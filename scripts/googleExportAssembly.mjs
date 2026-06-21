import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// Server-side assembly of the BeamNG google_tiles export: texture ATLASES +
// chunked-mesh GLB, built straight from the bake session's records — the
// browser previously did this with 4096² canvases + GLTFExporter and died at
// ultra scale (39 atlas canvases ≈ 2.6 GB RGBA + a 1.5 GB GLB in one tab).
//
// Ported 1:1 from services/exportBeamNGLevel.js generateGoogleTilesGLB —
// the hard-won semantics are identical:
//  - 4096² atlas sheets, shelf-packed tallest-first, as many as needed
//  - GUTTER of edge-replicated pixels per cell (BeamNG mipmaps would bleed
//    neighbouring cells together by mip 3-4) — sharp's extend-with-copy
//    does the whole 8-patch replication in one op per tile
//  - UVs remapped into the cells with a half-texel inset
//  - meshes chunked at ≤60k verts (Torque TSMesh uses 16-bit indices) and
//    named ..._mesh (trailing digits parse as LOD sizes)
//
// The GLB is written by hand (no GLTFExporter): geometry is trivial
// (POSITION/TEXCOORD_0/indices) and the atlas PNGs embed as pre-encoded
// bytes — no canvas, no decode, flat memory, streamed to disk.

const ATLAS_SIZE = 4096;
const GUTTER = 8;
const PAD = GUTTER * 2;
const VERT_LIMIT = 60000;

const align4 = (n) => (n + 3) & ~3;

/**
 * @param {Array} records bake records: {name, positions, uvs, index, texture}
 * @param {object} opts { worldSize, sceneSize, zOffsetM, outDir, log }
 * @returns {{ glbPath, textures: [{name, path}], materialNames, meshCount }}
 */
