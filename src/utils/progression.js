const PROFILE_STORAGE_KEY = 'pixel-prix:driver-profile:v1';
const DRIVER_NAME_STORAGE_KEY = 'pixel-prix:player-name';

const DEFAULT_PROFILE = Object.freeze({
  xp: 0,
  level: 1,
  racesCompleted: 0,
  cleanRaces: 0,
  personalBests: {}
});

function normaliseProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const xp = Math.max(0, Number(source.xp) || 0);
  return {
    xp,
    level: Math.max(1, Number(source.level) || calculateLevel(xp)),
    racesCompleted: Math.max(0, Number(source.racesCompleted) || 0),
    cleanRaces: Math.max(0, Number(source.cleanRaces) || 0),
    personalBests: source.personalBests && typeof source.personalBests === 'object'
      ? source.personalBests
      : {}
  };
}

export function calculateLevel(xp) {
  return Math.max(1, Math.floor(Math.sqrt(Math.max(0, xp) / 250)) + 1);
}

export function loadDriverProfile() {
  try {
    return normaliseProfile(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_PROFILE, personalBests: {} };
  }
}

export function saveDriverProfile(profile) {
  const normalised = normaliseProfile(profile);
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(normalised));
  } catch {
    // Progression is optional; the race remains playable when storage is unavailable.
  }
  return normalised;
}

export function getDriverName() {
  return localStorage.getItem(DRIVER_NAME_STORAGE_KEY) || 'DRIVER 1';
}

export function saveDriverName(name) {
  const value = String(name || '').trim().toUpperCase().slice(0, 16);
  if (value) {
    try {
      localStorage.setItem(DRIVER_NAME_STORAGE_KEY, value);
    } catch {
      // Storage is optional; score submission still proceeds.
    }
  }
  return value || getDriverName();
}

export function recordSoloRace({ trackId, totalTimeMs, penaltyMs = 0 }) {
  const profile = loadDriverProfile();
  const cleanRace = penaltyMs <= 0;
  const previousBest = Number(profile.personalBests[trackId]) || null;
  const personalBest = Number.isFinite(totalTimeMs) && totalTimeMs > 0 &&
    (!previousBest || totalTimeMs < previousBest);

  const earnedXp = 100 + (cleanRace ? 50 : 0) + (personalBest ? 75 : 0);
  profile.xp += earnedXp;
  profile.level = calculateLevel(profile.xp);
  profile.racesCompleted += 1;
  if (cleanRace) profile.cleanRaces += 1;
  if (personalBest) profile.personalBests[trackId] = Math.round(totalTimeMs);

  return {
    profile: saveDriverProfile(profile),
    earnedXp,
    personalBest,
    cleanRace,
    previousBest
  };
}

/** Uses UTC day-of-year so every player sees the same free featured circuit. */
export function getDailyFeaturedTrackId(tracks, now = new Date()) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayIndex = Math.floor((today - startOfYear) / 86400000);
  return tracks[dayIndex % tracks.length]?.id || null;
}
