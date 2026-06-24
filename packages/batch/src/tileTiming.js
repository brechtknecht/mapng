/** @layer core */
/**
 * tileTiming.js — Pure per-tile runner helpers: stage-timing accumulation,
 * timed-stage wrapping, completion counts, pause/cancel detection, and error
 * sanitization. Shared by processTile.js and batchRun.js. No DOM, no network.
 */

import { JOB_STATES, TILE_STATES } from './batchRuntime.js';

export const addTiming = (tile, stage, ms) => {
  tile.stageTimings[stage] = Math.round((tile.stageTimings[stage] || 0) + ms);
};

export const runTimedStage = async (tile, stage, fn) => {
  const start = performance.now();
  const result = await fn();
  addTiming(tile, stage, performance.now() - start);
  return result;
};

export const sanitizeError = (error, classification, attempt, waitMs = null) => {
  const timestamp = new Date().toISOString();
  return {
    classification: classification.retryable ? 'retryable' : 'non-retryable',
    kind: classification.kind,
    status: classification.status,
    message: error?.message || String(error),
    stack: error?.stack || null,
    timestamp,
    attempts: attempt,
    nextRetryAt: waitMs ? new Date(Date.now() + waitMs).toISOString() : null,
  };
};

export const updateCounts = (state) => {
  state.totalCompleted = state.tiles.filter((t) => t.status === TILE_STATES.DONE).length;
  state.totalFailed = state.tiles.filter((t) => t.status === TILE_STATES.FAILED).length;
};

export const isPausedOrCanceled = (signal, state) => {
  if (!signal?.aborted) return false;
  if (state.status === JOB_STATES.CANCELED) return true;
  state.status = JOB_STATES.PAUSED;
  return true;
};
