# Deformation stiffness — one concept for "structures keep their shape"

Status: concept (2026-07-03). Supersedes the abandoned per-building footprint
freeze (stash `building-footprint-protection WIP`, not merged).

## Problem

The tile→ground conform (`packages/bake/src/tileGroundConform.js`) builds a
smooth correction field D(x,z) from ground-classified triangles and subtracts
it from **every** vertex. The header claims "a building's verts all shift by
the same local D, so the building keeps its height" — that only holds if D is
locally constant across the building. It is not. Observed result: buildings
morph badly, no roof stays planar.

### Mechanism (verified in code, 2026-07-03)

1. **D is noisy at 6 m wavelength.** The field is a per-cell *median* residual
   on a `cellM = 6` grid, bilinearly sampled, with `smoothPasses = 0`
   (`tileGroundConform.js:87-91`, `scalarFieldGrid.js`). `smoothPasses = 0` was
   chosen deliberately because blur worsens the *road* residual (curbs,
   embankment edges) — but that same choice means cell-to-cell disagreement
   (photogrammetry ground noise, courtyards, terraces, cars, garage roofs that
   sit inside the ±2.5 m ground band) becomes a 6 m-wavelength wobble in D.
   Terrain absorbs that wobble invisibly; a rigid structure spanning several
   cells gets visibly bent by it. One global smoothness knob cannot serve both
   objectives — the field must be smooth *where structures are* and sharp
   *where ground is measured*.

2. **Building interiors are guesses.** Buildings contribute no ground samples,
   so their footprint cells are inpainted by 4-neighbour dilation from
   perimeter cells (`scalarFieldGrid.js` `inpaint()`), whose own medians are
   contaminated by facade-adjacent junk. Any gradient in that guessed interior
   bends the building.

3. **Building semantics never reach the worker.** The sidecar payload filter
   (`googleBakeSidecar.js:72-77`) ships only roads + flat-ground areas.
   Features tagged `building` are stripped before the headless bake — any
   conform-side footprint logic silently no-ops in that path. (Likely why the
   stashed footprint-freeze changed nothing.)

### Why per-class exceptions keep failing

Every stage currently patches the same missing concept locally: `minNormalY`
gates in ground extraction, mask holes in `groundMask`, wall flags + float
ceiling + floor-trust in the conform, footprint freeze in the stash. Each
patches the *output* of a field that was built without knowing rigidity
exists. Boundary artifacts (shear at mask edges, moats around footprints) and
per-class code growth are structural consequences, not tuning problems.

## Concept

Separate the two questions the pipeline conflates, as two scalar fields over
the AOI:

- **Target field** — *where should the surface end up?* Extracted floor, DEM,
  road profiles; each sample carries a confidence weight. (Half-exists today:
  residual samples + `floorCoveredMask` trust.)
- **Stiffness field** — *how much may space deform here?* `s(x,z) ∈ [0,1]`:
  0 = compliant terrain, 1 = rigid structure. **New.** The conform never
  learns what a "building" is — a building is just a region of high stiffness.

The correction field is then the solution of a weighted least-squares problem
on the existing grid:

```
minimize  Σ confidence·(D − target)²  +  Σ κ(s)·|∇D|²
```

- Where confidence is high and stiffness low (measured road/ground): D tracks
  the residual sharply — the current behaviour, preserving the
  `smoothPasses = 0` road accuracy.
- Where stiffness is high (structures): the gradient penalty forces D toward
  locally constant → the structure translates as a rigid block *by
  construction*. No owner IDs, no per-building median, no hand-tuned feather —
  the solver distributes the transition smoothly around the footprint.
- Where neither (unobserved ground): smooth interpolation, as inpaint does
  today.

Implementation-wise this is a small step from the current code:
`grid.build({smoothPasses})` is already Jacobi-style diffusion; the solve is
the same relaxation with per-cell data/smoothness weights (screened Poisson,
Gauss–Seidel, ~tens of iterations on the existing grid).

## Stiffness is fused evidence, not a class

Providers, each independent, max-combined:

- **Semantic** (`deform/providers/osmStructures.js`): OSM `building=*`,
  `man_made=*`, `barrier=*` polygons; bridge decks (the bridge-profile work is
  the same concept, currently hand-rolled a third time). Requires widening the
  sidecar payload filter — see Mechanism 3.
- **Geometric** (`deform/providers/meshEvidence.js`): the mesh asserts its own
  rigidity — verticality (today's wall flags) and height-above-floor (today's
  float ceiling), rasterized into the stiffness grid instead of applied as
  inline vetoes.

