/**
 * Minimal TLS ClientHello (SNI) peek used by the TCP multiplexer.
 * Returns null while the record is still incomplete.
 */
export function peekSni(buf) {
  if (!buf || buf.length < 5) return null;
  if (buf[0] !== 0x16 || buf[1] !== 0x03) return null; // not a TLS handshake
  const recordLength = buf.readUInt16BE(3);
  if (buf.length < 5 + recordLength) return { incomplete: true, sni: '' };
  if (buf[5] !== 0x01) return { sni: '', notClientHello: true };
  let pos = 9; // skip record(5) + handshake type(1) + length(3)
  pos += 2 + 32; // version + random
  if (pos >= buf.length) return { incomplete: true, sni: '' };
  const sessionIdLen = buf[pos];
  pos += 1 + sessionIdLen;
  if (pos + 2 > buf.length) return { incomplete: true, sni: '' };
  const cipherLen = buf.readUInt16BE(pos);
  pos += 2 + cipherLen;
  if (pos + 1 > buf.length) return { incomplete: true, sni: '' };
  const compLen = buf[pos];
  pos += 1 + compLen;
  if (pos + 2 > buf.length) return { incomplete: true, sni: '' };
  const extTotal = buf.readUInt16BE(pos);
  pos += 2;
  const extEnd = Math.min(buf.length, pos + extTotal);
  while (pos + 4 <= extEnd) {
    const type = buf.readUInt16BE(pos);
    const len = buf.readUInt16BE(pos + 2);
    pos += 4;
    if (pos + len > extEnd) return { incomplete: true, sni: '' };
    if (type === 0x0000) {
      // server_name
      let p = pos + 2; // list length
      while (p + 3 <= pos + len) {
        const nameType = buf[p];
        const nameLen = buf.readUInt16BE(p + 1);
        p += 3;
        if (nameType === 0 && p + nameLen <= pos + len) {
          return { sni: buf.subarray(p, p + nameLen).toString('latin1').toLowerCase(), incomplete: false };
        }
        p += nameLen;
      }
    }
    pos += len;
  }
  return { sni: '', incomplete: false };
}

/** Cheap protocol sniffing for the non-TLS side of the multiplexer. */
export function classify(buf) {
  if (!buf || !buf.length) return 'unknown';
  if (buf[0] === 0x16 && buf[1] === 0x03) return 'tls';
  if (buf[0] === 0x05) return 'socks5';
  const head = buf.subarray(0, 8).toString('latin1').toUpperCase();
  if (head.startsWith('CONNECT ')) return 'http-connect';
  if (head.startsWith('GET ') || head.startsWith('POST ') || head.startsWith('HEAD ')) return 'http';
  return 'opaque';
}

/**
 * MTProto obfuscated2 puts a 4-byte protocol tag at offset 56 of the first
 * 64-byte frame. Recognising it is the only reliable way to tell MTProto apart
 * from Shadowsocks on a shared plain-TCP port (both look like random bytes).
 *   ef ef ef ef → abridged,  ee ee ee ee → intermediate,
 *   dd dd dd dd → padded intermediate,  48 54 54 50 → HTTP transport
 */
const MTPROTO_TAGS = new Set([0xeeeeeeee, 0xdddddddd, 0xefefefef, 0x50545448]);

export function looksLikeMtproto(buf) {
  if (!buf || buf.length < 60) return false;
  return MTPROTO_TAGS.has(buf.readUInt32LE(56));
}
