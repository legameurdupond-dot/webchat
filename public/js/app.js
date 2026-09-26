const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const STATUS_LABEL = { online: 'En ligne', away: 'Absent', dnd: 'Ne pas déranger', invisible: 'Invisible', offline: 'Hors ligne' };

const state = {
  token: localStorage.getItem('webchat_token') || null,
  user: null,
  socket: null,
  servers: [],
  currentServer: null,
  channels: [],
  currentChannel: null,
  members: [],
  presence: new Map(), // userId -> status
  messages: new Map(), // messageId -> message
  replyTo: null,
  typingUsers: new Map(), // userId -> username
  typingTimeout: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function api(path, options = {}) {
  const res = await fetch('/api' + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur serveur');
  return data;
}

function initials(name) { return name.slice(0, 2).toUpperCase(); }

function avatarEl(user, size) {
  const wrap = el('div', 'avatar-wrap');
  let a;
  if (user.avatarUrl) {
    a = document.createElement('img');
    a.className = 'avatar';
    a.src = user.avatarUrl;
  } else {
    a = el('div', 'avatar', initials(user.username));
    a.style.background = user.avatarColor || '#5865F2';
  }
  if (size) { a.style.width = a.style.height = size + 'px'; }
  wrap.appendChild(a);
  return { wrap, a };
}

function timeFmt(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- Auth screen ---------------- */

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $('#loginForm').classList.toggle('hidden', tab.dataset.tab !== 'login');
    $('#registerForm').classList.toggle('hidden', tab.dataset.tab !== 'register');
  });
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const data = await api('/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }),
    });
    onAuthSuccess(data);
  } catch (err) { $('#loginError').textContent = err.message; }
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#registerError').textContent = '';
  try {
    const data = await api('/register', {
      method: 'POST',
      body: JSON.stringify({ username: $('#registerUsername').value.trim(), password: $('#registerPassword').value }),
    });
    onAuthSuccess(data);
  } catch (err) { $('#registerError').textContent = err.message; }
});

function onAuthSuccess({ token, user }) {
  state.token = token;
  state.user = user;
  localStorage.setItem('webchat_token', token);
  startApp();
}

/* ---------------- App bootstrap ---------------- */

async function tryResumeSession() {
  if (!state.token) return showAuth();
  try {
    state.user = await api('/me');
    startApp();
  } catch {
    localStorage.removeItem('webchat_token');
    showAuth();
  }
}

function showAuth() {
  $('#authScreen').classList.remove('hidden');
  $('#appScreen').classList.add('hidden');
}

async function startApp() {
  $('#authScreen').classList.add('hidden');
  $('#appScreen').classList.remove('hidden');

  renderSelfPanel();
  connectSocket();

  state.servers = await api('/servers');
  if (!state.servers.length) return;
  state.currentServer = state.servers[0];
  renderServerRail();
  $('#serverName').textContent = state.currentServer.name;

  state.channels = await api(`/servers/${state.currentServer.id}/channels`);
  renderChannelLists();

  state.members = await api(`/servers/${state.currentServer.id}/members`);
  renderMembers();

  const firstText = state.channels.find((c) => c.type === 'text');
  if (firstText) selectChannel(firstText);
}

function renderSelfPanel() {
  $('#selfUsername').textContent = state.user.username;
  setStatusPicker(state.user.status);
  const { wrap, a } = avatarEl(state.user);
  a.style.width = a.style.height = '34px';
  $('#selfAvatar').replaceWith(wrap);
  wrap.id = 'selfAvatar';
}

function setStatusPicker(status) {
  $('#statusPickerDot').className = 'status-dot-inline ' + status;
  $('#statusPickerLabel').textContent = STATUS_LABEL[status] || STATUS_LABEL.online;
}

$('#statusPickerBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#statusPickerMenu').classList.toggle('hidden');
});
document.querySelectorAll('#statusPickerMenu button').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const status = btn.dataset.status;
    $('#statusPickerMenu').classList.add('hidden');
    setStatusPicker(status);
    state.user.status = status;
    await api('/me', { method: 'PUT', body: JSON.stringify({ status }) });
    state.socket.emit('status:update', status);
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#statusPicker')) $('#statusPickerMenu').classList.add('hidden');
});

