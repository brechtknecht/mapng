/** @layer core */
// Combined BeamNG ASSET_SETS table (refactor doc 06 step 10).
// Split across A/B part files only to keep each module under the 500-LOC cap.
import { ASSET_SETS_A } from './forestAssetSetsA.js';
import { ASSET_SETS_B } from './forestAssetSetsB.js';

export const ASSET_SETS = { ...ASSET_SETS_A, ...ASSET_SETS_B };
