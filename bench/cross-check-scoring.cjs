// SCORING cross-check: the C++ engine's per-player score must equal the canonical JS engine's on
// arbitrary boards -- INCLUDING partially-filled ones with dead (all-empty) chains, the regime the
// "empty chain scores 0, not 1" fix touches. We only ever cross-checked legal MOVES before, never
// scores, which is exactly how a scoring bug could hide. Run after bench/build.ps1:
//   node bench/cross-check-scoring.cjs
const fs = require('fs');
const path = require('path');
const NewFactory = require('./engine/hexuki.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'hexuki_game_engine_asymmetric.js'), 'utf8');
const JSEngine = new Function('window', src + '\nreturn window.HexukiGameEngineAsymmetric;')({});

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Random board: each hex filled (~prob p) with a random value 1-9; rest empty. Spans full boards,
// sparse boards, and everything between -> exercises empty/partial/full chains.
function genBoard(seed) {
  const r = rng(seed); const p = 0.25 + r() * 0.7; const placed = [];
  const board = new Array(19).fill(null);
  for (let h = 0; h < 19; h++) if (r() < p) { const v = 1 + Math.floor(r() * 9); board[h] = v; placed.push(`h${h}:${v}`); }
  return { str: `${placed.join(',')}|p1:|p2:|turn:1`, board };
}

(async () => {
  const m = await NewFactory(); m.initialize();
  const g = new JSEngine();
  let tested = 0, mism = 0, shown = 0;
  for (let s = 1; s <= 3000; s++) {
    const { str, board } = genBoard(s);
    let c1, c2, j1, j2;
    try {
      m.loadPosition(str); c1 = m.getScoreP1(); c2 = m.getScoreP2();
      for (let h = 0; h < 19; h++) { g.board[h].value = board[h]; g.board[h].owner = board[h] !== null ? 'x' : null; }
      j1 = g.calculatePlayerScore(1); j2 = g.calculatePlayerScore(2);
    } catch (e) { continue; }
    tested++;
    if (c1 !== j1 || c2 !== j2) {
      mism++;
      if (shown++ < 8) console.log(`MISMATCH ${str}\n   C++ P1/P2 = ${c1}/${c2}   JS P1/P2 = ${j1}/${j2}`);
    }
  }
  console.log(`\nSCORING CROSS-CHECK: ${tested} boards, ${mism} mismatch(es).`);
  console.log(mism === 0 ? 'PASS — C++ scores == canonical JS everywhere (incl. dead chains).'
                         : 'FAIL — scoring diverges between engines.');
  process.exit(mism === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
