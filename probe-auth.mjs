import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on('console', m => console.log(`[console.${m.type()}]`, m.text().slice(0,200)));
page.on('pageerror', e => console.log('[pageerror]', e.message));
page.on('response', r => { if (r.status() >= 400) console.log(`[HTTP${r.status()}]`, r.url()); });
await page.goto('https://auth.void42.internal/if/flow/default-authentication-flow/?next=/', { waitUntil: 'networkidle', timeout: 30000 });
for (const t of [1000, 3000, 5000, 10000]) {
  await page.waitForTimeout(t === 1000 ? 1000 : t-1000);
  const html = await page.content();
  console.log(`t=${t}ms html_len=${html.length} title="${await page.title()}"`);
}
const inputs = await page.evaluate(() => {
  const r = [];
  const f = (root, d=0) => { if (!root || !root.querySelectorAll) return;
    for (const i of root.querySelectorAll('input')) r.push(`d${d} name=${i.name} hidden=${i.offsetParent===null}`);
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) f(e.shadowRoot, d+1);
  };
  f(document); return r;
});
console.log('inputs:', inputs);
await b.close();
