import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGeoTiff } from '@mapng/bake/exportGeoTiff';

const center = { lat: 40.1234, lng: -105.1234 };

const makeTerrainData = ({ width = 32, height = 32 } = {}) => {
  const length = width * height;
  const heightMap = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    heightMap[index] = Math.sin(index / 7) * 120 + 500;
  }

  return { width, height, heightMap };
};

const hasTiffHeader = (bytes) => {
  const isLittleEndianTiff = bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00;
  const isBigEndianTiff = bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a;
  return isLittleEndianTiff || isBigEndianTiff;
};

const hasZipHeader = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b;

test('single source GeoTIFF buffer is returned as .tif', async () => {
  const rawGeoTiffBytes = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]).buffer;
  const terrainData = {
    ...makeTerrainData(),
    sourceGeoTiffs: {
      source: 'gpxz',
      arrayBuffers: [rawGeoTiffBytes],
    },
  };

  const { blob, filename } = await exportGeoTiff(terrainData, center);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  assert.equal(blob.type, 'image/tiff');
  assert.match(filename, /^GPXZ_.*\.tif$/);
  assert.equal(filename.endsWith('.zip'), false);
  assert.equal(hasZipHeader(bytes), false);
  assert.equal(hasTiffHeader(bytes), true);
});

test('multi-source input exports one merged TIFF (not ZIP)', async () => {
  const terrainData = {
    ...makeTerrainData({ width: 64, height: 64 }),
    sourceGeoTiffs: {
      source: 'gpxz',
      arrayBuffers: [new ArrayBuffer(16), new ArrayBuffer(16), new ArrayBuffer(16)],
    },
  };

  const { blob, filename } = await exportGeoTiff(terrainData, center);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  assert.equal(blob.type, 'image/tiff');
  assert.match(filename, /^Heightmap_WGS84_.*\.tif$/);
  assert.equal(filename.endsWith('.zip'), false);
  assert.equal(hasZipHeader(bytes), false);
  assert.equal(hasTiffHeader(bytes), true);
});