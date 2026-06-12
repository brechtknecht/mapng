// Ground truth: walk Google's tile tree straight down at one lat/lng and
// print every level — depth, geometricError, OBB size, content type. Tells
// us the ACTUAL maximum LOD the dataset offers at this spot, independent of
// our selector. ~20 fetches, no bake.
import { readFileSync } from 'node:fs';
import { WGS84_ELLIPSOID } from './headlessTilesEnv.mjs';
import * as THREE from 'three';

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const key = env.match(/^VITE_GOOGLE_MAPS_API_KEY=(.+)$/m)[1].trim();

const lat = Number(process.argv[2] ?? 52.5163);
const lng = Number(process.argv[3] ?? 13.3777);
const heightEll = Number(process.argv[4] ?? 80); // ellipsoidal metres — near local ground
const target = new THREE.Vector3();
WGS84_ELLIPSOID.getCartographicToPosition((lat * Math.PI) / 180, (lng * Math.PI) / 180, heightEll, target);

let session = null;
const fetchJson = async (uri) => {
  const url = new URL(uri, 'https://tile.googleapis.com');
  url.searchParams.set('key', key);
  if (session && !url.searchParams.has('session')) url.searchParams.set('session', session);
  if (!session) {
    const s = url.searchParams.get('session');
    if (s) session = s;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.pathname}`);
  return res.json();
};

const boxDist = (box) => {
  // distance from target to OBB centre + half-diagonal size
  const c = new THREE.Vector3(box[0], box[1], box[2]);
  const size = Math.hypot(box[3], box[4], box[5]) + Math.hypot(box[6], box[7], box[8]) + Math.hypot(box[9], box[10], box[11]);
  return { dist: c.distanceTo(target), size };
};

// Point-in-OBB: project (target - centre) onto each (non-unit) half-axis.
// 15% slack — tight leaf boxes must not prune the walk over a street point.
const boxContains = (box) => {
  const dx = target.x - box[0], dy = target.y - box[1], dz = target.z - box[2];
  for (const o of [3, 6, 9]) {
    const ax = box[o], ay = box[o + 1], az = box[o + 2];
    const len2 = ax * ax + ay * ay + az * az;
    if (len2 < 1e-12) continue;
    const proj = Math.abs(dx * ax + dy * ay + dz * az) / len2; // in half-axis units
    if (proj > 1.15) return false;
  }
  return true;
};

// Mesh/texture density of a GLB — the ACTUAL quality the API serves there.
const glbStats = async (uri) => {
  const url = new URL(uri, 'https://tile.googleapis.com');
  url.searchParams.set('key', key);
  if (session && !url.searchParams.has('session')) url.searchParams.set('session', session);
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (buf.readUInt32LE(0) !== 0x46546c67) return null; // 'glTF'
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  let verts = 0;
  let tris = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      verts += json.accessors[prim.attributes.POSITION]?.count ?? 0;
      tris += (json.accessors[prim.indices]?.count ?? 0) / 3;
    }
  }
  const imgBytes = (json.images ?? [])
    .map((im) => json.bufferViews[im.bufferView]?.byteLength ?? 0)
    .reduce((a, b) => a + b, 0);
  return {
    bytes: buf.byteLength,
    verts,
    tris: Math.round(tris),
    images: (json.images ?? []).length,
    imgKB: Math.round(imgBytes / 1024),
  };
};

console.log(`target ECEF: ${target.x.toFixed(0)}, ${target.y.toFixed(0)}, ${target.z.toFixed(0)} (|t|=${target.length().toFixed(0)})`);

// DFS with backtracking: loose top-level boxes "contain" the target in
// several branches at once — only the true branch keeps containing it all
// the way down. Track the deepest GLB leaf found.
let fetches = 0;
let deepest = null;
const visit = async (tile, depth, viaJson) => {
  if (depth > 40 || fetches > 80) return;
  const box = tile.boundingVolume?.box;
  if (!box || !boxContains(box)) return;
  const uri = tile.content?.uri ?? '';
  const { size } = boxDist(box);

  let children = tile.children ?? [];
  if (children.length === 0 && uri.includes('.json') && !viaJson) {
    fetches++;
    try {
      const sub = (await fetchJson(uri)).root;
      await visit(sub, depth, true); // subtree root replaces this node
      return;
    } catch { return; }
  }

  if (uri.includes('.glb')) {
    if (!deepest || tile.geometricError < deepest.ge) {
      deepest = { ge: tile.geometricError, size, depth, uri };
      console.log(
        `d=${String(depth).padStart(2)} ge=${tile.geometricError.toFixed(2).padStart(9)} ` +
        `boxSize≈${size.toFixed(0).padStart(6)}m children=${children.length}${children.length === 0 ? '  ← LEAF' : ''}`,
      );
    }
  }
  for (const c of children) await visit(c, depth + 1, false);
};

await visit((await fetchJson('/v1/3dtiles/root.json')).root, 0, false);
if (!deepest) {
  console.log('no GLB found containing the target');
} else {
  console.log(
    `DEEPEST GLB containing the target: ge=${deepest.ge.toFixed(2)}, boxSize≈${deepest.size.toFixed(0)}m, ` +
    `depth=${deepest.depth} (${fetches} subtree fetches)`,
  );
  const stats = await glbStats(deepest.uri).catch(() => null);
  if (stats) {
    console.log(
      `leaf content: ${(stats.bytes / 1024).toFixed(0)} KB, ${stats.verts} verts, ${stats.tris} tris, ` +
      `${stats.images} texture(s) totalling ${stats.imgKB} KB JPEG`,
    );
  }
  console.log(
    'NOTE: the public Map Tiles API serves ~one LOD LESS than the Google Maps/Earth native ' +
    'renderer (known limitation) — Maps will always look one level sharper than any bake can.',
  );
}
