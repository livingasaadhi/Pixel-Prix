import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'style.css'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
const runtimeCreatedIds = new Set(['hud-speed-vignette']);

function collectJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScriptFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const references = new Map();
for (const filePath of collectJavaScriptFiles(path.join(root, 'src'))) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
    const id = match[1];
    if (!references.has(id)) references.set(id, []);
    references.get(id).push(path.relative(root, filePath));
  }
}

const missing = [...references.entries()]
  .filter(([id]) => !htmlIds.has(id) && !runtimeCreatedIds.has(id));

if (missing.length > 0) {
  const details = missing.map(([id, files]) => `- #${id} (${[...new Set(files)].join(', ')})`).join('\n');
  throw new Error(`UI integrity check failed. Missing DOM IDs:\n${details}`);
}

assert.match(html, /LIVE TIMING/, 'the app chrome must use original live-timing branding');
assert.doesNotMatch(html, />F1 BROADCAST</, 'the public UI must not present copied Formula 1 branding');
assert.match(css, /PRODUCTION CASCADE LOCK/, 'the production visual system must remain the final style layer');
assert.match(css, /@media \(max-width: 860px\) and \(orientation: landscape\)/, 'the touch race HUD must retain a landscape-specific layout');
assert.match(
  css,
  /\.touch-device #hud-steer-left-group, \.touch-device #hud-drive-left-group \{ display: none !important; \}/,
  'touch racers must see one deliberate steering/control scheme rather than duplicate inputs'
);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, 'the production UI must respect reduced-motion preferences');

console.log(`UI integrity check passed: ${references.size} static DOM references verified.`);
