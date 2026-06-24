// Headless oracle for the BeamNG level archive serializer (refactor 06 step 9b).
// writeLevelEntries(zip, ctx) takes an explicit ctx of computed artifacts and
// records the whole level directory tree — it imports no renderer/canvas/fetch/
// ?raw modules (everything arrives via ctx), so it runs in Node directly. We
// feed a representative ctx exercising every conditional branch, record into a
// plain { folder, file } recorder, and hash the entries in insertion order
// (captures both content AND path/ordering). A verbatim extraction keeps the
// bytes identical; any drift — a missing ctx field (→ undefined in output), a
// reordered write (→ PRNG/persistentId shift), a changed template — flips it.
//
// This validates the SERIALIZATION half. The compute half (buildLevelArtifacts)
// pulls canvas/THREE/renderer/fetch and can't run headless; its ctx field names
// are checked statically against this consumer (see the package boundary +
// build), and confirmed end-to-end by a real in-app bake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeLevelEntries } from '@mapng/bake/beamng/levelArchive';

const seededRandom = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const withSeededRandom = (seed, fn) => {
  const real = Math.random;
  Math.random = seededRandom(seed);
  try { return fn(); } finally { Math.random = real; }
};

// A recorder identical in shape to the entry's virtual zip.
const makeRecorder = () => {
  const dirs = [];
  const entries = new Map();
  const zip = { folder: (p) => dirs.push(p), file: (p, c) => entries.set(p, c) };
  return { zip, dirs, entries };
};

// Representative ctx — fake string "blobs", real Uint8Array for the flag asset
// (writeLevelFiles TextDecoder-decodes its main.materials.json). Exercises:
// architect roads + mesh roads + decal tree + barriers + google tiles (GLB
// path) + backdrop + forest + groundcover + mapng flag + PBR.
const makeCtx = () => ({
  levelName: 'test_level',
  levelDisplayName: 'Test Level',
  lat: '1.2340',
  lng: '5.6780',
  size: 64,
  spawnPosition: [12.3, -4.5, 6.7],
  spawnRotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  halfExtent: 133.44,
  squareSize: 4.17,
  maxHeight: 20,
  roadArchitectSession: { data: { roads: [{ name: 'r1' }, { name: 'r2' }], junctions: [] } },
  roadArchitectHeightmapBlob: '<ra-heightmap>',
  meshRoads: [{ class: 'MeshRoad', name: 'MeshRoad_0', persistentId: 'mr0', nodes: [] }],
  junctionsDaeBlob: '<junctions-dae>',
  decalRoads: [{ class: 'SimGroup', name: 'Main St', persistentId: 'sg1', __items: [
    { class: 'DecalRoad', name: 'Main_St__Base__S1__L1', persistentId: 'd1', nodes: [] },
  ] }],
  pbrResult: {
    materialNames: ['DefaultMaterial', 'osm_grass'],
    materialDefs: { DefaultMaterial: { class: 'TerrainMaterial' }, osm_grass: { class: 'TerrainMaterial' } },
    textureSetName: 'theTextureSet',
    textureFiles: [{ path: 'osm_grass_b.png', blob: '<pbr-tex>' }],
  },
  terBlob: '<ter-binary>',
  texBlob: '<terrain-png>',
  heightmapBlob: '<heightmap-png>',
  previewBlob: '<preview-png>',
  osmDaeBlob: '<osm-dae>',
  googleTilesGlbBlob: '<google-glb>',
  googleTilesDaeBlob: null, // → ships GLB + python + README
  googleTilesTextureFiles: [{ name: 'google_atlas_00', ext: 'png', data: '<atlas0>' }],
  googleDebugCubeBlob: '<debug-cube>',
  waterObjects: [{ class: 'WaterPlane', name: 'ocean', persistentId: 'w0', __parent: 'Water' }],
  barrierFolderItems: [{ class: 'TSStatic', name: 'barrier_0_1', persistentId: 'b0', __parent: 'barriers',
    shapeName: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_wood_fence_a.DAE' }],
  roadFolderGroups: [{ groupName: 'Main St' }, { groupName: 'Main St_2' }],
  usesEastCoastFenceMaterials: true,
  forestFiles: [{ path: 'forest/tree_a.forest4.json', contents: '{"x":1}\n' }],
  groundCoverObjects: [{ class: 'GroundCover', name: 'mapng_grass_cover', persistentId: 'gc0', __parent: 'vegetation' }],
  managedForestItemData: { tree_a: { persistentId: 'mi0' } },
  shapeMaterialDefsForFlavor: { tree_a_mat: { class: 'Material', name: 'tree_a_mat' } },
  backdropDaeBlob: '<backdrop-dae>',
  backdropTextureFiles: [{ name: 'backdrop_NW', ext: 'png', data: '<bd-nw>' }],
  mapngFlagFiles: [
    { path: 'mapng/main.materials.json', data: new TextEncoder().encode(JSON.stringify({ mapng_flag: { Stages: [{}] } })) },
    { path: 'mapng/flagng.dae', data: new Uint8Array([1, 2, 3, 4]) },
  ],
  mapngFlagPosition: [10, 20, 30],
  routeTilePieces: null,
  reportContents: 'MapNG Export Report\nfixed deterministic body\n',
  groundCoverProfile: { materialName: 'grass_mat', materialDef: { class: 'Material', name: 'grass_mat' } },
  tileRenderBiasM: 0.05,
  beamngGlbToDaeScript: '# beamng_glb_to_dae.py\nprint("convert")\n',
});

const hashArchive = ({ dirs, entries }) => {
  const h = createHash('sha256');
  for (const d of dirs) h.update('D:' + d + '\n');
  for (const [p, c] of entries) {
    h.update('F:' + p + '\n');
    if (typeof c === 'string') h.update(c);
    else if (c instanceof Uint8Array) h.update(Buffer.from(c));
    else h.update(String(c));
  }
  return h.digest('hex').slice(0, 16);
};

const GOLDEN = '4ca421d2fe6840c5';

test('writeLevelEntries is deterministic and records the expected tree', () => {
  const a = makeRecorder();
  const b = makeRecorder();
  withSeededRandom(7, () => writeLevelEntries(a.zip, makeCtx()));
  withSeededRandom(7, () => writeLevelEntries(b.zip, makeCtx()));
  assert.equal(hashArchive(a), hashArchive(b), 'identical ctx + seed → identical archive bytes');
  // sanity: key entries present
  assert.ok(a.entries.has('levels/test_level/info.json'), 'writes info.json');
  assert.ok(a.entries.has('levels/test_level/mainLevel.lua'), 'writes mainLevel.lua');
  assert.ok(a.entries.has('levels/test_level/main/MissionGroup/Level_objects/Other/items.level.json'), 'writes the Other scene tree');
  assert.ok(a.entries.has('levels/test_level/art/shapes/google_tiles/beamng_glb_to_dae.py'), 'ships the GLB conversion script');
});

test('writeLevelEntries matches the pinned golden hash (regression oracle)', () => {
  const r = makeRecorder();
  withSeededRandom(7, () => writeLevelEntries(r.zip, makeCtx()));
  const got = hashArchive(r);
  if (GOLDEN === 'PENDING') {
    console.log(`[oracle] writeLevelEntries golden = ${got}`);
  } else {
    assert.equal(got, GOLDEN, 'archive matches the pinned golden hash');
  }
});
