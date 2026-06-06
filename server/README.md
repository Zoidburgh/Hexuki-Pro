# Hexuki solve server

A local service that runs the Hexuki engine **off the browser** and **caches every solve**.
See `../server_integration_plan.md` for the full plan. This folder is **additive** — it does
not touch the editor, the game, or the shipped WASM. Delete it and nothing else changes.

## What it is (S1)
- Node + the node-capable WASM engine (`bench/engine/hexuki.js`) — **no native compiler needed**.
- `POST /solve` → solves a position to game end and returns the value + best move.
- Every **completed** solve is cached to `cache.jsonl`, so repeat positions are instant.
- Timed-out solves are flagged (`complete:false`) and **not** cached (never treated as perfect).

## Run it
```
# one-time: build the node engine if you haven't
pwsh bench/build.ps1

# start the server (or double-click START_SOLVE_SERVER.bat)
node server/solve-server.cjs        # http://localhost:8080
```

## Try it
```
node server/test-solve.cjs          # auto-generates a small position, solves, then shows the cache hit
```
Or hit it directly:
```
POST http://localhost:8080/solve
{ "position": "h4:3,h6:7,...|p1:2,5,6,7,8,9|p2:1,2,4,5,8,9|turn:1", "maxMs": 600000 }
```
Response:
```
{ "bestMove": {"hexId":17,"tileValue":8}, "score":-136, "depth":12,
  "empties":12, "timeout":false, "complete":true, "nodes":..., "cached":false, "position":"<normalized>" }
```

## Notes / limits (S1)
- **Single-threaded**: one solve at a time. A long solve blocks other requests. S2 adds a
  worker pool for concurrency (solve many positions at once).
- **WASM speed** per solve (same engine as the editor). Native (S3) is the per-core speedup.
- The cache key is the **normalized** position (board sorted by hex, hands sorted) so different
  orderings of the same position share one cache entry.
- Port 8080 (set `HEXUKI_PORT` to change). The editor uses 8000 — no conflict.
