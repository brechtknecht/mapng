# Route chunk frame invariants

Verification procedure for the route assembly (Google 3D Tiles chunks + tile-extracted
`.ter` ground). Written 2026-09-07 after "physically impossible" height steps between
chunks on a flat Berlin route.

## Tool

```
node tools/chunk_frame_invariants.mjs --list              # bake generations on disk
node tools/chunk_frame_invariants.mjs [--set N] [--png out/] [--json out.json]
node tools/chunk_frame_invariants.mjs <workDir> <workDir> ...   # explicit containers
```

Reads the sidecar containers (`$TMPDIR/mapng-google-bake-*/job.json` + `out.bin`, MBK1)
and places every chunk's tile mesh, extracted ground and DEM into one absolute frame
(equirectangular metres about chunk 0's centre; heights absolute — mesh Y + chunk datum).
It reports per chunk the anchor chain and the tile-vs-ground / tile-vs-DEM gaps on the
corridor, per pair the DEM / ground / tile continuity in the overlap and the horizontal
best shift, the placement arithmetic (preview `translation.y` vs export `baseUp` vs the
`.ter` datum), and a verdict list. `--png` writes top-down heat maps (2 m/px): tile min,
ground, tile − ground, tile − DEM, ground − DEM, overlap disagreement, tile coverage by
chunk, each with chunk boxes (coloured), ownership lines (white) and the corridor
centreline (black).

Only INDEXED vertices are rasterised: the worker's strip and ownership-clip passes rewrite
the index and leave dropped vertices in the position buffer.

## Invariants

1. One shared vertical anchor for all chunks; tile A − tile B in every overlap ≈ 0.
2. DEM A − DEM B in every overlap ≈ 0 (one elevation dataset per run).
3. Export `baseUp_i − preview y_i` is the same constant for all chunks
   (`datum_0 − combined.minHeight`).
4. Per chunk, tile MIN − ground on carriageway cells ≈ 0 (the `.ter` sits on the visible road).
5. Ground A − ground B in every overlap < 0.3 m (follows from 1 and 4).

## Findings on the 2026-09-07 route

Invariants 1–3 held exactly (0.00 m). Invariants 4–5 failed, in two different ways:

- Natural DEM (pre re-seat): the DEM–tile offset varies along the route
  (+0.2 / +0.3 / −4.4 / −2.6 m on the carriageway for chunks 0–3). The extraction is
  DEM-relative, so where the DEM sits more than the band above the road the floor lands on
  the DEM: 4.7 / 2.8 m above the road in chunks 2 / 3. No seam steps, but the road mesh
  under the drive surface.
- Single-point re-seat (shared − natural anchor, tsnap13): correct for chunks 2 / 3, wrong
  by 6.7 m for chunk 1 (the centre probe read a railway cut). The floor of chunk 1 dropped;
  the route registration then moved the mesh placement by the floor disagreement
  (+5.44 / +4.35 / +3.49 m chained) — a 5.4 m tile step at the first seam.

## Fix (tsnap15)

- Worker `applyDemReseat`: RUNNING MEDIAN ALONG THE ROUTE LINE (60 m window, 10 m step) of
  per-cell tile-surface minimum − DEM over OSM carriageway cells within 12 m of the line
  (`packages/bake/src/tiles/demReseat.js`, `estimateTileDemOffsetField`), applied per DEM
  pixel (along-route value within 50 m of the line, fading to the chunk median by 150 m)
  before weld / conform / extraction, for every extraction bake (chunk 0 included). A
  constant per chunk was not enough: on the re-bake with tsnap14 the chunk-1 DEM error moved
  from +1.0 m (west) to −6.0 m (east tail, a railway cut the 30 m DEM does not resolve), so
  140 m of road stayed 5–6 m under the DEM band, coverage 0, floor on the DEM — a 7 m floor
  step at the 1|2 ownership line while every other pair was within 0.02 m on the road. Validated on the real containers: corridor-restricted estimates
  +0.17 / +0.93 / −4.65 / −2.98 m for chunks 0–3 versus the probe deltas 0 / −6.40 / −4.04 /
  −2.67 m; all OSM roads of the whole box would have given −1.53 m for chunk 0 (stadium
  pit, railway cut), which is why the vote is confined to the corridor.
- Registration (`registerChunkGrounds`) is diagnostic only: logged to turbolog
  `ground-overlap` as "floor disagreement", never applied to placement or grounds.
- `bakeCacheKey` carries the datum (`|dz=`): baked Y is metres above `minHeight`, so a
  bake is only valid for the DEM it was baked against (the elevation source changed the
  datum of identical bounds by 12.5 m between two runs that day).
- Container header `anchor` ships `groundOffsetM`, `naturalOffsetM`, `demShiftM`, `demShiftRangeM`.

## Verification (tsnap15 re-bake, 2026-09-07 15:15 UTC, 5 chunks)

Tile MIN − ground on the road 0.00–0.02 m for every chunk; ground A − B on the road 0.00 /
0.01 / −0.01 / 0.00 m for the four pairs; tiles continuous (0.00 m where both meshes exist).
Off-corridor DEM-fallback cells in an overlap band may still differ between chunks (0.7 m at
1↔2) — the `.ter` takes the owner's floor there with a 6 m feather.

## Follow-up (tsnap16, 2026-09-07)

BeamNG drive confirmed the export matches the preview and drives smoother. Remaining
work moved to the side roads and the process:

- Profile hygiene (`roadProfiles.js` `carveVeto`): a resolved surface profile steeper
  than 35 % anywhere (garage ramps, driveways under buildings; measured 84–169 % on
  `service` ways) or a `service` way with < 25 % trusted samples keeps its profile for
  display and stats but neither carves the `.ter` nor joins junction clusters. Stats carry
  `vetoed` / `vetoedRoads`; the worker log lists them.
- Wider road footprint (`groundMask.roadHalfWidthM`): class half-width widened by OSM
  `width` / `lanes` tags, plus a 1 m kerb margin (`ROAD_KERB_MARGIN_M`). Shared by the
  snap mask, the profile taps and the carve.
- Ground-seat audit in the worker (`applyGroundSeatAudit`): tile − `.ter` on the route
  corridor after the terSnap, shipped as `groundSeatStats` and logged per chunk on the
  turbolog `ground-overlap` stream ("FLOOR OFF THE ROAD" above 0.3 m). The offline tool
  stays for the pairwise and placement checks.
- Preview bakes keep their containers (`routeBake` ends sessions with `keepFiles`), so
  `tools/chunk_frame_invariants.mjs` always finds a complete set.
- Open: z-fighting between the coarser `.ter` and the tile road at ground level (the
  render bias is `TILE_RENDER_BIAS_M` = 0.15 m plus the live z-offset control); a
  route-wide DEM offset field to remove the 0.7 m off-road steps between chunk fields.

## Follow-up 2 (tsnap17, 2026-09-07)

Measured on the tsnap16 re-bake (4 chunks, ground seat on the corridor 0.00–0.02 m,
floor disagreement on the road ≤ 0.00 m, 11 side-road profiles vetoed, junction steps
max 3.55 → 0.33 m):

- **Poke-through beside the road** was the visible "z-fighting am Boden": 10–36 % of
  the covered cells 6–60 m from the route line had the `.ter` above the tile surface
  even with the 0.15 m render bias (p90 0.3–2.8 m, p99 up to 10 m). On the carriageway
  only 1–4 %, ≤ 0.4 m. Fix: `ground/groundCeiling.js` — off the carriageway mask the
  ground is lowered to (per-cell tile minimum − 0.05 m) wherever it exceeds it by at
  most 1.5 m (larger excesses are junk / sunken yards, left to the pit defences).
  What-if on the containers: poke-through 18 / 32 / 26 / 23 % → 5.5 / 10 / 1.2 / 1.9 %.
  Runs after the carve, before the terSnap. No slider involved; the bias stays 0.15 m.
- **Off-road step between chunk fields** (mean |Δ| 3.2 m in the 1↔2 band): the DEM
  re-seat field faded laterally to the chunk-constant median, and the constants differed
  by 5 m. The field is now held laterally (`fullWidthM = Infinity` default) and the
  `.ter` ownership feather is 20 m (free on the road, where the floors agree).
- **0.45 m hump on a flat residential road** (s 713–756 of the route) matched the
  logged 0.43 m junction adjustment: the trust-weighted consensus let a side road that
  had profiled a raised crossing lift the driven road. The consensus is now the
  highest-class road present (`highwayRank`); lower classes meet its grade.
- Bumpiness otherwise: `.ter` grade change per 10 m p50 0.24, p95 1.28 %-points;
  profile roughness RMS 1.9–3.0 cm; the 5.9 %-point outliers in the offline profile were
  artefacts of joining chunk segments, the ground there is smooth.
