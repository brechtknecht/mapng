// Conform test lab — a standalone HTTP server (own port, no Vite coupling) that
// drives the REAL app modules (conformTilesToFloor, sampleHeightAtScene,
// computeUnitsPerMeter) over a controllable Google-bake-shaped scene.
//
//   Browser (for Felix):  GET /                visual before/after + heatmap
//   Harness (for CI/me):  GET /api/conform     JSON stats — self-verifiable
//                         GET /api/field.png    real delta-field heatmap
//                         GET /api/scene.json   geometry before/after for the 3D view
//                         GET /api/health       liveness
//
// Run:  node tools/testlab/server.mjs   (PORT env overrides, default 5180)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conformTilesToFloor } from '../../services/tileGroundConform.js';
import { sampleHeightAtScene, computeUnitsPerMeter } from '../../services/googleBakeCore.js';
import { buildTestScene } from './scene.mjs';
import { fieldHeatmapPng } from './render.mjs';
import { listCaptures, loadCapture } from './captureStore.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = Number(process.env.PORT) || 5180;

const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

// Map query string → scene params (all optional, sensible defaults in scene.mjs).
const sceneParamsFrom = (q) => ({
  capture: q.get('capture') || null,
  base: num(q.get('base'), 1.2),
  tiltX: num(q.get('tiltX'), 0.6),
  tiltZ: num(q.get('tiltZ'), 0.3),
  wiggle: num(q.get('wiggle'), 0.4),
  gridN: Math.max(8, Math.min(96, num(q.get('gridN'), 56))),
});

// Source the scene: a REAL bake capture when requested, else the synthetic lab
// scene. Either way the conform that runs is the real app module.
const prepareScene = (params) => {
  if (params.capture) {
    const { data, soup, meta } = loadCapture(params.capture);
    return { data, soup, buildings: [], unitsPerMeter: computeUnitsPerMeter(data), source: 'capture', meta };
  }
  const s = buildTestScene(params);
  return { data: s.data, soup: s.soup, buildings: s.buildings, unitsPerMeter: s.unitsPerMeter, source: 'synthetic' };
};

// Global vertical extent (max−min Y over all verts), in metres. A flattening bug
// would collapse this; conform must preserve it (structures keep their height).
const verticalExtent = (soup) => {
  let mn = Infinity, mx = -Infinity;
  for (const m of soup) {
    const p = m.positions; if (!p) continue;
    for (let i = 1; i < p.length; i += 3) { if (p[i] < mn) mn = p[i]; if (p[i] > mx) mx = p[i]; }
  }
  return mx - mn;
};

const verticalExtentOf = (positionsArrays) => verticalExtent(positionsArrays.map((positions) => ({ positions })));

// Run the REAL conform over a generated/loaded scene and derive verifiable metrics.
const runScene = (params) => {
  const scene = prepareScene(params);
  const r = conformTilesToFloor(scene.soup, scene.data);
  const minH = scene.data.minHeight;
  const vExtentBefore = verticalExtent(scene.soup);
  const vExtentAfter = verticalExtentOf(scene.soup.map((m, i) => r.positions[i] || m.positions));

  const yExtent = (arr) => {
    let mn = Infinity, mx = -Infinity;
    for (let i = 1; i < arr.length; i += 3) { const y = arr[i]; if (y < mn) mn = y; if (y > mx) mx = y; }
    return { base: mn, top: mx };
  };

  // Building preservation: base must drop onto the floor, height must survive.
  const buildings = scene.buildings.map((b, bi) => {
    const soupIdx = bi + 1; // index 0 is the ground carpet
    const before = scene.soup[soupIdx].positions;
    const after = r.positions[soupIdx] || before;
    const terrAbove = sampleHeightAtScene(scene.data, b.cx, b.cz) - minH;
    const yb = yExtent(before), ya = yExtent(after);
    return {
      cx: b.cx, cz: b.cz,
      before: { baseAboveFloorM: yb.base - terrAbove, heightM: yb.top - yb.base },
      after: { baseAboveFloorM: ya.base - terrAbove, heightM: ya.top - ya.base },
    };
  });

  return { scene, r, buildings, vExtentBefore, vExtentAfter };
};

