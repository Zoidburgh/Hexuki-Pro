// Shared helpers for the minimax benchmark.
const fs = require('fs');
const path = require('path');

const ENGINE = path.join(__dirname, 'engine', 'hexuki.js');

async function loadEngine() {
  const HexukiWasm = require(ENGINE);
  const m = await HexukiWasm();
  m.initialize();
  return m;
}

// Count placed hexes in a position string: "h6:5,h8:5,...|p1:..|p2:..|turn:1"
function placedCount(pos) {
  const head = pos.split('|')[0].trim();
  if (!head) return 0;
  return head.split(',').filter(s => s.length).length;
}

function emptiesOf(pos) {
  return 19 - placedCount(pos);
}

// Deterministic move pick: smallest (hexId, tileValue) among valid moves.
function pickMove(m) {
  const moves = JSON.parse(m.getValidMoves());
  if (!moves.length) return null;
  moves.sort((a, b) => (a.h - b.h) || (a.t - b.t));
  return moves[0];
}

module.exports = { loadEngine, placedCount, emptiesOf, pickMove };
