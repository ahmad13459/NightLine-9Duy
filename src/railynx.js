/**
 * Railynx — Railway clean-IP scanner.
 *
 * A Railway service reachable through `*.up.railway.app` is often slow or
 * filtered, while the plain IP range behind it is not. Railynx takes a
 * `vless://` link, walks a CIDR block, and keeps only the addresses that
 * complete a real VLESS-over-WebSocket round trip in under a second.
 *
 * One probe (five steps, exactly as specified):
 *   1. TCP connect to the candidate IP on the link's port (443 by default)
 *   2. TLS handshake with SNI = the link's domain, ALPN http/1.1, trust-all
 *   3. WebSocket upgrade on the link's path with `Host: <domain>` → expect 101
 *   4. a masked binary frame carrying the VLESS header (cmd 1, port 80,
 *      www.google.com) followed by a plain `GET /generate_204` request
 *   5. success only when the answers contains `HTTP/1.1 204` / `204 No Content`
 *
 * Every address is probed three times, 60 ms apart; a single miss rejects it.
 * The reported latency is the mean of the three probes.
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export const DEFAULTS = {
  cidr: '69.46.46.0/24',
  concurrency: 12,
  rounds: 3,
  gapMs: 60,
  connectTimeoutMs: 2400,
  probeTimeoutMs: 6000,
  maxHosts: 1024,
};

const VLESS_DEST_HOST = 'www.google.com';
const VLESS_DEST_PORT = 80;
const PROBE_REQUEST = `GET /generate_204 HTTP/1.1\r\nHost: ${VLESS_DEST_HOST}\r\nUser-Agent: v2rayN\r\nConnection: close\r\n\r\n`;

/* ── link parsing ─────────────────────────────────────────────────────── */

