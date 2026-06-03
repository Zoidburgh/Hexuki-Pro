// Compare a fresh scorecard against the frozen baseline.
//   node compare.cjs [newRun] [baseline]
// Defaults: newRun = runs/latest.json, baseline = baseline.json
//
// HARD GATE: score must match on every fixture (game-theoretic value is
// invariant under any correctness-preserving optimization). A score mismatch
// exits non-zero. bestMove differences with equal score are "alt-optimal"
// (acceptable). nodes/time deltas are reported as the efficiency story.
const fs = require('fs');
const path = require('path');

const newFile = process.argv[2] || path.join(__dirname, 'runs', 'latest.json');
const baseFile = process.argv[3] || path.join(__dirname, 'baseline.json');

if (!fs.existsSync(baseFile)) { console.error(`No baseline at ${baseFile}. Create one: node run.cjs baseline.json`); process.exit(2); }
const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const cur  = JSON.parse(fs.readFileSync(newFile, 'utf8'));

const baseBy = new Map(base.results.map(r => [r.name, r]));
let scoreFails = 0, altOptimal = 0, missing = 0;
let nodesBase = 0, nodesCur = 0, timeBase = 0, timeCur = 0;

console.log('fixture                 score   nodes (base->cur)        time (base->cur)      delta');
console.log('-'.repeat(96));
for (const c of cur.results) {
  const b = baseBy.get(c.name);
  if (!b) { console.log(`  ${c.name}  (new fixture, no baseline)`); missing++; continue; }
  nodesBase += b.nodes; nodesCur += c.nodes; timeBase += b.timeMs; timeCur += c.timeMs;

  const scoreOK = c.score === b.score;
  const moveOK = c.hexId === b.hexId && c.tileValue === b.tileValue;
  const nodeD = c.nodes - b.nodes;
  const timeD = b.timeMs ? ((c.timeMs - b.timeMs) / b.timeMs * 100) : 0;
  let tag;
  if (!scoreOK) { tag = `SCORE FAIL ${b.score}->${c.score}`; scoreFails++; }
  else if (!moveOK) { tag = 'alt-optimal'; altOptimal++; }
  else tag = 'ok';

  console.log(
    `  ${c.name.padEnd(20)} ${scoreOK ? '  ok ' : ' FAIL'}  ` +
    `${String(b.nodes).padStart(9)}->${String(c.nodes).padStart(9)} (${pct(nodeD, b.nodes)})  ` +
    `${b.timeMs.toFixed(1).padStart(7)}->${c.timeMs.toFixed(1).padStart(7)}ms (${timeD>=0?'+':''}${timeD.toFixed(0)}%)  ${tag}`
  );
}

function pct(d, base) { if (!base) return 'n/a'; const p = d / base * 100; return (p>=0?'+':'') + p.toFixed(0) + '%'; }

const nodeSpeedup = nodesBase ? (1 - nodesCur / nodesBase) * 100 : 0;
const timeSpeedup = timeBase ? (1 - timeCur / timeBase) * 100 : 0;
console.log('-'.repeat(96));
console.log(`TOTAL nodes ${nodesBase.toLocaleString()} -> ${nodesCur.toLocaleString()}  (${nodeSpeedup>=0?'-':'+'}${Math.abs(nodeSpeedup).toFixed(1)}% ${nodeSpeedup>=0?'fewer':'more'})`);
console.log(`TOTAL time  ${timeBase.toFixed(0)}ms -> ${timeCur.toFixed(0)}ms  (${timeSpeedup>=0?'':'-'}${timeSpeedup.toFixed(1)}% ${timeSpeedup>=0?'faster':'SLOWER'})`);
console.log(`Correctness: ${scoreFails===0 ? 'PASS (all scores match)' : `FAIL (${scoreFails} score mismatches)`}  |  alt-optimal moves: ${altOptimal}  |  unmatched: ${missing}`);
process.exit(scoreFails === 0 ? 0 : 1);
