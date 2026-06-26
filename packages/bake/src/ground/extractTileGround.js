/** @layer core */
// Extract a drivable bare-earth ground heightmap FROM baked Google 3D tiles —
// the production entry point for the strategy validated in the terrain sandbox.
//
// Pipeline (see ./heightField.js + ./filters + ./postprocess):
//   1. rasterise every tile triangle → dense per-cell MIN surface (DSM bottom)
//   2. bare-earth filter (CSF cloth / PMF morphology) strips buildings, lifts
//      sub-street spikes — no reliance on the coarse DEM datum
//   3. optional edge-preserving (bilateral) post-process smooths the road
//
// Returns a heightMap that is a DROP-IN replacement for terrain.heightMap: same
// width×height grid, same north-origin row order, ABSOLUTE METRES — so the .ter
// encoder consumes it unchanged. Cells the tiles don't cover fall back to the
// DEM, so the sheet stays watertight.
//
// Pure / DOM-free: traverses the THREE.Group geometry only (no renderer), so it
// runs in the browser export AND a headless Node worker.
import { computeUnitsPerMeter } from '../scene/sceneFrame.js';
import { buildTileHeightField } from './heightField.js';
import { FILTERS } from './filters/index.js';
import { postProcessorById } from './postprocess/index.js';

const filterById = (id) =>
  FILTERS.find((f) => f.meta.id === id) ||
  FILTERS.find((f) => f.meta.id === 'csf') ||
  FILTERS[0];

// The default ground strategy chosen in the sandbox: cloth simulation for robust
// building removal + bilateral smoothing to even the road without bleeding
// buildings into it. Per-filter / per-effect params default to each module's own
// meta defaults when left empty.
export const DEFAULT_GROUND_STRATEGY = {
  filterId: 'csf',
  filterParams: {},
  postId: 'bilateral',
  postParams: {},
  belowBandM: 3,
  aboveBandM: 5,
};

/**
 * @param {import('three').Group} tilesGroup  baked tiles, world Y = beamZMeters * unitsPerMeter
 * @param {object} terrain  TerrainData (heightMap, width, height, minHeight, bounds)
 * @param {object} [options]  overrides for DEFAULT_GROUND_STRATEGY (+ optional `maxSeg`)
 * @returns {{ heightMap: Float32Array, width: number, height: number, minHeight: number, maxHeight: number, coverage: number }}
 *   heightMap is absolute metres, terrain.width×terrain.height, north-origin.
 */
export function extractTileGround(tilesGroup, terrain, options = {}) {
  const opt = { ...DEFAULT_GROUND_STRATEGY, ...options };
  const width = terrain.width;
  const height = terrain.height;
  const minHeight = terrain.minHeight ?? 0;
  const upm = computeUnitsPerMeter(terrain) || 1;

  // Match the field grid to the .ter resolution so a node maps 1:1 to a pixel
  // (same orientation: node row zi == heightMap row zi == north→south).
  const maxSeg = options.maxSeg ?? (Math.max(width, height) - 1);
  const field = buildTileHeightField(tilesGroup, terrain, upm, {
    maxSeg,
    belowBandM: opt.belowBandM,
    aboveBandM: opt.aboveBandM,
  });

  const filter = filterById(opt.filterId);
  let heights = filter.apply(field, { ...opt.filterParams }); // scene units
  if (opt.postId) {
    heights = postProcessorById(opt.postId).apply(heights, field, { ...opt.postParams });
  }

  const { nx, nz } = field;
  const out = new Float32Array(width * height);
  const toMeters = (sceneH) => sceneH / upm + minHeight;

  let lo = Infinity;
  let hi = -Infinity;
  let covered = 0;
  if (nx === width && nz === height) {
    // 1:1 grid — direct copy, scene units → absolute metres.
    for (let i = 0; i < out.length; i++) {
      const m = toMeters(heights[i]);
      out[i] = m;
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
  } else {
    // Fallback: bilinear resample the field grid onto the terrain grid.
    for (let row = 0; row < height; row++) {
      const gz = (row / Math.max(1, height - 1)) * (nz - 1);
      const z0 = Math.floor(gz);
      const z1 = Math.min(z0 + 1, nz - 1);
      const wz = gz - z0;
      for (let col = 0; col < width; col++) {
        const gx = (col / Math.max(1, width - 1)) * (nx - 1);
        const x0 = Math.floor(gx);
        const x1 = Math.min(x0 + 1, nx - 1);
        const wx = gx - x0;
        const h = heights[z0 * nx + x0] * (1 - wx) * (1 - wz)
          + heights[z0 * nx + x1] * wx * (1 - wz)
          + heights[z1 * nx + x0] * (1 - wx) * wz
          + heights[z1 * nx + x1] * wx * wz;
        const m = toMeters(h);
        out[row * width + col] = m;
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
    }
  }
  for (let i = 0; i < field.covered.length; i++) covered += field.covered[i];

  if (lo === Infinity) { lo = minHeight; hi = minHeight; }
  return {
    heightMap: out,
    width,
    height,
    minHeight: lo,
    maxHeight: hi,
    coverage: +(covered / field.covered.length).toFixed(3),
  };
}
