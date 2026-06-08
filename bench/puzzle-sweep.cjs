// PUZZLE SWEEP (v2) -- mines a DIVERSE pool of interesting Hexuki puzzles by stratifying over the
// whole (board-pattern x tile-theme x hands) space, solving every P1 move exactly, and TAGGING each
// position by archetype so you can browse by flavor (big-flip / razor / sharp-win / least-loss / ...).
//
// A puzzle = P1 to move; human plays P1 vs PERFECT P2 and tries to reach the best achievable result
// (a win, or the least-bad loss). Authored fills are owner-agnostic value boards (validated rule-exact
// vs the canonical JS engine by cross-check-arbitrary.cjs), so we can place ANY pattern with ANY tiles.
//
//   node bench/puzzle-sweep.cjs [--per-cell K] [--empties E] [--keep M] [--seed S] [--conc C]
//
// Stratified: every (pattern-family x theme) cell gets K candidates -> guaranteed variety. Output is
// grouped by archetype, capped per-template so one fertile template can't dominate, and written as
// level JSONs into bench/puzzles/. Reproducible (seeded). Defaults: K=2, E=10, keep top 4/archetype.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const NewFactory = require('./engine/hexuki.js');

const SOLVER = path.join(__dirname, '..', 'native', 'hexuki-solve.exe');
const OUTDIR = path.join(__dirname, 'puzzles');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PERCELL = +arg('--per-cell', 2);
const EMPTIES = +arg('--empties', 10);
const KEEP    = +arg('--keep', 4);           // top per archetype
const SEED    = +arg('--seed', 1);
const CONC    = +arg('--conc', Math.max(2, os.cpus().length));
const PERTPL  = +arg('--per-template', 2);    // diversity cap: max kept per (pattern,theme) template

// ---------- seeded PRNG ----------
function makeRng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const sample = (r, pool, n) => Array.from({ length: n }, () => pick(r, pool));

// ---------- board-pattern families (hex orderings; take first fillN) ----------
// vertical mirror axis = the scoring axis. Axis hexes then full mirror pairs => symmetric fills.
const VAXIS   = [9, 4, 14, 0, 18, 1, 2, 6, 7, 3, 5, 11, 12, 8, 10, 13, 15, 16, 17];
const PERIM   = [0, 2, 5, 10, 15, 18, 17, 16, 13, 8, 3, 1, 6, 11, 7, 12, 4, 14, 9]; // ring inward
const CENTER  = [9, 6, 7, 4, 14, 8, 10, 11, 12, 3, 5, 13, 15, 1, 2, 16, 17, 0, 18]; // center outward
const PATTERNS = {
  vaxis:   (r, n) => VAXIS.slice(0, n),
  ring:    (r, n) => PERIM.slice(0, n),
  cluster: (r, n) => CENTER.slice(0, n),
  random:  (r, n) => { const h = [...Array(19).keys()]; for (let i = 18; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [h[i], h[j]] = [h[j], h[i]]; } return h.slice(0, n); },
};

// ---------- tile themes -> value pools for board + each hand ----------
// All values are clamped to 1..MAXT (--max-tile, default 9). Lower caps keep chain scores legible.
const MAXT = Math.max(1, +arg('--max-tile', 9));
const RANGE = Array.from({ length: MAXT }, (_, i) => i + 1);
const randVal = (r) => RANGE[Math.floor(r() * RANGE.length)];
const twoDistinct = (r) => { const a = randVal(r); if (RANGE.length < 2) return [a, a]; let b; do { b = randVal(r); } while (b === a); return [a, b]; };
const THEMES = {
  full:  (r) => ({ name: `full≤${MAXT}`, board: RANGE, p1: RANGE, p2: RANGE }),
  pair:  (r) => { const [a, b] = twoDistinct(r); const P = [a, b]; return { name: `pair{${a},${b}}`, board: P, p1: P, p2: P }; },
  split: (r) => { const mid = Math.ceil(MAXT / 2); const low = RANGE.filter(v => v <= mid), high = RANGE.filter(v => v > mid); const hi = high.length ? high : low; const sw = r() < 0.5; return { name: 'split', board: [...low, ...hi], p1: sw ? low : hi, p2: sw ? hi : low }; },
  dup:   (r) => { const [a, b] = twoDistinct(r); const heavy = [a, a, a, a, b, b]; return { name: `dup{${a}x4,${b}x2}`, board: [a, b], p1: heavy, p2: heavy }; },
};