function renderServerRail() {
  const rail = $('#serversRail');
  rail.innerHTML = '';
  for (const s of state.servers) {
    const icon = el('div', 'server-icon' + (s.id === state.currentServer.id ? ' active' : ''), initials(s.name));
    icon.title = s.name;
    rail.appendChild(icon);
  }
}

function renderChannelLists() {
  const textList = $('#textChannels');
  const voiceList = $('#voiceChannels');
  textList.innerHTML = '';
  voiceList.innerHTML = '';
  for (const c of state.channels) {
    const item = el('li', 'channel-item', (c.type === 'text' ? '# ' : '🔊 ') + c.name);
    item.dataset.id = c.id;
    if (state.currentChannel && c.id === state.currentChannel.id) item.classList.add('active');
    item.addEventListener('click', () => {
      if (c.type === 'voice') {
        Voice.joinChannel(c);
        renderChannelLists();
        return;
      }
      selectChannel(c);
    });
    if (c.type === 'voice' && Voice.isInChannel(c.id)) item.classList.add('active');
    (c.type === 'text' ? textList : voiceList).appendChild(item);
  }
  Voice.refreshSidebar();
}

/* ---------------- Channel / messages ---------------- */

async function selectChannel(channel) {
  if (state.currentChannel) state.socket?.emit('channel:leave', state.currentChannel.id);
  state.currentChannel = channel;
  state.replyTo = null;
  $('#replyPreview').classList.add('hidden');
  renderChannelLists();
  $('#channelName').textContent = channel.name;

  state.socket?.emit('channel:join', channel.id);

  const messages = await api(`/channels/${channel.id}/messages`);
  state.messages.clear();
  const container = $('#messages');
  container.innerHTML = '';
  for (const m of messages) {
    state.messages.set(m.id, m);
    container.appendChild(renderMessage(m));
  }
  scrollToBottom();
}

function scrollToBottom() {
  const c = $('#messages');
  c.scrollTop = c.scrollHeight;
}

function renderMessage(m) {
  const row = el('div', 'message-row');
  row.dataset.id = m.id;
  const { wrap } = avatarEl(m.author);
  wrap.classList.add('clickable');
  wrap.addEventListener('click', () => openProfileCard(m.author.id));
  row.appendChild(wrap);

  const body = el('div', 'message-body');

  if (m.replyToId) {
    const target = state.messages.get(m.replyToId);
    const ctx = el('div', 'reply-context');
    ctx.textContent = target ? `↩ répond à ${target.author.username}: ${target.content.slice(0, 60)}` : '↩ répond à un message';
    body.appendChild(ctx);
  }

  const header = el('div', 'message-header');
  const authorEl = el('span', 'message-author clickable', m.author.username);
  authorEl.addEventListener('click', () => openProfileCard(m.author.id));
  header.appendChild(authorEl);
  header.appendChild(el('span', 'message-time', timeFmt(m.createdAt)));
  body.appendChild(header);

  const content = el('div', 'message-content');
  content.dataset.role = 'content';
  content.textContent = m.content;
  if (m.editedAt) content.appendChild(el('span', 'edited-tag', '(modifié)'));
  body.appendChild(content);

  const reactionsRow = el('div', 'reactions-row');
  reactionsRow.dataset.role = 'reactions';
  renderReactions(reactionsRow, m);
  body.appendChild(reactionsRow);

  row.appendChild(body);

  const actions = el('div', 'message-actions');
  const reactBtn = el('button', null, '🙂');
  reactBtn.title = 'Réagir';
  reactBtn.addEventListener('click', (e) => openEmojiPicker(e, m.id));
  actions.appendChild(reactBtn);

  const replyBtn = el('button', null, '↩');
  replyBtn.title = 'Répondre';
  replyBtn.addEventListener('click', () => startReply(m));
  actions.appendChild(replyBtn);

  if (m.author.id === state.user.id) {
    const editBtn = el('button', null, '✎');
    editBtn.title = 'Modifier';
    editBtn.addEventListener('click', () => startEdit(row, m));
    actions.appendChild(editBtn);

    const delBtn = el('button', null, '🗑');
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', () => {
      if (confirm('Supprimer ce message ?')) state.socket.emit('message:delete', { messageId: m.id });
    });
    actions.appendChild(delBtn);
  }
  row.appendChild(actions);

  return row;
}

