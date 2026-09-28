const Voice = (() => {
  let socket = null;
  let selfUser = null;
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let currentChannelId = null;

  let micStream = null;
  let videoTrack = null;
  let videoKind = null; // 'camera' | 'screen'
  let localStream = null;

  let callStartTime = null;
  let callTimerInterval = null;

  const peers = new Map(); // userId -> { pc, polite, makingOffer, ignoreOffer }
  const participants = new Map(); // userId -> { username, avatarColor, muted, camera, screenShare }
  const remoteStreams = new Map(); // userId -> MediaStream
  const roomsByChannel = new Map(); // channelId -> participants[]
  let selfState = { muted: false, camera: false, screenShare: false };

  const DEFAULT_PREFS = { micDeviceId: '', camDeviceId: '', speakerDeviceId: '', camResolution: '720p', screenFps: 30 };
  function loadPrefs() {
    try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('webchat_prefs') || '{}') }; }
    catch { return { ...DEFAULT_PREFS }; }
  }
  let prefs = loadPrefs();

  function iEl(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function initials(name) { return (name || '?').slice(0, 2).toUpperCase(); }
  function avatarDiv(user, size) {
    const wrap = iEl('div', 'avatar-wrap');
    let a;
    if (user.avatarUrl) {
      a = document.createElement('img');
      a.className = 'avatar';
      a.src = user.avatarUrl;
    } else {
      a = iEl('div', 'avatar', initials(user.username));
      a.style.background = user.avatarColor || '#5865F2';
    }
    if (size) { a.style.width = a.style.height = size + 'px'; }
    wrap.appendChild(a);
    return wrap;
  }

  function init(sock, user) {
    socket = sock;
    selfUser = user;

    fetch('/api/ice-servers', { headers: { Authorization: 'Bearer ' + localStorage.getItem('webchat_token') } })
      .then((res) => (res.ok ? res.json() : null))
      .then((list) => { if (list) iceServers = list; })
      .catch(() => { /* fallback to default STUN */ });

    socket.on('voice:snapshot', (snapshot) => {
      roomsByChannel.clear();
      for (const [channelId, list] of Object.entries(snapshot)) roomsByChannel.set(channelId, list);
      renderSidebarVoiceLists();
    });

    socket.on('voice:room-update', ({ channelId, participants: list }) => {
      roomsByChannel.set(channelId, list);
      renderSidebarVoiceLists();
    });

    socket.on('voice:participants', ({ participants: list }) => {
      for (const p of list) {
        participants.set(p.userId, p);
        getOrCreatePeer(p.userId);
      }
      renderCallBar();
    });

    socket.on('voice:user-joined', ({ channelId, userId, username, avatarColor }) => {
      if (channelId !== currentChannelId) return;
      participants.set(userId, { username, avatarColor, muted: false, camera: false, screenShare: false });
      getOrCreatePeer(userId);
      renderCallBar();
    });

    socket.on('voice:user-left', ({ channelId, userId }) => {
      if (channelId !== currentChannelId) return;
      closePeer(userId);
      participants.delete(userId);
      renderCallBar();
    });

    socket.on('voice:state-update', ({ channelId, userId, muted, camera, screenShare }) => {
      if (channelId !== currentChannelId) return;
      const p = participants.get(userId);
      if (p) { p.muted = muted; p.camera = camera; p.screenShare = screenShare; }
      renderCallBar();
      refreshVideoTile(userId);
    });

    socket.on('voice:signal', ({ fromUserId, data }) => handleSignal(fromUserId, data));

    socket.on('member:updated', ({ userId, username, avatarColor, avatarUrl }) => {
      const p = participants.get(userId);
      if (p) { p.username = username; p.avatarColor = avatarColor; p.avatarUrl = avatarUrl; renderCallBar(); }
    });

    socket.on('connect', () => {
      // The transport reconnected (network blip, host waking up, etc). The server
      // already dropped our previous voice session on disconnect, so any peer
      // connections we still hold are stale — tear them down and rejoin fresh so
      // everyone renegotiates instead of talking to a half-closed connection.
      if (currentChannelId) {
        for (const uid of [...peers.keys()]) closePeer(uid);
        participants.clear();
        socket.emit('voice:join', currentChannelId);
      }
    });

    wireButtons();
  }

  function wireButtons() {
    document.getElementById('toggleMicBtn').addEventListener('click', toggleMic);
    document.getElementById('toggleCamBtn').addEventListener('click', toggleCamera);
    document.getElementById('toggleScreenBtn').addEventListener('click', toggleScreenShare);
    document.getElementById('leaveCallBtn').addEventListener('click', leaveChannel);
  }

  /* ---- Peer connection / perfect negotiation ---- */

  function getOrCreatePeer(remoteUserId) {
    if (peers.has(remoteUserId)) return peers.get(remoteUserId).pc;
    const polite = selfUser.id > remoteUserId;
    const pc = new RTCPeerConnection({ iceServers });
    const entry = { pc, polite, makingOffer: false, ignoreOffer: false };
    peers.set(remoteUserId, entry);

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('voice:signal', { toUserId: remoteUserId, data: { description: pc.localDescription } });
      } catch (err) {
        console.error('negotiation error', err);
      } finally {
        entry.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('voice:signal', { toUserId: remoteUserId, data: { candidate } });
    };
    pc.ontrack = (event) => {
      remoteStreams.set(remoteUserId, event.streams[0]);
      attachAudioPool(remoteUserId, event.streams[0]);
      refreshVideoTile(remoteUserId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch { /* not supported, fall through to the timeout below */ }
        setTimeout(() => { if (pc.connectionState === 'failed') closePeer(remoteUserId); }, 8000);
      } else if (pc.connectionState === 'closed') {
        closePeer(remoteUserId);
      }
    };

    addLocalTracksToPeer(pc);
    return pc;
  }

  function addLocalTracksToPeer(pc) {
    if (!localStream) return;
    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
  }

  async function handleSignal(fromUserId, data) {
    let entry = peers.get(fromUserId);
    if (!entry) { getOrCreatePeer(fromUserId); entry = peers.get(fromUserId); }
    const { pc } = entry;
    try {
      if (data.description) {
        const offerCollision = data.description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return;
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          socket.emit('voice:signal', { toUserId: fromUserId, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (err) { if (!entry.ignoreOffer) throw err; }
      }
    } catch (err) {
      console.error('voice signal error', err);
    }
  }

  function closePeer(userId) {
    const entry = peers.get(userId);
    if (entry) { entry.pc.close(); peers.delete(userId); }
    remoteStreams.delete(userId);
    document.getElementById('audio-' + userId)?.remove();
    removeVideoTile(userId);
  }

  /* ---- Join / leave ---- */

  async function joinChannel(channel) {
    if (currentChannelId === channel.id) return;
    if (currentChannelId) await leaveChannel();

    currentChannelId = channel.id;
    localStream = new MediaStream();
    selfState = { muted: false, camera: false, screenShare: false };

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: prefs.micDeviceId ? { exact: prefs.micDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStream.getAudioTracks().forEach((t) => localStream.addTrack(t));
    } catch {
      alert("Micro indisponible : vous rejoignez le salon en �coute seule.");
      micStream = null;
    }

    socket.emit('voice:join', channel.id);
    startCallTimer();
    renderCallBar();
  }

  function startCallTimer() {
    const el = document.getElementById('callTimer');
    if (typeof Plugins === 'undefined' || !Plugins.isEnabled('voiceTimer')) { el?.classList.add('hidden'); return; }
    callStartTime = Date.now();
    el.classList.remove('hidden');
    updateCallTimer();
    callTimerInterval = setInterval(updateCallTimer, 1000);
  }

  function updateCallTimer() {
    const el = document.getElementById('callTimer');
    if (!el || !callStartTime) return;
    const secs = Math.floor((Date.now() - callStartTime) / 1000);
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    const pad = (n) => String(n).padStart(2, '0');
    el.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function stopCallTimer() {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    callStartTime = null;
    document.getElementById('callTimer')?.classList.add('hidden');
  }

  async function leaveChannel() {
    if (!currentChannelId) return;
    socket.emit('voice:leave');
    stopCallTimer();
    for (const userId of [...peers.keys()]) closePeer(userId);
    participants.clear();
    micStream?.getTracks().forEach((t) => t.stop());
    if (videoTrack) { videoTrack.stop(); videoTrack = null; videoKind = null; }
    micStream = null;
    localStream = null;
    currentChannelId = null;
    removeVideoTile('self');
    renderCallBar();
  }

  /* ---- Mic / camera / screen share ---- */

  function toggleMic() {
    if (!currentChannelId) return;
    selfState.muted = !selfState.muted;
    localStream?.getAudioTracks().forEach((t) => { t.enabled = !selfState.muted; });
    socket.emit('voice:state', { muted: selfState.muted });
    renderCallBar();
  }

  async function toggleCamera() {
    if (!currentChannelId) return;
    if (videoKind === 'camera') {
      stopVideoTrack();
    } else {
      if (videoKind === 'screen') stopVideoTrack();
      try {
        const dims = prefs.camResolution === '1080p' ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...dims, frameRate: { ideal: 30 }, deviceId: prefs.camDeviceId ? { exact: prefs.camDeviceId } : undefined },
        });
        videoTrack = stream.getVideoTracks()[0];
        videoKind = 'camera';
        localStream.addTrack(videoTrack);
        for (const [, entry] of peers) {
          const sender = entry.pc.addTrack(videoTrack, localStream);
          applyEncodingLimits(sender, prefs.camResolution === '1080p' ? 2_000_000 : 1_000_000, 30);
        }
        videoTrack.onended = () => stopVideoTrack();
        renderVideoTile('self', localStream, false);
      } catch {
        alert("Impossible d'accéder à la caméra.");
        return;
      }
    }
    selfState.camera = videoKind === 'camera';
    selfState.screenShare = videoKind === 'screen';
    socket.emit('voice:state', { camera: selfState.camera, screenShare: selfState.screenShare });
    renderCallBar();
  }

  async function toggleScreenShare() {
    if (!currentChannelId) return;
    if (videoKind === 'screen') {
      stopVideoTrack();
    } else {
      if (videoKind === 'camera') stopVideoTrack();
      try {
        const fps = prefs.screenFps >= 60 ? 60 : 30;
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: fps, max: fps }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true,
        });
        videoTrack = stream.getVideoTracks()[0];
        videoTrack.contentHint = 'detail';
        videoKind = 'screen';
        localStream.addTrack(videoTrack);
        for (const [, entry] of peers) {
          const sender = entry.pc.addTrack(videoTrack, localStream);
          applyEncodingLimits(sender, fps >= 60 ? 3_000_000 : 1_500_000, fps);
        }
        videoTrack.onended = () => stopVideoTrack();
        renderVideoTile('self', localStream, true);
      } catch (err) {
        if (err.name !== 'NotAllowedError') alert("Partage d'écran indisponible.");
        return;
      }
    }
    selfState.camera = videoKind === 'camera';
    selfState.screenShare = videoKind === 'screen';
    socket.emit('voice:state', { camera: selfState.camera, screenShare: selfState.screenShare });
    renderCallBar();
  }

  function applyEncodingLimits(sender, maxBitrate, maxFramerate) {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    params.encodings[0].maxFramerate = maxFramerate;
    sender.setParameters(params).catch(() => {});
  }

  function stopVideoTrack() {
    if (!videoTrack) return;
    localStream?.removeTrack(videoTrack);
    for (const [, entry] of peers) {
      const sender = entry.pc.getSenders().find((s) => s.track === videoTrack);
      if (sender) entry.pc.removeTrack(sender);
    }
    videoTrack.stop();
    videoTrack = null;
    videoKind = null;
    removeVideoTile('self');
  }

  /* ---- Devices & live preference changes ---- */

  async function listDevices() {
    try {
      if (!currentChannelId) {
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        tmp.getTracks().forEach((t) => t.stop());
      }
    } catch { /* permission refused: labels stay generic */ }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: devices.filter((d) => d.kind === 'audioinput'),
      cams: devices.filter((d) => d.kind === 'videoinput'),
      speakers: devices.filter((d) => d.kind === 'audiooutput'),
    };
  }

  function replaceLocalAudioTrack(newTrack) {
    const old = localStream.getAudioTracks()[0];
    if (old) { localStream.removeTrack(old); old.stop(); }
    localStream.addTrack(newTrack);
    newTrack.enabled = !selfState.muted;
    for (const [, entry] of peers) {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (sender) sender.replaceTrack(newTrack);
      else entry.pc.addTrack(newTrack, localStream);
    }
  }

  async function applyMicDevice() {
    if (!currentChannelId || !micStream) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: prefs.micDeviceId ? { exact: prefs.micDeviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      replaceLocalAudioTrack(stream.getAudioTracks()[0]);
    } catch { /* keep previous mic */ }
  }

  async function applyVideoPrefs() {
    if (!currentChannelId || !videoKind) return;
    if (videoKind === 'camera') {
      try {
        const dims = prefs.camResolution === '1080p' ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1280 }, height: { ideal: 720 } };
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { ...dims, frameRate: { ideal: 30 }, deviceId: prefs.camDeviceId ? { exact: prefs.camDeviceId } : undefined },
        });
        const newTrack = stream.getVideoTracks()[0];
        const old = videoTrack;
        localStream.removeTrack(old);
        localStream.addTrack(newTrack);
        videoTrack = newTrack;
        videoTrack.onended = () => stopVideoTrack();
        for (const [, entry] of peers) {
          const sender = entry.pc.getSenders().find((s) => s.track === old);
          if (sender) {
            sender.replaceTrack(newTrack);
            applyEncodingLimits(sender, prefs.camResolution === '1080p' ? 2_000_000 : 1_000_000, 30);
          }
        }
        old.stop();
        renderVideoTile('self', localStream, false);
      } catch { /* keep previous camera */ }
    } else if (videoKind === 'screen') {
      const fps = prefs.screenFps >= 60 ? 60 : 30;
      videoTrack.applyConstraints({ frameRate: { ideal: fps, max: fps } }).catch(() => {});
      for (const [, entry] of peers) {
        const sender = entry.pc.getSenders().find((s) => s.track === videoTrack);
        if (sender) applyEncodingLimits(sender, fps >= 60 ? 3_000_000 : 1_500_000, fps);
      }
    }
  }

  function applySpeakerToPool() {
    if (!prefs.speakerDeviceId) return;
    document.querySelectorAll('#audioPool video').forEach((el) => {
      if (typeof el.setSinkId === 'function') el.setSinkId(prefs.speakerDeviceId).catch(() => {});
    });
  }

  function getPrefs() { return { ...prefs }; }

  function setPrefs(next) {
    const micChanged = 'micDeviceId' in next && next.micDeviceId !== prefs.micDeviceId;
    const speakerChanged = 'speakerDeviceId' in next && next.speakerDeviceId !== prefs.speakerDeviceId;
    const videoChanged = ('camDeviceId' in next && next.camDeviceId !== prefs.camDeviceId) ||
      ('camResolution' in next && next.camResolution !== prefs.camResolution);
    const fpsChanged = 'screenFps' in next && next.screenFps !== prefs.screenFps;

    prefs = { ...prefs, ...next };
    localStorage.setItem('webchat_prefs', JSON.stringify(prefs));

    if (micChanged) applyMicDevice();
    if (videoChanged) applyVideoPrefs();
    if (fpsChanged && videoKind === 'screen') applyVideoPrefs();
    if (speakerChanged) applySpeakerToPool();
  }

  /* ---- Rendering: call bar ---- */

  function renderCallBar() {
    const bar = document.getElementById('callBar');
    if (!currentChannelId) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    const wrap = document.getElementById('callParticipants');
    wrap.innerHTML = '';
    const selfChip = iEl('div', 'call-participant');
    selfChip.appendChild(avatarDiv(selfUser, 24));
    selfChip.appendChild(iEl('span', null, selfUser.username + ' (vous)'));
    if (selfState.muted) selfChip.appendChild(iEl('span', 'mic-state', '🔇'));
    wrap.appendChild(selfChip);

    for (const [pid, p] of participants) {
      const chip = iEl('div', 'call-participant');
      chip.appendChild(avatarDiv(p, 24));
      chip.appendChild(iEl('span', null, p.username));
      if (p.muted) chip.appendChild(iEl('span', 'mic-state', '🔇'));
      const volBtn = iEl('button', 'volume-btn', '🔊');
      volBtn.title = 'Volume';
      volBtn.addEventListener('click', (e) => { e.stopPropagation(); openVolumePopover(volBtn, pid); });
      chip.appendChild(volBtn);
      wrap.appendChild(chip);
    }

    document.getElementById('toggleMicBtn').classList.toggle('off', selfState.muted);
    document.getElementById('toggleCamBtn').classList.toggle('active', selfState.camera);
    document.getElementById('toggleScreenBtn').classList.toggle('active', selfState.screenShare);
  }

  /* ---- Rendering: audio pool + video grid ---- */

  function attachAudioPool(userId, stream) {
    let a = document.getElementById('audio-' + userId);
    if (!a) {
      a = document.createElement('video');
      a.id = 'audio-' + userId;
      a.autoplay = true;
      a.playsInline = true;
      a.style.display = 'none';
      a.volume = prefs.userVolumes?.[userId] ?? 1;
      document.getElementById('audioPool').appendChild(a);
      if (prefs.speakerDeviceId && typeof a.setSinkId === 'function') a.setSinkId(prefs.speakerDeviceId).catch(() => {});
    }
    a.srcObject = stream;
  }

  function refreshVideoTile(userId) {
    const p = participants.get(userId);
    const stream = remoteStreams.get(userId);
    const hasVideo = stream && stream.getVideoTracks().length > 0 && p && (p.camera || p.screenShare);
    if (hasVideo) renderVideoTile(userId, stream, p.screenShare);
    else removeVideoTile(userId);
  }

  function renderVideoTile(userId, stream, isScreen) {
    const grid = document.getElementById('videoGrid');
    let tile = document.getElementById('tile-' + userId);
    if (!tile) {
      tile = iEl('div', 'video-tile');
      tile.id = 'tile-' + userId;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true; // audio always plays through the hidden audio pool, never here
      tile.appendChild(video);
      tile.appendChild(iEl('span', 'tile-label', userId === 'self' ? 'Vous' : (participants.get(userId)?.username || '')));

      const controls = iEl('div', 'tile-controls');
      if (userId !== 'self') {
        const volBtn = iEl('button', 'tile-btn', '🔊');
        volBtn.title = 'Volume';
        volBtn.addEventListener('click', (e) => { e.stopPropagation(); openVolumePopover(volBtn, userId); });
        controls.appendChild(volBtn);
      }
      const expandBtn = iEl('button', 'tile-btn', '⛶');
      expandBtn.title = 'Plein écran';
      expandBtn.addEventListener('click', (e) => { e.stopPropagation(); openTheater(userId); });
      controls.appendChild(expandBtn);
      tile.appendChild(controls);

      grid.appendChild(tile);
    }
    tile.classList.toggle('screen', !!isScreen);
    tile.querySelector('video').srcObject = stream;
    grid.classList.remove('hidden');
  }

  function removeVideoTile(userId) {
    document.getElementById('tile-' + userId)?.remove();
    const grid = document.getElementById('videoGrid');
    if (!grid.children.length) grid.classList.add('hidden');
    if (document.getElementById('theaterOverlay')?.dataset.userId === userId) closeTheater();
  }

  /* ---- Volume popover ---- */

  function ensureVolumePopover() {
    let pop = document.getElementById('volumePopover');
    if (!pop) {
      pop = iEl('div', 'volume-popover hidden');
      pop.id = 'volumePopover';
      pop.appendChild(iEl('span', null, '🔉'));
      const range = document.createElement('input');
      range.type = 'range'; range.min = '0'; range.max = '100'; range.className = 'volume-range';
      pop.appendChild(range);
      pop.appendChild(iEl('span', null, '🔊'));
      document.body.appendChild(pop);
      document.addEventListener('click', (e) => {
        if (!pop.contains(e.target) && !e.target.closest('.volume-btn')) pop.classList.add('hidden');
      });
    }
    return pop;
  }

  function openVolumePopover(anchorEl, userId) {
    const pop = ensureVolumePopover();
    const range = pop.querySelector('.volume-range');
    range.value = String(Math.round((prefs.userVolumes?.[userId] ?? 1) * 100));
    range.oninput = () => {
      const vol = Number(range.value) / 100;
      prefs.userVolumes = { ...(prefs.userVolumes || {}), [userId]: vol };
      localStorage.setItem('webchat_prefs', JSON.stringify(prefs));
      const audioEl = document.getElementById('audio-' + userId);
      if (audioEl) audioEl.volume = vol;
    };
    const rect = anchorEl.getBoundingClientRect();
    pop.style.top = Math.max(8, rect.top - 46) + 'px';
    pop.style.left = Math.max(8, rect.left - 70) + 'px';
    pop.classList.remove('hidden');
  }

  /* ---- Theater (fullscreen) view ---- */

  function openTheater(userId) {
    const stream = userId === 'self' ? localStream : remoteStreams.get(userId);
    if (!stream) return;
    let overlay = document.getElementById('theaterOverlay');
    if (!overlay) {
      overlay = iEl('div', 'theater-overlay hidden');
      overlay.id = 'theaterOverlay';
      const video = document.createElement('video');
      video.id = 'theaterVideo';
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      const closeBtn = iEl('button', 'theater-close', '✕');
      closeBtn.addEventListener('click', closeTheater);
      const label = iEl('div', 'theater-label');
      label.id = 'theaterLabel';
      overlay.appendChild(video);
      overlay.appendChild(label);
      overlay.appendChild(closeBtn);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeTheater(); });
      document.body.appendChild(overlay);
    }
    overlay.dataset.userId = userId;
    overlay.querySelector('video').srcObject = stream;
    document.getElementById('theaterLabel').textContent = userId === 'self' ? 'Vous' : (participants.get(userId)?.username || '');
    overlay.classList.remove('hidden');
  }

  function closeTheater() {
    document.getElementById('theaterOverlay')?.classList.add('hidden');
  }

  /* ---- Sidebar voice member lists ---- */

  function renderSidebarVoiceLists() {
    for (const [channelId, list] of roomsByChannel) updateSidebarChannel(channelId, list);
  }

  function getVoiceChannelIdFor(userId) {
    for (const [channelId, list] of roomsByChannel) {
      if (list.some((p) => p.userId === userId)) return channelId;
    }
    return null;
  }

  function updateSidebarChannel(channelId, list) {
    const item = document.querySelector(`.channel-item[data-id="${channelId}"]`);
    if (!item) return;
    let sub = item.nextElementSibling;
    if (!sub || !sub.classList?.contains('voice-member-list')) {
      sub = iEl('ul', 'voice-member-list');
      item.after(sub);
    }
    sub.innerHTML = '';
    if (!list || !list.length) { sub.remove(); return; }
    for (const p of list) {
      const li = iEl('li', 'voice-member-item');
      li.appendChild(avatarDiv(p, 20));
      li.appendChild(iEl('span', null, p.username));
      if (p.muted) li.appendChild(iEl('span', 'mic-off', '🔇'));
      sub.appendChild(li);
    }
  }

  return {
    init,
    joinChannel,
    leaveChannel,
    refreshSidebar: renderSidebarVoiceLists,
    isInChannel: (id) => currentChannelId === id,
    listDevices,
    getPrefs,
    setPrefs,
    updateSelfUser: (u) => { selfUser = u; renderCallBar(); },
    getVoiceChannelIdFor,
  };
})();
