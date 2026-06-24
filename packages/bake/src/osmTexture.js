/** @layer io */
// OSM → satellite/vector texture generation for the BeamNG terrain base
// (refactor doc 06 step 6). The pure classification / lane inference / geometry
// live under osm/* (core); the canvas drawing lives in osm/{roadDraw,featureRender}
// (io). This file is the thin public entry: the three canvas texture builders.
import { createWGS84ToLocal } from '@mapng/geo';
import { getFeatureCategory } from "./osm/osmColors.js";
import { renderFeaturesToCanvas, createNoisePattern } from "./osm/featureRender.js";

// Re-export so existing consumers (`@mapng/bake`, `@mapng/bake/osmTexture`) keep
// importing getFeatureCategory from here.
export { getFeatureCategory };

export const generateOSMTexture = async (terrainData, options = {}) => {
  const onProgress = options.onProgress;
  onProgress?.("Baking procedural noise...");
  // Cap texture at 8192px max to avoid excessive RGBA buffers.
  const MAX_TEX_SIZE = 8192;
  const requestedSize = Number(options.outputSize || terrainData.width || 1024);
  const targetSize = Math.max(1, Math.min(MAX_TEX_SIZE, Math.floor(requestedSize)));
  const SCALE_FACTOR = targetSize / Math.max(1, terrainData.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(terrainData.width * SCALE_FACTOR));
  canvas.height = Math.max(1, Math.round(terrainData.height * SCALE_FACTOR));
  console.log(`[OSM Texture] Generating OSM texture ${canvas.width}x${canvas.height} (${terrainData.osmFeatures?.length ?? 0} features)`);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");

  const centerLat = (terrainData.bounds.north + terrainData.bounds.south) / 2;
  const centerLng = (terrainData.bounds.east + terrainData.bounds.west) / 2;
  const toMetric = createWGS84ToLocal(centerLat, centerLng);
  const halfW = terrainData.width / 2,
    halfH = terrainData.height / 2;

  const toPixel = (lat, lng) => {
    const [lx, ly] = toMetric.forward([lng, lat]);
    return { x: (lx + halfW) * SCALE_FACTOR, y: (halfH - ly) * SCALE_FACTOR };
  };

  // Use noise pattern for background instead of solid color
  const noisePattern = ctx.createPattern(
    createNoisePattern(options.baseColor),
    "repeat",
  );
  ctx.fillStyle = noisePattern;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  onProgress?.("Drawing vector maps (roads, buildings, landuse)...");
  renderFeaturesToCanvas(
    ctx,
    terrainData.osmFeatures,
    toPixel,
    SCALE_FACTOR,
    options,
  );

  const blob = await new Promise((r) =>
    canvas.toBlob((b) => r(b || null), "image/png"),
  );
  if (!blob) console.warn("[OSM Texture] canvas.toBlob() returned null — canvas may be tainted or too large");
  const url = blob ? URL.createObjectURL(blob) : "";
  console.log(`[OSM Texture] Done — blob=${blob ? `${(blob.size / 1024).toFixed(0)} KB` : "null"}, url=${url ? "ok" : "empty"}`);
  return { url, canvas, blob };
};

export const generateHybridTexture = async (terrainData, options = {}) => {
  const onProgress = options.onProgress;
  onProgress?.("Blending satellite imagery with vector overlays...");
  const MAX_TEX_SIZE = 8192;
  const requestedSize = Number(options.outputSize || terrainData.width || 1024);
  const targetSize = Math.max(1, Math.min(MAX_TEX_SIZE, Math.floor(requestedSize)));
  const SCALE_FACTOR = targetSize / Math.max(1, terrainData.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(terrainData.width * SCALE_FACTOR));
  canvas.height = Math.max(1, Math.round(terrainData.height * SCALE_FACTOR));
  console.log(`[Hybrid Texture] Generating hybrid texture ${canvas.width}x${canvas.height}`);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");

  // Background: Satellite Image
  if (terrainData.satelliteTextureUrl) {
    const img = new Image();
    img.src = terrainData.satelliteTextureUrl;
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = (e) => {
        console.warn("[Hybrid Texture] Failed to load satellite image:", e?.message || e);
        resolve(false);
      };
    });
    if (loaded && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    } else {
      console.warn("[Hybrid Texture] Satellite image not drawable — falling back to black background");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  } else {
    console.warn("[Hybrid Texture] No satelliteTextureUrl — using black background");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  renderRoadOverlayOnCanvas(canvas, terrainData, {
    ...options,
    alpha: 1.0,
  });

  const blob = await new Promise((r) =>
    canvas.toBlob((b) => r(b || null), "image/png"),
  );
  if (!blob) console.warn("[Hybrid Texture] canvas.toBlob() returned null — canvas may be tainted or too large");
  const url = blob ? URL.createObjectURL(blob) : "";
  console.log(`[Hybrid Texture] Done — blob=${blob ? `${(blob.size / 1024).toFixed(0)} KB` : "null"}, url=${url ? "ok" : "empty"}`);
  return { url, canvas, blob };
};

export function renderRoadOverlayOnCanvas(canvas, terrainData, options = {}) {
  if (!canvas || !terrainData?.bounds || !terrainData?.osmFeatures?.length) return canvas;

  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const scaleFactor = canvas.width / Math.max(1, terrainData.width);
  const centerLat = (terrainData.bounds.north + terrainData.bounds.south) / 2;
  const centerLng = (terrainData.bounds.east + terrainData.bounds.west) / 2;
  const toMetric = createWGS84ToLocal(centerLat, centerLng);
  const halfW = terrainData.width / 2;
  const halfH = terrainData.height / 2;

  const toPixel = (lat, lng) => {
    const [lx, ly] = toMetric.forward([lng, lat]);
    return { x: (lx + halfW) * scaleFactor, y: (halfH - ly) * scaleFactor };
  };

  const roadFeatures = terrainData.osmFeatures.filter(
    (f) => f.type === "road" || f.type === "bridge_infra",
  );

  renderFeaturesToCanvas(ctx, roadFeatures, toPixel, scaleFactor, {
    ...options,
    alpha: options.alpha ?? 1.0,
  });

  return canvas;
}
