// SQLite storage for accounts, sessions and village saves (node:sqlite, no dependencies).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE,
  password_hash TEXT,
  google_sub TEXT UNIQUE,
  username TEXT UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS villages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  seed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  day INTEGER NOT NULL DEFAULT 1,
  pop INTEGER NOT NULL DEFAULT 0,
  save TEXT,
  save_size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS villages_user ON villages(user_id);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  return makeQueries(db);
}

function makeQueries(db) {
  const q = (sql) => db.prepare(sql);
  const s = {
    userById: q('SELECT * FROM users WHERE id = ?'),
    userByEmail: q('SELECT * FROM users WHERE email = ?'),
    userByGoogle: q('SELECT * FROM users WHERE google_sub = ?'),
    userByUsername: q('SELECT id FROM users WHERE username = ?'),
    insertUser: q('INSERT INTO users (email, password_hash, google_sub, created_at, last_login) VALUES (?, ?, ?, ?, ?)'),
    linkGoogle: q('UPDATE users SET google_sub = ? WHERE id = ?'),
    setUsername: q('UPDATE users SET username = ? WHERE id = ?'),
    touchLogin: q('UPDATE users SET last_login = ? WHERE id = ?'),
    insertSession: q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                    WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: q('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: q('DELETE FROM sessions WHERE expires_at <= ?'),
    listVillages: q(`SELECT id, name, seed, day, pop, created_at, updated_at, save_size
                     FROM villages WHERE user_id = ? ORDER BY id`),
    countVillages: q('SELECT COUNT(*) AS n FROM villages WHERE user_id = ?'),
    village: q(`SELECT id, name, seed, day, pop, created_at, updated_at, save_size
                FROM villages WHERE id = ? AND user_id = ?`),
    villageSave: q('SELECT save FROM villages WHERE id = ? AND user_id = ?'),
    insertVillage: q('INSERT INTO villages (user_id, name, seed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    renameVillage: q('UPDATE villages SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?'),
    deleteVillage: q('DELETE FROM villages WHERE id = ? AND user_id = ?'),
    writeSave: q(`UPDATE villages SET save = ?, save_size = ?, day = ?, pop = ?, updated_at = ?
                  WHERE id = ? AND user_id = ?`),
  };
  return {
    raw: db,
    userById: (id) => s.userById.get(id),
    userByEmail: (email) => s.userByEmail.get(email),
    userByGoogle: (sub) => s.userByGoogle.get(sub),
    usernameTaken: (name) => !!s.userByUsername.get(name),
    createUser: ({ email = null, passwordHash = null, googleSub = null }) => {
      const now = Date.now();
      const r = s.insertUser.run(email, passwordHash, googleSub, now, now);
      return s.userById.get(Number(r.lastInsertRowid));
    },
    linkGoogle: (id, sub) => s.linkGoogle.run(sub, id),
    setUsername: (id, name) => s.setUsername.run(name, id),
    touchLogin: (id) => s.touchLogin.run(Date.now(), id),
    createSession: (tokenHash, userId, ttlMs) => {
      const now = Date.now();
      s.insertSession.run(tokenHash, userId, now, now + ttlMs);
    },
    sessionUser: (tokenHash) => s.sessionUser.get(tokenHash, Date.now()),
    deleteSession: (tokenHash) => s.deleteSession.run(tokenHash),
    purgeSessions: () => s.purgeSessions.run(Date.now()),
    listVillages: (userId) => s.listVillages.all(userId),
    countVillages: (userId) => s.countVillages.get(userId).n,
    village: (id, userId) => s.village.get(id, userId),
    villageSave: (id, userId) => s.villageSave.get(id, userId)?.save ?? null,
    createVillage: (userId, name, seed) => {
      const now = Date.now();
      const r = s.insertVillage.run(userId, name, seed, now, now);
      return s.village.get(Number(r.lastInsertRowid), userId);
    },
    renameVillage: (id, userId, name) => s.renameVillage.run(name, Date.now(), id, userId).changes > 0,
    deleteVillage: (id, userId) => s.deleteVillage.run(id, userId).changes > 0,
    writeSave: (id, userId, save, day, pop) => {
      const now = Date.now();
      const ok = s.writeSave.run(save, save.length, day, pop, now, id, userId).changes > 0;
      return ok ? now : null;
    },
    backup: (file) => db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`),
    close: () => db.close(),
  };
}
