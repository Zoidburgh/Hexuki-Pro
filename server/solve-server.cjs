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
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.HEXUKI_PORT || '8080', 10);
const WASM_PATH = path.join(__dirname, '..', 'bench', 'engine', 'hexuki.js');
const NATIVE_EXE = path.join(__dirname, '..', 'native', 'hexuki-solve.exe'); // multi-core native solver
const CACHE_PATH = path.join(__dirname, 'cache.jsonl');
const DEFAULT_MAX_MS = 600000; // 10 min cap per solve
const HAS_NATIVE = fs.existsSync(NATIVE_EXE);
// Threads for the native solver. DEFAULT 1 (single-threaded = correct). Multi-threaded Lazy SMP
// still has a residual race that occasionally returns a WRONG value, so it must NOT be the
// default. Set HEXUKI_THREADS>1 only for experiments while that's being fixed.
const SOLVE_THREADS = Math.max(1, parseInt(process.env.HEXUKI_THREADS || '1', 10));

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

// ---- async jobs: anytime search with cancel (no cap) ----
// A job runs the solve in a worker thread that reports each completed depth. "best" is always
// the deepest completed answer. Cancel terminates the worker and keeps that best-so-far.
const jobs = new Map();
let jobCounter = 0;

function emptiesOf(position) {
    const board = (position.split('|')[0] || '');
    const placed = board ? board.split(',').filter(Boolean).length : 0;
    return 19 - placed;
}

function startJob(position) {
    const id = `job${++jobCounter}`;
    const empties = emptiesOf(position);
    const job = { id, position, empties, status: 'running', best: null, error: null,
                  worker: null, proc: null, kind: null, startedAt: Date.now() };

    if (HAS_NATIVE) {
        // Native multi-core solve: spawn the exe (uses all hardware threads, Lazy SMP), stream
        // @PROGRESS, cancel = kill the process. Same anytime-search contract as the WASM worker.
        job.kind = 'native';
        const child = spawn(NATIVE_EXE, [position, '0', '2147483647', '--threads', String(SOLVE_THREADS), '--stream']);
        job.proc = child;
        let buf = '';
        child.stdout.on('data', d => {
            buf += d.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (line.startsWith('@PROGRESS')) {
                    const p = line.split(/\s+/); // @PROGRESS depth score hexId tileValue totalNodes elapsedMs
                    job.best = {
                        bestMove: { hexId: +p[3], tileValue: +p[4] }, score: +p[2], depth: +p[1],
                        empties, timeout: false, complete: (+p[1]) >= empties,
                        nodes: +p[5], timeMs: +p[6], totalNodes: +p[5], totalMs: +p[6],
                    };
                } else if (line.startsWith('{')) {
                    try {
                        const r = JSON.parse(line);
                        job.best = {
                            bestMove: { hexId: r.hexId, tileValue: r.tileValue }, score: r.score,
                            depth: r.depth, empties: r.empties, timeout: !!r.timeout,
                            complete: !r.timeout && r.depth >= r.empties,
                            nodes: r.nodes, timeMs: r.timeMs, totalNodes: r.nodes, totalMs: r.timeMs,
                        };
                        job.status = 'done';
                        if (job.best.complete) cachePut(position, job.best);
                        console.log(`job ${id} (native) done: score ${job.best.score} depth ${job.best.depth}`);
                    } catch {}
                }
            }
        });
        child.on('error', e => { job.status = 'error'; job.error = String(e.message || e); });
        child.on('exit', () => { if (job.status === 'running') job.status = 'error', job.error = job.error || 'native process exited'; });
        jobs.set(id, job);
        return job;
    }

    // Fallback: WASM worker thread (no native exe present).
    job.kind = 'wasm';
    const worker = new Worker(path.join(__dirname, 'solve-worker.cjs'), { workerData: { position } });
    job.worker = worker;
    worker.on('message', msg => {
        if (msg.progress) job.best = msg.progress;
        else if (msg.done) {
            job.best = msg.done || job.best;
            job.status = 'done';
            if (job.best && job.best.complete) cachePut(position, job.best); // cache full solves only
            console.log(`job ${id} (wasm) done: score ${job.best && job.best.score} depth ${job.best && job.best.depth}`);
        } else if (msg.error) { job.status = 'error'; job.error = msg.error; }
    });
    worker.on('error', e => { job.status = 'error'; job.error = String(e && e.message || e); });
    worker.on('exit', () => { if (job.status === 'running') job.status = 'error', job.error = job.error || 'worker exited'; });
    jobs.set(id, job);
    return job;
}

function jobView(job) {
    return {
        jobId: job.id, status: job.status, position: job.position,
        solver: HAS_NATIVE ? (SOLVE_THREADS > 1 ? 'native (multi-core)' : 'native (single-thread)') : 'wasm worker',
        best: job.best, error: job.error, elapsedMs: Date.now() - job.startedAt,
    };
}

function cancelJob(job) {
    if (job.status === 'running') {
        job.status = 'cancelled';
        if (job.kind === 'native' && job.proc) job.proc.kill();      // kill native process
        else if (job.worker) job.worker.terminate();                 // terminate WASM worker
        console.log(`job ${job.id} cancelled at depth ${job.best ? job.best.depth : 0}`);
    }
    return jobView(job);
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
        return send(res, 200, { ok: true, solver: HAS_NATIVE ? 'native (multi-core)' : 'wasm', engineLoaded: !!engine, cachedPositions: cache.size, activeJobs: jobs.size });
    }

    // --- async job API (anytime search + cancel, no cap) ---
    // POST /jobs            { position }            -> { jobId } (or cached result immediately)
    // GET  /jobs/<id>                               -> { status, best, ... }
    // POST /jobs/<id>/cancel                        -> terminates, returns best-so-far
    if (req.method === 'POST' && req.url === '/jobs') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
        req.on('end', () => {
            let position;
            try { position = normalizePosition(JSON.parse(body || '{}').position); }
            catch (e) { return send(res, 400, { error: 'bad JSON: ' + e.message }); }
            if (!position || !position.includes('|')) return send(res, 400, { error: 'missing/invalid position' });
            if (cache.has(position)) return send(res, 200, { status: 'done', best: cache.get(position), cached: true, position, solver: HAS_NATIVE ? 'native (multi-core)' : 'wasm worker' });
            const job = startJob(position);
            return send(res, 202, { jobId: job.id, status: job.status, position });
        });
        return;
    }
    const jobMatch = req.url.match(/^\/jobs\/([^/]+)(\/cancel)?$/);
    if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return send(res, 404, { error: 'no such job' });
        if (req.method === 'POST' && jobMatch[2] === '/cancel') return send(res, 200, cancelJob(job));
        if (req.method === 'GET') return send(res, 200, jobView(job));
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
        console.log(`  solver: ${HAS_NATIVE ? 'NATIVE (multi-core Lazy SMP)' : 'WASM (single-thread; build native/ for multi-core)'}`);
        console.log(`  POST /jobs    {"position":"..."}   (anytime search + cancel; used by the editor)`);
        console.log(`  POST /solve   {"position":"...", "maxMs":600000}   (synchronous)`);
        console.log(`  GET  /health`);
    });
});
