import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => errs.push(`[${m.type()}] ${m.text().slice(0,200)}`));
page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
page.on('response', r => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });
await page.goto('https://auth.void42.internal/if/flow/default-authentication-flow/?next=/', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(8000);
console.log('--- errors / 4xx-5xx ---');
errs.forEach(e => console.log(e));
console.log('--- inputs found anywhere ---');
const inputs = await page.evaluate(() => {
  const out = [];
  const find = (root, depth=0) => {
    if (!root) return;
    const inputs = root.querySelectorAll ? root.querySelectorAll('input') : [];
    for (const i of inputs) out.push(`d${depth} name=${i.name} type=${i.type} placeholder=${i.placeholder||''}`);
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) if (el.shadowRoot) find(el.shadowRoot, depth+1);
  };
  find(document);
  return out;
});
inputs.forEach(i => console.log(i));
console.log('--- buttons ---');
const buttons = await page.evaluate(() => {
  const out = [];
  const find = (root, depth=0) => {
    if (!root) return;
    const bs = root.querySelectorAll ? root.querySelectorAll('button') : [];
    for (const b of bs) out.push(`d${depth} type=${b.type} text="${b.innerText.trim().slice(0,40)}"`);
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) if (el.shadowRoot) find(el.shadowRoot, depth+1);
  };
  find(document);
  return out;
});
buttons.forEach(b => console.log(b));
await page.screenshot({ path: '/tmp/auth-page.png' });
console.log('screenshot: /tmp/auth-page.png');
await b.close();
