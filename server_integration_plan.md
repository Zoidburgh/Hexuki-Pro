# Server Integration Plan

> **⚠ LIVING DOCUMENT — SUBJECT TO CHANGE.** This captures the plan as of the date below.
> Priorities, phases, and designs here will change as we learn more, hit surprises, or the
> product direction shifts. Nothing here is a commitment; it's a map we redraw as needed.
> Last updated: 2026-06-06.

---

## Why a server (the goal)

Hexuki ships on **web + mobile**. Deep, all-different positions are genuinely heavy — a
single all-different **12-empty took ~24.5 min / 12.4 billion nodes** single-threaded on a
laptop (measured this session). That will never solve on a phone or in a browser tab without
freezing it. A server lets a strong machine do the heavy solving **off the player's device**,
and — the big win — **cache every answer so each unique position is solved once, ever**.

This does **not** replace on-device solving. It augments it.

---

## Core principles (the guardrails)

1. **Additive, never destructive.** All server code lives in a new `server/` folder. The
   editor, the game, `hexuki.js` / `hexuki.wasm`, and the WASM build are **never touched**.
   Delete `server/` and we're exactly where we are today.
2. **Offline always works.** The app keeps its built-in WASM engine. The server is **always
   optional** — the client tries the server, and falls back to on-device WASM when there's
   no server / no internet / the user prefers offline.
3. **One engine, one source of truth.** The same C++ engine compiles to WASM (client) and,
   later, native (server). Both pass the **same gate**, so online and offline give
   **identical** answers — just at different speeds. No divergence, ever.
4. **The gate still rules correctness.** Any engine change is still gated
   (`build → gate → deploy`). The server is just a new way to *run* the gated engine.
5. **Swap the location freely.** The client points at a URL. `localhost` today → any cloud
   host later → switch hosts anytime = change one setting. No provider lock-in.

---

## Environment findings (checked 2026-06-06 on this laptop)

| Thing | Status | Implication |
|---|---|---|
| Native C++ compiler (MSVC / clang / gcc) | ❌ none usable | true-native server (S3) needs a one-time **MSVC Build Tools** install |
| emsdk clang → native Windows | ❌ no Visual Studio / Windows SDK | can't shortcut native without the install |
| **Node** | ✅ v22.18.0 | can run a server **today**, no installs |
| **CPU** | ✅ 8 logical cores | room for ~7 parallel solve workers |
| node-capable WASM build | ✅ already produced by `bench/build.ps1` → `bench/engine/` | the server can load this now |
| emscripten (for WASM) | ✅ 4.0.18 | unchanged; still the client build path |

**Takeaway:** start with **Node + the existing WASM** (zero installs, zero risk). Native is a
later, optional upgrade.

---

## Architecture (target shape)

```
            ┌─────────────────────────── client (web app / mobile app / editor) ───┐
            │   "solve(position)"  ── one function, swappable backend:              │
            │        ├─ try SERVER (if configured + reachable)  ──────────┐         │
            │        └─ else FALL BACK to built-in WASM (offline)         │         │
            └────────────────────────────────────────────────────────────┼─────────┘
                                                                          │ HTTP
                                                       ┌──────────────────▼─────────┐
                                                       │  SERVER (Node, then native)│
                                                       │   POST /solve              │
                                                       │   1. normalize position    │
                                                       │   2. CACHE hit? -> return   │
                                                       │   3. else run engine, solve │
                                                       │   4. store in CACHE, return │
                                                       └────────────────────────────┘
```

The **cache** is the multiplier: keyed by the normalized position string (we also have
Zobrist hashing internally if we want a compact key). First solve of a position pays full
cost; everyone after gets it instantly. Persisted to disk so it survives restarts and can be
shipped/seeded.

### Solve API (first sketch — subject to change)
- `POST /solve` body `{ "position": "h4:3,...|p1:...|p2:...|turn:1", "maxMs": <optional> }`
- returns `{ "bestMove": {"hexId":..,"tileValue":..}, "score":.., "depth":..,
  "timeout":bool, "nodes":.., "cached":bool }`
