// ARBITRARY-BLACKOUT cross-check: the editor can black out ANY subset of hexes (even one). For every
// random active mask -- including ASYMMETRIC ones the anti-symmetry rule never saw -- the C++ engine's
// legal moves must equal the canonical JS engine's, and no move may land on a blacked-out hex. Proves
// the general blackout feature is rule-correct. Run after bench/build.ps1: node bench/cross-check-blackout.cjs
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
const cppMoves = (m, pos, mask) => { m.setActiveHexes(mask); m.loadPosition(pos); return JSON.parse(m.getValidMoves()); };
function jsMoves(pos, mask) {
  const p = parse(pos); const g = new JSEngine(); g.activeMask = mask;
  for (let h = 0; h < 19; h++) { g.board[h].value = (h in p.board) ? p.board[h] : null; g.board[h].owner = (h in p.board) ? 'x' : null; }
  g.player1Tiles = p.p1; g.player2Tiles = p.p2; g.currentPlayer = p.turn;
  g.tilesAreIdentical = g.tilesMatch(p.p1, p.p2);
  return new Set(g.getAllValidMoves().map(x => `h${x.hexId}:${x.tileValue}`));
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const POOLS = [[1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 9], [2, 3], [1, 2, 3, 4, 5, 6, 7, 8, 9]];

// Random active mask: each hex in play with ~65% prob (so 0..19 blacked out, asymmetric), >=3 active.
function genCase(seed) {
  const r = rng(seed);
  let mask = 0; const active = [];
  for (let h = 0; h < 19; h++) if (r() < 0.65) { mask |= (1 << h); active.push(h); }
  if (active.length < 3) return null;
  const pool = pick(r, POOLS);
  // fill a random subset of ACTIVE hexes, leave the rest (and all blacked-out) empty
  const placed = [];
  for (const h of active) if (r() < 0.5) placed.push(`h${h}:${pick(r, pool)}`);
  if (placed.length === 0 || placed.length === active.length) return null;
  const hand = (n) => Array.from({ length: n }, () => pick(r, pool));
  const pos = `${placed.join(',')}|p1:${hand(2 + Math.floor(r() * 3)).join(',')}|p2:${hand(2 + Math.floor(r() * 3)).join(',')}|turn:${r() < 0.5 ? 1 : 2}`;
  return { pos, mask, active: new Set(active) };
}

(async () => {
  const m = await NewFactory(); m.initialize();
  let tested = 0, mism = 0, leak = 0, shown = 0;
  for (let s = 1; s <= 2500; s++) {
    const cse = genCase(s); if (!cse) continue;
    let cppRaw, j;
    try { cppRaw = cppMoves(m, cse.pos, cse.mask); j = jsMoves(cse.pos, cse.mask); } catch (e) { continue; }
    tested++;
    const c = new Set(cppRaw.map(x => `h${x.h}:${x.t}`));
    for (const x of cppRaw) if (!cse.active.has(x.h)) { leak++; if (shown < 4) console.log(`LEAK h${x.h} (mask ${cse.mask}) ${cse.pos}`); break; }
    const onlyC = [...c].filter(x => !j.has(x)), onlyJ = [...j].filter(x => !c.has(x));
    if (onlyC.length || onlyJ.length) {
      mism++;
      if (shown++ < 6) {
        console.log(`MISMATCH mask=${cse.mask}  ${cse.pos}`);
        if (onlyC.length) console.log(`   C++ allows, JS rejects: ${onlyC.join(', ')}`);
        if (onlyJ.length) console.log(`   JS allows, C++ rejects: ${onlyJ.join(', ')}`);
      }
    }
  }
  console.log(`\nBLACKOUT CROSS-CHECK: ${tested} random masks, ${mism} mismatch(es), ${leak} leak(s) onto blacked-out hexes.`);
  const ok = mism === 0 && leak === 0;
  console.log(ok ? 'PASS — arbitrary blackout is rule-correct (C++ == JS, no move ever lands on a blacked-out hex).'
                 : 'FAIL — arbitrary blackout diverges; do NOT ship per-hex blackout until fixed.');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
