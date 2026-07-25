import assert from 'node:assert/strict';
import {
  captureGhostSample,
  createGhostRecorder,
  loadGhostReplay,
  sampleGhostReplay,
  saveGhostReplay
} from '../src/utils/ghostReplay.js';

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value))
};

const session = {
  trackId: 'verification-ring',
  carId: 'test-car',
  weatherId: 'wet',
  setupId: 'rain'
};
const recorder = createGhostRecorder({ carId: session.carId });
captureGhostSample(recorder, { timeMs: 0, x: 0, y: 0, rotation: 0 });
captureGhostSample(recorder, { timeMs: 1000, x: 100, y: 50, rotation: Math.PI / 2 });
captureGhostSample(recorder, { timeMs: 2000, x: 200, y: 100, rotation: Math.PI });

assert.equal(saveGhostReplay(session, recorder, 2000), true, 'the first complete ghost should save');
const replay = loadGhostReplay(session);
assert.equal(replay?.finalTimeMs, 2000);

const sample = sampleGhostReplay(replay, 500);
assert.ok(sample, 'a ghost should interpolate between captured samples');
assert.equal(sample.x, 50);
assert.equal(sample.y, 25);
assert.ok(Math.abs(sample.rotation - Math.PI / 4) < 0.0001);

const slower = createGhostRecorder({ carId: session.carId });
captureGhostSample(slower, { timeMs: 0, x: 0, y: 0, rotation: 0 });
captureGhostSample(slower, { timeMs: 2500, x: 220, y: 110, rotation: Math.PI });
assert.equal(saveGhostReplay(session, slower, 2500), false, 'a slower replay must not overwrite a personal ghost');
assert.equal(sampleGhostReplay(replay, 2001), null, 'a finished ghost should disappear after its recorded time');

console.log('Ghost replay checks passed: storage, interpolation, and personal-best protection verified.');
