/**
 * NIGHTLINE · Railway Edition — protocol catalogue
 *
 * Every entry describes one "inbound recipe": which core runs it, which
 * transport + security it speaks and how it can actually reach the internet
 * from a Railway container.
 *
 *   edge: 'http' → reaches clients through the public HTTPS port (Railway edge
 *                  terminates TLS, we route by path / ALPN inside the panel)
 *   edge: 'tcp'  → reaches clients through the single Railway TCP proxy port.
 *                  The panel multiplexes TLS-SNI / SOCKS5 / HTTP / MTProto on
 *                  that one port (see src/proxy/mux.js).
 *   tier: 'verified' → confirmed end-to-end through a real Railway TCP proxy; on
 *                  by default and the only recipes the panel links by default.
 *   tier: 'lab'  → kept for custom domains / experiments; never enabled on a
 *                  fresh install because it was not reproducible on the edge.
 *   udp: true    → needs public UDP ingress, which Railway does not provide.
 *                  The recipe stays available (config + links are generated)
 *                  but the panel marks it unusable on this host.
 */
import { uid } from './store.js';

export const CORES = {
  xray: {
    id: 'xray',
    name: 'Xray-core',
    bin: 'xray',
    note: { fa: 'هستهٔ اصلی؛ REALITY، XHTTP و XTLS را کامل پوشش می‌دهد', en: 'Primary core: full REALITY, XHTTP and XTLS coverage' },
  },
  singbox: {
    id: 'singbox',
    name: 'sing-box',
    bin: 'sing-box',
    note: { fa: 'هستهٔ دوم؛ AnyTLS، ShadowTLS، Hysteria2 و TUIC', en: 'Second core: AnyTLS, ShadowTLS, Hysteria2, TUIC' },
  },
};

const F = {
  path: { key: 'path', type: 'text', mono: true, label: { fa: 'مسیر (Path)', en: 'Path' } },
  host: { key: 'host', type: 'text', mono: true, label: { fa: 'Host هدر', en: 'Host header' } },
  sni: { key: 'sni', type: 'text', mono: true, label: { fa: 'SNI / نام سرور', en: 'SNI / server name' } },
  serviceName: { key: 'serviceName', type: 'text', mono: true, label: { fa: 'نام سرویس gRPC', en: 'gRPC service name' } },
  dest: { key: 'dest', type: 'text', mono: true, label: { fa: 'مقصد REALITY', en: 'REALITY destination' } },
  shortIds: { key: 'shortIds', type: 'text', mono: true, label: { fa: 'ShortIds (با کاما)', en: 'ShortIds (comma)' } },
  flow: { key: 'flow', type: 'select', options: ['xtls-rprx-vision', ''], label: { fa: 'Flow', en: 'Flow' } },
  method: {
    key: 'method',
    type: 'select',
    options: ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', 'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'none'],
    label: { fa: 'متد رمزنگاری', en: 'Cipher method' },
  },
  version: { key: 'version', type: 'select', options: ['1', '2'], label: { fa: 'نسخهٔ ShadowTLS', en: 'ShadowTLS version' } },
  congestion: { key: 'congestion', type: 'text', mono: true, label: { fa: 'کنترل ازدحام', en: 'Congestion control' } },
  upMbps: { key: 'upMbps', type: 'number', label: { fa: 'پهنای‌باند آپ (Mbps)', en: 'Upstream Mbps' } },
  downMbps: { key: 'downMbps', type: 'number', label: { fa: 'پهنای‌باند دان (Mbps)', en: 'Downstream Mbps' } },
  obfs: { key: 'obfs', type: 'text', mono: true, label: { fa: 'رمز پوشش', en: 'Obfs password' } },
};

