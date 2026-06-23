# MapNG Cleanup Refactor

Goal: move from a flat Vue app with a 60-file `services/` junk drawer and a
1200-line `App.vue` to a **package-based architecture** with small, focused,
independently testable packages — without changing runtime behaviour of the two
working pipelines (single-tile bake and route bake).

This is a **behaviour-preserving refactor**. The bake/export output must be
byte-stable across every step. Each phase is shippable on its own.

## Documents

| Doc | Purpose |
|---|---|
| [01-current-architecture.md](01-current-architecture.md) | Verified map of what exists today: both pipelines, shared modules, the dependency graph, and the concrete smells. |
| [02-target-architecture.md](02-target-architecture.md) | The target package layout, package boundaries, dependency rules, and the two pipelines re-drawn on top of it. |
| [03-migration-plan.md](03-migration-plan.md) | Phased, ordered, shippable steps. Each phase lists files moved, risk, and the verification gate. |
| [04-conventions.md](04-conventions.md) | Engineering standards the refactor enforces: package template, import rules, naming, file-size budgets, test strategy, the god-file split playbook. |
| [05-execution-log.md](05-execution-log.md) | What was actually executed vs planned, the deviations forced by the real dependency graph, and what is deliberately deferred (and why). **Read this for current state.** |

## Guiding principles

1. **Pipelines stay green the whole time.** `npm run test:*` and a manual
   single-tile + route bake must pass after every phase. No "big bang".
2. **Extract shared core first, pipelines last.** The two pipelines are thin
   orchestrators over a shared core (terrain, tiles, osm, export). Stabilise the
   core, then the pipelines fall out cleanly.
3. **Move before you split.** Relocate a file into its package unchanged, get
   imports green, *then* break up god-files. Never do both in one commit.
4. **One concern per package.** fetching ≠ compute ≠ IO. A package that fetches
   should not also rasterize and not also write ZIPs.
5. **Leaf packages have no app/Vue/DOM imports.** Geo math, terrain grids, and
   exporters must be runnable headless (they already are — see `tests/*.mjs`).
