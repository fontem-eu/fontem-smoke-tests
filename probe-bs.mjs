import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', args: ['--ignore-certificate-errors','--no-sandbox'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://docs.void42.internal/login', { waitUntil: 'networkidle' });
const btns = await page.evaluate(() => Array.from(document.querySelectorAll('a, button')).map(e => `${e.tagName} text="${(e.innerText||'').trim().slice(0,40)}" href="${e.href||''}"`).filter(s => s.length > 30));
console.log(btns.join('\n'));
await b.close();
