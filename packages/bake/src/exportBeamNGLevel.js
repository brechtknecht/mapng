/** @layer flow */
// BeamNG level export orchestrator. Two phases live in ./beamng/*: the io/
// renderer-bound compute (buildLevelArtifacts — terrain, roads, water, barriers,
// forest, DAE/GLB assets, the diagnostics report) and the pure-core archive
// serializer (writeLevelEntries — the BeamNG level directory tree). This file
// wires them: build the artifact ctx, record it into a virtual zip, and
// compress (Node sidecar when available, in-browser JSZip fallback). Consumers:
// components/panels/ExportPanel.vue, packages/route exportRouteLevel.js.
import JSZip from 'jszip';
import { zipSidecarAvailable, compressZipViaSidecar, isServerPathEntry } from './zipExportSidecar.js';
import { buildLevelArtifacts } from './beamng/levelArtifacts.js';
import { writeLevelEntries } from './beamng/levelArchive.js';

const BEAMNG_EXPORT_SERVICE_LOG = '[BeamNG Export Service]';

/**
 * Create the shared export progress tracker: a timed step log (each beginStep
 * closes the previous step with its wall-clock duration) plus UI callbacks.
 * Passed to buildLevelArtifacts (which drives the compute steps) and used here
 * for the compression steps; snapshot() feeds the diagnostics report.
 */
