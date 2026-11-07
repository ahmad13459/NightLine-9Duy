/**
 * Pre-flight: verify binaries, generated configs and the store before a
 * deploy.  `npm run check`
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, DATA_DIR, ROOT } from '../src/env.js';
import { load } from '../src/store.js';
import { buildXrayConfig } from '../src/config/xray.js';
import { buildSingboxConfig } from '../src/config/singbox.js';
import { ensureCerts, ensureReality } from '../src/config/certs.js';
import { PRESETS } from '../src/catalog.js';

const problems = [];
const notes = [];

function checkBinary(name, args) {
  const file = BIN[name];
  if (!fs.existsSync(file)) {
    problems.push(`${name} binary missing at ${file} — run scripts/install-binaries.mjs or build with Docker`);
    return;
  }
  const res = spawnSync(file, args, { encoding: 'utf8', timeout: 10000 });
  notes.push(`${name}: ${(res.stdout || res.stderr || '').split('\n')[0].trim()}`);
}

checkBinary('xray', ['version']);
checkBinary('singbox', ['version']);
checkBinary('mtg', ['--version']);

const doc = load();
doc.__runtime = {
  publicHost: process.env.RAILWAY_PUBLIC_DOMAIN || 'panel.example.com',
  tcpHost: process.env.RAILWAY_TCP_PROXY_DOMAIN || 'tcp.example.com',
  tcpPort: Number(process.env.RAILWAY_TCP_PROXY_PORT || 12345),
  reality: ensureReality(),
};
const reality = ensureReality();
const certs = ensureCerts();
const xray = buildXrayConfig({ doc, reality, certs, serverSecret: doc.secrets.server });
const singbox = buildSingboxConfig({ doc, reality, certs, serverSecret: doc.secrets.server });

fs.mkdirSync(path.join(DATA_DIR, 'preflight'), { recursive: true });
const xrayPath = path.join(DATA_DIR, 'preflight', 'xray.json');
const sbPath = path.join(DATA_DIR, 'preflight', 'singbox.json');
fs.writeFileSync(xrayPath, JSON.stringify(xray.config, null, 2));
fs.writeFileSync(sbPath, JSON.stringify(singbox.config, null, 2));

if (fs.existsSync(BIN.xray)) {
  const res = spawnSync(BIN.xray, ['-test', '-c', xrayPath], { encoding: 'utf8', timeout: 20000 });
  if (res.status !== 0) problems.push(`xray config rejected: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
  else notes.push(`xray config OK (${xray.routes.length} inbounds)`);
}
if (fs.existsSync(BIN.singbox)) {
  const res = spawnSync(BIN.singbox, ['check', '-c', sbPath], { encoding: 'utf8', timeout: 20000 });
  if (res.status !== 0) problems.push(`sing-box config rejected: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`);
  else notes.push(`sing-box config OK (${singbox.routes.length} inbounds)`);
}

notes.push(`${PRESETS.length} protocol recipes available`);
notes.push(`store: ${path.join(DATA_DIR, 'nightline.json')} (${doc.users.length} users, ${doc.inbounds.length} inbounds)`);
notes.push(`panel root: ${ROOT}`);

console.log('── notes ──');
for (const line of notes) console.log('  ·', line);
if (problems.length) {
  console.log('\n── problems ──');
  for (const line of problems) console.log('  ✗', line);
  process.exit(1);
}
console.log('\n✓ pre-flight passed');