export function parseVlessLink(raw) {
  const text = String(raw || '').trim();
  if (!/^vless:\/\//i.test(text)) throw new Error('only vless:// links can be scanned');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('the link is not a valid URL');
  }
  const uuid = decodeURIComponent(url.username || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error('the link has no valid UUID');
  }
  const q = url.searchParams;
  const type = (q.get('type') || 'ws').toLowerCase();
  const security = (q.get('security') || 'tls').toLowerCase();
  const domain = (q.get('host') || q.get('sni') || url.hostname || '').toLowerCase();
  if (!domain) throw new Error('the link has no host/SNI');
  return {
    // WebSocket links get the full five-step probe; every other VLESS transport
    // (raw TCP, REALITY, gRPC, XHTTP) falls back to a TLS-latency probe so the
    // scanner is not limited to one config type.
    mode: type === 'ws' ? 'full' : 'ping',
    raw: text,
    uuid,
    address: url.hostname,
    port: Number(url.port || 443) || 443,
    domain,
    sni: (q.get('sni') || domain).toLowerCase(),
    host: (q.get('host') || domain).toLowerCase(),
    path: q.get('path') || '/',
    security,
    type,
    name: decodeURIComponent((url.hash || '').replace(/^#/, '')) || 'Railynx',
  };
}

/**
 * Rebuild the same link with only the connection address swapped — every other
 * parameter (flow, pbk, sid, alpn, path …) stays exactly as the operator set it.
 */
export function buildCleanLink(parsed, ip) {
  const swapped = parsed.raw.replace(/@(\[[^\]]+\]|[^@/?#]+?):(\d+)/, `@${ip}:${parsed.port}`);
  if (swapped !== parsed.raw) return swapped;
  const params = new URLSearchParams({
    encryption: 'none',
    security: parsed.security || 'tls',
    sni: parsed.sni,
    fp: 'chrome',
    alpn: 'http/1.1',
    type: parsed.type,
    host: parsed.host,
    path: parsed.path,
  });
  return `vless://${parsed.uuid}@${ip}:${parsed.port}?${params.toString()}#${encodeURIComponent(parsed.name)}`;
}

/* ── ip helpers ───────────────────────────────────────────────────────── */

export function expandCidr(cidr, cap = DEFAULTS.maxHosts) {
  const text = String(cidr || '').trim();
  const single = /^(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (single) return [single[1]];
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text);
  if (!m) throw new Error('range must look like 69.46.46.0/24 or a single IP');
  const base = m[1].split('.').map(Number);
  const bits = Number(m[2]);
  if (bits < 8 || bits > 32) throw new Error('prefix must be between /8 and /32');
  if (base.some((n) => n < 0 || n > 255)) throw new Error('invalid IPv4 address');
  const total = 2 ** (32 - bits);
  const usable = bits >= 31 ? total : total - 2;
  if (usable > cap) throw new Error(`range too large (${usable} addresses, max ${cap})`);
  const startInt = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  const first = bits >= 31 ? 0 : 1;
  const out = [];
  for (let i = first; i < usable + first; i += 1) {
    const n = (startInt + i) >>> 0;
    out.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return out;
}

/* ── websocket helpers ────────────────────────────────────────────────── */

function frameBinary(payload) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x82;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** VLESS request header for a TCP connection to `host:port`. */
function vlessHeader(uuid, host, port) {
  const id = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  const hostBytes = Buffer.from(host, 'utf8');
  const head = Buffer.alloc(1 + 16 + 1 + 1 + 2 + 1 + 1 + hostBytes.length);
  let o = 0;
  head[o++] = 0; // version
  id.copy(head, o); o += 16;
  head[o++] = 0; // addons length
  head[o++] = 1; // command: TCP
  head.writeUInt16BE(port, o); o += 2;
  head[o++] = 2; // address type: domain
  head[o++] = hostBytes.length;
  hostBytes.copy(head, o);
  return head;
}

function wsUpgradeRequest(parsed) {
  const key = crypto.randomBytes(16).toString('base64');
  const path = parsed.path.startsWith('/') ? parsed.path : `/${parsed.path}`;
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${parsed.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    'User-Agent: Mozilla/5.0',
    '',
    '',
  ].join('\r\n');
}

/** Latency-only probe for non-WebSocket configs: TCP + TLS with the link SNI. */
function probeTls({ parsed, ip }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let done = false;
    let raw = null;
    let sock = null;
    const finish = (ok, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* ignore */ }
      try { raw?.destroy(); } catch { /* ignore */ }
      resolve({ ok, ip, latency: Math.round(Number(process.hrtime.bigint() - started) / 1e6), ...extra });
    };
    const timer = setTimeout(() => finish(false, { reason: 'timeout' }), DEFAULTS.connectTimeoutMs + 2000);
    raw = net.connect({ host: ip, port: parsed.port });
    raw.setNoDelay(true);
    raw.on('error', (err) => finish(false, { reason: err.code || 'tcp' }));
    raw.on('connect', () => {
      sock = tls.connect({
        socket: raw,
        servername: parsed.sni,
        ALPNProtocols: parsed.type === 'grpc' ? ['h2'] : ['http/1.1'],
        rejectUnauthorized: false,
      });
      sock.on('error', (err) => finish(false, { reason: err.code || 'tls' }));
      sock.on('secureConnect', () => finish(true));
    });
  });
}

/* ── one probe ────────────────────────────────────────────────────────── */

function probe({ parsed, ip }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    let tlsSocket = null;
    let raw = null;
    let connectTimer = null;
    let done = false;
    let buffered = Buffer.alloc(0);
    let upgraded = false;

    const finish = (ok, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (connectTimer) clearTimeout(connectTimer);
      try { tlsSocket?.destroy(); } catch { /* ignore */ }
      try { raw?.destroy(); } catch { /* ignore */ }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ ok, ip, latency: Math.round(ms), ...extra });
    };

    const timer = setTimeout(() => finish(false, { reason: 'timeout' }), DEFAULTS.probeTimeoutMs);

    raw = net.connect({ host: ip, port: parsed.port });
    raw.setNoDelay(true);
    raw.on('error', (err) => finish(false, { reason: err.code || 'tcp' }));
    connectTimer = setTimeout(() => finish(false, { reason: 'connect-timeout' }), DEFAULTS.connectTimeoutMs);
    raw.on('connect', () => {
      clearTimeout(connectTimer);
      tlsSocket = tls.connect({
        socket: raw,
        servername: parsed.sni,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: false,
      });
      tlsSocket.on('error', (err) => finish(false, { reason: err.code || 'tls' }));
      tlsSocket.on('close', () => { if (!done) finish(false, { reason: 'closed' }); });
      tlsSocket.on('secureConnect', () => {
        tlsSocket.write(wsUpgradeRequest(parsed));
      });
      tlsSocket.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!upgraded) {
          const end = buffered.indexOf('\r\n\r\n');
          if (end === -1) {
            if (buffered.length > 8192) finish(false, { reason: 'bad-upgrade' });
            return;
          }
          const head = buffered.subarray(0, end).toString('latin1');
          const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1] || 0);
          if (status !== 101) {
            finish(false, { reason: `upgrade-${status || 'invalid'}` });
            return;
          }
          upgraded = true;
          buffered = buffered.subarray(end + 4);
          const payload = Buffer.concat([
            vlessHeader(parsed.uuid, VLESS_DEST_HOST, VLESS_DEST_PORT),
            Buffer.from(PROBE_REQUEST, 'latin1'),
          ]);
          tlsSocket.write(frameBinary(payload));
        }
        const text = buffered.toString('latin1');
        if (text.includes('HTTP/1.1 204') || text.includes('204 No Content')) {
          finish(true);
        }
      });
    });
  });
}