// Fixed-theme override: --board-vals / --p1-vals / --p2-vals lock the value pools (comma lists), so the
// sweep keeps a single theme and only varies the board PATTERN (which hexes are empty). e.g. board all
// 3's, P1 holds 1's, P2 holds 2's: --board-vals 3 --p1-vals 1 --p2-vals 2.
let THEME_KEYS = Object.keys(THEMES);
const bv = arg('--board-vals'), p1v = arg('--p1-vals'), p2v = arg('--p2-vals');
if (bv && p1v && p2v) {
  const nums = (s) => s.split(',').map(Number);
  THEMES.custom = () => ({ name: `board[${bv}]/p1[${p1v}]/p2[${p2v}]`, board: nums(bv), p1: nums(p1v), p2: nums(p2v) });
  THEME_KEYS = ['custom'];
}

const emptyCount = (m) => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };
const uniqMoves  = (m) => { const seen = new Set(), out = []; for (const x of JSON.parse(m.getValidMoves())) { const k = x.h + ':' + x.t; if (!seen.has(k)) { seen.add(k); out.push(x); } } return out; };

// Author one position from a (pattern, theme) cell. fillN = 19 - E; hands fill the empties, P1 first.
function genFromCell(m, patName, themeName, seed) {
  const r = makeRng(seed);
  const fillN = 19 - EMPTIES;
  const filled = [...new Set(PATTERNS[patName](r, fillN))].sort((a, b) => a - b);
  if (filled.length < fillN) return null;
  const th = THEMES[themeName](r);
  const placed = filled.map(h => `h${h}:${pick(r, th.board)}`);
  const E = 19 - filled.length;
  const p1 = sample(r, th.p1, Math.ceil(E / 2));
  const p2 = sample(r, th.p2, Math.floor(E / 2));
  const pos = `${placed.join(',')}|p1:${p1.join(',')}|p2:${p2.join(',')}|turn:1`;
  m.loadPosition(pos);
  if (m.getCurrentPlayer() !== 1 || m.isGameOver() || uniqMoves(m).length < 2) return null;
  return { pos, pattern: patName, theme: th.name };
}

function solveChild(child) {
  return new Promise((resolve) => {
    execFile(SOLVER, [child, '0', '2147483647', '--threads', '1'],
      { encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env, HEXUKI_TT_MB: '64' } },
      (err, stdout) => { if (err) return resolve(null); try { resolve(JSON.parse(stdout.trim().split('\n').pop())); } catch { resolve(null); } });
  });
}
async function pool(tasks, conc) {
  const out = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(conc, tasks.length) }, async () => { for (;;) { const k = i++; if (k >= tasks.length) break; out[k] = await tasks[k](); } }));
  return out;
}

const fmtMove = (mv) => `H${mv.hexId + 1}+${mv.tileValue}`;
const fmtVal  = (v) => (v > 0 ? `P1 wins by ${v}` : v < 0 ? `P1 loses by ${-v}` : 'draw');
function parsePos(pos) { const [pl, p1, p2] = pos.split('|'); const b = {}; if (pl) for (const t of pl.split(',')) { const [h, v] = t.split(':'); b[+h.slice(1)] = +v; } return { board: b, p1: p1.split(':')[1].split(',').filter(Boolean).map(Number), p2: p2.split(':')[1].split(',').filter(Boolean).map(Number) }; }

