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

/**
 * Compress an assembled JSZip via the sidecar. Streams each entry's raw bytes
 * to Node one at a time, freeing it from `zip` as it goes (so renderer memory
 * falls during compression instead of spiking), then finalizes the archive.
 *
 * `onProgress({ step, pct })` fires once per file (pct 0..100 over the upload),
 * giving the previously-opaque "Compressing…" step real, visible motion.
 *
 * Returns `{ url, jobId, filename }` — a same-origin GET URL the caller streams
 * straight to disk; the archive is never materialised as a blob in the renderer.
 *
 * @param {import('jszip')} zip assembled JSZip instance (mutated: entries are dropped)
 * @param {{ filename: string, onProgress?: (p:{step:string,pct:number}) => void }} opts
 */
export async function compressZipViaSidecar(zip, { filename, onProgress }) {
  const step = 'Compressing ZIP archive (DEFLATE)…';
  const { jobId } = await postJson('/api/zip-export', { method: 'POST' });

  // Snapshot paths up front: we delete entries as we upload, and skip the
  // directory placeholders JSZip adds via zip.folder() (yazl needs files only).
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const total = paths.length;
  onProgress?.({ step, pct: 0 });

  for (let i = 0; i < total; i += 1) {
    const p = paths[i];
    const entry = zip.files[p];
    if (!entry) continue;
    let bytes = await entry.async('uint8array');
    const res = await fetch(`/api/zip-export/${jobId}/file?path=${encodeURIComponent(p)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error ?? ''; } catch (_) { /* noop */ }
      throw new Error(`zip sidecar rejected "${p}" (HTTP ${res.status}${detail ? `: ${detail}` : ''})`);
    }
    // Drop the entry so its uncompressed bytes can be GC'd before the next one.
    bytes = null;
    delete zip.files[p];
    onProgress?.({ step, pct: Math.round(((i + 1) / total) * 100) });
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
