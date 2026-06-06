// Solve worker — runs in a worker_thread so the server stays responsive (and can TERMINATE
// it instantly on cancel). It drives iterative deepening EXTERNALLY (depth 1, 2, 3, ...),
// posting each COMPLETED depth back to the server. So there is always a "best answer so far",
// and cancel = terminate this worker + keep the last reported depth. No hard time cap.
//
// Cost: re-running lower depths each step adds ~20-30% vs a single internal-ID solve. That
// buys live progress + a meaningful cancel. Batch/precompute that doesn't need cancel can use
// the synchronous POST /solve instead. (A zero-overhead version would stream the engine's
// internal per-depth output; deferred — it needs a gated engine change.)

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

(async () => {
    const Factory = require(path.join(__dirname, '..', 'bench', 'engine', 'hexuki.js'));
    const m = await Factory();
    m.initialize();

    const { position } = workerData;
    m.loadPosition(position);
    let empties = 0;
    for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) empties++;

    let last = null;
    let totalNodes = 0;   // accumulated across every depth pass (the real work done)
    let totalMs = 0;
    for (let d = 1; d <= empties; d++) {
        m.loadPosition(position);                       // fresh internal ID to depth d
        const r = JSON.parse(m.minimaxFindBestMove(d, 0x7fffffff)); // 0x7fffffff ms = effectively no cap
        totalNodes += (r.nodes || 0);
        totalMs += (r.timeMs || 0);
        last = {
            bestMove: { hexId: r.hexId, tileValue: r.tileValue },
            score: r.score,
            depth: r.depth,
            empties,
            timeout: !!r.timeout,
            complete: !r.timeout && r.depth >= empties, // a real solve = reached game end
            nodes: r.nodes,                             // this depth pass
            timeMs: r.timeMs,
            totalNodes,                                 // cumulative across all passes so far
            totalMs,
        };
        parentPort.postMessage({ progress: last });
        if (last.complete) break;                       // reached game end -> fully solved, stop
        await new Promise(res => setImmediate(res));
    }
    parentPort.postMessage({ done: last });
})().catch(e => parentPort.postMessage({ error: e.message }));
