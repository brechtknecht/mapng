/** @layer io */
/**
 * statePersistence.js — localStorage persistence + client cache reset for the
 * batch job state. Wraps migrateLoadedState (pure) with the storage side.
 */

import { migrateLoadedState } from './batchState.js';
import { JOB_STATES, TILE_STATES } from './batchRuntime.js';
import { clearBatchCache } from './batchCache.js';

const STORAGE_KEY = 'mapng_batch_state_v2';
const LEGACY_STORAGE_KEY = 'mapng_batch_state';

export function saveBatchState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    console.warn('[Batch] Could not persist batch state to localStorage');
  }
}

export function loadBatchState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!saved) return null;
    const state = migrateLoadedState(JSON.parse(saved));
    if (!state) return null;

    // Completed jobs should not remain as "saved resumable" jobs.
    if (state.status === JOB_STATES.COMPLETED) {
      clearBatchState();
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

export function clearBatchState() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export async function clearBatchClientCache() {
  await clearBatchCache();
}

export function resetFailedTiles(state) {
  for (const tile of state.tiles) {
    if (tile.status === TILE_STATES.FAILED) {
      tile.status = TILE_STATES.QUEUED;
      tile.lastError = null;
      tile.retryable = false;
      tile.nextRetryAt = null;
    }
  }
  state.status = JOB_STATES.PENDING;
  state.totalFailed = 0;
  saveBatchState(state);
}
