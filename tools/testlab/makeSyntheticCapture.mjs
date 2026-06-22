// Emit a SYNTHETIC capture fixture (no network / API key) that exercises the road
// mask: a flat DEM, one straight OSM road, and a road mesh that both WIGGLES and
// FLOATS ~5 m above the floor (beyond the conform's ±2.5 m band). Lets the lab
// verify the mask snap offline — load it like any real capture.
//
//   node tools/testlab/makeSyntheticCapture.mjs            → writes captures/synthroad.json
//   then open the lab and pick "synthroad", or:
//   GET /api/conform?capture=synthroad&roadmask=1  vs  &roadmask=0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP_DIR = path.join(HERE, 'captures');
const b64 = (t) => Buffer.from(t.buffer, t.byteOffset, t.byteLength).toString('base64');

// 100 m AOI ⇒ unitsPerMeter ≈ 1. Flat DEM at absolute height 10 (minHeight 10 ⇒
// terrain sits at 0 above the datum, so a vertex's metres-Y IS its float).
const N = 64;
const heightMap = new Float32Array(N * N).fill(10);
const bounds = { south: 0, north: 100 / 111320, west: 0, east: 100 / 111320 };
const C_LAT = 50 / 111320;

// A road mesh: horizontal tris along X at z≈0, each lifted +5 m and wiggled ±0.6 m.
const verts = [], index = [];
let v = 0;
for (let cx = -45; cx <= 45; cx += 3) {
  const y = 5 + 0.6 * Math.sin(cx * 0.7); // floats beyond the band AND wiggles
  verts.push(cx, y, 0, cx + 1, y, 0, cx, y, 1);
  index.push(v, v + 1, v + 2); v += 3;
}
const positions = new Float32Array(verts);
const idx = new Uint32Array(index);

const capture = {
  meta: { lat: 0, lng: 0, sizeM: 100, quality: 'synthetic', meshCount: 1, synthetic: true },
  terrain: {
    width: N, height: N, minHeight: 10, maxHeight: 10,
    bounds, heightMapB64: b64(heightMap),
    osmFeatures: [{
      id: 'synth_road', type: 'road', tags: { highway: 'residential' },
      geometry: [{ lat: C_LAT, lng: 5 / 111320 }, { lat: C_LAT, lng: 95 / 111320 }],
    }],
  },
  meshes: [{ name: 'synth_road', positionsB64: b64(positions), index: { b64: b64(idx), kind: 'u32' } }],
};

fs.mkdirSync(CAP_DIR, { recursive: true });
const out = path.join(CAP_DIR, 'synthroad.json');
fs.writeFileSync(out, JSON.stringify(capture));
console.error(`[synth] wrote ${path.relative(path.resolve(HERE, '../..'), out)} — ${index.length / 3} road tris, +5 m float, ±0.6 m wiggle`);
