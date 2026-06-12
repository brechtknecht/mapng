// Protocol smoke test for the bake-session refine flow, no browser needed.
// Requires a running dev server (npm run dev).
//
//   node scripts/smokeRefineSession.mjs [--rebake] [--extent 512] [--fov 70]
//
// FAST BY DEFAULT: the job key is stable, so repeat runs JOIN the live
// session from the previous run and skip the base bake — a run is then just
// one refine (~5–20 s warm). --rebake forces a fresh base bake (~25–60 s,
// mostly from the tile disk cache after the first time).
//
// Prints the worker's merge diagnostics (added/recarved in-AOI vs outside)
// relayed over SSE — the numbers that tell you whether refinement actually
// lands geometry inside the AOI.
import { readFileSync } from 'node:fs';

const BASE = process.env.MAPNG_DEV_URL ?? 'http://localhost:5173';
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GOOGLE_MAPS_API_KEY=(.+)$/m)[1].trim();

// Berlin, 512 m AOI by default — mirrors the real-map scale where the
// outside-AOI frustum problem was first observed.
const centerLat = 52.5163, centerLng = 13.3777;
const extentM = opt('--extent', 512);
const fov = opt('--fov', 70);
const dLat = extentM / 2 / 111320;
const dLng = extentM / 2 / (111320 * Math.cos((centerLat * Math.PI) / 180));
const heightMap = new Float32Array(256 * 256).fill(34);

const key = `smoke-refine|berlin|${extentM}m`;
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
};

// SSE until pred matches; relays interesting worker log lines.
const waitEvent = (jobId, pred) => new Promise(async (resolve, reject) => {
  const res = await fetch(`${BASE}/api/google-bake/${jobId}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) { reject(new Error('SSE stream ended without terminal event')); return; }
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const msg = JSON.parse(dataLine.slice(6));
      if (msg.type === 'log' && /merge:|refine rev|vertical anchor|station \d/.test(msg.line)) {
        console.log(`  worker> ${msg.line.replace(/^\[\w+\] /, '')}`);
      }
      if (msg.type === 'error' || msg.type === 'refine-error') { reject(new Error(msg.message)); return; }
      if (pred(msg)) { reader.cancel().catch(() => {}); resolve(msg); return; }
    }
  }
});

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 1. Start or JOIN the bake session.
const { jobId, status, joined } = await post('/api/google-bake', {
  key,
  force: flag('--rebake'),
  ensureSession: true,
  data: {
    bounds: { north: centerLat + dLat, south: centerLat - dLat, east: centerLng + dLng, west: centerLng - dLng },
    width: 256, height: 256, minHeight: 0,
    heightMap: Buffer.from(heightMap.buffer).toString('base64'),
  },
  options: { apiKey, quality: 'standard' },
});
if (joined && status === 'done') {
  console.log(`[${since()}] joined live session ${jobId.slice(0, 8)} — skipping base bake`);
} else {
  console.log(`[${since()}] base bake running (job ${jobId.slice(0, 8)})…`);
  const done = await waitEvent(jobId, (m) => m.type === 'done');
  console.log(`[${since()}] base done: ${done.meshes} meshes, session=${done.session}`);
}

// 2. Refine: street-level camera INSIDE the AOI looking INWARD across it —
//    vary the spot per run so repeat runs against a joined session always
//    have something new to pull (deterministic from the minute).
const minute = Math.floor(Date.now() / 60000) % 4;
const spots = [
  { e: -extentM * 0.15, n: -extentM * 0.12, lookE: extentM * 0.2, lookN: extentM * 0.15 },
  { e: extentM * 0.18, n: -extentM * 0.1, lookE: -extentM * 0.15, lookN: extentM * 0.12 },
  { e: -extentM * 0.1, n: extentM * 0.16, lookE: extentM * 0.12, lookN: -extentM * 0.18 },
  { e: extentM * 0.12, n: extentM * 0.14, lookE: -extentM * 0.1, lookN: -extentM * 0.15 },
];
const s = spots[minute];
const station = { ...s, heightM: 30, lookHeightM: 10, fov };
console.log(`[${since()}] refining from (e=${s.e.toFixed(0)}, n=${s.n.toFixed(0)}) looking inward, fov=${fov}…`);

const tR = Date.now();
const { revision } = await post(`/api/google-bake/${jobId}/refine`, { station });
const refined = await waitEvent(jobId, (m) => m.type === 'refined' && m.revision === revision);
console.log(
  `[${since()}] refined rev${revision} in ${((Date.now() - tR) / 1000).toFixed(1)}s: ` +
  `+${refined.added}/-${refined.removed} tiles, ${refined.meshes} meshes, ` +
  `${(refined.bytes / 1024 ** 2).toFixed(0)} MB${refined.timedOut ? ' — TIMED OUT' : ''}`,
);

if (refined.added === 0 && refined.removed === 0) {
  console.log('NOTE: +0/-0 — nothing new in this frustum (already refined here?). Re-run for a different spot.');
}
console.log('SMOKE OK');
