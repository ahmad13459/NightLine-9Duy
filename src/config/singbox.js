/**
 * sing-box configuration generator (server side).
 *
 * sing-box covers what Xray cannot: AnyTLS, ShadowTLS, Hysteria2, TUIC and
 * WireGuard.  On Railway only the TCP/HTTP reachable inbounds are useful, but
 * the UDP ones are still generated so a multi-node setup can consume them.
 */
import { routingSettings, serverSingboxRules, rulesAssets } from '../routing.js';
import { effectiveEnabled } from '../store.js';
import { describeInbound, edgePath, edgeServiceName } from '../catalog.js';
import { ssServerKey, legacySsPassword } from './shared.js';

export const SB_CLASH_PORT = 9091;
export const SB_V2RAY_API_PORT = 10086;

function tlsBlock(ib, ctx) {
  const params = ib.params || {};
  if (ib.security === 'reality') {
    const dest = params.dest || 'www.microsoft.com:443';
    return {
      enabled: true,
      server_name: params.sni || dest.split(':')[0],
      reality: {
        enabled: true,
        handshake: { server: dest.split(':')[0], server_port: Number(dest.split(':')[1] || 443) },
        private_key: ctx.reality.privateKey,
        short_id: String(params.shortIds || 'a1b2c3d4').split(',').map((x) => x.trim()).filter((x) => /^[0-9a-f]{2,16}$/.test(x))[0] || 'a1b2c3d4',
      },
    };
  }
  if (ib.security === 'tls-self' || ib.transport === 'quic') {
    return {
      enabled: true,
      server_name: params.sni || 'nightline.railway',
      alpn: ib.protocol === 'hysteria2' ? ['h3'] : ib.protocol === 'tuic' ? ['h3'] : ['h2', 'http/1.1'],
      certificate_path: ctx.certs.certificateFile || undefined,
      key_path: ctx.certs.keyFile || undefined,
    };
  }
  return undefined;
}

function transportBlock(ib) {
  const params = ib.params || {};
  const httpPath = ib.edge === 'http' ? edgePath(ib) : params.path || '/';
  if (ib.transport === 'ws') {
    return {
      type: 'ws',
      path: httpPath,
      ...(params.host ? { headers: { Host: params.host } } : {}),
    };
  }
  if (ib.transport === 'httpupgrade') {
    return { type: 'httpupgrade', path: httpPath, ...(params.host ? { host: params.host } : {}) };
  }
  if (ib.transport === 'grpc') {
    return { type: 'grpc', service_name: ib.edge === 'http' ? edgeServiceName(ib) : params.serviceName || 'grpc' };
  }
  return undefined;
}

function usersFor(ib, users, ctx) {
  const active = users.filter((u) => effectiveEnabled(u));
  const params = ib.params || {};
  if (ib.protocol === 'vless' || ib.protocol === 'vmess') {
    // sing-box 1.12+ rejects `flow` on inbound users ("json: unknown field"),
    // and inbound VTLS flow is not needed for a working tunnel anyway.
    return active.map((u) => ({ name: `u-${u.id}`, uuid: u.secrets.uuid }));
  }
  if (ib.protocol === 'trojan' || ib.protocol === 'anytls') {
    return active.map((u) => ({ name: `u-${u.id}`, password: u.secrets.password }));
  }
  if (ib.protocol === 'tuic') {
    return active.map((u) => ({
      name: `u-${u.id}`,
      uuid: u.secrets.uuid,
      password: u.secrets.password,
    }));
  }
  if (ib.protocol === 'hysteria2') {
    return active.map((u) => ({ name: `u-${u.id}`, password: u.secrets.password }));
  }
  if (ib.protocol === 'shadowsocks') {
    const method = params.method || '2022-blake3-aes-128-gcm';
    if (method.startsWith('2022-')) {
      return active.map((u) => ({
        name: `u-${u.id}`,
        password: method.endsWith('aes-256-gcm') ? u.secrets.ss256 : u.secrets.ss128,
      }));
    }
    return [{ name: 'shared', password: params.password || legacySsPassword(ctx.serverSecret, ib.id) }];
  }
  if (ib.protocol === 'shadowtls') {
    const method = params.method || '2022-blake3-aes-128-gcm';
    return active.map((u) => ({
      name: `u-${u.id}`,
      password: method.endsWith('aes-256-gcm') ? u.secrets.ss256 : u.secrets.ss128,
    }));
  }
  return [];
}

