import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

function loadEnvFile() {
  try {
    const contents = readFileSync(new URL('../.env', import.meta.url), 'utf8');

    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;

      const [, key, rawValue] = match;
      const value = rawValue.replace(/^(["'])(.*)\1$/, '$2');
      process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

loadEnvFile();

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://vtnezkwpauvxgfnktjbf.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_rCP0G5TWK69ak7WjWpVGYQ_U0kYl5hm';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function verifySetup() {
  console.log('🔍 Verifying Supabase setup...\n');

  // Check connection
  const { count, error: connectionError } = await supabase
    .from('scores')
    .select('*', { count: 'exact', head: true });

  if (connectionError) {
    console.error('❌ ERROR: Could not verify the scores table');
    console.error('   Details:', connectionError.message);
    if (connectionError.message.includes('fetch failed')) {
      console.error('\n📋 Check your network connection and Supabase URL/key.\n');
    } else {
      console.error('\n📋 If the table has not been created, run supabase/migrations/001_create_scores_table.sql in the Supabase SQL Editor.\n');
    }
    process.exit(1);
  }

  console.log('✅ Supabase connection verified!');
  console.log(`   Table: scores`);
  console.log(`   Total rows: ${count ?? 0}`);
  console.log(`   URL: ${SUPABASE_URL}`);
  console.log('\n🎉 Your leaderboards are ready to go!');
  process.exit(0);
}

verifySetup();
