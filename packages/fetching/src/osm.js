/** @layer io */
// Overpass fetch orchestration: endpoint racing with abort, per-request
// metadata, and the public fetchOSMData(WithInfo) entry points. The pure query
// builder + response parser live in osmParse.js (docs/refactor/06 step 5).

import { buildQuery, parseOverpassResponse } from './osmParse.js';

const OVERPASS_ENDPOINTS = [
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.openstreetmap.ru/api/interpreter",
];

let lastOSMRequestInfo = null;

export const getOSMQueryParameters = (bounds) => ({
  endpointCandidates: [...OVERPASS_ENDPOINTS],
  method: 'POST',
  output: 'json',
  timeoutSec: 30,
  maxSize: 134217728, // 128 MB — much more reasonable
  bbox: {
    south: bounds.south,
    west: bounds.west,
    north: bounds.north,
    east: bounds.east,
  },
});

export const getLastOSMRequestInfo = () => {
  return lastOSMRequestInfo ? { ...lastOSMRequestInfo } : null;
};

// --- Endpoint Fetcher ---

// Fires all endpoints simultaneously; first successful response wins and
// all others are aborted.
const fetchWithAbort = async (endpoint, query, signal) => {
  return fetch(endpoint, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error(`Non-JSON response from ${endpoint}: ${rawText.slice(0, 200)}`);
    }
    return { endpoint, data };
  });
};

const raceEndpoints = (endpoints, query) => {
  return new Promise((resolve, reject) => {
    const controllers = endpoints.map(() => new AbortController());
    let settled = false;
    let failCount = 0;
    const errors = [];

    endpoints.forEach((endpoint, i) => {
      fetchWithAbort(endpoint, query, controllers[i].signal)
        .then((result) => {
          if (settled) return;
          settled = true;
          controllers.forEach((c, j) => { if (j !== i) c.abort(); });
          resolve(result);
        })
        .catch((err) => {
          if (err.name === "AbortError") return;
          errors.push(`${endpoint}: ${err.message}`);
          failCount++;
          if (failCount === endpoints.length && !settled) {
            settled = true;
            reject(new Error(`All endpoints failed:\n${errors.join("\n")}`));
          }
        });
    });
  });
};

// Fetch OSM features AND the per-request metadata in one call. Returns the info
// alongside the features so a caller can keep it locally instead of reading the
// module-global getLastOSMRequestInfo() — essential when several fetches run
// concurrently (e.g. the route bake's parallel chunks), where the global would
// otherwise be clobbered by whichever request finishes last.
export const fetchOSMDataWithInfo = async (bounds) => {
  console.log(`[OSM] Fetching data for bounds: N:${bounds.north}, S:${bounds.south}, E:${bounds.east}, W:${bounds.west}`);

  const query = buildQuery(bounds);
  const queryParams = getOSMQueryParameters(bounds);
  const startedAt = new Date().toISOString();

  // Shuffle endpoints so no single mirror always gets hammered first
  const shuffled = [...OVERPASS_ENDPOINTS].sort(() => Math.random() - 0.5);

  try {
    const { endpoint, data } = await raceEndpoints(shuffled, query);

    console.log(`[OSM] Winner: ${endpoint} — ${data.elements?.length || 0} elements`);

    const requestInfo = {
      ...queryParams,
      endpointUsed: endpoint,
      elementCount: data.elements?.length || 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    lastOSMRequestInfo = requestInfo;

    const features = parseOverpassResponse(data, bounds);
    console.log(`[OSM] Parsed ${features.length} features.`);
    return { features, requestInfo };

  } catch (error) {
    console.error("[OSM] All endpoints failed:", error.message);
    const requestInfo = {
      ...queryParams,
      endpointUsed: null,
      error: error.message,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    lastOSMRequestInfo = requestInfo;
    return { features: [], requestInfo };
  }
};

export const fetchOSMData = async (bounds) => {
  return (await fetchOSMDataWithInfo(bounds)).features;
};
