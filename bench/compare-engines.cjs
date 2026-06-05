// Head-to-head: OLD editor engine vs NEW source engine on every fixture.
// The NEW engine is deterministic + bugfixed -> treat its score as ground truth.
// Any fixture where OLD.score != NEW.score = a position the old engine gets wrong.
// Also runs the old engine TWICE per fixture to test the "non-deterministic score" claim.
const fs = require('fs');
const path = require('path');

// Browser stubs so the web-only old engine loads under Node.
globalThis.self = globalThis;
globalThis.document = { currentScript: { src: path.join(__dirname, 'original-engine', 'hexuki.js') } };
globalThis.location = { href: 'file://' + __dirname.replace(/\\/g, '/') + '/' };

const NewFactory = require('./engine/hexuki.js');
const OldFactory = require('./original-engine/hexuki.js');
const oldWasm = fs.readFileSync(path.join(__dirname, 'original-engine', 'hexuki.wasm'));
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

const solve = (m, fx) => JSON.parse(m.minimaxFindBestMove(fx.emptyHexes, 60000));

(async () => {
  const nw = await NewFactory(); nw.initialize();
  const old = await OldFactory({ wasmBinary: oldWasm, locateFile: p => path.join(__dirname, 'original-engine', p), print(){}, printErr(){} }); old.initialize();

  let scoreDiffs = 0, moveDiffs = 0, nonDeterministic = 0;
  const diffRows = [];

  for (const fx of fixtures) {
    nw.loadPosition(fx.position);
    const n = solve(nw, fx);
    old.loadPosition(fx.position);
    const o1 = solve(old, fx);
    old.loadPosition(fx.position);
    const o2 = solve(old, fx);   // second run -> determinism check

    const oNodes = o1.nodes ?? o1.nodesExplored;
    const nNodes = n.nodes ?? n.nodesExplored;
    const scoreDiff = o1.score !== n.score;
    const moveDiff = o1.hexId !== n.hexId || o1.tileValue !== n.tileValue;
    const nondet = o1.score !== o2.score || o1.hexId !== o2.hexId || o1.tileValue !== o2.tileValue;

    if (scoreDiff) scoreDiffs++;
    if (moveDiff) moveDiffs++;
    if (nondet) nonDeterministic++;

    if (scoreDiff || nondet) {
      diffRows.push(`  ${fx.name.padEnd(20)} e=${fx.emptyHexes}  OLD score=${o1.score}${nondet?`/${o2.score}(NONDET)`:''} move=h${o1.hexId}+${o1.tileValue}  |  NEW score=${n.score} move=h${n.hexId}+${n.tileValue}  ${scoreDiff?'<<< SCORE MISMATCH':''}`);
    }
  }

  console.log(`Compared ${fixtures.length} fixtures (old engine vs new engine, full-depth solve).\n`);
  if (diffRows.length) { console.log('Disagreements / non-determinism:'); console.log(diffRows.join('\n')); console.log(''); }
  console.log(`SCORE mismatches (old gives wrong game value): ${scoreDiffs}`);
  console.log(`Old engine non-deterministic (score changed between 2 runs): ${nonDeterministic}`);
  console.log(`Move-only differences (same score, different optimal move = harmless tie): ${moveDiffs}`);
  if (scoreDiffs === 0 && nonDeterministic === 0)
    console.log('\n=> On these fixtures the old engine produced CORRECT, STABLE scores everywhere. No bug observed here.');
})().catch(e => { console.error(e); process.exit(1); });
