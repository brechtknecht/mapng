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
//   GET    /jobs?key=<key>    → { jobId, status, sessionAlive, revision } | 404
//   GET    /<id>/events       → SSE; replays buffered events, then live.
//          event types: progress | log | done | refined | refine-error | error
//   GET    /<id>/result       → binary MBK1 container (latest revision)
//   POST   /<id>/refine       → { revision }; body { station } — forwards a
//          refine command to the job's LIVE worker session (the worker stays
//          resident after the base bake, warm cache + selection state). The
//          'refined' SSE event with that revision signals completion; fetch
//          /result again for the updated container.
//   DELETE /<id>              → kill the job's child process
//
// A bake job survives browser page reloads (dev HMR): the client reattaches
// by key via /jobs and re-subscribes to /events — something the in-browser
// bake could never do. Idle sessions are reaped after
// MAPNG_BAKE_SESSION_IDLE_MS (default 15 min); the result file outlives the
// session, so restore keeps working — only refinement needs a re-bake.

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
const MAX_FINISHED_JOBS = 3; // transient (un-retained) result files in tmp — prune hard
// Retained jobs: their worker has been freed (RAM reclaimed) but their workDir
// is deliberately kept on disk — a route export reads every chunk's files at
// the final zip, and "fast re-export" (tweak z-offset) reuses them. The current
// run must keep ALL its chunks' files until the zip, so the route export purges
// the PREVIOUS run's retained files when it starts a fresh bake (DELETE
// /jobs?retained=1); this cap is only a disk backstop against pathological
// accumulation (aborted runs, no fresh bake since).
const MAX_RETAINED_JOBS = 200;
const MAX_BUFFERED_EVENTS = 1500; // SSE replay buffer cap per job
const SESSION_IDLE_MS = (() => {
  const env = Number(process.env.MAPNG_BAKE_SESSION_IDLE_MS);
  return Number.isFinite(env) && env > 0 ? env : 15 * 60 * 1000;
})();

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
    if (job.events.length > MAX_BUFFERED_EVENTS) job.events.splice(0, 500);
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
    // Live sessions are exempt — their worker holds the warm bake state.
    const finished = [...jobs.values()].filter((j) => j.status !== 'running' && !j.sessionAlive);
    // Two LRU buckets: retained jobs (worker freed, files kept for the export +
    // re-export) get a generous cap; everything else is pruned hard.
    const prune = (bucket, cap, label) => {
      bucket.sort((a, b) => a.finishedAt - b.finishedAt);
      while (bucket.length > cap) {
        const oldest = bucket.shift();
        console.log(`[google-bake] pruning ${label} job ${oldest.id} (${oldest.status})`);
        cleanupJob(oldest);
      }
    };
    prune(finished.filter((j) => !j.retain), MAX_FINISHED_JOBS, 'finished');
    prune(finished.filter((j) => j.retain), MAX_RETAINED_JOBS, 'retained');
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
      // Worker freed but workDir kept on disk (route export / fast re-export).
      // Exempt from the hard MAX_FINISHED_JOBS prune; bounded by MAX_RETAINED_JOBS.
      retain: false,
      // Live-session state (worker stays resident after the base bake).
      sessionAlive: false,
      revision: 0,
      refineRevision: 0,
      lastActivity: Date.now(),
    };
    jobs.set(job.id, job);
    byKey.set(job.key, job.id);

    job.workDir = await mkdtemp(path.join(tmpdir(), 'mapng-google-bake-'));
    const jobPath = path.join(job.workDir, 'job.json');
    job.outPath = path.join(job.workDir, 'out.bin');
    await writeFile(jobPath, JSON.stringify({
      data: body.data,
      // session:true keeps the worker alive for refine commands.
      options: { ...(body.options ?? {}), session: true },
    }));

    const heap = heapMb();
    console.log(`[google-bake] job ${job.id} starting (heap=${heap}MB, key=${job.key})`);
    // Clean env: tooling that wraps the dev server (preview harnesses,
    // debuggers) injects NODE_OPTIONS/inspect flags that can crash or hang a
    // plain Node child — the worker needs none of it.
    const childEnv = { ...process.env };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.NODE_INSPECT_RESUME_ON_START;
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${heap}`, WORKER_SCRIPT, jobPath, job.outPath],
      { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv },
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
          // In session mode the worker stays alive after 'done' — flip the
          // job state NOW, not on child exit.
          job.stats = msg;
          job.status = 'done';
          job.finishedAt = Date.now();
          job.lastActivity = Date.now();
          job.sessionAlive = msg.session === true;
          pushEvent(job, msg);
          console.log(
            `[google-bake] job ${job.id} done: ${msg.meshes} meshes, ` +
            `${(msg.bytes / 1024 ** 2).toFixed(0)} MB${job.sessionAlive ? ' (session alive)' : ''}`,
          );
          pruneFinished();
        } else if (msg.type === 'refined') {
          job.revision = msg.revision;
          job.outPath = msg.resultPath;
          job.lastActivity = Date.now();
          pushEvent(job, msg);
          console.log(
            `[google-bake] job ${job.id} refined rev${msg.revision}: ` +
            `+${msg.added}/-${msg.removed} tiles, ${msg.meshes} meshes, ${(msg.bytes / 1024 ** 2).toFixed(0)} MB`,
          );
        } else if (msg.type === 'refine-error') {
          job.lastActivity = Date.now();
          pushEvent(job, msg);
          console.warn(`[google-bake] job ${job.id} refine rev${msg.revision} failed: ${msg.message}`);
        } else if (msg.type === 'exported') {
          job.lastActivity = Date.now();
          pushEvent(job, msg);
          console.log(
            `[google-bake] job ${job.id} export rev${msg.revision}: ${msg.meshes} meshes, ` +
            `${msg.materialNames?.length ?? 0} atlases → ${msg.glbPath}`,
          );
        } else if (msg.type === 'export-error') {
          job.lastActivity = Date.now();
          pushEvent(job, msg);
          console.warn(`[google-bake] job ${job.id} export rev${msg.revision} failed: ${msg.message}`);
        } else if (msg.type === 'error') {
          job.error = msg.message;
        } else if (msg.type === 'progress') {
          pushEvent(job, msg);
        }
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
      const wasSession = job.sessionAlive;
      job.sessionAlive = false;
      if (job.status === 'running') {
        // Worker died before reporting done.
        job.finishedAt = Date.now();
        job.status = 'error';
        job.error ??= `bake worker exited with code ${code}` +
          (stderrTail ? ` — last output:${stderrTail.slice(-1500)}` : '');
        pushEvent(job, { type: 'error', message: job.error });
        console.warn(`[google-bake] job ${job.id} failed: ${job.error.slice(0, 300)}`);
      } else if (wasSession) {
        console.log(`[google-bake] job ${job.id} session ended (exit ${code}) — result stays restorable`);
        pushEvent(job, { type: 'session-ended' });
      }
      finishListeners(job);
      pruneFinished();
    });

    return job;
  };

  const killJob = (job, reason) => {
    if (job.status === 'running') {
      console.log(`[google-bake] killing job ${job.id} (${reason})`);
      job.status = 'error';
      job.error = `cancelled (${reason})`;
      job.finishedAt = Date.now();
      pushEvent(job, { type: 'error', message: job.error });
      finishListeners(job);
      try { job.child?.kill(); } catch { /* already gone */ }
    } else if (job.sessionAlive) {
      // Finished bake with a live session — end the worker; the 'close'
      // handler flips sessionAlive and notifies subscribers.
      console.log(`[google-bake] ending session of job ${job.id} (${reason})`);
      try { job.child?.stdin?.end(); } catch { /* noop */ }
      try { job.child?.kill(); } catch { /* already gone */ }
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
        clearInterval(reaper);
        for (const job of jobs.values()) killJob(job, 'dev server shutdown');
      });

      // Reap idle sessions — each holds a multi-GB worker process. The
      // result file survives, so restores keep working; only refinement
      // needs a fresh bake afterwards.
      const reaper = setInterval(() => {
        for (const job of jobs.values()) {
          if (job.sessionAlive && Date.now() - job.lastActivity > SESSION_IDLE_MS) {
            killJob(job, `idle ${Math.round(SESSION_IDLE_MS / 60000)} min`);
          }
        }
      }, 60000);
      reaper.unref?.();

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
            sendJson(res, 200, {
              jobId: job.id,
              status: job.status,
              sessionAlive: job.sessionAlive,
              revision: job.revision,
            });
            return;
          }

          // DELETE /jobs?retained=1 — purge every RETAINED job (worker already
          // freed; this removes their kept workDirs). The route export calls
          // this when it starts a FRESH bake, dropping the previous run's files
          // so disk doesn't accumulate route-over-route. Live sessions and the
          // current run's own (not-yet-created) jobs are untouched.
          if (req.method === 'DELETE' && segments[0] === 'jobs' && url.searchParams.get('retained') === '1') {
            const retained = [...jobs.values()].filter((j) => j.retain);
            for (const j of retained) await cleanupJob(j);
            console.log(`[google-bake] purged ${retained.length} retained job(s)`);
            sendJson(res, 200, { ok: true, purged: retained.length });
            return;
          }

          // POST / — start or join a job. body.ensureSession=true means the
          // caller needs a LIVE session (fly-mode refinement): a finished job
          // whose worker has died is then re-baked instead of joined.
          if (req.method === 'POST' && segments.length === 0) {
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            const existingId = body.key && byKey.get(body.key);
            const existing = existingId && jobs.get(existingId);
            if (existing && !body.force) {
              const joinable = existing.status === 'running' ||
                (existing.status === 'done' && (existing.sessionAlive || !body.ensureSession));
              if (joinable) {
                sendJson(res, 200, { jobId: existing.id, status: existing.status, joined: true });
                return;
              }
              if (existing.status === 'done') {
                console.log(`[google-bake] job ${existing.id} has no live session — re-baking for refinement`);
                await cleanupJob(existing);
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
            // Keep the stream open while the worker can still emit — i.e.
            // while the bake runs OR a live session may produce refinements.
            if (job.status !== 'running' && !job.sessionAlive) { res.end(); return; }
            job.listeners.add(res);
            const heartbeat = setInterval(() => res.write(':hb\n\n'), 15000);
            req.on('close', () => {
              clearInterval(heartbeat);
              job.listeners.delete(res);
            });
            return;
          }

          // GET /<id>/result — stream the MBK1 container (latest revision)
          if (req.method === 'GET' && segments[1] === 'result') {
            if (job.status !== 'done') {
              sendJson(res, job.status === 'running' ? 409 : 410, { error: `job is ${job.status}`, detail: job.error });
              return;
            }
            job.lastActivity = Date.now();
            const size = statSync(job.outPath).size;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(size));
            createReadStream(job.outPath).pipe(res);
            return;
          }

          // POST /<id>/export — assemble the BeamNG atlas+GLB SERVER-SIDE in
          // the live session worker; the 'exported' SSE event carries file
          // PATHS that the Blender bridge / zip sidecar consume directly.
          if (req.method === 'POST' && segments[1] === 'export') {
            if (!job.sessionAlive || !job.child?.stdin?.writable) {
              sendJson(res, 409, {
                error: 'no live bake session for this job — re-bake to export server-side',
              });
              return;
            }
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            const revision = ++job.refineRevision;
            job.lastActivity = Date.now();
            job.child.stdin.write(`${JSON.stringify({ type: 'export', revision, spec: body.spec ?? {} })}\n`);
            console.log(`[google-bake] job ${job.id} export rev${revision} queued`);
            sendJson(res, 200, { revision });
            return;
          }

          // POST /<id>/refine — forward a user station to the live session
          if (req.method === 'POST' && segments[1] === 'refine') {
            if (!job.sessionAlive || !job.child?.stdin?.writable) {
              sendJson(res, 409, {
                error: 'no live bake session for this job — re-bake to refine ' +
                  '(sessions end on dev-server restart or after idling)',
              });
              return;
            }
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            const revision = ++job.refineRevision;
            job.lastActivity = Date.now();
            job.child.stdin.write(`${JSON.stringify({ type: 'refine', revision, station: body.station ?? {} })}\n`);
            console.log(`[google-bake] job ${job.id} refine rev${revision} queued (${JSON.stringify(body.station ?? {}).slice(0, 120)})`);
            sendJson(res, 200, { revision });
            return;
          }

          // DELETE /<id>[?keepFiles=1]
          // keepFiles: free the worker process (reclaim RAM) but KEEP the
          // workDir — a route export reads every chunk's files at the final zip
          // and fast re-export reuses them. Without it: full purge (worker +
          // files), used by the Raw-GLB bake which keeps nothing server-side.
          if (req.method === 'DELETE' && segments.length === 1) {
            const keepFiles = url.searchParams.get('keepFiles') === '1';
            if (keepFiles) {
              job.retain = true; // exempt from the hard prune; close→pruneFinished keeps it
              killJob(job, 'end session (keep files)');
            } else {
              killJob(job, 'client cancel');
              await cleanupJob(job);
            }
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
