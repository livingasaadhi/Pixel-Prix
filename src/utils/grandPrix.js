/**
 * Framework-independent helpers for building an offline Grand Prix field.
 *
 * Distances are expressed in whatever world units a track uses.  The AI
 * simulator deliberately does not move sprites or query a scene, which makes
 * it suitable for UI previews, headless simulations, and race-state tests.
 */

const DEFAULT_WEATHER_ID = 'dry';
const MAX_GRID_SIZE = 64;
const MAX_DELTA_MS = 3_600_000;
const MIN_TRACK_LENGTH = 0.001;
const MAX_TRACK_LENGTH = 10_000_000;

const DRIVER_NAMES = Object.freeze([
  'Avery Sol',
  'Mika Vale',
  'Rory Kestrel',
  'Juno Hart',
  'Tarin Moss',
  'Nico Ember',
  'Sage Mercer',
  'Iris Calder',
  'Quinn Vega',
  'Lena Voss',
  'Milo Arden',
  'Zara Flint',
  'Cato Wynn',
  'Nell Orion',
  'Pax Rowan',
  'Thea Rush',
  'Kian Frost',
  'Rhea Nova',
  'Dax Linden',
  'Noor Sable',
  'Emi Briar',
  'Oren Hale',
  'Vera Skye',
  'Finn Marlow'
]);

/**
 * Immutable presentation and handling defaults for the built-in weather modes.
 * `aiPaceMultiplier` is used by {@link updateAiProgress}; the other physics
 * values are available for a renderer or player-vehicle implementation.
 */
export const WEATHER_PRESETS = Object.freeze({
  dry: Object.freeze({
    id: 'dry',
    label: 'Dry',
    style: Object.freeze({
      sky: '#77c9ff',
      horizon: '#d8f3ff',
      terrain: '#76b852',
      asphalt: '#303540',
      roadEdge: '#f4f5f7',
      ambient: '#fff1bc',
      precipitation: 'none',
      precipitationAlpha: 0,
      headlights: false
    }),
    physics: Object.freeze({
      gripMultiplier: 1,
      accelerationMultiplier: 1,
      topSpeedMultiplier: 1,
      brakingMultiplier: 1,
      steeringMultiplier: 1,
      visibilityMultiplier: 1,
      aiPaceMultiplier: 1
    })
  }),
  overcast: Object.freeze({
    id: 'overcast',
    label: 'Overcast',
    style: Object.freeze({
      sky: '#8496ab',
      horizon: '#c3ccd6',
      terrain: '#6d8d62',
      asphalt: '#343941',
      roadEdge: '#e1e4e8',
      ambient: '#d5deea',
      precipitation: 'mist',
      precipitationAlpha: 0.08,
      headlights: false
    }),
    physics: Object.freeze({
      gripMultiplier: 0.97,
      accelerationMultiplier: 0.985,
      topSpeedMultiplier: 0.99,
      brakingMultiplier: 0.975,
      steeringMultiplier: 0.98,
      visibilityMultiplier: 0.92,
      aiPaceMultiplier: 0.985
    })
  }),
  wet: Object.freeze({
    id: 'wet',
    label: 'Wet',
    style: Object.freeze({
      sky: '#43556c',
      horizon: '#8ea4b7',
      terrain: '#4f7654',
      asphalt: '#202936',
      roadEdge: '#c5d1dc',
      ambient: '#9cb5ca',
      precipitation: 'rain',
      precipitationAlpha: 0.58,
      headlights: true
    }),
    physics: Object.freeze({
      gripMultiplier: 0.78,
      accelerationMultiplier: 0.9,
      topSpeedMultiplier: 0.94,
      brakingMultiplier: 0.82,
      steeringMultiplier: 0.84,
      visibilityMultiplier: 0.72,
      aiPaceMultiplier: 0.88
    })
  }),
  night: Object.freeze({
    id: 'night',
    label: 'Night',
    style: Object.freeze({
      sky: '#11162b',
      horizon: '#283862',
      terrain: '#263e37',
      asphalt: '#252934',
      roadEdge: '#c6d3ec',
      ambient: '#778bc7',
      precipitation: 'none',
      precipitationAlpha: 0,
      headlights: true
    }),
    physics: Object.freeze({
      gripMultiplier: 0.96,
      accelerationMultiplier: 0.98,
      topSpeedMultiplier: 0.985,
      brakingMultiplier: 0.96,
      steeringMultiplier: 0.97,
      visibilityMultiplier: 0.76,
      aiPaceMultiplier: 0.965
    })
  })
});

