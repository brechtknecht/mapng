import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yazl from 'yazl';

// Vite dev-server middleware: the BeamNG ZIP-export sidecar. The in-browser
// export assembles the whole level into a JSZip object and then compresses it
// with pako (services/exportBeamNGLevel.js); on large maps generateAsync()
// allocates the compressed output + DEFLATE working buffers on top of the
// already-held archive and tips the ~4 GB renderer ceiling, hanging the tab.
//
// This streams the compression out instead: the browser POSTs each archive
// entry's raw bytes here one at a time (freeing it from JSZip as it goes), the
// entry is DEFLATEd through Node's native zlib straight to a temp file (yazl,
// zip64-capable, off-heap, streaming — flat memory even for multi-GB zips),
// and the finished .zip is streamed back GET → disk so the renderer never
// re-materialises it. The in-browser path stays as the prod-build fallback.
//
// Unlike the Google-bake sidecar this needs no child process / big heap: zlib
// does the heavy lifting natively, and the browser drives the per-file loop so
// progress is reported client-side (no SSE here).
//
// Job API (all under /api/zip-export):
//   GET    /health             → { ok: true }                  (sidecar probe)
//   POST   /                   → { jobId }            open a streaming zip job
//   POST   /<id>/file?path=... → { ok, files, bytesIn }   append one entry;
//          body = that file's raw (uncompressed) bytes
//   POST   /<id>/finalize      → { files, bytes }     close + flush the archive
//   GET    /<id>/result        → the finished .zip (streamed from disk)
//   DELETE /<id>               → drop the job + temp files

const MAX_FILE_BYTES = 1536 * 1024 * 1024; // per-entry upload cap (~1.5 GB)
const MAX_FINISHED_JOBS = 3;               // temp .zips are big — prune like the bake sidecar
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
    try { job.zipfile?.outputStream?.destroy(); } catch { /* already gone */ }
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
    const job = {
      id: randomUUID(),
      workDir: await mkdtemp(path.join(tmpdir(), 'mapng-zip-export-')),
      outPath: null,
      zipfile: new yazl.ZipFile(),
      status: 'open', // open → finalizing → done | error
      files: 0,
      bytesIn: 0,
      bytesOut: 0,
      error: null,
      finalize: null, // Promise resolved when the output stream closes
      createdAt: Date.now(),
      finishedAt: 0,
      lastActivity: Date.now(),
    };
    job.outPath = path.join(job.workDir, 'out.zip');
    jobs.set(job.id, job);

    const out = createWriteStream(job.outPath);
    job.finalize = new Promise((resolve, reject) => {
      out.on('close', () => {
        job.bytesOut = statSync(job.outPath).size;
        resolve();
      });
      out.on('error', reject);
      job.zipfile.outputStream.on('error', reject);
    });
    job.zipfile.outputStream.pipe(out);

    console.log(`[zip-export] job ${job.id} opened`);
    return job;
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

          // POST / — open a job
          if (req.method === 'POST' && segments.length === 0) {
            const job = await startJob();
            sendJson(res, 200, { jobId: job.id });
            return;
          }

          const job = jobs.get(segments[0]);
          if (!job) { sendJson(res, 404, { error: 'unknown job' }); return; }

          // POST /<id>/file?path=... — append one entry
          if (req.method === 'POST' && segments[1] === 'file') {
            if (job.status !== 'open') {
              sendJson(res, 409, { error: `job is ${job.status}, not accepting files` });
              return;
            }
            const entryPath = url.searchParams.get('path');
            if (!entryPath) { sendJson(res, 400, { error: 'missing ?path=' }); return; }
            const buf = await readBody(req, MAX_FILE_BYTES);
            // yazl wants forward slashes; normalize defensively.
            job.zipfile.addBuffer(buf, entryPath.replace(/\\/g, '/'));
            job.files += 1;
            job.bytesIn += buf.byteLength;
            job.lastActivity = Date.now();
            sendJson(res, 200, { ok: true, files: job.files, bytesIn: job.bytesIn });
            return;
          }

          // POST /<id>/finalize — close + flush the archive
          if (req.method === 'POST' && segments[1] === 'finalize') {
            if (job.status !== 'open') {
              sendJson(res, 409, { error: `job is ${job.status}` });
              return;
            }
            job.status = 'finalizing';
            job.lastActivity = Date.now();
            job.zipfile.end();
            try {
              await job.finalize;
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
              job.error = String(err?.message ?? err);
              job.finishedAt = Date.now();
              console.warn(`[zip-export] job ${job.id} finalize failed: ${job.error}`);
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
