# Plan: the road as the baseline under the photogrammetry

Status: IMPLEMENTED in the worker pipeline (2026-09-07, uncommitted), bench
at `/road-profile-bench`. Branch `feat/road-elevation-profiles`. Not yet
verified on a real route bake / in BeamNG.

## Corridor authority — the requirement, stated as two guarantees

Inside a road corridor of fixed width (HALF_WIDTH_M per class):

1. **Smooth:** the `.ter` is the 1D road profile everywhere in the corridor.
   No held ends, no tapers, no clamps, no trust gates deciding cell by cell.
2. **Coincident:** no tile geometry sits between the `.ter` and a clearance
   height above it. Everything lower than the clearance IS the road and is
   seated on the `.ter`; everything higher is an object above the road.

Every conditional in the old chain was a place where one of these broke:
carve trust taper (hole in the `.ter` where the profile was least trusted),
carve clamp (hole exactly where the profile disagreed most), snap ceiling +
taper + wall exemption + covered gate (mesh left hovering over the car).

What changed (see `tsnap10` in bakeCache.js):

| where | before | now |
| --- | --- | --- |
| `buildRoadProfiles` | median3 + gaussian + grade limiter, gaps interpolated, ends held flat | asymmetric Whittaker (`solver:'whittaker'`), a height for every sample; interior gaps interpolated by curvature, unobserved ENDS ease into the extracted ground over ~13 m (`priorWeight` 0.05) |
| `carveRoadProfiles` | held-end taper, ±10 m clamp, feather cells not trusted | whittaker profiles stamp unconditionally; no clamp (>10 m shifts counted in `largeShiftCells`); feather cells marked covered so mesh and floor transition together |
| `conformTilesToFloor` (terSnap) | 2 m ceiling, 1 m taper, wall exemption, covered gate | `corridorClearanceM` 2.5: below it seated at full mask weight, no ceiling/taper/wall exemption; structure veto and floor-trust gate kept |
| strategy | — | `profileSolver`, `profileCutoffM`, `profileCoreM`, `profileObjectM`, `profileAboveWeight`, `profilePriorWeight`, `corridorClearanceM` in DEFAULT_GROUND_STRATEGY; `profileSolver:'legacy'` / `corridorClearanceM:0` restore the old behaviour for A/B |

The one real decision left: `corridorClearanceM`. 2.5 m flattens parked cars
into the road texture and keeps trucks, canopies, decks, facades above 2.5 m.

## Connectors (chunk overlaps): one owner per point

Measured on a real route (turbolog `ground-overlap`): neighbouring chunk
floors disagreed by 1.84 m mean in one overlap band, 0.26 m in the next. The
`.ter` used to BLEND both floors across the band while both meshes existed
there, each seated on its own floor → mesh off the drive surface by Δh/2
over the whole band.

Same principle as the corridor: no blending of two independent solutions.

1. **Ownership** — every point belongs to the chunk whose centre is nearest
   (Voronoi). The worker clips each chunk's mesh to its cell
   (`tiles/chunkOwnership.js`, `applyOwnershipClip`, keyed `|own=`); the
   route composite takes the owner's floor with a 6 m feather on the
   bisector (`compositeRouteGround ownershipFeatherM`). Mesh and `.ter`
   switch chunk on the same line.
2. **Registration** — `registerChunkGrounds`: per chunk the median signed
   floor difference to the previous overlapping chunk, chained along the
   route, applied to the chunk's ground AND its tile placement (`baseUp`
   in the level, `placement.translationM.y` in the preview). What remains
   on the ownership line is shape disagreement, not an offset.

Still open: the horizontal component (best shift −5 m east on one pair) and
the route-wide profile solve that would make chunks agree by construction.

## The one idea

Every heuristic in the current road chain answers the same question in a
different way: *which of the tile heights inside the road corridor is the
road?* Per-cell min, PMF, CSF, bilateral, pit lift, normal gate, DEM band,
sliding-median outlier rejection, grade limiter, junction consensus, glitch
override — each one is a threshold on that question.

The question has a physical answer that needs no threshold:

> Everything that stands on a road is **above** it. Nothing drivable is below
> it. And a road's vertical alignment is **smooth** by construction (tangents
> joined by long vertical curves).

