// Shared ground-extraction substrate for the terrain sandbox.
//
// Turns the baked Google tiles (a DSM — surface incl. buildings/trees) into a
// regular height raster, then lets pluggable filters distil a DTM (bare-earth
// drivable ground) from it. Every filter consumes the SAME HeightField and
// returns a flat Float32Array of node heights — so approaches stay independent
// and directly comparable side by side.
//
// UNITS: every height in the field (and every filter output) is in SCENE UNITS
// (tilesGroup already carries scale.y = unitsPerMeter), so meshes built from
// them need NO further y-scale.
import * as THREE from 'three';
import { sampleHeightAtScene } from '@mapng/bake/google3dTiles';

// Bake scene plane: X/Z span [-SCENE_SIZE/2, +SCENE_SIZE/2] (see sceneFrame.js).
export const SCENE_SIZE = 100;

/**
 * @typedef {Object} HeightField
 * @property {number} nx               node columns (segX + 1)
 * @property {number} nz               node rows (segZ + 1)
 * @property {number} segX             quad columns
 * @property {number} segZ             quad rows
 * @property {number} unitsPerMeter    scene units per metre
 * @property {number} cellSizeM        node spacing in metres (for window sizing)
 * @property {Float32Array} minH       dense per-cell MIN of the rasterised tile surface (DSM bottom), scene units (Infinity if no tile covers the cell)
 * @property {Float32Array} loH        confident-street subset: minH where it sits in the DEM band, else Infinity
 * @property {Uint8Array}   covered    1 where any tile triangle rasterised onto the node
 * @property {Float32Array} demH       DEM surface per node, scene units
 * @property {Float32Array} seed       ready-to-filter base: the dense min surface where covered (incl. building bumps for the filters to strip), else demH
 */

/** Flat node index. */
export const nodeIndex = (field, xi, zi) => zi * field.nx + xi;

/**
 * Build the height raster from the baked tiles in a single O(vertices) pass.
 *
 * @param {THREE.Group} tilesGroup   baked + y-scaled tiles (world Y = scene units)
 * @param {object} terrain           TerrainData (heightMap, width, height, minHeight)
 * @param {number} unitsPerMeter     computeUnitsPerMeter(terrain)
 * @param {object} [opts]
 * @param {number} [opts.maxSeg]     grid resolution cap (default 192)
 * @returns {HeightField}
 */
