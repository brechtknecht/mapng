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
import { exportBeamNGLevel } from './exportBeamNGLevel';
import { exportGoogleTilesViaSidecar, getGoogleTilesZOffset } from './google3dTiles';
import { getCorridorTier, resolveChunkSizeM } from './routeCorridor';
import { buildCombinedRouteTerrain } from './routeTerrainComposite';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const pad2 = (n) => String(n).padStart(2, '0');
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * DEG) || M_PER_DEG_LAT;

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
export async function exportRouteAsBeamNGLevel(chunks, opts = {}) {
  const { tierId, googleApiKey, levelName, flavorId, onProgress, signal } = opts;
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error('exportRouteAsBeamNGLevel: no chunks');
  if (!googleApiKey) throw new Error('exportRouteAsBeamNGLevel: missing tiles credential');

  const tier = getCorridorTier(tierId);
  const chunkSizeM = resolveChunkSizeM(tierId, opts.chunkSizeM);
  const total = chunks.length;
  const report = (chunk, phase, detail) => onProgress?.({ chunk, total, phase, detail });

  // 1) Terrain per chunk (the .ter source + the exact data that resolves each
  //    chunk's bake cache key for the tile assembly below).
  const terrains = new Array(total);
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    report(i, 'terrain', `Fetching terrain ${i + 1}/${total}`);
    terrains[i] = await fetchTerrainData(
      chunks[i].center, chunkSizeM, true, false, false, false, '', undefined,
      undefined, signal,
    );
  }

  // 2) One composited terrain spanning the route bbox.
  report(total, 'terrain', 'Compositing route terrain');
  const combined = buildCombinedRouteTerrain(terrains);
  const combinedCenter = {
    lat: (combined.bounds.north + combined.bounds.south) / 2,
    lng: (combined.bounds.east + combined.bounds.west) / 2,
  };
  const mLng = mPerDegLng(combinedCenter.lat);

  // 3) Per chunk: assemble the BeamNG tile shape on the bake sidecar, convert to
  //    DAE, and compute its world placement.
  const zOffsetM = getGoogleTilesZOffset();
  const pieces = [];
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
        onProgress: (p) => report(i, 'tiles', `Tiles ${i + 1}/${total}: ${p.visible ?? 0} loaded`),
      },
      // Unique material prefix per chunk — BeamNG resolves materials globally by
      // name, so without this every chunk's google_atlas_00 collides and the
      // textures scramble across tiles.
      { worldSize: chunkSizeM, zOffsetM, materialPrefix: `c${pad2(i)}_` },
    );
    report(i, 'tiles', `Converting tiles ${i + 1}/${total} to DAE`);
    const dae = await convertGlbToDae(exported.glbPath);
    console.info(
      `[routeLevel] chunk ${i + 1}/${total}: ${exported.meshes ?? '?'} meshes, ` +
      `${(exported.materialNames ?? []).length} atlases, ${(exported.textures ?? []).length} textures, ` +
      `dae=${dae ? 'yes' : 'NO (glb fallback)'}`,
    );

    // Placement: chunk-centre offset from the combined-terrain centre, lifted so
    // the tile ground (Y=0 ⇒ chunk datum) meets the combined terrain datum.
    const east = (chunks[i].center.lng - combinedCenter.lng) * mLng;
    const north = (chunks[i].center.lat - combinedCenter.lat) * M_PER_DEG_LAT;
    const up = (terrains[i].minHeight ?? 0) - combined.minHeight;

    pieces.push({
      name: `google_tiles_${pad2(i)}`,
      daeBlob: dae,
      glbBlob: dae ? null : { fromPath: exported.glbPath, size: exported.glbBytes ?? 0 },
      textureFiles: (exported.textures ?? []).map((t) => ({
        name: t.name, ext: 'png', data: { fromPath: t.path, size: t.bytes ?? 0 },
      })),
      materialNames: exported.materialNames ?? [],
      position: [
        Math.round(east * 100) / 100,
        Math.round(north * 100) / 100,
        Math.round(up * 100) / 100,
      ],
    });
  }

  // 4) Build the level with the single-tile pipeline in route mode.
  // Spawn at the ROUTE START (chunk 0), not the bbox centre — for an L-shaped
  // route the centre sits off-corridor, leaving the player on empty filler
  // terrain with every tile beyond visibleDistance. geoToWorld maps this back to
  // chunk 0's offset, which is exactly where chunk 0's tile TSStatic sits.
  report(total, 'level', 'Building BeamNG level');
  const date = new Date().toISOString().slice(0, 10);
  const res = await exportBeamNGLevel(combined, chunks[0].center, {
    googleTilePlacements: pieces,
    levelName: levelName || `mapng_route_${date}_${total}chunks`,
    // Flavour mostly drives OSM/fence/terrain-paint materials we don't use in
    // route mode (pbrSource:'none' → plain asphalt terrain), so any valid id works.
    flavorId: flavorId || 'west_coast_usa',
    // Route tiles ARE the scenery — skip the OSM/road/foundation machinery and
    // let the composited terrain be the drive surface.
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

  // exportBeamNGLevel returns the sidecar shape { download:{url,jobId}, filename }
  // or the fallback { blob, filename }. Flatten to the { url|blob, jobId?, filename }
  // the caller's download helper expects.
  return res.download
    ? { url: res.download.url, jobId: res.download.jobId, filename: res.filename }
    : res;
}
