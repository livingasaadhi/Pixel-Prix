import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const viewports = [
  ['desktop-wide', 1440, 900], ['desktop-compact', 1024, 768],
  ['mobile-portrait', 390, 844], ['mobile-landscape', 844, 390]
];
const server = spawn(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npx vite --host 127.0.0.1 --port 4173 --strictPort']
  : ['vite', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { cwd: root, stdio: 'ignore' });
const output = process.env.KEEP_VIEWPORT_SHOTS || await mkdtemp(path.join(os.tmpdir(), 'pixel-prix-viewports-'));

async function waitForServer() {
  for (let i = 0; i < 40; i += 1) {
    try { await fetch('http://127.0.0.1:4173'); return; } catch { await new Promise((resolve) => setTimeout(resolve, 150)); }
  }
  throw new Error('Vite did not become available for viewport smoke coverage.');
}

async function captureViewport(width, height, screenshot) {
  const browser = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`,
    `--screenshot=${screenshot}`, 'http://127.0.0.1:4173'
  ], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 120; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        const details = await stat(screenshot);
        if (details.size > 1000) return;
      } catch { /* screenshot has not been written yet */ }
    }
    throw new Error(`Timed out capturing ${width}×${height}.`);
  } finally {
    browser.kill();
  }
}

try {
  await waitForServer();
  for (const [name, width, height] of viewports) {
    const screenshot = path.join(output, `${name}.png`);
    await captureViewport(width, height, screenshot);
    const details = await stat(screenshot);
    if (details.size < 1000) throw new Error(`${name} screenshot was unexpectedly empty.`);
  }
  console.log(`Viewport smoke passed: ${viewports.map(([name]) => name).join(', ')}.`);
} finally {
  server.kill();
  if (!process.env.KEEP_VIEWPORT_SHOTS) await rm(output, { recursive: true, force: true });
}
