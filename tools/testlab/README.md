# Conform Test Lab

A standalone visual + headless harness for the S2 tile→floor conform
(`services/tileGroundConform.js`). Runs on its own port, reuses the **real** app
modules, and works against either a synthetic scene or a **real Google 3D Tiles
bake**.

## Run the viewer

```bash
npm run testlab            # http://localhost:5180  (PORT=… to change)
```

Open `/` in a browser: BEFORE (tile ground drifting above the floor) vs AFTER
(real conform applied), the delta-field heatmap, and stats. The **Scene source**
dropdown picks the synthetic scene (drift sliders) or any real capture.

## Capture a real bake

Runs the actual headless bake worker (`scripts/googleBakeWorker.mjs`) with the
conform disabled, fetches the real DEM (Terrarium), and dumps the soup so the lab
can apply the conform live. Key read from `.env.local`
(`VITE_GOOGLE_MAPS_API_KEY` — Google or Cesium ion).

```bash
node tools/testlab/captureRealBake.mjs \
  --lat 52.5163 --lng 13.3777 --size 280 --quality standard --name berlin_gate
```

Then reload the lab and pick `berlin_gate`. Captures land in
`tools/testlab/captures/` (git-ignored).

## Verify headlessly (no browser)

```
GET /api/conform?capture=berlin_gate   → JSON stats (residual before/after,
                                          vertical extent, verts moved)
GET /api/conform                        → same, synthetic (drift via query)
GET /api/field.png[?capture=…]          → delta-field heatmap PNG
GET /api/scene.json[?capture=…]         → before/after geometry for the viewer
GET /api/captures                       → list captured bakes
```

`groundResidual…M` is the **mean-absolute** distance of tile ground from the
floor; conform should lower it. `verticalExtent…M` must stay ≈ unchanged (a
flattening regression would collapse it).

## Multi-chunk route model

The single-chunk view doesn't catch route-mode seating bugs. `routeScene.mjs`
models the real route vertical pipeline — a route-wide shared anchor, the conform
applied PER CHUNK against that chunk's own terrain, the **combined** terrain the
level actually drives on (`buildCombinedRouteTerrain`), and `baseUp` placement —
then measures each chunk's residual against the combined surface.

```bash
npm run test:route    # tests/routeConform.test.mjs
```

Key result: a route-wide geoid drift is fully absorbed by the per-chunk conform,
but where adjacent chunks' DEMs disagree (different elevation tiles, or the
coarser combined grid smoothing slopes) the per-chunk conform leaves a residual
vs the combined surface — the "one chunk lifted ~1 m" symptom. Conforming against
the **combined** terrain instead removes it (`conformMode: 'combined'`).

## Files

| file | role |
|---|---|
| `server.mjs` | HTTP routes; drives the real conform |
| `scene.mjs` | synthetic Google-shaped scene generator |
| `terrainHeadless.mjs` | Terrarium DEM fetch (the one browser-coupled gap) |
| `captureRealBake.mjs` | real bake → capture fixture (spawns the bake worker) |
| `binContainer.mjs` / `captureStore.mjs` | read MBK1 container / load captures |
| `render.mjs` | delta-field heatmap PNG (fast-png) |
| `index.html` / `app.mjs` | three.js before/after viewer |

Nothing here mocks the unit under test — `conformTilesToFloor` is the real app
module; the lab only feeds it real or controlled input.
