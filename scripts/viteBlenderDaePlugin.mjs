import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vite dev-server middleware: POST /api/convert-dae with a GLB body returns
// the BeamNG-ready .dae, converted by headless Blender via
// scripts/beamng_glb_to_dae.py. This is what lets the BeamNG export include
// the final google_tiles.dae automatically — the browser can't spawn
// processes, but the dev server can.
//
// Requires Blender 3.x/4.x (Collada export was REMOVED in Blender 5.0+).
// Resolution order: BLENDER_PATH env var → portable unzips on the Desktop →
// installed versions under Program Files.

const CONVERT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'beamng_glb_to_dae.py',
);

const findBlender = () => {
  const candidates = [];
  if (process.env.BLENDER_PATH) candidates.push(process.env.BLENDER_PATH);

  // Portable unzips, e.g. Desktop/blender42-portable/blender-4.2.9-windows-x64/blender.exe
  const desktop = path.join(homedir(), 'Desktop');
  try {
    for (const dir of readdirSync(desktop)) {
      if (!/blender/i.test(dir)) continue;
      const sub = path.join(desktop, dir);
      try {
        for (const inner of readdirSync(sub)) {
          if (/^blender-[34]\./i.test(inner)) {
            candidates.push(path.join(sub, inner, 'blender.exe'));
          }
        }
      } catch { /* not a directory */ }
      candidates.push(path.join(sub, 'blender.exe'));
    }
  } catch { /* no Desktop */ }

  // Installed versions — only 3.x/4.x still have the Collada exporter.
  try {
    const root = 'C:\\Program Files\\Blender Foundation';
    for (const dir of readdirSync(root)) {
      const m = dir.match(/^Blender (\d+)\./);
      if (m && Number(m[1]) <= 4) candidates.push(path.join(root, dir, 'blender.exe'));
    }
  } catch { /* not installed */ }

  return candidates.find((c) => c && existsSync(c)) ?? null;
};

const runBlender = (blender, glbPath, daePath) => new Promise((resolve, reject) => {
  const p = spawn(
    blender,
    ['--background', '--factory-startup', '--python', CONVERT_SCRIPT, '--', glbPath, daePath],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', (d) => { log += d; });
  p.on('error', reject);
  p.on('close', (code) => {
    if (code === 0 && existsSync(daePath)) resolve();
    else reject(new Error(`Blender exited with code ${code}\n${log.slice(-2000)}`));
  });
});

export default function blenderDaePlugin() {
  return {
    name: 'beamng-blender-dae',
    configureServer(server) {
      server.middlewares.use('/api/convert-dae', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST a GLB body to convert it to a BeamNG .dae');
          return;
        }
        const blender = findBlender();
        if (!blender) {
          res.statusCode = 503;
          res.end(
            'No Blender 3.x/4.x found (Collada export was removed in Blender 5.0+). ' +
            'Set the BLENDER_PATH env var or drop a portable Blender 4.2 on the Desktop.',
          );
          return;
        }

        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          let work = null;
          try {
            const glb = Buffer.concat(chunks);
            if (glb.length < 12) {
              res.statusCode = 400;
              res.end('empty GLB body');
              return;
            }
            work = await mkdtemp(path.join(tmpdir(), 'mapng-dae-'));
            const glbPath = path.join(work, 'google_tiles.glb');
            const daePath = path.join(work, 'google_tiles.dae');
            await writeFile(glbPath, glb);

            const t0 = Date.now();
            await runBlender(blender, glbPath, daePath);
            const dae = await readFile(daePath);

            console.log(
              `[beamng-blender-dae] ${(glb.length / 1024 ** 2).toFixed(1)} MB GLB → ` +
              `${(dae.length / 1024 ** 2).toFixed(1)} MB DAE in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
              `(${blender})`,
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/xml');
            res.end(dae);
          } catch (err) {
            console.warn('[beamng-blender-dae] conversion failed:', err?.message ?? err);
            res.statusCode = 500;
            res.end(String(err?.message ?? err));
          } finally {
            if (work) rm(work, { recursive: true, force: true }).catch(() => {});
          }
        });
      });
    },
  };
}
