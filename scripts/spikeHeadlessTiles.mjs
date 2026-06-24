// Spike: prove 3d-tiles-renderer 0.3.46 can run a Google Photorealistic 3D
// Tiles selection + parse loop headless in Node, with texture DECODE skipped
// entirely (raw JPEG bytes captured off the GLB instead).
//
// Usage:  node scripts/spikeHeadlessTiles.mjs [lat lng extentM]
// Reads VITE_GOOGLE_MAPS_API_KEY from .env.local.
//
// Exit criteria (see plan):
//  - root tileset loads through GoogleCloudAuthPlugin
//  - camera-driven selection refines to a plausible tile count at errorTarget=5
//  - parsed scenes carry geometry + captured compressed image bytes
//  - a second camera station re-selects without re-instantiating anything

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
// Polyfills + resolve hook + DOM-free deep imports of the tiles library —
// never import the '3d-tiles-renderer' package indices in Node.
import {
  TilesRenderer,
  GoogleCloudAuthPlugin,
  WGS84_ELLIPSOID,
  installCaptureLoader,
  getCapturedImage,
} from './headlessTilesEnv.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readApiKey = () => {
  const env = readFileSync(path.join(ROOT, '.env.local'), 'utf8');
  const m = env.match(/^VITE_GOOGLE_MAPS_API_KEY=(.+)$/m);
  if (!m) throw new Error('VITE_GOOGLE_MAPS_API_KEY not found in .env.local');
  return m[1].trim();
};

// --- main --------------------------------------------------------------------
const [latArg, lngArg, extentArg] = process.argv.slice(2);
const centerLat = Number(latArg ?? 52.5163); // Brandenburg Gate
const centerLng = Number(lngArg ?? 13.3777);
const extentM = Number(extentArg ?? 1000);

const apiKey = readApiKey();
const latRad = (centerLat * Math.PI) / 180;
const lonRad = (centerLng * Math.PI) / 180;

const tiles = new TilesRenderer();
tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
tiles.errorTarget = 5;
tiles.lruCache.minBytesSize = 1.0 * 1024 ** 3;
tiles.lruCache.maxBytesSize = 1.5 * 1024 ** 3;
tiles.downloadQueue.maxJobs = 32;
tiles.parseQueue.maxJobs = 8;
tiles.downloadQueue.schedulingCallback = (fn) => setImmediate(fn);
tiles.parseQueue.schedulingCallback = (fn) => setImmediate(fn);

installCaptureLoader(tiles);

// Camera: the bake's top-down station.
const centerEcef = new THREE.Vector3();
WGS84_ELLIPSOID.getCartographicToPosition(latRad, lonRad, 0, centerEcef);
const upDir = centerEcef.clone().normalize();
const eastDir = new THREE.Vector3(0, 0, 1).cross(upDir).normalize();
const northDir = upDir.clone().cross(eastDir).normalize();

const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e9);
cam.up.copy(upDir);
cam.position.copy(centerEcef).addScaledVector(upDir, extentM * 1.5 + 200);
cam.lookAt(centerEcef);
cam.updateMatrixWorld(true);

tiles.setCamera(cam);
tiles.setResolution(cam, 1024, 1024);

let loadError = null;
tiles.addEventListener('load-error', (e) => { loadError = e; });

const waitForQuiet = (label, { stabilityMs = 2500, timeoutMs = 180000 } = {}) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    let lastChange = started;
    let lastVisible = -1;
    let sawActivity = false;
    const iv = setInterval(() => {
      if (loadError) { clearInterval(iv); reject(new Error(`load-error: ${loadError.error ?? loadError}`)); return; }
      try {
        tiles.update();
      } catch (e) { clearInterval(iv); reject(e); return; }

      const downloading = tiles.stats?.downloading ?? 0;
      const parsing = tiles.stats?.parsing ?? 0;
      if (downloading + parsing > 0) sawActivity = true;
      let visible = 0;
      tiles.group.traverse((o) => { if (o.isMesh) visible++; });
      if (visible !== lastVisible) { lastVisible = visible; lastChange = performance.now(); }

      const now = performance.now();
      if (now - started > timeoutMs) { clearInterval(iv); reject(new Error(`${label}: timed out after ${timeoutMs}ms`)); return; }
      const quietMs = sawActivity ? stabilityMs : 1500;
      if (downloading === 0 && parsing === 0 && now - lastChange > quietMs && visible > 0) {
        clearInterval(iv);
        resolve({ visible, elapsed: (now - started) / 1000 });
      }
    }, 16);
  });

const report = (label) => {
  let meshes = 0;
  let geomBytes = 0;
  let texCount = 0;
  let texBytes = 0;
  let texMissing = 0;
  let sampleJpeg = null;
  for (const tile of tiles.visibleTiles) {
    tile.cached?.scene?.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      for (const attr of Object.values(o.geometry.attributes)) geomBytes += attr.array.byteLength;
      if (o.geometry.index) geomBytes += o.geometry.index.array.byteLength;
      const img = getCapturedImage(o.material?.map);
      if (img) {
        texCount++;
        texBytes += img.bytes.byteLength;
        if (!sampleJpeg) sampleJpeg = img;
      } else if (o.material?.map) {
        texMissing++;
      }
    });
  }
  const mem = process.memoryUsage();
  console.log(
    `[spike] ${label}: ${tiles.visibleTiles.size} tiles, ${meshes} meshes, ` +
    `geom=${(geomBytes / 1024 ** 2).toFixed(1)}MB, textures=${texCount} (${(texBytes / 1024 ** 2).toFixed(1)}MB compressed, ${texMissing} missing bytes), ` +
    `rss=${(mem.rss / 1024 ** 2).toFixed(0)}MB heap=${(mem.heapUsed / 1024 ** 2).toFixed(0)}MB`,
  );
  return sampleJpeg;
};

console.log(`[spike] AOI ${centerLat},${centerLng} extent=${extentM}m errorTarget=5 sensor=1024px`);
const t0 = performance.now();

const r1 = await waitForQuiet('station 1 (top-down)');
console.log(`[spike] station 1 quiet after ${r1.elapsed.toFixed(1)}s, ${r1.visible} visible meshes`);
const sample = report('station 1');

// Station 2: oblique from the north — verifies camera moves re-drive selection.
cam.position.copy(centerEcef)
  .addScaledVector(northDir, extentM * 1.1)
  .addScaledVector(upDir, extentM * 0.8);
cam.lookAt(centerEcef);
cam.updateMatrixWorld(true);

const r2 = await waitForQuiet('station 2 (oblique north)');
console.log(`[spike] station 2 quiet after ${r2.elapsed.toFixed(1)}s, ${r2.visible} visible meshes`);
report('station 2');

if (sample) {
  const magic = sample.bytes.subarray(0, 3);
  const isJpeg = magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff;
  const isPng = magic[0] === 0x89 && magic[1] === 0x50;
  const out = path.join(ROOT, 'spike-sample-texture' + (isPng ? '.png' : '.jpg'));
  writeFileSync(out, sample.bytes);
  console.log(
    `[spike] sample texture: ${sample.mimeType}, ${sample.bytes.byteLength} bytes, ` +
    `magic=${isJpeg ? 'JPEG ✓' : isPng ? 'PNG ✓' : 'UNKNOWN ✗'} → ${out}`,
  );
}

console.log(`[spike] total ${(performance.now() - t0) / 1000 | 0}s — SUCCESS`);
tiles.dispose();
process.exit(0);
