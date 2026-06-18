// ============================================================================
// EVENTS, GOALS/TASKS, STORIES, VAULT
// ============================================================================
// Each of these was a static, non-functional view in the prototype (no real
// data, "+Add event" was a dead button, "+New goal" showed a toast). All
// wired to real tables now, scoped to the active group.
// ============================================================================

const { supabase: __fdb } = window.__nexus;

// ----------------------------------------------------------------------------
// EVENTS
// ----------------------------------------------------------------------------
async function loadEventsForGroup(groupId) {
  const { data, error } = await __fdb
    .from('events')
    .select('*, event_rsvps(*)')
    .eq('group_id', groupId)
    .order('starts_at');

  if (error) { console.error(error); return; }
  renderEventsView(data || []);
}

function renderEventsView(events) {
  const now = new Date();
  const upcoming = events.filter((e) => e.is_recurring || new Date(e.starts_at) >= now);
  const body = document.getElementById('view-events').querySelector('.view-body');

  if (!upcoming.length) {
    body.innerHTML = `
      <div class="empty-state-large">
        <div style="font-size:40px;">📅</div>
        <div style="font-weight:600;margin:8px 0;">No events yet</div>
        <div style="color:var(--text3);font-size:13px;margin-bottom:16px;">Plan something with your group — a movie night, a trip, anything.</div>
        <button class="btn-primary" onclick="openCreateEvent()">+ Plan something</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div style="font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:600;color:var(--text);margin-bottom:16px;">Upcoming</div>
    <div class="events-full-grid">
      ${upcoming.map((e) => renderEventCardHtml(e)).join('')}
    </div>
    <div style="text-align:center;padding:24px 0;">
      <button class="btn-primary" onclick="openCreateEvent()">+ Plan something new</button>
    </div>`;
}

function renderEventCardHtml(e) {
  const myRsvp = (e.event_rsvps || []).find((r) => r.user_id === currentUser.id)?.status;
  const dateStr = e.is_all_day
    ? new Date(e.starts_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + ' · All day'
    : new Date(e.starts_at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return `
    <div class="event-full-card">
      <div class="event-full-emoji">${escapeHtml(e.emoji)}</div>
      <div class="event-full-title">${escapeHtml(e.title)}</div>
      <div class="event-full-time">📅 ${dateStr}${e.is_recurring ? ' · Recurring' : ''}</div>
      ${e.description ? `<div class="event-full-desc">${escapeHtml(e.description)}</div>` : ''}
      <div class="rsvp-bar">
        <button class="rsvp-btn ${myRsvp === 'going' ? 'going' : ''}" onclick="setRsvp('${e.id}','going')">✓ Going</button>
        <button class="rsvp-btn ${myRsvp === 'maybe' ? 'maybe' : ''}" onclick="setRsvp('${e.id}','maybe')">? Maybe</button>
        <button class="rsvp-btn ${myRsvp === 'not_going' ? 'cant' : ''}" onclick="setRsvp('${e.id}','not_going')">✕ Can't</button>
      </div>
    </div>`;
}

async function setRsvp(eventId, status) {
  const { error } = await __fdb.from('event_rsvps').upsert({ event_id: eventId, user_id: currentUser.id, status, updated_at: new Date().toISOString() }, { onConflict: 'event_id,user_id' });
  if (error) { showToast('❌', 'Could not update RSVP.'); console.error(error); return; }
  showToast('✅', 'RSVP updated.');
  await loadEventsForGroup(activeGroupId);
}

function openCreateEvent() {
  document.getElementById('event-name-input').value = '';
  document.getElementById('event-date-input').value = '';
  document.getElementById('event-time-input').value = '';
  document.getElementById('event-desc-input').value = '';
  openModal('create-event-modal');
}

async function submitCreateEvent() {
  const title = document.getElementById('event-name-input').value.trim();
  const date = document.getElementById('event-date-input').value;
  const time = document.getElementById('event-time-input').value;
  const description = document.getElementById('event-desc-input').value.trim();

  if (!title) return showToast('⚠️', 'Please name your event.');
  if (!date) return showToast('⚠️', 'Please pick a date.');

  const startsAt = new Date(`${date}T${time || '00:00'}`);
  if (isNaN(startsAt.getTime())) return showToast('⚠️', 'That date/time looks invalid.');

  const { error } = await __fdb.from('events').insert({
    group_id: activeGroupId,
    title,
    description,
    starts_at: startsAt.toISOString(),
    is_all_day: !time,
    created_by: currentUser.id,
  });
  if (error) { showToast('❌', 'Could not create event.'); console.error(error); return; }

  closeModal('create-event-modal');
  showToast('🎉', 'Event created!');
  await loadEventsForGroup(activeGroupId);
}

// ----------------------------------------------------------------------------
// GOALS & TASKS
// ----------------------------------------------------------------------------
async function loadGoalsForGroup(groupId) {
  const { data, error } = await __fdb.from('goals').select('*, tasks(*)').eq('group_id', groupId).order('created_at');
  if (error) { console.error(error); return; }
  renderGoalsView(data || []);
}

function renderGoalsView(goals) {
  const body = document.getElementById('view-goals').querySelector('.view-body');
  if (!goals.length) {
    body.innerHTML = `
      <div class="empty-state-large">
        <div style="font-size:40px;">✅</div>
        <div style="font-weight:600;margin:8px 0;">No goals yet</div>
        <div style="color:var(--text3);font-size:13px;margin-bottom:16px;">Set a shared goal and break it into tasks your group can knock out together.</div>
        <button class="btn-primary" onclick="openCreateGoalModal()">+ Add goal</button>
      </div>`;
    return;
  }

  body.innerHTML =
    goals.map((g) => renderGoalCardHtml(g)).join('') +
    `<div style="text-align:center;padding:12px 0 24px;"><button class="btn-primary" onclick="openCreateGoalModal()">+ Add new goal</button></div>`;
}

function renderGoalCardHtml(g) {
  const tasks = g.tasks || [];
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const tagColors = { study: 'tag-study', fitness: 'tag-fitness', social: 'tag-social', trip: 'tag-trip' };

  return `
    <div class="goal-card">
      <div class="goal-header">
        <div class="goal-icon">${escapeHtml(g.emoji)}</div>
        <div><div class="goal-title">${escapeHtml(g.title)}</div><div class="goal-sub">${tasks.length} task${tasks.length === 1 ? '' : 's'}</div></div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="background:var(--accent);width:${pct}%;"></div></div>
      <div class="progress-label"><span>${pct}% complete</span><span>${done} / ${tasks.length} done</span></div>
      <div style="margin-top:12px;">
        ${tasks
          .map(
            (t) => `
          <div class="task-item">
            <div class="task-check ${t.done ? 'done' : ''}" onclick="toggleTaskDb('${t.id}', ${!t.done})"></div>
            <div class="task-label ${t.done ? 'done' : ''}">${escapeHtml(t.label)}</div>
            <div class="task-tag ${tagColors[g.tag] || 'tag-study'}">${escapeHtml(g.tag || 'general')}</div>
          </div>`
          )
          .join('')}
        <div style="margin-top:8px;display:flex;gap:8px;">
          <input class="form-input" placeholder="Add a task…" style="flex:1;font-size:13px;padding:7px 10px;" onkeydown="if(event.key==='Enter'){addTaskToGoal('${g.id}', this.value); this.value='';}">
        </div>
      </div>
    </div>`;
}

async function toggleTaskDb(taskId, done) {
  const { error } = await __fdb.from('tasks').update({ done, completed_at: done ? new Date().toISOString() : null }).eq('id', taskId);
  if (error) { showToast('❌', 'Could not update task.'); return; }
  await loadGoalsForGroup(activeGroupId);
}

async function addTaskToGoal(goalId, label) {
  label = label.trim();
  if (!label) return;
  const { error } = await __fdb.from('tasks').insert({ goal_id: goalId, label, created_by: currentUser.id });
  if (error) { showToast('❌', 'Could not add task.'); return; }
  await loadGoalsForGroup(activeGroupId);
}

function openCreateGoalModal() {
  document.getElementById('goal-title-input').value = '';
  document.getElementById('goal-emoji-input').value = '';
  document.getElementById('goal-tag-input').value = 'study';
  openModal('create-goal-modal');
}

async function submitCreateGoal() {
  const title = document.getElementById('goal-title-input').value.trim();
  const emoji = document.getElementById('goal-emoji-input').value.trim() || '🎯';
  const tag = document.getElementById('goal-tag-input').value;

  if (!title) return showToast('⚠️', 'Please name your goal.');

  const { error } = await __fdb.from('goals').insert({ group_id: activeGroupId, title, emoji, tag, created_by: currentUser.id });
  if (error) { showToast('❌', 'Could not create goal.'); console.error(error); return; }

  closeModal('create-goal-modal');
  showToast('🎯', 'Goal created!');
  await loadGoalsForGroup(activeGroupId);
}

// ----------------------------------------------------------------------------
// STORIES
// ----------------------------------------------------------------------------
let activeStories = [];
let currentStoryIdx = 0;
let storyTimer = null;

async function loadStoriesForGroup(groupId) {
  const { data, error } = await __fdb
    .from('stories')
    .select('*, profiles(*)')
    .eq('group_id', groupId)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });

  if (error) { console.error(error); return; }
  activeStories = data || [];
  renderStoriesBar();
}

function renderStoriesBar() {
  const bar = document.getElementById('stories-bar');
  if (!bar) return;
  const myStory = activeStories.find((s) => s.author_id === currentUser.id);

  bar.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;" onclick="openCreateStoryModal()">
      <div class="add-story">+</div>
      <span style="font-size:11px;color:var(--text3);">${myStory ? 'Add more' : 'Your story'}</span>
    </div>
    ${activeStories
      .map(
        (s, i) => `
      <div class="story" onclick="openStoryViewer(${i})">
        <div class="story-ring"><div class="story-inner">
          <div class="avatar" style="width:100%;height:100%;border-radius:50%;font-size:14px;background:linear-gradient(135deg,${s.profiles.avatar_color_from},${s.profiles.avatar_color_to});">${s.profiles.avatar_url ? `<img src="${escapeHtml(s.profiles.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : escapeHtml(initialsFor(s.profiles.display_name))}</div>
        </div></div>
        <span class="story-name">${escapeHtml(s.profiles.display_name.split(' ')[0])}</span>
      </div>`
      )
      .join('')}`;
}

function openCreateStoryModal() {
  document.getElementById('story-caption-input').value = '';
  document.getElementById('story-media-input').value = '';
  openModal('create-story-modal');
}

async function submitStory() {
  const caption = document.getElementById('story-caption-input').value.trim();
  const fileInput = document.getElementById('story-media-input');
  const file = fileInput.files[0];

  if (!caption && !file) return showToast('⚠️', 'Add a photo or a caption.');

  let mediaUrl = null;
  if (file) {
    showToast('⬆️', 'Uploading…');
    const path = `${activeGroupId}/${currentUser.id}/${Date.now()}-${file.name}`;
    const { error: upErr } = await __fdb.storage.from('media').upload(path, file);
    if (upErr) { showToast('❌', 'Upload failed.'); console.error(upErr); return; }
    mediaUrl = __fdb.storage.from('media').getPublicUrl(path).data.publicUrl;
  }

  const { error } = await __fdb.from('stories').insert({ group_id: activeGroupId, author_id: currentUser.id, media_url: mediaUrl, caption });
  if (error) { showToast('❌', 'Could not post story.'); console.error(error); return; }

  closeModal('create-story-modal');
  showToast('✨', 'Story posted! It\'ll disappear in 24 hours.');
  await loadStoriesForGroup(activeGroupId);
}

function openStoryViewer(idx) {
  currentStoryIdx = idx;
  document.getElementById('story-viewer').style.display = 'flex';
  renderActiveStory();
  startStoryTimer();
}
function renderActiveStory() {
  const s = activeStories[currentStoryIdx];
  if (!s) return closeStoryViewer();
  document.getElementById('story-name-display').textContent = s.profiles.display_name;
  document.getElementById('story-time-display').textContent = timeAgo(s.created_at);
  document.getElementById('story-caption').textContent = s.caption || '';
  const content = document.getElementById('story-content');
  if (s.media_url) {
    content.style.background = `url('${s.media_url}') center/cover`;
    content.textContent = '';
  } else {
    content.style.background = `linear-gradient(135deg,${s.profiles.avatar_color_from},${s.profiles.avatar_color_to})`;
    content.textContent = '💬';
  }
  const prog = document.getElementById('story-progress');
  prog.innerHTML = activeStories.map((_, i) => `<div class="story-prog-bar"><div class="story-prog-fill" id="spf-${i}" style="width:${i < currentStoryIdx ? '100%' : '0'}"></div></div>`).join('');
}
function startStoryTimer() {
  clearTimeout(storyTimer);
  const fill = document.getElementById(`spf-${currentStoryIdx}`);
  if (!fill) return;
  fill.style.transition = 'none';
  fill.style.width = '0';
  setTimeout(() => {
    fill.style.transition = 'width 5s linear';
    fill.style.width = '100%';
    storyTimer = setTimeout(nextStory, 5000);
  }, 50);
}
function nextStory() {
  clearTimeout(storyTimer);
  if (currentStoryIdx < activeStories.length - 1) { currentStoryIdx++; renderActiveStory(); startStoryTimer(); }
  else closeStoryViewer();
}
function prevStory() {
  clearTimeout(storyTimer);
  if (currentStoryIdx > 0) { currentStoryIdx--; renderActiveStory(); startStoryTimer(); }
}
function closeStoryViewer() {
  clearTimeout(storyTimer);
  document.getElementById('story-viewer').style.display = 'none';
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diffMs / 3600000);
  if (hrs < 1) return Math.floor(diffMs / 60000) + 'm ago';
  return hrs + 'h ago';
}

// ----------------------------------------------------------------------------
// MEMORY VAULT
// ----------------------------------------------------------------------------
async function loadVaultForGroup(groupId) {
  const [{ data: collections, error: cErr }, { data: items, error: iErr }] = await Promise.all([
    __fdb.from('vault_collections').select('*').eq('group_id', groupId).order('created_at'),
    __fdb.from('vault_items').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(12),
  ]);
  if (cErr) console.error(cErr);
  if (iErr) console.error(iErr);
  renderVaultView(collections || [], items || []);
}

function renderVaultView(collections, items) {
  const body = document.getElementById('view-vault').querySelector('.view-body');

  if (!collections.length && !items.length) {
    body.innerHTML = `
      <div class="empty-state-large">
        <div style="font-size:40px;">🗄️</div>
        <div style="font-weight:600;margin:8px 0;">No memories saved yet</div>
        <div style="color:var(--text3);font-size:13px;margin-bottom:16px;">Save your favorite messages and photos here as your group makes memories together.</div>
        <button class="btn-primary" onclick="openCreateCollectionModal()">+ Create a collection</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="vault-section-title">📍 Recent</div>
    <div class="vault-grid">
      ${
        items.length
          ? items.map((it) => `<div class="vault-item" title="${escapeHtml(it.caption || '')}">${it.media_url ? `<img src="${escapeHtml(it.media_url)}" style="width:100%;height:100%;object-fit:cover;">` : `<div class="vault-item-bg">💬</div>`}<div class="vault-item-label">${escapeHtml(it.caption || 'Saved memory')}</div></div>`).join('')
          : '<div class="empty-state-small">Nothing saved yet</div>'
      }
    </div>
    <div class="vault-section-title">📅 Collections</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${
        collections.length
          ? collections.map((c) => `
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 16px;display:flex;align-items:center;gap:14px;">
          <div style="font-size:28px;">${escapeHtml(c.emoji)}</div>
          <div style="flex:1;"><div style="font-size:14px;font-weight:600;color:var(--text);">${escapeHtml(c.name)}</div></div>
        </div>`).join('')
          : '<div class="empty-state-small">No collections yet</div>'
      }
      <button class="btn-ghost" onclick="openCreateCollectionModal()">+ New collection</button>
    </div>`;
}

function openCreateCollectionModal() {
  document.getElementById('collection-name-input').value = '';
  openModal('create-collection-modal');
}
async function submitCreateCollection() {
  const name = document.getElementById('collection-name-input').value.trim();
  if (!name) return showToast('⚠️', 'Please name your collection.');
  const { error } = await __fdb.from('vault_collections').insert({ group_id: activeGroupId, name, created_by: currentUser.id });
  if (error) { showToast('❌', 'Could not create collection.'); return; }
  closeModal('create-collection-modal');
  showToast('🗂️', 'Collection created!');
  await loadVaultForGroup(activeGroupId);
}

async function saveMessageToVault(messageId, caption) {
  const { error } = await __fdb.from('vault_items').insert({ group_id: activeGroupId, source_message_id: messageId, saved_by: currentUser.id, caption: caption || '' });
  if (error) { showToast('❌', 'Could not save to vault.'); return; }
  showToast('🗄️', 'Saved to Memory Vault.');
  await loadVaultForGroup(activeGroupId);
}
