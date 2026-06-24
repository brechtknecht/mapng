/** @layer io */
// Managed-forest + groundcover generation: template cloning, deterministic
// point/area placement sampling for trees/bushes/rocks, NDJSON file
// serialization, and GroundCover object emission. Pure compute, but tagged
// `io` because it depends on the io-layer flavor catalog (managed-forest /
// rock / groundcover selectors) — a core file may not import it. (Those
// selectors are pure lookups, so these builders still run headless.)
// Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import {
  getManagedForestTemplate,
  resolveTreeTypeForTags,
  resolveBushType,
  getRockCandidates,
  getGroundCoverProfile,
} from '../beamngFlavorCatalog.js';
import { roundTo } from './format.js';
import {
  geoToWorldPoint,
  seededRandom,
  rotationMatrixFromYaw,
  isClosedRing,
  pointInPolygonLatLng,
  hashString,
  generatePersistentId,
  getTerrainHeightWorld,
} from './worldMath.js';
import { toNDJSON } from './levelZip.js';

/**
 * Clone managed forest templates by item name and assign fresh persistentIds.
 */
export function cloneManagedItemData(itemNames, flavor) {
  const out = {};
  for (const itemName of itemNames) {
    const template = getManagedForestTemplate(flavor, itemName);
    if (!template) continue;
    out[itemName] = {
      ...structuredClone(template),
      persistentId: generatePersistentId(),
    };
  }
  return out;
}

/**
 * Build one managed-forest placement record at a geographic point.
 */
export function makeForestPlacement(type, point, terrainData, squareSize, seed, scaleMin, scaleMax) {
  const [x, y, z] = geoToWorldPoint(point.lat, point.lng, terrainData, squareSize, 0);
  const yaw = seededRandom(seed + 17) * Math.PI * 2;
  const scale = scaleMin + (scaleMax - scaleMin) * seededRandom(seed + 29);
  return {
    ctxid: 0,
    pos: [roundTo(x, 3), roundTo(y, 3), roundTo(z, 3)],
    rotationMatrix: rotationMatrixFromYaw(yaw),
    scale: roundTo(scale, 6),
    type,
  };
}

const BEAMNG_TREE_DENSITY_MULTIPLIER = 2.5;
const BEAMNG_GRASS_DENSITY_MULTIPLIER = 2.0;
const BEAMNG_MAX_FOREST_PLACEMENTS_PER_TYPE = 12000;
const BEAMNG_MAX_GROUNDCOVER_ELEMENTS = 150000;

/**
 * Randomly jitter a lat/lng point by up to N meters using deterministic seed.
 */
export function jitterLatLngByMeters(point, meters, seed) {
  if (!meters || meters <= 0) return point;
  const metersPerDegLat = 111320;
  const cosLat = Math.max(0.2, Math.cos((point.lat * Math.PI) / 180));
  const metersPerDegLng = 111320 * cosLat;
  const angle = seededRandom(seed + 0.17) * Math.PI * 2;
  const radius = seededRandom(seed + 0.31) * meters;
  const dLat = (Math.sin(angle) * radius) / metersPerDegLat;
  const dLng = (Math.cos(angle) * radius) / metersPerDegLng;
  return {
    lat: point.lat + dLat,
    lng: point.lng + dLng,
  };
}

/**
 * Sample pseudo-random placements inside a polygon feature with hole support.
 */
export function sampleAreaPlacements(feature, terrainData, squareSize, itemType, densityPerSqM, maxCount, scaleMin, scaleMax, baseSeed) {
  if (!Array.isArray(feature.geometry) || feature.geometry.length < 3) return [];
  const ring = isClosedRing(feature.geometry) ? feature.geometry.slice(0, -1) : feature.geometry;
  if (ring.length < 3) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const pt of ring) {
    minLat = Math.min(minLat, pt.lat);
    maxLat = Math.max(maxLat, pt.lat);
    minLng = Math.min(minLng, pt.lng);
    maxLng = Math.max(maxLng, pt.lng);
  }
  const centerLat = (minLat + maxLat) * 0.5;
  const metersPerDegLng = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const widthM = Math.max(1, (maxLng - minLng) * metersPerDegLng);
  const heightM = Math.max(1, (maxLat - minLat) * 111320);
  const count = Math.min(maxCount, Math.max(0, Math.floor(widthM * heightM * densityPerSqM)));
  const placements = [];
  for (let i = 0; i < count; i++) {
    const seed = baseSeed + i * 13.37;
    const lat = minLat + (maxLat - minLat) * seededRandom(seed + 1);
    const lng = minLng + (maxLng - minLng) * seededRandom(seed + 2);
    const pt = { lat, lng };
    if (!pointInPolygonLatLng(pt, ring)) continue;
    let inHole = false;
    for (const hole of feature.holes || []) {
      if (pointInPolygonLatLng(pt, hole)) {
        inHole = true;
        break;
      }
    }
    if (inHole) continue;
    placements.push(makeForestPlacement(itemType, pt, terrainData, squareSize, seed, scaleMin, scaleMax));
  }
  return placements;
}

