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
import { exportGoogleTilesViaSidecar, getGoogleTilesZOffset } from './google3dTiles';
import { computeUnitsPerMeter } from './googleBakeCore';
import { getCorridorTier, resolveChunkSizeM } from './routeCorridor';
import { computeRouteFrame } from './routeStitch';
import { buildCombinedRouteTerrain } from './routeTerrainComposite';

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
  } = opts;
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('exportRouteAsBeamNGLevel: no chunks');
  if (!googleApiKey) throw new Error('exportRouteAsBeamNGLevel: missing tiles credential');

  const tier = getCorridorTier(tierId);
  const chunkSizeM = resolveChunkSizeM(tierId, opts.chunkSizeM);
  const total = chunks.length;
  const report = (chunk, phase, detail) => onProgress?.({ chunk, total, phase, detail });
  // z-offset is applied as the tile TSStatic POSITION (not baked into the tile
  // geometry), so changing it never invalidates the cached assembly.
  const zOffsetM = Number.isFinite(opts.zOffsetM) ? opts.zOffsetM : getGoogleTilesZOffset();

  const key = asmKey(chunks, tierId, chunkSizeM, elevationSource, gpxzApiKey, tier.googleQuality, baseTexture);
  let asm = _routeAsm && _routeAsm.key === key ? _routeAsm : null;

  if (!asm) {
    // ---- EXPENSIVE pipeline (runs once per route/settings) ------------------
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
    let terrainDone = 0;
    report(0, 'terrain', `Fetching terrain 0/${total}`);
    let nextChunk = 0;
    const terrainWorker = async () => {
      while (nextChunk < total) {
        const i = nextChunk++;
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        terrains[i] = await fetchTerrainData(
          chunks[i].center, chunkSizeM, includeOSM, useUSGS, useGPXZ, useKRON86, gpxzApiKey,
          undefined, undefined, signal, genOpts,
        );
        terrainDone++;
        report(terrainDone, 'terrain', `Fetching terrain ${terrainDone}/${total}`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(terrainConcurrency, total) }, terrainWorker),
    );

    // 2) One composited terrain + texture spanning the route bbox.
    report(total, 'terrain', 'Compositing route terrain');
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
    const pieces = [];
    const previewBlobs = new Array(total).fill(null);
    // One route-wide vertical anchor for the Google tiles, captured from chunk 0
    // and reused by every later chunk (.dae) AND every preview GLB. Each chunk
    // would otherwise re-seat Google's ground onto its OWN centre's DEM height,
    // so neighbours disagree at the shared seam and the next chunk floats.
    let sharedGroundOffsetM = null;
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      report(i, 'tiles', `Assembling tiles ${i + 1}/${total}`);
      const exported = await exportGoogleTilesViaSidecar(
        terrains[i],
        {
          apiKey: googleApiKey,
          quality: tier.googleQuality,
          corridorSegment: chunks[i].segment,
          corridorHalfWidthM: tier.halfWidthM,
          // Chunk 0 bakes with its natural anchor and reports it back; chunks
          // 1..N seat on that same value so the rail stays continuous.
          ...(sharedGroundOffsetM != null ? { sharedGroundOffsetM } : {}),
          onProgress: (p) => report(i, 'tiles', `Tiles ${i + 1}/${total}: ${p.visible ?? 0} loaded`),
        },
        // Unique material prefix per chunk so BeamNG's global material resolution
        // doesn't cross-wire textures. zOffsetM:0 — z-offset is positional.
        { worldSize: chunkSizeM, zOffsetM: 0, materialPrefix: `c${pad2(i)}_` },
      );
      if (i === 0 && Number.isFinite(exported?.groundOffsetM)) {
        sharedGroundOffsetM = exported.groundOffsetM;
        console.info(`[routeLevel] shared Google vertical anchor = ${sharedGroundOffsetM.toFixed(2)}m (from chunk 0)`);
      }
      report(i, 'tiles', `Converting tiles ${i + 1}/${total} to DAE`);
      const dae = await convertGlbToDae(exported.glbPath);
      console.info(
        `[routeLevel] chunk ${i + 1}/${total}: ${exported.meshes ?? '?'} meshes, ` +
        `${(exported.materialNames ?? []).length} atlases, ${(exported.textures ?? []).length} textures, ` +
        `dae=${dae ? 'yes' : 'NO (glb fallback)'}`,
      );

      const east = (chunks[i].center.lng - combinedCenter.lng) * mLng;
      const north = (chunks[i].center.lat - combinedCenter.lat) * M_PER_DEG_LAT;
      const baseUp = (terrains[i].minHeight ?? 0) - combined.minHeight; // datum lift, no z-offset

      pieces.push({
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
      });

      // z-offset-free preview GLB (googleZOffsetM:0) — RoutePreview applies the
      // live z-offset to the tiles. Reuses the SAME cached bake (no re-bake).
      report(i, 'tiles', `Encoding preview ${i + 1}/${total}`);
      previewBlobs[i] = await exportToGLB(terrains[i], {
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
    }

    const frame = computeRouteFrame(
      chunks.map((c, i) => ({
        center: c.center,
        unitsPerMeter: computeUnitsPerMeter(terrains[i]),
        minHeight: terrains[i].minHeight,
      })),
      chunkSizeM,
    );
    const previewChunks = chunks.map((c, i) => ({
      index: i,
      blob: previewBlobs[i],
      placement: frame.placements[i],
    }));

    asm = { key, combined, combinedCenter, frame, pieces, previewChunks };
    _routeAsm = asm;
  } else {
    report(0, 'level', 'Reusing fetched terrain + baked tiles');
  }

  // 4) Place tiles (z-offset → TSStatic Z) and build the level. Spawn at the
  //    ROUTE START (chunk 0) so the player lands on the corridor.
  report(total, 'level', 'Building BeamNG level');
  const date = new Date().toISOString().slice(0, 10);
  const placedPieces = asm.pieces.map((p) => ({
    ...p,
    position: [p.east, p.north, Math.round((p.baseUp + zOffsetM) * 100) / 100],
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
    onProgress: (p) => report(total, 'level', p?.step),
  });

  const flat = res.download
    ? { url: res.download.url, jobId: res.download.jobId, filename: res.filename }
    : res;
  return { ...flat, previewChunks: asm.previewChunks, worldBoundsM: asm.frame.worldBoundsM };
}