export function buildSingboxConfig({ doc, reality, certs, sharedSsPassword, serverSecret, logLevel = 'warn' }) {
  const ctx = { reality, certs, sharedSsPassword, serverSecret };
  const inbounds = [];
  const routes = [];
  const users = doc.users || [];
  const tags = [];

  for (const raw of doc.inbounds || []) {
    const ib = describeInbound(raw);
    if (!ib || !ib.enabled) continue;
    if (ib.core !== 'singbox') continue;
    const params = ib.params || {};
    const usersBlock = usersFor(ib, users, ctx);
    const base = {
      type: ib.protocol,
      tag: `ib-${ib.id}`,
      listen: '127.0.0.1',
      listen_port: ib.port,
    };
    let inbound = null;

    if (ib.protocol === 'vless' || ib.protocol === 'vmess' || ib.protocol === 'trojan') {
      inbound = { ...base, users: usersBlock };
      const transport = transportBlock(ib);
      if (transport) inbound.transport = transport;
      const tls = tlsBlock(ib, ctx);
      if (tls) inbound.tls = tls;
    } else if (ib.protocol === 'anytls') {
      inbound = { ...base, users: usersBlock, tls: tlsBlock(ib, ctx) };
    } else if (ib.protocol === 'shadowsocks') {
      inbound = {
        ...base,
        method: params.method || '2022-blake3-aes-128-gcm',
        ...(String(params.method || '').startsWith('2022-')
          ? { password: ssServerKey(ctx.serverSecret, ib.id, params.method) }
          : {}),
        users: usersBlock,
      };
    } else if (ib.protocol === 'shadowtls') {
      const method = params.method || '2022-blake3-aes-128-gcm';
      const detag = `ss-${ib.id}`;
      inbound = {
        ...base,
        version: 3,
        users: usersBlock,
        handshake: {
          server: (params.handshakeHost || 'www.cloudflare.com'),
          server_port: Number(params.handshakePort || 443),
        },
        detour: detag,
      };
      inbounds.push({
        type: 'shadowsocks',
        tag: detag,
        method,
        password: ssServerKey(ctx.serverSecret, ib.id, method),
        users: usersBlock.map((u) => ({ name: u.name, password: u.password })),
      });
      tags.push(detag);
    } else if (ib.protocol === 'hysteria2') {
      inbound = {
        ...base,
        users: usersBlock,
        ...(Number(params.upMbps) ? { up_mbps: Number(params.upMbps) } : {}),
        ...(Number(params.downMbps) ? { down_mbps: Number(params.downMbps) } : {}),
        ...(params.obfs ? { obfs: { type: 'salamander', password: params.obfs } } : {}),
        tls: tlsBlock(ib, ctx),
      };
    } else if (ib.protocol === 'tuic') {
      inbound = {
        ...base,
        users: usersBlock,
        congestion_control: params.congestion || 'bbr',
        tls: tlsBlock(ib, ctx),
      };
    } else if (ib.protocol === 'wireguard') {
      inbound = {
        type: 'wireguard',
        tag: `ib-${ib.id}`,
        listen: '127.0.0.1',
        listen_port: ib.port,
        address: [params.address || '10.77.0.1/24'],
        private_key: params.privateKey || ctx.sharedSsPassword.repeat(1).slice(0, 43),
        peers: [
          {
            public_key: params.peerPublicKey || '',
            allowed_ips: ['0.0.0.0/0', '::/0'],
          },
        ],
      };
    }

    if (!inbound) continue;
    inbounds.push(inbound);
    tags.push(inbound.tag);
    routes.push({
      routeKey: ib.routeKey,
      id: ib.id,
      edge: ib.edge,
      port: ib.port,
      transport: ib.transport,
      tag: inbound.tag,
      serviceName: '',
      kind: ib.protocol,
    });
  }

  const serverRules = serverSingboxRules(routingSettings(doc), rulesAssets());

  const config = {
    log: { level: logLevel, timestamp: true },
    inbounds,
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      auto_detect_interface: true,
      // Iranian block rules are enforced here, on the server (src/routing.js).
      ...(serverRules.ruleSets.length ? { rule_set: serverRules.ruleSets } : {}),
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, action: 'reject' },
        ...serverRules.rules,
      ],
      final: 'direct',
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${SB_CLASH_PORT}`,
        default_mode: 'rule',
      },
    },
  };

  return { config, routes };
}
