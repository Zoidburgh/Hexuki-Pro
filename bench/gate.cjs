// THE GATE. Run after every engine change, before deploying:
//     pwsh bench/build.ps1   &&   node bench/gate.cjs
// Exits non-zero on any failure. Three checks:
//   1. CORRECTNESS  - every fixture's score matches the frozen baseline
//   2. DETERMINISM  - same score + node count across repeated runs
//   3. CONSISTENCY  - on big diverse-tile positions, the perfect-play margin does
//                     not drift when you solve, play the best move, and solve again
//                     (this is the exact check that caught the off-by-one bug)
const fs = require('fs');
const path = require('path');
const F = require('./engine/hexuki.js');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline.json'), 'utf8'));
const stress = JSON.parse(fs.readFileSync(path.join(__dirname, 'stress-fixtures.json'), 'utf8'));
const baseBy = new Map(baseline.results.map(r => [r.name, r]));
const turnOf = p => parseInt(p.split('|')[3].split(':')[1]);
const absV = (raw, t) => (t === 1 ? raw : -raw);

(async () => {
  const m = await F(); m.initialize();
  let scoreFails = 0, nondetFails = 0, driftFails = 0;

  // 1 + 2: correctness vs baseline, and determinism
  for (const fx of fixtures) {
    m.loadPosition(fx.position); const a = JSON.parse(m.minimaxFindBestMove(fx.emptyHexes, 120000));
    m.loadPosition(fx.position); const b = JSON.parse(m.minimaxFindBestMove(fx.emptyHexes, 120000));
    const base = baseBy.get(fx.name);
    if (base && a.score !== base.score) { scoreFails++; console.log(`  CORRECTNESS FAIL ${fx.name}: baseline ${base.score} -> ${a.score}`); }
    if (a.score !== b.score || a.nodes !== b.nodes) { nondetFails++; console.log(`  DETERMINISM FAIL ${fx.name}: ${a.nodes}/${a.score} vs ${b.nodes}/${b.score}`); }
  }

  // 3: consistency on big stress positions
  for (const fx of stress) {
    m.loadPosition(fx.position); const r1 = JSON.parse(m.minimaxFindBestMove(fx.empties, 300000)); const v1 = absV(r1.score, turnOf(fx.position));
    m.loadPosition(fx.position); m.makeMove(r1.hexId, r1.tileValue); const pos2 = m.savePosition();
    m.loadPosition(pos2); const r2 = JSON.parse(m.minimaxFindBestMove(fx.empties - 1, 300000)); const v2 = absV(r2.score, turnOf(pos2));
    const ok = v1 === v2;
    if (!ok) driftFails++;
    console.log(`  ${ok ? 'ok  ' : 'DRIFT'} ${fx.name.padEnd(16)} e=${fx.empties}  value ${v1}${ok ? ' (stable)' : ' -> ' + v2 + ' DRIFTED'}  [${(r1.nodes / 1e6).toFixed(1)}M nodes]`);
  }

  const pass = scoreFails === 0 && nondetFails === 0 && driftFails === 0;
  console.log('\n' + '='.repeat(60));
  console.log(`CORRECTNESS: ${scoreFails === 0 ? 'PASS' : scoreFails + ' FAIL'}   ` +
              `DETERMINISM: ${nondetFails === 0 ? 'PASS' : nondetFails + ' FAIL'}   ` +
              `CONSISTENCY: ${driftFails === 0 ? 'PASS' : driftFails + ' FAIL'}`);
  console.log(pass ? 'GATE: PASS — safe to deploy.' : 'GATE: FAIL — do NOT deploy.');
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