`s = max(semantic, geometric)`. The fusion is what makes OSM↔photogrammetry
misregistration (typically metres) survivable: where the footprint misses the
actual mesh, the geometry itself still raises stiffness.

**v1 decision (2026-07-03): semantic only.** Field observation via the bend
heatmap: street trees light up exactly like buildings (unmeasured cells) —
geometry cannot tell a tree column from a facade, and trees must NOT be
rigidified. OSM is the sole authority in v1; misregistration is mitigated by a
3 m full-stiffness buffer + 6 m feather around each footprint instead of
geometric evidence. The geometric provider stays future work behind that
explicit trade-off.

## One field, every consumer

Every stage that moves vertices respects the same field:

| Consumer | Today | With stiffness |
| --- | --- | --- |
| Conform delta | uniform D | D from the weighted solve |
| Road mask snap | wall-flag veto, float ceiling | `snapWeight ·= (1 − s)` |
| Route worker terSnap | own heuristics | same multiplier |
| Preview carve | own heuristics | same multiplier |

The scattered per-stage protections get deleted, not accumulated.

## Migration

0. **Instrument first.** Per-stage vertex displacement diagnostics (which pass
   moved a roof vertex, by how much) + a debug overlay of D and s on the
   existing wireframe-debug infra. The footprint-freeze attempt shipped blind;
   this concept should not.
   **Built (2026-07-03):** `fieldGrad` + p50/p95/max bend stats in the conform
   return (logged by both bake paths), `measureOnly` mode, and the
   "show conform bend heatmap (debug)" overlay in the route preview
   (store `conformFieldShow`, rendered in `RoutePreview.vue`). Verified by
   tests in `tests/tileGroundConform.test.mjs` (field-bend + measureOnly).
1. **Extract, behaviour-preserving.** `packages/bake/src/deform/` with the
   stiffness grid + both providers; recast wall flags / float ceiling / mask
   holes as providers. Widen the sidecar filter to ship structure features.
   No visual change yet (verify via A/B bake hash).
   **Built (2026-07-03):** `deform/structureStiffness.js` (semantic provider —
   collectStructureRings + rasterizeStructureStiffness), sidecar filter ships
   building/`building:part`/man_made footprints, flag
   `mapng_conform_stiffness` (default ON when the conform runs) /
   `MAPNG_CONFORM_STIFFNESS` (worker), cache-key `BAKE_FORMAT_VERSION` 15→16.
   Wall flags / float ceiling kept inline as fallback for unmapped structures.
2. **Swap the field build** for the weighted solve in `scalarFieldGrid`.
   **Built (2026-07-03):** `build({stiffness})` runs a weighted Gauss–Seidel
   relaxation — data term `(1−s)·(D−median)²` + smoothness
   `κ·min(s_i,s_j)·(D_i−D_j)²` (κ=50). `min()` guarantees s=0 cells are
   byte-identical to the stiffness-free build (verified by test); s→1 forces D
   locally constant, the transition lives in the feather rim. The road snap is
   attenuated by `(1−s)` per vertex in the conform (semantic veto over the
   heuristic wall gate). Tests: roof-planarity, far-ground byte-identity,
   snap veto (`tests/tileGroundConform.test.mjs`,
   `tests/structureStiffness.test.mjs`).
3. **Wire the remaining consumers** (route worker terSnap, preview carve) to
   the shared field; delete inline heuristics.
   **terSnap wired (2026-07-03):** the pass that ACTUALLY runs on route bakes
   is `applyTerGroundSnap` (googleBakeWorker.mjs), not the off-by-default
   `applyConform` — its "delta field is near-zero by construction" assumption
   is false near buildings (measured p95 ≈ 2 m/cell vs the extracted floor),
   and it applies the field to every vertex TWICE (road snap + bridge-deck
   snap). Both conform calls now receive `structures`; cache literal
   tsnap8→tsnap9. Lesson repeated: always identify WHICH pass runs in the
   observed path before wiring a fix (applyConform was a no-op path for route
   bakes, exactly like the sidecar filter was for the old stash).
   Preview carve: open.

## Open questions

- κ(s) shape and solver iteration count vs. bake-time budget (grid is small —
  AOI/6 m — so likely negligible; measure in step 0).
- Whether roofs of *low* structures (garages, terraces inside the ±2.5 m
  band) should also be excluded from the target samples once stiffness knows
  about them — today they contaminate D's perimeter cells.
- Cache keys: stiffness inputs must enter the bake cache key (the stash
  already touched `bakeCache.js` for this).