const sendJson = (res, obj, code = 200) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
};

const sendFile = (res, abs, type) => {
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  });
};

// Static assets we expose to the browser (offline — three served from node_modules).
const STATIC = {
  '/': [path.join(HERE, 'index.html'), 'text/html; charset=utf-8'],
  '/app.mjs': [path.join(HERE, 'app.mjs'), 'text/javascript; charset=utf-8'],
  '/vendor/three.module.js': [path.join(ROOT, 'node_modules/three/build/three.module.js'), 'text/javascript; charset=utf-8'],
  '/vendor/OrbitControls.js': [path.join(ROOT, 'node_modules/three/examples/jsm/controls/OrbitControls.js'), 'text/javascript; charset=utf-8'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (STATIC[p]) return sendFile(res, STATIC[p][0], STATIC[p][1]);

    if (p === '/api/health') return sendJson(res, { ok: true, port: PORT });

    if (p === '/api/captures') return sendJson(res, { captures: listCaptures() });

    if (p === '/api/conform') {
      const params = sceneParamsFrom(url.searchParams);
      const { r, buildings, scene, vExtentBefore, vExtentAfter } = runScene(params);
      return sendJson(res, {
        params,
        source: scene.source,
        stats: {
          vertsMoved: r.vertsMoved,
          meshesMoved: r.meshesMoved,
          cellsFilled: r.cellsFilled,
          groundResidualBeforeM: round(r.residualBefore),
          groundResidualAfterM: round(r.residualAfter),
          verticalExtentBeforeM: round(vExtentBefore),
          verticalExtentAfterM: round(vExtentAfter),
          fieldN: r.fieldN,
        },
        buildings: buildings.map((b) => ({
          at: [b.cx, b.cz],
          baseAboveFloor: { beforeM: round(b.before.baseAboveFloorM), afterM: round(b.after.baseAboveFloorM) },
          heightPreserved: { beforeM: round(b.before.heightM), afterM: round(b.after.heightM) },
        })),
      });
    }

    if (p === '/api/field.png') {
      const params = sceneParamsFrom(url.searchParams);
      const { r } = runScene(params);
      const { buffer } = fieldHeatmapPng(r.fieldValues, r.fieldN, { scale: 10 });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(Buffer.from(buffer));
    }

    if (p === '/api/scene.json') {
      const params = sceneParamsFrom(url.searchParams);
      const { scene, r, buildings, vExtentBefore, vExtentAfter } = runScene(params);
      // before/after positions per mesh; index shared (conform never re-indexes).
      const meshes = scene.soup.map((m, i) => ({
        kind: m.kind || (i === 0 && scene.source === 'synthetic' ? 'ground' : 'tile'),
        index: Array.from(m.index),
        before: Array.from(m.positions),
        after: Array.from(r.positions[i] || m.positions),
      }));
      return sendJson(res, {
        params,
        source: scene.source,
        unitsPerMeter: scene.unitsPerMeter,
        minHeight: scene.data.minHeight,
        terrain: { width: scene.data.width, height: scene.data.height, heightMap: Array.from(scene.data.heightMap) },
        meshes,
        field: { n: r.fieldN, values: Array.from(r.fieldValues) },
        stats: {
          groundResidualBeforeM: round(r.residualBefore),
          groundResidualAfterM: round(r.residualAfter),
          verticalExtentBeforeM: round(vExtentBefore),
          verticalExtentAfterM: round(vExtentAfter),
          vertsMoved: r.vertsMoved, cellsFilled: r.cellsFilled,
        },
        buildings,
      });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`no route: ${p}`);
  } catch (err) {
    sendJson(res, { error: String(err && err.stack || err) }, 500);
  }
});

function round(v) { return Math.round(v * 1000) / 1000; }

server.listen(PORT, () => {
  console.log(`[testlab] conform lab on http://localhost:${PORT}  (open / in a browser)`);
});
