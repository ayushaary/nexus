// ============================================================================
// ONBOARDING — create or join a group
// ============================================================================
// Replaces the prototype's auto-populated "The Squad" with a real choice:
// every new user starts with zero groups and must create or join one.
// ============================================================================

const { supabase: __sb } = window.__nexus;

let myGroups = [];       // [{id, name, emoji, ...}]
let activeGroupId = null;

async function loadMyGroups() {
  const { data, error } = await __sb
    .from('group_members')
    .select('role, groups(id, name, emoji, description, invite_code, created_by)')
    .eq('user_id', currentUser.id);

  if (error) {
    console.error('Failed to load groups', error);
    showToast('⚠️', 'Could not load your groups. Please refresh.');
    return [];
  }
  myGroups = (data || [])
    .filter((row) => row.groups)
    .map((row) => ({ ...row.groups, myRole: row.role }));
  return myGroups;
}

function renderGroupSwitcher() {
  const list = document.getElementById('group-switcher-list');
  if (!list) return;
  if (!myGroups.length) {
    list.innerHTML = '<div class="empty-state-small">No groups yet</div>';
    return;
  }
  list.innerHTML = myGroups
    .map(
      (g) => `
      <div class="group-switch-item ${g.id === activeGroupId ? 'active' : ''}" onclick="switchActiveGroup('${g.id}')">
        <div class="channel-avatar group" style="font-size:16px;">${escapeHtml(g.emoji)}</div>
        <div class="channel-name">${escapeHtml(g.name)}</div>
      </div>`
    )
    .join('');
}

async function switchActiveGroup(groupId) {
  activeGroupId = groupId;
  renderGroupSwitcher();
  await loadGroupWorkspace(groupId);
}

// ----------------------------------------------------------------------------
// CREATE GROUP
// ----------------------------------------------------------------------------
async function handleCreateGroup(event) {
  event.preventDefault();
  setAuthError('create-group', '');

  const name = document.getElementById('create-group-name').value.trim();
  const emojiInput = document.getElementById('create-group-emoji').value.trim();
  const emoji = emojiInput || '🏠';
  const description = document.getElementById('create-group-description').value.trim();

  if (!name) return setAuthError('create-group', 'Please give your group a name.');
  if (name.length > 80) return setAuthError('create-group', 'Group name is too long (max 80 characters).');

  setAuthLoading('create-group-submit', true, 'Create group');
  try {
    const { data, error } = await __sb
      .from('groups')
      .insert({ name, emoji, description, created_by: currentUser.id })
      .select()
      .single();
    if (error) throw error;

    showToast('🎉', `${name} created!`);
    await loadMyGroups();
    activeGroupId = data.id;
    renderGroupSwitcher();
    hideOnboardingOverlay();
    await loadGroupWorkspace(data.id);
  } catch (err) {
    setAuthError('create-group', err.message || 'Could not create the group. Please try again.');
  } finally {
    setAuthLoading('create-group-submit', false, 'Create group');
  }
}

// ----------------------------------------------------------------------------
// JOIN GROUP (via invite code)
// ----------------------------------------------------------------------------
async function handleJoinGroup(event) {
  event.preventDefault();
  setAuthError('join-group', '');

  const code = document.getElementById('join-group-code').value.trim().toLowerCase();
  if (!code) return setAuthError('join-group', 'Please enter an invite code.');

  setAuthLoading('join-group-submit', true, 'Join group');
  try {
    const { data: group, error: findErr } = await __sb.from('groups').select('id, name, emoji').eq('invite_code', code).maybeSingle();
    if (findErr) throw findErr;
    if (!group) {
      setAuthError('join-group', 'No group found with that invite code. Double-check it with whoever invited you.');
      return;
    }

    const { data: existing } = await __sb.from('group_members').select('group_id').eq('group_id', group.id).eq('user_id', currentUser.id).maybeSingle();
    if (existing) {
      showToast('👋', `You're already in ${group.name}.`);
    } else {
      const { error: joinErr } = await __sb.from('group_members').insert({ group_id: group.id, user_id: currentUser.id, role: 'member' });
      if (joinErr) throw joinErr;
      showToast('🎉', `Joined ${group.name}!`);
    }

    await loadMyGroups();
    activeGroupId = group.id;
    renderGroupSwitcher();
    hideOnboardingOverlay();
    await loadGroupWorkspace(group.id);
  } catch (err) {
    setAuthError('join-group', err.message || 'Could not join the group. Please check the code and try again.');
  } finally {
    setAuthLoading('join-group-submit', false, 'Join group');
  }
}

function copyInviteCode() {
  const activeGroup = myGroups.find((g) => g.id === activeGroupId);
  if (!activeGroup) return;
  copyToClipboard(activeGroup.invite_code);
  showToast('📋', 'Invite code copied — share it so others can join.');
}

// ----------------------------------------------------------------------------
// ONBOARDING OVERLAY VISIBILITY
// ----------------------------------------------------------------------------
function showOnboardingOverlay() {
  document.getElementById('onboarding-overlay').style.display = 'flex';
}
function hideOnboardingOverlay() {
  document.getElementById('onboarding-overlay').style.display = 'none';
}
function showOnboardingTab(tab) {
  document.querySelectorAll('.onboarding-tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.onboarding-tab-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('onboarding-tab-btn-' + tab).classList.add('active');
  document.getElementById('onboarding-tab-' + tab).classList.add('active');
}

// ----------------------------------------------------------------------------
// ENTRY POINT — called after a user's profile is confirmed to exist
// ----------------------------------------------------------------------------
async function runOnboardingCheck() {
  await loadMyGroups();
  renderGroupSwitcher();

  if (myGroups.length === 0) {
    showOnboardingOverlay();
    showOnboardingTab('create');
    return false; // caller should not proceed to load a workspace yet
  }
  activeGroupId = myGroups[0].id;
  return true;
}
