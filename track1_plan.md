# Track 1: recover the value-TT (safely)

> Living doc. Goal: let the transposition table return cached VALUES again (not just ordering
> hints), so we skip re-searching positions -> ~2-7x fewer nodes -> depth-13 becomes feasible.
> The value-TT had a bug (stored wrong EXACT values on ~6% of positions); we turned it off. This
> plan recovers it WITHOUT breaking the now-correct engine.

## ✅ RESOLVED (2026-06) — root cause: a Zobrist HASH bug, not the alpha-beta logic
The value-TT wasn't returning wrong values because of a flag/window/replacement flaw. The
**incremental Zobrist hash was wrong**: `updateZobristHash` XOR'd only the board tile + a single
player hash, and NEVER updated the per-player hand-count term that the full `Zobrist::hash()`
includes. So two genuinely different states whose only difference was *which player held a tile*
(e.g. `...|p1:1|p2:6` vs `...|p1:6|p2:1`, same board, same turn) produced the SAME hash. The
ordering-only TT survived this (a collision only gives a bad move-ordering hint, never a wrong
value) -- which is exactly why the shipped engine stayed correct. The value-TT returns the cached
value, so a collision returned the *other* state's value -> the ~6% wrong-EXACT.

**Fix** (`bitboard.cpp` `applyHashDelta`, `zobrist.cpp` `getTileCountHash`): maintain the
full-hash invariant incrementally -- on each move XOR (1) the board tile, (2) the CONSTANT
`playerHash[P1]^playerHash[P2]` side-to-move delta, (3) the mover's hand-count term
`tileCountHashes[mover][val][oldCount]`-> `[newCount]`. Self-inverse, so make/unmake restore it.

**How it was found:** brute-force oracle (`verifyTrueValue`) caught a wrong returned EXACT at a tiny
3-empty node; it reproduced ONLY in the full search (not isolation) => window/path dependent; a
store-time verifier found NO wrong store <=5 empties => the wrong entry came from a *different*
position hitting the same slot+key => a hash collision; a canonicalized collision detector printed
the swapped-hands pair above. Mechanism understood, then fixed (no guessing -- per the rule below).

**Proven:** `bench/difftest-valuett.cjs` — value-TT == pure alpha-beta on 200 random positions
e=4..10 (ID-on AND no-ID) + the 3 historical fixtures (e=9 539, e=11 -56, e=10 1243) + a
hash-invariant sweep (incremental hash == full recompute, 0 drift). `gate.cjs`, `difftest.cjs`,
`difftest-threads.cjs` all still PASS. Measured node reduction: **e=11 9.65x** (454.5M->47.1M),
e=10 2.41x — the depth-13 lever, recovered.

**Still gated OFF by default** (`useValueTT=false`). Remaining integration: (1) enable it on the
single-thread WASM solve path; (2) for the native THREADED root-split the shared TT now carries
VALUES, so a torn read can corrupt a value -> add the Hyatt lockless-XOR slot (or per-thread TTs)
before turning value-TT on there; (3) clear the server disk cache if it is keyed by the numeric hash.

## Why this matters for depth 13
Node counts roughly ~7-10x per extra empty for all-different tiles.
- 12-empty today (ordering-only): ~1.17B nodes, ~81s on 8 cores.
- 13-empty (est): ~10B+ nodes -> ~13 min on 8 cores as-is.
- With the value-TT back (~2-7x fewer nodes) + a 16-32 core server: 13-empty in ~1-5 min.
The value-TT is the lever that makes 13 practical. Threading + cores alone aren't enough.

## THE CARDINAL RULE (how we don't fuck it up)
**The shipped ordering-only engine is the correct baseline and DOES NOT CHANGE until the
value-TT is PROVEN correct.** All value-TT work happens behind a compile/runtime flag so we can
A/B it against the oracle. We integrate only after it passes a massively expanded differential
test. The mistakes last time were: (1) editing the live engine on a hunch, (2) trusting the
gate's fixed fixtures (blind spots), (3) measuring on hybrid cores. This plan bans all three.

