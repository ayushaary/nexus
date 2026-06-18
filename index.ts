// ============================================================================
// Supabase Edge Function: ai-chat
// ============================================================================
// This replaces the original code's direct browser → Anthropic API call,
// which exposed (or would have needed to expose) an API key in client JS —
// anyone could read it from devtools and rack up usage on your account.
//
// This function runs server-side. It:
//   1. Verifies the caller has a valid Supabase session (real signed-in user)
//   2. Verifies the caller is actually a member of the group they're asking about
//   3. Pulls real recent messages/events/goals from the database for context
//      (instead of the hardcoded fictional squad bio from the original file)
//   4. Calls Anthropic with the server-side ANTHROPIC_API_KEY secret
//   5. Returns just the text reply to the client
//
// DEPLOY:
//   supabase functions deploy ai-chat
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    if (!ANTHROPIC_API_KEY) {
      return json({ error: 'Server is not configured with an AI provider key yet. Set ANTHROPIC_API_KEY via `supabase secrets set`.' }, 500);
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Missing Authorization header — you must be signed in.' }, 401);
    }

    // Verify the caller's session using their own JWT (not the service key —
    // this function never escalates privilege; it reads exactly what RLS
    // would let this user read anyway).
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: 'Invalid or expired session. Please sign in again.' }, 401);
    }
    const user = userData.user;

    const body = await req.json();
    const { message, groupId, history } = body;

    if (!message || typeof message !== 'string' || message.length > 4000) {
      return json({ error: 'Message is required and must be under 4000 characters.' }, 400);
    }
    if (!groupId) {
      return json({ error: 'groupId is required so the assistant knows which group context to use.' }, 400);
    }

    // Confirm membership (RLS would block the queries below anyway, but we
    // check explicitly so we can return a clean error instead of an empty
    // context that looks like a bug).
    const { data: membership } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('group_id', groupId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return json({ error: 'You are not a member of this group.' }, 403);
    }

    // Pull real, current context — replaces the hardcoded fictional squad
    // bio from the prototype. If a group has no events/goals yet, these
    // arrays are just empty, and the prompt says so plainly.
    const [{ data: group }, { data: profile }, { data: recentMessages }, { data: upcomingEvents }, { data: goals }] = await Promise.all([
      supabase.from('groups').select('name, description').eq('id', groupId).single(),
      supabase.from('profiles').select('display_name').eq('id', user.id).single(),
      supabase
        .from('messages')
        .select('body, created_at, author_id, profiles!messages_author_id_fkey(display_name)')
        .eq('channel_id', (await supabase.from('channels').select('id').eq('group_id', groupId).eq('name', 'general').single()).data?.id)
        .order('created_at', { ascending: false })
        .limit(20),
      supabase.from('events').select('title, starts_at, description').eq('group_id', groupId).gte('starts_at', new Date().toISOString()).order('starts_at').limit(5),
      supabase.from('goals').select('title, tag').eq('group_id', groupId).limit(10),
    ]);

    const messagesContext = (recentMessages || [])
      .reverse()
      .map((m) => `${m.profiles?.display_name || 'Someone'}: ${m.body || '[attachment]'}`)
      .join('\n') || '(no recent messages yet)';

    const eventsContext = (upcomingEvents || []).map((e) => `- ${e.title} (${new Date(e.starts_at).toLocaleDateString()})`).join('\n') || '(no upcoming events)';
    const goalsContext = (goals || []).map((g) => `- ${g.title}`).join('\n') || '(no goals set yet)';

    const systemPrompt = `You are Nexus AI, the assistant built into "${group?.name || 'this group'}" — a private social platform for a group of friends.
The person you're talking to is ${profile?.display_name || 'a member of the group'}.
Group description: ${group?.description || '(none set)'}

Recent conversation in #general:
${messagesContext}

Upcoming events:
${eventsContext}

Active goals:
${goalsContext}

Be warm, helpful, and concise. Use emoji naturally but don't overdo it. Use **bold** for key info and bullet points for lists. If the group has no events, goals, or message history yet, say so honestly rather than inventing details — this is a real group's real (possibly still-empty) data, not a demo.`;

    const trimmedHistory = Array.isArray(history) ? history.slice(-10) : [];

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [...trimmedHistory, { role: 'user', content: message }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error('Anthropic API error:', anthropicRes.status, errText);
      return json({ error: 'The AI service is temporarily unavailable. Please try again in a moment.' }, 502);
    }

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || "I couldn't generate a response right now. Please try again.";

    return json({ reply });
  } catch (err) {
    console.error('ai-chat function error:', err);
    return json({ error: 'Something went wrong processing your request.' }, 500);
  }
});

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