function renderReactions(rowEl, m) {
  rowEl.innerHTML = '';
  const grouped = {};
  for (const r of m.reactions || []) {
    grouped[r.emoji] = grouped[r.emoji] || [];
    grouped[r.emoji].push(r.userId);
  }
  for (const [emoji, userIds] of Object.entries(grouped)) {
    if (!userIds.length) continue;
    const chip = el('div', 'reaction-chip' + (userIds.includes(state.user.id) ? ' mine' : ''));
    chip.textContent = `${emoji} ${userIds.length}`;
    chip.addEventListener('click', () => state.socket.emit('reaction:toggle', { messageId: m.id, emoji }));
    rowEl.appendChild(chip);
  }
}

function startReply(m) {
  state.replyTo = m.id;
  $('#replyPreview').classList.remove('hidden');
  $('#replyPreviewText').textContent = `Réponse à ${m.author.username}: ${m.content.slice(0, 50)}`;
  $('#messageInput').focus();
}
$('#cancelReply').addEventListener('click', () => {
  state.replyTo = null;
  $('#replyPreview').classList.add('hidden');
});

function startEdit(row, m) {
  const contentEl = row.querySelector('[data-role="content"]');
  const original = m.content;
  contentEl.innerHTML = '';
  const ta = el('textarea');
  ta.value = original;
  ta.style.cssText = 'width:100%;background:var(--bg-input);color:var(--text-normal);border:none;border-radius:6px;padding:6px;resize:none;outline:none;';
  contentEl.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  function commit() {
    const val = ta.value.trim();
    if (val && val !== original) state.socket.emit('message:edit', { messageId: m.id, content: val });
    else contentEl.textContent = original;
  }
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { contentEl.textContent = original; }
  });
  ta.addEventListener('blur', commit);
}

function openEmojiPicker(e, messageId) {
  const picker = $('#emojiPicker');
  picker.innerHTML = '';
  for (const emoji of EMOJIS) {
    const span = el('span', null, emoji);
    span.addEventListener('click', () => {
      state.socket.emit('reaction:toggle', { messageId, emoji });
      picker.classList.add('hidden');
    });
    picker.appendChild(span);
  }
  const rect = e.target.getBoundingClientRect();
  picker.style.top = rect.bottom + 4 + 'px';
  picker.style.left = Math.max(8, rect.left - 150) + 'px';
  picker.classList.remove('hidden');
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emojiPicker') && e.target.title !== 'Réagir') $('#emojiPicker').classList.add('hidden');
});

/* ---------------- Sending / typing ---------------- */

const input = $('#messageInput');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  if (!state.currentChannel) return;
  state.socket.emit('typing:start', { channelId: state.currentChannel.id });
  clearTimeout(state.typingTimeout);
  state.typingTimeout = setTimeout(() => state.socket.emit('typing:stop', { channelId: state.currentChannel.id }), 2000);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$('#sendBtn').addEventListener('click', sendMessage);

function sendMessage() {
  const text = input.value.trim();
  if (!text || !state.currentChannel) return;
  state.socket.emit('message:send', { channelId: state.currentChannel.id, content: text, replyToId: state.replyTo });
  input.value = '';
  input.style.height = 'auto';
  state.replyTo = null;
  $('#replyPreview').classList.add('hidden');
  clearTimeout(state.typingTimeout);
  state.socket.emit('typing:stop', { channelId: state.currentChannel.id });
}

/* ---------------- Members / presence ---------------- */

function renderMembers() {
  const onlineList = $('#onlineMembers');
  const offlineList = $('#offlineMembers');
  onlineList.innerHTML = '';
  offlineList.innerHTML = '';
  let onlineCount = 0;

  const sorted = [...state.members].sort((a, b) => a.username.localeCompare(b.username));
  for (const m of sorted) {
    const status = state.presence.get(m.id) || 'offline';
    const isOnline = status !== 'offline';
    if (isOnline) onlineCount++;

    const item = el('li', 'member-item clickable');
    const { wrap } = avatarEl(m, 32);
    const dot = el('div', 'status-dot ' + status);
    wrap.appendChild(dot);
    item.appendChild(wrap);
    item.appendChild(el('span', 'member-name' + (isOnline ? '' : ' offline'), m.username));
    item.addEventListener('click', () => openProfileCard(m.id));
    (isOnline ? onlineList : offlineList).appendChild(item);
  }
  $('#onlineLabel').textContent = `En ligne — ${onlineCount}`;
}

