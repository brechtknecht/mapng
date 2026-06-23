// Google Routes API client — fetches a driving route polyline between two
// points for the route-corridor map mode.
//
// Browser CORS: the Routes API (routes.googleapis.com/directions/v2:computeRoutes)
// supports cross-origin requests with the X-Goog-Api-Key / X-Goog-FieldMask
// headers, so we can call it directly from the SPA with the same Google Maps
// Platform key used for the 3D Tiles bake (Routes API must be enabled on the
// project). If a deployment needs to hide the key or work around CORS, set
// VITE_ROUTES_PROXY_URL to a same-origin proxy that forwards to the endpoint.

const ROUTES_ENDPOINT =
  import.meta.env?.VITE_ROUTES_PROXY_URL ||
  'https://routes.googleapis.com/directions/v2:computeRoutes';

// Resolve the credential for the Routes API.
//   1. explicit arg, else
//   2. VITE_GOOGLE_ROUTES_API_KEY (dedicated Routes key), else
//   3. VITE_GOOGLE_MAPS_API_KEY — but ONLY if it's a Google key ("AIza…").
// The shared maps var may hold a Cesium ion token ("eyJ…") used to bypass the
// EEA block on 3D Tiles; that token cannot authenticate Routes, so we ignore it.
function resolveRoutesKey(explicit) {
  if (explicit) return explicit;
  const routesKey = import.meta.env?.VITE_GOOGLE_ROUTES_API_KEY;
  if (routesKey) return routesKey;
  const mapsKey = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY;
  if (mapsKey && mapsKey.startsWith('AIza')) return mapsKey;
  return null;
}

/**
 * Decode a Google "encoded polyline" string (precision 1e-5) into points.
 * Reference algorithm — https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 * @param {string} encoded
 * @returns {{lat:number, lng:number}[]}
 */
export function decodePolyline(encoded) {
  if (!encoded) return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;

  while (index < len) {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return points;
}

/**
 * Fetch a route between start and end.
 * @param {object} opts
 * @param {{lat:number,lng:number}} opts.start
 * @param {{lat:number,lng:number}} opts.end
 * @param {string} [opts.apiKey] defaults to VITE_GOOGLE_MAPS_API_KEY
 * @param {AbortSignal} [opts.signal]
 * @param {'DRIVE'|'WALK'|'BICYCLE'|'TWO_WHEELER'} [opts.travelMode='DRIVE']
 * @returns {Promise<{polyline:{lat:number,lng:number}[], distanceMeters:number, duration:string|null}>}
 */
export async function fetchRoute({ start, end, apiKey, signal, travelMode = 'DRIVE' } = {}) {
  if (!start || !end) throw new Error('fetchRoute: start and end are required');
  const key = resolveRoutesKey(apiKey);
  if (!key) {
    const maps = import.meta.env?.VITE_GOOGLE_MAPS_API_KEY;
    const ionHint =
      maps && !maps.startsWith('AIza')
        ? ' Your VITE_GOOGLE_MAPS_API_KEY looks like a Cesium ion token, which the Routes API cannot use.'
        : '';
    throw new Error(
      'Routes needs a Google Maps API key (AIza…) with the Routes API enabled. ' +
        'Set VITE_GOOGLE_ROUTES_API_KEY in .env.local.' +
        ionHint
    );
  }

  const body = {
    origin: { location: { latLng: { latitude: start.lat, longitude: start.lng } } },
    destination: { location: { latLng: { latitude: end.lat, longitude: end.lng } } },
    travelMode,
    polylineQuality: 'HIGH_QUALITY',
  };

  const res = await fetch(ROUTES_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Routes API ${res.status}: ${detail || res.statusText}`);
  }

  const data = await res.json();
  const route = data?.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  if (!encoded) throw new Error('Routes API returned no route for these points');

  return {
    polyline: decodePolyline(encoded),
    distanceMeters: Number(route.distanceMeters) || 0,
    duration: route.duration || null,
  };
}
