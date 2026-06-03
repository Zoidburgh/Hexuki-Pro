// Generate a frozen, reproducible set of endgame fixtures for the minimax gate.
// For each saved level, load its position and play deterministically forward,
// snapshotting the position whenever the empty-hex count hits a target value.
// Output: bench/fixtures.json  (array of {name, emptyHexes, position})
const fs = require('fs');
const path = require('path');
const { loadEngine, emptiesOf, pickMove } = require('./lib.cjs');

const TARGETS = [11, 10, 9, 8, 7, 6]; // minimax regime (editor default threshold = 10)
const LEVELS_DIR = path.join(__dirname, '..', 'levels');
const OUT = path.join(__dirname, 'fixtures.json');

(async () => {
  const m = await loadEngine();
  const levelFiles = fs.readdirSync(LEVELS_DIR).filter(f => f.endsWith('.json')).sort();
  const fixtures = [];

  for (const file of levelFiles) {
    const level = JSON.parse(fs.readFileSync(path.join(LEVELS_DIR, file), 'utf8'));
    if (!level.position) continue;
    const base = file.replace(/\.json$/, '');

    m.loadPosition(level.position);
    let pos = m.savePosition();
    const want = new Set(TARGETS);

    // Snapshot at the start too if it already matches a target.
    let guard = 0;
    while (guard++ < 40) {
      const e = emptiesOf(pos);
      if (want.has(e)) {
        fixtures.push({ name: `${base}@${e}`, emptyHexes: e, position: pos });
        want.delete(e);
      }
      if (e <= Math.min(...TARGETS) || m.isGameOver() || want.size === 0) break;
      const mv = pickMove(m);
      if (!mv) break;
      if (!m.makeMove(mv.h, mv.t)) {
        // Try remaining moves if the deterministic pick was rejected.
        const moves = JSON.parse(m.getValidMoves()).sort((a, b) => (a.h - b.h) || (a.t - b.t));
        let made = false;
        for (const c of moves) { if (m.makeMove(c.h, c.t)) { made = true; break; } }
        if (!made) break;
      }
      pos = m.savePosition();
    }
  }

  fixtures.sort((a, b) => (b.emptyHexes - a.emptyHexes) || a.name.localeCompare(b.name));
  fs.writeFileSync(OUT, JSON.stringify(fixtures, null, 2));
  console.log(`Wrote ${fixtures.length} fixtures -> bench/fixtures.json`);
  const byE = {};
  for (const f of fixtures) byE[f.emptyHexes] = (byE[f.emptyHexes] || 0) + 1;
  console.log('By emptyHexes:', JSON.stringify(byE));
})().catch(e => { console.error(e); process.exit(1); });
