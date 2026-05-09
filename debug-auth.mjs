import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell', args: ['--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
await page.goto('https://auth.void42.internal/if/flow/default-authentication-flow/?next=/', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
const html = await page.content();
console.log(html.length, 'chars');
// Print first 4kb
console.log(html.slice(0, 4000));
console.log('---');
// Count shadow roots
const c = await page.evaluate(() => {
  const find = (root, count = 0) => {
    if (!root) return count;
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.shadowRoot) { count++; count = find(el.shadowRoot, count); }
    }
    return count;
  };
  return find(document);
});
console.log('shadow roots:', c);
await b.close();
