// ============================================================================
// APP INITIALIZATION & SHARED UTILITIES
// ============================================================================
// This is the glue layer: small utility functions used across every other
// module (showToast, openModal, escapeHtml, etc. — these existed as plain
// functions in the original prototype and are carried over/adapted here),
// the real init flow that replaces the original's "load demo data on page
// load" behavior, and the features that didn't have an obvious home in the
// other files: AI proxy calls, voice notes, file uploads, members panel,
// and the new-conversation picker.
// ============================================================================

const { supabase: __adb } = window.__nexus;

// ----------------------------------------------------------------------------
// APP INIT — called from auth.js once a user is signed in and their profile
// row is confirmed to exist.
// ----------------------------------------------------------------------------
async function initAppForUser() {
  updateSidebarAvatar();
  document.getElementById('settings-display-name')?.replaceChildren(document.createTextNode(currentProfile.display_name));

  const hasGroups = await runOnboardingCheck();
  if (hasGroups) {
    await loadGroupWorkspace(activeGroupId);
  }
  // If hasGroups is false, runOnboardingCheck has already shown the
  // onboarding overlay — handleCreateGroup/handleJoinGroup will call
  // loadGroupWorkspace themselves once the user picks one.

  await loadNotifications();
  subscribeToNotifications();
}

// ----------------------------------------------------------------------------
// VIEW SWITCHING (sidebar nav: chats / events / goals / vault / ai)
// ----------------------------------------------------------------------------
function setView(viewName, btnEl) {
  document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById('view-' + viewName)?.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
}