/** @type {Array<object>} */
export const PRESETS = [
  /* ── Xray · HTTP edge (Railway TLS termination) ─────────────────────── */
  {
    id: 'vless-ws',
    tier: 'lab',
    core: 'xray',
    protocol: 'vless',
    transport: 'ws',
    security: 'tls-edge',
    edge: 'http',
    udp: false,
    featured: true,
    title: { fa: 'VLESS + WebSocket', en: 'VLESS + WebSocket' },
    desc: {
      fa: 'سازگارترین گزینه؛ از پورت ۴۴۳ ریلوی با TLS خودِ لبه عبور می‌کند و در همهٔ کلاینت‌ها کار می‌کند.',
      en: 'The most compatible recipe: rides Railway edge TLS on :443 and works in every client.',
    },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'vless-httpupgrade',
    tier: 'lab',
    core: 'xray',
    protocol: 'vless',
    transport: 'httpupgrade',
    security: 'tls-edge',
    edge: 'http',
    udp: false,
    title: { fa: 'VLESS + HTTPUpgrade', en: 'VLESS + HTTPUpgrade' },
    desc: {
      fa: 'ارتقای HTTP سبک‌تر از WS با مصرف کمتر؛ همان مسیر امن لبه.',
      en: 'A lighter upgrade handshake than WS, same edge path.',
    },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'vless-xhttp',
    tier: 'lab',
    core: 'xray',
    protocol: 'vless',
    transport: 'xhttp',
    security: 'tls-edge',
    edge: 'http',
    udp: false,
    title: { fa: 'VLESS + XHTTP', en: 'VLESS + XHTTP' },
    desc: {
      fa: 'حمل‌ونقل نسل جدید Xray (SplitHTTP) برای شبکه‌های سخت؛ از CDN و لبهٔ HTTP عبور می‌کند.',
      en: 'Xray next-gen SplitHTTP transport for hostile networks; passes CDN and HTTP edges.',
    },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'vless-grpc',
    tier: 'lab',
    core: 'xray',
    protocol: 'vless',
    transport: 'grpc',
    security: 'tls-edge',
    edge: 'http',
    udp: false,
    note: { fa: 'به پشتیبانی HTTP/2 در لبهٔ ریلوی وابسته است', en: 'Depends on HTTP/2 support at the Railway edge' },
    title: { fa: 'VLESS + gRPC', en: 'VLESS + gRPC' },
    desc: {
      fa: 'tunnel روی HTTP/2؛ برای کلاینت‌هایی که gRPC را بهتر از WS عبور می‌دهند.',
      en: 'HTTP/2 tunnel for clients that carry gRPC better than WS.',
    },
    defaults: { serviceName: 'grpcnl' },
    fields: ['serviceName'],
  },
  {
    id: 'vmess-ws',
    tier: 'lab',
    core: 'xray',
    protocol: 'vmess',
    transport: 'ws',
    security: 'tls-edge',
    edge: 'http',
    udp: true,
    paused: true,
    title: { fa: 'VMess + WebSocket', en: 'VMess + WebSocket' },
    desc: { fa: 'پروتکل کلاسیک VMess روی WS برای کلاینت‌های قدیمی.', en: 'Classic VMess over WS for legacy clients.' },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'vmess-grpc',
    tier: 'lab',
    core: 'xray',
    protocol: 'vmess',
    transport: 'grpc',
    security: 'tls-edge',
    edge: 'http',
    title: { fa: 'VMess + gRPC', en: 'VMess + gRPC' },
    desc: { fa: 'VMess روی HTTP/2.', en: 'VMess over HTTP/2.' },
    defaults: { serviceName: 'grpcvm' },
    fields: ['serviceName'],
  },
  {
    id: 'trojan-ws',
    tier: 'lab',
    core: 'xray',
    protocol: 'trojan',
    transport: 'ws',
    security: 'tls-edge',
    edge: 'http',
    title: { fa: 'Trojan + WebSocket', en: 'Trojan + WebSocket' },
    desc: { fa: 'تروجان با رمز اختصاصی هر کاربر روی WS.', en: 'Trojan with a per-user password over WS.' },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'trojan-grpc',
    tier: 'lab',
    core: 'xray',
    protocol: 'trojan',
    transport: 'grpc',
    security: 'tls-edge',
    edge: 'http',
    title: { fa: 'Trojan + gRPC', en: 'Trojan + gRPC' },
    desc: { fa: 'تروجان روی HTTP/2.', en: 'Trojan over HTTP/2.' },
    defaults: { serviceName: 'grpctr' },
    fields: ['serviceName'],
  },

  /* ── Xray · TCP proxy edge ──────────────────────────────────────────── */
  {
    id: 'vless-reality',
    tier: 'verified',
    core: 'xray',
    protocol: 'vless',
    transport: 'tcp',
    security: 'reality',
    edge: 'tcp',
    udp: false,
    featured: true,
    title: { fa: 'VLESS + REALITY (Vision)', en: 'VLESS + REALITY (Vision)' },
    desc: {
      fa: 'قوی‌ترین گزینهٔ ضد‌فیلتر: دست‌دادن TLS واقعی با گواهی سایت مقصد، بدون نیاز به دامنهٔ خودی.',
      en: 'The strongest anti-censorship option: real TLS handshake borrowed from the destination site.',
    },
    defaults: { dest: 'www.microsoft.com:443', shortIds: 'a1b2c3d4,9f8e7d6c5b4a', flow: 'xtls-rprx-vision' },
    fields: ['dest', 'shortIds'],
  },
  {
    id: 'vless-tcp',
    tier: 'lab',
    core: 'xray',
    protocol: 'vless',
    transport: 'tcp',
    security: 'none',
    edge: 'tcp',
    title: { fa: 'VLESS خام (بدون TLS)', en: 'Raw VLESS (no TLS)' },
    desc: { fa: 'سبک‌ترین حالت روی پورت TCP؛ فقط وقتی مسیر شما TLS را مشکل می‌کند.', en: 'Lightest mode on the TCP port; only when TLS itself is the problem.' },
    defaults: {},
    fields: [],
  },
  {
    id: 'vmess-tcp',
    tier: 'lab',
    core: 'xray',
    protocol: 'vmess',
    transport: 'tcp',
    security: 'none',
    edge: 'tcp',
    title: { fa: 'VMess خام', en: 'Raw VMess' },
    desc: { fa: 'VMess بدون TLS روی پورت TCP.', en: 'VMess without TLS on the TCP port.' },
    defaults: {},
    fields: [],
  },
  {
    id: 'trojan-tcp-tls',
    tier: 'lab',
    core: 'xray',
    protocol: 'trojan',
    transport: 'tcp',
    security: 'tls-self',
    edge: 'tcp',
    title: { fa: 'Trojan + TLS خودامضا', en: 'Trojan + self-signed TLS' },
    desc: {
      fa: 'TLS با گواهی خودامضا روی پورت TCP؛ گواهی در کلاینت پین می‌شود.',
      en: 'Self-signed TLS on the TCP port; the certificate is pinned by the client.',
    },
    defaults: { sni: 'aws.amazon.com' },
    fields: ['sni'],
  },
  {
    id: 'ss-2022',
    tier: 'verified',
    core: 'xray',
    protocol: 'shadowsocks',
    transport: 'tcp',
    security: 'none',
    edge: 'tcp',
    title: { fa: 'Shadowsocks 2022', en: 'Shadowsocks 2022' },
    desc: { fa: 'SS-2022 با کلید اختصاصی هر کاربر؛ سریع و کم‌هزینه.', en: 'SS-2022 with a per-user key: fast and cheap.' },
    defaults: { method: '2022-blake3-aes-128-gcm' },
    fields: ['method'],
  },
  {
    id: 'ss-legacy',
    tier: 'lab',
    core: 'xray',
    protocol: 'shadowsocks',
    transport: 'tcp',
    security: 'none',
    edge: 'tcp',
    title: { fa: 'Shadowsocks (AEAD)', en: 'Shadowsocks (AEAD)' },
    desc: { fa: 'SS کلاسیک AEAD برای سازگاری با کلاینت‌های قدیمی.', en: 'Classic AEAD SS for older clients.' },
    defaults: { method: 'chacha20-ietf-poly1305' },
    fields: ['method'],
  },

  /* ── sing-box · HTTP edge ───────────────────────────────────────────── */
  {
    id: 'sb-vless-ws',
    tier: 'lab',
    core: 'singbox',
    protocol: 'vless',
    transport: 'ws',
    security: 'tls-edge',
    edge: 'http',
    title: { fa: 'VLESS + WS (sing-box)', en: 'VLESS + WS (sing-box)' },
    desc: { fa: 'همان تونل WS اما با هستهٔ sing-box؛ مسیر دوم برای تنوع.', en: 'Same WS tunnel served by sing-box: a second path.' },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'sb-trojan-ws',
    tier: 'lab',
    core: 'singbox',
    protocol: 'trojan',
    transport: 'ws',
    security: 'tls-edge',
    edge: 'http',
    title: { fa: 'Trojan + WS (sing-box)', en: 'Trojan + WS (sing-box)' },
    desc: { fa: 'تروجان روی WS با هستهٔ sing-box.', en: 'Trojan over WS on sing-box.' },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },
  {
    id: 'sb-vmess-ws',
    tier: 'lab',
    core: 'singbox',
    protocol: 'vmess',
    transport: 'ws',
    security: 'tls-edge',
    edge: 'http',
    title: { fa: 'VMess + WS (sing-box)', en: 'VMess + WS (sing-box)' },
    desc: { fa: 'VMess روی WS با هستهٔ sing-box.', en: 'VMess over WS on sing-box.' },
    defaults: { path: '/', host: '' },
    fields: ['path', 'host'],
  },

  /* ── sing-box · TCP proxy edge ──────────────────────────────────────── */
  {
    id: 'anytls',
    tier: 'verified',
    core: 'singbox',
    protocol: 'anytls',
    transport: 'tcp',
    security: 'tls-self',
    edge: 'tcp',
    featured: true,
    title: { fa: 'AnyTLS', en: 'AnyTLS' },
    desc: {
      fa: 'پروتکل جدید ضد‌فیلتر با پدینگ هوشمند؛ روی پورت TCP با TLS خودامضا.',
      en: 'Modern padding-based anti-censorship protocol on the TCP port with self-signed TLS.',
    },
    // Every self-signed TLS inbound on the shared port needs its own SNI — that
    // is the only thing the multiplexer can route on.
    defaults: { sni: 'www.apple.com' },
    fields: ['sni'],
  },
  {
    id: 'shadowtls',
    tier: 'lab',
    core: 'singbox',
    protocol: 'shadowtls',
    transport: 'tcp',
    security: 'tls-self',
    edge: 'tcp',
    title: { fa: 'ShadowTLS v3', en: 'ShadowTLS v3' },
    desc: { fa: 'پوشش TLS کاملاً واقعی روی SS؛ برای عبور از DPI.', en: 'Real-looking TLS wrapper around SS for DPI evasion.' },
    defaults: { version: '3', method: '2022-blake3-aes-128-gcm' },
    fields: ['method'],
  },
  {
    id: 'sb-ss-2022',
    tier: 'lab',
    core: 'singbox',
    protocol: 'shadowsocks',
    transport: 'tcp',
    security: 'none',
    edge: 'tcp',
    title: { fa: 'Shadowsocks 2022 (sing-box)', en: 'Shadowsocks 2022 (sing-box)' },
    desc: { fa: 'SS-2022 با هستهٔ sing-box.', en: 'SS-2022 on sing-box.' },
    defaults: { method: '2022-blake3-aes-128-gcm' },
    fields: ['method'],
  },
  {
    id: 'sb-vless-reality',
    tier: 'lab',
    core: 'singbox',
    protocol: 'vless',
    transport: 'tcp',
    security: 'reality',
    edge: 'tcp',
    title: { fa: 'VLESS + REALITY (sing-box)', en: 'VLESS + REALITY (sing-box)' },
    desc: { fa: 'REALITY روی هستهٔ sing-box؛ مسیر پشتیبان برای REALITY.', en: 'REALITY on sing-box: a backup REALITY path.' },
    defaults: { dest: 'www.microsoft.com:443', shortIds: 'a1b2c3d4', flow: '' },
    fields: ['dest', 'shortIds'],
  },

  /* ── UDP-only (config + links are produced, Railway cannot expose them) ─ */
  {
    id: 'hysteria2',
    tier: 'lab',
    core: 'singbox',
    protocol: 'hysteria2',
    transport: 'quic',
    security: 'tls-self',
    edge: 'udp',
    udp: true,
    title: { fa: 'Hysteria2', en: 'Hysteria2' },
    desc: {
      fa: 'پرسرعت‌ترین روی شبکهٔ بد اما فقط UDP؛ ریلوی UDP عمومی نمی‌دهد.',
      en: 'Fastest on bad networks, but UDP-only; Railway exposes no public UDP.',
    },
    defaults: { obfs: '', upMbps: 0, downMbps: 0 },
    fields: ['obfs', 'upMbps', 'downMbps'],
  },
  {
    id: 'tuic',
    tier: 'lab',
    core: 'singbox',
    protocol: 'tuic',
    transport: 'quic',
    security: 'tls-self',
    edge: 'udp',
    udp: true,
    title: { fa: 'TUIC v5', en: 'TUIC v5' },
    desc: { fa: 'تونل QUIC با کنترل ازدحام BBR؛ فقط UDP.', en: 'QUIC tunnel with BBR congestion control; UDP only.' },
    defaults: { congestion: 'bbr' },
    fields: ['congestion'],
  },
  {
    id: 'wireguard',
    tier: 'lab',
    core: 'singbox',
    protocol: 'wireguard',
    transport: 'udp',
    security: 'none',
    edge: 'udp',
    udp: true,
    title: { fa: 'WireGuard', en: 'WireGuard' },
    desc: { fa: 'WireGuard استاندارد؛ فقط UDP.', en: 'Standard WireGuard; UDP only.' },
    defaults: {},
    fields: [],
  },
];

