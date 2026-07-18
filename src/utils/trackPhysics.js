/**
 * Calculates physics checks for off-road grass surface and checkpoint validation.
 * Includes a generous tolerance buffer so clipping kerbs or track edges is penalty-free.
 */

/**
 * Checks if a position (px, py) is significantly off the track road surface.
 * Adds a +25px tolerance buffer so minor kerb touches or riding track edges does NOT count as off-road.
 */
export function isOffRoad(px, py, curvePoints, roadWidth) {
  let minDistanceSq = Infinity;
  
  // Add 25px generous margin to road width
  const effectiveHalfWidth = (roadWidth / 2) + 25;
  const halfWidthSq = effectiveHalfWidth * effectiveHalfWidth;

  for (let i = 0; i < curvePoints.length; i += 2) {
    const pt = curvePoints[i];
    const dx = px - pt.x;
    const dy = py - pt.y;
    const distSq = dx * dx + dy * dy;

    if (distSq < minDistanceSq) {
      minDistanceSq = distSq;
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
