// Capture a REAL multi-chunk route (adjacent Google 3D Tile bakes sharing one
// vertical anchor, like services/exportRouteLevel.js) with the conform OFF, so
// diagnoseRoute.mjs can measure per-chunk seating vs the COMBINED terrain under
// the three conform modes. This reproduces the actual route vertical pipeline on
// real tiles + real DEM — the thing the single-AOI capture can't show.
//
// Usage:
//   node tools/testlab/captureRoute.mjs --lat 33.76766 --lng -117.73490 \
//        --size 300 --chunks 3 --bearing 90 --name oc_route

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTerrainHeadless } from './terrainHeadless.mjs';
import { readMbkContainer } from './binContainer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CAP_DIR = path.join(HERE, 'captures');
const TMP_DIR = path.join(HERE, '.tmp');
const M_PER_DEG_LAT = 111320;

const argOf = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const readApiKey = () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    if (line.trim().startsWith('#') || !/GOOGLE_MAPS_API_KEY/.test(line)) continue;
    return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('VITE_GOOGLE_MAPS_API_KEY not found in .env.local');
};
const b64 = (t) => Buffer.from(t.buffer, t.byteOffset, t.byteLength).toString('base64');

const runWorker = (jobPath, outPath) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath,
    ['--max-old-space-size=8192', path.join(ROOT, 'scripts/googleBakeWorker.mjs'), jobPath, outPath],
    { cwd: ROOT, env: { ...process.env, MAPNG_CONFORM_TILES: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let last = null;
  child.stdout.on('data', (c) => { for (const l of String(c).split('\n')) { if (l.trim()) try { last = JSON.parse(l); } catch {} } });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve(last) : reject(new Error(`worker exit ${code}`))));
});

const main = async () => {
  const lat0 = Number(argOf('lat', '33.76766'));
  const lng0 = Number(argOf('lng', '-117.73490'));
  const sizeM = Number(argOf('size', '300'));
  const nChunks = Number(argOf('chunks', '3'));
  const bearingDeg = Number(argOf('bearing', '90')); // 90 = east
  const overlap = Number(argOf('overlap', '0.15'));
  const quality = argOf('quality', 'standard');
  const n = Number(argOf('demN', '256'));
  const name = argOf('name', `route_${lat0.toFixed(4)}_${lng0.toFixed(4)}_${nChunks}c`);

  fs.mkdirSync(CAP_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const apiKey = readApiKey();

  const stepM = sizeM * (1 - overlap);
  const br = (bearingDeg * Math.PI) / 180;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);

  let sharedGroundOffsetM = null;
  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    // advance along the bearing
    const dN = i * stepM * Math.cos(br), dE = i * stepM * Math.sin(br);
    const lat = lat0 + dN / M_PER_DEG_LAT;
    const lng = lng0 + dE / mPerDegLng;
    console.error(`[route] chunk ${i}: ${lat.toFixed(5)},${lng.toFixed(5)} — terrain…`);
    const terrain = await fetchTerrainHeadless({ lat, lng, sizeM, n });

    const jobPath = path.join(TMP_DIR, `${name}_c${i}.job.json`);
    const outPath = path.join(TMP_DIR, `${name}_c${i}.bin`);
    fs.writeFileSync(jobPath, JSON.stringify({
      data: { width: terrain.width, height: terrain.height, minHeight: terrain.minHeight, maxHeight: terrain.maxHeight, bounds: terrain.bounds, heightMap: b64(terrain.heightMap) },
      options: { apiKey, quality, stripGround: false, ...(sharedGroundOffsetM != null ? { sharedGroundOffsetM } : {}) },
    }));
    console.error(`[route] chunk ${i}: baking (conform OFF${sharedGroundOffsetM != null ? `, sharedAnchor=${sharedGroundOffsetM.toFixed(2)}` : ', natural anchor'})…`);
    await runWorker(jobPath, outPath);
    const { header, meshes } = readMbkContainer(outPath);
    // natural per-chunk anchor = mapngGroundY − googleGroundAlt; chunk 0 sets the shared value
    const naturalOffset = header.anchor.mapngGroundY - header.anchor.googleGroundAlt;
    if (i === 0) sharedGroundOffsetM = naturalOffset;

    const soup = meshes.filter((m) => m.positions && m.index)
      .map((m) => ({ positionsB64: b64(m.positions), index: { b64: b64(m.index), kind: m.index instanceof Uint32Array ? 'u32' : 'u16' } }));
    chunks.push({
      center: { lat, lng },
      anchor: header.anchor,
      terrain: { width: terrain.width, height: terrain.height, minHeight: terrain.minHeight, maxHeight: terrain.maxHeight, bounds: terrain.bounds, heightMapB64: b64(terrain.heightMap) },
      meshes: soup,
    });
    console.error(`[route] chunk ${i}: ${soup.length} meshes, anchor mapngGroundY=${header.anchor.mapngGroundY.toFixed(1)} googleGroundAlt=${header.anchor.googleGroundAlt.toFixed(1)}`);
  }

  const capPath = path.join(CAP_DIR, `${name}.route.json`);
  fs.writeFileSync(capPath, JSON.stringify({ meta: { lat0, lng0, sizeM, nChunks, bearingDeg, overlap, quality, sharedGroundOffsetM }, chunks }));
  console.error(`[route] wrote ${path.relative(ROOT, capPath)} (${nChunks} chunks)`);
};

main().catch((e) => { console.error('[route] FAILED:', e?.stack || e); process.exit(1); });