/**
 * Build grouped BeamNG forest placements for trees, bushes, and optional rocks.
 *
 * Returns Map<managedForestType, placement[]>.
 */
export function buildForestPlacements(terrainData, squareSize, { includeTrees, includeRocks }, flavor) {
  const regularPlacementsByType = new Map();
  const priorityPlacementsByType = new Map();
  const treeDensityMultiplier = BEAMNG_TREE_DENSITY_MULTIPLIER;
  const bushDensityMultiplier = BEAMNG_TREE_DENSITY_MULTIPLIER;
  /**
   * Add a forest placement to priority or regular buckets with hard caps.
   */
  const pushPlacement = (placement, { priority = false } = {}) => {
    if (!getManagedForestTemplate(flavor, placement.type)) return;
    const target = priority ? priorityPlacementsByType : regularPlacementsByType;
    if (!target.has(placement.type)) target.set(placement.type, []);
    const list = target.get(placement.type);
    if (list.length >= BEAMNG_MAX_FOREST_PLACEMENTS_PER_TYPE) return;
    list.push(placement);
  };

  if (includeTrees) {
    for (const feature of terrainData.osmFeatures || []) {
      if (feature.type === 'vegetation' && feature.geometry?.length === 1) {
        const seed = hashString(`${feature.id}:${feature.geometry[0].lat}:${feature.geometry[0].lng}`);
        const point = feature.geometry[0];
        const itemType = resolveTreeTypeForTags(flavor, feature.tags || {});
        const isBush = feature.tags?.natural === 'shrub';
        const isTreeRow =
          feature.tags?.natural === 'tree_row' ||
          feature.tags?.tree_row === 'yes' ||
          feature.tags?.source_feature === 'tree_row';
        const resolvedType = isBush ? resolveBushType(flavor) : itemType;
        if (!resolvedType) continue;
        const pointCopies = isTreeRow
          ? 1
          : isBush
            ? Math.max(1, Math.round(bushDensityMultiplier))
            : Math.max(1, Math.round(treeDensityMultiplier));
        const jitterMeters = isBush ? 2.2 : 5.5;
        for (let i = 0; i < pointCopies; i++) {
          const cloneSeed = seed + i * 97.13;
          const sampledPoint = i === 0 ? point : jitterLatLngByMeters(point, jitterMeters, cloneSeed);
          pushPlacement(makeForestPlacement(
            resolvedType,
            sampledPoint,
            terrainData,
            squareSize,
            cloneSeed,
            isBush ? 0.7 : 0.85,
            isBush ? 1.2 : 1.2,
          ), { priority: isTreeRow });
        }
      }
      if (feature.type === 'landuse') {
        const tags = feature.tags || {};
        const isTreeArea =
          tags.natural === 'wood' ||
          tags.natural === 'forest' ||
          tags.landuse === 'forest' ||
          tags.landuse === 'orchard' ||
          tags.landcover === 'trees';
        if (isTreeArea) {
          const itemType = resolveTreeTypeForTags(flavor, tags);
          if (!itemType) continue;
          // Use polygon-driven sampling for BeamNG export so tree coverage
          // reflects full OSM vegetation areas, independent of 3D preview caps.
          const isOrchard = tags.landuse === 'orchard';
          const placements = sampleAreaPlacements(
            feature,
            terrainData,
            squareSize,
            itemType,
            (isOrchard ? 0.0028 : 0.0036) * treeDensityMultiplier,
            (isOrchard ? 1800 : 3600) * treeDensityMultiplier,
            isOrchard ? 0.9 : 0.85,
            isOrchard ? 1.1 : 1.25,
            hashString(`${feature.id}:tree_area`),
          );
          placements.forEach(pushPlacement);
        }

        const isBushArea =
          tags.natural === 'scrub' ||
          tags.natural === 'heath' ||
          tags.natural === 'shrubbery' ||
          tags.landcover === 'scrub';
        if (isBushArea) {
          const itemType = resolveBushType(flavor, { hedge: tags.barrier === 'hedge' });
          if (!itemType) continue;
          const placements = sampleAreaPlacements(
            feature,
            terrainData,
            squareSize,
            itemType,
            0.004 * bushDensityMultiplier,
            400 * bushDensityMultiplier,
            0.75,
            1.2,
            hashString(feature.id),
          );
          placements.forEach(pushPlacement);
        }
      }
    }
  }

  if (includeRocks) {
    const rockTypes = getRockCandidates(flavor);
    for (const feature of terrainData.osmFeatures || []) {
      if (feature.type !== 'landuse') continue;
      const tags = feature.tags || {};
      const isRockArea =
        tags.landuse === 'quarry' ||
        tags.natural === 'bare_rock' ||
        tags.natural === 'rock' ||
        tags.natural === 'scree' ||
        tags.natural === 'shingle';
      if (!isRockArea) continue;
      if (!rockTypes.length) continue;
      const placements = sampleAreaPlacements(
        feature,
        terrainData,
        squareSize,
        rockTypes[hashString(feature.id) % rockTypes.length],
        0.0008,
        140,
        0.8,
        1.25,
        hashString(`${feature.id}:rocks`),
      );
      placements.forEach((placement, idx) => {
        placement.type = rockTypes[(hashString(`${feature.id}:${idx}`) % rockTypes.length)];
        pushPlacement(placement);
      });
    }
  }

  const placementsByType = new Map();
  const allTypes = new Set([
    ...priorityPlacementsByType.keys(),
    ...regularPlacementsByType.keys(),
  ]);

  for (const type of allTypes) {
    const priority = priorityPlacementsByType.get(type) || [];
    const regular = regularPlacementsByType.get(type) || [];
    const merged = [...priority, ...regular].slice(0, BEAMNG_MAX_FOREST_PLACEMENTS_PER_TYPE);
    if (merged.length > 0) placementsByType.set(type, merged);
  }

  return placementsByType;
}