- `timeout:true` means NOT a full solve (never present as perfect play — same rule as the
  editor fix).

---

## Roadmap (phased, each step additive)

### S1 — Node + WASM solve server  *(no installs, ~zero risk)* ← START HERE
- [ ] `server/` Node program (built-in `http`, no npm deps) that loads `bench/engine/hexuki.js`.
- [ ] `POST /solve`: normalize position → check disk cache → else solve → cache → return.
- [ ] Disk cache (e.g. a JSON/append file keyed by normalized position).
- [ ] Honest `timeout` flag passthrough (a timed-out solve is not a solve).
- **Wins immediately:** solves run off the browser (**no freeze**); repeat positions instant.
- **Speed:** WASM speed per solve (same as today), but usable without freezing the UI.
- **Risk:** minimal — new files only; nothing existing is modified.

### S2 — Throughput parallelism  *(still no installs)*
- [ ] Pool of ~7 Node `worker_threads`, each its own WASM instance.
- [ ] Solve **different** positions concurrently (≈7× throughput on 8 cores).
- **Note:** this parallelizes *across* solves, not *within* one — no shared memory, no races,
  no correctness risk. A single hard solve is still single-threaded here.
- **Risk:** low — isolation per worker; the cache is the only shared resource (simple file lock
  or single writer).

### S3 — Go native  *(optional; needs MSVC Build Tools install)*
- [ ] Native build target for the C++ engine (same sources as the WASM build).
- [ ] 1.5–2× per-core speedup vs WASM.
- [ ] Native shared-memory threads → **single-solve Lazy SMP** (the hard, big parallel win;
      see Phase 4 in `minimax_opt_plan.md`, incl. the Hyatt-XOR lockless TT for race safety).
- **When:** only when monster positions need to be faster than S1/S2 + cache deliver.
- **Risk:** higher (native build + concurrency) — gate remains the oracle; relax determinism
  to "same value, node counts may vary" for threaded runs.

### Cross-cutting (whenever relevant)
- [ ] Client `solve()` abstraction with server-or-WASM fallback + an offline toggle.
- [ ] Editor: optionally call the local server for solves (native-speed, no freeze) while
      keeping WASM as fallback.
- [ ] Precompute path: the editor/server solves shipped puzzles **once**, bakes the answer in.
- [ ] Deploy step (later): same server program → a cloud host; client points at its URL.

---

## Progress tracker (fill in as we go)

| Phase | What | Status | Notes |
|---|---|---|---|
| S1 | Node+WASM /solve + disk cache | **DONE** | verified: solve off-browser, 1ms cache hit, order-normalized key, /health, timeout honesty |
| S2 | worker-thread throughput pool | not started | ~7× throughput, no races |
| S3 | native build + Lazy SMP | not started | needs MSVC Build Tools |
| — | client solve() fallback + offline toggle | not started | keeps offline working |
| — | precompute shipped puzzles | not started | editor solves once, bakes in |

---

## Open decisions (revisit as we learn)
- **Cache key**: normalized position string vs Zobrist hash (string is human-readable + already
  canonical from `savePosition`; hash is compact). Leaning: position string for v1.
- **Cache storage**: flat append file / JSON / a small embedded KV — start simplest.
- **Server framework**: Node built-in `http` (zero deps) for S1; revisit if we need more.
- **When (if) to go native (S3)**: depends on whether S1+S2+cache make deep solves tolerable.
- **Thread count for S2/S3**: fixed vs cores-1 (lean cores-1, leave one for the OS).
- **Determinism contract for S3 threads**: accept "exact value, node counts vary" (gate keeps
  value + consistency strict).

---

## What this plan does NOT change
- The shipped WASM engine, the editor, the game, the gate, or any current workflow.
- Correctness: same engine source, same gate, identical answers online vs offline.
