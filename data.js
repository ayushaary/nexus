// ============================================================================
// CORE DATA LAYER — groups, channels, messages, reactions, polls
// ============================================================================
// Replaces the prototype's hardcoded `channelData` object and DOM-only
// `sendMessage()` with real reads/writes against Supabase, plus realtime
// subscriptions so messages from other members appear live.
// ============================================================================

const { supabase: __db } = window.__nexus;

let channels = [];          // channels in the active group
let dmThreads = [];          // dm thread summaries
let activeChannelId = null;
let activeDmThreadId = null;
let messageSubscription = null;
let reactionSubscription = null;
let replyTarget = null;

// ----------------------------------------------------------------------------
// LOAD A GROUP'S WORKSPACE (channels, members, recent DMs)
// ----------------------------------------------------------------------------
async function loadGroupWorkspace(groupId) {
  activeGroupId = groupId;

  const [{ data: chans, error: chanErr }, { data: members, error: memErr }] = await Promise.all([
    __db.from('channels').select('*').eq('group_id', groupId).order('created_at'),
    __db.from('group_members').select('user_id, role, profiles(*)').eq('group_id', groupId),
  ]);

  if (chanErr) { console.error(chanErr); showToast('⚠️', 'Could not load channels.'); return; }
  if (memErr) { console.error(memErr); }

  channels = chans || [];
  renderChannelList(channels, members || []);
  renderMembersPanel(members || []);

  const group = myGroups.find((g) => g.id === groupId);
  document.getElementById('channel-list-title').textContent = group?.name || 'Nexus';
  document.getElementById('channel-list-subtitle').textContent = `${(members || []).length} member${(members || []).length === 1 ? '' : 's'}`;

  await loadDmThreads();

  if (channels.length) {
    await openChannel(channels[0].id);
  } else {
    renderEmptyMessages('No channels yet.');
  }

  await loadEventsForGroup(groupId);
  await loadGoalsForGroup(groupId);
  await loadVaultForGroup(groupId);
  await loadStoriesForGroup(groupId);
}

function renderChannelList(chans, members) {
  const scroll = document.getElementById('cl-scroll');
  const channelsHtml = chans
    .map(
      (c) => `
    <div class="channel-item" id="ch-${c.id}" onclick="openChannel('${c.id}')">
      <div class="channel-avatar group" style="font-size:18px;">${escapeHtml(c.emoji || '💬')}</div>
      <div class="channel-info">
        <div class="channel-name">#${escapeHtml(c.name)}</div>
        <div class="channel-preview" id="preview-${c.id}">No messages yet</div>
      </div>
    </div>`
    )
    .join('');

  const dmsHtml = dmThreads
    .map((t) => {
      const other = t.otherProfile;
      return `
      <div class="channel-item" id="ch-dm-${t.id}" onclick="openDmThread('${t.id}')">
        <div class="channel-avatar" style="background:linear-gradient(135deg,${other.avatar_color_from},${other.avatar_color_to});position:relative;">
          ${other.avatar_url ? `<img src="${escapeHtml(other.avatar_url)}" style="width:100%;height:100%;border-radius:10px;object-fit:cover;">` : escapeHtml(initialsFor(other.display_name))}
        </div>
        <div class="channel-info">
          <div class="channel-name">${escapeHtml(other.display_name)}</div>
          <div class="channel-preview">${escapeHtml(t.lastPreview || 'Say hi 👋')}</div>
        </div>
      </div>`;
    })
    .join('');

  scroll.innerHTML = `
    <div class="cl-section">Channels</div>
    ${channelsHtml || '<div class="empty-state-small">No channels</div>'}
    <div class="cl-section">Direct Messages</div>
    ${dmsHtml || '<div class="empty-state-small">No conversations yet</div>'}
    <div style="padding:8px 16px 0;">
      <button class="cl-new-btn" onclick="openNewConversationPicker()">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New conversation
      </button>
    </div>`;
}

function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