export const PRESET_MAP = new Map(PRESETS.map((p) => [p.id, p]));
export const FIELD_MAP = F;

export function presetById(id) {
  return PRESET_MAP.get(id) || null;
}

function makeInbound(preset, overrides = {}) {
  const id = overrides.id || uid(6);
  return {
    id,
    presetId: preset.id,
    label: overrides.label || preset.title.en,
    enabled: overrides.enabled !== false,
    routeKey: `nl-${id}`,
    port: overrides.port || 0,
    params: { ...preset.defaults, ...(overrides.params || {}) },
  };
}

/** Default inbounds seeded on a fresh install. */
export function DEFAULT_INBOUNDS() {
  const list = [
    makeInbound(presetById('vless-ws'), { label: 'VLESS · WS', enabled: false, port: 11001 }),
    makeInbound(presetById('vless-xhttp'), { label: 'VLESS · XHTTP', enabled: false, port: 11003 }),
    makeInbound(presetById('vless-grpc'), { label: 'VLESS · gRPC', enabled: false, port: 11004 }),
    makeInbound(presetById('trojan-ws'), { label: 'Trojan · WS', enabled: false, port: 11005 }),
    makeInbound(presetById('trojan-tcp-tls'), { label: 'Trojan · TLS', enabled: false, port: 11006 }),
    makeInbound(presetById('vless-reality'), { label: 'VLESS · REALITY', enabled: true, port: 11010 }),
    makeInbound(presetById('ss-2022'), { label: 'Shadowsocks 2022', enabled: true, port: 11011 }),
    makeInbound(presetById('anytls'), { label: 'AnyTLS', enabled: true, port: 11012 }),
    makeInbound(presetById('shadowtls'), { label: 'ShadowTLS v3', enabled: false, port: 11013 }),
    makeInbound(presetById('sb-vless-ws'), { label: 'VLESS · WS (sing-box)', enabled: false, port: 12001 }),
    makeInbound(presetById('hysteria2'), { label: 'Hysteria2 (UDP)', enabled: false, port: 11020 }),
  ];
  return list;
}

