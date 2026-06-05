// Confirm the C++ engine and the JS asymmetric engine now produce IDENTICAL
// legal-move sets (the goal: synced game logic). Loads both in Node.
const fs = require('fs');
const path = require('path');
const NewFactory = require('./engine/hexuki.js');

// Load the browser-style JS engine class under Node.
const src = fs.readFileSync(path.join(__dirname, '..', 'hexuki_game_engine_asymmetric.js'), 'utf8');
const HexukiGameEngineAsymmetric = new Function('window', src + '\nreturn window.HexukiGameEngineAsymmetric;')({});

function parse(pos) {
  const [placed, p1, p2, turnS] = pos.split('|');
  const board = {};
  if (placed) for (const t of placed.split(',')) { const [h, v] = t.split(':'); board[+h.slice(1)] = +v; }
  return {
    board,
    p1: p1.split(':')[1].split(',').filter(x => x).map(Number),
    p2: p2.split(':')[1].split(',').filter(x => x).map(Number),
    turn: +turnS.split(':')[1],
  };
}
const cppMoves = (m, pos) => { m.loadPosition(pos); return new Set(JSON.parse(m.getValidMoves()).map(x => `h${x.h}:${x.t}`)); };
function jsMoves(pos) {
  const p = parse(pos);
  const g = new HexukiGameEngineAsymmetric();
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in p.board) ? p.board[h] : null; g.board[h].owner = (h in p.board) ? 'x' : null; }
  g.player1Tiles = p.p1; g.player2Tiles = p.p2; g.currentPlayer = p.turn;
  g.tilesAreIdentical = g.tilesMatch(p.p1, p.p2);
  return new Set(g.getAllValidMoves().map(x => `h${x.hexId}:${x.tileValue}`));  // Set dedups JS duplicate-tile moves
}
const diff = (a, b) => [...a].filter(x => !b.has(x));

const POSITIONS = {
  'identical, one-from-mirror': 'h1:5,h6:3,h7:3,h9:1|p1:5,2,3|p2:5,2,3|turn:2',
  'buggy fixture A (editor-valid)': 'h0:5,h1:1,h2:1,h3:1,h4:5,h5:1,h6:1,h7:1,h9:5,h14:5,h18:5|p1:2,2,2,3|p2:2,2,2,3|turn:1',
  'NON-identical control (gate off)': 'h1:5,h6:3,h7:3,h9:1|p1:5,2,3|p2:5,2,4|turn:2',
};

(async () => {
  const m = await NewFactory(); m.initialize();
  let allMatch = true;
  for (const [label, pos] of Object.entries(POSITIONS)) {
    const c = cppMoves(m, pos), j = jsMoves(pos);
    const onlyC = diff(c, j), onlyJ = diff(j, c);
    const ok = onlyC.length === 0 && onlyJ.length === 0;
    allMatch = allMatch && ok;
    console.log(`${ok ? 'MATCH' : 'DIFFER'}  ${label}  (C++ ${c.size} moves, JS ${j.size} moves)`);
    if (!ok) { if (onlyC.length) console.log(`    only in C++: ${onlyC.join(', ')}`); if (onlyJ.length) console.log(`    only in JS:  ${onlyJ.join(', ')}`); }
  }
  console.log(allMatch ? '\nALL MATCH — C++ and JS game logic agree.' : '\nMISMATCH — see above.');
})().catch(e => { console.error(e); process.exit(1); });
