/**
 * The panel runtime: owns the cores, the Telegram proxy fleet, the TCP
 * multiplexer and the accounting loop.
 */
import { EventEmitter } from 'node:events';
import { createCores } from './cores.js';
import { MtprotoProxy, MTPROTO_PORT, generateSecret, secretHost } from './proxy/mtproto.js';
import { Socks5Server } from './proxy/socks5.js';
import { HttpProxyServer } from './proxy/http.js';
import { Mux, buildPlan } from './proxy/mux.js';
import { buildXrayConfig, XRAY_API_PORT } from './config/xray.js';
import { buildSingboxConfig } from './config/singbox.js';
import { ensureCerts, ensureReality } from './config/certs.js';
import { TrafficAccountant, queryStats, sysStats } from './stats.js';
import { describeInbound } from './catalog.js';
import { coreReason } from './text.js';
import {
  get as getDoc,
  set as setDoc,
  effectiveEnabled,
  addTrafficSample,
  event,
  normalizeUser,
} from './store.js';
import { RAILWAY, MUX_PORT, PORT, LIMITS } from './env.js';

/**
 * Last-resort safety net: a rule that references geo data the core cannot load
 * must never take the whole core down (and with it every config the panel
 * serves). If a generated config is rejected we retry once without the optional
 * rule data and keep the cores running.
 */
function withoutGeoData(config, core) {
  const clone = JSON.parse(JSON.stringify(config));
  const mentionsGeo = (rule) => {
    const text = JSON.stringify(rule);
    return text.includes('geosite:') || text.includes('geoip:') || text.includes('"rule_set"');
  };
  if (core === 'xray' && clone.routing && Array.isArray(clone.routing.rules)) {
    clone.routing.rules = clone.routing.rules.filter((rule) => !mentionsGeo(rule));
  }
  if (core === 'singbox' && clone.route) {
    if (Array.isArray(clone.route.rules)) clone.route.rules = clone.route.rules.filter((rule) => !mentionsGeo(rule));
    delete clone.route.rule_set;
  }
  return clone;
}

export class Runtime extends EventEmitter {
  constructor() {
    super();
    this.cores = createCores();
    this.mtproto = new MtprotoProxy();
    this.socks = new Socks5Server({ getUser: () => this.telegramSocksAuth() });
    this.httpProxy = new HttpProxyServer({ getUser: () => this.telegramHttpAuth() });
    this.mux = new Mux({
      socks5: this.socks,
      httpProxy: this.httpProxy,
      resolvePlan: () => this.plan(),
      panelPort: PORT,
    });
    this.accountant = new TrafficAccountant();
    this.reality = ensureReality();
    this.certs = ensureCerts();
    this.timers = [];
    this.lastActiveSignature = '';
    this.lastStats = { at: 0, totals: { up: 0, down: 0 }, perUser: new Map() };
    this.sys = {};
    this.bootedAt = Date.now();
    for (const core of [this.cores.xray, this.cores.singbox, this.mtproto]) {
      core.on('status', () => this.emit('change'));
      core.on('log', () => this.emit('log'));
    }
  }

  telegramSocksAuth() {
    const doc = getDoc();
    const t = doc.settings.telegram.socks;
    if (!t.enabled) return null;
    return { user: t.user, pass: t.pass };
  }

  telegramHttpAuth() {
    const doc = getDoc();
    const t = doc.settings.telegram.http;
    if (!t.enabled) return null;
    return { user: t.user, pass: t.pass };
  }

  /** Public/tcp facts, refreshed on every state read. */
  facts() {
    const doc = getDoc();
    return {
      publicHost: (doc.settings.publicHost || RAILWAY.publicDomain || '').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      tcpHost: doc.settings.tcpHost || RAILWAY.tcpDomain || '',
      tcpPort: Number(doc.settings.tcpPort || RAILWAY.tcpPort || 0) || 0,
      internalMuxPort: MUX_PORT,
      reality: this.reality,
      plan: this.plan(),
    };
  }

