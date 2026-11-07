import fs from 'node:fs';
import path from 'node:path';
import { BIN_DIR } from './env.js';

/**
 * NIGHTLINE · Railway Edition — Iranian routing rules (applied on the server)
 *
 * The rules follow the layout of the "Iran v2ray rules" project by Chocolate4U
 * (https://github.com/Chocolate4U/Iran-v2ray-rules) and its sing-box / Clash
 * siblings. Iranian domains and IPs go out directly, ads and security lists are
 * blocked, everything else is tunnelled through the panel's inbounds.
 *
 * Two delivery styles:
 *   • xray / v2ray clients ask for geosite:/geoip: files → we ship the rule
 *     block plus download links for the .dat files.
 *   • sing-box and Mihomo can pull remote rule-sets by URL → nothing to install.
 */

export const ROUTING_SOURCE = {
  name: 'Iran v2ray rules',
  author: 'Chocolate4U',
  xray: 'https://github.com/Chocolate4U/Iran-v2ray-rules',
  singbox: 'https://github.com/Chocolate4U/Iran-sing-box-rules',
  clash: 'https://github.com/Chocolate4U/Iran-clash-rules',
  license: 'GPL-3.0',
};

const V2RAY_RAW = 'https://raw.githubusercontent.com/Chocolate4U/Iran-v2ray-rules/release';
const V2RAY_CDN = 'https://cdn.jsdelivr.net/gh/Chocolate4U/Iran-v2ray-rules@release';
const SRS_RAW = 'https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set';
const SRS_CDN = 'https://cdn.jsdelivr.net/gh/Chocolate4U/Iran-sing-box-rules@rule-set';
const CLASH_RAW = 'https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release';
const CLASH_CDN = 'https://cdn.jsdelivr.net/gh/Chocolate4U/Iran-clash-rules@release';

/** .dat files an xray/v2ray client needs beside its binary. */
export const GEO_FILES = [
  { name: 'geosite.dat', label: 'دامنه‌ها · geosite', labelEn: 'domains · geosite', primary: true },
  { name: 'geoip.dat', label: 'آی‌پی‌ها · geoip', labelEn: 'addresses · geoip', primary: true },
  { name: 'security.dat', label: 'لیست امنیتی · security', labelEn: 'security list', primary: false },
  { name: 'security-ip.dat', label: 'امنیتی · IP', labelEn: 'security addresses', primary: false },
  { name: 'geosite-lite.dat', label: 'نسخهٔ سبک · geosite', labelEn: 'lite geosite', primary: false },
  { name: 'geoip-lite.dat', label: 'نسخهٔ سبک · geoip', labelEn: 'lite geoip', primary: false },
].map((f) => ({
  ...f,
  url: `${V2RAY_RAW}/${f.name}`,
  cdn: `${V2RAY_CDN}/${f.name}`,
}));

/** DNS presets. `auto` keeps DoH (encrypted, unfiltered); the rest are Iranian resolvers. */
export const DNS_PRESETS = {
  auto: {
    label: 'خودکار · DoH',
    labelEn: 'automatic · DoH',
    note: 'همه‌چیز روی DNS رمزنگاری‌شده حل می‌شود؛ دامنه‌های ایرانی هم از تونل می‌گذرند.',
    noteEn: 'Everything resolves over encrypted DoH; Iranian domains also go through the tunnel.',
    doh: true,
    ips: [],
  },
  split: {
    label: 'تفکیک‌شده · DoH + DNS ایران',
    labelEn: 'split · DoH + Iran DNS',
    note: 'دامنه‌های ایرانی با DNS داخلی و بدون تونل، بقیه با DoH.',
    noteEn: 'Iranian domains use a local resolver; everything else uses DoH.',
    doh: true,
    ips: ['178.22.122.100', '185.51.200.2'],
  },
  shecan: {
    label: 'شکن',
    labelEn: 'Shecan',
    note: 'DNS شکن برای دامنه‌های ایرانی؛ سازگار با شبکهٔ داخلی.',
    noteEn: 'Shecan resolver for Iranian domains.',
    doh: false,
    ips: ['178.22.122.100', '185.51.200.2'],
  },
  radar: {
    label: 'رادار · ۴۰۳',
    labelEn: 'Radar · 403',
    note: 'DNS رادار (۴۰۳) برای دامنه‌های ایرانی.',
    noteEn: 'Radar (403.online) resolver for Iranian domains.',
    doh: false,
    ips: ['10.202.10.10', '10.202.10.11'],
  },
  electro: {
    label: 'الکترو',
    labelEn: 'Electro',
    note: 'DNS الکترو برای دامنه‌های ایرانی.',
    noteEn: 'Electro resolver for Iranian domains.',
    doh: false,
    ips: ['78.157.42.100', '78.157.42.101'],
  },
  off: {
    label: 'خاموش · DNS پیش‌فرض دستگاه',
    labelEn: 'off · system DNS',
    note: 'DNS را کلاینت خودش انتخاب می‌کند؛ ساده‌ترین حالت.',
    noteEn: 'The client picks its own DNS; the simplest option.',
    doh: false,
    ips: [],
  },
};

/* ── rule data that ships inside the image ───────────────────────────── */

/**
 * The Docker build downloads the Iranian geo files and sing-box rule-sets next
 * to the cores and writes a marker. Without the marker we fall back to the
 * names that stock Xray data knows, so a config never fails to load.
 */
