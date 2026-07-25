import assert from 'node:assert/strict';
import { assessTrackLimits, createStewardState } from '../src/utils/stewarding.js';

const profile = {
  reviewMs: 1500,
  breachMs: 3500,
  shortcutMs: 600,
  shortcutSpeedKph: 190,
  recoveryMs: 1000,
  warningLimit: 2,
  trackLimitPenaltyMs: 5000,
  shortcutPenaltyMs: 10000
};

let state = createStewardState();
const step = (onGrass, speedKph, deltaMs) => {
  const result = assessTrackLimits(state, { onGrass, speedKph, deltaMs }, profile);
  state = result.state;
  return result.event;
};
const resetIncident = () => step(false, 0, profile.recoveryMs);

// Kerb touches and brief excursions remain clean.
assert.equal(step(true, 80, 400), null);
assert.deepEqual(resetIncident(), { type: 'clear' });
assert.equal(state.trackLimitsCount, 0);

// A sustained high-speed cut is penalized once, even if it remains off-track.
assert.deepEqual(step(true, 220, 600), { type: 'shortcut-penalty', penaltyMs: 10000 });
assert.equal(step(true, 220, 3000), null);
assert.deepEqual(resetIncident(), { type: 'clear' });

// A short touch of asphalt cannot reset a nearly completed high-speed cut.
state = createStewardState();
assert.equal(step(true, 220, 500), null);
assert.equal(step(false, 0, 999), null);
assert.deepEqual(step(true, 220, 100), { type: 'shortcut-penalty', penaltyMs: 10000 });
assert.deepEqual(resetIncident(), { type: 'clear' });

// Slow cuts cannot bypass the rules: three sustained excursions yield two
// warnings followed by a time penalty.
assert.deepEqual(step(true, 70, 3500), { type: 'warning' });
resetIncident();
assert.deepEqual(step(true, 70, 3500), { type: 'final-warning' });
resetIncident();
assert.deepEqual(step(true, 70, 3500), { type: 'track-limit-penalty', penaltyMs: 5000 });

console.log('Stewarding checks passed: kerb, shortcut, slow-cut, and re-entry scenarios verified.');
