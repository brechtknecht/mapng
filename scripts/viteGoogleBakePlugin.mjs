import { spawn } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite dev-server middleware: the Google 3D Tiles bake sidecar. The browser
// bake dies at the ~4 GB renderer-process ceiling on heavy tiers / large
// AOIs; this runs the SAME bake (shared core, see googleBakeWorker.mjs) in a
// dedicated Node child process with a multi-GB heap and compressed-texture
// pass-through. When the dev server is reachable, the browser routes EVERY
// bake through here regardless of quality tier; the in-browser bake remains
// as the fallback for prod builds (Cloudflare) where no sidecar exists.
//
// Job API (all under /api/google-bake):
//   GET    /health            → { ok: true }                  (sidecar probe)
//   POST   /                  → { jobId, status }   start (or join) a bake job
//          body: { key, force?, data:{...}, options:{...} } — see the worker
//          header. Jobs are deduped by `key` (the browser's bakeCacheKey):
//          posting an already-running key joins that job, force kills it.
//   GET    /jobs?key=<key>    → { jobId, status } | 404        (reattach probe)
//   GET    /<id>/events       → SSE; replays buffered events, then live.
//          event types: progress | log | done | error
//   GET    /<id>/result       → binary MBK1 container (see the worker)
//   DELETE /<id>              → kill the job's child process
//
// A bake job survives browser page reloads (dev HMR): the client reattaches
// by key via /jobs and re-subscribes to /events — something the in-browser
// bake could never do.

const WORKER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'googleBakeWorker.mjs',
);

// Child heap budget: MAPNG_BAKE_HEAP_MB env var, else half the machine's
// RAM, capped at 24 GB. (The browser bake had 4 GB for everything.)
const heapMb = () => {
  const env = Number(process.env.MAPNG_BAKE_HEAP_MB);
  if (Number.isFinite(env) && env > 0) return Math.round(env);
  return Math.min(24576, Math.round(totalmem() / 1024 / 1024 / 2));
};

const MAX_BODY_BYTES = 512 * 1024 * 1024;
const MAX_FINISHED_JOBS = 3; // result files in tmp are big — prune like the IndexedDB cache

const sendJson = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};

