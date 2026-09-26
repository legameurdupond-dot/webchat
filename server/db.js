const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new DatabaseSync(path.join(dataDir, 'webchat.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'online',
    bio TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    reply_to_id TEXT,
    edited_at INTEGER,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
`);

for (const col of ['avatar_url TEXT', 'banner_url TEXT']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* column already exists */ }
}

// Seed a default server/channels on first run
const serverCount = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c;
if (serverCount === 0) {
  const serverId = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO servers (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
    .run(serverId, 'Accueil', 'system', now);
  db.prepare('INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), serverId, 'general', 'text', 0);
  db.prepare('INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), serverId, 'off-topic', 'text', 1);
  db.prepare('INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), serverId, 'Général', 'voice', 0);
}

module.exports = db;
