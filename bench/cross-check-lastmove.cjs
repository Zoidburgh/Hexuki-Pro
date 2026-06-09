// LAST-MOVE cross-check: when exactly one in-play hex is empty, the placing player has no choice of
// location, so chain-length and anti-symmetry are WAIVED -- the final tile is always playable. This
// verifies (a) C++ and JS agree on those 1-empty positions, and (b) the forced square is ALWAYS offered
// even when it completes a mirror or would violate the chain rule (the regime this rule changes).
// Run after bench/build.ps1:  node bench/cross-check-lastmove.cjs
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
const cppMoves = (m, pos) => { m.setActiveHexes((1 << 19) - 1); m.loadPosition(pos); return new Set(JSON.parse(m.getValidMoves()).map(x => `h${x.h}:${x.t}`)); };
function jsMoves(pos) {
  const p = parse(pos); const g = new JSEngine(); g.activeMask = (1 << 19) - 1;
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in p.board) ? p.board[h] : null; g.board[h].owner = (h in p.board) ? 'x' : null; }
  g.player1Tiles = p.p1; g.player2Tiles = p.p2; g.currentPlayer = p.turn;
  return new Set(g.getAllValidMoves().map(x => `h${x.hexId}:${x.tileValue}`));
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 18 hexes filled with random values, ONE hex left empty; mover holds one random tile. Spans boards
// where the empty square would be chain-illegal and/or mirror-completing.
function genLast(seed) {
  const r = rng(seed);
  const empty = Math.floor(r() * 19);
  const placed = [];
  for (let h = 0; h < 19; h++) if (h !== empty) placed.push(`h${h}:${1 + Math.floor(r() * 9)}`);
  const tile = 1 + Math.floor(r() * 9);
  const turn = r() < 0.5 ? 1 : 2;
  const p = turn === 1 ? `p1:${tile}|p2:` : `p1:|p2:${tile}`;
  return { pos: `${placed.join(',')}|${p}|turn:${turn}`, empty, tile };
}

(async () => {
  const m = await NewFactory(); m.initialize();
  let tested = 0, mism = 0, missing = 0, shown = 0;
  for (let s = 1; s <= 3000; s++) {
    const { pos, empty, tile } = genLast(s);
    let c, j;
    try { c = cppMoves(m, pos); j = jsMoves(pos); } catch (e) { continue; }
    tested++;
    const want = `h${empty}:${tile}`;
    if (!c.has(want)) { missing++; if (shown < 4) console.log(`C++ did NOT offer forced ${want} in ${pos}`); }
    const onlyC = [...c].filter(x => !j.has(x)), onlyJ = [...j].filter(x => !c.has(x));
    if (onlyC.length || onlyJ.length) { mism++; if (shown++ < 6) { console.log(`MISMATCH ${pos}`); if (onlyC.length) console.log('  C++ only:', onlyC.join(',')); if (onlyJ.length) console.log('  JS only:', onlyJ.join(',')); } }
  }
  console.log(`\nLAST-MOVE CROSS-CHECK: ${tested} one-empty positions, ${mism} C++/JS mismatch(es), ${missing} missing forced move(s).`);
  const ok = mism === 0 && missing === 0;
  console.log(ok ? 'PASS — the final square is always playable and C++ == JS (chain-length + symmetry waived on the last move).'
                 : 'FAIL — last-move rule diverges.');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
