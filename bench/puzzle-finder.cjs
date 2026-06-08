// PUZZLE FINDER (v1) -- mines for INTERESTING Hexuki puzzles and explains why each is interesting.
//
// A puzzle = a position with P1 to move; the human plays P1 against PERFECT P2 (the minimax line)
// and tries to reach the best achievable result (a win, OR the least-bad loss). This tool:
//   1. generates legal, reachable candidate positions (random legal playout from the standard start,
//      stopped at TARGET even empties so P1 is to move, leaving both sides VARIED hands),
//   2. for each candidate, exact-solves the child of EVERY legal P1 move to game end (full window,
//      so each move gets its TRUE value -- the pruned root search can't give that),
//   3. scores interestingness from the move-value spread + an anti-greedy check, and
//   4. prints a ranked pool with a plain-English "why it's interesting", and writes the keepers as
//      level JSONs (existing schema) into bench/puzzles/ for you to load in the editor and judge.
//
// Interestingness here is DESCRIPTIVE (it explains, it does not gate -- "any puzzle can work"):
//   sharpness  = best value minus 2nd-best (is there one clearly-right move?)
//   antiGreedy = the best move is NOT the move that grabs the most immediate score (obvious-is-wrong)
//   traps      = how many moves are real blunders (drop a lot of value / flip the outcome)
//
//   node bench/puzzle-finder.cjs [--count K] [--empties E] [--keep M] [--seed S] [--conc C]
//
// Defaults: 24 candidates at 10 empties, write top 8 JSONs, seed 1, concurrency = CPU count.
// Reproducible: the only randomness is the seeded playout (the C++ start is fixed).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const NewFactory = require('./engine/hexuki.js');

const SOLVER = path.join(__dirname, '..', 'native', 'hexuki-solve.exe');
const OUTDIR = path.join(__dirname, 'puzzles');

// ---- args ----
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const COUNT   = +arg('--count', 24);
const EMPTIES = +arg('--empties', 10);          // must be even so P1 is to move
const KEEP    = +arg('--keep', 8);
const SEED    = +arg('--seed', 1);
const CONC    = +arg('--conc', Math.max(2, os.cpus().length));
if (EMPTIES % 2 !== 0) { console.error('--empties must be EVEN (so P1 is to move).'); process.exit(1); }

// ---- seeded PRNG (mulberry32) ----
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const emptyCount = (m) => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };
const uniqMoves  = (m) => { const seen = new Set(), out = []; for (const x of JSON.parse(m.getValidMoves())) { const k = x.h + ':' + x.t; if (!seen.has(k)) { seen.add(k); out.push(x); } } return out; };

// Generate one candidate (P1 to move, EMPTIES empties, >=2 legal moves) via a seeded legal playout.
function genCandidate(m, seed) {
  const r = makeRng(seed);
  m.reset();                                  // h9:1 | p1:1-9 | p2:1-9 | turn:1  (empties = 18)
  let guard = 0;
  while (emptyCount(m) > EMPTIES) {
    const mv = uniqMoves(m); if (!mv.length) return null;          // dead end -> reject this seed
    let mvPick = mv[Math.floor(r() * mv.length)];
    if (!m.makeMove(mvPick.h, mvPick.t)) {                          // fallback: first that sticks
      let ok = false; for (const x of mv) if (m.makeMove(x.h, x.t)) { ok = true; break; }
      if (!ok) return null;
    }
    if (++guard > 40) return null;
  }
  if (m.getCurrentPlayer() !== 1 || m.isGameOver()) return null;
  if (uniqMoves(m).length < 2) return null;                        // trivial -> reject
  return m.savePosition();
}

// Exact game-end value of `child` (P2 to move) from P2's perspective; caller negates for P1.
function solveChild(child) {
  return new Promise((resolve) => {
    execFile(SOLVER, [child, '0', '2147483647', '--threads', '1'],
      { encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env, HEXUKI_TT_MB: '64' } },
      (err, stdout) => {
        if (err) return resolve(null);
        try { const line = stdout.trim().split('\n').pop(); resolve(JSON.parse(line)); }
        catch { resolve(null); }
      });
  });
}

// Run async tasks with a fixed concurrency.
async function pool(tasks, conc) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, tasks.length) }, async () => {
    for (;;) { const k = i++; if (k >= tasks.length) break; out[k] = await tasks[k](); }
  }));
  return out;
}

// ---- position helpers ----
function parsePos(pos) {
  const [placed, p1, p2] = pos.split('|');
  const board = {};
  if (placed) for (const t of placed.split(',')) { const [h, v] = t.split(':'); board[+h.slice(1)] = +v; }
  return { board, p1: p1.split(':')[1].split(',').filter(Boolean).map(Number), p2: p2.split(':')[1].split(',').filter(Boolean).map(Number) };
}
const fmtMove = (mv) => `H${mv.hexId + 1}+${mv.tileValue}`;   // editor hex labels are 1-indexed
const fmtVal  = (v) => (v > 0 ? `P1 wins by ${v}` : v < 0 ? `P1 loses by ${-v}` : 'draw');

