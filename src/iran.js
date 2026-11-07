/**
 * NIGHTLINE · Railway — easy setup & Iran network advisor.
 *
 * Everything in here is *advice*, not magic: it inspects the deployment
 * (Railway facts, cores, enabled inbounds), explains what is likely to work on
 * an Iranian ISP, and can apply a curated profile that turns on the protocols
 * that survive that network — all of them sharing the single TCP port, all of
 * them inside one subscription link.
 *
 * Sources for the defaults (2026):
 *   · XTLS/REALITY docs & Xray-examples — dest must be a real TLS1.3 + H2 site
 *     that is reachable from inside Iran; Google-owned names are avoided.
 *   · net4people/bbs#410 — Vision-without-seed has a fixed traffic shape; keep
 *     flow = xtls-rprx-vision, avoid VLESS-without-TLS, avoid `*.ir` SNIs.
 *   · Iranian ISP reports — port 443 (through the Railway HTTPS domain) is the
 *     most filtered path, high random TCP ports (the Railway TCP proxy) are the
 *     most resilient one; UDP is unavailable on Railway at all.
 */

import { presetById } from './catalog.js';

/** Destinations that are known to answer TLS1.3 + HTTP/2 from inside Iran. */
export const IRAN_SNI_CHOICES = [
  { value: 'www.microsoft.com', fa: 'مایکروسافت (پیشنهادی)', en: 'Microsoft (recommended)' },
  { value: 'www.apple.com', fa: 'اپل', en: 'Apple' },
  { value: 'aws.amazon.com', fa: 'آمازون', en: 'AWS' },
  { value: 'dash.cloudflare.com', fa: 'کلادفلر', en: 'Cloudflare dash' },
  { value: 'www.speedtest.net', fa: 'اسپیدتست', en: 'Speedtest' },
  { value: 'www.swift.com', fa: 'سوئیفت', en: 'Swift' },
];

/** Domain used for MTProto FakeTLS — must be reachable *and* not filtered. */
export const IRAN_FAKETLS_CHOICES = [
  { value: 'www.microsoft.com', fa: 'مایکروسافت', en: 'Microsoft' },
  { value: 'www.apple.com', fa: 'اپل', en: 'Apple' },
  { value: 'www.samsung.com', fa: 'سامسونگ', en: 'Samsung' },
  { value: 'www.icloud.com', fa: 'آیکلاود', en: 'iCloud' },
];

/**
 * Profile = which presets to enable + the parameter overrides that matter.
 * `via` tells the UI how the protocol reaches the outside world:
 *   'tcp'  → Railway TCP proxy (random high port) — most resilient in Iran
 *   'edge' → Railway HTTPS domain (`*.up.railway.app`) — filtered more often
 */