function switchRPTab(tabName, btnEl) {
  document.querySelectorAll('.rp-tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('rp-' + tabName)?.classList.add('active');
  document.querySelectorAll('.rp-tab').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
}

// ----------------------------------------------------------------------------
// TOASTS
// ----------------------------------------------------------------------------
let toastTimer = null;
function showToast(icon, message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerHTML = `<span style="font-size:18px;">${icon}</span><span>${escapeHtml(message)}</span>`;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

// ----------------------------------------------------------------------------
// MODALS
// ----------------------------------------------------------------------------
function openModal(id) {
  document.getElementById(id)?.classList.add('open');
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

// ----------------------------------------------------------------------------
// MISC UTILITIES
// ----------------------------------------------------------------------------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ----------------------------------------------------------------------------
// MEMBERS PANEL (right sidebar)
// ----------------------------------------------------------------------------
function renderMembersPanel(members) {
  const panel = document.getElementById('members-panel-list');
  if (!panel) return;
  if (!members.length) {
    panel.innerHTML = '<div class="empty-state-small">No members</div>';
    return;
  }
  panel.innerHTML = members
    .map((m) => {
      const p = m.profiles;
      if (!p) return '';
      const isMe = p.id === currentUser.id;
      return `
      <div class="member-row" ${isMe ? '' : `onclick="startDmWith('${p.id}')"`} style="${isMe ? '' : 'cursor:pointer;'}">
        <div class="member-avatar" style="background:linear-gradient(135deg,${p.avatar_color_from},${p.avatar_color_to});">
          ${p.avatar_url ? `<img src="${escapeHtml(p.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : escapeHtml(initialsFor(p.display_name))}
        </div>
        <div class="member-info">
          <div class="member-name">${escapeHtml(p.display_name)}${isMe ? ' (you)' : ''}</div>
          <div class="member-role">${escapeHtml(m.role)}</div>
        </div>
      </div>`;
    })
    .join('');
}

// ----------------------------------------------------------------------------
// NEW CONVERSATION PICKER
// ----------------------------------------------------------------------------
async function openNewConversationPicker() {
  const { data: members, error } = await __adb.from('group_members').select('user_id, profiles(*)').eq('group_id', activeGroupId);
  if (error) { showToast('⚠️', 'Could not load members.'); return; }

  const others = (members || []).filter((m) => m.user_id !== currentUser.id);
  const list = document.getElementById('new-conversation-list');
  if (!others.length) {
    list.innerHTML = '<div class="empty-state-small">No other members in this group yet — invite someone first.</div>';
  } else {
    list.innerHTML = others
      .map((m) => {
        const p = m.profiles;
        return `
        <div class="spotlight-result" onclick="startDmWith('${p.id}')">
          <div class="spotlight-result-icon" style="background:linear-gradient(135deg,${p.avatar_color_from},${p.avatar_color_to});border-radius:50%;color:#fff;font-size:12px;font-weight:700;">${escapeHtml(initialsFor(p.display_name))}</div>
          <div><div class="spotlight-result-name">${escapeHtml(p.display_name)}</div><div class="spotlight-result-sub">@${escapeHtml(p.username)}</div></div>
        </div>`;
      })
      .join('');
  }
  openModal('new-conversation-modal');
}

// ----------------------------------------------------------------------------
// SPOTLIGHT SEARCH (wired to real data: channels, members, events)
// ----------------------------------------------------------------------------
let spotlightDebounce = null;
function openSpotlight() {
  document.getElementById('spotlight').classList.add('open');
  document.getElementById('spotlight-input').focus();
  renderSpotlightResults('');
}
function closeSpotlight() {
  document.getElementById('spotlight').classList.remove('open');
  document.getElementById('spotlight-input').value = '';
}
function onSpotlightInput(value) {
  clearTimeout(spotlightDebounce);
  spotlightDebounce = setTimeout(() => renderSpotlightResults(value.trim()), 150);
}

async function renderSpotlightResults(query) {
  const resultsEl = document.getElementById('spotlight-results');
  const q = query.toLowerCase();

  const matchedChannels = channels.filter((c) => !q || c.name.toLowerCase().includes(q));
  const matchedMembers = (dmThreads || []).filter((t) => !q || t.otherProfile.display_name.toLowerCase().includes(q));

  if (!matchedChannels.length && !matchedMembers.length && q) {
    resultsEl.innerHTML = `<div class="spotlight-empty">No results for "${escapeHtml(query)}"</div>`;
    return;
  }

  resultsEl.innerHTML = `
    ${matchedChannels.length ? '<div class="spotlight-section">Channels</div>' : ''}
    ${matchedChannels
      .map((c) => `<div class="spotlight-result" onclick="closeSpotlight();setView('chats', document.getElementById('nav-chats'));openChannel('${c.id}')"><div class="spotlight-result-icon">${escapeHtml(c.emoji)}</div><div><div class="spotlight-result-name">#${escapeHtml(c.name)}</div></div></div>`)
      .join('')}
    ${matchedMembers.length ? '<div class="spotlight-section">People</div>' : ''}
    ${matchedMembers
      .map((t) => `<div class="spotlight-result" onclick="closeSpotlight();setView('chats', document.getElementById('nav-chats'));openDmThread('${t.id}')"><div class="spotlight-result-icon" style="background:linear-gradient(135deg,${t.otherProfile.avatar_color_from},${t.otherProfile.avatar_color_to});border-radius:50%;color:#fff;font-size:12px;font-weight:700;">${escapeHtml(initialsFor(t.otherProfile.display_name))}</div><div><div class="spotlight-result-name">${escapeHtml(t.otherProfile.display_name)}</div></div></div>`)
      .join('')}
    <div class="spotlight-section">Quick actions</div>
    <div class="spotlight-result" onclick="closeSpotlight();setView('ai', document.getElementById('nav-ai'))"><div class="spotlight-result-icon">🤖</div><div><div class="spotlight-result-name">Ask Nexus AI</div></div></div>
    <div class="spotlight-result" onclick="closeSpotlight();openCreateEvent()"><div class="spotlight-result-icon">📅</div><div><div class="spotlight-result-name">Create new event</div></div></div>`;
}

// ----------------------------------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------------------------------
let notificationSubscription = null;
async function loadNotifications() {
  const { data, error } = await __adb.from('notifications').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false }).limit(30);
  if (error) { console.error(error); return; }
  renderNotificationsPanel(data || []);
}
function renderNotificationsPanel(notifs) {
  const panel = document.getElementById('notifications-list');
  if (!panel) return;
  const unreadCount = notifs.filter((n) => !n.is_read).length;
  const badge = document.getElementById('notif-badge');
  if (badge) badge.style.display = unreadCount ? 'flex' : 'none';
  if (badge) badge.textContent = unreadCount;

  if (!notifs.length) {
    panel.innerHTML = '<div class="empty-state-small">No notifications yet</div>';
    return;
  }
  panel.innerHTML = notifs
    .map(
      (n) => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="markNotificationRead('${n.id}')">
      <div class="notif-icon">${n.type === 'reaction' ? '❤️' : n.type === 'mention' ? '💬' : '🔔'}</div>
      <div class="notif-content"><div>${escapeHtml(n.title)}</div><div style="font-size:11px;color:var(--text3);">${timeAgo(n.created_at)}</div></div>
    </div>`
    )
    .join('');
}
async function markNotificationRead(id) {
  await __adb.from('notifications').update({ is_read: true }).eq('id', id);
  await loadNotifications();
}
function subscribeToNotifications() {
  notificationSubscription = __adb
    .channel('notifications-' + currentUser.id)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentUser.id}` }, () => loadNotifications())
    .subscribe();
}

// ----------------------------------------------------------------------------
// NEXUS AI — calls the secure Edge Function instead of the browser calling
// Anthropic directly (which is how the original prototype worked, and which
// would have required exposing an API key in client JS).
// ----------------------------------------------------------------------------
let aiConversationHistory = [];

async function callNexusAI(userText) {
  const { AI_PROXY_URL } = window.__nexus;
  const { data: sessionData } = await __adb.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) {
    showToast('⚠️', 'Please sign in again to use Nexus AI.');
    return;
  }

  const thinkingId = 'ai-thinking-' + Date.now();
  document.getElementById('messages').insertAdjacentHTML(
    'beforeend',
    `<div class="msg-group fade-in" id="${thinkingId}"><div class="msg-avatar" style="background:linear-gradient(135deg,#7c5cfc,#fc5cce);">🤖</div><div class="msg-body"><div class="msg-meta"><span class="msg-name">Nexus AI</span></div><div class="msg-text" style="color:var(--text3);">Thinking…</div></div></div>`
  );
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;

  try {
    const res = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ message: userText, groupId: activeGroupId, history: aiConversationHistory }),
    });
    const json = await res.json();
    document.getElementById(thinkingId)?.remove();

    if (!res.ok) {
      showToast('❌', json.error || 'Nexus AI is unavailable right now.');
      return;
    }

    aiConversationHistory.push({ role: 'user', content: userText }, { role: 'assistant', content: json.reply });
    if (aiConversationHistory.length > 20) aiConversationHistory = aiConversationHistory.slice(-20);

    // Persist the AI's reply as a real message so it shows up for everyone
    // in the group (not just the asker) and survives a page reload —
    // unlike the original, which only ever appended to the DOM in-memory.
    await __adb.from('messages').insert({
      author_id: currentUser.id,
      body: json.reply,
      is_ai: true,
      channel_id: activeChannelId || null,
      dm_thread_id: activeDmThreadId || null,
    });
  } catch (err) {
    document.getElementById(thinkingId)?.remove();
    console.error(err);
    showToast('❌', 'Could not reach Nexus AI. Check your connection and try again.');
  }
}

// ----------------------------------------------------------------------------
// VOICE NOTES — real MediaRecorder capture, uploaded to Storage, inserted as
// a playable message. The original prototype had a microphone button with
// no recording logic behind it at all.
// ----------------------------------------------------------------------------
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartTime = null;

async function startVoiceRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast('⚠️', 'Voice recording is not supported in this browser.');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      handleRecordingStopped();
    };
    mediaRecorder.start();
    recordingStartTime = Date.now();
    document.getElementById('voice-record-btn')?.classList.add('recording');
    showToast('🎙️', 'Recording… click again to stop.');
  } catch (err) {
    console.error(err);
    showToast('⚠️', 'Microphone permission denied or unavailable.');
  }
}

function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    document.getElementById('voice-record-btn')?.classList.remove('recording');
  } else {
    startVoiceRecording();
  }
}

async function handleRecordingStopped() {
  const durationSeconds = (Date.now() - recordingStartTime) / 1000;
  if (durationSeconds < 0.5) {
    showToast('⚠️', 'Recording too short — try again.');
    return;
  }
  if (!activeChannelId && !activeDmThreadId) {
    showToast('⚠️', 'Open a channel first.');
    return;
  }

  const blob = new Blob(recordedChunks, { type: 'audio/webm' });
  const path = `${currentUser.id}/${Date.now()}.webm`;

  showToast('⬆️', 'Uploading voice note…');
  const { error: upErr } = await __adb.storage.from('voice-notes').upload(path, blob);
  if (upErr) { showToast('❌', 'Upload failed.'); console.error(upErr); return; }

  const url = __adb.storage.from('voice-notes').getPublicUrl(path).data.publicUrl;

  const { error } = await __adb.from('messages').insert({
    author_id: currentUser.id,
    voice_note_url: url,
    voice_note_duration_seconds: durationSeconds,
    channel_id: activeChannelId || null,
    dm_thread_id: activeDmThreadId || null,
  });
  if (error) { showToast('❌', 'Could not send voice note.'); console.error(error); return; }
  showToast('✅', 'Voice note sent.');
}

function playAudioVoiceNote(btnEl, url) {
  document.querySelectorAll('audio[data-voice-note]').forEach((a) => { if (a.dataset.url !== url) { a.pause(); } });
  let audio = document.querySelector(`audio[data-url="${url}"]`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.dataset.voiceNote = 'true';
    audio.dataset.url = url;
    audio.src = url;
    audio.onended = () => { btnEl.textContent = '▶'; };
    document.body.appendChild(audio);
  }
  if (audio.paused) { audio.play(); btnEl.textContent = '⏸'; }
  else { audio.pause(); btnEl.textContent = '▶'; }
}

// ----------------------------------------------------------------------------
// FILE ATTACHMENTS — the original referenced file messages in markup but had
// no upload path; this adds a real one via Supabase Storage.
// ----------------------------------------------------------------------------
async function handleFileAttachmentSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!activeChannelId && !activeDmThreadId) {
    showToast('⚠️', 'Open a channel first.');
    event.target.value = '';
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showToast('⚠️', 'Files must be under 25MB.');
    event.target.value = '';
    return;
  }

  showToast('⬆️', `Uploading ${file.name}…`);
  const path = `${currentUser.id}/${Date.now()}-${file.name}`;
  const { error: upErr } = await __adb.storage.from('attachments').upload(path, file);
  if (upErr) { showToast('❌', 'Upload failed.'); console.error(upErr); event.target.value = ''; return; }

  const url = __adb.storage.from('attachments').getPublicUrl(path).data.publicUrl;

  const { error } = await __adb.from('messages').insert({
    author_id: currentUser.id,
    file_url: url,
    file_name: file.name,
    file_size_bytes: file.size,
    file_type: file.type,
    channel_id: activeChannelId || null,
    dm_thread_id: activeDmThreadId || null,
  });
  event.target.value = '';
  if (error) { showToast('❌', 'Could not send file.'); console.error(error); return; }
  showToast('✅', 'File sent.');
}

// ----------------------------------------------------------------------------
// Close spotlight / pickers on outside click or Escape
// ----------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSpotlight();
    document.getElementById('emoji-picker')?.classList.remove('open');
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    openSpotlight();
  }
});
document.addEventListener('click', (e) => {
  const picker = document.getElementById('emoji-picker');
  if (picker && picker.classList.contains('open') && !picker.contains(e.target) && !e.target.closest('[onclick*="showEmojiPickerForMsg"]')) {
    picker.classList.remove('open');
  }
});
