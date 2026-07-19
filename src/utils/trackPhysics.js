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
 * Checks if a position (px, py) is significantly off the track road surface.
 * Measures distance to the track centerline (nearest segment), not just the
 * nearest sample vertex, so accuracy is consistent along the whole loop.
 * Adds a +35px tolerance buffer so minor kerb touches or riding track edges
 * does NOT count as off-road.
 */
export function isOffRoad(px, py, curvePoints, roadWidth) {
  let minDistanceSq = Infinity;

  // Add 35px generous margin to road width - more forgiving track limits
  const effectiveHalfWidth = (roadWidth / 2) + 35;
  const halfWidthSq = effectiveHalfWidth * effectiveHalfWidth;

  if (curvePoints.length < 2) return false;

  // The centerline is a closed loop: test every consecutive segment.
  for (let i = 0; i < curvePoints.length - 1; i++) {
    const a = curvePoints[i];
    const b = curvePoints[i + 1];
    const distSq = distToSegmentSq(px, py, a.x, a.y, b.x, b.y);
    if (distSq < minDistanceSq) {
      minDistanceSq = distSq;
    }
  }

  // Also test the wrap-around segment that closes the loop.
  const first = curvePoints[0];
  const last = curvePoints[curvePoints.length - 1];
  if (first.x !== last.x || first.y !== last.y) {
    const closeSq = distToSegmentSq(px, py, last.x, last.y, first.x, first.y);
    if (closeSq < minDistanceSq) {
      minDistanceSq = closeSq;
    }
  }

  return minDistanceSq > halfWidthSq;
}

/**
 * Checks if the player is within trigger range of a checkpoint.
 */
export function checkCheckpointProximity(px, py, checkpoint, radius = 140) {
  const dx = px - checkpoint.x;
  const dy = py - checkpoint.y;
  return (dx * dx + dy * dy) <= (radius * radius);
}