const WEATHER_ALIASES = Object.freeze({
  clear: 'dry',
  sunny: 'dry',
  warm: 'dry',
  cool: 'overcast',
  cloudy: 'overcast',
  cloud: 'overcast',
  rain: 'wet',
  rainy: 'wet',
  storm: 'wet',
  neon: 'night'
});

/**
 * Resolve a weather id to one of {@link WEATHER_PRESETS}. Unknown or missing
 * values safely use the dry preset. Track display strings such as
 * `"OVERCAST · 19°C"` are also recognised.
 *
 * @param {string | { id?: string } | null | undefined} id
 * @returns {Readonly<(typeof WEATHER_PRESETS)[keyof typeof WEATHER_PRESETS]>}
 */
export function resolveWeatherCondition(id) {
  const rawId = typeof id === 'object' && id !== null ? id.id : id;
  const normalised = String(rawId || '').trim().toLowerCase();

  if (WEATHER_PRESETS[normalised]) return WEATHER_PRESETS[normalised];
  if (WEATHER_ALIASES[normalised]) return WEATHER_PRESETS[WEATHER_ALIASES[normalised]];
  if (/rain|wet|storm/.test(normalised)) return WEATHER_PRESETS.wet;
  if (/night|neon|dark/.test(normalised)) return WEATHER_PRESETS.night;
  if (/overcast|cloud|cool|mist/.test(normalised)) return WEATHER_PRESETS.overcast;
  return WEATHER_PRESETS[DEFAULT_WEATHER_ID];
}

/**
 * Build a deterministic AI entry list. `count` is the desired number of AI
 * racers (the player is not included), and is capped by the number of unique
 * non-player cars supplied.
 *
 * @param {{
 *   cars?: Array<string | { id?: string, name?: string, color?: string, topSpeed?: number, maxSpeed?: number, acceleration?: number, handling?: number }>,
 *   playerCarId?: string | null,
 *   trackId?: string | null,
 *   count?: number,
 *   seed?: string | number | null
 * }} options
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   carId: string,
 *   carName: string,
 *   carColor: string | null,
 *   gridPosition: number,
 *   pace: number,
 *   consistency: number,
 *   aggression: number,
 *   variationSeed: number,
 *   completedLaps: number,
 *   distance: number,
 *   totalDistance: number,
 *   progress: number,
 *   raceTimeMs: number,
 *   finished: boolean,
 *   finishTimeMs: null
 * }>}
 */
export function createAiGrid({
  cars = [],
  playerCarId = null,
  trackId = 'unknown-track',
  count = 7,
  seed = 0
} = {}) {
  const playerKey = normaliseKey(playerCarId);
  const availableCars = getUniqueCars(cars).filter((car) => car.key !== playerKey);
  const requestedCount = toBoundedInteger(count, 7, 0, MAX_GRID_SIZE);
  const fieldSize = Math.min(requestedCount, availableCars.length);
  const random = createSeededRandom(
    `${serialiseSeed(seed)}|${String(trackId || 'unknown-track')}|${playerKey}|${availableCars.map((car) => car.id).join('|')}`
  );
  const shuffledCars = shuffle(availableCars, random).slice(0, fieldSize);
  const shuffledNames = shuffle([...DRIVER_NAMES], random);

  const entries = shuffledCars.map((car, index) => {
    const carBonus = getCarPaceBonus(car);
    const pace = roundTo(clamp(0.9 + random() * 0.14 + carBonus, 0.84, 1.1), 4);
    const consistency = roundTo(clamp(0.72 + random() * 0.25, 0.65, 0.99), 4);
    const aggression = roundTo(clamp(0.25 + random() * 0.62, 0.1, 0.95), 4);
    const name = getDriverName(shuffledNames, index);
    const variationSeed = Math.floor(random() * 0xFFFFFFFF) >>> 0;

    return {
      id: `ai-${slugify(trackId)}-${car.key}-${index + 1}`,
      name,
      carId: car.id,
      carName: car.name,
      carColor: car.color,
      gridPosition: 0,
      pace,
      consistency,
      aggression,
      variationSeed,
      completedLaps: 0,
      distance: 0,
      totalDistance: 0,
      progress: 0,
      raceTimeMs: 0,
      finished: false,
      finishTimeMs: null
    };
  });

  // Faster drivers begin farther up the AI grid. Stable tie-breaking keeps
  // identical inputs identical even where Array#sort is not assumed stable.
  entries.sort((a, b) => b.pace - a.pace || b.consistency - a.consistency || a.id.localeCompare(b.id));
  return entries.map((entry, index) => ({ ...entry, gridPosition: index + 1 }));
}

