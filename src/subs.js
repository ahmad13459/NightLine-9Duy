/**
 * Subscription generators — the same multi-format delivery as the Cloudflare
 * edition: raw links, base64 (v2rayNG/NekoBox), full Xray JSON, full sing-box
 * JSON and Clash/Mihomo YAML.
 */
import { buildUserLinks } from './links.js';
import { certPin } from './config/certs.js';
import { userTotal } from './store.js';

export const REPO_URL = 'https://github.com/youdidking/NightLine-Railway';
const REPO_URL_INLINE = REPO_URL;

const SUB_HEADERS = {
  'profile-title': 'NIGHTLINE · FREE',
  'profile-update-interval': '12',
  'profile-web-page-url': REPO_URL_INLINE,
};

export function headerSet(brand = 'NIGHTLINE') {
  return { ...SUB_HEADERS, 'profile-title': `${brand} · FREE` };
}

export const FREE_LINE = 'FREE & NOT FOR SALE — selling this service is prohibited';
export const FREE_LINE_FA = 'رایگان است — فروش این سرویس ممنوع';

/** Days left before the account expires (null when it never expires). */
export function daysLeft(user) {
  if (!user.expiresAt) return null;
  return Math.max(0, Math.ceil((user.expiresAt - Date.now()) / 86_400_000));
}

/** Human summary used by subscriptions, headers and the portal. */
export function usageSummary(user) {
  const used = userTotal(user);
  const total = user.quotaBytes || 0;
  const remaining = total ? Math.max(0, total - used) : null;
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2);
  return {
    usedGb: gb(used),
    totalGb: total ? gb(total) : null,
    remainingGb: remaining === null ? null : gb(remaining),
    days: daysLeft(user),
    expires: user.expiresAt ? new Date(user.expiresAt).toISOString().slice(0, 10) : null,
  };
}

export function infoLine(doc, user) {
  const u = usageSummary(user);
  const quota = u.totalGb ? `${u.usedGb}GB / ${u.totalGb}GB` : `${u.usedGb}GB / unlimited`;
  const left = u.remainingGb ? `${u.remainingGb} GB` : 'unlimited';
  const days = u.days === null ? 'never' : `${u.days} day(s) left`;
  const exp = u.expires || 'never';
  return [
    `# NIGHTLINE · Railway · ${user.name}`,
    `# credits ${quota} · remaining ${left}`,
    `# valid until ${exp} · ${days}`,
    `# ${FREE_LINE}`,
    `# ${FREE_LINE_FA}`,
    `# source ${REPO_URL}`,
  ].join('\n');
}

export function plainText(doc, user) {
  const links = buildUserLinks(doc, user);
  return [infoLine(doc, user), ...links.map((l) => l.uri)].join('\n');
}

export function base64Sub(doc, user) {
  return Buffer.from(plainText(doc, user), 'utf8').toString('base64');
}

/* ── Xray client config ──────────────────────────────────────────────── */

