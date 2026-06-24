/** @layer io */
// Stitch global Terrarium (Z15 elevation fallback) + Esri satellite (Z17) tiles
// into canvases, then expose bilinear height/colour samplers + the serializable
// sampler payloads the off-thread resampler consumes. Extracted verbatim from
// fetchTerrainData's "Prepare Samplers / global tiles" block.
import {
  project,
  TILE_SIZE,
  TERRAIN_ZOOM,
  SATELLITE_ZOOM,
  TILE_API_URL,
  SATELLITE_API_URL,
} from './mercatorTiles.js';
import { NO_DATA_VALUE } from './heightDecode.js';
import { pMap } from './pMap.js';
import { loadTerrainTileCached, loadSatelliteTileCached } from './tileLoaders.js';

/**
 * Fetch + stitch the global tile canvases for fetchTerrainData and build the
 * height/colour samplers plus the worker-bound sampler payloads.
 *
 * @returns {{ heightSampler, colorSampler, fallbackSamplerData, imageSamplerData }}
 */
export const fetchGlobalTileSamplers = async ({
  fetchBounds,
  rawData,
  sourceGeoTiffs,
  gpxzChunkFailures,
  globalTileConcurrency,
  onProgress,
  signal,
}) => {
  // 3. Prepare Samplers
  let heightSampler = null;
  let colorSampler = null;

  // We always need global tiles for Satellite Texture, and as fallback for Height
  onProgress?.("Fetching global tiles...");

  // Calculate tile range covering the fetchBounds for Terrain (Z15)
  const nw = project(fetchBounds.north, fetchBounds.west, TERRAIN_ZOOM);
  const se = project(fetchBounds.south, fetchBounds.east, TERRAIN_ZOOM);

  const minTileX = Math.floor(nw.x / TILE_SIZE);
  const minTileY = Math.floor(nw.y / TILE_SIZE);
  const maxTileX = Math.floor(se.x / TILE_SIZE);
  const maxTileY = Math.floor(se.y / TILE_SIZE);

  // Calculate tile range covering the fetchBounds for Satellite (Z17)
  const satNw = project(fetchBounds.north, fetchBounds.west, SATELLITE_ZOOM);
  const satSe = project(fetchBounds.south, fetchBounds.east, SATELLITE_ZOOM);

  const satMinTileX = Math.floor(satNw.x / TILE_SIZE);
  const satMinTileY = Math.floor(satNw.y / TILE_SIZE);
  const satMaxTileX = Math.floor(satSe.x / TILE_SIZE);
  const satMaxTileY = Math.floor(satSe.y / TILE_SIZE);

  // Create canvases to hold the stitched tiles
  const tileCountX = maxTileX - minTileX + 1;
  const tileCountY = maxTileY - minTileY + 1;
  const canvasWidth = tileCountX * TILE_SIZE;
  const canvasHeight = tileCountY * TILE_SIZE;

  const satTileCountX = satMaxTileX - satMinTileX + 1;
  const satTileCountY = satMaxTileY - satMinTileY + 1;
  const satCanvasWidth = satTileCountX * TILE_SIZE;
  const satCanvasHeight = satTileCountY * TILE_SIZE;

  const terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = canvasWidth;
  terrainCanvas.height = canvasHeight;
  const tCtx = terrainCanvas.getContext("2d", { willReadFrequently: true });

  if (!tCtx) throw new Error("Failed to create terrain canvas context");

  // Build satellite pixel data into a CPU-side buffer rather than a GPU-backed
  // canvas. A large canvas (e.g. 18432x18176 at 16k) can have its GPU backing
  // store silently zeroed under memory pressure, causing getImageData to return
  // all-transparent pixels even when every tile loaded successfully.
  // Using a plain Uint8ClampedArray eliminates the GPU round-trip entirely and
  // halves peak memory (no separate getImageData copy needed).
  const satBuffer = new Uint8ClampedArray(satCanvasWidth * satCanvasHeight * 4);
  // Default alpha=255 so any gap (missed tile) reads as opaque rather than transparent
  const satBuffer32 = new Uint32Array(satBuffer.buffer);
  satBuffer32.fill(0xFF000000); // little-endian RGBA: (0,0,0,255) opaque black

  // Reuse a single 256×256 scratch canvas to extract each satellite tile's pixels.
  // JS is single-threaded so concurrent pMap callbacks never actually overlap;
  // clearing+drawing+reading is always atomic within one event-loop turn.
  const tempSatCanvas = document.createElement("canvas");
  tempSatCanvas.width = TILE_SIZE;
  tempSatCanvas.height = TILE_SIZE;
  const tempSatCtx = tempSatCanvas.getContext("2d", { willReadFrequently: true });
  if (!tempSatCtx) throw new Error("Failed to create satellite scratch canvas context");

  // Fetch tiles

  const requests = [];

  // Terrain Requests
  // Always fetch global tiles to serve as fallback for holes in high-res data
  if (!sourceGeoTiffs || sourceGeoTiffs.source !== "gpxz" || gpxzChunkFailures) {
    for (let tx = minTileX; tx <= maxTileX; tx++) {
      for (let ty = minTileY; ty <= maxTileY; ty++) {
        requests.push({ tx, ty, type: "terrain" });
      }
    }
  }

  // Satellite Requests
  for (let tx = satMinTileX; tx <= satMaxTileX; tx++) {
    for (let ty = satMinTileY; ty <= satMaxTileY; ty++) {
      requests.push({ tx, ty, type: "satellite" });
    }
  }

  onProgress?.(
    `Downloading ${requests.filter((r) => r.type === "terrain").length} terrain and ${requests.filter((r) => r.type === "satellite").length} satellite tiles (${Math.max(1, Number(globalTileConcurrency || 20))}x concurrent)...`,
  );

  let completed = 0;
  let terrainTilesRequested = 0;
  let terrainTilesSucceeded = 0;
  let terrainTilesFailed = 0;
  let satTilesSucceeded = 0;
  let satTilesFailed = 0;
  await pMap(
    requests,
    async ({ tx, ty, type }) => {
      completed++;
      if (completed % 10 === 0 || completed === requests.length) {
        onProgress?.(
          `Downloaded ${completed}/${requests.length} global tiles...`,
        );
      }
      if (type === "terrain") {
        terrainTilesRequested++;
        const drawX = (tx - minTileX) * TILE_SIZE;
        const drawY = (ty - minTileY) * TILE_SIZE;

        const numTiles = Math.pow(2, TERRAIN_ZOOM);
        const wrappedTx = ((tx % numTiles) + numTiles) % numTiles;

        const terrainUrl = `${TILE_API_URL}/${TERRAIN_ZOOM}/${wrappedTx}/${ty}.png`;
        const tImg = await loadTerrainTileCached(terrainUrl, TERRAIN_ZOOM, wrappedTx, ty, signal);
        if (tImg) {
          terrainTilesSucceeded++;
          tCtx.drawImage(tImg, drawX, drawY);
        } else {
          terrainTilesFailed++;
          tCtx.fillStyle = "black";
          tCtx.fillRect(drawX, drawY, TILE_SIZE, TILE_SIZE);
        }
      } else {
        const drawX = (tx - satMinTileX) * TILE_SIZE;
        const drawY = (ty - satMinTileY) * TILE_SIZE;

        const numTiles = Math.pow(2, SATELLITE_ZOOM);
        const wrappedTx = ((tx % numTiles) + numTiles) % numTiles;

        const satUrl = `${SATELLITE_API_URL}/${SATELLITE_ZOOM}/${ty}/${wrappedTx}`;
        const sImg = await loadSatelliteTileCached(satUrl, SATELLITE_ZOOM, wrappedTx, ty, signal);
        if (sImg) {
          satTilesSucceeded++;
          tempSatCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
          tempSatCtx.drawImage(sImg, 0, 0);
          const tilePixels = tempSatCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
          for (let row = 0; row < TILE_SIZE; row++) {
            const srcOff = row * TILE_SIZE * 4;
            const dstOff = ((drawY + row) * satCanvasWidth + drawX) * 4;
            satBuffer.set(tilePixels.subarray(srcOff, srcOff + TILE_SIZE * 4), dstOff);
          }
        } else {
          satTilesFailed++;
          // Fallback: already initialized to opaque black; write dark gray for visibility
          for (let row = 0; row < TILE_SIZE; row++) {
            const dstOff = ((drawY + row) * satCanvasWidth + drawX) * 4;
            for (let col = 0; col < TILE_SIZE; col++) {
              satBuffer[dstOff + col * 4]     = 0x1a;
              satBuffer[dstOff + col * 4 + 1] = 0x1a;
              satBuffer[dstOff + col * 4 + 2] = 0x1a;
              // alpha already 255 from initialization
            }
          }
        }
      }
    },
    Math.max(1, Number(globalTileConcurrency || 20)),
    signal,
  );
  console.log(`[Sat Tiles] ${satTilesSucceeded} ok / ${satTilesFailed} failed — canvas ${satCanvasWidth}x${satCanvasHeight}`);

  if (!rawData && terrainTilesRequested > 0 && terrainTilesSucceeded === 0) {
    throw new Error(
      `Failed to download elevation terrain tiles (${terrainTilesFailed}/${terrainTilesRequested} failed). Please retry or switch elevation source.`
    );
  }

  // Create Samplers from Canvases
  // Always create the terrain data image so we have a fallback sampler
  const terrainDataImg = tCtx.getImageData(0, 0, canvasWidth, canvasHeight);
  // satDataImg uses the CPU-side buffer directly — no GPU readback needed.
  const satDataImg = { data: satBuffer, width: satCanvasWidth, height: satCanvasHeight };
  {
    const d = satDataImg.data;
    const sample = (px, py) => {
      const idx = (py * satCanvasWidth + px) * 4;
      return `(${d[idx]},${d[idx+1]},${d[idx+2]},${d[idx+3]})`;
    };
    const cx = satCanvasWidth >> 1, cy = satCanvasHeight >> 1;
    console.log(`[Sat Canvas] ${satCanvasWidth}x${satCanvasHeight} — center:${sample(cx,cy)} TL:${sample(0,0)} TR:${sample(satCanvasWidth-1,0)} BL:${sample(0,satCanvasHeight-1)} BR:${sample(satCanvasWidth-1,satCanvasHeight-1)}`);
  }

  // Helper to get pixel from Mercator Canvas
  const getMercatorPixel = (lat, lng, data, zoom, minTx, minTy) => {
    const p = project(lat, lng, zoom);
    const localX = p.x - minTx * TILE_SIZE;
    const localY = p.y - minTy * TILE_SIZE;

    const x = Math.floor(localX);
    const y = Math.floor(localY);

    if (x < 0 || x >= data.width || y < 0 || y >= data.height) return null;

    const i = (y * data.width + x) * 4;
    return {
      r: data.data[i],
      g: data.data[i + 1],
      b: data.data[i + 2],
      a: data.data[i + 3],
    };
  };

  if (terrainDataImg) {
    heightSampler = (lat, lng) => {
      // Bilinear Interpolation for smoother terrain
      const p = project(lat, lng, TERRAIN_ZOOM);
      const localX = p.x - minTileX * TILE_SIZE;
      const localY = p.y - minTileY * TILE_SIZE;

      const x0 = Math.floor(localX);
      const y0 = Math.floor(localY);
      const dx = localX - x0;
      const dy = localY - y0;

      const w = terrainDataImg.width;
      const h = terrainDataImg.height;

      const getH = (x, y) => {
        const cx = Math.max(0, Math.min(w - 1, x));
        const cy = Math.max(0, Math.min(h - 1, y));
        const i = (cy * w + cx) * 4;
        const r = terrainDataImg.data[i];
        const g = terrainDataImg.data[i + 1];
        const b = terrainDataImg.data[i + 2];
        // Mapzen encoding with nodata guard (0,0,0 → -32768)
        const h = r * 256 + g + b / 256 - 32768;
        return h <= -32760 ? NO_DATA_VALUE : h;
      };

      const h00 = getH(x0, y0);
      const h10 = getH(x0 + 1, y0);
      const h01 = getH(x0, y0 + 1);
      const h11 = getH(x0 + 1, y0 + 1);

      const top = (1 - dx) * h00 + dx * h10;
      const bottom = (1 - dx) * h01 + dx * h11;
      return (1 - dy) * top + dy * bottom;
    };
  }

  colorSampler = (lat, lng) => {
    const px = getMercatorPixel(
      lat,
      lng,
      satDataImg,
      SATELLITE_ZOOM,
      satMinTileX,
      satMinTileY,
    );
    if (!px) return { r: 0, g: 0, b: 0, a: 255 };
    return px;
  };

  // Prepare serializable fallback sampler data for the web worker
  const fallbackSamplerData = terrainDataImg ? {
    pixels: terrainDataImg.data,
    width: terrainDataImg.width,
    height: terrainDataImg.height,
    zoom: TERRAIN_ZOOM,
    minTileX,
    minTileY,
  } : null;

  const imageSamplerData = {
    pixels: satDataImg.data,
    width: satDataImg.width,
    height: satDataImg.height,
    zoom: SATELLITE_ZOOM,
    minTileX: satMinTileX,
    minTileY: satMinTileY,
  };

  return { heightSampler, colorSampler, fallbackSamplerData, imageSamplerData };
};
