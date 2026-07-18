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
 * Submits a new race score to Supabase or LocalStorage.
 */
export async function submitScore({ playerName, carId, trackId, timeMs }) {
  const scoreData = {
    player_name: playerName || 'Anonymous',
    car_id: carId,
    track_id: trackId,
    time_ms: timeMs,
    created_at: new Date().toISOString()
  };

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('scores')
        .insert([scoreData])
        .select();

      if (error) throw error;
      return { success: true, backend: 'Supabase', data };
    } catch (err) {
      console.warn('Supabase insert failed, saving locally:', err.message);
    }
  }

  // LocalStorage Fallback
  saveScoreLocally(scoreData);
  return { success: true, backend: 'LocalStorage', data: [scoreData] };
}

/**
 * Fetches top 10 fastest times for a given track_id.
 */
export async function fetchTopScores(trackId) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('scores')
        .select('*')
        .eq('track_id', trackId)
        .order('time_ms', { ascending: true })
        .limit(10);

      if (!error && data) {
        return { scores: data, backend: 'Supabase' };
      }
    } catch (err) {
      console.warn('Supabase fetch failed, loading local scores:', err.message);
    }
  }

  // LocalStorage Fallback
  const localScores = getLocalScores(trackId);
  return { scores: localScores, backend: 'LocalStorage' };
}

/**
 * Saves a score entry to window.localStorage
 */
function saveScoreLocally(score) {
  try {
    const existing = JSON.parse(localStorage.getItem('pixel_prix_scores') || '[]');
    existing.push(score);
    localStorage.setItem('pixel_prix_scores', JSON.stringify(existing));
  } catch (e) {
    console.error('LocalStorage write error:', e);
  }
}

/**
 * Reads and filters top 10 scores from window.localStorage
 */
function getLocalScores(trackId) {
  try {
    const existing = JSON.parse(localStorage.getItem('pixel_prix_scores') || '[]');
    return existing
      .filter(s => s.track_id === trackId)
      .sort((a, b) => a.time_ms - b.time_ms)
      .slice(0, 10);
  } catch (e) {
    return [];
  }
}

export function getBackendStatus() {
  if (!isConfigured) return 'Offline / LocalStorage';
  if (!connectionVerified) return 'Supabase (table missing?)';
  return 'Supabase Connected';
}