  /** Attach runtime facts to the document so config/link builders can use them. */
  withRuntime(doc = getDoc()) {
    const f = this.facts();
    doc.__runtime = { ...f };
    return doc;
  }

  plan() {
    const doc = getDoc();
    return buildPlan(
      { ...doc, __catalog: { describeInbound } },
      {
        mtprotoPort: MTPROTO_PORT,
        mtprotoEnabled: doc.settings.telegram.mtproto.enabled,
        mtprotoFakeTls: doc.settings.telegram.mtproto.faketlsHost,
      },
    );
  }

  /** Which HTTP-edge inbounds should be routed by the panel. */
  httpRoutes() {
    const doc = this.withRuntime(getDoc());
    const routes = [];
    for (const raw of doc.inbounds || []) {
      const ib = describeInbound(raw);
      if (!ib || !ib.enabled || ib.edge !== 'http' || ib.udp) continue;
      routes.push({ prefix: `/${ib.routeKey}`, port: ib.port, inboundId: ib.id, core: ib.core });
    }
    return routes;
  }

  /**
   * Railway only injects RAILWAY_PUBLIC_DOMAIN / the TCP proxy values while the
   * service is actually exposed. A redeploy or a re-created service can come up
   * without them, which used to turn every link into "host:0". Remember the
   * values in the document the first time we see them, so the links survive.
   */
  rememberHosts() {
    const doc = getDoc();
    const patch = {};
    if (!doc.settings.publicHost && RAILWAY.publicDomain) patch.publicHost = RAILWAY.publicDomain;
    if (!doc.settings.tcpHost && RAILWAY.tcpDomain) patch.tcpHost = RAILWAY.tcpDomain;
    if (!Number(doc.settings.tcpPort) && RAILWAY.tcpPort) patch.tcpPort = RAILWAY.tcpPort;
    if (!Object.keys(patch).length) return null;
    setDoc((d) => Object.assign(d.settings, patch));
    event('hosts-saved', `Railway hosts remembered: ${patch.publicHost || doc.settings.publicHost || '-'} / ${patch.tcpHost || '-'}`);
    return patch;
  }

  async boot() {
    this.rememberHosts();
    this.startMux();
    await this.apply({ reason: 'boot' });
    this.timers.push(setInterval(() => this.tick().catch(() => {}), LIMITS.statsIntervalMs));
    this.timers.push(setInterval(() => this.housekeeping(), 60 * 1000));
  }

  /** Tell the multiplexer where the panel really listens (it may not be PORT). */
  usePanelPort(port) {
    this.panelPort = port;
    if (this.mux) this.mux.panelPort = port;
    return port;
  }

  async startMux() {
    try {
      await this.mux.listen(MUX_PORT, '0.0.0.0');
      event('mux', `TCP multiplexer listening on :${MUX_PORT}`);
    } catch (err) {
      event('mux-error', `TCP multiplexer failed: ${err.message}`);
      console.error('[mux]', err.message);
    }
  }

/** The generated and the currently active core configs, as editable JSON. */
  rawConfigs() {
    return this.raw || { generated: { xray: '', singbox: '' }, active: { xray: '', singbox: '' }, override: { xray: false, singbox: false }, notes: {} };
  }

  /** Rebuild every generated config and restart what changed. */
  async apply({ reason = 'manual' } = {}) {
    const doc = this.withRuntime(getDoc());
    const serverSecret = doc.secrets.server;

    const xray = buildXrayConfig({
      doc,
      reality: this.reality,
      certs: this.certs,
      serverSecret,
      logLevel: doc.settings.logLevel || 'warning',
    });
    const singbox = buildSingboxConfig({
      doc,
      reality: this.reality,
      certs: this.certs,
      serverSecret,
      logLevel: doc.settings.singboxLogLevel || 'warn',
    });

    this.xrayRoutes = xray.routes;
    this.singboxRoutes = singbox.routes;

    const wantXray = doc.settings.cores.xray.enabled && xray.routes.length > 0;
    const wantSingbox = doc.settings.cores.singbox.enabled && singbox.routes.length > 0;

    /* Hand-written configs win, but only if the core accepts them. */
    const overrides = (doc.settings && doc.settings.rawOverride) || {};
    const notes = { xray: '', singbox: '' };
    const pick = (coreName, generated) => {
      const raw = overrides[coreName];
      if (!raw) return generated;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        return parsed;
      } catch (err) {
        notes[coreName] = `override ignored: ${err.message}`;
        return generated;
      }
    };
    const xrayConfig = pick('xray', xray.config);
    const singboxConfig = pick('singbox', singbox.config);

