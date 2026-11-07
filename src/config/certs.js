/**
 * Certificates, REALITY keypairs and other generated material.
 * Everything lands inside the Railway volume so it survives redeploys.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { STATE_DIR } from '../env.js';

const CERT_DIR = path.join(STATE_DIR, 'certs');

export function ensureCerts() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const certPath = path.join(CERT_DIR, 'nightline-cert.pem');
  const keyPath = path.join(CERT_DIR, 'nightline-key.pem');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'ec',
        '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-nodes', '-days', '3650',
        '-subj', '/CN=nightline.railway',
        '-addext', 'subjectAltName=DNS:nightline.railway,DNS:localhost,IP:127.0.0.1',
        '-keyout', keyPath, '-out', certPath,
      ], { stdio: 'pipe' });
    } catch (err) {
      console.error('[certs] openssl failed:', err.message);
    }
  }
  return {
    certificateFile: fs.existsSync(certPath) ? certPath : null,
    keyFile: fs.existsSync(keyPath) ? keyPath : null,
  };
}

/**
 * SHA-256 of the generated certificate (hex), used by modern Xray clients
 * instead of `allowInsecure`, which was removed in Xray 25.x+/26.x.
 */
export function certPin() {
  try {
    const certPath = path.join(CERT_DIR, 'nightline-cert.pem');
    if (!fs.existsSync(certPath)) return '';
    const pem = fs.readFileSync(certPath, 'utf8');
    const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (!b64) return '';
    const der = Buffer.from(b64, 'base64');
    return crypto.createHash('sha256').update(der).digest('hex');
  } catch {
    return '';
  }
}

/** X25519 keypair in the base64url form Xray/sing-box expect for REALITY. */
export function generateRealityKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return {
    privateKey: privateKey.export({ format: 'jwk' }).d,
    publicKey: publicKey.export({ format: 'jwk' }).x,
    shortIds: [crypto.randomBytes(4).toString('hex'), crypto.randomBytes(8).toString('hex')],
  };
}

/** Stable per-install REALITY material. */
export function ensureReality() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, 'reality.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.privateKey && parsed.publicKey) return parsed;
  } catch { /* create below */ }
  const keys = generateRealityKeys();
  fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  return keys;
}
