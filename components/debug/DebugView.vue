<template>
  <div class="w-full h-full relative">
    <canvas ref="canvasRef" class="w-full h-full block" @click="requestPointerLock" />

    <!-- Stats overlay (top-left) -->
    <div class="absolute top-4 left-4 bg-black/85 text-white text-xs font-mono p-3 rounded-lg pointer-events-none space-y-0.5 min-w-[260px]">
      <div class="font-bold text-[#ff6655] mb-1">Junction analysis</div>
      <div>Network segments: <span class="text-white">{{ stats.segmentCount }}</span></div>
      <div>Intersection nodes: <span class="text-white">{{ stats.intersectionCount }}</span></div>
      <div>Junctions emitted: <span class="text-white font-bold">{{ stats.junctionCount }}</span></div>
      <div v-if="stats.junctionCount > 0">Polygon verts (min/avg/max): <span class="text-white">{{ stats.minPolyVerts }}/{{ stats.avgPolyVerts.toFixed(1) }}/{{ stats.maxPolyVerts }}</span></div>
      <div class="mt-1 pt-1 border-t border-white/20" v-if="stats.junctionCount > 0">
        <div v-if="stats.degree3 > 0">3-way: <span class="text-white">{{ stats.degree3 }}</span></div>
        <div v-if="stats.degree4 > 0">4-way: <span class="text-white">{{ stats.degree4 }}</span></div>
        <div v-if="stats.degreeMore > 0">5+ way: <span class="text-white">{{ stats.degreeMore }}</span></div>
      </div>

      <div class="font-bold text-[#ff6655] mb-1 mt-3 pt-2 border-t border-white/20">MeshRoad anomalies</div>
      <div>Roads emitted: <span class="text-white">{{ stats.meshRoadCount }}</span></div>
      <div>
        Errors:
        <span :class="stats.meshRoadErrors > 0 ? 'text-[#ff5566] font-bold' : 'text-white/60'">{{ stats.meshRoadErrors }}</span>
        · Warnings:
        <span :class="stats.meshRoadWarnings > 0 ? 'text-[#ffaa44]' : 'text-white/60'">{{ stats.meshRoadWarnings }}</span>
      </div>
      <div v-for="(count, type) in stats.anomaliesByType" :key="type" class="text-white/80">
        · {{ type }}: <span class="text-white">{{ count }}</span>
      </div>
      <div v-if="stats.meshRoadErrors + stats.meshRoadWarnings > 0" class="mt-1 pt-1 text-white/60 text-[10px]">
        Pylons mark anomaly sites (red = error, amber = warn). Flagged roads are yellow.
      </div>
    </div>

    <!-- Anomaly list panel (bottom-left, clickable to copy) -->
    <div
      v-if="errorAnomalies.length > 0 || warnAnomalies.length > 0"
      class="absolute bottom-4 left-4 bg-black/85 text-white text-xs font-mono p-3 rounded-lg w-[460px] max-h-[55vh] flex flex-col"
    >
      <div class="flex items-center justify-between mb-2 pb-2 border-b border-white/15 gap-2">
        <div class="font-bold text-[#ff5566] whitespace-nowrap">
          Errors {{ errorAnomalies.length }}
          <span v-if="warnAnomalies.length > 0" class="text-[#ffaa44] font-normal text-[10px] ml-1">+{{ warnAnomalies.length }} warn</span>
        </div>
        <button
          class="text-[10px] px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 transition whitespace-nowrap"
          @click="logToConsole"
          title="Dump full report to dev console (filterable via DevTools)"
        >
          Log
        </button>
        <button
          class="text-[10px] px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 transition whitespace-nowrap"
          @click="copyAllErrors"
          title="Copy all errors as JSON"
        >
          Copy all
        </button>
      </div>
      <div class="mb-2">
        <input
          v-model="filterText"
          type="text"
          placeholder="Filter by road / type / message…"
          class="w-full px-2 py-1 text-[11px] bg-white/10 text-white placeholder:text-white/40 rounded border border-white/15 focus:outline-none focus:border-white/40"
        />
        <div v-if="filterText" class="text-[10px] text-white/50 mt-1">
          Showing {{ filteredErrors.length + filteredWarns.length }} of {{ errorAnomalies.length + warnAnomalies.length }}
        </div>
      </div>
      <div
        v-if="copiedFeedback"
        class="text-[#9aff88] text-[10px] mb-1 font-bold"
      >
        ✓ {{ copiedFeedback }}
      </div>
      <ul class="overflow-y-auto flex-1 space-y-px pr-1">
        <li
          v-for="(entry, idx) in filteredErrors"
          :key="`e${idx}`"
          @click="copyIssue(entry)"
          class="cursor-pointer hover:bg-white/10 active:bg-white/20 px-1.5 py-0.5 rounded select-none flex items-baseline gap-1.5"
          :title="'Click to copy JSON'"
        >
          <span class="text-[#ff5566] flex-shrink-0">●</span>
          <span class="text-[#ff8855] flex-shrink-0">{{ entry.road }}</span>
          <span class="text-white/90 flex-shrink-0">{{ entry.type }}</span>
          <span class="text-white/60 truncate text-[10px]">{{ entry.message }}</span>
        </li>
        <li
          v-for="(entry, idx) in filteredWarns"
          :key="`w${idx}`"
          @click="copyIssue(entry)"
          class="cursor-pointer hover:bg-white/10 active:bg-white/20 px-1.5 py-0.5 rounded select-none flex items-baseline gap-1.5"
          :title="'Click to copy JSON'"
        >
          <span class="text-[#ffaa44] flex-shrink-0">●</span>
          <span class="text-[#ffcc88] flex-shrink-0">{{ entry.road }}</span>
          <span class="text-white/80 flex-shrink-0">{{ entry.type }}</span>
          <span class="text-white/60 truncate text-[10px]">{{ entry.message }}</span>
        </li>
        <li
          v-if="filteredErrors.length + filteredWarns.length === 0"
          class="text-white/40 text-center py-2 italic"
        >
          No matches for "{{ filterText }}"
        </li>
      </ul>
    </div>

    <!-- Layer toggles (top center) -->
    <div class="absolute top-4 left-1/2 -translate-x-1/2 bg-black/85 text-white text-xs p-3 rounded-lg flex gap-4 items-center pointer-events-auto" @click.stop>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="showRoads" /> Road slabs</label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="showJunctions" /> Junctions</label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="showCenterlines" /> Centerlines</label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="wireframe" /> Wireframe</label>
    </div>

    <!-- Help (bottom-right) -->
    <div class="absolute bottom-4 right-4 bg-black/85 text-white/80 text-xs font-mono p-3 rounded-lg pointer-events-none space-y-0.5">
      <div class="font-bold text-[#ff6655] mb-1">Controls</div>
      <div>Click canvas: capture mouse</div>
      <div>Mouse: look around</div>
      <div>W A S D: move horizontally</div>
      <div>Space / Ctrl: up / down</div>
      <div>Shift: sprint (5×)</div>
      <div>Esc: release mouse</div>
    </div>

    <!-- Click-to-activate overlay -->
    <div
      v-if="!pointerLocked"
      class="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none"
    >
      <div class="bg-black/85 text-white text-base px-6 py-4 rounded-lg shadow-2xl border border-white/20">
        Click anywhere to fly · Esc to release
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue';
import * as THREE from 'three';
import { buildMeshRoadAnalysis, generateMeshRoads } from '../../services/exportBeamNGLevel.js';
import { buildJunctionMeshGroup } from '../../services/junctionMesh.js';
import { scanAllMeshRoads } from '../../services/meshRoadAnomalies.js';

