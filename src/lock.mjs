import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export function acquireLock(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'instance.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(filename, 'wx', 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd);
      return () => { try { if (readFileSync(filename, 'utf8') === String(process.pid)) unlinkSync(filename); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(filename, 'utf8'));
      let running = true;
      try { if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid server lock; inspect it manually.'); process.kill(pid,0); }
      catch (failure) { if (failure.code === 'ESRCH') running = false; else throw failure; }
      if (running) throw new Error('JTG Cloud is running or a backup is in progress. Stop it before starting another instance or making a backup.');
      unlinkSync(filename);
    }
  }
  throw new Error('Unable to acquire server lock.');
}