export function rulesAssets() {
  const marker = path.join(BIN_DIR, '.iran-rules.json');
  let iran = false;
  try {
    iran = Boolean(JSON.parse(fs.readFileSync(marker, 'utf8')).iran);
  } catch {
    iran = false;
  }
  const srsDir = path.join(BIN_DIR, 'srs');
  const srs = (name) => path.join(srsDir, `${name}.srs`);
  const hasSrs = iran && fs.existsSync(srs('geosite-category-ir'));
  return { dir: BIN_DIR, srsDir, iran, srs, hasSrs };
}

/**
 * Rules the cores enforce ON THE SERVER (this Railway container):
 * ads / malware / phishing / miners are dropped, QUIC and BitTorrent can be
 * dropped, private ranges never leave the box. No client-side setup needed.
 */
export function serverXrayRules(settings, assets = rulesAssets()) {
  const s = { ...ROUTING_DEFAULTS, ...(settings || {}) };
  const rules = [];
  if (!s.enabled) return rules;
  if (s.blockAds) {
    rules.push({
      type: 'field',
      outboundTag: 'block',
      domain: assets.iran ? ['geosite:category-ads-all', 'geosite:ads'] : ['geosite:category-ads-all'],
    });
  }
  if (s.blockSecurity && assets.iran) {
    rules.push({
      type: 'field',
      outboundTag: 'block',
      domain: ['geosite:malware', 'geosite:phishing', 'geosite:cryptominers'],
    });
    rules.push({ type: 'field', outboundTag: 'block', ip: ['geoip:malware', 'geoip:phishing'] });
  }
  if (s.blockBittorrent) {
    // stops the service being used as a torrent exit node
    rules.push({ type: 'field', protocol: ['bittorrent'], outboundTag: 'block' });
  }
  if (s.blockQuic) {
    rules.push({ type: 'field', network: 'udp', port: '443', outboundTag: 'block' });
  }
  return rules;
}

export function serverSingboxRules(settings, assets = rulesAssets()) {
  const s = { ...ROUTING_DEFAULTS, ...(settings || {}) };
  if (!s.enabled) return { ruleSets: [], rules: [] };
  const ruleSets = [];
  const rules = [];
  const addSet = (tag, file) => {
    if (assets.hasSrs) ruleSets.push({ type: 'local', tag, format: 'binary', path: assets.srs(file) });
    else ruleSets.push({ type: 'remote', tag, format: 'binary', url: `${SRS_RAW}/${file}.srs` });
  };
  if (s.blockAds) {
    addSet('geosite-ads', 'geosite-category-ads-all');
    rules.push({ rule_set: 'geosite-ads', action: 'reject' });
  }
  if (s.blockSecurity) {
    addSet('geosite-malware', 'geosite-malware');
    addSet('geosite-phishing', 'geosite-phishing');
    addSet('geoip-malware', 'geoip-malware');
    rules.push({ rule_set: ['geosite-malware', 'geosite-phishing'], action: 'reject' });
    rules.push({ rule_set: 'geoip-malware', action: 'reject' });
  }
  if (s.blockQuic) rules.push({ protocol: 'quic', action: 'reject' });
  if (s.blockBittorrent) rules.push({ protocol: 'bittorrent', action: 'reject' });
  return { ruleSets, rules };
}

export const ROUTING_DEFAULTS = {
  enabled: true,
  blockAds: true,
  blockSecurity: true,
  blockQuic: false,
  blockBittorrent: true,
};

const PRIVATE_CIDRS = [
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8',
  '169.254.0.0/16', '100.64.0.0/10', '::1/128', 'fc00::/7', 'fe80::/10',
];

/** Merge whatever is stored with the defaults, and drop unknown DNS names. */
export function routingSettings(doc) {
  const stored = (doc && doc.settings && doc.settings.routing) || {};
  const out = { ...ROUTING_DEFAULTS };
  for (const key of Object.keys(ROUTING_DEFAULTS)) {
    if (stored[key] === undefined) continue;
    if (key === 'dns') {
      if (DNS_PRESETS[stored.dns]) out.dns = stored.dns;
    } else {
      out[key] = Boolean(stored[key]);
    }
  }
  return out;
}

export function dnsPreset(name) {
  return DNS_PRESETS[name] || DNS_PRESETS[ROUTING_DEFAULTS.dns];
}

/* ── panel-facing summary + previews ─────────────────────────────────── */

export function routingSummary(doc) {
  const s = routingSettings(doc);
  return {
    settings: s,
    defaults: ROUTING_DEFAULTS,
    assets: rulesAssets(),
    source: ROUTING_SOURCE,
    geoFiles: GEO_FILES,
    counts: {
      serverRules: serverXrayRules(s).length,
      ruleSets: serverSingboxRules(s).ruleSets.length,
    },
  };
}

export function previewRouting(doc) {
  const s = routingSettings(doc);
  const assets = rulesAssets();
  const sb = serverSingboxRules(s, assets);
  return {
    server: JSON.stringify({
      xray: { domainStrategy: 'IPIfNonMatch', rules: serverXrayRules(s, assets) },
      singbox: {
        rule_set: sb.ruleSets.map((r) => ({ ...r, path: r.path ? r.path.replace(/^.*\/srs\//, 'srs/') : undefined })),
        rules: sb.rules,
      },
    }, null, 2),
  };
}