/**
 * Serialize forest placement maps into export file descriptors.
 */
export function serializeForestFiles(placementsByType) {
  const files = [];
  for (const [type, placements] of placementsByType.entries()) {
    if (!placements.length) continue;
    files.push({
      path: `forest/${type}.forest4.json`,
      contents: toNDJSON(placements),
    });
  }
  return files;
}

/**
 * Build GroundCover objects used to render broad grass coverage in BeamNG.
 */
export function buildGroundCoverObjects(terrainData, squareSize, includeTrees, flavor) {
  if (!includeTrees) return [];
  const groundCover = getGroundCoverProfile(flavor);
  const grassClumpScale = Math.max(1, Math.sqrt(BEAMNG_GRASS_DENSITY_MULTIPLIER));
  const widthMeters = terrainData.width * squareSize;
  const heightMeters = terrainData.height * squareSize;
  const radius = Math.max(30, roundTo(Math.min(widthMeters, heightMeters) * 0.48, 3));
  const centerHeight = getTerrainHeightWorld(
    (terrainData.bounds.north + terrainData.bounds.south) * 0.5,
    (terrainData.bounds.east + terrainData.bounds.west) * 0.5,
    terrainData,
  );

  return [{
    __parent: 'vegetation',
    class: 'GroundCover',
    name: 'mapng_grass_cover',
    persistentId: generatePersistentId(),
    position: [0, 0, roundTo(centerHeight, 3)],
    material: groundCover.materialName,
    gridSize: Math.max(1, Math.round(3 / Math.sqrt(BEAMNG_GRASS_DENSITY_MULTIPLIER))),
    radius,
    dissolveRadius: Math.max(40, roundTo(radius * 0.6, 3)),
    shapeCullRadius: radius,
    maxBillboardTiltAngle: 40,
    maxElements: Math.min(
      BEAMNG_MAX_GROUNDCOVER_ELEMENTS,
      Math.max(
        180000,
        Math.round(((widthMeters * heightMeters) / 6) * BEAMNG_GRASS_DENSITY_MULTIPLIER),
      ),
    ),
    windGustLength: 1.7,
    windGustStrength: 0.2,
    windTurbulenceFrequency: 0.3,
    seed: 11,
    Types: [
      {
        billboardUVs: [0.496093988, 0, 0.503906012, 0.47656101],
        clumpRadius: 1.5,
        layer: groundCover.terrainLayer,
        maxClumpCount: Math.round(10 * grassClumpScale),
        minClumpCount: Math.round(4 * grassClumpScale),
        probability: 1,
        sizeMax: 0.7,
        sizeMin: 0.42,
        windScale: 0.2,
      },
      {
        billboardUVs: [0, 0, 0.507812023, 0.488281012],
        layer: groundCover.terrainLayer,
        maxClumpCount: Math.round(8 * grassClumpScale),
        minClumpCount: Math.round(3 * grassClumpScale),
        probability: 0.7,
        sizeMax: 0.65,
        sizeMin: 0.38,
        windScale: 0.2,
      },
      {
        billboardUVs: [0, 0.50781101, 0.5, 0.49218899],
        layer: groundCover.terrainLayer,
        maxClumpCount: Math.round(7 * grassClumpScale),
        minClumpCount: Math.round(3 * grassClumpScale),
        probability: 0.55,
        sizeMax: 0.58,
        sizeMin: 0.34,
        windScale: 0.2,
      },
      {
        billboardUVs: [0.5, 0.503906012, 0.5, 0.496093988],
        clumpRadius: 0.35,
        layer: groundCover.terrainLayer,
        maxClumpCount: Math.round(8 * grassClumpScale),
        minClumpCount: Math.round(3 * grassClumpScale),
        probability: 0.45,
        sizeMax: 0.52,
        sizeMin: 0.32,
        windScale: 0.2,
      },
      {}, {}, {}, {},
    ],
  }];
}
