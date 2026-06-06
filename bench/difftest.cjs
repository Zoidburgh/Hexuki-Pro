// Differential correctness gate: the TT-enabled search MUST equal pure alpha-beta (TT disabled)
// on every position. Pure alpha-beta is a ground-truth oracle (it cannot have a TT bug), so any
// disagreement means the value-TT is wrong. This is what would have caught the wrong-EXACT bug
// the gate's fixed fixtures missed. Run after bench/build.ps1:  node bench/difftest.cjs
//
// Exits non-zero on any disagreement.
const F = require('./engine/hexuki.js');
const empt = m => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };

(async () => {
  const m = await F(); m.initialize();
  let tested = 0, fails = 0;
  // Deterministic spread of positions across empties 5..9 (TT-off is slow on bigger ones; the bug
  // class already shows by e=9 -- the 550-vs-539 case was e=9). Run deeper checks manually if wanted.
  for (let seed = 1; seed <= 600 && tested < 60; seed++) {
    const target = 5 + (seed % 5); // 5..9
    m.reset();
    let g = seed * 3 + 1;
    while (empt(m) > target && g++ < 60) {
      const mv = JSON.parse(m.getValidMoves()); if (!mv.length) break;
      const c = mv[(g * 31 + seed) % mv.length];
      if (!m.makeMove(c.h, c.t)) { for (const x of mv) if (m.makeMove(x.h, x.t)) break; }
    }
    if (empt(m) !== target) continue;
    const pos = m.savePosition(); const e = target;
    m.loadPosition(pos); const on = JSON.parse(m.minimaxFindBestMove(e, 600000));        // TT enabled
    m.loadPosition(pos); const off = JSON.parse(m.minimaxFindBestMoveNoTT(e, 600000));    // ground truth
    tested++;
    if (on.score !== off.score) { fails++; console.log(`  DIFF e=${e}: TT-on=${on.score} truth=${off.score}  ${pos}`); }
  }
  console.log(`\nDIFFTEST: ${tested} positions (e=5..9), ${fails} disagreement(s).`);
  if (fails === 0) { console.log('DIFFTEST: PASS — TT-enabled search == pure alpha-beta everywhere.'); process.exit(0); }
  console.log('DIFFTEST: FAIL — the TT returns wrong values; do NOT ship.'); process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
