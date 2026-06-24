# @mapng/geo

Pure projection and grid math. The single source of truth for coordinate
transforms (local Transverse Mercator, UTM, metric projectors) and the small
numeric helpers (`clamp`, `bilinear`, `lerp`, `metersPerDegreeLng`, …) that were
previously inlined across the bake pipelines.

**Owns:** WGS84 ↔ local-metric/UTM projection, pixel projectors, scalar/grid math.

**Must NOT:** fetch, touch the DOM, import any other `@mapng/*` package, or know
about terrain/tiles/export domain types. Leaf package — depends only on `proj4`.
