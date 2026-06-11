# Google Photorealistic 3D Tiles → BeamNG

Bakes Google Maps Platform's Photorealistic 3D Tiles into mapng's BeamNG level export, replacing the OSM-extruded buildings with real photogrammetry geometry + photographic textures.

Currently behind the **Google 3D buildings** toggle in the BeamNG Level export panel. Off by default.

> ⚠️ Personal/fork use only. Google's Map Tiles ToS prohibits storing, caching, or deriving content from the tiles, and baking them into a redistributable game level violates both. Don't ship the resulting BeamNG zips publicly.

## Setup

1. **Google Cloud project + API key**
   - [Enable the Map Tiles API](https://console.cloud.google.com/apis/library/tile.googleapis.com)
   - Create an API key, restrict it to *Map Tiles API only*
   - Billing must be enabled on the project (free tier covers small bakes)
2. **`.env.local`** (gitignored via the existing `*.local` rule)
   ```
   VITE_GOOGLE_MAPS_API_KEY=AIza…
   ```
3. Run `npm run dev`. The toggle appears in the BeamNG export section once the env var is set.

Track usage at https://console.cloud.google.com/google/maps-apis/quotas?api=tile.googleapis.com.

## Architecture

```
ExportPanel.vue (toggle)
        │
        ▼
exportBeamNGLevel.js
        │
        ├── generateOSMObjectsDAE()   ← unchanged OSM path
        │
        └── generateGoogleTilesDAE() ──┐
                 │                     │
                 ▼                     │
        bakeGoogle3DTiles()            │
        services/google3dTiles.js      │
                 │                     │
                 ▼                     │
        3d-tiles-renderer              │
        + GoogleCloudAuthPlugin        │
                 │                     │
                 ▼                     │
        per-tile Three.js Mesh         │
        (MeshStandardMaterial,         │
         snapshotted CanvasTexture)    │
                                       ▼
                              merged into one BufferGeometry
                              with per-tile material groups
                                       │
                                       ▼
                              ColladaExporter
                                       │
                                       ▼
                              art/shapes/google_tiles/
                                google_tiles.dae
                                main.materials.json
                                google_debug.dae        (diagnostic cube)
                                textures/google_tile_*.png
                                       │
                                       ▼
                              JSZip → BeamNG level zip
                                       │
                                       ▼
                              items.level.json
                                Other > google_tiles    (TSStatic)
                                Other > google_debug_cube
```

## Key files

| File | Responsibility |
|---|---|
| `services/google3dTiles.js` | Headless tile fetcher. Drives an offscreen `WebGLRenderer` + RAF loop, snapshots each tile's texture to a standalone canvas before disposing the renderer, transforms ECEF → mapng scene coords, clips to AOI, optionally strips ground triangles. |
| `services/exportBeamNGLevel.js` | `generateGoogleTilesDAE()` builder + zip-writer wiring for the `art/shapes/google_tiles/` folder. |
| `services/export3d.js` | Threads `useGoogle3DTiles` through `exportToGLB` / `exportToDAE` for direct GLB/DAE export paths. |
| `components/panels/ExportPanel.vue` | Toggle in the BeamNG export section. Reads `VITE_GOOGLE_MAPS_API_KEY`. |
| `.env.example` | Documents the env var. |

## Tuning knobs

In `bakeGoogle3DTiles()` in `services/google3dTiles.js`:

| Option | Current default | Effect |
|---|---|---|
| `errorTarget` | **5** | Screen-space-error target in pixels. Lower = more tiles, higher mesh + texture detail. Library default 6, GoogleTilesRenderer default 40 (realtime). 5 yields ~4× more tiles than 8 baseline. |
| `stripGround` | `true` | Drops near-horizontal tris so mapng's heightmap terrain shows through. |
| `groundNormalThreshold` | `0.85` | `|normal.y|` above this counts as ground. Raise to keep more flat surfaces (e.g. rooftops). |
| `maxWaitMs` | `240000` | Hard cap on bake time. |
| `stabilityMs` | `2500` | Queue must stay quiet for this long to be considered done. |
| `worldSize` | passed in | Pre-divides scene-Y so the downstream BeamNG transform produces world-Z in real meters above the `.ter` minHeight reference. |
| `lruCache.maxBytesSize` | `1.5 GB` (set in code) | The library refuses to load tiles while the cache `isFull()`. The 0.3.46 default byte cap (0.4 GB) saturates around errorTarget=5 and silently truncates the bake. |
| `downloadQueue.maxJobs` / `parseQueue.maxJobs` | `20` / `6` | Library defaults are 10 / **1** — single-threaded parsing dominated bake time at higher tile counts. |

Rough estimates (1 km² dense urban AOI):

| `errorTarget` | Tiles | Bake | Zip add | API calls |
|---|---|---|---|---|
| 8 | ~330 | ~20 s | ~34 MB | ~1k |
| **5 (current)** | **~1.3k** | **~1–2 min** | **~150 MB** | **~4k** |
| 3 | ~3k | ~3–5 min | ~400 MB | ~10k |
| 1 | ~8k | ~5–12 min | ~1 GB | ~25k |

## Layout in the level zip

```
levels/<level>/
  art/shapes/
    osm_objects.dae                  (OSM roads, unchanged)
    main.materials.json              (osm_object vertex-colour material)
    google_tiles/
      google_tiles.dae               (Google photogrammetry mesh)
      main.materials.json            (osm_object + per-tile colorMap entries)
      google_debug.dae               (diagnostic cube)
      textures/
        google_tile_0.png
        google_tile_1.png
        …
  main/MissionGroup/Level_objects/Other/
    items.level.json
      "name": "osm_objects"          (TSStatic)
      "name": "google_tiles"         (TSStatic)
      "name": "google_debug_cube"    (TSStatic, 5m above spawn)
```

The `google_tiles` namespace is isolated in its own folder with its own materials.json. Mirrors the proven `art/shapes/mapng/` (flag) asset layout.

## In the BeamNG editor

Scene tree → `Other > google_tiles` (the photogrammetry mesh).
Plus `Other > google_debug_cube` floating 5 m above the spawn point — a diagnostic probe using `google_tile_0`. If it shows up textured but the main mesh doesn't, the issue is in the bigger mesh (UVs/scale/normals); if the cube fails too, it's a material or path problem.

## Hard-won lessons (read before changing anything)

These were the actual bugs that ate days of debug time. Don't reintroduce them.

### 1. BeamNG's `Material` class uses `colorMap`, not `diffuseMap`
The Three.js / glTF convention is `diffuseMap`. BeamNG silently ignores it for the `Material` class. Renders **fully invisible**, no error. The `mapng_flag` material is the canonical working shape:
```json
{
  "name": "google_tile_0",
  "mapTo": "google_tile_0",
  "class": "Material",
  "Stages": [
    { "colorMap": "levels/<level>/art/shapes/google_tiles/textures/google_tile_0.png" },
    {},
    {},
    {}
  ],
  "translucentBlendOp": "None"
}
```
The 4-entry `Stages` array is also required even if only the first is populated.

### 2. ColladaExporter refuses textures on `MeshBasicMaterial`
Google's photogrammetry tiles ship as `MeshBasicMaterial` (lighting baked into the texture). If you forward them as-is to `ColladaExporter`, it emits a console warning (`Texture maps not supported with MeshBasicMaterial.`) and writes the material with no texture reference at all. Mesh renders invisible.

Fix: build a fresh `MeshStandardMaterial` per tile and copy the snapshotted texture onto it. See `bakeGoogle3DTiles()`.

### 3. Set `material.name` explicitly — constructor param doesn't always stick
In Three.js r0.162, `new MeshStandardMaterial({ name: 'foo' })` silently drops the name in some paths. Always assign `material.name = matName` on a separate line. Without this, BeamNG can't resolve the material via materials.json and the mesh renders invisible.

### 4. Snapshot textures BEFORE `tiles.dispose()`
`TilesRenderer.dispose()` unloads tile caches, which frees the b3dm/glb image data. A `THREE.Texture.clone()` shallow-shares the image, so the cloned texture's `.image` is empty by the time `ColladaExporter` reads it for PNG extraction.

Fix: draw each source texture into a fresh `HTMLCanvasElement` and assign it as a `CanvasTexture` *before* disposing the renderer.

### 5. DAE topology: one mesh under start01, not many
BeamNG's TSStatic importer is strict about node depth. The proven working shape is:
```
base00 > start01 > [single visual mesh] + Colmesh-1
```
Multiple sibling meshes under `start01` (one per tile) silently fail to render — invisible even when materials and textures are correct.

Fix: `mergeGeometries(geoms, true)` to produce **one** `BufferGeometry` with per-tile material **groups**, and a mesh with an array material (`material: [mat0, mat1, …]`). ColladaExporter then writes one geometry with N `<instance_material>` bindings.

### 6. Heightmap is raw meters, BeamNG transform multiplies by `s`
mapng's `data.heightMap` stores **raw meters above sea level**. The BeamNG export's scene→world transform multiplies scene-Y by `s = worldSize / SCENE_SIZE` (typically ~5×). Naively writing raw heightmap meters into scene-Y puts buildings hundreds of meters in the sky.

Fix: `bakeGoogle3DTiles()` accepts `worldSize` and pre-divides each vertex's BeamNG-target Z by `s`. The formula:
```
beamZMeters  = (mapngGroundY - data.minHeight) + (cart.height - googleGroundAlt)
sceneY       = beamZMeters / (worldSize / SCENE_SIZE)
```
where `cart.height` is the Google vertex altitude above ellipsoid and `googleGroundAlt` is sampled from the lowest vertex near the AOI center.

> Note: the existing OSM building code (`v.y = getHeightAtScenePos(...)`) has the same raw-meters bug. OSM buildings are also off-by-`s` in BeamNG; nobody noticed because the offset for low-elevation AOIs is hidden by other slop. Worth fixing separately.

### 7. Multi-camera rig broke the bake (returned 0 tiles)
A 5-camera rig (top-down + 4 perimeter oblique) intended to force high-LOD wall textures caused the renderer to return 0 tiles, killing the export silently (no errors, no objects in scene tree).

Reverted to single top-down camera. If we want wall-detail boost later, it needs more careful testing — likely either:
- a smarter perimeter altitude / FOV that doesn't put the AOI behind the near plane
- registering cameras *after* the first `update()` so the LRU has tiles to compare against
- per-camera resolution calibration

### 8. `.env.local` is the right secrets path; `.env` is committed by convention
Vite reads both. The user's `.gitignore` already excludes `*.local`, so `.env.local` is the safe place for the API key. `.env.example` is committed as documentation.

### 9. `mergeGeometries()` returns null on ANY attribute mismatch
`mergeGeometries(tileGeoms, true)` requires every geometry to carry the **identical attribute set**. Google occasionally ships untextured tiles (no `uv`); one such tile makes the merge return null → `generateGoogleTilesDAE` returns null → no DAE, no debug cube, no scene-tree entries, **no console error**. Looks exactly like the multi-camera 0-tiles failure but has a different cause.

Fix: `bakeGoogle3DTiles()` guarantees `position+uv+normal` on every output geometry, zero-filling `uv` when the source has none. Never filter or conditionally add attributes in the merge path.

### 10. The LRU cache byte cap silently truncates big bakes
`3d-tiles-renderer@0.3.46` only loads new tiles while `!lruCache.isFull()`, and `isFull()` trips at `cachedBytes >= 0.4 GB` by default. At errorTarget=5 (~1.3–1.8k photogrammetry tiles) the cap saturates mid-bake; queues drain, the stability window passes, and the bake "succeeds" with partial coverage. The bake now sets `maxBytesSize = 1.5 GB` and logs `cacheFull` at the end — if you see the saturation warning, raise the budget or the errorTarget.

### 11. A failed bake must not kill the level export
`generateGoogleTilesDAE()` is wrapped in try/catch at the call site; on failure the export logs `[BeamNG export] Google 3D Tiles bake failed` (and surfaces it in the progress UI) and continues with the OSM-only level. Empty bakes throw descriptive errors (`0 tiles loaded` vs `none survived AOI clipping`) instead of silently returning nothing.

## Known issues / open questions

- **Texture quality** is still low compared to Google Earth. `errorTarget=5` is a compromise to avoid browser OOM. Next step: investigate per-camera detail-forcing without breaking the bake.
- **Texture positioning** — user reported textures "make no sense position-wise". Hard to verify with current resolution. Re-evaluate after a sharper bake.
- **No height calibration UI** — the constant Y offset is fully formula-driven now, but if BeamNG terrain has unusual `maxHeight` settings, buildings can still float or sink. Consider a `verticalOffset` slider in the export panel.
- **No wall-detail forcing** — see lesson 7. Single top-down camera means wall textures are at lower LOD than roofs.
- **Collision mesh = visual mesh** — fine for prototyping but photogrammetry collision will be very expensive at runtime. Future: convex decomposition or simplification before emitting `Colmesh-1`.
- **OSM buildings sky bug** — see lesson 6 note. Separate fix.

## Branch + commit

Branch: `google`
Tip commit: `a7d5aea Bake Google Photorealistic 3D Tiles into BeamNG level exports`

Uncommitted on top: errorTarget=5, multi-camera attempt + revert to single top-down camera, uv zero-fill merge fix (lesson 9), LRU byte-budget raise + queue widening (lesson 10), bake resilience + loud diagnostics (lesson 11).
