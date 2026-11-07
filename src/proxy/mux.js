/**
 * The Railway TCP-proxy multiplexer.
 *
 * Railway grants exactly **one** public TCP port per service, so the panel
 * folds every TCP-based entry point into a single intelligent listener:
 *
 *   TLS ClientHello  → SNI based routing (REALITY / AnyTLS / FakeTLS MTProto)
 *   SOCKS5 greeting  → built-in SOCKS5 server        (t.me/socks)
 *   CONNECT / GET    → HTTP forward proxy            (http://user:pass@host:port)
 *   anything else    → MTProto obfuscated2           (tg://proxy)
 *
 * Without this, a Railway deployment could only offer one of Xray, sing-box or
 * the Telegram proxy.  With it, all of them share the same host:port.
 */
import net from 'node:net';
import { peekSni, classify, looksLikeMtproto } from './sni.js';

export class Mux {
  constructor({ socks5, httpProxy, resolvePlan, panelPort }) {
    this.socks5 = socks5;
    this.httpProxy = httpProxy;
    this.resolvePlan = resolvePlan; // () => plan
    this.panelPort = panelPort;
    this.server = null;
    this.stats = {
      total: 0,
      tls: 0,
      socks: 0,
      http: 0,
      mtproto: 0,
      xray: 0,
      singbox: 0,
      up: 0,
      down: 0,
      active: 0,
    };
  }

  listen(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.on('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        this.port = port;
        resolve(server.address());
      });
    });
  }

  close() {
    if (this.server) this.server.close();
  }

  state() {
    return {
      listening: Boolean(this.server && this.server.listening),
      ...this.stats,
      socks5: this.socks5.state(),
      http: { ...this.httpProxy.state(), ...this.stats.httpState },
    };
  }

  onConnection(socket) {
    this.stats.total += 1;
    this.stats.active += 1;
    socket.on('close', () => {
      this.stats.active = Math.max(0, this.stats.active - 1);
    });
    socket.on('error', () => {});
    socket.setNoDelay(true);

    const plan = this.resolvePlan();
    const onFirst = (chunk) => {
      socket.off('data', onFirst);
      socket.pause();
      try {
        this.routeFirst(socket, chunk, plan);
      } catch (err) {
        console.error('[mux] routing failed:', err.message);
        socket.destroy();
      }
    };
    socket.on('data', onFirst);
    setTimeout(() => {
      if (socket.readable && socket.bytesRead === 0) socket.destroy();
    }, 20000).unref?.();
  }

  routeFirst(socket, chunk, plan) {
    const kind = classify(chunk);
    if (kind === 'socks5') {
      this.stats.socks += 1;
      socket.resume();
      this.socks5.handle(socket, chunk);
      return;
    }
    if (kind === 'http-connect') {
      this.stats.http += 1;
      socket.resume();
      this.httpProxy.handle(socket, chunk);
      return;
    }
    if (kind === 'http') {
      this.stats.http += 1;
      socket.resume();
      this.toPanel(socket, chunk);
      return;
    }
    if (kind === 'tls') {
      this.stats.tls += 1;
      this.routeTls(socket, chunk, plan);
      return;
    }
    // Plain (non-TLS) traffic: MTProto and Shadowsocks look equally random, so
    // MTProto's obfuscated2 tag decides, and everything else goes to the
    // Shadowsocks inbound when one is enabled on the shared port.
    if (plan.mtprotoPort && looksLikeMtproto(chunk)) {
      this.stats.mtproto += 1;
      this.pipeTo(socket, chunk, plan.mtprotoPort, 'mtproto');
      return;
    }
    if (plan.opaquePort) {
      if (plan.opaqueCore === 'singbox') this.stats.singbox += 1;
      else this.stats.xray += 1;
      this.pipeTo(socket, chunk, plan.opaquePort, 'core');
      return;
    }
    if (plan.mtprotoPort) {
      this.stats.mtproto += 1;
      this.pipeTo(socket, chunk, plan.mtprotoPort, 'mtproto');
      return;
    }
    this.stats.dropped = (this.stats.dropped || 0) + 1;
    socket.destroy();
  }

  routeTls(socket, firstChunk, plan) {
    let buffer = firstChunk;
    const decide = () => {
      const info = peekSni(buffer);
      if (info && info.incomplete && buffer.length < 8192) return false;
      const sni = (info && info.sni) || '';
      let target = plan.sniMap[sni] || null;
      if (!target && plan.mtprotoFakeTls && sni === plan.mtprotoFakeTls) target = { port: plan.mtprotoPort, kind: 'mtproto' };
      if (!target && plan.defaultTls) target = plan.defaultTls;
      if (!target && plan.mtprotoPort) target = { port: plan.mtprotoPort, kind: 'mtproto' };
      if (!target) {
        socket.destroy();
        return true;
      }
      if (target.kind === 'mtproto') this.stats.mtproto += 1;
      else if (target.core === 'singbox') this.stats.singbox += 1;
      else this.stats.xray += 1;
      this.pipeTo(socket, buffer, target.port, target.kind);
      buffer = null;
      return true;
    };
    if (decide()) return;
    const onMore = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (decide()) socket.off('data', onMore);
    };
    socket.on('data', onMore);
    socket.resume();
    setTimeout(() => {
      socket.off('data', onMore);
    }, 10000).unref?.();
  }

  toPanel(socket, chunk) {
    // Never proxy into ourselves: if the panel port equals the mux port the
    // request would loop forever. The panel always listens somewhere else.
    if (!this.panelPort || this.panelPort === this.port) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: this.panelPort }, () => {
      upstream.write(chunk);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const cleanup = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    upstream.on('close', cleanup);
    socket.resume();
  }

  pipeTo(socket, chunk, port, kind) {
    if (!port) {
      socket.destroy();
      return;
    }
    socket.pause();
    const upstream = net.connect({ host: '127.0.0.1', port }, () => {
      if (chunk && chunk.length) upstream.write(chunk);
      socket.pipe(upstream);
      upstream.pipe(socket);
      socket.resume();
      socket.on('data', (d) => { this.stats.up += d.length; });
      upstream.on('data', (d) => { this.stats.down += d.length; });
    });
    const cleanup = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', () => {
      if (kind === 'mtproto') this.stats.mtproto -= 1;
      cleanup();
    });
    socket.on('error', cleanup);
    socket.on('close', cleanup);
    upstream.on('close', cleanup);
  }
}

