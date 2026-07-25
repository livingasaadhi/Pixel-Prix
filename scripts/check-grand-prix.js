import assert from 'node:assert/strict';
import { CARS } from '../src/data/cars.js';
import {
  createAiGrid,
  getGrandPrixClassification,
  resolveWeatherCondition,
  updateAiProgress
} from '../src/utils/grandPrix.js';
import { recordSoloRace } from '../src/utils/progression.js';

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value))
};

const gridA = createAiGrid({
  cars: CARS,
  playerCarId: CARS[0].id,
  trackId: 'verification-ring',
  count: 6,
  seed: 'stable-seed'
});
const gridB = createAiGrid({
  cars: CARS,
  playerCarId: CARS[0].id,
  trackId: 'verification-ring',
  count: 6,
  seed: 'stable-seed'
});

assert.equal(gridA.length, 6, 'requested Grand Prix rival count should be created');
assert.deepEqual(
  gridA.map((driver) => [driver.id, driver.carId, driver.name]),
  gridB.map((driver) => [driver.id, driver.carId, driver.name]),
  'the same session seed should build the same AI grid'
);
assert.equal(new Set(gridA.map((driver) => driver.carId)).size, gridA.length, 'AI cars must be unique');
assert.ok(!gridA.some((driver) => driver.carId === CARS[0].id), 'the player car must stay out of the AI field');

const dry = updateAiProgress(gridA[0], 20_000, 3, 25_000, resolveWeatherCondition('dry'));
const wet = updateAiProgress(gridA[0], 20_000, 3, 25_000, resolveWeatherCondition('wet'));
assert.ok(dry.totalDistance > wet.totalDistance, 'wet conditions should reduce AI race pace');

const finalRival = updateAiProgress({ ...gridA[1], baseLapTimeMs: 10_000 }, 35_000, 3, 1_000, 'dry');
assert.equal(finalRival.finished, true, 'an AI driver should finish once it covers race distance');

const classification = getGrandPrixClassification(
  { id: 'player', isPlayer: true, finished: true, finishTimeMs: 45_000, totalDistance: 3_000 },
  [
    { id: 'winner', finished: true, finishTimeMs: 44_000, totalDistance: 3_000 },
    { id: 'running', finished: false, completedLaps: 2, distance: 900, totalDistance: 2_900 }
  ]
);
assert.deepEqual(classification.map((entry) => entry.id), ['winner', 'player', 'running']);
assert.deepEqual(classification.map((entry) => entry.position), [1, 2, 3]);

const timeTrialProgress = recordSoloRace({ trackId: 'verification-ring', totalTimeMs: 60_000 });
assert.equal(timeTrialProgress.grandPrixPosition, null, 'a time trial must not be classified as Grand Prix');
assert.equal(timeTrialProgress.profile.grandPrixWins, 0, 'a time trial must not award a Grand Prix win');
assert.equal(timeTrialProgress.profile.podiums, 0, 'a time trial must not award a Grand Prix podium');

console.log('Grand Prix checks passed: deterministic grid, weather pace, finish state, classification, and progression isolation verified.');
