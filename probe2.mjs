import { chromium } from 'playwright';
const b = await chromium.launch({
  headless: true,
  executablePath: '/config/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--ignore-certificate-errors','--no-sandbox','--disable-dev-shm-usage','--window-size=1600,1000']
});
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://auth.void42.internal/if/flow/default-authentication-flow/?next=/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const find = (root, d=0) => {
    if (!root || !root.querySelectorAll) return null;
    for (const i of root.querySelectorAll('input')) {
      if (i.name === 'uidField') {
        const r = i.getBoundingClientRect();
        return { found: true, depth: d, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, visible: i.offsetParent !== null, parent: i.parentElement?.tagName };
      }
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const g = find(el.shadowRoot, d+1); if (g) return g; }
    return null;
  };
  return find(document);
});
console.log('uidField:', JSON.stringify(info));
await page.screenshot({ path: '/tmp/auth-fullpage.png', fullPage: true });
console.log('done');
await b.close();
