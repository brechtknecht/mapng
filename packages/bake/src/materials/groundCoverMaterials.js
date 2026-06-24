/** @layer core */
// Static BeamNG terrain/groundcover material data (refactor doc 06 step 10).
// Pure data tables drained verbatim from beamngFlavorCatalog.js — no logic.

export const DEFAULT_TERRAIN_CANDIDATES = {
  Grass: ['Grass', 'Grass2', 'Grass3', 'Grass4', 'dirt_grass'],
  Dirt: ['Dirt', 'dirt_loose', 'dirt_grass', 'RockyDirt', 'dirt_loose_dusty'],
  BeachSand: ['BeachSand', 'sand', 'dirt_sandy'],
  ROCK: ['ROCK', 'Rock', 'Rock_cliff', 'dirt_rocky', 'dirt_rocky_large', 'rockydirt', 'rocks_large'],
  asphalt: ['asphalt', 'asphalt2', 'groundmodel_asphalt1', 'GROUNDMODEL_ASPHALT1'],
  GRAVEL: ['GRAVEL', 'gravel_wet', 'dirt_rocky_large'],
  Concrete: ['Concrete'],
};

export const ITALY_GROUNDCOVER_MATERIAL = {
  name: 'GrassMiddle',
  mapTo: 'unmapped_mat',
  class: 'Material',
  persistentId: 'c6552e8a-3784-44da-998b-3dca87552aca',
  Stages: [{
    colorMap: 'levels/italy/art/shapes/groundcover/Grass_Middle_d.dds',
    diffuseColor: [0.996078491, 0.996078491, 0.996078491, 1],
    normalMap: '/levels/italy/art/shapes/groundcover/Grass_green_n.normal.png',
    roughnessFactor: 0.481729716,
    specular: [0.992156923, 0.992156923, 0.992156923, 1],
    specularMap: '/levels/italy/art/shapes/groundcover/Grass_green_s.color.png',
    useAnisotropic: true,
  }, {}, {}, {}],
  alphaRef: 95,
  alphaTest: true,
  annotation: 'NATURE',
  doubleSided: true,
  groundType: 'GRASS',
  materialTag0: 'beamng',
  materialTag1: 'vegetation',
  translucentBlendOp: 'None',
};

export const UTAH_GROUNDCOVER_MATERIAL = {
  name: 'dry_grass',
  mapTo: 'unmapped_mat',
  class: 'Material',
  persistentId: 'a269c30f-2863-4077-907b-5bfba1dc1f2f',
  Stages: [{
    colorMap: 'levels/Utah/art/shapes/groundcover/dry_grass_d.dds',
    diffuseColor: [0.905882418, 0.905882418, 0.905882418, 1],
    normalMap: 'levels/Utah/art/shapes/groundcover/dry_grass_n.dds',
    specular: [0.988235354, 0.988235354, 0.988235354, 1],
    specularMap: 'levels/Utah/art/shapes/groundcover/dry_grass_s.dds',
    useAnisotropic: true,
  }, {}, {}, {}],
  alphaRef: 60,
  alphaTest: true,
  annotation: 'GRASS',
  doubleSided: true,
  groundType: 'GRASS',
  materialTag0: 'beamng',
  materialTag1: 'vegetation',
  materialTag2: 'vegetation',
  materialTag3: 'Natural',
  translucentBlendOp: 'None',
};

export const EAST_COAST_GROUNDCOVER_MATERIAL = {
  name: 'BNGGrass',
  mapTo: 'unmapped_mat',
  class: 'Material',
  persistentId: 'b2d38e39-359b-4603-b334-a3263a4bcc57',
  Stages: [{
    colorMap: '/levels/east_coast_usa/art/shapes/groundcover/t_grass_01_d.color.png',
    diffuseColor: [0.996078491, 0.996078491, 0.996078491, 1],
    normalMap: '/levels/east_coast_usa/art/shapes/groundcover/t_grass_01_nm.normal.png',
    specular: [0.992156923, 0.992156923, 0.992156923, 1],
    specularMap: '/levels/east_coast_usa/art/shapes/groundcover/t_grass_01_s.color.png',
    useAnisotropic: true,
  }, {}, {}, {}],
  alphaRef: 60,
  alphaTest: true,
  annotation: 'NATURE',
  doubleSided: true,
  materialTag0: 'beamng',
  materialTag1: 'vegetation',
  materialTag2: 'vegetation',
  materialTag3: 'Natural',
  materialTag4: 'east_coast_usa',
  translucentBlendOp: 'None',
};

export const JOHNSON_VALLEY_GROUNDCOVER_MATERIAL = {
  name: 'dry_grass',
  mapTo: 'dry_grass',
  class: 'Material',
  persistentId: 'a58a2f27-8d2f-4556-bbc0-f7e2b2672bd5',
  Stages: [{
    colorMap: 'levels/johnson_valley/art/shapes/groundcover/dry_grass_d.color.png',
    detailNormalMapStrength: 0.5,
    detailScale: [1, 1],
    diffuseColor: [0.905882418, 0.905882418, 0.905882418, 1],
    normalMap: '/levels/johnson_valley/art/shapes/groundcover/dry_grass_n.normal.png',
    specular: [0.992156923, 0.992156923, 0.992156923, 1],
    specularMap: '/levels/johnson_valley/art/shapes/groundcover/dry_grass_s2.color.png',
    useAnisotropic: true,
  }, {}, {}, {}],
  alphaRef: 59,
  alphaTest: true,
  annotation: 'GRASS',
  doubleSided: true,
  groundType: 'GRASS',
  materialTag0: 'beamng',
  materialTag1: 'vegetation',
  translucentBlendOp: 'None',
};

export const JUNGLE_GROUNDCOVER_MATERIAL = {
  name: 'BNG_Grass_03',
  mapTo: 'unmapped_mat',
  class: 'Material',
  persistentId: 'b9a7716f-de7f-4df0-80bf-979ca74d043c',
  Stages: [{
    colorMap: 'levels/jungle_rock_island/art/shapes/groundcover/Grass03_tropical_d.dds',
    specularPower: 1,
  }, {}, {}, {}],
  alphaRef: 107,
  alphaTest: true,
  doubleSided: true,
  materialTag0: 'beamng',
  materialTag1: 'vegetation',
  materialTag2: 'vegetation',
};
