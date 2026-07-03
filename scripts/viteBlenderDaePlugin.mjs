import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tlog } from './viteTurbologPlugin.mjs';

// --- geometry probes (turbolog `dae-geometry`) --------------------------------
// AABB of every POSITION accessor in a GLB (min/max come free in the JSON — no
// vertex scan). glTF is Y-up: [x=east, y=up, z=south].
const glbPositionBBox = (buf) => {
  try {
    if (buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF'
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    const posIdx = new Set();
    for (const m of json.meshes ?? []) for (const p of m.primitives ?? []) {
      if (Number.isInteger(p.attributes?.POSITION)) posIdx.add(p.attributes.POSITION);
    }
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const i of posIdx) {
      const a = json.accessors?.[i];
      if (!a?.min || !a?.max) continue;
      for (let d = 0; d < 3; d++) { if (a.min[d] < mn[d]) mn[d] = a.min[d]; if (a.max[d] > mx[d]) mx[d] = a.max[d]; }
    }
    return Number.isFinite(mn[0]) ? aabb(mn, mx) : null;
  } catch { return null; }
};

// AABB over a COLLADA's position <float_array>s (Blender ids them "*-mesh-positions*").
// The .dae is Z-up after export: [x=east, y=north, z=up].
const daePositionBBox = (xml) => {
  try {
    const re = /<float_array[^>]*id="[^"]*positions[^"]*"[^>]*>([\s\S]*?)<\/float_array>/gi;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    let m, found = false;
    while ((m = re.exec(xml))) {
      const nums = m[1].trim().split(/\s+/);
      for (let k = 0; k + 2 < nums.length; k += 3) {
        found = true;
        for (let d = 0; d < 3; d++) { const v = +nums[k + d]; if (v < mn[d]) mn[d] = v; if (v > mx[d]) mx[d] = v; }
      }
    }
    return found ? aabb(mn, mx) : null;
  } catch { return null; }
};

const aabb = (min, max) => ({
  min, max,
  center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  span: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
});

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

// The Blender binary inside a macOS .app bundle.
const MAC_APP_BIN = 'Contents/MacOS/Blender';

// Collada (.dae) export was REMOVED in Blender 5.0. Reject a 5.x+ binary so the
// caller gets the clean "install 3.x/4.x" message instead of a cryptic Python
// error mid-conversion. Returns true when the binary is usable (3.x/4.x) OR the
// version can't be determined (don't block a possibly-fine install).
const blenderHasCollada = (bin) => {
  // macOS .app bundle: read CFBundleShortVersionString from Info.plist (no spawn).
  const m = bin.match(/^(.*\.app)\/Contents\/MacOS\/Blender$/);
  if (m) {
    try {
      const plist = readFileSync(path.join(m[1], 'Contents', 'Info.plist'), 'utf8');
      const ver = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      const major = ver ? parseInt(ver[1], 10) : NaN;
      if (Number.isFinite(major)) return major <= 4;
    } catch { /* unreadable → don't block */ }
  }
  return true;
};

