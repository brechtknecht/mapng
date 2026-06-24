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
export const BAKE_FORMAT_VERSION = 12;

// Cheap order-sensitive hash of a route segment (rounded coords) — keeps the
// cache key short while still splitting different routes/widths over the same
// bounds into distinct entries.
const hashSegment = (segment) => {
  let h = 2166136261; // FNV-1a 32-bit
  for (const p of segment) {
    const s = `${p.lat.toFixed(6)},${p.lng.toFixed(6)};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
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
  return (
    `v${BAKE_FORMAT_VERSION}|${r(b.north)},${r(b.south)},${r(b.east)},${r(b.west)}` +
    `|${data.width}x${data.height}|et=${errorTarget}|sg=${stripGround}` +
    `|gd=${groundDistanceM}|sweep=${cameraSweep}|q=${quality}|px=${sensorSize}${corridor}${anchor}`
  );
};
