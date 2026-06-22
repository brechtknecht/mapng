// Route corridor → ONE BeamNG level.
//
// The preview route bake (services/routeBake.js) emits chunk_NN/model.glb +
// manifest.json — geometry for the in-app 3D preview, NOT a loadable map. This
// module assembles the SAME chunks into a single drivable BeamNG level by
// reusing the proven single-tile pipeline (services/exportBeamNGLevel.js) in its
// "route mode": one composited terrain + N google_tiles_NN TSStatics placed at
// their world offsets.
//
// Per chunk it reuses the bake worker's BeamNG assembly (atlas + GLB) and the
// dev-server Blender bridge (GLB → DAE) — exactly what the single-tile export
// does — so each chunk's tiles arrive in BeamNG's expected shape/material form.
// The chunks' terrain heightmaps are composited into one square .ter that spans
// the route bounding box (the drive surface; the photogrammetry tiles are the
// visuals on top, like single-tile).
//
// Alignment note (NEEDS in-BeamNG verification): each tile TSStatic is placed at
// its chunk-centre offset from the combined-terrain centre (metres), lifted by
// (chunkMinHeight − combinedMinHeight) so its ground meets the terrain datum.

import { fetchTerrainData } from './terrain';
import { exportToGLB } from './export3d';
import { exportBeamNGLevel } from './exportBeamNGLevel';
import { exportGoogleTilesViaSidecar, getGoogleTilesZOffset, endGoogleTilesSession, purgeRetainedBakes, BAKE_FORMAT_VERSION, TILE_RENDER_BIAS_M } from './google3dTiles';
import { computeUnitsPerMeter } from './googleBakeCore';
import { getCorridorTier, resolveChunkSizeM } from './routeCorridor';
import { computeRouteFrame } from './routeStitch';
import { buildCombinedRouteTerrain, sampleCombinedHeightMap } from './routeTerrainComposite';
import { createRouteProgress } from './routeProgress';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const pad2 = (n) => String(n).padStart(2, '0');
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * DEG) || M_PER_DEG_LAT;

/** Resolve a chunk's texture source for `baseTexture` to a drawable image/canvas. */
async function loadTextureSource(terrain, baseTexture) {
  // Prefer canvases (sync), fall back to blob URLs (async Image load).
  const pick = {
    satellite: [terrain.satelliteTextureCanvas, terrain.satelliteTextureUrl],
    hybrid: [terrain.hybridTextureCanvas, terrain.hybridTextureUrl],
    osm: [terrain.osmTextureCanvas, terrain.osmTextureUrl],
  }[baseTexture] ?? [];
  // Satellite/hybrid give the colourful aerial floor; fall back to OSM, then
  // whatever exists, so a chunk is never blank when SOME texture was generated.
  const candidates = [
    ...pick,
    terrain.satelliteTextureUrl, terrain.hybridTextureCanvas, terrain.osmTextureCanvas,
  ].filter(Boolean);
  for (const src of candidates) {
    if (src instanceof HTMLCanvasElement) return src;
    if (typeof src === 'string') {
      const img = await new Promise((res) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = src;
      });
      if (img) return img;
    }
  }
  return null;
}

/**
 * Composite the per-chunk terrain textures into ONE texture canvas spanning the
 * route bbox — otherwise the combined terrain has no texture and BeamNG shows a
 * solid grey floor. Off-corridor area (nothing fetched) stays a neutral filler.
 * Mirrors the heightmap composite's bbox→pixel-rect math.
 */
async function compositeRouteTexture(terrains, bounds, baseTexture = 'satellite', texSize = 2048) {
  const canvas = document.createElement('canvas');
  canvas.width = texSize;
  canvas.height = texSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#4a4a42'; // neutral earth tone for off-corridor filler
  ctx.fillRect(0, 0, texSize, texSize);
  const W = bounds.east - bounds.west;
  const H = bounds.north - bounds.south;
  let painted = 0;
  for (const t of terrains) {
    const img = await loadTextureSource(t, baseTexture);
    if (!img) continue;
    const cb = t.bounds;
    const x0 = ((cb.west - bounds.west) / W) * texSize;
    const x1 = ((cb.east - bounds.west) / W) * texSize;
    const y0 = ((bounds.north - cb.north) / H) * texSize; // texture rows are north-origin
    const y1 = ((bounds.north - cb.south) / H) * texSize;
    ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
    painted++;
  }
  return painted > 0 ? canvas : null;
}