export function buildTileHeightField(tilesGroup, terrain, unitsPerMeter, { maxSeg = 192, belowBandM = 3, aboveBandM = 5 } = {}) {
  const half = SCENE_SIZE / 2;
  const segX = Math.max(1, Math.min((terrain.width || 256) - 1, maxSeg));
  const segZ = Math.max(1, Math.min((terrain.height || 256) - 1, maxSeg));
  const nx = segX + 1;
  const nz = segZ + 1;
  const n = nx * nz;
  const minHeight = terrain.minHeight ?? 0;

  // 1. DEM surface per node (scene units). Computed FIRST because it gates the
  //    tile-vertex aggregation below.
  const demH = new Float32Array(n);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const sceneX = (xi / (nx - 1)) * SCENE_SIZE - half;
      const sceneZ = (zi / (nz - 1)) * SCENE_SIZE - half;
      demH[zi * nx + xi] = (sampleHeightAtScene(terrain, sceneX, sceneZ) - minHeight) * unitsPerMeter;
    }
  }

  const belowBandU = belowBandM * unitsPerMeter;
  const aboveBandU = aboveBandM * unitsPerMeter;

  // 2. RASTERISE EVERY triangle into a dense per-cell MIN height (the DSM bottom).
  //
  // Sampling vertices is wrong for the .ter: flat roads/plazas mesh into sparse
  // vertices, so vertex binning covered only ~5 % of cells. And band-gating the
  // triangles against the coarse 30 m DEM rejected the big flat road triangles
  // (one corner drifts out of band), giving ~18 %. So we rasterise the SURFACE of
  // ALL triangles and keep the per-cell MINIMUM — the lowest surface seen from
  // above. That's the road wherever a road triangle covers the cell, and a
  // building roof/underside only where a building is the sole cover. Buildings
  // are NOT gated out here — the bare-earth FILTERS (PMF/CSF) strip those bumps
  // from the data itself, with no reliance on the DEM datum.
  const ground = new Float32Array(n).fill(Infinity);
  tilesGroup.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();

  let tris = 0;
  tilesGroup.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos = node.geometry.attributes.position;
    const index = node.geometry.index;
    const mat = node.matrixWorld;
    const triCount = index ? index.count / 3 : pos.count / 3;

    for (let t = 0; t < triCount; t++) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.set(pos.getX(i0), pos.getY(i0), pos.getZ(i0)).applyMatrix4(mat);
      b.set(pos.getX(i1), pos.getY(i1), pos.getZ(i1)).applyMatrix4(mat);
      c.set(pos.getX(i2), pos.getY(i2), pos.getZ(i2)).applyMatrix4(mat);

      // Grid coordinates (node units): x,z ∈ [-half,half] → [0,segX]/[0,segZ].
      const Ax = (a.x + half) / SCENE_SIZE * segX, Az = (a.z + half) / SCENE_SIZE * segZ;
      const Bx = (b.x + half) / SCENE_SIZE * segX, Bz = (b.z + half) / SCENE_SIZE * segZ;
      const Cx = (c.x + half) / SCENE_SIZE * segX, Cz = (c.z + half) / SCENE_SIZE * segZ;

      let minx = Math.floor(Math.min(Ax, Bx, Cx)); if (minx < 0) minx = 0;
      let maxx = Math.ceil(Math.max(Ax, Bx, Cx)); if (maxx > segX) maxx = segX;
      let minz = Math.floor(Math.min(Az, Bz, Cz)); if (minz < 0) minz = 0;
      let maxz = Math.ceil(Math.max(Az, Bz, Cz)); if (maxz > segZ) maxz = segZ;
      if (minx > maxx || minz > maxz) continue; // fully outside the AOI footprint

      const denom = (Bz - Cz) * (Ax - Cx) + (Cx - Bx) * (Az - Cz);
      if (Math.abs(denom) < 1e-9) continue; // degenerate / vertical sliver
      const invDen = 1 / denom;
      tris++;

      for (let zi = minz; zi <= maxz; zi++) {
        for (let xi = minx; xi <= maxx; xi++) {
          const wa = ((Bz - Cz) * (xi - Cx) + (Cx - Bx) * (zi - Cz)) * invDen;
          const wb = ((Cz - Az) * (xi - Cx) + (Ax - Cx) * (zi - Cz)) * invDen;
          const wc = 1 - wa - wb;
          if (wa < -1e-4 || wb < -1e-4 || wc < -1e-4) continue; // cell centre outside tri
          const y = wa * a.y + wb * b.y + wc * c.y;
          const idx = zi * nx + xi;
          if (y < ground[idx]) ground[idx] = y; // min projection from above
        }
      }
    }
  });

  // 3. Aggregate. ground[] = dense DSM-bottom: road where road covers the cell,
  //    building bump where only a building does. seed = that (the FILTERS strip
  //    the bumps). loH keeps the confident-street subset (min in the DEM band)
  //    for the DEM-anchored pane.
  const minH = new Float32Array(n);
  const loH = new Float32Array(n);
  const covered = new Uint8Array(n);
  const seed = new Float32Array(n);
  let coveredCount = 0, streetCount = 0;
  for (let idx = 0; idx < n; idx++) {
    const g = ground[idx];
    if (Number.isFinite(g)) {
      covered[idx] = 1; coveredCount++;
      minH[idx] = g; seed[idx] = g;
      const off = g - demH[idx];
      if (off >= -belowBandU && off <= aboveBandU) { loH[idx] = g; streetCount++; }
      else loH[idx] = Infinity;
    } else {
      minH[idx] = Infinity; loH[idx] = Infinity;
      seed[idx] = demH[idx]; // tiles don't cover this cell → DEM
    }
  }

  console.info('[terrain-sandbox] ground raster:',
    `${tris} tris → ${coveredCount}/${n} cells covered (${(100 * coveredCount / n).toFixed(0)}%); ` +
    `${(100 * streetCount / n).toFixed(0)}% of cells sit in the DEM street band.`);

  const realWidthM = SCENE_SIZE / unitsPerMeter;
  const cellSizeM = realWidthM / segX;

  return { nx, nz, segX, segZ, unitsPerMeter, cellSizeM, minH, loH, covered, demH, seed };
}

/**
 * Build a THREE.Mesh from a filtered height array (scene units). Grid geometry
 * matches the field exactly, so every approach registers with the tiles.
 *
 * @param {HeightField} field
 * @param {Float32Array} heights   length nx*nz, scene units
 * @param {object} [opts]
 * @param {THREE.Texture|null} [opts.texture]
 * @param {number} [opts.color]    flat color when untextured
 * @returns {THREE.Mesh}
 */
