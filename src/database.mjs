import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { GiB, MiB } from './config.mjs';

export function openStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const dir of ['blobs', 'tmp']) mkdirSync(path.join(dataDir, dir), { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDir, 'encryption.key');
  let key;
  try { key = readFileSync(keyPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Never silently replace a lost key for an existing database.
    try { readFileSync(path.join(dataDir, 'cloud.sqlite')); throw new Error('Missing encryption.key: restore it from your backup before starting.'); }
    catch (dbError) { if (dbError.code !== 'ENOENT') throw dbError; }
    key = randomBytes(32);
    writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('Invalid encryption key');
  const db = new DatabaseSync(path.join(dataDir, 'cloud.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
      quota INTEGER NOT NULL CHECK(quota >= 0), active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON users(role) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('file','folder')),
      size INTEGER NOT NULL DEFAULT 0, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      blob TEXT, iv TEXT, tag TEXT, starred INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS live_entry_names ON entries(user_id, COALESCE(parent_id,''),name) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS entries_user ON entries(user_id, parent_id, deleted_at);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, action TEXT NOT NULL,
      target TEXT, detail TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id TEXT, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0),
      chunk_size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','complete')),
      entry_id TEXT REFERENCES entries(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS upload_sessions_user ON upload_sessions(user_id,state);
    CREATE INDEX IF NOT EXISTS upload_sessions_expiry ON upload_sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS pending_upload_names ON upload_sessions(user_id,COALESCE(parent_id,''),name) WHERE state='pending';
    CREATE TABLE IF NOT EXISTS upload_parts (
      upload_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      part_index INTEGER NOT NULL, size INTEGER NOT NULL, blob TEXT UNIQUE NOT NULL,
      iv TEXT NOT NULL, tag TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY(upload_id,part_index)
    );
    CREATE TABLE IF NOT EXISTS file_parts (
      entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      part_index INTEGER NOT NULL, size INTEGER NOT NULL, blob TEXT UNIQUE NOT NULL,
      iv TEXT NOT NULL, tag TEXT NOT NULL, sha256 TEXT NOT NULL,
      PRIMARY KEY(entry_id,part_index)
    );
  `);
  if (!db.prepare('PRAGMA table_info(entries)').all().some(column => column.name === 'storage_format')) {
    db.exec("ALTER TABLE entries ADD COLUMN storage_format TEXT NOT NULL DEFAULT 'legacy'");
  }
  const defaults = {
    siteName: 'JTG Cloud', tagline: 'Your files. Your cloud.', registrationEnabled: true,
    defaultQuota: 5 * GiB, maxUpload: 0, uploadChunkSize: 20 * MiB, accent: '#7367f0', logo: '', favicon: ''
  };
  for (const [name, value] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(name, JSON.stringify(value));
  if (db.prepare('PRAGMA user_version').get().user_version < 2) {
    transaction(db, () => {
      db.prepare("UPDATE settings SET value='0' WHERE key='maxUpload'").run();
      db.exec('PRAGMA user_version = 2');
    });
  }
  try { chmodSync(path.join(dataDir, 'cloud.sqlite'), 0o600); chmodSync(keyPath, 0o600); } catch { /* Windows uses ACLs. */ }
  return { db, key, dataDir };
}

export function settings(db) {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row => [row.key, JSON.parse(row.value)]));
}
export function usage(db, userId) { return db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM entries WHERE user_id=? AND kind='file'").get(userId).bytes; }
export function publicUser(db, user) {
  return { id: user.id, username: user.username, email: user.email, displayName: user.display_name,
    role: user.role, quota: user.quota, active: !!user.active, used: usage(db, user.id), createdAt: user.created_at };
}
export function audit(db, actor, action, target = '', detail = '') {
  db.prepare('INSERT INTO audit(actor,action,target,detail,created_at) VALUES (?,?,?,?,?)').run(actor || null, action, target, detail.slice(0,300), Date.now());
  // Bound metadata growth while retaining the latest 10,000 events.
  db.prepare('DELETE FROM audit WHERE id <= (SELECT MAX(id)-10000 FROM audit)').run();
}
export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