    this.raw = {
      generated: { xray: JSON.stringify(xray.config, null, 2), singbox: JSON.stringify(singbox.config, null, 2) },
      active: { xray: JSON.stringify(xrayConfig, null, 2), singbox: JSON.stringify(singboxConfig, null, 2) },
      override: { xray: Boolean(overrides.xray), singbox: Boolean(overrides.singbox) },
      notes,
    };

    if (wantXray) {
      let ok = await this.cores.xray.start(xrayConfig);
      if (!ok && xrayConfig !== xray.config) {
        notes.xray = `override rejected: ${coreReason(this.cores.xray.lastError)}`;
        this.raw.notes = notes;
        this.raw.active.xray = this.raw.generated.xray;
        this.raw.override.xray = false;
        clearOverride('xray');
        ok = await this.cores.xray.start(xray.config);
      }
      if (!ok) {
        // never leave the service without a core: retry without the geo rules
        const safe = withoutGeoData(xrayConfig, 'xray');
        ok = await this.cores.xray.start(safe);
        if (ok) {
          event('xray-warn', 'rule data was rejected by Xray — started without the optional block rules');
          this.raw.active.xray = JSON.stringify(safe, null, 2);
        }
      }
      if (!ok) event('xray-error', `Xray did not start: ${this.cores.xray.lastError || 'unknown'}`);
    } else {
      await this.cores.xray.stop();
    }
    if (wantSingbox) {
      let ok = await this.cores.singbox.start(singboxConfig);
      if (!ok && singboxConfig !== singbox.config) {
        notes.singbox = `override rejected: ${coreReason(this.cores.singbox.lastError)}`;
        this.raw.notes = notes;
        this.raw.active.singbox = this.raw.generated.singbox;
        this.raw.override.singbox = false;
        clearOverride('singbox');
        ok = await this.cores.singbox.start(singbox.config);
      }
      if (!ok) {
        const safe = withoutGeoData(singboxConfig, 'singbox');
        ok = await this.cores.singbox.start(safe);
        if (ok) {
          event('singbox-warn', 'rule sets were rejected by sing-box — started without the optional block rules');
          this.raw.active.singbox = JSON.stringify(safe, null, 2);
        }
      }
      if (!ok) event('singbox-error', `sing-box did not start: ${this.cores.singbox.lastError || 'unknown'}`);
    } else {
      await this.cores.singbox.stop();
    }
    for (const [coreName, note] of Object.entries(notes)) {
      if (note) event('raw-override', `${coreName}: ${note}`);
    }

    const tg = doc.settings.telegram.mtproto;
    if (tg.enabled) {
      if (!tg.secret) {
        setDoc((d) => {
          d.settings.telegram.mtproto.secret = generateSecret(d.settings.telegram.mtproto.faketlsHost);
        });
      }
      const fresh = getDoc().settings.telegram.mtproto;
      await this.mtproto.start({
        secret: fresh.secret,
        faketlsHost: fresh.faketlsHost,
        preferIpv4: !fresh.preferIpv6,
      });
    } else {
      await this.mtproto.stop();
    }