export default function googleBakePlugin() {
  /** @type {Map<string, object>} jobId → job */
  const jobs = new Map();
  /** @type {Map<string, string>} bake key → jobId (latest) */
  const byKey = new Map();

  const pushEvent = (job, event) => {
    job.events.push(event);
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of job.listeners) res.write(line);
  };

  const finishListeners = (job) => {
    for (const res of job.listeners) res.end();
    job.listeners.clear();
  };

  const cleanupJob = async (job) => {
    jobs.delete(job.id);
    if (byKey.get(job.key) === job.id) byKey.delete(job.key);
    if (job.workDir) await rm(job.workDir, { recursive: true, force: true }).catch(() => {});
  };

  const pruneFinished = () => {
    const finished = [...jobs.values()]
      .filter((j) => j.status !== 'running')
      .sort((a, b) => a.finishedAt - b.finishedAt);
    while (finished.length > MAX_FINISHED_JOBS) {
      const oldest = finished.shift();
      console.log(`[google-bake] pruning finished job ${oldest.id} (${oldest.status})`);
      cleanupJob(oldest);
    }
  };

  const startJob = async (body) => {
    const job = {
      id: randomUUID(),
      key: body.key ?? randomUUID(),
      status: 'running',
      events: [],
      listeners: new Set(),
      child: null,
      workDir: null,
      outPath: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: 0,
    };
    jobs.set(job.id, job);
    byKey.set(job.key, job.id);

    job.workDir = await mkdtemp(path.join(tmpdir(), 'mapng-google-bake-'));
    const jobPath = path.join(job.workDir, 'job.json');
    job.outPath = path.join(job.workDir, 'out.bin');
    await writeFile(jobPath, JSON.stringify({ data: body.data, options: body.options ?? {} }));

    const heap = heapMb();
    console.log(`[google-bake] job ${job.id} starting (heap=${heap}MB, key=${job.key})`);
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${heap}`, WORKER_SCRIPT, jobPath, job.outPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    job.child = child;

    // stdout: NDJSON protocol. Line-buffer it — chunks split mid-line.
    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'done') {
          job.stats = msg;
        } else if (msg.type === 'error') {
          job.error = msg.message;
        }
        if (msg.type === 'progress') {
          pushEvent(job, msg);
        }
        // done/error events are pushed from the 'close' handler below, once
        // the exit code confirms them.
      }
    });

    // stderr: worker logs (incl. the shared core's console lines) — relay to
    // the vite terminal and to SSE subscribers.
    let stderrBuf = '';
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
      let nl;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl).trimEnd();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (!line) continue;
        stderrTail = `${stderrTail}\n${line}`.slice(-4000);
        console.log(`[google-bake:${job.id.slice(0, 8)}] ${line}`);
        pushEvent(job, { type: 'log', line });
      }
    });

    child.on('error', (err) => {
      job.status = 'error';
      job.error = `failed to spawn bake worker: ${err.message}`;
      job.finishedAt = Date.now();
      pushEvent(job, { type: 'error', message: job.error });
      finishListeners(job);
    });

    child.on('close', (code) => {
      if (job.status !== 'running') return; // spawn error already handled
      job.finishedAt = Date.now();
      if (code === 0 && job.stats) {
        job.status = 'done';
        pushEvent(job, { ...job.stats }); // type:'done'
        console.log(`[google-bake] job ${job.id} done: ${job.stats.meshes} meshes, ${(job.stats.bytes / 1024 ** 2).toFixed(0)} MB`);
      } else {
        job.status = 'error';
        job.error ??= `bake worker exited with code ${code}` +
          (stderrTail ? ` — last output:${stderrTail.slice(-1500)}` : '');
        pushEvent(job, { type: 'error', message: job.error });
        console.warn(`[google-bake] job ${job.id} failed: ${job.error.slice(0, 300)}`);
      }
      finishListeners(job);
      pruneFinished();
    });

    return job;
  };

  const killJob = (job, reason) => {
    if (job.status === 'running' && job.child) {
      console.log(`[google-bake] killing job ${job.id} (${reason})`);
      job.status = 'error';
      job.error = `cancelled (${reason})`;
      job.finishedAt = Date.now();
      pushEvent(job, { type: 'error', message: job.error });
      finishListeners(job);
      try { job.child.kill(); } catch { /* already gone */ }
    }
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  return {
    name: 'mapng-google-bake',
    configureServer(server) {
      // Kill bake children when the dev server shuts down/restarts.
      server.httpServer?.on('close', () => {
        for (const job of jobs.values()) killJob(job, 'dev server shutdown');
      });

      server.middlewares.use('/api/google-bake', (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const segments = url.pathname.split('/').filter(Boolean);

        (async () => {
          // GET /health
          if (req.method === 'GET' && segments[0] === 'health') {
            sendJson(res, 200, { ok: true });
            return;
          }

          // GET /jobs?key=...
          if (req.method === 'GET' && segments[0] === 'jobs') {
            const key = url.searchParams.get('key');
            const jobId = key && byKey.get(key);
            const job = jobId && jobs.get(jobId);
            if (!job) { sendJson(res, 404, { error: 'no job for key' }); return; }
            sendJson(res, 200, { jobId: job.id, status: job.status });
            return;
          }

          // POST / — start or join a job
          if (req.method === 'POST' && segments.length === 0) {
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            const existingId = body.key && byKey.get(body.key);
            const existing = existingId && jobs.get(existingId);
            if (existing && !body.force) {
              if (existing.status === 'running' || existing.status === 'done') {
                sendJson(res, 200, { jobId: existing.id, status: existing.status, joined: true });
                return;
              }
            }
            if (existing && body.force) {
              killJob(existing, 'force re-bake');
              await cleanupJob(existing);
            }
            const job = await startJob(body);
            sendJson(res, 200, { jobId: job.id, status: job.status });
            return;
          }

          const job = jobs.get(segments[0]);
          if (!job) { sendJson(res, 404, { error: 'unknown job' }); return; }

          // GET /<id>/events — SSE
          if (req.method === 'GET' && segments[1] === 'events') {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write(':ok\n\n');
            for (const event of job.events) res.write(`data: ${JSON.stringify(event)}\n\n`);
            if (job.status !== 'running') { res.end(); return; }
            job.listeners.add(res);
            const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000);
            req.on('close', () => {
              clearInterval(heartbeat);
              job.listeners.delete(res);
            });
            return;
          }

          // GET /<id>/result — stream the MBK1 container
          if (req.method === 'GET' && segments[1] === 'result') {
            if (job.status !== 'done') {
              sendJson(res, job.status === 'running' ? 409 : 410, { error: `job is ${job.status}`, detail: job.error });
              return;
            }
            const size = statSync(job.outPath).size;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(size));
            createReadStream(job.outPath).pipe(res);
            return;
          }

          // DELETE /<id>
          if (req.method === 'DELETE' && segments.length === 1) {
            killJob(job, 'client cancel');
            await cleanupJob(job);
            sendJson(res, 200, { ok: true });
            return;
          }

          sendJson(res, 405, { error: `unsupported ${req.method} ${url.pathname}` });
        })().catch((err) => {
          console.warn('[google-bake] request failed:', err?.message ?? err);
          if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
          else res.end();
        });
      });
    },
  };
}