// ----------------------------------------------------------------------------
// CHANNEL SWITCHING
// ----------------------------------------------------------------------------
async function openChannel(channelId) {
  activeChannelId = channelId;
  activeDmThreadId = null;
  teardownMessageSubscriptions();

  document.querySelectorAll('.channel-item').forEach((i) => i.classList.remove('active'));
  document.getElementById('ch-' + channelId)?.classList.add('active');

  const channel = channels.find((c) => c.id === channelId);
  document.getElementById('chat-title').textContent = channel ? '#' + channel.name : 'Channel';
  document.getElementById('chat-header-icon').textContent = channel?.emoji || '💬';
  document.getElementById('chat-header-icon').style.background = '';
  document.getElementById('chat-status').textContent = '';
  document.getElementById('msg-input').placeholder = `Message #${channel?.name || ''}… (try @Nexus AI)`;

  await loadAndRenderMessages({ channelId });
  subscribeToChannel(channelId);
}

async function openDmThread(threadId) {
  activeDmThreadId = threadId;
  activeChannelId = null;
  teardownMessageSubscriptions();

  document.querySelectorAll('.channel-item').forEach((i) => i.classList.remove('active'));
  document.getElementById('ch-dm-' + threadId)?.classList.add('active');

  const thread = dmThreads.find((t) => t.id === threadId);
  const other = thread?.otherProfile;
  document.getElementById('chat-title').textContent = other?.display_name || 'Direct Message';
  document.getElementById('chat-header-icon').textContent = other ? escapeHtml(initialsFor(other.display_name)) : 'DM';
  document.getElementById('chat-header-icon').style.background = other ? `linear-gradient(135deg,${other.avatar_color_from},${other.avatar_color_to})` : '';
  document.getElementById('chat-status').textContent = '';
  document.getElementById('msg-input').placeholder = `Message ${other?.display_name || ''}…`;

  await loadAndRenderMessages({ dmThreadId: threadId });
  subscribeToDmThread(threadId);
}

async function loadDmThreads() {
  const { data, error } = await __db
    .from('dm_threads')
    .select('*')
    .or(`user_a.eq.${currentUser.id},user_b.eq.${currentUser.id}`)
    .order('created_at', { ascending: false });

  if (error) { console.error(error); dmThreads = []; return; }

  const otherIds = (data || []).map((t) => (t.user_a === currentUser.id ? t.user_b : t.user_a));
  let profilesById = {};
  if (otherIds.length) {
    const { data: profiles } = await __db.from('profiles').select('*').in('id', otherIds);
    profilesById = Object.fromEntries((profiles || []).map((p) => [p.id, p]));
  }

  dmThreads = (data || []).map((t) => ({
    ...t,
    otherProfile: profilesById[t.user_a === currentUser.id ? t.user_b : t.user_a] || { display_name: 'Unknown', avatar_color_from: '#888', avatar_color_to: '#888' },
  }));
}

async function startDmWith(otherUserId) {
  const [a, b] = [currentUser.id, otherUserId].sort();
  const { data: existing } = await __db.from('dm_threads').select('id').eq('user_a', a).eq('user_b', b).maybeSingle();

  let threadId = existing?.id;
  if (!threadId) {
    const { data, error } = await __db.from('dm_threads').insert({ user_a: a, user_b: b }).select().single();
    if (error) { showToast('⚠️', 'Could not start conversation.'); console.error(error); return; }
    threadId = data.id;
  }
  await loadDmThreads();
  renderChannelList(channels, []);
  closeModal('new-conversation-modal');
  setView('chats', document.getElementById('nav-chats'));
  await openDmThread(threadId);
}

