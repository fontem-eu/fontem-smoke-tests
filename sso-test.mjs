// Drives SSO flows against Authentik.
// Usage: node sso-test.mjs [gitea|argocd|grafana|sonar|dtrack|vault|bookstack|all]
import { chromium } from 'playwright';

const USER = 'lucid';
const PASS = 'qwerty1134';
const target = process.argv[2] || 'both';

// Wait for an actual cross-origin redirect away from auth.void42.internal
// after the password stage submits. Authentik's flow controller renders
// an in-place "redirecting…" component and the URL doesn't transition
// until the OAuth callback fires; waitForLoadState alone isn't enough.
async function waitForCallbackRedirect(page, expectedHost, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (page.url().startsWith(expectedHost) || !page.url().startsWith('https://auth.void42.internal/')) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function loginAuthentikIfPrompted(page) {
  // Authentik renders inputs inside Lit shadow roots. There are also
  // depth-0 a11y-shim inputs with names username/password/code that
  // are hidden — we want the *visible* one inside the active stage.
  // Look for an input whose offsetParent !== null and matches the
  // expected name; prefer uidField (identification stage), then any
  // password input that's visible (password stage).
  for (const [stageName, val, candidates] of [
    ['identification', USER, ['uidField']],
    ['password', PASS, ['password']],
  ]) {
    // Wait for visible input matching candidates
    await page.waitForFunction((cands) => {
      const findVisible = (root) => {
        if (!root || !root.querySelectorAll) return null;
        for (const i of root.querySelectorAll('input')) {
          if (cands.includes(i.name) && i.offsetParent !== null) return i;
        }
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) { const got = findVisible(el.shadowRoot); if (got) return got; }
        }
        return null;
      };
      return !!findVisible(document);
    }, candidates, { timeout: 20000 }).catch(() => {});

    const ok = await page.evaluate(({ cands, val }) => {
      // Walk all shadow roots, collect every matching input + its
      // depth, return the DEEPEST visible one (the a11y shims live
      // at depth 0; the real Lit input lives at depth ≥2).
      const matches = [];
      const walk = (root, d=0) => {
        if (!root || !root.querySelectorAll) return;
        for (const i of root.querySelectorAll('input')) {
          if (cands.includes(i.name)) matches.push({ el: i, depth: d, visible: i.offsetParent !== null });
        }
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot, d+1);
      };
      walk(document);
      const visible = matches.filter(m => m.visible);
      if (!visible.length) return { ok: false, reason: 'no visible match', matches: matches.map(m=>({n:m.el.name,d:m.depth,v:m.visible})) };
      visible.sort((a,b)=>b.depth-a.depth);
      const input = visible[0].el;

      input.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      // Find the *form* containing this input and submit it natively
      let node = input;
      let form = null;
      while (node) {
        if (node.tagName === 'FORM') { form = node; break; }
        node = node.parentNode || (node.host /* shadow root */);
      }
      if (form) {
        const btn = form.querySelector('button[type="submit"], input[type="submit"]');
        if (btn) btn.click();
        else form.requestSubmit ? form.requestSubmit() : form.submit();
        return { ok: true, via: 'form submit', formAction: form.action || '(none)' };
      }
      // No form found — fall back to clicking any submit button in the input's shadow root
      const root = input.getRootNode();
      const btn = root.querySelector ? root.querySelector('button[type="submit"]') : null;
      if (btn) { btn.click(); return { ok: true, via: 'button[type=submit] in root' }; }
      // Last resort: synthetic Enter
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      return { ok: true, via: 'Enter key' };
    }, { cands: candidates, val });

    console.log(`    fill result for ${stageName}:`, JSON.stringify(ok));

    if (!ok || !ok.ok) { console.log(`    no visible input for ${stageName}`); return; }
    console.log(`    submitted ${stageName}, url=${page.url()}`);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    console.log(`    after wait, url=${page.url()}`);
  }
  // After both stages, give time for the OIDC callback redirect
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
}

