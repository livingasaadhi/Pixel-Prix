import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://vtnezkwpauvxgfnktjbf.supabase.co';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_rCP0G5TWK69ak7WjWpVGYQ_U0kYl5hm';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function verifySetup() {
  console.log('🔍 Verifying Supabase setup...\n');

  // Check connection
  const { data: connectionData, error: connectionError } = await supabase
    .from('scores')
    .select('*', { count: 'exact', head: true });

  if (connectionError) {
    console.error('❌ ERROR: Cannot connect to scores table');
    console.error('   Details:', connectionError.message);
    console.error('\n📋 ACTION REQUIRED:');
    console.error('   1. Open your Supabase project dashboard');
    console.error('   2. Go to SQL Editor');
    console.error('   3. Paste the contents of supabase/migrations/001_create_scores_table.sql');
    console.error('   4. Click "Run"\n');
    process.exit(1);
  }

  console.log('✅ Supabase connection verified!');
  console.log(`   Table: scores`);
  console.log(`   Total rows: ${connectionData?.length || 0}`);
  console.log(`   URL: ${SUPABASE_URL}`);
  console.log('\n🎉 Your leaderboards are ready to go!');
  process.exit(0);
}

verifySetup();
