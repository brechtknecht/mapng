# Google 3D Tiles — Mesh Assembly Problem Statement

Status: **post-processing DISABLED by default (2026-06-24)** — the bake ships raw
transformed tiles while a new ground/surface strategy is designed. Every pass is
still opt-in (localStorage / env flags + per-bake options + `/quality-sandbox`
toggles). `BAKE_FORMAT_VERSION = 15`. The analysis below stands as the record of
why each pass was removed and what a replacement must satisfy. Created via the
`/quality-sandbox` A/B lab.

> Decision (user): "the strat is bad in general. remove all post processing for
> now; I'll come back with a new strat after thinking and tinkering." So weld,
> conform, road-mask, and ground-strip are all OFF by default. Raw tiles were the
> cleanest option in the lab. The requirements a new strategy must still meet are
> in "What a replacement must satisfy" below.

## TL;DR

We bake Google Photorealistic 3D Tiles (fetched via the three.js `3d-tiles-renderer`)
into a static mesh for BeamNG. After the tiles are selected, a chain of **geometry
post-passes** runs to make the result watertight and drivable. Empirically, **every
pass makes the surface worse**, and the cleanest result is **all passes off (raw
tiles)**:

| Combination | Result (observed in /quality-sandbox, Times Square, standard/err5) |
|---|---|
| weld + conform + roadmask (production) | road shattered into spikes/sheets |
| no roadmask | corrugation gone, road still bumpy + slightly lifted |
| no conform + no roadmask | cleaner, sits lower |
| **no weld + no conform + no roadmask (RAW)** | **cleanest — matches what CesiumJS draws** |

Per-pass symptoms reported:
- **weld** → creates holes/cracks.
- **conform** → lifts the whole surface a little and adds unevenness.
- **roadmask** → pushes the unevenness to the extreme (spikes).

This document characterises *why* before we change anything, then sets an order of
attack: **weld first** (it runs first and is where the topology damage starts).

## The core thesis

**Google tiles are an overlapping, multi-resolution triangle SOUP, not a surface.**
Independent tiles compose *visually* when drawn with a depth buffer, but they do **not**
share vertices and do **not** form a watertight mesh. Adjacent tiles overlap; LOD
transitions are T-junctions (an edge with N verts on one side, M on the other).

Our pipeline treats this soup as if it were a single editable height-field: each pass
moves vertices **in Y, independently, per-cell or per-vertex, gated by thresholds**.
Because coincident/adjacent vertices across tiles (and across cell boundaries) receive
**different** treatment, points that used to coincide separate → **cracks/holes**;
partially-overlapping LOD tiles that used to resolve by depth get pushed to **different
heights** → **interpenetration / unevenness**. More tiles (finer LOD) = more boundaries
= worse. RAW looks cleanest precisely because, untouched, each tile is internally
consistent and the depth buffer hides the overlap.

Every pass below is a different symptom of this one root cause: **vertex-level Y editing
on a non-welded, overlapping, multi-LOD soup with no shared topology.**

## The pipeline (current order)

In-browser: [bakeGoogle3DTiles.js](../packages/bake/src/tiles/bakeGoogle3DTiles.js) lines ~368–452.
Worker (the dev/default path): [googleBakeWorker.mjs](../scripts/googleBakeWorker.mjs) lines 865–868.

```
selectFinestCovering   → choose tiles (deliberately keeps partial overlap)
transform              → ECEF → scene coords, vertical anchor (probeGroundAltitude)
applyWeld              → close LOD-seam risers (per-XZ ground consensus, snap Y)
applyConform           → seat ground onto the .ter DEM (delta field) + road-mask snap
applyGroundStrip       → drop near-flat ground tris (production only; sandbox = off)
applyRiserStrip        → legacy, off by default
```

## Pass-by-pass

