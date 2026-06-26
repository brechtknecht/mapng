// Quality Sandbox helpers — pure logic for the /quality-sandbox A/B lab.
//
// Builds terrain for a small AOI, bakes Google Photorealistic 3D Tiles with
// per-variant option overrides, and derives PATH-INDEPENDENT LOD quality metrics
// straight off the baked THREE.Group. Reading triangle/vertex/texture counts from
// the finished group means we never touch (and can't perturb) the bake pipeline
// to measure it — the sandbox stays fully additive.
//
// The levers exposed map to the verified research (see memory
// google-tiles-quality-findings): errorTarget + sensorSize are the pure-DATA LOD
// levers; the quality tier changes camera distance / station count (the biggest
// real factor). Tone mapping is a RENDER-side lever handled per-cell.
import { fetchTerrainData } from '@mapng/terrain/terrain';
import { getOrBakeGoogle3DTiles, computeUnitsPerMeter } from '@mapng/bake/google3dTiles';
import { getTilesApiKey } from '@mapng/pipelines/credentials';

// Curated dense test spots — a fixed location bakes the SAME tile every run, so
// A/B comparisons are honest across sessions. lat/lng are editable in the UI.
export const PRESETS = [
  { id: 'berlin', label: 'Berlin · Olympischer Platz', lat: 52.5145, lng: 13.2395 },
  { id: 'nyc', label: 'New York · Midtown', lat: 40.7580, lng: -73.9855 },
  { id: 'sf', label: 'San Francisco · Downtown', lat: 37.7937, lng: -122.3965 },
  { id: 'paris', label: 'Paris · Eiffel Tower', lat: 48.8584, lng: 2.2945 },
  { id: 'tokyo', label: 'Tokyo · Shibuya', lat: 35.6595, lng: 139.7005 },
  { id: 'london', label: 'London · The City', lat: 51.5128, lng: -0.0918 },
  { id: 'sydney', label: 'Sydney · Opera House', lat: -33.8568, lng: 151.2153 },
];

// Tile edge length in metres (= terrain px at 1 m/px). Smaller = faster bake.
export const TILE_SIZES = [256, 512, 768];

export const QUALITY_TIERS = ['standard', 'high', 'roads', 'max'];
export const SENSOR_SIZES = [1024, 1536, 2048];

let _vid = 0;

/** A comparison variant: a label + bake option overrides + live bake state. */
export function mkVariant(label, options = {}) {
  return {
    id: `v${++_vid}`,
    label,
    options: {
      quality: 'standard',
      errorTarget: 5,
      sensorSize: 1024,
      cameraSweep: true,
      // Ground strip: true = .ter is the drivable surface (Google = buildings).
      // false = keep Google's ground. Default false (raw) while post-processing
      // is disabled.
      stripGround: false,
      // Assembly passes — all DEFAULT OFF now (production ships raw tiles while the
      // post-processing strategy is reworked). Toggle on to experiment with a pass.
      weld: false,
      conform: false,
      roadmask: false,
      ...options,
    },
    status: 'idle', // idle | baking | done | error
    progress: '',
    error: '',
    stats: null,
    bakeMs: null,
    bakeNonce: 0, // parent bumps this (staggered) to trigger a (re)bake in the cell
  };
}

// Seed comparison set as a CONTROLLED experiment that brackets the LOD range, so
// the side-by-side answers "do the knobs work, and where's Google's ceiling?":
//   • Coarse (errorTarget 24) is the CONTROL — if it shows fewer tiles/tris than
//     baseline, the knobs demonstrably change the output; if it matches baseline,
//     the options aren't being applied (a real bug).
//   • Baseline = current production.
//   • Fine pushes errorTarget down + sensor up — if it equals baseline, we're at
//     Google's LOD ceiling for this AOI (finer settings have nothing to fetch).
//   • Max = closest cameras (street-level stations) — the real lever for facades.
// Compare the `stations`/`selected` stats, not just the picture: equal SELECTED
// tile counts across very different settings = ceiling reached.
export function defaultVariants() {
  // Post-processing is disabled (raw tiles), so the interesting axis is back to
  // RAW TILE QUALITY: errorTarget / sensorSize / quality tier (camera distance).
  // All cells are raw (no weld/conform/roadmask/strip) — the production output now.
  return [
    mkVariant('Standard · err5', {}),
    mkVariant('Fine · err2 · sensor2048', { errorTarget: 2, sensorSize: 2048 }),
    mkVariant('High · closer cameras', { quality: 'high', sensorSize: 1536 }),
    mkVariant('Max · closest cameras', { quality: 'max', errorTarget: 3, sensorSize: 1536 }),
  ];
}

