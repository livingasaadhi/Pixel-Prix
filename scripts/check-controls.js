import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const raceScene = fs.readFileSync(path.join(root, 'src', 'scenes', 'RaceScene.js'), 'utf8');

const requiredBindings = [
  ['btn-touch-accel', 'setAccelerate'],
  ['btn-touch-brake', 'setBrake'],
  ['btn-touch-reverse', 'setBrake'],
  ['btn-touch-left', 'setSteerLeft'],
  ['btn-touch-right', 'setSteerRight'],
  ['btn-touch-boost', 'setBoost'],
  ['btn-touch-boost-left', 'setBoost']
];

for (const [id, method] of requiredBindings) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `${id} must be present in the HUD`);
  assert.match(
    main,
    new RegExp(`bindButton\\(\\s*['"]${id}['"]\\s*,\\s*s\\s*=>\\s*s\\.${method}\\(true\\)\\s*,\\s*s\\s*=>\\s*s\\.${method}\\(false\\)\\s*\\)`, 's'),
    `${id} must drive RaceScene.${method} while held`
  );
}

assert.match(main, /if \('PointerEvent' in window\)/, 'HUD controls must use reliable pointer hold/release handling');
assert.match(raceScene, /setAccelerate\(v\) \{ this\.isAccelerating = Boolean\(v\); \}/, 'accelerate input must be normalized');
assert.match(
  raceScene,
  /this\.isAccelerating \|\| this\.cursors\.up\.isDown \|\| this\.wasd\.up\.isDown \|\| this\._kb\.up/,
  'the GAS pedal and keyboard throttle must enter the forward drive path'
);

console.log('Control checks passed: every HUD driving control is present, bound, and feeds the race input path.');
