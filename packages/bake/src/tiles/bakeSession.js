/** @layer flow */
// Cached front-ends + sidecar session lifecycle for the Google tiles bake
// (refactor doc 06 step 3). In-memory single-slot cache, IndexedDB restore,
// Node-sidecar routing, refine/export/end. Moved verbatim from google3dTiles.js.
import { loadPersistedBake, persistBake, deletePersistedBake } from '@mapng/fetching';
import {
  sidecarAvailable,
  bakeViaSidecar,
  restoreSidecarBake,
  bakeRefinementViaSidecar,
  ensureSidecarSession,
  exportAssemblyViaSidecar,
  endBakeSession,
} from '../googleBakeSidecar.js';
import { bakeCacheKey } from './bakeCache.js';
import { resolveBakeOptions } from './bakeFlags.js';
import { bakeGoogle3DTiles } from './bakeGoogle3DTiles.js';

// ---------------------------------------------------------------------------
// In-memory bake cache — single entry, because a photogrammetry group holds
// hundreds of MB of canvas textures. Shared by the 3D preview and the BeamNG
// export so "preview first, then export" costs zero extra API calls.
//
// The cached group is OWNED BY THE CACHE: callers must not mutate or dispose
// it (the export path clones geometries before transforming). Deliberately
// not persisted to disk — memory cost aside, Google's Map Tiles ToS prohibits
// storing tile content.
// ---------------------------------------------------------------------------

let _bakeCache = null; // { key, promise }

const disposeGroup = (group) => {
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      m?.map?.dispose();
      m?.dispose();
    }
  });
};

/**
 * Cached front-end for bakeGoogle3DTiles(). Two layers:
 *
 * 1. In-memory (this module, single entry) — same Group for identical
 *    (bounds, resolution, bake options); concurrent calls during a bake
 *    share one in-flight promise.
 * 2. IndexedDB (googleTilesPersistentCache.js) — survives page reloads /
 *    dev-server HMR, so re-generating the same coordinates restores the
 *    bake from disk instead of re-fetching from Google.
 *
 * On cache miss the bake itself routes by environment:
 *
 * - Node sidecar (dev server, scripts/viteGoogleBakePlugin.mjs) whenever it
 *   is reachable — ALL quality tiers. The worker runs the same shared-core
 *   pipeline in a child process with a multi-GB heap, so large AOIs and
 *   heavy tiers stop dying at the browser's ~4 GB ceiling. Jobs are keyed
 *   by this cache key and survive page reloads.
 * - In-browser bake otherwise (prod builds) — today's behavior and limits.
 *
 * `onProgress` only fires when a real bake runs — cache hits resolve fast.
 * Pass `forceRebake: true` to bypass and purge both layers for this key.
 */
// The actual bake for a cache key: IndexedDB restore → Node sidecar → in-browser
// fallback. Touches NO module-global state, so it is safe to run concurrently
// for different keys (route mode bakes several chunks at once). The returned
// group is owned by the CALLER.
const runBake = async (key, data, bakeOptions, forceRebake) => {
  if (forceRebake) {
    await deletePersistedBake(key).catch(() => { /* best effort */ });
  } else {
    try {
      const t0 = performance.now();
      const restored = await loadPersistedBake(key);
      if (restored) {
        console.info(
          `[google3dTiles] restored ${restored.children.length} tile meshes from IndexedDB ` +
          `in ${((performance.now() - t0) / 1000).toFixed(1)}s — no Google refetch`,
        );
        return restored;
      }
    } catch (err) {
      console.warn('[google3dTiles] persistent cache read failed — baking fresh:', err);
    }
  }

  if (await sidecarAvailable()) {
    console.info('[google3dTiles] baking via Node sidecar');
    // The sidecar client persists the result records to IndexedDB itself.
    return bakeViaSidecar(data, bakeOptions, key, { force: forceRebake });
  }

  const group = await bakeGoogle3DTiles(data, bakeOptions);
  // Persist in the background; never block or fail the bake on it.
  persistBake(key, group)
    .then((bytes) => {
      if (bytes !== null) {
        console.info(
          `[google3dTiles] bake persisted to IndexedDB (~${(bytes / 1024 ** 2).toFixed(0)} MB) key=${key}`,
        );
      }
    })
    .catch((err) => console.warn('[google3dTiles] persisting bake failed (quota?):', err));
  return group;
};

