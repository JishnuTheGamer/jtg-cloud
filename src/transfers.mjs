import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { open, rename, unlink, readdir, statfs } from 'node:fs/promises';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MiB } from './config.mjs';
import { settings, usage, transaction } from './database.mjs';
import { fail, HttpError, integer, entryName } from './security.mjs';

const TTL = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9-]{36}$/;
const CLIENT_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const aad = (userId, id, index, size) => Buffer.from(`JTG Cloud part v1:${userId}:${id}:${index}:${size}`);

export function reservedUploads(db, userId) {
  return db.prepare("SELECT COALESCE(SUM(size),0) AS bytes FROM upload_sessions WHERE user_id=? AND state='pending'").get(userId).bytes;
}
export function reservedName(db, userId, parentId, name, except = '') {
  return db.prepare("SELECT id FROM upload_sessions WHERE user_id=? AND parent_id IS ? AND name=? AND state='pending' AND id<>?").get(userId, parentId, name, except);
}
export function entryBlobs(db, rows) {
  return rows.flatMap(row => row.storage_format === 'chunked'
    ? db.prepare('SELECT blob FROM file_parts WHERE entry_id=?').all(row.id).map(part => part.blob)
    : row.blob ? [row.blob] : []);
}
export async function deleteBlobs(dataDir, names) {
  for (const name of names) {
    if (!UUID.test(name)) continue;
    await unlink(path.join(dataDir, 'blobs', name)).catch(error => {
      if (error.code !== 'ENOENT') console.error('Encrypted blob cleanup failed:', error.code);
    });
  }
}

