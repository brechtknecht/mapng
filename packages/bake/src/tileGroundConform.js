// S2 — Delta-field conform: seat the Google tile mesh onto the mapng .ter floor.
//
// The single-point vertical anchor (probeGroundAltitude → groundOffset) lifts
// Google's ground onto the DEM at ONE reference point. Everywhere else the
// residual `aboveTerrain = Y − terrain(x,z)` drifts — Google's photogrammetric
// ground shape ≠ the DEM shape, plus a slowly varying ellipsoid↔geoid datum
// term. A global z-offset slider cannot fix a spatially varying residual.
//
// This pass measures that residual where Google actually HAS ground (the same
// near-flat, near-terrain tris stripGroundTris removes), builds a smooth field
// D(x,z) from it, and subtracts D from EVERY vertex. Ground verts land on the
// floor (residual → 0); a building's verts all shift by the same local D, so the
// building keeps its height ABOVE the now-corrected ground — structure preserved,
// no flattening.
//
// Runs as a soup pass AFTER weldSeams (consistent ground) and BEFORE
// stripGroundTris (needs the ground tris present to measure D). Pure / DOM-free;
// the browser bake and headless worker call the identical function. Mirrors the
// weldSeams return shape so the orchestrators write positions back the same way.

import { sampleHeightAtScene, computeUnitsPerMeter, SCENE_SIZE } from './googleBakeCore.js';
import { createScalarFieldGrid } from './scalarFieldGrid.js';
import { rasterizeStructureStiffness } from './deform/structureStiffness.js';