    event('apply', `configs applied (${reason})`, { xray: xray.routes.length, singbox: singbox.routes.length });
    this.emit('change');
    return { xray: xray.routes, singbox: singbox.routes };
  }

  /** Slow loop: expiry, samples, log rotation. */
  housekeeping() {
    const doc = getDoc();
    let changed = false;
    const now = Date.now();
    for (const user of doc.users) {
      if (user.enabled && user.expiresAt && user.expiresAt <= now && user.disabledReason !== 'expired') {
        user.disabledReason = 'expired';
        changed = true;
      }
    }
    if (changed) {
      setDoc(() => {});
      this.apply({ reason: 'expiry' }).catch(() => {});
    }
  }

  /** Traffic accounting + quota enforcement. */
  async tick() {
    const doc = getDoc();
    let stats = [];
    try {
      stats = await queryStats(XRAY_API_PORT, '', false);
    } catch {
      stats = [];
    }
    if (stats.length) {
      const { perUser, totals } = this.accountant.ingest(stats);
      this.lastStats = { at: Date.now(), totals, perUser };
      if (perUser.size) {
        setDoc((d) => {
          for (const user of d.users) {
            const delta = perUser.get(user.id);
            if (!delta) continue;
            user.usage.up += delta.up;
            user.usage.down += delta.down;
            user.lastSeen = Date.now();
          }
        });
      }
      const point = {
        t: Date.now(),
        up: totals.up,
        down: totals.down,
        tg: this.mux.state().up + this.mux.state().down,
      };
      addTrafficSample(point);
    }
    try {
      this.sys = await sysStats(XRAY_API_PORT);
    } catch {
      this.sys = {};
    }
    await this.enforceQuotas();
    this.emit('change');
  }

  /** Users that crossed a limit are dropped from every core config. */
  async enforceQuotas() {
    const doc = getDoc();
    let changed = false;
    for (const user of doc.users) {
      const exhausted = user.quotaBytes && user.usage.up + user.usage.down >= user.quotaBytes;
      const expired = user.expiresAt && user.expiresAt <= Date.now();
      if (exhausted && user.disabledReason !== 'quota') {
        user.disabledReason = 'quota';
        changed = true;
        event('quota', `user ${user.name} hit quota`);
      } else if (expired && user.disabledReason !== 'expired') {
        user.disabledReason = 'expired';
        changed = true;
        event('quota', `user ${user.name} expired`);
      }
    }
    const signature = doc.users
      .filter((u) => effectiveEnabled(u))
      .map((u) => u.id)
      .sort()
      .join(',');
    if (signature !== this.lastActiveSignature) {
      this.lastActiveSignature = signature;
      changed = true;
    }
    if (changed) await this.apply({ reason: 'accounting' });
  }

  snapshot() {
    const muxState = this.mux.state();
    return {
      xray: { ...this.cores.xray.snapshot(), routes: this.xrayRoutes || [] },
      singbox: { ...this.cores.singbox.snapshot(), routes: this.singboxRoutes || [] },
      mtproto: { ...this.mtproto.snapshot(), port: MTPROTO_PORT, secretHost: secretHost(getDoc().settings.telegram.mtproto.secret) },
      mux: muxState,
      socks5: this.socks.state(),
      http: this.httpProxy.state(),
      sys: this.sys,
      stats: {
        at: this.lastStats.at,
        totals: this.lastStats.totals,
      },
      bootedAt: this.bootedAt,
      plan: this.plan(),
      facts: this.facts(),
    };
  }

  async shutdown() {
    for (const timer of this.timers) clearInterval(timer);
    this.mux.close();
    await Promise.all([
      this.cores.xray.stop(),
      this.cores.singbox.stop(),
      this.mtproto.stop(),
    ]);
  }
}

/** Forget a hand-written config so the next apply uses the generated one. */
function clearOverride(core) {
  try {
    setDoc((d) => {
      d.settings.rawOverride = { xray: '', singbox: '', ...(d.settings.rawOverride || {}) };
      d.settings.rawOverride[core] = '';
    });
  } catch { /* best effort */ }
}

/** Trim a core's stderr down to one readable sentence for the UI. */
function shortReason(text) {
  const raw = String(text || 'invalid config').replace(/\s+/g, ' ').trim();
  const marker = raw.match(/(invalid [^>]{0,120}|failed to (?:start|load|decode)[^>]{0,120}|unknown field[^>]{0,80})/i);
  const picked = marker ? marker[0] : raw;
  return `override rejected: ${picked.slice(0, 160)}`;
}
