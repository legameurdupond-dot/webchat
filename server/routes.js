const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const multer = require('multer');
const db = require('./db');
const { signToken, authenticate, pickAvatarColor } = require('./auth');

const router = express.Router();

const uploadsDir = path.join(__dirname, '..', 'uploads');
for (const sub of ['avatars', 'banners']) {
  const dir = path.join(uploadsDir, sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function makeUploader(subdir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(uploadsDir, subdir)),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, crypto.randomUUID() + ext);
    },
  });
  return multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)),
  });
}
const uploadAvatar = makeUploader('avatars');
const uploadBanner = makeUploader('banners');

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url || null,
    bannerUrl: u.banner_url || null,
    status: u.status,
    bio: u.bio,
  };
}

function publicProfile(u) {
  return { ...publicUser(u), createdAt: u.created_at };
}

router.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Pseudo (3+) et mot de passe (6+) requis' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Ce pseudo est déjà pris' });

  const id = crypto.randomUUID();
  const passwordHash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  db.prepare(
    'INSERT INTO users (id, username, password_hash, avatar_color, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, username, passwordHash, pickAvatarColor(username), 'online', now);

  const server = db.prepare('SELECT id FROM servers ORDER BY created_at LIMIT 1').get();
  if (server) {
    db.prepare('INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)').run(server.id, id, now);
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(publicUser(user));
});

router.put('/me', authenticate, (req, res) => {
  const { status, bio, avatarUrl, bannerUrl } = req.body || {};
  const allowedStatus = ['online', 'away', 'dnd', 'invisible'];
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const newStatus = allowedStatus.includes(status) ? status : user.status;
  const newBio = typeof bio === 'string' ? bio.slice(0, 200) : user.bio;
  const newAvatar = avatarUrl === null ? null : typeof avatarUrl === 'string' ? avatarUrl.slice(0, 1000) : user.avatar_url;
  const newBanner = bannerUrl === null ? null : typeof bannerUrl === 'string' ? bannerUrl.slice(0, 1000) : user.banner_url;

  db.prepare('UPDATE users SET status = ?, bio = ?, avatar_url = ?, banner_url = ? WHERE id = ?')
    .run(newStatus, newBio, newAvatar, newBanner, req.user.id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

router.post('/me/avatar', authenticate, uploadAvatar.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image invalide' });
  res.json({ url: `/uploads/avatars/${req.file.filename}` });
});

router.post('/me/banner', authenticate, uploadBanner.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image invalide' });
  res.json({ url: `/uploads/banners/${req.file.filename}` });
});

router.get('/giphy/search', authenticate, async (req, res) => {
  const q = (req.query.q || '').toString().slice(0, 100);
  const limit = Math.min(Number(req.query.limit) || 24, 48);
  const key = process.env.GIPHY_API_KEY || 'dc6zaby0qak7ky';
  const endpoint = q
    ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=${limit}&rating=pg-13`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=${limit}&rating=pg-13`;
  try {
    const apiRes = await fetch(endpoint);
    const data = await apiRes.json();
    if (data.meta && data.meta.status !== 200) {
      return res.status(502).json({ error: 'Clé API Giphy invalide ou manquante (voir .env GIPHY_API_KEY)' });
    }
    const results = (data.data || []).map((g) => ({
      id: g.id,
      preview: g.images.fixed_width_small?.url || g.images.fixed_width.url,
      full: g.images.original.url,
    }));
    res.json(results);
  } catch {
    res.status(502).json({ error: 'Giphy indisponible' });
  }
});

router.get('/users/:id', authenticate, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json(publicProfile(user));
});

router.get('/ice-servers', authenticate, async (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  } else if (process.env.METERED_APP_NAME && process.env.METERED_API_KEY) {
    try {
      const r = await fetch(
        `https://${process.env.METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`
      );
      const meteredServers = await r.json();
      if (Array.isArray(meteredServers)) iceServers.push(...meteredServers);
    } catch { /* fall back to STUN only */ }
  } else if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }

  res.json(iceServers);
});

router.get('/servers', authenticate, (req, res) => {
  const servers = db
    .prepare(
      `SELECT s.* FROM servers s
       JOIN server_members m ON m.server_id = s.id
       WHERE m.user_id = ? ORDER BY s.created_at`
    )
    .all(req.user.id);
  res.json(servers);
});

router.get('/servers/:id/channels', authenticate, (req, res) => {
  const channels = db
    .prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY type, position')
    .all(req.params.id);
  res.json(channels);
});

router.get('/servers/:id/members', authenticate, (req, res) => {
  const members = db
    .prepare(
      `SELECT u.id, u.username, u.avatar_color, u.avatar_url, u.status FROM users u
       JOIN server_members m ON m.user_id = u.id
       WHERE m.server_id = ?`
    )
    .all(req.params.id);
  res.json(members.map((m) => ({ id: m.id, username: m.username, avatarColor: m.avatar_color, avatarUrl: m.avatar_url || null, status: m.status })));
});

router.get('/channels/:id/messages', authenticate, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = Number(req.query.before) || Date.now() + 1;
  const rows = db
    .prepare(
      `SELECT m.*, u.username, u.avatar_color, u.avatar_url FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.channel_id = ? AND m.created_at < ? AND m.deleted = 0
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(req.params.id, before, limit);

  const ids = rows.map((r) => r.id);
  const reactions = ids.length
    ? db
        .prepare(`SELECT * FROM reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids)
    : [];

  const withReactions = rows.reverse().map((m) => ({
    id: m.id,
    channelId: m.channel_id,
    content: m.content,
    replyToId: m.reply_to_id,
    editedAt: m.edited_at,
    createdAt: m.created_at,
    author: { id: m.user_id, username: m.username, avatarColor: m.avatar_color, avatarUrl: m.avatar_url || null },
    reactions: reactions.filter((r) => r.message_id === m.id).map((r) => ({ emoji: r.emoji, userId: r.user_id })),
  }));

  res.json(withReactions);
});

module.exports = router;
