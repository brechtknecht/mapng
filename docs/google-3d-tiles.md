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
        ├── generateOSMObjectsDAE()   ← OSM path (buildings → collision-only
        │                               when Google tiles are on)
        │
        └── generateGoogleTilesGLB() ──┐
                 │                     │
                 ▼                     │
        getOrBakeGoogle3DTiles()       │   (memory → IndexedDB → bake)
        bakeGoogle3DTiles()            │
        services/google3dTiles.js      │
                 │                     │
                 ▼                     │
        3d-tiles-renderer              │
        + GoogleCloudAuthPlugin        │
        camera sweep, 5 stations       │
                 │                     │
                 ▼                     │
        per-tile Three.js Mesh         │
        (MeshStandardMaterial,         │
         snapshotted CanvasTexture)    │
                                       ▼
                              texture ATLASES (4096², shelf-packed,
                              UVs remapped) + CHUNKED meshes
                              (≤60k verts, letter-named)
                                       │
                                       ▼
                              GLTFExporter → google_tiles.glb
                              (verifiable in any glTF viewer!)
                                       │
                                       ▼
                              art/shapes/google_tiles/
                                google_tiles.glb
                                beamng_glb_to_dae.py    (Blender ≤4.2 headless)
                                README_CONVERT.txt
                                main.materials.json     (google_atlas_NN entries)
                                google_debug.dae        (diagnostic cube)
                                textures/google_atlas_NN.png
                                       │
                                       ▼
                              POST /api/convert-dae
                              (vite dev-server middleware →
                               headless Blender ≤4.2, ~7 s)
                                       │
                            ┌──────────┴──────────┐
                            ▼                     ▼
                     bridge available       bridge unavailable
                     google_tiles.dae       google_tiles.glb +
                     in the zip —           beamng_glb_to_dae.py +
                     ready to play          README (manual one-liner)
                                       │
                                       ▼
                              JSZip → BeamNG level zip
                                       │
                                       ▼
                              items.level.json
                                Other > google_tiles    (TSStatic, collision None)
                                Other > google_debug_cube
