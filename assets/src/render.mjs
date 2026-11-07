import { chromium } from 'playwright';
import { readdirSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';

// The panel's static root (public/) is what serves /fonts and /sprite.svg, so the
// render sources are staged there while screenshots are taken.
const SRC = '/home/user/nightline-railway/assets/src';
const STAGE = '/home/user/nightline-railway/public/__render';
mkdirSync(STAGE, { recursive: true });
for (const f of readdirSync(SRC)) {
  if (f.endsWith('.html') || f.endsWith('.css')) copyFileSync(`${SRC}/${f}`, `${STAGE}/${f}`);
}

const exe = process.env.CHROME_BIN || (process.env.HOME + '/.cache/ms-playwright/chromium-1187/chrome-linux/chrome');
const base = 'http://127.0.0.1:8100/__render/';
const only = process.argv[2];
const files = readdirSync('/home/user/nightline-railway/assets/src')
  .filter((f) => f.endsWith('.html'))
  .filter((f) => !only || f.startsWith(only));

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--font-render-hinting=none'] });
const ctx = await browser.newContext({ viewport: { width: 1700, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('requestfailed', (r) => console.log('FAILED', r.url().slice(0, 90), r.failure()?.errorText));

for (const f of files) {
  const name = f.replace('.html', '');
  await page.goto(base + f, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#i-shield') !== null || !window.__needsSprite, null, { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const box = await page.locator('.sheet').boundingBox();
  console.log(name, JSON.stringify(box));
  await page.locator('.sheet').screenshot({
    path: `/home/user/nightline-railway/assets/${name}.png`,
    omitBackground: false,
  });
  console.log('wrote', name + '.png');
}
await browser.close();
rmSync(STAGE, { recursive: true, force: true });
console.log('staging dir removed');
