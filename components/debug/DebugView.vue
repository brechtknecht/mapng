<template>
  <div class="w-full h-full relative">
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
    <div class="absolute top-4 left-1/2 -translate-x-1/2 bg-black/85 text-white text-xs p-3 rounded-lg flex gap-4 items-center">
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="showRoads" /> Road slabs</label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="showJunctions" /> Junctions</label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="showCenterlines" /> Centerlines</label>
      <label class="flex items-center gap-1.5 cursor-pointer select-none"><input type="checkbox" v-model="wireframe" /> Wireframe</label>
    </div>

    <!-- Help (bottom-right) -->
    <div class="absolute bottom-4 right-4 bg-black/85 text-white/70 text-xs font-mono p-3 rounded-lg pointer-events-none">
      <div>Drag: orbit · Wheel: zoom · Right-drag: pan</div>
      <div class="mt-1">Coords: BeamNG world (Z-up, meters)</div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, shallowRef } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
let controls;
let animId = 0;
const roadsGroup = shallowRef(null);
const junctionsGroup = shallowRef(null);
const centerlinesGroup = shallowRef(null);

onMounted(() => {
  setupScene();
  rebuildScene();
  animate();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animId);
  window.removeEventListener('resize', onResize);
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

  camera = new THREE.PerspectiveCamera(45, w / h, 1, 50000);
  // Match BeamNG world convention: Z is up, X east, Y north.
  camera.up.set(0, 0, 1);
  camera.position.set(300, -300, 400);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(200, -150, 400);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0x99aaff, 0.25);
  dir2.position.set(-300, 200, 200);
  scene.add(dir2);

  // World axes (X red, Y green, Z blue) at origin, 30 m long.
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

  // Frame the camera on the centroid of all junctions (or roads as fallback).
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
    controls.target.set(cx, cy, 0);
    camera.position.set(cx + 200, cy - 200, 350);
    camera.lookAt(cx, cy, 0);
    controls.update();
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

  // Build & add three layered groups.
  const roads = buildRoadSlabsGroup(segmentInfo, analysis.surfaceLift);
  if (roads) {
    scene.add(roads);
    roadsGroup.value = roads;
  }
  const jGroup = buildJunctionMeshGroup(junctions, { depth: analysis.surfaceLift });
  if (jGroup) {
    // Replace the BeamNG-bound material with a bright debug-only material
    // that's fully under our control (no BeamNG material lookup involved).
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
  if (lines) {
    scene.add(lines);
    centerlinesGroup.value = lines;
  }

  updateVisibility();
}

/**
 * Build one extruded-rectangle slab per network segment. Matches MeshRoad's
 * top/bottom/side topology so junction prism walls visibly butt against
 * road end-caps (or expose any misalignment).
 */
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
  // For each centerline vertex, emit 4 corners: TL (top-left), TR (top-right),
  // BL (bottom-left), BR (bottom-right). "left" = +perpendicular along
  // outbound CCW; depth extrudes downward.
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
    // TL: left + top, TR: right + top, BL: left + bottom, BR: right + bottom
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
    // Top (normal +Z): TL_A, TR_A, TR_B, TL_B (CCW from above).
    indices.push(tlA, trA, trB, tlA, trB, tlB);
    // Bottom (normal -Z): mirrored winding.
    indices.push(brA, blA, blB, brA, blB, brB);
    // Left wall: TL_A, BL_A, BL_B, TL_B (CCW from outside left).
    indices.push(tlA, blA, blB, tlA, blB, tlB);
    // Right wall: TR_B, BR_B, BR_A, TR_A (CCW from outside right).
    indices.push(trB, brB, brA, trB, brA, trA);
  }
  // End caps so the prism is closed.
  const tl0 = 0;
  const tr0 = 1;
  const bl0 = 2;
  const br0 = 3;
  // Start cap: outward normal points opposite to outbound. From behind the
  // road, CCW order is TL, BL, BR, TR.
  indices.push(tl0, bl0, br0, tl0, br0, tr0);
  const tE = (N - 1) * 4;
  const trE = tE + 1;
  const blE = tE + 2;
  const brE = tE + 3;
  // End cap: outward normal = +outbound. From the front, CCW is TR, BR, BL, TL.
  indices.push(trE, brE, blE, trE, blE, tE);

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

function animate() {
  animId = requestAnimationFrame(animate);
  controls?.update();
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
  if (controls) controls.dispose();
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
