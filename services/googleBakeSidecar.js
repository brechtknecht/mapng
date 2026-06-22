import { deserializeGroup, persistBakeRecords } from './googleTilesPersistentCache.js';

// Browser client for the Google 3D Tiles bake sidecar (the vite dev-server
// job API in scripts/viteGoogleBakePlugin.mjs + scripts/googleBakeWorker.mjs).
//
// When the sidecar is reachable, EVERY bake routes through it regardless of
// quality tier: the worker runs the same shared-core pipeline in a Node child
// process with a multi-GB heap, so the ~4 GB renderer-process ceiling (which
// even 'standard' hits on large AOIs) stops mattering. The in-browser bake in
// google3dTiles.js remains the fallback for prod builds, where these
// endpoints don't exist.
//
// Jobs are keyed by the bake cache key and survive page reloads: re-posting
// the same key joins the running job instead of re-fetching from Google.

let _availability = null; // memoized Promise<boolean>

/**
 * Probe /api/google-bake/health once per session. In prod builds the SPA
 * fallback answers this route with index.html — the JSON guard handles that.
 */
export function sidecarAvailable() {
  _availability ??= (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch('/api/google-bake/health', { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const json = await res.json().catch(() => null);
      return json?.ok === true;
    } catch (_) {
      return false;
    }
  })();
  return _availability;
}

const toBase64 = (f32) => {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
};

// Only what the worker consumes goes over the wire — never onProgress/
// forceRebake, and osmFeatures only when the road pass will use them.
const buildJobBody = (data, options, key, force, ensureSession = false) => {
  const {
    apiKey, errorTarget, stripGround, groundNormalThreshold, groundDistanceM,
    cameraSweep, quality, sensorSize, maxWaitMs, stabilityMs,
    corridorSegment, corridorHalfWidthM, sharedGroundOffsetM,
  } = options;
  const heightMap = data.heightMap instanceof Float32Array
    ? data.heightMap
    : new Float32Array(data.heightMap);
  // Ship the ground the conform mask snaps onto: roads PLUS flat-ground area
  // polygons (parking, squares, pedestrian areas). The worker uses these ONLY
  // for the conform mask now (station selection in corridor mode comes from
  // corridorSegment, NOT OSM), so send them in EVERY mode and quality — incl.
  // corridor/route bakes, which is where the road z-fight was. Bounded to that
  // subset to keep the payload small.
  const allOsm = data.osmFeatures ?? [];
  const pickedOsm = allOsm.filter((f) => {
    if (f.type === 'road') return true;
    const t = f.tags || {};
    return t.amenity === 'parking' || t.place === 'square' || t['area:highway'] ||
      (t.area === 'yes' && ['pedestrian', 'footway', 'living_street', 'service'].includes(t.highway));
  });
  const corridor = Array.isArray(corridorSegment) && corridorSegment.length >= 2;
  console.info(
    `[roadmask] sidecar payload: osmFeatures in data=${allOsm.length}, shipped=${pickedOsm.length}, ` +
    `corridor=${corridor}, quality=${quality}`,
  );
  return {
    key,
    force,
    ensureSession,
    data: {
      bounds: data.bounds,
      width: data.width,
      height: data.height,
      minHeight: data.minHeight,
      heightMap: toBase64(heightMap),
      osmFeatures: pickedOsm.length ? pickedOsm : undefined,
    },
    options: {
      apiKey, errorTarget, stripGround, groundNormalThreshold, groundDistanceM,
      cameraSweep, quality, sensorSize, maxWaitMs, stabilityMs,
      corridorSegment, corridorHalfWidthM, sharedGroundOffsetM,
    },
  };
};

/**
 * Subscribe to a job's SSE stream until `terminal(msg)` classifies an event
 * as the end of THIS wait: return {resolve: msg} or {reject: Error} to
 * settle, undefined to keep listening. `checkAfterDrop(probe)` decides the
 * outcome when the stream drops (dev server restart, subscribed too late).
 */
