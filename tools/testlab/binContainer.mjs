// Reader for the bake worker's MBK1 container (scripts/googleBakeWorker.mjs →
// writeContainer): an 8-byte fixed head ('MBK1' + unpadded header length), a
// JSON header listing meshes with {offset,byteLength} refs, then a 4-byte-aligned
// payload blob. We only need positions + index per mesh for the conform; uvs and
// textures are skipped.

import { readFileSync } from 'node:fs';

const MAGIC = 0x4d424b31; // 'MBK1'

export const readMbkContainer = (path) => {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== MAGIC) throw new Error(`${path}: not an MBK1 container`);
  const headerLen = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen));
  // Payload starts 4-byte-aligned after the (8 + headerLen) preamble.
  const payloadStart = 8 + headerLen + ((4 - ((8 + headerLen) % 4)) % 4);

  const slice = (ref, Type) => {
    if (!ref) return null;
    const start = payloadStart + ref.offset;
    const bytes = buf.subarray(start, start + ref.byteLength);
    // Copy into an aligned ArrayBuffer (pooled Buffer slices aren't aligned).
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Type(ab);
  };

  const meshes = header.meshes.map((m) => ({
    name: m.name,
    positions: slice(m.positions, Float32Array),
    index: m.index ? slice(m.index, m.index.kind === 'u32' ? Uint32Array : Uint16Array) : null,
  }));

  return { header, meshes };
};
