<template>
  <div class="w-full h-full relative" @click="requestPointerLock">
    <canvas ref="canvasRef" class="w-full h-full block" />

    <!-- Stats overlay (top-left) -->
    <div class="absolute top-4 left-4 bg-black/85 text-white text-xs font-mono p-3 rounded-lg pointer-events-none space-y-0.5 min-w-[220px]">
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
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue';
import * as THREE from 'three';
import { buildMeshRoadAnalysis } from '../../services/exportBeamNGLevel.js';
import { buildJunctionMeshGroup } from '../../services/junctionMesh.js';

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
});

let scene;
let camera;
let renderer;
let animId = 0;
const roadsGroup = shallowRef(null);
const junctionsGroup = shallowRef(null);
const centerlinesGroup = shallowRef(null);

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
  for (const g of [roadsGroup.value, junctionsGroup.value, centerlinesGroup.value]) {
    if (g) {
      scene.remove(g);
      disposeGroup(g);
    }
  }
  roadsGroup.value = null;
  junctionsGroup.value = null;
  centerlinesGroup.value = null;

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
  };

  const roads = buildRoadSlabsGroup(segmentInfo, analysis.surfaceLift);
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

function buildRoadSlabsGroup(segmentInfo, depth) {
  const group = new THREE.Group();
  group.name = 'road_slabs';
  const material = new THREE.MeshLambertMaterial({ color: 0x555560 });
  let any = false;
  for (const [, info] of segmentInfo) {
    const geom = buildSlabGeometry(info.worldGeometry, info.halfWidth, depth);
    if (geom) {
      group.add(new THREE.Mesh(geom, material));
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
