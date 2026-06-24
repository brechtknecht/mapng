/** @layer core */
// OSM feature → fill-colour classification for the texture painter (refactor doc
// 06 step 6). Pure: tags in, colour string out. Moved verbatim from osmTexture.js.

// Colors aligned to OSM Carto style definitions
// Source: https://github.com/gravitystorm/openstreetmap-carto (landcover.mss / water.mss)
// All surface/landuse colors darkened 40% vs OSM Carto defaults (×0.60) to reduce glare.
export const COLORS = {
  // Vegetation / greens (OSM Carto)
  forest: "#687d5f",
  scrub: "#788167",
  heath: "#80825f",
  grass: "#7b8d6a",
  orchard: "#688662",
  farmland: "#8f9080",

  // Water / wetness (OSM Carto)
  water: "#667f86",
  wetland: "#7b8d6a",
  swamp: "#687d5f",
  glacier: "#858e8e",
  mud: "#8a847d",

  // Bare / earth (OSM Carto)
  bare: "#8f8984",
  sand: "#938c77",
  dirt: "#77776c",
  quarry: "#767575",

  // Developed / landuse (OSM Carto)
  residential: "#868686",
  commercial: "#8c8985",
  industrial: "#807d79",
  retail: "#9a9691",
  education: "#999989",
  military: "#928885",
  cemetery: "#667a69",
  sport: "#528672",
  recreation: "#859473",
  park: "#78967a",
  parking: "#8e8b87",
  aeroway: "#8c8b88",
  apron: "#838386",
  runway: "#6f6f6f",
  power: "#867d85",
  tourism: "#660033",
  hospital: "#999989",

  // Water / Aquatic features
  swimming_pool: "#667f86",
  marina: "#7f7b76", // Warm beige-gray marina/harbor fill
  harbourLand: "#8d838b",
  fountain: "#667f86",

  // Vegetated / Garden
  allotments: "#798773",
  flowerbed: "#7b8d6a",
  hedge: "#687d5f",

  // Hard surfaces (paving)
  cobblestone: "#545454", // Cobblestone / sett (dark grey)
  tiles: "#6e6e6e", // Paving stones / tiles (lighter grey)

  // Defaults
  building: "#827d79",
  buildingStroke: "#766d67",
  road: "#404040",
  path: "#7a7a7a",
  track: "#73685a", // Light brown dirt color
  sidewalk: "#e3e1db", // Bright off-white concrete color
  barrier: "#76624f",
  bridgeInfra: "#56585c",
  coastline: "#5f7680",
  ocean: "#667f86",
  defaultLanduse: "#858585",

  // Markings
  markingWhite: "rgba(255, 255, 255, 0.7)",
  markingYellow: "rgba(255, 204, 0, 0.8)",
  markingRed: "rgba(255, 50, 50, 0.8)",
};

const hasExplicitGroundCover = (tags) => {
  if (!tags) return false;
  return !!(
    tags.surface ||
    tags.material ||
    tags.landcover ||
    tags.landuse ||
    tags.natural ||
    tags.water ||
    tags.wetland ||
    tags.waterway ||
    tags.aeroway
  );
};

export const isBoundaryOnlyArea = (tags) => {
  if (!tags || !tags.boundary) return false;

  const boundaryType = String(tags.boundary).toLowerCase();
  const isBoundaryLike = [
    "administrative",
    "protected_area",
    "national_park",
    "political",
    "historic",
  ].includes(boundaryType);
  if (!isBoundaryLike) return false;

  return !hasExplicitGroundCover(tags);
};

