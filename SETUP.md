# Nexus — Setup Guide

This app needs three things you'll set up yourself before it runs: a Supabase
project, Google OAuth credentials, and a way to actually serve the files
(they won't work if you just double-click index.html — more on that below).

Everything in the code is wired up and waiting for these. Total time: about
20–30 minutes.

---

## 1. Create your Supabase project

1. Go to **https://supabase.com** → sign up / log in → **New Project**.
2. Pick any name and database password (save the password somewhere — you
   won't need it for this app, but Supabase will ask).
3. Wait ~2 minutes for the project to finish provisioning.

## 2. Run the database schema

1. In your new project, open the **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open `sql/schema.sql` from this project, copy the *entire* file, paste it
   into the SQL editor.
4. Click **Run**.
5. You should see "Success. No rows returned." If you see an error instead,
   copy the exact error message — the script is written to be safe to
   re-run (it drops policies before recreating them), so re-running after
   fixing something won't duplicate anything.

This creates every table, every security policy, every trigger, and the
four storage buckets (avatars, attachments, voice-notes, media) the app
needs.

## 3. Connect the app to your project

1. In Supabase, go to **Project Settings → API**.
2. Copy the **Project URL** (looks like `https://abcdefgh.supabase.co`).
3. Copy the **anon public** key (a long string starting with `eyJ...`).
4. Open `js/supabase-client.js` in this project and replace:
   ```js
   const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR-ANON-PUBLIC-KEY';
   ```
   with your real values.

The anon key is safe to put directly in this client-side file — it has no
power on its own; every table is locked down with Row Level Security, so it
can only ever do what a signed-in user is allowed to do. Do **not** use the
"service_role" key here; that one bypasses security and must never appear
in browser code.

## 4. Set up Google OAuth (for "Continue with Google")

This part happens in Google's console, not Supabase's, so I can't do it for
you — it needs your Google account.

1. Go to **https://console.cloud.google.com** → create a new project (or
   use an existing one).
2. Go to **APIs & Services → OAuth consent screen**. Choose **External**,
   fill in an app name and your email, save.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth
   client ID**.
4. Application type: **Web application**.
5. Under **Authorized redirect URIs**, add:
   ```
   https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
   ```
   (replace with your actual Supabase project URL from step 3 above).
6. Click **Create**. You'll get a **Client ID** and **Client Secret** —
   copy both.
7. Back in Supabase: go to **Authentication → Providers → Google**, toggle
   it on, paste in the Client ID and Client Secret, save.

That's it — `handleGoogleSignIn()` in `js/auth.js` is already wired to call
this provider; there's nothing else to change in the code.

## 5. Deploy the AI Edge Function (for Nexus AI / @nexus mentions)

This step is optional — everything else in the app works without it. Skip
it if you don't want the AI assistant feature yet.

1. Install the Supabase CLI if you don't have it:
   ```
   npm install -g supabase
   ```
2. Log in and link this project:
   ```
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```
3. Get an Anthropic API key from **https://console.anthropic.com** if you
   don't already have one.
4. Set it as a secret (this keeps it server-side — never in browser code):
   ```
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```
5. Deploy the function:
   ```
   supabase functions deploy ai-chat
   ```

Once deployed, mentioning `@nexus` in any channel, or asking a question
from the AI panel, will call this function.

## 6. Run the app locally (or host it)

**Important:** you cannot just double-click `index.html` and open it in a
browser. The app uses `fetch` and ES-module-style imports that browsers
block under the `file://` protocol for security reasons — you'll get
cryptic CORS or network errors. You need to serve the files over HTTP.

**Easiest option — local testing:**
```
cd nexus
python3 -m http.server 8080
```
Then open `http://localhost:8080` in your browser.

**To actually deploy it for your group to use:**
Any static hosting works since this is just HTML/CSS/JS with no build step
— for example:
- **Netlify** or **Vercel**: drag-and-drop the `nexus` folder onto their
  dashboard, or connect a GitHub repo. Both have free tiers.
- **GitHub Pages**: push this folder to a repo, enable Pages in settings.

One thing to update once you have a real domain: in Supabase, go to
**Authentication → URL Configuration** and add your deployed URL (e.g.
`https://your-app.netlify.app`) to the **Redirect URLs** allow-list, or
Google sign-in and password reset links won't redirect back correctly.

---

## What's real vs. what's not

Everything described below is genuinely wired to the database — there's no
fake/demo data anywhere in the app once you complete the setup above:

- **Auth**: real email/password signup with verification, real Google
  OAuth, real password reset.
- **Groups**: created by users, with real invite codes; no pre-populated
  "Squad."
- **Chat**: real-time, persisted, with replies/edits/deletes/reactions, all
  scoped so only group members can see a group's messages (enforced at the
  database level, not just hidden in the UI).
- **Polls**: real votes, one per person, stored in the database.
- **Events**: real, with RSVPs.
- **Goals & tasks**: real, with progress tracked from actual completed
  tasks.
- **Stories**: real, expire after 24 hours automatically, optional photo
  upload.
- **Voice notes**: real microphone recording, uploaded, playable.
- **File attachments**: real upload, real download links.
- **Memory Vault**: real save/collections feature — starts empty, since
  there's nothing to curate until your group actually uses the app.
- **Nexus AI**: calls Claude through a secure server-side function (your
  API key is never exposed to the browser, unlike the original prototype's
  approach), and answers based on your group's actual messages, events,
  and goals — including saying "no events yet" honestly if that's true.

**One thing was intentionally removed, not just left fake:** the original
prototype's voice/video **call** screen (the "Live" group call UI with
video tiles) has been removed entirely rather than kept as a non-functional
button. Real calling needs WebRTC signaling infrastructure — a whole
separate subsystem (connection brokering, NAT traversal via STUN/TURN
servers, etc.) that's beyond what fits in this build. Adding real calling
later is possible but would be a separate, focused project — happy to help
with that whenever you're ready to tackle it specifically.
