// Diagnose WHERE the conform leaves / grows residual on a real capture, and
// whether that correlates with (a) cells that had no real ground samples
// (inpaint-guessed D) or (b) steep local terrain (DEM-vs-photogrammetry mismatch
// beyond the detection band). Run: node tools/testlab/diagnoseDrift.mjs <name>

import { conformTilesToFloor } from '@mapng/bake/tileGroundConform';
import { sampleHeightAtScene, SCENE_SIZE } from '@mapng/bake/googleBakeCore';
import { loadCapture } from './captureStore.mjs';

const name = process.argv[2] || 'muc_isar';
const { data, soup, meta } = loadCapture(name);
const r = conformTilesToFloor(soup, data, { diagnostics: true });
const d = r.diag;
const n = r.fieldN;
const minH = data.minHeight;

// Per-cell mean residual after, split by coverage.
let covSum = 0, covCnt = 0, inpSum = 0, inpCnt = 0;
let covCells = 0, inpCells = 0;
const HALF = SCENE_SIZE / 2;
const cellCenterScene = (c) => (c + 0.5) / n * SCENE_SIZE - HALF;

// Local terrain slope per cell (metres of relief across the cell), to test the
// "steep ground → residual grows" hypothesis.
const slopeOf = (cx, cz) => {
  const x = cellCenterScene(cx), z = cellCenterScene(cz);
  const step = SCENE_SIZE / n;
  const hL = sampleHeightAtScene(data, x - step, z), hR = sampleHeightAtScene(data, x + step, z);
  const hD = sampleHeightAtScene(data, x, z - step), hU = sampleHeightAtScene(data, x, z + step);
  return Math.hypot(hR - hL, hU - hD) / 2;
};

let steepWorseAfter = 0, steepCnt = 0, flatAfter = 0, flatCnt = 0;
for (let i = 0; i < n * n; i++) {
  if (d.count[i] === 0) continue;
  const after = d.afterAbsSum[i] / d.count[i];
  if (d.coverage[i]) { covSum += after; covCnt++; covCells++; }
  else { inpSum += after; inpCnt++; inpCells++; }
  const slope = slopeOf(i % n, Math.floor(i / n));
  if (slope > 1.0) { steepWorseAfter += after; steepCnt++; }
  else { flatAfter += after; flatCnt++; }
}

const f = (v) => v.toFixed(3);
console.log(`capture: ${name}  (${meta?.sizeM}m, ${meta?.quality}, ${soup.length} meshes)`);
console.log(`overall mean-abs residual:  before ${f(r.residualBefore)} m  →  after ${f(r.residualAfter)} m`);
console.log(`ground verts: improved ${d.improved.toLocaleString()}  worsened ${d.worsened.toLocaleString()}  (${(100 * d.worsened / (d.improved + d.worsened)).toFixed(1)}% worse)`);
console.log(`field cells with ground samples: ${r.cellsFilled}/${n * n}`);
console.log('');
console.log('after-residual by cell coverage:');
console.log(`  measured cells (real samples): ${f(covSum / Math.max(1, covCnt))} m   (${covCells} cells)`);
console.log(`  inpaint-guessed cells:         ${f(inpSum / Math.max(1, inpCnt))} m   (${inpCells} cells)`);
console.log('');
console.log('after-residual by terrain slope:');
console.log(`  steep cells (>1 m relief/cell): ${f(steepWorseAfter / Math.max(1, steepCnt))} m   (${steepCnt} cells)`);
console.log(`  flat cells:                     ${f(flatAfter / Math.max(1, flatCnt))} m   (${flatCnt} cells)`);
