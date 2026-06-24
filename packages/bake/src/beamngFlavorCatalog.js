/** @layer io */
// BeamNG flavor accessors (refactor doc 06 step 10). The static data tables
// now live under materials/; this file is the lookup/selector logic plus the
// runtime shape-material library fetch. Re-exports BEAMNG_FLAVORS so existing
// consumers (`./beamngFlavorCatalog.js`, `@mapng/bake`) stay unchanged.
import { DEFAULT_TERRAIN_CANDIDATES } from './materials/groundCoverMaterials.js';
import { ASSET_SETS } from './materials/forestAssetSets.js';
import { WATER_PROFILES } from './materials/waterProfiles.js';
import { BEAMNG_FLAVORS } from './materials/beamngFlavors.js';

export { BEAMNG_FLAVORS };

const FLAVOR_BY_ID = new Map(BEAMNG_FLAVORS.map((flavor) => [flavor.id, flavor]));
let shapeMaterialLibraryPromise = null;

const normalizeLevelName = (value) => String(value || '').toLowerCase();

export function getBeamNGFlavorById(flavorId) {
  return FLAVOR_BY_ID.get(flavorId) ?? null;
}

export function getBeamNGFlavorOptions() {
  return BEAMNG_FLAVORS.map(({ id, label }) => ({ id, label }));
}

export function getTerrainSemanticCandidates(semanticName) {
  return DEFAULT_TERRAIN_CANDIDATES[semanticName] ?? [semanticName];
}

export function getTerrainLevelFallbacks(flavor) {
  return Array.from(new Set([
    flavor?.levelName,
    ...(flavor?.terrainLevelFallbacks ?? []),
  ].filter(Boolean)));
}

export function getGroundCoverProfile(flavor) {
  for (const assetSetId of flavor?.assetSetIds ?? []) {
    const groundCover = ASSET_SETS[assetSetId]?.groundCover;
    if (groundCover) return groundCover;
  }
  return ASSET_SETS.italy.groundCover;
}

export function getManagedForestTemplate(flavor, itemName) {
  for (const assetSetId of flavor?.assetSetIds ?? []) {
    const template = ASSET_SETS[assetSetId]?.managedItemTemplates?.[itemName];
    if (template) return template;
  }
  return null;
}

function getVegetationSelector(flavor, selectorName) {
  for (const assetSetId of flavor?.assetSetIds ?? []) {
    const selectors = ASSET_SETS[assetSetId]?.vegetationSelectors;
    if (selectors?.[selectorName]) return selectors[selectorName];
  }
  return null;
}

export function resolveTreeTypeForTags(flavor, tags = {}) {
  const species = `${tags.species || ''} ${tags['species:en'] || ''}`.toLowerCase();
  if (species.includes('olive')) return getVegetationSelector(flavor, 'olive') ?? getVegetationSelector(flavor, 'default');
  if (species.includes('cypress')) return getVegetationSelector(flavor, 'cypress') ?? getVegetationSelector(flavor, 'default');
  if (species.includes('palm') || tags.leaf_type === 'palm') return getVegetationSelector(flavor, 'palm') ?? getVegetationSelector(flavor, 'default');
  if (tags.leaf_type === 'needleleaved' || tags.wood === 'coniferous') return getVegetationSelector(flavor, 'needle') ?? getVegetationSelector(flavor, 'default');
  return getVegetationSelector(flavor, 'default') ?? getVegetationSelector(flavor, 'bush');
}

export function resolveBushType(flavor, { hedge = false } = {}) {
  return getVegetationSelector(flavor, hedge ? 'hedgeBush' : 'bush')
    ?? getVegetationSelector(flavor, 'default')
    ?? 'generibush';
}

export function getRockCandidates(flavor) {
  for (const assetSetId of flavor?.assetSetIds ?? []) {
    const candidates = ASSET_SETS[assetSetId]?.rockCandidates;
    if (Array.isArray(candidates) && candidates.length > 0) return candidates;
  }
  return ASSET_SETS.italy.rockCandidates;
}

export function getWaterProfile(flavor) {
  return flavor?.waterProfile ?? WATER_PROFILES.italy;
}

export function getGlobalEnvironmentMap(flavor) {
  return flavor?.environmentProfile?.globalEnvironmentMap ?? 'cubemap_italy_reflection';
}

export function doesFlavorMatchLevel(flavor, levelName) {
  return normalizeLevelName(flavor?.levelName) === normalizeLevelName(levelName);
}

async function loadShapeMaterialLibrary() {
  if (!shapeMaterialLibraryPromise) {
    shapeMaterialLibraryPromise = fetch('/beamng_shape_materials.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load BeamNG shape materials: ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        console.warn('Failed to load BeamNG shape material library:', error);
        return {};
      });
  }
  return shapeMaterialLibraryPromise;
}

export async function getShapeMaterialDefsForFlavor(flavor) {
  const library = await loadShapeMaterialLibrary();
  const merged = {};
  for (const assetSetId of flavor?.assetSetIds ?? []) {
    Object.assign(merged, library?.[assetSetId] ?? {});
  }
  return merged;
}