export async function assembleGoogleTilesExport(records, {
  worldSize,
  sceneSize = 100,
  zOffsetM = 0,
  outDir,
  // Namespaces the atlas material/texture names. BeamNG resolves materials
  // GLOBALLY by name, so a multi-tile level (route export) MUST give each tile a
  // unique prefix or the meshes share one atlas and textures scramble. Empty for
  // the single-tile export (only one set, no collision).
  materialPrefix = '',
  log = console.info,
}) {
  const s = worldSize / sceneSize;

  // ---- 1. entries: transformed geometry + texture dimensions ---------------
  const entries = [];
  for (const r of records) {
    if (!r.positions?.length) continue;
    let w = 8;
    let h = 8;
    if (r.texture?.bytes?.length) {
      try {
        const meta = await sharp(Buffer.from(r.texture.bytes.buffer, r.texture.bytes.byteOffset, r.texture.bytes.byteLength)).metadata();
        w = Math.min(meta.width ?? 8, ATLAS_SIZE - 2 * PAD);
        h = Math.min(meta.height ?? 8, ATLAS_SIZE - 2 * PAD);
      } catch { /* undecodable — gray cell */ }
    }

    // Bake space (X/Z scene units, Y metres) → glTF space authored to land in
    // BeamNG world coordinates after the Blender round trip: gX = s·x,
    // gY = y + zOffset (already metres), gZ = s·z. (Same as the browser path,
    // incl. the preview z-offset.)
    const src = r.positions;
    const positions = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      positions[i] = src[i] * s;
      positions[i + 1] = src[i + 1] + zOffsetM;
      positions[i + 2] = src[i + 2] * s;
    }

    entries.push({
      positions,
      uvs: new Float32Array(r.uvs), // copy — remapped in place below
      index: r.index ?? null,
      texture: r.texture ?? null,
      w, h,
      x: 0, y: 0,
      atlas: null,
    });
  }
  if (entries.length === 0) return null;

  // ---- 2. shelf-pack tallest-first into as many atlases as needed ----------
  const atlases = [];
  const newAtlas = () => {
    const atlas = { cursorX: PAD, cursorY: PAD, shelfH: 0, entries: [] };
    atlases.push(atlas);
    return atlas;
  };
  let atlas = newAtlas();
  const packOrder = [...entries].sort((a, b) => b.h - a.h);
  for (const e of packOrder) {
    if (atlas.cursorX + e.w + PAD > ATLAS_SIZE) {
      atlas.cursorX = PAD;
      atlas.cursorY += atlas.shelfH + PAD;
      atlas.shelfH = 0;
    }
    if (atlas.cursorY + e.h + PAD > ATLAS_SIZE) {
      atlas = newAtlas();
    }
    e.atlas = atlas;
    e.x = atlas.cursorX;
    e.y = atlas.cursorY;
    atlas.cursorX += e.w + PAD;
    atlas.shelfH = Math.max(atlas.shelfH, e.h);
    atlas.entries.push(e);
  }

  // ---- 3. composite the atlas PNGs ------------------------------------------
  const materialNames = [];
  const textures = [];
  for (let i = 0; i < atlases.length; i++) {
    const a = atlases[i];
    if (a.entries.length === 0) continue;
    const matName = `${materialPrefix}google_atlas_${String(materialNames.length).padStart(2, '0')}`;
    const composites = [];
    for (const e of a.entries) {
      if (!e.texture?.bytes?.length) continue; // gray background shows through
      const tile = Buffer.from(e.texture.bytes.buffer, e.texture.bytes.byteOffset, e.texture.bytes.byteLength);
      try {
        // Edge-replicated gutter in ONE op; resize guards the rare oversized tile.
        const withGutter = await sharp(tile)
          .resize(e.w, e.h, { fit: 'fill' })
          .extend({ top: GUTTER, bottom: GUTTER, left: GUTTER, right: GUTTER, extendWith: 'copy' })
          .toBuffer();
        composites.push({ input: withGutter, left: e.x - GUTTER, top: e.y - GUTTER });
      } catch { /* undecodable tile — gray cell */ }
    }
    const png = await sharp({
      create: { width: ATLAS_SIZE, height: ATLAS_SIZE, channels: 3, background: { r: 128, g: 128, b: 128 } },
    }).composite(composites).png().toBuffer();

    const file = path.join(outDir, `${matName}.png`);
    await writeFile(file, png);
    textures.push({ name: matName, path: file, bytes: png.length, png });
    materialNames.push(matName);
    log(`[export] atlas ${matName}: ${a.entries.length} tiles, ${(png.length / 1024 ** 2).toFixed(1)} MB PNG`);
  }

  // ---- 4. UV remap into the atlas cells (half-texel inset) -----------------
  for (const e of entries) {
    const inset = 0.5;
    const u0 = (e.x + inset) / ATLAS_SIZE;
    const v0 = (e.y + inset) / ATLAS_SIZE;
    const uw = (e.w - 2 * inset) / ATLAS_SIZE;
    const vh = (e.h - 2 * inset) / ATLAS_SIZE;
    const uv = e.uvs;
    for (let i = 0; i < uv.length; i += 2) {
      const u = Math.min(1, Math.max(0, uv[i]));
      const v = Math.min(1, Math.max(0, uv[i + 1]));
      uv[i] = u0 + u * uw;
      uv[i + 1] = v0 + v * vh;
    }
  }

  // ---- 5. chunk-merge ≤60k verts per atlas material -------------------------
  const chunks = []; // { name, materialIdx, positions, uvs, indices(u32), min, max }
  for (let ai = 0, mi = 0; ai < atlases.length; ai++) {
    const a = atlases[ai];
    if (a.entries.length === 0) continue;
    const materialIdx = mi++;
    let group = [];
    let groupVerts = 0;
    const flush = () => {
      if (group.length === 0) return;
      let vTotal = 0;
      let iTotal = 0;
      for (const e of group) {
        vTotal += e.positions.length / 3;
        iTotal += e.index ? e.index.length : e.positions.length / 3;
      }
      const positions = new Float32Array(vTotal * 3);
      const uvs = new Float32Array(vTotal * 2);
      const indices = new Uint32Array(iTotal);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      let vOff = 0;
      let iOff = 0;
      for (const e of group) {
        positions.set(e.positions, vOff * 3);
        uvs.set(e.uvs, vOff * 2);
        const vCount = e.positions.length / 3;
        if (e.index) {
          for (let k = 0; k < e.index.length; k++) indices[iOff + k] = e.index[k] + vOff;
          iOff += e.index.length;
        } else {
          for (let k = 0; k < vCount; k++) indices[iOff + k] = vOff + k;
          iOff += vCount;
        }
        for (let k = 0; k < e.positions.length; k += 3) {
          for (let d = 0; d < 3; d++) {
            const v = e.positions[k + d];
            if (v < min[d]) min[d] = v;
            if (v > max[d]) max[d] = v;
          }
        }
        vOff += vCount;
      }
      const matTag = String(materialIdx).padStart(2, '0');
      chunks.push({
        name: `google_tiles_a${matTag}_c${String(chunks.length).padStart(3, '0')}_mesh`,
        materialIdx, positions, uvs, indices, min, max,
      });
      group = [];
      groupVerts = 0;
    };
    for (const e of a.entries) {
      const vCount = e.positions.length / 3;
      if (groupVerts + vCount > VERT_LIMIT && group.length > 0) flush();
      group.push(e);
      groupVerts += vCount;
    }
    flush();
  }

  // ---- 6. hand-rolled GLB ----------------------------------------------------
  const bufferViews = [];
  const accessors = [];
  const binParts = [];
  let binOffset = 0;
  const pushBin = (typedArrayOrBuffer, target) => {
    const buf = Buffer.isBuffer(typedArrayOrBuffer)
      ? typedArrayOrBuffer
      : Buffer.from(typedArrayOrBuffer.buffer, typedArrayOrBuffer.byteOffset, typedArrayOrBuffer.byteLength);
    const viewIdx = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: binOffset, byteLength: buf.byteLength, ...(target ? { target } : {}) });
    binParts.push(buf);
    binOffset += buf.byteLength;
    const pad = align4(binOffset) - binOffset;
    if (pad) {
      binParts.push(Buffer.alloc(pad));
      binOffset += pad;
    }
    return viewIdx;
  };

  const meshes = [];
  const nodes = [{ name: 'google_tiles', children: [] }];
  for (const c of chunks) {
    const posView = pushBin(c.positions, 34962);
    const uvView = pushBin(c.uvs, 34962);
    const idxView = pushBin(c.indices, 34963);
    const posAcc = accessors.push({
      bufferView: posView, componentType: 5126, count: c.positions.length / 3,
      type: 'VEC3', min: c.min, max: c.max,
    }) - 1;
    const uvAcc = accessors.push({
      bufferView: uvView, componentType: 5126, count: c.uvs.length / 2, type: 'VEC2',
    }) - 1;
    const idxAcc = accessors.push({
      bufferView: idxView, componentType: 5125, count: c.indices.length, type: 'SCALAR',
    }) - 1;
    const meshIdx = meshes.push({
      name: c.name,
      primitives: [{
        attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc },
        indices: idxAcc,
        material: c.materialIdx,
        mode: 4,
      }],
    }) - 1;
    nodes[0].children.push(nodes.length);
    nodes.push({ name: c.name, mesh: meshIdx });
  }

  const images = [];
  const gltfTextures = [];
  const materials = [];
  for (let i = 0; i < textures.length; i++) {
    const imgView = pushBin(textures[i].png);
    images.push({ name: textures[i].name, mimeType: 'image/png', bufferView: imgView });
    gltfTextures.push({ source: i, sampler: 0 });
    materials.push({
      name: materialNames[i],
      pbrMetallicRoughness: {
        baseColorTexture: { index: i },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
    });
    delete textures[i].png; // header only needs name+path from here on
  }

  const gltf = {
    asset: { version: '2.0', generator: 'mapng google-bake sidecar' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    materials,
    textures: gltfTextures,
    images,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binOffset }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPad = align4(jsonBuf.length) - jsonBuf.length;
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);

  const glbPath = path.join(outDir, 'google_tiles.glb');
  const out = createWriteStream(glbPath);
  const writeOut = (buf) => new Promise((resolve, reject) => out.write(buf, (e) => (e ? reject(e) : resolve())));
  const header = Buffer.alloc(12 + 8);
  header.writeUInt32LE(0x46546c67, 0);                       // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binOffset, 8);
  header.writeUInt32LE(jsonBuf.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);                      // 'JSON'
  await writeOut(header);
  await writeOut(jsonBuf);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binOffset, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);                    // 'BIN'
  await writeOut(binHeader);
  for (const part of binParts) await writeOut(part);
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));

  const glbBytes = 12 + 8 + jsonBuf.length + 8 + binOffset;
  log(
    `[export] google_tiles.glb: ${chunks.length} meshes, ${materialNames.length} atlases, ` +
    `${(glbBytes / 1024 ** 2).toFixed(0)} MB`,
  );

  return {
    glbPath,
    glbBytes,
    textures: textures.map(({ name, path: p, bytes }) => ({ name, path: p, bytes })),
    materialNames,
    meshCount: chunks.length,
  };
}
