# Plan: Semantic ground-mask conform — flatten streets, kill floaters

Status: proposed. Supersedes the band-only behaviour of `conformTilesToFloor`
described in [plan-tile-terrain-conform.md](plan-tile-terrain-conform.md) (S2).
This is additive — the smooth delta field stays as the off-road fallback.

## Problem (root cause, from the current code)

The bake conforms Google 3D-Tiles photogrammetry to the smooth DEM via a single
low-frequency **delta field** D(x,z) on a **6 m grid**
([tileGroundConform.js:53](../services/tileGroundConform.js), `cellM=6`). Two
consequences the user sees:

1. **Streets wiggle.** D is bilinear over 6 m cells and only *shifts* geometry;
   it cannot flatten. High-frequency noise in the photogrammetry road surface is
   below the grid and survives untouched.
2. **Floaters > ±2.5 m are never pulled down.** `groundDistanceM = 2.5` is a
   *band* used at field-build time: any triangle whose mean `aboveTerrain` is
   `>= 2.5 m` is skipped ([line 91](../services/tileGroundConform.js)). Apply
   (Pass 2) already shifts every vertex up to `maxShiftM=15`, so this is a
   **coverage** failure, not an apply clamp: regions that float uniformly >2.5 m
   contribute no samples, their cells are inpainted from neighbours (or fall back
   to ~0), and the float stays.

The band can't simply be widened — its lower bound exists to reject subterranean
horizontal geometry (underpasses, garage/canal floors, photogrammetry junk) that
would otherwise poison D with large negative residuals.

## Key insight

We already rasterize a **top-down road mask** from vector OSM polylines
([batchExports.js:127](../services/batchExports.js), `generateRoadMaskBlob`).
That mask is everything the delta field is not: **full-resolution (~1 m/px,**
`resolution` = pixels = metres, [terrain.js:900](../services/terrain.js)**),
vector-authored (zero photogrammetry noise), and semantic** — it tells us with
certainty which (x,z) is road.

Semantic certainty is exactly what lets us bypass the conservative 2.5 m band
*safely*: a near-horizontal vertex that we *know* is road can be snapped to the
DEM no matter how far it floats, because there is no risk of mistaking it for a
building or an underpass.

## Design

Layer a **full-resolution, feathered, mask-driven snap** on top of the existing
delta field. For every vertex compute two candidate heights and blend by a
per-vertex mask coverage weight `w ∈ [0,1]`:

```
terr      = sampleHeightAtScene(data, x, z) - minH      // smooth DEM, above-datum frame
ySnap     = terr + ROAD_EPS_M * upm                     // sit on the DEM (+ z-fight epsilon)
yDelta    = p.y - clamp(field.sample(x, z), ±maxShiftM) // existing smooth conform
yOut      = lerp(yDelta, ySnap, w)
```

- `w = 1` deep inside a road, near-horizontal → vertex lands exactly on the
  smooth DEM. Wiggle gone; floaters (any height) gone.
- `w = 0` off-road → unchanged from today's delta field.
- `0 < w < 1` in the feather band around road edges → continuous transition, so
  the continuous tile mesh does **not tear** at road/curb boundaries.

The two targets already agree in the mean (the delta field is also built to aim
at the DEM), so the feather lerp only resolves the high-frequency difference — no
ridge at the seam.

### Mask coverage `w` — what gates it

`w` is the product of three factors:

1. **Road footprint** with a soft edge. Rasterize a coverage/distance field once;
   per-vertex `w_geom = smoothstep(featherM, 0, distToRoadEdgeM)`. Width is per
   road class (motorway/primary wider than residential), not the fixed 8 px the
   export mask uses ([batchExports.js:143](../services/batchExports.js)).