const props = defineProps({
  terrainData: { type: Object, required: true },
});

const canvasRef = ref(null);
const showRoads = ref(true);
const showJunctions = ref(true);
const showCenterlines = ref(false);
const wireframe = ref(false);
const pointerLocked = ref(false);

const stats = ref({
  segmentCount: 0,
  intersectionCount: 0,
  junctionCount: 0,
  minPolyVerts: 0,
  avgPolyVerts: 0,
  maxPolyVerts: 0,
  degree3: 0,
  degree4: 0,
  degreeMore: 0,
  meshRoadCount: 0,
  meshRoadErrors: 0,
  meshRoadWarnings: 0,
  anomaliesByType: {},
});

// Full anomaly report from the scanner, used to populate the clickable
// anomaly panel below. Stored separately from `stats` because it holds raw
// nested data we iterate in the template.
const anomalyReport = shallowRef({ anomalies: [] });
const copiedFeedback = ref('');
let copiedTimeout = null;

const filterText = ref('');

const errorAnomalies = computed(() => {
  const out = [];
  for (const anomaly of anomalyReport.value.anomalies || []) {
    for (const issue of anomaly.issues) {
      if (issue.severity === 'error') {
        out.push({ road: anomaly.name, ...issue });
      }
    }
  }
  return out;
});

