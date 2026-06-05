// Verify the JS engine's makeMove (the manual-placement path) rejects a mirror
// move once tilesAreIdentical is set (as the fixed editor setup now does).
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'hexuki_game_engine_asymmetric.js'), 'utf8');
const Engine = new Function('window', src + '\nreturn window.HexukiGameEngineAsymmetric;')({});

function setup(board, p1, p2, turn) {        // mimic the (fixed) editor startPlay
  const g = new Engine();
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in board) ? board[h] : null; g.board[h].owner = null; }
  g.player1Tiles = [...p1]; g.player2Tiles = [...p2]; g.currentPlayer = turn;
  g.tilesAreIdentical = g.tilesMatch(g.player1Tiles, g.player2Tiles);   // the line the editor was missing
  return g;
}

// Board one move from mirror: h1:5 (mirror h2 empty), matched pair h6:3/h7:3, P2 to move.
const board = { 1: 5, 6: 3, 7: 3, 9: 1 };
console.log('gate (tilesAreIdentical):', setup(board, [5,2,3], [5,2,3], 2).tilesAreIdentical);

let g = setup(board, [5,2,3], [5,2,3], 2);
console.log('makeMove(h2, tile 5)  [completes the mirror] ->', g.makeMove(2, 5), '(expect false)');
g = setup(board, [5,2,3], [5,2,3], 2);
console.log('makeMove(h2, tile 2)  [does NOT mirror]      ->', g.makeMove(2, 2), '(expect true)');

// With NON-identical tiles, the gate is off -> mirror move allowed
g = setup(board, [5,2,3], [5,2,4], 2);
console.log('non-identical tiles: makeMove(h2, tile 5)    ->', g.makeMove(2, 5), '(expect true, gate off)');