/* ---------------- Socket.io ---------------- */

function connectSocket() {
  state.socket = io({ auth: { token: state.token } });
  Voice.init(state.socket, state.user);

  state.socket.on('voice:room-update', () => renderChannelLists());

  state.socket.on('member:updated', ({ userId, username, avatarColor, avatarUrl }) => {
    const m = state.members.find((x) => x.id === userId);
    if (m) { m.username = username; m.avatarColor = avatarColor; m.avatarUrl = avatarUrl; renderMembers(); }
  });

  state.socket.on('presence:snapshot', (snapshot) => {
    for (const { userId, status } of snapshot) state.presence.set(userId, status);
    renderMembers();
  });

  state.socket.on('presence:update', ({ userId, status }) => {
    state.presence.set(userId, status);
    renderMembers();
  });

  state.socket.on('message:new', (m) => {
    if (!state.currentChannel || m.channelId !== state.currentChannel.id) {
      notify(m);
      return;
    }
    state.messages.set(m.id, m);
    $('#messages').appendChild(renderMessage(m));
    scrollToBottom();
    notify(m);
  });

  state.socket.on('message:updated', ({ id, content, editedAt }) => {
    const m = state.messages.get(id);
    if (!m) return;
    m.content = content;
    m.editedAt = editedAt;
    const row = document.querySelector(`.message-row[data-id="${id}"]`);
    if (row) {
      const contentEl = row.querySelector('[data-role="content"]');
      contentEl.textContent = content;
      contentEl.appendChild(el('span', 'edited-tag', '(modifié)'));
    }
  });

  state.socket.on('message:deleted', ({ id }) => {
    state.messages.delete(id);
    document.querySelector(`.message-row[data-id="${id}"]`)?.remove();
  });

  state.socket.on('reaction:update', ({ messageId, emoji, userId, added }) => {
    const m = state.messages.get(messageId);
    if (!m) return;
    m.reactions = m.reactions || [];
    if (added) m.reactions.push({ emoji, userId });
    else m.reactions = m.reactions.filter((r) => !(r.emoji === emoji && r.userId === userId));
    const row = document.querySelector(`.message-row[data-id="${messageId}"]`);
    if (row) renderReactions(row.querySelector('[data-role="reactions"]'), m);
  });

  state.socket.on('typing:update', ({ channelId, userId, username, typing }) => {
    if (!state.currentChannel || channelId !== state.currentChannel.id || userId === state.user.id) return;
    if (typing) state.typingUsers.set(userId, username);
    else state.typingUsers.delete(userId);
    const names = [...state.typingUsers.values()];
    $('#typingIndicator').textContent = names.length ? `${names.join(', ')} ${names.length > 1 ? 'écrivent' : 'écrit'}...` : '';
  });
}

function notify(m) {
  if (m.author.id === state.user.id) return;
  if (document.hasFocus()) return;
  if (Notification?.permission === 'granted') {
    new Notification(`${m.author.username}`, { body: m.content.slice(0, 100) });
  }
}
if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
  Notification.requestPermission();
}

/* ---------------- Profile card (view another user's profile) ---------------- */

