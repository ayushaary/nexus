// ============================================================================
// AUTH & ONBOARDING
// ============================================================================
// This entire module is new — the original prototype had no auth screen at
// all and booted directly into a hardcoded "Ayush Kothiyal" demo session.
// ============================================================================

const { supabase } = window.__nexus;

let currentUser = null;   // Supabase auth user object
let currentProfile = null; // row from public.profiles

// ----------------------------------------------------------------------------
// VALIDATION
// ----------------------------------------------------------------------------
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function passwordIssues(pw) {
  const issues = [];
  if (pw.length < 8) issues.push('at least 8 characters');
  if (!/[A-Za-z]/.test(pw)) issues.push('a letter');
  if (!/[0-9]/.test(pw)) issues.push('a number');
  return issues;
}
function usernameIssues(name) {
  const issues = [];
  if (!/^[a-z0-9_.]{3,30}$/.test(name)) {
    issues.push('3-30 characters, lowercase letters/numbers/underscore/period only');
  }
  return issues;
}

// ----------------------------------------------------------------------------
// UI HELPERS (auth screen has its own small error/loading affordances)
// ----------------------------------------------------------------------------
function setAuthError(formId, message) {
  const el = document.getElementById(formId + '-error');
  if (!el) return;
  if (!message) {
    el.style.display = 'none';
    el.textContent = '';
  } else {
    el.style.display = 'block';
    el.textContent = message;
  }
}
function setAuthLoading(buttonId, loading, idleText) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : idleText;
}

// ----------------------------------------------------------------------------
// SIGN UP (email + password)
// ----------------------------------------------------------------------------
async function handleSignup(event) {
  event.preventDefault();
  setAuthError('signup', '');

  const displayName = document.getElementById('signup-name').value.trim();
  const username = document.getElementById('signup-username').value.trim().toLowerCase();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;

  if (!displayName) return setAuthError('signup', 'Please enter your name.');
  const uIssues = usernameIssues(username);
  if (uIssues.length) return setAuthError('signup', `Username must be ${uIssues.join(', ')}.`);
  if (!isValidEmail(email)) return setAuthError('signup', 'Please enter a valid email address.');
  const pIssues = passwordIssues(password);
  if (pIssues.length) return setAuthError('signup', `Password needs ${pIssues.join(' and ')}.`);

  setAuthLoading('signup-submit', true, 'Create account');
  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: displayName, username },
        emailRedirectTo: window.location.origin,
      },
    });
    if (error) throw error;

    if (data.user && !data.session) {
      // Email confirmation is required by the Supabase project's settings.
      showAuthScreen('check-email');
      document.getElementById('check-email-address').textContent = email;
    } else if (data.session) {
      await onAuthSuccess();
    }
  } catch (err) {
    setAuthError('signup', friendlyAuthError(err));
  } finally {
    setAuthLoading('signup-submit', false, 'Create account');
  }
}

// ----------------------------------------------------------------------------
// LOG IN (email + password)
// ----------------------------------------------------------------------------
async function handleLogin(event) {
  event.preventDefault();
  setAuthError('login', '');

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  if (!isValidEmail(email)) return setAuthError('login', 'Please enter a valid email address.');
  if (!password) return setAuthError('login', 'Please enter your password.');

  setAuthLoading('login-submit', true, 'Log in');
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await onAuthSuccess();
  } catch (err) {
    setAuthError('login', friendlyAuthError(err));
  } finally {
    setAuthLoading('login-submit', false, 'Log in');
  }
}

// ----------------------------------------------------------------------------
// GOOGLE OAUTH
// ----------------------------------------------------------------------------
async function handleGoogleSignIn() {
  setAuthError('login', '');
  setAuthError('signup', '');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
  if (error) {
    setAuthError('login', 'Google sign-in failed: ' + error.message);
  }
  // On success, the browser redirects to Google then back to this page;
  // onAuthStateChange (registered in initAuth) picks up the new session.
}

