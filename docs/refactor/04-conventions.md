# 04 — Conventions & Playbooks

Standards the refactor introduces and enforces. Keep this doc as the contract
new code is reviewed against.

## 1. Package template

Every `packages/<name>/`:

```
package.json     name "@mapng/<name>", "type":"module", explicit @mapng/* deps
index.js         the ONLY public surface — barrel of intended exports
src/             implementation; cross-package imports hit other packages' index only
*.test.mjs       co-located headless tests (node --test)
README.md        one paragraph: what this package owns + what it must NOT do
```

Rule: **import from a package's barrel, never its internals.**
`import { clamp } from '@mapng/geo'` — not `@mapng/geo/src/math.js`.

## 2. Dependency direction (hard rule)

```
geo, workers  →  fetching  →  terrain  →  tiles  →  osm  →  export  →  route  →  pipelines  →  app
```
- Lower never imports higher. Leaves (`geo`, `workers`) import no `@mapng/*`.
- Only `app/` imports Vue. Only `fetching`/`workers` touch `window`/DOM/network.
- `tools/` may import leaf packages; nothing imports `tools/`.
- Enforced by `dependency-cruiser` (warn from Phase 0, error from Phase 9).

## 3. Naming

- Packages: lowercase noun of the domain (`geo`, `terrain`, `export`).
- Files: `camelCase.js` matching the primary export.
- Exported funcs: verbs (`buildTerrainGrid`, `bakeTile`, `exportBeamNGLevel`);
  pure helpers are nouns/adjectives (`clamp`, `bilinear`).
- No `utils.js` grab-bags inside a package — name files by concern
  (`projection.js`, `sampling.js`), not by being "misc".

## 4. File-size budget

- Target ≤ 300 LOC, hard cap **500 LOC** per file. A file over budget is a
  signal it holds more than one concern — split it.
- Add a lint check (simple script over `wc -l` or
  `eslint max-lines: [error, 500]`) in Phase 9.

## 5. Separation of concerns

A module does **one** of: fetch, compute, or serialize. Not two.
- Fetch modules return data, never rasterize or write files.
- Compute modules are pure where possible: inputs → outputs, no `fetch`, no DOM.
- IO/serialize modules take finished data and emit bytes.
- Orchestration (sequencing fetch→compute→IO) lives only in `@mapng/pipelines`.

## 6. God-file split playbook

For `exportBeamNGLevel.js` (5558), `export3d.js` (2164), `terrain.js` (1986),
`osmTexture.js` (1886), `batchJob.js` (1561):

1. **Map the seams** — list the distinct responsibilities inside the file
   (e.g. exportBeamNG: terrain `.ter` write, material/layer map, TSStatic
   placement, `info/items.level.json` assembly, ZIP packing).
2. **Move the file unchanged** into its package first; get green.
3. **Extract one seam per commit** into a sibling `src/*.js`, re-exported from
   the file's existing public function. Keep the public signature identical.
4. **Hash against the Phase-0 oracle** after every extraction. Any drift = stop,
   the seam wasn't pure.
5. When the orchestrator shell is all that's left, it moves to `@mapng/pipelines`
   if it sequences other packages, or stays as the package's entry if it's
   format-internal.

Never extract by line-range mechanically — extract by responsibility.

## 7. Shared abstractions to introduce (carefully, as follow-ups)

Introduce these **after** the relevant move, never during:
- `httpClient` (fetching): retry + backoff + header injection; replaces ad-hoc
  `fetch` in `osm`/`nominatim`/`googleRoutes`/`tilesAuth`.
- `Cache` interface (fetching): one contract over memory / IndexedDB / disk.
- `WorkerPool` + message envelope (workers): replaces the per-pair postMessage
  protocols.
- Data-not-code: `beamngFlavorCatalog` and big OSM material tables → JSON loaded
  at runtime.

## 8. Testing strategy

- **Keep all existing `node --test` suites green at every phase** — they are the
  safety net.
- Pure helpers get a unit test when consolidated (Phase 1 onward).
- Pipelines get **integration tests** once lifted out of `App.vue` (Phase 8),
  with mocked fetch + the bake oracle for output assertions.
- Regression oracle: `tools/testlab/captureRealBake.mjs` snapshots real bake
  output; diff exports against it after risky phases (4, 5, 6, 7).

## 9. Commit / PR discipline

- One concern per commit; **move commits and split commits are never the same
  commit.**
- Each PR maps to one phase (or one package within a phase) and states its
  verification gate result.
- Behaviour-preserving means behaviour-preserving: if output bytes change,
  it's a separate, justified change — not part of the refactor.