const warnAnomalies = computed(() => {
  const out = [];
  for (const anomaly of anomalyReport.value.anomalies || []) {
    for (const issue of anomaly.issues) {
      if (issue.severity === 'warn') {
        out.push({ road: anomaly.name, ...issue });
      }
    }
  }
  return out;
});

function matchesFilter(entry) {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return true;
  return (
    (entry.road || '').toLowerCase().includes(q) ||
    (entry.type || '').toLowerCase().includes(q) ||
    (entry.message || '').toLowerCase().includes(q)
  );
}

const filteredErrors = computed(() => errorAnomalies.value.filter(matchesFilter));
const filteredWarns = computed(() => warnAnomalies.value.filter(matchesFilter));

function showCopied(label) {
  copiedFeedback.value = label;
  if (copiedTimeout) clearTimeout(copiedTimeout);
  copiedTimeout = setTimeout(() => { copiedFeedback.value = ''; }, 1800);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    showCopied(label || 'Copied to clipboard');
  } catch (err) {
    // Fallback for environments without clipboard API (insecure context, etc.)
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); showCopied(label || 'Copied (legacy)'); }
    catch { showCopied('Copy failed — see console'); console.error(err); }
    finally { document.body.removeChild(ta); }
  }
}

function copyIssue(entry) {
  const payload = {
    road: entry.road,
    type: entry.type,
    severity: entry.severity,
    message: entry.message,
    location: entry.location,
    nodeIndex: entry.nodeIndex,
    ...(entry.xyDist !== undefined ? { xyDist: entry.xyDist } : {}),
    ...(entry.zChange !== undefined ? { zChange: entry.zChange } : {}),
    ...(entry.turnDeg !== undefined ? { turnDeg: entry.turnDeg } : {}),
    ...(entry.widthA !== undefined ? { widthA: entry.widthA, widthB: entry.widthB } : {}),
  };
  copyText(JSON.stringify(payload, null, 2), `Copied ${entry.road}`);
}

function copyAllErrors() {
  const list = errorAnomalies.value;
  if (list.length === 0) { showCopied('No errors to copy'); return; }
  const payload = list.map((e) => ({
    road: e.road,
    type: e.type,
    message: e.message,
    location: e.location,
    nodeIndex: e.nodeIndex,
  }));
  copyText(JSON.stringify(payload, null, 2), `Copied ${list.length} errors`);
}

/**
 * Dump the full anomaly report to the dev console as filterable tables.
 * DevTools has its own filter input on the Console tab — `console.table` is
 * grep-friendly there. One row per issue, columns: road, type, message, x, y, z.
 */
function logToConsole() {
  const errs = errorAnomalies.value;
  const warns = warnAnomalies.value;
  const toRow = (e) => ({
    road: e.road,
    type: e.type,
    message: e.message,
    x: Array.isArray(e.location) ? Math.round(e.location[0] * 100) / 100 : null,
    y: Array.isArray(e.location) ? Math.round(e.location[1] * 100) / 100 : null,
    z: Array.isArray(e.location) ? Math.round(e.location[2] * 100) / 100 : null,
    nodeIndex: e.nodeIndex,
  });
  console.groupCollapsed(
    `%c[MeshRoad anomalies]%c ${errs.length} errors, ${warns.length} warnings`,
    'color:#ff5566;font-weight:bold',
    'color:inherit',
  );
  if (errs.length > 0) {
    console.warn(`Errors (${errs.length}):`);
    console.table(errs.map(toRow));
  }
  if (warns.length > 0) {
    console.info(`Warnings (${warns.length}):`);
    console.table(warns.map(toRow));
  }
  console.groupEnd();
  showCopied(`Logged ${errs.length + warns.length} to console`);
}

