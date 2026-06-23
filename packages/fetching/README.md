# @mapng/fetching

External data ingestion: Overpass/OSM, Nominatim geocoding, Google Routes, Google
3D Tiles auth, the elevation cache, the uploaded-file loaders (ASC, LAZ, GeoTIFF,
GML, Kron86), the persistent IndexedDB tile cache, and the shared retry policy.

**Owns:** all network/disk source access and parsing of fetched/uploaded data.

**Must NOT:** import compute (`terrain`/`tiles`/`osm`), export, route, or pipeline
packages. May depend on `@mapng/geo`. (Worker-backed decode for LAZ lives in
`@mapng/workers`; `lazLoader` here is the loader-side entry.)
