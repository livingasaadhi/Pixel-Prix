/**
 * Calculates physics checks for off-road grass surface and checkpoint validation.
 * Includes a generous tolerance buffer so clipping kerbs or track edges is penalty-free.
 */

/**
 * Returns the squared distance from point (px, py) to the line segment
 * between (ax, ay) and (bx, by).
 */
function distToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }

  // Project (px, py) onto the segment, clamped to [0, 1].
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Finds the nearest track segment index to the point (px, py).
 * Performs a stateful local search window (+/- 10 segments around prevIndex)
 * to avoid scan loops over all track divisions on every frame.
 */
export function getNearestSegmentIndex(px, py, curvePoints, prevIndex = -1) {
  const n = curvePoints.length;
  if (n < 2) return { nearestIndex: 0, minDistanceSq: Infinity };

  const searchIndices = [];
  if (prevIndex === -1 || prevIndex >= n) {
    // Full search on start or reset
    for (let i = 0; i < n; i++) {
      searchIndices.push(i);
    }
  } else {
    // Local search window of +/- 10 segments around previous nearest index
    const windowSize = 10;
    for (let i = -windowSize; i <= windowSize; i++) {
      searchIndices.push((prevIndex + i + n) % n);
    }
  }

  let minDistanceSq = Infinity;
  let nearestIndex = 0;

  for (const idx of searchIndices) {
    const a = curvePoints[idx];
    const b = curvePoints[(idx + 1) % n];
    const distSq = distToSegmentSq(px, py, a.x, a.y, b.x, b.y);
    if (distSq < minDistanceSq) {
      minDistanceSq = distSq;
      nearestIndex = idx;
    }
  }

  return { nearestIndex, minDistanceSq };
}

/**
 * Checks if a position (px, py) is significantly off the track road surface.
 * Measures distance to the track centerline (nearest segment), not just the
 * nearest sample vertex, so accuracy is consistent along the whole loop.
 * Adds a +35px tolerance buffer so minor kerb touches or riding track edges
 * does NOT count as off-road.
 */
export function isOffRoad(px, py, curvePoints, roadWidth) {
  const { minDistanceSq } = getNearestSegmentIndex(px, py, curvePoints, -1);
  const effectiveHalfWidth = (roadWidth / 2) + 35;
  return minDistanceSq > (effectiveHalfWidth * effectiveHalfWidth);
}

/**
 * Checks if the player is within trigger range of a checkpoint.
 */
export function checkCheckpointProximity(px, py, checkpoint, radius = 140) {
  const dx = px - checkpoint.x;
  const dy = py - checkpoint.y;
  return (dx * dx + dy * dy) <= (radius * radius);
}