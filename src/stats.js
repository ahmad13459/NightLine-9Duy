/**
 * Traffic accounting.
 *
 * Xray exposes the standard v2ray stats gRPC service.  Rather than pulling a
 * grpc-js dependency into a 512 MB Railway container, this module speaks the
 * (very small) subset of gRPC/protobuf it needs directly over node:http2.
 *
 *   v2ray.core.app.stats.command.StatsService/QueryStats
 *   v2ray.core.app.stats.command.StatsService/GetSysStats
 */
import http2 from 'node:http2';

/* ── protobuf primitives ─────────────────────────────────────────────── */

function writeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function field(len, index) {
  return writeVarint((len << 3) | 2).length ? writeVarint((BigInt(index) << 3n) | 2n) : Buffer.alloc(0);
}

function encodeString(i, str) {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarint((BigInt(i) << 3n) | 2n), writeVarint(body.length), body]);
}

function encodeBool(i, val) {
  return Buffer.concat([writeVarint(BigInt(i) << 3n), writeVarint(val ? 1 : 0)]);
}

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos];
    result |= BigInt(byte & 0x7f) << shift;
    pos += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: result, offset: pos };
}

/** Tolerant protobuf decoder: returns { fields: [{no, wire, value}] }. */
function decodeMessage(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    pos = key.offset;
    const no = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.offset;
      fields.push({ no, wire, value: v.value });
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.offset;
      const end = pos + Number(len.value);
      fields.push({ no, wire, value: buf.subarray(pos, end) });
      pos = end;
    } else if (wire === 5) {
      fields.push({ no, wire, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else if (wire === 1) {
      fields.push({ no, wire, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else {
      break;
    }
  }
  return fields;
}

/* ── grpc client ─────────────────────────────────────────────────────── */

function grpcCall(port, method, message, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${port}`);
    let settled = false;
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      try { session.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('stats timeout')), timeoutMs);
    session.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });
    let req;
    try {
      req = session.request({
        ':method': 'POST',
        ':path': method,
        'content-type': 'application/grpc',
        te: 'trailers',
      });
    } catch (err) {
      clearTimeout(timer);
      finish(err);
      return;
    }
    const chunks = [];
    req.on('response', (headers) => {
      if (headers['grpc-status'] && Number(headers['grpc-status']) !== 0) {
        clearTimeout(timer);
        finish(new Error(`grpc-status ${headers['grpc-status']}`));
      }
    });
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('trailers', (trailers) => {
      if (trailers['grpc-status'] && Number(trailers['grpc-status']) !== 0) {
        clearTimeout(timer);
        finish(new Error(`grpc-status ${trailers['grpc-status']}`));
      }
    });
    req.on('end', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      if (raw.length < 5) {
        finish(null, Buffer.alloc(0));
        return;
      }
      const len = raw.readUInt32BE(1);
      finish(null, raw.subarray(5, 5 + len));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    const payload = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), message]);
    payload.writeUInt32BE(message.length, 1);
    req.end(payload);
  });
}

export async function queryStats(port, pattern = '', reset = false) {
  const request = Buffer.concat([encodeString(1, pattern), encodeBool(2, reset)]);
  const response = await grpcCall(port, '/v2ray.core.app.stats.command.StatsService/QueryStats', request);
  const stats = [];
  for (const f of decodeMessage(response)) {
    if (f.no !== 1 || f.wire !== 2) continue;
    const inner = decodeMessage(f.value);
    let name = '';
    let value = 0n;
    for (const g of inner) {
      if (g.no === 1 && g.wire === 2) name = g.value.toString('utf8');
      if (g.no === 2 && g.wire === 0) value = g.value;
    }
    if (name) stats.push({ name, value: Number(value) });
  }
  return stats;
}

export async function sysStats(port) {
  const response = await grpcCall(port, '/v2ray.core.app.stats.command.StatsService/GetSysStats', Buffer.alloc(0));
  const out = {};
  for (const f of decodeMessage(response)) {
    if (f.wire !== 0) continue;
    if (f.no === 1) out.uptime = Number(f.value);
    if (f.no === 2) out.goroutines = Number(f.value);
    if (f.no === 3) out.alloc = Number(f.value);
    if (f.no === 4) out.totalAlloc = Number(f.value);
    if (f.no === 5) out.sys = Number(f.value);
  }
  return out;
}

/**
 * Keep a per-stat cursor and turn the monotonic counters Xray reports into the
 * per-user deltas the panel stores.
 */
export class TrafficAccountant {
  constructor() {
    this.cursor = new Map();
    this.totals = { up: 0, down: 0 };
  }

  /**
   * @returns {{perUser: Map<string,{up:number,down:number}>, totals:{up:number,down:number}}}
   */
  ingest(stats) {
    const perUser = new Map();
    for (const { name, value } of stats) {
      const prev = this.cursor.get(name) || 0;
      const delta = value >= prev ? value - prev : value; // counter reset on restart
      this.cursor.set(name, value);
      if (delta <= 0) continue;
      const match = /^user>>>u-([a-z0-9]+)>>>traffic>>>(uplink|downlink)$/.exec(name);
      if (match) {
        const [, userId, dir] = match;
        const entry = perUser.get(userId) || { up: 0, down: 0 };
        if (dir === 'uplink') {
          entry.up += delta;
          this.totals.up += delta;
        } else {
          entry.down += delta;
          this.totals.down += delta;
        }
        perUser.set(userId, entry);
      }
    }
    return { perUser, totals: { ...this.totals } };
  }

  reset() {
    this.cursor.clear();
    this.totals = { up: 0, down: 0 };
  }
}
