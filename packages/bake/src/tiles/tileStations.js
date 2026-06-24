/** @layer core */
// Camera-station generation for the Google 3D Tiles sweep: OSM road stations,
// route-corridor stations, and the box-covering sweep (top-down + obliques +
// grid). Pure / DOM-free (THREE used only for Vector3 offsets) — imported by
// the browser bake and the headless node worker. Extracted from googleBakeCore.js
// (docs/refactor/06 step 2); googleBakeCore re-exports these. Covered by
// tests/buildCorridorStations.

import * as THREE from 'three';

// Road classes worth a street-level camera, most important first — the
// station cap is spent on major driving corridors before side streets.
const ROAD_PRIORITY = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  residential: 5,
  unclassified: 6,
  living_street: 7,
};

/**
 * Sample street-level camera stations along the OSM road network: one every
 * `spacingM` metres along roads (major classes first), deduped to `minSepM`,
 * capped at `maxStations`. Returns ENU offsets + a down-street look target.
 */
export const buildRoadStations = (data, {
  centerLat, centerLng, metersPerDegree, extentM,
  horiz, upDir, groundAltAt,
  spacingM = 120, minSepM = 60, altitudeM = 25, aheadM = 35, maxStations = 40,
}) => {
  const half = extentM / 2;
  const roads = (data.osmFeatures ?? [])
    .filter((f) => f.type === 'road' && f.geometry?.length >= 2 && (f.tags?.highway in ROAD_PRIORITY))
    .map((f) => ({ f, prio: ROAD_PRIORITY[f.tags.highway] }))
    .sort((a, b) => a.prio - b.prio);

  const accepted = [];
  const minSepSq = minSepM * minSepM;
  outer:
  for (const { f } of roads) {
    const pts = f.geometry.map((p) => ({
      e: (p.lng - centerLng) * metersPerDegree,
      n: (p.lat - centerLat) * 111320,
    }));
    let carry = spacingM * 0.5; // first station half a spacing into the road
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const segLen = Math.hypot(b.e - a.e, b.n - a.n);
      if (segLen < 1e-6) continue;
      let t = carry;
      while (t < segLen) {
        const u = t / segLen;
        const e = a.e + (b.e - a.e) * u;
        const n = a.n + (b.n - a.n) * u;
        t += spacingM;
        if (Math.abs(e) > half || Math.abs(n) > half) continue;
        if (accepted.some((s) => (s.e - e) ** 2 + (s.n - n) ** 2 < minSepSq)) continue;
        accepted.push({ e, n, dirE: (b.e - a.e) / segLen, dirN: (b.n - a.n) / segLen });
        if (accepted.length >= maxStations) break outer;
      }
      carry = t - segLen;
    }
  }

  return accepted.map((s, i) => {
    const groundAlt = groundAltAt(s.e, s.n);
    return {
      label: `road-${i}`,
      offset: horiz(s.e, s.n).addScaledVector(upDir, groundAlt + altitudeM),
      // Aim at the street surface a few car-lengths ahead — the frustum then
      // covers asphalt plus both facade walls at maximum LOD.
      target: horiz(s.e + s.dirE * aheadM, s.n + s.dirN * aheadM).addScaledVector(upDir, groundAlt),
      viz: { kind: 'road', e: s.e, n: s.n, aglM: altitudeM },
    };
  });
};

/**
 * Route-corridor camera stations — the route-mode replacement for
 * buildSweepStations' box-covering obliques + grid. Detail is concentrated in a
 * band of half-width `halfWidthM` around the route polyline, which is exactly
 * the geometry the corridor mask (export3d.js clipGroupToCorridorXZ) keeps. The
 * full-box sweep instead pulled tiles everywhere and the mask then deleted
 * ~65% of them — paying to bake tiles we throw away. Following only the route
 * removes that waste (the structural win in §3 of the perf plan).
 *
 * Mirrors buildRoadStations' contract (ENU offsets + a down-route look target +
 * the dependency-injected `groundAltAt`), but driven by the SINGLE route
 * segment instead of the OSM network. Two station families:
 *   • on-route: a low down-street camera every `spacingM` (asphalt + near facades)
 *   • lateral:  for wider corridors, the same low oblique offset perpendicular
 *               to the route by up to ~halfWidth on BOTH sides, so the corridor
 *               flanks and set-back facades refine too (an on-route camera sees
 *               them only at distance → coarse LOD). Ring count scales with the
 *               tier's half-width: 0 for a tight draft band, up to 3 for ultra.
 * The cheap top-down overview is kept by buildSweepStations; this adds the rest.
 *
 * @param {{lat:number,lng:number}[]} segment route polyline inside the AOI
 * @param {object} params frame fields + groundAltAt + corridor sizing
 */
