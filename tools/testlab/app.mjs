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
scene.background = new THREE.Color(0x0f1115);
const RES_CLAMP = 2.0; // metres: residual at which the blue/red ramp saturates

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

// The .ter floor as a faint wireframe reference — present but never competing
// with the colour-coded tiles that sit on it.
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
  for (let r = 0; r < H - 1; r += 4) for (let c = 0; c < W - 1; c += 4) {
    const a = r * W + c, b = r * W + Math.min(c + 4, W - 1), d = Math.min(r + 4, H - 1) * W + c;
    idx.push(a, b, a, d); // sparse grid lines
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x47506a }));
};

// Diverging residual ramp: blue = below the floor, near-black-grey = on it
// (accurate), red = above. Saturates at ±RES_CLAMP metres.
const lerp = (a, b, t) => a + (b - a) * t;
const residualColor = (out, o, res) => {
  const t = Math.max(-1, Math.min(1, res / RES_CLAMP));
  // on-floor colour is a neutral light grey so "accurate" reads as uncoloured
  const mid = [0.82, 0.84, 0.88];
  const lo = [0.20, 0.45, 1.0];  // blue (below)
  const hi = [1.0, 0.25, 0.22];  // red (above)
  const end = t < 0 ? lo : hi;
  const k = Math.abs(t);
  out[o] = lerp(mid[0], end[0], k);
  out[o + 1] = lerp(mid[1], end[1], k);
  out[o + 2] = lerp(mid[2], end[2], k);
};

// Tile/ground mesh coloured per-vertex by residual (unlit → crisp colours).
const residualMesh = (positions, index, residual) => {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(positions.length);
  const col = new Float32Array(positions.length);
  for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
    pos[i] = positions[i]; pos[i + 1] = positions[i + 1] * yScale; pos[i + 2] = positions[i + 2];
    residualColor(col, i, residual[v]);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
};

// Buildings are legitimately above the floor — show them solid, not as "drift".
const buildingMesh = (positions, index) => {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) { pos[i] = positions[i]; pos[i + 1] = positions[i + 1] * yScale; pos[i + 2] = positions[i + 2]; }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x6b7280, side: THREE.DoubleSide }));
};

const populate = (which, payload) => {
  const g = groups[which];
  disposeGroup(g);
  g.add(buildTerrainMesh(payload.terrain, payload.minHeight));
  const resKey = which === 'before' ? 'residualBefore' : 'residualAfter';
  for (const m of payload.meshes) {
    g.add(m.kind === 'building' ? buildingMesh(m[which], m.index) : residualMesh(m[which], m.index, m[resKey]));
  }
};

const fmtSigned = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);

// Road-mask rows: the snap's verifiable payoff. road RMS after should collapse
// toward ~0 (flat on the DEM) and max float fixed shows floaters the band missed.
const roadMaskRows = (rm) => {
  if (!rm) return '';
  if (!rm.enabled) return `<tr><td class="k">road mask</td><td class="v warn">off</td></tr>`;
  if (rm.maskedVerts == null) return `<tr><td class="k">road mask</td><td class="v warn">on — no road verts</td></tr>`;
  const flat = rm.roadRmsAfterM < 0.15;
  return `
    <tr><td class="k">road verts snapped</td><td class="v">${rm.vertsSnapped.toLocaleString()} / ${rm.maskedVerts.toLocaleString()}</td></tr>
    <tr><td class="k">road RMS before → after</td><td class="v ${flat ? 'good' : 'warn'}">${rm.roadRmsBeforeM.toFixed(2)} → ${rm.roadRmsAfterM.toFixed(2)} m</td></tr>
    <tr><td class="k">max road float fixed</td><td class="v">${rm.maxFloatFixedM.toFixed(1)} m</td></tr>`;
};

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
    <tr><td class="k">field cells filled</td><td class="v">${s.cellsFilled}</td></tr>
    ${roadMaskRows(payload.roadMask)}`;

  document.querySelector('#bld tbody').innerHTML = payload.buildings.map((b, i) => {
    const preserved = Math.abs(b.after.heightM - b.before.heightM) < 0.2;
    const seated = Math.abs(b.after.baseAboveFloorM) < 0.5;
    return `<tr><td class="k">#${i + 1} base above floor</td><td class="v">${fmtSigned(b.before.baseAboveFloorM)} → <span class="${seated ? 'good' : 'warn'}">${fmtSigned(b.after.baseAboveFloorM)}</span> m</td></tr>
            <tr><td class="k">#${i + 1} height</td><td class="v"><span class="${preserved ? 'good' : 'warn'}">${b.after.heightM.toFixed(1)}</span> / ${b.before.heightM.toFixed(1)} m</td></tr>`;
  }).join('');
};

const sourceEl = document.getElementById('source');
const capture = () => sourceEl.value;
const roadmaskOn = () => (document.getElementById('roadmask').checked ? '1' : '0');
const query = () => {
  const rm = `roadmask=${roadmaskOn()}`;
  if (capture()) return `capture=${encodeURIComponent(capture())}&${rm}`;
  return `${PARAMS.map((k) => `${k}=${document.getElementById(k).value}`).join('&')}&${rm}`;
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
document.getElementById('roadmask').addEventListener('change', refresh);

// Populate the real-bake capture list (if any captured via captureRealBake.mjs
// or the "New real capture" button below).
const refreshCaptureList = (selectName) => fetch('/api/captures').then((r) => r.json()).then(({ captures }) => {
  for (const o of [...sourceEl.options]) if (o.value) o.remove();
  for (const c of captures) {
    const o = document.createElement('option');
    o.value = c.name;
    o.textContent = c.meta ? `${c.name} — ${c.meta.sizeM}m ${c.meta.quality} (real)` : `${c.name} (real)`;
    sourceEl.appendChild(o);
  }
  document.getElementById('capnote').textContent = captures.length
    ? `${captures.length} real bake(s) available.`
    : 'No real bakes yet — use "New real capture" below.';
  if (selectName && [...sourceEl.options].some((o) => o.value === selectName)) {
    sourceEl.value = selectName;
    refresh();
  }
}).catch(() => {});
refreshCaptureList();

// "New real capture" — runs the bake on the server and streams its log here.
const capBtn = document.getElementById('capbtn');
capBtn.addEventListener('click', async () => {
  const v = (id) => document.getElementById(id).value.trim();
  const lat = v('caplat'), lng = v('caplng'), size = v('capsize'),
    quality = v('capquality'), name = v('capname');
  const log = document.getElementById('caplog');
  log.style.display = 'block';
  if (!lat || !lng || !name) { log.textContent = 'lat, lng and name are required.'; return; }
  capBtn.disabled = true; log.textContent = `baking ${name} (${lat},${lng}) — calls Google + Overpass …\n`;
  try {
    const q = new URLSearchParams({ lat, lng, size, quality, name }).toString();
    const resp = await fetch(`/api/capture?${q}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = log.textContent;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      log.textContent = buf;
      log.scrollTop = log.scrollHeight;
    }
    await refreshCaptureList(name); // appears in the list and auto-selects
  } catch (e) {
    log.textContent += `\n[error] ${e.message}`;
  } finally {
    capBtn.disabled = false;
  }
});

resize();
refresh();
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
