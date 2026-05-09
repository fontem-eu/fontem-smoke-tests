import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', args: ['--ignore-certificate-errors','--no-sandbox'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on('response', r => { if (r.url().includes('/api/v1/user/oidc')) console.log('oidc-api', r.status(), r.url()); });
page.on('console', m => { if (m.type() === 'error') console.log('console.error', m.text().slice(0,300)); });
await page.goto('https://dtrack.void42.internal/login', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const btn = await page.locator('button:has-text("Sign in with Authentik")').first();
await btn.click();
await page.waitForTimeout(2000);
// fill identification
const filled = await page.evaluate((u) => {
  const f = (r) => { for (const i of r.querySelectorAll('input')) if (i.name === 'uidField' && i.offsetParent) return i; for (const e of r.querySelectorAll('*')) if (e.shadowRoot) { const g = f(e.shadowRoot); if (g) return g; } return null; };
  const i = f(document); if (!i) return false;
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i, u);
  i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true}));
  let n = i; while (n) { if (n.tagName === 'FORM') { n.requestSubmit(); return true; } n = n.parentNode || n.host; }
  return false;
}, 'lucid');
console.log('id filled:', filled);
await page.waitForTimeout(2000);
const filled2 = await page.evaluate((p) => {
  const f = (r) => { for (const i of r.querySelectorAll('input')) if (i.name === 'password' && i.offsetParent) return i; for (const e of r.querySelectorAll('*')) if (e.shadowRoot) { const g = f(e.shadowRoot); if (g) return g; } return null; };
  const i = f(document); if (!i) return false;
  const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(i, p);
  i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true}));
  let n = i; while (n) { if (n.tagName === 'FORM') { n.requestSubmit(); return true; } n = n.parentNode || n.host; }
  return false;
}, 'qwerty1134');
console.log('pw filled:', filled2);
await page.waitForTimeout(8000);
console.log('final URL:', page.url());
console.log('PAGE TEXT first 600:', (await page.locator('body').innerText()).slice(0,600).replace(/\n/g,' | '));
await b.close();