export const buildCorridorStations = (segment, {
  centerLat, centerLng, metersPerDegree, extentM,
  horiz, upDir, groundAltAt,
  halfWidthM = 150,
  spacingM = 110, altitudeM = 30, aheadM = 35, maxStations = 160,
}) => {
  if (!Array.isArray(segment) || segment.length < 2) return [];
  const half = extentM / 2;
  // Segment lat/lng → ENU metres from the AOI centre (same projection the road
  // builder uses: east scaled by metersPerDegree, north by the 111320 constant).
  const pts = segment.map((p) => ({
    e: (p.lng - centerLng) * metersPerDegree,
    n: (p.lat - centerLat) * 111320,
  }));

  // Resample the polyline every spacingM → along-route samples carrying a unit
  // down-route heading (dirE,dirN). carry threads the leftover distance across
  // vertices so spacing stays uniform regardless of vertex density.
  const samples = [];
  let carry = spacingM * 0.5; // first sample half a spacing in
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const segLen = Math.hypot(b.e - a.e, b.n - a.n);
    if (segLen < 1e-6) continue;
    const dirE = (b.e - a.e) / segLen, dirN = (b.n - a.n) / segLen;
    let t = carry;
    while (t < segLen) {
      const u = t / segLen;
      samples.push({ e: a.e + (b.e - a.e) * u, n: a.n + (b.n - a.n) * u, dirE, dirN });
      t += spacingM;
    }
    carry = t - segLen;
  }

  const ringCount = Math.min(3, Math.round(halfWidthM / 160));
  const stations = [];
  const place = (e, n, dirE, dirN, label) => {
    // Drop samples that fall outside the AOI box (resampling near a boundary, or
    // a lateral offset reaching past the edge) — those tiles aren't ours.
    if (Math.abs(e) > half || Math.abs(n) > half) return;
    const groundAlt = groundAltAt(e, n);
    stations.push({
      label,
      offset: horiz(e, n).addScaledVector(upDir, groundAlt + altitudeM),
      // Aim down-route a few car-lengths ahead at the street surface — frustum
      // covers asphalt + facades at maximum LOD, like the road pass.
      target: horiz(e + dirE * aheadM, n + dirN * aheadM).addScaledVector(upDir, groundAlt),
      viz: { kind: 'road', e, n, aglM: altitudeM },
    });
  };
  samples.forEach((s, i) => {
    place(s.e, s.n, s.dirE, s.dirN, `corridor-${i}`);
    if (ringCount > 0) {
      const perpE = -s.dirN, perpN = s.dirE; // unit left-of-heading perpendicular
      for (let r = 1; r <= ringCount; r++) {
        const off = halfWidthM * (r / ringCount) * 0.85; // keep just inside the mask
        place(s.e + perpE * off, s.n + perpN * off, s.dirE, s.dirN, `corridor-${i}-L${r}`);
        place(s.e - perpE * off, s.n - perpN * off, s.dirE, s.dirN, `corridor-${i}-R${r}`);
      }
    }
  });

  // No silent truncation: if a very long/wide corridor overshoots the cap, thin
  // UNIFORMLY (never lop off the route's tail) and log what was dropped.
  if (stations.length > maxStations) {
    console.warn(
      `[google3dTiles] corridor pass: ${stations.length} stations exceeds cap ${maxStations} — ` +
      `thinning uniformly (raise spacingM or use a tighter tier to keep them all)`,
    );
    const stride = stations.length / maxStations;
    const thinned = [];
    for (let k = 0; thinned.length < maxStations && Math.floor(k) < stations.length; k += stride) {
      thinned.push(stations[Math.floor(k)]);
    }
    return thinned;
  }
  return stations;
};

/**
 * Camera stations for the sweep. ONE camera is swept through these in
 * sequence: top-down first (the proven baseline), then obliques/grid so
 * facades cover enough screen pixels for the LOD selector to refine them.
 * Registering multiple cameras SIMULTANEOUSLY broke the bake entirely
 * (0 tiles — hard-won lesson 7); repositioning a single camera keeps the
 * selector consistent, and tiles loaded at earlier stations stay in the LRU
 * cache.
 *
 * Stations: { label, offset (camera position relative to AOI centre),
 * target (look-at point relative to AOI centre, default = centre),
 * viz (ENU footprint for the preview overlay) }.
 */
