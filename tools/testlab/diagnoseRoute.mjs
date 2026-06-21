// Measure per-chunk seating of a REAL captured route (captureRoute.mjs) vs the
// COMBINED terrain — the surface the level drives on — under each conform mode.
// Run: node tools/testlab/diagnoseRoute.mjs <name.route>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conformTilesToFloor } from '../../services/tileGroundConform.js';
import { buildCombinedRouteTerrain, sampleHeightAt, sampleCombinedHeightMap } from '../../services/routeTerrainComposite.js';
import { SCENE_SIZE } from '../../services/googleBakeCore.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HALF = SCENE_SIZE / 2;
const name = (process.argv[2] || '').replace(/\.route(\.json)?$/, '');
const j = JSON.parse(fs.readFileSync(path.join(HERE, 'captures', `${name}.route.json`), 'utf8'));

const decode = (b64, T) => { const b = Buffer.from(b64, 'base64'); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return new T(ab); };
const terrainOf = (t) => ({ width: t.width, height: t.height, minHeight: t.minHeight, maxHeight: t.maxHeight, bounds: t.bounds, heightMap: decode(t.heightMapB64, Float32Array) });
const soupOf = (c) => c.meshes.map((m) => ({ positions: decode(m.positionsB64, Float32Array), index: decode(m.index.b64, m.index.kind === 'u32' ? Uint32Array : Uint16Array) }));

const chunks = j.chunks.map((c) => ({ center: c.center, terrain: terrainOf(c.terrain), soup: soupOf(c) }));
const combined = buildCombinedRouteTerrain(chunks.map((c) => c.terrain));

const sceneToLatLng = (b, x, z) => ({
  lng: b.west + ((x + HALF) / SCENE_SIZE) * (b.east - b.west),
  lat: b.north - ((z + HALF) / SCENE_SIZE) * (b.north - b.south),
});

// Mean/max |residual| of a chunk's GROUND tiles vs combined, after conforming
// `soup` against `target` and placing via baseUp = chunkMin − combinedMin.
const measure = (chunk, mode) => {
  let target = chunk.terrain;
  if (mode === 'combined') target = { ...chunk.terrain, heightMap: sampleCombinedHeightMap(combined, chunk.terrain) };
  const conformed = mode === 'off' ? null : conformTilesToFloor(chunk.soup, target);
  const baseUp = chunk.terrain.minHeight - combined.minHeight;
  let sum = 0, max = 0, cnt = 0, groundSum = 0, groundCnt = 0;
  for (let mi = 0; mi < chunk.soup.length; mi++) {
    const p = chunk.soup[mi].positions;
    const out = conformed ? (conformed.positions[mi] || p) : p;
    for (let i = 0; i < p.length; i += 3) {
      const { lat, lng } = sceneToLatLng(chunk.terrain.bounds, p[i], p[i + 2]);
      const worldZ = baseUp + out[i + 1];
      const combinedAbove = sampleHeightAt(combined, lat, lng) - combined.minHeight;
      const res = worldZ - combinedAbove;
      // only count near-ground tiles (drivable surface), within ±3m of combined
      if (Math.abs(res) < 3) { groundSum += Math.abs(res); groundCnt++; }
      sum += Math.abs(res); if (Math.abs(res) > max) max = Math.abs(res); cnt++;
    }
  }
  return { meanAll: sum / cnt, groundMean: groundCnt ? groundSum / groundCnt : NaN, groundFrac: groundCnt / cnt, max };
};

console.log(`route ${name}: ${chunks.length} chunks, sharedAnchor=${j.meta.sharedGroundOffsetM?.toFixed(2)}, combined.minH=${combined.minHeight.toFixed(1)} mpp=${combined.metersPerPixel.toFixed(2)}`);
for (const mode of ['off', 'perChunk', 'combined']) {
  const rows = chunks.map((c, i) => { const m = measure(c, mode); return `c${i}:gm=${m.groundMean.toFixed(2)}(${(m.groundFrac * 100).toFixed(0)}%)`; });
  console.log(`  ${mode.padEnd(9)} ground-mean residual vs combined:  ${rows.join('   ')}`);
}
