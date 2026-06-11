import * as THREE from 'three';

// IndexedDB persistence for baked Google 3D Tiles groups, so a page reload
// (dev-server HMR resets the whole app) doesn't force a multi-minute re-bake
// of coordinates that were already fetched this session/week.
//
// ⚠️ This stores Google-derived content on disk. Personal/dev use only —
// same fork-only scope as the rest of the Google tiles feature.
//
// Layout: one record per bake key { createdAt, meshes: [...] }, plus a tiny
// '__meta__' record mapping key → timestamp used for LRU pruning (reading
// all bake records just to sort them would pull GBs into memory).

const DB_NAME = 'mapng-google-tiles';
const STORE = 'bakes';
const META_KEY = '__meta__';
const MAX_PERSISTED_BAKES = 3;

const hasIdb = () => typeof indexedDB !== 'undefined';

const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) {
      req.result.createObjectStore(STORE);
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const reqAsPromise = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const idbGet = async (key) => {
  const db = await openDb();
  try {
    return await reqAsPromise(db.transaction(STORE).objectStore(STORE).get(key));
  } finally { db.close(); }
};

const idbPut = async (key, value) => {
  const db = await openDb();
  try {
    return await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key));
  } finally { db.close(); }
};

const idbDelete = async (key) => {
  const db = await openDb();
  try {
    return await reqAsPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
  } finally { db.close(); }
};

// Bounded concurrency — thousands of simultaneous PNG encodes/decodes would
// spike memory for nothing.
const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const serializeGroup = async (group) => {
  const children = group.children.filter((c) => c.isMesh && c.geometry?.attributes?.position);
  return mapLimit(children, 16, async (mesh) => {
    const geom = mesh.geometry;
    const map = mesh.material?.map ?? null;
    let texture = null;
    const img = map?.image;
    if (img?.toBlob) {
      texture = await new Promise((res) => img.toBlob(res, 'image/png'));
    }
    return {
      name: mesh.name,
      // slice() detaches from the live geometry so the structured clone
      // can't be affected by later mutation/disposal.
      positions: geom.attributes.position.array.slice(),
      uvs: geom.attributes.uv ? geom.attributes.uv.array.slice() : null,
      index: geom.index ? geom.index.array.slice() : null,
      texture,
      flipY: map?.flipY ?? true,
      wrapS: map?.wrapS ?? THREE.ClampToEdgeWrapping,
      wrapT: map?.wrapT ?? THREE.ClampToEdgeWrapping,
      colorSpace: map?.colorSpace ?? '',
    };
  });
};

const deserializeGroup = async (meshes) => {
  const out = new THREE.Group();
  out.name = 'GoogleTiles3D';
  const built = await mapLimit(meshes, 16, async (m) => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    // Same invariant as the live bake: every geometry carries position+uv+normal.
    geom.setAttribute(
      'uv',
      new THREE.BufferAttribute(m.uvs ?? new Float32Array((m.positions.length / 3) * 2), 2),
    );
    if (m.index) geom.setIndex(new THREE.BufferAttribute(m.index, 1));
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    mat.name = m.name;
    if (m.texture) {
      const bitmap = await createImageBitmap(m.texture);
      // Re-materialise as a canvas — the Collada texture-extraction path
      // (and lesson 4) expects canvas-backed textures.
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const tex = new THREE.CanvasTexture(canvas);
      tex.name = m.name;
      tex.flipY = m.flipY;
      tex.wrapS = m.wrapS;
      tex.wrapT = m.wrapT;
      if (m.colorSpace) tex.colorSpace = m.colorSpace;
      mat.map = tex;
    }
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = m.name;
    mesh.userData.isGoogleTile = true;
    return mesh;
  });
  for (const mesh of built) out.add(mesh);
  return out;
};

/** Restore a baked group for `key`, or null when not cached. */
export async function loadPersistedBake(key) {
  if (!hasIdb()) return null;
  const record = await idbGet(key);
  if (!record?.meshes?.length) return null;
  const group = await deserializeGroup(record.meshes);
  if (record.stations) group.userData.bakeStations = record.stations;
  // Touch the LRU timestamp so frequently used AOIs survive pruning.
  try {
    const meta = (await idbGet(META_KEY)) || {};
    meta[key] = Date.now();
    await idbPut(META_KEY, meta);
  } catch (_) { /* cosmetic */ }
  return group;
}

/** Persist a baked group. Returns the approximate payload size in bytes. */
export async function persistBake(key, group) {
  if (!hasIdb()) return null;
  const meshes = await serializeGroup(group);
  await idbPut(key, {
    createdAt: Date.now(),
    meshes,
    // Camera-station footprints for the preview overlay.
    stations: group.userData?.bakeStations ?? null,
  });

  let bytes = 0;
  for (const m of meshes) {
    bytes += m.positions.byteLength + (m.uvs?.byteLength ?? 0) + (m.index?.byteLength ?? 0) + (m.texture?.size ?? 0);
  }

  // LRU prune via the meta record.
  const meta = (await idbGet(META_KEY)) || {};
  meta[key] = Date.now();
  const keys = Object.keys(meta).sort((a, b) => meta[a] - meta[b]);
  while (keys.length > MAX_PERSISTED_BAKES) {
    const oldest = keys.shift();
    await idbDelete(oldest);
    delete meta[oldest];
    console.info(`[google3dTiles] pruned old persisted bake: ${oldest}`);
  }
  await idbPut(META_KEY, meta);
  return bytes;
}

/** Drop one persisted bake (used by force re-bake). */
export async function deletePersistedBake(key) {
  if (!hasIdb()) return;
  await idbDelete(key);
  try {
    const meta = (await idbGet(META_KEY)) || {};
    if (key in meta) {
      delete meta[key];
      await idbPut(META_KEY, meta);
    }
  } catch (_) { /* cosmetic */ }
}