/**
 * Advance a single AI racer without mutating its previous state.
 *
 * The function estimates a baseline lap duration from `trackLength`, then
 * applies the driver's pace, consistency, and weather multiplier. Supply a
 * `baseLapTimeMs` property on `ai` to override that estimate when a track has
 * a known target lap time.
 *
 * @param {Record<string, unknown>} ai Previous AI state (normally an entry from {@link createAiGrid}).
 * @param {number} deltaMs Elapsed simulation time in milliseconds; clamped to 0–1 hour.
 * @param {number} totalLaps Race lap count; clamped to 1–99.
 * @param {number} trackLength One lap's length in world units; must be positive.
 * @param {string | { id?: string, physics?: { aiPaceMultiplier?: number } } | null | undefined} weather
 * @returns {Record<string, unknown> & {
 *   completedLaps: number,
 *   lap: number,
 *   distance: number,
 *   totalDistance: number,
 *   lapProgress: number,
 *   progress: number,
 *   raceTimeMs: number,
 *   speedUnitsPerSecond: number,
 *   finished: boolean,
 *   finishTimeMs: number | null
 * }} A new state object; `ai` is never changed.
 */
export function updateAiProgress(ai, deltaMs, totalLaps, trackLength, weather) {
  const source = isRecord(ai) ? ai : {};
  const laps = toBoundedInteger(totalLaps, 1, 1, 99);
  const lapLength = clamp(toFiniteNumber(trackLength, 1), MIN_TRACK_LENGTH, MAX_TRACK_LENGTH);
  const raceDistance = laps * lapLength;
  const elapsedDelta = clamp(toFiniteNumber(deltaMs, 0), 0, MAX_DELTA_MS);
  const elapsedBefore = Math.max(0, toFiniteNumber(source.raceTimeMs ?? source.elapsedMs, 0));
  const initialDistance = readTotalDistance(source, lapLength, laps, raceDistance);
  const knownFinished = source.finished === true || initialDistance >= raceDistance;

  if (knownFinished) {
    const finishTimeMs = Math.max(
      0,
      toFiniteNumber(source.finishTimeMs, elapsedBefore)
    );
    return buildAiState(source, {
      laps,
      lapLength,
      raceDistance,
      totalDistance: raceDistance,
      raceTimeMs: finishTimeMs,
      speedUnitsPerSecond: 0,
      finished: true,
      finishTimeMs
    });
  }

  const condition = resolveWeatherCondition(weather);
  const customPaceMultiplier = isRecord(weather) && isRecord(weather.physics)
    ? toFiniteNumber(weather.physics.aiPaceMultiplier, condition.physics.aiPaceMultiplier)
    : condition.physics.aiPaceMultiplier;
  const weatherPace = clamp(customPaceMultiplier, 0.4, 1.2);
  const pace = clamp(toFiniteNumber(source.pace, 1), 0.5, 1.25);
  const consistency = clamp(toFiniteNumber(source.consistency, 0.82), 0.5, 1);
  const baseLapTimeMs = clamp(
    toFiniteNumber(source.baseLapTimeMs, estimateLapTimeMs(lapLength)),
    5_000,
    600_000
  );
  const variationSeed = toUInt32(source.variationSeed ?? source.seed ?? source.id ?? 'ai');
  const variation = getPaceVariation(elapsedBefore, elapsedDelta, variationSeed, consistency);
  const distancePerMs = (lapLength / baseLapTimeMs) * pace * weatherPace * variation;
  const travelledDistance = Math.max(0, distancePerMs * elapsedDelta);
  const totalDistance = Math.min(raceDistance, initialDistance + travelledDistance);
  const finished = totalDistance >= raceDistance - Number.EPSILON;
  const remainingDistance = Math.max(0, raceDistance - initialDistance);
  const crossingMs = distancePerMs > 0 ? remainingDistance / distancePerMs : elapsedDelta;
  const finishTimeMs = finished ? Math.round(elapsedBefore + Math.min(elapsedDelta, crossingMs)) : null;
  const raceTimeMs = finished ? finishTimeMs : Math.round(elapsedBefore + elapsedDelta);

  return buildAiState(source, {
    laps,
    lapLength,
    raceDistance,
    totalDistance,
    raceTimeMs,
    speedUnitsPerSecond: distancePerMs * 1_000,
    finished,
    finishTimeMs
  });
}

