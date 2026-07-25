const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lerp = (from, to, amount) => from + (to - from) * amount;

/**
 * Converts driver inputs into the available steering and directional grip for
 * this frame. A car cannot simultaneously use full grip for acceleration,
 * braking, and cornering, so carrying too much speed naturally creates
 * understeer instead of an unrealistically tight flat-out line.
 */
export function calculateHandling({
  speedKph,
  maxSpeedKph,
  steerInput,
  throttle,
  brake,
  boostActive,
  corneringGrip = 1,
  highSpeedSteeringMultiplier = 0.48
}) {
  const speedRatio = clamp(speedKph / Math.max(1, maxSpeedKph), 0, 1.15);
  const steering = clamp(Math.abs(steerInput), 0, 1);
  const throttleInput = clamp(throttle, 0, 1);
  const brakeInput = clamp(brake, 0, 1);
  const chassisGrip = clamp(corneringGrip, 0.92, 1.14);
  const highSpeedAuthority = clamp(highSpeedSteeringMultiplier * 0.62, 0.22, 0.38);
  const speedLoad = Math.pow(Math.min(speedRatio, 1), 1.35);
  const cornerLoad = steering * Math.pow(Math.min(speedRatio, 1), 1.25);

  const baseSteering = lerp(0.98, highSpeedAuthority, speedLoad) * (1 + (chassisGrip - 1) * 0.75);
  const throttleUndersteer = throttleInput * steering * (0.12 + 0.42 * speedLoad);
  const boostUndersteer = boostActive ? steering * (0.12 + 0.18 * speedLoad) : 0;
  const trailBrakeRotation = brakeInput * steering * (0.08 + 0.14 * speedLoad);
  const steeringAuthority = clamp(
    baseSteering * (1 - throttleUndersteer - boostUndersteer) + trailBrakeRotation,
    0.12,
    0.98
  );

  const longitudinalLoad = speedLoad * (throttleInput * 0.32 + brakeInput * 0.24);
  const gripExcess = Math.max(0, cornerLoad + longitudinalLoad - chassisGrip * 0.78);
  const directionResponse = clamp(
    0.31 - cornerLoad * 0.17 - throttleInput * steering * 0.07 + brakeInput * steering * 0.04 - gripExcess * 0.15,
    0.07,
    0.31
  );

  const accelerationFactor = clamp(
    1 - steering * speedLoad * (0.22 + throttleInput * 0.28 + (boostActive ? 0.18 : 0)),
    0.4,
    1
  );

  return { steeringAuthority, directionResponse, accelerationFactor, speedRatio };
}
