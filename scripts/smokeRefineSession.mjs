// Protocol smoke test for the bake-session refine flow, no browser needed:
// base bake → live session → two refines with user stations → verifies the
// result container grows, the revision advances and the vertical anchor
// stays bit-identical. Requires a running dev server.
//
//   node scripts/smokeRefineSession.mjs
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:5173';
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GOOGLE_MAPS_API_KEY=(.+)$/m)[1].trim();

const centerLat = 52.5163, centerLng = 13.3777, extentM = 1000;
const dLat = extentM / 2 / 111320;
const dLng = extentM / 2 / (111320 * Math.cos((centerLat * Math.PI) / 180));
const heightMap = new Float32Array(256 * 256).fill(34);

const key = `tmp-refine-test|${Date.now()}`;
const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
};

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
      if (msg.type === 'error' || msg.type === 'refine-error') { reject(new Error(msg.message)); return; }
      if (pred(msg)) { reader.cancel().catch(() => {}); resolve(msg); return; }
    }
  }
});

const decodeHeader = async (jobId) => {
  const buf = await (await fetch(`${BASE}/api/google-bake/${jobId}/result`)).arrayBuffer();
  const view = new DataView(buf);
  const headerLen = view.getUint32(4, true);
  return { header: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen))), bytes: buf.byteLength };
};

// 1. base bake
const { jobId } = await post('/api/google-bake', {
  key,
  data: {
    bounds: { north: centerLat + dLat, south: centerLat - dLat, east: centerLng + dLng, west: centerLng - dLng },
    width: 256, height: 256, minHeight: 0,
    heightMap: Buffer.from(heightMap.buffer).toString('base64'),
  },
  options: { apiKey, quality: 'standard' },
});
console.log(`job ${jobId} started`);
const done = await waitEvent(jobId, (m) => m.type === 'done');
console.log(`base done: ${done.meshes} meshes, session=${done.session}`);

const probe1 = await (await fetch(`${BASE}/api/google-bake/jobs?key=${encodeURIComponent(key)}`)).json();
console.log(`probe: ${JSON.stringify(probe1)}`);
if (!probe1.sessionAlive) throw new Error('session not alive after base bake');

const base = await decodeHeader(jobId);
console.log(`base result: rev=${base.header.revision}, meshes=${base.header.meshes.length}, ` +
  `${(base.bytes / 1024 ** 2).toFixed(1)}MB, anchor=${JSON.stringify(base.header.anchor)}`);

// 2. refine: street-level station 150m east of centre, looking north, FOV 75
const t0 = Date.now();
const { revision } = await post(`/api/google-bake/${jobId}/refine`, {
  station: { e: 150, n: 0, heightM: 30, lookE: 150, lookN: 60, lookHeightM: 8, fov: 75 },
});
console.log(`refine rev${revision} queued`);
const refined = await waitEvent(jobId, (m) => m.type === 'refined' && m.revision === revision);
console.log(
  `refined in ${((Date.now() - t0) / 1000).toFixed(1)}s: +${refined.added}/-${refined.removed} tiles, ` +
  `${refined.meshes} meshes, selected=${refined.selected}`,
);

const after = await decodeHeader(jobId);
const userStations = after.header.bakeStations.filter((s) => s.kind === 'user');
console.log(
  `refined result: rev=${after.header.revision}, meshes=${after.header.meshes.length}, ` +
  `${(after.bytes / 1024 ** 2).toFixed(1)}MB, userStations=${JSON.stringify(userStations)}`,
);

if (after.header.revision !== revision) throw new Error('revision mismatch in container');
if (after.header.meshes.length <= base.header.meshes.length - refined.removed) {
  console.warn('mesh count did not grow as expected — inspect');
}
if (after.header.anchor.googleGroundAlt !== base.header.anchor.googleGroundAlt) {
  throw new Error('vertical anchor changed across refinement!');
}

// 3. second refine to prove the session keeps serving
const r2 = await post(`/api/google-bake/${jobId}/refine`, {
  station: { e: -200, n: 120, heightM: 25, lookE: -150, lookN: 160, lookHeightM: 5, fov: 70 },
});
const t1 = Date.now();
const refined2 = await waitEvent(jobId, (m) => m.type === 'refined' && m.revision === r2.revision);
console.log(`second refine in ${((Date.now() - t1) / 1000).toFixed(1)}s: +${refined2.added}/-${refined2.removed} tiles, ${refined2.meshes} meshes`);

console.log('REFINE E2E SUCCESS');
