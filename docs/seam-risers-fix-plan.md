# Fixing plan: LOD-seam "risers" in the Google 3D Tiles bake

**Artifact (confirmed):** a grid of small near-vertical walls over flat ground in
the 3D preview. The codebase already names them *seam risers*
(`stripSeamRisers` in `services/googleBakeCore.js`).

**Goal:** stop creating the walls at the source / close them geometrically —
**retire** the magic-threshold deletion (`stripSeamRisers`) rather than tune it.

**Chosen direction:** do both — (1) fix at geometry (carve + weld) and (2) fix at
selection (lateral LOD balancing).

---

## STATUS — v1 shipped (geometry half: carve + weld)

Landed, replacing `stripSeamRisers` as the default:

- **Lateral footprint carving** — `computeCarveTargets()` in
  `scripts/googleBakeWorker.mjs`; `rebuildOutputs` now subtracts a finer tile's
  footprint from **every** strictly-coarser kept tile it overlaps (cousins, not
  just ancestors). Hole-safe (carve stays within the carver's own shrunk
  footprint).
- **Seam weld** — `weldSeams()` in `services/googleBakeCore.js` (shared, DOM-free,
  unit-tested in `tests/weldSeams.test.mjs`, `npm run test:weld`). Worker:
  `applyWeld()` (idempotent, recomputed each refine from immutable
  `basePositions`). Browser fallback: in-tab weld in `services/google3dTiles.js`.

  **v2 — learned from a live bake (key correction):** the in-AOI mass of a small
  bake is ALL the same finest LOD (`ge≈2`), so a finer-only weld moved 0 verts —
  the risers are between **same-LOD** neighbours. The weld is now **LOD-agnostic**:
  per-XZ-cell ground *consensus*, snapping every vertex to its **own cell's** mean
  so both tiles meet exactly and the pass stays idempotent. A first cut over-reached
  and ate building walls; three gates now protect real geometry — `cohereM` (cell
  ground spread), `maxRiserM` (height above local ground = wall vs riser), `bandM`
  (vertical reach). All env-tunable (`MAPNG_WELD_*`).
- **Defaults flipped:** weld ON, heuristic strip OFF.
  - Worker: `MAPNG_WELD_SEAMS=0` to disable weld, `MAPNG_STRIP_RISERS=1` to
    re-enable the old strip.
  - Browser: `localStorage mapng_weld_seams='0'` / `mapng_strip_risers='1'`.

**Fixed regression:** the first cut of `computeCarveTargets` rasterised every
kept tile's footprint into a fixed-cell grid — coarse far-field tiles have
whole-city footprints, so the grid blew V8's `Map` cap ("Map maximum size
exceeded") even on the smallest AOI. Both `computeCarveTargets` (AOI-clamped cell
range, `LIM`) and `weldSeams` (adaptive `effCellM`) now keep their grids bounded
regardless of AOI size.

**v3 — street fix (ground-strip ordering):** a live `roads`/`high` bake showed
the weld working off-street (`moved 85k verts`) but streets still seamed.
Cause: `stripGround` ran INSIDE the transform, deleting the street surface
BEFORE the weld, so street risers had no ground to snap onto and survived on the
bare terrain. Fixed by **reordering**: the transform now keeps the ground
(`stripGround:false`), the weld runs, then `stripGroundTris()`
(`services/googleBakeCore.js`) strips the ground **last** — so flattened street
risers are removed with the street. Worker: `applyGroundStrip()` (recomputed
each merge from an immutable `baseIndex`; the weld's field also reads `baseIndex`
so a refine never sees a half-stripped street). Browser path mirrors it. Tests:
`tests/stripGroundTris.test.mjs`.

**Not yet done (follow-ups):** Phase D selection balancing (2:1 lateral);
OBB-polygon carve for cousins (currently AABB, can mildly over-carve corners);
browser-path lateral carving (worker-only today — fine since the dev server
routes every bake through the worker); deleting `stripSeamRisers` outright once a
live bake confirms candidates ≈ 0.

**Next:** run a live bake on a known AOI and read the worker log
(`seam weld: moved N verts…`, `merge: … recarved=…`) to confirm the wall grid is
gone; then decide whether Phase D is needed.

---

## 1. Root cause (architecture, not a guess)

The bake sweeps ONE camera through many stations (top-down + obliques + grid +
road-level) and **unions** every station's tile selection
(`runStationSweep`, `googleBakeCore.js:306`). Different stations resolve the
*same ground* at *different LOD depths*. The kept set is therefore a **patchwork
of mixed LOD levels** across the AOI.

Google Photorealistic 3D Tiles use **REPLACE refinement**; each tile is an
**independent mesh**; adjacent tiles **overlap ~2 m** (`footprintRect`,
`googleBakeWorker.mjs:174`). Where a finely-refined tile abuts a coarser
neighbour, their photogrammetric surfaces sit at slightly different heights, and
the overlapping edge geometry **stands up as a short vertical wall** — a riser.
Across the AOI these form the grid you see.

### What the pipeline already does

