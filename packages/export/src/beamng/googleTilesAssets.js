/** @layer io */
// Google Photorealistic 3D Tiles → BeamNG GLB (texture-atlased, vertex-capped)
// plus a debug cube DAE. This is the ONLY beamng/* module that imports
// google3dTiles (3d-tiles-renderer builds a WebGLRenderer at module eval), so
// the GPU dependency is isolated here. Extracted verbatim from
// exportBeamNGLevel.js (06 step 9).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ColladaExporter } from '../ColladaExporter.js';
import { getOrBakeGoogle3DTiles, getGoogleTilesZOffset, exportGoogleTilesViaSidecar, googleBakeSidecarAvailable } from '@mapng/bake/google3dTiles';
import { SCENE_SIZE } from '../scene3d/sceneProjection.js';

/**
 * Bake Google Photorealistic 3D Tiles into a BeamNG-ready GLB plus the atlas
 * textures + material names for `art/shapes/google_tiles/`.
 *
 * The GLB is NOT loaded by BeamNG directly — its Torque-era importer only
 * accepts .dae, and our hand-rolled Collada writer kept tripping over
 * undocumented importer constraints (16-bit vertex indices, trailing digits
 * in node names parsed as LOD sizes, ...). Instead the level zip ships the
 * GLB together with scripts/beamng_glb_to_dae.py; a headless Blender run
 * converts it to the final google_tiles.dae using the Collada exporter the
 * BeamNG modding community itself relies on. The GLB is also verifiable in
 * any glTF viewer — a trustworthy intermediate at last.
 *
 * Returns { glbBlob, textureFiles, materialNames } or null if nothing baked.
 */
