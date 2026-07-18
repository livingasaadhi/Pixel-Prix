import { createClient } from '@supabase/supabase-js';

// ============================================================================
// SUPABASE CONFIGURATION
// Replace the placeholders below with your Supabase Project URL and Anon Key.
// See README.md for step-by-step instructions on setting up your database!
// ============================================================================
// Detect credentials from environment variables (checking both Vite and Next.js prefixes)
const ENV_URL = import.meta.env.VITE_SUPABASE_URL || import.meta.env.NEXT_PUBLIC_SUPABASE_URL;
const ENV_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const SUPABASE_URL = ENV_URL && !ENV_URL.includes('YOUR_SUPABASE_PROJECT_ID') ? ENV_URL : 'https://vtnezkwpauvxgfnktjbf.supabase.co';
const SUPABASE_ANON_KEY = ENV_KEY && !ENV_KEY.includes('YOUR_SUPABASE_ANON_KEY') ? ENV_KEY : 'sb_publishable_rCP0G5TWK69ak7WjWpVGYQ_U0kYl5hm';

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

/**
 * Submits a new race score to the global Supabase leaderboard.
 */
export async function submitScore({ playerName, carId, trackId, timeMs }) {
  const normalizedName = String(playerName || '').trim().slice(0, 16);
  if (!normalizedName || !carId || !trackId || !Number.isFinite(timeMs) || timeMs <= 0) {
    return { success: false, error: 'Enter a driver name and finish a valid race first.' };
  }

  const scoreData = {
    player_name: normalizedName,
    car_id: carId,
    track_id: trackId,
    time_ms: Math.round(timeMs)
  };

  if (!supabase) {
    return { success: false, error: 'Global leaderboard is unavailable.' };
  }

  const { data, error } = await supabase
    .from('scores')
    .insert(scoreData)
    .select()
    .single();

  if (error) {
    console.warn('Supabase score submission failed:', error.message);
    return { success: false, error: error.message };
  }

  connectionVerified = true;
  return { success: true, backend: 'Supabase', data: [data] };
}

/**
 * Fetches top 10 fastest times for a given track_id.
 */
export async function fetchTopScores(trackId) {
  if (!supabase) {
    return { scores: [], backend: 'Unavailable', error: 'Global leaderboard is unavailable.' };
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
