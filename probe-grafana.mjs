import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', args: ['--ignore-certificate-errors','--no-sandbox'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://monitor.void42.internal/login', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(3000);
const links = await page.evaluate(() => Array.from(document.querySelectorAll('a, button')).filter(e => e.innerText.toLowerCase().includes('auth') || e.href?.includes('oauth') || e.href?.includes('oidc')).map(e => `${e.tagName} text="${e.innerText.trim().slice(0,40)}" href="${e.href||''}"`));
console.log(links);
await b.close();
