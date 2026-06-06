/**
 * Language-switch e2e smoke test.
 *
 * Catches the class of regressions introduced when fontem-web went
 * from one locale (English) to twenty-four: hydration must not crash
 * under strict CSP, switching to a non-English locale must actually
 * change labels on screen, and the pick must persist across reloads.
 *
 * The unit tests pin the i18n message catalogues; this spec pins
 * everything the *deployed bundle* has to get right end-to-end —
 * vue-i18n's message compiler (CSP-safe), the `app.provide('fontem-
 * i18n', …)` wiring, and the per-route document.title swap on locale
 * change.
 *
 * Run: BASE_URL=https://gmr.void42.net npx playwright test i18n.spec.js
 */
import { test, expect } from '@playwright/test'

// Three locales, each with one label the user actually sees on the
// landing page. Pinned against src/locales/<code>.json in fontem-web.
const LOCALES = [
  {
    code: 'de',
    titleContains: 'Öffentliche Datengeschichten',
    feedSubContains: 'Öffentliche Datengeschichten der Community',
    pluralZero: 'keine Aufträge',
    pluralOne: '1 Auftrag',
    pluralMany: '5 Aufträge',
  },
  {
    code: 'fr',
    titleContains: 'Histoires de données publiques',
    feedSubContains: 'Histoires de données publiques',
    pluralZero: 'aucun contrat',
    pluralOne: '1 contrat',
    pluralMany: '5 contrats',
  },
  {
    code: 'pt',
    titleContains: 'Histórias de dados públicas',
    feedSubContains: 'Histórias de dados públicas',
    pluralZero: 'sem contratos',
    pluralOne: '1 contrato',
    pluralMany: '5 contratos',
  },
]

// Reset to a clean English session before every test so prior runs
// don't leak `gmr-lang` into a fresh assertion.
test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.removeItem('gmr-lang')
  })
})

test('English landing renders without hydration crash', async ({ page }) => {
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await page.goto('/', { waitUntil: 'networkidle' })

  // Hydration wipes #app to empty on the regression that motivated this
  // test — the bundle must keep the SSR HTML reactive.
  await expect(page.getByTestId('app-nav')).toBeVisible()
  await expect(page).toHaveTitle(/Fontem/)

  // The three plural badges from I18nPluralProbe are the canonical
  // "did vue-i18n hydrate at all" check — strings the unit tests pin.
  await expect(page.getByTestId('i18n-plural-zero')).toContainText('no contracts')
  await expect(page.getByTestId('i18n-plural-one')).toContainText('1 contract')
  await expect(page.getByTestId('i18n-plural-many')).toContainText('5 contracts')

  expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
})

for (const loc of LOCALES) {
  test(`switching to ${loc.code} updates labels, plural forms and document.title`, async ({ page }) => {
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    await page.goto('/', { waitUntil: 'networkidle' })

    // Open preferences → language picker → select the target locale.
    // The picker is a native <select>, so selectOption is enough.
    await page.getByTestId('prefs-menu-trigger').click()
    await page.getByTestId('lang-picker').selectOption(loc.code)

    // The lang attribute on <html> is the synchronous side effect of
    // useLang.applyLang — a fast assertion that the switch fired
    // before we wait on the slower async locale load.
    await expect.poll(
      () => page.evaluate(() => document.documentElement.lang),
      { timeout: 5000 },
    ).toBe(loc.code)

    // Plural badges re-render once setLocaleMessage resolves and the
    // watcher ticks; this is the assertion that pins the CSP / new
    // Function regression. Reads the *displayed* text after the
    // locale switch.
    await expect(page.getByTestId('i18n-plural-zero')).toContainText(loc.pluralZero)
    await expect(page.getByTestId('i18n-plural-one')).toContainText(loc.pluralOne)
    await expect(page.getByTestId('i18n-plural-many')).toContainText(loc.pluralMany)

    // useDocumentMeta writes the title from meta.title.home; pinned
    // per locale so a missing translation surfaces as a failure, not
    // a silent fall-back to English.
    await expect.poll(
      () => page.title(),
      { timeout: 5000 },
    ).toContain(loc.titleContains)

    // A second i18n-driven label that lives in body content — proves
    // template strings (not just <head>) re-render.
    const feedSub = page.locator('.feed-sub').first()
    await expect(feedSub).toContainText(loc.feedSubContains)

    expect(pageErrors, `unexpected pageerrors after switch to ${loc.code}: ${pageErrors.join(' | ')}`).toEqual([])

    // Persistence across reload — gmr-lang in localStorage should keep
    // the locale, and the same labels should render on the fresh page.
    await page.reload({ waitUntil: 'networkidle' })
    await expect.poll(
      () => page.evaluate(() => document.documentElement.lang),
      { timeout: 5000 },
    ).toBe(loc.code)
    await expect(page.getByTestId('i18n-plural-many')).toContainText(loc.pluralMany)
  })
}
