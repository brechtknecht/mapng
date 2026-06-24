// Headless golden-hash oracle for the pure-compute batch modules extracted from
// batchJob.js (refactor 11). grid.js / schedulerConfig.js / batchState.js /
// batchReport.js emit plain JS objects/strings (tile layout, scheduler config,
// job state, the elevation report text) — no DOM/canvas/renderer/network — so
// they run in Node directly. We hash a canonical JSON/string serialization of
// each module's output against a fixed fixture and pin it: a verbatim move keeps
// the bytes identical; any behavioural drift (field order, rounding, default
// change, status mapping) flips the hash.
//
// Coverage note (no silent caps): this oracle covers the CORE/pure path. The io
// modules (statePersistence, memorySampling, tileSnapshot, batchDownloads,
// compositeHeightmap) and the flow modules (processTile, batchRun) are NOT
// exercised here — processTile imports the export3d barrel, which builds a
// WebGLRenderer at module eval and cannot be imported in Node. They rely on the
// verbatim move + the Vite build + a real in-app grid batch run.
//
// buildTileMetadata is intentionally NOT pinned: it embeds getBuildTrace() +
// buildCommonTraceMetadata() output, which carry build/version/timestamp fields.
// buildBatchElevationReportText IS pinned, with its non-deterministic
// "Generated:" line stripped before hashing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  computeGridTiles,
  computeGridTilesWithOffsets,
  computeGridBounds,
  normalizeTileNames,
  normalizeTileOffsets,
  getDefaultTileLabel,
  getTileLabel,
  sanitizeFilenamePart,
} from '@mapng/batch/grid';
import {
  deriveSchedulerConfig,
  normalizeExportFlags,
  mapLegacyJobStatus,
  mapLegacyTileStatus,
} from '@mapng/batch/schedulerConfig';
import { createBatchJobState, migrateLoadedState } from '@mapng/batch/batchState';
import { buildBatchElevationReportText } from '@mapng/batch/batchReport';

const h = (o) => createHash('sha256').update(typeof o === 'string' ? o : JSON.stringify(o)).digest('hex').slice(0, 16);

const CENTER = { lat: 47.3769, lng: 8.5417 };

const baseConfig = () => ({
  center: CENTER,
  resolution: 1024,
  gridCols: 3,
  gridRows: 2,
  exports: { heightmap: true, glb: true, dae: false },
  includeOSM: true,
  elevationSource: 'usgs',
  gpxzApiKey: '',
  glbMeshResolution: 512,
  performanceProfile: 'balanced',
  tileOffsets: [{ index: 1, offsetX: 25, offsetY: -10 }],
  tileNames: [{ index: 0, name: 'Downtown' }],
  elevationNormalization: { enabled: true },
});

test('grid: pure tile layout + labels are stable', () => {
  const out = {
    tiles: computeGridTiles(CENTER, 1024, 3, 2),
    offsetTiles: computeGridTilesWithOffsets(CENTER, 1024, 3, 2, [
      { index: 1, offsetX: 25, offsetY: -10 },
      { index: 4, offsetX: -5, offsetY: 12 },
    ]),
    bounds: computeGridBounds(CENTER, 1024, 3, 2),
    names: normalizeTileNames([{ index: 0, name: 'Foo' }, { index: 9, name: 'OOB' }, { index: 2, name: 'R1C3' }], 6, 3),
    offsets: normalizeTileOffsets([{ index: 2, offsetX: '3', offsetY: 4 }, { index: 99, offsetX: 1 }], 6),
    defaultLabels: [getDefaultTileLabel(0, 3), getDefaultTileLabel(5, 3), getDefaultTileLabel({ row: 1, col: 2 })],
    tileLabels: [getTileLabel({ label: 'A' }), getTileLabel({ row: 0, col: 0 }, 3)],
    sanitized: ['a b/c.d', '  ***  ', ''].map(sanitizeFilenamePart),
  };
  assert.equal(h(out), '2721c541aba158b3');
});

test('schedulerConfig: profile derivation + flag/status normalization are stable', () => {
  const out = {
    balanced: deriveSchedulerConfig({ resolution: 1024, exports: {}, includeOSM: false }),
    throughput8k: deriveSchedulerConfig({ resolution: 8192, performanceProfile: 'throughput' }),
    lowmem4k: deriveSchedulerConfig({ resolution: 4096, performanceProfile: 'low_memory' }),
    highres: deriveSchedulerConfig({ resolution: 8192, exports: { glb: true }, includeOSM: true }),
    veryHighRes: deriveSchedulerConfig({ resolution: 4096 }),
    flagsNested: normalizeExportFlags({ value: { value: { glb: true, heightmap: false } }, satellite: true }),
    jobStatus: ['idle', 'running', 'paused', 'completed', 'completed_with_errors', 'weird'].map(mapLegacyJobStatus),
    tileStatus: ['pending', 'processing', 'completed', 'weird'].map(mapLegacyTileStatus),
  };
  assert.equal(h(out), '79270ee927d7455e');
});

test('batchState: createBatchJobState is deterministic', () => {
  const state = createBatchJobState(baseConfig());
  assert.equal(h(state), '7b2c63e03c1ec047');
});

test('batchState: migrateLoadedState forwards a legacy state', () => {
  const legacy = {
    status: 'running',
    gridCols: 2,
    gridRows: 1,
    includeOSM: 'yes',
    exports: { heightmap: true },
    tiles: [
      { index: 0, status: 'pending', customName: 'Old' },
      { index: 1, status: 'completed' },
    ],
    tileNames: [{ index: 0, name: 'Old' }],
    performanceProfile: 'nonsense',
  };
  assert.equal(h(migrateLoadedState(legacy)), '3d3eb4f8aff0ed3a');
});

test('batchReport: elevation report text is stable (Generated line stripped)', () => {
  const state = createBatchJobState(baseConfig());
  // Two completed tiles with stats + one failed, to exercise aggregates + failure section.
  state.elevationNormalization.globalMinHeight = 400;
  state.elevationNormalization.globalMaxHeight = 600;
  state.tiles[0].status = 'done';
  state.tiles[0].elevationStats = {
    localMinHeight: 410, localMaxHeight: 590, localRange: 180,
    encodedMinHeight: 400, encodedMaxHeight: 600, encodedRange: 200,
    deltaMinToEncoded: 10, deltaMaxToEncoded: 10, extraEncodedRange: 20,
  };
  state.tiles[1].status = 'done';
  state.tiles[1].elevationStats = {
    localMinHeight: 420, localMaxHeight: 580, localRange: 160,
    encodedMinHeight: 400, encodedMaxHeight: 600, encodedRange: 200,
    deltaMinToEncoded: 20, deltaMaxToEncoded: 20, extraEncodedRange: 40,
  };
  state.tiles[2].status = 'failed';
  state.tiles[2].lastError = { message: 'boom' };
  const text = buildBatchElevationReportText(state)
    .split('\n')
    .filter((line) => !line.startsWith('Generated:'))
    .join('\n');
  assert.equal(h(text), '21ffdcd6ff948c67');
});
