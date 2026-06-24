/** @layer core */
// Pure rasterization of OSM features → BeamNG terrain layer map (refactor doc
// 06 step 10). The layer map is a Uint8Array of material indices, terrain-space
// origin at the SW corner, Y increases northward, row-major: index = y*size + x.
// No DOM/network — moved verbatim from osmTerrainMaterials.js.

// ── OSM → road material + width ────────────────────────────────────────────
const ROAD_STYLE = {
  motorway:       { mat: 5, halfWidthM: 9.0 },
  motorway_link:  { mat: 5, halfWidthM: 5.0 },
  trunk:          { mat: 5, halfWidthM: 8.0 },
  trunk_link:     { mat: 5, halfWidthM: 5.0 },
  primary:        { mat: 5, halfWidthM: 7.0 },
  primary_link:   { mat: 5, halfWidthM: 4.0 },
  secondary:      { mat: 5, halfWidthM: 6.0 },
  secondary_link: { mat: 5, halfWidthM: 3.5 },
  tertiary:       { mat: 5, halfWidthM: 5.0 },
  tertiary_link:  { mat: 5, halfWidthM: 3.0 },
  residential:    { mat: 5, halfWidthM: 4.0 },
  living_street:  { mat: 5, halfWidthM: 3.0 },
  unclassified:   { mat: 5, halfWidthM: 4.0 },
  road:           { mat: 5, halfWidthM: 4.0 },
  service:        { mat: 5, halfWidthM: 2.5 },
  raceway:        { mat: 5, halfWidthM: 6.0 },
  busway:         { mat: 5, halfWidthM: 4.0 },
  pedestrian:     { mat: 7, halfWidthM: 4.0 },
  track:          { mat: 6, halfWidthM: 2.5 },
  footway:        { mat: 7, halfWidthM: 1.2 },
  cycleway:       { mat: 7, halfWidthM: 1.2 },
  path:           { mat: 6, halfWidthM: 1.0 },
};

// Linear waterway types → half-width in metres for terrain-layer rasterisation.
const WATERWAY_STYLE = {
  river:  { halfWidthM: 12.0 },
  canal:  { halfWidthM:  6.0 },
  stream: { halfWidthM:  2.5 },
  drain:  { halfWidthM:  2.0 },
  ditch:  { halfWidthM:  1.5 },
};

const CONCRETE_LANDUSES = new Set(['commercial', 'industrial', 'retail']);

// ── Coordinate conversion ──────────────────────────────────────────────────

/**
 * Convert WGS84 lat/lng to terrain pixel coordinates.
 * Terrain space: (0,0) = SW corner, px increases eastward, py increases northward.
 * Layer map index = py * size + px  (row-major, bottom-left origin).
 */
function geoToTerrainPx(lat, lng, bounds, size) {
  const px = (lng - bounds.west)  / (bounds.east  - bounds.west)  * (size - 1);
  const py = (lat - bounds.south) / (bounds.north - bounds.south) * (size - 1);
  return {
    px: Math.max(0, Math.min(size - 1, Math.round(px))),
    py: Math.max(0, Math.min(size - 1, Math.round(py))),
  };
}

// ── Rasterization ──────────────────────────────────────────────────────────

/**
 * Rasterize a thick line segment into the layer map using distance-to-segment.
 */
function rasterizeSegment(layerMap, size, x0, y0, x1, y1, halfPx, matIdx) {
  const dx = x1 - x0, dy = y1 - y0;
  const segLen2 = dx * dx + dy * dy;
  const r2 = halfPx * halfPx;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - halfPx));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(x0, x1) + halfPx));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - halfPx));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(y0, y1) + halfPx));
  for (let y = minY; y <= maxY; y++) {
    const row = y * size;
    for (let x = minX; x <= maxX; x++) {
      let dist2;
      if (segLen2 < 1e-9) {
        const ex = x - x0, ey = y - y0;
        dist2 = ex * ex + ey * ey;
      } else {
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / segLen2));
        const ex = x - (x0 + t * dx), ey = y - (y0 + t * dy);
        dist2 = ex * ex + ey * ey;
      }
      if (dist2 <= r2) layerMap[row + x] = matIdx;
    }
  }
}

