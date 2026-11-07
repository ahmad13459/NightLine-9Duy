/**
 * NIGHTLINE · Railway Edition — boot entry point.
 *
 * Railway rebuilds the container from the image on every restart, so code
 * written into /app at runtime never survives. The in-panel updater therefore
 * stages a release on the volume; this tiny bootstrap copies that stage over
 * the install *before* the panel is loaded and then starts the real process.
 *
 * Nothing is loaded from src/ before the copy — a fresh child process is used
 * so no module is ever cached from the previous version.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { applyStaged, pendingUpdate } from './update.js';
import { ROOT, APP, DATA_DIR } from './env.js';

const pending = pendingUpdate();
if (pending) {
  console.log(`[boot] staged update found: v${pending.version || '?'} (from v${pending.from || '?'})`);
  try {
    const applied = applyStaged({ log: (line) => console.log(`[boot] ${line}`) });
    if (applied) console.log(`[boot] update applied → v${applied.version || '?'}`);
  } catch (err) {
    console.error('[boot] could not apply the staged update:', err && err.message ? err.message : err);
    console.error('[boot] keeping the installed version');
  }
} else {
  console.log(`[boot] v${APP.version} · data ${DATA_DIR}`);
}

const entry = path.join(ROOT, 'src', 'index.js');
const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: process.env });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch { /* already gone */ }
    setTimeout(() => process.exit(0), 3000);
  });
}

child.on('exit', (code, signal) => {
  console.log(`[boot] panel exited (code=${code}, signal=${signal || '-'})`);
  if (signal) {
    try { process.kill(process.pid, signal); } catch { process.exit(1); }
    return;
  }
  process.exit(code == null ? 1 : code);
});

child.on('error', (err) => {
  console.error('[boot] could not start the panel:', err.message);
  process.exit(1);
});
