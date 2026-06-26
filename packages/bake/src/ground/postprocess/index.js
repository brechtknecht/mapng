// Post-processor registry. Each module exports { meta, apply(heights, field,
// params) } and transforms an already-extracted ground heightfield. Mirrors
// ../filters/index.js so the two stay symmetric and a new post-processor is just
// another entry here. Order = the FX dropdown order; first is the default.
import * as bilateralSmooth from './bilateralSmooth.js';
import * as gaussianSmooth from './gaussianSmooth.js';

// Bilateral first: edge-preserving smoothing is what road surfaces want (keeps
// buildings/curbs from bleeding into the street). Gaussian is the plain blur.
export const POSTPROCESSORS = [bilateralSmooth, gaussianSmooth];

/** Look up a post-processor module by its meta.id. */
export function postProcessorById(id) {
  return POSTPROCESSORS.find((p) => p.meta.id === id) || POSTPROCESSORS[0];
}
