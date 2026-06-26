// Terrain-elevation sandbox helpers — pure logic for the /terrain-sandbox lab.
//
// Bakes STANDARD-quality Google Photorealistic 3D Tiles for a small AOI, then
// rasterises the tile surface into a shared HeightField (see groundRaster.js).
// Several ground-extraction approaches (DEM baseline, raw tile-aligned, and the
// pluggable filters in ./filters) distil a smooth drivable .ter from that one
// field and are rendered side by side for comparison — the .ter is what we
// actually drive on in BeamNG; the tiles are decoration on top.
//
// Vertical registration matches the BeamNG export exactly (tileMeshTransform):
// a ground point sits at Y_m = sampleHeightAtScene(data, x, z) - minHeight, and
// the tiles group carries scale.y = computeUnitsPerMeter(data). The HeightField
// works entirely in those scene units, so every approach co-registers with the
// tiles.
import { bakeVariant } from '../quality-sandbox/sandbox.js';
import { computeUnitsPerMeter } from '@mapng/bake/google3dTiles';
import { loadSatelliteTexture } from './textureLoader.js';
import { buildTileHeightField } from './groundRaster.js';

// Re-export the curated AOI presets + tile sizes so the app shares one source.
export { PRESETS, TILE_SIZES, disposeGroup, fmt, computeGroupStats } from '../quality-sandbox/sandbox.js';

// Standard-quality bake options — the production default. The terrain sandbox is
// about the GROUND, not the tile-quality knobs, so this stays fixed.
export const STANDARD_OPTIONS = {
  quality: 'standard',
  errorTarget: 5,
  sensorSize: 1024,
  cameraSweep: true,
  stripGround: false, // keep Google's ground visible so we can compare it to .ter
  weld: false,
  conform: false,
  roadmask: false,
};

/**
 * Bake standard-quality tiles and rasterise their surface into a HeightField.
 *
 * Returns the tiles group (already y-scaled to scene units), the raw TerrainData,
 * unitsPerMeter, an optional ground texture, and the shared HeightField every
 * approach consumes. The app builds one ground mesh per approach from the field.
 */
export async function bakeTerrainScene(aoi, { onProgress, forceRebake = false, signal, terrainTexture = 'satellite', maxSeg = 192 } = {}) {
  const { group: tilesGroup, terrain } = await bakeVariant(aoi, { ...STANDARD_OPTIONS }, {
    onProgress,
    forceRebake,
    signal,
  });

  const upm = computeUnitsPerMeter(terrain) || 1;

  let texture = null;
  if (terrainTexture === 'satellite') texture = await loadSatelliteTexture(terrain.satelliteTextureUrl);
  else if (terrainTexture === 'osm') texture = await loadSatelliteTexture(terrain.osmTextureUrl || terrain.satelliteTextureUrl);

  onProgress?.('rasterising tile surface…');
  const field = buildTileHeightField(tilesGroup, terrain, upm, { maxSeg });

  // Tile coverage = fraction of nodes that actually saw a tile vertex (the rest
  // fall back to the DEM). Reported so low-coverage AOIs are obvious.
  let covered = 0;
  for (let i = 0; i < field.covered.length; i++) covered += field.covered[i];
  const coverage = +(covered / field.covered.length).toFixed(3);

  return { tilesGroup, terrain, unitsPerMeter: upm, texture, field, coverage };
}
