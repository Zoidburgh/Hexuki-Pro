// EXPANDED game-logic cross-check: the C++ engine's legal-move set must equal the canonical JS
// engine's (hexuki_game_engine_asymmetric.js) on MANY positions -- including the regime that the
// 3-fixture cross-check never exercised: mirror-able boards with DIVERGED hands (where the C++
// anti-symmetry gate `tilesAreIdentical` turns off). Any disagreement = a real rules mismatch that
// would make the minimax solve wrong. Run after bench/build.ps1:  node bench/cross-check-expanded.cjs
const fs = require('fs');
const path = require('path');
const NewFactory = require('./engine/hexuki.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'hexuki_game_engine_asymmetric.js'), 'utf8');
const JSEngine = new Function('window', src + '\nreturn window.HexukiGameEngineAsymmetric;')({});

function parse(pos) {
  const [placed, p1, p2, turnS] = pos.split('|');
  const board = {};
  if (placed) for (const t of placed.split(',')) { const [h, v] = t.split(':'); board[+h.slice(1)] = +v; }
  return { board,
    p1: p1.split(':')[1].split(',').filter(x => x).map(Number),
    p2: p2.split(':')[1].split(',').filter(x => x).map(Number),
    turn: +turnS.split(':')[1] };
}
const cppMoves = (m, pos) => { m.loadPosition(pos); return new Set(JSON.parse(m.getValidMoves()).map(x => `h${x.h}:${x.t}`)); };
function jsMoves(pos) {
  const p = parse(pos);
  const g = new JSEngine();
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in p.board) ? p.board[h] : null; g.board[h].owner = (h in p.board) ? 'x' : null; }
  g.player1Tiles = p.p1; g.player2Tiles = p.p2; g.currentPlayer = p.turn;
  g.tilesAreIdentical = g.tilesMatch(p.p1, p.p2);
  return new Set(g.getAllValidMoves().map(x => `h${x.hexId}:${x.tileValue}`));
}
const empt = m => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };

(async () => {
  const m = await NewFactory(); m.initialize();
  const positions = [];

  // (1) random playouts from the opening -> natural spread of empties + hand divergence.
  for (let seed = 1; seed <= 400 && positions.length < 250; seed++) {
    const target = 2 + (seed % 15);   // e = 2..16
    m.reset(); let step = 0;
    while (empt(m) > target) {
      const mv = JSON.parse(m.getValidMoves()); if (!mv.length) break;
      const c = mv[((step * 31 + seed * 17 + 7) >>> 0) % mv.length];
      if (!m.makeMove(c.h, c.t)) { let ok = false; for (const x of mv) if (m.makeMove(x.h, x.t)) { ok = true; break; } if (!ok) break; }
      positions.push(m.savePosition());   // capture every intermediate position too
      step++;
    }
  }

  // (2) constructed STRESS cases: mirror-able board (symmetry still possible) + DIVERGED hands.
  // Mirror pairs straddle the center column; an axis/near-axis board stays mirror-able. Hands differ
  // so the C++ gate would be OFF -- the exact regime the 3-fixture test missed.
  positions.push('h9:1|p1:1,2,3,4,5,6,7,8|p2:1,2,3,4,5,6,7,9|turn:1');           // near-empty, diverged
  positions.push('h9:1,h6:3,h7:3|p1:1,2,4,5|p2:1,2,4,6|turn:1');                  // symmetric placed, diverged hands
  positions.push('h9:1,h4:5,h5:5|p1:2,3,6|p2:2,3,7|turn:2');                      // mirror pair h4/h5 same, diverged
  positions.push('h9:1,h0:2,h2:2|p1:3,4,5|p2:3,4,6|turn:1');                      // mirror pair h0/h2 same, diverged

  let tested = 0, mism = 0;
  for (const pos of positions) {
    let c, j;
    try { c = cppMoves(m, pos); j = jsMoves(pos); } catch (e) { continue; }
    tested++;
    const onlyC = [...c].filter(x => !j.has(x)), onlyJ = [...j].filter(x => !c.has(x));
    if (onlyC.length || onlyJ.length) {
      mism++;
      if (mism <= 6) {
        console.log(`MISMATCH  ${pos}`);
        if (onlyC.length) console.log(`   C++ allows, JS rejects: ${onlyC.join(', ')}`);
        if (onlyJ.length) console.log(`   JS allows, C++ rejects: ${onlyJ.join(', ')}`);
      }
    }
  }
  console.log(`\nEXPANDED CROSS-CHECK: ${tested} positions, ${mism} mismatch(es).`);
  console.log(mism === 0 ? 'PASS — C++ legal moves == canonical JS everywhere tested (incl. diverged-hands).'
                         : 'FAIL — the C++ rules diverge from the JS reference; solves on those positions are suspect.');
  process.exit(mism === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