/**
 * Return a sorted, non-mutating classification. Finished racers rank first by
 * their finish time; active racers rank by laps completed and then distance
 * around the current lap. The returned entries receive 1-based `position`s.
 *
 * @param {Record<string, unknown> | null | undefined} player
 * @param {Array<Record<string, unknown>> | null | undefined} rivals
 * @returns {Array<Record<string, unknown> & { position: number }>}
 */
export function getGrandPrixClassification(player, rivals = []) {
  const entrants = [player, ...(Array.isArray(rivals) ? rivals : [])]
    .filter(isRecord)
    .map((entrant, index) => ({
      entrant,
      index,
      metrics: getClassificationMetrics(entrant)
    }));

  entrants.sort((a, b) => compareEntrants(a, b));
  return entrants.map(({ entrant }, index) => ({ ...entrant, position: index + 1 }));
}

function getUniqueCars(cars) {
  if (!Array.isArray(cars)) return [];
  const seen = new Set();

  return cars.reduce((uniqueCars, car, index) => {
    const normalised = normaliseCar(car, index);
    if (!normalised || seen.has(normalised.key)) return uniqueCars;
    seen.add(normalised.key);
    uniqueCars.push(normalised);
    return uniqueCars;
  }, []);
}

function normaliseCar(car, index) {
  if (typeof car === 'string' && car.trim()) {
    const id = car.trim();
    return { id, key: normaliseKey(id), name: id, color: null };
  }
  if (!isRecord(car) || !String(car.id || '').trim()) return null;

  const id = String(car.id).trim();
  return {
    id,
    key: normaliseKey(id),
    name: String(car.name || id).trim() || id,
    color: typeof car.color === 'string' ? car.color : null,
    topSpeed: toFiniteNumber(car.topSpeed ?? car.maxSpeed, NaN),
    acceleration: toFiniteNumber(car.acceleration, NaN),
    handling: toFiniteNumber(car.handling, NaN),
    sourceIndex: index
  };
}

function getCarPaceBonus(car) {
  const speed = Number.isFinite(car.topSpeed) ? clamp((car.topSpeed - 275) / 6000, -0.025, 0.025) : 0;
  const acceleration = Number.isFinite(car.acceleration)
    ? clamp((car.acceleration - 185) / 10_000, -0.012, 0.012)
    : 0;
  const handling = Number.isFinite(car.handling)
    ? clamp((car.handling - 4.3) / 400, -0.01, 0.01)
    : 0;
  return speed + acceleration + handling;
}

function getDriverName(names, index) {
  const name = names[index % names.length] || `Driver ${index + 1}`;
  const cycle = Math.floor(index / names.length);
  return cycle ? `${name} ${cycle + 1}` : name;
}

function readTotalDistance(source, lapLength, laps, raceDistance) {
  if (source.finished === true) return raceDistance;

  const explicitDistance = toFiniteNumber(
    source.totalDistance ?? source.distanceTravelled ?? source.progressDistance,
    NaN
  );
  const completedLaps = toBoundedInteger(source.completedLaps ?? source.lapsCompleted, 0, 0, laps);
  const currentLapDistance = clamp(
    toFiniteNumber(source.distance ?? source.lapDistance ?? source.distanceIntoLap, 0),
    0,
    lapLength
  );
  const lapDerivedDistance = completedLaps * lapLength + currentLapDistance;
  const fractionalProgress = toFiniteNumber(source.progress ?? source.raceProgress, NaN);
  const progressDerivedDistance = Number.isFinite(fractionalProgress) && fractionalProgress >= 0 && fractionalProgress <= 1
    ? fractionalProgress * raceDistance
    : 0;

  return clamp(
    Math.max(
      Number.isFinite(explicitDistance) ? explicitDistance : 0,
      lapDerivedDistance,
      progressDerivedDistance
    ),
    0,
    raceDistance
  );
}

