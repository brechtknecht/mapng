import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ZipStreamWriter } from './zipStreamWriter.mjs';

// Vite dev-server middleware: the BeamNG ZIP-export sidecar. The in-browser
// export assembles the whole level into a JSZip object and then compresses it
// with pako (services/exportBeamNGLevel.js); on large maps generateAsync()
// allocates the compressed output + DEFLATE working buffers on top of the
// already-held archive and tips the ~4 GB renderer ceiling, hanging the tab.
//
// This streams the compression out instead: the browser POSTs each archive
// entry's raw bytes here one at a time (freeing it from JSZip as it goes); the
// entry streams straight from the request through DEFLATE into a spool file
// and is then appended to the archive with a COMPLETE local header (sizes/CRC
// known upfront — BeamNG's Torque-derived zip reader rejects the bit-3 data
// descriptors every streaming zip library writes; and yazl's buffer API caps
// entries at 1 GB, which an ultra-tier google_tiles.dae blows past). See
// zipStreamWriter.mjs. Memory stays flat for arbitrarily large entries, and
// the finished .zip is streamed back GET → disk so the renderer never
// re-materialises it. The in-browser path stays as the prod-build fallback.
//
// Job API (all under /api/zip-export):
//   GET    /health             → { ok: true }                  (sidecar probe)
//   POST   /                   → { jobId }            open a streaming zip job
//   POST   /<id>/file?path=... → { ok, files, bytesIn }   append one entry;
//          body = that file's raw (uncompressed) bytes
//   POST   /<id>/finalize      → { files, bytes }     close + flush the archive
//   GET    /<id>/result        → the finished .zip (streamed from disk)
//   DELETE /<id>               → drop the job + temp files

const MAX_FILE_BYTES = 8 * 1024 ** 3; // sanity cap per entry (zip64 handles the format side)
// Finished temp .zips reach hundreds of MB each and the browser streams the
// result immediately after finalize — keeping more than the latest one only
// burns the disk the NEXT export needs (observed ENOSPC).
const MAX_FINISHED_JOBS = 1;
const JOB_IDLE_MS = (() => {
  const env = Number(process.env.MAPNG_ZIP_JOB_IDLE_MS);
  return Number.isFinite(env) && env > 0 ? env : 15 * 60 * 1000;
})();

const sendJson = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};

