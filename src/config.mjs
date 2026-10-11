import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
export function config(overrides = {}) {
  const production = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 6696);
  const appUrl = process.env.APP_URL || `http://localhost:${port}`;
  const result = {
    port, host: process.env.HOST || '127.0.0.1', production,
    appUrl: new URL(appUrl).origin,
    secureCookie: process.env.COOKIE_SECURE === 'true' || production,
    trustProxy: process.env.TRUST_PROXY === 'true',
    dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
    backupDir: path.resolve(ROOT, process.env.BACKUP_DIR || 'backups'),
    registrationDomain: (process.env.REGISTRATION_DOMAIN || '').trim().toLowerCase(),
    ...overrides
  };
  if (result.production && !result.appUrl.startsWith('https://')) throw new Error('Production requires an HTTPS APP_URL. Configure a TLS reverse proxy first.');
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('Invalid PORT');
  return result;
}
