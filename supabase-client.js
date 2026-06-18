// ============================================================================
// SUPABASE CLIENT CONFIGURATION
// ============================================================================
// ⚠️ REQUIRED SETUP — the app will not run until you fill these in.
//
// 1. Create a project at https://supabase.com (free tier is fine)
// 2. Go to Project Settings → API
// 3. Copy "Project URL" into SUPABASE_URL below
// 4. Copy "anon public" key into SUPABASE_ANON_KEY below
//
// The anon key is safe to expose in client-side code — it has no power on
// its own. Every table is locked down with Row Level Security (see
// sql/schema.sql), so the anon key can only do what a signed-in user is
// allowed to do, nothing more. Never put your "service_role" key here.
// ============================================================================

const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';

if (SUPABASE_URL.includes('YOUR-PROJECT-REF') || SUPABASE_ANON_KEY.includes('YOUR-ANON')) {
  console.warn(
    '%c⚠️ Nexus setup incomplete',
    'font-size:14px;font-weight:bold;color:#fc5c5c;',
    '\nYou need to add your Supabase URL and anon key in js/supabase-client.js.\nSee SETUP.md for step-by-step instructions.'
  );
}

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: {
    params: { eventsPerSecond: 10 },
  },
});

// ----------------------------------------------------------------------------
// AI proxy endpoint — set after deploying the Supabase Edge Function in
// functions/ai-chat. Until then AI features will show a clear error instead
// of silently failing or leaking a key.
// ----------------------------------------------------------------------------
const AI_PROXY_URL = `${SUPABASE_URL}/functions/v1/ai-chat`;

window.__nexus = { supabase, AI_PROXY_URL, SUPABASE_URL, SUPABASE_ANON_KEY };
