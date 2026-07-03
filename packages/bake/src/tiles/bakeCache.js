/** @layer core */
// Pure bake cache-key derivation (refactor doc 06 step 3). No DOM/network —
// just the format version + deterministic key/hash, moved verbatim from
// google3dTiles.js so the preview, the Node sidecar and the in-browser
// fallback all resolve the same key.

// Bump when the bake output format/semantics change — persisted bakes from
// older versions are then simply never matched (and age out via LRU prune).
// This MUST be bumped on any change to the conform / weld / strip geometry
// passes (services/tileGroundConform.js et al.), or stale cached/session bakes
// from the previous behaviour get silently reused.
// v5: cross-tile seam-riser strip (removes the LOD-transition tile-edge walls).
// v6: delta-field tile→floor conform (tileGroundConform) — symmetric ground
//     band + no field smoothing. Invalidates early buggy-conform bakes that
//     could lift tiles several metres (unbounded ground detection).
// v7: route mode conforms each chunk against its slice of the COMBINED terrain
//     (the driven surface) instead of its own DEM — fixes chunks floating at
//     seams where per-chunk DEMs disagree. Geometry depends on combined now.
// v13: road-mask snap (tileGroundConform) decouples wall protection from the
//      ground threshold (steep-face-only) + tapers the maxSnapM ceiling.
// v14: road-mask snap now snaps EVERY masked vertex onto the DEM except true
//      walls (dropped the near-horizontal candidate gate that left the road's
//      photogrammetry bumps unsnapped) — flattens the road surface to the DEM.
// v15: ALL geometry post-passes disabled by default (weld/conform/road-mask/
//      ground-strip) — output is now raw transformed tiles while the
//      post-processing strategy is reworked. Passes remain opt-in (flags/options).
// v16: semantic structure stiffness in the conform (deform/structureStiffness):
//      OSM building footprints freeze the delta field locally constant (rigid
//      re-seat — roofs stay planar) and veto the road snap underneath; sidecar
//      now ships building/man_made footprints. Conformed bakes change geometry.
export const BAKE_FORMAT_VERSION = 16;

// FNV-1a 32-bit over a string — the cache key's compact fingerprint primitive.
const fnv1a = (s, h = 2166136261) => {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
};

// Cheap order-sensitive hash of a route segment (rounded coords) — keeps the
// cache key short while still splitting different routes/widths over the same
// bounds into distinct entries.
const hashSegment = (segment) => {
  let h = 2166136261;
  for (const p of segment) h = fnv1a(`${p.lat.toFixed(6)},${p.lng.toFixed(6)};`, h);
  return (h >>> 0).toString(36);
};

export const bakeCacheKey = (
  data,
  {
    errorTarget = 5,
    stripGround = true,
    groundDistanceM = 2.5,
    cameraSweep = true,
    quality = 'standard',
    sensorSize = quality === 'standard' ? 1024 : 1536,
    corridorSegment = null,
    corridorHalfWidthM = 0,
    sharedGroundOffsetM = null,
    // Per-bake assembly-pass overrides (sandbox / debug). Left undefined in
    // production, so the key below is byte-for-byte unchanged there.
    weld,
    conform,
    roadmask,
    stiffness,
    // Route .ter mode: when the worker snaps road verts onto the EXTRACTED tile
    // ground (applyTerGroundSnap), the baked geometry depends on the whole ground
    // strategy — so it must key apart. Undefined/off leaves the key unchanged.
    extractGround,
    groundStrategy,
  } = {},
) => {
  const b = data.bounds;
  // Round to ~1 cm so float formatting noise between sessions can't split
  // identical coordinates into different cache keys.
  const r = (x) => Number(x).toFixed(7);
  // Corridor bakes follow the route, not the box — a different station set and
  // result than a full-box bake of the same bounds, so they MUST key apart (and
  // re-bake when the route or half-width changes). Empty for the area path, so
  // its key is byte-for-byte unchanged.
  const corridor = Array.isArray(corridorSegment) && corridorSegment.length >= 2
    ? `|corr=${corridorHalfWidthM}:${corridorSegment.length}:${hashSegment(corridorSegment)}`
    : '';
  // The route-wide vertical anchor changes the baked Y of every vertex, so a
  // chunk baked with one MUST key apart from its per-chunk (natural) bake.
  // Empty for the area/single-tile path, so its key is byte-for-byte unchanged.
  const anchor = Number.isFinite(sharedGroundOffsetM)
    ? `|gz=${Number(sharedGroundOffsetM).toFixed(2)}`
    : '';
  // Only an explicitly-disabled pass appends to the key — undefined (production)
  // leaves the key unchanged, so existing caches/sessions still match.
  const passes =
    (weld === false ? '|nw' : '') +
    (conform === false ? '|nc' : '') +
    (roadmask === false ? '|nr' : '') +
    (stiffness === false ? '|ns' : '');
  // Ter-ground snap fingerprint — only when the snap will actually run, so all
  // pre-existing keys (no extraction, or snap disabled) stay byte-for-byte.
  // The literal carries the snap-algo revision: bump it (tsnap3 → tsnap4 …) when
  // conformTilesToFloor's snap behaviour changes, so only snapped bakes re-bake
  // (a full BAKE_FORMAT_VERSION bump would trash every unsnapped bake too).
  // tsnap2: wall protection gated on triangle Y-span (road micro-facets snap).
  // tsnap3: snap gated on the extraction coveredMask (no snap onto DEM-fallback
  //         floor: underpasses/viaducts) + 2 m ceiling for the tile floor.
  // tsnap4: road profiles sample the RAW per-cell min (filters fill underpass
  //         dips inside covered cells) — carve output changes for same strategy.
  // tsnap5: profile robustness — cross-road median taps, sliding-median outlier
  //         rejection, physical grade clamp (bridge-abutment junk bent profiles).
  // tsnap6: carve feather aligned to the snap-mask feather (3m) — floor and tile
  //         mesh now transition together at street edges (no bent lips).
  // tsnap7: samples under a bridge footprint are demoted (raw min reads the DECK
  //         there) — the underpass bottom is interpolated between the ramps.
  // tsnap8: bridge profiles stitched between abutment anchors + deck snap (the
  //         deck mesh follows the stitched line via a transient deck floor).
  // tsnap9: semantic structure stiffness (deform/structureStiffness) in BOTH
  //         terSnap conforms — OSM footprints freeze the delta field per
  //         structure (rigid re-seat, planar roofs) and veto the road snap
  //         underneath. Disable via stiffness=false / MAPNG_CONFORM_STIFFNESS=0.
  const terSnap = extractGround && (groundStrategy?.snapRoads ?? true)
    ? `|tsnap9=${(fnv1a(JSON.stringify(groundStrategy ?? {})) >>> 0).toString(36)}`
    : '';
  return (
    `v${BAKE_FORMAT_VERSION}|${r(b.north)},${r(b.south)},${r(b.east)},${r(b.west)}` +
    `|${data.width}x${data.height}|et=${errorTarget}|sg=${stripGround}` +
    `|gd=${groundDistanceM}|sweep=${cameraSweep}|q=${quality}|px=${sensorSize}${corridor}${anchor}${passes}${terSnap}`
  );
};