function xrayOutbound(link) {
  const c = link.conn;
  const stream = { network: c.transport === 'tcp' ? 'tcp' : c.transport };
  if (c.security === 'reality') {
    stream.security = 'reality';
    stream.realitySettings = {
      serverName: c.sni,
      fingerprint: c.fingerprint,
      publicKey: c.publicKey,
      shortId: c.shortId,
      spiderX: '',
    };
  } else if (c.security === 'tls-edge' || c.security === 'tls-self') {
    stream.security = 'tls';
    stream.tlsSettings = {
      serverName: c.sni,
      fingerprint: c.fingerprint,
      alpn: c.security === 'tls-edge' ? c.alpn.split(',') : ['h2', 'http/1.1'],
    };
    if (c.security === 'tls-self') {
      // Our own certificate, pinned by hash: modern Xray removed `allowInsecure`.
      const pin = certPin();
      if (pin) stream.tlsSettings.pinnedPeerCertSha256 = pin;
      else stream.tlsSettings.allowInsecure = true;
    }
  } else {
    stream.security = 'none';
  }
  if (c.transport === 'ws') stream.wsSettings = { path: c.path, headers: { Host: c.hostHeader } };
  if (c.transport === 'httpupgrade') stream.httpupgradeSettings = { path: c.path, host: c.hostHeader };
  if (c.transport === 'xhttp') stream.xhttpSettings = { path: c.path, host: c.hostHeader, mode: 'auto' };
  if (c.transport === 'grpc') stream.grpcSettings = { serviceName: c.serviceName };

  const tag = link.label;
  if (c.protocol === 'vless') {
    return {
      tag,
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: c.host,
            port: Number(c.port),
            users: [{ id: link.uuid, encryption: 'none', flow: c.flow && c.security === 'reality' ? c.flow : '' }],
          },
        ],
      },
      streamSettings: stream,
    };
  }
  if (c.protocol === 'trojan') {
    return {
      tag,
      protocol: 'trojan',
      settings: { servers: [{ address: c.host, port: Number(c.port), password: link.password }] },
      streamSettings: stream,
    };
  }
  if (c.protocol === 'shadowsocks') {
    return {
      tag,
      protocol: 'shadowsocks',
      settings: {
        servers: [{ address: c.host, port: Number(c.port), method: c.extra.method, password: c.ssPassword }],
      },
    };
  }
  if (c.protocol === 'vmess') {
    stream.network = c.transport;
    return {
      tag,
      protocol: 'vmess',
      settings: {
        vnext: [
          {
            address: c.host,
            port: Number(c.port),
            users: [{ id: link.uuid, alterId: 0, security: 'auto' }],
          },
        ],
      },
      streamSettings: stream,
    };
  }
  return null;
}

export function xrayJson(doc, user) {
  const links = buildUserLinks(doc, user).filter((l) =>
    ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(l.protocol),
  );
  const outbounds = [];
  // NOTE: Xray removed the `fragment` outbound in current cores (`unknown config id:
  // fragment`), so fragmenting is only offered in the sing-box output. Xray users turn
  // on “Fragment” in v2rayNG / Hiddify / NekoBox instead.
  for (const link of links) {
    const ob = xrayOutbound({ ...link, uuid: user.secrets.uuid, password: user.secrets.password });
    if (ob) outbounds.push(ob);
  }
  outbounds.push({ tag: 'direct', protocol: 'freedom', settings: {} });
  outbounds.push({ tag: 'block', protocol: 'blackhole', settings: {} });
  return {
    remarks: `NIGHTLINE · Railway · ${user.name}`,
    log: { loglevel: 'warning' },
    dns: {
      // DoH first: plain UDP:53 is hijacked by most Iranian ISPs
      servers: ['https+local://1.1.1.1/dns-query', 'https+local://8.8.8.8/dns-query', 'localhost'],
      queryStrategy: 'UseIPv4',
    },
    inbounds: [
      { tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true } },
      { tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http', settings: {} },
    ],
    outbounds,
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        // literal private ranges — a `geoip:private` rule needs geoip.dat beside the
        // binary and kills the whole client config when that file is absent
        {
          type: 'field',
          ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'],
          outboundTag: 'direct',
        },
        { type: 'field', network: 'tcp,udp', outboundTag: outbounds[0]?.tag || 'direct' },
      ],
    },
  };
}

/* ── sing-box client config ──────────────────────────────────────────── */

