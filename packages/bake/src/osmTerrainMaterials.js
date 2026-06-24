/** @layer io */
/**
 * OSM-driven terrain material painting for BeamNG levels.
 *
 * Reads OSM feature data and rasterizes it onto a BeamNG terrain layer map
 * (a Uint8Array where each byte is a material index, terrain-space origin at
 * the SW corner, Y increases northward, row-major: index = y*size + x).
 *
 * Material definitions reference textures from BeamNG's base game levels —
 * no textures are generated; only the material JSON is needed in the ZIP.
 *
 * The static reference-material data and the pure OSM rasterization live under
 * materials/ (refactor doc 06 step 10); this file keeps the library resolution,
 * canvas-based texture generation, and the buildTerrainMaterials orchestrator.
 */

import {
  getTerrainLevelFallbacks,
  getTerrainSemanticCandidates,
} from './beamngFlavorCatalog.js';
import {
  MATERIAL_NAMES,
  MATERIAL_NAMES_LIST,
  REFERENCE_MATERIALS,
} from './materials/terrainReferenceMaterials.js';
import { buildOSMLayerMap, colorToMaterialIndex } from './materials/osmLayerMap.js';

// Re-export the ordered material name list so existing consumers (`@mapng/bake`,
// exportTer) keep importing it from here.
export { MATERIAL_NAMES };

let terrainMaterialLibraryPromise = null;

function normalizeLevelName(value) {
  return String(value || '').toLowerCase();
}

function normalizeMaterialName(value) {
  return String(value || '').trim().toLowerCase();
}

async function loadTerrainMaterialLibrary() {
  if (!terrainMaterialLibraryPromise) {
    terrainMaterialLibraryPromise = fetch('/example_terrain.materials.json')
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load terrain material library: ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        console.warn('Failed to load terrain material library, using built-in fallbacks:', error);
        return {};
      });
  }
  return terrainMaterialLibraryPromise;
}

function collectLevelNames(value, acc = new Set()) {
  if (typeof value === 'string') {
    const matches = value.match(/\/levels\/([^/]+)\//gi) ?? [];
    for (const match of matches) {
      const levelName = match.split('/levels/')[1]?.split('/')[0];
      if (levelName) acc.add(normalizeLevelName(levelName));
    }
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLevelNames(item, acc);
    return acc;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectLevelNames(item, acc);
  }
  return acc;
}

function matchesMaterialCandidate(entryKey, template, candidate) {
  const names = [
    entryKey,
    template?.name,
    template?.internalName,
    template?.mapTo,
  ].map(normalizeMaterialName).filter(Boolean);
  const expected = normalizeMaterialName(candidate);
  return names.some((name) => name === expected);
}

function findLibraryTemplateForCandidate(library, levelName, candidate) {
  const normalizedLevel = normalizeLevelName(levelName);
  for (const [entryKey, template] of Object.entries(library || {})) {
    if (!template || typeof template !== 'object') continue;
    const levels = collectLevelNames(template);
    if (levels.size > 0 && !levels.has(normalizedLevel)) continue;
    if (!matchesMaterialCandidate(entryKey, template, candidate)) continue;
    return structuredClone(template);
  }
  return null;
}

function findFallbackReferenceMaterial(semanticName) {
  const candidates = getTerrainSemanticCandidates(semanticName);
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeMaterialName(candidate);
    const ref = REFERENCE_MATERIALS.find(({ internalName }) => normalizeMaterialName(internalName) === normalizedCandidate);
    if (ref) return cloneMaterialTemplate(ref.template);
  }
  const ref = REFERENCE_MATERIALS.find(({ internalName }) => normalizeMaterialName(internalName) === normalizeMaterialName(semanticName));
  return ref ? cloneMaterialTemplate(ref.template) : null;
}

async function resolveReferenceMaterialsForFlavor(flavor) {
  const library = await loadTerrainMaterialLibrary();
  const levelFallbacks = getTerrainLevelFallbacks(flavor);
  return MATERIAL_NAMES_LIST.slice(1).map((semanticName) => {
    const candidates = getTerrainSemanticCandidates(semanticName);
    for (const levelName of levelFallbacks) {
      for (const candidate of candidates) {
        const template = findLibraryTemplateForCandidate(library, levelName, candidate);
        if (template) return { internalName: semanticName, template };
      }
    }
    const fallbackTemplate = findFallbackReferenceMaterial(semanticName);
    return {
      internalName: semanticName,
      template: fallbackTemplate ?? {},
    };
  });
}

// ── Image-based layer map builder ──────────────────────────────────────────

/**
 * Build a terrain-space layer map by inferring material indices from the
 * colors in a segmented satellite image canvas.
 *
 * The canvas origin is NW (top-left); the layer map origin is SW (bottom-left)
 * so Y must be flipped during sampling.
 *
 * @param {HTMLCanvasElement} canvas - segmented (hybrid) image at any resolution
 * @param {number} terrainSize - square side length of the target layer map
 * @returns {Uint8Array} layer map (row-major, SW origin)
 */
