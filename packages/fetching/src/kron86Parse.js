/** @layer core */
// Pure helpers for the NMT EVRF2007 (KRON86) elevation source: WFS URL builders,
// XML/header parsing, year selection, coverage test, and the pseudo-ASC meta
// shape. No network, no JSZip — pure / DOM-free. Extracted from kron86.js
// (docs/refactor/06 step 5); kron86.js (io) imports these for its fetchers.

const KRON86_PROXY_PREFIX = '/api/kron86';
const KRON86_OPENDATA_PROXY_PREFIX = '/api/kron86-opendata';
const KRON86_INDEX_PATH = '/wss/service/PZGIK/NumerycznyModelTerenuEVRF2007/WFS/Skorowidze';
const KRON86_LAYER_PREFIX = 'gugik:SkorowidzNMT';
const KRON86_MIN_YEAR = 2018;
const KRON86_MAX_YEAR = 2020;
export const KRON86_DEFAULT_YEAR = KRON86_MAX_YEAR;
const KRON86_LOG_PREFIX = '[NMT-EVRF2007]';

export const logInfo = (...args) => console.info(KRON86_LOG_PREFIX, ...args);
export const logWarn = (...args) => console.warn(KRON86_LOG_PREFIX, ...args);

const formatHeaderNumber = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? 'n/a');
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
};

export const extractAscHeaderFields = (text) => {
  const lines = String(text || '').split(/\r?\n/).slice(0, 32);
  const header = {
    ncols: null,
    nrows: null,
    xllcenter: null,
    yllcenter: null,
    cellsize: null,
    nodata_value: null,
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const key = parts[0].toLowerCase();
    const value = parts[1];
    if (!(key in header)) continue;
    const parsed = Number(value);
    header[key] = Number.isFinite(parsed) ? parsed : value;
  }

  const hasAllFields = Object.values(header).every((value) => value != null);
  return { header, hasAllFields };
};

export const logAscHeaderDiagnostics = (sourceName, headerLike) => {
  if (!headerLike) return;
  const lines = [
    `ncols ${formatHeaderNumber(headerLike.ncols)}`,
    `nrows ${formatHeaderNumber(headerLike.nrows)}`,
    `xllcenter ${formatHeaderNumber(headerLike.xllcenter)}`,
    `yllcenter ${formatHeaderNumber(headerLike.yllcenter)}`,
    `cellsize ${formatHeaderNumber(headerLike.cellsize)}`,
    `nodata_value ${formatHeaderNumber(headerLike.nodata_value)}`,
  ];
  logInfo(`ASC header diagnostics (${sourceName}):\n${lines.join('\n')}`);
};

export const KRON86_POLAND_BOUNDS = {
  west: 13.70,
  south: 48.64,
  east: 24.87,
  north: 55.03,
};

const clampKron86Year = (value) => {
  const year = Number(value);
  if (!Number.isFinite(year)) return KRON86_DEFAULT_YEAR;
  return Math.min(KRON86_MAX_YEAR, Math.max(KRON86_MIN_YEAR, Math.trunc(year)));
};

const intersectsBounds = (a, b) => {
  if (!a || !b) return false;
  return !(a.east <= b.west || a.west >= b.east || a.north <= b.south || a.south >= b.north);
};

export const isWithinKron86Coverage = (bounds) => intersectsBounds(bounds, KRON86_POLAND_BOUNDS);

