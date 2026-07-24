import { createClient } from '@supabase/supabase-js';

// ============================================================================
// SUPABASE CONFIGURATION
// Replace the placeholders below with your Supabase Project URL and Anon Key.
// See README.md for step-by-step instructions on setting up your database!
// ============================================================================
// Detect credentials from environment variables (checking both Vite and Next.js prefixes)
const getEnv = (key) => {
  if (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env[key]) {
    return import.meta.env[key];
  }
  if (typeof process !== 'undefined' && process && process.env && process.env[key]) {
    return process.env[key];
  }
  return null;
};

const ENV_URL = getEnv('VITE_SUPABASE_URL') || getEnv('NEXT_PUBLIC_SUPABASE_URL');
const ENV_KEY = getEnv('VITE_SUPABASE_ANON_KEY') || getEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') || getEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');

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

export let supabase = null;
let connectionVerified = false;

let isSyncing = false;

/**
 * Automatically syncs any local-only scores stored in LocalStorage
 * (e.g. from offline play or prior fallback runs) up to the live Supabase database.
 */
export async function syncLocalScoresToSupabase() {
  if (!supabase || isSyncing) return { syncedCount: 0 };
  isSyncing = true;
  let syncedCount = 0;

  try {
    const trackIds = new Set();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(LB_STORAGE_PREFIX)) {
        trackIds.add(key.slice(LB_STORAGE_PREFIX.length));
      }
    }

    for (const trackId of trackIds) {
      const localScores = loadLocalScores(trackId);
      if (!localScores || localScores.length === 0) continue;

      const { data: remoteScores, error } = await supabase
        .from('scores')
        .select('player_name, time_ms')
        .eq('track_id', trackId);

      if (error || !remoteScores) continue;

      const remoteSet = new Set(remoteScores.map(s => `${s.player_name}:${s.time_ms}`));

      for (const ls of localScores) {
        const key = `${ls.player_name}:${ls.time_ms}`;
        if (!remoteSet.has(key)) {
          const result = await submitScore({
            playerName: ls.player_name,
            carId: ls.car_id,
            trackId: ls.track_id || trackId,
            timeMs: ls.time_ms,
            metadata: ls.metadata || null
          });

          if (result.success && result.backend === 'Supabase') {
            remoteSet.add(key);
            syncedCount++;
            console.log(`✅ Synced local score to live Supabase: ${ls.player_name} (${ls.time_ms}ms) on ${trackId}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn('⚠️ Error during local score synchronization:', err);
  } finally {
    isSyncing = false;
  }

  return { syncedCount };
}

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
        syncLocalScoresToSupabase();
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

  // Helper to persist locally as cache
  const saveToLocalCache = (record) => {
    const scores = loadLocalScores(trackId);
    const exists = scores.some(s => s.player_name === record.player_name && s.time_ms === record.time_ms);
    if (!exists) {
      scores.push(record);
      saveLocalScores(trackId, scores);
    }
  };

  if (!supabase) {
    // Offline fallback: store in LocalStorage.
    const record = { ...scoreData, id: Date.now(), created_at: new Date().toISOString() };
    saveToLocalCache(record);
    return { success: true, backend: 'LocalStorage', data: [record] };
  }

  // Define the core insertion attempt
  const insertAttempt = async (payload) => {
    const { data, error } = await supabase
      .from('scores')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    return data;
  };

  // Helper for exponential backoff retrying
  const executeWithRetry = async (payload, retries = 3, delay = 500) => {
    try {
      return await insertAttempt(payload);
    } catch (error) {
      // Catch missing metadata column (PostgREST code PGRST204 or PostgreSQL 42703 or message with 'metadata')
      const isMetadataColError = payload.metadata && (
        error.code === 'PGRST204' ||
        error.code === '42703' ||
        /metadata/i.test(error.message || '')
      );

      if (isMetadataColError) {
        console.warn('⚠️ Supabase metadata column missing in database/schema cache. Retrying payload without metadata...');
        const fallbackPayload = { ...payload };
        delete fallbackPayload.metadata;
        return executeWithRetry(fallbackPayload, retries, delay);
      }

      if (retries <= 1) {
        throw error;
      }
      console.warn(`⚠️ Supabase score upload failed: "${error.message}". Retrying in ${delay}ms... (${retries - 1} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return executeWithRetry(payload, retries - 1, delay * 2);
    }
  };

  try {
    const data = await executeWithRetry(scoreData, 3, 500);
    connectionVerified = true;
    saveToLocalCache(data || { ...scoreData, id: Date.now(), created_at: new Date().toISOString() });
    return { success: true, backend: 'Supabase', data: [data] };
  } catch (error) {
    console.warn('⚠️ Supabase upload failed after retries. Storing score in LocalStorage fallback:', error.message);
    const record = { ...scoreData, id: Date.now(), created_at: new Date().toISOString() };
    saveToLocalCache(record);
    return { success: true, backend: 'LocalStorage', data: [record] };
  }
}

/**
 * Fetches top 10 fastest times for a given track_id.
 */
export async function fetchTopScores(trackId) {
  let remoteScores = [];
  let fetchError = null;
  if (supabase) {
    const { data, error } = await supabase
      .from('scores')
      .select('*')
      .eq('track_id', trackId)
      .order('time_ms', { ascending: true })
      .limit(20);
    if (!error && data) {
      remoteScores = data;
      connectionVerified = true;
    } else if (error) {
      console.warn('⚠️ Supabase fetch error:', error.message);
      fetchError = error;
    }
  }

  const localScores = loadLocalScores(trackId);
  const combined = [...remoteScores];
  localScores.forEach(ls => {
    const matchFound = combined.some(s =>
      (s.id && ls.id && s.id === ls.id) ||
      (s.player_name === ls.player_name && s.time_ms === ls.time_ms)
    );
    if (!matchFound) {
      combined.push(ls);
    }
  });
  combined.sort((a, b) => a.time_ms - b.time_ms);
  return {
    scores: combined.slice(0, 10),
    backend: remoteScores.length > 0 ? 'Hybrid' : 'LocalStorage',
    error: (remoteScores.length === 0 && localScores.length === 0) ? fetchError : null
  };
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
