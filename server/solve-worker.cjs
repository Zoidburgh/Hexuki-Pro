// Solve worker — runs in a worker_thread so the server stays responsive and can TERMINATE it
// instantly on cancel. Uses the engine's STREAMING entry (minimaxFindBestMoveStream): ONE
// internal iterative-deepening search that emits a "@PROGRESS" line per completed depth. The
// worker captures those (via Module.print) and posts each as best-so-far. So we get live
// progress + cancel with NO re-search overhead (totals are the true single-ID node counts).
//
// Cancel = the server terminates this worker; the last posted @PROGRESS is the best-so-far
// (the in-progress, incomplete depth is correctly discarded).

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

(async () => {
    const { position, activeMask } = workerData;
    const FULL_MASK = (1 << 19) - 1;
    const mask = (activeMask != null) ? (activeMask >>> 0) : FULL_MASK;
    let empties = 0;
    let last = null;

    // @PROGRESS <depth> <score> <hexId> <tileValue> <totalNodes> <elapsedMs>
    const onLine = (s) => {
        if (typeof s !== 'string' || s.lastIndexOf('@PROGRESS', 0) !== 0) return;
        const p = s.split(/\s+/);
        const depth = +p[1], score = +p[2], hexId = +p[3], tileValue = +p[4], totalNodes = +p[5], elapsed = +p[6];
        last = {
            bestMove: { hexId, tileValue },
            score, depth, empties,
            timeout: false,
            complete: depth >= empties,             // final depth == empties -> full solve
            nodes: totalNodes, timeMs: elapsed,
            totalNodes, totalMs: elapsed,            // true cumulative totals (single ID, no 2x)
        };
        parentPort.postMessage({ progress: last });
    };

    const Factory = require(path.join(__dirname, '..', 'bench', 'engine', 'hexuki.js'));
    const m = await Factory({ print: onLine });     // route engine stdout (@PROGRESS) to onLine
    m.initialize();
    if (mask !== FULL_MASK && typeof m.setActiveHexes === 'function') m.setActiveHexes(mask);  // blackout

    m.loadPosition(position);
    for (let h = 0; h < 19; h++) if (((mask >> h) & 1) && m.getTileValue(h) === 0) empties++;  // active empties

    // Single streaming search to game end, no practical cap (0x7fffffff ms). @PROGRESS lines
    // fire synchronously per depth during this call -> real-time progress out to the server.
    const r = JSON.parse(m.minimaxFindBestMoveStream(empties, 0x7fffffff));

    parentPort.postMessage({
        done: {
            bestMove: { hexId: r.hexId, tileValue: r.tileValue },
            score: r.score, depth: r.depth, empties,
            timeout: !!r.timeout,
            complete: !r.timeout && r.depth >= empties,
            nodes: r.nodes, timeMs: r.timeMs,
            totalNodes: r.nodes, totalMs: r.timeMs, // engine's true total for the single ID search
        }
    });
})().catch(e => parentPort.postMessage({ error: e.message }));