export const PROFILES = [
  {
    id: 'iran',
    fa: 'ایران · پایدارترین',
    en: 'IRAN · MOST ROBUST',
    taglineFa: 'فقط سه روشی که روی پورت TCP ریلوی واقعاً وصل شدند',
    taglineEn: 'Only the three methods that actually connected over the Railway TCP port',
    enables: ['vless-reality', 'ss-2022', 'anytls'],
    disables: ['vless-ws', 'vless-xhttp', 'vless-grpc', 'vless-httpupgrade', 'trojan-ws', 'vmess-ws', 'sb-vless-ws', 'sb-trojan-ws', 'sb-vmess-ws', 'trojan-tcp-tls', 'shadowtls', 'hysteria2', 'tuic', 'wireguard', 'vless-tcp', 'vmess-tcp', 'ss-legacy', 'sb-ss-2022', 'sb-vless-reality'],
    // Each self-signed TLS inbound needs its own SNI: the multiplexer can only
    // tell them apart by server name, and the FakeTLS host must stay separate.
    telegram: { mtproto: true, socks: true, http: true, faketlsHost: 'www.samsung.com' },
    overrides: {
      'vless-reality': { dest: 'www.microsoft.com:443', sni: 'www.microsoft.com', flow: 'xtls-rprx-vision' },
      anytls: { sni: 'www.apple.com' },
      'ss-2022': {},
    },
    notesFa: [
      'REALITY، Shadowsocks-2022 و AnyTLS با هم روی همان یک پورت TCP پروکسی سرو می‌شوند.',
      'هیچ‌کدام به دامنهٔ *.up.railway.app وابسته نیستند؛ دلیلی که بقیهٔ روش‌ها پینگ نمی‌دادند همین بود.',
      'ترافیک تلگرام (MTProto / SOCKS5 / HTTP) روی همان پورت فعال می‌شود.',
    ],
    notesEn: [
      'REALITY, Shadowsocks-2022 and AnyTLS share the single TCP proxy port.',
      'None of them depends on the *.up.railway.app domain — that dependency is why the other recipes never answered.',
      'Telegram traffic (MTProto / SOCKS5 / HTTP) rides the same port.',
    ],
  },
  {
    id: 'balanced',
    fa: 'سبک · فقط REALITY',
    en: 'LIGHT · REALITY ONLY',
    taglineFa: 'کمترین مصرف حافظه؛ فقط قوی‌ترین روش',
    taglineEn: 'Lowest memory; the strongest method only',
    enables: ['vless-reality'],
    disables: ['vless-ws', 'vless-xhttp', 'vless-grpc', 'vless-httpupgrade', 'trojan-ws', 'vmess-ws', 'sb-vless-ws', 'sb-trojan-ws', 'sb-vmess-ws', 'trojan-tcp-tls', 'shadowtls', 'anytls', 'ss-2022', 'hysteria2', 'tuic', 'wireguard', 'vless-tcp', 'vmess-tcp', 'ss-legacy', 'sb-ss-2022', 'sb-vless-reality'],
    telegram: { mtproto: true, socks: true, http: true, faketlsHost: 'www.samsung.com' },
    overrides: {
      'vless-reality': { dest: 'www.microsoft.com:443', sni: 'www.microsoft.com', flow: 'xtls-rprx-vision' },
    },
    notesFa: [
      'برای پلن رایگان ریلوی با ۵۱۲ مگابایت رم؛ فقط یک اینباند Xray بالا می‌آید.',
      'بقیهٔ روش‌ها خاموش می‌شوند تا هستهٔ sing-box هم اجرا نشود.',
    ],
    notesEn: [
      'Made for the Railway free plan (512 MB); a single Xray inbound stays up.',
      'Everything else is switched off so sing-box does not need to run either.',
    ],
  },
  {
    id: 'lab',
    fa: 'آزمایشی · همهٔ روش‌ها',
    en: 'LAB · EVERY METHOD',
    taglineFa: 'روش‌هایی که روی لبهٔ ریلوی قابل‌اعتماد نبودند — برای دامنهٔ اختصاصی',
    taglineEn: 'Recipes that were not reliable on the Railway edge — for custom domains',
    enables: [
      'vless-reality', 'ss-2022', 'anytls', 'vless-ws', 'vless-xhttp', 'vless-httpupgrade',
      'vmess-ws', 'trojan-ws', 'trojan-tcp-tls', 'shadowtls', 'sb-vless-ws',
    ],
    disables: ['hysteria2', 'tuic', 'wireguard', 'vless-tcp', 'vmess-tcp', 'ss-legacy', 'sb-ss-2022', 'vless-grpc', 'vmess-grpc', 'trojan-grpc'],
    telegram: { mtproto: true, socks: true, http: true, faketlsHost: 'www.samsung.com' },
    overrides: {
      'vless-reality': { dest: 'www.microsoft.com:443', sni: 'www.microsoft.com', flow: 'xtls-rprx-vision' },
      anytls: { sni: 'www.apple.com' },
      'trojan-tcp-tls': { sni: 'aws.amazon.com' },
      shadowtls: { sni: 'dash.cloudflare.com' },
    },
    notesFa: [
      'لینک‌های دامنه‌محور (WS / XHTTP / HTTPUpgrade) نیاز به دامنهٔ اختصاصی دارند؛ روی دامنهٔ خود ریلوی معمولاً پاسخ نمی‌دهند.',
      'اگر با یکی از این‌ها وصل شدی، همان را نگه دار و بقیه را خاموش کن.',
    ],
    notesEn: [
      'Domain-based links (WS / XHTTP / HTTPUpgrade) expect a custom domain; on the plain Railway domain they usually never answer.',
      'If one of them connects for you, keep it and switch the rest off.',
    ],
  },
];

export const PROFILE_MAP = new Map(PROFILES.map((p) => [p.id, p]));

