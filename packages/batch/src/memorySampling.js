/** @layer io */
/**
 * memorySampling.js — performance.memory sampling + the job checkpoint
 * (sample + summarize + persist). Touches a browser-only API and localStorage.
 */

import { saveBatchState } from './statePersistence.js';
import { summarizeStageTimings } from './batchRuntime.js';

const readPerformanceMemory = () => {
  const mem = performance?.memory;
  if (!mem) return null;
  const usedBytes = Number(mem.usedJSHeapSize || 0);
  const totalBytes = Number(mem.totalJSHeapSize || 0);
  const limitBytes = Number(mem.jsHeapSizeLimit || 0);
  if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes)) return null;
  return { usedBytes, totalBytes, limitBytes };
};

export const sampleMemory = (state, { tile = null, label = 'checkpoint', force = false } = {}) => {
  const store = state?.instrumentation?.memory;
  if (!store) return null;

  const now = Date.now();
  if (!force && store.lastSampleAt && (now - store.lastSampleAt) < (store.sampleIntervalMs || 1200)) {
    return null;
  }

  const sample = readPerformanceMemory();
  if (!sample) {
    store.supported = false;
    store.lastSampleAt = now;
    return null;
  }

  store.supported = true;
  store.lastSampleAt = now;
  const sampleRow = {
    at: now,
    label,
    tileId: tile?.id || null,
    usedBytes: sample.usedBytes,
    totalBytes: sample.totalBytes,
    limitBytes: sample.limitBytes,
  };

  store.samples.push(sampleRow);
  const limit = Math.max(20, Number(store.sampleLimit || 120));
  if (store.samples.length > limit) {
    store.samples.splice(0, store.samples.length - limit);
  }

  store.peakUsedBytes = Math.max(Number(store.peakUsedBytes || 0), sample.usedBytes);
  store.peakTotalBytes = Math.max(Number(store.peakTotalBytes || 0), sample.totalBytes);

  if (tile) {
    tile.memory = tile.memory || {};
    tile.memory.peakUsedBytes = Math.max(Number(tile.memory.peakUsedBytes || 0), sample.usedBytes);
  }

  return sampleRow;
};

export const checkpoint = (state) => {
  sampleMemory(state);
  state.summary = summarizeStageTimings(state);
  saveBatchState(state);
};
