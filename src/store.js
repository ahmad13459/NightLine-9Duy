/**
 * NIGHTLINE · Railway Edition — persistent store
 *
 * A single JSON document (no database) written atomically to the mounted
 * volume, exactly like the Cloudflare edition keeps everything in one KV
 * record.  Railway's free plan gives 0.5 GB of volume storage, which is more
 * than enough for thousands of subscribers.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_FILE, DATA_DIR, ensureDirs } from './env.js';
import { DEFAULT_INBOUNDS } from './catalog.js';
import { ROUTING_DEFAULTS } from './routing.js';

const SCHEMA = 3;
const listeners = new Set();
let doc = null;
let saveTimer = null;
let saving = false;

export function hex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function uid(len = 10) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function defaults() {
  return {
    schema: SCHEMA,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    secrets: { server: hex(32) },
    admin: null,
    settings: {
      publicHost: '',
      tcpHost: '',
      tcpPort: 0,
      theme: 'dark',
      lang: 'fa',
      brand: 'NIGHTLINE',
      tag: 'Railway',
      subPath: 'sub',
      publicStatus: true,
      autoRestartCores: true,
      lowMemory: true,
      // Client-side TLS-hello fragment. Splitting the ClientHello into two packets
      // is the single most effective Iranian-DPI workaround and costs ~10 ms.
      fragment: true,
      // Iranian split-routing rules, on by default (src/routing.js).
      routing: { ...ROUTING_DEFAULTS },
      telegram: {
        mtproto: {
          enabled: false,
          engine: 'mtg',
          faketlsHost: 'www.microsoft.com',
          secret: '',
          listenPort: 0,
          adTag: '',
          preferIpv6: false,
        },
        socks: { enabled: false, user: 'nl', pass: hex(6) },
        http: { enabled: false, user: 'nl', pass: hex(6) },
        web: { enabled: false },
      },
      cores: {
        xray: { enabled: true },
        singbox: { enabled: true, lazy: true },
      },
    },
    users: [],
    inbounds: DEFAULT_INBOUNDS(),
    traffic: { samples: [] },
    events: [],
  };
}

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaults();
  const base = defaults();
  const out = { ...base, ...raw };
  out.schema = SCHEMA;
  out.secrets = { ...base.secrets, ...(raw.secrets || {}) };
  out.settings = {
    ...base.settings,
    ...(raw.settings || {}),
    telegram: {
      ...base.settings.telegram,
      ...((raw.settings && raw.settings.telegram) || {}),
      mtproto: { ...base.settings.telegram.mtproto, ...(((raw.settings || {}).telegram || {}).mtproto || {}) },
      socks: { ...base.settings.telegram.socks, ...(((raw.settings || {}).telegram || {}).socks || {}) },
      http: { ...base.settings.telegram.http, ...(((raw.settings || {}).telegram || {}).http || {}) },
      web: { ...base.settings.telegram.web, ...(((raw.settings || {}).telegram || {}).web || {}) },
    },
    cores: { ...base.settings.cores, ...((raw.settings || {}).cores || {}) },
    routing: { ...base.settings.routing, ...(((raw.settings || {}).routing) || {}) },
  };
  out.users = Array.isArray(raw.users) ? raw.users.map(normalizeUser) : [];
  out.inbounds = Array.isArray(raw.inbounds) && raw.inbounds.length ? raw.inbounds : DEFAULT_INBOUNDS();
  out.traffic = raw.traffic && Array.isArray(raw.traffic.samples) ? raw.traffic : base.traffic;
  out.events = Array.isArray(raw.events) ? raw.events.slice(-200) : [];
  return out;
}

export function normalizeUser(input) {
  const now = Date.now();
  const user = {
    id: input.id || uid(10),
    name: input.name || 'user',
    enabled: input.enabled !== false,
    createdAt: input.createdAt || now,
    expiresAt: input.expiresAt ?? null,
    quotaBytes: input.quotaBytes ?? null,
    ipLimit: Number(input.ipLimit ?? 0) || 0,
    note: input.note || '',
    lastSeen: input.lastSeen || 0,
    usage: { up: Number(input.usage?.up || 0), down: Number(input.usage?.down || 0) },
    secrets: {
      uuid: input.secrets?.uuid || crypto.randomUUID(),
      password: input.secrets?.password || b64url(crypto.randomBytes(12)),
      // Shadowsocks 2022 keys must be standard base64 *with* padding.
      ss128: input.secrets?.ss128 || crypto.randomBytes(16).toString('base64'),
      ss256: input.secrets?.ss256 || crypto.randomBytes(32).toString('base64'),
    },
    disabledReason: input.disabledReason || '',
  };
  return user;
}

export function load() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    doc = migrate(JSON.parse(raw));
  } catch {
    doc = defaults();
    writeNow();
  }
  return doc;
}

export function get() {
  return doc || load();
}

export function set(mutator) {
  const d = get();
  const result = mutator(d);
  d.updatedAt = Date.now();
  scheduleSave();
  emit();
  return result;
}

function emit() {
  for (const fn of listeners) {
    try { fn(doc); } catch { /* ignore */ }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function scheduleSave(delay = 120) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, delay);
}

export function writeNow() {
  if (saving) { scheduleSave(250); return; }
  saving = true;
  try {
    ensureDirs();
    const tmp = path.join(DATA_DIR, `.nightline.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[store] save failed:', err.message);
  } finally {
    saving = false;
  }
}

export function event(kind, message, meta = {}) {
  const d = get();
  d.events.push({ t: Date.now(), kind, message, ...meta });
  if (d.events.length > 200) d.events = d.events.slice(-200);
  scheduleSave();
  emit();
}

/* ── traffic helpers ────────────────────────────────────────────────── */

export function userTotal(user) {
  return (user.usage?.up || 0) + (user.usage?.down || 0);
}

export function isExpired(user, now = Date.now()) {
  return Boolean(user.expiresAt && user.expiresAt <= now);
}

export function isQuotaExhausted(user) {
  return Boolean(user.quotaBytes && userTotal(user) >= user.quotaBytes);
}

export function effectiveEnabled(user, now = Date.now()) {
  if (!user.enabled) return false;
  if (isExpired(user, now)) return false;
  if (isQuotaExhausted(user)) return false;
  return true;
}

export function addTrafficSample(point) {
  const d = get();
  const samples = d.traffic.samples;
  samples.push(point);
  if (samples.length > 180) d.traffic.samples = samples.slice(-180);
  scheduleSave(2000);
}

export function publicBase(settings, fallbackHost = '') {
  const host = (settings.publicHost || fallbackHost || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return host ? `https://${host}` : '';
}

export function exportBackup() {
  return JSON.stringify({ exportedAt: new Date().toISOString(), doc: get() }, null, 2);
}

export function importBackup(text) {
  const parsed = JSON.parse(text);
  const incoming = parsed.doc || parsed;
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.users)) {
    throw new Error('invalid backup file');
  }
  doc = migrate(incoming);
  writeNow();
  emit();
  return doc;
}
