/** @layer core */
/**
 * tileQueues.js — Batch OSM-fetch predicate and the staged scheduling queues
 * (fetch/compute/encode + Overpass rate limiter). Wraps taskQueues.js.
 */

import { toStrictBool } from './schedulerConfig.js';
import { createTaskQueue, createRateLimiter } from './taskQueues.js';

export function shouldFetchOSMForBatch(state) {
  if (!toStrictBool(state?.includeOSM)) return false;
  const exports = state.exports || {};
  return (
    exports.osmTexture === true
    || exports.hybridTexture === true
    || exports.roadMask === true
    || exports.geojson === true
    || exports.glb === true
    || exports.dae === true
  );
}

export function buildQueues(state, onQueueWait) {
  const scheduler = state.scheduler || {
    fetchConcurrency: 4,
    computeConcurrency: 1,
    encodeConcurrency: 1,
    overpassMinIntervalMs: 600,
  };
  const fetchQueue = createTaskQueue({ concurrency: scheduler.fetchConcurrency, name: 'fetch' });
  const computeQueue = createTaskQueue({ concurrency: scheduler.computeConcurrency, name: 'compute' });
  const encodeQueue = createTaskQueue({ concurrency: scheduler.encodeConcurrency, name: 'encode' });

  const overpassLimiter = createRateLimiter({
    minIntervalMs: Math.max(0, Number(scheduler.overpassMinIntervalMs || 600)),
    concurrency: 1,
  });

  const scheduleFetch = (tile, task) => {
    return fetchQueue.enqueue(() => overpassLimiter.schedule(task), {
      onStart: (waitMs) => onQueueWait(tile, 'queue_wait_fetch', waitMs),
    });
  };
  const scheduleCompute = (tile, task) => {
    return computeQueue.enqueue(task, {
      onStart: (waitMs) => onQueueWait(tile, 'queue_wait_compute', waitMs),
    });
  };
  const scheduleEncode = (tile, task) => {
    return encodeQueue.enqueue(task, {
      onStart: (waitMs) => onQueueWait(tile, 'queue_wait_encode', waitMs),
    });
  };

  return {
    scheduleFetch,
    scheduleCompute,
    scheduleEncode,
    close: () => {
      fetchQueue.close();
      computeQueue.close();
      encodeQueue.close();
    },
  };
}