function singboxOutbound(link, user, opts = {}) {
  const c = link.conn;
  // sing-box takes a plain boolean here (the length/interval knobs of other
  // clients do not exist in the schema), and it splits the ClientHello for us.
  const tlsFrag = () => (opts.fragment === false ? {} : { fragment: true });
  const tls = (insecure = false) => {
    if (c.security === 'reality') {
      return {
        enabled: true,
        server_name: c.sni,
        utls: { enabled: true, fingerprint: c.fingerprint },
        reality: { enabled: true, public_key: c.publicKey, short_id: c.shortId },
      };
    }
    return {
      enabled: true,
      server_name: c.sni,
      insecure: insecure || c.security === 'tls-self',
      utls: { enabled: true, fingerprint: c.fingerprint },
      ...(c.security === 'tls-edge' ? { alpn: String(c.alpn || 'http/1.1').split(',') } : {}),
      ...tlsFrag(),
    };
  };
  const base = { tag: link.label, server: c.host, server_port: Number(c.port) };
  const transport = () => {
    if (c.transport === 'ws') return { type: 'ws', path: c.path, headers: { Host: c.hostHeader } };
    if (c.transport === 'httpupgrade') return { type: 'httpupgrade', path: c.path, host: c.hostHeader };
    if (c.transport === 'grpc') return { type: 'grpc', service_name: c.serviceName };
    return undefined;
  };
  switch (c.protocol) {
    case 'vless': {
      const ob = {
        type: 'vless',
        ...base,
        uuid: user.secrets.uuid,
        ...(c.security === 'reality' && c.flow ? { flow: c.flow } : {}),
        tls: c.security === 'none' ? undefined : tls(),
      };
      const t = transport();
      if (t) ob.transport = t;
      return ob;
    }
    case 'vmess': {
      const ob = { type: 'vmess', ...base, uuid: user.secrets.uuid, security: 'auto', tls: c.security === 'none' ? undefined : tls() };
      const t = transport();
      if (t) ob.transport = t;
      return ob;
    }
    case 'trojan': {
      const ob = { type: 'trojan', ...base, password: user.secrets.password, tls: tls() };
      const t = transport();
      if (t) ob.transport = t;
      return ob;
    }
    case 'shadowsocks':
      return { type: 'shadowsocks', ...base, method: c.extra.method, password: c.ssPassword };
    case 'anytls':
      return { type: 'anytls', ...base, password: user.secrets.password, tls: tls(true) };
    case 'hysteria2':
      return {
        type: 'hysteria2',
        ...base,
        password: user.secrets.password,
        tls: { enabled: true, server_name: c.sni, insecure: true, alpn: ['h3'] },
        ...(c.extra.obfs ? { obfs: { type: 'salamander', password: c.extra.obfs } } : {}),
      };
    case 'tuic':
      return {
        type: 'tuic',
        ...base,
        uuid: user.secrets.uuid,
        password: user.secrets.password,
        congestion_control: c.extra.congestion || 'bbr',
        tls: { enabled: true, server_name: c.sni, insecure: true, alpn: ['h3'] },
      };
    default:
      return null;
  }
}

export function singboxJson(doc, user) {
  const links = buildUserLinks(doc, user);
  const outbounds = links
    .map((l) => singboxOutbound(l, user, doc.settings || {}))
    .filter(Boolean);
  const tags = outbounds.map((o) => o.tag);
  const sbsDns = singboxDns(route);
  const ruleSets = singboxRuleSets(route);
  return {
    log: { level: 'warn', timestamp: true },
    dns: {
      // sing-box 1.12+ DNS server format. No `detour`: sing-box refuses a detour
      // into an empty direct outbound, and tunnelling DNS would kill the client
      // whenever the server is unreachable.
      servers: [
        { type: 'https', tag: 'cloudflare', server: '1.1.1.1' },
        { type: 'https', tag: 'google', server: '8.8.8.8' },
        { type: 'local', tag: 'local' },
      ],
      rules: [{ domain_suffix: ['.ir'], server: 'local' }],
      final: 'cloudflare',
    },
    inbounds: [
      { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 },
    ],
    outbounds: [...outbounds, { type: 'direct', tag: 'direct' }, { type: 'block', tag: 'block' }],
    route: {
      rules: [
        { action: 'sniff' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, action: 'reject' },
        { clash_mode: 'direct', outbound: 'direct' },
        { clash_mode: 'global', outbound: tags[0] || 'direct' },
      ],
      final: tags[0] || 'direct',
      auto_detect_interface: true,
      default_domain_resolver: 'local',
    },
    experimental: { cache_file: { enabled: true, path: 'cache.db' } },
  };
}

/* ── Clash / Mihomo YAML ─────────────────────────────────────────────── */

