/**
 * NIGHTLINE · Railway Edition — boot guard
 *
 * The panel keeps every user, key and setting inside one JSON file that lives
 * on the Railway volume. Deploying without that volume (or without telling the
 * panel where it is) silently gives you a panel that loses everything on the
 * next restart, so the boot sequence refuses to start instead.
 *
 * Required, always:
 *   PORT      → 8080        the HTTP port the Railway domain targets
 *   DATA_DIR  → /data       the mount path of the volume
 *   a Railway volume mounted on DATA_DIR
 *
 * `NL_ALLOW_EPHEMERAL=1` downgrades these to warnings — it exists only for
 * running the panel on a laptop (`npm start`), never for Railway.
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIREMENTS = [
  { key: 'PORT', value: '8080', why: 'پورت HTTP پنل که دامنهٔ ریلوی به آن وصل می‌شود' },
  { key: 'DATA_DIR', value: '/data', why: 'مسیر والیوم؛ کاربران و لینک‌ها اینجا می‌مانند' },
];

function readMountInfo() {
  try {
    return fs
      .readFileSync('/proc/self/mountinfo', 'utf8')
      .split('\n')
      .map((line) => line.split(' ')[4])
      .filter(Boolean)
      .map((mp) => path.resolve(mp.replace(/\\040/g, ' ')));
  } catch {
    return [];
  }
}

/** True when `dir` is a mount point (i.e. a Railway volume is attached there). */
export function isMountPoint(dir) {
  const target = path.resolve(dir);
  if (readMountInfo().includes(target)) return true;
  try {
    const self = fs.statSync(target);
    const parent = fs.statSync(path.dirname(target));
    // A different device than its parent means "mounted", even without /proc.
    if (self.dev !== parent.dev) return true;
  } catch {
    /* not created yet */
  }
  return false;
}

function insideVolume(dir, mount) {
  const d = path.resolve(dir);
  const m = path.resolve(mount);
  return d === m || d.startsWith(m.endsWith('/') ? m : `${m}/`);
}

/**
 * Audit the runtime environment.
 * @returns {{ok:boolean, fatal:object[], warn:object[], info:object}}
 */
export function auditEnvironment({ dataDir = '', volumeMount = '' } = {}) {
  const fatal = [];
  const warn = [];
  const envDataDir = (dataDir || '').trim();
  const envPort = (process.env.PORT || '').trim();
  const mount = (volumeMount || '').trim();

  if (!envPort) {
    fatal.push({
      code: 'PORT_MISSING',
      fa: 'متغیر PORT تنظیم نشده است.',
      en: 'The PORT variable is not set.',
      fix: 'Railway → Variables → + New Variable → PORT = 8080',
    });
  }

  if (!envDataDir) {
    fatal.push({
      code: 'DATA_DIR_MISSING',
      fa: 'متغیر DATA_DIR تنظیم نشده است.',
      en: 'The DATA_DIR variable is not set.',
      fix: 'Railway → Variables → + New Variable → DATA_DIR = /data',
    });
  }

  const volumeAttached = Boolean(mount) || (envDataDir ? isMountPoint(envDataDir) : false);

  if (envDataDir && !volumeAttached) {
    fatal.push({
      code: 'VOLUME_MISSING',
      fa: `والیومی روی ${envDataDir} وصل نشده است؛ داده‌ها با هر ری‌استارت پاک می‌شوند.`,
      en: `No volume is mounted on ${envDataDir}; all data would be lost on every restart.`,
      fix: 'Railway → Service → Data/Volumes → + New Volume → Mount path: /data',
    });
  }

  if (envDataDir && mount && !insideVolume(envDataDir, mount)) {
    fatal.push({
      code: 'DATA_DIR_OUTSIDE_VOLUME',
      fa: `DATA_DIR (${envDataDir}) داخل والیوم (${mount}) نیست.`,
      en: `DATA_DIR (${envDataDir}) is outside the mounted volume (${mount}).`,
      fix: `DATA_DIR را برابر ${mount} یا مسیری داخل آن بگذارید.`,
    });
  }

  const bypass = /^(1|true|yes|on)$/i.test((process.env.NL_ALLOW_EPHEMERAL || '').trim());
  if (bypass && fatal.length) {
    for (const item of fatal.splice(0)) {
      warn.push({ ...item, code: `${item.code}_BYPASSED` });
    }
  }

  return {
    ok: fatal.length === 0,
    fatal,
    warn,
    info: {
      port: envPort || '(unset)',
      dataDir: envDataDir || '(unset)',
      volumeMount: mount || (envDataDir && isMountPoint(envDataDir) ? envDataDir : ''),
      volumeAttached,
      bypass,
    },
  };
}

/** Big, unmissable box printed before the process exits. */
export function requirementBanner(report) {
  const line = '─'.repeat(66);
  const out = [
    '',
    `  ┌${line}┐`,
    '  │  NIGHTLINE · Railway — REFUSING TO START (configuration)          │',
    `  └${line}┘`,
  ];
  for (const item of report.fatal) {
    out.push('', `  ✗ ${item.en}`, `    ${item.fa}`, `    → ${item.fix}`);
  }
  for (const item of report.warn) {
    out.push('', `  ! (bypassed) ${item.en}`, `    → ${item.fix}`);
  }
  out.push(
    '',
    '  Variables that must exist on the Railway service',
    ...REQUIREMENTS.map((r) => `    ${r.key.padEnd(10)} = ${r.value.padEnd(8)} ${r.why}`),
    '  Volume that must be attached',
    '    mount path : /data',
    '    (Service → Data/Volumes → + New Volume → /data)',
    '',
    '  Nothing was started. Add what is missing and redeploy.',
    '',
  );
  return out.join('\n');
}
