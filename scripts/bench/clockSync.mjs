// Benchmark for claim 3: do clients with wrong local clocks agree on "server
// now" after the Cristian's-algorithm handshake?
//
//   node scripts/bench/clockSync.mjs [url] [clients]     default: prod, 30 clients
//
// All simulated clients run on THIS machine, so they share one real clock. Each
// gets a random artificial skew in +-5 s (Date.now is patched per client), runs
// the project's real public/js/clock.js against the real server over the real
// network, and then every client computes its estimate of server time at the
// SAME real instant. If the handshake works, those estimates agree to within
// network jitter even though the local clocks disagree by seconds.
//   uncorrected   : each client trusts its own (skewed) clock -> spread ~ skew range
//   1 sample      : single Cristian round trip (no best-of-N filtering)
//   best of 5     : the shipped algorithm (lowest RTT of 5 samples)
// Note this measures agreement BETWEEN clients, not absolute error against
// the Fly VM's clock (unknowable from here).

import { io } from 'socket.io-client';

const URL_ = process.argv[2] ?? 'https://jammusicspot.fly.dev';
const N = Number(process.argv[3] ?? 30);
const realNow = Date.now.bind(Date);
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const spread = (a) => Math.max(...a) - Math.min(...a);
const std = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };

const clients = [];
for (let i = 0; i < N; i++) {
    const skew = Math.round((Math.random() * 2 - 1) * 5000);
    Date.now = () => realNow() + skew;
    const clock = await import(`../../public/js/clock.js?client=${i}`);
    const socket = io(URL_, { transports: ['websocket'], forceNew: true, reconnection: false });
    await new Promise((res, rej) => { socket.on('connect', res); socket.on('connect_error', rej); });
    // one raw single-sample estimate with the same skewed clock
    const single = await new Promise((resolve) => {
        const t0 = Date.now();
        socket.emit('clock:sync', {}, (reply) => {
            const t1 = Date.now();
            const rtt = t1 - t0;
            resolve({ rtt, offset: reply.serverTime + rtt / 2 - t1 });
        });
    });
    await clock.syncClock(socket);
    clients.push({ skew, single, offset: clock.getOffset(), lowConfidence: clock.isLowConfidence() });
    socket.close();
}
Date.now = realNow;

const T = realNow(); // one shared real instant
const est = {
    uncorrected: clients.map((c) => T + c.skew),
    single: clients.map((c) => T + c.skew + c.single.offset),
    best5: clients.map((c) => T + c.skew + c.offset),
};
const rtts = clients.map((c) => c.single.rtt);
console.log(`clock-sync benchmark: ${N} clients, random local skew +-5000 ms, server ${URL_}`);
console.log(`network RTT (single sample): p50 ${pct(rtts, 0.5)} ms, p95 ${pct(rtts, 0.95)} ms, max ${Math.max(...rtts)} ms`);
console.log(`injected skew range: ${spread(clients.map((c) => c.skew))} ms`);
for (const [name, v] of Object.entries(est)) {
    const dev = v.map((x) => x - v.reduce((a, b) => a + b, 0) / v.length);
    console.log(`${name.padEnd(12)} spread (max-min of "server now" estimates): ${spread(v).toFixed(0).padStart(5)} ms | std ${std(v).toFixed(1).padStart(6)} ms | p95 |dev from mean| ${pct(dev.map(Math.abs), 0.95).toFixed(1)} ms`);
}
console.log(`low-confidence rounds: ${clients.filter((c) => c.lowConfidence).length}/${N}`);
process.exit(0);
