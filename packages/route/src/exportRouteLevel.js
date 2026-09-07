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

import { fetchTerrainData, computeOSMOutputBounds } from '@mapng/terrain/terrain';
import { fetchOSMUnionRaw, parseOverpassResponse } from '@mapng/fetching';
import { exportToGLB } from '@mapng/export/export3d';
import { exportBeamNGLevel } from '@mapng/export/exportBeamNGLevel';
import { exportGoogleTilesViaSidecar, prefetchGoogleTilesSweep, getGoogleTilesZOffset, endGoogleTilesSession, purgeRetainedBakes, BAKE_FORMAT_VERSION, TILE_RENDER_BIAS_M } from '@mapng/bake/google3dTiles';
import { computeUnitsPerMeter } from '@mapng/bake/googleBakeCore';
import { getCorridorTier, resolveChunkSizeM } from './routeCorridor.js';
import { computeRouteFrame } from './routeStitch.js';
import { buildCombinedRouteTerrain, sampleCombinedHeightMap, compositeRouteGround, registerChunkGrounds, sampleHeightAt } from './routeTerrainComposite.js';
import { getPreferredTerGround, getGroundStrategy } from '@mapng/bake/ground/extractTileGround';
import { pickProfileRoads } from '@mapng/bake/roadProfiles';
import { createRouteProgress } from './routeProgress.js';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const pad2 = (n) => String(n).padStart(2, '0');
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * DEG) || M_PER_DEG_LAT;

// Fire-and-forget structured log to the turbolog dev bridge (viteTurbologPlugin).
// No-op on failure and in prod builds (endpoint absent) — never blocks the export.
const devLog = (stream, message, meta) => {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream, message, meta }),
    }).catch(() => { /* dev-only, best effort */ });
  } catch { /* no fetch / prod */ }
};

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
let _routeAsm = null; // { key, combined, combinedGround, combinedCenter, frame, pieces, previewChunks }