(async () => {
  const m = await NewFactory(); m.initialize();

  // 1) generate distinct candidates
  const candidates = [];
  const seen = new Set();
  for (let s = SEED; candidates.length < COUNT && s < SEED + COUNT * 50; s++) {
    const pos = genCandidate(m, s);
    if (pos && !seen.has(pos)) { seen.add(pos); candidates.push({ seed: s, pos }); }
  }
  console.log(`Generated ${candidates.length} candidates (${EMPTIES} empties, P1 to move). Solving move-by-move...\n`);

  // 2) build the flat solve task list: for every candidate, every legal P1 move's child.
  const records = [];     // {cand, move, child, immediate}
  for (const cand of candidates) {
    m.loadPosition(cand.pos);
    for (const mv of uniqMoves(m)) {
      m.loadPosition(cand.pos);
      if (!m.makeMove(mv.h, mv.t)) continue;
      records.push({ cand, move: { hexId: mv.h, tileValue: mv.t }, child: m.savePosition(),
                     immediate: m.getScoreP1() - m.getScoreP2() });
    }
  }
  const t0 = Date.now();
  const solved = await pool(records.map(rec => () => solveChild(rec.child)), CONC);
  records.forEach((rec, i) => { rec.value = solved[i] ? -solved[i].score : null; });   // P1 perspective
  console.log(`Solved ${records.length} child positions in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  // 3) per-candidate signals
  const results = [];
  for (const cand of candidates) {
    const mv = records.filter(r => r.cand === cand && r.value !== null);
    if (mv.length < 2) continue;
    mv.sort((a, b) => b.value - a.value);
    const best = mv[0].value;
    const optimal = mv.filter(r => r.value === best);
    const secondBest = mv.find(r => r.value < best);           // first strictly worse
    const sharpness = secondBest ? best - secondBest.value : 0;
    const worst = mv[mv.length - 1].value;
    const swing = best - worst;
    const blunderCut = Math.max(50, Math.round(0.25 * swing));
    const traps = mv.filter(r => best - r.value >= blunderCut).length;
    const losing = (best >= 0) ? mv.filter(r => r.value < 0).length : 0;   // moves that throw a winnable game
    const greedy = mv.reduce((a, b) => b.immediate > a.immediate ? b : a, mv[0]);
    const antiGreedy = !optimal.includes(greedy);
    const greedyRegret = best - greedy.value;
    const interest = sharpness + (antiGreedy ? greedyRegret : 0);
    results.push({ cand, mv, best, optimal, sharpness, secondBest, swing, traps, losing, greedy, antiGreedy, greedyRegret, interest });
  }
  results.sort((a, b) => b.interest - a.interest);

  // 4) report + write keepers
  fs.mkdirSync(OUTDIR, { recursive: true });
  for (const f of fs.readdirSync(OUTDIR)) if (f.endsWith('.json')) fs.unlinkSync(path.join(OUTDIR, f));

  console.log('='.repeat(78));
  console.log(`RANKED PUZZLE POOL  (${results.length} solvable candidates, by interest)`);
  console.log('='.repeat(78));
  let rank = 0;
  for (const r of results) {
    rank++;
    const bestMv = r.optimal.map(o => fmtMove(o.move)).join(' / ');
    const why = [];
    why.push(r.optimal.length === 1 ? `ONLY ${bestMv} reaches ${fmtVal(r.best)}`
                                    : `${r.optimal.length} moves tie best (${fmtVal(r.best)}): ${bestMv}`);
    if (r.sharpness > 0) why.push(`next-best drops ${r.sharpness} (to ${r.secondBest ? fmtVal(r.secondBest.value) : '-'})`);
    if (r.antiGreedy)    why.push(`the greedy grab ${fmtMove(r.greedy.move)} costs ${r.greedyRegret} (→ ${fmtVal(r.greedy.value)})`);
    if (r.losing > 0)    why.push(`${r.losing}/${r.mv.length} moves throw the win`);
    else if (r.traps > 0) why.push(`${r.traps}/${r.mv.length} moves are blunders`);

    const keep = rank <= KEEP;
    console.log(`\n#${rank}  interest=${r.interest}  ${keep ? '[saved]' : ''}`);
    console.log(`   ${r.cand.pos}`);
    console.log(`   ` + why.join('; ') + '.');

    if (keep) {
      const p = parsePos(r.cand.pos);
      const board = Array.from({ length: 19 }, (_, h) => (h in p.board ? p.board[h] : null));
      const desc = `Best: ${bestMv} → ${fmtVal(r.best)}. ` + why.slice(1).join('; ') + '.';
      const json = { title: `auto_e${EMPTIES}_s${r.cand.seed}`, description: desc, position: r.cand.pos,
                     board, p1Tiles: p.p1, p2Tiles: p.p2, startingPlayer: 1, exportedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(OUTDIR, `${json.title}.json`), JSON.stringify(json, null, 2));
    }
  }
  console.log(`\nWrote top ${Math.min(KEEP, results.length)} to bench/puzzles/. Load any in the editor to judge it.`);
})().catch(e => { console.error(e); process.exit(1); });
