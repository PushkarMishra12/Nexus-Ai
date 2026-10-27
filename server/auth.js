import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const scrypt = promisify(scryptCallback);
export const passwordHash = async (password) => {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`;
};
export const verifyPassword = async (password, stored) => {
  try {
    const [scheme, saltValue, hashValue] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashValue, 'base64url');
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltValue, 'base64url'), expected.length));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
};
export const tokenDigest = (token) => createHash('sha256').update(token).digest('hex');
export const cookieOptions = (maxAge) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
export const parseCookies = (header = '') => Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value !== undefined).map(([key, value]) => [key, decodeURIComponent(value)]));
export const DEMO_EMAIL = 'demo@nexusai.local';
export const DEMO_PASSWORD = 'NexusDemo!27';
export const newSession = (userId) => {
  const token = randomBytes(32).toString('base64url');
  const ttlHours = Number(process.env.SESSION_TTL_HOURS || 12);
  return { token, record: { id: tokenDigest(token), userId, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString() } };
};
export { randomUUID };
