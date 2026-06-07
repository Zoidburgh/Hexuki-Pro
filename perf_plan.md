# Perf plan: (1) P-core affinity + (2) aspiration windows — WITHOUT breaking correctness

> Goal: cut the hard-position e=12 times and the ~2x run-to-run jitter on the hybrid CPU, with
> ZERO risk to the minimax value. Same cardinal rule as track1_plan.md: nothing ships until it's
> proven == pure alpha-beta (the oracle) across the full differential suite. Each change is
> independently flag/ifdef-gated and revertable. Do #1 first (can't change values), then #2.

## Baseline facts (why these two)
- Engine speed is constant (~13-15M nodes/s); wall-clock is driven by NODE COUNT, which swings
  several-fold between e=12 positions (200M typical -> 700M user's -> ~2.5B for a "3 min" one).
- Two extra multi-core wobbles on this CPU (Core Ultra 5 = 4 P-cores + 4 E-cores, no HT):
  (a) parallel non-determinism (node count varies run-to-run); (b) the per-depth join() is a
  BARRIER, so the slowest worker bounds each depth — an E-core straggler can ~2x the wall-clock.
- #1 attacks (b) + jitter. #2 attacks raw node count on every position. Neither may change a value.

---

## #1 — P-core affinity  (RISK: LOW — cannot change the minimax value, only WHERE threads run)
Native Windows + threads only. WASM untouched (single-threaded). Pure scheduling.

**Design**
- Detect P-cores once (single-threaded, before spawning) via `GetSystemCpuSetInformation`: each CPU
  set reports an `EfficiencyClass`; the highest class = P-cores. Build the P-core CpuSet-ID list.
- Pin every root-split worker (including worker 0 / main) to the P-core set with
  `SetThreadSelectedCpuSets` (fallback `SetThreadAffinityMask`).
- Because the join() barrier makes E-core stragglers dominate, when `--threads 0` (auto) DEFAULT the
  worker count to #P-cores (4 balanced fast workers) instead of all 8. Explicit `--threads N` is
  still honored; if N > #P-cores we also allow E-cores (affinity set = all).
- EVERYTHING guarded: if the API is missing / detection returns 0 P-cores / not Windows, do nothing
  (exactly today's behavior). Never throw, never hard-fail.

**Where:** `findBestMoveRootSplit` (thread spawn site) + a small `#ifdef _WIN32` helper. native_solve
auto-thread default. No change to `alphaBeta` or any value logic.

**Verify**
- `difftest-threads.cjs` still PASS (affinity literally cannot change the result — this just confirms).
- Measure the user's e=12 (`h1:9,h4:3,h5:8,h7:6,h9:1,h12:4,h17:7|p1:1,2,4,5,7,9|p2:1,2,3,5,6,8|turn:1`)
  three times: 4-P-pinned vs 8-mixed. Expect tighter spread + likely faster (no straggler).

**Rollback:** delete the helper + the affinity calls; `#ifdef` means the WASM/Linux builds never saw it.

---

## #2 — Aspiration windows  (RISK: MEDIUM — a buggy window CAN return a wrong value; gated + proven)
Iterative deepening currently searches every depth with the full window [-INF, INF]. Aspiration
seeds a NARROW window around the previous depth's score, re-searching wider only when the true score
falls outside. Fewer nodes when the guess is close (it usually is: the user's depths moved ~50-70
apart). Applies at the ROOT of each ID iteration, single-thread and multi-thread.

**The one rule that keeps it correct:** ONLY accept a score that lands STRICTLY INSIDE the searched
window (that's an exact value). On fail-low (best <= alpha) or fail-high (best >= beta), WIDEN that
side and re-search. The final widen goes to the full window, which guarantees both termination and
an exact result. A bound is NEVER treated as the value. (Our `alphaBeta` is fail-soft — it returns
the real best score even outside the window — so the widened bounds are always valid.)

**Single-thread (`findBestMove` ID loop, line ~525) — do FIRST (simplest):**
```
prev = bestScore from depth d-1
if (d < ASPIRATION_MIN_DEPTH) { alpha=-INF; beta=INF; }      // shallow depths: full window
else { delta = INITIAL_DELTA; alpha = prev-delta; beta = prev+delta; }
loop:
    run the existing root move loop with [alpha,beta]  (currentBestScore = fail-soft max)
    if (currentBestScore <= alpha) { alpha = prev - (delta*=4); if(alpha<=-INF/2) alpha=-INF; continue }  // fail low
    if (currentBestScore >= beta ) { beta  = prev + (delta*=4); if(beta >= INF/2)  beta = INF;  continue } // fail high
    break                                                    // exact -> accept
```
- `INITIAL_DELTA`: Hexuki scores are products (±hundreds/thousands), not centipawns — size it to the
  observed depth-to-depth delta (~64-128 to start; tune so the re-search rate stays low). Too small =
  many re-searches (slower); too big = no pruning benefit. Measure the re-search rate and tune.
- Timeout safety: the existing mid-depth timeout check stays; a half-finished aspiration re-search
  just falls back to the previous completed depth (unchanged behavior).

**Multi-thread (`findBestMoveRootSplit` per-depth, line ~360):**
- Seed `globalAlpha = prev - delta` and pass `betaAsp = prev + delta` into the workers
  (`alphaBeta(b, depth-1, -betaAsp, -alpha, ...)`), then at the combine: `dBest <= (prev-delta)` =
  fail low, `dBest >= betaAsp` = fail high -> widen + re-run the whole depth. Same accept-only-exact
  rule. Slightly more code (re-runs the parallel split), so land it AFTER single-thread is proven.

**Gating:** new `config.useAspiration` (default OFF during dev). A/B against OFF the whole time.

**Verify (un-foolable — all must pass before flipping default ON):**
1. NEW `bench/difftest-aspiration.cjs`: aspiration-ON == aspiration-OFF == oracle (NoTT) on 200+
   positions e=4..11 (ID-on), zero disagreements. (Catches any window/flag interaction.)
2. `difftest-valuett.cjs` still PASS with aspiration ON (value-TT + aspiration together == oracle).
3. `difftest-threads.cjs` still PASS (threaded + aspiration == single == oracle, move-optimal).
4. `gate.cjs` still PASS — its chain-consistency check is exactly what catches value drift.
5. The 3 historical fixtures (e=9 539, e=11 -56, e=10 1243) still exact.

**Rollback:** flip `useAspiration` OFF (one line); the full-window path is unchanged underneath.

---

## STATUS (2026-06)
- **#1 P-core affinity: DONE & shipped** (commit ee4c817). 1:1 distinct-core pinning, P-cores first,
  auto=all logical procs. Correct (difftest-threads PASS). Outcome: a throughput STABILIZER, not a
  speedup -- the node count is the wall, so on its own it doesn't cut the hard-position times.
- **#2 aspiration windows: IMPLEMENTED, NOT SHIPPED (gated OFF).** Saves ~30% nodes and is CORRECT
  with the ordering-only TT, BUT under-reports values when combined with the VALUE-TT (the shipped
  config). Localized: `asp+ordering == oracle` (right), `asp+valueTT < oracle` (wrong), `valueTT
  alone == oracle` (right). A narrow ROOT window + same-depth re-search exposes a value-TT
  interaction not yet root-caused. Per the cardinal rule it stays OFF. `bench/difftest-aspiration.cjs`
  is the guard (must reach 0 disagreements with value-TT before it can be enabled). NOTE: this does
  NOT threaten the shipped engine -- shipping uses FULL root windows, which difftest-valuett proves
  correct over 200 positions; only the narrow-root-window regime is affected.
  - Next root-cause step (mirror the hash-bug method): re-add the `verifyTrueValue` oracle behind a
    debug flag and, during an aspiration+valueTT solve on a failing position, log the first value-TT
    return (EXACT or bound) that disagrees with brute force -> that pinpoints the bad entry/window.

## Order of work (each step independently green before the next)
1. #1 P-core affinity -> difftest-threads PASS + timing measured -> commit.
2. #2 single-thread aspiration (flag) -> difftest-aspiration + valuett + gate PASS -> commit.
3. #2 multi-thread aspiration -> difftest-threads + all above PASS -> commit.
4. Flip `useAspiration` default ON, rebuild+deploy editor WASM + native, re-run full suite -> commit.
5. Measure the user's e=12 end-to-end (expect ~45s -> ~20s range, tighter jitter).

## What could break & the guard against it
- Aspiration returning a bound as a value -> the accept-only-exact rule + final full-window retry.
- value-TT cutoff under a shifted window -> flags are alphaOrig-relative already; difftest-valuett
  with aspiration ON proves it.
- Affinity pinning to the wrong cores / API absent -> guarded no-op fallback; can't affect values.
- Thread jitter masking a real regression in timing -> judge correctness by node/value gates (exact),
  not by wall-clock; measure timing only as medians on P-cores.