2. **Near-horizontal gate.** Reuse `groundNormalThreshold = 0.85` on the
   vertex's incident-triangle normal, so a building facade or curb riser that
   happens to overlap a road pixel is *not* flattened. (Computed per triangle as
   today; a vertex's gate = max over its incident ground-classified tris.)
3. **Not a bridge / not a tunnel.** Exclude OSM features tagged
   `bridge`, `tunnel`, or `layer != 0` from the snap mask — those roads are
   legitimately above/below the DEM and must keep their baked height. (The
   current export mask ignores this; it's a latent correctness bug we fix here.)

### Generalising "road" → "flat ground" (the "once and for all" part)

The same mechanism extends to any OSM feature that is *by definition* flat
ground: parking aisles, pedestrian plazas, squares, service areas, paved
`landuse`. Rasterising those polygons into the same coverage field lets the snap
fix non-road ground floaters too, still semantically safe. Roads ship first
(Phase 1); area polygons are Phase 2 behind the same code path.

### What we deliberately do NOT auto-flatten

Non-road, non-bulk geometry that floats >2.5 m with no semantic label (could be a
low building, berm, wall) stays governed by the delta field. We do not guess.
Buildings *should* float above ground by their height — the delta field already
shifts them by the local ground D and preserves relative height; that is correct.

## Changes by file

### New: `services/groundMask.js` (DOM-free)

The conform runs in the Node sidecar worker, so **no canvas**. Pure-JS
rasteriser, unit-testable in plain Node, identical in browser + worker (same
constraint that `scalarFieldGrid.js` already satisfies).

- `buildGroundMask(osmFeatures, data, opts)` →
  `{ sample(x, z): number /* w in [0,1] */, width, height }`.
- Work in **scene space** using the *same* mapping as `sampleHeightAtScene`
  (`u=(x+SCENE_SIZE/2)/SCENE_SIZE`), so per-vertex sampling is trivially
  consistent with the DEM lookup — do **not** reuse the export mask's
  meters-based `createWGS84ToLocal` mapping.
- Rasterise a Float32 coverage grid (resolution = `data.width × data.height`, the
  heightmap res ≈ 1 m/px) by stamping each road segment: for cells within
  `halfWidth + featherM` of the segment, write `smoothstep` of the
  signed distance. `max`-combine overlapping segments. This gives the feather for
  free (no separate blur pass).
- Filter features: `type === 'road'`, drop the existing pedestrian excludes, and
  additionally drop `bridge`/`tunnel`/`layer != 0`. Per-class width table.
- Bilinear `sample` with edge clamp (mirror `scalarFieldGrid.sample`).

### `services/tileGroundConform.js`

- New opts: `{ groundMask = null, roadEpsM = 0.02, featherM = 3,
  snapNormalThreshold = groundNormalThreshold }`. Fully backward-compatible —
  with `groundMask = null` behaviour is identical to today.
- In Pass 2, when `groundMask` is present, compute `ySnap`, `w` (mask × normal
  gate), and `yOut = lerp(yDelta, ySnap, w)` instead of the plain `yDelta`.
- The vertex normal gate needs per-vertex normals. Cheapest: in Pass 1 we already
  visit every triangle and classify near-horizontal ground — accumulate a
  per-vertex `maxNy` (or a `isGroundVertex` bitset) there and reuse it in Pass 2.
  Avoids a second normal computation.
- **Decouple the band's two roles** so the field-build outlier rejection
  (`groundDistanceM`) is documented as build-only; apply already has no 2.5 m
  ceiling. Add a comment + keep the name. No behaviour change, just clarity.
- Extend the returned diagnostics: `vertsSnapped`, `snapResidualBefore/After`,
  `maxFloatFixedM` so the test lab and the `console.info` log line report how
  many floaters were brought down and by how much.

### `services/google3dTiles.js`

- Build the mask from `data.osmFeatures` once, just before the conform call
  ([~line 420](../services/google3dTiles.js)), and pass it in:
  `conformTilesToFloor(soup, data, { groundMask })`.
- Gate behind the existing `conformTilesEnabled()` flag, plus a sub-flag
  `mapng_conform_roadmask` (default ON) so it can be toggled independently in the
  lab without disabling the whole conform.
- Extend the bake cache key string ([~line 564](../services/google3dTiles.js))
  with mask params (`featherM`, road-width table version) so changing them
  invalidates stale bakes.
- Bump `BAKE_FORMAT_VERSION` (currently 6) so existing bakes re-conform.

## Parameters (initial defaults)

| Param | Default | Rationale |
|---|---|---|
| `roadEpsM` | 0.02 m | Matches the existing road-surface offset in `createRoadGeometry` and the z-fight epsilon commit. |
| `featherM` | 3 m | ~3 cells of mask; wide enough to avoid tears, narrow enough to keep roads flat. Tune in lab. |
| per-class road half-width | motorway 12 / primary 8 / secondary 6 / residential 4 / service 3 m | Replace the fixed 8 px stamp; align mask to real carriageway. |
| `snapNormalThreshold` | 0.85 | Same gate as ground classification; excludes facades/curb risers. |

## Edge cases / risks

- **Mesh tearing** at road edges → solved by the feather lerp; verify on a tile
  straddling a curb.
- **Bridges / overpasses / tunnels** → excluded from the mask via tags; if OSM
  layer data is missing they fall back to the delta field (no worse than today).
- **Curbs, retaining walls, railings over road pixels** → excluded by the
  near-horizontal gate.
- **Datum / vertical anchor** interplay — the route-wide anchor
  ([google3dTiles.js:127](../services/google3dTiles.js)) and `minHeight` framing
  must be applied before the snap; snap targets `sampleHeightAtScene - minH`,
  same frame Pass 2 already uses ([line 146](../services/tileGroundConform.js)).
- **Mask ↔ DEM misregistration** — both derive from the same AOI/bounds and we
  sample in scene space, so they share one mapping; add a test asserting a known
  road centreline samples `w≈1` at the expected XZ.
- **Performance** — one segment-stamp rasterise (O(segments × stamp footprint))
  + per-vertex bilinear sample (O(verts)). Negligible vs the bake. Corridor mode
  with large AOIs: cap mask grid to the heightmap dims (already bounded).
- **Multi-chunk / corridor seams** — mask built per chunk from that chunk's
  `osmFeatures`; since snap targets the shared DEM, adjacent chunks agree at the
  seam by construction (this is why we snap to DEM, not to a per-chunk field).

## Test plan (plain Node, mirrors existing `tests/*.mjs`)

New `tests/groundMask.test.mjs`:
- A straight road polyline → coverage is 1 on the centreline, smoothstep across
  `featherM`, 0 well outside. Width respects road class.
- `bridge`/`tunnel`/`layer` features produce zero coverage.

Extend `tests/tileGroundConform.test.mjs`:
- **Wiggle**: synthetic flat DEM + a road mesh with ±1 m sinusoidal noise on a
  road mask → post-conform road residual ≈ 0 (was ≈ the noise amplitude with the
  delta field alone). Assert RMS drop.
- **Floater**: a road mesh sitting uniformly +5 m (beyond the 2.5 m band) on a
  road mask → snapped to DEM (residual ≈ `roadEpsM`). Assert the old path leaves
  it floating and the mask path fixes it.
- **No-tear**: a tile mesh straddling the mask edge → vertical gap between
  adjacent on/off-road verts stays < small bound (feather continuity).
- **Off-road unchanged**: building verts with `groundMask` set get the *same* Y
  as with `groundMask=null` (snap touches only masked, near-horizontal verts).
- **Bridge preserved**: a road tagged `bridge` at +5 m is NOT snapped.

## Rollout

1. Phase 1: `groundMask.js` + roads-only snap + tests, behind
   `mapng_conform_roadmask` (default ON). Bump `BAKE_FORMAT_VERSION`, extend
   cache key.
2. Verify in the conform lab/diagnostics on a dense urban AOI and a rural one;
   read the new `vertsSnapped` / `maxFloatFixedM` log line (no screenshots).
3. Phase 2 (DONE): mask now also fills flat-ground area polygons (amenity=parking,
   place=square, area=yes pedestrian/footway/living_street/service, area:highway)
   via `stampPolygon` — interior w=1, feathered outer edge, holes punched out,
   bridges/tunnels/buildings excluded. Same blend/snap path as roads.

## Out of scope

- Auto-flattening unlabelled >2.5 m ground (no semantic signal — left to the
  delta field).
- Changing the procedural `createRoadGeometry` roads — those already read the DEM
  per vertex and don't wiggle; this plan targets the Google 3D-Tiles mesh.