/** Convert a server-side GLB to DAE via the dev Blender bridge. Returns {fromPath,size} or null. */
async function convertGlbToDae(glbPath) {
  try {
    const resp = await fetch(`/api/convert-dae?file=${encodeURIComponent(glbPath)}`, { method: 'POST' });
    if (!resp.ok) {
      const msg = await resp.text().catch(() => '');
      console.warn(`[routeLevel] Blender DAE conversion failed (HTTP ${resp.status}): ${msg} — shipping GLB + script for ${glbPath}`);
      return null;
    }
    const { daePath, bytes } = await resp.json();
    return { fromPath: daePath, size: bytes ?? 0 };
  } catch (err) {
    console.warn(`[routeLevel] Blender bridge unreachable for ${glbPath} — shipping GLB + script:`, err);
    return null;
  }
}

/**
 * Assemble a route corridor into ONE BeamNG level zip.
 *
 * @param {object[]} chunks  chunkRoute() output (each with .center, .bounds, .segment)
 * @param {object} opts
 *   @param {string} opts.tierId
 *   @param {number|null} [opts.chunkSizeM]
 *   @param {string} opts.googleApiKey
 *   @param {string} [opts.levelName]
 *   @param {string} opts.flavorId
 *   @param {(p:{chunk:number,total:number,phase:string,detail?:string})=>void} [opts.onProgress]
 *   @param {AbortSignal} [opts.signal]
 * @returns {Promise<{url?,jobId?,blob?,filename:string}>} same shape as exportBeamNGLevel
 */
// Session cache of the EXPENSIVE artifacts (fetched terrain, composited terrain
// + texture, per-chunk assembled tile shapes/atlases, stitched preview) keyed by
// everything EXCEPT the z-offset. Re-exporting the same route with a tweaked
// z-offset (or just again) reuses all of this and only re-places the tiles +
// re-zips — no terrain re-fetch, no tile re-bake/assemble/convert. Server temp
// paths can age out (idle session reap), so it's a best-effort within-session
// cache; a fresh route/settings combo rebuilds it.
let _routeAsm = null; // { key, combined, combinedCenter, frame, pieces, previewChunks }

const asmKey = (chunks, tierId, chunkSizeM, elevationSource, gpxzApiKey, quality, baseTexture) =>
  JSON.stringify({
    // Bake geometry version — without this, the in-memory _routeAsm (and the
    // fast "reuse" path) serve stale per-chunk geometry across conform/weld/strip
    // changes, so "re-bake the same route" silently does nothing.
    v: BAKE_FORMAT_VERSION,
    b: chunks.map((c) => [
      Number(c.bounds.north).toFixed(6), Number(c.bounds.south).toFixed(6),
      Number(c.bounds.east).toFixed(6), Number(c.bounds.west).toFixed(6),
    ]),
    tierId, chunkSizeM, elevationSource, gpxzApiKey: gpxzApiKey ? 'set' : '', quality, baseTexture,
  });

