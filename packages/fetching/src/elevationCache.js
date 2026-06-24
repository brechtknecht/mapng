// IndexedDB persistence for fetched elevation data, so re-exporting the same
// tile or route (or reloading the dev server — Vite HMR resets the whole app)
// doesn't re-download the same DEM bytes over the network.
//
// Two record shapes share one store, distinguished by key prefix:
//   - source rasters  ("gpxz|…", "usgs|…"): the raw GeoTIFF ArrayBuffers for a
//     given fetch bounds, plus any per-source flags needed to reconstruct the
//     fetch result without touching the network.
//   - global tiles    ("terr|z|x|y"): a single Terrarium elevation PNG blob,
//     immutable and shared across any overlapping bounds.
//
// Keys are derived purely from the inputs that determine the bytes (bounds,
// source, api-key identity, tile coords), so identical inputs hit the cache and
// anything that changes the request misses it. A '__meta__' record holds
// key → timestamp for LRU pruning (so we never read every payload just to sort).

const DB_NAME = 'mapng-elevation';
const STORE = 'elev';
const META_KEY = '__meta__';
// The store holds two very different payload classes, so they get independent
// LRU budgets (a single shared cap would let a route's hundreds of small tiles
// evict the multi-MB rasters — or evict earlier tiles of the same route
// mid-fetch — defeating the cache):
//   - source rasters ("gpxz|…", "usgs|…"): tens of MB each → keep the working
//     set tight.
//   - global tiles ("terr|…", "sat|…"): ~20–40 KB JPEG/PNG each → a route can
//     touch hundreds, so allow a much larger count for a few MB total.
const MAX_RASTER_ENTRIES = 120;
const MAX_TILE_ENTRIES = 6000;
const isTileKey = (key) => key.startsWith('terr|') || key.startsWith('sat|');

const hasIdb = () => typeof indexedDB !== 'undefined';

// In-memory mirror so repeated lookups within one session skip IndexedDB too.
const mem = new Map();

const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) {
      req.result.createObjectStore(STORE);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const reqAsPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const idbGet = async (key) => {
  const db = await openDb();
  try {
    return await reqAsPromise(db.transaction(STORE).objectStore(STORE).get(key));
  } finally { db.close(); }
};

const idbPut = async (key, value) => {
  const db = await openDb();
  try {
    return await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key));
  } finally { db.close(); }
};

const idbDelete = async (key) => {
  const db = await openDb();
  try {
    return await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
  } finally { db.close(); }
};

// Stable, collision-resistant-enough short hash so the API key never lands in a
// key or on disk in the clear (and to keep keys short).
const shortHash = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// Quantise bounds to ~1e-6 deg (~0.1 m) so float formatting noise can't split
// what is logically the same fetch across two cache entries.
const boundsKey = (b) =>
  [b.north, b.south, b.east, b.west].map((v) => Number(v).toFixed(6)).join(',');

export const gpxzCacheKey = (bounds, apiKey) =>
  `gpxz|${shortHash(apiKey || '')}|${boundsKey(bounds)}`;

export const usgsCacheKey = (bounds) => `usgs|${boundsKey(bounds)}`;

export const terrainTileCacheKey = (z, x, y) => `terr|${z}|${x}|${y}`;

// ArcGIS World Imagery satellite tiles are effectively immutable per z/x/y, so
// the same tile is reused across overlapping route chunks (corridor chunks
// overlap by ~220 m) and across reloads — the same logic as Terrarium tiles.
export const satelliteTileCacheKey = (z, x, y) => `sat|${z}|${x}|${y}`;

// The LRU index, cached in memory. Previously every tile write re-read the
// whole META_KEY object, sorted ALL its keys, and rewrote it to IndexedDB —
// so per-write cost grew with cache size (thousands of sat tiles on a long
// route), making the cache itself slow down as it filled. Now: the index lives
// in memory, the expensive sort runs ONLY when a bucket is actually over cap,
// and the rewrite to disk is debounced.
let _meta = null;          // module cache of the LRU index { key: stamp }
let _metaDirty = false;    // unflushed in-memory changes
let _metaFlushTimer = null;
const META_FLUSH_MS = 3000;

