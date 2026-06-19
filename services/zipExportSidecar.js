// Browser client for the BeamNG ZIP-export sidecar (the vite dev-server job API
// in scripts/viteZipExportPlugin.mjs).
//
// The in-browser export builds the whole level into a JSZip object; compressing
// it with pako (zip.generateAsync) allocates the compressed output on top of
// the already-held archive and hangs the renderer on large maps. When the
// sidecar is reachable we stream each entry out to Node instead: every file is
// POSTed one at a time and freed from the JSZip object as it goes, Node DEFLATEs
// it straight to a temp file, and the result is downloaded GET → disk so the
// renderer never holds the compressed archive.
//
// In prod builds (Cloudflare) these endpoints don't exist — the SPA fallback
// answers /health with index.html, the JSON guard catches it, and the caller
// falls back to the in-browser zip.generateAsync path.

let _availability = null; // memoized Promise<boolean>

/**
 * Probe /api/zip-export/health once per session. In prod builds the SPA
 * fallback answers this route with index.html — the JSON guard handles that.
 */
export function zipSidecarAvailable() {
  _availability ??= (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 2000);
      const res = await fetch('/api/zip-export/health', { signal: ctl.signal });
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

const postJson = async (path, init) => {
  const res = await fetch(path, init);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
    throw new Error(`zip sidecar ${path} failed (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
  }
  return res.json();
};

const MB = (n) => (n / 1024 ** 2).toFixed(0);

/**
 * Marker for an archive entry that already lives on the dev server's disk
 * (bake-sidecar exports): { fromPath, size } — see compressZipViaSidecar.
 * Exported so the prod JSZip fallback can detect and reject it cleanly.
 */
export const isServerPathEntry = (c) =>
  c !== null && typeof c === 'object' && !(c instanceof Blob) && !ArrayBuffer.isView(c)
  && typeof c.fromPath === 'string';

/**
 * Compress a recorded archive ({ dirs, entries }) via the sidecar. Each entry
 * is uploaded in its ORIGINAL form — Blobs stream from browser-managed (often
 * disk-backed) storage straight into the request body, never copied through
 * the JS heap. This is why the export records entries instead of building a
 * JSZip: JSZip would have eagerly read every Blob into the heap on file().
 *
 * `onProgress({ step, pct })` fires once per file; pct is byte-weighted (a
 * 1 GB DAE moves the bar like 1 GB, not like one file) and the step text
 * carries live file/byte counters so the UI visibly ticks.
 *
 * Returns `{ url, jobId, filename }` — a same-origin GET URL the caller streams
 * straight to disk; the archive is never materialised as a blob in the renderer.
 *
 * @param {{ dirs: string[], entries: Map<string, string|Blob|ArrayBufferView> }} archive
 *   (mutated: entries are dropped as they upload)
 * @param {{ filename: string, onProgress?: (p:{step:string,pct:number}) => void }} opts
 */
export async function compressZipViaSidecar({ dirs, entries }, { filename, onProgress }) {
  const { jobId } = await postJson('/api/zip-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Explicit directory entries ride along on the open call — BeamNG's
    // FS:directoryExists() needs them in the final archive.
    body: JSON.stringify({ dirs: dirs ?? [] }),
  });

  const paths = [...entries.keys()];
  const total = paths.length;
  const sizeOf = (c) => (isServerPathEntry(c) ? (c.size ?? 0) : c instanceof Blob ? c.size : (c?.byteLength ?? new Blob([c]).size));
  let totalBytes = 0;
  for (const p of paths) totalBytes += sizeOf(entries.get(p));
  let sentBytes = 0;
  onProgress?.({ step: `Compressing ZIP archive (0/${total} files)…`, pct: 0 });

  for (let i = 0; i < total; i += 1) {
    const p = paths[i];
    let body = entries.get(p);
    if (body === undefined) continue;

    let res;
    let entryBytes;
    if (isServerPathEntry(body)) {
      // Bake-sidecar artifact (GLB/DAE/atlas) — already on the server's disk;
      // only the path crosses the wire.
      console.info(`[zip-export] ingesting server-side entry "${p}" (${MB(body.size ?? 0)} MB) from ${body.fromPath}`);
      res = await fetch(
        `/api/zip-export/${jobId}/file?path=${encodeURIComponent(p)}&from=${encodeURIComponent(body.fromPath)}`,
        { method: 'POST' },
      );
      entryBytes = body.size ?? 0;
    } else {
      // Strings / typed arrays get wrapped once; Blobs pass through untouched.
      if (!(body instanceof Blob)) body = new Blob([body]);
      if (body.size > 64 * 1024 * 1024) {
        console.info(`[zip-export] uploading large entry "${p}" (${MB(body.size)} MB)`);
      }
      res = await fetch(`/api/zip-export/${jobId}/file?path=${encodeURIComponent(p)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      entryBytes = body.size;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
      throw new Error(`zip sidecar rejected "${p}" (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
    }
    sentBytes += entryBytes;
    body = null;
    // Drop the entry so the renderer can release it before the next upload.
    entries.delete(p);
    onProgress?.({
      step: `Compressing ZIP archive (${i + 1}/${total} files, ${MB(sentBytes)}/${MB(totalBytes)} MB)…`,
      pct: totalBytes > 0 ? Math.round((sentBytes / totalBytes) * 100) : 100,
    });
  }

  const { bytes } = await postJson(`/api/zip-export/${jobId}/finalize`, { method: 'POST' });
  console.info(`[zip-export] sidecar compressed ${total} files → ${((bytes ?? 0) / 1024 ** 2).toFixed(0)} MB`);

  return { url: `/api/zip-export/${jobId}/result`, jobId, filename };
}

/** Best-effort cleanup of a finished sidecar job (after the download drains). */
export function disposeSidecarZip(jobId) {
  if (!jobId) return;
  fetch(`/api/zip-export/${jobId}`, { method: 'DELETE' }).catch(() => { /* TTL-reaped anyway */ });
}