export async function generateGoogleTilesGLB(terrainData, worldSize, googleOptions) {
  // Cached bake shared with the 3D preview — a preview-then-export flow only
  // hits the Google API once.
  // Pass stripGround ONLY when the caller explicitly chose — otherwise the
  // persisted preference is resolved centrally (resolveBakeOptions), exactly
  // like the preview. Hardcoding `!== false` here forced sg=true into the
  // cache key and silently RE-BAKED whenever the preview was keeping the
  // ground (different key → the user's refined bake never reached the zip).
  const googleGroup = await getOrBakeGoogle3DTiles(terrainData, {
    apiKey: googleOptions.apiKey,
    errorTarget: googleOptions.errorTarget,
    ...(typeof googleOptions.stripGround === 'boolean' ? { stripGround: googleOptions.stripGround } : {}),
    onProgress: googleOptions.onProgress,
  });

  const googleMeshes = [];
  googleGroup.traverse((c) => {
    if (c.isMesh && c.userData.isGoogleTile) googleMeshes.push(c);
  });
  if (googleMeshes.length === 0) return null;

  // Bake-space (X/Z scene units, Y in metres above the .ter datum) → glTF
  // space (Y-up, metres), authored so the round trip lands in BeamNG world
  // coordinates: Blender's glTF import maps (gX, gY, gZ) → (gX, -gZ, gY),
  // which must equal BeamNG's (s·x, -s·z, y). Hence simply gX = s·x,
  // gY = y (already metres), gZ = s·z — a plain scale matrix.
  const s = worldSize / SCENE_SIZE;
  // The preview's manual z-offset (real metres) ships with the export — what
  // the user aligned visually is what lands in BeamNG (gY is metres, so the
  // lift is a plain translation after the scale).
  const zOffsetM = getGoogleTilesZOffset();
  if (zOffsetM !== 0) {
    console.log(`[BeamNG export] applying Google tiles z-offset: ${zOffsetM} m`);
  }
  const transformMatrix = new THREE.Matrix4().makeScale(s, 1, s).setPosition(0, zOffsetM, 0);

  // Transform CLONES of the tile geometries — the source group is owned by
  // the bake cache and must survive untouched for the preview / next export.
  //
  // TEXTURE ATLAS: thousands of per-tile materials are unusable in BeamNG
  // (materials.json bloat, importer scrambling). Pack every tile texture
  // into a few 4096² atlas sheets and remap the UVs into the atlas cells —
  // a handful of materials total.
  const ATLAS_SIZE = 4096;
  // Each cell gets a GUTTER of edge-replicated pixels on all sides: BeamNG
  // generates mipmaps, and by mip 3-4 a thin gap would average neighbouring
  // cells together — visible as colour bleeding and seams on DISTANT
  // surfaces. Edge replication keeps every mip level sampling "more of the
  // same tile". PAD (= 2×GUTTER) is the spacing between cell rects so two
  // neighbouring gutters never overlap.
  const GUTTER = 8;
  const PAD = GUTTER * 2;

  const entries = [];
  for (const mesh of googleMeshes) {
    if (!mesh.geometry?.attributes?.position) continue;
    const geom = mesh.geometry.clone();
    geom.applyMatrix4(transformMatrix);
    geom.computeVertexNormals();
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const img = mat?.map?.image ?? null;
    const valid = img && img.width > 0 && img.height > 0;
    entries.push({
      geom,
      img: valid ? img : null,
      // Untextured tiles get a small grey cell so their (zero-filled) UVs
      // sample a neutral colour instead of a neighbouring tile.
      w: Math.min(valid ? img.width : 8, ATLAS_SIZE - 2 * PAD),
      h: Math.min(valid ? img.height : 8, ATLAS_SIZE - 2 * PAD),
      x: 0,
      y: 0,
      atlas: null,
    });
  }
  if (entries.length === 0) return null;

  // Shelf-pack, tallest first, into as many atlases as needed.
  const atlases = [];
  const newAtlas = () => {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
    const atlas = { canvas, ctx, cursorX: PAD, cursorY: PAD, shelfH: 0, entries: [] };
    atlases.push(atlas);
    return atlas;
  };
  let atlas = newAtlas();
  const packOrder = [...entries].sort((a, b) => b.h - a.h);
  for (const e of packOrder) {
    if (atlas.cursorX + e.w + PAD > ATLAS_SIZE) {
      // new shelf
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
    if (e.img) {
      const { ctx } = atlas;
      const { img, x, y, w, h } = e;
      ctx.drawImage(img, x, y, w, h);
      const iw = img.width;
      const ih = img.height;
      // Edge replication into the gutter: stretch the outermost source
      // pixel rows/columns (and corner pixels) outward so mip downsampling
      // never mixes in a neighbouring tile.
      ctx.drawImage(img, 0, 0, 1, ih, x - GUTTER, y, GUTTER, h);              // left
      ctx.drawImage(img, iw - 1, 0, 1, ih, x + w, y, GUTTER, h);              // right
      ctx.drawImage(img, 0, 0, iw, 1, x, y - GUTTER, w, GUTTER);              // top
      ctx.drawImage(img, 0, ih - 1, iw, 1, x, y + h, w, GUTTER);              // bottom
      ctx.drawImage(img, 0, 0, 1, 1, x - GUTTER, y - GUTTER, GUTTER, GUTTER);                 // top-left
      ctx.drawImage(img, iw - 1, 0, 1, 1, x + w, y - GUTTER, GUTTER, GUTTER);                 // top-right
      ctx.drawImage(img, 0, ih - 1, 1, 1, x - GUTTER, y + h, GUTTER, GUTTER);                 // bottom-left
      ctx.drawImage(img, iw - 1, ih - 1, 1, 1, x + w, y + h, GUTTER, GUTTER);                 // bottom-right
    }
    atlas.cursorX += e.w + PAD;
    atlas.shelfH = Math.max(atlas.shelfH, e.h);
    atlas.entries.push(e);
  }

  // Remap each tile's UVs into its atlas cell. Half-texel inset keeps
  // bilinear samples inside the cell; UVs are clamped to [0,1] (Google
  // photogrammetry doesn't use wrapping).
  for (const e of entries) {
    const uv = e.geom.attributes.uv;
    const inset = 0.5;
    const u0 = (e.x + inset) / ATLAS_SIZE;
    const v0 = (e.y + inset) / ATLAS_SIZE;
    const uw = (e.w - 2 * inset) / ATLAS_SIZE;
    const vh = (e.h - 2 * inset) / ATLAS_SIZE;
    for (let i = 0; i < uv.count; i++) {
      const u = Math.min(1, Math.max(0, uv.getX(i)));
      const v = Math.min(1, Math.max(0, uv.getY(i)));
      uv.setXY(i, u0 + u * uw, v0 + v * vh);
    }
  }

  // Chunked meshes, ≤60k vertices each, ONE atlas material each. The final
  // .dae lands in Torque's TSMesh which uses 16-bit vertex indices — a mesh
  // past 65,535 verts imports with wrapped indices (shapes survive,
  // texcoords scramble into kaleidoscope). Names end in "_mesh" because
  // Torque parses trailing digits as LOD detail sizes ("foo000" = render at
  // 0 px = invisible); the Blender script re-sanitizes anyway.
  const VERT_LIMIT = 60000;
  const materialNames = [];
  const tilesGroup = new THREE.Group();
  tilesGroup.name = 'google_tiles';
  let mergeFailed = false;

  for (const a of atlases) {
    if (a.entries.length === 0) continue;
    const matName = `google_atlas_${String(materialNames.length).padStart(2, '0')}`;
    const tex = new THREE.CanvasTexture(a.canvas);
    tex.name = matName;
    // glTF convention (v=0 at the image top) — matches the source tile UVs
    // and keeps GLTFExporter from misexporting the canvas.
    tex.flipY = false;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    mat.name = matName;
    mat.map = tex;
    materialNames.push(matName);

    let chunk = [];
    let chunkVerts = 0;
    const flushChunk = () => {
      if (chunk.length === 0) return;
      const merged = mergeGeometries(chunk, false);
      if (!merged) {
        console.error(
          `[BeamNG export] mergeGeometries failed for a ${chunk.length}-tile chunk of ${matName} ` +
          '(attribute mismatch?) — dropping Google tiles from this export',
        );
        mergeFailed = true;
        chunk = [];
        return;
      }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.name = `google_tiles_a${matName.slice(-2)}_c${String(tilesGroup.children.length).padStart(3, '0')}_mesh`;
      tilesGroup.add(mesh);
      chunk = [];
      chunkVerts = 0;
    };

    for (const e of a.entries) {
      const vCount = e.geom.attributes.position.count;
      if (chunkVerts + vCount > VERT_LIMIT && chunk.length > 0) flushChunk();
      if (mergeFailed) return null;
      chunk.push(e.geom);
      chunkVerts += vCount;
    }
    flushChunk();
    if (mergeFailed) return null;
  }
  if (tilesGroup.children.length === 0) return null;
  console.info(
    `[BeamNG export] packed ${entries.length} Google tiles into ${materialNames.length} ` +
    `${ATLAS_SIZE}px atlas(es), ${tilesGroup.children.length} meshes (≤${VERT_LIMIT} verts each)`,
  );

  // No collision mesh on purpose: colliding against raw photogrammetry is
  // expensive and lumpy. The extruded OSM building boxes (kept in
  // osm_objects.dae's collision mesh even when their visuals are hidden)
  // provide the collision instead. The base00 > start01 node skeleton is
  // added by the Blender conversion script.
  tilesGroup.updateMatrixWorld(true);

  const glbBuffer = await new GLTFExporter().parseAsync(tilesGroup, { binary: true });
  const glbBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' });

  // Atlas PNGs for the zip's textures/ folder + materials.json entries.
  const textureFiles = [];
  for (let i = 0; i < atlases.length; i++) {
    if (atlases[i].entries.length === 0) continue;
    const name = materialNames[textureFiles.length];
    const data = await new Promise((resolve) => atlases[i].canvas.toBlob(resolve, 'image/png'));
    if (data) textureFiles.push({ name, ext: 'png', data });
  }

  return { glbBlob, textureFiles, materialNames };
}

/**
 * Build a small textured-cube DAE that uses a known Google tile material name.
 * Dropped near the player spawn as a diagnostic probe: if the cube renders
 * textured in-game but the big osm_objects.dae stays invisible, the issue is
 * in the photogrammetry mesh itself (UVs/normals/scale) rather than the
 * material/texture pipeline.
 */
export function generateGoogleDebugCubeDAE(materialName) {
  const geom = new THREE.BoxGeometry(4, 4, 4);
  // Build a fresh MeshStandardMaterial named to match the target material so
  // BeamNG resolves it via main.materials.json the same way the big DAE does.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.name = materialName;
  const cube = new THREE.Mesh(geom, mat);
  cube.name = 'google_debug_cube';

  const base00 = new THREE.Group();
  base00.name = 'base00';
  const start01 = new THREE.Group();
  start01.name = 'start01';
  start01.add(cube);
  base00.add(start01);
  base00.updateMatrixWorld(true);

  const result = new ColladaExporter().parse(base00, undefined, {
    version: '1.4.1',
    upAxis: 'Z_UP',
  });
  return result?.data ?? null;
}

/**
 * Orchestrate the Google Photorealistic 3D Tiles export for a level: prefer the
 * bake sidecar (server-side atlas+GLB assembly, file-path markers — keeps multi-
 * GB blobs out of the renderer), fall back to in-browser generateGoogleTilesGLB,
 * build a debug cube, then auto-convert GLB→DAE via the dev-server Blender bridge
 * when available. A failed Google bake never takes down the level export — every
 * path catches and logs. Extracted verbatim from exportBeamNGLevel.js (06 step 9c).
 *
 * `progress` is { report, beginStep, yield_ }.
 * Returns { glbBlob, daeBlob, textureFiles, materialNames, debugCubeBlob }.
 */
export async function exportGoogleTilesForLevel(exportTerrainData, worldSize, { googleApiKey, google3DErrorTarget }, progress) {
  const { report, beginStep, yield_ } = progress;
  let googleTilesGlbBlob = null;
  let googleTilesDaeBlob = null;
  let googleTilesTextureFiles = [];
  let googleTilesMaterialNames = [];
  let googleDebugCubeBlob = null;

  // SIDEcar path first: the bake worker assembles atlases + GLB on the
  // server (it holds every tile record) and hands back FILE PATHS — the
  // ultra-scale exports that crashed the tab (39 atlas canvases + a
  // 1.5 GB GLB in the renderer) never enter the browser at all.
  const googleProgress = (p) => report(
    `Google tiles pass ${p.station ?? 1}/${p.stations ?? 1}: ${p.visible} loaded, ${p.downloading + p.parsing} in flight`,
    65,
  );
  if (await googleBakeSidecarAvailable()) {
    try {
      beginStep('Assembling Google tiles on the bake sidecar…', 65);
      await yield_();
      const exported = await exportGoogleTilesViaSidecar(exportTerrainData, {
        apiKey: googleApiKey,
        errorTarget: google3DErrorTarget,
        onProgress: googleProgress,
      }, {
        worldSize,
        zOffsetM: getGoogleTilesZOffset(),
      });
      // Server-side artifacts ride through the existing zip variables as
      // {fromPath} markers — the zip sidecar ingests them from disk.
      googleTilesGlbBlob = { fromPath: exported.glbPath, size: exported.glbBytes ?? 0 };
      googleTilesTextureFiles = (exported.textures ?? []).map((t) => ({
        name: t.name,
        ext: 'png',
        data: { fromPath: t.path, size: t.bytes ?? 0 },
      }));
      googleTilesMaterialNames = exported.materialNames ?? [];
      console.info(
        `[BeamNG export] sidecar assembled google_tiles.glb: ${exported.meshes} meshes, ` +
        `${googleTilesMaterialNames.length} atlases, ${((exported.glbBytes ?? 0) / 1024 ** 2).toFixed(0)} MB — zero renderer memory`,
      );
    } catch (err) {
      console.warn('[BeamNG export] sidecar export failed — falling back to in-browser assembly:', err);
      report(`Sidecar export failed (${err?.message ?? err}) — assembling in the browser`, 65);
    }
  }

  if (!googleTilesGlbBlob) {
    try {
      const googleResult = await generateGoogleTilesGLB(exportTerrainData, worldSize, {
        apiKey: googleApiKey,
        errorTarget: google3DErrorTarget,
        onProgress: googleProgress,
      });
      googleTilesGlbBlob = googleResult?.glbBlob ?? null;
      googleTilesTextureFiles = googleResult?.textureFiles ?? [];
      googleTilesMaterialNames = googleResult?.materialNames ?? [];
      if (!googleResult) {
        console.warn('[BeamNG export] Google 3D Tiles produced no geometry — exporting without them');
        report('Google tiles: no geometry produced — exporting without them', 65);
      } else {
        console.info(
          `[BeamNG export] Google tiles GLB built: ${googleTilesMaterialNames.length} atlas materials, ` +
          `${googleTilesTextureFiles.length} textures — convert with scripts/beamng_glb_to_dae.py`,
        );
      }
    } catch (err) {
      console.error('[BeamNG export] Google 3D Tiles bake failed — exporting without them:', err);
      report(`Google tiles failed (${err?.message ?? err}) — exporting without them`, 65);
    }
  }
  if (googleTilesMaterialNames.length > 0) {
    googleDebugCubeBlob = generateGoogleDebugCubeDAE(googleTilesMaterialNames[0]);
  }

  // Auto-convert GLB → .dae through the dev-server Blender bridge
  // (vite middleware → headless Blender ≤4.2). Sidecar-assembled GLBs
  // convert IN PLACE on the server (?file= mode) — no multi-GB blobs in
  // the tab. When the bridge is unavailable (no Blender, prod build),
  // the zip ships the GLB plus the conversion script for the documented
  // manual one-liner.
  if (googleTilesGlbBlob) {
    try {
      beginStep('Converting Google tiles to DAE (Blender)…', 66);
      await yield_();
      const serverPath = googleTilesGlbBlob.fromPath;
      const resp = serverPath
        ? await fetch(`/api/convert-dae?file=${encodeURIComponent(serverPath)}`, { method: 'POST' })
        : await fetch('/api/convert-dae', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: googleTilesGlbBlob,
        });
      if (resp.ok && serverPath) {
        const { daePath, bytes } = await resp.json();
        googleTilesDaeBlob = { fromPath: daePath, size: bytes ?? 0 };
        console.info(
          `[BeamNG export] Blender bridge converted google_tiles.dae in place ` +
          `(${((bytes ?? 0) / 1024 ** 2).toFixed(1)} MB) — zip is ready to play`,
        );
      } else if (resp.ok) {
        googleTilesDaeBlob = await resp.blob();
        console.info(
          `[BeamNG export] Blender bridge converted google_tiles.dae ` +
          `(${(googleTilesDaeBlob.size / 1024 ** 2).toFixed(1)} MB) — zip is ready to play`,
        );
      } else {
        const msg = await resp.text();
        console.warn(
          `[BeamNG export] Blender bridge unavailable (HTTP ${resp.status}): ${msg} — ` +
          'shipping GLB + conversion script instead',
        );
        report('Blender bridge unavailable — zip needs the manual conversion step', 66);
      }
    } catch (err) {
      console.warn(
        '[BeamNG export] Blender bridge unreachable — shipping GLB + conversion script instead:',
        err,
      );
      report('Blender bridge unreachable — zip needs the manual conversion step', 66);
    }
  }

  return {
    glbBlob: googleTilesGlbBlob,
    daeBlob: googleTilesDaeBlob,
    textureFiles: googleTilesTextureFiles,
    materialNames: googleTilesMaterialNames,
    debugCubeBlob: googleDebugCubeBlob,
  };
}