function buildLayerMapFromImage(canvas, terrainSize) {
  // Draw canvas into an offscreen canvas at terrain resolution, flipping Y so
  // (0,0) becomes SW instead of NW.
  const offscreen = document.createElement('canvas');
  offscreen.width  = terrainSize;
  offscreen.height = terrainSize;
  const ctx = offscreen.getContext('2d');
  ctx.translate(0, terrainSize);
  ctx.scale(1, -1);
  ctx.drawImage(canvas, 0, 0, terrainSize, terrainSize);

  const { data } = ctx.getImageData(0, 0, terrainSize, terrainSize);
  const layerMap = new Uint8Array(terrainSize * terrainSize);
  for (let i = 0; i < terrainSize * terrainSize; i++) {
    layerMap[i] = colorToMaterialIndex(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return layerMap;
}

// ── Shared base texture generation (neutral AO / normal / roughness) ───────
// These are generated at baseSize to match the TerrainMaterialTextureSet.
// Only 6 textures total regardless of how many materials are used.

async function makeAoBlob(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.getContext('2d').fillStyle = '#ffffff';
  canvas.getContext('2d').fillRect(0, 0, size, size);
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

async function makeNormalBlob(bumpiness = 0, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  if (bumpiness === 0) {
    // Flat normal map (R=128, G=128, B=255) — no bumpiness.
    for (let i = 0; i < size * size; i++) {
      d[i * 4] = 128; d[i * 4 + 1] = 128; d[i * 4 + 2] = 255; d[i * 4 + 3] = 255;
    }
  } else {
    const raw = new Float32Array(size * size);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.random();
    const blurred = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size, xp = (x + 1) % size;
        const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size;
        const row = y * size;
        blurred[row + x] = (
          raw[ym + xm] + raw[ym + x] + raw[ym + xp] +
          raw[row + xm] + raw[row + x] + raw[row + xp] +
          raw[yp + xm] + raw[yp + x] + raw[yp + xp]
        ) / 9;
      }
    }
    const scale = bumpiness * 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size, xp = (x + 1) % size;
        const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size;
        const row = y * size;
        const gx = (blurred[row + xp] - blurred[row + xm]) * scale;
        const gy = (blurred[yp + x] - blurred[ym + x]) * scale;
        const gz = 1;
        const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
        const i = row + x;
        d[i * 4]     = Math.round((gx / len * 0.5 + 0.5) * 255);
        d[i * 4 + 1] = Math.round((gy / len * 0.5 + 0.5) * 255);
        d[i * 4 + 2] = Math.round((gz / len * 0.5 + 0.5) * 255);
        d[i * 4 + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

async function makeRoughnessBlob(roughness = 180, variance = 0, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, roughness + (Math.random() - 0.5) * variance * 2));
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}

function cloneMaterialTemplate(template) {
  return structuredClone(template);
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Build BeamNG terrain materials.
 *
 * @param {object} terrainData  — { width, bounds, osmFeatures }
 * @param {number} worldSize    — terrain width in metres
 * @param {string} exportLevelName — generated BeamNG level folder name
 * @param {object} flavor          — BeamNG flavor profile
 * @param {number} [satelliteTexSize] — base texture pixel size (defaults to terrainData.width)
 * @param {object} [options]
 * @param {'osm'|'image'} [options.pbrSource='osm'] — layer map source
 * @param {HTMLCanvasElement|null} [options.imageCanvas=null] — segmented image for 'image' mode
 * @returns {Promise<{
 *   layerMap: Uint8Array,
 *   materialNames: string[],
 *   materialDefs: object,
 *   textureFiles: Array<{path:string, blob:Blob}>,
 *   textureSetName: string,
 * }>}
 */
export async function buildTerrainMaterials(terrainData, worldSize, exportLevelName, flavor, satelliteTexSize, options = {}) {
  const { pbrSource = 'osm', imageCanvas = null } = options;
  const { width: size } = terrainData;
  const baseSize = satelliteTexSize ?? size;
  const levelName = exportLevelName;

  // ── Build layer map ────────────────────────────────────────────────────────
  let layerMap;
  if (pbrSource === 'image' && imageCanvas) {
    layerMap = buildLayerMapFromImage(imageCanvas, size);
  } else {
    layerMap = buildOSMLayerMap(terrainData, worldSize);
  }

  // ── Material definitions ───────────────────────────────────────────────────
  const DETAIL_SIZE = 1024;
  const textureFiles = [];
  const materialDefs = {};
  const referenceMaterials = await resolveReferenceMaterialsForFlavor(flavor);

  // TerrainMaterialTextureSet: switches BeamNG to PBR mode. baseTexSize must
  // match the pixel dimensions of the base-slot textures we generate below.
  //
  // Torque SimObject names must start with a letter — a level named "5"
  // would yield "5TerrainMaterialTextureSet", which silently fails to
  // register and renders the ENTIRE terrain black (no textures ever bind).
  const safeNamePrefix = /^[A-Za-z_]/.test(levelName) ? levelName : `m_${levelName}`;
  const textureSetName = `${safeNamePrefix}TerrainMaterialTextureSet`;
  materialDefs[textureSetName] = {
    name: textureSetName,
    class: 'TerrainMaterialTextureSet',
    persistentId: crypto.randomUUID(),
    baseTexSize:   [baseSize, baseSize],
    detailTexSize: [DETAIL_SIZE, DETAIL_SIZE],
    macroTexSize:  [DETAIL_SIZE, DETAIL_SIZE],
  };

  const satellitePath = `/levels/${levelName}/art/terrains/terrain.png`;
  const p = (f) => `/levels/${levelName}/art/terrains/${f}`;

  // Shared neutral base textures (AO = white, normal = flat, roughness = neutral).
  // Generated at baseSize to match TextureSet.baseTexSize. Only one set shared
  // by all materials, so memory cost is 3 canvases instead of 3×N.
  const sharedAo = await makeAoBlob(baseSize);
  const sharedNm = await makeNormalBlob(0, baseSize);
  const sharedR  = await makeRoughnessBlob(180, 0, baseSize);
  const [sharedAoSm, sharedNmSm, sharedRSm] = await Promise.all([
    makeAoBlob(DETAIL_SIZE),
    makeNormalBlob(0, DETAIL_SIZE),
    makeRoughnessBlob(180, 0, DETAIL_SIZE),
  ]);
  textureFiles.push(
    { path: 'shared_ao.png',    blob: sharedAo },
    { path: 'shared_nm.png',    blob: sharedNm },
    { path: 'shared_r.png',     blob: sharedR },
    { path: 'shared_ao_sm.png', blob: sharedAoSm },
    { path: 'shared_nm_sm.png', blob: sharedNmSm },
    { path: 'shared_r_sm.png',  blob: sharedRSm },
  );

  // Helper: neutral slot fields used by DefaultMaterial and as fallbacks.
  function neutralSlots() {
    return {
      baseColorDetailTex:      p('shared_r_sm.png'), baseColorDetailStrength: [0, 0],
      baseColorMacroTex:       p('shared_r_sm.png'), baseColorMacroStrength:  [0, 0],
      normalBaseTex:           p('shared_nm.png'),   normalBaseTexSize:        baseSize,
      normalDetailTex:         p('shared_nm_sm.png'), normalDetailStrength:    [0, 0],
      normalMacroTex:          p('shared_nm_sm.png'), normalMacroStrength:     [0, 0],
      roughnessBaseTex:        p('shared_r.png'),    roughnessBaseTexSize:     baseSize,
      roughnessDetailTex:      p('shared_r_sm.png'), roughnessDetailStrength: [0, 0],
      roughnessMacroTex:       p('shared_r_sm.png'), roughnessMacroStrength:  [0, 0],
      aoBaseTex:               p('shared_ao.png'),   aoBaseTexSize:            baseSize,
      aoDetailTex:             p('shared_ao_sm.png'),
      aoMacroTex:              p('shared_ao_sm.png'),
      heightBaseTex:           p('shared_r.png'),    heightBaseTexSize:        baseSize,
      heightDetailTex:         p('shared_r_sm.png'),
      heightMacroTex:          p('shared_r_sm.png'),
    };
  }

  // DefaultMaterial: satellite base, neutral for all other channels.
  const defaultUuid = crypto.randomUUID();
  const defaultKey  = `DefaultMaterial-${defaultUuid}`;
  materialDefs[defaultKey] = {
    name: defaultKey,
    class: 'TerrainMaterial',
    persistentId: defaultUuid,
    internalName: 'DefaultMaterial',
    groundmodelName: 'GROUNDMODEL_ASPHALT1',
    baseColorBaseTex: satellitePath,
    baseColorBaseTexSize: baseSize,
    diffuseSize: baseSize,
    ...neutralSlots(),
  };

  // Clone real BeamNG terrain materials and repoint only the base slots to this
  // exported level's terrain base, following the Terrain Material Editor flow.
  for (const refMaterial of referenceMaterials) {
    const uuid = crypto.randomUUID();
    const key = `${refMaterial.internalName}-${uuid}`;
    const materialDef = cloneMaterialTemplate(refMaterial.template);
    materialDef.name = key;
    materialDef.persistentId = uuid;
    materialDef.internalName = refMaterial.internalName;
    materialDef.baseColorBaseTex = satellitePath;
    materialDef.baseColorBaseTexSize = baseSize;
    materialDef.diffuseSize = baseSize;
    materialDef.aoBaseTex = p('shared_ao.png');
    materialDef.aoBaseTexSize = baseSize;
    materialDef.normalBaseTex = p('shared_nm.png');
    materialDef.normalBaseTexSize = baseSize;
    materialDef.roughnessBaseTex = p('shared_r.png');
    materialDef.roughnessBaseTexSize = baseSize;
    materialDef.heightBaseTex = p('shared_r.png');
    materialDef.heightBaseTexSize = baseSize;
    materialDefs[key] = materialDef;
  }

  return { layerMap, materialNames: MATERIAL_NAMES, materialDefs, textureFiles, textureSetName };
}
