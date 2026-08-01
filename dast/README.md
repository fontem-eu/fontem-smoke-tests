# DAST

The scan runs itself: a CronJob (`dast-scan`, every 3 days) in
`fontem-dast`, defined in `gitops/infra/dast.yaml`. It drives the smoke
suite through ZAP as a proxy, runs an active scan against the API,
applies `dast-ignore.yaml`, and publishes a verdict to the
`dast-latest-report` ConfigMap. The production promotion gate reads that
verdict — see `fontem-prod-release`.

## Run one now

```
kubectl -n fontem-dast create job dast-now --from=cronjob/dast-scan
kubectl -n fontem-dast logs -f job/dast-now
```

## Read the last verdict

```
kubectl -n fontem-dast get cm dast-latest-report \
  -o jsonpath='{.metadata.annotations.dast/verdict}{"  "}{.metadata.annotations.dast/completed-at}'
kubectl -n fontem-dast get cm dast-latest-report -o jsonpath='{.data.dast-summary\.md}'
```

## Suppressing a false positive

Add a rule to `dast-ignore.yaml`. Every rule **must** carry a `reason` —
the parser rejects the file otherwise, so nothing gets silenced silently.
Include the evidence that made you conclude it is a false positive, not
just an assertion that it is one.

## Why the workstation script is gone

`run-dast-scan.sh`, `zap-cronjob.yaml` and `upload-zap-report.py` were
removed on 2026-08-01. They drove a CronJob suspended on `0 0 31 2 *` —
February 31st, a date that never arrives — which existed only as a
template for a human to run by hand. The last human did so on 2026-06-15
and nothing ran it after that. Nothing noticed for six weeks, because a
suspended CronJob and a working one look the same in `kubectl get cronjob`
until you read the schedule.

A scan nobody runs is worse than no scan: it reads as coverage.