const findBlender = () => {
  const candidates = [];
  if (process.env.BLENDER_PATH) candidates.push(process.env.BLENDER_PATH);

  // Portable unzips on the Desktop, e.g.
  //   Win:   Desktop/blender42-portable/blender-4.2.9-windows-x64/blender.exe
  //   macOS: Desktop/blender-4.2.9-macos-arm64/Blender.app/Contents/MacOS/Blender
  //   Linux: Desktop/blender-4.2.9-linux-x64/blender
  const desktop = path.join(homedir(), 'Desktop');
  try {
    for (const dir of readdirSync(desktop)) {
      if (!/blender/i.test(dir)) continue;
      const sub = path.join(desktop, dir);
      candidates.push(
        path.join(sub, 'blender.exe'),
        path.join(sub, 'blender'),
        path.join(sub, 'Blender.app', MAC_APP_BIN),
        path.join(sub, MAC_APP_BIN), // a bare Blender.app dropped on the Desktop
      );
      try {
        for (const inner of readdirSync(sub)) {
          if (!/^blender-[34]\./i.test(inner)) continue;
          candidates.push(
            path.join(sub, inner, 'blender.exe'),
            path.join(sub, inner, 'blender'),
            path.join(sub, inner, 'Blender.app', MAC_APP_BIN),
          );
        }
      } catch { /* not a directory */ }
    }
  } catch { /* no Desktop */ }

  if (process.platform === 'darwin') {
    // Standard installs + Homebrew.
    candidates.push(
      '/Applications/Blender.app/' + MAC_APP_BIN,
      path.join(homedir(), 'Applications/Blender.app', MAC_APP_BIN),
      '/opt/homebrew/bin/blender',
      '/usr/local/bin/blender',
    );
    // Versioned app bundles, e.g. /Applications/Blender 4.2/Blender.app.
    try {
      for (const dir of readdirSync('/Applications')) {
        if (/^Blender[ -]?[34]/i.test(dir)) {
          candidates.push(path.join('/Applications', dir, 'Blender.app', MAC_APP_BIN));
        }
      }
    } catch { /* noop */ }
  } else if (process.platform === 'win32') {
    // Installed versions — only 3.x/4.x still have the Collada exporter.
    try {
      const root = 'C:\\Program Files\\Blender Foundation';
      for (const dir of readdirSync(root)) {
        const m = dir.match(/^Blender (\d+)\./);
        if (m && Number(m[1]) <= 4) candidates.push(path.join(root, dir, 'blender.exe'));
      }
    } catch { /* not installed */ }
  } else {
    // Linux: common install locations + PATH-style symlinks.
    candidates.push('/usr/bin/blender', '/usr/local/bin/blender', '/opt/blender/blender');
  }

  // BLENDER_PATH is trusted as-is (explicit override); otherwise skip a 5.x+
  // .app bundle that can't produce Collada.
  const override = process.env.BLENDER_PATH;
  return candidates.find((c) =>
    c && existsSync(c) && (c === override || blenderHasCollada(c)),
  ) ?? null;
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
          res.end('POST a GLB body (or ?file=<server path>) to convert it to a BeamNG .dae');
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

        // Server-path mode: the GLB was assembled by the bake sidecar and
        // already sits on this machine — convert in place and return the DAE
        // PATH, so multi-GB artifacts never round-trip the browser. Paths are
        // constrained to the OS temp dir (where bake jobs live).
        const url = new URL(req.url, 'http://localhost');
        const serverGlb = url.searchParams.get('file');
        if (serverGlb) {
          (async () => {
            const resolved = path.resolve(serverGlb);
            if (!resolved.startsWith(path.resolve(tmpdir()))) {
              res.statusCode = 400;
              res.end('?file= must point inside the OS temp directory');
              return;
            }
            req.resume(); // drain the (empty) body
            const daePath = resolved.replace(/\.glb$/i, '') + '.dae';
            const t0 = Date.now();
            await runBlender(blender, resolved, daePath);
            const bytes = statSync(daePath).size;
            console.log(
              `[beamng-blender-dae] ${resolved} → ${(bytes / 1024 ** 2).toFixed(1)} MB DAE ` +
              `in ${((Date.now() - t0) / 1000).toFixed(1)}s (server-path mode)`,
            );
            // Geometry probe: did Blender's Y-up→Z-up round-trip move/mirror the
            // mesh? glTF [x,y=up,z=south] should map to .dae [x, y=north(−z), z=up].
            // A wrong north sign shows as a mirrored Y span here — the horizontal,
            // BeamNG-only shift the browser placement can't see.
            try {
              const glbBBox = glbPositionBBox(readFileSync(resolved));
              const daeBBox = daePositionBBox(readFileSync(daePath, 'utf8'));
              tlog('dae-geometry', `blender ${path.basename(path.dirname(resolved))}: glbCXZ=[${glbBBox?.center[0]?.toFixed(2)},${glbBBox?.center[2]?.toFixed(2)}] → daeCXY=[${daeBBox?.center[0]?.toFixed(2)},${daeBBox?.center[1]?.toFixed(2)}]`, {
                stage: 'blender-dae',
                glbPath: resolved,
                glbBBox,   // glTF Y-up
                daeBBox,   // COLLADA Z-up
              });
            } catch { /* diagnostic only */ }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ daePath, bytes }));
          })().catch((err) => {
            console.warn('[beamng-blender-dae] conversion failed:', err?.message ?? err);
            res.statusCode = 500;
            res.end(String(err?.message ?? err));
          });
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