/**
 * @param {Array<{positions:ArrayLike<number>, index:ArrayLike<number>}>} meshes
 *   positions are [sceneX, metersY, sceneZ]; metersY is above the .ter datum.
 * @param {object} data  mapng terrain (heightMap, width, height, minHeight, bounds).
 * @param {object} [opts]
 * @param {number} [opts.cellM=6]              delta-field cell size (metres).
 *   Smaller = follows local ground better (measured: monotonic residual drop down
 *   to ~4 m on dense AOIs); 6 keeps enough samples/cell on sparse/rural AOIs.
 * @param {number} [opts.groundDistanceM=2.5]  tri counts as ground if its mean
 *   aboveTerrain is within ±this of the terrain (a BAND, not just an upper bound
 *   — subterranean horizontal geometry must be excluded or it poisons the field).
 *   This is also the correction CEILING: a residual larger than this isn't
 *   recognised as ground and won't be corrected. The single-point anchor already
 *   nulls the bulk offset at the AOI centre, so the residual across one bake AOI
 *   stays within this band in practice; widen it only if a bake floats by more.
 * @param {number} [opts.groundNormalThreshold=0.85] and is this near-horizontal.
 * @param {number} [opts.maxShiftM=15]         clamp on |D| so a bad cell can't
 *   teleport geometry; the real datum residual is well under this.
 * @param {number} [opts.smoothPasses=0]       delta-field blur passes. Default 0:
 *   field.sample already bilinearly interpolates between cell centres, so the
 *   applied shift is continuous WITHOUT blur. Extra passes measurably worsen the
 *   residual — they smear a cell's correction across real ground discontinuities
 *   (curbs, embankment edges, terrace steps), pushing already-accurate spots off.
 * @param {object} [opts.groundMask=null]      optional semantic road-coverage mask
 *   (groundMask.js: { sample(x,z)→w∈[0,1] }). Where w>0 AND the vertex is
 *   near-horizontal, its height is blended toward the DEM directly (full-res, NO
 *   ±groundDistanceM ceiling) — this is what flattens photogrammetry road wiggle
 *   and pulls down floaters the delta field's band leaves behind. w feathers the
 *   snap into the delta-field result at road edges so the mesh does not tear.
 * @param {number} [opts.roadEpsM=0.02]        metres above the DEM a fully-masked
 *   (w=1) vertex is seated, matching the road-surface offset / z-fight bias.
 * @param {number} [opts.maxSnapM=5]           snap CEILING: a masked vertex more
 *   than this far off the DEM is NOT snapped. A real road floats a few metres at
 *   most; a vertex tens of metres up is a flat roof / overpass / tree merely
 *   overlapping a road pixel, and snapping it would tear a thin vertical spike.
 *   Tapered (not a hard cliff — see snapTaperM) so a vertex just over the ceiling
 *   doesn't spike against an in-ceiling neighbour.
 * @param {number} [opts.snapTaperM=1.5]       width (metres) over which the snap
 *   weight fades to 0 as a vertex's float approaches maxSnapM. Removes the hard
 *   on/off boundary that left a vertex at 5.1 m unsnapped beside a 4.9 m neighbour.
 * @param {number} [opts.wallNormalY=0.34]     WALL-protection threshold, SEPARATE
 *   from groundNormalThreshold. A vertex is excluded from the snap only when it is
 *   shared with a genuinely STEEP face (|ny|/|n| < this ≈ tilt > ~70°: a facade or
 *   curb riser). Using the 0.85 ground threshold here instead flagged every gentle
 *   road micro-relief tri (crown, manholes, paint, debris) as "wall", so on a
 *   DENSE mesh scattered road verts were left unsnapped among snapped neighbours —
 *   the interleaving that corrugated/tore the road. Genuine walls/curbs are still
 *   protected; only the spurious mid-tilt exclusions are dropped.
 * @param {number} [opts.wallMinSpanM=1.5]     a steep face counts as a WALL only
 *   when its own vertical extent reaches this (metres). Road-noise micro-facets
 *   are steep but span centimetres — without this gate they flagged the bumps'
 *   own verts as walls, exempting the road's bumps from the snap.
 * @param {Uint8Array|null} [opts.floorCoveredMask=null]  per-cell trust mask for
 *   the floor, on the SAME grid as data.heightMap (1 = the floor at this cell was
 *   genuinely derived from the tiles). Where any bilinear neighbour is 0 the snap
 *   is skipped entirely: there the floor is a fallback (DEM) that never saw the
 *   road — snapping to it drags underpasses UP and viaducts DOWN by metres.
 * @param {boolean} [opts.measureOnly=false]  build the delta field + its bend
 *   diagnostics from Pass 1 and return WITHOUT touching any vertex (positions are
 *   all null, Pass-2 stats are 0). This is the debug/overlay path: the preview
 *   uses it to visualise WHAT the conform would do without allocating per-mesh
 *   position copies.
 * @param {boolean} [opts.glitchSnap=true]  road-prior glitch override. The
 *   snap guards (maxSnapM ceiling, wall flags) exist to protect legitimate
 *   geometry that overhangs a road — but they also protect photogrammetry
 *   GLITCHES, which float far above the ceiling and bristle with steep
 *   pseudo-facades (measured live: 8–30 m spikes sitting on carriageways,
 *   immune to every guard). The discriminator is the pre-inpaint delta-field
 *   coverage: a legit overhang has the road surface UNDER it, so its cell has
 *   in-band ground samples (filled=1); a glitch REPLACED the road, so its
 *   column has no ground-level surface at all (filled=0). Inside the core
 *   carriageway (m ≥ 0.9, floor trusted, no structure veto) an unfilled cell
 *   means the OSM road network is the stronger prior: pull the geometry onto
 *   the floor regardless of float height or wall flags. false disables (A/B).
 * @param {Array<{ring,holes}>|null} [opts.structures=null]  OSM structure
 *   footprints in scene coords (deform/structureStiffness.collectStructureRings).
 *   When given, a per-cell stiffness raster gates the field build (see
 *   scalarFieldGrid.build): inside a footprint the field is forced locally
 *   constant, so the structure translates onto the corrected floor RIGIDLY
 *   instead of being bent by the field's cell-to-cell wobble. Additionally the
 *   road snap is attenuated by (1−stiffness) at each vertex — a facade over a
 *   road pixel is never pulled to road height, semantically this time (the
 *   heuristic wall gate stays as a fallback for unmapped structures). The
 *   conform itself stays agnostic of WHAT a structure is — OSM semantics decide
 *   upstream, precisely so unmapped photogrammetry (street trees!) is not
 *   falsely rigidified.
 * @returns {{ positions:Array<Float32Array|null>, vertsMoved:number,
 *   meshesMoved:number, cellsFilled:number, residualBefore:number,
 *   residualAfter:number, fieldValues:Float32Array, fieldN:number,
 *   fieldFilled:Uint8Array, fieldGrad:Float32Array, fieldGradP50M:number,
 *   fieldGradP95M:number, fieldGradMaxM:number }}
 *   positions[i] is a NEW array when mesh i moved, else null (caller keeps its own).
 *   fieldGrad is the per-cell BEND intensity of D — max |ΔD| to the 4-neighbours
 *   in metres per cell step — with p50/p95/max taken over MEASURED cells only.
 *   A rigid structure spanning k cells is bent by ~k× the local fieldGrad, so
 *   these numbers quantify how much the smooth field distorts buildings.
 */
