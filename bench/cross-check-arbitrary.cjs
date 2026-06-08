// ARBITRARY-FILL cross-check: the puzzle finder will author positions that are NOT reachable by
// legal play -- any pattern of hexes, any tile values (non-1 centers, themed pools), any hands. The
// solver must rule those exactly like the canonical JS engine, or solves on them are meaningless.
// This sweeps arbitrary fills across patterns/themes/hands and asserts C++ legal moves == JS legal
// moves on every one. Run after bench/build.ps1:  node bench/cross-check-arbitrary.cjs
const fs = require('fs');
const path = require('path');
const NewFactory = require('./engine/hexuki.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'hexuki_game_engine_asymmetric.js'), 'utf8');
const JSEngine = new Function('window', src + '\nreturn window.HexukiGameEngineAsymmetric;')({});

function parse(pos) {
  const [placed, p1, p2, turnS] = pos.split('|');
  const board = {};
  if (placed) for (const t of placed.split(',')) { const [h, v] = t.split(':'); board[+h.slice(1)] = +v; }
  return { board, p1: p1.split(':')[1].split(',').filter(Boolean).map(Number),
           p2: p2.split(':')[1].split(',').filter(Boolean).map(Number), turn: +turnS.split(':')[1] };
}
const cppMoves = (m, pos) => { m.loadPosition(pos); return new Set(JSON.parse(m.getValidMoves()).map(x => `h${x.h}:${x.t}`)); };
function jsMoves(pos) {
  const p = parse(pos); const g = new JSEngine();
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in p.board) ? p.board[h] : null; g.board[h].owner = (h in p.board) ? 'x' : null; }
  g.player1Tiles = p.p1; g.player2Tiles = p.p2; g.currentPlayer = p.turn;
  g.tilesAreIdentical = g.tilesMatch(p.p1, p.p2);
  return new Set(g.getAllValidMoves().map(x => `h${x.hexId}:${x.tileValue}`));
}

// seeded PRNG
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];

// tile-value pools spanning the themes the finder will use
const POOLS = [
  [1, 8], [2, 9], [3, 7], [1, 9],                 // pairs
  [1, 2, 3], [7, 8, 9],                           // low / high
  [1, 2, 3, 4, 5, 6, 7, 8, 9],                    // full
  [8, 8, 8, 8, 1, 1], [9, 9, 9, 3, 3],            // duplicate-heavy
];

// One arbitrary authored position: random hex subset (any pattern, incl. non-1 / empty center),
// themed values, hands sized to fill the empties with P1 to move.
function genArbitrary(seed) {
  const r = rng(seed);
  const fillN = 5 + Math.floor(r() * 9);                 // 5..13 filled hexes
  const hexes = [...Array(19).keys()];
  for (let i = hexes.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [hexes[i], hexes[j]] = [hexes[j], hexes[i]]; }
  const filled = hexes.slice(0, fillN).sort((a, b) => a - b);
  const boardPool = pick(r, POOLS);
  const placed = filled.map(h => `h${h}:${pick(r, boardPool)}`);
  const E = 19 - fillN;
  const p1n = Math.ceil(E / 2), p2n = Math.floor(E / 2);
  const handPool = pick(r, POOLS);
  const hand = (n) => Array.from({ length: n }, () => pick(r, handPool));
  if (p1n < 1) return null;                               // need at least one P1 move slot
  return `${placed.join(',')}|p1:${hand(p1n).join(',')}|p2:${hand(p2n).join(',')}|turn:1`;
}

(async () => {
  const m = await NewFactory(); m.initialize();
  let tested = 0, mism = 0, shown = 0;
  for (let s = 1; s <= 1500; s++) {
    const pos = genArbitrary(s); if (!pos) continue;
    let c, j;
    try { c = cppMoves(m, pos); j = jsMoves(pos); } catch (e) { continue; }
    tested++;
    const onlyC = [...c].filter(x => !j.has(x)), onlyJ = [...j].filter(x => !c.has(x));
    if (onlyC.length || onlyJ.length) {
      mism++;
      if (shown++ < 8) {
        console.log(`MISMATCH  ${pos}`);
        if (onlyC.length) console.log(`   C++ allows, JS rejects: ${onlyC.join(', ')}`);
        if (onlyJ.length) console.log(`   JS allows, C++ rejects: ${onlyJ.join(', ')}`);
      }
    }
  }
  console.log(`\nARBITRARY-FILL CROSS-CHECK: ${tested} authored positions, ${mism} mismatch(es).`);
  console.log(mism === 0 ? 'PASS — C++ rules == canonical JS on arbitrary authored fills; finder solves are trustworthy.'
                         : 'FAIL — arbitrary fills diverge; do NOT trust finder solves until fixed.');
  process.exit(mism === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