let scene;
let camera;
let renderer;
let animId = 0;
const roadsGroup = shallowRef(null);
const junctionsGroup = shallowRef(null);
const centerlinesGroup = shallowRef(null);
const anomaliesGroup = shallowRef(null);

// ── Flycam state ─────────────────────────────────────────────────────────
// Yaw rotates around world +Z (BeamNG up). Pitch is local elevation.
// yaw = 0 → looking toward +X. Pitch limited to (-π/2, π/2) exclusive.
let yaw = Math.PI / 2;     // start looking +Y (north)
let pitch = -0.4;          // ~22° down
const MOUSE_SENSITIVITY = 0.0022;
const BASE_SPEED = 30;     // m/s
const SPRINT_MULTIPLIER = 5;
const keys = { fwd: false, back: false, left: false, right: false, up: false, down: false, sprint: false };
let lastTime = 0;

onMounted(() => {
  setupScene();
  rebuildScene();
  attachInputHandlers();
  animate(performance.now());
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animId);
  window.removeEventListener('resize', onResize);
  detachInputHandlers();
  if (document.pointerLockElement === canvasRef.value) document.exitPointerLock();
  disposeAll();
});

watch(() => props.terrainData, () => rebuildScene());
watch([showRoads, showJunctions, showCenterlines, wireframe], updateVisibility);

function setupScene() {
  const canvas = canvasRef.value;
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 600;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a14);

  camera = new THREE.PerspectiveCamera(60, w / h, 0.5, 50000);
  camera.up.set(0, 0, 1); // BeamNG: Z is up
  camera.position.set(0, -100, 60);
  applyOrientation();

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(200, -150, 400);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0x99aaff, 0.25);
  dir2.position.set(-300, 200, 200);
  scene.add(dir2);

  scene.add(new THREE.AxesHelper(30));
}

function rebuildScene() {
  for (const g of [roadsGroup.value, junctionsGroup.value, centerlinesGroup.value, anomaliesGroup.value]) {
    if (g) {
      scene.remove(g);
      disposeGroup(g);
    }
  }
  roadsGroup.value = null;
  junctionsGroup.value = null;
  centerlinesGroup.value = null;
  anomaliesGroup.value = null;

  const analysis = buildMeshRoadAnalysis(props.terrainData);
  if (!analysis) {
    stats.value = {
      segmentCount: 0, intersectionCount: 0, junctionCount: 0,
      minPolyVerts: 0, avgPolyVerts: 0, maxPolyVerts: 0,
      degree3: 0, degree4: 0, degreeMore: 0,
    };
    return;
  }

  const { roadNetwork, segmentInfo, junctions } = analysis;

  // Frame the camera near the centroid of all junctions (or roads as fallback).
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const j of junctions) { cx += j.position[0]; cy += j.position[1]; n++; }
  if (n === 0) {
    for (const [, info] of segmentInfo) {
      for (const p of info.worldGeometry) { cx += p[0]; cy += p[1]; n++; }
    }
  }
  if (n > 0) {
    cx /= n;
    cy /= n;
    // Position the camera 100 m south and 80 m above the centroid, looking
    // toward it. Y is "north" in BeamNG world coords, so −Y from centroid =
    // south side. Yaw is set so we face +Y (north).
    camera.position.set(cx, cy - 100, 80);
    yaw = Math.PI / 2;
    pitch = -0.5;
    applyOrientation();
  }

  // Stats: polygon vertex distribution and degree histogram.
  const polyCounts = junctions.map((j) => j.polygon.length);
  let deg3 = 0;
  let deg4 = 0;
  let degN = 0;
  for (const j of junctions) {
    if (j.degree === 3) deg3++;
    else if (j.degree === 4) deg4++;
    else if (j.degree >= 5) degN++;
  }
  // Run the export's MeshRoad emitter on the SAME terrain so we see exactly
  // what will be exported (same clip-back, decimation, end-edge prune). Then
  // scan for known-bad geometric patterns.
  const { meshRoads } = generateMeshRoads(props.terrainData, analysis.squareSize);
  const report = scanAllMeshRoads(meshRoads);
  anomalyReport.value = report;
  const anomalousRoadNames = new Set(report.anomalies.map((a) => a.name));

  stats.value = {
    segmentCount: roadNetwork.segments.length,
    intersectionCount: roadNetwork.intersections.size,
    junctionCount: junctions.length,
    minPolyVerts: polyCounts.length ? Math.min(...polyCounts) : 0,
    avgPolyVerts: polyCounts.length ? polyCounts.reduce((a, b) => a + b, 0) / polyCounts.length : 0,
    maxPolyVerts: polyCounts.length ? Math.max(...polyCounts) : 0,
    degree3: deg3,
    degree4: deg4,
    degreeMore: degN,
    meshRoadCount: meshRoads.length,
    meshRoadErrors: report.errors,
    meshRoadWarnings: report.warnings,
    anomaliesByType: report.issuesByType,
  };

  // Mark the spots where each anomaly was detected with a bright vertical
  // bar — fly toward one to inspect what went wrong with that MeshRoad.
  const anomalyMarkers = buildAnomalyMarkers(report);
  if (anomalyMarkers) { scene.add(anomalyMarkers); anomaliesGroup.value = anomalyMarkers; }

  const roads = buildRoadSlabsGroup(meshRoads, anomalousRoadNames);
  if (roads) { scene.add(roads); roadsGroup.value = roads; }
  const jGroup = buildJunctionMeshGroup(junctions, { depth: analysis.surfaceLift });
  if (jGroup) {
    jGroup.traverse((c) => {
      if (c.isMesh) {
        c.material = new THREE.MeshLambertMaterial({
          color: 0xff2255,
          emissive: 0x441122,
          side: THREE.DoubleSide,
        });
      }
    });
    scene.add(jGroup);
    junctionsGroup.value = jGroup;
  }
  const lines = buildCenterlinesGroup(segmentInfo);
  if (lines) { scene.add(lines); centerlinesGroup.value = lines; }

  updateVisibility();
}