| Mechanism | Where | Handles | Leaves behind |
|---|---|---|---|
| `selectFinestCovering` | `googleBakeCore.js:471` | drops a coarse tile only when its children fully cover it | partially-covered coarse tiles (kept to avoid holes) |
| **Ancestor footprint carving** | `rebuildOutputs`, `googleBakeWorker.mjs:296` (worker only) | a parent's surface is carved out where its own finer **descendants** cover it (deepest-first) → no vertical z-fight stacking | **lateral** seams between adjacent **cousins** at different depth |
| `stripSeamRisers` | `googleBakeCore.js:655` | heuristic deletion of the residual lateral risers | the magic-value band-aid you want gone (8 tuned constants) |

So risers survive **only at lateral boundaries between adjacent tiles that are
not in a parent/child relation** — exactly what ancestor carving can't see and
`stripSeamRisers` is currently mopping up.

### Parity note (important)

- **Default path = the Node worker** (`googleBakeWorker.mjs`). On the dev server
  *every* bake routes through it, so the risers you see in the preview are the
  worker's output (carve + `stripSeamRisers`), deserialized into the scene.
- **The browser in-tab bake** (`services/google3dTiles.js:201+`, prod / sidecar-
  unreachable fallback) does **finest-covering + `stripSeamRisers` only — no
  carving at all.** It's already inconsistent with the worker. The fix must live
  in the **shared DOM-free core** (`googleBakeCore.js`) and be called by both, so
  the prod fallback gains carving+weld too.