/**
 * Scanline-fill a polygon ring (array of {px,py} in terrain space) with materialIndex.
 */
function rasterizePolygon(layerMap, size, ring, matIdx) {
  if (ring.length < 3) return;
  const n = ring.length;
  let minY = size, maxY = 0;
  for (const p of ring) {
    if (p.py < minY) minY = p.py;
    if (p.py > maxY) maxY = p.py;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(size - 1, Math.ceil(maxY));

  for (let y = minY; y <= maxY; y++) {
    const sy = y + 0.5;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = ring[i].py, y1 = ring[j].py;
      if ((y0 <= sy && y1 > sy) || (y1 <= sy && y0 > sy)) {
        xs.push(ring[i].px + (sy - y0) / (y1 - y0) * (ring[j].px - ring[i].px));
      }
    }
    xs.sort((a, b) => a - b);
    const row = y * size;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(size - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) layerMap[row + x] = matIdx;
    }
  }
}

/**
 * Return material index for an OSM area/polygon feature, or -1 if unrecognized.
 */
function areaMatIndex(feature) {
  const t = feature.tags || {};
  const nat = t.natural, lu = t.landuse, lei = t.leisure, am = t.amenity, sur = t.surface;

  if (nat === 'grass' || nat === 'meadow' || nat === 'heath') return 1;
  if (nat === 'grassland' || nat === 'shrub') return 1;
  if (nat === 'wood' || nat === 'scrub' || nat === 'shrubbery') return 1;
  if (nat === 'sand' || nat === 'beach' || nat === 'dune') return 3;
  if (nat === 'bare_rock' || nat === 'rock' || nat === 'scree' || nat === 'cliff') return 4;
  if (nat === 'shingle') return 4;
  if (nat === 'mud') return 2;
  if (nat === 'water' || nat === 'wetland') return -1;

  if (lu === 'grass' || lu === 'meadow' || lu === 'village_green') return 1;
  if (lu === 'recreation_ground' || lu === 'allotments' || lu === 'cemetery') return 1;
  if (lu === 'orchard' || lu === 'vineyard') return 1;
  if (lu === 'forest' || lu === 'wood') return 1;
  if (lu === 'religious' || lu === 'greenfield') return 1;
  if (lu === 'farmland' || lu === 'farmyard' || lu === 'greenhouse_horticulture') return 2;
  if (lu === 'brownfield' || lu === 'construction' || lu === 'landfill') return 2;
  if (lu === 'military') return 2;
  if (CONCRETE_LANDUSES.has(lu)) return 7;
  if (lu === 'garages') return 5;
  if (lu === 'residential') return 1;
  if (lu === 'quarry') return 4;
  if (lu === 'railway') return 6;
  if (lu === 'reservoir' || lu === 'basin') return -1;

  if (lei === 'park' || lei === 'garden' || lei === 'playground') return 1;
  if (lei === 'recreation_ground' || lei === 'pitch' || lei === 'golf_course') return 1;
  if (lei === 'nature_reserve' || lei === 'common' || lei === 'dog_park') return 1;
  if (lei === 'sports_centre' || lei === 'stadium') return 7;
  if (lei === 'beach_resort') return 3;
  if (lei === 'track') return 5;

  if (am === 'parking') return 7;
  if (am === 'fuel') return 5;

  if (sur === 'asphalt' || sur === 'paved') return 5;
  if (sur === 'concrete') return 7;
  if (sur === 'gravel' || sur === 'dirt' || sur === 'unpaved' || sur === 'compacted') return 6;
  if (sur === 'grass') return 1;
  if (sur === 'sand') return 3;

  return -1;
}

// ── OSM layer map builder ──────────────────────────────────────────────────

