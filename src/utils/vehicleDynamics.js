const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapIndex = (index, length) => ((index % length) + length) % length;
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angleBetween = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Builds a compact geometry profile once per selected circuit. */
export function buildTrackProfile(curvePoints, roadWidth) {
  const last = curvePoints.length - 1;
  const hasClosingDuplicate = last > 0 &&
    Math.abs(curvePoints[0].x - curvePoints[last].x) < 0.001 &&
    Math.abs(curvePoints[0].y - curvePoints[last].y) < 0.001;
  const points = hasClosingDuplicate ? curvePoints.slice(0, -1) : [...curvePoints];
  const count = points.length;
  const segmentLengths = new Array(count);
  const curvatures = new Array(count);
  let worldLength = 0;

  for (let i = 0; i < count; i++) {
    const segmentLength = distance(points[i], points[(i + 1) % count]);
    segmentLengths[i] = segmentLength;
    worldLength += segmentLength;
  }

  // World co-ordinates are artistic rather than geographic. Treating the
  // rendered road as a 12 m racing surface establishes a consistent physical
  // scale regardless of the display-only circuit-distance label.
  const worldUnitsPerMeter = Math.max(1, roadWidth / 12);
  for (let i = 0; i < count; i++) {
    const previous = points[wrapIndex(i - 2, count)];
    const current = points[i];
    const next = points[wrapIndex(i + 2, count)];
    const inHeading = angleBetween(previous, current);
    const outHeading = angleBetween(current, next);
    const arcWorld = Math.max(1, distance(previous, current) + distance(current, next));
    // Convert from inverse world units to inverse metres for the grip model.
    curvatures[i] = Math.abs(angleDelta(outHeading, inHeading)) / arcWorld * worldUnitsPerMeter;
  }

  return { points, segmentLengths, curvatures, worldUnitsPerMeter, worldLength };
}

/** Samples the limiting bend ahead of the current segment. */
export function sampleTrackContext(profile, segmentIndex, {
  speedKph,
  roadWidth,
  distanceFromCenter,
  corneringGrip,
  onGrass
}) {
  const count = profile.points.length;
  const start = wrapIndex(segmentIndex, count);
  const lookAheadMeters = clamp(45 + speedKph * 0.48, 60, 240);
  const lookAheadWorld = lookAheadMeters * profile.worldUnitsPerMeter;
  let scannedWorld = 0;
  let limitingCurvature = profile.curvatures[start] || 0;

  for (let step = 0; step < count && scannedWorld < lookAheadWorld; step++) {
    const index = wrapIndex(start + step, count);
    limitingCurvature = Math.max(limitingCurvature, profile.curvatures[index] || 0);
    scannedWorld += profile.segmentLengths[index];
  }

  const halfRoadWidth = Math.max(1, roadWidth / 2);
  const edgeRatio = clamp(distanceFromCenter / halfRoadWidth, 0, 1.5);
  const edgeGrip = onGrass ? 0.46 : 1 - Math.max(0, edgeRatio - 0.72) * 0.30;
  const lateralG = 1.42 * clamp(corneringGrip, 0.92, 1.14) * edgeGrip;
  const cornerSpeedKph = limitingCurvature > 0.00001
    ? Math.sqrt((lateralG * 9.81) / limitingCurvature) * 3.6
    : Infinity;

  return {
    cornerSpeedKph,
    currentCurvature: profile.curvatures[start] || 0,
    limitingCurvature,
    edgeRatio,
    surfaceGrip: edgeGrip,
    lookAheadMeters
  };
}

/**
 * Advances longitudinal speed from forces rather than a hard speed cap.
 * `referenceTopSpeedKph` calibrates each car's power/drag balance; its actual
 * terminal speed emerges from the conditions. Boost references feed a bounded
 * deployment-power increase rather than restoring the old arcade speed cap.
 */
export function advanceVehicleDynamics({
  speedKph,
  throttle,
  brake,
  boostActive,
  onGrass,
  offRoadFactor,
  accelerationStat,
  brakeForceStat,
  dragStat = 25,
  referenceTopSpeedKph,
  boostAccelerationStat = accelerationStat,
  boostReferenceTopSpeedKph = referenceTopSpeedKph,
  accelerationFactor,
  steerInput = 0,
  trackContext,
  deltaSeconds
}) {
  const speed = Math.max(0, speedKph);
  const referenceSpeed = Math.max(120, referenceTopSpeedKph);
  const speedRatio = speed / referenceSpeed;
  const baseDriveAccel = 27 + (accelerationStat - 150) * 0.14;
  const powerBand = 1 / (1 + 1.35 * Math.pow(Math.max(0, speedRatio), 1.4));
  const boostPower = boostActive
    ? clamp(
      1 + (boostAccelerationStat / Math.max(1, accelerationStat) - 1) * 0.16 +
      (boostReferenceTopSpeedKph / referenceSpeed - 1) * 0.22,
      1.08,
      1.24
    )
    : 1;
  const driveAccel = baseDriveAccel * clamp(throttle, 0, 1) * powerBand * boostPower * accelerationFactor;
  const aeroFactor = clamp(dragStat / 25, 0.8, 1.2);
  const aeroDrag = baseDriveAccel * 0.38 * aeroFactor * Math.pow(Math.max(0, speedRatio), 2);
  const surfaceResistance = onGrass
    ? 18 + speed * (0.035 + (1 - clamp(offRoadFactor, 0.35, 0.85)) * 0.025)
    : 1.1 + Math.max(0, trackContext.edgeRatio - 0.72) * 3.5;
  const brakeDecel = (brakeForceStat / 6.4) * clamp(brake, 0, 1);
  const safeCornerSpeed = trackContext.cornerSpeedKph;
  const cornerOverspeed = Number.isFinite(safeCornerSpeed)
    ? Math.max(0, (speed - safeCornerSpeed) / Math.max(30, safeCornerSpeed))
    : 0;
  const steeringLoad = clamp(Math.abs(steerInput), 0, 1);
  const rawCornerScrub = Math.pow(cornerOverspeed, 2) * (10 + speed * 0.19) *
    steeringLoad * (1 + throttle * 0.35);
  // Corner overspeed sheds energy through tyre scrub, never through an
  // invisible emergency brake. The cap stays below the car's braking ability.
  const cornerScrub = Math.min(rawCornerScrub, (brakeForceStat / 6.4) * 0.78);
  const accelerationKphPerSecond = driveAccel - aeroDrag - surfaceResistance - brakeDecel - cornerScrub;

  return {
    speedKph: Math.max(0, speed + accelerationKphPerSecond * Math.max(0, deltaSeconds)),
    accelerationKphPerSecond,
    cornerOverspeed,
    cornerScrub
  };
}
