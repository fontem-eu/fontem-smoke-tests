#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Scheduled DAST scan — runs IN-CLUSTER, every 3 days.
#
# Distinct from run-dast-scan.sh, which is the workstation entrypoint:
# that one drives both the fontem-web e2e suite and this repo's smoke
# suite, and needs both git checkouts on local disk. This one runs from
# the smoke-tests image, so it drives the suite it ships with. Less
# traffic, but it runs unattended and on a schedule — which is the whole
# point, since the last unattended run before this was 2026-06-15.
#
# ZAP is a long-lived Deployment here rather than a Job. That means no
# RBAC to create Jobs and no waiting for a pod to schedule; the session
# is reset with core/action/newSession at the start of every run, which
# is what a fresh Job would have given us anyway.
#
# Ends by writing the verdict into a ConfigMap that the prod-release PR
# check reads. If this script dies, that ConfigMap goes stale, and the
# check fails on staleness — a broken scanner blocks releases instead of
# silently passing them.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

ZAP="${ZAP_URL:-http://zap.fontem-dast.svc.cluster.local:8080}"
TARGET="${TARGET_URL:-https://fontem.dast.void42.internal}"
TARGET_CAPI="${TARGET_CAPI:-${TARGET}/capi}"
NS="${DAST_NAMESPACE:-fontem-dast}"
CM="${STATUS_CONFIGMAP:-dast-latest-report}"
WORK="${WORK_DIR:-/work}"
ASCAN_TIMEOUT="${ASCAN_TIMEOUT:-1800}"
PSCAN_TIMEOUT="${PSCAN_TIMEOUT:-600}"
# Traffic floor. The 2026-07-31 authenticated run produced 8,500+
# messages; the unauthenticated June run produced 151 and looked clean.
# 1500 sits well above "the suite barely started" and well below a
# healthy run, so it catches starvation without being brittle.
MIN_MESSAGES="${MIN_MESSAGES:-1500}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

mkdir -p "$WORK"

# ── Wait for ZAP ────────────────────────────────────────────
log "Waiting for ZAP at $ZAP"
for _ in $(seq 1 60); do
    V=$(curl -sf --max-time 5 "$ZAP/JSON/core/view/version/" 2>/dev/null \
        | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])" 2>/dev/null || true)
    [ -n "${V:-}" ] && { log "ZAP $V ready"; break; }
    sleep 5
done
[ -n "${V:-}" ] || { log "FATAL: ZAP never became ready"; exit 1; }

# Fresh session — this Deployment is long-lived, so without it every run
# would inherit the previous run's alerts and the diff would be empty.
log "Starting a new ZAP session"
curl -sf --max-time 30 "$ZAP/JSON/core/action/newSession/?name=scan-$(date -u +%Y%m%d-%H%M)&overwrite=true" >/dev/null

# ── Traffic: drive the smoke suite through the proxy ────────
log "Ensuring test users exist"
for U in '{"email":"researcher@fontem.eu","password":"TestPass123!","name":"Test User"}' \
         '{"email":"fuzz@example.com","password":"FuzzPass123!","name":"Fuzz"}'; do
    curl -sf -k -X POST "$TARGET_CAPI/auth/register" -H 'Content-Type: application/json' \
         -d "$U" >/dev/null 2>&1 || true
done

log "Running smoke suite through the ZAP proxy (passive scan)"
# `|| true` on purpose: a failing assertion still generated the traffic
# we are here to scan. Test health is the e2e gate's job, not this one's.
#
# The whole output is kept, not tail -5. When the suite dies early the
# scan is starved of traffic, and the reason is in the lines tail -5
# throws away — the first run in-cluster reported "72 did not run" and
# there was nothing left in the log to say why.
BASE_URL="$TARGET" PLAYWRIGHT_PROXY="$ZAP" \
    npx playwright test --project=chromium --grep-invert "ASSIST" \
    > "$WORK/playwright.log" 2>&1 || true
tail -40 "$WORK/playwright.log" || true

# A scan is only as good as the traffic it saw. ZAP finding nothing
# because the suite never exercised the app is not a clean bill of
# health, and it must not be allowed to read as one.
MSGS=$(curl -s --max-time 10 "$ZAP/JSON/core/view/numberOfMessages/" \
       | python3 -c "import json,sys;print(json.load(sys.stdin).get('numberOfMessages','0'))" 2>/dev/null || echo 0)