/**
 * Build slab meshes directly from the export's emitted MeshRoad objects, so
 * what's shown in the debug view is byte-identical (clip-back, decimation,
 * end-edge prune) to what will end up in the BeamNG level. Roads flagged by
 * the anomaly scanner are drawn in saturated yellow so they stand out for
 * easy fly-to inspection.
 */
function buildRoadSlabsGroup(meshRoads, anomalousNames) {
  if (!Array.isArray(meshRoads) || meshRoads.length === 0) return null;
  const group = new THREE.Group();
  group.name = 'road_slabs';
  const cleanMaterial = new THREE.MeshLambertMaterial({ color: 0x555560 });
  const badMaterial = new THREE.MeshLambertMaterial({
    color: 0xffcc22,
    emissive: 0x553300,
  });
  let any = false;
  for (const mr of meshRoads) {
    const nodes = mr?.nodes;
    if (!Array.isArray(nodes) || nodes.length < 2) continue;
    const centerline = nodes.map((n) => [n[0], n[1], n[2]]);
    const halfWidth = (nodes[0][3] || 0) / 2;
    const depth = Number.isFinite(nodes[0][4]) ? nodes[0][4] : 0.5;
    if (halfWidth <= 0) continue;
    const geom = buildSlabGeometry(centerline, halfWidth, depth);
    if (!geom) continue;
    const isBad = anomalousNames.has(mr.name);
    group.add(new THREE.Mesh(geom, isBad ? badMaterial : cleanMaterial));
    any = true;
  }
  return any ? group : null;
}

/**
 * Place a vertical pylon marker at each anomaly location. Errors are red
 * pylons; warnings are amber. Fly the camera near a pylon to inspect why
 * that MeshRoad got flagged.
 */
function buildAnomalyMarkers(report) {
  if (!report?.anomalies?.length) return null;
  const group = new THREE.Group();
  group.name = 'anomaly_markers';
  const errorMat = new THREE.MeshBasicMaterial({ color: 0xff3344 });
  const warnMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
  const pylonGeom = new THREE.BoxGeometry(0.5, 0.5, 8);
  let any = false;
  for (const anomaly of report.anomalies) {
    for (const issue of anomaly.issues) {
      if (!Array.isArray(issue.location) || issue.location.length < 3) continue;
      const mat = issue.severity === 'error' ? errorMat : warnMat;
      const mesh = new THREE.Mesh(pylonGeom, mat);
      mesh.position.set(issue.location[0], issue.location[1], issue.location[2] + 4);
      group.add(mesh);
      any = true;
    }
  }
  return any ? group : null;
}

