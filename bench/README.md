# Minimax benchmark harness

A scriptable regression + speed gate for the C++ minimax endgame solver
(`c++engine/src/ai/minimax.cpp`). It runs the solver under Node against a frozen
set of endgame positions and compares output + speed to a saved baseline, so you
can tell whether a change **stayed correct** and **how much faster/slower** it is.

## Why this works

The puzzle editor solves the endgame to full depth (`depth = emptyHexes`), so the
returned `score` is the **game-theoretic final point differential under perfect
play**. That value is an invariant: any correctness-preserving optimization MUST
return the identical score on every fixture.

| Metric | Meaning | Gate |
|---|---|---|
| `score` | exact final differential | **HARD** — must match baseline exactly, else FAIL |
| `nodes` | search nodes visited | efficiency — *fewer is better* (better pruning/ordering) |
| `hexId`/`tileValue` | chosen move | should match; differing with equal score = "alt-optimal" (OK) |
| `timeMs` | wall time (min of 3) | speed — judge on the **total** and the **heavy fixtures**, not sub-5ms ones (noisy ±30-60%) |

Minimax is deterministic: node counts are identical across runs and processes, so
a node delta of anything other than 0% means search behavior changed.

## The loop (after editing minimax)

```powershell
pwsh bench/build.ps1                 # recompile c++engine -> bench/engine (~16-20s)
node bench/gate.cjs                  # THE GATE: correctness + determinism + consistency; exit 1 on any fail
```

**`gate.cjs` is the canonical check — run it before every deploy.** It enforces:
1. **Correctness** — every fixture's score matches `baseline.json`.
2. **Determinism** — same score + node count across repeated runs.
3. **Consistency** — on big all-different-tile positions (`stress-fixtures.json`),
   the perfect-play margin must not drift when you solve, play the best move, and
   solve again. This is the exact check that catches the off-by-one TT/ordering bug
   class that the small fixtures missed. Only deploy when the gate says PASS.

For per-fixture node/time deltas (the speed story), also run `node bench/run.cjs`
then `node bench/compare.cjs latest baseline`.

## Files

- `build.ps1` — rebuild the engine to a Node-loadable WASM (prod `-O3 -flto`, no
  closure since closure only minifies JS glue, not the `.wasm`). Output: `bench/engine/` (gitignored).
- `fixtures.json` — 48 frozen endgame positions (6-11 empty hexes) derived from
  `levels/*.json`. Committed; regenerate only intentionally.
- `baseline.json` — frozen scorecard of the current solver. Committed.
- `run.cjs` — solve every fixture, write a scorecard.
- `compare.cjs` — diff a run against the baseline (the gate).
- `lib.cjs` — shared helpers (load engine, parse positions, deterministic move pick).
- `gen-fixtures.cjs` — regenerate `fixtures.json` (rarely needed).
- `runs/` — transient scorecards (gitignored).

## Re-baselining

Re-measure the baseline (`node bench/run.cjs bench/baseline.json`) ONLY when you
have intentionally and correctly changed solver behavior, or changed the build
toolchain/flags. The baseline must always be measured with the same `build.ps1`
you compare against. After a successful, intended change: rebuild, re-run to
`baseline.json`, and commit the new baseline with a note on why scores/nodes moved.

## Regenerating fixtures

`node bench/gen-fixtures.cjs` replays each level deterministically and snapshots
positions at 6-11 empty hexes. Changing the fixture set invalidates the baseline,
so re-baseline immediately after.