/** Tips shown in the UI; short enough to read, specific enough to act on. */
export const IRAN_TIPS = [
  {
    fa: 'دامنهٔ *.up.railway.app را با یک دامنهٔ شخصی جایگزین کن. دامنه‌های اشتراکی ریلوی در ایران زیاد فیلتر می‌شوند؛ با دامنهٔ خودت (Cloudflare proxied) پینگ WS برمی‌گردد.',
    en: 'Replace the *.up.railway.app domain with your own (Cloudflare-proxied) one — shared Railway domains are filtered often in Iran.',
  },
  {
    fa: 'SNI گوگل انتخاب نکن. www.microsoft.com یا www.apple.com پایدارترند و دامنهٔ گوگل در ایران هم فیلتر است هم انگشت‌نگاری می‌شود.',
    en: 'Never pick a Google-owned SNI. www.microsoft.com or www.apple.com survive much better in Iran.',
  },
  {
    fa: 'در v2rayN/NekoBox گزینهٔ Fragment را روی 1–3 و TLS Fragment را روشن کن؛ ClientHello تکه‌تکه می‌شود و DPI کمتر می‌گیرد.',
    en: 'In v2rayN/NekoBox enable Fragment (1–3 packets) + TLS fragment: a split ClientHello slips past DPI more often.',
  },
  {
    fa: 'روی موبایل MTU را ۱۴۰۰ بگذار؛ کلاینتهلو بزرگ در شبکه‌های ۴G ایرانی تکه‌تکه می‌شود و هندشیک REALITY تایم‌اوت می‌دهد.',
    en: 'Set MTU 1400 on mobile: big ClientHellos get fragmented on Iranian 4G and REALITY handshakes time out.',
  },
  {
    fa: 'اگر REALITY وصل شد ولی سرعت افت کرد، mux را با ۴ اتصال (TCP) روشن کن؛ Vision بدون mux الگوی ترافیک ثابتی دارد.',
    en: 'If REALITY connects but crawls, enable mux with 4 concurrency — Vision without mux has a fixed traffic shape.',
  },
  {
    fa: 'برای تلگرام، MTProto با FakeTLS سبک‌تر از هر تانلی است؛ دامنهٔ FakeTLS را از فهرست پیشنهادی انتخاب کن.',
    en: 'For Telegram, MTProto with FakeTLS is lighter than any tunnel; keep the FakeTLS domain from the list above.',
  },
  {
    fa: 'پورت TCP پروکسی ریلوی (عدد تصادفی) مقاوم‌ترین راه است؛ روی آن، REALITY و SS و MTProto همه با هم کار می‌کنند.',
    en: 'The Railway TCP proxy port (random high number) is the most resilient path; REALITY, SS and MTProto all share it.',
  },
];

const EDGE_PRESETS = new Set([
  'vless-ws', 'vless-httpupgrade', 'vless-xhttp', 'vless-grpc', 'vmess-ws', 'vmess-grpc',
  'trojan-ws', 'trojan-grpc', 'sb-vless-ws', 'sb-trojan-ws', 'sb-vmess-ws',
]);

const UDP_PRESETS = new Set(['hysteria2', 'tuic', 'wireguard']);

function presetOf(inbound) {
  return inbound.presetId || inbound.preset || '';
}

/** Which Railway transport a preset uses, and how it fares in Iran. */
const GRPC_PRESETS = new Set(['vless-grpc', 'vmess-grpc', 'trojan-grpc']);

function reachabilityOf(preset) {
  if (UDP_PRESETS.has(preset)) {
    return { via: 'udp', iran: 'off', fa: 'روی ریلوی کار نمی‌کند (UDP عمومی ندارد)', en: 'Unavailable on Railway (no public UDP)' };
  }
  if (GRPC_PRESETS.has(preset)) {
    return {
      via: 'edge',
      iran: 'off',
      fa: 'gRPC به HTTP/2 نیاز دارد و لبهٔ ریلوی آن را به پنل نمی‌رساند — عملاً کار نمی‌کند',
      en: 'gRPC needs HTTP/2, which the Railway edge does not pass to the panel — it will not work',
    };
  }
  if (EDGE_PRESETS.has(preset)) {
    return { via: 'edge', iran: 'risky', fa: 'از دامنهٔ HTTPS ریلوی؛ در ایران متغیر است', en: 'Through the Railway HTTPS domain; unreliable in Iran' };
  }
  if (preset === 'ss-legacy' || preset === 'vmess-tcp' || preset === 'vless-tcp') {
    return { via: 'tcp', iran: 'risky', fa: 'بدون TLS؛ DPI ایران آن را می‌بیند', en: 'No TLS; Iranian DPI fingerprints it' };
  }
  return { via: 'tcp', iran: 'good', fa: 'از پورت TCP پروکسی؛ پایدار در ایران', en: 'Over the TCP proxy port; robust in Iran' };
}

