<template>
  <primitive :object="overlayGroup" />
</template>

<script setup>
// Area inspector for the route preview: drag rectangles on the 3D map and get
// hard numbers for each — per-sample TILE-vs-.ter gap (raycast the Google mesh
// and the live extracted-ground floor from above), coverage, location. The
// parent renders the report UI and copies the JSON to the clipboard, so a
// broken spot can be handed over as data instead of screenshots/log walls.
//
// Must live INSIDE <TresCanvas> (needs the Tres context for camera/renderer).
import { shallowRef, ref, watch, onUnmounted } from 'vue';
import * as THREE from 'three';
import { useTresContext } from '@tresjs/core';
import { TILE_RENDER_BIAS_M } from '@mapng/bake/google3dTiles';

const props = defineProps({
  chunks: { type: Array, default: () => [] }, // RoutePreview `loaded` entries
  active: { type: Boolean, default: false },
  zOffsetM: { type: Number, default: 0 },
});
const emit = defineEmits(['areas-changed']);

const { camera, renderer, controls } = useTresContext();

const overlayGroup = new THREE.Group();
overlayGroup.name = '__area_inspector';

const COLORS = [0xff6600, 0x38bdf8, 0xa3e635, 0xf472b6, 0xfacc15, 0xc084fc];
const GRID_N = 16; // samples per rect side

const areas = ref([]); // [{ id, label, rect, stats, grid, center, chunks }]
let nextId = 1;

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const dragPlane = new THREE.Plane();
const planeHit = new THREE.Vector3();

let dragStart = null; // { x, z, y } world
let previewMesh = null;

// --- picking -----------------------------------------------------------------

const pickTargets = () => {
  const t = [];
  for (const c of props.chunks) {
    if (c.tilesNode) t.push(c.tilesNode);
    if (c.groundMesh) t.push(c.groundMesh);
    else if (c.terrainNode) t.push(c.terrainNode);
  }
  return t;
};

const setRayFromEvent = (e) => {
  const el = renderer.value.domElement;
  const r = el.getBoundingClientRect();
  ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ndc, camera.value);
};

// --- overlay meshes ------------------------------------------------------------

const makeRectOverlay = (rect, y, color, opacity) => {
  const w = Math.max(0.01, rect.maxX - rect.minX);
  const d = Math.max(0.01, rect.maxZ - rect.minZ);
  const g = new THREE.Group();
  const face = new THREE.Mesh(
    new THREE.BoxGeometry(w, 0.4, d),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(face.geometry),
    new THREE.LineBasicMaterial({ color }),
  );
  g.add(face, edges);
  g.position.set((rect.minX + rect.maxX) / 2, y + 0.3, (rect.minZ + rect.maxZ) / 2);
  return g;
};

const disposeOverlay = (g) => {
  g?.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
};

// --- world point → lat/lng (via the owning chunk's bounds) --------------------

const worldToLatLng = (x, z) => {
  const p = new THREE.Vector3(x, 0, z);
  for (const c of props.chunks) {
    if (!c.bounds || !c.object) continue;
    const local = c.object.worldToLocal(p.clone());
    // Chunk scene frame is [-50, 50] on X/Z; row 0 (z = -50) is north.
    if (local.x < -51 || local.x > 51 || local.z < -51 || local.z > 51) continue;
    const u = (local.x + 50) / 100;
    const v = (local.z + 50) / 100;
    const b = c.bounds;
    return {
      lat: +(b.north - v * (b.north - b.south)).toFixed(6),
      lng: +(b.west + u * (b.east - b.west)).toFixed(6),
      chunk: c.index,
    };
  }
  return null;
};

// --- sampling ------------------------------------------------------------------

const DOWN = new THREE.Vector3(0, -1, 0);

