import http from 'node:http';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, unlink, readdir, statfs } from 'node:fs/promises';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { config, ROOT, GiB, MiB } from './config.mjs';
import { openStore, settings, usage, publicUser, audit, transaction } from './database.mjs';
import { fail, HttpError, token, digest, hashPassword, verifyPassword, identity, entryName, integer, cookies, rateLimiter } from './security.mjs';
import { acquireLock } from './lock.mjs';

const SESSION = 'jtg_session';
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/mark.svg': ['mark.svg', 'image/svg+xml'] };
const imageType = bytes => {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())) return 'image/gif';
  if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') return 'image/webp';
  return null;
};
function brandingImage(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 1400000) fail(400, 'Brand image must be smaller than 1 MB.');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match || imageType(Buffer.from(match[2], 'base64')) !== match[1]) fail(400, 'Use a PNG, JPEG or WebP image. SVG and HTML are not accepted.');
  return value;
}
async function body(req, max = 32768) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Expected application/json.');
  let total = 0; const chunks = [];
  for await (const chunk of req) { total += chunk.length; if (total > max) fail(413, 'Request is too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { fail(400, 'Invalid JSON request.'); }
}
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function sqlError(error) {
  if (String(error.message).includes('UNIQUE constraint failed')) return new HttpError(409, 'That name, username or email already exists.');
  return error;
}

export async function createApp(overrides = {}) {
  const cfg = config(overrides);
  const releaseLock = acquireLock(cfg.dataDir);
  let store;
  try { store = openStore(cfg.dataDir); }
  catch (error) { releaseLock(); throw error; }
  const { db, key, dataDir } = store;
  const limiter = rateLimiter();
  const uploads = new Map();
  let reservedDisk = 0;
  const dummyPassword = await hashPassword(randomBytes(24).toString('hex'));
  // Clean interrupted uploads and unreferenced encrypted blobs after a restart.
  for (const name of await readdir(path.join(dataDir, 'tmp'))) if (/^[a-f0-9-]{36}$/.test(name)) await unlink(path.join(dataDir, 'tmp', name)).catch(() => {});
  const known = new Set(db.prepare('SELECT blob FROM entries WHERE blob IS NOT NULL').all().map(e => e.blob));
  for (const name of await readdir(path.join(dataDir, 'blobs'))) if (/^[a-f0-9-]{36}$/.test(name) && !known.has(name)) await unlink(path.join(dataDir, 'blobs', name)).catch(() => {});

  function current(req) {
    const raw = cookies(req.headers.cookie)[SESSION];
    if (!raw || raw.length > 100) fail(401, 'Please sign in to continue.');
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(digest(raw), Date.now());
    const user = session && db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user_id);
    if (!user) fail(401, 'Your session has expired. Please sign in.');
    return { user, session };
  }
  function csrf(req, session) { if (req.headers['x-csrf-token'] !== session.csrf) fail(403, 'Security token is missing or expired. Refresh the page.'); }
  function owner(user) { if (user.role !== 'owner') fail(403, 'Only the owner can change these settings.'); }
  function staff(user) { if (!['admin','owner'].includes(user.role)) fail(403, 'Administrator access required.'); }
  function manageable(user, target) {
    staff(user);
    if (!target) fail(404, 'Account not found.');
    if (target.role === 'owner' || (user.role === 'admin' && target.role !== 'member')) fail(403, 'You cannot manage this account.');
    if (uploads.has(target.id)) fail(409, 'This account has an upload in progress. Try again shortly.');
  }
  function entry(userId, id, deleted = false) {
    const result = db.prepare('SELECT * FROM entries WHERE id=? AND user_id=?').get(id, userId);
    if (!result || (!!result.deleted_at !== deleted)) fail(404, 'File or folder not found.');
    return result;
  }
  function parent(userId, id) {
    if (id === null || id === undefined || id === '') return null;
    if (typeof id !== 'string') fail(400, 'Invalid folder.');
    const folder = entry(userId, id);
    if (folder.kind !== 'folder') fail(400, 'Choose a folder.');
    return folder.id;
  }
  function subtree(userId, id) {
    return db.prepare(`WITH RECURSIVE tree AS (SELECT * FROM entries WHERE id=? AND user_id=? UNION ALL SELECT e.* FROM entries e JOIN tree t ON e.parent_id=t.id WHERE e.user_id=?) SELECT * FROM tree`).all(id, userId, userId);
  }
  function breadcrumbs(userId, id) {
    const result = []; let cursor = id;
    while (cursor) { if (result.length >= 64) fail(400, 'Folder nesting limit reached.'); const folder = entry(userId, cursor); result.unshift({ id: folder.id, name: folder.name }); cursor = folder.parent_id; }
    return result;
  }
  function cookie(res, value, seconds) {
    res.setHeader('Set-Cookie', `${SESSION}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${cfg.secureCookie ? '; Secure' : ''}`);
  }
  function signIn(res, user, remember = false) {
    const raw = token(), csrfToken = token(); const seconds = remember ? 7 * 86400 : 12 * 3600;
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(digest(raw), user.id, csrfToken, Date.now() + seconds * 1000, Date.now());
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10)').run(user.id, user.id);
    cookie(res, raw, seconds);
    return { user: publicUser(db, user), csrf: csrfToken };
  }
  async function removeRows(rows) {
    const ids = new Set(rows.map(e => e.id));
    transaction(db, () => { for (const row of rows) if (!row.parent_id || !ids.has(row.parent_id)) db.prepare('DELETE FROM entries WHERE id=?').run(row.id); });
    for (const row of rows) if (row.blob) await unlink(path.join(dataDir, 'blobs', row.blob)).catch(error => { if (error.code !== 'ENOENT') console.error('Blob cleanup failed:', error.code); });
  }
  function entryView(e) { return { id: e.id, parentId: e.parent_id, name: e.name, kind: e.kind, size: e.size, mime: e.mime, starred: !!e.starred, deletedAt: e.deleted_at, createdAt: e.created_at, updatedAt: e.updated_at }; }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const url = new URL(req.url, cfg.appUrl), route = url.pathname, method = req.method;
    const ip = cfg.trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
    if (route.startsWith('/api/')) limiter.check(`api:${ip}`, 1200, 60000);
    if (!['GET','HEAD','OPTIONS'].includes(method)) {
      if (req.headers.origin && req.headers.origin !== cfg.appUrl) fail(403, 'Cross-origin requests are not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
    }
    if (route === '/api/health' && method === 'GET') return json(res, 200, { status: 'ok', version: '1.0.0' });
    if (route === '/api/config' && method === 'GET') {
      const s = settings(db);
      return json(res, 200, { siteName: s.siteName, tagline: s.tagline, logo: s.logo, favicon: s.favicon, accent: s.accent, registrationEnabled: s.registrationEnabled, defaultQuota: s.defaultQuota, googleEnabled: false, setupRequired: !db.prepare("SELECT id FROM users WHERE role='owner'").get() });
    }
    if ((route === '/api/auth/login' || route === '/api/auth/register') && method === 'POST') {
      limiter.check(`auth:${ip}`, 20);
      const input = await body(req);
      if (route.endsWith('login')) {
        const identifier = String(input.identifier || '').trim().toLowerCase();
        limiter.check(`login:${digest(identifier)}`, 30);
        const user = identifier.length <= 254 && db.prepare('SELECT * FROM users WHERE email=? OR username=?').get(identifier, identifier);
        const valid = await verifyPassword(input.password, user ? user.password_hash : dummyPassword);
        if (!valid || !user || !user.active) fail(401, 'Email / username or password is incorrect.');
        audit(db, user.id, 'auth.login', user.id);
        return json(res, 200, signIn(res, user, input.remember === true));
      }
      limiter.check(`register:${ip}`, 5, 3600000);
      if (!db.prepare("SELECT id FROM users WHERE role='owner'").get()) fail(503, 'The owner must finish server setup first.');
      if (!settings(db).registrationEnabled) fail(403, 'Registration is closed. Contact the cloud owner.');
      const data = identity(input);
      if (cfg.registrationDomain && data.email.split('@')[1] !== cfg.registrationDomain) fail(400, `Registration is restricted to @${cfg.registrationDomain}.`);
      const passwordHash = await hashPassword(input.password);
      // Recheck after hashing so a concurrent settings update cannot bypass closure.
      const user = transaction(db, () => {
        const s = settings(db); if (!s.registrationEnabled) fail(403, 'Registration is closed.');
        const id = randomUUID();
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id, data.username, data.email, data.displayName, passwordHash, 'member', s.defaultQuota, 1, Date.now());
        return db.prepare('SELECT * FROM users WHERE id=?').get(id);
      });
      audit(db, user.id, 'user.register', user.id);
      return json(res, 201, signIn(res, user));
    }
    if (route.startsWith('/api/')) {
      const { user, session } = current(req);
      if (!['GET','HEAD'].includes(method)) csrf(req, session);
      if (route === '/api/me' && method === 'GET') return json(res, 200, { user: publicUser(db, user), csrf: session.csrf, maxUpload: settings(db).maxUpload });
      if (route === '/api/auth/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.token_hash); cookie(res, '', 0); return json(res, 200, { ok: true });
      }
      if (route === '/api/account' && method === 'PATCH') {
        const input = await body(req);
        if (!await verifyPassword(input.currentPassword, user.password_hash)) fail(403, 'Current password is incorrect.');
        const passwordHash = await hashPassword(input.newPassword);
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
        audit(db, user.id, 'auth.password_changed', user.id);
        cookie(res, '', 0); return json(res, 200, { ok: true });
      }
      if (route === '/api/entries' && method === 'GET') {
        const view = url.searchParams.get('view') || 'files', search = (url.searchParams.get('q') || '').trim().slice(0,180);
        const parentId = view === 'files' && !search ? parent(user.id, url.searchParams.get('parent')) : null;
        let filter = 'user_id=?', params = [user.id];
        if (view === 'trash') filter += ' AND deleted_at IS NOT NULL AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM entries WHERE user_id=? AND deleted_at IS NOT NULL))', params.push(user.id);
        else { filter += ' AND deleted_at IS NULL'; if (view === 'starred') filter += ' AND starred=1'; if (view === 'photos') filter += " AND mime LIKE 'image/%' AND kind='file'"; }
        if (view === 'files' && !search) { filter += ' AND parent_id IS ?'; params.push(parentId); }
        if (search) { filter += ' AND instr(lower(name),lower(?))>0'; params.push(search); }
        const rows = db.prepare(`SELECT * FROM entries WHERE ${filter} ORDER BY kind DESC,updated_at DESC LIMIT 2000`).all(...params);
        return json(res, 200, { entries: rows.map(entryView), breadcrumbs: breadcrumbs(user.id, parentId), user: publicUser(db, user), total: db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE ${filter}`).get(...params).count });
      }
      if (route === '/api/folders' && method === 'POST') {
        const input = await body(req), name = entryName(input.name), parentId = parent(user.id, input.parentId);
        if (breadcrumbs(user.id, parentId).length >= 64) fail(400, 'Folder nesting limit reached.');
        const id = randomUUID(), now = Date.now();
        db.prepare("INSERT INTO entries(id,user_id,parent_id,name,kind,created_at,updated_at) VALUES (?,?,?,?,'folder',?,?)").run(id, user.id, parentId, name, now, now);
        audit(db, user.id, 'folder.create', id, name);
        return json(res, 201, { entry: entryView(entry(user.id, id)) });
      }
      if (route === '/api/upload' && method === 'POST') {
        if (uploads.has(user.id)) fail(409, 'Another upload is in progress for your account.');
        const parentId = parent(user.id, url.searchParams.get('parent'));
        let name; try { name = entryName(decodeURIComponent(String(req.headers['x-file-name'] || ''))); } catch (error) { if (error instanceof HttpError) throw error; fail(400, 'Invalid filename.'); }
        if (db.prepare('SELECT id FROM entries WHERE user_id=? AND parent_id IS ? AND name=? AND deleted_at IS NULL').get(user.id, parentId, name)) fail(409, 'A file with that name already exists. Rename it first.');
        const freshUser = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
        const available = freshUser.quota - usage(db, user.id);
        const max = Math.min(settings(db).maxUpload, available);
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 0) fail(411, 'A valid Content-Length is required for uploads.');
        if (length > max) fail(413, available < length ? 'Not enough storage. Empty trash or ask an administrator for more space.' : 'This file exceeds the upload limit.');
        const space = await statfs(dataDir); if (space.bavail * space.bsize - reservedDisk < length + 64 * MiB) fail(507, 'The server is running low on disk space.');
        // Recheck the lock after statfs awaits; two requests must not reserve the same quota.
        if (uploads.has(user.id)) fail(409, 'Another upload is in progress for your account.');
        uploads.set(user.id, true); reservedDisk += length;
        const id = randomUUID(), temp = path.join(dataDir, 'tmp', id), destination = path.join(dataDir, 'blobs', id);
        let size = 0, header = Buffer.alloc(0), committed = false;
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        const counter = new Transform({ transform(chunk, encoding, callback) {
          size += chunk.length;
          if (header.length < 16) header = Buffer.concat([header, chunk.subarray(0, 16-header.length)]);
          callback(size > max || size > length ? new HttpError(413, 'Upload exceeded its allowed size.') : null, chunk);
        } });
        try {
          await pipeline(req, counter, cipher, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
          if (size !== length) fail(400, 'Upload was interrupted.');
          await rename(temp, destination);
          transaction(db, () => {
            parent(user.id, parentId);
            const updated = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(user.id);
            if (!updated || size + usage(db, user.id) > updated.quota) fail(413, 'Storage quota changed. Please retry.');
            const now = Date.now();
            db.prepare("INSERT INTO entries(id,user_id,parent_id,name,kind,size,mime,blob,iv,tag,created_at,updated_at) VALUES (?,?,?,?,'file',?,?,?,?,?,?,?)").run(id, user.id, parentId, name, size, imageType(header) || 'application/octet-stream', id, iv.toString('hex'), cipher.getAuthTag().toString('hex'), now, now);
          });
          committed = true; audit(db, user.id, 'file.upload', id, name);
          return json(res, 201, { entry: entryView(entry(user.id, id)), user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(user.id)) });
        } finally {
          uploads.delete(user.id); reservedDisk -= length;
          await unlink(temp).catch(() => {});
          if (!committed) await unlink(destination).catch(() => {});
        }
      }
      const match = /^\/api\/entries\/([a-f0-9-]{36})(?:\/(download|restore|purge))?$/.exec(route);
      if (match) {
        const [, id, action] = match;
        const e = entry(user.id, id, ['restore','purge'].includes(action));
        if (action === 'download' && method === 'GET') {
          if (e.kind !== 'file') fail(400, 'Open the folder to download its files.');
          const inline = url.searchParams.get('preview') === '1' && e.mime.startsWith('image/');
          res.setHeader('Content-Type', inline ? e.mime : 'application/octet-stream');
          res.setHeader('Content-Length', e.size);
          res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(e.name).replace(/'/g,'%27')}`);
          const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex')); decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
          await pipeline(createReadStream(path.join(dataDir, 'blobs', e.blob)), decipher, res);
          return;
        }
        if (!action && method === 'PATCH') {
          const input = await body(req); let name = e.name, parentId = e.parent_id, starred = e.starred;
          if ('name' in input) name = entryName(input.name);
          if ('starred' in input) { if (typeof input.starred !== 'boolean') fail(400, 'Invalid starred value.'); starred = input.starred ? 1 : 0; }
          if ('parentId' in input) {
            parentId = parent(user.id, input.parentId);
            const parents = breadcrumbs(user.id, parentId);
            if (parents.some(p => p.id === e.id)) fail(400, 'A folder cannot be moved inside itself.');
            if (e.kind === 'folder') {
              const descendants = subtree(user.id, id);
              const depths = new Map([[id,1]]);
              for (const row of descendants) if (row.id !== id) depths.set(row.id, (depths.get(row.parent_id) || 1)+1);
              if (parents.length + Math.max(...depths.values()) > 64) fail(400, 'Folder nesting limit reached.');
            }
          }
          db.prepare('UPDATE entries SET name=?,parent_id=?,starred=?,updated_at=? WHERE id=?').run(name, parentId, starred, Date.now(), id);
          audit(db, user.id, 'entry.update', id, name);
          return json(res, 200, { entry: entryView(entry(user.id, id)) });
        }
        if (!action && method === 'DELETE') {
          // A distinct per-account deletion timestamp identifies one restore group.
          const now = Math.max(Date.now(), db.prepare('SELECT COALESCE(MAX(deleted_at),0)+1 AS next FROM entries WHERE user_id=?').get(user.id).next);
          transaction(db, () => { for (const row of subtree(user.id, id)) if (!row.deleted_at) db.prepare('UPDATE entries SET deleted_at=?,updated_at=? WHERE id=?').run(now, now, row.id); });
          audit(db, user.id, 'entry.trash', id, e.name);
          return json(res, 200, { ok: true });
        }
        if (action === 'restore' && method === 'POST') {
          const p = e.parent_id && db.prepare('SELECT id FROM entries WHERE id=? AND user_id=? AND deleted_at IS NULL').get(e.parent_id, user.id);
          transaction(db, () => {
            db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run(p?.id || null, id);
            for (const row of subtree(user.id, id)) if (row.deleted_at === e.deleted_at) db.prepare('UPDATE entries SET deleted_at=NULL,updated_at=? WHERE id=?').run(Date.now(), row.id);
          });
          audit(db, user.id, 'entry.restore', id, e.name); return json(res, 200, { ok: true });
        }
        if (action === 'purge' && method === 'DELETE') {
          await removeRows(subtree(user.id, id)); audit(db, user.id, 'entry.purge', id, e.name); return json(res, 200, { ok: true });
        }
      }
      if (route === '/api/trash' && method === 'DELETE') {
        const rows = db.prepare('SELECT * FROM entries WHERE user_id=? AND deleted_at IS NOT NULL').all(user.id);
        await removeRows(rows); audit(db, user.id, 'trash.empty', user.id); return json(res, 200, { ok: true });
      }
      if (route === '/api/admin/overview' && method === 'GET') {
        staff(user);
        const disk = await statfs(dataDir);
        return json(res, 200, { users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
          files: db.prepare("SELECT COUNT(*) AS count FROM entries WHERE kind='file'").get().count,
          used: db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM entries').get().bytes,
          diskFree: disk.bavail * disk.bsize, diskTotal: disk.blocks * disk.bsize,
          settings: settings(db), version: '1.0.0', port: cfg.port });
      }
      if (route === '/api/admin/users' && method === 'GET') {
        staff(user); return json(res, 200, { users: db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 2000').all().map(u => publicUser(db, u)) });
      }
      if (route === '/api/admin/users' && method === 'POST') {
        staff(user); const input = await body(req), data = identity(input);
        const role = input.role || 'member';
        if (!['admin','member'].includes(role) || (user.role === 'admin' && role !== 'member')) fail(403, 'Only the owner can create administrators.');
        const quota = integer(input.quota ?? settings(db).defaultQuota, 0, 100000 * GiB, 'Storage quota');
        const passwordHash = await hashPassword(input.password);
        const activeUser = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(user.id);
        staff(activeUser || {}); if (role === 'admin') owner(activeUser);
        const id = randomUUID();
        db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id, data.username, data.email, data.displayName, passwordHash, role, quota, 1, Date.now());
        audit(db, user.id, 'user.create', id, `${data.username} (${role})`);
        return json(res, 201, { user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
      }
      const userMatch = /^\/api\/admin\/users\/([a-f0-9-]{36})$/.exec(route);
      if (userMatch) {
        const target = db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);
        if (target?.role === 'owner' && user.role === 'owner' && method === 'PATCH') {
          const input = await body(req);
          if (Object.keys(input).some(k => k !== 'quota') || !('quota' in input)) fail(403, 'The owner role and account status are protected.');
          const quota = integer(input.quota, 0, 100000 * GiB, 'Quota');
          if (quota < usage(db,target.id)) fail(400, 'Quota cannot be lower than current usage.');
          if (uploads.has(target.id)) fail(409, 'Finish the current upload before changing storage.');
          db.prepare('UPDATE users SET quota=? WHERE id=?').run(quota,target.id);
          audit(db,user.id,'user.quota',target.id,'Owner storage allowance updated');
          return json(res,200,{user:publicUser(db,db.prepare('SELECT * FROM users WHERE id=?').get(target.id))});
        }
        manageable(user, target);
        if (method === 'PATCH') {
          const input = await body(req);
          // Recheck mutable roles after parsing the request body.
          manageable(db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(user.id) || {}, db.prepare('SELECT * FROM users WHERE id=?').get(target.id));
          const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(target.id);
          let role = fresh.role, quota = fresh.quota, active = fresh.active;
          if ('role' in input) { owner(user); if (!['admin','member'].includes(input.role)) fail(400, 'Role must be admin or member.'); role = input.role; }
          if ('quota' in input) { quota = integer(input.quota, 0, 100000 * GiB, 'Quota'); if (quota < usage(db, target.id)) fail(400, 'Quota cannot be lower than current usage, including trash.'); }
          if ('active' in input) { if (typeof input.active !== 'boolean') fail(400, 'Invalid account status.'); active = input.active ? 1 : 0; }
          db.prepare('UPDATE users SET role=?,quota=?,active=? WHERE id=?').run(role, quota, active, target.id);
          if (role !== fresh.role || !active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
          audit(db, user.id, 'user.update', target.id, `${fresh.username}: ${role}, active=${active}`);
          return json(res, 200, { user: publicUser(db, db.prepare('SELECT * FROM users WHERE id=?').get(target.id)) });
        }
        if (method === 'DELETE') {
          const rows = db.prepare('SELECT * FROM entries WHERE user_id=?').all(target.id);
          db.prepare('DELETE FROM users WHERE id=?').run(target.id);
          for (const row of rows) if (row.blob) await unlink(path.join(dataDir, 'blobs', row.blob)).catch(() => {});
          audit(db, user.id, 'user.delete', target.id, target.username); return json(res, 200, { ok: true });
        }
      }
      if (route === '/api/admin/settings' && method === 'PATCH') {
        owner(user); const input = await body(req, 2900000), update = {};
        owner(db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(user.id) || {});
        if ('siteName' in input) { if (typeof input.siteName !== 'string' || !input.siteName.trim() || input.siteName.length > 40) fail(400, 'Site name must be 1–40 characters.'); update.siteName = input.siteName.trim(); }
        if ('tagline' in input) { if (typeof input.tagline !== 'string' || input.tagline.length > 100) fail(400, 'Tagline is too long.'); update.tagline = input.tagline.trim(); }
        if ('registrationEnabled' in input) { if (typeof input.registrationEnabled !== 'boolean') fail(400, 'Invalid registration setting.'); update.registrationEnabled = input.registrationEnabled; }
        if ('defaultQuota' in input) update.defaultQuota = integer(input.defaultQuota, 0, 100000 * GiB, 'Default quota');
        if ('maxUpload' in input) update.maxUpload = integer(input.maxUpload, MiB, 10 * GiB, 'Upload limit');
        if ('accent' in input) { if (!/^#[0-9a-f]{6}$/i.test(input.accent)) fail(400, 'Invalid accent color.'); update.accent = input.accent; }
        if ('logo' in input) update.logo = brandingImage(input.logo);
        if ('favicon' in input) update.favicon = brandingImage(input.favicon);
        transaction(db, () => { for (const [name,value] of Object.entries(update)) db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(value), name); });
        audit(db, user.id, 'settings.update', 'site', Object.keys(update).join(', '));
        return json(res, 200, { settings: settings(db) });
      }
      if (route === '/api/admin/audit' && method === 'GET') {
        owner(user); return json(res, 200, { events: db.prepare('SELECT a.*,u.username FROM audit a LEFT JOIN users u ON a.actor=u.id ORDER BY a.id DESC LIMIT 200').all() });
      }
      fail(404, 'Endpoint not found.');
    }
    if (['GET','HEAD'].includes(method) && STATIC[route]) {
      const [filename,type] = STATIC[route]; res.setHeader('Content-Type', type);
      const bytes = await readFile(path.join(ROOT,'public',filename)); res.setHeader('Content-Length', bytes.length); res.end(method === 'HEAD' ? undefined : bytes); return;
    }
    fail(404, 'Not found.');
  }
  const server = http.createServer((req,res) => {
    handle(req,res).catch(original => {
      const error = sqlError(original);
      if (!res.headersSent && !res.destroyed) json(res, error.status || 500, { error: error.status ? error.message : 'An unexpected server error occurred.' });
      else if (!res.destroyed) res.destroy();
      if (!error.status) console.error('Request failed:', error.message);
      // Drain rejected request bodies without buffering them.
      if (!req.destroyed) req.resume();
    });
  });
  server.requestTimeout = 30 * 60000; server.headersTimeout = 30000; server.keepAliveTimeout = 5000;
  const cleanup = setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now()), 3600000); cleanup.unref();
  return { server, db, cfg, async close() { clearInterval(cleanup); limiter.close(); await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); db.close(); releaseLock(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.server.listen(app.cfg.port, app.cfg.host, () => console.log(`JTG Cloud is running at ${app.cfg.appUrl} (listening on ${app.cfg.host}:${app.cfg.port})`));
  app.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  let stopping = false;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {
    if (stopping) return; stopping = true;
    const forced = setTimeout(() => process.exit(1), 10000); forced.unref();
    await app.close(); process.exit(0);
  });
}
