# fontem-smoke-tests

Playwright smoke tests for the public web app. Run by CD against the testing env after each deploy (auto), and against prod manually before promote. Catches regressions in the golden user paths.

## Deploy

CI auto-deploys to the testing env on every merge to main. Promotion to staging / prod is **manual** — bump the version in `gitops/<env>/<service>.yaml` to land it in a given environment.

## Convention

See [/config/repos/CLAUDE.md](https://contribute.void42.internal/fontem/gitops) for workspace-wide rules (feature branches + CI gate, no direct push to main, full gate before declaring done, conventional commits).
