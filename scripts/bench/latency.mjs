// Command round-trip latency against a running server.
//
//   node scripts/bench/latency.mjs [url] [commands]   default: prod, 100 commands
//
// Creates a jam, joins as host, then alternates PLAY / PAUSE (host-only, each a
// real mutation: lock -> Redis -> version bump -> diff broadcast -> log enqueue)
// and times each ack. Also times the bare `clock:sync` ping as the network
// baseline, so "server work" = command ack minus ping RTT.

import { io } from 'socket.io-client';

const URL_ = process.argv[2] ?? 'https://jammusicspot.fly.dev';
const N = Number(process.argv[3] ?? 100);
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const req = (s, ev, payload) => new Promise((res) => s.timeout(10000).emit(ev, payload, (e, a) => res(e ? { ok: false } : a)));

const { jamId, hostToken } = await (await fetch(`${URL_}/api/jams`, { method: 'POST' })).json();
const s = io(URL_, { transports: ['websocket'], forceNew: true, reconnection: false });
await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
const joined = await req(s, 'jam:join', { jamId, userId: 'bench-host', name: 'Bench', hostToken });
if (!joined.ok) throw new Error(`join failed: ${JSON.stringify(joined)}`);
const catalog = (await (await fetch(`${URL_}/api/catalog`)).json()).tracks;
await req(s, 'room:command', { type: 'ADD_TRACK', payload: { trackId: catalog[0].trackId } });
await req(s, 'room:command', { type: 'ADD_TRACK', payload: { trackId: catalog[1].trackId } });
await req(s, 'room:command', { type: 'SKIP', payload: { expectedTrackId: null } }); // -> PLAYING

const ping = [];
for (let i = 0; i < N; i++) { const t = performance.now(); await req(s, 'clock:sync', {}); ping.push(performance.now() - t); }
const ack = [];
let failures = 0;
for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await req(s, 'room:command', { type: i % 2 ? 'PLAY' : 'PAUSE', payload: {} });
    ack.push(performance.now() - t);
    if (!r.ok) failures++;
}
const f = (x) => x.toFixed(1).padStart(6);
console.log(`latency benchmark: ${N} commands against ${URL_} (sequential, one client)`);
console.log(`ping RTT (clock:sync)      p50 ${f(pct(ping, 0.5))} ms  p95 ${f(pct(ping, 0.95))} ms  max ${f(Math.max(...ping))} ms`);
console.log(`PLAY/PAUSE ack             p50 ${f(pct(ack, 0.5))} ms  p95 ${f(pct(ack, 0.95))} ms  max ${f(Math.max(...ack))} ms  (failures: ${failures})`);
console.log(`server work (ack - ping)   p50 ${f(pct(ack, 0.5) - pct(ping, 0.5))} ms`);
s.close();
process.exit(0);
