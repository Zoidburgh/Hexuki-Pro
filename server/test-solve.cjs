// Test client for the solve server. Generates a small (fast) valid position with the engine
// if none is given, then POSTs it to the server and prints the response. Run the server first.
//
//   node server/test-solve.cjs                 # auto-generates a ~7-empty position
//   node server/test-solve.cjs "<position>"    # solve a specific position
//   node server/test-solve.cjs "<position>" 60000   # with a custom maxMs

const http = require('http');
const path = require('path');

function post(position, maxMs) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ position, maxMs });
        const req = http.request(
            { host: 'localhost', port: process.env.HEXUKI_PORT || 8080, path: '/solve', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
        req.on('error', reject);
        req.write(body); req.end();
    });
}

(async () => {
    let position = process.argv[2];
    const maxMs = parseInt(process.argv[3] || '120000', 10);

    if (!position) {
        // Generate a small valid position: reset, play random legal moves down to ~7 empties.
        const Factory = require(path.join(__dirname, '..', 'bench', 'engine', 'hexuki.js'));
        const m = await Factory(); m.initialize(); m.reset();
        const empt = () => { let c = 0; for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++; return c; };
        let guard = 0;
        while (empt() > 7 && guard++ < 30) {
            const mv = JSON.parse(m.getValidMoves());
            if (!mv.length) break;
            const c = mv[guard % mv.length];
            if (!m.makeMove(c.h, c.t)) { for (const x of mv) if (m.makeMove(x.h, x.t)) break; }
        }
        position = m.savePosition();
        console.log(`generated test position (${empt()} empty): ${position}`);
    }

    console.log('\n--- first solve (computes) ---');
    let t = Date.now();
    console.log(await post(position, maxMs), `\n(${Date.now() - t}ms round-trip)`);

    console.log('\n--- second solve (should be cached:true, instant) ---');
    t = Date.now();
    console.log(await post(position, maxMs), `\n(${Date.now() - t}ms round-trip)`);
})().catch(e => { console.error('test failed:', e.message); process.exit(1); });