function buildAiState(source, {
  laps,
  lapLength,
  raceDistance,
  totalDistance,
  raceTimeMs,
  speedUnitsPerSecond,
  finished,
  finishTimeMs
}) {
  const cappedDistance = clamp(totalDistance, 0, raceDistance);
  const completedLaps = finished
    ? laps
    : Math.min(laps, Math.floor((cappedDistance + Number.EPSILON) / lapLength));
  const distance = finished
    ? lapLength
    : Math.max(0, cappedDistance - completedLaps * lapLength);

  return {
    ...source,
    completedLaps,
    lap: finished ? laps : Math.min(laps, completedLaps + 1),
    distance,
    totalDistance: cappedDistance,
    lapProgress: finished ? 1 : clamp(distance / lapLength, 0, 1),
    progress: raceDistance > 0 ? clamp(cappedDistance / raceDistance, 0, 1) : 0,
    raceTimeMs: Math.max(0, Math.round(raceTimeMs)),
    speedUnitsPerSecond: Math.max(0, speedUnitsPerSecond),
    finished,
    finishTimeMs: finished ? Math.max(0, Math.round(finishTimeMs ?? raceTimeMs)) : null
  };
}

function estimateLapTimeMs(trackLength) {
  // This produces sensible defaults for compact test tracks and the project's
  // larger world-space circuits, while allowing callers to override it.
  return clamp(trackLength * 2.25, 35_000, 120_000);
}

function getPaceVariation(elapsedBefore, elapsedDelta, variationSeed, consistency) {
  const phase = (elapsedBefore + elapsedDelta * 0.5) / 1_000;
  const seedPhase = (variationSeed % 360) * (Math.PI / 180);
  const wobble = Math.sin(phase * 0.71 + seedPhase) * (1 - consistency) * 0.12;
  const secondWobble = Math.cos(phase * 0.19 + seedPhase * 0.5) * (1 - consistency) * 0.045;
  return clamp(1 + wobble + secondWobble, 0.82, 1.08);
}

function getClassificationMetrics(entrant) {
  const completedLaps = Math.max(0, Math.floor(toFiniteNumber(
    entrant.completedLaps ?? entrant.lapsCompleted,
    0
  )));
  const currentDistance = Math.max(0, toFiniteNumber(
    entrant.distance ?? entrant.lapDistance ?? entrant.distanceIntoLap,
    0
  ));
  const totalDistance = toFiniteNumber(
    entrant.totalDistance ?? entrant.distanceTravelled ?? entrant.progressDistance,
    NaN
  );
  const progress = clamp(toFiniteNumber(entrant.progress ?? entrant.raceProgress, 0), 0, 1);
  const status = String(entrant.status || '').trim().toUpperCase();
  const finished = entrant.finished === true || status === 'FINISHED' || progress >= 1;
  const finishTimeMs = Math.max(0, toFiniteNumber(
    entrant.finishTimeMs ?? entrant.totalTimeMs ?? (finished ? entrant.raceTimeMs : NaN),
    Number.POSITIVE_INFINITY
  ));
  const raceTimeMs = Math.max(0, toFiniteNumber(entrant.raceTimeMs ?? entrant.elapsedMs, Number.POSITIVE_INFINITY));

  return { completedLaps, currentDistance, totalDistance, progress, finished, finishTimeMs, raceTimeMs };
}

function compareEntrants(a, b) {
  const first = a.metrics;
  const second = b.metrics;

  if (first.finished !== second.finished) return first.finished ? -1 : 1;
  if (first.finished && first.finishTimeMs !== second.finishTimeMs) {
    return first.finishTimeMs - second.finishTimeMs;
  }
  if (first.completedLaps !== second.completedLaps) {
    return second.completedLaps - first.completedLaps;
  }
  if (Number.isFinite(first.totalDistance) && Number.isFinite(second.totalDistance) && first.totalDistance !== second.totalDistance) {
    return second.totalDistance - first.totalDistance;
  }
  if (first.currentDistance !== second.currentDistance) {
    return second.currentDistance - first.currentDistance;
  }
  if (first.progress !== second.progress) return second.progress - first.progress;
  if (first.raceTimeMs !== second.raceTimeMs) return first.raceTimeMs - second.raceTimeMs;
  return a.index - b.index;
}

function createSeededRandom(seed) {
  let state = toUInt32(seed);
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function toUInt32(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value) >>> 0;
  return hashString(serialiseSeed(value));
}

function hashString(value) {
  let hash = 2_166_136_261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function serialiseSeed(seed) {
  if (seed === null || seed === undefined) return '0';
  if (typeof seed === 'object') {
    try {
      return JSON.stringify(seed);
    } catch {
      return String(seed);
    }
  }
  return String(seed);
}

function normaliseKey(value) {
  return String(value || '').trim().toLowerCase();
}

function slugify(value) {
  const slug = String(value || 'track').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'track';
}

function toFiniteNumber(value, fallback) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return fallback;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBoundedInteger(value, fallback, min, max) {
  return Math.floor(clamp(toFiniteNumber(value, fallback), min, max));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