- The AI-overview you pasted (near-plane, mipmapping, texture padding, "merge
  JSON tilesets") targets *texture* seams and z-fighting. **Not this bug.** This
  is reconstructed geometry at LOD boundaries; those tips don't apply.

---

## 2. The fix

Three new shared, DOM-free passes in `googleBakeCore.js`, driven by both the
worker and the browser orchestrator. No height thresholds — authority is purely
**geometricError ordering** (finer = smaller GE wins) and the **known ~2 m
overlap band**.

### Phase A — Spike & measure (no behaviour change yet) — 0.5 day
Before building, quantify the residual so we tune nothing blind.

1. Add an instrument that counts the **riser candidates** `stripSeamRisers`
   currently finds (it already returns `candidates` + `collectCentroids`) and
   their height distribution, logged per bake, broken down by whether the two
   contributing grounds are cross-tile (the LOD-seam signature).
2. Run a known AOI (Berlin, the doc's reference) at `standard` and `roads`.
   Record: candidate count, removed count, and a screenshot with the existing
   `deletedCentroids` debug overlay.
3. **Decision gate:** this baseline tells us how much Phase B-carve alone removes
   vs. how much needs Phase C-weld. Keeps the rest of the plan empirical, like
   the rest of this project's lessons.

### Phase B — Lateral footprint carving (the bulk fix) — 1–2 days
Generalize the trusted ancestor carve to **all** finer overlaps.

1. In `rebuildOutputs` (`googleBakeWorker.mjs:296`), today a finer tile's
   `footprintRect` is pushed only onto its **kept ancestors**
   (`for (let p = tile.parent; …)`, line 376). Change the carve target to **every
   kept tile whose footprint this finer tile overlaps** and whose `geometricError`
   is strictly larger (coarser) — cousins included. "Finer tile owns its
   footprint" globally. Build the overlap set with the existing footprint rects +
   a spatial hash (the rects are already cached per tile).
2. Pull the carve logic out of the worker into a shared
   `carveByFinerFootprints(records, tiles, …)` in `googleBakeCore.js` so the
   **browser path gets it too** (closes the parity gap above).
3. **Over-carve guard:** `footprintRect` is an axis-aligned AABB of a rotated
   OBB, so it overshoots. For cousins (not strict ancestors) that can eat a
   neighbour's legit area. Mitigations to evaluate in the spike:
   - keep the existing ~2 m inward `shrink` (already there);
   - optionally carve against the **true OBB polygon** (project the 4 ground
     corners) instead of the AABB when a pair is cousins, not ancestors.
4. **Expected result:** the coarse surface (and its riser geometry) is removed
   wherever a finer tile covers it; only a ≤2 m sliver of coarse survives at each
   seam (kept to avoid holes). Measure how many candidates remain → feeds Phase C.

### Phase C — Boundary weld / T-junction removal (closes the residual) — 2–3 days
After carving, each seam is a ≤2 m-wide sliver of coarse surface whose **outer
edge height ≠ the adjacent finer surface** → the remaining (now short) step.
Weld it shut, geometrically, with no magic constants:

1. New shared `weldSeams(records, …)` in `googleBakeCore.js`:
   - For each surviving coarse boundary vertex that lies within the overlap band
     of a finer tile's footprint, **sample the finer tile's surface height at
     that vertex's XZ** (rasterize/interpolate the finer tile's triangles over a
     small local grid, or nearest-triangle barycentric lookup) and **snap the
     coarse vertex Y onto it.** The step collapses to zero; the sliver becomes a
     flush ramp into the finer surface.
   - Correspondence is defined entirely by the **existing ~2 m overlap band** —
     no height/normal thresholds. A vertex with no finer surface above/below it
     (a real facade, curb, embankment) has no correspondent → untouched. That is
     why this can't eat real walls the way `stripSeamRisers` can.
2. **Idempotency / refinement safety:** `weldSeams` mutates `positions.Y`, unlike
   the index-only `stripSeamRisers`. The worker session is **incremental**
   (`session.outputs` reused across refines). Weld must be **recomputed each
   merge from an un-welded base**, never welded-on-welded. Design: keep each
   record's transformed positions immutable; produce welded positions into the
   serialized container only (or store `record.weldedPositions` recomputed in
   `rebuildOutputs` → `weldSeams`, replacing the `applyRiserStrip` call at
   `googleBakeWorker.mjs:638` and `:766`).

### Phase D — Selection balancing (the "fix at selection" half) — 1–2 days
Bound lateral LOD jumps so welds never bridge more than one level (well-
conditioned welds, smaller slivers, fewer carves).

1. After `selectFinestCovering`, build lateral adjacency among kept tiles from
   their footprint rects. For each adjacent pair with `tileDepth` diff > 1,
   **split the coarser tile** toward the boundary: add the descendant chain that
   borders the finer region to the keep set until the lateral diff ≤ 1.
2. **Cache-only — no new fetches in the base bake.** Use a descendant **only if
   it's already loaded** (`tile.children` present, `cached.scene` available);
   deep frustums in refinement already load neighbours, so many will be. Where
   intermediates aren't loaded, **leave it to Phase C's weld** (which bridges any
   step). This keeps the bake's time/memory budget bounded.
3. Carve (Phase B) already handles the coarse remainder once descendants are
   added to keep — no new carve code needed.

### Phase E — Retire `stripSeamRisers` — 0.5 day
1. Default the kill switch **off** once B–D land (`MAPNG_STRIP_RISERS` /
   `localStorage mapng_strip_risers`), keep it as an emergency fallback for one
   release.
2. Prove it's unnecessary: with B–D on, the instrumented **candidate count from
   Phase A should approach zero**. If it does, delete `stripSeamRisers` and its
   env knobs in a follow-up; if a stubborn residual remains, that residual — not
   a tuned constant — is the next investigation.

---

## 3. Files touched

| File | Change |
|---|---|
| `services/googleBakeCore.js` | New shared `carveByFinerFootprints`, `weldSeams`, lateral-balance helper; `footprintRect`/`tileDepth` move here (shared) ; `stripSeamRisers` kept but gated |
| `scripts/googleBakeWorker.mjs` | `rebuildOutputs` carve target → all finer overlaps + balance pass; replace `applyRiserStrip` with `weldSeams` (recompute-per-merge, not in-place) |
| `services/google3dTiles.js` | browser path calls the shared carve+weld (gains carving it never had) |
| `scripts/googleExportAssembly.mjs` / `services/exportBeamNGLevel.js` | consume welded positions (they read `session.outputs` records / `out.children` — verify the welded geometry flows through unchanged) |
| `scripts/smokeRefineSession.mjs` | add a post-stitch riser-candidate assertion (< small N) |

Both the **preview** and the **BeamNG/GLB/DAE export** read the same records, so
fixing the shared core fixes every consumer at once (the project's stated
invariant: "the hard-won bake semantics live HERE, once").

---

## 4. Risks & how the plan handles them

- **Over-carving neighbours** (AABB footprint overshoot) → spike-measured;
  OBB-polygon carve for cousins; the ~2 m shrink already there.
- **Holes** where carve removes coarse but no finer surface actually covers →
  carve only against *strictly finer* tiles whose footprint truly overlaps; keep
  the sliver; weld rather than delete at the very edge.
- **Weld double-application across refines** → recompute from immutable base each
  merge (Phase C.2).
- **Balance cost blowup** (fetching deep neighbours everywhere) → cache-only,
  weld covers the rest (Phase D.2).
- **Real low walls/curbs eaten** (the failure mode of `stripSeamRisers`) →
  structurally avoided: weld only moves a vertex that has a finer surface
  correspondent in the overlap band; a true wall has none.

---

## 5. Verification

1. **Visual A/B**, same AOI/quality, `stripSeamRisers` off:
   before (current) vs after (carve+weld+balance), with the candidate-centroid
   overlay. Target: the flat-ground wall grid gone, facades/curbs intact.
2. **Headless**: `node scripts/smokeRefineSession.mjs` asserts post-stitch
   candidate count below a small bound; bake → 2 refines stays stable.
3. **Export round-trip**: GLB opens clean in a glTF viewer (no riser grid); the
   BeamNG DAE path unaffected.
4. **Refinement**: fly-mode R refine still sharpens and the seams stay closed
   across revisions.

---

## 6. Sequencing

A (measure) → B (carve, the bulk) → **re-measure** → C (weld, the closer) →
D (balance, the polish) → E (retire the band-aid). Ship B+C first if the spike
shows they alone clear the grid; D and E follow.