### Pass 0 — tile selection (substrate, not a mutation)
- **What:** [selectFinestCovering](../packages/bake/src/tiles/probeGround.js):56 keeps a tile unless *all* its children are also selected. Comment: *"Tiles partially covered by finer selections are kept — a small overlap beats a hole."*
- **Consequence:** the input to every later pass is **intentionally overlapping** (coarse tile + finer children coexist where coverage is partial) and **T-junctioned** at LOD boundaries. This is the substrate the passes then fight.
- **Hypothesis:** some "holes" and "sheets" are not created by the weld — they are pre-existing overlap/T-junctions that the passes *expose* by moving one layer relative to the other.

### Pass 1 — weld (`weldSeams`) — START HERE
- **File:** [tileSeamWeld.js](../packages/bake/src/tiles/tileSeamWeld.js):48–169.
- **Purpose:** close the little **risers/cracks** where two tiles disagree about ground height at a shared boundary. Root-cause replacement for the old magic-threshold `stripSeamRisers`.
- **Mechanism:** rasterise ground tris into a per-XZ **cell grid** (`effCellM`, ~1 m); each cell keeps the finest LOD's mean Y; Pass B snaps each vertex to its **own cell's mean Y**, gated by `cohereM` (1.5), `maxRiserM` (2.5), `bandM` (1.5).
- **Observed:** holes/cracks.
- **Root-cause hypotheses (to verify):**
  1. **Cell-boundary quantization.** Two coincident verts (tile A at x=0.99, tile B at x=1.01) quantize into *different* cells → different means → they separate vertically → crack. Dense meshes have many verts near cell edges.
  2. **T-junctions can't be closed by Y-snap.** A coarse edge (2 verts) against a fine edge (5 verts) stays a T-junction no matter the Y; snapping the 2 coarse verts to the fine ground can *open* a gap mid-edge.
  3. **Gate inconsistency between neighbours.** One vertex passes `maxRiserM`/`bandM`/`cohereM`, its triangle-neighbour fails → the shared triangle is stretched/torn.
  4. **Idempotence assumption.** "Both tiles' verts in one cell resolve to the identical mean" holds only if both tiles actually drop verts in that cell; near boundaries one tile may contribute and the other not.
- **Open question:** is the weld even necessary if we strip the ground in production (Pass 3)? It may only matter for **preview with ground kept** and for **building-base seams**.

### Pass 2 — conform (`conformTilesToFloor`, delta field)
- **File:** [tileGroundConform.js](../packages/bake/src/tileGroundConform.js).
- **Purpose:** Google's ground SHAPE ≠ the mapng `.ter` DEM, and there's a spatially-varying datum residual the single-point vertical anchor can't fix. Build a smooth field `D(x,z)` of the residual over real ground and subtract it from every vertex, so ground lands on the floor while buildings keep their height above it. Needed so building bases sit correctly once the ground is stripped.
- **Observed:** lifts the whole surface slightly and adds unevenness.
- **Root-cause hypotheses (to verify):**
  1. **Anchor vs field interaction.** `probeGroundAltitude` seats ground at a low percentile (5th); the delta field then targets the band mean — net vertical shift may be positive (apparent lift). Verify the sign of `D` and the anchor offset on a flat AOI.
  2. **Sparse / inpainted cells.** Cells with no ground samples fall back to `D=0`; neighbours with samples shift → relative steps (unevenness) at the sample/no-sample boundary.
  3. **Field sampled across real discontinuities.** Bilinear `D` interpolated across a curb/embankment smears a correction onto geometry that didn't need it.
- **Note:** this pass is partly redundant with the depth buffer for *preview*, but real for *export* (building-base alignment after ground strip).