export function createTransfers({ db, key, dataDir, activeUploads, parent, imageType, legacyReservation }) {
  let diskEpoch = 0;
  const diskChanged = () => { diskEpoch++; };
  function get(userId, id) {
    const upload = db.prepare('SELECT * FROM upload_sessions WHERE id=? AND user_id=?').get(id, userId);
    if (!upload) fail(404, 'Upload session not found.');
    if (upload.expires_at <= Date.now()) fail(410, 'This upload expired. Select the file again to start a new upload.');
    return upload;
  }
  function view(upload) {
    const parts = db.prepare('SELECT part_index,size FROM upload_parts WHERE upload_id=? ORDER BY part_index').all(upload.id);
    const uploadedBytes = upload.state === 'complete' ? upload.size : parts.reduce((sum, part) => sum + part.size, 0);
    return { id: upload.id, name: upload.name, parentId: upload.parent_id, size: upload.size,
      chunkSize: upload.chunk_size, uploadedBytes, nextIndex: upload.state === 'complete' ? Math.ceil(upload.size / upload.chunk_size) : parts.length,
      totalChunks: Math.ceil(upload.size / upload.chunk_size), expiresAt: upload.expires_at, state: upload.state };
  }
  function validatePending(upload) {
    if (upload.state !== 'pending') fail(409, 'This upload is already complete.');
    const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(upload.user_id);
    if (!user) fail(401, 'This account is no longer active.');
    parent(upload.user_id, upload.parent_id);
    if (usage(db, upload.user_id) + reservedUploads(db, upload.user_id) > user.quota) fail(413, 'Storage quota changed. Cancel this upload and try again.');
    return user;
  }
  function remainingDisk() {
    return db.prepare("SELECT COALESCE(SUM(u.size - COALESCE((SELECT SUM(p.size) FROM upload_parts p WHERE p.upload_id=u.id),0)),0) AS bytes FROM upload_sessions u WHERE u.state='pending'").get().bytes;
  }
  async function reserveDisk(additionalBytes, reserve = () => {}, replay = () => null) {
    // A filesystem snapshot must not be combined with reservations released by
    // a chunk that finished after that snapshot. Retry if accounting changed,
    // then commit the new reservation synchronously before another request runs.
    for (;;) {
      const epoch = diskEpoch,space = await statfs(dataDir);
      if (epoch !== diskEpoch) continue;
      const previous = replay();
      if (previous) return previous;
      if (space.bavail * space.bsize - remainingDisk() - legacyReservation() < additionalBytes + 64 * MiB) fail(507,'The server is running low on disk space.');
      return reserve();
    }
  }
  async function removeSessions(ids) {
    const blobs = [];
    transaction(db, () => {
      for (const id of ids) {
        blobs.push(...db.prepare('SELECT blob FROM upload_parts WHERE upload_id=?').all(id).map(part => part.blob));
        db.prepare('DELETE FROM upload_sessions WHERE id=?').run(id);
      }
    });
    if (ids.length) diskChanged();
    await deleteBlobs(dataDir, blobs);
  }
  async function cleanup() {
    const expired = db.prepare(`SELECT u.id,u.user_id FROM upload_sessions u LEFT JOIN users a ON a.id=u.user_id
      WHERE u.expires_at<=? OR (u.state='pending' AND (a.id IS NULL OR a.active=0 OR
      (u.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.id=u.parent_id AND e.user_id=u.user_id AND e.kind='folder' AND e.deleted_at IS NULL))))`).all(Date.now());
    await removeSessions(expired.filter(upload => !activeUploads.has(upload.user_id)).map(upload => upload.id));
  }
  async function initialize() {
    await cleanup();
    // Part blobs are immutable and committed references survive restarts and offline backups.
    for (const name of await readdir(path.join(dataDir, 'tmp'))) if (UUID.test(name)) await unlink(path.join(dataDir, 'tmp', name)).catch(() => {});
    const known = new Set(db.prepare(`SELECT blob FROM entries WHERE blob IS NOT NULL
      UNION SELECT blob FROM upload_parts UNION SELECT blob FROM file_parts`).all().map(row => row.blob));
    for (const name of await readdir(path.join(dataDir, 'blobs'))) if (UUID.test(name) && !known.has(name)) await unlink(path.join(dataDir, 'blobs', name)).catch(() => {});
    // A backup made after an interrupted write contains only committed encrypted parts.
    for (const upload of db.prepare("SELECT * FROM upload_sessions WHERE state='pending'").all()) {
      const parts = db.prepare('SELECT * FROM upload_parts WHERE upload_id=? ORDER BY part_index').all(upload.id);
      let valid = true;
      for (const [index, part] of parts.entries()) {
        if (part.part_index !== index || part.size !== Math.min(upload.chunk_size, upload.size - index * upload.chunk_size)) { valid = false; break; }
        try { const handle = await open(path.join(dataDir, 'blobs', part.blob)); try { if ((await handle.stat()).size !== part.size) valid = false; } finally { await handle.close(); } }
        catch { valid = false; }
        if (!valid) break;
      }
      if (!valid) await removeSessions([upload.id]);
    }
  }
  async function create(userId, input) {
    await cleanup();
    const name = entryName(input.name),parentId = input.parentId === undefined || input.parentId === '' ? null : input.parentId;
    if (parentId !== null && typeof parentId !== 'string') fail(400,'Invalid folder.');
    const size = integer(input.size,0,Number.MAX_SAFE_INTEGER,'File size');
    if ('clientId' in input && (typeof input.clientId !== 'string' || !CLIENT_UUID.test(input.clientId))) fail(400,'The upload client ID must be a UUID.');
    const id = input.clientId ? input.clientId.toLowerCase() : randomUUID();
    function replay() {
      const upload = db.prepare('SELECT * FROM upload_sessions WHERE id=?').get(id);
      if (upload) {
        if (upload.user_id !== userId) fail(404,'Upload session not found.');
        if (upload.name !== name || upload.parent_id !== parentId || upload.size !== size) fail(409,'This upload ID was already used for a different file.');
        return { upload:view(get(userId,id)),replay:true };
      }
      const existing = db.prepare('SELECT user_id FROM entries WHERE id=?').get(id);
      if (existing) fail(existing.user_id === userId ? 409 : 404,'This upload ID is unavailable. Start a new upload.');
      return null;
    }
    const previous = replay();
    if (previous) return previous;
    if (activeUploads.has(userId)) fail(409, 'Another upload is in progress for your account.');
    parent(userId,parentId);
    if (settings(db).maxUpload > 0 && size > settings(db).maxUpload) fail(413,'This file exceeds the upload limit.');
    return reserveDisk(size,() => transaction(db, () => {
      const previous = replay();
      if (previous) return previous;
      if (activeUploads.has(userId)) fail(409, 'Another upload is in progress for your account.');
      const user = db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(userId);
      if (!user) fail(401, 'This account is no longer active.');
      parent(userId, parentId);
      if (settings(db).maxUpload > 0 && size > settings(db).maxUpload) fail(413, 'This file exceeds the upload limit.');
      if (db.prepare('SELECT COUNT(*) AS count FROM upload_sessions WHERE user_id=? AND state=?').get(userId, 'pending').count >= 20) fail(429, 'Finish or cancel an existing upload before starting another.');
      if (reservedName(db, userId, parentId, name) || db.prepare('SELECT id FROM entries WHERE user_id=? AND parent_id IS ? AND name=? AND deleted_at IS NULL').get(userId, parentId, name)) fail(409, 'A file or upload with that name already exists.');
      if (usage(db, userId) + reservedUploads(db, userId) + size > user.quota) fail(413, 'Not enough storage. Cancel paused uploads, empty trash or ask an administrator for more space.');
      const now = Date.now();
      db.prepare('INSERT INTO upload_sessions(id,user_id,parent_id,name,size,chunk_size,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(id,userId,parentId,name,size,settings(db).uploadChunkSize,now,now+TTL);
      diskChanged();
      return { upload:view(get(userId,id)),replay:false };
    }),replay);
  }
  async function put(userId, id, index, req) {
    const initial = get(userId, id);
    validatePending(initial);
    const totalChunks = Math.ceil(initial.size / initial.chunk_size);
    integer(index, 0, Math.max(0, totalChunks - 1), 'Chunk index');
    if (!totalChunks) fail(400, 'An empty file has no chunks. Complete the upload directly.');
    const expected = Math.min(initial.chunk_size, initial.size - index * initial.chunk_size);
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 0) fail(411, 'A valid Content-Length is required for upload chunks.');
    if (length !== expected) fail(400, 'The chunk length does not match this upload.');
    if (activeUploads.has(userId)) fail(409, 'Another upload request is in progress for your account.');
    // Lock before any asynchronous filesystem operation, including replay verification.
    activeUploads.set(userId, id);
    const blob = randomUUID(), temp = path.join(dataDir,'tmp',blob), destination = path.join(dataDir,'blobs',blob);
    let committed = false, size = 0, header = Buffer.alloc(0);
    const hash = createHash('sha256');
    const counter = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      if (header.length < 16) header = Buffer.concat([header,chunk.subarray(0,16-header.length)]);
      hash.update(chunk);
      callback(size > expected ? new HttpError(413,'Upload chunk exceeded its expected size.') : null, chunk);
    } });
    try {
      const upload = get(userId,id), parts = db.prepare('SELECT * FROM upload_parts WHERE upload_id=? ORDER BY part_index').all(id);
      if (index > parts.length) fail(409, 'Upload chunks in order. Refresh upload progress and try again.');
      const previous = parts[index];
      if (previous) {
        await pipeline(req,counter,new Writable({ write(chunk,encoding,callback) { callback(); } }));
        if (size !== expected) fail(400,'Upload chunk was interrupted.');
        if (hash.digest('hex') !== previous.sha256) fail(409,'The retried chunk differs from the original file. Cancel this upload and select the correct file.');
        validatePending(get(userId,id));
        db.prepare('UPDATE upload_sessions SET expires_at=? WHERE id=?').run(Date.now()+TTL,id);
        return view(get(userId,id));
      }
      await reserveDisk(0);
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(aad(userId,id,index,expected));
      await pipeline(req,counter,cipher,createWriteStream(temp,{ flags:'wx',mode:0o600 }));
      if (size !== expected) fail(400,'Upload chunk was interrupted.');
      await rename(temp,destination);
      transaction(db, () => {
        const fresh = get(userId,id); validatePending(fresh);
        db.prepare('INSERT INTO upload_parts VALUES (?,?,?,?,?,?,?)').run(id,index,size,blob,iv.toString('hex'),cipher.getAuthTag().toString('hex'),hash.digest('hex'));
        db.prepare('UPDATE upload_sessions SET expires_at=?,mime=? WHERE id=?').run(Date.now()+TTL,index === 0 ? imageType(header) || 'application/octet-stream' : fresh.mime,id);
      });
      diskChanged();
      committed = true;
      return view(get(userId,id));
    } finally {
      await unlink(temp).catch(() => {});
      if (!committed) await unlink(destination).catch(() => {});
      activeUploads.delete(userId);
    }
  }
  function complete(userId,id) {
    if (activeUploads.has(userId)) fail(409,'An upload request is still in progress. Try again shortly.');
    return transaction(db, () => {
      const upload = get(userId,id);
      if (upload.state === 'complete') {
        const entry = upload.entry_id && db.prepare('SELECT * FROM entries WHERE id=? AND user_id=?').get(upload.entry_id,userId);
        if (!entry) fail(410,'This completed file was permanently deleted.');
        return { entry, replay:true };
      }
      validatePending(upload);
      const parts = db.prepare('SELECT * FROM upload_parts WHERE upload_id=? ORDER BY part_index').all(id);
      if (parts.length !== Math.ceil(upload.size / upload.chunk_size) || parts.reduce((sum,part) => sum+part.size,0) !== upload.size) fail(409,'Some chunks are still missing. Resume the upload before completing it.');
      const now = Date.now();
      db.prepare("INSERT INTO entries(id,user_id,parent_id,name,kind,size,mime,created_at,updated_at,storage_format) VALUES (?,?,?,?,'file',?,?,?,?,'chunked')").run(id,userId,upload.parent_id,upload.name,upload.size,upload.mime,now,now);
      db.prepare('INSERT INTO file_parts SELECT upload_id,part_index,size,blob,iv,tag,sha256 FROM upload_parts WHERE upload_id=?').run(id);
      db.prepare('DELETE FROM upload_parts WHERE upload_id=?').run(id);
      db.prepare("UPDATE upload_sessions SET state='complete',entry_id=?,expires_at=? WHERE id=?").run(id,now+TTL,id);
      return { entry:db.prepare('SELECT * FROM entries WHERE id=?').get(id),replay:false };
    });
  }
  async function cancel(userId,id) {
    const upload = get(userId,id);
    if (upload.state !== 'pending') fail(409,'The file is already complete. Delete it from your files instead.');
    if (activeUploads.has(userId)) fail(409,'This upload request is still stopping. Try cancellation again shortly.');
    await removeSessions([id]);
  }
  async function cancelUser(userId, mutate = () => {}) {
    if (activeUploads.has(userId)) fail(409,'This account has an upload in progress. Try again shortly.');
    const blobs = db.prepare('SELECT p.blob FROM upload_parts p JOIN upload_sessions u ON u.id=p.upload_id WHERE u.user_id=?').all(userId).map(part => part.blob);
    transaction(db, () => {
      db.prepare('DELETE FROM upload_sessions WHERE user_id=?').run(userId);
      // Account suspension/deletion happens before filesystem awaits, preventing
      // a new upload from racing the removal of that account's reservations.
      mutate();
    });
    diskChanged();
    await deleteBlobs(dataDir,blobs);
  }
  function protectsFolders(userId,ids) {
    if (!ids.length) return;
    const folders = new Set(ids);
    if (db.prepare("SELECT parent_id FROM upload_sessions WHERE user_id=? AND state='pending'").all(userId).some(upload => folders.has(upload.parent_id))) fail(409,'This folder contains a paused upload. Finish or cancel it before deleting the folder.');
  }
  return { initialize,cleanup,create,put,complete,cancel,cancelUser,protectsFolders,get:(userId,id) => view(get(userId,id)),remainingDisk,reserveDisk,diskChanged };
}

