import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/server.mjs';
import { MiB, ROOT } from '../src/config.mjs';

const memberPassword = 'A private transfer passphrase!';
const fixture = size => {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 37 + Math.floor(index / 251)) % 256;
  return bytes;
};

test('chunked uploads preserve bytes, reservations, isolation and resumable downloads', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'jtg-cloud-transfer-'));
  const dataDir = path.join(temp, 'data');
  const backups = path.join(temp, 'backups');
  let app, base;
  const cli = command => spawnSync(process.execPath, ['src/cli.mjs', command, '--stdin'], {
    cwd: ROOT, encoding: 'utf8',
    input: JSON.stringify({ username: 'transferowner', email: 'transferowner@example.com', displayName: 'Transfer Owner', password: memberPassword }),
    env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backups, NODE_ENV: 'development', APP_URL: 'http://localhost:6969' }
  });
  const start = async directory => {
    app = await createApp({ dataDir: directory, port: 0, production: false, secureCookie: false, appUrl: 'http://127.0.0.1' });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    app.cfg.appUrl = base;
  };
  const request = async (route, { actor, method = 'GET', data, bytes, headers = {} } = {}) => {
    const outgoing = {};
    if (actor) { outgoing.Cookie = actor.cookie; if (!['GET', 'HEAD'].includes(method)) outgoing['X-CSRF-Token'] = actor.csrf; }
    if (data !== undefined) outgoing['Content-Type'] = 'application/json';
    Object.assign(outgoing, headers);
    const response = await fetch(base + route, { method, headers: outgoing, body: bytes ?? (data === undefined ? undefined : JSON.stringify(data)) });
    const content = await response.arrayBuffer();
    const value = method !== 'HEAD' && response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(Buffer.from(content).toString()) : Buffer.from(content);
    return { status: response.status, value, headers: response.headers };
  };
  const rawChunkedRequest = (route, actor, bytes) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, { method: 'PUT', headers: { Cookie: actor.cookie, 'X-CSRF-Token': actor.csrf, 'Transfer-Encoding': 'chunked' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    outgoing.on('error', reject); outgoing.end(bytes);
  });
  const authenticate = async (identifier, register = false) => {
    const response = await request(register ? '/api/auth/register' : '/api/auth/login', { method: 'POST', data: register
      ? { username: identifier, email: `${identifier}@example.com`, password: memberPassword }
      : { identifier, password: memberPassword } });
    assert.equal(response.status, register ? 201 : 200, JSON.stringify(response.value));
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: response.value.csrf, user: response.value.user };
  };
  const begin = async (actor, name, size, parentId = null) => {
    const response = await request('/api/uploads', { actor, method: 'POST', data: { name, size, parentId, mime: 'application/octet-stream' } });
    assert.equal(response.status, 201, JSON.stringify(response.value));
    return response.value.upload;
  };
  const send = (actor, upload, index, bytes, headers = {}) => request(`/api/uploads/${upload.id}/chunks/${index}`, { actor, method: 'PUT', bytes, headers });
  const complete = (actor, upload) => request(`/api/uploads/${upload.id}/complete`, { actor, method: 'POST', data: {} });
  const cancel = (actor, upload) => request(`/api/uploads/${upload.id}`, { actor, method: 'DELETE' });
  const uploadAll = async (actor, name, bytes, parentId = null) => {
    const upload = await begin(actor, name, bytes.length, parentId);
    for (let index = 0; index < upload.totalChunks; index++) {
      const sent = await send(actor, upload, index, bytes.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize));
      assert.equal(sent.status, 200, JSON.stringify(sent.value));
    }
    const result = await complete(actor, upload);
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return { entry: result.value.entry, upload };
  };
  let owner, alice, bob, admin, mainFile;
  const mainBytes = fixture(2 * MiB + 137);
  try {
    const setup = cli('setup'); assert.equal(setup.status, 0, setup.stderr);
    await start(dataDir);
    owner = await authenticate('transferowner');
    alice = await authenticate('transferalice', true);
    bob = await authenticate('transferbob', true);

    await t.test('default chunk size is 20 MiB; only owner changes bounded integer settings', async () => {
      const me = await request('/api/me', { actor: alice });
      assert.equal(me.value.uploadChunkSize, 20 * MiB);
      assert.equal(me.value.settings.uploadChunkSize, 20 * MiB);
      assert.equal((await request('/api/admin/settings', { actor: alice, method: 'PATCH', data: { uploadChunkSize: MiB } })).status, 403);
      const created = await request('/api/admin/users', { actor: owner, method: 'POST', data: { username: 'transferadmin', email: 'transferadmin@example.com', password: memberPassword, role: 'admin' } });
      assert.equal(created.status, 201); admin = await authenticate('transferadmin');
      assert.equal((await request('/api/admin/settings', { actor: admin, method: 'PATCH', data: { uploadChunkSize: MiB } })).status, 403);
      for (const invalid of [MiB - 1, 80 * MiB + 1, MiB + 0.5, '20971520', null]) {
        assert.equal((await request('/api/admin/settings', { actor: owner, method: 'PATCH', data: { uploadChunkSize: invalid } })).status, 400);
      }
      const changed = await request('/api/admin/settings', { actor: owner, method: 'PATCH', data: { uploadChunkSize: MiB } });
      assert.equal(changed.status, 200, JSON.stringify(changed.value));
      assert.equal(changed.value.settings.uploadChunkSize, MiB);
      assert.equal((await request('/api/me', { actor: bob })).value.uploadChunkSize, MiB);
    });

    await t.test('multi-request assembly is byte exact, encrypted at rest, and complete is idempotent', async () => {
      const before = (await request('/api/me', { actor: alice })).value.user.used;
      const upload = await begin(alice, 'Transfer résumé.zip', mainBytes.length);
      assert.equal(upload.chunkSize, MiB); assert.equal(upload.nextIndex, 0); assert.equal(upload.uploadedBytes, 0); assert.equal(upload.totalChunks, 3);
      assert.equal((await request('/api/entries', { actor: alice })).value.entries.length, 0);
      assert.equal((await request('/api/me', { actor: alice })).value.user.used, before);
      for (let index = 0; index < 3; index++) {
        const sent = await send(alice, upload, index, mainBytes.subarray(index * MiB, (index + 1) * MiB));
        assert.equal(sent.status, 200, JSON.stringify(sent.value));
        assert.equal(sent.value.upload.nextIndex, index + 1);
        assert.equal(sent.value.upload.uploadedBytes, Math.min((index + 1) * MiB, mainBytes.length));
      }
      const result = await complete(alice, upload);
      assert.equal(result.status, 201, JSON.stringify(result.value)); mainFile = result.value.entry;
      assert.equal(mainFile.size, mainBytes.length);
      const repeat = await complete(alice, upload);
      assert.ok([200, 201].includes(repeat.status)); assert.equal(repeat.value.entry.id, mainFile.id);
      assert.equal((await request('/api/me', { actor: alice })).value.user.used, before + mainBytes.length);
      const rows = (await request('/api/entries', { actor: alice })).value.entries;
      assert.equal(rows.filter(row => row.name === mainFile.name).length, 1);
      const downloaded = await request(`/api/entries/${mainFile.id}/download`, { actor: alice });
      assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.value, mainBytes);
      assert.match(downloaded.headers.get('content-disposition'), /filename\*=UTF-8''Transfer%20r%C3%A9sum%C3%A9.zip/);
      for (const filename of await readdir(path.join(dataDir, 'blobs'))) {
        const encrypted = await readFile(path.join(dataDir, 'blobs', filename));
        assert.ok(!encrypted.includes(mainBytes.subarray(0, 128)), 'A stored blob contains upload plaintext.');
      }
    });

    await t.test('a client upload ID makes lost acknowledgements and concurrent creation retries idempotent', async () => {
      const before = app.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS reserved FROM upload_sessions WHERE user_id=? AND state='pending'").get(alice.user.id);
      const clientId = randomUUID(), data = { clientId, name: 'lost-acknowledgement.bin', parentId: null, size: MiB + 17 };
      const created = await Promise.all([0, 1].map(() => request('/api/uploads', { actor: alice, method: 'POST', data })));
      for (const response of created) assert.ok([200, 201].includes(response.status), JSON.stringify(response.value));
      const upload = created[0].value.upload;
      assert.equal(upload.id, clientId);
      assert.equal(created[1].value.upload.id, upload.id);
      const replay = await request('/api/uploads', { actor: alice, method: 'POST', data });
      assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.value)); assert.equal(replay.value.upload.id, upload.id);
      const after = app.db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS reserved FROM upload_sessions WHERE user_id=? AND state='pending'").get(alice.user.id);
      assert.equal(after.count, before.count + 1); assert.equal(after.reserved, before.reserved + data.size);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM upload_sessions WHERE user_id=? AND name=?').get(alice.user.id, data.name).count, 1);
      for (const changed of [{ ...data, name: 'mismatched.bin' }, { ...data, size: data.size + 1 }]) {
        assert.equal((await request('/api/uploads', { actor: alice, method: 'POST', data: changed })).status, 409);
      }
      const folder = await request('/api/folders', { actor: alice, method: 'POST', data: { name: 'Client ID mismatch folder' } });
      assert.equal(folder.status, 201);
      assert.equal((await request('/api/uploads', { actor: alice, method: 'POST', data: { ...data, parentId: folder.value.entry.id } })).status, 409);
      const foreign = await request('/api/uploads', { actor: bob, method: 'POST', data });
      assert.ok([404, 409].includes(foreign.status), JSON.stringify(foreign.value)); assert.equal(foreign.value.upload, undefined);
      assert.equal((await send(alice, upload, 0, fixture(MiB))).status, 200);
      assert.equal((await request('/api/admin/settings', { actor: owner, method: 'PATCH', data: { maxUpload: MiB } })).status, 200);
      const progressedReplay = await request('/api/uploads', { actor: alice, method: 'POST', data });
      assert.ok([200, 201].includes(progressedReplay.status)); assert.equal(progressedReplay.value.upload.id, upload.id);
      assert.equal(progressedReplay.value.upload.nextIndex, 1); assert.equal(progressedReplay.value.upload.uploadedBytes, MiB);
      const canonicalReplay = await request('/api/uploads', { actor: alice, method: 'POST', data: { ...data, clientId: clientId.toUpperCase() } });
      assert.equal(canonicalReplay.status, 200); assert.equal(canonicalReplay.value.upload.id, clientId);
      assert.equal((await request('/api/admin/settings', { actor: owner, method: 'PATCH', data: { maxUpload: 512 * MiB } })).status, 200);
      assert.equal((await cancel(alice, upload)).status, 200);
      const completedData = { clientId: randomUUID(), name: 'completed-client-id.bin', size: 4 };
      const receipt = await request('/api/uploads', { actor: alice, method: 'POST', data: completedData }); assert.equal(receipt.status, 201);
      const usedBefore = (await request('/api/me', { actor: alice })).value.user.used;
      assert.equal((await send(alice, receipt.value.upload, 0, Buffer.from('once'))).status, 200);
      assert.equal((await complete(alice, receipt.value.upload)).status, 201);
      const completedReplay = await request('/api/uploads', { actor: alice, method: 'POST', data: completedData });
      assert.equal(completedReplay.status, 200); assert.equal(completedReplay.value.upload.id, completedData.clientId); assert.equal(completedReplay.value.upload.state, 'complete');
      assert.equal((await request('/api/me', { actor: alice })).value.user.used, usedBefore + 4);
      for (const invalid of ['not-a-uuid', '../unsafe', '', 23, null, {}]) {
        assert.equal((await request('/api/uploads', { actor: alice, method: 'POST', data: { clientId: invalid, name: 'invalid-client-id.bin', size: 1 } })).status, 400);
      }
    });

    await t.test('invalid, missing and out-of-order chunks cannot advance upload state', async () => {
      const upload = await begin(alice, 'rejected-parts.bin', MiB + 7);
      const initial = () => request(`/api/uploads/${upload.id}`, { actor: alice });
      assert.equal((await send(alice, upload, 1, Buffer.alloc(7))).status, 409);
      assert.equal((await send(alice, upload, 0, Buffer.alloc(MiB - 1))).status, 400);
      assert.equal((await send(alice, upload, 0, Buffer.alloc(MiB + 1))).status, 400);
      assert.equal((await rawChunkedRequest(`/api/uploads/${upload.id}/chunks/0`, alice, Buffer.alloc(MiB))).status, 411);
      assert.equal((await complete(alice, upload)).status, 409);
      assert.equal((await initial()).value.upload.uploadedBytes, 0);
      assert.equal((await initial()).value.upload.nextIndex, 0);
      const chunk = fixture(MiB);
      assert.equal((await send(alice, upload, 0, chunk)).status, 200);
      const replay = await send(alice, upload, 0, chunk);
      assert.equal(replay.status, 200, JSON.stringify(replay.value)); assert.equal(replay.value.upload.uploadedBytes, MiB);
      const changed = Buffer.from(chunk); changed[11] ^= 255;
      assert.equal((await send(alice, upload, 0, changed)).status, 409);
      assert.equal((await initial()).value.upload.nextIndex, 1);
      assert.equal((await cancel(alice, upload)).status, 200);
      assert.equal((await initial()).status, 404);
    });

    await t.test('upload sessions require authentication, CSRF and the owning account', async () => {
      assert.equal((await request('/api/uploads', { method: 'POST', data: { name: 'anonymous.bin', size: 3 } })).status, 401);
      const upload = await begin(alice, 'private-transfer.bin', 3);
      for (const actor of [bob, owner, admin]) {
        assert.equal((await request(`/api/uploads/${upload.id}`, { actor })).status, 404);
        assert.equal((await send(actor, upload, 0, Buffer.from('abc'))).status, 404);
        assert.equal((await complete(actor, upload)).status, 404);
        assert.equal((await cancel(actor, upload)).status, 404);
      }
      assert.equal((await send(alice, upload, 0, Buffer.from('abc'), { 'X-CSRF-Token': 'invalid' })).status, 403);
      assert.equal((await send(alice, upload, 0, Buffer.from('abc'), { Origin: 'https://untrusted.example' })).status, 403);
      assert.equal((await request(`/api/uploads/${upload.id}`, { actor: alice })).value.upload.nextIndex, 0);
      assert.equal((await cancel(alice, upload)).status, 200);
      for (const actor of [bob, owner, admin]) assert.equal((await request(`/api/entries/${mainFile.id}/download`, { actor, headers: { Range: 'bytes=0-10' } })).status, 404);
    });

    await t.test('a dropped chunk can be retried; simultaneous writes and account mutation stay locked', async () => {
      const upload = await begin(alice, 'interrupted-request.bin', MiB + 1);
      const pending = http.request(base + `/api/uploads/${upload.id}/chunks/0`, { method: 'PUT', headers: {
        Cookie: alice.cookie, 'X-CSRF-Token': alice.csrf, 'Content-Length': MiB
      } });
      pending.on('error', () => {});
      const closed = new Promise(resolve => pending.on('close', resolve));
      try {
        pending.write(Buffer.from('a'));
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal((await send(alice, upload, 0, fixture(MiB))).status, 409);
        assert.equal((await request(`/api/admin/users/${alice.user.id}`, { actor: owner, method: 'PATCH', data: { quota: 6 * 1024 * MiB } })).status, 409);
      } finally { pending.destroy(); await closed; }
      let result;
      for (let attempt = 0; attempt < 20; attempt++) {
        result = await send(alice, upload, 0, fixture(MiB));
        if (result.status !== 409) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(result.status, 200, JSON.stringify(result.value));
      assert.equal(result.value.upload.nextIndex, 1); assert.equal(result.value.upload.uploadedBytes, MiB);
      assert.equal((await cancel(alice, upload)).status, 200);
    });

    await t.test('quota is reserved before any chunks; cancellation releases it and protects administration', async () => {
      assert.equal((await request(`/api/admin/users/${bob.user.id}`, { actor: owner, method: 'PATCH', data: { quota: 9 } })).status, 200);
      const upload = await begin(bob, 'reserved.bin', 9);
      const second = await request('/api/uploads', { actor: bob, method: 'POST', data: { name: 'overflow.bin', size: 1 } });
      assert.ok([409, 413].includes(second.status), JSON.stringify(second.value));
      assert.ok([409, 413].includes((await request('/api/upload', { actor: bob, method: 'POST', bytes: Buffer.from('x'), headers: { 'X-File-Name': 'legacy.bin' } })).status));
      assert.equal((await request(`/api/admin/users/${bob.user.id}`, { actor: owner, method: 'PATCH', data: { quota: 1 } })).status, 400);
      assert.equal((await request('/api/me', { actor: bob })).value.user.used, 0);
      assert.equal((await cancel(bob, upload)).status, 200);
      const replacement = await uploadAll(bob, 'released.bin', Buffer.from('123456789'));
      assert.equal(replacement.entry.size, 9);
      assert.equal((await request('/api/me', { actor: bob })).value.user.used, 9);
      assert.equal((await request('/api/uploads', { actor: bob, method: 'POST', data: { name: 'too-large.bin', size: 1 } })).status, 413);
    });

    await t.test('simultaneous session creation cannot reserve the same remaining storage twice', async () => {
      assert.equal((await request(`/api/admin/users/${bob.user.id}`, { actor: owner, method: 'PATCH', data: { quota: 18 } })).status, 200);
      const attempts = await Promise.all(['parallel-one.bin', 'parallel-two.bin'].map(name => request('/api/uploads', { actor: bob, method: 'POST', data: { name, size: 9 } })));
      assert.equal(attempts.filter(response => response.status === 201).length, 1, JSON.stringify(attempts.map(response => response.value)));
      assert.equal(attempts.filter(response => [409, 413].includes(response.status)).length, 1);
      assert.equal((await cancel(bob, attempts.find(response => response.status === 201).value.upload)).status, 200);
      assert.equal((await request('/api/me', { actor: bob })).value.user.used, 9);
    });

    await t.test('deleting a paused account cancels its reservations and encrypted uploaded parts', async () => {
      const member = await authenticate('transferdelete', true);
      const upload = await begin(member, 'deleted-account.bin', MiB + 3);
      assert.equal((await send(member, upload, 0, fixture(MiB))).status, 200);
      const parts = app.db.prepare('SELECT blob FROM upload_parts WHERE upload_id=?').all(upload.id);
      assert.equal(parts.length, 1);
      assert.equal((await request(`/api/admin/users/${member.user.id}`, { actor: owner, method: 'DELETE' })).status, 200);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM upload_sessions WHERE user_id=?').get(member.user.id).count, 0);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM upload_parts WHERE upload_id=?').get(upload.id).count, 0);
      for (const part of parts) await assert.rejects(readFile(path.join(dataDir, 'blobs', part.blob)), error => error.code === 'ENOENT');
      assert.equal((await request(`/api/uploads/${upload.id}`, { actor: member })).status, 401);
    });

    await t.test('cancelling an upload and expiring it erase parts without adding used storage', async () => {
      const before = (await request('/api/me', { actor: alice })).value.user.used;
      for (const expired of [false, true]) {
        const upload = await begin(alice, expired ? 'expire.bin' : 'cancel.bin', MiB + 9);
        assert.equal((await send(alice, upload, 0, fixture(MiB))).status, 200);
        const parts = app.db.prepare('SELECT blob FROM upload_parts WHERE upload_id=?').all(upload.id);
        assert.equal(parts.length, 1);
        if (expired) {
          app.db.prepare('UPDATE upload_sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, upload.id);
          assert.equal((await request(`/api/uploads/${upload.id}`, { actor: alice })).status, 410);
          const replacement = await begin(alice, 'expiry-cleanup-trigger.bin', 0);
          assert.equal((await cancel(alice, replacement)).status, 200);
        } else assert.equal((await cancel(alice, upload)).status, 200);
        assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM upload_parts WHERE upload_id=?').get(upload.id).count, 0);
        for (const part of parts) await assert.rejects(readFile(path.join(dataDir, 'blobs', part.blob)), error => error.code === 'ENOENT');
        assert.equal((await request('/api/me', { actor: alice })).value.user.used, before);
        assert.equal((await complete(alice, upload)).status, 404);
      }
    });

    await t.test('a pending upload reserves its folder and filename against conflicting mutations', async () => {
      const folderResponse = await request('/api/folders', { actor: alice, method: 'POST', data: { name: 'Upload destination' } });
      assert.equal(folderResponse.status, 201); const folder = folderResponse.value.entry;
      const upload = await begin(alice, 'reserved-name.bin', 3, folder.id);
      assert.equal((await request(`/api/entries/${folder.id}`, { actor: alice, method: 'DELETE' })).status, 409);
      const conflict = await request('/api/folders', { actor: alice, method: 'POST', data: { name: 'reserved-name.bin', parentId: folder.id } });
      assert.equal(conflict.status, 409);
      assert.equal((await send(alice, upload, 0, Buffer.from('abc'))).status, 200);
      assert.equal((await complete(alice, upload)).status, 201);
      assert.equal((await request(`/api/entries/${folder.id}`, { actor: alice, method: 'DELETE' })).status, 200);
    });

    await t.test('an upload captures its chunk size, so changing settings does not invalidate in-flight parts', async () => {
      const upload = await begin(alice, 'stable-chunk-size.bin', MiB + 5);
      assert.equal((await request('/api/admin/settings', { actor: owner, method: 'PATCH', data: { uploadChunkSize: 2 * MiB } })).status, 200);
      assert.equal((await request(`/api/uploads/${upload.id}`, { actor: alice })).value.upload.chunkSize, MiB);
      assert.equal((await send(alice, upload, 0, Buffer.alloc(MiB, 23))).status, 200);
      assert.equal((await send(alice, upload, 1, Buffer.alloc(5, 25))).status, 200);
      assert.equal((await complete(alice, upload)).status, 201);
      assert.equal((await request('/api/admin/settings', { actor: owner, method: 'PATCH', data: { uploadChunkSize: MiB } })).status, 200);
    });

    await t.test('partial uploads resume after a process restart without repeating completed bytes', async () => {
      const bytes = fixture(MiB + 29); const upload = await begin(alice, 'resume.bin', bytes.length);
      assert.equal((await send(alice, upload, 0, bytes.subarray(0, MiB))).status, 200);
      await app.close(); app = null; await start(dataDir);
      const recovered = await request(`/api/uploads/${upload.id}`, { actor: alice });
      assert.equal(recovered.status, 200, JSON.stringify(recovered.value)); assert.equal(recovered.value.upload.uploadedBytes, MiB); assert.equal(recovered.value.upload.nextIndex, 1);
      assert.equal((await send(alice, upload, 0, bytes.subarray(0, MiB))).status, 200);
      assert.equal((await send(alice, upload, 1, bytes.subarray(MiB))).status, 200);
      const completed = await complete(alice, upload); assert.equal(completed.status, 201);
      assert.deepEqual((await request(`/api/entries/${completed.value.entry.id}/download`, { actor: alice })).value, bytes);
    });

    await t.test('restart invalidates a partial upload with a missing blob and releases all its parts', async () => {
      const before = (await request('/api/me', { actor: alice })).value.user.used;
      const upload = await begin(alice, 'missing-part.bin', 2 * MiB + 3);
      for (const index of [0, 1]) assert.equal((await send(alice, upload, index, fixture(MiB))).status, 200);
      const parts = app.db.prepare('SELECT blob FROM upload_parts WHERE upload_id=? ORDER BY part_index').all(upload.id);
      assert.equal(parts.length, 2); await rm(path.join(dataDir, 'blobs', parts[1].blob));
      await app.close(); app = null; await start(dataDir);
      assert.equal((await request(`/api/uploads/${upload.id}`, { actor: alice })).status, 404);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM upload_parts WHERE upload_id=?').get(upload.id).count, 0);
      await assert.rejects(readFile(path.join(dataDir, 'blobs', parts[0].blob)), error => error.code === 'ENOENT');
      assert.equal((await request('/api/me', { actor: alice })).value.user.used, before);
    });

    await t.test('range downloads cross chunk boundaries and support open-ended and suffix ranges', async () => {
      const route = `/api/entries/${mainFile.id}/download`;
      for (const [range, start, end] of [['bytes=0-16', 0, 16], [`bytes=${MiB - 11}-${MiB + 19}`, MiB - 11, MiB + 19], [`bytes=${mainBytes.length - 20}-`, mainBytes.length - 20, mainBytes.length - 1], ['bytes=-37', mainBytes.length - 37, mainBytes.length - 1], [`bytes=-${mainBytes.length + 99}`, 0, mainBytes.length - 1]]) {
        const result = await request(route, { actor: alice, headers: { Range: range } });
        assert.equal(result.status, 206, JSON.stringify(result.value));
        assert.equal(result.headers.get('accept-ranges'), 'bytes');
        assert.equal(result.headers.get('content-range'), `bytes ${start}-${end}/${mainBytes.length}`);
        assert.equal(Number(result.headers.get('content-length')), end - start + 1);
        assert.deepEqual(result.value, mainBytes.subarray(start, end + 1));
      }
      const full = await request(route, { actor: alice }); assert.equal(full.status, 200); assert.deepEqual(full.value, mainBytes);
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      const metadata = await request(route, { actor: alice, method: 'HEAD' });
      assert.equal(metadata.status, 200); assert.equal(Number(metadata.headers.get('content-length')), mainBytes.length); assert.equal(metadata.value.length, 0);
      const rangeMetadata = await request(route, { actor: alice, method: 'HEAD', headers: { Range: 'bytes=7-29' } });
      assert.equal(rangeMetadata.status, 206); assert.equal(rangeMetadata.headers.get('content-range'), `bytes 7-29/${mainBytes.length}`); assert.equal(rangeMetadata.value.length, 0);
      for (const range of [`bytes=${mainBytes.length}-`, 'bytes=30-20', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=abc-def', 'items=0-1']) {
        const rejected = await request(route, { actor: alice, headers: { Range: range } });
        assert.equal(rejected.status, 416, `${range}: ${JSON.stringify(rejected.value)}`);
        assert.equal(rejected.headers.get('content-range'), `bytes */${mainBytes.length}`);
      }
    });

    await t.test('empty files complete and download correctly without a fake nonempty chunk', async () => {
      const empty = await uploadAll(alice, 'empty.txt', Buffer.alloc(0));
      const download = await request(`/api/entries/${empty.entry.id}/download`, { actor: alice });
      assert.equal(download.status, 200); assert.equal(download.value.length, 0); assert.equal(download.headers.get('content-length'), '0');
      assert.equal((await request(`/api/entries/${empty.entry.id}/download`, { actor: alice, headers: { Range: 'bytes=0-' } })).status, 416);
    });

    await t.test('legacy encrypted uploads still support full, range and HEAD downloads after migration', async () => {
      const bytes = fixture(2 * MiB + 23);
      const uploaded = await request('/api/upload', { actor: alice, method: 'POST', bytes, headers: { 'X-File-Name': 'legacy-range.bin' } });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value));
      const route = `/api/entries/${uploaded.value.entry.id}/download`;
      const full = await request(route, { actor: alice }); assert.equal(full.status, 200); assert.deepEqual(full.value, bytes);
      const partial = await request(route, { actor: alice, headers: { Range: `bytes=${MiB - 7}-${MiB + 17}` } });
      assert.equal(partial.status, 206); assert.deepEqual(partial.value, bytes.subarray(MiB - 7, MiB + 18));
      const head = await request(route, { actor: alice, method: 'HEAD', headers: { Range: 'bytes=-23' } });
      assert.equal(head.status, 206); assert.equal(head.headers.get('content-range'), `bytes ${bytes.length - 23}-${bytes.length - 1}/${bytes.length}`); assert.equal(head.value.length, 0);
    });

    await t.test('a tampered encrypted part is authenticated before any requested plaintext is sent', async () => {
      const route = `/api/entries/${mainFile.id}/download`;
      const part = app.db.prepare('SELECT * FROM file_parts WHERE entry_id=? AND part_index=1').get(mainFile.id);
      assert.ok(part);
      const filename = path.join(app.cfg.dataDir, 'blobs', part.blob);
      const encrypted = await readFile(filename), damaged = Buffer.from(encrypted); damaged[0] ^= 1;
      await writeFile(filename, damaged);
      try {
        const unaffected = await request(route, { actor: alice, headers: { Range: 'bytes=0-31' } });
        assert.equal(unaffected.status, 206); assert.deepEqual(unaffected.value, mainBytes.subarray(0, 32));
        const rejected = await request(route, { actor: alice, headers: { Range: `bytes=${MiB}-${MiB + 31}` } });
        assert.equal(rejected.status, 500); assert.equal(typeof rejected.value.error, 'string');
        assert.ok(!Buffer.from(JSON.stringify(rejected.value)).includes(mainBytes.subarray(MiB, MiB + 32)));
      } finally { await writeFile(filename, encrypted); }
      assert.deepEqual((await request(route, { actor: alice })).value, mainBytes);
    });

    await t.test('offline backup restores segmented encrypted file data and keys together', async () => {
      await app.close(); app = null;
      const saved = cli('backup'); assert.equal(saved.status, 0, saved.stderr);
      const [name] = await readdir(backups); const restored = path.join(backups, name);
      assert.deepEqual(await readFile(path.join(restored, 'encryption.key')), await readFile(path.join(dataDir, 'encryption.key')));
      await start(restored);
      const download = await request(`/api/entries/${mainFile.id}/download`, { actor: alice });
      assert.equal(download.status, 200); assert.deepEqual(download.value, mainBytes);
      const ranged = await request(`/api/entries/${mainFile.id}/download`, { actor: alice, headers: { Range: `bytes=${MiB - 10}-${MiB + 10}` } });
      assert.equal(ranged.status, 206); assert.deepEqual(ranged.value, mainBytes.subarray(MiB - 10, MiB + 11));
    });
  } finally { if (app) await app.close(); await rm(temp, { recursive: true, force: true }); }
});
