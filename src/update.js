/**
 * In-panel updater — staged on the volume, applied at boot.
 *
 * Railway recreates the container from the built image on every restart, so a
 * file written into /app at runtime would disappear the moment the process
 * restarts. The updater therefore downloads the release ONTO THE VOLUME
 * (DATA_DIR/.update), writes a pending manifest, and lets `src/boot.js` copy
 * the staged files over the install during the next boot — which is the only
 * moment where that copy is both safe and persistent.
 *
 * Everything here is read-only unless `applyUpdate()` is called explicitly.
 */
import https from 'node:https';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, rmSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { DATA_DIR, ROOT, APP } from './env.js';

const run = promisify(execFile);
const REPO = 'youdidking/NightLine-Railway';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const TARBALL_FALLBACK = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`;
const UA = `NightLine-Railway/${APP.version} (+https://github.com/${REPO})`;

/** Which top-level paths an update is allowed to overwrite. */
const CODE_PATHS = ['src', 'public', 'docs', 'assets', 'scripts', 'installer', 'README.md', 'Dockerfile', 'railway.json', 'package.json', 'LICENSE'];

let cache = { at: 0, value: null };
const CACHE_MS = 5 * 60 * 1000;

function get(url, { redirect = 0, header = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'application/vnd.github+json', ...header } }, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirect < 4) {
        res.resume();
        resolve(get(headers.location, { redirect: redirect + 1, header }));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? { raw: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] > pb.parts[i] ? 1 : -1;
  }
  return 0;
}

function trimNotes(body) {
  // GitHub release bodies are markdown; the panel shows a short plain preview.
  return String(body || '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`>]/g, '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(0, 24)
    .join('\n')
    .slice(0, 1600);
}

/**
 * Ask the repository for the newest release. Never throws; errors land in `error`
 * so the UI can show them instead of a dead button.
 */
export async function checkUpdate({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_MS) return cache.value;

  let value;
  try {
    const raw = await get(API);
    const rel = JSON.parse(raw);
    const latest = parseVersion(rel.tag_name || rel.name || '') || null;
    value = {
      ok: true,
      current: APP.version,
      latest: latest ? latest.raw : '',
      tag: rel.tag_name || '',
      name: rel.name || rel.tag_name || '',
      publishedAt: rel.published_at || '',
      notes: trimNotes(rel.body),
      tarball: rel.tarball_url || TARBALL_FALLBACK,
      htmlUrl: rel.html_url || `https://github.com/${REPO}/releases`,
      updateAvailable: latest ? compareVersions(latest.raw, APP.version) > 0 : false,
      repo: `https://github.com/${REPO}`,
      checkedAt: now,
      error: '',
    };
  } catch (err) {
    value = {
      ok: false,
      current: APP.version,
      latest: '',
      tag: '',
      name: '',
      publishedAt: '',
      notes: '',
      tarball: TARBALL_FALLBACK,
      htmlUrl: `https://github.com/${REPO}/releases`,
      updateAvailable: false,
      repo: `https://github.com/${REPO}`,
      checkedAt: now,
      error: String(err && err.message ? err.message : err),
    };
  }
  cache = { at: now, value };
  return value;
}

function download(url, file) {
  return new Promise((resolve, reject) => {
    const go = (target, hops = 0) => {
      https.get(target, { headers: { 'user-agent': UA } }, (res) => {
        const { statusCode = 0, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && hops < 4) {
          res.resume();
          go(headers.location, hops + 1);
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`download failed: HTTP ${statusCode}`));
          return;
        }
        const out = createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(file)));
        out.on('error', reject);
      }).on('error', reject);
    };
    go(url);
  });
}

/**
 * Download and unpack the newest release over the code paths.
 * Returns a small report; the caller decides when to restart the process.
 */
export function stageDir() {
  return path.join(DATA_DIR, '.update');
}

/** The manifest of a staged update, or null. */
export function pendingUpdate() {
  try {
    return JSON.parse(readFileSync(path.join(stageDir(), 'pending.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Copy a staged update over the install. Called from src/boot.js before the
 * panel is imported, never from a request handler.
 */
export function applyStaged({ root = ROOT, log = () => {} } = {}) {
  const pending = pendingUpdate();
  if (!pending) return null;
  const source = path.join(stageDir(), pending.dir || '');
  if (!existsSync(path.join(source, 'src', 'index.js'))) {
    log('staged update is incomplete — ignored');
    rmSync(stageDir(), { recursive: true, force: true });
    return null;
  }
  for (const rel of CODE_PATHS) {
    const from = path.join(source, rel);
    if (!existsSync(from)) continue;
    cpSync(from, path.join(root, rel), { recursive: true, force: true });
  }
  rmSync(stageDir(), { recursive: true, force: true });
  return { version: pending.version || '', from: pending.from || '', at: pending.at || 0 };
}

export async function applyUpdate({ onLog = () => {} } = {}) {
  const info = await checkUpdate({ force: true });
  const tarball = info.ok ? info.tarball : TARBALL_FALLBACK;

  const stage = stageDir();
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const tar = path.join(stage, 'release.tar.gz');
  onLog(`downloading ${tarball}`);
  await download(tarball, tar);

  onLog('extracting');
  await run('tar', ['-xzf', tar, '-C', stage], { timeout: 60000 });
  const root = readdirSync(stage).find((n) => {
    try {
      return readdirSync(path.join(stage, n)).includes('package.json');
    } catch {
      return false;
    }
  });
  if (!root) throw new Error('release archive has no package.json');
  const source = path.join(stage, root);
  if (!existsSync(path.join(source, 'src', 'index.js'))) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error('release archive is not a NightLine build');
  }

  let version = APP.version;
  try {
    version = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version || version;
  } catch { /* keep current */ }

  const paths = CODE_PATHS.filter((rel) => existsSync(path.join(source, rel)));
  onLog(`staged ${paths.length} paths (v${version}) on the volume`);
  rmSync(tar, { force: true });
  writeFileSync(
    path.join(stage, 'pending.json'),
    JSON.stringify({ version, from: APP.version, dir: root, paths, at: Date.now() }, null, 2),
  );

  // the running version stays as it is until the next boot applies the stage
  return { ok: true, version, from: APP.version, paths, staged: true, at: Date.now() };
}