log "ZAP saw $MSGS messages (floor: $MIN_MESSAGES)"
if [ "$MSGS" -lt "$MIN_MESSAGES" ]; then
    log "::error:: only $MSGS messages — the suite did not exercise the app"
    log "Last 40 lines of the suite output are above. Not publishing a verdict:"
    log "a PASS from a starved scan is worse than no scan at all."
    exit 1
fi

# ── Passive drain (bounded + stall-aware, same as run-dast-scan.sh) ──
log "Draining the passive scan queue"
START=$(date +%s); LAST=""; STALL=0
while true; do
    [ $(( $(date +%s) - START )) -gt "$PSCAN_TIMEOUT" ] && { log "passive timeout — proceeding"; break; }
    RAW=$(curl -s --max-time 10 "$ZAP/JSON/pscan/view/recordsToScan/" || echo '{}')
    R=$(echo "$RAW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('recordsToScan','?'))" 2>/dev/null || echo "?")
    [ "$R" = "0" ] && break
    if [ "$R" = "$LAST" ]; then
        STALL=$((STALL+1)); [ "$STALL" -ge 12 ] && { log "passive stalled at $R — proceeding"; break; }
    else STALL=0; fi
    LAST="$R"; sleep 5
done

# ── Active scan ─────────────────────────────────────────────
log "Active scan against $TARGET_CAPI"
# curl -sf yields an EMPTY body on an HTTP error, so an unguarded
# json.load here dies with a decoder traceback that says nothing about
# what ZAP actually objected to. It failed exactly this way on the first
# in-cluster run — "url_not_found: URL Not Found in the Scan Tree",
# invisible behind a JSONDecodeError.
ASCAN_RAW=$(curl -s --max-time 30 "$ZAP/JSON/ascan/action/scan/?url=${TARGET_CAPI}&recurse=true&inScopeOnly=false" || echo '')
SID=$(echo "$ASCAN_RAW" | python3 -c "import json,sys;print(json.load(sys.stdin)['scan'])" 2>/dev/null || echo '')
if [ -z "$SID" ]; then
    log "::error:: ZAP refused to start the active scan against $TARGET_CAPI"
    log "ZAP said: ${ASCAN_RAW:-<empty response>}"
    exit 1
fi
START=$(date +%s)
while true; do
    [ $(( $(date +%s) - START )) -gt "$ASCAN_TIMEOUT" ] && { log "active scan timeout — partial results"; break; }
    RAW=$(curl -s --max-time 10 "$ZAP/JSON/ascan/view/status/?scanId=${SID}" || echo '{}')
    S=$(echo "$RAW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status','0'))" 2>/dev/null || echo "0")
    [ "$S" = "100" ] && break
    log "active scan ${S}%"
    sleep 15
done
log "Active scan done"

# ── Parse, diff, verdict ────────────────────────────────────
log "Fetching alerts"
curl -sf --max-time 120 "$ZAP/JSON/alert/view/alerts/?baseurl=${TARGET}&start=0&count=10000" \
     -o "$WORK/alerts.json"

# The previous run's summary is the diff baseline. Pulled from the
# ConfigMap so history survives this pod.
kubectl -n "$NS" get configmap "$CM" -o jsonpath='{.data.dast-summary\.json}' \
    > "$WORK/previous.json" 2>/dev/null || true
[ -s "$WORK/previous.json" ] || rm -f "$WORK/previous.json"

log "Parsing"
set +e
python3 "$(dirname "$0")/parse-report.py" \
    --alerts "$WORK/alerts.json" \
    --ignore "$(dirname "$0")/dast-ignore.yaml" \
    ${PREV:+} $( [ -f "$WORK/previous.json" ] && echo "--previous $WORK/previous.json" ) \
    --out-dir "$WORK"
VERDICT=$?
set -e
log "Parser verdict exit=$VERDICT"

# ── Publish ─────────────────────────────────────────────────
# Written whether the verdict passed or failed — the gate needs to see a
# FAIL, and a missing ConfigMap is indistinguishable from a scan that
# never ran.
log "Publishing to configmap $NS/$CM"
kubectl -n "$NS" create configmap "$CM" \
    --from-file=dast-summary.json="$WORK/dast-summary.json" \
    --from-file=dast-summary.md="$WORK/dast-summary.md" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$NS" annotate configmap "$CM" --overwrite \
    "dast/completed-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "dast/verdict=$( [ "$VERDICT" -eq 0 ] && echo pass || echo fail )" >/dev/null

log "Done — verdict=$( [ "$VERDICT" -eq 0 ] && echo pass || echo fail )"
# Exit non-zero on a failing verdict so the Job shows as Failed and the
# scan itself is visible in `kubectl get jobs`, not just in the ConfigMap.
exit "$VERDICT"