const decodeXmlEntities = (value) => String(value || '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'");

const normalizeUrl = (value) => decodeXmlEntities(value).trim();

export const parseNumberReturned = (xmlText) => {
  const match = String(xmlText || '').match(/numberReturned="(\d+)"/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseEpsgFromUklad = (ukladText) => {
  const text = String(ukladText || '').toUpperCase();
  if (!text) return 2180;
  if (text.includes('PL-1992')) return 2180;
  if (text.includes('PL-2000:S5') || text.includes('PL-2000 S5')) return 2176;
  if (text.includes('PL-2000:S6') || text.includes('PL-2000 S6')) return 2177;
  if (text.includes('PL-2000:S7') || text.includes('PL-2000 S7')) return 2178;
  if (text.includes('PL-2000:S8') || text.includes('PL-2000 S8')) return 2179;
  return 2180;
};

export const extractAvailableYearsFromCapabilities = (xmlText) => {
  const out = new Set();
  const pattern = /SkorowidzNMT(\d{4})/gi;
  let match = pattern.exec(String(xmlText || ''));
  while (match) {
    const year = Number.parseInt(match[1], 10);
    if (Number.isFinite(year) && year >= KRON86_MIN_YEAR && year <= KRON86_MAX_YEAR) {
      out.add(year);
    }
    match = pattern.exec(String(xmlText || ''));
  }
  return [...out].sort((a, b) => b - a);
};

export const extractLinkCandidatesFromFeatureXml = (xmlText) => {
  const text = String(xmlText || '');
  const memberPattern = /<wfs:member\b[\s\S]*?<\/wfs:member>/gi;
  const urlPattern = /<(?:[\w.-]+:)?url_do_pobrania\b[^>]*>([^<]+)</i;
  const ukladPattern = /<(?:[\w.-]+:)?uklad_xy\b[^>]*>([^<]+)</i;
  const formatPattern = /<(?:[\w.-]+:)?format\b[^>]*>([^<]+)</i;
  const godloPattern = /<(?:[\w.-]+:)?godlo\b[^>]*>([^<]+)</i;

  const out = [];
  const seen = new Set();
  for (const member of text.match(memberPattern) || []) {
    const rawUrl = member.match(urlPattern)?.[1];
    if (!rawUrl) continue;
    const url = normalizeUrl(rawUrl);
    if (!/^https?:\/\//i.test(url)) continue;
    const godlo = decodeXmlEntities(member.match(godloPattern)?.[1] || '').trim();
    const dedupeKey = godlo || url;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const uklad = decodeXmlEntities(member.match(ukladPattern)?.[1] || '').trim();
    const format = decodeXmlEntities(member.match(formatPattern)?.[1] || '').trim();
    out.push({
      url,
      godlo,
      uklad,
      format,
      epsgCode: parseEpsgFromUklad(uklad),
    });
  }
  return out;
};

export const buildYearCandidates = (preferredYear) => {
  const startYear = clampKron86Year(preferredYear);
  const years = [];
  for (let y = startYear; y >= KRON86_MIN_YEAR; y--) years.push(y);
  for (let y = startYear + 1; y <= KRON86_MAX_YEAR; y++) years.push(y);
  return years;
};

export const buildGetCapabilitiesUrl = () => {
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetCapabilities',
  });
  return `${KRON86_PROXY_PREFIX}${KRON86_INDEX_PATH}?${params.toString()}`;
};

export const toProxyPath = (absoluteUrl) => {
  try {
    const parsed = new URL(absoluteUrl);
    // Download links are hosted directly on opendata.geoportal.gov.pl.
    // Keep the original path so the proxy fetches the file directly.
    if (parsed.hostname === 'opendata.geoportal.gov.pl') {
      return `${KRON86_OPENDATA_PROXY_PREFIX}${parsed.pathname}${parsed.search}`;
    }
    if (parsed.hostname === 'mapy.geoportal.gov.pl') {
      return `${KRON86_PROXY_PREFIX}${parsed.pathname}${parsed.search}`;
    }
    return absoluteUrl;
  } catch {
    return absoluteUrl;
  }
};

export const buildGetFeatureUrl = (bounds, year = KRON86_DEFAULT_YEAR) => {
  const selectedYear = clampKron86Year(year);
  const params = new URLSearchParams({
    SERVICE: 'WFS',
    VERSION: '2.0.0',
    REQUEST: 'GetFeature',
    TYPENAMES: `${KRON86_LAYER_PREFIX}${selectedYear}`,
    SRSNAME: 'urn:ogc:def:crs:EPSG::4326',
    BBOX: `${bounds.south},${bounds.west},${bounds.north},${bounds.east},urn:ogc:def:crs:EPSG::4326`,
  });

  return `${KRON86_PROXY_PREFIX}${KRON86_INDEX_PATH}?${params.toString()}`;
};

export const toPseudoAscMeta = (raster, width, height, west, east, south, north, noData, sourceName) => ({
  sourceType: 'grid',
  sourceFormat: 'asc',
  formatLabel: 'NMT EVRF2007 Grid',
  raster,
  sourceWidth: width,
  sourceHeight: height,
  isGeoTiff: false,
  isGeoReferenced: false,
  epsgCode: null,
  sourceBoundsProjected: { west, east, south, north },
  sourceCrsSelectable: false,
  bounds: null,
  center: null,
  nativeWidth: null,
  nativeHeight: null,
  suggestedResolution: null,
  nativeMetersPerPixel: null,
  noData,
  gridTiles: [],
  fileSize: raster.byteLength,
  verticalUnitDetected: 'meters',
  verticalUnitDetectionSource: 'NMT-EVRF2007',
  sourceName,
});

export const hasZipSignature = (buffer) => {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  // ZIP local file header, empty archive, or split archive signatures.
  return (
    (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x07 && bytes[3] === 0x08)
  );
};

export const decodeBufferToText = (buffer) => {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return decoder.decode(new Uint8Array(buffer));
};
