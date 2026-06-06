# Multi-threading, done right

> Living doc. The first attempt (native Lazy SMP + packed TT) was reverted because it returned
> WRONG values ~20% of the time. This plan captures *why* it failed and how to do it correctly.

## What went wrong last time (the lessons)

1. **The engine had a latent single-threaded bug, and threading amplified it.** The value-TT
   stored wrong "EXACT" entries on ~6% of positions. Single-threaded it was a few-point error
   on rare positions; with helper threads filling a shared TT it became ±16+ / ~20% wrong.
   → **Rule: the engine must be provably correct single-threaded FIRST.** (It now is —
   ordering-only TT, verified by `bench/difftest.cjs` vs pure alpha-beta.)
2. **Shared globals were initialized lazily and raced.** The legal-move table AND the Zobrist
   hash table were built on first use; N threads racing to build them computed inconsistent
   state → poisoned the shared TT. → **Rule: pre-build every lazily-initialized global,
   single-threaded, before spawning any worker.**
3. **The gate's fixed fixtures have blind spots.** They never hit the buggy positions.
   → **Rule: correctness is proven by DIFFERENTIAL + RANDOM testing, not a fixed list.**
4. **Measurements were confounded** by this laptop's hybrid P/E cores (the Node process lands
   on slow E-cores), which made me mis-judge speedups. → **Rule: pin to P-cores or measure on
   homogeneous hardware before trusting any speedup number.**

## The key enabler: the ordering-only TT makes threading correctness-TRIVIAL

The current engine uses the TT for **move ordering only** — it never returns stored values.
That changes everything for parallelism:

- **Each thread computes its value with pure alpha-beta** (the TT only reorders moves).
  So every thread's value is correct *regardless of the TT*.
- **A shared TT race is BENIGN.** A torn/garbage entry is just a bad ordering hint → slightly
  worse pruning (slower), **never a wrong value.** No Hyatt-XOR lockless scheme needed, no
  value-corruption risk — the entire class of bug that sank the last attempt is gone.

So "multi-thread right" is now *low-risk*, as long as we still (a) pre-init globals and
(b) prove it with differential testing.

## Plan

### Track 1 (optional, higher payoff): recover the value-TT speed FIRST
The ordering-only engine is correct but slower (it gave up the value cutoffs). Root-causing the
wrong-EXACT bug would restore that speed AND let a value-TT be shared across threads (bigger
parallel win). Approach:
- Use the `difftest` oracle to find the SMALLEST disagreeing position (done: an e=9 gives 550
  vs truth 539).
- Instrument: when storing an EXACT entry on a small position, re-solve that sub-position with
  the TT disabled and assert equality; log the FIRST divergent store. That pinpoints the exact
  node + flag where the value-TT goes wrong.
- Likely suspects to examine at that node: fail-soft flag vs alphaOrig/beta, the
  iterative-deepening depth bookkeeping, the replacement policy, the unconditional EXACT return.
- Fix, then `difftest` must be 0 disagreements + gate PASS. If a value-TT is recovered, a shared
  value-TT across threads DOES need the Hyatt-XOR lockless slot (races would corrupt values).

### Track 2: the threading itself (on whichever engine — ordering-only is the safe default)
1. **Pre-init globals** in the entry: `HexukiBitboard::ensureLegalTable(); Zobrist::initialize();`
   before any thread is spawned. (Already learned.)
2. **Start simple — ROOT SPLITTING** (embarrassingly parallel, obviously correct):
   - Generate the root moves; partition them across N threads.
   - Each thread fully searches its subset (own board copy; shared ordering-only TT is fine).
   - Combine: the answer = the max over all threads' best-in-subset. This is *exactly* the serial
     root loop, just distributed → same value, by construction.
   - Speedup is sub-linear (no shared value memoization) but correct and predictable.
3. **Then LAZY SMP** if more speed is needed: N threads search the whole tree sharing the
   (ordering-only) TT, diversified by root-move rotation / depth stagger; thread 0 authoritative.
   With ordering-only the shared TT can't corrupt values, so the only correctness concern is the
   combine step + globals.
4. **Native vs threaded-WASM**: native (MinGW, already set up in `tools/`) for the server;
   threaded-WASM later if we want client-side parallelism. Per-core speed was ~par (V8 is good),
   so the win is purely the extra cores.

### Mandatory verification (the gate that was missing)
- **Threaded differential gate**: for many random positions, the N-thread solve (run M times,
  since threading is non-deterministic) MUST equal the single-thread value every time. Add this
  alongside `difftest`. This is exactly what would have caught the last race.
- Keep `difftest` (TT-on vs pure alpha-beta) in the gate so the engine itself can't regress.

## Sequence
1. (Now) Engine is correct single-threaded + `difftest` gate. ✅
2. Track 1: recover value-TT speed (biggest single-threaded win; optional but high value).
3. Track 2 step 2: root splitting on the ordering-only engine (safe, correct multi-core).
4. Add the threaded differential gate; measure on P-cores.
5. Track 2 step 3: Lazy SMP if more is needed.

## Bottom line
The last attempt failed because we threaded an engine that wasn't actually correct, raced lazy
globals, and trusted a fixed-fixture gate. With the engine now correct (ordering-only), globals
pre-built, and differential testing as the oracle, multi-threading is straightforward and
low-risk — the value-corruption class of bug is structurally gone.
