/**
 * JSON API + subscription endpoints.
 *
 * Everything the UI needs lives behind three verbs: GET /api/state,
 * POST /api/<action>, PATCH/DELETE /api/<resource>/<id>.  Subscriptions are
 * served outside the authenticated API so clients can fetch them directly.
 */
import net from 'node:net';
import zlib from 'node:zlib';
import { analyse, applyProfile } from '../iran.js';
import { stripAnsi } from '../text.js';
import { checkUpdate, applyUpdate, pendingUpdate } from '../update.js';
import { scanner, DEFAULTS as RAILYNX_DEFAULTS, parseVlessLink } from '../railynx.js';
import { readFileSync } from 'node:fs';
import { APP, RAILWAY, IS_RAILWAY, DATA_DIR, PORT, MUX_PORT, BIN, NODE_ENV, LIMITS } from '../env.js';
import {
  get as getDoc,
  set as setDoc,
  normalizeUser,
  load,
  exportBackup,
  importBackup,
  userTotal,
  effectiveEnabled,
  isExpired,
  isQuotaExhausted,
  event,
  subscribe,
} from '../store.js';
import { PRESETS, describeInbound, presetById, FIELD_MAP } from '../catalog.js';
import { buildUserLinks } from '../links.js';
import { buildSub, headerSet, plainText } from '../subs.js';
import { routingSummary, previewRouting, ROUTING_DEFAULTS, DNS_PRESETS } from '../routing.js';
import {
  hashPassword,
  verifyPassword,
  issueSession,
  clearSession,
  readSession,
  throttle,
  clearThrottle,
  subToken,
} from '../auth.js';
import { generateSecret, telegramLinks, MTPROTO_PORT } from '../proxy/mtproto.js';

const FORMATS = new Set(['base64', 'links', 'xray', 'singbox', 'clash']);

