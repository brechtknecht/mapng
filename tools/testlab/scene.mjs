// Synthetic-but-realistic scene generator for the conform test lab.
//
// NOTHING here is a mock of the unit under test: the conform (S2) is the real
// app module. This file only FEEDS it Google-bake-shaped input we can control:
//   - a mapng terrain (rolling DEM) in the exact {heightMap,width,height,
//     minHeight,bounds} shape services consume, and
//   - a tile "soup" (Array<{positions:[sceneX,Ymeters,sceneZ], index}>) shaped
//     like createTileMeshTransformer output: a ground carpet lifted off the DEM
//     by a spatially-varying RESIDUAL (the datum/shape drift the single-point
//     anchor leaves behind), plus building boxes that must keep their height.
//
// Coordinates match the bake: SCENE_SIZE=100, X/Z in scene units [-50,50],
// Y in metres above the .ter datum. Pure / DOM-free.

import { SCENE_SIZE, computeUnitsPerMeter } from '@mapng/bake/googleBakeCore';

const HALF = SCENE_SIZE / 2;

// A gentle rolling DEM so the floor is clearly non-flat (proves conform follows
// terrain shape, not just a constant lift). Returns the {data} services expect.
const buildTerrain = ({ aoiM = 400, demN = 128, demAmpM = 12 } = {}) => {
  const heightMap = new Float32Array(demN * demN);
  let minH = Infinity, maxH = -Infinity;
  for (let r = 0; r < demN; r++) {
    for (let c = 0; c < demN; c++) {
      const u = c / (demN - 1), v = r / (demN - 1);
      // two low-frequency lobes + a slope
      const h =
        100 +
        demAmpM * Math.sin(u * Math.PI * 1.5) * Math.cos(v * Math.PI * 1.2) +
        demAmpM * 0.4 * (u - 0.5);
      heightMap[r * demN + c] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  // bounds sized to aoiM (near the equator so cos≈1); only the WIDTH matters for
  // computeUnitsPerMeter, height kept square.
  const degW = aoiM / 111320;
  const data = {
    width: demN,
    height: demN,
    minHeight: minH,
    maxHeight: maxH,
    heightMap,
    bounds: { south: 0, north: degW, west: 0, east: degW },
  };
  return data;
};

// Inline copy of the bake's bilinear DEM read (services/googleBakeCore
// sampleHeightAtScene), kept local so the scene builder has no import cycle and
// stays trivially testable. Returns ABSOLUTE terrain height in metres.
const terrainAt = (data, x, z) => {
  const u = Math.max(0, Math.min(1, (x + HALF) / SCENE_SIZE));
  const v = Math.max(0, Math.min(1, (z + HALF) / SCENE_SIZE));
  const fx = u * (data.width - 1), fz = v * (data.height - 1);
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, data.width - 1), z1 = Math.min(z0 + 1, data.height - 1);
  const tx = fx - x0, tz = fz - z0;
  const h = data.heightMap, w = data.width;
  return (
    h[z0 * w + x0] * (1 - tx) * (1 - tz) +
    h[z0 * w + x1] * tx * (1 - tz) +
    h[z1 * w + x0] * (1 - tx) * tz +
    h[z1 * w + x1] * tx * tz
  );
};

// The drift the conform must remove, in metres, as a function of scene XZ. A
// constant (datum) + tilt (ellipsoid↔geoid term) + a low wiggle (photogrammetric
// ground-shape mismatch). px,pz ∈ [-1,1]. Kept under groundDistanceM by default
// so every ground tri is detected (see tileGroundConform's ceiling note).
const driftAt = (x, z, { base = 1.2, tiltX = 0.6, tiltZ = 0.3, wiggle = 0.4 } = {}) => {
  const px = x / HALF, pz = z / HALF;
  return base + tiltX * 0.5 * px + tiltZ * 0.5 * pz + wiggle * Math.sin(px * Math.PI * 2) * Math.cos(pz * Math.PI * 1.3);
};

// One axis-aligned building: 4 walls + a flat roof, base sitting ON the drifted
// tile ground (so its footprint reads as ground), roof `heightM` above it. Its
// walls are vertical and roof is elevated, so the conform never treats them as
// ground — it only shifts them rigidly by the local delta. Returned as its own
// soup mesh, mirroring per-tile meshes.
const buildBuilding = (data, drift, { cx, cz, halfM = 6, heightM = 18 } = {}, upm) => {
  const half = halfM * upm; // metres → scene units for the footprint
  const x0 = cx - half, x1 = cx + half, z0 = cz - half, z1 = cz + half;
  const groundY = (x, z) => terrainAt(data, x, z) - data.minHeight + driftAt(x, z, drift);
  const baseY = groundY(cx, cz);
  const topY = baseY + heightM;
  // 8 corners: 0-3 base (CCW), 4-7 top
  const positions = [
    x0, baseY, z0, x1, baseY, z0, x1, baseY, z1, x0, baseY, z1,
    x0, topY, z0, x1, topY, z0, x1, topY, z1, x0, topY, z1,
  ];
  const quad = (a, b, c, d) => [a, b, c, a, c, d];
  const index = [
    ...quad(4, 5, 6, 7),           // roof
    ...quad(0, 1, 5, 4),           // walls
    ...quad(1, 2, 6, 5),
    ...quad(2, 3, 7, 6),
    ...quad(3, 0, 4, 7),
  ];
  return { positions: new Float32Array(positions), index: new Uint32Array(index), kind: 'building', baseY, topY, cx, cz };
};

// The ground "carpet": a regular grid of horizontal tris covering the AOI, each
// vertex lifted to terrain + drift. This is the surface that must land on the
// floor. One mesh.
const buildGroundCarpet = (data, drift, gridN = 64) => {
  const verts = [];
  const groundY = (x, z) => terrainAt(data, x, z) - data.minHeight + driftAt(x, z, drift);
  for (let r = 0; r <= gridN; r++) {
    for (let c = 0; c <= gridN; c++) {
      const x = -HALF + (c / gridN) * SCENE_SIZE;
      const z = -HALF + (r / gridN) * SCENE_SIZE;
      verts.push(x, groundY(x, z), z);
    }
  }
  const index = [];
  const idx = (r, c) => r * (gridN + 1) + c;
  for (let r = 0; r < gridN; r++) {
    for (let c = 0; c < gridN; c++) {
      index.push(idx(r, c), idx(r, c + 1), idx(r + 1, c));
      index.push(idx(r, c + 1), idx(r + 1, c + 1), idx(r + 1, c));
    }
  }
  return { positions: new Float32Array(verts), index: new Uint32Array(index), kind: 'ground' };
};

/**
 * Build a full test scene.
 * @param {object} params  drift {base,tiltX,tiltZ,wiggle} + {gridN}
 * @returns {{ data, soup, buildings, drift, unitsPerMeter, aoiM }}
 */
export const buildTestScene = (params = {}) => {
  const { gridN = 64, aoiM = 400, ...drift } = params;
  const data = buildTerrain({ aoiM });
  const upm = computeUnitsPerMeter(data);
  const carpet = buildGroundCarpet(data, drift, gridN);
  const buildingDefs = [
    { cx: -18, cz: -12, halfM: 7, heightM: 22 },
    { cx: 14, cz: 8, halfM: 5, heightM: 14 },
    { cx: 2, cz: 22, halfM: 6, heightM: 30 },
    { cx: 24, cz: -22, halfM: 8, heightM: 18 },
  ];
  const buildings = buildingDefs.map((b) => buildBuilding(data, drift, b, upm));
  return { data, soup: [carpet, ...buildings], buildings, drift, unitsPerMeter: upm, aoiM };
};
