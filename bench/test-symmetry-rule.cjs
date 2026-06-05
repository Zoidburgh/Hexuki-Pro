// Clean isolation of the anti-symmetry rule. Same tiles (identical -> gate ON) in
// both cases; the ONLY change is h1's value. h1's mirror is h2 (empty), and
// h6:3/h7:3 is already a matched pair, so the board is one move from mirrored.
//   X: h1=5  -> placing 5 at h2 completes the mirror -> h2:5 must be BLOCKED, h2:2 allowed
//   Y: h1=2  -> now placing 2 at h2 completes the mirror -> h2:2 must be BLOCKED, h2:5 allowed
// The blocked tile should track h1's value, proving the rule keys on the mirror value.
const NewFactory = require('./engine/hexuki.js');
const X = 'h1:5,h6:3,h7:3,h9:1|p1:5,2,3|p2:5,2,3|turn:2';
const Y = 'h1:2,h6:3,h7:3,h9:1|p1:5,2,3|p2:5,2,3|turn:2';
const h2moves = m => JSON.parse(m.getValidMoves()).filter(x => x.h === 2).map(x => x.t).sort();

(async () => {
  const m = await NewFactory(); m.initialize();
  m.loadPosition(X); const x = h2moves(m);
  m.loadPosition(Y); const y = h2moves(m);
  console.log(`X (h1=5): legal tiles at h2 = [${x}]   -> h2:5 ${x.includes(5) ? 'ALLOWED' : 'BLOCKED'}, h2:2 ${x.includes(2) ? 'ALLOWED' : 'BLOCKED'}`);
  console.log(`Y (h1=2): legal tiles at h2 = [${y}]   -> h2:5 ${y.includes(5) ? 'ALLOWED' : 'BLOCKED'}, h2:2 ${y.includes(2) ? 'ALLOWED' : 'BLOCKED'}`);
  const pass = !x.includes(5) && x.includes(2) && y.includes(5) && !y.includes(2);
  console.log(pass
    ? '\nPASS: the blocked tile tracks h1 (5 blocked when h1=5, 2 blocked when h1=2). Rule is correct and value-aware.'
    : '\nFAIL: blocked tile did not track the mirror value.');
})().catch(e => { console.error(e); process.exit(1); });