function buildSlabGeometry(centerline, halfWidth, depth) {
  if (!Array.isArray(centerline) || centerline.length < 2) return null;
  const positions = [];
  for (let i = 0; i < centerline.length; i++) {
    const p = centerline[i];
    let tx;
    let ty;
    if (i === 0) {
      tx = centerline[1][0] - p[0];
      ty = centerline[1][1] - p[1];
    } else if (i === centerline.length - 1) {
      tx = p[0] - centerline[i - 1][0];
      ty = p[1] - centerline[i - 1][1];
    } else {
      tx = centerline[i + 1][0] - centerline[i - 1][0];
      ty = centerline[i + 1][1] - centerline[i - 1][1];
    }
    const len = Math.hypot(tx, ty);
    if (len < 1e-6) return null;
    const nx = (-ty / len) * halfWidth;
    const ny = (tx / len) * halfWidth;
    positions.push(p[0] + nx, p[1] + ny, p[2]);
    positions.push(p[0] - nx, p[1] - ny, p[2]);
    positions.push(p[0] + nx, p[1] + ny, p[2] - depth);
    positions.push(p[0] - nx, p[1] - ny, p[2] - depth);
  }
  const N = positions.length / 12;
  if (N < 2) return null;
  const indices = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    const tlA = a;
    const trA = a + 1;
    const blA = a + 2;
    const brA = a + 3;
    const tlB = b;
    const trB = b + 1;
    const blB = b + 2;
    const brB = b + 3;
    indices.push(tlA, trA, trB, tlA, trB, tlB);
    indices.push(brA, blA, blB, brA, blB, brB);
    indices.push(tlA, blA, blB, tlA, blB, tlB);
    indices.push(trB, brB, brA, trB, brA, trA);
  }
  indices.push(0, 2, 3, 0, 3, 1);
  const tE = (N - 1) * 4;
  indices.push(tE + 1, tE + 3, tE + 2, tE + 1, tE + 2, tE);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildCenterlinesGroup(segmentInfo) {
  const group = new THREE.Group();
  group.name = 'centerlines';
  const material = new THREE.LineBasicMaterial({ color: 0xffeecc, transparent: true, opacity: 0.7 });
  let any = false;
  for (const [, info] of segmentInfo) {
    const pts = info.worldGeometry.map((p) => new THREE.Vector3(p[0], p[1], p[2] + 0.1));
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(geom, material));
    any = true;
  }
  return any ? group : null;
}

function updateVisibility() {
  if (roadsGroup.value) roadsGroup.value.visible = showRoads.value;
  if (junctionsGroup.value) junctionsGroup.value.visible = showJunctions.value;
  if (centerlinesGroup.value) centerlinesGroup.value.visible = showCenterlines.value;
  for (const g of [roadsGroup.value, junctionsGroup.value]) {
    if (!g) continue;
    g.traverse((c) => {
      if (c.isMesh && c.material) {
        if (Array.isArray(c.material)) {
          c.material.forEach((m) => { m.wireframe = wireframe.value; });
        } else {
          c.material.wireframe = wireframe.value;
        }
      }
    });
  }
}

// ── Flycam input ─────────────────────────────────────────────────────────

function attachInputHandlers() {
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
}

function detachInputHandlers() {
  document.removeEventListener('pointerlockchange', onPointerLockChange);
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('keydown', onKeyDown);
  document.removeEventListener('keyup', onKeyUp);
}

function requestPointerLock() {
  if (document.pointerLockElement === canvasRef.value) return;
  canvasRef.value?.requestPointerLock?.();
}

function onPointerLockChange() {
  pointerLocked.value = document.pointerLockElement === canvasRef.value;
  if (!pointerLocked.value) {
    // Clear pressed-key state so a key held while Esc is pressed doesn't
    // remain "stuck" once we regain focus.
    for (const k of Object.keys(keys)) keys[k] = false;
  }
}

