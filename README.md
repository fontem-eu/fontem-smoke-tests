# fontem-smoke-tests

Playwright end-to-end tests for the public web app.

## How these run: as a promotion gate, not on a schedule

e2e is a **gate**. It runs on demand, before a version moves forward, and
a failure blocks the promotion:

| Gate | Runs against | Blocks |
|---|---|---|
| `gitops` **promote.yml** (automatic, on any `testing/**` bump) | `fontem.testing.void42.internal` | testing → staging + dast |
| `gitops` **promote-prod.yml** (manual dispatch) | `fontem.staging.void42.internal` | staging → prod |

**e2e is never run against production.** Nothing reaches staging that
has not passed e2e in testing, and nothing reaches prod that has not
passed e2e in staging.

There are deliberately **no CronJobs**. Both workflows render
`deployment/e2e-job.yaml` (substituting `E2E_NAMESPACE`, `E2E_ENV`,
`E2E_BASE_URL`, `E2E_IMAGE_TAG`) and create a one-shot Job in the target
namespace, then wait on it and fail the promotion if it does not
complete. `BASE_URL` is supplied per
environment; the default in `playwright.config.js` is the testing host,
so a bare run cannot reach the live site by accident.

> Removed 2026-07-29. The previous arrangement gated nothing: the gate
> step in `promote.yml` was hard-disabled with `if: ${{ false && … }}`,
> and the two CronJobs that fed it were both suspended — the testing one
> had not succeeded since 2026-05-30 and the staging one had never
> succeeded at all. Worse, the CronJob named `fontem-smoke-tests-prod`
> ran in the **fontem-staging** namespace with `BASE_URL` pointed at
> `https://www.fontem.eu`, i.e. the "staging" schedule was aimed at
> production. With nothing enforcing them, the sibling suite in
> `fontem-web/tests/e2e/` rotted to 52 of 114 `data-testid`s no longer
> present in `src/`.

## Running it by hand

```sh
BASE_URL=https://fontem.testing.void42.internal \
TEST_EMAIL=... TEST_PASSWORD=... \
npx playwright test --project=chromium
```

Credentials live in the `gmr-smoke-creds` secret in `fontem-testing` and
`fontem-staging` (synced from Vault at `secret/gmr-staging/smoke-creds`):

```sh
export TEST_EMAIL=$(kubectl get secret gmr-smoke-creds -n fontem-testing -o jsonpath='{.data.email}' | base64 -d)
export TEST_PASSWORD=$(kubectl get secret gmr-smoke-creds -n fontem-testing -o jsonpath='{.data.password}' | base64 -d)
```

Or run it exactly as the gate does, in-cluster:

```sh
E2E_NAMESPACE=fontem-testing E2E_ENV=testing \
E2E_BASE_URL=https://fontem.testing.void42.internal \
E2E_IMAGE_TAG=$(sed -n '1s/.*"\(.*\)".*/\1/p' ../gitops/testing/fontem-smoke-tests.yaml) \
sed -e "s|\${E2E_NAMESPACE}|$E2E_NAMESPACE|g" \
    -e "s|\${E2E_ENV}|$E2E_ENV|g" \
    -e "s|\${E2E_BASE_URL}|$E2E_BASE_URL|g" \
    -e "s|\${E2E_IMAGE_TAG}|$E2E_IMAGE_TAG|g" \
    deployment/e2e-job.yaml | kubectl create -f -
```

`global-setup.js` does one API login and shares the resulting
storageState across the suite — `/capi/auth/login` is rate-limited to
5/min per IP, so don't reintroduce per-test UI logins.

## Deploy

CI auto-deploys the image to the testing env on every merge to main.
Promotion to staging and prod is handled by the gitops workflows above.

## Convention

See [/config/repos/CLAUDE.md](https://contribute.void42.internal/fontem/gitops)
for workspace-wide rules (feature branches + CI gate, no direct push to
main, full gate before declaring done, conventional commits).
