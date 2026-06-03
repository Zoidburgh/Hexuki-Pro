// Run the minimax solver over every fixture and emit a scorecard.
// Each fixture is solved to full depth (depth = emptyHexes), exactly as the
// puzzle editor does -> score is the game-theoretic final differential.
//   node run.cjs [outFile]   (default: bench/runs/latest.json)
const fs = require('fs');
const path = require('path');
const { loadEngine } = require('./lib.cjs');

const REPEATS = 3;            // take the min engine time (least noisy)
const TIMEOUT_MS = 60000;     // must be generous enough for a full solve
const FIXTURES = path.join(__dirname, 'fixtures.json');

(async () => {
  const outFile = process.argv[2] || path.join(__dirname, 'runs', 'latest.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const fixtures = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  const m = await loadEngine();
  const results = [];
  const wall0 = Date.now();

  for (const fx of fixtures) {
    let best = null, timedOut = false, nodesSeen = new Set();
    for (let r = 0; r < REPEATS; r++) {
      m.loadPosition(fx.position);
      const res = JSON.parse(m.minimaxFindBestMove(fx.emptyHexes, TIMEOUT_MS));
      const nodes = res.nodes ?? res.nodesExplored;
      nodesSeen.add(nodes);
      if (res.timeMs >= TIMEOUT_MS * 0.95) timedOut = true;
      if (!best || res.timeMs < best.timeMs) best = { ...res, nodes };
    }
    const row = {
      name: fx.name, emptyHexes: fx.emptyHexes,
      hexId: best.hexId, tileValue: best.tileValue,
      score: best.score, depth: best.depth, nodes: best.nodes,
      timeMs: +best.timeMs.toFixed(3),
      nodesStable: nodesSeen.size === 1,   // determinism sanity check
      timedOut,
    };
    results.push(row);
    const flag = timedOut ? ' !!TIMEOUT' : (row.nodesStable ? '' : ' !!NODES-VARY');
    console.log(`  ${fx.name.padEnd(22)} e=${fx.emptyHexes}  move=h${best.hexId}+${best.tileValue}  score=${String(best.score).padStart(4)}  nodes=${String(best.nodes).padStart(9)}  ${row.timeMs.toFixed(1)}ms${flag}`);
  }

  const wallMs = Date.now() - wall0;
  const totalNodes = results.reduce((s, r) => s + r.nodes, 0);
  const totalTime = +results.reduce((s, r) => s + r.timeMs, 0).toFixed(1);
  const scorecard = {
    meta: {
      fixtures: results.length, repeats: REPEATS, timeoutMs: TIMEOUT_MS,
      totalNodes, totalSolveMs: totalTime, wallMs,
      anyTimedOut: results.some(r => r.timedOut),
      anyNodesUnstable: results.some(r => !r.nodesStable),
    },
    results,
  };
  fs.writeFileSync(outFile, JSON.stringify(scorecard, null, 2));
  console.log(`\nTotal: ${results.length} fixtures | ${totalNodes.toLocaleString()} nodes | ${totalTime.toFixed(0)}ms solve | ${(wallMs/1000).toFixed(1)}s wall`);
  console.log(`Wrote ${outFile}`);
  if (scorecard.meta.anyTimedOut) console.log('WARNING: some fixtures timed out -> their score is NOT a full solve.');
})().catch(e => { console.error(e); process.exit(1); });
