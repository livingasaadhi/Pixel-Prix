import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = `${fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8')}\n${fs.readFileSync(path.join(root, 'src', 'brand-stabilizer.css'), 'utf8')}`;
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

assert.match(html, /id="btn-touch-accel"/, 'the touch GAS control must remain in the HUD');
assert.match(html, /class="countdown-control-hint"/, 'the launch control hint must remain visible during lights');
assert.match(
  css,
  /\.touch-device\s+#screen-hud\s+#hud-drive-right-group\s*\{[^}]*display:\s*flex !important;/s,
  'touch players must have a visible right-side GAS / BRAKE control group'
);
assert.doesNotMatch(
  css,
  /\.touch-device\s+(?:#screen-hud\s+)?#hud-drive-right-group\s*\{\s*display:\s*none !important;/,
  'the only visible GAS pedal must never be hidden on touch devices'
);
assert.match(
  css,
  /\.ui-screen\s*\{[^}]*overflow-y:\s*auto !important;/,
  'menu and setup surfaces must scroll rather than clip on short mobile viewports'
);
assert.match(
  css,
  /#screen-leaderboard \.lb-rows\s*\{[^}]*overflow-y:\s*auto !important;[^}]*touch-action:\s*pan-y;/s,
  'leaderboard rows must remain vertically reachable on short touch viewports'
);
assert.match(
  css,
  /\.garage-heading p\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
  'mobile menu copy must wrap instead of clipping beyond the viewport'
);
assert.match(
  main,
  /sc\.setSteeringValue\(steering\);/,
  'the touch joystick must provide explicit analog steering'
);
assert.doesNotMatch(
  main,
  /const angle = Math\.atan2\(dy, dx\);[\s\S]{0,180}setTouchGas/,
  'the steering joystick must not silently double as the throttle'
);

console.log('Responsive UI checks passed: reachable setup, explicit touch pedals, and unambiguous steering verified.');
