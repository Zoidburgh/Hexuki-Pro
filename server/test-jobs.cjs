// Test the async job API: anytime search + cancel-returns-best. Run the server first.
//   node server/test-jobs.cjs
const http = require('http');
const PORT = process.env.HEXUKI_PORT || 8080;

function req(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: 'localhost', port: PORT, path, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
            res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d || '{}'))); });
        r.on('error', reject);
        if (data) r.write(data);
        r.end();
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const HARD = 'h4:3,h6:7,h7:4,h9:1,h12:1,h14:6,h16:3|p1:2,5,6,7,8,9|p2:1,2,4,5,8,9|turn:1';

    console.log('=== TEST 1: start a job on the hard 12-empty, watch depth climb, then CANCEL ===');
    const { jobId } = await req('POST', '/jobs', { position: HARD });
    console.log('started', jobId);

    for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const s = await req('GET', `/jobs/${jobId}`);
        const b = s.best;
        console.log(`  t+${((i + 1) * 1.5).toFixed(1)}s  status=${s.status}  best depth=${b ? b.depth : '-'}  score=${b ? b.score : '-'}  complete=${b ? b.complete : '-'}`);
        if (s.status !== 'running') break;
    }

    console.log('--- cancelling ---');
    const cancelled = await req('POST', `/jobs/${jobId}/cancel`);
    const b = cancelled.best;
    console.log(`  status=${cancelled.status}`);
    console.log(`  BEST-SO-FAR: depth ${b ? b.depth : '-'} of ${b ? b.empties : '-'}  score=${b ? b.score : '-'}  complete=${b ? b.complete : '-'}`);
    console.log(`  -> ${b && b.complete ? 'fully solved before cancel' : 'partial (depth-limited) best answer, honestly flagged complete:false'}`);
})().catch(e => { console.error('test failed:', e.message); process.exit(1); });
