// Try to load the web-only original engine under Node by feeding it the wasm
// bytes directly and stubbing the few browser globals its loader may touch.
const fs = require('fs');
const path = require('path');

globalThis.self = globalThis;
globalThis.document = { currentScript: { src: path.join(__dirname, 'hexuki.js') } };
globalThis.location = { href: 'file://' + __dirname.replace(/\\/g, '/') + '/' };

const wasmBinary = fs.readFileSync(path.join(__dirname, 'hexuki.wasm'));
let HexukiWasm;
try { HexukiWasm = require('./hexuki.js'); }
catch (e) { console.error('REQUIRE FAIL:', e.message); process.exit(1); }
console.log('export type =', typeof HexukiWasm);

HexukiWasm({ wasmBinary, locateFile: (p) => path.join(__dirname, p), print: () => {}, printErr: () => {} })
  .then(m => {
    m.initialize();
    const pos = 'h0:3,h1:1,h2:1,h3:3,h4:3,h5:3,h6:5,h7:3,h8:5,h12:5,h14:5|p1:3,3,3,3|p2:3,3,3,3|turn:2';
    m.loadPosition(pos);
    const r = JSON.parse(m.minimaxFindBestMove(8, 60000));
    console.log('OLD ENGINE ->', JSON.stringify(r));
    console.log('LOAD OK');
  })
  .catch(e => { console.error('INIT FAIL:', e.message); process.exit(1); });
