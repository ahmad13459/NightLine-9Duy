// Renders README screenshots from the running panel with every secret redacted.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const exe = process.env.CHROME_BIN || (process.env.HOME + '/.cache/ms-playwright/chromium-1187/chrome-linux/chrome');
const OUT = '/home/user/nightline-railway/assets/screens';
mkdirSync(OUT, { recursive: true });

const REDACT_JS = () => {
  const style = document.createElement('style');
  style.textContent = `.redact{filter:blur(6px) !important;user-select:none !important}
    .redact .qrbox{filter:none !important}`;
  document.head.append(style);

  // subscription tokens, protocol URIs, uuid-ish strings and route keys must
  // never reach a screenshot
  const SECRET = /([0-9a-f]{16,})|(\/sub\/)|(vless:\/\/|trojan:\/\/|ss:\/\/|vmess:\/\/|anytls:\/\/|hysteria2:\/\/|tg:\/\/|t\.me\/proxy|t\.me\/socks|nl-[a-z0-9]{5,})|([A-Za-z0-9_-]{18,})/i;
  const SKIP = ['SCRIPT', 'STYLE', 'HTML'];

  document.querySelectorAll('*').forEach((el) => {
    if (SKIP.includes(el.tagName) || el.classList.contains('redact')) return;
    if (el.closest('.redact')) return;
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
      .trim();
    if (own && SECRET.test(own)) el.classList.add('redact');
  });
  // QR codes encode the same secrets
  document.querySelectorAll('.qrbox, canvas.qr, .qr svg').forEach((el) => el.classList.add('redact'));
  // mask every field value (credentials, keys, tokens)
  const KEEP = new Set(['rl-cidr', 'rl-workers', 's-public', 's-tcpport', 's-loglevel']);
  document.querySelectorAll('input').forEach((el) => {
    if (KEEP.has(el.id)) return;
    if (el.type === 'text' || el.type === '') el.type = 'password';
  });
  // never leak an account name in a screenshot
  document.querySelectorAll('.user-name, .acct-name').forEach((el) => el.classList.add('redact'));
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle' });
await page.fill('#auth-user', 'admin');
await page.fill('#auth-pass', 'supersecret1');
await page.click('#auth-submit');
await page.waitForTimeout(2200);

const shots = [
  ['dashboard', null],
  ['easy', 'easy'],
  ['railynx', 'railynx'],
  ['inbounds', 'inbounds'],
  ['telegram', 'telegram'],
  ['users', 'users'],
  ['cores', 'cores'],
];

for (const [name, tab] of shots) {
  if (tab) {
    await page.click(`.tab-btn[data-arg="${tab}"]`);
    await page.waitForTimeout(1600);
  }
  await page.evaluate(REDACT_JS);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  const left = await page.evaluate(() => document.querySelectorAll('.redact').length);
  console.log(name, 'redacted nodes:', left);
}

await browser.close();
