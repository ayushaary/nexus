// ============================================================================
// PROFILE MANAGEMENT — replaces the static "Edit Profile coming in v2!" toast
// ============================================================================

const { supabase: __pdb } = window.__nexus;

function openProfileModal() {
  document.getElementById('profile-display-name').value = currentProfile.display_name || '';
  document.getElementById('profile-username').value = currentProfile.username || '';
  document.getElementById('profile-bio').value = currentProfile.bio || '';
  renderProfileAvatarPreview();
  openModal('profile-modal');
}

function renderProfileAvatarPreview() {
  const el = document.getElementById('profile-avatar-preview');
  if (currentProfile.avatar_url) {
    el.innerHTML = `<img src="${escapeHtml(currentProfile.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
  } else {
    el.style.background = `linear-gradient(135deg,${currentProfile.avatar_color_from},${currentProfile.avatar_color_to})`;
    el.textContent = initialsFor(currentProfile.display_name);
  }
}

async function handleAvatarFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showToast('⚠️', 'Please choose an image file.');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('⚠️', 'Image must be under 5MB.');
    return;
  }

  showToast('⬆️', 'Uploading photo…');
  const ext = file.name.split('.').pop();
  const path = `${currentUser.id}/avatar.${ext}`;

  const { error: uploadErr } = await __pdb.storage.from('avatars').upload(path, file, { upsert: true, cacheControl: '3600' });
  if (uploadErr) {
    console.error(uploadErr);
    showToast('❌', 'Upload failed: ' + uploadErr.message);
    return;
  }

  const { data: urlData } = __pdb.storage.from('avatars').getPublicUrl(path);
  // Cache-bust so the new image shows immediately instead of the browser
  // serving a stale cached copy at the same URL.
  const freshUrl = urlData.publicUrl + '?t=' + Date.now();

  const { error: updateErr } = await __pdb.from('profiles').update({ avatar_url: freshUrl }).eq('id', currentUser.id);
  if (updateErr) {
    console.error(updateErr);
    showToast('❌', 'Could not save your new photo.');
    return;
  }

  currentProfile.avatar_url = freshUrl;
  renderProfileAvatarPreview();
  updateSidebarAvatar();
  showToast('✅', 'Profile photo updated!');
}

async function saveProfileChanges(event) {
  event.preventDefault();

  const displayName = document.getElementById('profile-display-name').value.trim();
  const username = document.getElementById('profile-username').value.trim().toLowerCase();
  const bio = document.getElementById('profile-bio').value.trim();

  if (!displayName) return showToast('⚠️', 'Display name cannot be empty.');
  const uIssues = usernameIssues(username);
  if (uIssues.length) return showToast('⚠️', `Username must be ${uIssues.join(', ')}.`);

  setAuthLoading('profile-save-btn', true, 'Save changes');
  try {
    const { error } = await __pdb.from('profiles').update({ display_name: displayName, username, bio }).eq('id', currentUser.id);
    if (error) throw error;

    currentProfile = { ...currentProfile, display_name: displayName, username, bio };
    updateSidebarAvatar();
    closeModal('profile-modal');
    showToast('✅', 'Profile updated!');
  } catch (err) {
    if (/duplicate key|already exists/i.test(err.message)) {
      showToast('❌', 'That username is already taken.');
    } else {
      showToast('❌', 'Could not save changes: ' + err.message);
    }
  } finally {
    setAuthLoading('profile-save-btn', false, 'Save changes');
  }
}

function updateSidebarAvatar() {
  const navAvatar = document.getElementById('sidebar-avatar');
  if (!navAvatar) return;
  if (currentProfile.avatar_url) {
    navAvatar.innerHTML = `<img src="${escapeHtml(currentProfile.avatar_url)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`;
  } else {
    navAvatar.style.background = `linear-gradient(135deg,${currentProfile.avatar_color_from},${currentProfile.avatar_color_to})`;
    navAvatar.textContent = initialsFor(currentProfile.display_name);
  }
}