export const buildSweepStations = (frame, { quality = 'standard', cameraSweep = true, corridorSegment = null } = {}) => {
  const { extentM, upDir, horiz } = frame;
  const stations = [
    {
      label: 'top-down',
      offset: new THREE.Vector3().addScaledVector(upDir, extentM * 1.5 + 200),
      viz: { kind: 'overview', e: 0, n: 0, aglM: extentM * 1.5 + 200 },
    },
  ];
  if (!cameraSweep) return stations;

  // Route-corridor mode: keep ONLY the cheap top-down overview here and DROP the
  // box-covering obliques + grid — they baked tiles the corridor mask deletes.
  // The route-following stations are appended in runStationSweep (they need the
  // ground-altitude probe that only station 0 makes possible).
  if (Array.isArray(corridorSegment) && corridorSegment.length >= 2) return stations;

  if (quality === 'high' || quality === 'roads' || quality === 'max') {
    // 8 perimeter obliques, lower than standard for sharper facades. The
    // near side fills the frustum at high LOD; the far side is covered by
    // the opposite station.
    const dirs = [
      ['north', 0, 1], ['north-east', Math.SQRT1_2, Math.SQRT1_2],
      ['east', 1, 0], ['south-east', Math.SQRT1_2, -Math.SQRT1_2],
      ['south', 0, -1], ['south-west', -Math.SQRT1_2, -Math.SQRT1_2],
      ['west', -1, 0], ['north-west', -Math.SQRT1_2, Math.SQRT1_2],
    ];
    for (const [label, e, n] of dirs) {
      stations.push({
        label: `oblique-${label}`,
        offset: horiz(e * extentM * 0.8, n * extentM * 0.8).addScaledVector(upDir, extentM * 0.5),
        viz: { kind: 'oblique', e: e * extentM * 0.8, n: n * extentM * 0.8, aglM: extentM * 0.5 },
      });
    }
    // Grid of low-altitude cells, each looked at straight down from much
    // closer than the overview — this is what drags the LOD selector
    // several levels deeper (screen-space error scales with distance).
    // The grid SIZE adapts to the AOI so detail DENSITY stays constant:
    // ~250 m cells regardless of map size (a fixed 4×4 would let cell
    // size — and camera altitude — grow with the AOI, collapsing quality
    // on larger maps back to overview level).
    const GRID = Math.min(8, Math.max(2, Math.round(extentM / 250)));
    const cellM = extentM / GRID;
    const gridAlt = cellM * 1.3 + 60;
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const cellE = ((gx + 0.5) / GRID - 0.5) * extentM;
        const cellN = ((gy + 0.5) / GRID - 0.5) * extentM;
        const target = horiz(cellE, cellN);
        stations.push({
          label: `grid-${gx},${gy}`,
          offset: target.clone().addScaledVector(upDir, gridAlt),
          target,
          viz: { kind: 'grid', e: cellE, n: cellN, aglM: gridAlt },
        });
      }
    }
    if (quality === 'max') {
      // Auto fly-mode: a LOW OBLIQUE camera per cell. The grid above looks
      // straight down, so walls cover almost no pixels and the LOD selector
      // never refines facades — exactly the detail the user otherwise has to
      // chase by hand in fly mode. Two diagonal headings (SW + NE) see all
      // four facade orientations. Much lower than the grid (≈third the
      // altitude) so screen-space error drags several LOD levels deeper.
      // These run LAST and carry phase 'deepen' so runStationSweep's
      // saturation stop can trim the tail once they stop adding tiles
      // (Google's finite LOD ceiling reached).
      const lowAlt = cellM * 0.4 + 50;
      const standoff = cellM * 0.7;
      const headings = [
        ['sw', -Math.SQRT1_2, -Math.SQRT1_2],
        ['ne', Math.SQRT1_2, Math.SQRT1_2],
      ];
      for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
          const cellE = ((gx + 0.5) / GRID - 0.5) * extentM;
          const cellN = ((gy + 0.5) / GRID - 0.5) * extentM;
          const target = horiz(cellE, cellN);
          for (const [label, e, n] of headings) {
            const offE = cellE + e * standoff;
            const offN = cellN + n * standoff;
            stations.push({
              label: `oblique-cell-${gx},${gy}-${label}`,
              offset: horiz(offE, offN).addScaledVector(upDir, lowAlt),
              target,
              phase: 'deepen',
              viz: { kind: 'oblique', e: offE, n: offN, aglM: lowAlt },
            });
          }
        }
      }
    }
  } else {
    // Standard: 4 oblique views, far enough out that the whole AOI fits
    // the 60° FOV and sits well past the near plane (the suspected
    // multi-camera killer).
    const obliqueOffset = (e, n) =>
      horiz(e * extentM * 1.1, n * extentM * 1.1).addScaledVector(upDir, extentM * 0.8);
    const obliqueViz = (e, n) =>
      ({ kind: 'oblique', e: e * extentM * 1.1, n: n * extentM * 1.1, aglM: extentM * 0.8 });
    stations.push(
      { label: 'north', offset: obliqueOffset(0, 1), viz: obliqueViz(0, 1) },
      { label: 'east', offset: obliqueOffset(1, 0), viz: obliqueViz(1, 0) },
      { label: 'south', offset: obliqueOffset(0, -1), viz: obliqueViz(0, -1) },
      { label: 'west', offset: obliqueOffset(-1, 0), viz: obliqueViz(-1, 0) },
    );
  }
  return stations;
};