export function getOrBakeGoogle3DTiles(data, options = {}) {
  const { forceRebake = false, memoryCache = true, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);

  // Route mode passes memoryCache:false so several chunks can bake at once: the
  // single-slot _bakeCache would otherwise have concurrent chunks evict (and
  // prematurely dispose) one another's groups. Each chunk is baked + encoded
  // once, so the in-memory layer buys nothing here — IndexedDB still makes
  // re-runs free. The group is owned by the caller (GC reclaims it; the bake
  // groups hold no GPU resources, only CPU buffers/canvas textures).
  if (!memoryCache) return runBake(key, data, bakeOptions, forceRebake);

  if (!forceRebake && _bakeCache?.key === key) {
    console.info('[google3dTiles] cache hit — reusing baked tiles');
    return _bakeCache.promise;
  }

  clearGoogleTilesCache();

  const promise = runBake(key, data, bakeOptions, forceRebake).catch((err) => {
    // Failed bakes must not poison the cache.
    if (_bakeCache?.promise === promise) _bakeCache = null;
    throw err;
  });
  _bakeCache = { key, promise };
  return promise;
}

/**
 * Restore-only probe: returns the baked Group for this AOI from the
 * in-memory or IndexedDB cache, or null — never fetches from Google.
 * Used by the 3D preview on page load so an already-baked AOI reappears
 * without clicking "Load".
 */
export async function restoreBakedGoogle3DTiles(data, options = {}) {
  const { forceRebake: _ignored, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  if (_bakeCache?.key === key) return _bakeCache.promise;

  let group = null;
  try {
    group = await loadPersistedBake(key);
  } catch (err) {
    console.warn('[google3dTiles] persistent cache probe failed:', err);
    return null;
  }
  if (!group) {
    // The sidecar may still hold a finished job for this key (page reloaded
    // before the IndexedDB persist landed, or the persist failed on quota).
    // Restore-only: never starts or joins a bake.
    group = await restoreSidecarBake(key);
  }
  if (!group) {
    console.info(`[google3dTiles] no persisted bake for key ${key}`);
    return null;
  }
  // A bake may have started for the same key while we were decoding —
  // defer to it rather than overwriting (its group would get disposed).
  if (_bakeCache?.key === key) return _bakeCache.promise;

  clearGoogleTilesCache();
  _bakeCache = { key, promise: Promise.resolve(group) };
  console.info(
    `[google3dTiles] restored ${group.children.length} tile meshes from IndexedDB — no Google refetch`,
  );
  return group;
}

/**
 * Refine the current bake from a user camera station (fly mode in the 3D
 * preview). Requires a live sidecar bake session for this AOI/options key —
 * the worker sweeps the station with its warm cache, merges via
 * finest-covering and rewrites the result; we decode the full update here.
 *
 * Returns the NEW group and installs it as the in-memory cache entry. The
 * caller owns the swap in the UI and must dispose the previous group
 * afterwards via disposeBakeGroup() — disposing here would yank textures out
 * from under the still-rendering preview.
 */
export async function refineGoogleTilesBake(data, options, station) {
  const { forceRebake: _ignored, onProgress, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  // A bake restored from cache has no live worker session (dev-server
  // restart, idle reap) — transparently re-bake once to rebuild it. The
  // result content is identical, so only the session state is fetched.
  await ensureSidecarSession(data, bakeOptions, key, onProgress);
  const group = await bakeRefinementViaSidecar(key, station, onProgress);
  _bakeCache = { key, promise: Promise.resolve(group) };
  return group;
}

/**
 * Assemble the BeamNG google_tiles export server-side (atlas + GLB in the
 * bake worker — see exportAssemblyViaSidecar). Resolves the same cache key
 * as the preview, rebuilding the worker session first if it died, so the
 * export always assembles exactly the bake (incl. refinements) on screen.
 *
 * @param {object} spec { worldSize, zOffsetM }
 * @returns {{glbPath, glbBytes, textures, materialNames, meshes}}
 */
export async function exportGoogleTilesViaSidecar(data, options, spec) {
  const { forceRebake: _ignored, onProgress, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  await ensureSidecarSession(data, bakeOptions, key, onProgress);
  return exportAssemblyViaSidecar(key, spec, onProgress);
}

/**
 * End the resident sidecar bake session for THIS data+options, freeing its
 * worker process. Recomputes the exact cache key the bake used (same
 * resolveBakeOptions → bakeCacheKey path), so the caller passes the same
 * `data` and bake options it baked with. No-op (harmless) if the key doesn't
 * match a live session. Route exports call this per chunk so resident workers
 * stay bounded by concurrency instead of growing with route length — see
 * endBakeSession() for the why.
 */
export async function endGoogleTilesSession(data, options = {}, { keepFiles = false } = {}) {
  const key = bakeCacheKey(data, resolveBakeOptions(options));
  await endBakeSession(key, { keepFiles });
}

/** Dispose a bake group's geometries, materials and textures (see refineGoogleTilesBake). */
export function disposeBakeGroup(group) {
  if (group) disposeGroup(group);
}

/** Dispose the cached bake (geometries, materials, canvas textures), if any. */
export function clearGoogleTilesCache() {
  if (!_bakeCache) return;
  const evicted = _bakeCache;
  _bakeCache = null;
  // Dispose once the bake settles — it may still be in flight.
  evicted.promise.then(disposeGroup).catch(() => { /* already logged */ });
}
