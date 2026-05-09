import { chromium } from 'playwright';
const b = await chromium.launch({ headless: true, executablePath: '/config/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome', args: ['--ignore-certificate-errors','--no-sandbox'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
await page.goto('https://vault.void42.internal/ui/vault/auth?with=oidc', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
const links = await page.evaluate(() => Array.from(document.querySelectorAll('a, button, input[type=button], input[type=submit]')).map(e => `${e.tagName} text="${(e.innerText||e.value||'').trim().slice(0,50)}" testid="${e.getAttribute('data-test-auth-method')||e.getAttribute('data-test-auth-submit')||''}"`).filter(s => s.length > 30));
console.log(links.join('\n'));
await b.close();