Written as one optimisation:

```
minimise  Σ_i w_i · (y_i − h_i)²  +  λ · Σ_i (h_{i−1} − 2 h_i + h_{i+1})²

w_i = trust_i · ρ(y_i − h_i)        ρ = 1          inside ±core      (noise)
                                    ρ = p ≪ 1      above core        (car, tree, deck — cheap)
                                    ρ = core/|r|   below core        (sink, skirt — bounded)
```

This is asymmetric Whittaker smoothing (asymmetric least squares, Eilers &
Boelens 2005 — the standard way to find a baseline under spectral peaks).
Solved by iteratively reweighted least squares: ~20 pentadiagonal solves,
O(n) each. Implementation: `packages/bake/src/ground/asymmetricWhittaker.js`.

Parameters and their physical meaning:

| knob | meaning | typical |
| --- | --- | --- |
| cutoff wavelength | shortest real vertical road feature to keep; everything shorter is treated as noise | 30–60 m |
| core | photogrammetry noise band, symmetric | ±0.3–0.5 m |
| p | how cheap an object above the road is | 0.01–0.05 |
| trust | semantic/coverage weight per sample: 1 tile observation, 0 gap or bridge-deck footprint | from OSM + coveredMask |
| prior weight | how strongly a gap relaxes toward the DEM instead of extrapolating | 0.001–0.01 |

What it removes: outlierM, the grade limiter's flat-then-kink output,
median3, the gaussian, held ends + end taper. What it keeps: the raw per-cell
min raster as the observation source, OSM semantics (bridge/tunnel/layer) as
zero-trust marks, the carve and the terSnap that consume the profile.

### Known limit (seen in the solver calibration, must be judged on real tiles)

A one-sided loss cannot distinguish a real **crest** longer than the cutoff
from a hump to be cut — with a very long cutoff it under-cuts crests. Keep the
cutoff at the length of the shortest real vertical curve (urban ≈ 30–50 m)
and let OSM mark bridge decks; a 30 m deck and a 30 m crest look identical to
any per-road filter, only the tag tells them apart.

## Second step: solve the whole road NETWORK at once

The junction step (the dominant defect after the 1D smoothing) exists because
every road is profiled alone and then reconciled by clustering (6 m gate,
parallel-run guard, 25 m blend). OSM already encodes the answer: ways that
meet share a **node**; ways that cross at different levels do not. Put the
profile unknowns on the road graph with shared unknowns at shared nodes, and
the same sparse least-squares system solves all roads together — junction
consistency by construction, dual carriageways decoupled by construction,
bridge decks decoupled from the road beneath by construction. The curvature
penalty runs through the node along each incident way. Solver: conjugate
gradient on a sparse SPD system, a few thousand unknowns per chunk.

Prerequisite to verify: the route/AOI OSM fetch keeps node identity (equal
coordinates on shared nodes). If it does not, the way→node join has to come
from the Overpass response before geometry is flattened.

## The PNG (top-down road mask)

The mask is the **domain** (where a profile applies, how wide, which cells
the carve and the terSnap own), not the height source. A raster is the wrong
place to solve heights: raster connectivity accidentally couples a service
road to the carriageway beside it, the graph does not. Keep the mask for the
stamp (carveRoadProfiles) and for choosing observation cells.

## How to judge it — on real tiles only

`/road-profile-bench` (components/road-profile-bench/):

1. Bake an AOI (cached like the terrain sandbox).
2. Draw the road where you believe it is (click vertices on the mesh) or adopt
   the nearest OSM way.
3. The bench reads the per-cell tile minimum across the corridor (taps), runs
   the production chain (`buildRoadProfiles`, orange) and the candidate
   (asymmetric Whittaker, cyan) and shows both on the mesh and in a profile
   chart, with residual statistics. Hover the chart to find the sample on
   the mesh, click to look at it.

Judge by: bump rms, worst bump, max grade, residual p10/p50/p90 against the
taps, and — most of all — whether the cyan ribbon sits on the visible road in
the tiles where the chain has been wrong (underpasses, tree rows, parked cars,
junction approaches).

No synthetic profiles: tuning on a model of the defects overfits the model,
not the tiles.