export function buildMeshFromHeights(field, heights, { texture = null, color = 0x4fd1c5 } = {}) {
  const { nx, nz, segX, segZ } = field;
  const half = SCENE_SIZE / 2;
  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);

  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      const idx = zi * nx + xi;
      const u = xi / (nx - 1);
      const w = zi / (nz - 1);
      positions[idx * 3] = u * SCENE_SIZE - half;
      positions[idx * 3 + 1] = heights[idx];
      positions[idx * 3 + 2] = w * SCENE_SIZE - half;
      uvs[idx * 2] = u;
      uvs[idx * 2 + 1] = 1 - w;
    }
  }

  const indices = [];
  for (let zi = 0; zi < segZ; zi++) {
    for (let xi = 0; xi < segX; xi++) {
      const a = zi * nx + xi;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    map: texture || null,
    color: texture ? 0xffffff : color,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geom, material);
}

/**
 * 2D median filter — the salt-and-pepper despiker. Removes thin up/down needles
 * (single-cell stalagmites/stalactites) while preserving the street level, since
 * the median of a mostly-street neighbourhood IS the street. Index-clamped at
 * borders. True (non-separable) median over a (2r+1)² window; keep r small.
 *
 * @param {Float32Array} src
 * @param {number} nx @param {number} nz
 * @param {number} [radius]  window half-width in nodes (default 1 → 3×3)
 * @param {number} [passes]  repeat count (default 1)
 * @returns {Float32Array} new array (src untouched)
 */
export function medianFilter(src, nx, nz, radius = 1, passes = 1) {
  let cur = Float32Array.from(src);
  if (passes <= 0 || radius <= 0) return cur;
  const clamp = (i, n) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);
  const win = [];
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(cur.length);
    for (let zi = 0; zi < nz; zi++) {
      for (let xi = 0; xi < nx; xi++) {
        win.length = 0;
        for (let dz = -radius; dz <= radius; dz++) {
          const zz = clamp(zi + dz, nz) * nx;
          for (let dx = -radius; dx <= radius; dx++) {
            win.push(cur[zz + clamp(xi + dx, nx)]);
          }
        }
        win.sort((a, b) => a - b);
        out[zi * nx + xi] = win[win.length >> 1];
      }
    }
    cur = out;
  }
  return cur;
}

const clampIdx = (i, n) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

// Separable square morphological op (min = erosion, max = dilation) → O(n·w).
function morph(src, nx, nz, w, take) {
  const seed = take === Math.min ? Infinity : -Infinity;
  const tmp = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    const row = zi * nx;
    for (let xi = 0; xi < nx; xi++) {
      let m = seed;
      for (let dx = -w; dx <= w; dx++) m = take(m, src[row + clampIdx(xi + dx, nx)]);
      tmp[row + xi] = m;
    }
  }
  const out = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      let m = seed;
      for (let dz = -w; dz <= w; dz++) m = take(m, tmp[clampIdx(zi + dz, nz) * nx + xi]);
      out[zi * nx + xi] = m;
    }
  }
  return out;
}

/**
 * Grayscale morphological CLOSING (dilate then erode) over a square window of
 * half-width `w` nodes. Fills DOWNWARD spikes/pits — the "pillars that stab into
 * the floor" — narrower than the window, while leaving the street level and
 * wider low areas intact. The down-spike counterpart to opening. `w=0` is a
 * no-op. Returns a new array (src untouched).
 */
export function morphClose(src, nx, nz, w) {
  if (w <= 0) return Float32Array.from(src);
  return morph(morph(src, nx, nz, w, Math.max), nx, nz, w, Math.min);
}

/**
 * Grayscale morphological OPENING (erode then dilate) — removes UPWARD objects
 * narrower than the window. Exposed for reuse; PMF rolls its own progressive,
 * thresholded variant.
 */
export function morphOpen(src, nx, nz, w) {
  if (w <= 0) return Float32Array.from(src);
  return morph(morph(src, nx, nz, w, Math.min), nx, nz, w, Math.max);
}

/** Window half-width in nodes for a feature size given in metres. */
export function windowNodes(field, sizeM) {
  return Math.max(0, Math.round(sizeM / field.cellSizeM / 2));
}

/**
 * Mean signed offset of a height array vs the DEM, in metres (+ above DEM).
 * The DEM is anchored to the tile street at the AOI centre, so for the raw/min
 * pane this reads ≈ how far the tile street sits above/below the DEM on average
 * — a quick objective check that a pane tracks the street rather than guessing
 * by eye.
 */
export function meanOffsetVsDem(field, heights) {
  let sum = 0;
  for (let i = 0; i < heights.length; i++) sum += heights[i] - field.demH[i];
  return +(sum / heights.length / field.unitsPerMeter).toFixed(1);
}

/** Peak-to-trough relief of a height array, in metres. */
export function reliefMeters(field, heights) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return +(((hi - lo) / field.unitsPerMeter)).toFixed(1);
}
