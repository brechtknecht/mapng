// Credential-aware auth for Google Photorealistic 3D Tiles.
//
// The same VITE_GOOGLE_MAPS_API_KEY value may carry EITHER:
//  - a Google Maps Platform API key ("AIza…") used directly, OR
//  - a Cesium ion access token (a JWT, "eyJ…").
//
// Why the Cesium path exists: since 8 July 2025 Google blocks Photorealistic
// 3D Tiles for EEA-billed projects with HTTP 403 (see
// https://developers.google.com/maps/comms/eea/map-tiles). Cesium ion serves
// the same tiles under its own non-EEA Google credentials.
//
// Key insight: ion's endpoint for the Google asset returns the SAME Google
// tileset URL (tile.googleapis.com) with ion's own Google API key embedded.
// So we resolve that key once and then drive everything through the ordinary
// GoogleCloudAuthPlugin — identical root, session handling, tile content URLs,
// and LOD refinement to a direct Google key. We deliberately do NOT use
// CesiumIonAuthPlugin: it registers a nested GoogleCloudAuthPlugin with
// useRecommendedSettings:true *mid-load*, which resets errorTarget to 40 and
// collapses the bake's LOD (much lower quality than our errorTarget=5).

// Cesium ion asset id for "Google Photorealistic 3D Tiles".
export const GOOGLE_PHOTOREALISTIC_ION_ASSET = 2275207;

/**
 * Cesium ion access tokens are JWTs: three base64url segments separated by
 * dots, always starting "eyJ". Google Maps keys are "AIza…" with no dots.
 */
export function isCesiumIonToken(credential) {
  return typeof credential === 'string'
    && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(credential.trim());
}

/**
 * Resolve a Cesium ion token to the underlying Google Maps API key ion uses
 * for the Photorealistic 3D Tiles asset. Throws with an actionable message on
 * failure (also serves as the Cesium-path preflight).
 */
async function resolveCesiumGoogleKey(token) {
  const url = `https://api.cesium.com/v1/assets/${GOOGLE_PHOTOREALISTIC_ION_ASSET}/endpoint?access_token=${token.trim()}`;
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.message ?? ''; } catch (_) { /* noop */ }
    throw new Error(
      `Cesium ion rejected the token (HTTP ${res.status}${detail ? `: ${detail}` : ''}). ` +
      'Check the token is valid and has access to the Google Photorealistic 3D Tiles asset ' +
      `(${GOOGLE_PHOTOREALISTIC_ION_ASSET}).`,
    );
  }
  const json = await res.json();
  const optionUrl = json?.options?.url;
  if (!optionUrl) {
    throw new Error('Cesium ion endpoint returned no Google tileset URL (unexpected asset type).');
  }
  const key = new URL(optionUrl).searchParams.get('key');
  if (!key) throw new Error('Cesium ion Google tileset URL carried no API key.');
  return key;
}

/**
 * Register the GoogleCloudAuthPlugin on a TilesRenderer for `credential`,
 * resolving a Cesium ion token to its embedded Google key first if needed.
 * The plugin class is injected because the import path differs by environment
 * (browser: '3d-tiles-renderer'; headless Node: deep import via
 * headlessTilesEnv.mjs).
 *
 * useRecommendedSettings:false — the bake sets its own errorTarget and queue
 * budgets; the plugin's "recommended" errorTarget=40 would otherwise collapse
 * the tile LOD.
 *
 * @returns the registered plugin instance (so callers can wrap its fetchData).
 */
export async function registerTilesAuth(tiles, credential, { GoogleCloudAuthPlugin }) {
  const apiKey = isCesiumIonToken(credential)
    ? await resolveCesiumGoogleKey(credential)
    : credential;
  const plugin = new GoogleCloudAuthPlugin({ apiToken: apiKey, useRecommendedSettings: false });
  tiles.registerPlugin(plugin);
  return plugin;
}

/**
 * Preflight the credential before a long bake so a bad key/token fails fast
 * with the real upstream error instead of polling 0 tiles until the timeout.
 */
export async function preflightTilesAuth(credential) {
  if (isCesiumIonToken(credential)) {
    await resolveCesiumGoogleKey(credential);
    return;
  }

  const res = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${credential}`);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch (_) { /* noop */ }
    throw new Error(
      `Google Map Tiles API rejected the request (HTTP ${res.status}${detail ? `: ${detail}` : ''}). ` +
      'Check that the Map Tiles API is enabled for the project, the API key allows it, and billing is active. ' +
      'Note: EEA-billed projects are blocked from Photorealistic 3D Tiles (HTTP 403) — use a Cesium ion token instead.',
    );
  }
}
