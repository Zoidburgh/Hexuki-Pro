# Minimax Optimization Plan

**Goal:** solve a **13-empty, all-different-tile** position to exact perfect play in
**under 1 minute**, with **zero loss of correctness**.

Everything here stays *exact* (the true minimax value, deterministic). That rules out
the usual speed cheats (late-move reductions, null-move, forward pruning) — they change
the answer. We are limited to **sound** techniques: alpha-beta, transposition table,
PVS/aspiration, move ordering, faster per-node work, and parallelism.

---

## Where we are (measured this session)

Engine = C++ → WASM (`hexuki.wasm`), searched to game end (`depth = empty hexes`).
After the legal-move table + the TT bound-flag fix (commit `29ac9ae`):

| Empties | Nodes | Time (Node, ~3M nps) | Notes |
|---|---|---|---|
| 9  | ~1.0M  | ~0.3s  | |
| 10 | ~4.2M  | ~1.5s  | |
| 11 | ~39M   | ~12s (Node), ~18–20s (browser w/ DevTools) | the position that exposed the off-by-one bug |
| 12 | ~250–400M (est) | ~80–130s (est) | **measure in Phase 0** |
| 13 | **~2–4 billion (est)** | **~10–20 min (est)** | **the target** |

All-different tiles ≈ ~7–9× more nodes per extra ply. So **13-empty ≈ 2–4B nodes**, and
**under 1 minute means a ~15–25× speedup.** Browser is ~1.7× slower than Node (DevTools
overhead), so "under 1 min" should be stated for a target environment.

---

## Constraints / ground rules

- **Exact only.** No unsound pruning. The answer must equal a full minimax.
- **Gated.** Every change: `pwsh bench/build.ps1` → `node bench/gate.cjs` → must say
  **PASS** (correctness vs baseline + determinism + no-margin-drift on big stress
  positions) before it deploys. The gate is what makes fast iteration safe.
- **North-star metric:** the **13-empty solve time**, re-measured after each phase.
- **Measure, don't guess.** Estimates below are rough; keep only changes that pay off
  on the benchmark.

---

## Roadmap

### Phase 0 — Size it (first; ~15 min)
- [ ] Measure the *real* 12- and 13-empty solve time on today's engine (the true start line).
- [ ] Add a 12- and a 13-empty position to `bench/stress-fixtures.json` so the gate
      tracks progress toward the goal every phase.
- **Outcome:** exact starting numbers; know precisely how much speedup is needed.

### Phase 1 — Per-node speed (sound, low risk) — target ~2–3×
- [x] **TT: `std::unordered_map` → flat array** (256MB fixed, index = `hash & mask`,
      depth-preferred eviction on collision; `TTSlot` stores the full key to detect
      collisions). **DONE.** Killed the OOM and is ~30% faster — see results below.
- [x] **Node counter `int` → `long long`.** The `int nodesSearched` wrapped past
      INT_MAX on billion-node searches (12-empty showed −1.36B). Cosmetic (never
      affected the score), but the editor's node readout was garbage on 12+. Fixed.
- [x] **No-alloc move generation.** `getValidMoves()` allocated a fresh `std::vector<Move>`
      (plus a dedup temp) at *every node* — ~billions of malloc/free per deep search.
      Added `getValidMovesInto(buf)` that refills a **per-ply reusable buffer** (the dedup
      temp is now a stack array). Behaviour is identical (same move order -> same node
      counts/values); only the per-node heap churn is gone. **DONE.**
- [ ] **Tiles: `std::vector<int>` → count array `int[10]`.** O(1) make/unmake. The big
      per-node alloc is already gone (above); this is now a smaller win — *deferred.*
- **Measured (Node):**
  - 11-empty: ~12s (orig) -> **8.5s** (array TT) -> **6.2s** (no-alloc buffer). nps
    3.25M -> 5.0M -> **6.9M**. 42.8M nodes (identical throughout — exact same search).
    **~2× off the original.**
  - 12-empty: **completes, no OOM** (~2.93B nodes). Previously `Aborted()` / OOM —
    the critical fix; billion-node searches no longer crash.
- **Risk:** low. Move order/node counts are byte-identical, so the search is provably
  unchanged. Gate: **PASS** (root wasm byte-identical to gate binary).

