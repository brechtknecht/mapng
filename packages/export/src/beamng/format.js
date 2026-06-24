/** @layer core */
// Numeric / boolean / timestamp / area formatting helpers for BeamNG export
// output. Extracted verbatim from exportBeamNGLevel.js (refactor 06 step 9).

/**
 * Round a number to a fixed number of decimal places.
 */
export function roundTo(value, places = 3) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * Format a finite number with fixed decimals, otherwise return "n/a".
 */
export function formatNumber(value, places = 3) {
  if (!Number.isFinite(value)) return 'n/a';
  return Number(value).toFixed(places);
}

/**
 * Format truthy/falsey values as Yes/No for report output.
 */
export function formatBool(value) {
  return value ? 'Yes' : 'No';
}

/**
 * Format a Date instance as ISO-8601, otherwise return "n/a".
 */
export function formatIsoTimestamp(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return 'n/a';
  return value.toISOString();
}

/**
 * Format a duration in ms with human-readable units.
 */
export function formatDurationMs(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

/**
 * Convert square meters to square kilometers for report display.
 */
export function metersToKm2(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return (value / 1_000_000).toFixed(3);
}

/**
 * Clamp a numeric value to the inclusive [min, max] range.
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