// ----------------------------------------------------------------------------
// MESSAGE LOADING + RENDERING
// ----------------------------------------------------------------------------
async function loadAndRenderMessages({ channelId, dmThreadId }) {
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '<div class="empty-state-small">Loading messages…</div>';

  let query = __db
    .from('messages')
    .select('*, author:profiles!messages_author_id_fkey(*), reactions(*), polls(*, poll_options(*, poll_votes(*)))')
    .order('created_at', { ascending: true })
    .limit(100);

  query = channelId ? query.eq('channel_id', channelId) : query.eq('dm_thread_id', dmThreadId);

  const { data, error } = await query;
  if (error) {
    console.error(error);
    messagesEl.innerHTML = '<div class="empty-state-small">Could not load messages.</div>';
    return;
  }

  if (!data || data.length === 0) {
    renderEmptyMessages(channelId ? 'No messages yet — say something to get the conversation started.' : 'No messages yet — say hi 👋');
    return;
  }

  messagesEl.innerHTML = data.map((m) => renderMessageHtml(m)).join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderEmptyMessages(text) {
  document.getElementById('messages').innerHTML = `<div class="empty-state-small" style="padding:40px 0;text-align:center;">${escapeHtml(text)}</div>`;
}

function renderMessageHtml(m) {
  const author = m.author || {};
  const isMe = m.author_id === currentUser.id;
  const initials = escapeHtml(initialsFor(author.display_name));
  const avatarBg = `linear-gradient(135deg,${author.avatar_color_from || '#7c5cfc'},${author.avatar_color_to || '#fc5cce'})`;
  const avatarInner = author.avatar_url
    ? `<img src="${escapeHtml(author.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`
    : initials;

  let bodyHtml = '';
  if (m.body) bodyHtml += `<div class="msg-text">${linkifyAndEscape(m.body)}</div>`;
  if (m.file_url) {
    bodyHtml += `
      <div class="msg-file">
        <div class="msg-file-icon">📄</div>
        <div class="msg-file-info"><div class="msg-file-name">${escapeHtml(m.file_name || 'file')}</div><div class="msg-file-size">${formatFileSize(m.file_size_bytes)}</div></div>
        <a href="${escapeHtml(m.file_url)}" target="_blank" rel="noopener" style="background:var(--accent);border:none;border-radius:8px;padding:6px 12px;color:#fff;font-size:12px;cursor:pointer;font-family:'Inter',sans-serif;flex-shrink:0;text-decoration:none;">Get</a>
      </div>`;
  }
  if (m.voice_note_url) {
    bodyHtml += `
      <div class="voice-note">
        <div class="voice-play" onclick="playAudioVoiceNote(this, '${escapeHtml(m.voice_note_url)}')">▶</div>
        <div class="voice-waveform"></div>
        <div class="voice-duration">${formatDuration(m.voice_note_duration_seconds)}</div>
      </div>`;
  }
  if (m.polls && m.polls.length) {
    bodyHtml += renderPollHtml(m.polls[0]);
  }

  const reactionGroups = {};
  (m.reactions || []).forEach((r) => {
    reactionGroups[r.emoji] = reactionGroups[r.emoji] || { count: 0, mine: false };
    reactionGroups[r.emoji].count++;
    if (r.user_id === currentUser.id) reactionGroups[r.emoji].mine = true;
  });
  const reactionsHtml = Object.keys(reactionGroups).length
    ? `<div class="msg-reactions">${Object.entries(reactionGroups)
        .map(([emoji, info]) => `<div class="reaction ${info.mine ? 'mine' : ''}" onclick="toggleReactionDb('${m.id}','${emoji}',this)">${emoji} <span>${info.count}</span></div>`)
        .join('')}</div>`
    : '';

  return `
    <div class="msg-group fade-in" id="msg-${m.id}" data-author="${escapeHtml(author.display_name || '')}" data-text="${escapeHtml((m.body || '').slice(0, 80))}">
      <div class="msg-avatar" style="background:${avatarBg};">${avatarInner}</div>
      <div class="msg-body">
        <div class="msg-meta">
          <span class="msg-name">${escapeHtml(author.display_name || 'Unknown')}</span>
          <span class="msg-time">${formatMessageTime(m.created_at)}</span>
          ${m.is_ai ? '<span class="msg-badge badge-ai">AI</span>' : ''}
          ${isMe ? '<span class="msg-badge badge-admin">You</span>' : ''}
          ${m.edited_at ? '<span class="msg-time">(edited)</span>' : ''}
        </div>
        ${bodyHtml}
        ${reactionsHtml}
        <div class="msg-actions">
          <button class="msg-action-btn" onclick="setReply('${escapeHtml(author.display_name || '')}', '${escapeHtml((m.body || '').replace(/'/g, "\\'").slice(0, 60))}')">↩ Reply</button>
          <button class="msg-action-btn" onclick="showEmojiPickerForMsg(this, '${m.id}')">😀 React</button>
          ${isMe && m.body ? `<button class="msg-action-btn" onclick="startEditMessage('${m.id}')">✏️ Edit</button><button class="msg-action-btn" onclick="deleteMessage('${m.id}')">🗑️ Delete</button>` : ''}
        </div>
      </div>
    </div>`;
}

function linkifyAndEscape(text) {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:var(--accent2);">$1</a>')
    .replace(/\n/g, '<br>');
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
function formatMessageTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ----------------------------------------------------------------------------
// SENDING MESSAGES
// ----------------------------------------------------------------------------
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;
  if (!activeChannelId && !activeDmThreadId) {
    showToast('⚠️', 'Pick a channel or conversation first.');
    return;
  }

  const payload = {
    author_id: currentUser.id,
    body: text,
    reply_to_id: replyTarget?.id || null,
    channel_id: activeChannelId || null,
    dm_thread_id: activeDmThreadId || null,
  };

  input.value = '';
  input.style.height = 'auto';
  clearReply();

  const { error } = await __db.from('messages').insert(payload);
  if (error) {
    console.error(error);
    showToast('❌', 'Message failed to send.');
    input.value = text; // give it back so the user doesn't lose it
    return;
  }
  // The realtime subscription below will render the message when Postgres
  // confirms the insert — including for this same tab, which keeps a single
  // source of truth instead of optimistically drawing it twice.

  if (/@nexus/i.test(text) || text.startsWith('/ai ') || text.startsWith('/')) {
    await callNexusAI(text);
  }
}

function setReply(name, text) {
  replyTarget = { name, text };
  const bar = document.getElementById('reply-bar');
  if (bar) {
    bar.style.display = 'flex';
    document.getElementById('reply-bar-text').textContent = `Replying to ${name}: ${text}`;
  }
  document.getElementById('msg-input').focus();
}
function clearReply() {
  replyTarget = null;
  const bar = document.getElementById('reply-bar');
  if (bar) bar.style.display = 'none';
}

async function startEditMessage(messageId) {
  const msgEl = document.getElementById('msg-' + messageId);
  const textEl = msgEl?.querySelector('.msg-text');
  if (!textEl) return;
  const current = textEl.textContent;
  const newText = window.prompt('Edit message:', current);
  if (newText === null || newText.trim() === '' || newText === current) return;

  const { error } = await __db.from('messages').update({ body: newText.trim(), edited_at: new Date().toISOString() }).eq('id', messageId).eq('author_id', currentUser.id);
  if (error) { showToast('❌', 'Could not edit message.'); return; }
  showToast('✅', 'Message updated.');
}

async function deleteMessage(messageId) {
  if (!window.confirm('Delete this message? This cannot be undone.')) return;
  const { error } = await __db.from('messages').delete().eq('id', messageId).eq('author_id', currentUser.id);
  if (error) { showToast('❌', 'Could not delete message.'); return; }
  document.getElementById('msg-' + messageId)?.remove();
  showToast('🗑️', 'Message deleted.');
}

// ----------------------------------------------------------------------------
// REACTIONS
// ----------------------------------------------------------------------------
async function toggleReactionDb(messageId, emoji) {
  const { data: existing } = await __db.from('reactions').select('*').eq('message_id', messageId).eq('user_id', currentUser.id).eq('emoji', emoji).maybeSingle();
  if (existing) {
    await __db.from('reactions').delete().eq('message_id', messageId).eq('user_id', currentUser.id).eq('emoji', emoji);
  } else {
    await __db.from('reactions').insert({ message_id: messageId, user_id: currentUser.id, emoji });
  }
  // Realtime subscription re-renders the affected message.
}

let emojiPickerTargetMessageId = null;
function showEmojiPickerForMsg(btnEl, messageId) {
  emojiPickerTargetMessageId = messageId;
  const picker = document.getElementById('emoji-picker');
  picker.classList.add('open');
  const rect = btnEl.getBoundingClientRect();
  picker.style.position = 'fixed';
  picker.style.left = Math.min(rect.left, window.innerWidth - 300) + 'px';
  picker.style.top = (rect.top - 180) + 'px';
}
function pickEmojiForMessage(emoji) {
  if (emojiPickerTargetMessageId) toggleReactionDb(emojiPickerTargetMessageId, emoji);
  document.getElementById('emoji-picker').classList.remove('open');
}

// ----------------------------------------------------------------------------
// POLLS
// ----------------------------------------------------------------------------
function renderPollHtml(poll) {
  const options = poll.poll_options || [];
  const totalVotes = options.reduce((sum, o) => sum + (o.poll_votes?.length || 0), 0);
  const myVote = options.find((o) => (o.poll_votes || []).some((v) => v.user_id === currentUser.id));
  const leadingId = options.reduce((best, o) => ((o.poll_votes?.length || 0) > (best?.poll_votes?.length || -1) ? o : best), null)?.id;

  return `
    <div class="msg-card">
      <div class="msg-card-title">📊 ${escapeHtml(poll.question)}</div>
      <div style="margin-top:8px;">
        ${options
          .map((o) => {
            const votes = o.poll_votes?.length || 0;
            const isMine = myVote?.id === o.id;
            const isLeading = o.id === leadingId && totalVotes > 0;
            return `
            <div class="poll-option ${isMine ? 'voted' : ''}" onclick="votePollDb('${poll.id}','${o.id}')">
              <div class="poll-option-text">${escapeHtml(o.option_text)}</div>
              <div class="poll-option-count" ${isLeading ? 'style="color:var(--accent2);"' : ''}>${votes} vote${votes === 1 ? '' : 's'}${isLeading ? ' ← leading' : ''}</div>
            </div>`;
          })
          .join('')}
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:8px;">${totalVotes} vote${totalVotes === 1 ? '' : 's'} total</div>
    </div>`;
}

async function votePollDb(pollId, optionId) {
  const { error } = await __db.from('poll_votes').upsert({ poll_id: pollId, poll_option_id: optionId, user_id: currentUser.id }, { onConflict: 'poll_id,user_id' });
  if (error) { console.error(error); showToast('❌', 'Vote failed.'); }
}

function addPollOption() {
  const container = document.getElementById('poll-options-container');
  const div = document.createElement('div');
  div.className = 'poll-option-input';
  div.innerHTML = `<input class="form-input" placeholder="Option ${container.children.length + 1}"><button class="poll-option-remove" onclick="removePollOption(this)">✕</button>`;
  container.appendChild(div);
}
function removePollOption(btn) {
  const container = document.getElementById('poll-options-container');
  if (container.children.length <= 2) {
    showToast('⚠️', 'A poll needs at least 2 options.');
    return;
  }
  btn.closest('.poll-option-input').remove();
}

async function submitPoll() {
  const question = document.getElementById('poll-question-input').value.trim();
  const optionInputs = [...document.querySelectorAll('#poll-options-container input')];
  const options = optionInputs.map((i) => i.value.trim()).filter(Boolean);

  if (!question) return showToast('⚠️', 'Please enter a poll question.');
  if (options.length < 2) return showToast('⚠️', 'Add at least 2 options.');
  if (!activeChannelId && !activeDmThreadId) return showToast('⚠️', 'Open a channel first.');

  const { data: msg, error: msgErr } = await __db
    .from('messages')
    .insert({ author_id: currentUser.id, body: `📊 ${question}`, channel_id: activeChannelId, dm_thread_id: activeDmThreadId })
    .select()
    .single();
  if (msgErr) { showToast('❌', 'Could not create poll.'); console.error(msgErr); return; }

  const { data: poll, error: pollErr } = await __db.from('polls').insert({ message_id: msg.id, question }).select().single();
  if (pollErr) { showToast('❌', 'Could not create poll.'); console.error(pollErr); return; }

  const { error: optErr } = await __db.from('poll_options').insert(options.map((text, i) => ({ poll_id: poll.id, option_text: text, position: i })));
  if (optErr) console.error(optErr);

  closeModal('create-poll-modal');
  document.getElementById('poll-question-input').value = '';
  showToast('📊', 'Poll sent!');
}

// ----------------------------------------------------------------------------
// REALTIME SUBSCRIPTIONS
// ----------------------------------------------------------------------------
function subscribeToChannel(channelId) {
  messageSubscription = __db
    .channel('messages-channel-' + channelId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` }, () => loadAndRenderMessages({ channelId }))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, () => loadAndRenderMessages({ channelId }))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'poll_votes' }, () => loadAndRenderMessages({ channelId }))
    .subscribe();
}
function subscribeToDmThread(threadId) {
  messageSubscription = __db
    .channel('messages-dm-' + threadId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `dm_thread_id=eq.${threadId}` }, () => loadAndRenderMessages({ dmThreadId: threadId }))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, () => loadAndRenderMessages({ dmThreadId: threadId }))
    .subscribe();
}
function teardownMessageSubscriptions() {
  if (messageSubscription) { __db.removeChannel(messageSubscription); messageSubscription = null; }
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
