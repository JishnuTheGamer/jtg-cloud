import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
export function config(overrides = {}) {
  const production = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 6969);
  const appUrl = process.env.APP_URL || `http://localhost:${port}`;
  const result = {
    port, host: process.env.HOST || '0.0.0.0', production,
    appUrl: new URL(appUrl).origin,
    secureCookie: false,
    explicitAppUrl: !!process.env.APP_URL || Object.hasOwn(overrides, 'appUrl'),
    trustProxy: process.env.TRUST_PROXY === 'true',
    dataDir: path.resolve(ROOT, process.env.DATA_DIR || 'data'),
    backupDir: path.resolve(ROOT, process.env.BACKUP_DIR || 'backups'),
    registrationDomain: (process.env.REGISTRATION_DOMAIN || '').trim().toLowerCase(),
    ...overrides
  };
  const parsed = new URL(result.appUrl);
  if (!['http:','https:'].includes(parsed.protocol)) throw new Error('APP_URL must use HTTP or HTTPS.');
  result.appUrl = parsed.origin;
  if (!Object.hasOwn(overrides, 'secureCookie')) result.secureCookie = process.env.COOKIE_SECURE === 'true' || (process.env.COOKIE_SECURE !== 'false' && parsed.protocol === 'https:');
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error('Invalid PORT');
  return result;
}

export function serviceUrls(port = 6969, host = '0.0.0.0') {
  const urls = new Set([`http://localhost:${port}`]);
  if (host === '0.0.0.0') {
    for (const addresses of Object.values(networkInterfaces())) for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) urls.add(`http://${address.address}:${port}`);
    }
  } else if (host !== '127.0.0.1') urls.add(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  return [...urls];
}
