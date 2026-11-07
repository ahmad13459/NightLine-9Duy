/**
 * NIGHTLINE · Railway Edition — runtime environment
 *
 * Two variables are mandatory on Railway — `PORT` and `DATA_DIR` — and the
 * DATA_DIR must be the mount path of an attached volume. The boot guard
 * (src/guard.js) enforces that before anything else runs; everything else in
 * this file has a working default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APP = {
  brand: 'NIGHTLINE',
  tag: 'Railway',
  version: '1.0.4',
  edition: 'RAILWAY',
  repo: 'https://github.com/youdidking/NightLine-Railway',
  telegram: process.env.NL_TELEGRAM_CONTACT || 'https://t.me/rvivl',
};

/**
 * Data directory — always the volume.
 *
 * `DATA_DIR` is a required Railway variable (see src/guard.js). The fallback
 * below only keeps the module importable when the variable is missing; the
 * boot sequence refuses to start in that case.
 */
function pickDataDir() {
  const explicit = process.env.DATA_DIR || process.env.NL_DATA_DIR;
  if (explicit) return path.resolve(explicit);
  return '/data';
}

export const DATA_DIR = pickDataDir();
export const DATA_FILE = path.join(DATA_DIR, 'nightline.json');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const STATE_DIR = path.join(DATA_DIR, 'state');
export const BIN_DIR = process.env.NL_BIN_DIR || path.join(ROOT, 'bin');

/** Public panel port (Railway injects PORT). */
export const PORT = Number(process.env.PORT || 8080);
/** Variables Railway's service must define (see src/guard.js). */
export const REQUIRED_ENV = ['PORT', 'DATA_DIR'];
/** Internal port used by the TCP multiplexer (the Railway TCP proxy targets it). */
export const MUX_PORT = Number(process.env.NL_TCP_PORT || 8443);

/**
 * The panel answers on every one of these ports. Railway edges are configured
 * per-domain and people very often point the HTTPS domain at 8080 while `PORT`
 * says something else (or at the TCP-proxy port), so listening on the whole
 * set makes the deployment work whichever port the edge targets.
 * The mux port is excluded: it belongs to the TCP multiplexer.
 */
export const PANEL_PORTS = (() => {
  const out = new Set();
  const explicit = Number(process.env.NL_PANEL_PORT || 0) || 0;
  if (explicit > 0) out.add(explicit);
  if (PORT > 0) out.add(PORT);
  out.add(8080);
  out.add(3000);
  return [...out].filter((p) => Number.isInteger(p) && p > 0 && p !== MUX_PORT);
})();

/** True when `PORT` points at the mux port — the classic Railway mix-up. */
export const PORT_CONFLICT = PORT === MUX_PORT;

/** Railway-injected facts. */
export const RAILWAY = {
  publicDomain: (process.env.RAILWAY_PUBLIC_DOMAIN || '').trim(),
  privateDomain: (process.env.RAILWAY_PRIVATE_DOMAIN || '').trim(),
  tcpDomain: (process.env.RAILWAY_TCP_PROXY_DOMAIN || '').trim(),
  tcpPort: Number(process.env.RAILWAY_TCP_PROXY_PORT || 0) || 0,
  tcpAppPort: Number(process.env.RAILWAY_TCP_APPLICATION_PORT || 0) || 0,
  region: (process.env.RAILWAY_REPLICA_REGION || '').trim(),
  serviceName: (process.env.RAILWAY_SERVICE_NAME || '').trim(),
  projectName: (process.env.RAILWAY_PROJECT_NAME || '').trim(),
  volumePath: (process.env.RAILWAY_VOLUME_MOUNT_PATH || '').trim(),
};

/** Binary locations (downloaded at image build time, see Dockerfile). */
export const BIN = {
  xray: process.env.NL_XRAY_BIN || path.join(BIN_DIR, 'xray'),
  singbox: process.env.NL_SINGBOX_BIN || path.join(BIN_DIR, 'sing-box'),
  mtg: process.env.NL_MTG_BIN || path.join(BIN_DIR, 'mtg'),
};

export const LIMITS = {
  maxUsers: Number(process.env.NL_MAX_USERS || 500),
  logLines: Number(process.env.NL_LOG_LINES || 400),
  statsIntervalMs: Number(process.env.NL_STATS_INTERVAL_MS || 20000),
  maxBodyBytes: 256 * 1024,
};

export const IS_RAILWAY = Boolean(RAILWAY.publicDomain || RAILWAY.tcpDomain || process.env.RAILWAY_ENVIRONMENT_ID);
export const NODE_ENV = process.env.NODE_ENV || 'production';

export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR, STATE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