export function buildOSMLayerMap(terrainData, worldSize) {
  const { width: size, bounds, osmFeatures = [] } = terrainData;
  const metersPerPixel = worldSize / size;
  const layerMap = new Uint8Array(size * size);

  // 1. Paint area polygons (painted first; roads override on top).
  for (const feature of osmFeatures) {
    if (feature.type === 'road') continue;
    const matIdx = areaMatIndex(feature);
    if (matIdx < 0 || !feature.geometry?.length) continue;
    const ring = feature.geometry.map(pt => geoToTerrainPx(pt.lat, pt.lng, bounds, size));
    rasterizePolygon(layerMap, size, ring, matIdx);
  }

  // 2. Paint water area bodies (overrides land-use fills).
  for (const feature of osmFeatures) {
    if (feature.type === 'road' || !feature.geometry?.length) continue;
    const t = feature.tags || {};
    const isWaterArea =
      t.natural === 'water' || t.natural === 'wetland' ||
      t.water ||
      t.landuse === 'reservoir' || t.landuse === 'basin' ||
      t.leisure === 'swimming_pool' ||
      ['riverbank', 'dock', 'boatyard', 'dam'].includes(t.waterway);
    if (!isWaterArea) continue;
    const ring = feature.geometry.map(pt => geoToTerrainPx(pt.lat, pt.lng, bounds, size));
    rasterizePolygon(layerMap, size, ring, 0);
  }

  // 3. Paint linear waterways.
  for (const feature of osmFeatures) {
    if (!feature.geometry?.length || feature.type !== 'water') continue;
    const t = feature.tags || {};
    const wStyle = WATERWAY_STYLE[t.waterway];
    if (!wStyle) continue;
    const halfPx = Math.max(1, wStyle.halfWidthM / metersPerPixel);
    const pts = feature.geometry.map(pt => geoToTerrainPx(pt.lat, pt.lng, bounds, size));
    for (let i = 0; i < pts.length - 1; i++) {
      rasterizeSegment(layerMap, size, pts[i].px, pts[i].py, pts[i + 1].px, pts[i + 1].py, halfPx, 0);
    }
  }

  // 4. Paint roads (overrides area fills).
  for (const feature of osmFeatures) {
    if (feature.type !== 'road' || !feature.geometry?.length) continue;
    const highway = feature.tags?.highway;
    const style = ROAD_STYLE[highway];
    if (!style) continue;
    const halfPx = Math.max(1, style.halfWidthM / metersPerPixel);
    const pts = feature.geometry.map(pt => geoToTerrainPx(pt.lat, pt.lng, bounds, size));
    for (let i = 0; i < pts.length - 1; i++) {
      rasterizeSegment(layerMap, size, pts[i].px, pts[i].py, pts[i + 1].px, pts[i + 1].py, halfPx, style.mat);
    }
  }

  return layerMap;
}

// ── Image-based layer map classifier ───────────────────────────────────────

/**
 * Map an RGB pixel color from the segmented satellite image to a material index.
 * Uses HSV color space to classify terrain cover types.
 */
export function colorToMaterialIndex(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const s = max === 0 ? 0 : delta / max; // HSV saturation

  let h = 0;
  if (delta > 0) {
    if (max === rn)      h = ((gn - bn) / delta % 6) * 60;
    else if (max === gn) h = ((bn - rn) / delta + 2) * 60;
    else                 h = ((rn - gn) / delta + 4) * 60;
    if (h < 0) h += 360;
  }

  // Very dark → asphalt / roads
  if (max < 0.25) return 5;

  // Blue / cyan → water (DefaultMaterial, index 0)
  if (h >= 170 && h <= 265 && s > 0.25) return 0;

  // Green → grass / vegetation
  if (h >= 60 && h <= 160 && s > 0.12) return 1;

  // Yellow-green with moderate saturation → grass
  if (h >= 40 && h < 60 && s > 0.1 && max > 0.35) return 1;

  // Sandy yellow / beige (high value, moderate saturation)
  if (h >= 30 && h < 60 && s > 0.15 && max > 0.55) return 3;

  // Brown / earthy → dirt
  if (h >= 15 && h < 45 && s > 0.15) return 2;

  // Reddish tones (rooftops, urban) → concrete
  if ((h < 20 || h > 340) && s > 0.2) return 7;

  // Desaturated grays
  if (s < 0.1) {
    if (max < 0.4) return 4; // dark gray → rock
    if (max < 0.72) return 7; // medium gray → concrete
    return 1; // light gray → grass / default
  }

  return 1; // fallback: grass
}
