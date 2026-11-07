/**
 * Helpers shared by both core config builders.
 */
import crypto from 'node:crypto';

/**
 * Deterministic Shadowsocks-2022 server PSK for an inbound.
 *
 * SS-2022 multi-user needs a *server* key next to the per-user keys.  Deriving
 * it from the install secret keeps it stable across restarts and redeploys
 * without having to persist one more field.
 */
export function ssServerKey(serverSecret, inboundId, method = '2022-blake3-aes-128-gcm') {
  const len = String(method).endsWith('aes-256-gcm') || String(method).includes('chacha20') ? 32 : 16;
  const mac = crypto.createHmac('sha256', String(serverSecret || 'nightline')).update(`ss:${inboundId}:${len}`).digest();
  return mac.subarray(0, len).toString('base64');
}

/** Deterministic shared password for legacy (non-2022) Shadowsocks inbounds. */
export function legacySsPassword(serverSecret, inboundId) {
  return crypto
    .createHmac('sha256', String(serverSecret || 'nightline'))
    .update(`ss-legacy:${inboundId}`)
    .digest('base64')
    .slice(0, 28);
}
