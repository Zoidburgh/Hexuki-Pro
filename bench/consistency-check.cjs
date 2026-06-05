// Regression test for the "margin drifts under perfect play" bug class.
// Solve a position, play the engine's own best move, solve again; with both sides
// optimal the absolute (P1-P2) value must NOT change. Big diverse-tile positions
// stress the transposition table in ways the small benchmark fixtures don't.
const path = require('path');
const F = require('./engine/hexuki.js');

const POSITIONS = [
  'h2:9,h3:3,h4:7,h6:3,h7:4,h8:5,h9:1,h12:2|p1:1,2,6,8,9|p2:1,4,5,6,7,8|turn:2', // the one that exposed it
];
const turnOf = p => parseInt(p.split('|')[3].split(':')[1]);
const absV = (raw, turn) => (turn === 1 ? raw : -raw);

(async () => {
  const m = await F(); m.initialize();
  let bad = 0;
  for (const pos of POSITIONS) {
    const e = 19 - pos.split('|')[0].split(',').length;
    m.loadPosition(pos); const r1 = JSON.parse(m.minimaxFindBestMove(e, 300000)); const a1 = absV(r1.score, turnOf(pos));
    m.loadPosition(pos); m.makeMove(r1.hexId, r1.tileValue); const pos2 = m.savePosition();
    m.loadPosition(pos2); const r2 = JSON.parse(m.minimaxFindBestMove(e - 1, 300000)); const a2 = absV(r2.score, turnOf(pos2));
    const ok = a1 === a2;
    if (!ok) bad++;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${e}-empty  value ${a1} -> ${a2} after best move ${ok ? '(stable)' : '(DRIFTED by ' + (a1 - a2) + ')'}`);
  }
  console.log(bad === 0 ? '\nPASS: perfect-play value is stable (no margin drift).' : `\nFAIL: ${bad} position(s) drifted.`);
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
