/**
 * Telegram MTProto proxy (the "tg://proxy" flavour).
 *
 * The actual proxy engine is mtg (github.com/9seconds/mtg) which implements
 * FakeTLS + MTProto obfuscation and is battle tested; the panel owns the
 * lifecycle, the secret, the port and the links.
 */
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BIN, LIMITS } from '../env.js';

export const MTPROTO_PORT = 11100;

/** `ee` + 16 random bytes + hex(fake-tls hostname) — the canonical hex secret. */
export function generateSecret(fakeTlsHost = 'www.microsoft.com') {
  const key = crypto.randomBytes(16).toString('hex');
  const host = Buffer.from(fakeTlsHost, 'utf8').toString('hex');
  return `ee${key}${host}`;
}

export function isValidSecret(secret) {
  return /^(?:[0-9a-f]{32}|dd[0-9a-f]{32}|ee[0-9a-f]{32}[0-9a-f]+)$/i.test(String(secret || '').trim());
}

export function secretHost(secret) {
  const s = String(secret || '');
  if (!s.startsWith('ee') || s.length <= 34) return '';
  try {
    return Buffer.from(s.slice(34), 'hex').toString('utf8');
  } catch {
    return '';
  }
}

export function telegramLinks({ host, port, secret }) {
  const q = `server=${encodeURIComponent(host)}&port=${port}&secret=${secret}`;
  return {
    app: `tg://proxy?${q}`,
    web: `https://t.me/proxy?${q}`,
  };
}

export class MtprotoProxy extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.status = 'stopped';
    this.lines = [];
    this.desired = false;
    this.lastError = '';
    this.restarts = 0;
    this.timer = null;
  }

  available() {
    try {
      const res = spawnSync(BIN.mtg, ['--version'], { timeout: 5000 });
      return !res.error;
    } catch {
      return false;
    }
  }

  version() {
    try {
      const res = spawnSync(BIN.mtg, ['--version'], { encoding: 'utf8', timeout: 5000 });
      return `${res.stdout || res.stderr || ''}`.trim().split('\n')[0] || '';
    } catch {
      return '';
    }
  }

  async start({ secret, faketlsHost, preferIpv4 = true }) {
    this.desired = true;
    if (!this.available()) {
      this.status = 'missing';
      this.lastError = `mtg binary not found at ${BIN.mtg}`;
      return false;
    }
    await this.stop();
    const safeSecret = isValidSecret(secret) ? secret : generateSecret(faketlsHost);
    const args = ['simple-run', `127.0.0.1:${MTPROTO_PORT}`, safeSecret, '-i', preferIpv4 ? 'prefer-ipv4' : 'prefer-ipv6'];
    const child = spawn(BIN.mtg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.status = 'starting';
    this.lastError = '';
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.trim()) this.log(line.trim());
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('spawn', () => {
      this.status = 'running';
      this.emit('status', this.snapshot());
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.status = this.desired ? 'crashed' : 'stopped';
      this.log(`exited code=${code} signal=${signal || '-'}`);
      if (this.desired) this.scheduleRestart(secret, faketlsHost, preferIpv4);
    });
    child.on('error', (err) => {
      this.status = 'error';
      this.lastError = err.message;
    });
    return true;
  }

  scheduleRestart(secret, faketlsHost, preferIpv4) {
    if (this.timer) return;
    this.restarts += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.desired) return;
      this.start({ secret, faketlsHost, preferIpv4 }).catch(() => {});
    }, Math.min(30000, 1500 * this.restarts));
  }

  async stop() {
    this.desired = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) {
      this.status = 'stopped';
      return;
    }
    await new Promise((resolve) => {
      child.once('exit', resolve);
      try { child.kill('SIGTERM'); } catch { resolve(); }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve();
      }, 3000);
    });
    this.status = 'stopped';
  }

  log(line) {
    this.lines.push(`${new Date().toISOString()} ${line}`);
    if (this.lines.length > LIMITS.logLines) this.lines.splice(0, this.lines.length - LIMITS.logLines);
    this.emit('log', line);
  }

  snapshot() {
    return {
      status: this.status,
      pid: this.child?.pid || 0,
      port: MTPROTO_PORT,
      restarts: this.restarts,
      lastError: this.lastError,
      version: this.version(),
      available: this.available(),
      lines: this.lines.slice(-120),
    };
  }
}
