import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, cp, chmod } from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT, GiB } from './config.mjs';
import { openStore, audit, settings } from './database.mjs';
import { hashPassword, identity } from './security.mjs';
import { acquireLock } from './lock.mjs';

let muted = false, rl;
const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
output.isTTY = process.stdout.isTTY; output.columns = process.stdout.columns;
async function ask(prompt, secret = false) {
  rl ??= createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  if (secret) { process.stdout.write(prompt); muted = true; }
  try { return await rl.question(secret ? '' : prompt); }
  finally { if (secret) { muted = false; process.stdout.write('\n'); } }
}
async function stdinJson() {
  let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 10000) throw new Error('Input too large.'); }
  return JSON.parse(text);
}
async function credentials() {
  if (process.argv.includes('--stdin')) return stdinJson();
  const displayName = await ask('Owner display name: ');
  const username = await ask('Owner username: ');
  const email = await ask('Owner email: ');
  const password = await ask('Owner password (8+ characters, hidden): ', true);
  const confirm = await ask('Repeat password: ', true);
  if (password !== confirm) throw new Error('Passwords do not match.');
  return { displayName, username, email, password };
}

const cfg = config();
const command = process.argv[2] || 'help';
let store, releaseLock;
try {
  if (command === 'setup') {
    releaseLock = acquireLock(cfg.dataDir);
    store = openStore(cfg.dataDir);
    if (store.db.prepare("SELECT id FROM users WHERE role='owner'").get()) throw new Error('An owner already exists. Setup never creates a second owner. Use reset-password to recover access.');
    console.log('\nJTG Cloud · Create the one protected owner account\n');
    const input = await credentials(), data = identity(input), passwordHash = await hashPassword(input.password);
    const id = randomUUID();
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)').run(id,data.username,data.email,data.displayName,passwordHash,'owner',Math.max(settings(store.db).defaultQuota,50*GiB),1,Date.now());
    audit(store.db,id,'owner.setup',id,data.username);
    console.log(`\nOwner @${data.username} created. Sign in at ${cfg.appUrl}\n`);
  } else if (command === 'reset-password') {
    store = openStore(cfg.dataDir);
    const input = process.argv.includes('--stdin') ? await stdinJson() : { identifier: await ask('Account email or username: '), password: await ask('New password (8+ characters, hidden): ',true) };
    const identifier = String(input.identifier || '').trim().toLowerCase();
    const user = store.db.prepare('SELECT * FROM users WHERE username=? OR email=?').get(identifier,identifier);
    if (!user) throw new Error('Account not found.');
    const hash = await hashPassword(input.password);
    store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);
    store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    audit(store.db,null,'auth.password_reset',user.id,user.username);
    console.log('Password reset. All existing sessions for this account were revoked.');
  } else if (command === 'backup') {
    releaseLock = acquireLock(cfg.dataDir);
    store = openStore(cfg.dataDir);
    const destination = path.join(cfg.backupDir,`jtg-cloud-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
    await mkdir(destination,{recursive:true,mode:0o700});
    store.db.prepare('VACUUM INTO ?').run(path.join(destination,'cloud.sqlite'));
    await cp(path.join(cfg.dataDir,'blobs'),path.join(destination,'blobs'),{recursive:true});
    await cp(path.join(cfg.dataDir,'encryption.key'),path.join(destination,'encryption.key'));
    await chmod(path.join(destination,'encryption.key'),0o600);
    console.log(`Backup saved: ${destination}\nKeep this directory private: it contains the encryption key. Restore database, blobs and key together.`);
  } else {
    console.log('JTG Cloud server commands:\n  npm run setup                  Create the first and only owner\n  node --env-file-if-exists=.env src/cli.mjs reset-password\n  node --env-file-if-exists=.env src/cli.mjs backup  (stop PM2 first)\n\nFor automation, setup and reset-password accept JSON through stdin with --stdin. Never pass passwords in command arguments.');
  }
} catch (error) { console.error(`Error: ${error.message}`); process.exitCode = 1; }
finally { rl?.close(); store?.db.close(); releaseLock?.(); }
