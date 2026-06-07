// ASPIRATION differential gate: iterative deepening WITH aspiration windows MUST equal pure
// alpha-beta (the oracle) AND equal ID without aspiration, on every position. Aspiration only
// narrows the search window around the previous depth's score + re-searches on a fail, so it can
// never change the game-theoretic value -- any disagreement = the re-search/accept logic is wrong.
// useID bitmask: 1=ID, 3=ID+aspiration. useValueTT=1 (value-TT on, the shipped path).
// Run after bench/build.ps1:  node bench/difftest-aspiration.cjs   (exits non-zero on disagreement)
const F = require('./engine/hexuki.js');
const empt = m => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };

(async () => {
  const m = await F(); m.initialize();
  let tested = 0, failAsp = 0, nodesOff = 0, nodesOn = 0;

  // Permanent fixtures: the historical wrong-value positions must also match under aspiration.
  const KNOWN = [
    { e: 9,  pos: 'h4:6,h6:2,h8:1,h9:1,h10:6,h12:7,h13:2,h14:9,h16:3,h17:3|p1:4,5,8,9|p2:1,4,5,7,8|turn:2' },
    { e: 11, pos: 'h2:7,h4:5,h7:3,h9:1,h11:7,h12:3,h15:8,h17:6|p1:1,2,4,5,9|p2:1,2,4,6,8,9|turn:2' },
    { e: 10, pos: 'h1:7,h4:4,h9:1,h10:2,h11:9,h12:5,h15:9,h17:5,h18:3|p1:1,2,4,6,8|p2:1,3,6,7,8|turn:1' },
  ];
  for (const k of KNOWN) {
    m.loadPosition(k.pos); const truth = JSON.parse(m.minimaxFindBestMoveNoTT(k.e, 600000)).score;
    m.loadPosition(k.pos); const asp   = JSON.parse(m.minimaxFindBestMoveCfg(k.e, 600000, 1, 3)).score; // ID+aspiration
    tested++;
    if (asp !== truth) { failAsp++; console.log(`  KNOWN DIFF e=${k.e}: aspiration=${asp} truth=${truth}`); }
    else console.log(`  ok  known e=${k.e}: ${truth}`);
  }

  for (let seed = 1; seed <= 4000 && tested < 200; seed++) {
    const target = 4 + (seed % 7); // 4..10
    m.reset();
    let step = 0;
    while (empt(m) > target) {
      const mv = JSON.parse(m.getValidMoves()); if (!mv.length) break;
      const c = mv[((step * 31 + seed * 17 + 7) >>> 0) % mv.length];
      if (!m.makeMove(c.h, c.t)) { let ok = false; for (const x of mv) if (m.makeMove(x.h, x.t)) { ok = true; break; } if (!ok) break; }
      step++;
    }
    if (empt(m) !== target) continue;
    const pos = m.savePosition(); const e = target;
    m.loadPosition(pos); const truth = JSON.parse(m.minimaxFindBestMoveNoTT(e, 600000)).score;       // oracle
    m.loadPosition(pos); const off   = JSON.parse(m.minimaxFindBestMoveCfg(e, 600000, 1, 1));         // ID, no aspiration
    m.loadPosition(pos); const on    = JSON.parse(m.minimaxFindBestMoveCfg(e, 600000, 1, 3));         // ID + aspiration
    tested++; nodesOff += off.nodes; nodesOn += on.nodes;
    if (on.score !== truth) { failAsp++; console.log(`  DIFF e=${e}: aspiration=${on.score} truth=${truth}  ${pos}`); }
  }
  console.log(`\nASPIRATION DIFFTEST: ${tested} positions`);
  console.log(`  disagreements vs oracle : ${failAsp}`);
  console.log(`  node ratio (asp / no-asp): ${(nodesOn / nodesOff).toFixed(3)}  (<1 = aspiration searched fewer)`);
  if (failAsp === 0) { console.log('ASPIRATION DIFFTEST: PASS — aspiration == pure alpha-beta everywhere.'); process.exit(0); }
  console.log('ASPIRATION DIFFTEST: FAIL — do NOT enable aspiration.'); process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
