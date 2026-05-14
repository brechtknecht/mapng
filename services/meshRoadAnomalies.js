/**
 * Anomaly scanner for emitted MeshRoad node arrays.
 *
 * Run after the export pipeline produces final MeshRoad objects (or call from
 * the in-app debug view with equivalent inputs). Catches geometric patterns
 * known to cause physics issues in BeamNG, before the level ever ships.
 *
 * Returns a list of `{ type, severity, nodeIndex, location, message, ... }`
 * issues per MeshRoad. `severity` is "warn" for cosmetic issues and "error"
 * for likely physics-breaking conditions (instakill candidates).
 *
 * Detected anomalies (and what they typically cause):
 *
 *   short-first-edge / short-last-edge   — sub-meter end edge creates a
 *                                          curvature spike at the end cap.
 *                                          High risk for instakill on
 *                                          contact at the road's cap.
 *
 *   short-edge                            — interior segment shorter than
 *                                          0.5m. Degenerate slab quad, may
 *                                          render but is a physics risk.
 *
 *   sharp-kink                            — angle change >90° between
 *                                          adjacent edges at one node.
 *                                          Spline blows up.
 *
 *   steep-z                               — |dz| > xy_distance, i.e.
 *                                          near-vertical road segment. The
 *                                          slab becomes a wall, not a road.
 *
 *   width-jump                            — adjacent node widths differ by
 *                                          more than 2× (pinch / flare).
 *
 *   too-few-nodes                         — fewer than 2 nodes; degenerate.
 *
 *   nan-or-infinite                       — non-finite values in any field.
 */

/**
 * Scan a single MeshRoad's node array.
 *
 * @param {object} meshRoad  As emitted by generateMeshRoads — must have
 *                           `.name` and `.nodes` (array of [x,y,z,fullWidth,depth,nx,ny,nz]).
 * @returns {Array<object>}  Issue records. Empty when the road is clean.
 */
export function scanMeshRoadAnomalies(meshRoad) {
  const nodes = meshRoad?.nodes;
  const issues = [];
  if (!Array.isArray(nodes)) {
    return [{ type: 'too-few-nodes', severity: 'error', message: 'No nodes array' }];
  }
  if (nodes.length < 2) {
    issues.push({
      type: 'too-few-nodes',
      severity: 'error',
      message: `Only ${nodes.length} node(s) — needs at least 2`,
    });
    return issues;
  }

  // Non-finite check first; everything below assumes finite numbers.
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    for (let f = 0; f < n.length; f++) {
      if (!Number.isFinite(n[f])) {
        issues.push({
          type: 'nan-or-infinite',
          severity: 'error',
          nodeIndex: i,
          message: `Node ${i} field ${f} is ${n[f]}`,
        });
      }
    }
  }
  if (issues.some((iss) => iss.type === 'nan-or-infinite')) return issues;

  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const xyDist = Math.hypot(dx, dy);
    const isFirst = i === 1;
    const isLast = i === nodes.length - 1;

    if (isFirst && xyDist < 1.5) {
      issues.push({
        type: 'short-first-edge',
        severity: 'error',
        nodeIndex: 0,
        location: [a[0], a[1], a[2]],
        xyDist,
        message: `First edge only ${xyDist.toFixed(2)}m — spline cap will spike`,
      });
    } else if (isLast && xyDist < 1.5) {
      issues.push({
        type: 'short-last-edge',
        severity: 'error',
        nodeIndex: i,
        location: [b[0], b[1], b[2]],
        xyDist,
        message: `Last edge only ${xyDist.toFixed(2)}m — spline cap will spike`,
      });
    } else if (xyDist < 0.5) {
      issues.push({
        type: 'short-edge',
        severity: 'warn',
        nodeIndex: i,
        location: [b[0], b[1], b[2]],
        xyDist,
        message: `Edge ${i - 1}→${i} only ${xyDist.toFixed(3)}m`,
      });
    }

    if (xyDist > 0.1 && Math.abs(dz) > xyDist) {
      issues.push({
        type: 'steep-z',
        severity: 'warn',
        nodeIndex: i,
        location: [b[0], b[1], b[2]],
        xyDist,
        zChange: dz,
        message: `Z change ${dz.toFixed(2)}m over ${xyDist.toFixed(2)}m XY (slope >100%)`,
      });
    }

    // Field 3 is fullWidth (MeshRoad node convention).
    const wA = a[3];
    const wB = b[3];
    if (Number.isFinite(wA) && Number.isFinite(wB) && wA > 0 && wB > 0) {
      const ratio = wA > wB ? wA / wB : wB / wA;
      if (ratio > 2.5) {
        issues.push({
          type: 'width-jump',
          severity: 'warn',
          nodeIndex: i,
          location: [b[0], b[1], b[2]],
          widthA: wA,
          widthB: wB,
          message: `Width changes ${wA.toFixed(1)}→${wB.toFixed(1)}m between adjacent nodes`,
        });
      }
    }
  }

  // Sharp kink detection. Skipped if either incoming or outgoing edge is
  // shorter than 0.2m — short edges already get flagged above and their
  // tangents are too noisy to give meaningful angle data.
  for (let i = 1; i < nodes.length - 1; i++) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const c = nodes[i + 1];
    const v0x = b[0] - a[0];
    const v0y = b[1] - a[1];
    const v1x = c[0] - b[0];
    const v1y = c[1] - b[1];
    const len0 = Math.hypot(v0x, v0y);
    const len1 = Math.hypot(v1x, v1y);
    if (len0 < 0.2 || len1 < 0.2) continue;
    const cosTheta = (v0x * v1x + v0y * v1y) / (len0 * len1);
    const clamped = Math.max(-1, Math.min(1, cosTheta));
    const turnDeg = (Math.acos(clamped) * 180) / Math.PI;
    if (turnDeg > 90) {
      issues.push({
        type: 'sharp-kink',
        severity: 'error',
        nodeIndex: i,
        location: [b[0], b[1], b[2]],
        turnDeg,
        message: `${turnDeg.toFixed(0)}° turn at node ${i}`,
      });
    }
  }

  return issues;
}

/**
 * Scan every MeshRoad in `meshRoads` and aggregate the results.
 *
 * @param {Array<object>} meshRoads  As returned by generateMeshRoads.
 * @returns {{
 *   totalRoads: number,
 *   roadsWithIssues: number,
 *   issuesByType: Record<string, number>,
 *   errors: number,
 *   warnings: number,
 *   anomalies: Array<{ name: string, position?: number[], issues: object[] }>,
 * }}
 */
export function scanAllMeshRoads(meshRoads) {
  const summary = {
    totalRoads: Array.isArray(meshRoads) ? meshRoads.length : 0,
    roadsWithIssues: 0,
    issuesByType: {},
    errors: 0,
    warnings: 0,
    anomalies: [],
  };
  if (!Array.isArray(meshRoads)) return summary;

  for (const mr of meshRoads) {
    const issues = scanMeshRoadAnomalies(mr);
    if (issues.length === 0) continue;
    summary.roadsWithIssues++;
    summary.anomalies.push({
      name: mr.name,
      position: mr.position,
      issues,
    });
    for (const iss of issues) {
      summary.issuesByType[iss.type] = (summary.issuesByType[iss.type] || 0) + 1;
      if (iss.severity === 'error') summary.errors++;
      else summary.warnings++;
    }
  }

  return summary;
}
