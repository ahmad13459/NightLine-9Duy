/**
 * Process supervisor for the two cores (Xray-core and sing-box).
 *
 * Both are plain child processes started with a generated config file.  The
 * supervisor keeps a ring buffer of their logs, validates configs before every
 * (re)start and restarts with backoff so a bad edit can never leave the service
 * dead.
 */
import fs from 'node:fs';
import { stripAnsi, oneLine } from './text.js';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { STATE_DIR, LOG_DIR, LIMITS, BIN, ensureDirs } from './env.js';

const RING = LIMITS.logLines;

export class Core extends EventEmitter {
  constructor({ id, bin, config }) {
    super();
    this.id = id;
    this.bin = bin;
    this.config = config;
    this.child = null;
    this.lines = [];
    this.startedAt = 0;
    this.status = 'stopped';
    this.lastError = '';
    this.restarts = 0;
    this.desired = false;
    this.restartTimer = null;
    this.configPath = path.join(STATE_DIR, `${id}.json`);
    this.logPath = path.join(LOG_DIR, `${id}.log`);
  }

  available() {
    try {
      fs.accessSync(this.bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  version() {
    if (!this.available()) return '';
    try {
      const res = spawnSync(this.bin, ['version'], { encoding: 'utf8', timeout: 8000 });
      const out = (res.stdout || '').trim().split('\n');
      return out[0] || '';
    } catch {
      return '';
    }
  }

  validate(config) {
    if (!this.available()) return { ok: false, error: `${this.id} binary not found at ${this.bin}` };
    const tmp = path.join(STATE_DIR, `${this.id}-check.json`);
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    const args = this.id === 'xray' ? ['-test', '-c', tmp] : ['check', '-c', tmp];
    const res = spawnSync(this.bin, args, { encoding: 'utf8', timeout: 15000 });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const ok = res.status === 0;
    return { ok, error: ok ? '' : output.trim().split('\n').slice(-4).join(' '), output };
  }

  async start(config = this.config) {
    this.desired = true;
    if (config) this.config = config;
    if (!this.config) {
      this.status = 'error';
      this.lastError = 'no config';
      return false;
    }
    if (!this.available()) {
      this.status = 'missing';
      this.lastError = `${this.id} binary not found (${this.bin})`;
      return false;
    }
    const check = this.validate(this.config);
    if (!check.ok) {
      this.status = 'invalid';
      this.lastError = check.error;
      this.log(`config rejected: ${check.error}`);
      return false;
    }
    await this.stop();
    ensureDirs();
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (err) {
      this.lastError = err.message;
      return false;
    }

    const args = this.id === 'xray' ? ['run', '-c', this.configPath] : ['run', '-c', this.configPath];
    const child = spawn(this.bin, args, {
      cwd: STATE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, XRAY_LOCATION_ASSET: path.dirname(this.bin) },
    });
    this.child = child;
    this.status = 'starting';
    this.startedAt = Date.now();
    this.lastError = '';

    const onData = (buf) => {
      const text = stripAnsi(buf.toString('utf8'));
      for (const line of text.split('\n')) {
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
      const wasDesired = this.desired;
      this.child = null;
      this.status = wasDesired ? 'crashed' : 'stopped';
      this.log(`exited code=${code} signal=${signal || '-'}`);
      this.emit('status', this.snapshot());
      if (wasDesired) this.scheduleRestart();
    });
    child.on('error', (err) => {
      this.status = 'error';
      this.lastError = err.message;
      this.log(`spawn error: ${err.message}`);
    });
    return true;
  }

  scheduleRestart() {
    if (this.restartTimer || !this.desired) return;
    this.restarts += 1;
    const delay = Math.min(30000, 1000 * Math.min(6, this.restarts));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desired) return;
      this.start().catch(() => {});
    }, delay);
  }

  async stop() {
    this.desired = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child) {
      if (this.status !== 'missing') this.status = 'stopped';
      return;
    }
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once('exit', done);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        done();
      }, 4000);
    });
    this.status = 'stopped';
  }

  async restart(config) {
    await this.stop();
    this.desired = true;
    return this.start(config || this.config);
  }

  log(line) {
    const clean = stripAnsi(line);
    if (!clean.trim()) return;
    const stamped = `${new Date().toISOString()} ${clean}`;
    this.lines.push(stamped);
    if (this.lines.length > RING) this.lines.splice(0, this.lines.length - RING);
    try {
      fs.appendFileSync(this.logPath, stamped + '\n');
      const size = fs.statSync(this.logPath).size;
      if (size > 512 * 1024) {
        fs.writeFileSync(this.logPath, this.lines.slice(-100).join('\n') + '\n');
      }
    } catch { /* ignore */ }
    this.emit('log', stamped);
  }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      desired: this.desired,
      pid: this.child?.pid || 0,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt && this.child ? Date.now() - this.startedAt : 0,
      restarts: this.restarts,
      lastError: this.lastError,
      available: this.available(),
      bin: this.bin,
      version: this._version || '',
      lines: this.lines.slice(-120),
    };
  }

  rememberVersion() {
    this._version = this.version();
  }
}

export function createCores() {
  const xray = new Core({ id: 'xray', bin: BIN.xray });
  const singbox = new Core({ id: 'singbox', bin: BIN.singbox });
  xray.rememberVersion();
  singbox.rememberVersion();
  return { xray, singbox };
}
