// Threaded correctness gate: native root-split N-thread solve must (a) give the same VALUE as
// single-threaded every run, and (b) report an OPTIMAL move (playing it yields a child whose
// value equals the parent's). Threading is non-deterministic, so we repeat. Run after build-native.
const { execFileSync } = require('child_process');
const path = require('path');
const EXE = path.join(__dirname, '..', 'native', 'hexuki-solve.exe');
const F = require('./engine/hexuki.js');
const empt = m => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };
const solve = (pos, threads) =>
  JSON.parse(execFileSync(EXE, [pos, '0', '2147483647', '--threads', String(threads)], { encoding: 'utf8' }).trim());

(async () => {
  const m = await F(); m.initialize();
  let tested = 0, valFails = 0, moveFails = 0;
  for (let seed = 1; seed <= 600 && tested < 30; seed++) {
    const target = 8 + (seed % 4); // 8..11 (deeper -> stresses the parallel split + aspiration + YBW)
    m.reset();
    let step = 0;
    while (empt(m) > target) {
      const mv = JSON.parse(m.getValidMoves()); if (!mv.length) break;
      const c = mv[((step * 31 + seed * 17 + 7) >>> 0) % mv.length];
      if (!m.makeMove(c.h, c.t)) { let ok = false; for (const x of mv) if (m.makeMove(x.h, x.t)) { ok = true; break; } if (!ok) break; }
      step++;
    }
    if (empt(m) !== target) continue;
    const pos = m.savePosition();
    const ref = solve(pos, 1).score;                 // single-thread reference value
    let valOk = true, moveOk = true;
    for (let r = 0; r < 3; r++) {
      const t8 = solve(pos, 8);
      if (t8.score !== ref) { valOk = false; console.log(`  VALUE DIFF e=${target}: t1=${ref} t8=${t8.score}  ${pos}`); }
      // move-optimality: play t8's move, the child value (from parent's player) must equal ref
      m.loadPosition(pos);
      if (m.makeMove(t8.hexId, t8.tileValue)) {
        let e = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) e++;
        const child = JSON.parse(m.minimaxFindBestMove(e, 600000));
        const childFromParent = -child.score; // negate to the parent's perspective
        if (childFromParent !== ref) { moveOk = false; console.log(`  MOVE SUBOPTIMAL e=${target}: ref=${ref} child=${childFromParent} move=H${t8.hexId+1}+${t8.tileValue}  ${pos}`); }
      } else { moveOk = false; console.log(`  ILLEGAL MOVE e=${target}: H${t8.hexId+1}+${t8.tileValue}  ${pos}`); }
    }
    tested++; if (!valOk) valFails++; if (!moveOk) moveFails++;
  }
  console.log(`\nDIFFTEST-THREADS: ${tested} positions x3 runs.  value fails=${valFails}  move fails=${moveFails}`);
  const ok = valFails === 0 && moveFails === 0;
  console.log(ok ? 'PASS — threaded value == single AND reported move is optimal.' : 'FAIL — do NOT ship.');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
