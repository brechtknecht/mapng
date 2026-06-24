/** @layer io */
/**
 * batchDownloads.js — Browser download helpers: anchor-triggered blob download,
 * export-blob MIME coercion, and the elevation-report download. Touches
 * document/URL/Blob.
 */

import { buildBatchElevationReportText } from './batchReport.js';

export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadBatchElevationReport(state) {
  const text = buildBatchElevationReportText(state);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const date = new Date().toISOString().slice(0, 10);
  const lat = Number(state?.center?.lat || 0).toFixed(4);
  const lng = Number(state?.center?.lng || 0).toFixed(4);
  triggerDownload(blob, `MapNG_Batch_Elevation_Report_${date}_${lat}_${lng}.txt`);
}

const isJsonMimeType = (mime = '') => {
  const normalized = String(mime).toLowerCase();
  return normalized.includes('application/json') || normalized.includes('text/json');
};

export async function ensureExportBlobType(blob, expectedMimeType, fallbackMimeType = expectedMimeType) {
  if (!blob) return null;

  if (isJsonMimeType(blob.type)) {
    throw new Error(`Expected ${expectedMimeType} blob but received JSON payload.`);
  }

  const currentType = String(blob.type || '').toLowerCase();
  const expectedType = String(expectedMimeType || '').toLowerCase();

  if (!expectedType || currentType === expectedType) {
    if (!blob.type && (fallbackMimeType || expectedMimeType)) {
      const buffer = await blob.arrayBuffer();
      return new Blob([buffer], { type: fallbackMimeType || expectedMimeType });
    }
    return blob;
  }

  const buffer = await blob.arrayBuffer();
  return new Blob([buffer], { type: fallbackMimeType || expectedMimeType || 'application/octet-stream' });
}