function createExportProgress(onProgress) {
  const processingLog = [];
  let currentStep = null;
  let currentStepStartedAt = performance.now();
  const report = (step, pct) => {
    console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Step`, { step, pct });
    onProgress?.({ step, pct });
  };
  const beginStep = (step, pct) => {
    const now = performance.now();
    if (currentStep !== null) {
      processingLog.push({ step: currentStep.step, pct: currentStep.pct, durationMs: now - currentStepStartedAt });
    }
    currentStep = { step, pct };
    currentStepStartedAt = now;
    report(step, pct);
  };
  const finishProcessingLog = () => {
    if (currentStep !== null) {
      processingLog.push({ step: currentStep.step, pct: currentStep.pct, durationMs: performance.now() - currentStepStartedAt });
      currentStep = null;
    }
  };
  const snapshot = () => (currentStep !== null
    ? [...processingLog, { step: currentStep.step, pct: currentStep.pct, durationMs: performance.now() - currentStepStartedAt }]
    : processingLog.slice());
  const yield_ = () => new Promise(r => setTimeout(r, 0));
  return { report, beginStep, finishProcessingLog, snapshot, yield_, exportStartedAt: new Date() };
}

/**
 * Generate a complete BeamNG level .zip from terrainData and center coordinates.
 *
 * ZIP structure:
 *   {levelName}.zip/
 *   └── levels/{levelName}/
 *       ├── info.json
 *       ├── mainLevel.lua
 *       ├── preview.png
 *       ├── theTerrain.ter
 *       ├── theTerrain.terrain.json
 *       ├── theTerrain.terrainheightmap.png
 *       ├── art/terrains/
 *       │   ├── terrain.png
 *       │   └── main.materials.json        (TerrainMaterial + TerrainMaterialTextureSet)
 *       ├── art/shapes/                    (present when OSM features or backdrop exist)
 *       │   ├── osm_objects.dae            (buildings, street furniture — optional)
 *       │   ├── terrain_backdrop.dae       (surrounding terrain mesh — optional)
 *       │   └── main.materials.json        (Materials for all DAEs in this folder)
 *       └── main/
 *           └── MissionGroup/
 *               ├── items.level.json
 *               ├── PlayerDropPoints/
 *               │   └── items.level.json
 *               ├── Level_objects/
 *               │   ├── items.level.json   (LevelInfo, TimeOfDay, ScatterSky, Other group)
 *               │   └── Other/
 *               │       └── items.level.json  (TerrainBlock + optional TSStatics)
 *
 * @param {object} terrainData
 * @param {object} center        — { lat, lng }
 * @param {object} [options]     — see buildLevelArtifacts (beamng/levelArtifacts.js)
 *   for the full option set (baseTexture, includeBuildings, applyFoundations,
 *   includeBackdrop, includeWater, includeNativeBarriers, includeTrees,
 *   includeRocks, roadType, flavorId, levelName, pbrSource, useGoogle3DTiles,
 *   googleApiKey, googleTilePlacements, onProgress, …).
 */
export async function exportBeamNGLevel(terrainData, center, options = {}) {
  const progress = createExportProgress(options.onProgress);
  const { report, beginStep, finishProcessingLog, yield_ } = progress;

  // Compute every artifact (terrain, roads, water, barriers, forest, DAE/GLB
  // assets, the diagnostics report) into the explicit ctx the serializer reads.
  const ctx = await buildLevelArtifacts(terrainData, center, options, progress);

  // Assemble the archive as a plain path → content recorder, NOT a JSZip:
  // JSZip eagerly reads every Blob into a JS-heap Uint8Array at file() time
  // (FileReader in prepareContent), so a large level — e.g. a 1+ GB Google
  // tiles DAE — blew the renderer heap during assembly, before compression
  // even started. Here contents keep their original form (Blobs stay
  // browser-managed/disk-backed); the sidecar uploads them as-is, and only
  // the prod fallback materialises a real JSZip at the very end.
  const zipDirs = [];
  const zipEntries = new Map(); // path → string | Blob | TypedArray
  const zip = {
    folder: (p) => { zipDirs.push(p); },
    file: (p, content) => { zipEntries.set(p, content); },
  };
  writeLevelEntries(zip, ctx);

  beginStep('Compressing ZIP archive (DEFLATE)…', 94);
  await yield_();

  // Offload compression to the Node sidecar when the dev server provides it:
  // the in-browser path materialises the whole archive in the renderer heap
  // (JSZip assembly + pako DEFLATE) and hangs large maps. The sidecar receives
  // each entry as-is (Blobs stream from browser storage, no JS-heap copy),
  // DEFLATEs natively to a temp file, and hands back a GET URL the UI streams
  // straight to disk. The in-browser path below stays as the prod fallback.
  const filename = `${ctx.levelName}.zip`;
  if (await zipSidecarAvailable()) {
    const { url, jobId } = await compressZipViaSidecar({ dirs: zipDirs, entries: zipEntries }, {
      filename,
      // Map the upload progress onto the 94→99% window; the step text carries
      // the live file/byte counters so the UI visibly ticks.
      onProgress: ({ step, pct }) => report(step, 94 + Math.round((pct / 100) * 5)),
    });
    beginStep('Done', 100);
    finishProcessingLog();
    console.log(`${BEAMNG_EXPORT_SERVICE_LOG} ZIP compressed via sidecar:`, { filename, jobId, url });
    console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Completed exportBeamNGLevel`);
    return { download: { url, jobId }, filename };
  }

  // Prod fallback: materialise a real JSZip from the recorder and compress
  // in-browser. This is where the old memory ceiling still applies.
  // Server-path markers can't exist here in practice (they're only created
  // when the bake sidecar ran, which implies a dev server with the zip
  // sidecar too) — but if the zip sidecar vanished mid-export, skip them
  // loudly rather than writing "[object Object]" into the archive.
  const realZip = new JSZip();
  for (const dir of zipDirs) realZip.folder(dir);
  for (const [p, content] of zipEntries) {
    if (isServerPathEntry(content)) {
      console.error(`[BeamNG export] cannot embed server-side entry "${p}" without the zip sidecar — skipped`);
      continue;
    }
    realZip.file(p, content);
  }
  const zipBlob = await realZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  console.log(`${BEAMNG_EXPORT_SERVICE_LOG} ZIP generated:`, {
    filename,
    blobType: zipBlob?.type,
    blobSize: zipBlob?.size,
    levelName: ctx.levelName,
  });
  beginStep('Done', 100);
  finishProcessingLog();
  console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Completed exportBeamNGLevel`);
  return { blob: zipBlob, filename };
}