const asmKey = (chunks, tierId, chunkSizeM, elevationSource, gpxzApiKey, quality, baseTexture, groundFp) =>
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
    // .ter ground strategy: a strategy change must rebuild the composited ground.
    groundFp,
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
    concurrency = 3,
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

  // Tile-extracted bare-earth ground for the route .ter ('dem' ⇒ skip, drive the DEM).
  const preferTiles = getPreferredTerGround() === 'tiles';
  const groundStrategy = preferTiles ? getGroundStrategy() : null;

  const key = asmKey(
    chunks, tierId, chunkSizeM, elevationSource, gpxzApiKey, tier.googleQuality, baseTexture,
    preferTiles ? JSON.stringify(groundStrategy) : 'dem',
  );
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
    // GPXZ/USGS keep a low cap (each fans out internally, GPXZ is rate-limited);
    // the global-tile path is network-bound, so a few more help.
    //
    // Texture work is scoped to the ONE base texture the composite will use:
    // a satellite floor needs no OSM at all, so we skip the per-chunk Overpass
    // query and both texture bakes entirely (the single biggest serial cost on
    // the standard tiers). osm/hybrid still pull OSM and bake only their own
    // texture. (The composite's cross-texture fallback is lost in trade, but a
    // wholesale satellite miss is rare and the off-corridor filler covers gaps.)
    const tex = String(baseTexture || 'satellite').toLowerCase();
    // Always fetch OSM FEATURES — the road mask/profiles need the geometry
    // regardless of the chosen base texture (a satellite route used to skip OSM
    // and lose the mask). Texture-ASSET generation stays gated by `tex` below.
    const includeOSM = true;
    // ONE union Overpass round-trip for the whole route instead of one query
    // per chunk: N racing queries from one IP used to pile onto the public
    // mirrors' per-IP slots and serialize (the dominant fetch-phase cost).
    // Each chunk's resolver slices its box out of the merged raw response —
    // parseOverpassResponse's bbox clip does the per-chunk split. Bounds are
    // deterministic from centre + size (computeOSMOutputBounds = the exact
    // bounds fetchTerrainData would have queried itself).
    const unionOsmPromise = fetchOSMUnionRaw(
      chunks.map((c) => computeOSMOutputBounds(c.center, chunkSizeM)),
    );
    const prefetchedOSM = async (outputBounds) => {
      const { data, requestInfo } = await unionOsmPromise;
      return { features: parseOverpassResponse(data, outputBounds), requestInfo };
    };
    const genOpts = {
      generateOSMTextureAsset: tex === 'osm',
      generateHybridTextureAsset: tex === 'hybrid',
      prefetchedOSM,
    };
    // GPXZ/USGS fan out internally and are rate-limited — keep the low cap.
    // The global-tile path is pure network (tiles are disk/IndexedDB-cached,
    // OSM is one shared union query now), so run wider.
    const terrainConcurrency = (useGPXZ || useUSGS) ? 2 : 8;

    // Google-tile PREFETCH: as soon as a chunk's terrain lands, warm the
    // sidecar's tile disk cache for it (sweep-only worker — downloads exactly
    // the tiles the real bake will select and exits). This overlaps the two
    // big network phases: previously chunks 1..N downloaded ZERO Google bytes
    // until chunk 0's whole anchor bake finished, which is most of the
    // "queued for tile bake" dead time. Fire-and-forget — a failed or late
    // prefetch only costs warmth, never correctness (the real bake just hits
    // the network as before). Chunks whose REAL bake has already started are
    // skipped (their prefetch would be pure duplicate downloads).
    const bakeStarted = new Set(); // chunk indices whose real bake began
    const prefetchQueue = [];
    let prefetchActive = 0;
    // Once the assembly pool fans out (post-anchor), REAL bakes own the
    // bandwidth: `concurrency` concurrent sweeps + prefetches on top starved
    // each sweep enough to trip its wall-clock budget, which silently skips
    // the corridor's tail stations — the "missing pieces at chunk seams"
    // failure. Prefetch's whole win is the fetch + chunk-0-anchor window, so
    // it stops scheduling the moment the pool opens (in-flight ones finish).
    let poolOpen = false;
    const PREFETCH_LIMIT = 2;
    const pumpPrefetch = () => {
      if (poolOpen) { prefetchQueue.length = 0; return; }
      while (prefetchActive < PREFETCH_LIMIT && prefetchQueue.length) {
        const { i, run } = prefetchQueue.shift();
        if (bakeStarted.has(i) || signal?.aborted) continue;
        prefetchActive++;
        run()
          .catch((err) => console.info(`[routeLevel] tile prefetch ${i} skipped: ${err?.message ?? err}`))
          .finally(() => { prefetchActive--; pumpPrefetch(); });
      }
    };
    const schedulePrefetch = (i, terrainData) => {
      if (i === 0) return; // chunk 0 IS the first real bake — nothing to hide
      prefetchQueue.push({
        i,
        run: () => prefetchGoogleTilesSweep(terrainData, {
          apiKey: googleApiKey,
          quality: tier.googleQuality,
          corridorSegment: chunks[i].segment,
          corridorHalfWidthM: tier.halfWidthM,
          // Chunk ownership (Voronoi by chunk centre): the worker trims the
          // mesh to this chunk's cell — the .ter switches floor on the same
          // line. Part of the bake key, so prefetch and bake must both carry it.
          corridorOwnership: { centers: chunks.map((c) => c.center), self: i },
        }),
      });
      pumpPrefetch();
    };

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
        schedulePrefetch(i, terrains[i]);
        progress.setPhase(i, 'pending', 'terrain fetched, queued for tile bake');
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(terrainConcurrency, total) }, terrainWorker),
    );

    // 2) One composited terrain + texture spanning the route bbox.
    // 1 m/px to MATCH the per-chunk DEM the single-tile bake conforms onto — at the
    // old 2 m/px the tiles seated on a half-resolution, smoothed surface, which is
    // why route roads looked coarse/misaligned vs single-tile (which uses 1 m/px).
    // (For very long routes the square combined still caps at maxSize px; raise
    // maxSize too if a long route degrades.)
    announce('Compositing route terrain');
    const combined = buildCombinedRouteTerrain(terrains, { targetMetersPerPixel: 1 });
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
    // Per-chunk tile-extracted ground (abs metres, shared anchor); nulls ⇒ DEM.
    const chunkGrounds = new Array(total).fill(null);
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
    // Gate for chunks 1..N: opens the moment chunk 0's anchor is KNOWN — via the
    // worker's early progress event (right after its sweep + ground probe), or
    // at the latest when chunk 0's assembly returns (cached/restored bakes emit
    // no live progress). Rejects if chunk 0 fails before an anchor exists.
    let anchorResolve, anchorReject;
    const anchorGate = new Promise((res, rej) => { anchorResolve = res; anchorReject = rej; });

    // Assemble ONE chunk: keyed sidecar bake → Blender DAE → preview GLB. All
    // three are per-chunk independent, so the pool below runs several at once.
    const assembleChunk = async (i) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // The anchor THIS chunk's bake uses: null for chunk 0 (bakes natural,
      // then sets the shared value), the shared value for chunks 1..N. Captured
      // up front so the session-end below recomputes the exact bake key.
      const assemblyAnchor = sharedGroundOffsetM;
      bakeStarted.add(i); // a still-queued prefetch for this chunk is now pointless
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
          // Chunk ownership (Voronoi by chunk centre): the worker trims the
          // mesh to this chunk's cell — the .ter switches floor on the same
          // line. Part of the bake key, so prefetch and bake must both carry it.
          corridorOwnership: { centers: chunks.map((c) => c.center), self: i },
          // Chunk 0 bakes with its natural anchor and reports it back; chunks
          // 1..N seat on that same value so the rail stays continuous.
          ...(assemblyAnchor != null ? { sharedGroundOffsetM: assemblyAnchor } : {}),
          // Extract the chunk's .ter ground (shared anchor ⇒ one absolute frame).
          ...(preferTiles ? { extractGround: true, groundStrategy } : {}),
          onProgress: (p) => {
            if (p?.phase === 'anchor') {
              // Chunk 0's early anchor (worker emits it right after sweep+probe):
              // set the shared value and open the gate — chunks 1..N start baking
              // while chunk 0 is still conforming/exporting/converting.
              if (i === 0 && sharedGroundOffsetM == null && Number.isFinite(p.groundOffsetM)) {
                sharedGroundOffsetM = p.groundOffsetM;
                console.info(`[routeLevel] shared Google vertical anchor = ${sharedGroundOffsetM.toFixed(2)}m (early, from chunk 0's sweep)`);
                anchorResolve();
              }
              return; // not a sweep-progress tick — don't clobber the tile count
            }
            progress.setPhase(i, 'bake', `tiles ${i + 1}/${total}: ${p.visible ?? 0} loaded`);
          },
        },
        // Unique material prefix per chunk so BeamNG's global material resolution
        // doesn't cross-wire textures. zOffsetM:0 — z-offset is positional.
        { worldSize: chunkSizeM, zOffsetM: 0, materialPrefix: `c${pad2(i)}_` },
      );
      if (i === 0 && sharedGroundOffsetM == null && Number.isFinite(exported?.groundOffsetM)) {
        // Fallback path: no live progress event fired (bake restored from
        // IndexedDB / job already done) — the anchor arrives with the export.
        sharedGroundOffsetM = exported.groundOffsetM;
        console.info(`[routeLevel] shared Google vertical anchor = ${sharedGroundOffsetM.toFixed(2)}m (from chunk 0)`);
      }
      if (exported?.timedOut) {
        // Budget-exhausted sweep = skipped corridor stations = missing mesh at
        // this chunk's tail/seam. Loud, per chunk — re-export re-sweeps only
        // the timed-out chunk (the others restore from cache).
        console.warn(`[routeLevel] chunk ${i + 1}/${total}: sweep budget exhausted — geometry is INCOMPLETE (expect holes near this chunk's seam)`);
        devLog('route-placement', `chunk ${i} sweep TIMED OUT — partial geometry`, { chunk: i, stage: 'bake-timeout' });
      }
      // Assembled-mesh geometry probe (turbolog `dae-geometry`): where the WORKER
      // GLB actually lands, in final metres, vs the chunk's expected extent. The
      // DAE is placed at [east,north]≈mesh-centre, so mesh centre X/Z should be
      // ≈0; a non-zero centre = a per-chunk offset the browser placement can't see.
      const mb = exported?.meshBounds;
      if (mb) {
        devLog('dae-geometry', `chunk ${i} worker-GLB: centerXZ=[${mb.center[0].toFixed(2)}, ${mb.center[2].toFixed(2)}] spanXZ=[${mb.span[0].toFixed(1)}, ${mb.span[2].toFixed(1)}]`, {
          chunk: i,
          stage: 'worker-glb',
          center: mb.center,
          span: mb.span,
          min: mb.min,
          max: mb.max,
          expectedHalfM: chunkSizeM / 2,
          corridorHalfWidthM: tier.halfWidthM,
        });
      }

      // Road-profile evenness telemetry (turbolog `road-profiles`): the worker
      // builds and carves the profiles but has no /api/log bridge, so its stats
      // ride the exported payload and are forwarded here. These are the numbers
      // the junction-solve / smoother work has to drive down.
      const rp = exported?.roadProfileStats;
      if (rp) {
        const rc = exported?.roadCarveStats;
        devLog('road-profiles',
          `chunk ${i}: roughness rms ${rp.roughnessRmsM}m, ` +
          `junction steps p95 ${rp.junctionStepP95M}m / max ${rp.junctionStepMaxM}m (${rp.junctionPairs} pairs)` +
          (rc ? `, .ter-vs-profile residual rms ${rc.profileResidualRmsM}m / max ${rc.profileResidualMaxM}m` : ''), {
            chunk: i,
            ...rp,
            carve: rc ?? null,
          });
      }

      // Pair the chunk's ground with its bounds (terrains[i] alive here). Absent
      // ⇒ this corridor falls back to the DEM in the composite.
      if (preferTiles && exported?.ground) {
        chunkGrounds[i] = { ...exported.ground, bounds: terrains[i].bounds };
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
        // ext is 'dds' when the sidecar BC1-compressed the atlas (≈8× less
        // BeamNG VRAM), else 'png' fallback — the per-chunk materials.json
        // colorMap (levelFiles.js) follows tex.ext.
        textureFiles: (exported.textures ?? []).map((t) => ({
          name: t.name, ext: t.ext ?? 'png', data: { fromPath: t.path, size: t.bytes ?? 0 },
        })),
        materialNames: exported.materialNames ?? [],
        east: Math.round(east * 100) / 100,
        north: Math.round(north * 100) / 100,
        baseUp: Math.round(baseUp * 100) / 100,
      };

      // z-offset-free preview GLB (googleZOffsetM:0) — RoutePreview applies the
      // live z-offset itself. Reuses the SAME cached bake (no re-bake):
      progress.setPhase(i, 'encode', `encoding preview ${i + 1}/${total}`);
      previewBlobs[i] = await exportToGLB(bakeTerrain, {
        returnBlob: true,
        useGoogle3DTiles: true,
        googleApiKey,
        googleQuality: tier.googleQuality,
        centerTextureType: 'osm',
        googleZOffsetM: 0,
        // Same shared anchor as the .dae so the preview is WYSIWYG at seams.
        ...(sharedGroundOffsetM != null ? { googleGroundOffsetM: sharedGroundOffsetM } : {}),
        // Must match the .dae bake — part of the bake key (tsnap).
        ...(preferTiles ? { googleExtractGround: true, googleGroundStrategy: groundStrategy } : {}),
        corridorMask: {
          segment: chunks[i].segment,
          halfWidthM: tier.halfWidthM,
          ownership: { centers: chunks.map((c) => c.center), self: i },
        },
      });
      progress.setPhase(i, 'done', 'complete');

      // Capture the cheap values computeRouteFrame needs + the bake-key inputs,
      // THEN release this chunk's heavy terrainData so only the in-flight chunks
      // stay resident (the steady memory creep on long routes).
      frameInputs[i] = {
        center: chunks[i].center,
        unitsPerMeter: computeUnitsPerMeter(terrains[i]),
        minHeight: terrains[i].minHeight,
        osmRoads: pickProfileRoads(terrains[i].osmFeatures),
      };
      // bakeCacheKey only reads bounds/width/height — a tiny stub matches the
      // bake's key exactly without pinning the multi-MB terrainData.
      const keyData = { bounds: terrains[i].bounds, width: terrains[i].width, height: terrains[i].height };
      terrains[i] = null;

      // Free the chunk's resident sidecar worker(s) (bake is on disk+IndexedDB).
      // keepFiles:true is ESSENTIAL — the final zip + fast re-export read this
      // chunk's server-side GLB/DAE/PNGs. Chunk 0 bakes under TWO keys (natural
      // .dae + anchored preview); 1..N share one. Fire-and-forget.
      const previewAnchor = sharedGroundOffsetM;
      const endSession = (anchor) => endGoogleTilesSession(keyData, {
        quality: tier.googleQuality,
        corridorSegment: chunks[i].segment,
        corridorHalfWidthM: tier.halfWidthM,
        ...(anchor != null ? { sharedGroundOffsetM: anchor } : {}),
        // Part of the bake key (tsnap) — a mismatched end leaks the worker.
        ...(preferTiles ? { extractGround: true, groundStrategy } : {}),
      }, { keepFiles: true }).catch(() => {});
      endSession(assemblyAnchor);
      if (previewAnchor !== assemblyAnchor) endSession(previewAnchor);
    };

    // Chunk 0 starts first to learn the shared vertical anchor (every later
    // chunk seats on it) — but the pool no longer waits for its WHOLE assembly.
    // The gate opens on the worker's early anchor event (right after chunk 0's
    // sweep + ground probe), so chunk 0's conform + atlas export + Blender DAE
    // + preview encode all overlap chunks 1..N's bakes. If no event arrives
    // (cached/restored bake), the gate opens when chunk 0's assembly returns.
    const chunk0 = assembleChunk(0);
    // Late-open fallback + failure propagation. Settled-gate re-calls are no-ops.
    chunk0.then(() => anchorResolve(), (err) => anchorReject(err));
    await anchorGate; // throws if chunk 0 failed before an anchor existed
    poolOpen = true; // real bakes fan out now — stop scheduling prefetches
    pumpPrefetch(); // drains the queue
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
    // chunk0 rides along so a post-anchor chunk-0 failure still fails the run.
    await Promise.all([chunk0, ...Array.from({ length: limit }, assembleWorker)]);

    // Composite the per-chunk tile grounds into ONE route .ter (bare-earth along
    // the corridor, DEM off-corridor, feathered between). Cached on asm.
    let combinedGround = null;
    let registration = null;
    let rawChunkGrounds = chunkGrounds.slice();
    if (preferTiles) {
      // Vertical registration — DIAGNOSTIC ONLY. Every chunk bakes with one
      // shared vertical anchor, so the tile meshes of all chunks are already one
      // continuous surface (measured 0.00 m in every overlap). A floor
      // disagreement between two chunks is therefore an EXTRACTION error of one
      // of them (its floor left the road), never a frame offset — and applying
      // it to the mesh placement, as this code did, moved a correct mesh by the
      // wrong floor's error: 5.4 m tile steps at the seams of a flat route.
      // The floor is fixed where it is wrong (worker applyDemReseat); here we
      // only measure and report the residual so it stays visible.
      registration = registerChunkGrounds(chunkGrounds);
      for (const p of registration.pairs) {
        const level = Math.abs(p.medianDhM) > 0.5 ? 'warn' : 'info';
        devLog('ground-overlap', `floor disagreement ${p.a}→${p.b}: median Δh ${p.medianDhM.toFixed(2)}m over ${p.n} samples (not applied — tiles are continuous by the shared anchor; a floor step here is an extraction error of one chunk)`, { ...p, level });
      }
      const grounds = chunkGrounds.filter(Boolean);
      if (grounds.length) {
        // ownershipFeatherM: the .ter takes the OWNER chunk's floor (Voronoi by
        // chunk centre), crossing over within ±6 m of the bisector — the same
        // line the worker clipped each chunk's mesh on.
        const cg = compositeRouteGround(grounds, combined, { featherM: 15, ownershipFeatherM: 6 });
        combinedGround = { heightMap: cg.heightMap, groundMax: cg.groundMax };
        console.info(
          `[routeLevel] route .ter ground: ${(cg.coverage * 100).toFixed(0)}% of the grid from tiles, ` +
          `${cg.groundMin.toFixed(1)}–${cg.groundMax.toFixed(1)}m (${grounds.length}/${total} chunks)`,
        );

        // ── Overlap-disagreement probe (turbolog `ground-overlap`) ────────────
        // Where two chunks overlap, the .ter blends BOTH extracted grounds while
        // the visible tiles are ONE chunk's mesh. If the two independent bakes
        // disagree HORIZONTALLY, the drive surface sits between them and the road
        // you see is offset from the road you drive — worst mid-route. For each
        // overlapping pair we grid-sample the overlap and find the (dx,dz) shift
        // of chunk B that best matches chunk A: a non-zero best shift = the
        // horizontal misregistration; baseline vs best |Δh| = how much it costs.
        for (let a = 0; a < grounds.length; a++) {
          for (let b = a + 1; b < grounds.length; b++) {
            const A = grounds[a], B = grounds[b];
            const west = Math.max(A.bounds.west, B.bounds.west);
            const east = Math.min(A.bounds.east, B.bounds.east);
            const south = Math.max(A.bounds.south, B.bounds.south);
            const north = Math.min(A.bounds.north, B.bounds.north);
            if (east <= west || north <= south) continue; // no overlap
            const latMid = (north + south) / 2;
            const mLngA = mPerDegLng(latMid);
            const NS = 24; // sample grid per axis
            const pts = [];
            for (let r = 0; r < NS; r++) {
              const lat = north - (r / (NS - 1)) * (north - south);
              for (let c = 0; c < NS; c++) {
                const lng = west + (c / (NS - 1)) * (east - west);
                pts.push([lat, lng, sampleHeightAt(A, lat, lng)]);
              }
            }
            const meanAbsDh = (dxM, dzM) => {
              const dLat = dzM / M_PER_DEG_LAT, dLng = dxM / mLngA;
              let s = 0, n = 0;
              for (const [lat, lng, hA] of pts) {
                const hB = sampleHeightAt(B, lat + dLat, lng + dLng);
                if (Number.isFinite(hA) && Number.isFinite(hB)) { s += Math.abs(hA - hB); n++; }
              }
              return n ? s / n : Infinity;
            };
            const baseline = meanAbsDh(0, 0);
            let best = { dx: 0, dz: 0, v: baseline };
            for (let dx = -5; dx <= 5; dx++) {
              for (let dz = -5; dz <= 5; dz++) {
                if (!dx && !dz) continue;
                const v = meanAbsDh(dx, dz);
                if (v < best.v) best = { dx, dz, v };
              }
            }
            const overlapM = [(east - west) * mLngA, (north - south) * M_PER_DEG_LAT];
            devLog('ground-overlap', `chunks ${a}↔${b}: baseline|Δh|=${baseline.toFixed(2)}m bestShift=[${best.dx},${best.dz}]m →|Δh|=${best.v.toFixed(2)}m`, {
              pair: [a, b],
              overlapSizeM: overlapM.map((x) => +x.toFixed(1)),
              baselineMeanAbsDhM: +baseline.toFixed(3),
              bestShiftM: { east: best.dx, north: best.dz },
              bestMeanAbsDhM: +best.v.toFixed(3),
              improvement: +(baseline - best.v).toFixed(3),
            });
          }
        }
      } else {
        console.warn('[routeLevel] tile ground requested but no chunk grounds returned — route .ter uses the DEM');
      }
    }

    const frame = computeRouteFrame(frameInputs, chunkSizeM);

    // ── Placement diagnostic (turbolog `route-placement` stream) ─────────────
    // The preview places tiles via computeRouteFrame (anchor = chunk 0, per-chunk
    // scale 1/upm) and is visually correct; the BeamNG export places them via
    // pieces[i].east/north (anchor = combinedCenter) + the sidecar DAE (scale
    // s = chunkSizeM/sceneSize). This logs BOTH per chunk so their divergence —
    // the source of the .ter↔tiles shift seen in BeamNG — is directly readable.
    const anchor0 = frame.anchor; // chunk 0 centre (preview origin)
    devLog('route-placement', `route summary: ${total} chunks, chunkSizeM=${chunkSizeM}`, {
      total,
      chunkSizeM,
      daeSceneSize: 100, // assembleGoogleTilesExport default → s = chunkSizeM/100
      daeScale: chunkSizeM / 100,
      combinedCenter,
      previewAnchorChunk0: anchor0,
      combinedBounds: combined.bounds,
      combinedWidthPx: combined.width,
      combinedMetersPerPixel: combined.metersPerPixel,
      combinedMinHeight: combined.minHeight,
      terGroundActive: !!combinedGround,
    });
    for (let i = 0; i < total; i++) {
      const p = pieces[i];
      const pl = frame.placements[i];
      const fi = frameInputs[i];
      if (!p || !pl) continue;
      // Both placements expressed as BeamNG world [X=east, Z-> north] for a direct
      // diff. Export uses combinedCenter origin; preview uses chunk-0 origin, so
      // shift the preview into the combined frame before comparing.
      const previewEastCombined = pl.translationM.x + (anchor0.lng - combinedCenter.lng) * mPerDegLng(combinedCenter.lat);
      const previewNorthCombined = -pl.translationM.z + (anchor0.lat - combinedCenter.lat) * M_PER_DEG_LAT;
      devLog('route-placement', `chunk ${i}: Δeast=${(p.east - previewEastCombined).toFixed(2)}m Δnorth=${(p.north - previewNorthCombined).toFixed(2)}m`, {
        chunk: i,
        chunkCenter: fi?.center,
        unitsPerMeter: fi?.unitsPerMeter,
        export: { east: p.east, north: p.north, baseUp: p.baseUp },
        previewRaw: { x: pl.translationM.x, y: pl.translationM.y, z: pl.translationM.z, scale: pl.scale },
        previewInCombinedFrame: { east: previewEastCombined, north: previewNorthCombined },
        deltaM: {
          east: p.east - previewEastCombined,
          north: p.north - previewNorthCombined,
        },
      });
    }

    const previewChunks = chunks.map((c, i) => ({
      index: i,
      blob: previewBlobs[i],
      placement: frame.placements[i],
      // For the route preview's LIVE ground extraction + profile carve: bounds
      // (→ upm), datum, and the chunk's OSM roads (captured pre-release).
      bounds: chunks[i].bounds,
      minHeight: frameInputs[i]?.minHeight ?? 0,
      osmRoads: frameInputs[i]?.osmRoads ?? [],
      // The worker's own floor (extracted + carved, exactly as the .ter
      // composite consumed it). Without it the preview falls back to a live
      // re-extraction whose uncovered cells sat at the chunk DATUM: chunks with
      // different datums then showed metre-scale steps that never existed in
      // the exported .ter.
      ground: rawChunkGrounds[i]
        ? { heightMap: rawChunkGrounds[i].heightMap, coveredMask: rawChunkGrounds[i].coverage ?? null, width: rawChunkGrounds[i].width, height: rawChunkGrounds[i].height, minHeight: rawChunkGrounds[i].minHeight }
        : null,
    }));

    asm = { key, combined, combinedGround, combinedCenter, frame, pieces, previewChunks };
    _routeAsm = asm;
  } else {
    for (let i = 0; i < total; i++) progress.setPhase(i, 'done');
    announce('Reusing fetched terrain + baked tiles');
  }

  // 4) Place tiles (z-offset → TSStatic Z) and build the level. Spawn at the
  //    ROUTE START (chunk 0) so the player lands on the corridor.
  announce('Building BeamNG level');
  // Date AND time — every export gets a unique level name, so BeamNG can never
  // serve a stale cached level for a re-export of the same route.
  const date = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const placedPieces = asm.pieces.map((p) => ({
    ...p,
    position: [p.east, p.north, Math.round((p.baseUp + zOffsetM + TILE_RENDER_BIAS_M) * 100) / 100],
  }));
  // Drive on the tile-extracted ground when present (keep combined.minHeight datum).
  const driveTerrain = asm.combinedGround
    ? {
      ...asm.combined,
      heightMap: asm.combinedGround.heightMap,
      maxHeight: Math.max(asm.combined.maxHeight, asm.combinedGround.groundMax),
    }
    : asm.combined;
  const res = await exportBeamNGLevel(driveTerrain, chunks[0].center, {
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