export function downloadRange(rangeHeader, size) {
  if (!rangeHeader) return { start:0,end:size-1,status:200,length:size };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match || !size || (!match[1] && !match[2])) fail(416,'This byte range is not available.');
  let start,end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) fail(416,'This byte range is not available.');
    start = Math.max(0,size-suffix); end = size-1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size-1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) fail(416,'This byte range is not available.');
    end = Math.min(end,size-1);
  }
  return { start,end,status:206,length:end-start+1 };
}

// Authenticate each immutable encrypted blob before yielding any plaintext from it.
// A second streaming pass keeps memory bounded even for legacy whole-file ciphertext.
async function* authenticatedBytes(filename,key,iv,tag,additionalData,size,start,end,signal) {
  const file = await open(filename,'r');
  function decryptor() {
    const decrypt = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));
    if (additionalData) decrypt.setAAD(additionalData);
    decrypt.setAuthTag(Buffer.from(tag,'hex')); return decrypt;
  }
  try {
    if ((await file.stat()).size !== size) throw new Error('Encrypted blob size does not match its metadata.');
    await pipeline(file.createReadStream({ start:0,autoClose:false }),decryptor(),new Writable({ write(chunk,encoding,callback) { callback(); } }),{ signal });
    if (end < start) return;
    const source = file.createReadStream({ start:0,autoClose:false }),decrypt = decryptor();
    const done = pipeline(source,decrypt,{ signal }); done.catch(() => {});
    let offset = 0;
    try {
      for await (const chunk of decrypt) {
        const from = Math.max(0,start-offset),to = Math.min(chunk.length,end-offset+1);
        if (to > from) yield chunk.subarray(from,to);
        offset += chunk.length;
      }
      await done;
    } finally { source.destroy(); decrypt.destroy(); await done.catch(() => {}); }
  } finally { await file.close(); }
}
export async function* downloadBytes(db,dataDir,key,entry,range,signal) {
  if (entry.storage_format !== 'chunked') {
    yield* authenticatedBytes(path.join(dataDir,'blobs',entry.blob),key,entry.iv,entry.tag,null,entry.size,range.start,range.end,signal);
    return;
  }
  const parts = db.prepare('SELECT * FROM file_parts WHERE entry_id=? ORDER BY part_index').all(entry.id);
  if (parts.reduce((sum,part) => sum+part.size,0) !== entry.size || parts.some((part,index) => part.part_index !== index)) throw new Error('Encrypted file parts are incomplete.');
  let offset = 0;
  for (const part of parts) {
    const start = Math.max(0,range.start-offset),end = Math.min(part.size-1,range.end-offset);
    if (end >= start) yield* authenticatedBytes(path.join(dataDir,'blobs',part.blob),key,part.iv,part.tag,aad(entry.user_id,entry.id,part.part_index,part.size),part.size,start,end,signal);
    offset += part.size;
  }
}