/** Resolve a stored inbound into a full descriptor with preset data merged. */
export function describeInbound(inbound) {
  const preset = presetById(inbound.presetId);
  if (!preset) return null;
  return {
    ...preset,
    ...inbound,
    params: { ...preset.defaults, ...(inbound.params || {}) },
    reachable: !preset.udp,
    tier: preset.tier || 'lab',
    reason: preset.udp
      ? { fa: 'ریلوی پلن رایگان UDP عمومی نمی‌دهد', en: 'Railway free plan exposes no public UDP' }
      : null,
  };
}

/**
 * The full HTTP path an edge-routed inbound answers on.
 *
 * The panel reverse-proxies by the `/<routeKey>` prefix (that is how a single
 * Railway HTTPS port can host many inbounds on two different cores), so the
 * value the core expects *must* include the route key.
 */
export function edgePath(inbound) {
  const raw = (inbound.params && inbound.params.path) || '/';
  const suffix = raw === '/' ? '' : raw.startsWith('/') ? raw : `/${raw}`;
  return `/${inbound.routeKey}${suffix}`;
}

/** gRPC service name including the routing prefix. */
export function edgeServiceName(inbound) {
  const extra = ((inbound.params && inbound.params.serviceName) || '').replace(/^\/+/, '');
  return extra ? `${inbound.routeKey}/${extra}` : inbound.routeKey;
}

export function enabledInbounds(doc) {
  return (doc.inbounds || [])
    .map(describeInbound)
    .filter((ib) => ib && ib.enabled && ib.reachable);
}

export function inboundByRouteKey(doc, routeKey) {
  const inbound = (doc.inbounds || []).find((ib) => ib.routeKey === routeKey);
  return inbound ? describeInbound(inbound) : null;
}
