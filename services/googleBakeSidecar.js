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
const buildJobBody = (data, options, key, force) => {
  const {
    apiKey, errorTarget, stripGround, groundNormalThreshold, groundDistanceM,
    cameraSweep, quality, sensorSize, maxWaitMs, stabilityMs,
  } = options;
  const heightMap = data.heightMap instanceof Float32Array
    ? data.heightMap
    : new Float32Array(data.heightMap);
  return {
    key,
    force,
    data: {
      bounds: data.bounds,
      width: data.width,
      height: data.height,
      minHeight: data.minHeight,
      heightMap: toBase64(heightMap),
      osmFeatures: quality === 'roads'
        ? (data.osmFeatures ?? []).filter((f) => f.type === 'road')
        : undefined,
    },
    options: {
      apiKey, errorTarget, stripGround, groundNormalThreshold, groundDistanceM,
      cameraSweep, quality, sensorSize, maxWaitMs, stabilityMs,
    },
  };
};

/** Subscribe to a job's SSE stream until it reports done or error. */
const waitForJob = (jobId, key, onProgress) => new Promise((resolve, reject) => {
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
    } else if (msg.type === 'log') {
      console.debug(`[google-bake] ${msg.line}`);
    } else if (msg.type === 'done') {
      settle(resolve, msg);
    } else if (msg.type === 'error') {
      settle(reject, new Error(msg.message ?? 'bake worker failed'));
    }
  };
  // The stream ends without a done/error message if we subscribed after the
  // job finished mid-replay, or the dev server restarted — check the job's
  // terminal status before declaring the connection lost.
  es.onerror = async () => {
    if (settled || es.readyState !== EventSource.CLOSED) return;
    try {
      const res = await fetch(`/api/google-bake/jobs?key=${encodeURIComponent(key)}`);
      const json = res.ok ? await res.json() : null;
      if (json?.jobId === jobId && json.status === 'done') {
        settle(resolve, { type: 'done' });
        return;
      }
    } catch (_) { /* fall through */ }
    settle(reject, new Error('lost connection to the bake sidecar (dev server restarted?)'));
  };
});

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
