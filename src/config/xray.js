/**
 * Xray-core configuration generator.
 *
 * The panel never writes a static config: every change in the UI rebuilds this
 * document and hot-swaps the running core.
 */
import { routingSettings, serverXrayRules, rulesAssets } from '../routing.js';
import { effectiveEnabled } from '../store.js';
import { ssServerKey, legacySsPassword } from './shared.js';
import { describeInbound, edgePath, edgeServiceName } from '../catalog.js';

export const XRAY_API_PORT = 10085;

/** REALITY shortIds must be even-length lowercase hex (max 16 chars). */
export function normalizeShortIds(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{2,16}$/.test(s) && s.length % 2 === 0);
  return list.length ? list : ['a1b2c3d4'];
}

function clientEmail(user) {
  return `u-${user.id}`;
}

function streamSettings(ib, ctx) {
  const params = ib.params || {};
  const sec = ib.security;
  const stream = { network: ib.transport === 'tcp' ? 'tcp' : ib.transport };

  const httpPath = ib.edge === 'http' ? edgePath(ib) : params.path || '/';
  if (ib.transport === 'ws') {
    stream.wsSettings = {
      path: httpPath,
      headers: params.host ? { Host: params.host } : {},
    };
  } else if (ib.transport === 'httpupgrade') {
    stream.httpupgradeSettings = { path: httpPath, host: params.host || '' };
  } else if (ib.transport === 'xhttp') {
    stream.xhttpSettings = {
      path: httpPath,
      host: params.host || '',
      mode: params.mode || 'auto',
    };
  } else if (ib.transport === 'grpc') {
    stream.grpcSettings = { serviceName: ib.edge === 'http' ? edgeServiceName(ib) : params.serviceName || 'grpc' };
  }

  if (sec === 'reality') {
    const dest = params.dest || 'www.microsoft.com:443';
    const serverName = params.sni || dest.split(':')[0];
    stream.security = 'reality';
    stream.realitySettings = {
      show: false,
      dest,
      xver: 0,
      serverNames: [serverName],
      privateKey: ctx.reality.privateKey,
      shortIds: normalizeShortIds(params.shortIds),
      ...(params.fingerprint ? { fingerprint: params.fingerprint } : {}),
    };
  } else if (sec === 'tls-self') {
    stream.security = 'tls';
    stream.tlsSettings = {
      serverName: params.sni || 'nightline.railway',
      alpn: params.alpn ? String(params.alpn).split(',') : undefined,
      certificates:
        ctx.certs.certificateFile && ctx.certs.keyFile
          ? [{ certificateFile: ctx.certs.certificateFile, keyFile: ctx.certs.keyFile }]
          : undefined,
    };
  } else {
    stream.security = 'none';
  }
  return stream;
}

function buildSettings(ib, users, ctx) {
  const params = ib.params || {};
  const active = users.filter((u) => effectiveEnabled(u));

  if (ib.protocol === 'vless') {
    return {
      clients: active.map((u) => ({
        id: u.secrets.uuid,
        email: clientEmail(u),
        flow: ib.security === 'reality' && params.flow !== '' ? params.flow || 'xtls-rprx-vision' : '',
        limitIp: u.ipLimit || 0,
      })),
      decryption: 'none',
      fallbacks: [],
    };
  }
  if (ib.protocol === 'vmess') {
    return {
      clients: active.map((u) => ({
        id: u.secrets.uuid,
        email: clientEmail(u),
        alterId: 0,
        security: 'auto',
        level: 0,
      })),
    };
  }
  if (ib.protocol === 'trojan') {
    return {
      clients: active.map((u) => ({
        password: u.secrets.password,
        email: clientEmail(u),
        level: 0,
      })),
      fallbacks: [],
    };
  }
  if (ib.protocol === 'shadowsocks') {
    const method = params.method || '2022-blake3-aes-128-gcm';
    const multiuser = method.startsWith('2022-');
    if (multiuser) {
      return {
        method,
        // server PSK: required by both Xray and sing-box for SS-2022 multi-user
        password: ssServerKey(ctx.serverSecret, ib.id, method),
        clients: active.map((u) => ({
          password: method.endsWith('aes-256-gcm') ? u.secrets.ss256 : u.secrets.ss128,
          email: clientEmail(u),
        })),
        network: 'tcp,udp',
      };
    }
    return {
      method,
      password: params.password || legacySsPassword(ctx.serverSecret, ib.id),
      network: 'tcp,udp',
    };
  }
  return null;
}

function inboundObject(ib, users, ctx) {
  const settings = buildSettings(ib, users, ctx);
  if (!settings) return null;
  const inbound = {
    tag: `ib-${ib.id}`,
    listen: '127.0.0.1',
    port: ib.port,
    protocol: ib.protocol,
    settings,
    streamSettings: streamSettings(ib, ctx),
    sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
  };
  if (ib.protocol === 'shadowsocks' && (ib.params.method || '').startsWith('2022-')) {
    inbound.settings.network = 'tcp,udp';
  }
  return inbound;
}

export function buildXrayConfig({ doc, reality, certs, sharedSsPassword, serverSecret, logLevel = 'warning' }) {
  const inbounds = [];
  const routes = [];
  const users = doc.users || [];

  for (const raw of doc.inbounds || []) {
    const ib = describeInbound(raw);
    if (!ib || !ib.enabled) continue;
    if (ib.core !== 'xray') continue;
    if (ib.udp) continue; // no public UDP on Railway
    const obj = inboundObject(ib, users, { reality, certs, sharedSsPassword, serverSecret });
    if (!obj) continue;
    inbounds.push(obj);
    routes.push({
      routeKey: ib.routeKey,
      id: ib.id,
      edge: ib.edge,
      port: ib.port,
      transport: ib.transport,
      tag: obj.tag,
      serviceName: ib.params.serviceName || '',
      kind: ib.protocol,
    });
  }

  const routingRules = serverXrayRules(routingSettings(doc), rulesAssets());

  const config = {
    log: { loglevel: logLevel, access: 'none', error: '' },
    api: {
      tag: 'api',
      services: ['HandlerService', 'LoggerService', 'StatsService'],
    },
    stats: {},
    policy: {
      levels: {
        0: {
          statsUserUplink: true,
          statsUserDownlink: true,
          handshake: 6,
          connIdle: 240,
          uplinkOnly: 2,
          downlinkOnly: 4,
          bufferSize: 32,
        },
      },
      system: {
        statsInboundUplink: true,
        statsInboundDownlink: true,
        statsOutboundUplink: true,
        statsOutboundDownlink: true,
      },
    },
    inbounds: [
      {
        tag: 'api-in',
        listen: '127.0.0.1',
        port: XRAY_API_PORT,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
      },
      ...inbounds,
    ],
    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: {}, streamSettings: { sockopt: { domainStrategy: 'UseIPv4v6' } } },
      { tag: 'block', protocol: 'blackhole', settings: {} },
    ],
    routing: {
      // Iranian block rules are enforced here, on the server (src/routing.js).
      domainStrategy: routingRules.length ? 'IPIfNonMatch' : 'AsIs',
      rules: [
        // the api inbound must be routed first: its destination is 127.0.0.1
        { type: 'field', inboundTag: ['api-in'], outboundTag: 'api' },
        // Plain private ranges instead of `geoip:private`: that rule needs
        // geoip.dat next to the binary, and a missing dat file used to take the
        // whole core down ("failed to open geoip.dat").
        {
          type: 'field',
          ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'],
          outboundTag: 'block',
        },
        ...routingRules,
      ],
    },
  };

  return { config, routes };
}
