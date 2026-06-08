// Anti-symmetry rule, isolated. The rule (state-based): a move is forbidden iff it makes the board a
// perfect mirror on a score-degenerate axis -- VERTICAL or HORIZONTAL -- AND leaves the hands equal
// afterward (the mover holds exactly one extra of that tile value). Both reflections swap P1's
// scoring diagonals onto P2's, so either one forces an equal-score draw.
//
// Cases use DIVERGED hands (mover has one extra of the mirror value) -- the regime the current rule
// actually gates. The blocked tile must track the value needed to complete the mirror.
const NewFactory = require('./engine/hexuki.js');

const h2 = (m, hex) => JSON.parse(m.getValidMoves()).filter(x => x.h === hex).map(x => x.t).sort((a, b) => a - b);

// VERTICAL: h1's vertical mirror is h2. h6:3/h7:3 is a matched pair, so the board is one move from a
// vertical mirror. P2 holds one extra of h1's value -> placing it at h2 completes the mirror + equals
// the hands -> BLOCKED. The blocked tile tracks h1's value.
const VX = 'h1:5,h6:3,h7:3,h9:1|p1:2,3|p2:5,2,3|turn:2';   // h1=5 -> h2:5 blocked, h2:2/3 allowed
const VY = 'h1:2,h6:3,h7:3,h9:1|p1:5,3|p2:2,5,3|turn:2';   // h1=2 -> h2:2 blocked, h2:3/5 allowed

// HORIZONTAL: h7's horizontal mirror is h12. h6:3/h11:3 is a matched horizontal pair, so placing h7's
// value (4) at h12 completes a HORIZONTAL mirror but NOT a vertical one (h6:3 vs h7:4 differ). P1 holds
// one extra 4 -> BLOCKED. Proves the horizontal axis is enforced, independently of vertical.
const HX = 'h6:3,h7:4,h9:1,h11:3|p1:4,1,2|p2:1,2|turn:1'; // -> h12:4 blocked, h12:1/2 allowed

(async () => {
  const m = await NewFactory(); m.initialize();
  m.loadPosition(VX); const vx = h2(m, 2);
  m.loadPosition(VY); const vy = h2(m, 2);
  m.loadPosition(HX); const hx = h2(m, 12);

  console.log(`VERT  X (h1=5): h2 legal [${vx}]  -> 5 ${vx.includes(5) ? 'ALLOWED' : 'BLOCKED'}, 2 ${vx.includes(2) ? 'ALLOWED' : 'BLOCKED'}`);
  console.log(`VERT  Y (h1=2): h2 legal [${vy}]  -> 2 ${vy.includes(2) ? 'ALLOWED' : 'BLOCKED'}, 5 ${vy.includes(5) ? 'ALLOWED' : 'BLOCKED'}`);
  console.log(`HORIZ   (h7=4): h12 legal [${hx}] -> 4 ${hx.includes(4) ? 'ALLOWED' : 'BLOCKED'}, 1 ${hx.includes(1) ? 'ALLOWED' : 'BLOCKED'}`);

  const vertOK = !vx.includes(5) && vx.includes(2) && vx.includes(3) && !vy.includes(2) && vy.includes(5) && vy.includes(3);
  const horizOK = !hx.includes(4) && hx.includes(1) && hx.includes(2);

  console.log('');
  if (vertOK && horizOK) {
    console.log('PASS: vertical blocks the mirror value (tracks h1), and horizontal blocks the top<->bottom mirror move. Rule is value-aware on both axes.');
    process.exit(0);
  } else {
    if (!vertOK) console.log('FAIL: vertical anti-symmetry did not track the mirror value.');
    if (!horizOK) console.log('FAIL: horizontal anti-symmetry did not block the completing move.');
    process.exit(1);
  }
})();
