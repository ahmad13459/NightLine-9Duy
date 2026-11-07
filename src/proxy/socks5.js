/**
 * SOCKS5 server — this is the "t.me/socks" flavour of Telegram proxying.
 *
 * Telegram clients understand username/password SOCKS5 proxies, so the panel
 * exposes this listener on the Railway TCP proxy port (multiplexed, see mux.js)
 * and hands out ready `https://t.me/socks?...` links.
 */
import net from 'node:net';
import { EventEmitter } from 'node:events';

const CMD = { CONNECT: 0x01, BIND: 0x02, UDP: 0x03 };
const ATYP = { IPV4: 0x01, DOMAIN: 0x03, IPV6: 0x04 };

export class Socks5Server extends EventEmitter {
  constructor({ getUser }) {
    super();
    this.getUser = getUser; // () => {user, pass} | null
    this.stats = { conns: 0, active: 0, up: 0, down: 0, denied: 0 };
  }

  state() {
    return { ...this.stats };
  }

  /** Handle one already-accepted socket (called by the mux). */
  handle(socket, firstChunk) {
    let buffer = firstChunk && firstChunk.length ? firstChunk : Buffer.alloc(0);
    let stage = 'greeting';
    let pending = null;
    let upstream = null;
    const auth = this.getUser();

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      step();
    };

    const detach = () => {
      socket.off('data', onData);
    };

    const fail = () => {
      detach();
      this.stats.denied += 1;
      try { socket.destroy(); } catch { /* ignore */ }
    };

    const step = () => {
      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const nmethods = buffer[1];
        if (buffer.length < 2 + nmethods) return;
        const methods = [...buffer.subarray(2, 2 + nmethods)];
        buffer = buffer.subarray(2 + nmethods);
        const needAuth = Boolean(auth && auth.user);
        socket.write(Buffer.from([0x05, needAuth ? 0x02 : 0x00]));
        stage = needAuth ? 'auth' : 'request';
        step();
        return;
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const ulen = buffer[1];
        if (buffer.length < 2 + ulen + 1) return;
        const plen = buffer[2 + ulen];
        if (buffer.length < 3 + ulen + plen) return;
        const user = buffer.subarray(2, 2 + ulen).toString();
        const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
        buffer = buffer.subarray(3 + ulen + plen);
        if (user === auth.user && pass === auth.pass) {
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 'request';
          step();
        } else {
          socket.write(Buffer.from([0x01, 0x01]));
          fail();
        }
        return;
      }
      if (stage === 'request') {
        if (buffer.length < 5) return;
        const ver = buffer[0];
        const cmd = buffer[1];
        const atyp = buffer[3];
        if (ver !== 0x05) return fail();
        let offset = 4;
        let host = '';
        if (atyp === ATYP.IPV4) {
          if (buffer.length < offset + 4 + 2) return;
          host = [...buffer.subarray(offset, offset + 4)].join('.');
          offset += 4;
        } else if (atyp === ATYP.IPV6) {
          if (buffer.length < offset + 16 + 2) return;
          const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(buffer.readUInt16BE(offset + i).toString(16));
          host = parts.join(':');
          offset += 16;
        } else if (atyp === ATYP.DOMAIN) {
          const len = buffer[offset];
          if (buffer.length < offset + 1 + len + 2) return;
          host = buffer.subarray(offset + 1, offset + 1 + len).toString();
          offset += 1 + len;
        } else {
          return fail();
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        if (cmd !== CMD.CONNECT) {
          // UDP ASSOCIATE/BIND are not offered: Telegram's SOCKS mode only uses CONNECT.
          socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return fail();
        }
        stage = 'relay';
        detach();
        this.connect(socket, host, port, buffer);
      }
    };

    socket.on('data', onData);
    socket.on('error', () => {});
    step();
    return null;
  }

  connect(client, host, port, rest) {
    const upstream = net.connect({ host, port }, () => {
      this.stats.conns += 1;
      this.stats.active += 1;
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      if (rest && rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('data', (d) => { this.stats.up += d.length; });
      upstream.on('data', (d) => { this.stats.down += d.length; });
    });
    const cleanup = () => {
      this.stats.active = Math.max(0, this.stats.active - 1);
      try { client.destroy(); } catch { /* ignore */ }
      try { upstream.destroy(); } catch { /* ignore */ }
    };
    upstream.on('error', () => {
      try { client.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch { /* ignore */ }
      cleanup();
    });
    client.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
  }
}
