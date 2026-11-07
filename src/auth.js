/**
 * Panel authentication: scrypt password hashing, signed session cookies and a
 * small brute-force brake.  No external dependencies.
 */
import crypto from 'node:crypto';

const COOKIE = 'nl_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt, hash: derived.toString('hex'), algo: 'scrypt' };
}

export function verifyPassword(password, admin) {
  if (!admin || !admin.salt || !admin.hash) return false;
  const derived = crypto.scryptSync(String(password), admin.salt, 64, { N: 16384, r: 8, p: 1 });
  const a = Buffer.from(derived.toString('hex'));
  const b = Buffer.from(admin.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function issueSession(res, secret, username) {
  const token = signToken({ u: username, iat: Date.now(), exp: Date.now() + SESSION_TTL }, secret);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}`);
  return token;
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function readSession(req, secret) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return verifyToken(v.join('='), secret);
  }
  return null;
}

/* ── brute force brake ───────────────────────────────────────────────── */

const attempts = new Map();

export function throttle(key, { max = 8, windowMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > windowMs) {
    attempts.set(key, { first: now, count: 1 });
    return { blocked: false, remaining: max - 1 };
  }
  entry.count += 1;
  if (entry.count > max) return { blocked: true, retryInMs: windowMs - (now - entry.first) };
  return { blocked: false, remaining: max - entry.count };
}

export function clearThrottle(key) {
  attempts.delete(key);
}

/** Subscription token: stable per user, verifiable, not guessable. */
export function subToken(secret, userId) {
  return crypto.createHmac('sha256', secret).update(`sub:${userId}`).digest('base64url').slice(0, 24);
}

export function verifySubToken(secret, userId, token) {
  const expect = subToken(secret, userId);
  return expect.length === token.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(token));
}