/**
 * Read-only analysis of the current deployment, shaped for the UI.
 */
export function analyse({ doc, facts, cores }) {
  const inbounds = doc.inbounds || [];
  const enabled = inbounds.filter((i) => i.enabled);
  const rows = inbounds.map((ib) => {
    const preset = presetOf(ib);
    const reach = reachabilityOf(preset);
    return {
      id: ib.id,
      preset,
      label: ib.label,
      enabled: Boolean(ib.enabled),
      core: ib.core,
      port: ib.port,
      via: reach.via,
      iran: reach.iran,
      noteFa: reach.fa,
      noteEn: reach.en,
    };
  });

  const hasTcp = Boolean(facts.tcpHost && facts.tcpPort);
  const hasPublic = Boolean(facts.publicHost);
  const tg = (doc.settings && doc.settings.telegram) || {};
  const mtprotoOn = Boolean(tg.mtproto && tg.mtproto.enabled);

  const checks = [
    {
      id: 'tcp',
      ok: hasTcp,
      fa: hasTcp ? `پروکسی TCP فعال است (${facts.tcpHost}:${facts.tcpPort})` : 'پروکسی TCP ریلوی را فعال کن (Settings → Networking → TCP Proxy → 8443)',
      en: hasTcp ? `TCP proxy is live (${facts.tcpHost}:${facts.tcpPort})` : 'Enable the Railway TCP proxy (Settings → Networking → TCP Proxy → 8443)',
    },
    {
      id: 'public',
      ok: hasPublic,
      fa: hasPublic ? `دامنهٔ HTTPS: ${facts.publicHost}` : 'دامنهٔ عمومی HTTPS ساخته نشده (برای WS/XHTTP لازم است)',
      en: hasPubicSafe(hasPublic) ? `HTTPS domain: ${facts.publicHost}` : 'No public HTTPS domain yet (needed by WS/XHTTP)',
    },
    {
      id: 'reality',
      ok: enabled.some((i) => presetOf(i) === 'vless-reality'),
      fa: 'REALITY روی پورت TCP روشن است',
      en: 'REALITY is enabled on the TCP port',
    },
    {
      id: 'opaque',
      ok: enabled.some((i) => presetOf(i) === 'ss-2022'),
      fa: 'Shadowsocks-2022 به‌عنوان مسیر دوم روی همان پورت روشن است',
      en: 'Shadowsocks-2022 is enabled as a second path on the same port',
    },
    {
      id: 'mtproto',
      ok: mtprotoOn && (cores.mtproto === 'running'),
      fa: mtprotoOn ? 'MTProto فعال است (برای تلگرام)' : 'MTProto خاموش است؛ تلگرام بدون تانل می‌ماند',
      en: mtprotoOn ? 'MTProto is on (Telegram)' : 'MTProto is off; Telegram has no proxy',
    },
    {
      id: 'google-sni',
      ok: !enabled.some((i) => /google|gstatic|youtube/i.test(String((i.params && i.params.sni) || (i.params && i.params.dest) || ''))),
      fa: 'هیچ SNI گوگلی در اینباندها نیست',
      en: 'No Google-owned SNI in the enabled inbounds',
    },
  ];

  const conflicts = (facts.plan && facts.plan.opaqueConflicts) || [];
  for (const c of conflicts) {
    const row = rows.find((r) => r.id === c.dropped);
    if (row) {
      row.iran = 'off';
      row.noteFa = 'روی همین پورت، فقط یکی از اینباندهای بدون TLS قابل تشخیص است';
      row.noteEn = 'Only one TLS-less inbound per port can be routed';
    }
  }
  if (conflicts.length) {
    checks.push({
      id: 'opaque-dupe',
      ok: false,
      fa: `${conflicts.length} اینباند بدون TLS اضافه است؛ فقط اولی روی پورت مشترک جواب می‌دهد`,
      en: `${conflicts.length} extra TLS-less inbound(s) cannot share the port — only the first is reachable`,
    });
  }

  const players = rows.filter((r) => r.enabled);
  return {
    at: Date.now(),
    facts: { publicHost: facts.publicHost || null, tcpHost: facts.tcpHost || null, tcpPort: facts.tcpPort || 0 },
    cores,
    counts: {
      enabled: players.length,
      total: rows.length,
      tcp: players.filter((r) => r.via === 'tcp').length,
      edge: players.filter((r) => r.via === 'edge').length,
      telegram: [tg.mtproto?.enabled, tg.socks?.enabled, tg.http?.enabled].filter(Boolean).length,
    },
    checks,
    rows,
    tips: IRAN_TIPS,
    sniChoices: IRAN_SNI_CHOICES,
    faketlsChoices: IRAN_FAKETLS_CHOICES,
    profiles: PROFILES.map((p) => ({
      id: p.id, fa: p.fa, en: p.en, taglineFa: p.taglineFa, taglineEn: p.taglineEn,
      count: p.enables.length, notesFa: p.notesFa, notesEn: p.notesEn,
    })),
  };
}