async function testGitea(page) {
  console.log('\n=== GITEA SSO TEST ===');
  await page.goto('https://contribute.void42.internal/user/login', { waitUntil: 'domcontentloaded' });
  const ssoBtn = page.locator('a.openidConnect');
  if (!(await ssoBtn.isVisible())) { console.log('  FAIL: no Authentik SSO button'); return false; }
  await Promise.all([page.waitForLoadState('domcontentloaded'), ssoBtn.click()]);
  console.log('  after click url:', page.url());
  await loginAuthentikIfPrompted(page);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  console.log('  final url:', page.url());
  const text = await page.locator('body').innerText().catch(() => '');
  console.log('  page text (first 400):', text.slice(0, 400).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/gitea-sso-final.png' });
  const onGitea = page.url().startsWith('https://contribute.void42.internal/');
  if (onGitea && !page.url().includes('/login')) { console.log('  PASS'); return true; }
  console.log('  FAIL'); return false;
}

async function testArgoCD(page) {
  console.log('\n=== ARGOCD SSO TEST ===');
  await page.goto('https://argocd.void42.internal/login', { waitUntil: 'domcontentloaded' }).catch(e => console.log('  goto err:', e.message));
  const ssoBtn = page.locator('a:has-text("LOG IN VIA AUTHENTIK"), a:has-text("Log in via Authentik")').first();
  if (!(await ssoBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    const html = await page.content();
    console.log('  FAIL: no SSO button. snippet:', html.slice(0, 400));
    return false;
  }
  await Promise.all([page.waitForLoadState('domcontentloaded'), ssoBtn.click()]);
  console.log('  after click url:', page.url());
  await loginAuthentikIfPrompted(page);
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  console.log('  final url:', page.url());
  const text = await page.locator('body').innerText().catch(() => '');
  console.log('  page text (first 400):', text.slice(0, 400).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/tmp/argo-sso-final.png' });
  const onArgo = page.url().startsWith('https://argocd.void42.internal/');
  if (onArgo && !page.url().includes('/login')) { console.log('  PASS'); return true; }
  console.log('  FAIL'); return false;
}

// playwright-core wants chromium 1217 but offline cache has 1208 only;
// pin to the executable that's actually on disk.
const browser = await chromium.launch({
  headless: true,
  executablePath: '/config/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--ignore-certificate-errors','--no-sandbox','--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('  pageerror:', e.message));
page.on('response', r => { if (r.status() >= 400) console.log(`  HTTP ${r.status()} ${r.url()}`); });

async function testGenericOIDC({ name, loginUrl, ssoSelector, expectedHostPrefix, successText }) {
  console.log(`\n=== ${name.toUpperCase()} SSO TEST ===`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(e => console.log('  goto err:', e.message));
  // Wait for SPA to render the SSO link/button
  const sel = await page.locator(ssoSelector).first();
  try {
    await sel.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    const html = await page.content();
    console.log(`  FAIL: no SSO selector "${ssoSelector}". snippet:`, html.slice(0, 400));
    return false;
  }
  await Promise.all([page.waitForLoadState('domcontentloaded'), sel.click()]);
  console.log('  after click url:', page.url());
  await loginAuthentikIfPrompted(page);
  // Wait specifically for the URL to leave auth.void42.internal
  await waitForCallbackRedirect(page, expectedHostPrefix, 30000);
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  console.log('  final url:', page.url());
  const text = await page.locator('body').innerText().catch(() => '');
  console.log('  page text (first 400):', text.slice(0, 400).replace(/\n/g, ' | '));
  await page.screenshot({ path: `/tmp/${name}-sso-final.png` });
  // Accept http:// or https:// — apps behind Traefik often see the
  // request as http internally even though the user types https.
  const altPrefix = expectedHostPrefix.replace('https://', 'http://');
  const onApp = page.url().startsWith(expectedHostPrefix) || page.url().startsWith(altPrefix);
  const notOnLoginPage = !page.url().includes('/login');
  const successTextFound = successText ? text.toLowerCase().includes(successText.toLowerCase()) : false;
  const looksLoggedIn = notOnLoginPage || successTextFound;
  if (onApp && looksLoggedIn) { console.log('  PASS'); return true; }
  console.log('  FAIL'); return false;
}

const tests = {
  gitea: () => testGitea(page),
  argocd: () => testArgoCD(page),
  grafana: () => testGenericOIDC({
    name: 'grafana',
    loginUrl: 'https://monitor.void42.internal/login',
    ssoSelector: 'a[href*="/login/generic_oauth"], a:has-text("Sign in with Authentik")',
    expectedHostPrefix: 'https://monitor.void42.internal/',
    successText: 'bot-claude',
  }),
  sonar: () => testGenericOIDC({
    name: 'sonar',
    loginUrl: 'https://sonarqube.void42.internal/sessions/new',
    ssoSelector: 'a:has-text("Authentik"), button:has-text("Authentik")',
    expectedHostPrefix: 'https://sonarqube.void42.internal/',
  }),
  dtrack: () => testGenericOIDC({
    name: 'dtrack',
    loginUrl: 'https://dtrack.void42.internal/login',
    ssoSelector: 'button:has-text("Sign in with Authentik")',
    expectedHostPrefix: 'https://dtrack.void42.internal/',
  }),
  vault: () => testGenericOIDC({
    name: 'vault',
    loginUrl: 'https://vault.void42.internal/ui/vault/auth?with=oidc',
    ssoSelector: 'button[data-test-auth-submit], button:has-text("Sign in with OIDC")',
    expectedHostPrefix: 'https://vault.void42.internal/',
  }),
  bookstack: () => testGenericOIDC({
    name: 'bookstack',
    loginUrl: 'https://docs.void42.internal/login',
    ssoSelector: 'button:has-text("Login with Authentik")',
    expectedHostPrefix: 'https://docs.void42.internal/',
  }),
};

const order = target === 'all' ? Object.keys(tests) : [target];
let ok = true;
for (const t of order) {
  if (!tests[t]) { console.log('unknown:', t); continue; }
  await ctx.clearCookies();
  ok = (await tests[t]()) && ok;
}
await browser.close();
process.exit(ok ? 0 : 1);