async function openProfileCard(userId) {
  let profile;
  try { profile = await api(`/users/${userId}`); } catch { return; }

  $('#pcBanner').style.backgroundImage = profile.bannerUrl ? `url(${profile.bannerUrl})` : '';

  const avatarWrap = $('#pcAvatarWrap');
  avatarWrap.querySelectorAll('img, .avatar-fallback, .status-dot').forEach((e) => e.remove());
  if (profile.avatarUrl) {
    const img = document.createElement('img');
    img.src = profile.avatarUrl;
    avatarWrap.prepend(img);
  } else {
    const fallback = el('div', 'avatar-fallback', initials(profile.username));
    fallback.style.background = profile.avatarColor || '#5865F2';
    avatarWrap.prepend(fallback);
  }
  const status = userId === state.user.id ? state.user.status : (state.presence.get(userId) || 'offline');
  avatarWrap.appendChild(el('div', 'status-dot ' + status));

  $('#pcName').textContent = profile.username;
  const statusEl = $('#pcStatus');
  statusEl.textContent = '';
  statusEl.appendChild(el('span', 'status-dot-inline ' + status));
  statusEl.appendChild(document.createTextNode(STATUS_LABEL[status] || STATUS_LABEL.offline));

  $('#pcBio').textContent = profile.bio || '';
  $('#pcBio').classList.toggle('hidden', !profile.bio);

  const joined = new Date(profile.createdAt);
  $('#pcMeta').textContent = `Membre depuis ${joined.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  const voiceChannelId = Voice.getVoiceChannelIdFor(userId);
  const pcVoice = $('#pcVoice');
  if (voiceChannelId) {
    const channel = state.channels.find((c) => c.id === voiceChannelId);
    $('#pcVoiceChannel').textContent = channel ? channel.name : 'Salon vocal';
    pcVoice.classList.remove('hidden');
    $('#pcJoinVoice').onclick = () => {
      if (channel) Voice.joinChannel(channel);
      $('#profileCardModal').classList.add('hidden');
    };
  } else {
    pcVoice.classList.add('hidden');
  }

  $('#profileCardModal').classList.remove('hidden');
}

$('#closeProfileCard').addEventListener('click', () => $('#profileCardModal').classList.add('hidden'));
$('#profileCardModal').addEventListener('click', (e) => {
  if (e.target.id === 'profileCardModal') $('#profileCardModal').classList.add('hidden');
});

/* ---------------- Profile editor: avatar / banner / Giphy ---------------- */

function renderProfilePreview() {
  const banner = $('#profileBanner');
  banner.style.backgroundImage = state.user.bannerUrl ? `url(${state.user.bannerUrl})` : '';
  banner.classList.toggle('has-image', !!state.user.bannerUrl);

  const preview = $('#profileAvatarPreview');
  preview.querySelector('img')?.remove();
  preview.querySelector('.avatar-fallback')?.remove();
  if (state.user.avatarUrl) {
    const img = document.createElement('img');
    img.src = state.user.avatarUrl;
    preview.prepend(img);
  } else {
    const fallback = el('div', 'avatar-fallback', initials(state.user.username));
    fallback.style.background = state.user.avatarColor || '#5865F2';
    preview.prepend(fallback);
  }
  $('#profilePreviewName').textContent = state.user.username;
}

async function saveProfileImage(field, url) {
  state.user = await api('/me', { method: 'PUT', body: JSON.stringify({ [field]: url }) });
  renderProfilePreview();
  renderSelfPanel();
  Voice.updateSelfUser(state.user);
  state.socket?.emit('profile:refresh');
}

async function uploadImage(file, kind) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/me/${kind}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + state.token },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'Import impossible'); return null; }
  return data.url;
}

function ensureImageChooser() {
  let menu = document.getElementById('imageChooserMenu');
  if (!menu) {
    menu = el('div', 'image-chooser hidden');
    menu.id = 'imageChooserMenu';
    document.body.appendChild(menu);
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !e.target.closest('#editAvatarBtn') && !e.target.closest('#editBannerBtn')) {
        menu.classList.add('hidden');
      }
    });
  }
  return menu;
}

function openImageChooser(anchorEl, target) {
  const menu = ensureImageChooser();
  menu.innerHTML = '';

  const uploadBtn = el('button', null, '📁 Importer une image');
  uploadBtn.type = 'button';
  uploadBtn.addEventListener('click', () => {
    menu.classList.add('hidden');
    const input = target === 'avatar' ? $('#avatarFileInput') : $('#bannerFileInput');
    input.onchange = async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      const url = await uploadImage(file, target);
      if (url) await saveProfileImage(target === 'avatar' ? 'avatarUrl' : 'bannerUrl', url);
    };
    input.click();
  });
  menu.appendChild(uploadBtn);

  const gifBtn = el('button', null, '🎞️ Choisir un GIF (Giphy)');
  gifBtn.type = 'button';
  gifBtn.addEventListener('click', () => {
    menu.classList.add('hidden');
    openGiphyModal(target);
  });
  menu.appendChild(gifBtn);

  if ((target === 'avatar' && state.user.avatarUrl) || (target === 'banner' && state.user.bannerUrl)) {
    const removeBtn = el('button', 'danger-option', '🗑️ Retirer');
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
      menu.classList.add('hidden');
      saveProfileImage(target === 'avatar' ? 'avatarUrl' : 'bannerUrl', null);
    });
    menu.appendChild(removeBtn);
  }

  const rect = anchorEl.getBoundingClientRect();
  menu.style.top = rect.bottom + 6 + 'px';
  menu.style.left = Math.max(8, rect.left) + 'px';
  menu.classList.remove('hidden');
}

$('#editAvatarBtn').addEventListener('click', (e) => { e.stopPropagation(); openImageChooser(e.currentTarget, 'avatar'); });
$('#editBannerBtn').addEventListener('click', (e) => { e.stopPropagation(); openImageChooser(e.currentTarget, 'banner'); });

let giphyTarget = null;
let giphyDebounce = null;

function openGiphyModal(target) {
  giphyTarget = target;
  $('#giphySearch').value = '';
  $('#giphyResults').innerHTML = '';
  $('#giphyModal').classList.remove('hidden');
  runGiphySearch('');
  $('#giphySearch').focus();
}

async function runGiphySearch(query) {
  const grid = $('#giphyResults');
  grid.innerHTML = '<div class="giphy-loading">Chargement...</div>';
  try {
    const results = await api(`/giphy/search?q=${encodeURIComponent(query)}`);
    grid.innerHTML = '';
    for (const g of results) {
      const img = document.createElement('img');
      img.src = g.preview;
      img.loading = 'lazy';
      img.className = 'giphy-thumb';
      img.addEventListener('click', async () => {
        $('#giphyModal').classList.add('hidden');
        await saveProfileImage(giphyTarget === 'avatar' ? 'avatarUrl' : 'bannerUrl', g.full);
      });
      grid.appendChild(img);
    }
    if (!results.length) grid.innerHTML = '<div class="giphy-loading">Aucun résultat</div>';
  } catch (err) {
    grid.innerHTML = `<div class="giphy-loading">${err.message || 'Giphy indisponible'}</div>`;
  }
}

$('#giphySearch').addEventListener('input', (e) => {
  clearTimeout(giphyDebounce);
  giphyDebounce = setTimeout(() => runGiphySearch(e.target.value.trim()), 350);
});
$('#closeGiphy').addEventListener('click', () => $('#giphyModal').classList.add('hidden'));

/* ---------------- Status / settings ---------------- */

document.querySelectorAll('.settings-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    $('#paneProfile').classList.toggle('hidden', tab.dataset.tab !== 'profile');
    $('#paneVoice').classList.toggle('hidden', tab.dataset.tab !== 'voice');
    $('#panePlugins').classList.toggle('hidden', tab.dataset.tab !== 'plugins');
  });
});

/* ---------------- Plugins tab ---------------- */

function ensurePluginPopover() {
  let pop = document.getElementById('pluginPopover');
  if (!pop) {
    pop = el('div', 'plugin-popover hidden');
    pop.id = 'pluginPopover';
    document.body.appendChild(pop);
    document.addEventListener('click', (e) => {
      if (!pop.contains(e.target) && !e.target.closest('.plugin-gear')) pop.classList.add('hidden');
    });
  }
  return pop;
}

function openPluginPopover(anchorEl, pluginId) {
  const pop = ensurePluginPopover();
  pop.innerHTML = '';

  if (pluginId === 'customTheme') {
    const info = Plugins.getThemeInfo();
    pop.appendChild(el('div', 'popover-title', info ? `Thème actuel — ${info.sizeKb} Ko` : 'Aucun thème importé'));
    const importBtn = el('button', null, '📁 Importer un fichier .css');
    importBtn.type = 'button';
    importBtn.addEventListener('click', () => {
      pop.classList.add('hidden');
      const input = $('#themeFileInput');
      input.onchange = () => {
        const file = input.files[0];
        input.value = '';
        if (file) Plugins.setThemeFile(file);
        renderPluginsGrid();
      };
      input.click();
    });
    pop.appendChild(importBtn);
    if (info) {
      const removeBtn = el('button', 'danger-option', '🗑️ Retirer le thème');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        Plugins.clearThemeFile();
        pop.classList.add('hidden');
        renderPluginsGrid();
      });
      pop.appendChild(removeBtn);
    }
  }

  if (pluginId === 'customFont') {
    pop.appendChild(el('div', 'popover-title', 'Choisir une police'));
    for (const font of Plugins.FONTS) {
      const btn = el('button', 'font-option' + (Plugins.getFontId() === font.id ? ' active' : ''), font.label);
      btn.type = 'button';
      if (font.family) btn.style.fontFamily = font.family;
      btn.addEventListener('click', () => {
        Plugins.setFont(font.id);
        pop.classList.add('hidden');
        renderPluginsGrid();
      });
      pop.appendChild(btn);
    }
  }

  const rect = anchorEl.getBoundingClientRect();
  pop.style.top = rect.bottom + 6 + 'px';
  pop.style.left = Math.max(8, rect.right - 230) + 'px';
  pop.classList.remove('hidden');
}

function renderPluginsGrid() {
  const grid = $('#pluginsGrid');
  grid.innerHTML = '';
  for (const plugin of Plugins.DEFS) {
    const card = el('div', 'plugin-card');
    const header = el('div', 'plugin-card-header');
    const info = el('div');
    info.appendChild(el('div', 'plugin-name', plugin.name));
    info.appendChild(el('div', 'plugin-desc', plugin.desc));
    header.appendChild(info);

    const actions = el('div', 'plugin-actions');
    if (plugin.hasSettings) {
      const gear = el('button', 'plugin-gear', '⚙️');
      gear.type = 'button';
      gear.addEventListener('click', (e) => { e.stopPropagation(); openPluginPopover(gear, plugin.id); });
      actions.appendChild(gear);
    }
    const toggle = el('button', 'toggle-switch' + (Plugins.isEnabled(plugin.id) ? ' on' : ''));
    toggle.type = 'button';
    toggle.addEventListener('click', () => {
      Plugins.setEnabled(plugin.id, !Plugins.isEnabled(plugin.id));
      toggle.classList.toggle('on');
    });
    actions.appendChild(toggle);
    header.appendChild(actions);

    card.appendChild(header);
    grid.appendChild(card);
  }
}

function fillDeviceSelect(select, devices, selectedId, fallbackLabel) {
  select.innerHTML = '';
  const defaultOpt = el('option', null, `${fallbackLabel} (par défaut)`);
  defaultOpt.value = '';
  select.appendChild(defaultOpt);
  devices.forEach((d, i) => {
    const opt = el('option', null, d.label || `${fallbackLabel} ${i + 1}`);
    opt.value = d.deviceId;
    select.appendChild(opt);
  });
  select.value = selectedId || '';
}

function setSegmentedValue(container, value) {
  container.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === String(value)));
}
document.querySelectorAll('.segmented').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    setSegmentedValue(seg, btn.dataset.value);
  });
});

async function openSettings() {
  $('#bioInput').value = state.user.bio || '';
  renderProfilePreview();
  renderPluginsGrid();
  const prefs = Voice.getPrefs();
  setSegmentedValue($('#camResSegment'), prefs.camResolution);
  setSegmentedValue($('#screenFpsSegment'), prefs.screenFps);
  $('#settingsModal').classList.remove('hidden');

  const { mics, cams, speakers } = await Voice.listDevices();
  fillDeviceSelect($('#micSelect'), mics, prefs.micDeviceId, 'Microphone');
  fillDeviceSelect($('#camSelect'), cams, prefs.camDeviceId, 'Caméra');
  fillDeviceSelect($('#speakerSelect'), speakers, prefs.speakerDeviceId, 'Haut-parleur');
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#closeSettings').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#saveSettings').addEventListener('click', async () => {
  const bio = $('#bioInput').value;
  state.user = await api('/me', { method: 'PUT', body: JSON.stringify({ bio }) });

  const camRes = $('#camResSegment').querySelector('button.active')?.dataset.value || '720p';
  const screenFps = Number($('#screenFpsSegment').querySelector('button.active')?.dataset.value || 30);
  Voice.setPrefs({
    micDeviceId: $('#micSelect').value,
    camDeviceId: $('#camSelect').value,
    speakerDeviceId: $('#speakerSelect').value,
    camResolution: camRes,
    screenFps,
  });

  $('#settingsModal').classList.add('hidden');
});

/* ---------------- Search / members toggle ---------------- */

$('#messageSearch').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('.message-row').forEach((row) => {
    if (!q) { row.style.display = ''; return; }
    const text = row.querySelector('[data-role="content"]')?.textContent.toLowerCase() || '';
    const author = row.querySelector('.message-author')?.textContent.toLowerCase() || '';
    row.style.display = text.includes(q) || author.includes(q) ? '' : 'none';
  });
});

$('#toggleMembersBtn').addEventListener('click', () => {
  document.querySelector('.members-panel').classList.toggle('hidden');
});

tryResumeSession();