/* ── helpers ─────────────────────────────────────────────────────────── */

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  };
  // /api/state and /api/easy-setup are tens of kilobytes; gzip makes them ~10×
  // smaller on a mobile connection.
  const acceptsGzip = /\bgzip\b/.test(res.req?.headers?.['accept-encoding'] || '');
  if (acceptsGzip && payload.length > 2048 && !base['Content-Encoding']) {
    const packed = zlib.gzipSync(payload, { level: 5 });
    res.writeHead(status, { ...base, 'Content-Encoding': 'gzip', 'Content-Length': packed.length, Vary: 'Accept-Encoding' });
    res.end(packed);
    return;
  }
  res.writeHead(status, { ...base, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = LIMITS.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`body too large (limit ${Math.round(limit / 1024)} KB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function gbToBytes(gb) {
  const n = Number(gb);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1024 ** 3);
}

function bytesToGb(bytes) {
  return bytes ? Number((bytes / 1024 ** 3).toFixed(2)) : 0;
}

function userStatus(user) {
  if (!user.enabled) return 'disabled';
  if (isExpired(user)) return 'expired';
  if (isQuotaExhausted(user)) return 'quota';
  return 'active';
}

/* ── state assembly ──────────────────────────────────────────────────── */

export function buildState(runtime, req) {
  const doc = runtime.withRuntime(getDoc());
  const facts = runtime.facts();
  const snapshot = runtime.snapshot();
  const panelHost = facts.publicHost || (req?.headers?.host || '');
  const subBase = panelHost ? `https://${panelHost}` : '';
  const tcpReady = Boolean(facts.tcpHost && facts.tcpPort);

  const inbounds = (doc.inbounds || []).map((raw) => {
    const ib = describeInbound(raw);
    if (!ib) return null;
    const reachable = ib.udp ? false : ib.edge === 'tcp' ? tcpReady : Boolean(facts.publicHost);
    return {
      id: ib.id,
      presetId: ib.presetId,
      label: ib.label,
      enabled: ib.enabled,
      core: ib.core,
      protocol: ib.protocol,
      transport: ib.transport,
      security: ib.security,
      edge: ib.edge,
      udp: Boolean(ib.udp),
      featured: Boolean(ib.featured),
      port: ib.port,
      routeKey: ib.routeKey,
      params: ib.params,
      title: ib.title,
      desc: ib.desc,
      note: ib.note || null,
      presetDesc: presetById(ib.presetId)?.desc || null,
      fields: (presetById(ib.presetId)?.fields || []).map((key) => FIELD_MAP[key]).filter(Boolean),
      reachable,
      reason: ib.udp
        ? { fa: 'ریلوی UDP عمومی ارائه نمی‌دهد', en: 'Railway offers no public UDP' }
        : ib.edge === 'tcp' && !tcpReady
          ? { fa: 'پروکسی TCP ریلوی را فعال کنید', en: 'Enable the Railway TCP proxy' }
          : ib.edge === 'http' && !facts.publicHost
            ? { fa: 'دامنهٔ عمومی ریلوی تنظیم نشده', en: 'Railway public domain missing' }
            : null,
    };
  }).filter(Boolean);

  const users = (doc.users || []).map((user) => {
    const links = buildUserLinks(doc, user);
    return {
      id: user.id,
      name: user.name,
      enabled: user.enabled,
      status: userStatus(user),
      disabledReason: user.disabledReason || '',
      note: user.note,
      ipLimit: user.ipLimit,
      createdAt: user.createdAt,
      expiresAt: user.expiresAt,
      quotaBytes: user.quotaBytes,
      quotaGb: bytesToGb(user.quotaBytes),
      usage: { up: user.usage.up, down: user.usage.down, total: userTotal(user) },
      usageGb: bytesToGb(userTotal(user)),
      lastSeen: user.lastSeen,
      links,
      subToken: subToken(doc.secrets.server, user.id),
      subUrl: subBase ? `${subBase}/sub/${subToken(doc.secrets.server, user.id)}` : '',
      portalUrl: subBase ? `${subBase}/u/${subToken(doc.secrets.server, user.id)}` : '',
    };
  });

  const tg = doc.settings.telegram;
  const mtLinks = tg.mtproto.secret && tcpReady
    ? telegramLinks({ host: facts.tcpHost, port: facts.tcpPort, secret: tg.mtproto.secret })
    : { app: '', web: '' };
  const socksLink = tcpReady
    ? `https://t.me/socks?server=${facts.tcpHost}&port=${facts.tcpPort}&user=${encodeURIComponent(tg.socks.user)}&pass=${encodeURIComponent(tg.socks.pass)}`
    : '';
  const httpLink = tcpReady
    ? `http://${encodeURIComponent(tg.http.user)}:${encodeURIComponent(tg.http.pass)}@${facts.tcpHost}:${facts.tcpPort}`
    : '';

  return {
    app: {
      brand: doc.settings.brand || APP.brand,
      tag: doc.settings.tag || APP.tag,
      version: APP.version,
      repo: APP.repo,
      telegram: APP.telegram,
      now: Date.now(),
      env: NODE_ENV,
    },
    facts: {
      publicHost: facts.publicHost,
      tcpHost: facts.tcpHost,
      tcpPort: facts.tcpPort,
      muxPort: MUX_PORT,
      panelUrl: facts.publicHost ? `https://${facts.publicHost}` : '',
      isRailway: IS_RAILWAY,
      region: RAILWAY.region,
      serviceName: RAILWAY.serviceName,
      projectName: RAILWAY.projectName,
      volume: RAILWAY.volumePath || DATA_DIR,
      dataDir: DATA_DIR,
      tcpReady,
      port: PORT,
      bins: {
        xray: BIN.xray,
        singbox: BIN.singbox,
        mtg: BIN.mtg,
      },
    },
    settings: {
      ...doc.settings,
      telegram: {
        mtproto: { ...tg.mtproto, secretHost: tg.mtproto.secret ? '' : '' },
        socks: tg.socks,
        http: tg.http,
        web: tg.web,
      },
    },
    inbounds,
    presets: PRESETS.map((p) => ({
      id: p.id,
      core: p.core,
      protocol: p.protocol,
      transport: p.transport,
      security: p.security,
      edge: p.edge,
      udp: Boolean(p.udp),
      featured: Boolean(p.featured),
      note: p.note || null,
      title: p.title,
      desc: p.desc,
      defaults: p.defaults,
      fields: (p.fields || []).map((key) => FIELD_MAP[key]).filter(Boolean),
    })),
    users,
    cores: {
      xray: snapshot.xray,
      singbox: snapshot.singbox,
      mtproto: snapshot.mtproto,
      mux: snapshot.mux,
      socks5: snapshot.socks5,
      http: snapshot.http,
      sys: snapshot.sys,
      bootedAt: snapshot.bootedAt,
    },
    telegram: {
      mtproto: {
        ...tg.mtproto,
        port: facts.tcpPort || MTPROTO_PORT,
        links: mtLinks,
        state: snapshot.mtproto,
        conflict: (snapshot.plan.conflicts || []).includes(String(tg.mtproto.faketlsHost || '').toLowerCase()),
      },
      socks: { ...tg.socks, port: facts.tcpPort, link: socksLink },
      http: { ...tg.http, port: facts.tcpPort, link: httpLink },
      web: { ...tg.web },
    },
    plan: snapshot.plan,
    traffic: doc.traffic.samples.slice(-96),
    events: doc.events.slice(-40).reverse(),
    limits: { maxUsers: LIMITS.maxUsers, statsIntervalMs: LIMITS.statsIntervalMs },
    setup: { needsSetup: !doc.admin },
  };
}

export function buildBootstrap(runtime, req) {
  const doc = getDoc();
  const facts = runtime.facts();
  const session = doc.admin ? readSession(req, doc.secrets.server) : null;
  return {
    app: {
      brand: doc.settings.brand || APP.brand,
      tag: doc.settings.tag || APP.tag,
      version: APP.version,
      repo: APP.repo,
      telegram: APP.telegram,
      env: NODE_ENV,
      now: Date.now(),
    },
    needsSetup: !doc.admin,
    loggedIn: Boolean(session),
    username: session?.u || '',
    facts: {
      publicHost: facts.publicHost,
      tcpHost: facts.tcpHost,
      tcpPort: facts.tcpPort,
      isRailway: IS_RAILWAY,
      region: RAILWAY.region,
      panelUrl: facts.publicHost ? `https://${facts.publicHost}` : '',
      tcpReady: Boolean(facts.tcpHost && facts.tcpPort),
      dataDir: DATA_DIR,
    },
    settings: { theme: doc.settings.theme, lang: doc.settings.lang },
  };
}

/* ── in-panel update job (survives until the process restarts) ────────── */
let UPDATE_JOB = { state: 'idle', startedAt: 0, logs: [], report: null, error: '' };

/* ── main router ─────────────────────────────────────────────────────── */

export async function handleApi(ctx) {
  const { req, res, url, runtime } = ctx;
  const doc = getDoc();
  const path = url.pathname;

  /* subscriptions & public portal (no session required) */
  if (path.startsWith('/sub/') || path.startsWith('/u/')) {
    return handleSubscription({ req, res, url, runtime });
  }

  const route = `${req.method} ${path}`;

  if (route === 'GET /api/bootstrap') {
    return send(res, 200, buildBootstrap(runtime, req));
  }

  if (route === 'POST /api/setup') {
    if (doc.admin) return send(res, 409, { error: 'already configured' });
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (username.length < 3) return send(res, 400, { error: 'username too short' });
    if (password.length < 8) return send(res, 400, { error: 'password must be at least 8 characters' });
    const record = hashPassword(password);
    setDoc((d) => {
      d.admin = { username, salt: record.salt, hash: record.hash, algo: record.algo, updatedAt: Date.now() };
    });
    issueSession(res, doc.secrets.server, username);
    event('auth', `admin account created (${username})`);
    return send(res, 200, { ok: true, ...buildBootstrap(runtime, req) });
  }

  if (route === 'POST /api/login') {
    const ip = clientIp(req);
    const gate = throttle(`login:${ip}`);
    if (gate.blocked) return send(res, 429, { error: 'too many attempts', retryInMs: gate.retryInMs });
    const body = await readBody(req);
    if (!doc.admin) return send(res, 409, { error: 'setup required' });
    const okUser = String(body.username || '') === doc.admin.username;
    const okPass = verifyPassword(String(body.password || ''), doc.admin);
    if (!okUser || !okPass) return send(res, 401, { error: 'invalid credentials' });
    clearThrottle(`login:${ip}`);
    issueSession(res, doc.secrets.server, doc.admin.username);
    return send(res, 200, { ok: true });
  }

  if (route === 'POST /api/logout') {
    clearSession(res);
    return send(res, 200, { ok: true });
  }

  /* everything below needs a session */
  const session = doc.admin ? readSession(req, doc.secrets.server) : null;
  if (!session) return send(res, 401, { error: 'unauthorized' });

  if (route === 'GET /api/state') {
    return send(res, 200, buildState(runtime, req));
  }

  if (route === 'GET /api/routing') {
    return send(res, 200, { ok: true, ...routingSummary(doc), previews: null });
  }

  if (route === 'GET /api/routing/preview') {
    return send(res, 200, { ok: true, ...previewRouting(doc) });
  }

  if (route === 'POST /api/settings') {
    const body = await readBody(req);
    const allowed = [
      'publicHost', 'tcpHost', 'tcpPort', 'theme', 'lang', 'brand', 'tag',
      'autoRestartCores', 'lowMemory', 'publicStatus', 'logLevel', 'fragment',
    ];
    setDoc((d) => {
      for (const key of allowed) {
        if (body[key] !== undefined) d.settings[key] = body[key];
      }
      if (body.routing && typeof body.routing === 'object') {
        const next = { ...d.settings.routing };
        for (const key of Object.keys(ROUTING_DEFAULTS)) {
          if (body.routing[key] === undefined) continue;
          next[key] = key === 'dns'
            ? (DNS_PRESETS[body.routing.dns] ? body.routing.dns : next.dns)
            : Boolean(body.routing[key]);
        }
        d.settings.routing = next;
      }
      if (body.cores && typeof body.cores === 'object') {
        if (body.cores.xray) d.settings.cores.xray = { ...d.settings.cores.xray, ...body.cores.xray };
        if (body.cores.singbox) d.settings.cores.singbox = { ...d.settings.cores.singbox, ...body.cores.singbox };
      }
    });
    await runtime.apply({ reason: 'settings' });
    return send(res, 200, { ok: true, state: buildState(runtime, req) });
  }

  if (route === 'POST /api/admin/password') {
    const body = await readBody(req);
    const password = String(body.password || '');
    if (password.length < 8) return send(res, 400, { error: 'password too short' });
    if (!verifyPassword(String(body.current || ''), doc.admin)) return send(res, 403, { error: 'wrong current password' });
    const record = hashPassword(password);
    setDoc((d) => {
      d.admin.salt = record.salt;
      d.admin.hash = record.hash;
      d.admin.updatedAt = Date.now();
    });
    return send(res, 200, { ok: true });
  }

  /* ── users ─────────────────────────────────────────────────────────── */
  if (route === 'POST /api/users') {
    if (doc.users.length >= LIMITS.maxUsers) return send(res, 400, { error: 'user limit reached' });
    const body = await readBody(req);
    const name = String(body.name || '').trim() || `user-${doc.users.length + 1}`;
    const days = Number(body.days || 0);
    const user = normalizeUser({
      name,
      quotaBytes: gbToBytes(body.quotaGb),
      expiresAt: days > 0 ? Date.now() + days * 86400000 : null,
      ipLimit: Number(body.ipLimit || 0),
      note: String(body.note || '').slice(0, 200),
    });
    setDoc((d) => d.users.push(user));
    event('user', `user created (${name})`);
    await runtime.apply({ reason: 'user-add' });
    return send(res, 200, { ok: true, user: { id: user.id }, state: buildState(runtime, req) });
  }

  const userMatch = /^\/api\/users\/([a-z0-9]+)(?:\/([a-z-]+))?$/.exec(path);
  if (userMatch) {
    const userId = userMatch[1];
    const action = userMatch[2];
    const user = doc.users.find((u) => u.id === userId);
    if (!user) return send(res, 404, { error: 'user not found' });

    if (req.method === 'PATCH' || (req.method === 'POST' && !action)) {
      const body = await readBody(req);
      setDoc(() => {
        if (body.name !== undefined) user.name = String(body.name).slice(0, 64);
        if (body.enabled !== undefined) user.enabled = Boolean(body.enabled);
        if (body.quotaGb !== undefined) user.quotaBytes = gbToBytes(body.quotaGb);
        if (body.days !== undefined) {
          const days = Number(body.days);
          user.expiresAt = days > 0 ? Date.now() + days * 86400000 : null;
        }
        if (body.expiresAt !== undefined) user.expiresAt = body.expiresAt ? Number(body.expiresAt) : null;
        if (body.ipLimit !== undefined) user.ipLimit = Math.max(0, Number(body.ipLimit) || 0);
        if (body.note !== undefined) user.note = String(body.note).slice(0, 200);
        if (user.enabled) user.disabledReason = '';
      });
      await runtime.apply({ reason: 'user-update' });
      return send(res, 200, { ok: true, state: buildState(runtime, req) });
    }

    if (req.method === 'DELETE' && !action) {
      setDoc((d) => {
        d.users = d.users.filter((u) => u.id !== userId);
      });
      event('user', `user removed (${user.name})`);
      await runtime.apply({ reason: 'user-remove' });
      return send(res, 200, { ok: true, state: buildState(runtime, req) });
    }

    if (action === 'rotate') {
      setDoc(() => {
        user.secrets = normalizeUser({ id: user.id, name: user.name }).secrets;
      });
      event('user', `credentials rotated (${user.name})`);
      await runtime.apply({ reason: 'user-rotate' });
      return send(res, 200, { ok: true, state: buildState(runtime, req) });
    }

    if (action === 'resettraffic' || action === 'reset') {
      setDoc(() => {
        user.usage = { up: 0, down: 0 };
        if (user.disabledReason === 'quota') user.disabledReason = '';
      });
      runtime.accountant.reset();
      await runtime.apply({ reason: 'user-reset' });
      return send(res, 200, { ok: true, state: buildState(runtime, req) });
    }
  }

  /* ── inbounds ──────────────────────────────────────────────────────── */
  if (route === 'POST /api/inbounds') {
    const body = await readBody(req);
    const preset = presetById(String(body.presetId || ''));
    if (!preset) return send(res, 400, { error: 'unknown preset' });
    const used = new Set((doc.inbounds || []).map((ib) => ib.port));
    const base = preset.core === 'singbox' ? 12000 : 11000;
    let port = base + 1;
    while (used.has(port)) port += 1;
    const id = `ib${Math.random().toString(36).slice(2, 8)}`;
    setDoc((d) => {
      d.inbounds.push({
        id,
        presetId: preset.id,
        label: preset.title.en,
        enabled: true,
        routeKey: `nl-${id}`,
        port,
        params: { ...preset.defaults },
      });
    });
    await runtime.apply({ reason: 'inbound-add' });
    return send(res, 200, { ok: true, state: buildState(runtime, req) });
  }

  const inboundMatch = /^\/api\/inbounds\/([a-z0-9]+)$/.exec(path);
  if (inboundMatch) {
    const inbound = (doc.inbounds || []).find((ib) => ib.id === inboundMatch[1]);
    if (!inbound) return send(res, 404, { error: 'inbound not found' });
    if (req.method === 'DELETE') {
      setDoc((d) => {
        d.inbounds = d.inbounds.filter((ib) => ib.id !== inbound.id);
      });
      await runtime.apply({ reason: 'inbound-remove' });
      return send(res, 200, { ok: true, state: buildState(runtime, req) });
    }
    if (req.method === 'PATCH' || req.method === 'POST') {
      const body = await readBody(req);
      setDoc(() => {
        if (body.enabled !== undefined) inbound.enabled = Boolean(body.enabled);
        if (body.label !== undefined) inbound.label = String(body.label).slice(0, 60);
        if (body.params && typeof body.params === 'object') inbound.params = { ...inbound.params, ...body.params };
      });
      await runtime.apply({ reason: 'inbound-update' });
      return send(res, 200, { ok: true, state: buildState(runtime, req) });
    }
  }

  /* ── telegram ──────────────────────────────────────────────────────── */
  if (route === 'POST /api/telegram') {
    const body = await readBody(req);
    setDoc((d) => {
      const tg = d.settings.telegram;
      if (body.mtproto) {
        tg.mtproto = { ...tg.mtproto, ...body.mtproto };
        if (!tg.mtproto.secret || body.mtproto.regenerate) {
          tg.mtproto.secret = generateSecret(tg.mtproto.faketlsHost || 'www.cloudflare.com');
        }
      }
      if (body.socks) tg.socks = { ...tg.socks, ...body.socks };
      if (body.http) tg.http = { ...tg.http, ...body.http };
      if (body.web) tg.web = { ...tg.web, ...body.web };
    });
    await runtime.apply({ reason: 'telegram' });
    return send(res, 200, { ok: true, state: buildState(runtime, req) });
  }

  if (route === 'POST /api/telegram/secret') {
    setDoc((d) => {
      d.settings.telegram.mtproto.secret = generateSecret(d.settings.telegram.mtproto.faketlsHost);
    });
    await runtime.apply({ reason: 'telegram-secret' });
    return send(res, 200, { ok: true, state: buildState(runtime, req) });
  }

  /* ── cores / diagnostics ───────────────────────────────────────────── */
  if (route === 'GET /api/easy-setup') {
    const state = buildState(runtime, req);
    return send(res, 200, {
      analysis: analyse({
        doc: getDoc(),
        facts: runtime.facts(),
        cores: {
          xray: state.cores.xray && state.cores.xray.status,
          singbox: state.cores.singbox && state.cores.singbox.status,
          mtproto: state.cores.mtproto && state.cores.mtproto.status,
        },
      }),
      users: state.users.map((u) => ({
        id: u.id,
        name: u.name,
        status: u.status,
        links: u.links.length,
        subUrl: u.subUrl,
        portalUrl: u.portalUrl,
      })),
    });
  }

  if (route === 'POST /api/easy-setup/apply') {
    const body = await readBody(req);
    const profileId = String(body.profile || 'iran');
    let summary = null;
    setDoc((d) => {
      summary = applyProfile(d, profileId);
      d.updatedAt = Date.now();
    });
    await runtime.apply({ reason: `easy-setup:${profileId}` });
    const state = buildState(runtime, req);
    const firstUser = state.users[0];
    const packet = {
      ok: true,
      summary,
      analysis: analyse({
        doc: getDoc(),
        facts: runtime.facts(),
        cores: {
          xray: state.cores.xray && state.cores.xray.status,
          singbox: state.cores.singbox && state.cores.singbox.status,
          mtproto: state.cores.mtproto && state.cores.mtproto.status,
        },
      }),
      subUrl: firstUser ? firstUser.subUrl : '',
      base64Url: firstUser ? firstUser.subUrl : '',
      portalUrl: firstUser ? firstUser.portalUrl : '',
      links: firstUser ? firstUser.links : [],
    };
    return send(res, 200, packet);
  }

  if (route === 'POST /api/apply') {
    // Fire and answer: a slow core restart must never turn into a 504 in the UI.
    const snapshot = buildState(runtime, req);
    send(res, 200, { ok: true, applying: true, state: snapshot });
    setImmediate(() => {
      runtime.apply({ reason: 'manual' }).catch((err) => console.error('[apply]', err));
    });
    return undefined;
  }

  const coreMatch = /^\/api\/cores\/(xray|singbox|mtproto)\/restart$/.exec(path);
  if (coreMatch) {
    const which = coreMatch[1];
    if (which === 'mtproto') {
      const tg = doc.settings.telegram.mtproto;
      await runtime.mtproto.stop();
      if (tg.enabled) {
        await runtime.mtproto.start({ secret: tg.secret, faketlsHost: tg.faketlsHost, preferIpv4: !tg.preferIpv6 });
      }
    } else {
      await runtime.apply({ reason: `restart-${which}` });
    }
    return send(res, 200, { ok: true, state: buildState(runtime, req) });
  }

  /* ── railynx · clean-ip scanner ────────────────────────────────────── */
  if (route === 'GET /api/railynx') {
    return send(res, 200, { ...scanner.snapshot(), defaults: RAILYNX_DEFAULTS });
  }

  if (route === 'POST /api/railynx/scan') {
    const body = await readBody(req);
    let link = String(body.link || '').trim();
    if (!link && body.linkId) {
      const owner = (doc.users || []).find((u) => (u.links || []).some((l) => l.id === body.linkId));
      const found = owner && owner.links.find((l) => l.id === body.linkId);
      if (found) link = found.uri;
    }
    try {
      parseVlessLink(link);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    if (scanner.snapshot().running) return send(res, 409, { error: 'a scan is already running' });
    const cidr = String(body.cidr || RAILYNX_DEFAULTS.cidr).trim();
    const concurrency = Number(body.concurrency || RAILYNX_DEFAULTS.concurrency);
    event('railynx', `scan started on ${cidr}`);
    scanner.start({ link, cidr, concurrency }).catch((err) => {
      event('railynx-error', err.message);
    });
    // Give the first probe a beat so the UI paints a real progress number.
    await new Promise((r) => setTimeout(r, 120));
    return send(res, 200, { ok: true, ...scanner.snapshot() });
  }

  if (route === 'POST /api/railynx/cancel') {
    const result = scanner.cancel();
    if (result.ok) event('railynx', 'scan cancelled');
    return send(res, result.ok ? 200 : 400, { ...result, ...scanner.snapshot() });
  }

  if (route === 'GET /api/raw') {
    return send(res, 200, runtime.rawConfigs());
  }

  if (route === 'POST /api/raw') {
    const body = await readBody(req);
    const core = String(body.core || '');
    if (core !== 'xray' && core !== 'singbox') return send(res, 400, { error: 'unknown core' });
    const text = typeof body.config === 'string' ? body.config.trim() : '';
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return send(res, 400, { error: 'config must be a JSON object' });
        }
      } catch (err) {
        return send(res, 400, { error: `invalid JSON: ${err.message}` });
      }
    }
    setDoc((d) => {
      d.settings.rawOverride = { xray: '', singbox: '', ...(d.settings.rawOverride || {}) };
      d.settings.rawOverride[core] = text;
    });
    event('raw-config', `${core} raw config ${text ? 'saved' : 'cleared'}`);
    await runtime.apply({ reason: `raw:${core}` });
    return send(res, 200, { ok: true, raw: runtime.rawConfigs(), state: buildState(runtime, req) });
  }

  if (route === 'GET /api/logs') {
    const source = url.searchParams.get('source') || 'xray';
    const snapshot = runtime.snapshot();
    const map = {
      xray: snapshot.xray.lines,
      singbox: snapshot.singbox.lines,
      mtproto: snapshot.mtproto.lines,
    };
    return send(res, 200, { source, lines: (map[source] || []).map((l) => stripAnsi(l)) });
  }

  if (route === 'GET /api/backup') {
    return send(res, 200, exportBackup(), {
      'Content-Disposition': `attachment; filename="nightline-railway-${new Date().toISOString().slice(0, 10)}.json"`,
      'Content-Type': 'application/json; charset=utf-8',
    });
  }

  if (route === 'POST /api/restore') {
    // A backup with a few hundred users is a couple of megabytes — the default
    // 256 KB API limit used to cut the upload off mid-flight.
    const body = await readBody(req, 32 * 1024 * 1024);
    try {
      importBackup(JSON.stringify(body));
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    load();
    // Answer *before* restarting the cores: Railway's edge closes a request
    // that waits too long (504) even though the restore itself succeeded.
    send(res, 200, { ok: true, applying: true, state: buildState(runtime, req) });
    setImmediate(() => {
      runtime.apply({ reason: 'restore' }).catch((err) => console.error('[restore]', err));
    });
    return undefined;
  }

  if (route === 'GET /api/update') {
    const info = await checkUpdate({ force: url.searchParams.get('force') === '1' });
    return send(res, 200, info);
  }

  if (route === 'POST /api/update') {
    if (UPDATE_JOB.state === 'running') {
      return send(res, 409, { ok: false, error: 'an update is already running', job: UPDATE_JOB });
    }
    const logs = [];
    UPDATE_JOB = { state: 'running', startedAt: Date.now(), logs, report: null, error: '' };
    // Answer immediately: Railway's edge gives up on long requests (504), and
    // the download can take a minute on a slow link.
    applyUpdate({ onLog: (line) => { logs.push(line); console.log('[update]', line); } })
      .then((report) => {
        UPDATE_JOB.state = 'staged';
        UPDATE_JOB.report = report;
        console.log(`[update] staged v${report.version}; restarting to apply it`);
        // exit non-zero so the Railway restart policy brings the container back;
        // src/boot.js copies the staged files over the install on the way up.
        setTimeout(() => process.exit(1), 1500);
      })
      .catch((err) => {
        UPDATE_JOB.state = 'error';
        UPDATE_JOB.error = String(err && err.message ? err.message : err);
        console.error('[update]', UPDATE_JOB.error);
      });
    return send(res, 202, { ok: true, started: true, current: APP.version, message: 'update staged in the background' });
  }

  if (route === 'GET /api/update/status') {
    const pending = pendingUpdate();
    return send(res, 200, { ...UPDATE_JOB, pending, current: APP.version });
  }


  if (route === 'POST /api/links/ping') {
    const body = await readBody(req);
    const doc = runtime.withRuntime(getDoc());
    const user = (doc.users || []).find((u) => u.id === body.userId) || (doc.users || [])[0];
    if (!user) return send(res, 400, { error: 'no user' });
    const links = buildUserLinks(doc, user);
    // one TCP handshake per unique endpoint — the host:port pairs repeat across
    // transports, so this stays cheap even with a dozen links
    const cache = new Map();
    const results = await Promise.all(links.map(async (l) => {
      const key = `${l.conn.host}:${l.conn.port}`;
      if (!cache.has(key)) cache.set(key, probeTcp(l.conn.host, Number(l.conn.port)));
      const r = await cache.get(key);
      return { label: l.label, ok: r.ok, ms: r.ms, host: l.conn.host, port: Number(l.conn.port), error: r.error || '' };
    }));
    return send(res, 200, { results, at: Date.now() });
  }

  if (route === 'POST /api/tools/probe') {
    const body = await readBody(req);
    const host = String(body.host || '').trim();
    if (!host) return send(res, 400, { error: 'host required' });
    const result = await probeTcp(host, Number(body.port || 443));
    return send(res, 200, result);
  }

  return send(res, 404, { error: 'not found', route });
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const done = (ok, error) => {
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ok, error: error || '', ms: Date.now() - started, host, port });
    };
    socket.setTimeout(5000, () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.message));
    socket.connect(port, host, () => done(true));
  });
}

