import { createLogger } from '@brechtknecht/turbolog';

// Vite dev-server middleware: a browser→turbolog bridge. turbolog's SDK opens a
// local unix socket (Node only), but most of our instrumentation-worthy code
// (the route export placement math in packages/route) runs in the BROWSER. This
// plugin runs the logger in the Vite Node process and exposes a tiny POST
// endpoint the browser posts structured events to, so the TUI + MCP server can
// read them. Mirrors the other sidecars (google-bake / convert-dae / zip-export).
//
//   POST /api/log        body: { stream, message, meta?, level?, duration? }
//   GET  /api/log/health → { ok: true }
//
// The socket path is derived from the project cwd, so `turbolog` (TUI) and
// `turbolog-mcp` (MCP server) launched from this repo attach with zero config.

// Module-singleton logger so OTHER in-process Vite plugins (e.g. the Blender DAE
// converter) can emit to the same turbolog store the TUI/MCP read — without the
// browser bridge. Child processes (the bake worker) can't share it; they route
// their diagnostics back through the browser → POST /api/log instead.
let _logger = null;
export const tlog = (stream, message, meta) => {
  try { _logger?.emit({ stream: String(stream), message: String(message ?? ''), meta }); }
  catch { /* logger down — never break the caller */ }
};

const sendJson = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
};

const readBody = (req, max = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > max) { reject(new Error('log body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

export default function turbologPlugin() {
  let log = null;
  return {
    name: 'mapng-turbolog',
    async configureServer(server) {
      try {
        log = createLogger({ serve: true, cwd: process.cwd() });
        _logger = log;
        await log.serve();
        console.log('[turbolog] logger serving — attach with `npx @brechtknecht/turbolog` (TUI) or the turbolog-mcp server');
      } catch (err) {
        console.warn('[turbolog] failed to start logger — /api/log will no-op:', err?.message ?? err);
      }

      server.httpServer?.on('close', () => { try { log?.close(); } catch { /* noop */ } });

      server.middlewares.use('/api/log', (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const segments = url.pathname.split('/').filter(Boolean);
        (async () => {
          if (req.method === 'GET' && segments[0] === 'health') {
            sendJson(res, 200, { ok: !!log });
            return;
          }
          if (req.method === 'POST' && segments.length === 0) {
            if (!log) { sendJson(res, 200, { ok: false, reason: 'logger unavailable' }); return; }
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            log.emit({
              stream: String(body.stream || 'app'),
              message: String(body.message ?? ''),
              level: body.level,
              meta: body.meta,
              duration: body.duration,
            });
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 405, { error: `unsupported ${req.method} ${url.pathname}` });
        })().catch((err) => {
          if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
          else res.end();
        });
      });
    },
  };
}
