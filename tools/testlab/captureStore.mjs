// Loads real-bake capture fixtures (written by captureRealBake.mjs) back into the
// {data, soup} shape conformTilesToFloor consumes. Base64 typed arrays are
// decoded into aligned ArrayBuffers (pooled Buffer slices aren't 4-byte aligned).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP_DIR = path.join(HERE, 'captures');

const decodeTyped = (b64, Type) => {
  const buf = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Type(ab);
};

export const listCaptures = () => {
  if (!fs.existsSync(CAP_DIR)) return [];
  return fs.readdirSync(CAP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.replace(/\.json$/, '');
      try {
        const j = JSON.parse(fs.readFileSync(path.join(CAP_DIR, f), 'utf8'));
        return { name, meta: j.meta };
      } catch { return { name, meta: null }; }
    });
};

export const loadCapture = (name) => {
  const file = path.join(CAP_DIR, `${path.basename(name)}.json`);
  if (!fs.existsSync(file)) throw new Error(`capture not found: ${name}`);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = j.terrain;
  const data = {
    width: t.width, height: t.height, minHeight: t.minHeight, maxHeight: t.maxHeight,
    bounds: t.bounds, heightMap: decodeTyped(t.heightMapB64, Float32Array),
  };
  const soup = j.meshes.map((m) => ({
    name: m.name,
    positions: decodeTyped(m.positionsB64, Float32Array),
    index: decodeTyped(m.index.b64, m.index.kind === 'u32' ? Uint32Array : Uint16Array),
  }));
  return { data, soup, meta: j.meta };
};