const loadMeta = async () => {
  if (_meta) return _meta;
  try { _meta = (await idbGet(META_KEY)) || {}; }
  catch (_) { _meta = {}; }
  return _meta;
};

const flushMeta = () => {
  _metaFlushTimer = null;
  if (!_metaDirty || !_meta) return;
  _metaDirty = false;
  idbPut(META_KEY, _meta).catch(() => { /* best-effort */ });
};

const scheduleMetaFlush = () => {
  if (_metaFlushTimer || !_metaDirty) return;
  _metaFlushTimer = setTimeout(flushMeta, META_FLUSH_MS);
  _metaFlushTimer?.unref?.(); // no-op in the browser
};

// Touch the LRU timestamp and, only when a payload class is over its cap,
// evict its oldest entries.
const touchAndPrune = async (key) => {
  const meta = await loadMeta();
  meta[key] = stamp();
  _metaDirty = true;

  // O(n) integer count — no allocation, no sort — to decide whether a bucket
  // even needs eviction. The sort (O(n log n)) only runs on an actual overflow.
  let tileCount = 0;
  let rasterCount = 0;
  for (const k in meta) {
    if (isTileKey(k)) tileCount++; else rasterCount++;
  }
  if (tileCount > MAX_TILE_ENTRIES) await evictBucket(meta, true, MAX_TILE_ENTRIES);
  if (rasterCount > MAX_RASTER_ENTRIES) await evictBucket(meta, false, MAX_RASTER_ENTRIES);

  scheduleMetaFlush();
};

const evictBucket = async (meta, tiles, cap) => {
  const keys = Object.keys(meta)
    .filter((k) => isTileKey(k) === tiles)
    .sort((a, b) => meta[a] - meta[b]);
  while (keys.length > cap) {
    const oldest = keys.shift();
    try { await idbDelete(oldest); } catch (_) { /* best-effort */ }
    mem.delete(oldest);
    delete meta[oldest];
  }
};

// Date.now is fine in the browser; only the workflow runtime forbids it. A
// monotonic-ish counter fallback keeps LRU ordering sane if it's ever absent.
let _counter = 0;
const stamp = () => {
  try { return Date.now(); } catch (_) { return ++_counter; }
};

/**
 * Look up a cached record by key. Returns the stored value (the same object
 * passed to putElevationCache) or null on a miss / when IndexedDB is absent.
 */
export async function getElevationCache(key) {
  if (mem.has(key)) return mem.get(key);
  if (!hasIdb()) return null;
  try {
    const record = await idbGet(key);
    if (record == null) return null;
    mem.set(key, record);
    // Touch LRU without blocking the caller.
    touchAndPrune(key);
    return record;
  } catch (e) {
    console.warn('[elevationCache] read failed:', e);
    return null;
  }
}

/**
 * Store a record under key. Value must be structured-cloneable (ArrayBuffers,
 * Blobs, typed arrays, plain objects). Best-effort: a failure to persist never
 * breaks the fetch path.
 */
export async function putElevationCache(key, value) {
  mem.set(key, value);
  if (!hasIdb()) return;
  try {
    await idbPut(key, value);
    await touchAndPrune(key);
  } catch (e) {
    // QuotaExceededError is the common one — drop from memory mirror too so we
    // don't pretend it's persisted, but keep going.
    console.warn('[elevationCache] write failed:', e);
  }
}

/** Wipe the whole elevation cache (debug / "force refetch"). */
export async function clearElevationCache() {
  mem.clear();
  // Drop the in-memory LRU index too, and cancel any pending flush, so it
  // doesn't rewrite a stale index over the just-cleared store.
  _meta = {};
  _metaDirty = false;
  if (_metaFlushTimer) { clearTimeout(_metaFlushTimer); _metaFlushTimer = null; }
  if (!hasIdb()) return;
  try {
    const db = await openDb();
    try {
      await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
    } finally { db.close(); }
  } catch (e) {
    console.warn('[elevationCache] clear failed:', e);
  }
}
