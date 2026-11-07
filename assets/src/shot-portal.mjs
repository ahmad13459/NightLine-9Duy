// Subscriber page screenshot with links + QR redacted.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const token = readFileSync('/tmp/token.txt', 'utf8').trim();
const exe = process.env.CHROME_BIN || (process.env.HOME + '/.cache/ms-playwright/chromium-1187/chrome-linux/chrome');
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const c = await b.newContext({ viewport: { width: 1100, height: 1500 }, deviceScaleFactor: 1 });
const p = await c.newPage();
await p.goto(`http://127.0.0.1:8080/u/${token}`, { waitUntil: 'networkidle' });
await p.waitForTimeout(900);
// present the real Railway domain instead of the local test host, and hide the token
await p.evaluate(() => {
  const host = 'nightline-railway-production.up.railway.app';
  const walk = (root) => {
    for (const n of root.querySelectorAll('*')) {
      for (const t of n.childNodes) {
        if (t.nodeType === 3 && t.nodeValue && t.nodeValue.includes('127.0.0.1')) {
          t.nodeValue = t.nodeValue.replace(/127\.0\.0\.1:8080/g, host);
        }
      }
      if (n.value && String(n.value).includes('127.0.0.1')) n.value = String(n.value).replace(/127\.0\.0\.1:8080/g, host);
    }
  };
  walk(document);
  const mask = (str) => String(str).replace(/(\/sub\/?)[A-Za-z0-9_-]{4,}/g, '$1••••••••••••');
  for (const n of document.querySelectorAll('*')) {
    for (const t of n.childNodes) if (t.nodeType === 3 && t.nodeValue && /\/sub\//.test(t.nodeValue)) t.nodeValue = mask(t.nodeValue);
  }
  document.querySelectorAll('input, textarea').forEach((i) => { i.value = mask(i.value || ''); });
  document.querySelectorAll('input').forEach((i) => { i.value = String(i.value || '').replace(/127\.0\.0\.1:8080/g, host); });
});
await p.addStyleTag({ content: '.redact{filter:blur(6px)!important;user-select:none}' });
await p.evaluate(() => {
  document.querySelectorAll('.qrbox, .lk-uri, .acct-name, .ep-val, .lk-cap, .u-uri, .sub-url').forEach((el) => el.classList.add('redact'));
});
await p.waitForTimeout(200);
await p.screenshot({ path: '/home/user/nightline-railway/assets/screens/portal.png', fullPage: true });
console.log('portal shot ok');
await b.close();