export async function exportRouteAsBeamNGLevel(chunks, opts = {}) {
  const {
    tierId, googleApiKey, levelName, flavorId, onProgress, signal,
    // Parity with the single-tile export's controls.
    elevationSource = 'default',
    gpxzApiKey = '',
    baseTexture = 'satellite',
    // How many chunks to assemble (sidecar bake + DAE convert + preview encode)
    // concurrently. Each chunk fans out to its own keyed sidecar bake job +
    // its own Blender process, so several run safely in parallel; bounded
    // because each is heap/CPU heavy. Mirrors routeBake.js's bake pool.
    concurrency = 2,
  } = opts;
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('exportRouteAsBeamNGLevel: no chunks');
  if (!googleApiKey) throw new Error('exportRouteAsBeamNGLevel: missing tiles credential');

  const tier = getCorridorTier(tierId);
  const chunkSizeM = resolveChunkSizeM(tierId, opts.chunkSizeM);
  const total = chunks.length;
  // Per-chunk progress (same tracker the Raw-GLB bake uses) so the map overlay
  // lights up every chunk that's in flight — terrain fetches run several at a
  // time, so multiple boxes glow at once. The legacy single-`chunk` shape this
  // replaced carried no per-chunk array, so the map showed nothing and the
  // parallelism was invisible (looked strictly sequential). See routeProgress.js.
  const progress = createRouteProgress(total, onProgress);
  // Route-wide step lines (compositing, level build) aren't per-chunk; spread
  // the current snapshot and just override its detail so the panel bar updates.
  const announce = (detail) => onProgress?.({ ...progress.snapshot(), detail });
  // z-offset is applied as the tile TSStatic POSITION (not baked into the tile
  // geometry), so changing it never invalidates the cached assembly.
  const zOffsetM = Number.isFinite(opts.zOffsetM) ? opts.zOffsetM : getGoogleTilesZOffset();

  const key = asmKey(chunks, tierId, chunkSizeM, elevationSource, gpxzApiKey, tier.googleQuality, baseTexture);
  let asm = _routeAsm && _routeAsm.key === key ? _routeAsm : null;

  if (!asm) {
    // ---- EXPENSIVE pipeline (runs once per route/settings) ------------------
    // Drop the PREVIOUS run's retained per-chunk files before we create this
    // run's — keeps tmp at ~one route's worth instead of accumulating. The
    // cache-reuse path (else branch) skips this so fast re-export keeps its
    // files. Best-effort; never blocks the bake.
    await purgeRetainedBakes();
    const src = String(elevationSource || 'default').toLowerCase();
    const useUSGS = src === 'usgs', useGPXZ = src === 'gpxz', useKRON86 = src === 'kron86';

    // 1) Terrain per chunk.
    //
    // The chunks are independent fetches that get composited afterwards, so we
    // run several at once instead of strictly back-to-back — this overlaps each
    // chunk's OSM Overpass round-trip + tile downloads + off-thread resample.
    // GPXZ/USGS keep a low cap: each already fans out its own internal requests
    // (and GPXZ is rate-limited), so too many parallel chunks would just trip
    // throttling. The global-tile path is network-bound, so a few more help.
    //
    // Texture work is scoped to the ONE base texture the composite will use:
    // a satellite floor needs no OSM at all, so we skip the per-chunk Overpass
    // query and both texture bakes entirely (the single biggest serial cost on
    // the standard tiers). osm/hybrid still pull OSM and bake only their own
    // texture. (The composite's cross-texture fallback is lost in trade, but a
    // wholesale satellite miss is rare and the off-corridor filler covers gaps.)
    const tex = String(baseTexture || 'satellite').toLowerCase();
    const includeOSM = tex === 'osm' || tex === 'hybrid';
    const genOpts = {
      generateOSMTextureAsset: tex === 'osm',
      generateHybridTextureAsset: tex === 'hybrid',
    };
    const terrainConcurrency = (useGPXZ || useUSGS) ? 2 : 4;

    const terrains = new Array(total);
    let nextChunk = 0;
    const terrainWorker = async () => {
      while (nextChunk < total) {
        const i = nextChunk++;
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        // Box i goes 'terrain' (sky blue, counted active) ONLY while its fetch is
        // actually in flight — with `terrainConcurrency` workers that's a small
        // rolling set, which is the real degree of fetch parallelism. The moment
        // the fetch settles we drop it back to 'pending' so it is NOT counted as
        // active: the tile bake below is strictly serial (one shared renderer), so
        // leaving fetched-but-unbaked chunks "active" would inflate the parallel
        // badge to the full chunk count while only one box is truly being worked.
        progress.setPhase(i, 'terrain', 'fetching terrain + OSM');
        terrains[i] = await fetchTerrainData(
          chunks[i].center, chunkSizeM, includeOSM, useUSGS, useGPXZ, useKRON86, gpxzApiKey,
          undefined, undefined, signal, genOpts,
        );
        progress.setPhase(i, 'pending', 'terrain fetched, queued for tile bake');
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(terrainConcurrency, total) }, terrainWorker),
    );

    // 2) One composited terrain + texture spanning the route bbox.
    announce('Compositing route terrain');
    const combined = buildCombinedRouteTerrain(terrains);
    const routeTexture = await compositeRouteTexture(terrains, combined.bounds, baseTexture);
    if (routeTexture) combined.osmTextureCanvas = routeTexture;
    const combinedCenter = {
      lat: (combined.bounds.north + combined.bounds.south) / 2,
      lng: (combined.bounds.east + combined.bounds.west) / 2,
    };
    const mLng = mPerDegLng(combinedCenter.lat);

    // 3) Per chunk: assemble the BeamNG tile shape (z-offset = 0 — applied as
    //    TSStatic position later), convert to DAE, compute the BASE placement,
    //    and encode a z-offset-FREE preview GLB (the preview shifts tiles live).
    //    Indexed (not push) because the bake pool finishes chunks out of order.
    const pieces = new Array(total);
    const previewBlobs = new Array(total).fill(null);
    // Small per-chunk values computeRouteFrame needs at the end. Captured here
    // so each chunk's HEAVY terrainData (heightmap + texture canvases, tens of
    // MB) can be released the moment its assembly finishes, instead of pinning
    // all N terrains in memory for the whole run — the steady memory creep that
    // made long routes slow down as they progressed.
    const frameInputs = new Array(total);
    // One route-wide vertical anchor for the Google tiles, captured from chunk 0
    // and reused by every later chunk (.dae) AND every preview GLB. Each chunk
    // would otherwise re-seat Google's ground onto its OWN centre's DEM height,
    // so neighbours disagree at the shared seam and the next chunk floats.
    let sharedGroundOffsetM = null;

    // Assemble ONE chunk: keyed sidecar bake → Blender DAE → preview GLB. All
    // three are per-chunk independent, so the pool below runs several at once.
    const assembleChunk = async (i) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // The anchor THIS chunk's bake uses: null for chunk 0 (bakes natural,
      // then sets the shared value), the shared value for chunks 1..N. Captured
      // up front so the session-end below recomputes the exact bake key.
      const assemblyAnchor = sharedGroundOffsetM;
      progress.setPhase(i, 'bake', `assembling tiles ${i + 1}/${total}`);
      // Bake/conform against this chunk's SLICE OF THE COMBINED terrain (the
      // surface the level drives on), not its independently-fetched DEM. Keeps
      // the chunk's bounds/minHeight (datum) + texture canvases so baseUp
      // placement is unchanged; only the heights the tiles seat on change, so the
      // conform seats them on the combined surface and they don't float at chunk
      // seams where DEMs disagree. See sampleCombinedHeightMap + the route conform
      // tests (tests/routeConform.test.mjs).
      const bakeTerrain = { ...terrains[i], heightMap: sampleCombinedHeightMap(combined, terrains[i]) };
      const exported = await exportGoogleTilesViaSidecar(
        bakeTerrain,
        {
          apiKey: googleApiKey,
          quality: tier.googleQuality,
          corridorSegment: chunks[i].segment,
          corridorHalfWidthM: tier.halfWidthM,
          // Chunk 0 bakes with its natural anchor and reports it back; chunks
          // 1..N seat on that same value so the rail stays continuous.
          ...(assemblyAnchor != null ? { sharedGroundOffsetM: assemblyAnchor } : {}),
          onProgress: (p) => progress.setPhase(i, 'bake', `tiles ${i + 1}/${total}: ${p.visible ?? 0} loaded`),
        },
        // Unique material prefix per chunk so BeamNG's global material resolution
        // doesn't cross-wire textures. zOffsetM:0 — z-offset is positional.
        { worldSize: chunkSizeM, zOffsetM: 0, materialPrefix: `c${pad2(i)}_` },
      );
      if (i === 0 && Number.isFinite(exported?.groundOffsetM)) {
        sharedGroundOffsetM = exported.groundOffsetM;
        console.info(`[routeLevel] shared Google vertical anchor = ${sharedGroundOffsetM.toFixed(2)}m (from chunk 0)`);
      }
      progress.setPhase(i, 'bake', `converting tiles ${i + 1}/${total} to DAE`);
      const dae = await convertGlbToDae(exported.glbPath);
      console.info(
        `[routeLevel] chunk ${i + 1}/${total}: ${exported.meshes ?? '?'} meshes, ` +
        `${(exported.materialNames ?? []).length} atlases, ${(exported.textures ?? []).length} textures, ` +
        `dae=${dae ? 'yes' : 'NO (glb fallback)'}`,
      );

      const east = (chunks[i].center.lng - combinedCenter.lng) * mLng;
      const north = (chunks[i].center.lat - combinedCenter.lat) * M_PER_DEG_LAT;
      const baseUp = (terrains[i].minHeight ?? 0) - combined.minHeight; // datum lift, no z-offset

      pieces[i] = {
        name: `google_tiles_${pad2(i)}`,
        daeBlob: dae,
        glbBlob: dae ? null : { fromPath: exported.glbPath, size: exported.glbBytes ?? 0 },
        textureFiles: (exported.textures ?? []).map((t) => ({
          name: t.name, ext: 'png', data: { fromPath: t.path, size: t.bytes ?? 0 },
        })),
        materialNames: exported.materialNames ?? [],
        east: Math.round(east * 100) / 100,
        north: Math.round(north * 100) / 100,
        baseUp: Math.round(baseUp * 100) / 100,
      };

      // z-offset-free preview GLB (googleZOffsetM:0) — RoutePreview applies the
      // live z-offset to the tiles. Reuses the SAME cached bake (no re-bake).
      progress.setPhase(i, 'encode', `encoding preview ${i + 1}/${total}`);
      previewBlobs[i] = await exportToGLB(bakeTerrain, {
        returnBlob: true,
        useGoogle3DTiles: true,
        googleApiKey,
        googleQuality: tier.googleQuality,
        centerTextureType: 'osm',
        googleZOffsetM: 0,
        // Same shared anchor as the .dae so the preview is WYSIWYG and chunks
        // line up. Chunk 0's preview reuses the value chunk 0's .dae produced.
        ...(sharedGroundOffsetM != null ? { googleGroundOffsetM: sharedGroundOffsetM } : {}),
        corridorMask: { segment: chunks[i].segment, halfWidthM: tier.halfWidthM },
      });
      progress.setPhase(i, 'done', 'complete');

      // Capture the cheap values computeRouteFrame needs + the bake-key inputs,
      // THEN release this chunk's heavy terrainData so only the in-flight chunks
      // stay resident (the steady memory creep on long routes).
      frameInputs[i] = {
        center: chunks[i].center,
        unitsPerMeter: computeUnitsPerMeter(terrains[i]),
        minHeight: terrains[i].minHeight,
      };
      // bakeCacheKey only reads bounds/width/height — a tiny stub matches the
      // bake's key exactly without pinning the multi-MB terrainData.
      const keyData = { bounds: terrains[i].bounds, width: terrains[i].width, height: terrains[i].height };
      terrains[i] = null;

      // Free the resident sidecar worker(s) for this chunk to reclaim RAM — the
      // bake is now on disk + in IndexedDB. keepFiles:true is ESSENTIAL: the
      // final zip (step 4) reads this chunk's server-side GLB/DAE/PNGs, and fast
      // re-export reuses them, so we keep the workDir while dropping the process.
      // Chunk 0 bakes under TWO keys (natural for the .dae, anchored for the
      // preview); chunks 1..N share one. Fire-and-forget; never block the pipe.
      const previewAnchor = sharedGroundOffsetM;
      const endSession = (anchor) => endGoogleTilesSession(keyData, {
        quality: tier.googleQuality,
        corridorSegment: chunks[i].segment,
        corridorHalfWidthM: tier.halfWidthM,
        ...(anchor != null ? { sharedGroundOffsetM: anchor } : {}),
      }, { keepFiles: true }).catch(() => {});
      endSession(assemblyAnchor);
      if (previewAnchor !== assemblyAnchor) endSession(previewAnchor);
    };

    // Chunk 0 alone first to learn the shared vertical anchor (every later chunk
    // seats on it), THEN fan the rest out `limit`-wide — the same one-up-front
    // pattern routeBake.js uses. Now multiple chunks bake at once (multiple
    // orange boxes), not strictly one after another.
    await assembleChunk(0);
    let nextAsm = 1;
    const limit = Math.max(1, Math.min(concurrency, Math.max(1, total - 1)));
    const assembleWorker = async () => {
      for (;;) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const i = nextAsm++;
        if (i >= total) return;
        await assembleChunk(i);
      }
    };
    await Promise.all(Array.from({ length: limit }, assembleWorker));

    const frame = computeRouteFrame(frameInputs, chunkSizeM);
    const previewChunks = chunks.map((c, i) => ({
      index: i,
      blob: previewBlobs[i],
      placement: frame.placements[i],
    }));

    asm = { key, combined, combinedCenter, frame, pieces, previewChunks };
    _routeAsm = asm;
  } else {
    for (let i = 0; i < total; i++) progress.setPhase(i, 'done');
    announce('Reusing fetched terrain + baked tiles');
  }

  // 4) Place tiles (z-offset → TSStatic Z) and build the level. Spawn at the
  //    ROUTE START (chunk 0) so the player lands on the corridor.
  announce('Building BeamNG level');
  const date = new Date().toISOString().slice(0, 10);
  const placedPieces = asm.pieces.map((p) => ({
    ...p,
    position: [p.east, p.north, Math.round((p.baseUp + zOffsetM + TILE_RENDER_BIAS_M) * 100) / 100],
  }));
  const res = await exportBeamNGLevel(asm.combined, chunks[0].center, {
    googleTilePlacements: placedPieces,
    levelName: levelName || `mapng_route_${date}_${total}chunks`,
    baseTexture: 'osm', // the composited satellite/OSM aerial set on combined.osmTextureCanvas
    flavorId: flavorId || 'west_coast_usa',
    includeBuildings: false,
    includeTrees: false,
    includeWater: false,
    includeNativeBarriers: false,
    includeBackdrop: false,
    includeRocks: false,
    applyFoundations: false,
    roadType: 'none',
    pbrSource: 'none',
    onProgress: (p) => announce(p?.step),
  });

  const flat = res.download
    ? { url: res.download.url, jobId: res.download.jobId, filename: res.filename }
    : res;
  return { ...flat, previewChunks: asm.previewChunks, worldBoundsM: asm.frame.worldBoundsM };
}
