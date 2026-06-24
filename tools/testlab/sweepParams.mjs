// Sweep conform field params on a real capture to see what minimises the
// residual AND the fraction of ground verts that get worse (Felix's "drift grows
// in some places"). Run: node tools/testlab/sweepParams.mjs <name>

import { conformTilesToFloor } from '@mapng/bake/tileGroundConform';
import { loadCapture } from './captureStore.mjs';

const name = process.argv[2] || 'muc_isar';
const { data, soup } = loadCapture(name);

const combos = [];
for (const cellM of [12, 8, 6, 4]) {
  for (const smoothPasses of [0, 1, 2]) combos.push({ cellM, smoothPasses });
}

console.log(`sweep on ${name} (${soup.length} meshes)\n`);
console.log('cellM  smooth   before→after (m)   worse%   cellsFilled');
for (const c of combos) {
  const r = conformTilesToFloor(soup, data, { ...c, diagnostics: true });
  const worsePct = 100 * r.diag.worsened / (r.diag.improved + r.diag.worsened);
  console.log(
    `${String(c.cellM).padStart(4)}   ${c.smoothPasses}       ` +
    `${r.residualBefore.toFixed(3)} → ${r.residualAfter.toFixed(3)}       ` +
    `${worsePct.toFixed(1).padStart(5)}    ${r.cellsFilled}`,
  );
}