/* ── subscriptions ───────────────────────────────────────────────────── */

function handleSubscription({ req, res, url, runtime }) {
  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[0];
  const token = parts[1] || '';
  const format = (parts[2] || url.searchParams.get('format') || 'base64').toLowerCase();
  const doc = runtime.withRuntime(getDoc());
  const user = (doc.users || []).find((u) => subToken(doc.secrets.server, u.id) === token);
  if (!user) return send(res, 404, { error: 'not found' });

  if (kind === 'u') {
    const info = {
      name: user.name,
      status: userStatus(user),
      usageGb: bytesToGb(userTotal(user)),
      quotaGb: bytesToGb(user.quotaBytes),
      expiresAt: user.expiresAt,
      links: buildUserLinks(doc, user).map((l) => ({
        label: l.label,
        uri: l.uri,
        protocol: l.protocol,
        transport: l.transport,
        security: l.security,
        core: l.core,
      })),
    };
    if (url.searchParams.get('json') === '1') return send(res, 200, info);
    try {
      const page = readFileSync(new URL('../../public/portal.html', import.meta.url));
      return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    } catch {
      return send(res, 200, info);
    }
  }

  if (!FORMATS.has(format)) return send(res, 400, { error: 'unknown format' });
  const sub = buildSub(doc, user, format);
  const headers = {
    'Content-Type': sub.type,
    'Cache-Control': 'no-store',
    'Subscription-Userinfo': buildUserInfoHeader(user),
    ...headerSet(doc.settings.brand || APP.brand),
  };
  if (url.searchParams.get('download') === '1') {
    headers['Content-Disposition'] = `attachment; filename="nightline-${user.name}.${format === 'clash' ? 'yaml' : format === 'links' ? 'txt' : 'json'}"`;
  }
  return send(res, 200, sub.body, headers);
}

function buildUserInfoHeader(user) {
  const total = user.quotaBytes || 0;
  const used = userTotal(user);
  const expire = user.expiresAt ? Math.floor(user.expiresAt / 1000) : 0;
  return `upload=0; download=${used}; total=${total}; expire=${expire}`;
}

export { plainText };
