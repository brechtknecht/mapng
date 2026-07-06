/** @layer io */
// Overpass fetch orchestration: endpoint racing with abort, per-request
// metadata, and the public fetchOSMData(WithInfo) entry points. The pure query
// builder + response parser live in osmParse.js (docs/refactor/06 step 5).

import { buildQuery, buildUnionQuery, parseOverpassResponse } from './osmParse.js';

// Re-exported so route-level callers can split one union response back into
// per-chunk feature sets (parse clips to the bounds it's given).
export { parseOverpassResponse } from './osmParse.js';

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

// How many chunk bboxes go into one union query. Bounded so a long route's
// union can't blow the server-side maxsize/timeout; batches beyond the first
// run concurrently (2 wide — the public mirrors' per-IP slot budget).
const UNION_BATCH_SIZE = 8;

/**
 * ONE Overpass round-trip for a whole route: union query over every chunk
 * bbox, returning the RAW merged response (`{ elements }`) plus request info.
 * Split it per chunk with parseOverpassResponse(data, chunkBounds).
 *
 * Long routes batch UNION_BATCH_SIZE boxes per query; elements are deduped by
 * type/id across batches (a way straddling two batches' boxes arrives twice —
 * without the dedupe it would double up in every chunk parse that clips it).
 * Never rejects: a failed batch degrades to its chunks parsing empty, matching
 * fetchOSMDataWithInfo's catch-internally contract.
 */
export const fetchOSMUnionRaw = async (boundsList) => {
  const startedAt = new Date().toISOString();
  const batches = [];
  for (let i = 0; i < boundsList.length; i += UNION_BATCH_SIZE) {
    batches.push(boundsList.slice(i, i + UNION_BATCH_SIZE));
  }
  console.log(`[OSM] Union fetch: ${boundsList.length} chunk boxes in ${batches.length} batch(es)`);

  let failures = 0;
  const endpoints = new Set();
  const runBatch = async (batch) => {
    const query = buildUnionQuery(batch, { timeoutSec: 30 });
    const shuffled = [...OVERPASS_ENDPOINTS].sort(() => Math.random() - 0.5);
    try {
      const { endpoint, data } = await raceEndpoints(shuffled, query);
      endpoints.add(endpoint);
      console.log(`[OSM] Union batch (${batch.length} boxes) winner: ${endpoint} — ${data.elements?.length || 0} elements`);
      return data.elements ?? [];
    } catch (error) {
      failures++;
      console.error(`[OSM] Union batch failed (${batch.length} boxes):`, error.message);
      return [];
    }
  };

  // 2 batches in flight max — polite to the public mirrors.
  const results = new Array(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const i = next++;
      results[i] = await runBatch(batches[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));

  const seen = new Set();
  const elements = [];
  for (const batch of results) {
    for (const el of batch) {
      const k = `${el.type}/${el.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      elements.push(el);
    }
  }

  const requestInfo = {
    method: 'POST',
    output: 'json',
    union: true,
    boxCount: boundsList.length,
    batchCount: batches.length,
    failedBatches: failures,
    endpointUsed: [...endpoints].join(', ') || null,
    elementCount: elements.length,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  console.log(`[OSM] Union fetch merged: ${elements.length} unique elements (${failures} failed batch(es))`);
  return { data: { elements }, requestInfo };
};