function onMouseMove(e) {
  if (!pointerLocked.value) return;
  yaw -= e.movementX * MOUSE_SENSITIVITY;
  pitch -= e.movementY * MOUSE_SENSITIVITY;
  const limit = Math.PI / 2 - 0.01;
  if (pitch > limit) pitch = limit;
  if (pitch < -limit) pitch = -limit;
  applyOrientation();
}

function onKeyDown(e) {
  if (!pointerLocked.value) return;
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.fwd = true; break;
    case 'KeyS': case 'ArrowDown': keys.back = true; break;
    case 'KeyA': case 'ArrowLeft': keys.left = true; break;
    case 'KeyD': case 'ArrowRight': keys.right = true; break;
    case 'Space': keys.up = true; e.preventDefault(); break;
    case 'ControlLeft': case 'ControlRight': keys.down = true; e.preventDefault(); break;
    case 'ShiftLeft': case 'ShiftRight': keys.sprint = true; break;
    default: return;
  }
}

function onKeyUp(e) {
  switch (e.code) {
    case 'KeyW': case 'ArrowUp': keys.fwd = false; break;
    case 'KeyS': case 'ArrowDown': keys.back = false; break;
    case 'KeyA': case 'ArrowLeft': keys.left = false; break;
    case 'KeyD': case 'ArrowRight': keys.right = false; break;
    case 'Space': keys.up = false; break;
    case 'ControlLeft': case 'ControlRight': keys.down = false; break;
    case 'ShiftLeft': case 'ShiftRight': keys.sprint = false; break;
    default: return;
  }
}

/**
 * Apply yaw/pitch to the camera by computing a forward direction and using
 * camera.lookAt with the Z-up convention. lookAt handles roll/up correctly
 * as long as camera.up is set.
 */
function applyOrientation() {
  if (!camera) return;
  const cosP = Math.cos(pitch);
  const fwdX = Math.cos(yaw) * cosP;
  const fwdY = Math.sin(yaw) * cosP;
  const fwdZ = Math.sin(pitch);
  camera.lookAt(
    camera.position.x + fwdX,
    camera.position.y + fwdY,
    camera.position.z + fwdZ,
  );
}

/**
 * Per-frame motion update. Yaw/pitch define forward; the right vector is the
 * horizontal perpendicular (XY plane only, so strafing never drifts up/down).
 */
function applyMotion(deltaSec) {
  if (!pointerLocked.value) return;
  const speed = (keys.sprint ? SPRINT_MULTIPLIER : 1) * BASE_SPEED;
  const step = speed * deltaSec;

  const cosP = Math.cos(pitch);
  const fwdX = Math.cos(yaw) * cosP;
  const fwdY = Math.sin(yaw) * cosP;
  const fwdZ = Math.sin(pitch);
  // Right vector relative to yaw, kept horizontal so strafing doesn't drift.
  const rightX = Math.sin(yaw);
  const rightY = -Math.cos(yaw);

  if (keys.fwd)   { camera.position.x += fwdX * step;  camera.position.y += fwdY * step;  camera.position.z += fwdZ * step; }
  if (keys.back)  { camera.position.x -= fwdX * step;  camera.position.y -= fwdY * step;  camera.position.z -= fwdZ * step; }
  if (keys.right) { camera.position.x += rightX * step; camera.position.y += rightY * step; }
  if (keys.left)  { camera.position.x -= rightX * step; camera.position.y -= rightY * step; }
  if (keys.up)    { camera.position.z += step; }
  if (keys.down)  { camera.position.z -= step; }

  if (keys.fwd || keys.back || keys.left || keys.right || keys.up || keys.down) {
    applyOrientation();
  }
}

function animate(now) {
  animId = requestAnimationFrame(animate);
  const deltaSec = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 0;
  lastTime = now;
  applyMotion(deltaSec);
  if (scene && camera && renderer) renderer.render(scene, camera);
}

function onResize() {
  if (!canvasRef.value || !camera || !renderer) return;
  const w = canvasRef.value.clientWidth;
  const h = canvasRef.value.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function disposeAll() {
  if (renderer) renderer.dispose();
  if (scene) disposeGroup(scene);
}

function disposeGroup(g) {
  g.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) {
      if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose());
      else c.material.dispose();
    }
  });
}
</script>
