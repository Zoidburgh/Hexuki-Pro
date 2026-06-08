// INNER-7 (beginner mode) cross-check: with the board restricted to the inner hexagon
// {4,6,7,9,11,12,14}, the C++ engine's legal moves must (a) equal the canonical JS engine's and
// (b) NEVER include an outer hex. If both hold, the minimax plays a correct inner-7 game (scoring is
// automatic -- outer hexes stay empty and drop out of the chain products). Run after bench/build.ps1:
//   node bench/cross-check-inner7.cjs
const fs = require('fs');
const path = require('path');
const NewFactory = require('./engine/hexuki.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'hexuki_game_engine_asymmetric.js'), 'utf8');
const JSEngine = new Function('window', src + '\nreturn window.HexukiGameEngineAsymmetric;')({});

const INNER = [4, 6, 7, 9, 11, 12, 14];
const INNER_SET = new Set(INNER);

function parse(pos) {
  const [placed, p1, p2, turnS] = pos.split('|');
  const board = {};
  if (placed) for (const t of placed.split(',')) { const [h, v] = t.split(':'); board[+h.slice(1)] = +v; }
  return { board, p1: p1.split(':')[1].split(',').filter(Boolean).map(Number),
           p2: p2.split(':')[1].split(',').filter(Boolean).map(Number), turn: +turnS.split(':')[1] };
}
const cppMoves7 = (m, pos) => { m.setBoardMode(7); m.loadPosition(pos); return JSON.parse(m.getValidMoves()); };
function jsMoves7(pos) {
  const p = parse(pos); const g = new JSEngine(); g.setBoardMode(7);
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in p.board) ? p.board[h] : null; g.board[h].owner = (h in p.board) ? 'x' : null; }
  g.player1Tiles = p.p1; g.player2Tiles = p.p2; g.currentPlayer = p.turn;
  g.tilesAreIdentical = g.tilesMatch(p.p1, p.p2);
  return new Set(g.getAllValidMoves().map(x => `h${x.hexId}:${x.tileValue}`));
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const POOLS = [[1, 2], [1, 2, 3], [1, 2, 3, 4], [2, 3], [1, 3], [3, 4]];

// Author an inner-7 position: fill a random subset of inner hexes, leave the rest (and ALL outer) empty.
function gen7(seed) {
  const r = rng(seed);
  const pool = pick(r, POOLS);
  const placed = [];
  for (const h of INNER) if (r() < 0.55) placed.push(`h${h}:${pick(r, pool)}`);
  if (placed.length === 0 || placed.length === INNER.length) return null;   // need some empty + some filled
  const hand = (n) => Array.from({ length: n }, () => pick(r, pool));
  return `${placed.join(',')}|p1:${hand(2 + Math.floor(r() * 3)).join(',')}|p2:${hand(2 + Math.floor(r() * 3)).join(',')}|turn:1`;
}

(async () => {
  const m = await NewFactory(); m.initialize();
  let tested = 0, mism = 0, outerLeak = 0, shown = 0;
  for (let s = 1; s <= 2000; s++) {
    const pos = gen7(s); if (!pos) continue;
    let cppRaw, j;
    try { cppRaw = cppMoves7(m, pos); j = jsMoves7(pos); } catch (e) { continue; }
    tested++;
    const c = new Set(cppRaw.map(x => `h${x.h}:${x.t}`));
    // (b) no move on an outer hex
    for (const x of cppRaw) if (!INNER_SET.has(x.h)) { outerLeak++; if (shown < 4) console.log(`OUTER LEAK h${x.h} in ${pos}`); break; }
    // (a) parity with JS
    const onlyC = [...c].filter(x => !j.has(x)), onlyJ = [...j].filter(x => !c.has(x));
    if (onlyC.length || onlyJ.length) {
      mism++;
      if (shown++ < 6) {
        console.log(`MISMATCH  ${pos}`);
        if (onlyC.length) console.log(`   C++ allows, JS rejects: ${onlyC.join(', ')}`);
        if (onlyJ.length) console.log(`   JS allows, C++ rejects: ${onlyJ.join(', ')}`);
      }
    }
  }
  console.log(`\nINNER-7 CROSS-CHECK: ${tested} positions, ${mism} legal-move mismatch(es), ${outerLeak} outer-hex leak(s).`);
  const ok = mism === 0 && outerLeak === 0;
  console.log(ok ? 'PASS — inner-7 legal moves == canonical JS, and no move ever lands on the outer ring.'
                 : 'FAIL — beginner-mode rules diverge; do NOT trust 7-hex solves until fixed.');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