export const conformTilesToFloor = (meshes, data, {
  cellM = 6,
  groundDistanceM = 2.5,
  groundNormalThreshold = 0.85,
  maxShiftM = 15,
  smoothPasses = 0,
  groundMask = null,
  roadEpsM = 0.02,
  maxSnapM = 5,
  snapTaperM = 1.5,
  wallNormalY = 0.34,
  wallMinSpanM = 1.5,
  floorCoveredMask = null,
  measureOnly = false,
  structures = null,
  diagnostics = false,
  glitchSnap = true,
  // Corridor authority (metres, null = legacy gates). When set, every masked
  // vertex that sits LOWER than this above the floor is road surface and is
  // seated on the floor at full mask weight — no snap ceiling, no taper, no
  // wall/riser exemption. Photogrammetry noise, seam skirts, curb blobs and
  // parked cars below the clearance become the road; anything higher (trees,
  // decks, facades) is a real object above it and keeps its height above the
  // conformed ground. The semantic structure veto and the floor-trust gate
  // still apply: OSM knows buildings, and an uncovered DEM-fallback floor
  // never saw the road. This is what guarantees the drive surface (.ter) and
  // the visible road coincide inside the corridor.
  corridorClearanceM = null,
} = {}) => {
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  const upm = computeUnitsPerMeter(data); // metres-Y → scene units, to metricise normals
  const grid = createScalarFieldGrid({ cellM, unitsPerMeter: upm });

  // aboveTerrain for a vertex, in metres. terrain(x,z) is stored absolute, so
  // (sample − minH) puts it in the same above-datum frame as Y.
  const aboveTerrain = (x, y, z) => y - (sampleHeightAtScene(data, x, z) - minH);

  // --- Pass 1: collect ground-vertex residuals into the field ----------------
  // residualBefore/After are reported as MEAN ABSOLUTE residual (not signed) so
  // they're comparable: a signed mean cancels on real data and hides the spread.
  // For the mask snap we need a per-vertex "near-horizontal" flag that IGNORES
  // the band — a road floating beyond groundDistanceM is exactly the floater we
  // want to snap, yet its tris never enter the delta field. Marked here, used in
  // Pass 2. (Null/skipped entirely when no mask, keeping the fast path intact.)
  // Per-vertex WALL flag for the snap (mask only): set when a vertex is touched by
  // a genuinely STEEP face (wallNormalY ≈ tilt > 70°: a facade or curb riser).
  // Pass 2 snaps EVERY masked vertex EXCEPT these onto the DEM — we trust the
  // (smooth) road mask to define what's road, NOT the local tri orientation.
  // Re-gating by local flatness (the old `horizCand`) left the photogrammetry
  // bumps — which are by definition NOT horizontal — unsnapped, so the road stayed
  // bumpy even though the DEM is smooth. Snapping by mask membership flattens them;
  // only true walls/curb risers are protected so the snap can't pull a facade
  // vertex off its wall.
  const nonHorizFlags = groundMask
    ? meshes.map((m) => (m.positions ? new Uint8Array(m.positions.length / 3) : null))
    : null;

  let groundSamples = 0;
  let residualAbsSum = 0;
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const p = m.positions, idx = m.index;
    if (!p || !idx) continue;
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const x0 = p[i0 * 3], y0 = p[i0 * 3 + 1], z0 = p[i0 * 3 + 2];
      const x1 = p[i1 * 3], y1 = p[i1 * 3 + 1], z1 = p[i1 * 3 + 2];
      const x2 = p[i2 * 3], y2 = p[i2 * 3 + 1], z2 = p[i2 * 3 + 2];

      const a0 = aboveTerrain(x0, y0, z0);
      const a1 = aboveTerrain(x1, y1, z1);
      const a2 = aboveTerrain(x2, y2, z2);
      const inBand = Math.abs((a0 + a1 + a2) / 3) < groundDistanceM;
      // Fast path with no mask: band-rejected tris skip the normal entirely. With
      // a mask we still need the normal — a floating road tri is out of band but
      // IS a snap candidate.
      if (!groundMask && !inBand) continue;

      // near-horizontal? (normal computed in a metrically uniform space)
      const ay = y0 * upm, by = y1 * upm, cy = y2 * upm;
      const e1x = x1 - x0, e1y = by - ay, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = cy - ay, e2z = z2 - z0;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const ncos = nlen > 1e-12 ? Math.abs(ny) / nlen : 0; // 1 = flat, 0 = vertical
      const isHoriz = ncos > groundNormalThreshold;
      // STEEP face = an actual wall. Two conditions, both required:
      //  - steeper than wallNormalY (~70°) — NOT the loose ground threshold (see
      //    the param doc: gentle mid-tilt road relief must keep snapping);
      //  - vertical extent ≥ wallMinSpanM. A noisy photogrammetry road is FULL of
      //    steep micro-facets (a 30 cm bump over a 15 cm run is already 63°) —
      //    without the span gate those facets flagged the bumps' own verts as
      //    "wall", excluding from the snap exactly the verts that make the road
      //    bumpy (measured: ~half of all carriageway verts). A real facade spans
      //    metres; a bump facet spans centimetres — the span separates them.
      const ySpanM = Math.max(y0, y1, y2) - Math.min(y0, y1, y2);
      const isWall = nlen > 1e-12 && ncos < wallNormalY && ySpanM >= wallMinSpanM;

      // Snap gate (mask only): mark every vertex touched by a genuinely STEEP face
      // (wall / curb riser) so Pass 2 protects it. Everything else inside the mask
      // is snapped — the mask defines road, not the local normal. Band-independent.
      if (groundMask && isWall) {
        const nh = nonHorizFlags[mi];
        if (nh) { nh[i0] = 1; nh[i1] = 1; nh[i2] = 1; }
      }

      // Delta-field gate: ground sits in a BAND around the terrain —
      // |residual| < groundDistanceM, not just below the ceiling. Without the
      // lower bound, subterranean horizontal geometry (underpasses, courtyards,
      // canal/garage floors, photogrammetry junk far under the DEM) reads as
      // "ground" with a large NEGATIVE residual and drags the whole field down.
      // (stripGroundTris only needs the upper bound; a delta field needs both.)
      if (!inBand || !isHoriz) continue;

      // It's ground: each vertex's residual is a sample of D at its XZ.
      grid.add(x0, z0, a0);
      grid.add(x1, z1, a1);
      grid.add(x2, z2, a2);
      groundSamples += 3;
      residualAbsSum += Math.abs(a0) + Math.abs(a1) + Math.abs(a2);
    }
  }

  // Semantic structure stiffness — rasterised onto THIS grid's resolution so the
  // solve and the raster can't drift apart. Null (legacy behaviour) without
  // structures.
  const stiffness = structures && structures.length
    ? rasterizeStructureStiffness(structures, { n: grid.cellsPerSide, unitsPerMeter: upm })
    : null;

  const field = grid.build({ smoothPasses, fallback: 0, stiffness });

  // Bilinear stiffness read for the per-vertex snap veto (same cell-centre
  // mapping as field.sample).
  const stiffnessAt = stiffness ? (x, z) => {
    const sn = grid.cellsPerSide;
    const gx = ((x + SCENE_SIZE / 2) / SCENE_SIZE) * sn - 0.5;
    const gz = ((z + SCENE_SIZE / 2) / SCENE_SIZE) * sn - 0.5;
    const x0 = Math.min(sn - 1, Math.max(0, Math.floor(gx)));
    const z0 = Math.min(sn - 1, Math.max(0, Math.floor(gz)));
    const x1 = Math.min(sn - 1, x0 + 1);
    const z1 = Math.min(sn - 1, z0 + 1);
    const tx = Math.min(1, Math.max(0, gx - x0));
    const tz = Math.min(1, Math.max(0, gz - z0));
    return (
      stiffness[z0 * sn + x0] * (1 - tx) * (1 - tz) +
      stiffness[z0 * sn + x1] * tx * (1 - tz) +
      stiffness[z1 * sn + x0] * (1 - tx) * tz +
      stiffness[z1 * sn + x1] * tx * tz
    );
  } : null;

  // --- Field bend diagnostics (always on — grid-sized, cheap) ----------------
  // Per-cell bend intensity of D: max |ΔD| to the 4-neighbours, in metres per
  // cell step. The delta pass subtracts D per VERTEX, so wherever D varies, a
  // rigid structure spanning those cells gets BENT by that variation — a roof
  // across k cells picks up ~k × the local value. Percentiles are taken over
  // MEASURED cells only: inpainted cells (building interiors, water) are smooth
  // by construction and would dilute the wobble the measured medians carry.
  const fN = field.cellsPerSide;
  const fV = field.values;
  const fieldGrad = new Float32Array(fN * fN);
  const measuredGrads = [];
  for (let cz = 0; cz < fN; cz++) {
    for (let cx = 0; cx < fN; cx++) {
      const ci = cz * fN + cx;
      const v = fV[ci];
      let g = 0;
      if (cx > 0) { const dd = Math.abs(v - fV[ci - 1]); if (dd > g) g = dd; }
      if (cx + 1 < fN) { const dd = Math.abs(v - fV[ci + 1]); if (dd > g) g = dd; }
      if (cz > 0) { const dd = Math.abs(v - fV[ci - fN]); if (dd > g) g = dd; }
      if (cz + 1 < fN) { const dd = Math.abs(v - fV[ci + fN]); if (dd > g) g = dd; }
      fieldGrad[ci] = g;
      if (field.filled[ci]) measuredGrads.push(g);
    }
  }
  measuredGrads.sort((a, b) => a - b);
  const gradQ = (q) => (measuredGrads.length
    ? measuredGrads[Math.min(measuredGrads.length - 1, Math.floor(q * measuredGrads.length))]
    : 0);
  const fieldGradP50M = gradQ(0.5);
  const fieldGradP95M = gradQ(0.95);
  const fieldGradMaxM = measuredGrads.length ? measuredGrads[measuredGrads.length - 1] : 0;

  if (measureOnly) {
    return {
      positions: meshes.map(() => null),
      vertsMoved: 0, meshesMoved: 0, vertsSnapped: 0, maxFloatFixedM: 0,
      glitchVertsFlattened: 0, glitchMaxFloatM: 0,
      roadVertsCore: 0, roadDevMeanM: 0, roadDevMaxM: 0,
      roadWallExcluded: 0, roadGateExcluded: 0, roadOverheadCount: 0,
      cellsFilled: field.filledCount,
      residualBefore: groundSamples ? residualAbsSum / groundSamples : 0,
      residualAfter: 0, // Pass 2 did not run — measure-only
      fieldValues: field.values, fieldN: fN, fieldFilled: field.filled,
      fieldGrad, fieldGradP50M, fieldGradP95M, fieldGradMaxM,
      structureCount: structures?.length ?? 0, structSnapVetoed: 0,
      diag: null,
    };
  }

  // Optional per-cell diagnostics (opt-in — normal bakes don't pay for it). Lets
  // the test lab show WHERE the residual stays / grows and whether that
  // correlates with cells that had no real ground samples (inpaint-guessed D).
  const nCells = field.cellsPerSide * field.cellsPerSide;
  const diag = diagnostics ? {
    coverage: field.filled,                  // 1 = had real ground samples
    afterAbsSum: new Float64Array(nCells),   // Σ|after residual| of ground verts
    beforeAbsSum: new Float64Array(nCells),  // Σ|before residual| of ground verts
    count: new Float64Array(nCells),         // ground verts per cell
    worsened: 0, improved: 0,                // ground verts whose |residual| grew / shrank
  } : null;

  // --- Pass 2: delta-field shift, then mask snap -----------------------------
  // Every vertex slides by D(x,z) — the smooth datum/ground correction. Where the
  // mask says a near-horizontal vertex is road (w>0), blend the result toward the
  // DEM directly: w=1 seats it on the floor (no ±band ceiling → floaters come
  // down, wiggle flattens), w feathers to 0 across the road edge so adjacent
  // off-road verts stay put and the mesh does not tear.
  // Floor-trust lookup (same scene→pixel mapping as sampleHeightAtScene, all four
  // bilinear neighbours must be covered). 1 when no mask was provided.
  const floorTrusted = (x, z) => {
    if (!floorCoveredMask) return 1;
    const half = SCENE_SIZE / 2;
    const u = Math.max(0, Math.min(1, (x + half) / SCENE_SIZE));
    const v = Math.max(0, Math.min(1, (z + half) / SCENE_SIZE));
    const lx = u * (data.width - 1);
    const lz = v * (data.height - 1);
    const x0 = Math.floor(lx), x1 = Math.min(x0 + 1, data.width - 1);
    const z0 = Math.floor(lz), z1 = Math.min(z0 + 1, data.height - 1);
    const cm = floorCoveredMask, w = data.width;
    return (cm[z0 * w + x0] && cm[z0 * w + x1] && cm[z1 * w + x0] && cm[z1 * w + x1]) ? 1 : 0;
  };

  let vertsMoved = 0, meshesMoved = 0, vertsSnapped = 0, maxFloatFixedM = 0;
  let structSnapVetoed = 0, glitchVertsFlattened = 0, glitchMaxFloatM = 0;
  const HALF_SCENE = SCENE_SIZE / 2;
  let postResidualSum = 0, postResidualCount = 0;
  // Core-carriageway flatness audit (mask w ≥ 0.9): how far the FINAL surface
  // deviates from the floor over the road proper — including the verts the snap
  // deliberately skipped (wall-shared, over-ceiling), because those are what the
  // eye still sees as bumps on the road. Answers "is the visible road flat now".
  let roadVertsCore = 0, roadDevSum = 0, roadDevMax = 0, roadWallExcluded = 0, roadGateExcluded = 0, roadOverheadCount = 0;
  const positions = meshes.map((m, mi) => {
    const p = m.positions;
    if (!p) return null;
    const nh = nonHorizFlags ? nonHorizFlags[mi] : null;
    const out = new Float32Array(p.length);
    out.set(p);
    let moved = false;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], z = p[i + 2];
      let d = field.sample(x, z);
      if (d > maxShiftM) d = maxShiftM; else if (d < -maxShiftM) d = -maxShiftM;
      const terr = sampleHeightAtScene(data, x, z) - minH;
      let newY = p[i + 1] - d;

      const vi = i / 3;
      // Snap every MASKED vertex that is NOT a wall/curb-riser vertex (nh) and sits
      // within maxSnapM of the DEM (so a roof/overpass merely overlapping a road
      // pixel is left alone). The mask weight w restricts this to the road footprint.
      if (groundMask && nh) {
        const trusted = floorTrusted(x, z);
        let m = trusted ? groundMask.sample(x, z) : 0;
        // Semantic snap veto: under a structure footprint the road mask must not
        // pull geometry to road height (facades/roofs overlapping road pixels).
        // Attenuated, not binary, so the footprint feather and the mask feather
        // blend instead of tearing. Zeroed m also drops the vertex from the
        // carriageway flatness audit — it is structure, not road surface.
        if (stiffnessAt && m > 0) {
          const sV = stiffnessAt(x, z);
          if (sV > 0) {
            m *= Math.max(0, 1 - sV);
            if (sV >= 0.5) structSnapVetoed++;
          }
        }
        const floatBefore = Math.abs(p[i + 1] - terr);
        // Road-prior glitch override (see opts.glitchSnap): inside the CORE
        // carriageway, a column whose delta-field cell never saw a ground-level
        // surface (pre-inpaint filled=0) cannot be an overhang — there is no
        // road under it to overhang. Whatever occupies it REPLACED the road: a
        // photogrammetry glitch. The road network outranks the geometry here —
        // the ceiling and wall guards that would protect an overhang are the
        // very guards that were pinning the glitch in place.
        const glitch = glitchSnap && m >= 0.9
          && x >= -HALF_SCENE && x <= HALF_SCENE && z >= -HALF_SCENE && z <= HALF_SCENE
          && !field.filled[field.cellIndex(x, z)];
        // Corridor authority: below the clearance the vertex IS road surface —
        // signed, so sunken geometry counts too — and no other gate applies.
        const authority = corridorClearanceM != null && (p[i + 1] - terr) < corridorClearanceM;
        // Legacy: tapered ceiling instead of a hard cutoff — full snap up to
        // (maxSnapM − snapTaperM), fading to 0 at maxSnapM.
        const snapGate = (glitch || authority) ? 1
          : floatBefore <= maxSnapM - snapTaperM
            ? 1
            : floatBefore >= maxSnapM
              ? 0
              : (maxSnapM - floatBefore) / snapTaperM;
        if (glitch || authority || !nh[vi]) {
          const w = m * snapGate;
          if (w > 0) {
            const ySnap = terr + roadEpsM;
            newY = newY * (1 - w) + ySnap * w;
            if (w > 0.5) {
              vertsSnapped++;
              // float the smooth field could NOT correct (beyond its band) but the
              // snap did — the headline number for the floater fix.
              if (floatBefore >= groundDistanceM && floatBefore > maxFloatFixedM) {
                maxFloatFixedM = floatBefore;
              }
              if (glitch && floatBefore >= maxSnapM) {
                glitchVertsFlattened++;
                if (floatBefore > glitchMaxFloatM) glitchMaxFloatM = floatBefore;
              }
            }
          }
        }
        // Flatness audit over the road proper (metrics only, no movement).
        // Restricted to SURFACE verts (float < maxSnapM): trees/facade overhangs
        // whose XZ lands on a road pixel would otherwise dominate the mean with
        // multi-metre "deviations" that are not road surface at all.
        if (m >= 0.9) {
          if (floatBefore < (corridorClearanceM ?? maxSnapM) || glitch) {
            // Flattened glitches are road surface now — audit them as such.
            roadVertsCore++;
            const dev = Math.abs(newY - (terr + roadEpsM));
            roadDevSum += dev;
            if (dev > roadDevMax) roadDevMax = dev;
            if (!glitch && !authority && nh[vi]) roadWallExcluded++;
            else if (snapGate <= 0) roadGateExcluded++;
          } else {
            roadOverheadCount++;
          }
        }
      }

      if (newY !== p[i + 1]) {
        out[i + 1] = newY;
        moved = true;
        vertsMoved++;
      }

      // residual of conformed ground (for the verification log line) — measured
      // over the SAME band that defined ground, so deep-below verts don't inflate it.
      const before = p[i + 1] - terr;
      if (Math.abs(before) < groundDistanceM) {
        const after = newY - terr;
        postResidualSum += Math.abs(after);
        postResidualCount++;
        if (diag) {
          const c = field.cellIndex(x, z);
          diag.afterAbsSum[c] += Math.abs(after);
          diag.beforeAbsSum[c] += Math.abs(before);
          diag.count[c] += 1;
          if (Math.abs(after) > Math.abs(before) + 1e-6) diag.worsened++;
          else if (Math.abs(after) < Math.abs(before) - 1e-6) diag.improved++;
        }
      }
    }
    if (moved) { meshesMoved++; return out; }
    return null;
  });

  return {
    positions,
    vertsMoved,
    meshesMoved,
    vertsSnapped,
    maxFloatFixedM,
    // Road-prior glitch override: verts beyond the snap ceiling flattened
    // because their column had no ground-level surface (glitchSnap).
    glitchVertsFlattened,
    glitchMaxFloatM,
    // Carriageway flatness audit (mask w ≥ 0.9, float < maxSnapM): FINAL
    // |y − (floor+eps)| over the road surface incl. deliberately-unsnapped verts.
    roadVertsCore,
    roadDevMeanM: roadVertsCore ? roadDevSum / roadVertsCore : 0,
    roadDevMaxM: roadDevMax,
    roadWallExcluded,
    roadGateExcluded,
    roadOverheadCount,
    cellsFilled: field.filledCount,
    residualBefore: groundSamples ? residualAbsSum / groundSamples : 0,
    residualAfter: postResidualCount ? postResidualSum / postResidualCount : 0,
    // The built delta field, for inspection/visualisation (e.g. the test lab
    // heatmap / preview overlay). Read-only — callers must not mutate.
    fieldValues: field.values,
    fieldN: field.cellsPerSide,
    fieldFilled: field.filled,
    fieldGrad, fieldGradP50M, fieldGradP95M, fieldGradMaxM,
    // Structure stiffness (semantic building protection): footprints received,
    // and road-snap attempts attenuated to ≤half weight under one.
    structureCount: structures?.length ?? 0,
    structSnapVetoed,
    diag,
  };
};