export const getFeatureColor = (tags, baseColor = COLORS.defaultLanduse) => {
  if (!tags) return baseColor;
  if (isBoundaryOnlyArea(tags)) return baseColor;

  const isMarinaOrHarbor =
    tags.leisure === "marina" ||
    tags.water === "harbour" ||
    tags.water === "dock" ||
    tags.harbour === "yes" ||
    tags["seamark:type"] === "harbour" ||
    tags["seamark:type"] === "harbour_basin" ||
    tags["seamark:harbour:category"] === "marina";
  if (tags.landuse === "harbour") return COLORS.harbourLand;
  if (isMarinaOrHarbor) return COLORS.marina;

  // --- OSM2World inspired surface mapping ---
  // Priority 1: Water
  if (
    tags.natural === "water" ||
    tags.waterway ||
    tags.landuse === "reservoir" ||
    tags.landuse === "basin" ||
    tags.water
  )
    return tags.source === "coastline" ? COLORS.ocean : COLORS.water;
  if (tags.natural === "coastline") return COLORS.coastline;
  if (tags.natural === "wetland" || tags.wetland) {
    const type = tags.wetland;
    if (type === "swamp") return COLORS.forest;
    if (type === "mangrove") return COLORS.scrub;
    if (type === "bog" || type === "fen" || type === "string_bog")
      return COLORS.heath;
    if (type === "marsh" || type === "reedbed" || type === "wet_meadow")
      return COLORS.grass;
    return COLORS.wetland;
  }
  if (tags.natural === "glacier") return COLORS.glacier;

  // Priority 2: Specific High-Level Categories
  if (tags.aeroway) {
    if (["runway", "taxiway"].includes(tags.aeroway)) return COLORS.runway;
    if (tags.aeroway === "apron") return COLORS.apron;
    return COLORS.aeroway;
  }

  if (tags.amenity === "parking") return COLORS.parking;
  if (
    tags.amenity === "school" ||
    tags.amenity === "university" ||
    tags.amenity === "college" ||
    tags.amenity === "kindergarten"
  )
    return COLORS.education;
  if (tags.amenity === "hospital" || tags.amenity === "clinic")
    return COLORS.hospital;

  // Aquatic leisure / amenity
  if (tags.leisure === "swimming_pool") return COLORS.swimming_pool;
  if (tags.leisure === "water_park") return COLORS.swimming_pool;
  if (
    tags.leisure === "marina" ||
    tags.water === "harbour" ||
    tags.water === "dock" ||
    tags.harbour === "yes" ||
    tags["seamark:type"] === "harbour" ||
    tags["seamark:type"] === "harbour_basin" ||
    tags["seamark:harbour:category"] === "marina"
  )
    return COLORS.marina;
  if (tags.amenity === "fountain") return COLORS.fountain;

  // Cemetery variant tags
  if (tags.amenity === "grave_yard") return COLORS.cemetery;

  // Barriers that cover area
  if (tags.barrier === "hedge") return COLORS.hedge;
  if (tags.natural === "shrubbery") return COLORS.hedge;

  if (tags.power === "plant" || tags.power === "substation")
    return COLORS.power;
  if (
    tags.man_made === "pier" ||
    tags.man_made === "breakwater" ||
    tags.man_made === "groyne"
  )
    return COLORS.bare;
  if (tags.man_made === "bridge") return COLORS.bridgeInfra;

  // Priority 3: Surface / Landuse / Leisure generic mapping
  const surface =
    tags.surface ||
    tags.material ||
    tags.landcover ||
    tags.landuse ||
    tags.natural ||
    tags.leisure ||
    tags.golf ||
    tags.recreation ||
    tags.tourism;

  if (["forest", "wood", "trees", "tree_row"].includes(surface))
    return COLORS.forest;
  if (
    [
      "grass",
      "meadow",
      "grassland",
      "fell",
      "park",
      "village_green",
      "garden",
      "recreation_ground",
      "common",
      "dog_park",
      "greenfield",
      "miniature_golf", // leisure=miniature_golf → grassy
      "fitness_centre",
      "fitness_station",
    ].includes(surface)
  )
    return COLORS.grass;
  if (["scrub", "heath", "tundra", "shrubbery", "bushes"].includes(surface))
    return COLORS.scrub;
  if (["orchard", "vineyard", "plant_nursery"].includes(surface))
    return COLORS.orchard;
  if (["farmland", "farmyard", "greenhouse_horticulture"].includes(surface))
    return COLORS.farmland;
  if (["allotments"].includes(surface)) return COLORS.allotments;
  if (["flowerbed"].includes(surface)) return COLORS.flowerbed;

  // Water / aquatic areas
  if (
    [
      "swimming_pool",
      "water_park",
      "salt_pond",
      "aquaculture",
      "harbour",
    ].includes(surface)
  )
    return COLORS.swimming_pool;
  if (["marina"].includes(surface)) return COLORS.marina;

  if (["sand", "beach", "shoal", "dune", "coastline", "beach_resort", "bathing_place"].includes(surface))
    return COLORS.sand;
  if (["bare_rock", "rock", "scree", "shingle", "shells", "marble"].includes(surface))
    return COLORS.bare;
  if (["glacier", "snow"].includes(surface)) return COLORS.glacier;
  if (
    [
      "mud", "ground", "dirt", "earth", "construction", "brownfield",
      "landfill", // landuse=landfill
      "wood",     // surface=wood (wooden decks etc)
      "woodchips", // surface=woodchips
    ].includes(surface)
  )
    return COLORS.dirt;

  // Hard paved surfaces
  if (
    [
      "cobblestone", "sett", "unhewn_cobblestone",
    ].includes(surface)
  )
    return COLORS.cobblestone;
  if (
    [
      "paving_stones", "concrete:plates", "tiles",
    ].includes(surface)
  )
    return COLORS.tiles;
  if (["fine_gravel", "compacted"].includes(surface)) return COLORS.quarry;

  if (["residential"].includes(surface)) return COLORS.residential;
  if (["commercial"].includes(surface)) return COLORS.commercial;
  if (["retail"].includes(surface)) return COLORS.retail;
  if (["industrial", "quarry", "railway", "garages", "depot"].includes(surface))
    return COLORS.industrial;
  if (["military"].includes(surface)) return COLORS.military;
  if (["cemetery"].includes(surface)) return COLORS.cemetery;
  if (
    [
      "pitch",
      "track",
      "stadium",
      "golf_course",
      "fairway",
      "green",
      "tee",
      "bunker",
      "playground",
      "sports_centre",
      "ice_rink",
      "horse_riding",
      "bowling_alley",
      "disc_golf_course",
      "shooting_range",
    ].includes(surface)
  )
    return COLORS.sport;
  if (["recreation", "recreation_ground"].includes(surface))
    return COLORS.recreation;
  if (["camp_site"].includes(surface)) return COLORS.park;
  if (["attraction", "zoo", "camp_site", "theme_park"].includes(surface))
    return COLORS.tourism;

  return baseColor;
};

// Help map tags to user-friendly categories (simplified for internal use)
export const getFeatureCategory = (feature) => {
  return feature.type;
};