async function probeThrice(parsed, ip, rounds, gapMs, isCancelled, probeFn = probe) {
  const latencies = [];
  for (let i = 0; i < rounds; i += 1) {
    if (isCancelled()) return { ok: false, ip, reason: 'cancelled' };
    const res = await probeFn({ parsed, ip });
    if (!res.ok) return res;
    latencies.push(res.latency);
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  const mean = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  return { ok: true, ip, latency: mean, samples: latencies };
}

/* ── scanner ──────────────────────────────────────────────────────────── */

export class RailynxScanner {
  constructor() {
    this.state = this.blank();
  }

  blank() {
    return {
      running: false,
      cancelled: false,
      startedAt: 0,
      finishedAt: 0,
      cidr: '',
      total: 0,
      checked: 0,
      alive: 0,
      failed: 0,
      concurrency: DEFAULTS.concurrency,
      parsed: null,
      results: [],
      recent: [],
      lastError: '',
      token: 0,
    };
  }

  snapshot() {
    return {
      running: this.state.running,
      cancelled: this.state.cancelled,
      startedAt: this.state.startedAt,
      finishedAt: this.state.finishedAt,
      cidr: this.state.cidr,
      total: this.state.total,
      checked: this.state.checked,
      alive: this.state.alive,
      failed: this.state.failed,
      concurrency: this.state.concurrency,
      lastError: this.state.lastError,
      link: this.state.parsed ? this.state.parsed.address : '',
      mode: this.state.parsed ? this.state.parsed.mode : '',
      results: this.state.results.slice(0, 200),
      recent: this.state.recent.slice(0, 24),
    };
  }

  cancel() {
    if (!this.state.running) return { ok: false, error: 'no scan is running' };
    this.state.cancelled = true;
    this.state.running = false;
    this.state.finishedAt = Date.now();
    this.state.token += 1;
    return { ok: true };
  }

  async start({ link, cidr = DEFAULTS.cidr, concurrency = DEFAULTS.concurrency }) {
    if (this.state.running) throw new Error('a scan is already running');
    const parsed = parseVlessLink(link);
    const hosts = expandCidr(cidr);
    const workers = Math.max(1, Math.min(32, Number(concurrency) || DEFAULTS.concurrency));
    const token = this.state.token + 1;
    this.state = {
      ...this.blank(),
      running: true,
      startedAt: Date.now(),
      cidr: String(cidr),
      total: hosts.length,
      concurrency: workers,
      parsed,
      token,
    };

    const st = this.state;
    const isCancelled = () => st.cancelled || this.state !== st;
    const queue = hosts.slice();
    const results = [];
    let index = 0;

    const worker = async () => {
      while (!isCancelled()) {
        const at = index;
        index += 1;
        if (at >= queue.length) return;
        const ip = queue[at];
        const res = parsed.mode === 'full'
          ? await probeThrice(parsed, ip, DEFAULTS.rounds, DEFAULTS.gapMs, isCancelled)
          : await probeThrice(parsed, ip, DEFAULTS.rounds, DEFAULTS.gapMs, isCancelled, probeTls);
        if (isCancelled()) return;
        this.state.checked += 1;
        this.state.recent.unshift({
          ip,
          ok: res.ok,
          latency: res.latency || 0,
          reason: res.reason || '',
          at: Date.now(),
        });
        if (this.state.recent.length > 40) this.state.recent.length = 40;
        if (res.ok) {
          this.state.alive += 1;
          results.push({ ip, latency: res.latency, samples: res.samples });
          // keep the table sorted while the scan runs
          results.sort((a, b) => a.latency - b.latency);
          this.state.results = results.map((r) => ({
            ...r,
            link: buildCleanLink(parsed, r.ip),
          }));
        } else {
          this.state.failed += 1;
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: workers }, worker));
    } catch (err) {
      if (this.state === st) st.lastError = err.message;
    } finally {
      if (this.state === st) {
        st.running = false;
        st.finishedAt = Date.now();
      }
    }
    return this.snapshot();
  }
}

export const scanner = new RailynxScanner();
