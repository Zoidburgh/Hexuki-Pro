// Independent ground truth WITH anti-symmetry, gated FIXED at the root (the way
// minimax gates). Reliable string traversal (no make/unmake), but the symmetry
// filter is implemented HERE in JS with a root-fixed gate — so it doesn't depend
// on the engine's per-node gate. Uses engine getValidMoves only for legality.
const fs = require('fs');
const path = require('path');
const NewFactory = require('./engine/hexuki.js');
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

const MIRROR = [0,2,1,5,4,3,7,6,10,9,8,12,11,15,14,13,17,16,18];

function parseBoard(pos) { const m = {}; const head = pos.split('|')[0]; if (head) for (const t of head.split(',')) { const [h, v] = t.split(':'); m[+h.slice(1)] = +v; } return m; }
function tilesOf(pos, who) { return pos.split('|')[who].split(':')[1].split(',').filter(x => x).map(Number).sort((a,b)=>a-b); }
function sameMultiset(a, b) { return a.length === b.length && a.every((x, i) => x === b[i]); }
function mirrored(board, subHex, subVal) {
  for (let h = 0; h < 19; h++) { const mh = MIRROR[h]; if (mh <= h) continue;
    const v1 = h === subHex ? subVal : (board[h] || 0);
    const v2 = mh === subHex ? subVal : (board[mh] || 0);
    if ((v1 === 0) !== (v2 === 0)) return false;
    if (v1 && v2 && v1 !== v2) return false;
  } return true;
}
function applyMove(pos, h, t) {
  const [placed, p1, p2, turnS] = pos.split('|'); const turn = +turnS.split(':')[1];
  const a = (placed ? placed.split(',') : []); a.push(`h${h}:${t}`);
  const t1 = p1.split(':')[1].split(',').filter(x=>x), t2 = p2.split(':')[1].split(',').filter(x=>x);
  const list = turn === 1 ? t1 : t2; const i = list.indexOf(String(t)); if (i >= 0) list.splice(i, 1);
  return `${a.join(',')}|p1:${t1.join(',')}|p2:${t2.join(',')}|turn:${turn === 1 ? 2 : 1}`;
}

(async () => {
  const m = await NewFactory(); m.initialize();
  let GATE = false, nodes = 0;
  function value(pos, alpha, beta) {
    nodes++;
    m.loadPosition(pos);
    let moves = JSON.parse(m.getValidMoves());                 // legality (engine)
    const board = parseBoard(pos);
    if (GATE && !mirrored(board, -1, 0)) moves = moves.filter(mv => !mirrored(board, mv.h, mv.t));  // my fixed-gate filter
    if (m.isGameOver() || moves.length === 0) return m.getScoreP1() - m.getScoreP2();
    const p = +pos.split('|')[3].split(':')[1];
    if (p === 1) { let best = -1e9; for (const mv of moves) { best = Math.max(best, value(applyMove(pos, mv.h, mv.t), alpha, beta)); if (best>alpha) alpha=best; if (alpha>=beta) break; } return best; }
    else { let best = 1e9; for (const mv of moves) { best = Math.min(best, value(applyMove(pos, mv.h, mv.t), alpha, beta)); if (best<beta) beta=best; if (alpha>=beta) break; } return best; }
  }
  for (const name of (process.argv.slice(2).length ? process.argv.slice(2) : ['3_4_and_5@8','3_4_and_5@10'])) {
    const fx = fixtures.find(f => f.name === name);
    GATE = sameMultiset(tilesOf(fx.position, 1), tilesOf(fx.position, 2));   // root-fixed gate
    nodes = 0; const t0 = Date.now(); const truth = value(fx.position, -1e9, 1e9);
    m.loadPosition(fx.position); const turn = m.getCurrentPlayer();
    const raw = JSON.parse(m.minimaxFindBestMove(fx.emptyHexes, 60000)).score;
    const mmAbs = turn === 1 ? raw : -raw;
    console.log(`${name.padEnd(16)} gate=${GATE}  truth(P1-P2)=${String(truth).padStart(5)}  minimax=${String(mmAbs).padStart(5)}  ${truth===mmAbs?'MATCH':'MISMATCH'}  [${nodes} nodes, ${Date.now()-t0}ms]`);
  }
})().catch(e => { console.error(e); process.exit(1); });