// ---------- archetype classification from the move-value spread ----------
function classify(s) {
  const tags = [];
  if (s.best > 0 && s.greedy.value < 0)              tags.push(['BIG_FLIP', s.greedyRegret]);       // obvious move throws the win
  if (Math.abs(s.best) <= 30 && s.swing >= 100 && s.optimal.length <= 3) tags.push(['RAZOR', s.swing]); // near-zero, one move decides
  if (s.best > 0 && s.optimal.length <= 2 && s.losing >= 0.5 * s.total)  tags.push(['SHARP_WIN', Math.round(s.losing / s.total * 100)]);
  if (s.best < 0 && s.sharpness >= 50)               tags.push(['LEAST_LOSS', s.sharpness]);         // losing, clear best least-loss
  if (s.antiGreedy && s.greedyRegret >= 100)         tags.push(['ANTI_GREEDY', s.greedyRegret]);     // obvious-is-wrong (generic)
  if (s.sharpness >= 100)                            tags.push(['SHARP', s.sharpness]);              // one clearly-best move
  return tags;   // [ [name, magnitude], ... ]; empty => bland
}
const PRIORITY = ['BIG_FLIP', 'RAZOR', 'SHARP_WIN', 'LEAST_LOSS', 'ANTI_GREEDY', 'SHARP'];