// ----------------------------------------------------------------------------
// PASSWORD RESET
// ----------------------------------------------------------------------------
async function handlePasswordResetRequest(event) {
  event.preventDefault();
  setAuthError('reset', '');
  const email = document.getElementById('reset-email').value.trim();
  if (!isValidEmail(email)) return setAuthError('reset', 'Please enter a valid email address.');

  setAuthLoading('reset-submit', true, 'Send reset link');
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '?reset=true',
    });
    if (error) throw error;
    showAuthScreen('check-email');
    document.getElementById('check-email-address').textContent = email;
  } catch (err) {
    setAuthError('reset', friendlyAuthError(err));
  } finally {
    setAuthLoading('reset-submit', false, 'Send reset link');
  }
}

async function handleSetNewPassword(event) {
  event.preventDefault();
  setAuthError('new-password', '');
  const password = document.getElementById('new-password-input').value;
  const issues = passwordIssues(password);
  if (issues.length) return setAuthError('new-password', `Password needs ${issues.join(' and ')}.`);

  setAuthLoading('new-password-submit', true, 'Update password');
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    showToast('✅', 'Password updated. You\'re all set.');
    await onAuthSuccess();
  } catch (err) {
    setAuthError('new-password', friendlyAuthError(err));
  } finally {
    setAuthLoading('new-password-submit', false, 'Update password');
  }
}

// ----------------------------------------------------------------------------
// LOG OUT
// ----------------------------------------------------------------------------
async function handleLogout() {
  await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
  window.location.reload();
}

// ----------------------------------------------------------------------------
// ERROR MESSAGE FRIENDLINESS
// ----------------------------------------------------------------------------
function friendlyAuthError(err) {
  const msg = err?.message || String(err);
  if (/already registered/i.test(msg)) return 'An account with this email already exists. Try logging in instead.';
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first — check your inbox for a verification link.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a moment and try again.';
  if (/User already registered/i.test(msg)) return 'That email is already in use.';
  return msg;
}

// ----------------------------------------------------------------------------
// SCREEN SWITCHING (auth screens, not the main app's view-panels)
// ----------------------------------------------------------------------------
function showAuthScreen(screen) {
  document.querySelectorAll('.auth-screen').forEach((el) => el.classList.remove('active'));
  const target = document.getElementById('auth-' + screen);
  if (target) target.classList.add('active');
}

// ----------------------------------------------------------------------------
// SESSION BOOTSTRAP
// ----------------------------------------------------------------------------
async function onAuthSuccess() {
  const { data } = await supabase.auth.getUser();
  currentUser = data.user;
  if (!currentUser) return;

  // The profile row is created by a DB trigger on signup, but there's a
  // small race window right after signup where it may not exist yet
  // (trigger hasn't committed). Retry briefly instead of erroring.
  currentProfile = await fetchProfileWithRetry(currentUser.id);

  if (!currentProfile) {
    setAuthError('login', 'Your account was created but the profile setup is still finishing — please refresh in a few seconds.');
    return;
  }

  document.getElementById('auth-container').style.display = 'none';
  document.getElementById('app-container').style.display = '';
  await initAppForUser();
}

async function fetchProfileWithRetry(userId, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (data) return data;
    if (error && error.code !== 'PGRST116') console.error(error);
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// Called once on page load to check for an existing session (so refreshing
// the page or returning later doesn't force a re-login), and to listen for
// auth state changes (covers the OAuth redirect-back case and the password
// recovery deep link).
async function initAuth() {
  const params = new URLSearchParams(window.location.search);
  const isPasswordRecovery = params.get('reset') === 'true';

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      showAuthScreen('new-password');
      return;
    }
    if (event === 'SIGNED_IN' && session && !isPasswordRecovery) {
      await onAuthSuccess();
    }
    if (event === 'SIGNED_OUT') {
      document.getElementById('auth-container').style.display = '';
      document.getElementById('app-container').style.display = 'none';
      showAuthScreen('login');
    }
  });

  const { data } = await supabase.auth.getSession();
  if (data.session && !isPasswordRecovery) {
    await onAuthSuccess();
  } else if (isPasswordRecovery) {
    showAuthScreen('new-password');
  } else {
    document.getElementById('auth-container').style.display = '';
    showAuthScreen('login');
  }
  document.getElementById('auth-loading').style.display = 'none';
}

window.addEventListener('DOMContentLoaded', initAuth);