### Pass 3 — road-mask snap (inside conform)
- **Files:** mask [groundMask.js](../packages/bake/src/groundMask.js); snap in [tileGroundConform.js](../packages/bake/src/tileGroundConform.js) Pass 2.
- **Purpose:** flatten road photogrammetry wiggle and pull down floaters the delta-field band can't reach, so roads are drivable.
- **Status:** partially worked this session. Root cause was: only **near-horizontal** verts were snap candidates, and the *exclusion* used the loose 0.85 ground threshold, so on dense meshes scattered road verts were left at Google height among snapped neighbours → corrugation/spikes. Changed to **snap every masked vertex except true walls** (`wallNormalY=0.34`) + tapered the `maxSnapM` cliff (`snapTaperM`). Bumped `BAKE_FORMAT_VERSION` to 14.
- **Remaining:** the snap still operates on the **weld+conform output**, so it inherits their damage. It cannot be judged in isolation until weld + conform are clean. The user reports it still extreme on top of broken weld/conform — consistent with "fixing pass 3 on a broken pass 1/2 substrate."

### Pass 4 — ground strip (`stripGroundTris`)
- **File:** [tileSeamWeld.js](../packages/bake/src/tiles/tileSeamWeld.js):189.
- **Production behaviour:** `stripGround = true` removes near-flat tris within `groundDistanceM` (2.5 m) of the `.ter`, so the **smooth `.ter` terrain becomes the drivable surface** and Google supplies the buildings. The sandbox runs `stripGround = false` to inspect the full tile.
- **Why the upstream passes still matter despite the strip:** the strip only removes **near-flat** tris. Weld/conform/roadmask artifacts are **steep spikes**, which survive the strip and poke through the `.ter` terrain. So a broken ground pass leaks into the shipped product even though the flat road is discarded.

## What a replacement must satisfy

Raw tiles are clean to look at but don't meet the export needs the removed passes
were (badly) trying to meet. A new strategy must address these — ideally WITHOUT
per-vertex Y editing of the overlapping soup, which is the shared root cause:

1. **Drivable surface = `.ter`, Google = buildings.** Google's ground must either be
   removed cleanly or made coincident with `.ter`, with **no patchy holes** and no
   z-fighting against the terrain. (Was: ground-strip + conform — failed at edges.)
2. **Buildings sit at the right height across the WHOLE AOI**, not just the centre —
   robust to the Google↔`.ter` vertical drift that grows outward. (Was: single-point
   anchor + delta field — failed past ±2.5 m.)
3. **No cracks/holes at LOD transitions** between tiles of different detail. (Was: the
   weld — created its own cracks via per-cell Y quantization.)
4. **Robust at AOI edges**, where tiles are coarsest and drift is largest — that is the
   regime every current pass fell apart in.
5. **Operate topologically, not per-vertex-independently** — merge/stitch shared verts,
   or replace the ground wholesale (re-grid), rather than nudging Y per vertex.

## Strategic options (to decide before fixing)

1. **Fix each pass to respect topology** (stitch T-junctions, vertex-merge by spatial hash, smooth fields with no sample/no-sample steps). Most work, keeps current design.
2. **Replace the ground passes with a single watertight re-grid.** Resample Google ground + the `.ter` into one consistent height-field / mesh; eliminates overlap, T-junctions, and per-pass vertex editing. Bigger change, likely cleaner.
3. **Stop editing the ground at all in production.** Strip Google ground entirely, drive on `.ter`, and only do a minimal **building-base** alignment (the one thing conform is truly needed for). Drops weld+roadmask for the ground; smallest surface area; but loses Google's high-detail road if we ever want it in preview.
4. **Keep RAW for preview, post-process only for export.** Decouple the "look" (raw, what Cesium shows) from the "drivable export" (stripped + .ter).

Decisions:
- **Drivable surface = the `.ter` terrain; Google supplies buildings only**. The ground passes exist mostly to serve a surface we discard — so the bar is "does it help the *buildings* sit/look right", not "does it make a nice road".
- **Weld → DEFERRED, not removed.** In the centre RAW/no-weld is clean, but the edge test (below) showed `Strip · no-weld` *breaks entirely* at the AOI edges while `Strip · weld` only *wiggles* — so the weld is currently load-bearing for the coarse edge tiles. Revisit removal only after the alignment problem is fixed (which may make it unnecessary again).

