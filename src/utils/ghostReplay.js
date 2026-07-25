const STORAGE_PREFIX = 'pixel-prix:ghost-replay:v1';
const MAX_SAMPLES = 1800;

function sanitisePart(value, fallback) {
  const clean = String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || fallback;
}

function storageKey({ trackId, carId, weatherId = 'auto', setupId = 'balanced' }) {
  return [
    STORAGE_PREFIX,
    sanitisePart(trackId, 'track'),
    sanitisePart(carId, 'car'),
    sanitisePart(weatherId, 'auto'),
    sanitisePart(setupId, 'balanced')
  ].join(':');
}

function normaliseReplay(candidate) {
  if (!candidate || typeof candidate !== 'object' || candidate.version !== 1) return null;
  if (!Number.isFinite(candidate.finalTimeMs) || candidate.finalTimeMs <= 0) return null;
  if (!Array.isArray(candidate.samples) || candidate.samples.length < 2) return null;

  const samples = candidate.samples
    .map((sample) => {
      if (!Array.isArray(sample) || sample.length < 4) return null;
      const [timeMs, x, y, rotation] = sample.map(Number);
      if (![timeMs, x, y, rotation].every(Number.isFinite) || timeMs < 0) return null;
      return [Math.round(timeMs), x, y, rotation];
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);

  if (samples.length < 2) return null;
  return {
    version: 1,
    finalTimeMs: Math.round(candidate.finalTimeMs),
    carId: sanitisePart(candidate.carId, 'car'),
    samples
  };
}

/**
 * Reads the best locally recorded ghost for an identical session setup.
 * Storage is deliberately optional: a private-session browser can still race.
 */
export function loadGhostReplay(session) {
  try {
    return normaliseReplay(JSON.parse(localStorage.getItem(storageKey(session))));
  } catch {
    return null;
  }
}

/**
 * Searches local storage for the fastest ghost replay recorded on a specific track.
 */
export function loadBestTrackGhost(trackId) {
  let bestReplay = null;
  const prefix = `${STORAGE_PREFIX}:${sanitisePart(trackId, 'track')}:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix)) {
        const candidate = normaliseReplay(JSON.parse(localStorage.getItem(key)));
        if (candidate && (!bestReplay || candidate.finalTimeMs < bestReplay.finalTimeMs)) {
          bestReplay = candidate;
        }
      }
    }
  } catch {
    // Storage error fallback
  }
  return bestReplay;
}

/** Creates a lightweight recorder; samples are appended from the live scene. */
export function createGhostRecorder({ carId }) {
  return {
    carId: sanitisePart(carId, 'car'),
    samples: [],
    lastSampleMs: -1
  };
}

/**
 * Captures a sampled car transform. Array tuples keep localStorage payloads
 * compact enough for a full three-lap race on mobile browsers.
 */
export function captureGhostSample(recorder, { timeMs, x, y, rotation }) {
  if (!recorder || !Array.isArray(recorder.samples)) return;
  const values = [timeMs, x, y, rotation].map(Number);
  if (!values.every(Number.isFinite) || values[0] < 0 || values[0] <= recorder.lastSampleMs) return;

  const sample = [
    Math.round(values[0]),
    Math.round(values[1] * 10) / 10,
    Math.round(values[2] * 10) / 10,
    Math.round(values[3] * 10000) / 10000
  ];

  if (recorder.samples.length >= MAX_SAMPLES) {
    // Preserve the whole session by thinning older detail rather than silently
    // truncating the finish. This only applies to unusually long sessions.
    recorder.samples = recorder.samples.filter((_, index) => index % 2 === 0);
  }
  recorder.samples.push(sample);
  recorder.lastSampleMs = sample[0];
}

/**
 * Stores a replay only when it is faster than the existing replay for this
 * exact car/track/weather/setup combination. Returns whether it was saved.
 */
export function saveGhostReplay(session, recorder, finalTimeMs) {
  const roundedFinalTime = Math.round(Number(finalTimeMs));
  if (!recorder || !Number.isFinite(roundedFinalTime) || roundedFinalTime <= 0) return false;
  if (!Array.isArray(recorder.samples) || recorder.samples.length < 2) return false;

  const replay = normaliseReplay({
    version: 1,
    finalTimeMs: roundedFinalTime,
    carId: recorder.carId,
    samples: recorder.samples
  });
  if (!replay) return false;

  const existing = loadGhostReplay(session);
  if (existing && existing.finalTimeMs <= replay.finalTimeMs) return false;

  try {
    localStorage.setItem(storageKey(session), JSON.stringify(replay));
    return true;
  } catch {
    return false;
  }
}

function interpolateRotation(from, to, amount) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
}

/**
 * Returns an interpolated transform for a replay at a particular elapsed time.
 * Returns null after the ghost has completed so callers can fade it out.
 */
export function sampleGhostReplay(replay, elapsedMs) {
  if (!replay || !Array.isArray(replay.samples) || replay.samples.length < 2) return null;
  const time = Number(elapsedMs);
  if (!Number.isFinite(time) || time < 0 || time > replay.finalTimeMs) return null;

  const samples = replay.samples;
  if (time <= samples[0][0]) {
    const [, x, y, rotation] = samples[0];
    return { x, y, rotation };
  }

  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid][0] < time) low = mid + 1;
    else high = mid;
  }

  const after = samples[low];
  const before = samples[Math.max(0, low - 1)];
  const span = Math.max(1, after[0] - before[0]);
  const amount = Math.min(1, Math.max(0, (time - before[0]) / span));
  return {
    x: before[1] + (after[1] - before[1]) * amount,
    y: before[2] + (after[2] - before[2]) * amount,
    rotation: interpolateRotation(before[3], after[3], amount)
  };
}