/** Build the routing plan from the current document (cheap, memoised by caller). */
export function buildPlan(doc, { mtprotoPort, mtprotoEnabled, mtprotoFakeTls }) {
  const { describeInbound } = doc.__catalog || {};
  const inbounds = (doc.inbounds || []).map((ib) => (describeInbound ? describeInbound(ib) : ib)).filter(Boolean);
  const sniMap = {};
  const sniConflicts = [];
  let defaultTls = null;
  for (const ib of inbounds) {
    if (!ib.enabled || ib.edge !== 'tcp' || ib.udp) continue;
    const port = ib.port;
    const entry = { port, kind: ib.core || 'xray', core: ib.core, inboundId: ib.id, protocol: ib.protocol };
    const claim = (sni) => {
      if (!sni) return;
      const taken = sniMap[sni];
      // Two self-signed TLS inbounds on one port can only be told apart by SNI,
      // so a duplicate name would silently make one of them unreachable.
      if (taken && taken.inboundId !== entry.inboundId) {
        sniConflicts.push({ sni, kept: taken.inboundId, dropped: entry.inboundId, droppedLabel: ib.label });
        return;
      }
      sniMap[sni] = entry;
    };
    if (ib.security === 'reality') {
      const sni = String(ib.params.sni || String(ib.params.dest || '').split(':')[0] || '').toLowerCase();
      claim(sni);
      defaultTls = defaultTls || entry;
    } else if (ib.security === 'tls-self') {
      const sni = String(ib.params.sni || '').toLowerCase();
      claim(sni);
      defaultTls = defaultTls || entry;
    }
  }
  // One plain-TCP inbound (Shadowsocks) can share the port; it is picked with
  // the MTProto tag heuristic above.
  let opaquePort = 0;
  let opaqueCore = '';
  let opaqueInboundId = '';
  const opaqueConflicts = [];
  for (const ib of inbounds) {
    if (!ib.enabled || ib.edge !== 'tcp' || ib.udp) continue;
    if (ib.security === 'tls-self' || ib.security === 'reality') continue;
    if (ib.protocol !== 'shadowsocks') continue;
    if (opaquePort) {
      // Two TLS-less inbounds on one port cannot be told apart — the first wins.
      opaqueConflicts.push({ kept: opaqueInboundId, dropped: ib.id, droppedLabel: ib.label });
      continue;
    }
    opaquePort = ib.port;
    opaqueCore = ib.core || 'xray';
    opaqueInboundId = ib.id;
  }

  const conflicts = [];
  if (mtprotoEnabled && mtprotoFakeTls && sniMap[mtprotoFakeTls]) {
    conflicts.push(mtprotoFakeTls);
  }
  return {
    sniMap,
    conflicts,
    defaultTls,
    sniConflicts,
    opaqueConflicts,
    opaquePort,
    opaqueCore,
    opaqueInboundId,
    mtprotoPort: mtprotoEnabled ? mtprotoPort : 0,
    mtprotoFakeTls: (mtprotoFakeTls || '').toLowerCase(),
  };
}