/**
 * Bake one variant for an AOI. Returns { group, terrain }. The group's Y is
 * pre-scaled to scene units (computeUnitsPerMeter) so proportions match the real
 * preview, and X/Z already span the fixed [-50, 50] AOI box — so every cell's
 * group lines up under one shared camera pose with no per-cell framing.
 *
 * stripGround:false — the sandbox compares the FULL tile (ground + buildings),
 * not the driving surface. memoryCache:false — each variant owns its group so the
 * single-slot bake cache can't evict a sibling. includeOSM:true — the road/max
 * tiers place street-level cameras off the OSM network, so they need it.
 */
export async function bakeVariant(aoi, options, { onProgress, forceRebake = false, signal } = {}) {
  const apiKey = getTilesApiKey();
  if (!apiKey) throw new Error('VITE_GOOGLE_MAPS_API_KEY is not set — cannot fetch Google tiles.');

  onProgress?.('fetching terrain + OSM…');
  const terrain = await fetchTerrainData(
    { lat: aoi.lat, lng: aoi.lng },
    aoi.sizeM,
    true, // includeOSM (road/max tiers need it)
    false, false, false, '', undefined,
    undefined, signal,
  );

  onProgress?.('baking tiles…');
  const group = await getOrBakeGoogle3DTiles(terrain, {
    apiKey,
    memoryCache: false,
    forceRebake,
    onProgress: (p) =>
      onProgress?.(`station ${p.station ?? 1}/${p.stations ?? 1} · ${p.visible ?? 0} tiles`),
    ...options, // includes stripGround + weld/conform/roadmask
  });

  group.scale.y = computeUnitsPerMeter(terrain) || 1; // metres → scene units
  group.updateMatrixWorld(true);
  return { group, terrain };
}

/**
 * Path-independent LOD quality proxies read straight off the baked group.
 * Triangle/vertex counts + texture megapixels rise together with LOD depth (in
 * Google's tiles mesh and texture share a tile), so this quantifies "are we
 * getting finer data" without needing the bake's internal geometricError.
 */
export function computeGroupStats(group) {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  let textures = 0;
  let texPixels = 0;
  let maxTexDim = 0;
  const seenTex = new Set();

  group.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    meshes++;
    const g = node.geometry;
    const posCount = g.attributes.position?.count ?? 0;
    triangles += g.index ? g.index.count / 3 : posCount / 3;
    vertices += posCount;

    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of mats) {
      const tex = m?.map || m?.emissiveMap;
      const img = tex?.image;
      if (!img || seenTex.has(tex)) continue;
      seenTex.add(tex);
      const w = img.width || img.naturalWidth || 0;
      const h = img.height || img.naturalHeight || 0;
      if (w && h) {
        textures++;
        texPixels += w * h;
        maxTexDim = Math.max(maxTexDim, w, h);
      }
    }
  });

  // The worker's own sweep telemetry (set by the sidecar/in-browser bake on the
  // group). stations + selected are the DECISIVE bug-vs-ceiling discriminator:
  // if quality:high reports stations≈25 but `selected` matches standard's, the
  // options ARE applied and we've hit Google's ceiling. (May be null on a bake
  // restored from IndexedDB, which doesn't persist these.)
  const bs = group.userData?.bakeStats ?? {};

  return {
    meshes,
    triangles: Math.round(triangles),
    vertices,
    textures,
    texMegapixels: +(texPixels / 1e6).toFixed(1),
    maxTexDim,
    stations: bs.stations ?? null,
    selected: bs.selected ?? null,
    kept: bs.kept ?? null,
  };
}

/** Dispose a baked group's geometries, materials and textures. */
export function disposeGroup(group) {
  if (!group) return;
  group.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry?.dispose();
    const mats = Array.isArray(node.material) ? node.material : [node.material];
    for (const m of mats) {
      m?.map?.dispose();
      m?.emissiveMap?.dispose();
      m?.dispose();
    }
  });
}

/** Compact number formatting for the stat strip (1.2k, 3.4M). */
export function fmt(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
