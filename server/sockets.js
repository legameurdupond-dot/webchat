const crypto = require('node:crypto');
const db = require('./db');
const { verifyToken } = require('./auth');

const onlineUsers = new Map(); // userId -> Set<socketId>
const voiceRooms = new Map(); // channelId -> Map<userId, { username, avatarColor, muted, camera, screenShare }>

function voiceParticipants(channelId) {
  const room = voiceRooms.get(channelId);
  return room ? [...room.entries()].map(([userId, s]) => ({ userId, ...s })) : [];
}

function fullVoiceSnapshot() {
  const snapshot = {};
  for (const [channelId] of voiceRooms) snapshot[channelId] = voiceParticipants(channelId);
  return snapshot;
}

function setupSockets(io) {
  io.use((socket, next) => {
    const payload = verifyToken(socket.handshake.auth?.token);
    if (!payload) return next(new Error('unauthorized'));
    socket.user = payload;
    next();
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) return socket.disconnect();

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    const server = db.prepare('SELECT id FROM servers ORDER BY created_at LIMIT 1').get();
    if (server) {
      socket.join(`server:${server.id}`);
      socket.serverId = server.id;
    }

    if (onlineUsers.get(userId).size === 1 && user.status !== 'invisible') {
      io.emit('presence:update', { userId, status: user.status });
    }

    const snapshot = [];
    for (const [uid] of onlineUsers) {
      const u = db.prepare('SELECT status FROM users WHERE id = ?').get(uid);
      if (u && u.status !== 'invisible') snapshot.push({ userId: uid, status: u.status });
    }
    socket.emit('presence:snapshot', snapshot);
    socket.emit('voice:snapshot', fullVoiceSnapshot());

    socket.on('channel:join', (channelId) => {
      socket.join(`channel:${channelId}`);
    });

    socket.on('channel:leave', (channelId) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on('message:send', ({ channelId, content, replyToId }) => {
      const text = (content || '').toString().trim().slice(0, 4000);
      if (!text || !channelId) return;
      const id = crypto.randomUUID();
      const now = Date.now();
      db.prepare(
        'INSERT INTO messages (id, channel_id, user_id, content, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(id, channelId, userId, text, replyToId || null, now);

      io.to(`channel:${channelId}`).emit('message:new', {
        id,
        channelId,
        content: text,
        replyToId: replyToId || null,
        editedAt: null,
        createdAt: now,
        author: { id: user.id, username: user.username, avatarColor: user.avatar_color, avatarUrl: user.avatar_url || null },
        reactions: [],
      });
    });

    socket.on('message:edit', ({ messageId, content }) => {
      const text = (content || '').toString().trim().slice(0, 4000);
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.user_id !== userId || !text) return;
      const now = Date.now();
      db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(text, now, messageId);
      io.to(`channel:${msg.channel_id}`).emit('message:updated', { id: messageId, content: text, editedAt: now });
    });

    socket.on('message:delete', ({ messageId }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || msg.user_id !== userId) return;
      db.prepare('UPDATE messages SET deleted = 1 WHERE id = ?').run(messageId);
      io.to(`channel:${msg.channel_id}`).emit('message:deleted', { id: messageId });
    });

    socket.on('reaction:toggle', ({ messageId, emoji }) => {
      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
      if (!msg || !emoji) return;
      const existing = db
        .prepare('SELECT * FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
        .get(messageId, userId, emoji);
      if (existing) {
        db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(
          messageId,
          userId,
          emoji
        );
      } else {
        db.prepare('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(
          messageId,
          userId,
          emoji
        );
      }
      io.to(`channel:${msg.channel_id}`).emit('reaction:update', {
        messageId,
        emoji,
        userId,
        added: !existing,
      });
    });

    socket.on('typing:start', ({ channelId }) => {
      socket.to(`channel:${channelId}`).emit('typing:update', { channelId, userId, username: user.username, typing: true });
    });

    socket.on('typing:stop', ({ channelId }) => {
      socket.to(`channel:${channelId}`).emit('typing:update', { channelId, userId, username: user.username, typing: false });
    });

    socket.on('status:update', (status) => {
      const allowed = ['online', 'away', 'dnd', 'invisible'];
      if (!allowed.includes(status)) return;
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
      io.emit('presence:update', { userId, status });
    });

    socket.on('profile:refresh', () => {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      const payload = { userId, username: user.username, avatarColor: user.avatar_color, avatarUrl: user.avatar_url || null };
      io.to(`server:${socket.serverId}`).emit('member:updated', payload);
      const channelId = socket.voiceChannelId;
      if (channelId) {
        const entry = voiceRooms.get(channelId)?.get(userId);
        if (entry) {
          entry.username = user.username;
          entry.avatarColor = user.avatar_color;
          entry.avatarUrl = user.avatar_url || null;
          io.to(`server:${socket.serverId}`).emit('voice:room-update', { channelId, participants: voiceParticipants(channelId) });
        }
      }
    });

    function leaveVoiceChannel() {
      const channelId = socket.voiceChannelId;
      if (!channelId) return;
      const room = voiceRooms.get(channelId);
      if (room) {
        room.delete(userId);
        if (room.size === 0) voiceRooms.delete(channelId);
      }
      socket.leave(`voice:${channelId}`);
      socket.voiceChannelId = null;
      io.to(`server:${socket.serverId}`).emit('voice:user-left', { channelId, userId });
      io.to(`server:${socket.serverId}`).emit('voice:room-update', { channelId, participants: voiceParticipants(channelId) });
    }

    socket.on('voice:join', (channelId) => {
      if (!channelId) return;
      if (socket.voiceChannelId === channelId) return;
      if (socket.voiceChannelId) leaveVoiceChannel();

      if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
      const room = voiceRooms.get(channelId);
      const existingParticipants = voiceParticipants(channelId);
      room.set(userId, { username: user.username, avatarColor: user.avatar_color, avatarUrl: user.avatar_url || null, muted: false, camera: false, screenShare: false });

      socket.join(`voice:${channelId}`);
      socket.voiceChannelId = channelId;

      socket.emit('voice:participants', { channelId, participants: existingParticipants });
      socket.to(`server:${socket.serverId}`).emit('voice:user-joined', {
        channelId,
        userId,
        username: user.username,
        avatarColor: user.avatar_color,
        avatarUrl: user.avatar_url || null,
      });
      io.to(`server:${socket.serverId}`).emit('voice:room-update', { channelId, participants: voiceParticipants(channelId) });
    });

    socket.on('voice:leave', () => leaveVoiceChannel());

    socket.on('voice:state', ({ muted, camera, screenShare }) => {
      const channelId = socket.voiceChannelId;
      if (!channelId) return;
      const room = voiceRooms.get(channelId);
      const entry = room?.get(userId);
      if (!entry) return;
      if (typeof muted === 'boolean') entry.muted = muted;
      if (typeof camera === 'boolean') entry.camera = camera;
      if (typeof screenShare === 'boolean') entry.screenShare = screenShare;
      io.to(`server:${socket.serverId}`).emit('voice:state-update', { channelId, userId, muted: entry.muted, camera: entry.camera, screenShare: entry.screenShare });
    });

    socket.on('voice:signal', ({ toUserId, data }) => {
      const targetSockets = onlineUsers.get(toUserId);
      if (!targetSockets) return;
      for (const sockId of targetSockets) {
        io.to(sockId).emit('voice:signal', { fromUserId: userId, data });
      }
    });

    socket.on('disconnect', () => {
      leaveVoiceChannel();
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          io.emit('presence:update', { userId, status: 'offline' });
        }
      }
    });
  });
}

module.exports = { setupSockets };
