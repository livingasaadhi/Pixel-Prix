import assert from 'node:assert/strict';
import { calculateHandling } from '../src/utils/handling.js';

const base = { maxSpeedKph: 300, steerInput: 1, corneringGrip: 1 };
const lowSpeed = calculateHandling({ ...base, speedKph: 60, throttle: 1, brake: 0, boostActive: false });
const flatOut = calculateHandling({ ...base, speedKph: 300, throttle: 1, brake: 0, boostActive: false });
const trailBraking = calculateHandling({ ...base, speedKph: 300, throttle: 0, brake: 0.7, boostActive: false });
const boosted = calculateHandling({ ...base, speedKph: 300, throttle: 1, brake: 0, boostActive: true });
const agile = calculateHandling({ ...base, speedKph: 220, throttle: 0.5, brake: 0, boostActive: false, corneringGrip: 1.14 });
const lowGrip = calculateHandling({ ...base, speedKph: 220, throttle: 0.5, brake: 0, boostActive: false, corneringGrip: 0.92 });
const sharpAtSpeed = calculateHandling({ ...base, speedKph: 260, throttle: 0, brake: 0, boostActive: false, highSpeedSteeringMultiplier: 0.58 });
const bluntAtSpeed = calculateHandling({ ...base, speedKph: 260, throttle: 0, brake: 0, boostActive: false, highSpeedSteeringMultiplier: 0.38 });

assert.ok(lowSpeed.steeringAuthority > flatOut.steeringAuthority, 'speed must reduce steering authority');
assert.ok(flatOut.directionResponse < 0.12, 'flat-out high-speed cornering must understeer');
assert.ok(flatOut.accelerationFactor < 0.55, 'full throttle must be limited while cornering');
assert.ok(trailBraking.steeringAuthority > flatOut.steeringAuthority, 'braking must improve turn-in');
assert.ok(trailBraking.directionResponse > flatOut.directionResponse, 'braking must restore front-end bite');
assert.ok(boosted.steeringAuthority < flatOut.steeringAuthority, 'boost must make a corner harder');
assert.ok(agile.steeringAuthority > lowGrip.steeringAuthority, 'handling cars need a cornering advantage');
assert.ok(sharpAtSpeed.steeringAuthority > bluntAtSpeed.steeringAuthority, 'cars need distinct high-speed steering balance');

console.log('Handling checks passed: speed, throttle, braking, boost, and chassis grip behave as expected.');
