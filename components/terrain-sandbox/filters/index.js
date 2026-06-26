// Ground-extraction filter registry. Each filter module exports { meta, apply }
// per the HeightField contract in ../groundRaster.js. The sandbox renders one
// pane per approach (plus the built-in DEM + Raw baselines) so they can be
// judged side by side.
import * as pmf from './pmf.js';
import * as demAnchor from './demAnchor.js';
import * as csf from './csf.js';

/** Pluggable filters — order defines pane order after the baselines. */
export const FILTERS = [pmf, demAnchor, csf];

/** Default param object for a filter module (from its meta descriptors). */
export function defaultParams(mod) {
  const out = {};
  for (const p of mod.meta.params) out[p.key] = p.default;
  return out;
}
