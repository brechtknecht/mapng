/** @layer core */
// Sutherland–Hodgman polygon + line clipping against a lat/lng bbox. Pure /
// DOM-free. Extracted from osm.js (docs/refactor/06 step 5); used by osmParse.js.

const isInside = (p, bounds, edge) => {
  switch (edge) {
    case "N": return p.lat <= bounds.north;
    case "S": return p.lat >= bounds.south;
    case "E": return p.lng <= bounds.east;
    case "W": return p.lng >= bounds.west;
  }
};

const intersect = (a, b, bounds, edge) => {
  const x1 = a.lng, y1 = a.lat;
  const x2 = b.lng, y2 = b.lat;
  let x = 0, y = 0;

  if (edge === "N" || edge === "S") {
    const boundaryY = edge === "N" ? bounds.north : bounds.south;
    y = boundaryY;
    x = y2 === y1 ? x1 : x1 + ((x2 - x1) * (boundaryY - y1)) / (y2 - y1);
  } else {
    const boundaryX = edge === "E" ? bounds.east : bounds.west;
    x = boundaryX;
    y = x2 === x1 ? y1 : y1 + ((y2 - y1) * (boundaryX - x1)) / (x2 - x1);
  }
  return { lat: y, lng: x };
};

export const clipPolygon = (points, bounds) => {
  let output = points;
  for (const edge of ["N", "S", "E", "W"]) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    let S = input[input.length - 1];
    for (const E of input) {
      if (isInside(E, bounds, edge)) {
        if (!isInside(S, bounds, edge)) output.push(intersect(S, E, bounds, edge));
        output.push(E);
      } else if (isInside(S, bounds, edge)) {
        output.push(intersect(S, E, bounds, edge));
      }
      S = E;
    }
  }
  return output;
};

export const clipLineString = (points, bounds) => {
  let segments = [points];
  for (const edge of ["N", "S", "E", "W"]) {
    const nextSegments = [];
    for (const segment of segments) {
      let currentSplit = [];
      for (let i = 0; i < segment.length; i++) {
        const p = segment[i];
        const prev = i > 0 ? segment[i - 1] : null;
        const pIn = isInside(p, bounds, edge);
        const prevIn = prev ? isInside(prev, bounds, edge) : null;

        if (i === 0) {
          if (pIn) currentSplit.push(p);
        } else {
          if (pIn && prevIn) {
            currentSplit.push(p);
          } else if (pIn && !prevIn) {
            if (prev) { currentSplit.push(intersect(prev, p, bounds, edge)); currentSplit.push(p); }
          } else if (!pIn && prevIn) {
            if (prev) {
              currentSplit.push(intersect(prev, p, bounds, edge));
              if (currentSplit.length > 0) nextSegments.push(currentSplit);
              currentSplit = [];
            }
          }
        }
      }
      if (currentSplit.length > 0) nextSegments.push(currentSplit);
    }
    segments = nextSegments;
  }
  return segments;
};
