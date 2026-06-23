# @mapng/bake

The terrain + Google-3D-Tiles + OSM + export compute core. This is the
behaviour-critical heart of both pipelines (single-tile and route share it).

It is intentionally **one** package today because these modules form a tightly
coupled subsystem with cross-cutting edges that cannot be cut without
behaviour-affecting function moves:

- `terrain.js` → `osmTexture.js` (terrain texture composite pulls OSM)
- `scalarFieldGrid.js` → `googleBakeCore.js` (`SCENE_SIZE` constant)
- `junctionMesh.js` → `ColladaExporter.js` (+ `exportBeamNGLevel → junctionMesh`)
  forms a compute↔export cycle.

**Planned internal split** (deep follow-up, must stay byte-stable against the
bake oracle): `terrain` · `tiles` · `osm` · `export` sub-packages, after
(a) moving shared constants like `SCENE_SIZE` into `@mapng/geo`, and
(b) extracting the terrain↔osm texture seam. The god-files
(`exportBeamNGLevel.js` 5558 LOC, `export3d.js`, `terrain.js`, `osmTexture.js`)
are decomposed as part of that work — see `docs/refactor/04-conventions.md`.

**Imports:** `@mapng/geo`, `@mapng/fetching`. Consumers import a specific module
via subpath (`@mapng/bake/terrain`) to avoid eager-loading worker/browser
siblings; the flat `index.js` barrel is convenience for the browser app.

**Worker entry:** `resamplerWorker.js` (has top-level `self.onmessage`) is **not**
re-exported from the barrel.