(async () => {
  const m = await NewFactory(); m.initialize();

  // 1) stratified generation: every (pattern x theme) cell -> PERCELL candidates
  const cands = []; const seenPos = new Set(); let seedCtr = SEED;
  for (const pat of Object.keys(PATTERNS)) for (const th of THEME_KEYS) {
    let got = 0, tries = 0;
    while (got < PERCELL && tries < PERCELL * 60) {
      const c = genFromCell(m, pat, th, seedCtr++); tries++;
      if (c && !seenPos.has(c.pos)) { seenPos.add(c.pos); cands.push(c); got++; }
    }
  }
  console.log(`Generated ${cands.length} candidates across ${Object.keys(PATTERNS).length}x${THEME_KEYS.length} cells (${EMPTIES} empties). Solving...\n`);

  // 2) flat solve list: every legal P1 move's child
  const recs = [];
  for (const c of cands) { m.loadPosition(c.pos); for (const mv of uniqMoves(m)) { m.loadPosition(c.pos); if (!m.makeMove(mv.h, mv.t)) continue; recs.push({ c, move: { hexId: mv.h, tileValue: mv.t }, child: m.savePosition(), immediate: m.getScoreP1() - m.getScoreP2() }); } }
  const t0 = Date.now();
  const res = await pool(recs.map(r => () => solveChild(r.child)), CONC);
  recs.forEach((r, i) => { r.value = res[i] ? -res[i].score : null; });
  console.log(`Solved ${recs.length} child positions in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

  // 3) per-candidate signals + classification
  const tagged = [];
  for (const c of cands) {
    const mv = recs.filter(r => r.c === c && r.value !== null);
    if (mv.length < 2) continue;
    mv.sort((a, b) => b.value - a.value);
    const best = mv[0].value, total = mv.length;
    const optimal = mv.filter(r => r.value === best);
    const second = mv.find(r => r.value < best);
    const sharpness = second ? best - second.value : 0;
    const worst = mv[total - 1].value, swing = best - worst;
    const blunderCut = Math.max(50, Math.round(0.25 * swing));
    const traps = mv.filter(r => best - r.value >= blunderCut).length;
    const losing = best >= 0 ? mv.filter(r => r.value < 0).length : 0;
    const greedy = mv.reduce((a, b) => b.immediate > a.immediate ? b : a, mv[0]);
    const antiGreedy = !optimal.includes(greedy);
    const greedyRegret = best - greedy.value;
    const s = { best, total, optimal, second, sharpness, swing, traps, losing, greedy, antiGreedy, greedyRegret };
    const tags = classify(s);
    if (!tags.length) continue;                                   // bland -> discard
    if (Math.abs(best) > 2000 && sharpness < 0.10 * Math.abs(best)) continue;  // huge score, imperceptible gap -> not fun
    const primary = PRIORITY.find(p => tags.some(t => t[0] === p));
    tagged.push({ c, s, tags, primary, mag: tags.find(t => t[0] === primary)[1] });
  }

  // 4) group by archetype, cap per template, write keepers
  fs.mkdirSync(OUTDIR, { recursive: true });
  for (const f of fs.readdirSync(OUTDIR)) if (f.endsWith('.json')) fs.unlinkSync(path.join(OUTDIR, f));

  const why = (t) => {
    const s = t.s, bestMv = s.optimal.map(o => fmtMove(o.move)).join(' / ');
    const parts = [s.optimal.length === 1 ? `ONLY ${bestMv} reaches ${fmtVal(s.best)}` : `${s.optimal.length} moves tie best (${fmtVal(s.best)})`];
    if (s.sharpness > 0 && s.second) parts.push(`next-best drops ${s.sharpness} (to ${fmtVal(s.second.value)})`);
    if (s.antiGreedy) parts.push(`greedy ${fmtMove(s.greedy.move)} costs ${s.greedyRegret} (→ ${fmtVal(s.greedy.value)})`);
    if (s.best > 0) { if (s.losing > 0) parts.push(`${s.losing}/${s.total} moves throw the win`); }
    else if (s.best === 0) { if (s.losing > 0) parts.push(`${s.losing}/${s.total} moves throw the draw`); }
    else if (s.traps > 0) parts.push(`${s.traps}/${s.total} are blunders`);
    return { bestMv, text: parts.join('; ') + '.' };
  };

  console.log('='.repeat(80));
  console.log(`DIVERSE PUZZLE POOL  (${tagged.length} tagged candidates)`);
  console.log('='.repeat(80));
  const counts = {};
  let saved = 0;
  // POOL.md: one copy-pasteable list. Paste a `position` line into the editor's box -> Paste Position.
  const md = [`# Hexuki puzzle pool`, ``, `${EMPTIES} empty hexes, P1 to move. Paste a position line into the editor and hit **Paste Position**.`, ``];
  for (const arch of PRIORITY) {
    const group = tagged.filter(t => t.primary === arch).sort((a, b) => b.mag - a.mag);
    counts[arch] = group.length;
    if (!group.length) continue;
    console.log(`\n### ${arch}  (${group.length})`);
    md.push(`## ${arch}`, ``);
    const perTpl = {}; let shownInArch = 0;
    for (const t of group) {
      const tpl = t.c.pattern + '|' + t.c.theme;
      if ((perTpl[tpl] = (perTpl[tpl] || 0) + 1) > PERTPL) continue;   // diversity cap
      if (shownInArch++ >= KEEP) break;
      const w = why(t);
      console.log(`  [${t.c.pattern}/${t.c.theme}] mag=${t.mag}  tags=${t.tags.map(x => x[0]).join(',')}`);
      console.log(`    ${t.c.pos}`);
      console.log(`    ${w.text}`);
      md.push(`**[${t.c.pattern}/${t.c.theme}]** ${w.text}`, ``, '`' + t.c.pos + '`', ``);
      const p = parsePos(t.c.pos);
      const board = Array.from({ length: 19 }, (_, h) => (h in p.board ? p.board[h] : null));
      const json = { title: `${arch.toLowerCase()}_${t.c.pattern}_${saved}`, description: `[${arch}] Best: ${w.bestMv} → ${fmtVal(t.s.best)}. ${w.text}`,
                     position: t.c.pos, board, p1Tiles: p.p1, p2Tiles: p.p2, startingPlayer: 1, exportedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(OUTDIR, `${json.title}.json`), JSON.stringify(json, null, 2));
      saved++;
    }
  }
  fs.writeFileSync(path.join(OUTDIR, 'POOL.md'), md.join('\n'));
  console.log(`\nArchetype counts: ${PRIORITY.map(a => `${a}:${counts[a] || 0}`).join('  ')}`);
  console.log(`Wrote ${saved} JSONs + POOL.md to bench/puzzles/ (≤${PERTPL}/template, ≤${KEEP}/archetype).`);
  console.log(`-> Open bench/puzzles/POOL.md, copy a position line into the editor's box, hit Paste Position.`);
})().catch(e => { console.error(e); process.exit(1); });
