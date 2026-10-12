import { scrypt as scryptCallback, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function fail(status, message) { throw new HttpError(status, message); }
export function token() { return randomBytes(32).toString('base64url'); }
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
export function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) fail(400, 'Use a password of 8–128 characters.');
}
export async function hashPassword(password) {
  passwordCheck(password);
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const [,salt,hash] = stored.split(':');
  const actual = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function identity(input) {
  const username = String(input.username || '').trim().toLowerCase();
  const email = String(input.email || '').trim().toLowerCase();
  const displayName = String(input.displayName || username).trim();
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) fail(400, 'Username must be 3–32 letters, numbers, dots, dashes or underscores.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  if (!displayName || displayName.length > 60) fail(400, 'Display name must be 1–60 characters.');
  return { username, email, displayName };
}
export function entryName(value) {
  if (typeof value !== 'string') fail(400, 'A name is required.');
  const name = value.normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || name.length > 180 || /[\x00-\x1f\x7f/\\:]/.test(name)) fail(400, 'Invalid name. Use up to 180 characters without slashes or control characters.');
  return name;
}
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
export function cookies(header = '') {
  const result = {};
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) result[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return result;
}
export function rateLimiter() {
  const buckets = new Map();
  const cleanup = setInterval(() => { const now = Date.now(); for (const [key, value] of buckets) if (value.until < now) buckets.delete(key); }, 60000);
  cleanup.unref();
  return {
    check(key, limit = 15, window = 15 * 60000) {
      const now = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.until < now) {
        if (buckets.size >= 20000) fail(429, 'Server is busy. Try again shortly.');
        bucket = { count: 0, until: now + window }; buckets.set(key, bucket);
      }
      if (++bucket.count > limit) fail(429, 'Too many attempts. Please try again later.');
    },
    close() { clearInterval(cleanup); }
  };
}
