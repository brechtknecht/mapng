// Browser viewer for the conform test lab. Fetches /api/scene.json (real
// conform output) and shows BEFORE vs AFTER side by side, plus the delta-field
// heatmap and verifiable stats. No geometry maths is re-implemented here — it
// just renders the positions the server returns.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const PARAMS = ['base', 'tiltX', 'tiltZ', 'wiggle'];
const GAP = 55; // half-spacing between the before/after copies (scene units)

const viewEl = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
viewEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404048, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(40, 120, 30); scene.add(sun);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(0, 140, 190);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 8, 0);

let yScale = 0.25;            // unitsPerMeter — set from the payload
const groups = { before: new THREE.Group(), after: new THREE.Group() };
groups.before.position.x = -GAP;
groups.after.position.x = GAP;
scene.add(groups.before, groups.after);

const resize = () => {
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
};
window.addEventListener('resize', resize);

const disposeGroup = (g) => {
  for (const c of [...g.children]) { c.geometry?.dispose(); c.material?.dispose(); g.remove(c); }
};

// Build a terrain reference surface from the DEM heightMap (metres above datum,
// scaled to scene units by yScale — matches how the bake preview displays Y).
const buildTerrainMesh = (terrain, minHeight) => {
  const { width: W, height: H, heightMap } = terrain;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(W * H * 3);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 3;
      pos[i] = (c / (W - 1)) * 100 - 50;
      pos[i + 1] = (heightMap[r * W + c] - minHeight) * yScale;
      pos[i + 2] = (r / (H - 1)) * 100 - 50;
    }
  }
  const idx = [];
  for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
    const a = r * W + c;
    idx.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx); geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3f7d4f, roughness: 1, flatShading: false }));
};

const meshFrom = (positions, index, mat) => {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    pos[i] = positions[i]; pos[i + 1] = positions[i + 1] * yScale; pos[i + 2] = positions[i + 2];
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index); geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
};

const carpetMat = () => new THREE.MeshStandardMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
const bldMat = () => new THREE.MeshStandardMaterial({ color: 0xe08a3c, roughness: 0.9 });
const tileMat = () => new THREE.MeshStandardMaterial({ color: 0xb8a98c, roughness: 1, side: THREE.DoubleSide });

const matFor = (kind) => (kind === 'building' ? bldMat() : kind === 'ground' ? carpetMat() : tileMat());

const populate = (which, payload) => {
  const g = groups[which];
  disposeGroup(g);
  g.add(buildTerrainMesh(payload.terrain, payload.minHeight));
  for (const m of payload.meshes) g.add(meshFrom(m[which], m.index, matFor(m.kind)));
};

const fmtSigned = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

const renderStats = (payload) => {
  const s = payload.stats;
  const ok = s.groundResidualAfterM < 0.4;
  const kept = Math.abs(s.verticalExtentAfterM - s.verticalExtentBeforeM) < Math.max(0.5, s.verticalExtentBeforeM * 0.05);
  document.querySelector('#stats tbody').innerHTML = `
    <tr><td class="k">source</td><td class="v">${payload.source}</td></tr>
    <tr><td class="k">ground residual before</td><td class="v">${s.groundResidualBeforeM.toFixed(2)} m</td></tr>
    <tr><td class="k">ground residual after</td><td class="v ${ok ? 'good' : 'warn'}">${s.groundResidualAfterM.toFixed(2)} m</td></tr>
    <tr><td class="k">vertical extent (kept)</td><td class="v ${kept ? 'good' : 'warn'}">${s.verticalExtentBeforeM.toFixed(0)} → ${s.verticalExtentAfterM.toFixed(0)} m</td></tr>
    <tr><td class="k">verts moved</td><td class="v">${s.vertsMoved.toLocaleString()}</td></tr>
    <tr><td class="k">field cells filled</td><td class="v">${s.cellsFilled}</td></tr>`;

  document.querySelector('#bld tbody').innerHTML = payload.buildings.map((b, i) => {
    const preserved = Math.abs(b.after.heightM - b.before.heightM) < 0.2;
    const seated = Math.abs(b.after.baseAboveFloorM) < 0.5;
    return `<tr><td class="k">#${i + 1} base above floor</td><td class="v">${fmtSigned(b.before.baseAboveFloorM)} → <span class="${seated ? 'good' : 'warn'}">${fmtSigned(b.after.baseAboveFloorM)}</span> m</td></tr>
            <tr><td class="k">#${i + 1} height</td><td class="v"><span class="${preserved ? 'good' : 'warn'}">${b.after.heightM.toFixed(1)}</span> / ${b.before.heightM.toFixed(1)} m</td></tr>`;
  }).join('');
};

const sourceEl = document.getElementById('source');
const capture = () => sourceEl.value;
const query = () => {
  if (capture()) return `capture=${encodeURIComponent(capture())}`;
  return PARAMS.map((k) => `${k}=${document.getElementById(k).value}`).join('&');
};

let timer = null;
const refresh = async () => {
  for (const k of PARAMS) document.getElementById('l' + k).textContent = Number(document.getElementById(k).value).toFixed(2);
  const isCap = !!capture();
  for (const k of PARAMS) document.getElementById(k).disabled = isCap;
  document.getElementById('synthonly').textContent = isCap ? '(ignored — real capture)' : '';
  const q = query();
  const payload = await fetch(`/api/scene.json?${q}`).then((r) => r.json());
  yScale = payload.unitsPerMeter;
  populate('before', payload);
  populate('after', payload);
  renderStats(payload);
  const img = document.getElementById('field');
  img.src = `/api/field.png?${q}`;
  let mn = Infinity, mx = -Infinity; for (const v of payload.field.values) { if (v < mn) mn = v; if (v > mx) mx = v; }
  document.getElementById('fmin').textContent = mn.toFixed(2);
  document.getElementById('fmax').textContent = mx.toFixed(2);
};
const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 120); };

// defaults
const defaults = { base: 1.2, tiltX: 0.6, tiltZ: 0.3, wiggle: 0.4 };
for (const k of PARAMS) { const el = document.getElementById(k); el.value = defaults[k]; el.addEventListener('input', schedule); }
sourceEl.addEventListener('change', refresh);

// Populate the real-bake capture list (if any captured via captureRealBake.mjs).
fetch('/api/captures').then((r) => r.json()).then(({ captures }) => {
  for (const c of captures) {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.meta ? `${c.name} — ${c.meta.sizeM}m ${c.meta.quality} (real)` : `${c.name} (real)`;
    sourceEl.appendChild(o);
  }
  document.getElementById('capnote').textContent = captures.length
    ? `${captures.length} real bake(s) available.`
    : 'No real bakes yet — run: node tools/testlab/captureRealBake.mjs --lat .. --lng .. --name ..';
}).catch(() => {});

resize();
refresh();
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