const waitForJobEvent = (jobId, key, onProgress, terminal, checkAfterDrop) =>
  new Promise((resolve, reject) => {
    const es = new EventSource(`/api/google-bake/${jobId}/events`);
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      es.close();
      fn(arg);
    };
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'progress') {
        onProgress?.(msg);
        return;
      }
      if (msg.type === 'log') {
        console.debug(`[google-bake] ${msg.line}`);
        return;
      }
      const verdict = terminal(msg);
      if (verdict && 'resolve' in verdict) settle(resolve, verdict.resolve);
      else if (verdict && 'reject' in verdict) settle(reject, verdict.reject);
    };
    es.onerror = async () => {
      if (settled || es.readyState !== EventSource.CLOSED) return;
      try {
        const res = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
        const probe = res.ok ? await res.json() : null;
        if (probe?.jobId === jobId && checkAfterDrop(probe)) {
          settle(resolve, null);
          return;
        }
      } catch (_) { /* fall through */ }
      settle(reject, new Error('lost connection to the bake sidecar (dev server restarted?)'));
    };
  });

/** Wait for the base bake of a job. */
const waitForJob = (jobId, key, onProgress) => waitForJobEvent(
  jobId, key, onProgress,
  (msg) => {
    if (msg.type === 'done') return { resolve: msg };
    if (msg.type === 'error') return { reject: new Error(msg.message ?? 'bake worker failed') };
    return undefined;
  },
  (probe) => probe.status === 'done',
);

const fetchAndDecodeResult = async (jobId) => {
  const res = await fetch(`/api/google-bake/${jobId}/result`);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.detail ?? ''; } catch (_) { /* noop */ }
    throw new Error(`bake result unavailable (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }
  const buf = await res.arrayBuffer();

  const view = new DataView(buf);
  if (buf.byteLength < 8 || view.getUint32(0, true) !== 0x4d424b31) {
    throw new Error('bake result is not an MBK1 container');
  }
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
  const payload = (8 + headerLen + 3) & ~3; // payload is 4-byte aligned

  // Slice (copy) each range out of the container so the records are
  // independently structured-cloneable — IndexedDB persistence would
  // otherwise clone the WHOLE container once per mesh.
  const f32 = (ref) => new Float32Array(buf.slice(payload + ref.offset, payload + ref.offset + ref.byteLength));
  const meshes = header.meshes.map((m) => ({
    name: m.name,
    positions: f32(m.positions),
    uvs: m.uvs ? f32(m.uvs) : null,
    index: m.index
      ? new (m.index.kind === 'u32' ? Uint32Array : Uint16Array)(
        buf.slice(payload + m.index.offset, payload + m.index.offset + m.index.byteLength),
      )
      : null,
    texture: m.texture
      ? new Blob([new Uint8Array(buf, payload + m.texture.offset, m.texture.byteLength)], { type: m.texture.mimeType })
      : null,
    flipY: m.flipY,
    wrapS: m.wrapS,
    wrapT: m.wrapT,
    colorSpace: m.colorSpace,
  }));
  return { meshes, stations: header.bakeStations ?? null, stats: header.stats ?? {} };
};

const buildGroup = async (key, { meshes, stations, stats }) => {
  const group = await deserializeGroup(meshes);
  if (stations) group.userData.bakeStations = stations;
  // Surface the worker's bake telemetry for the route manifest (§6).
  group.userData.bakeStats = {
    stations: stats.stations,
    selected: stats.selected,
    kept: stats.kept,
    timedOut: stats.timedOut,
    elapsedMs: stats.elapsedMs,
  };
  console.info(
    `[google-bake] sidecar bake restored: ${meshes.length} meshes ` +
    `(${stats.selected ?? '?'} tiles selected, ${stats.kept ?? '?'} kept, ` +
    `${((stats.elapsedMs ?? 0) / 1000).toFixed(1)}s bake${stats.timedOut ? ', TIMED OUT' : ''})`,
  );
  // Persist in the background so reloads restore from IndexedDB first.
  persistBakeRecords(key, meshes, stations)
    .then((bytes) => {
      if (bytes !== null) {
        console.info(`[google-bake] sidecar bake persisted to IndexedDB (~${(bytes / 1024 ** 2).toFixed(0)} MB)`);
      }
    })
    .catch((err) => console.warn('[google-bake] persisting sidecar bake failed (quota?):', err));
  return group;
};

/**
 * Run a bake on the Node sidecar. `options` must be the RESOLVED bake options
 * (quality already defaulted) so the job joins/dedupes on the same key the
 * caches use. Returns the baked THREE.Group, already persisted to IndexedDB.
 */
export async function bakeViaSidecar(data, options, key, { force = false } = {}) {
  const body = buildJobBody(data, options, key, force);
  const res = await fetch('/api/google-bake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
    throw new Error(`bake sidecar rejected the job (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }
  const { jobId, status, joined } = await res.json();
  if (joined) console.info(`[google-bake] joined existing sidecar job ${jobId} (${status})`);

  if (status !== 'done') {
    await waitForJob(jobId, key, options.onProgress);
  }
  return buildGroup(key, await fetchAndDecodeResult(jobId));
}