```

**Why the Blender hop:** BeamNG only loads .dae, and its Torque-era importer has
undocumented constraints our hand-rolled ColladaExporter kept tripping over
(lessons 14–15). Blender's Collada exporter is what the BeamNG modding community
itself uses; the GLB intermediate is verifiable in any viewer before conversion.

**The conversion is automatic in dev:** `scripts/viteBlenderDaePlugin.mjs` adds a
`POST /api/convert-dae` middleware to the Vite dev server that pipes the GLB through
headless Blender and returns the .dae, so exported zips are ready to play. Blender
resolution: `BLENDER_PATH` env var → portable unzips on the Desktop → Program Files
(3.x/4.x only). Without a usable Blender, the export falls back to bundling the GLB +
script for the manual command.

## Key files

| File | Responsibility |
|---|---|
| `services/googleBakeCore.js` | **Shared, DOM-free bake core** (browser + Node): AOI frame, sweep stations (incl. road pass), the station sweep engine (pinning, quiet detection, budgets), finest-covering dedup, ground probes, ECEF→mapng vertex transform + AOI clip + ground strip. The hard-won bake semantics live HERE, once. |
| `services/google3dTiles.js` | Browser orchestrator around the core: Web-Worker ticker (anti-throttling), decoded-texture canvas snapshots, bake caches (in-memory + IndexedDB), and the routing front-end `getOrBakeGoogle3DTiles()` (sidecar when reachable, in-tab bake otherwise). |
| `services/googleBakeSidecar.js` | Browser client for the bake sidecar: health probe, job POST (joins running jobs by cache key), SSE progress, MBK1 result decode → `deserializeGroup()`, IndexedDB persist. |
| `scripts/googleBakeWorker.mjs` | Headless Node bake worker (child process): same shared-core pipeline, no texture decode — raw JPEG bytes pass from Google's GLB straight into the result. NDJSON protocol on stdout. Also runnable standalone for debugging. |
| `scripts/viteGoogleBakePlugin.mjs` | Vite dev-server job API `/api/google-bake/*`: spawns the worker with a multi-GB heap, dedupes jobs by bake key, relays progress via SSE, streams results. Jobs survive page reloads. |
| `scripts/headlessTilesEnv.mjs` + `scripts/headlessTilesHooks.mjs` | Make `3d-tiles-renderer` importable in Node: DOM polyfills, a resolve hook around the WebGL-at-module-scope plugins index, deep file imports, and the texture-capture GLTFLoader. |
| `scripts/spikeHeadlessTiles.mjs` | Standalone headless smoke test (`node scripts/spikeHeadlessTiles.mjs [lat lng extentM]`) — two-station selection + texture capture against the live API. |
| `services/exportBeamNGLevel.js` | `generateGoogleTilesGLB()` (atlas + chunking + GLTFExporter) + zip-writer wiring for the `art/shapes/google_tiles/` folder; hides OSM building visuals (keeps their collision) when Google tiles are on. |
| `scripts/beamng_glb_to_dae.py` | Headless Blender (≤4.2!) converter: sanitizes names, builds `base00 > start01`, exports the BeamNG-proven Collada. Shipped in the zip when the bridge is unavailable. |
| `scripts/viteBlenderDaePlugin.mjs` | Vite dev-server middleware `POST /api/convert-dae` — runs the converter automatically during export. |
| `services/export3d.js` | Threads `useGoogle3DTiles` through `exportToGLB` / `exportToDAE` for direct GLB/DAE export paths. |
| `components/panels/ExportPanel.vue` | Toggle in the BeamNG export section. Reads `VITE_GOOGLE_MAPS_API_KEY`. |
| `stores/googleTilesStore.js` | Pinia store for the 3D-preview bake (status, progress, show toggle, markRaw'd group). |
| `components/three/GoogleTiles3D.vue` | Displays the cached bake in the 3D preview (`<primitive>` inside a Y-scaled wrapper). |
| `components/three/Preview3D.vue` | "Google 3D Tiles" section in the scene-settings panel (load / progress / show / re-bake). |
| `.env.example` | Documents the env var. |

## Coordinate convention (mode-neutral bake output)

`bakeGoogle3DTiles()` emits X/Z in scene units (`[-50, 50]`) and **Y in real metres above
the `.ter` datum**: `beamZMeters = (mapngGroundY − minHeight) + (vertexAlt − googleGroundAlt)`.
Consumers convert:

- **3D preview / GLB / DAE**: scale Y by `computeUnitsPerMeter(data)` → identical to
  TerrainMesh's `(h − minHeight) × upm`.
- **BeamNG export**: the scene→world matrix maps Y → world-Z with factor **1** (world-Z
  is already metres above the `.ter` reference).

The vertical anchor `googleGroundAlt` is the 5th-percentile vertex altitude within a
horizontal radius of the AOI centre (see lesson 12).

## Previewing without BeamNG

3D preview → **Scene Settings** → *Google 3D Tiles* → **Load**. Status flow:
idle → baking (shows sweep pass + tile counts) → ready (show/hide toggle + re-bake link).
Errors render inline with a retry button; without `VITE_GOOGLE_MAPS_API_KEY` the section
shows a setup hint instead.

The preview, the BeamNG export and the GLB/DAE exports all go through
`getOrBakeGoogle3DTiles()`, which layers two caches and then routes the bake:

1. **In-memory** (single entry, keyed by AOI bounds + resolution + bake options) —
   shared within the session; preview-then-export bakes once.
2. **IndexedDB** (`mapng-google-tiles`, 3 most-recent bakes, LRU-pruned) — survives
   page reloads/HMR. The preview **auto-restores** on load: when terrain data for an
   already-baked AOI appears, the tiles reappear without clicking Load and without any
   Google request (`restoreBakedGoogle3DTiles()` is restore-only). Cache keys are
   versioned (`v2|…`) and bounds-rounded to ~1 cm so float noise can't split keys.
   "Re-bake" purges both layers for the current key.
   ⚠️ This persists Google-derived content on disk — personal/dev use only, in line
   with the fork-only scope above.
3. **On miss, the bake routes by environment** — see the next section.

## Node bake sidecar (dev server)

The in-browser bake dies at the renderer process's ~4 GB ceiling — heavy tiers
always, and even `standard` on large AOIs. When the Vite dev server is running,
`getOrBakeGoogle3DTiles()` therefore routes **every** bake (all quality tiers)
through `/api/google-bake`:

```
browser                       vite dev server               bake worker (child process)
getOrBakeGoogle3DTiles()      viteGoogleBakePlugin.mjs      googleBakeWorker.mjs
  memory → IndexedDB →   POST   job registry (dedupe   spawn  --max-old-space-size=<RAM/2>
  sidecar health? ───────────▶  by bake key), SSE  ──────────▶ shared-core sweep, JPEG
    │ unreachable (prod)        relay, result stream          pass-through (NO decode)
    ▼                                │     ◀─────────────────  MBK1 container
  in-tab bake (unchanged)            ▼
                              deserializeGroup() ← same path as an IndexedDB restore
```

Why the worker fits where the browser didn't: the child gets a configurable
multi-GB heap (`MAPNG_BAKE_HEAP_MB`, default half the machine's RAM), and it
**never decodes textures** — the capture loader keeps Google's compressed JPEG
bytes, ~10× smaller than the RGBA bitmaps + canvas snapshots the browser pays
for. A 1 km² standard bake also runs ~3× faster (no tab throttling, no GPU).

Properties worth knowing:

- **Jobs are keyed by the bake cache key** and survive page reloads: re-posting
  the same key joins the running job; `restoreBakedGoogle3DTiles()` also probes
  for a *finished* job (covers "reloaded before the IndexedDB persist landed").
- The result is the **persisted-bake record schema** in a binary container
  (`MBK1`: u32 magic, u32 unpadded header length, JSON header, 4-byte-aligned
  payload), decoded by `googleBakeSidecar.js` and fed through the exact same
  `deserializeGroup()` as an IndexedDB hit — downstream consumers can't tell
  the difference.
- Worker stdout is NDJSON protocol; ALL logging (including the shared core's
  `console.info`) goes to stderr and is relayed to the vite terminal and the
  browser console (`console.debug`).
- In prod builds (Cloudflare) the health probe fails and everything behaves as
  before — in-tab bake with the old limits. Same graceful-degradation pattern
  as the Blender DAE bridge.

### Fly-mode refinement (bake sessions)

After the base bake the worker process **stays resident** ("bake session"):
warm LRU cache, full selection set, vertical anchor. The 3D preview's fly
mode turns that into interactive quality painting — fly anywhere
first-person, press **R**, and the sidecar sweeps ONE station at your exact
camera pose (position, direction, **your FOV**), re-runs the finest-covering
dedup over the union of all sweeps so far, transforms only the newly kept
tiles and rewrites the result. A refinement takes ~15–25 s instead of a full
re-bake; superseded coarser parents are dropped, so no double geometry.

#### Tutorial

1. `npm run dev`, open the app, pick an AOI, generate the 3D preview.
2. Scene Settings → *Google 3D Tiles* → **Load** (any quality tier). Wait for
   ready.
3. Click **Fly mode: refine by view**. Click into the scene to capture the
   mouse: **WASD** moves, **E/Q** up/down, **Shift** boosts, **mouse wheel**
   changes speed, the HUD slider sets your **FOV**, **ESC** releases the
   mouse.
4. Fly to a spot that looks mushy, frame it, press **R** (or the HUD button).
   The HUD shows the sweep; when it finishes the group swaps in place —
   sharper tiles exactly in that frustum. Keep flying, refine as often as
   you like; each pass costs seconds because the session cache is warm.
5. "Show camera positions" displays your refinement stations as **cyan**
   markers next to the automatic ones.
6. Exports pick up the refined bake automatically — it's the same cached
   group, persisted to IndexedDB under the same key.

Notes:
- If the tiles came from the IndexedDB cache (page reload, dev-server
  restart), there's no live session — the first refine transparently re-runs
  the base sweep once (HUD: "Rebuilding bake session…"), then refines. With
  the tile disk cache (below) that rebuild downloads NOTHING from Google.
- Sessions are reaped after 15 min idle (`MAPNG_BAKE_SESSION_IDLE_MS`); each
  one parks a multi-GB worker process. The bake itself survives reaping.
- `node scripts/smokeRefineSession.mjs` exercises the whole protocol
  headlessly (bake → 2 refines → container/anchor assertions).

#### Tile disk cache

The worker caches every fetched GLB under
`node_modules/.cache/mapng-google-tiles/` (LRU, `MAPNG_TILE_CACHE_MB`,
default 8 GB), so session rebuilds, quality switches and force re-bakes
replay from local disk: a 1 km² standard rebuild serves ~6.8k tiles / 650 MB
with zero Google requests, cutting the sweep from ~50 s to ~30 s (the rest is
quiet-window detection, not I/O).

**The cache canNOT key on URLs** — Google's `/files/<blob>.glb` path is an
opaque per-session token; two sessions over the same AOI share zero paths
(verified empirically). Keys are the tile's geometric identity instead:
dataset id + ECEF bounding box (cm-rounded) + geometricError, which the
tileset reproduces exactly across sessions. The URI→key mapping is recorded
in a `requestTileContents` hook (the only place the tile object and its
content URL meet) and consumed by the `fetchData` wrapper
(`scripts/googleTileDiskCache.mjs`).

#### Refinement reaches Google's FINEST LOD — it's not the base bake's depth

The base bake runs at `errorTarget=5` / `sensor=1024–1536` — values chosen to
bound TOTAL memory across every station over the whole AOI. A refinement
sweeps ONE frustum, so it runs FAR more aggressively: `errorTarget=1`,
`sensor=2048` (env-tunable, see below). That difference is the whole point —
at `errorTarget=5` a close-up street camera pulls only *somewhat* deeper
tiles (soft textures, edgy silhouettes vs Google Maps); `errorTarget=1` on a
high-res buffer reaches Google's deepest tiles, sharpening textures AND mesh
(both are functions of tile depth). The cost stays bounded because only the
user's frustum refines — off-frustum tiles aren't visible and stay put.

Tune without code edits (restart the dev server to apply):

| env var | default | effect |
|---|---|---|
| `MAPNG_REFINE_ERROR_TARGET` | `1` | screen-space-error cap (px). Lower = deeper, until Google's max LOD floor. |
| `MAPNG_REFINE_SENSOR` | `2048` | virtual sensor px for the refine frustum. Higher = deeper. |
| `MAPNG_REFINE_MAX_WAIT_MS` | `180000` | per-refine budget (deep frustums download a lot cold; the disk cache makes repeats fast). |

The refine log line reports the actual `errorTarget`/`sensor`/`fov` and the
`+added/-removed` tile delta — a big `+added` confirms it reached deeper.

#### Wire format

`POST /api/google-bake/<id>/refine` with `{station: {e, n, heightM, lookE,
lookN, lookHeightM, fov, errorTarget?, sensorSize?, maxWaitMs?}}` — ENU
metres from the AOI centre, heights in metres above the `.ter` datum
(= preview scene-Y ÷ `unitsPerMeter`); the optional last three override the
aggressiveness per-refine. The worker converts to ECEF with the session's
stored `googleGroundAlt`, so refined geometry can never float relative to the
base bake. Completion is the `refined` SSE event carrying the revision;
`GET /<id>/result` then serves the rewritten container (header `revision` +
`anchor` fields).

### Headless-Node gotchas (the sidecar's own lessons)

- **Never import the `3d-tiles-renderer` package indices in Node.** Both the
  root index and `/plugins` transitively evaluate the glTF-metadata
  `TextureReadUtility`, which constructs a `WebGLRenderer` at module scope →
  `document is not defined`. `headlessTilesEnv.mjs` deep-imports the needed
  modules by file path and `headlessTilesHooks.mjs` (a Node resolve hook)
  redirects the one shim import baked into `GLTFExtensionLoader`.
- Remaining DOM surface is tiny and polyfilled in `headlessTilesEnv.mjs`:
  `window.location.href`, `requestAnimationFrame`, `ImageBitmap`.
- **Texture capture**: `GLTFExtensionLoader` checks `manager.getHandler()`
  before building its own decoding loader — `addHandler(/\.(glb|gltf)$/i, …)`
  injects a GLTFLoader whose `loadTexture` plugin returns stub `Texture`s
  carrying the raw image bytes (non-enumerable property, NOT `userData`:
  `Texture.copy()` round-trips userData through JSON and would corrupt them).
- `tiles.setResolution(cam, w, h)` replaces the offscreen-renderer dance; the
  browser bake now uses it too.

While the tiles are visible, the preview auto-hides the OSM-extruded buildings
(`featureVisibility.buildings`) and restores the previous setting when the tiles are
hidden — both at once just z-fight inside the photogrammetry.

The cached group is owned by the cache: consumers never mutate or dispose it (the BeamNG
export clones geometries before transforming, GLB/DAE clone the mesh nodes).

## Tuning knobs

In `bakeGoogle3DTiles()` in `services/google3dTiles.js`:

| Option | Current default | Effect |
|---|---|---|
| `errorTarget` | **5** | Screen-space-error target in pixels. Lower = more tiles, higher mesh + texture detail. Library default 6, GoogleTilesRenderer default 40 (realtime). 5 yields ~4× more tiles than 8 baseline. Next quality dial: 3–4. |
| `cameraSweep` | `true` | Sweep one camera through 5 stations (top-down + N/E/S/W oblique) so facades get refined. ~2–3× bake time/requests vs top-down only. |
| `stripGround` | `true` | Drops street-level tris so mapng's heightmap terrain shows through. |
| `groundNormalThreshold` | `0.85` | `|normal.y|` above this counts as near-flat. |
| `groundDistanceM` | `2.5` | Near-flat tris are only stripped within this many metres of the mapng terrain — streets go, flat/gentle roofs stay. |
| `maxWaitMs` | `300000` | Hard cap on total bake time across all sweep stations. |
| `stabilityMs` | `2500` | Queue must stay quiet this long per station to be considered done. |
| `lruCache.maxBytesSize` | `1.5 GB` (set in code) | The library refuses to load tiles while the cache `isFull()`. The 0.3.46 default byte cap (0.4 GB) saturates around errorTarget=5 and silently truncates the bake. |
| `downloadQueue.maxJobs` / `parseQueue.maxJobs` | `20` / `6` | Library defaults are 10 / **1** — single-threaded parsing dominated bake time at higher tile counts. |

Rough estimates (1 km² dense urban AOI):

| `errorTarget` | Tiles | Bake | Zip add | Tile requests |
|---|---|---|---|---|
| 8 | ~330 | ~20 s | ~34 MB | ~1k |
| **5 (current)** | **~1.3k+** | **~2–4 min with sweep** | **~150–250 MB** | **~4–10k** |
| 3 | ~3k | ~5–10 min | ~400 MB | ~10–25k |
| 1 | ~8k | OOM risk; raise LRU caps first | ~1 GB | ~25k+ |

**Billing:** Google charges per **root tileset request** (a ~3 h session), *not* per tile —
$6 per 1,000 root requests after 1,000 free per month. One bake ≈ 2 root requests
(preflight + session) ≈ $0.01; the per-tile request counts above are quota, not cost.
The practical ceiling used to be browser memory (snapshot canvases) — with the Node
sidecar (see above) the dev-time ceiling is the worker heap, leaving room to push
`errorTarget`/quality further; the browser limits only apply to prod builds.

## Layout in the level zip

```
levels/<level>/
  art/shapes/
    osm_objects.dae                  (OSM roads + building COLLISION;
                                      building visuals hidden w/ Google tiles)
    main.materials.json              (osm_object vertex-colour material)
    google_tiles/
      google_tiles.glb               (photogrammetry — convert once w/ Blender)
      beamng_glb_to_dae.py           (the converter, Blender ≤4.2)
      README_CONVERT.txt             (the command)
      google_tiles.dae               (created by the conversion step)
      main.materials.json            (google_atlas_NN colorMap entries)
      google_debug.dae               (diagnostic cube)
      textures/
        google_atlas_00.png
        google_atlas_01.png
        …
  main/MissionGroup/Level_objects/Other/
    items.level.json
      "name": "osm_objects"          (TSStatic)
      "name": "google_tiles"         (TSStatic, collisionType None)
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

### 7. Multiple SIMULTANEOUS cameras break the bake — sweep ONE camera instead
A 5-camera rig (top-down + 4 perimeter oblique) registered at once caused the renderer to return 0 tiles, killing the export silently. **Resolved** by sweeping a single camera through 5 stations *sequentially* (top-down, then N/E/S/W oblique at `dist=1.1×extent, alt=0.8×extent` — whole AOI inside the 60° frustum, far from the near plane). Tiles loaded at earlier stations stay in the LRU; see lesson 13 for how the selections are combined.

### 8. `.env.local` is the right secrets path; `.env` is committed by convention
Vite reads both. The user's `.gitignore` already excludes `*.local`, so `.env.local` is the safe place for the API key. `.env.example` is committed as documentation.

### 9. `mergeGeometries()` returns null on ANY attribute mismatch
`mergeGeometries(tileGeoms, true)` requires every geometry to carry the **identical attribute set**. Google occasionally ships untextured tiles (no `uv`); one such tile makes the merge return null → `generateGoogleTilesDAE` returns null → no DAE, no debug cube, no scene-tree entries, **no console error**. Looks exactly like the multi-camera 0-tiles failure but has a different cause.

Fix: `bakeGoogle3DTiles()` guarantees `position+uv+normal` on every output geometry, zero-filling `uv` when the source has none. Never filter or conditionally add attributes in the merge path.

### 10. The LRU cache byte cap silently truncates big bakes
`3d-tiles-renderer@0.3.46` only loads new tiles while `!lruCache.isFull()`, and `isFull()` trips at `cachedBytes >= 0.4 GB` by default. At errorTarget=5 (~1.3–1.8k photogrammetry tiles) the cap saturates mid-bake; queues drain, the stability window passes, and the bake "succeeds" with partial coverage. The bake now sets `maxBytesSize = 1.5 GB` and logs `cacheFull` at the end — if you see the saturation warning, raise the budget or the errorTarget.

### 11. A failed bake must not kill the level export
`generateGoogleTilesDAE()` is wrapped in try/catch at the call site; on failure the export logs `[BeamNG export] Google 3D Tiles bake failed` (and surfaces it in the progress UI) and continues with the OSM-only level. Empty bakes throw descriptive errors (`0 tiles loaded` vs `none survived AOI clipping`) instead of silently returning nothing. A preflight `root.json` fetch fails in ~1 s with Google's actual error — the library (0.3.46) never dispatches `load-error`, so without it a dead key polls 0 tiles for the whole bake budget (404 "Requested entity was not found" = Map Tiles API not enabled/allowed for the key).

### 12. Probe the ground anchor HORIZONTALLY
`googleGroundAlt` anchors Google's ground to mapng's terrain at the AOI centre. An early version measured 3D ECEF distance from a point at *ellipsoid height 0* — real ground sits tens of metres above the ellipsoid (geoid offset + elevation, ~75 m in Berlin), so no vertices fell inside the probe sphere, the anchor collapsed to 0, and the whole city floated by that altitude. Probe by lat/lon distance and take the **5th-percentile** altitude (not the minimum — canal beds and basement junk would sink it). The bake logs `vertical anchor: …` for debugging.

### 13. `tiles.group` only holds the CURRENT selection — snapshot per station
The renderer adds/removes tile scenes from `tiles.group` as the selection changes, so after a camera sweep a final `group.traverse()` would only see the *last* station's tiles. Snapshot `tiles.visibleTiles` after each station, union the sets, then dedupe to the **finest covering**: drop a tile only when selected descendants fully cover its area (recursive check over `tile.children`); keep partially-covered ones — a small LOD overlap beats a hole. Loaded-but-deselected scenes live on in the LRU cache (`tile.cached.scene`); call `scene.updateMatrixWorld(true)` before reading their geometry.

### 14. Torque meshes use 16-BIT vertex indices — chunk at ≤60k verts
A single merged geometry with millions of vertices imports into BeamNG with wrapped indices: shapes survive (positions get split/processed) but **texcoords scramble into kaleidoscope** — in-game only, while Three.js (32-bit indices) renders the same data perfectly. This was the real cause behind "textures all over the place", misdiagnosed twice (first as material bindings, then as atlas mapping). Emit many meshes of ≤60,000 vertices.

### 15. Trailing digits in a mesh/node name are parsed as the LOD detail size
That's *why* `Colmesh-1` works (negative = never rendered). A chunk named `foo_000` becomes "render at detail size 0" → invisible; mixed numeric suffixes become distance-switching LOD levels → flickering chaos. Every mesh name must end in a letter (`..._mesh`). This also retroactively explains lesson 5's "multiple sibling meshes are invisible" — those test meshes had numeric suffixes; the topology was never the problem (osm_objects.dae happily ships multiple meshes in a group).

### 16. Don't hand-roll the final DAE — export GLB, convert with Blender ≤4.2
After lessons 1–15 the conclusion: BeamNG's importer has more undocumented constraints than it's worth reverse-engineering. The shipped pipeline exports a clean GLB via three's battle-tested `GLTFExporter` (verifiable in any glTF viewer — the checkpoint this project never had) and converts it once, offline, with `scripts/beamng_glb_to_dae.py` using Blender's Collada exporter — the same one the BeamNG modding community uses. **Collada export was REMOVED in Blender 5.0+**; use 3.x/4.x (portable 4.2 LTS zip works without installing). Axis chain: the GLB is authored as `(s·x, yMetres, s·z)` so glTF(Y-up) → Blender(Z-up) → Collada `Z_UP` lands exactly in BeamNG world coordinates.

## Known issues / open questions

- **Texture quality** — much improved by the camera sweep; the next dial is `errorTarget` 5 → 3–4 (raise the LRU byte budget along with it).
- **Slight LOD overlap** — partially-covered coarse tiles are kept (lesson 13), so a sliver of doubled geometry can z-fight in rare spots. Acceptable trade vs holes so far.
- **Google data gaps** — inner courtyards, under trees, narrow alleys are missing in the source photogrammetry itself; no bake setting fixes those.
- **No height calibration UI** — the Y offset is fully formula-driven now; if BeamNG terrain has unusual `maxHeight` settings, a `verticalOffset` slider may still be wanted.
- ~~Collision mesh = visual mesh~~ — solved: photogrammetry is visual-only (`collisionType: None`), the hidden OSM building boxes in `osm_objects.dae` provide cheap watertight collision.
- ~~Manual conversion step~~ — solved: the Vite dev-server bridge converts automatically during export (~7 s for a 75 MB GLB); manual fallback remains for prod builds / missing Blender.
- **OSM buildings sky bug** — see lesson 6 note. Separate fix.

## Branch + commit

Branch: `google`

- `a7d5aea` Bake Google Photorealistic 3D Tiles into BeamNG level exports
- `c25e13f` Preview Google 3D Tiles in-app with a shared bake cache (+ pipeline hardening, lessons 9–11)
- `b196bde` Anchor Google tiles vertically via horizontal ground probe (lesson 12)
- `995db47` Sweep the bake camera and make ground stripping height-aware (lessons 7/13)
- `8285d5b` Persist baked Google tiles in IndexedDB and auto-restore on load
- `22b3ce8` Atlas-texture the Google tiles DAE; split visuals and collision
- *(next)* Export GLB + Blender conversion route — first version confirmed working in-game (lessons 14–16)
