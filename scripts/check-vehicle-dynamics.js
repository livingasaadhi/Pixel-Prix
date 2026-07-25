import assert from 'node:assert/strict';
import { advanceVehicleDynamics, buildTrackProfile, sampleTrackContext } from '../src/utils/vehicleDynamics.js';

const base = {
  throttle: 1, brake: 0, boostActive: false, onGrass: false, offRoadFactor: 0.55,
  accelerationStat: 180, brakeForceStat: 450, referenceTopSpeedKph: 275,
  boostAccelerationStat: 380, boostReferenceTopSpeedKph: 398,
  accelerationFactor: 1, steerInput: 1, deltaSeconds: 1 / 60
};
const straight = { cornerSpeedKph: Infinity, edgeRatio: 0 };
const tightCorner = { cornerSpeedKph: 95, edgeRatio: 0 };
const simulate = (context, deltaSeconds, onGrass = false) => {
  let speed = 0;
  for (let time = 0; time < 20; time += deltaSeconds) {
    speed = advanceVehicleDynamics({ ...base, speedKph: speed, trackContext: context, onGrass, deltaSeconds }).speedKph;
  }
  return speed;
};

const terminal60 = simulate(straight, 1 / 60);
const terminal120 = simulate(straight, 1 / 120);
const cornerSpeed = simulate(tightCorner, 1 / 60);
const noSteerCornerSpeed = (() => {
  let speed = 0;
  for (let time = 0; time < 20; time += 1 / 60) {
    speed = advanceVehicleDynamics({ ...base, steerInput: 0, speedKph: speed, trackContext: tightCorner }).speedKph;
  }
  return speed;
})();
const grassSpeed = simulate(straight, 1 / 60, true);
const boostSpeed = (() => {
  let speed = 0;
  for (let time = 0; time < 20; time += 1 / 60) {
    speed = advanceVehicleDynamics({ ...base, boostActive: true, speedKph: speed, trackContext: straight }).speedKph;
  }
  return speed;
})();
assert.ok(terminal60 > 220 && terminal60 < 320, 'straight speed must settle through force balance');
assert.ok(Math.abs(terminal60 - terminal120) / terminal60 < 0.03, 'speed must be stable across frame rates');
assert.ok(cornerSpeed < terminal60 * 0.7, 'tight upcoming corners must scrub excess speed');
assert.ok(noSteerCornerSpeed > cornerSpeed * 1.35, 'corner geometry must not secretly brake a car that is not turning');
assert.ok(grassSpeed < terminal60 * 0.6, 'grass must substantially reduce achievable speed');
assert.ok(boostSpeed > terminal60 * 1.04 && boostSpeed < terminal60 * 1.2, 'boost must provide a controlled straight-line gain');

const circle = Array.from({ length: 64 }, (_, i) => {
  const angle = (i / 64) * Math.PI * 2;
  return { x: Math.cos(angle) * 2000, y: Math.sin(angle) * 2000 };
});
circle.push({ ...circle[0] });
const profile = buildTrackProfile(circle, 500);
const context = sampleTrackContext(profile, 0, {
  speedKph: 200, roadWidth: 500, distanceFromCenter: 0, corneringGrip: 1, onGrass: false
});
assert.ok(Number.isFinite(context.cornerSpeedKph) && context.cornerSpeedKph > 0, 'track profile must produce a finite corner speed');

console.log('Vehicle dynamics checks passed: force balance, corners, grass, profile, and frame-rate stability verified.');