## What we already have (the foundation)
- A **ground-truth oracle**: `minimaxFindBestMoveNoTT` (TT disabled = pure alpha-beta, cannot
  have a TT bug) + the `g_ttEnabled` switch.
- A **small reproducing case**: a 9-empty where value-TT=550 but truth=539
  (`h4:6,h6:2,h8:1,h9:1,h10:6,h12:7,h13:2,h14:9,h16:3,h17:3|p1:4,5,8,9|p2:1,4,5,7,8|turn:2`).
- The `difftest` gate (TT-on == pure alpha-beta) -- currently passes because the value-TT is OFF.

## Method: INSTRUMENT to find the exact bug, never guess

### Step 1 -- find the FIRST wrong stored value (the root, not a symptom)
The bug cascades: a wrong stored EXACT poisons everything above it. The FIRST wrong store is at
a node whose subtree is still correct -- that's where the logic is actually wrong.
- Add a debug build flag (e.g. `-DTT_VERIFY`). When set, on every EXACT store, record
  `(positionString via savePosition(), storedValue, depth, alpha, beta window)`.
- After the solve on the small failing position, replay the recorded stores IN ORDER: for each,
  solve that exact position with the oracle (NoTT) and compare. **Stop at the first mismatch.**
- That gives the exact position + depth + window where an EXACT value was stored wrong, with the
  pure-alpha-beta value next to it.

### Step 2 -- understand WHY at that one node
At the first divergent node, dump: the window (alpha/beta/alphaOrig), the per-move scores, which
moves caused cutoffs, and which child values came from TT hits vs fresh search. Compare to what
pure alpha-beta does at the same node. The flaw will be visible (candidates: the fail-soft flag
vs the window, the iterative-deepening depth bookkeeping, the EXACT-return ignoring the window,
the replacement policy). Do NOT apply a fix until the mechanism is understood and stated.

### Step 3 -- fix exactly that flaw, behind the flag
Implement the minimal fix. Keep the value-TT behind `g_useValueTT` (default OFF) so the shipped
path is unchanged.

## Verification (the oracle, made un-foolable)
Before the value-TT is allowed anywhere near the shipped engine, ALL of these must pass:
1. **Expanded `difftest`**: value-TT == pure alpha-beta on **thousands** of random positions,
   e=4..11 (not 15). Zero disagreements. (Today's difftest is too small -- expand it.)
2. **Permanent regression fixtures**: add the known wrong cases (the e=9 above; the user's e=11
   `h2:7,h4:5,h7:3,h9:1,h11:7,h12:3,h15:8,h17:6|p1:1,2,4,5,9|p2:1,2,4,6,8,9|turn:2` = -56) to the
   gate so they can never silently regress.
3. **Chain consistency**: for many positions, play the engine's own best moves to the end; the
   value must stay constant (it drifted before -- that's how the bug first showed).
4. The existing `gate.cjs` still PASS.

## Integration (only after all green)
1. Flip `g_useValueTT` on for the WASM build; re-run all four checks; gate; deploy root.
2. Re-verify the THREADED path: `difftest-threads` must still pass (threaded == single == oracle).
   The shared TT now carries VALUES, so re-confirm races stay benign or add the Hyatt-XOR lockless
   slot if needed (with the value-TT, a torn read CAN corrupt a value -> may need the lockless
   scheme that ordering-only didn't).  <-- important: threading correctness must be re-earned.
3. Measure on P-cores (not E-cores) before trusting any speedup number.
4. Commit only when every gate is green.

## Definition of done
- `difftest` (value-TT vs pure alpha-beta): 0 disagreements over thousands of positions.
- Regression fixtures + chain consistency + `gate.cjs` + `difftest-threads`: all PASS.
- Measured node-count reduction on the 11/12-empty (expect ~2-7x).
- Then: depth-13 timing re-measured (the real goal).

## If Step 1-2 still can't find it
Fallback that's still a win: keep the value-TT OFF for correctness, but recover speed via SAFE
node-reduction that can't change values -- better move ordering (domain chain-impact heuristic,
history/killer tuning). Ordering provably can't change the minimax value, so it's zero-risk and
still cuts nodes. Smaller than the value-TT, but safe and shippable.
