import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const css = `${fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8')}\n${fs.readFileSync(path.join(root, 'src', 'brand-stabilizer.css'), 'utf8')}`;
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const scene = fs.readFileSync(path.join(root, 'src', 'scenes', 'RaceScene.js'), 'utf8');

assert.match(css, /1440px/, 'desktop content must cap at 1440px');
assert.match(css, /\.select-section\s*\{[^}]*grid-column:\s*span 6/, 'vehicle and circuit must each span six columns');
assert.match(css, /#session-config\s*\{[^}]*grid-column:\s*span 8/, 'session configuration must span eight columns');
assert.match(css, /#screen-select \.selection-footer,[\s\S]*?grid-column:\s*span 4 !important;[\s\S]*?position:\s*static !important;/, 'CTA region must occupy four columns in normal flow');
assert.match(css, /#screen-mp-lobby \.mp-lobby-container\s*\{[^}]*grid-column:\s*1\s*\/\s*-1 !important;[^}]*grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)/s, 'co-op lobby must use the full 12-column command surface');
assert.match(css, /#screen-leaderboard \.lb-body\s*\{[^}]*grid-column:\s*1\s*\/\s*-1 !important;[^}]*grid-template-columns:\s*repeat\(12, minmax\(0, 1fr\)\)/s, 'leaderboard must use the full 12-column timing surface');
assert.match(css, /#screen-leaderboard \.lb-table-wrap[\s\S]*?width:\s*calc\(100vw - 52px\) !important;/, 'desktop leaderboard table must fill the available width');
assert.match(html, /id="hud-alert-region"/, 'alerts must be structurally independent from telemetry');
assert.doesNotMatch(main, /_sectorTickerActive/, 'legacy shared ticker state must not return');
assert.match(main, /label: 'TRACK LIMITS', message: 'UNDER REVIEW'/, 'review alerts must include plain-language meaning');
assert.match(scene, /updateRaceCamera\(deltaSeconds = 0\.1\)/, 'race view must use one camera controller');
assert.doesNotMatch(scene, /centerCameraOnPlayer/, 'legacy competing player camera controller must not return');
assert.match(scene, /1 - speedRatio \* 0\.06/, 'speed zoom-out must stay below the approved six percent');
assert.match(css, /#hud-steer-left-group,\s*#hud-drive-left-group\s*\{\s*display:\s*none !important;/, 'duplicate touch controls must remain hidden');

console.log('Layout checks passed: 12-column shell, independent HUD alerts, single camera, and deliberate touch controls verified.');
