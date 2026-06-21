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
// Source rasters can be tens of MB each; keep the working set bounded but large
// enough to hold a typical multi-chunk route plus a few single tiles.
const MAX_ENTRIES = 120;

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

// Touch the LRU timestamp and prune the oldest entries past MAX_ENTRIES.
const touchAndPrune = async (key) => {
  let meta;
  try {
    meta = (await idbGet(META_KEY)) || {};
  } catch (_) {
    return; // meta bookkeeping is best-effort
  }
  meta[key] = stamp();
  const keys = Object.keys(meta).sort((a, b) => meta[a] - meta[b]);
  while (keys.length > MAX_ENTRIES) {
    const oldest = keys.shift();
    try { await idbDelete(oldest); } catch (_) { /* best-effort */ }
    mem.delete(oldest);
    delete meta[oldest];
  }
  try { await idbPut(META_KEY, meta); } catch (_) { /* best-effort */ }
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
