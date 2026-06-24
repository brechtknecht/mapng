/** @layer core */
// Web Mercator projection + tile-grid math and the shared fetch-bounds helpers.
// Source of truth for how lat/lng map to pixels/tiles during terrain fetching.
import { createLocalToWGS84 } from '@mapng/geo';

// Constants
export const TILE_SIZE = 256;
export const TERRAIN_ZOOM = 15; // Fixed high detail zoom level for Terrain
export const SATELLITE_ZOOM = 17; // Higher detail zoom level for Satellite (approx 1.2m/px)
export const TILE_API_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
export const SATELLITE_API_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";

// Helper to normalize longitude to -180 to 180
export const normalizeLng = (lng) => {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
};

export const unwrapLngNearRef = (lng, refLng) => {
  let out = lng;
  let delta = out - refLng;
  while (delta > 180) {
    out -= 360;
    delta = out - refLng;
  }
  while (delta < -180) {
    out += 360;
    delta = out - refLng;
  }
  return out;
};

/**
 * Compute fetch bounds from the same local metric projection used by resampling.
 * This avoids meters/degree approximation drift, especially at higher latitudes.
 */
export const computeMetricFetchBounds = (normalizedCenter, width, height, padMeters = 4) => {
  const toWGS84 = createLocalToWGS84(normalizedCenter.lat, normalizedCenter.lng);
  const halfWidth = width / 2 + padMeters;
  const halfHeight = height / 2 + padMeters;

  const corners = [
    toWGS84.forward([-halfWidth, halfHeight]),
    toWGS84.forward([halfWidth, halfHeight]),
    toWGS84.forward([-halfWidth, -halfHeight]),
    toWGS84.forward([halfWidth, -halfHeight]),
  ];

  const lats = corners.map(([, lat]) => lat);
  const unwrappedLngs = corners.map(([lng]) => unwrapLngNearRef(lng, normalizedCenter.lng));

  return {
    north: Math.max(...lats),
    south: Math.min(...lats),
    east: normalizeLng(Math.max(...unwrappedLngs)),
    west: normalizeLng(Math.min(...unwrappedLngs)),
  };
};

// Math Helpers for Web Mercator Projection (Source of Truth for Fetching)
const MAX_LATITUDE = 85.05112878;

export const project = (lat, lng, zoom) => {
  const d = Math.PI / 180;
  const max = MAX_LATITUDE;
  const latClamped = Math.max(Math.min(max, lat), -max);
  const sin = Math.sin(latClamped * d);

  const z = TILE_SIZE * Math.pow(2, zoom);

  const x = (z * (lng + 180)) / 360;
  const y = z * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI);

  return { x, y };
};