### Phase 2 — Fewer nodes / search smarter (sound) — target ~1.5–2.5×
- [~] **Principal Variation Search (null-window).** ATTEMPTED, REVERTED — the gate
      caught an off-by-one (user-11 −58 → −59, might_draw 6 → 7). **Root cause:** when the
      TT holds a `LOWER_BOUND`, we narrow `alpha` above `alphaOrig` (`minimax.cpp:198`).
      PVS's width-1 null window returns *bounds*, not exact values; when a move's true
      value *equals* that TT lower bound, the null window can't distinguish "== bound"
      from "< bound", fails low, and the fail-soft result lands in `(alphaOrig, beta)`
      where the flag logic stamps it **EXACT** — storing a bound as exact corrupts the TT.
      Same off-by-one family as the original bug. **PVS needs the TT-bound/flag interaction
      reworked first** (don't narrow alpha into the flag's reference window, or track
      exactness explicitly). Not a quick edit — own focused task. Gate did its job.
- [ ] **Aspiration windows.** Same window/bound family as PVS — do AFTER the TT-bound/flag
      rework, or it'll hit the same boundary bug. Also uncertain for our score scale
      (multiplicative chain values swing hard between depths; tight δ -> constant re-search).
- [ ] **Move-ordering upgrades (SAFEST Phase-2 item — pure reorder, cannot change value).**
      Order by chain impact / better history weighting. Same safety class as Phase 1b.
      Prefer this next if continuing sequential work — no window/bound risk.
- **Expected:** ~5–7 min → ~2–3 min (if PVS lands after the TT fix).
- **Risk:** the window/bound items (PVS, aspiration) are medium-risk and share the TT-flag
  subtlety above. The gate is the oracle — it already blocked the bad PVS.

### Phase 3 — Re-measure & decide
- [ ] Re-measure 13-empty after Phases 1–2 (realistically ~2–3 min).
- Sound *sequential* techniques top out around here. If we want <1 min, go to Phase 4.

### Phase 4 — Parallelism (the key to <1 min; hardest) — target ~3–6×
- [ ] **WASM threads** (SharedArrayBuffer + pthreads); requires COOP/COEP headers on the
      dev server.
- [ ] **Lazy SMP:** N worker threads share the (flat array) TT and search the same tree
      at staggered depths; the shared table compounds across threads.
- [ ] **Thread-safe TT** (lockless slot writes or sharded) — enabled by the Phase-1 array.
- [ ] Relax the gate's *determinism* check to **"same value, node count may vary"** — the
      value must stay exactly correct even though thread timing changes node counts.
- **Expected:** ~2–3 min → **~30–60s** (scales with cores). This closes the gap.
- **Risk:** high (concurrency, TT races, determinism semantics) — the gate's
  correctness + consistency checks remain the oracle.

### Phase 5 — Polish
- [ ] **Embed the legal-move table** as a static array (instant engine load; no ~1.3s
      build pause).
- [ ] Optional **tiny endgame solver** for ≤6 empties (the deep, repetitive bottom of
      the tree), if profiling says it's worth it.

---

## Progress tracker (fill in measured numbers)

| Phase | Change | 13-empty time | nps | Gate | Commit |
|---|---|---|---|---|---|
| baseline | ordering fix | _(measure in P0)_ | ~3.25M | PASS | `29ac9ae` |
| 0 | size it | 12e ~420s; 13e not yet | ~3.25M | PASS | — |
| 1a | TT array (OOM fix) | 12e completes (no OOM) | ~5.0M (11e) | PASS | `dedfa8f` |
| 1b | no-alloc move buffer | 11e 8.5s -> 6.2s | ~6.9M (11e) | PASS | `4bd59bc` |
| 1c | count-array tiles | _(deferred — small win)_ | | | TODO |
| 2-PVS | PVS (null-window) | — | — | **FAIL (reverted)** | gate blocked off-by-one |
| 2 | PVS + aspiration + ordering | | | | |
| 4 | threads (Lazy SMP) | | | | |

---

## Honest bottom line

- **Phases 1–2 are the safe, high-confidence wins** (~5–7× combined) → 13-empty to ~2–3 min.
- **Phase 4 (threads) is what actually delivers <1 min**, and it's the most complex piece —
  most of the remaining gap lives there.
- A 13-empty all-different *exact* solve under 1 minute *in a browser* is at the edge of
  feasible. Very likely achievable with the full stack; if it lands at ~75s, **MCTS is the
  fallback** for the true monsters (≥12 empties), with exact minimax for ≤10–11.
- Correctness never trades for speed — the gate enforces it at every step.
