// Generate a frozen set of BIG, all-different-tile positions (9-11 empties) -- the
// class that exposed the off-by-one bug and that the small fixtures missed. Plays
// games forward deterministically (seeded) and snapshots non-symmetric positions.
// Run once: node gen-stress.cjs  ->  writes stress-fixtures.json
const fs = require('fs');
const path = require('path');
const F = require('./engine/hexuki.js');

function lcg(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s; }; }
function empties(m) { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; }
const sortedTiles = part => part.split(':')[1].split(',').filter(x => x).map(Number).sort((a, b) => a - b).join(',');

(async () => {
  const m = await F(); m.initialize();
  const out = [
    // the real position that exposed the bug -- keep it as a permanent regression case
    { name: 'user-11-unique', empties: 11, position: 'h2:9,h3:3,h4:7,h6:3,h7:4,h8:5,h9:1,h12:2|p1:1,2,6,8,9|p2:1,4,5,6,7,8|turn:2' },
  ];

  const wanted = [[11, 'a'], [11, 'b'], [10, 'a'], [10, 'b'], [9, 'a'], [9, 'b']];
  let seed = 1;
  for (const [target, suffix] of wanted) {
    let pos = null;
    // try seeds until we land a NON-symmetric (diverse-tile) position at the target
    for (let tries = 0; tries < 50 && !pos; tries++, seed++) {
      const rng = lcg(seed * 7919 + 13);
      m.reset();
      let guard = 0;
      while (empties(m) > target && guard++ < 40) {
        const moves = JSON.parse(m.getValidMoves());
        if (!moves.length) break;
        const mv = moves[rng() % moves.length];
        if (!m.makeMove(mv.h, mv.t)) {
          let made = false;
          for (const c of moves) { if (m.makeMove(c.h, c.t)) { made = true; break; } }
          if (!made) break;
        }
      }
      if (empties(m) !== target) continue;
      const p = m.savePosition();
      const [, p1, p2] = p.split('|');
      if (sortedTiles(p1) === sortedTiles(p2)) continue; // skip symmetric-tile positions
      pos = p;
    }
    if (pos) out.push({ name: `stress-${target}${suffix}`, empties: target, position: pos });
  }

  fs.writeFileSync(path.join(__dirname, 'stress-fixtures.json'), JSON.stringify(out, null, 2));
  console.log(`Wrote ${out.length} stress fixtures -> stress-fixtures.json`);
  for (const f of out) console.log(`  ${f.name.padEnd(16)} e=${f.empties}  ${f.position}`);
})().catch(e => { console.error(e); process.exit(1); });