/**
 * Make sure a LIVE worker session exists for this key, re-baking if needed.
 *
 * A bake restored from IndexedDB (or whose worker was reaped/restarted away)
 * has no session to refine against — the worker needs its warm tile cache and
 * selection state, which only a sweep produces. This re-runs the base bake in
 * that case (progress flows through `onProgress`, station counts > 1 reveal
 * it's the base sweep) but never downloads the result: the displayed group is
 * already identical, only the session state matters.
 */
export async function ensureSidecarSession(data, options, key, onProgress) {
  try {
    const probeRes = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
    if (probeRes.ok && (await probeRes.json()).sessionAlive) return;
  } catch (_) { /* fall through to POST */ }

  console.info('[google-bake] no live session for this bake — re-baking once to enable refinement');
  const body = buildJobBody(data, options, key, false, true);
  const res = await fetch('/api/google-bake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
    throw new Error(`bake sidecar rejected the session re-bake (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }
  const { jobId, status } = await res.json();
  if (status !== 'done') {
    await waitForJob(jobId, key, onProgress);
  }
}

/**
 * Refine an existing bake from a user camera station. Requires the job's
 * worker session to still be alive (it stays resident after the base bake,
 * holding the warm tile cache + selection state). The station is in
 * preview-friendly units — ENU metres from the AOI centre, heights in metres
 * above the .ter datum (scene-Y ÷ unitsPerMeter), plus the camera FOV — and
 * the worker converts via the bake's own vertical anchor.
 *
 * Returns the FULL updated group (decoded from the rewritten container) and
 * persists it to IndexedDB under the same key.
 *
 * @param {string} key bake cache key (same as the base bake)
 * @param {{e:number,n:number,heightM:number,lookE:number,lookN:number,lookHeightM:number,fov?:number}} station
 */
export async function bakeRefinementViaSidecar(key, station, onProgress) {
  const probeRes = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
  if (!probeRes.ok) {
    throw new Error('no bake session for this AOI — run a bake first (sessions end on dev-server restart)');
  }
  const { jobId, sessionAlive } = await probeRes.json();
  if (!sessionAlive) {
    throw new Error('the bake session has ended (dev-server restart or idle timeout) — re-bake to refine');
  }

  const res = await fetch(`/api/google-bake/${jobId}/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ station }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
    throw new Error(`refine rejected (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }
  const { revision } = await res.json();

  const refinedMsg = await waitForJobEvent(
    jobId, key, onProgress,
    (msg) => {
      if (msg.type === 'refined' && msg.revision === revision) return { resolve: msg };
      if (msg.type === 'refine-error' && msg.revision === revision) {
        return { reject: new Error(msg.message ?? 'refinement failed') };
      }
      if (msg.type === 'error' || msg.type === 'session-ended') {
        return { reject: new Error(msg.message ?? 'bake session ended during refinement') };
      }
      return undefined;
    },
    (probe) => probe.status === 'done' && probe.revision >= revision,
  );

  const group = await buildGroup(key, await fetchAndDecodeResult(jobId));
  // Where the refine landed (scene-space tile footprints + the frustum
  // parameters the worker used) — the preview overlays this so a "nothing
  // changed in front of me" report is debuggable at a glance.
  if (refinedMsg?.debug) {
    group.userData.lastRefineDebug = refinedMsg.debug;
    console.info(
      `[google-bake] refine debug: +${refinedMsg.added} tiles (${refinedMsg.debug.addedRects?.length ?? 0} rects), ` +
      `recarved=${refinedMsg.recarved}, fov=${refinedMsg.debug.fov}, aspect=${refinedMsg.debug.aspect}, ` +
      `far=${Math.round(refinedMsg.debug.far)}m, errorTarget=${refinedMsg.debug.errorTarget}`,
    );
  }
  return group;
}

/**
 * Assemble the BeamNG google_tiles export (atlas PNGs + chunked GLB) on the
 * SIDEcar — the worker holds every tile record, so the browser never builds
 * atlas canvases or a multi-GB GLB. Returns the 'exported' message:
 * { glbPath, glbBytes, textures: [{name, path, bytes}], materialNames } —
 * server-side PATHS, consumed directly by the Blender bridge and the zip
 * sidecar on the same machine.
 */
export async function exportAssemblyViaSidecar(key, spec, onProgress) {
  const probeRes = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
  if (!probeRes.ok) throw new Error('no bake session for this AOI — bake first');
  const { jobId, sessionAlive } = await probeRes.json();
  if (!sessionAlive) throw new Error('the bake session has ended — re-bake to export server-side');

  const res = await fetch(`/api/google-bake/${jobId}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spec }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
    throw new Error(`sidecar export rejected (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }
  const { revision } = await res.json();

  return waitForJobEvent(
    jobId, key, onProgress,
    (msg) => {
      if (msg.type === 'exported' && msg.revision === revision) return { resolve: msg };
      if (msg.type === 'export-error' && msg.revision === revision) {
        return { reject: new Error(msg.message ?? 'sidecar export failed') };
      }
      if (msg.type === 'error' || msg.type === 'session-ended') {
        return { reject: new Error(msg.message ?? 'bake session ended during export') };
      }
      return undefined;
    },
    () => false, // a dropped stream can't confirm export completion — retryable
  );
}

/**
 * End the LIVE worker session for a bake key, freeing its resident child
 * process. Best-effort: the baked result already lives on the sidecar's disk
 * AND in IndexedDB, so any later re-run restores it — we only drop the warm
 * in-memory session, which a batch route export never refines.
 *
 * Without this, EVERY chunk of a long route leaves a multi-GB worker resident
 * until the idle reaper fires (~15 min), so workers pile up across the run
 * until the machine swaps — the classic "the bake slows down the longer it
 * goes". Calling this as each chunk completes keeps resident workers bounded by
 * the concurrency, not by the route length.
 */
export async function endBakeSession(key, { keepFiles = false } = {}) {
  try {
    const probe = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
    if (!probe.ok) return; // no job for this key (already reaped / never baked here)
    const { jobId } = await probe.json();
    if (!jobId) return;
    // keepFiles=true frees the worker but keeps its workDir on disk — REQUIRED
    // for the BeamNG route export, whose final zip reads each chunk's server
    // files (and whose fast re-export reuses them). The Raw-GLB bake passes
    // keepFiles=false to also reclaim the disk (it keeps nothing server-side).
    await fetch(`/api/google-bake/${jobId}${keepFiles ? '?keepFiles=1' : ''}`, { method: 'DELETE' });
  } catch (_) {
    /* best-effort: the idle reaper / prune collects it eventually */
  }
}

/**
 * Purge every RETAINED bake job (worker already freed; this drops their kept
 * workDirs on disk). The route export calls this when starting a FRESH bake so
 * the PREVIOUS run's per-chunk files don't accumulate run-over-run. The current
 * run keeps all its own files (created after this call) for its final zip and
 * for fast re-export. Best-effort.
 */
export async function purgeRetainedBakes() {
  try {
    await fetch('/api/google-bake/jobs?retained=1', { method: 'DELETE' });
  } catch (_) {
    /* best-effort: the retained-jobs cap collects them eventually */
  }
}

/**
 * Restore-only probe: if the sidecar holds a FINISHED job for this key
 * (e.g. the page reloaded right after a bake, before IndexedDB persisted,
 * or the persist failed on quota), fetch and decode it. Never starts a bake,
 * never joins a running one. Returns null when there's nothing to restore.
 */
export async function restoreSidecarBake(key) {
  if (!(await sidecarAvailable())) return null;
  try {
    const res = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const { jobId, status } = await res.json();
    if (status !== 'done') return null;
    console.info(`[google-bake] restoring finished sidecar job ${jobId}`);
    return await buildGroup(key, await fetchAndDecodeResult(jobId));
  } catch (err) {
    console.warn('[google-bake] sidecar restore probe failed:', err);
    return null;
  }
}
