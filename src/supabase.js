import { createClient } from '@supabase/supabase-js';

// ============================================================================
// SUPABASE CONFIGURATION
// Replace the placeholders below with your Supabase Project URL and Anon Key.
// See README.md for step-by-step instructions on setting up your database!
// ============================================================================
// Detect credentials from environment variables (checking both Vite and Next.js prefixes)
const ENV_URL = import.meta.env.VITE_SUPABASE_URL || import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
const ENV_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Only treat the connection as configured when the user supplied real
// credentials. Previously a real key was hard-coded as a fallback, which
// leaked data to a third-party project and meant offline (LocalStorage) mode
// was never reachable without editing the source.
const ENV_URL_VALID = typeof ENV_URL === 'string' && ENV_URL.length > 0 && !ENV_URL.includes('YOUR_SUPABASE_PROJECT_ID');
const ENV_KEY_VALID = typeof ENV_KEY === 'string' && ENV_KEY.length > 0 && !ENV_KEY.includes('YOUR_SUPABASE_ANON_KEY') && !ENV_KEY.includes('YOUR_SUPABASE_PUBLISHABLE_KEY');

const SUPABASE_URL = ENV_URL_VALID ? ENV_URL : null;
const SUPABASE_ANON_KEY = ENV_KEY_VALID ? ENV_KEY : null;

// Check if credentials have been updated by the user
const isConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabase = null;
let connectionVerified = false;

if (isConfigured) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('⚡ Supabase client initialized.');

    supabase.from('scores').select('*', { count: 'exact', head: true }).then(({ error }) => {
      if (error) {
        console.warn('⚠️ Supabase connection verified but table may not exist:', error.message);
        console.warn('⚠️ Run supabase/migrations/001_create_scores_table.sql in your Supabase SQL Editor.');
      } else {
        connectionVerified = true;
        console.log('✅ Supabase connection verified. scores table exists and is accessible.');
      }
    }).catch((err) => {
      console.warn('⚠️ Supabase connection failed:', err.message);
    });
  } catch (err) {
    console.warn('⚠️ Supabase initialization error, falling back to local storage:', err);
  }
} else {
  console.log('ℹ️ Supabase credentials not set. Operating in offline LocalStorage mode.');
}

// ----------------------------------------------------------------------------
// OFFLINE FALLBACK (LocalStorage)
// When Supabase is not configured, scores are persisted per-track in the
// browser so the game remains fully playable and the leaderboard still works.
// ----------------------------------------------------------------------------
const LB_STORAGE_PREFIX = 'pixel-prix:scores:';

function loadLocalScores(trackId) {
  try {
    const raw = localStorage.getItem(LB_STORAGE_PREFIX + trackId);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalScores(trackId, scores) {
  try {
    localStorage.setItem(LB_STORAGE_PREFIX + trackId, JSON.stringify(scores));
  } catch {
    // Storage may be unavailable (private mode / quota) — ignore.
  }
}

/**
 * Submits a new race score to the global Supabase leaderboard.
 */
export async function submitScore({ playerName, carId, trackId, timeMs, metadata }) {
  const normalizedName = String(playerName || '').trim().slice(0, 16);
  if (!normalizedName || !carId || !trackId || !Number.isFinite(timeMs) || timeMs <= 0) {
    return { success: false, error: 'Enter a driver name and finish a valid race first.' };
  }

  const scoreData = {
    player_name: normalizedName,
    car_id: carId,
    track_id: trackId,
    time_ms: Math.round(timeMs),
    metadata: metadata || null
  };

  if (!supabase) {
    // Offline fallback: store in LocalStorage.
    const scores = loadLocalScores(trackId);
    const record = { ...scoreData, id: Date.now(), created_at: new Date().toISOString() };
    scores.push(record);
    saveLocalScores(trackId, scores);
    return { success: true, backend: 'LocalStorage', data: [record] };
  }

  let { data, error } = await supabase
    .from('scores')
    .insert(scoreData)
    .select()
    .single();

  if (error) {
    // Check if the error is due to a missing 'metadata' column on the remote table
    if (metadata && (error.code === '42703' || error.message.includes('column "metadata"'))) {
      console.warn('⚠️ Supabase metadata column missing. Retrying score submission without metadata...');
      const fallbackData = { ...scoreData };
      delete fallbackData.metadata;

      const retryResult = await supabase
        .from('scores')
        .insert(fallbackData)
        .select()
        .single();

      if (retryResult.error) {
        console.warn('Supabase score submission failed on retry:', retryResult.error.message);
        return { success: false, error: retryResult.error.message };
      }

      data = retryResult.data;
      error = null;
    } else {
      console.warn('Supabase score submission failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  connectionVerified = true;
  return { success: true, backend: 'Supabase', data: [data] };
}

/**
 * Fetches top 10 fastest times for a given track_id.
 */
export async function fetchTopScores(trackId) {
  if (!supabase) {
    // Offline fallback: read from LocalStorage, sorted fastest-first.
    const scores = loadLocalScores(trackId)
      .slice()
      .sort((a, b) => a.time_ms - b.time_ms)
      .slice(0, 10);
    return { scores, backend: 'LocalStorage' };
  }

  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .eq('track_id', trackId)
    .order('time_ms', { ascending: true })
    .limit(10);

  if (error) {
    console.warn('Supabase leaderboard fetch failed:', error.message);
    return { scores: [], backend: 'Unavailable', error: error.message };
  }

  connectionVerified = true;
  return { scores: data || [], backend: 'Supabase' };
}

export function subscribeToScores(trackId, onChange) {
  if (!supabase) return () => {};

  const channel = supabase
    .channel(`scores:${trackId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'scores',
      filter: `track_id=eq.${trackId}`
    }, onChange)
    .subscribe();

  return () => supabase.removeChannel(channel);
}

export function getBackendStatus() {
  if (!isConfigured) return 'Supabase unavailable';
  if (!connectionVerified) return 'Connecting to Supabase…';
  return 'Supabase Connected';
}