function yamlStr(value) {
  const s = String(value ?? '');
  if (/^[A-Za-z0-9_.:\/+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

export function clashYaml(doc, user) {
  const links = buildUserLinks(doc, user);
  const lines = [];
  const names = [];
  lines.push('port: 7890', 'socks-port: 7891', 'allow-lan: true', 'mode: rule', 'log-level: warning', '');
  lines.push('proxies:');
  for (const link of links) {
    const c = link.conn;
    const name = link.label;
    const common = [`name: ${yamlStr(name)}`, `type: ${c.protocol === 'shadowsocks' ? 'ss' : c.protocol}`];
    common.push(`server: ${yamlStr(c.host)}`, `port: ${c.port}`);
    let ok = true;
    if (c.protocol === 'vless') {
      common.push(`uuid: ${yamlStr(user.secrets.uuid)}`);
      if (c.flow) common.push(`flow: ${yamlStr(c.flow)}`);
      common.push('udp: true');
    } else if (c.protocol === 'vmess') {
      common.push(`uuid: ${yamlStr(user.secrets.uuid)}`, 'alterId: 0', 'cipher: auto', 'udp: true');
    } else if (c.protocol === 'trojan') {
      common.push(`password: ${yamlStr(user.secrets.password)}`, 'udp: true');
    } else if (c.protocol === 'shadowsocks') {
      common.push(`cipher: ${yamlStr(c.extra.method)}`, `password: ${yamlStr(c.ssPassword)}`, 'udp: true');
    } else if (c.protocol === 'anytls') {
      common.push(`password: ${yamlStr(user.secrets.password)}`);
    } else if (c.protocol === 'hysteria2') {
      common.push(`password: ${yamlStr(user.secrets.password)}`);
    } else if (c.protocol === 'tuic') {
      common.push(`uuid: ${yamlStr(user.secrets.uuid)}`, `password: ${yamlStr(user.secrets.password)}`, 'congestion-controller: bbr');
    } else {
      ok = false;
    }
    if (!ok) continue;
    if (c.security === 'reality') {
      common.push(
        'tls: true',
        'servername: ' + yamlStr(c.sni),
        'client-fingerprint: ' + yamlStr(c.fingerprint),
        'reality-opts:',
        '  public-key: ' + yamlStr(c.publicKey),
        '  short-id: ' + yamlStr(c.shortId),
      );
    } else if (c.security !== 'none') {
      common.push('tls: true', 'servername: ' + yamlStr(c.sni), 'skip-cert-verify: true');
      if (c.security === 'tls-edge') common.push('alpn:', ...String(c.alpn || 'http/1.1').split(',').map((a) => `  - ${a.trim()}`));
    }
    if (c.transport === 'ws') {
      common.push('network: ws', 'ws-opts:', `  path: ${yamlStr(c.path)}`, '  headers:', `    Host: ${yamlStr(c.hostHeader)}`);
    } else if (c.transport === 'grpc') {
      common.push('network: grpc', 'grpc-opts:', `  grpc-service-name: ${yamlStr(c.serviceName)}`);
    }
    lines.push('  - ' + common.join('\n    '));
    names.push(name);
  }
  if (!names.length) lines.push('  []');
  lines.push('');
  lines.push('proxy-groups:');
  lines.push('  - name: "NIGHTLINE"');
  lines.push('    type: select');
  lines.push('    proxies:');
  for (const n of names) lines.push(`      - ${yamlStr(n)}`);
  if (!names.length) lines.push('      - DIRECT');
  lines.push('      - DIRECT');
  lines.push('');
  const providers = clashProviders(route);
  if (Object.keys(providers).length) {
    lines.push('rule-providers:');
    for (const [key, p] of Object.entries(providers)) {
      lines.push(
        `  ${key}:`,
        `    type: ${p.type}`,
        `    behavior: ${p.behavior}`,
        `    format: ${p.format}`,
        `    url: "${p.url}"`,
        `    path: ${p.path}`,
        `    interval: ${p.interval}`,
      );
    }
    lines.push('');
  }
  lines.push('rules:');
  for (const rule of clashRules(route)) lines.push(`  - ${rule}`);
  lines.push('  - MATCH,NIGHTLINE');
  return lines.join('\n') + '\n';
}

export function buildSub(doc, user, format) {
  switch (format) {
    case 'links':
      return { body: plainText(doc, user), type: 'text/plain; charset=utf-8' };
    case 'xray':
      return { body: JSON.stringify(xrayJson(doc, user), null, 2), type: 'application/json; charset=utf-8' };
    case 'singbox':
      return { body: JSON.stringify(singboxJson(doc, user), null, 2), type: 'application/json; charset=utf-8' };
    case 'clash':
      return { body: clashYaml(doc, user), type: 'text/yaml; charset=utf-8' };
    case 'base64':
    default:
      return { body: base64Sub(doc, user), type: 'text/plain; charset=utf-8' };
  }
}