function hasPubicSafe(v) { return v; }

/**
 * Mutate the stored document according to a profile.
 * Returns a summary the API hands back to the UI.
 */
export function applyProfile(doc, profileId) {
  const profile = PROFILE_MAP.get(profileId);
  if (!profile) throw new Error(`unknown profile: ${profileId}`);

  const want = new Set(profile.enables);
  const kill = new Set(profile.disables);
  const changed = [];

  // Profiles can ask for presets that the document does not carry yet — create
  // them instead of silently ignoring the request.
  const have = new Set((doc.inbounds || []).map(presetOf));
  for (const presetId of profile.enables) {
    if (have.has(presetId)) continue;
    const preset = presetById(presetId);
    if (!preset) continue;
    const used = new Set((doc.inbounds || []).map((ib) => ib.port));
    const base = preset.core === 'singbox' ? 12000 : 11000;
    let port = base + 1;
    while (used.has(port)) port += 1;
    const id = `ib${Math.random().toString(36).slice(2, 8)}`;
    doc.inbounds.push({
      id,
      presetId: preset.id,
      label: preset.title.en,
      enabled: true,
      routeKey: `nl-${id}`,
      port,
      params: { ...preset.defaults, ...(profile.overrides[presetId] || {}) },
    });
    have.add(presetId);
    changed.push({ preset: presetId, label: preset.title.en, enabled: true, created: true });
  }

  for (const ib of doc.inbounds || []) {
    const preset = presetOf(ib);
    let next = ib.enabled;
    if (want.has(preset)) next = true;
    else if (kill.has(preset)) next = false;
    if (next !== ib.enabled) {
      changed.push({ preset, label: ib.label, enabled: next });
      ib.enabled = next;
    }
    if (next && profile.overrides[preset]) {
      ib.params = { ...(ib.params || {}), ...profile.overrides[preset] };
    }
  }

  const tg = doc.settings.telegram || (doc.settings.telegram = {});
  const before = {
    mtproto: Boolean(tg.mtproto && tg.mtproto.enabled),
    socks: Boolean(tg.socks && tg.socks.enabled),
    http: Boolean(tg.http && tg.http.enabled),
  };
  tg.mtproto = tg.mtproto || { engine: 'mtg', faketlsHost: 'www.microsoft.com', secret: '', listenPort: 0 };
  tg.socks = tg.socks || { user: 'nl', pass: '' };
  tg.http = tg.http || { user: 'nl', pass: '' };
  tg.mtproto.enabled = Boolean(profile.telegram.mtproto);
  tg.socks.enabled = Boolean(profile.telegram.socks);
  tg.http.enabled = Boolean(profile.telegram.http);
  if (tg.mtproto.enabled) {
    if (profile.telegram.faketlsHost) tg.mtproto.faketlsHost = profile.telegram.faketlsHost;
    if (!tg.mtproto.faketlsHost) tg.mtproto.faketlsHost = 'www.samsung.com';
  }

  doc.settings.easySetup = { profile: profile.id, appliedAt: Date.now() };

  return {
    profile: profile.id,
    changed,
    telegram: { before, after: profile.telegram },
    enabledPresets: (doc.inbounds || []).filter((i) => i.enabled).map(presetOf),
  };
}
