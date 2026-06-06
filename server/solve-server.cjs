// Hexuki solve server — S1 (Node + the node-capable WASM engine).
//
// ADDITIVE: loads the engine we already build (bench/engine/hexuki.js), exposes POST /solve,
// and caches every COMPLETE solve to disk. No npm deps (Node built-in http only). Solves run
// HERE, off the browser, so the editor never freezes — the browser just awaits the response.
//
// Single-threaded for S1: one solve at a time (a long solve blocks other requests; S2 adds a
// worker pool). A timed-out solve is flagged and NOT cached — same honesty rule as the editor.
//
//   Run:    node server/solve-server.cjs        (or server/START_SOLVE_SERVER.bat)
//   Needs:  bench/build.ps1 to have produced bench/engine/hexuki.{js,wasm} (node build)
//   Port:   8080 by default (set HEXUKI_PORT to change). Editor runs on 8000 — no conflict.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.HEXUKI_PORT || '8080', 10);
const WASM_PATH = path.join(__dirname, '..', 'bench', 'engine', 'hexuki.js');
const CACHE_PATH = path.join(__dirname, 'cache.jsonl');
const DEFAULT_MAX_MS = 600000; // 10 min cap per solve

// ---- position normalization: one canonical cache key regardless of input ordering ----
// "h6:7,h4:3|p1:6,2,5|p2:..|turn:1" and "h4:3,h6:7|p1:2,5,6|p2:..|turn:1" -> same key.
function normalizePosition(pos) {
    const parts = String(pos).trim().split('|');
    const board = (parts[0] || '').split(',').filter(Boolean)
        .map(s => { const [h, v] = s.replace(/^h/i, '').split(':'); return [parseInt(h, 10), parseInt(v, 10)]; })
        .filter(([h, v]) => Number.isFinite(h) && Number.isFinite(v))
        .sort((a, b) => a[0] - b[0])
        .map(([h, v]) => `h${h}:${v}`).join(',');
    const hand = (seg, tag) => {
        const nums = (seg || '').split(':')[1] || '';
        const sorted = nums.split(',').filter(Boolean).map(Number).sort((a, b) => a - b).join(',');
        return `${tag}:${sorted}`;
    };
    const p1 = hand(parts[1], 'p1');
    const p2 = hand(parts[2], 'p2');
    const turn = parts[3] || 'turn:1';
    return `${board}|${p1}|${p2}|${turn}`;
}

function countEmpties(m) {
    let c = 0;
    for (let h = 0; h < 19; h++) if (m.getTileValue(h) === 0) c++;
    return c;
}

// ---- cache: in-memory Map + append-only JSONL on disk (crash-safe, rebuilt on startup) ----
const cache = new Map();
function loadCache() {
    if (!fs.existsSync(CACHE_PATH)) return;
    for (const line of fs.readFileSync(CACHE_PATH, 'utf8').split('\n').filter(Boolean)) {
        try { const { key, value } = JSON.parse(line); cache.set(key, value); } catch {}
    }
    console.log(`cache: loaded ${cache.size} solved position(s) from disk`);
}
function cachePut(key, value) {
    cache.set(key, value);
    fs.appendFileSync(CACHE_PATH, JSON.stringify({ key, value }) + '\n');
}

// ---- engine: loaded once, reused (S1 solves are sequential) ----
let engine = null;
async function getEngine() {
    if (engine) return engine;
    if (!fs.existsSync(WASM_PATH)) {
        console.error(`\nENGINE NOT FOUND: ${WASM_PATH}`);
        console.error('Run  pwsh bench/build.ps1  first to produce the node-capable WASM.\n');
        process.exit(1);
    }
    const Factory = require(WASM_PATH);
    engine = await Factory();
    engine.initialize();
    console.log('engine: WASM loaded + initialized');
    return engine;
}

function solve(m, position, maxMs) {
    m.loadPosition(position);
    const empties = countEmpties(m);
    const r = JSON.parse(m.minimaxFindBestMove(empties, maxMs)); // depth = empties = solve to game end
    return {
        bestMove: { hexId: r.hexId, tileValue: r.tileValue },
        score: r.score,
        depth: r.depth,
        empties,
        timeout: !!r.timeout,
        complete: !r.timeout && r.depth >= empties, // a real solve reaches game end without timing out
        nodes: r.nodes,
        timeMs: r.timeMs,
    };
}

// ---- HTTP ----
function send(res, code, obj) {
    res.writeHead(code, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // editor (localhost:8000) -> server (localhost:8080)
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    });
    res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        return send(res, 200, { ok: true, engineLoaded: !!engine, cachedPositions: cache.size });
    }
    if (req.method === 'POST' && req.url === '/solve') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', async () => {
            let position, maxMs;
            try {
                const j = JSON.parse(body || '{}');
                position = normalizePosition(j.position);
                maxMs = Math.max(1, Math.min(DEFAULT_MAX_MS, parseInt(j.maxMs || DEFAULT_MAX_MS, 10)));
            } catch (e) { return send(res, 400, { error: 'bad JSON: ' + e.message }); }
            if (!position || !position.includes('|')) return send(res, 400, { error: 'missing/invalid position' });

            if (cache.has(position)) {
                return send(res, 200, { ...cache.get(position), cached: true, position });
            }
            try {
                const m = await getEngine();
                const t0 = Date.now();
                const result = solve(m, position, maxMs);
                result.wallMs = Date.now() - t0;
                if (result.complete) cachePut(position, result); // never cache a timed-out (non-perfect) result
                console.log(`solve ${position}  -> score ${result.score} depth ${result.depth}` +
                            `${result.complete ? '' : ' (TIMED OUT)'}  ${result.wallMs}ms  [cache ${cache.size}]`);
                return send(res, 200, { ...result, cached: false, position });
            } catch (e) {
                return send(res, 500, { error: 'solve failed: ' + e.message });
            }
        });
        return;
    }
    send(res, 404, { error: 'not found' });
});

loadCache();
getEngine().then(() => {
    server.listen(PORT, () => {
        console.log(`Hexuki solve server: http://localhost:${PORT}`);
        console.log(`  POST /solve   {"position":"h..|p1:..|p2:..|turn:1", "maxMs":600000}`);
        console.log(`  GET  /health`);
    });
});
