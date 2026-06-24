/** @layer core */
// Top-level BeamNG level archive assembler: given an explicit `ctx` of computed
// artifacts (no closure scope), writes every entry of the level directory tree
// into the `zip` recorder. Splits into the config/asset files writer and the
// MissionGroup scene-tree writer. Pure core — all io-produced artifacts arrive
// via ctx — so it imports no renderer/canvas/fetch/?raw modules and is fully
// headless-testable. Extracted from exportBeamNGLevel.js (06 step 9b).
import { writeLevelFiles } from './levelFiles.js';
import { writeMissionGroup } from './missionGroup.js';

/**
 * Write all entries of a BeamNG level into the archive recorder.
 *
 * `zip` is a recorder: { folder(path), file(path, content) }.
 * `ctx` carries every computed artifact (see the producer in
 * beamng/exportBeamNGLevel.js for the field contract).
 *
 * Files are written BEFORE the MissionGroup scene tree: every
 * generatePersistentId() call lives in writeMissionGroup, so this order keeps
 * the PRNG consumption sequence identical to the pre-decomposition monolith.
 */
export function writeLevelEntries(zip, ctx) {
  writeLevelFiles(zip, ctx);
  writeMissionGroup(zip, ctx);
}