const sampleArea = (rect) => {
  const tiles = props.chunks.map((c) => c.tilesNode).filter(Boolean);
  const grounds = props.chunks.map((c) => c.groundMesh).filter(Boolean);
  const intendedLiftM = props.zOffsetM + TILE_RENDER_BIAS_M;

  const grid = []; // rows north→south (world -Z → +Z), cols west→east
  const gaps = [];
  let tileHits = 0, groundHits = 0;
  const chunksTouched = new Set();

  for (let iz = 0; iz < GRID_N; iz++) {
    const row = [];
    const z = rect.minZ + ((iz + 0.5) / GRID_N) * (rect.maxZ - rect.minZ);
    for (let ix = 0; ix < GRID_N; ix++) {
      const x = rect.minX + ((ix + 0.5) / GRID_N) * (rect.maxX - rect.minX);
      raycaster.set(new THREE.Vector3(x, 5000, z), DOWN);
      const tHit = raycaster.intersectObjects(tiles, true)[0] || null;
      const gHit = raycaster.intersectObjects(grounds, true)[0] || null;
      if (tHit) tileHits++;
      if (gHit) groundHits++;
      if (tHit && gHit) {
        // World units are metres; subtract the INTENDED lift so 0 = perfect.
        const gap = tHit.point.y - gHit.point.y - intendedLiftM;
        gaps.push(gap);
        row.push(+gap.toFixed(2));
        const owner = worldToLatLng(x, z);
        if (owner) chunksTouched.add(owner.chunk);
      } else {
        row.push(null);
      }
    }
    grid.push(row);
  }

  gaps.sort((a, b) => a - b);
  const q = (p) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))].toFixed(2) : null);
  const mean = gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) : null;

  const center = worldToLatLng((rect.minX + rect.maxX) / 2, (rect.minZ + rect.maxZ) / 2);
  return {
    center,
    sizeM: { w: +(rect.maxX - rect.minX).toFixed(0), d: +(rect.maxZ - rect.minZ).toFixed(0) },
    chunks: [...chunksTouched].sort((a, b) => a - b),
    samples: GRID_N * GRID_N,
    tileHits,
    groundHits,
    // gap = tile − .ter floor − (zOffset + renderBias): 0 = tiles sit exactly at
    // the intended height; positive = tiles float, negative = tiles sink.
    gapM: gaps.length
      ? { min: q(0), p50: q(0.5), mean, p95: q(0.95), max: +gaps[gaps.length - 1].toFixed(2) }
      : null,
    grid,
  };
};

// --- drag interaction ----------------------------------------------------------

const onPointerDown = (e) => {
  if (!props.active || e.button !== 0) return;
  setRayFromEvent(e);
  const hit = raycaster.intersectObjects(pickTargets(), true)[0];
  if (!hit) return;
  dragStart = { x: hit.point.x, z: hit.point.z, y: hit.point.y };
  dragPlane.set(new THREE.Vector3(0, 1, 0), -hit.point.y);
  if (controls.value) controls.value.enabled = false;
  e.target.setPointerCapture?.(e.pointerId);
};

const rectFrom = (a, b) => ({
  minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
  minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
});

const onPointerMove = (e) => {
  if (!dragStart) return;
  setRayFromEvent(e);
  if (!raycaster.ray.intersectPlane(dragPlane, planeHit)) return;
  const rect = rectFrom(dragStart, { x: planeHit.x, z: planeHit.z });
  if (previewMesh) { overlayGroup.remove(previewMesh); disposeOverlay(previewMesh); }
  previewMesh = makeRectOverlay(rect, dragStart.y, 0xffffff, 0.15);
  overlayGroup.add(previewMesh);
};

const onPointerUp = (e) => {
  if (!dragStart) return;
  if (previewMesh) { overlayGroup.remove(previewMesh); disposeOverlay(previewMesh); previewMesh = null; }
  setRayFromEvent(e);
  const end = raycaster.ray.intersectPlane(dragPlane, planeHit)
    ? { x: planeHit.x, z: planeHit.z } : { x: dragStart.x, z: dragStart.z };
  const rect = rectFrom(dragStart, end);
  const y = dragStart.y;
  dragStart = null;
  if (controls.value) controls.value.enabled = true;

  // Ignore accidental clicks — a real selection is at least ~4 m on a side.
  if (rect.maxX - rect.minX < 4 || rect.maxZ - rect.minZ < 4) return;

  const result = sampleArea(rect);
  const id = nextId++;
  const color = COLORS[(id - 1) % COLORS.length];
  const overlay = makeRectOverlay(rect, y, color, 0.25);
  overlayGroup.add(overlay);
  areas.value = [...areas.value, { id, label: `Area ${id}`, colorHex: `#${color.toString(16).padStart(6, '0')}`, ...result, _overlay: overlay }];
  emit('areas-changed', areas.value);
};

const clear = () => {
  for (const a of areas.value) { overlayGroup.remove(a._overlay); disposeOverlay(a._overlay); }
  areas.value = [];
  nextId = 1;
  emit('areas-changed', areas.value);
};

const removeArea = (id) => {
  const a = areas.value.find((x) => x.id === id);
  if (a) { overlayGroup.remove(a._overlay); disposeOverlay(a._overlay); }
  areas.value = areas.value.filter((x) => x.id !== id);
  emit('areas-changed', areas.value);
};

defineExpose({ clear, removeArea });

// --- listeners -----------------------------------------------------------------

const attach = () => {
  const el = renderer.value?.domElement;
  if (!el) return;
  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
};
const detach = () => {
  const el = renderer.value?.domElement;
  if (!el) return;
  el.removeEventListener('pointerdown', onPointerDown);
  el.removeEventListener('pointermove', onPointerMove);
  el.removeEventListener('pointerup', onPointerUp);
  if (dragStart) { dragStart = null; if (controls.value) controls.value.enabled = true; }
  if (previewMesh) { overlayGroup.remove(previewMesh); disposeOverlay(previewMesh); previewMesh = null; }
};

watch(() => props.active, (on) => (on ? attach() : detach()), { immediate: true });
onUnmounted(() => { detach(); clear(); });
</script>