export default function zipExportPlugin() {
  /** @type {Map<string, object>} jobId → job */
  const jobs = new Map();

  const cleanupJob = async (job) => {
    jobs.delete(job.id);
    try { job.zip?.out?.destroy(); } catch { /* already gone */ }
    if (job.workDir) await rm(job.workDir, { recursive: true, force: true }).catch(() => {});
  };

  const pruneFinished = () => {
    const finished = [...jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'error')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > MAX_FINISHED_JOBS) {
      const oldest = finished.shift();
      console.log(`[zip-export] pruning finished job ${oldest.id} (${oldest.status})`);
      cleanupJob(oldest);
    }
  };

  const startJob = async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'mapng-zip-export-'));
    const job = {
      id: randomUUID(),
      workDir,
      outPath: path.join(workDir, 'out.zip'),
      zip: null,
      // Entries MUST hit the archive strictly sequentially — every write is
      // chained here. The browser uploads serially anyway; the chain makes
      // it a guarantee instead of an assumption.
      chain: Promise.resolve(),
      status: 'open', // open → finalizing → done | error
      files: 0,
      bytesIn: 0,
      bytesOut: 0,
      dirsSeen: new Set(),
      error: null,
      createdAt: Date.now(),
      finishedAt: 0,
      lastActivity: Date.now(),
    };
    job.zip = new ZipStreamWriter(job.outPath, workDir);
    jobs.set(job.id, job);
    console.log(`[zip-export] job ${job.id} opened`);
    return job;
  };

  // Queue a write on the job's chain; a failure poisons the job (every later
  // call sees the error) but never leaves the chain rejected-unhandled.
  const enqueue = (job, task) => {
    const run = job.chain.then(() => {
      if (job.status === 'error') throw new Error(job.error ?? 'job already failed');
      return task();
    });
    job.chain = run.catch((err) => {
      if (job.status !== 'error') {
        job.status = 'error';
        job.error = String(err?.message ?? err);
        job.finishedAt = Date.now();
        console.warn(`[zip-export] job ${job.id} failed: ${job.error}`);
      }
    });
    return run;
  };

  // Write a dir entry for `dir` and every missing ancestor. The in-browser
  // JSZip auto-created parent folders for every file (createFolders:true) and
  // BeamNG's FS:directoryExists() relies on those entries being present —
  // without them e.g. art/shapes/google_tiles/ is invisible to the game and
  // its shape/material lookups silently fail.
  const addDirChain = async (job, dir) => {
    const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      const d = parts.slice(0, i).join('/');
      if (job.dirsSeen.has(d)) continue;
      job.dirsSeen.add(d);
      await job.zip.addEmptyDirectory(d);
    }
  };

  const readBody = (req, cap) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error(`upload exceeds ${cap} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  return {
    name: 'mapng-zip-export',
    configureServer(server) {
      server.httpServer?.on('close', () => {
        clearInterval(reaper);
        for (const job of jobs.values()) cleanupJob(job);
      });

      // Reap stalled/abandoned jobs (tab closed mid-upload, never finalized).
      const reaper = setInterval(() => {
        for (const job of jobs.values()) {
          if (Date.now() - job.lastActivity > JOB_IDLE_MS) {
            console.log(`[zip-export] reaping idle job ${job.id} (${job.status})`);
            cleanupJob(job);
          }
        }
      }, 60000);
      reaper.unref?.();

      server.middlewares.use('/api/zip-export', (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const segments = url.pathname.split('/').filter(Boolean);

        (async () => {
          // GET /health
          if (req.method === 'GET' && segments[0] === 'health') {
            sendJson(res, 200, { ok: true });
            return;
          }

          // POST / — open a job. Body (optional JSON): { dirs: string[] } —
          // explicit directory entries (BeamNG's FS:directoryExists() needs
          // them in the final archive).
          if (req.method === 'POST' && segments.length === 0) {
            const job = await startJob();
            const raw = await readBody(req, 4 * 1024 * 1024);
            if (raw.length > 0) {
              let dirs = [];
              try { dirs = JSON.parse(raw.toString('utf8'))?.dirs ?? []; } catch { /* no dirs */ }
              await enqueue(job, async () => {
                for (const d of dirs) await addDirChain(job, String(d));
              });
            }
            sendJson(res, 200, { jobId: job.id });
            return;
          }

          const job = jobs.get(segments[0]);
          if (!job) { sendJson(res, 404, { error: 'unknown job' }); return; }

          // POST /<id>/file?path=... — append one entry, streamed straight
          // from the request body through DEFLATE (no buffering). With
          // ?from=<server path>, the entry is read from THIS machine instead
          // (bake-sidecar artifacts: GLB/DAE/atlases) — multi-GB files then
          // never round-trip the browser. Paths are constrained to the OS
          // temp dir, where bake/conversion jobs live.
          if (req.method === 'POST' && segments[1] === 'file') {
            if (job.status !== 'open') {
              sendJson(res, 409, { error: `job is ${job.status}, not accepting files`, detail: job.error });
              return;
            }
            const entryPath = url.searchParams.get('path');
            if (!entryPath) { sendJson(res, 400, { error: 'missing ?path=' }); return; }
            const fromPath = url.searchParams.get('from');
            if (fromPath && !path.resolve(fromPath).startsWith(path.resolve(tmpdir()))) {
              sendJson(res, 400, { error: '?from= must point inside the OS temp directory' });
              return;
            }
            job.lastActivity = Date.now();
            req.pause(); // hold the body until this entry's turn on the chain
            try {
              const { rawSize } = await enqueue(job, async () => {
                const parentDir = entryPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
                if (parentDir) await addDirChain(job, parentDir);
                if (fromPath) {
                  req.resume(); // drain the empty body
                  return job.zip.addStream(entryPath, createReadStream(fromPath), { maxBytes: MAX_FILE_BYTES });
                }
                req.resume();
                return job.zip.addStream(entryPath, req, { maxBytes: MAX_FILE_BYTES });
              });
              job.files += 1;
              job.bytesIn += rawSize;
              job.lastActivity = Date.now();
              if (rawSize >= 16 * 1024 * 1024 || job.files % 50 === 0) {
                console.log(
                  `[zip-export] job ${job.id.slice(0, 8)} +${entryPath} ` +
                  `(${(rawSize / 1024 ** 2).toFixed(1)} MB, ${job.files} files, ` +
                  `${(job.bytesIn / 1024 ** 2).toFixed(0)} MB total)`,
                );
              }
              sendJson(res, 200, { ok: true, files: job.files, bytesIn: job.bytesIn });
            } catch (err) {
              sendJson(res, 500, { error: String(err?.message ?? err) });
            }
            return;
          }

          // POST /<id>/finalize — central directory + flush
          if (req.method === 'POST' && segments[1] === 'finalize') {
            if (job.status !== 'open') {
              sendJson(res, 409, { error: `job is ${job.status}`, detail: job.error });
              return;
            }
            job.status = 'finalizing';
            job.lastActivity = Date.now();
            console.log(`[zip-export] job ${job.id.slice(0, 8)} finalizing: ${job.files} files, ${(job.bytesIn / 1024 ** 2).toFixed(0)} MB in…`);
            try {
              await enqueue(job, () => job.zip.finalize());
              job.bytesOut = statSync(job.outPath).size;
              job.status = 'done';
              job.finishedAt = Date.now();
              console.log(
                `[zip-export] job ${job.id} done: ${job.files} files, ` +
                `${(job.bytesIn / 1024 ** 2).toFixed(0)} MB in → ` +
                `${(job.bytesOut / 1024 ** 2).toFixed(0)} MB zip`,
              );
              pruneFinished();
              sendJson(res, 200, { files: job.files, bytes: job.bytesOut });
            } catch (err) {
              job.status = 'error';
              const code = err?.code ? ` [${err.code}]` : '';
              job.error = `${String(err?.message ?? err)}${code}`;
              if (err?.code === 'ENOSPC') {
                job.error += ' — the temp drive is FULL. Free disk space (the tile cache in ' +
                  'node_modules/.cache/mapng-google-tiles can be deleted or capped via MAPNG_TILE_CACHE_MB).';
              }
              job.finishedAt = Date.now();
              console.warn(`[zip-export] job ${job.id} finalize failed: ${job.error}`);
              if (err?.stack) console.warn(err.stack);
              console.warn(
                `[zip-export] state at failure: ${job.files} files, ${(job.bytesIn / 1024 ** 2).toFixed(0)} MB in, ` +
                `rss=${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)} MB`,
              );
              sendJson(res, 500, { error: job.error });
            }
            return;
          }

          // GET /<id>/result — stream the finished .zip from disk
          if (req.method === 'GET' && segments[1] === 'result') {
            if (job.status !== 'done') {
              sendJson(res, job.status === 'error' ? 410 : 409, { error: `job is ${job.status}`, detail: job.error });
              return;
            }
            job.lastActivity = Date.now();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Length', String(job.bytesOut));
            createReadStream(job.outPath).pipe(res);
            return;
          }

          // DELETE /<id>
          if (req.method === 'DELETE' && segments.length === 1) {
            await cleanupJob(job);
            sendJson(res, 200, { ok: true });
            return;
          }

          sendJson(res, 405, { error: `unsupported ${req.method} ${url.pathname}` });
        })().catch((err) => {
          console.warn('[zip-export] request failed:', err?.message ?? err);
          if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
          else res.end();
        });
      });
    },
  };
}