## KEY FAILURE: center-out vertical drift (the real Phase 1)

Sandbox edge test (Times Square, 512 m, standard): centre is clean in every processed cell; quality degrades **monotonically with distance from the AOI centre**. RAW is clean throughout. This tracks the single vertical anchor: `probeGroundAltitude` pins Google ground to `.ter` at the **centre**, and outward the photogrammetric ground **drifts** from the DEM (surface-shape mismatch + datum/geoid term). The conform + strip only handle **±`groundDistanceM` (2.5 m)** of drift — the conform's own docstring states it assumes the residual stays within that band across one AOI. Where it doesn't (edges of a 512 m tile):
- conform stops correcting past 2.5 m → ground stays drifted/warped → **wiggles**;
- strip removes ground patchily (some tris in-band, neighbours not) → **holes**;
- edge tiles are also **coarser** (cameras far from edges) → large triangles span very different `.ter` heights → per-vertex moves **warp** them (worse than centre).

RAW is immune because it never aligns to `.ter`. Fix direction: replace the single-point anchor + fixed band with a **spatially-robust ground↔.ter alignment** (low-order surface fit / multi-anchor), OR strip ground by **classification** (near-horizontal + below a height) rather than `.ter` proximity so removal is residual-independent, then align building bases separately.

Still open:
- Acceptable to re-grid into a watertight mesh (option 2), or must we preserve Google's exact triangles (option 1)? (Revisit after the alignment fix.)

## Roadmap — one pass at a time

**Phase 1 — Vertical alignment (the center-out drift above).** Weld removal is paused
because the edge test showed weld is currently load-bearing there.
- Confirm the dominant edge cause with DATA before coding: surface, per RAW (unconformed,
  ground-kept) bake, the residual `Y − (.ter − minH)` over near-horizontal ground verts —
  max + value at centre vs edge — and the LOD/triangle size vs distance. Expect the
  residual to grow outward and cross 2.5 m near the edge.
- Fix options once confirmed: (a) spatially-robust alignment (low-order/multi-anchor fit of
  Google ground → `.ter`, so residual stays small everywhere → strip works to the edge);
  (b) strip ground by classification (near-horizontal + below a height), residual-independent,
  then align building bases robustly. (b) is closest to "drive on `.ter`, Google = buildings".
- Each gated behind the sandbox toggles so the lab proves it edge-to-edge, not just centre.

**Phase 1b — Weld (revisit).** After alignment is robust, re-test `no-weld` at the edges.
If clean, remove weld (flip default in [googleBakeWorker.mjs](../scripts/googleBakeWorker.mjs)
`WELD_SEAMS` + [bakeFlags.js](../packages/bake/src/tiles/bakeFlags.js) `weldSeamsEnabled`,
bump `BAKE_FORMAT_VERSION`). If still needed at coarse edges, prefer **spatial-hash vertex
merge** of coincident cross-tile verts over the current per-cell Y-quantized weld.

**Phase 2 — Conform.** Verify the lift sign + the sparse-cell stepping; make `D` continuous (no sample/no-sample discontinuity); confirm building bases still land on `.ter`.

**Phase 3 — Road-mask.** Re-judge on a clean weld+conform substrate; tune `wallNormalY` / `maxSnapM` only after 1–2 are clean.

**Phase 4 — Re-evaluate whole chain** vs option 2/3 once each pass is individually understood.

## Instruments already in place
- `/quality-sandbox` page: per-cell `weld` / `conform` / `roadmask` toggles, synced cameras, wireframe, tone-map toggle, and per-cell stats (tris/verts/tiles/stations/selected/texMP). This is the A/B harness for every phase below.
- Per-bake pass overrides threaded through both bake paths + the cache key; `BAKE_FORMAT_VERSION = 14`.
- Tests exist for each pass: `weldSeams.test.mjs`, `tileGroundConform.test.mjs`, `routeConform.test.mjs`, `groundMask.test.mjs`, `stripGroundTris.test.mjs`.
