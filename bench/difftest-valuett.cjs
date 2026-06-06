// VALUE-TT differential gate: the value-returning TT (cfg useValueTT=1) MUST equal pure alpha-beta
// (the oracle) on every position, with iterative deepening ON and OFF. Pure alpha-beta cannot have
// a TT bug, so any disagreement = the value-TT is wrong. Also sweeps the hash invariant (cfg
// useValueTT=3 prints @HASHDRIFT if the incremental hash ever != the full recompute). This is the
// test that proves the Zobrist hand-hash fix: before it, value-TT disagreed on ~6% of positions.
// Run after bench/build.ps1:  node bench/difftest-valuett.cjs   (exits non-zero on any disagreement)
const F = require('./engine/hexuki.js');
const empt = m => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };

(async () => {
  let drift = 0;
  const m = await F({ print: s => { if (s.indexOf('@HASHDRIFT') === 0) { drift++; if (drift <= 3) console.log('  ' + s.trim()); } } });
  m.initialize();
  let tested = 0, failID = 0, failNoID = 0;

  // Permanent regression fixtures: the exact positions where the value-TT returned WRONG values
  // before the Zobrist hand-hash fix (a hash collision swapped a value between two states whose
  // only difference was which player held a tile). Each must now match pure alpha-beta.
  const KNOWN = [
    { e: 9,  pos: 'h4:6,h6:2,h8:1,h9:1,h10:6,h12:7,h13:2,h14:9,h16:3,h17:3|p1:4,5,8,9|p2:1,4,5,7,8|turn:2' },   // was 550 vs 539
    { e: 11, pos: 'h2:7,h4:5,h7:3,h9:1,h11:7,h12:3,h15:8,h17:6|p1:1,2,4,5,9|p2:1,2,4,6,8,9|turn:2' },           // was -55 vs -56
    { e: 10, pos: 'h1:7,h4:4,h9:1,h10:2,h11:9,h12:5,h15:9,h17:5,h18:3|p1:1,2,4,6,8|p2:1,3,6,7,8|turn:1' },      // was 1321 vs 1243
  ];
  for (const k of KNOWN) {
    m.loadPosition(k.pos); const truth = JSON.parse(m.minimaxFindBestMoveNoTT(k.e, 600000)).score;
    m.loadPosition(k.pos); const vID   = JSON.parse(m.minimaxFindBestMoveCfg(k.e, 600000, 1, 1)).score;
    m.loadPosition(k.pos); const vNo   = JSON.parse(m.minimaxFindBestMoveCfg(k.e, 600000, 1, 0)).score;
    tested++;
    if (vID !== truth) { failID++;  console.log(`  KNOWN DIFF(ID)   e=${k.e}: value-TT=${vID} truth=${truth}`); }
    if (vNo !== truth) { failNoID++; console.log(`  KNOWN DIFF(noID) e=${k.e}: value-TT=${vNo} truth=${truth}`); }
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
    m.loadPosition(pos); const truth = JSON.parse(m.minimaxFindBestMoveNoTT(e, 600000)).score;     // oracle
    m.loadPosition(pos); const vID   = JSON.parse(m.minimaxFindBestMoveCfg(e, 600000, 1, 1)).score; // value-TT + ID
    m.loadPosition(pos); const vNo   = JSON.parse(m.minimaxFindBestMoveCfg(e, 600000, 1, 0)).score;  // value-TT, no ID
    tested++;
    if (vID !== truth) { failID++; console.log(`  DIFF(ID)   e=${e}: value-TT=${vID} truth=${truth}  ${pos}`); }
    if (vNo !== truth) { failNoID++; console.log(`  DIFF(noID) e=${e}: value-TT=${vNo} truth=${truth}  ${pos}`); }
    // hash-invariant sweep on a subset (cfg=3 = value-TT + verify)
    if (seed % 4 === 0) { m.loadPosition(pos); m.minimaxFindBestMoveCfg(e, 600000, 3, 1); }
  }
  console.log(`\nVALUE-TT DIFFTEST: ${tested} positions (e=4..10)`);
  console.log(`  ID-on  disagreements : ${failID}`);
  console.log(`  no-ID  disagreements : ${failNoID}`);
  console.log(`  hash-drift events    : ${drift}`);
  if (failID === 0 && failNoID === 0 && drift === 0) {
    console.log('VALUE-TT DIFFTEST: PASS — value-TT == pure alpha-beta everywhere, hash invariant holds.');
    process.exit(0);
  }
  console.log('VALUE-TT DIFFTEST: FAIL — do NOT enable the value-TT.'); process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
