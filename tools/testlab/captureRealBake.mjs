// Capture a REAL Google Photorealistic 3D Tiles bake to a lab fixture.
//
// Runs the actual headless bake worker (scripts/googleBakeWorker.mjs — the same
// one the dev sidecar uses) with the CONFORM DISABLED and the ground kept, then
// dumps the welded, un-conformed soup + the real DEM into a capture file. The
// lab server later loads that and applies the REAL conformTilesToFloor live, so
// the before/after comparison is on genuine tile geometry against a genuine
// floor — no synthesis anywhere in the path under test.
//
// Usage:
//   node tools/testlab/captureRealBake.mjs --lat 52.5163 --lng 13.3777 \
//        --size 320 --quality roads --name brandenburg
//   (key read from .env.local VITE_GOOGLE_MAPS_API_KEY — Google or Cesium ion)

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

const argOf = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const readApiKey = () => {
  const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    if (line.trim().startsWith('#') || !/GOOGLE_MAPS_API_KEY/.test(line)) continue;
    return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('VITE_GOOGLE_MAPS_API_KEY not found in .env.local');
};

const b64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');

const runWorker = (jobPath, outPath) => new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    ['--max-old-space-size=8192', path.join(ROOT, 'scripts/googleBakeWorker.mjs'), jobPath, outPath],
    { cwd: ROOT, env: { ...process.env, MAPNG_CONFORM_TILES: '0' }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let last = null;
  child.stdout.on('data', (c) => {
    for (const line of String(c).split('\n')) {
      if (!line.trim()) continue;
      try { last = JSON.parse(line); } catch { /* not protocol */ }
    }
  });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve(last) : reject(new Error(`bake worker exited ${code}`))));
});

const main = async () => {
  const lat = Number(argOf('lat', '52.5163'));
  const lng = Number(argOf('lng', '13.3777'));
  const sizeM = Number(argOf('size', '320'));
  const quality = argOf('quality', 'roads');
  const n = Number(argOf('demN', '256'));
  const name = argOf('name', `cap_${lat.toFixed(4)}_${lng.toFixed(4)}_${sizeM}m`);

  fs.mkdirSync(CAP_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const apiKey = readApiKey();

  console.error(`[capture] terrain ${lat},${lng} ${sizeM}m @ DEM ${n}px …`);
  const terrain = await fetchTerrainHeadless({ lat, lng, sizeM, n });
  console.error(`[capture] terrain: ${terrain.tilesFetched} tiles, elev ${terrain.minHeight.toFixed(1)}–${terrain.maxHeight.toFixed(1)}m`);

  const jobPath = path.join(TMP_DIR, `${name}.job.json`);
  const outPath = path.join(TMP_DIR, `${name}.bin`);
  fs.writeFileSync(jobPath, JSON.stringify({
    data: {
      width: terrain.width, height: terrain.height,
      minHeight: terrain.minHeight, maxHeight: terrain.maxHeight,
      bounds: terrain.bounds,
      heightMap: b64(terrain.heightMap),
    },
    options: { apiKey, quality, stripGround: false },
  }));

  console.error(`[capture] baking real tiles (quality=${quality}, conform OFF) — this calls Google/Cesium …`);
  const done = await runWorker(jobPath, outPath);
  console.error(`[capture] bake done: ${done?.meshes} meshes, ${((done?.bytes || 0) / 1024 ** 2).toFixed(1)} MB`);

  const { header, meshes } = readMbkContainer(outPath);
  const soup = meshes
    .filter((m) => m.positions && m.index)
    .map((m) => ({ name: m.name, positionsB64: b64(m.positions), index: { b64: b64(m.index), kind: m.index instanceof Uint32Array ? 'u32' : 'u16' } }));

  const capPath = path.join(CAP_DIR, `${name}.json`);
  fs.writeFileSync(capPath, JSON.stringify({
    meta: { lat, lng, sizeM, quality, meshCount: soup.length, anchor: header.anchor, stats: header.stats },
    terrain: {
      width: terrain.width, height: terrain.height,
      minHeight: terrain.minHeight, maxHeight: terrain.maxHeight,
      bounds: terrain.bounds, heightMapB64: b64(terrain.heightMap),
    },
    meshes: soup,
  }));
  console.error(`[capture] wrote ${path.relative(ROOT, capPath)}  (${soup.length} meshes)`);
  console.error(`[capture] open the lab and pick "${name}" — or GET /api/scene.json?capture=${name}`);
};

main().catch((e) => { console.error('[capture] FAILED:', e?.stack || e); process.exit(1); });
