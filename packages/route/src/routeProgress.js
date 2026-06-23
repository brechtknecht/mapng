// Per-chunk progress tracker for the route corridor bake.
//
// Framework-agnostic on purpose: services/routeBake.js drives it as chunks move
// through their lifecycle, and any consumer (the map overlay, the panel bar)
// subscribes for immutable snapshots. Keeping the progress SHAPE here — rather
// than inline in routeBake — makes it reusable and unit-testable, and means the
// bake stays parallel without every consumer having to understand the pool.
//
// A chunk's fill (pct 0→100) is split across its lifecycle so the map boxes
// "fill up" smoothly: terrain fetch is the first slice, the Google bake sweep
// is the bulk (driven by station/stations when the worker reports it), and the
// GLB encode tops it off at done.

export const CHUNK_PHASES = ['pending', 'terrain', 'bake', 'encode', 'done', 'error'];

// Fill (%) a chunk has reached at the START of each phase. The bake sweep owns
// the widest band because it dominates wall-clock; its internal progress
// (station/stations) interpolates within [bake, encode).
const PHASE_FLOOR = { pending: 0, terrain: 0, bake: 12, encode: 92, done: 100, error: 0 };

/**
 * @param {number} total number of chunks
 * @param {(snap: RouteProgressSnapshot) => void} [onUpdate] called on every change
 */
export function createRouteProgress(total, onUpdate) {
  const chunks = Array.from({ length: total }, (_, i) => ({
    index: i,
    phase: 'pending',
    pct: 0,
    detail: '',
  }));
  let lastDetail = '';

  const completed = () => chunks.reduce((n, c) => n + (c.phase === 'done' ? 1 : 0), 0);
  const errored = () => chunks.reduce((n, c) => n + (c.phase === 'error' ? 1 : 0), 0);
  const active = () => chunks.filter((c) => c.phase === 'terrain' || c.phase === 'bake' || c.phase === 'encode');
  const overallPct = () =>
    (total ? Math.round(chunks.reduce((s, c) => s + c.pct, 0) / total) : 0);

  const snapshot = () => ({
    total,
    completed: completed(),
    errored: errored(),
    overallPct: overallPct(),
    activeCount: active().length,
    activeIndices: active().map((c) => c.index),
    detail: lastDetail,
    // `chunk`/`phase` keep the legacy single-line bar working: report the
    // completed count and the phase label of any active chunk (or 'done').
    chunk: completed(),
    phase: active()[0]?.phase ?? (completed() >= total ? 'done' : 'terrain'),
    chunks: chunks.map((c) => ({ ...c })),
  });

  const emit = () => onUpdate?.(snapshot());

  const setDetail = (i, detail) => {
    if (detail == null) return;
    chunks[i].detail = detail;
    lastDetail = `Chunk ${i + 1}: ${detail}`;
  };

  return {
    snapshot,

    /** Move a chunk to a lifecycle phase, snapping its fill to that phase floor. */
    setPhase(i, phase, detail) {
      const c = chunks[i];
      if (!c || !CHUNK_PHASES.includes(phase)) return;
      c.phase = phase;
      c.pct = Math.max(c.pct, PHASE_FLOOR[phase] ?? c.pct);
      if (phase === 'done') c.pct = 100;
      setDetail(i, detail);
      emit();
    },

    /**
     * Interpolate a baking chunk's fill from the bake sweep's own progress
     * (0..1 of stations swept) into the [bake, encode) band. Monotonic — never
     * moves the fill backwards.
     */
    setBakeFraction(i, frac, detail) {
      const c = chunks[i];
      if (!c) return;
      const lo = PHASE_FLOOR.bake;
      const hi = PHASE_FLOOR.encode;
      const target = Math.round(lo + Math.max(0, Math.min(1, frac)) * (hi - lo));
      // The bake sweep ticks many times a second; only emit when the integer
      // fill actually advances so the map doesn't re-render needlessly.
      if (target <= c.pct) return;
      c.pct = target;
      setDetail(i, detail);
      emit();
    },
  };
}

/**
 * @typedef {object} RouteProgressSnapshot
 * @property {number} total
 * @property {number} completed
 * @property {number} errored
 * @property {number} overallPct        0..100 weighted by per-chunk fill
 * @property {number} activeCount       chunks currently baking (reveals concurrency)
 * @property {number[]} activeIndices
 * @property {string} detail
 * @property {number} chunk             legacy: completed count
 * @property {string} phase             legacy: an active phase label
 * @property {{index:number,phase:string,pct:number,detail:string}[]} chunks
 */
