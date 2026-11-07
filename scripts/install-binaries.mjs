/**
 * Local / CI helper: download the three binaries this panel supervises into
 * ./bin so `npm start` works outside Docker.
 *
 *   node scripts/install-binaries.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/env.js';

const XRAY_VERSION = process.env.XRAY_VERSION || '26.10.31';
const SINGBOX_VERSION = process.env.SINGBOX_VERSION || '1.14.4';
const MTG_VERSION = process.env.MTG_VERSION || '2.3.0';

const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
const BIN = path.join(ROOT, 'bin');
const TMP = path.join(ROOT, '.cache-bin');

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' });
}

fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const xrayZip = arch === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
console.log(`› xray ${XRAY_VERSION} (${arch})`);
run('curl', ['-fsSL', '-o', path.join(TMP, 'xray.zip'), `https://github.com/XTLS/Xray-core/releases/download/v${XRAY_VERSION}/${xrayZip}`]);
run('unzip', ['-oq', path.join(TMP, 'xray.zip'), '-d', BIN]);

console.log(`› sing-box ${SINGBOX_VERSION} (${arch})`);
run('curl', ['-fsSL', '-o', path.join(TMP, 'sb.tar.gz'), `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${arch}.tar.gz`]);
run('tar', ['-xzf', path.join(TMP, 'sb.tar.gz'), '-C', TMP]);
fs.copyFileSync(path.join(TMP, `sing-box-${SINGBOX_VERSION}-linux-${arch}`, 'sing-box'), path.join(BIN, 'sing-box'));

console.log(`› mtg ${MTG_VERSION} (${arch})`);
run('curl', ['-fsSL', '-o', path.join(TMP, 'mtg.tar.gz'), `https://github.com/9seconds/mtg/releases/download/v${MTG_VERSION}/mtg-${MTG_VERSION}-linux-${arch}.tar.gz`]);
run('tar', ['-xzf', path.join(TMP, 'mtg.tar.gz'), '-C', TMP]);
fs.copyFileSync(path.join(TMP, `mtg-${MTG_VERSION}-linux-${arch}`, 'mtg'), path.join(BIN, 'mtg'));

for (const name of ['xray', 'sing-box', 'mtg']) fs.chmodSync(path.join(BIN, name), 0o755);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✓ binaries in ${BIN}`);
