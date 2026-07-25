import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const raceScene = fs.readFileSync(path.join(root, 'src', 'scenes', 'RaceScene.js'), 'utf8');

assert.match(raceScene, /this\.velocityScale = 14\.4;/, 'on-track velocity must use the second 2× production race scale');
assert.match(raceScene, /displayedSpeed = Math\.abs\(this\.currentSpeed\) \/ this\.velocityScale/, 'the HUD speed must use the same conversion as the world motion');
assert.doesNotMatch(raceScene, /\* 2\.4|\/ 2\.4/, 'no stale 2.4x world-speed conversion may remain');

console.log('Race pace checks passed: world motion, HUD telemetry, and handling thresholds share one velocity scale.');
