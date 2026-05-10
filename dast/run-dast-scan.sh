#!/bin/bash
# ─────────────────────────────────────────────────────────────
# DAST scan orchestrator
#
# Spins up ZAP in daemon mode, drives e2e + smoke tests through
# its proxy (passive scan), runs an active scan, then uploads
# the HTML report to BookStack.
#
# Usage:  ./run-dast-scan.sh
# Prereq: kubectl access to the gmr-dast namespace
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve SCRIPT_DIR *before* any `cd` later in the script. We used to
# compute this lazily at the upload step, by which point we had already
# cd'd into the smoke-tests repo root, so `dirname "$0"` pointed at the
# repo root instead of ./dast — the upload script couldn't be found
# and the report never made it to BookStack.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NAMESPACE="gmr-dast"
# Use the external ingress (HTTPS) as the traffic source for the DAST
# scan — exactly what real users hit. The smoke tests' playwright
# config already skips cert validation for *.void42.internal (private
# PKI), so self-signed internal certs aren't a blocker.
TARGET_URL="https://fontem.dast.void42.internal"
TARGET_CAPI="https://fontem.dast.void42.internal/capi"
ZAP_SERVICE="zap.${NAMESPACE}.svc.cluster.local:8080"
BOOKSTACK_URL="http://bookstack.bookstack.svc.cluster.local"
RUN_ID="run_$(date -u +%Y%m%d_%H%M)"

# BookStack API credentials
BOOKSTACK_TOKEN_ID=$(kubectl -n "$NAMESPACE" get secret bookstack-api -o jsonpath='{.data.token_id}' | base64 -d)
BOOKSTACK_TOKEN_SECRET=$(kubectl -n "$NAMESPACE" get secret bookstack-api -o jsonpath='{.data.token_secret}' | base64 -d)
BOOKSTACK_AUTH="Token ${BOOKSTACK_TOKEN_ID}:${BOOKSTACK_TOKEN_SECRET}"

SMOKE_REPO="/config/repos/gmr-smoke-tests"
WEB_REPO="/config/repos/gmr-web"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

cleanup() {
    log "Cleaning up..."
    kubectl -n "$NAMESPACE" delete job "$JOB_NAME" --ignore-not-found 2>/dev/null || true
}
trap cleanup EXIT

# ── Phase 1: Start ZAP ─────────────────────────────────────
JOB_NAME="zap-scan-$(date +%s)"
log "Creating ZAP job: $JOB_NAME"
kubectl create job "$JOB_NAME" --from=cronjob/zap-dast -n "$NAMESPACE"

# Point the ZAP service at this specific job's pods
kubectl -n "$NAMESPACE" patch svc zap --type merge \
    -p "{\"spec\":{\"selector\":{\"job-name\":\"${JOB_NAME}\"}}}"

log "Waiting for ZAP to be ready..."
kubectl -n "$NAMESPACE" wait --for=condition=ready \
    pod -l "job-name=${JOB_NAME}" --timeout=120s

# Wait for the ZAP API to respond
for i in $(seq 1 120); do
    if curl -sf "http://${ZAP_SERVICE}/JSON/core/view/version/" >/dev/null 2>&1; then
        ZAP_VERSION=$(curl -sf "http://${ZAP_SERVICE}/JSON/core/view/version/" | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
        log "ZAP $ZAP_VERSION is ready"
        break
    fi
    sleep 2
done

# ── Phase 2: Spider the target ──────────────────────────────
log "Spidering target: $TARGET_URL"
curl -sf "http://${ZAP_SERVICE}/JSON/spider/action/scan/?url=${TARGET_URL}&maxChildren=10&recurse=true" >/dev/null

# Also spider the community API health/openapi endpoints
curl -sf "http://${ZAP_SERVICE}/JSON/spider/action/scan/?url=${TARGET_CAPI}/health&maxChildren=5" >/dev/null
curl -sf "http://${ZAP_SERVICE}/JSON/spider/action/scan/?url=${TARGET_CAPI}/openapi.json&maxChildren=5" >/dev/null

# Wait for spider to complete
while true; do
    STATUS=$(curl -sf "http://${ZAP_SERVICE}/JSON/spider/view/status/" | python3 -c "import json,sys;print(json.load(sys.stdin)['status'])")
    [ "$STATUS" = "100" ] && break
    log "Spider progress: ${STATUS}%"
    sleep 5
done
log "Spider complete"

# ── Phase 2.5: Make sure the test users exist in the dast DB ──
# Registration is idempotent — API returns 409/400 if the user
# already exists. Without the researcher user, global-setup.js fails
# to log in and the passive scan has nothing to record. The fuzz
# user is used by Schemathesis in Phase 3.5 below; kept distinct
# so property-based inputs can't hit destructive endpoints with the
# same privileges the smoke tests rely on.
log "Ensuring test users are registered in dast..."
curl -sf -k -X POST "${TARGET_CAPI}/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"email":"researcher@gmr.test","password":"TestPass123!","name":"Test User"}' \
    >/dev/null 2>&1 || true
curl -sf -k -X POST "${TARGET_CAPI}/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"email":"fuzz@gmr.test","password":"FuzzPass123!","name":"Schemathesis Fuzz"}' \
    >/dev/null 2>&1 || true

# ── Phase 3: Passive scan — e2e + smoke tests through ZAP ──
log "Running e2e tests through ZAP proxy (passive scan)..."
cd "$WEB_REPO"
BASE_URL="https://fontem.dast.void42.internal" \
    npx playwright test --project=chromium \
    --config=playwright.config.js \
    --grep-invert "ASSIST" 2>&1 | tail -5 || true

log "Running smoke tests through ZAP proxy (passive scan)..."
cd "$SMOKE_REPO"
BASE_URL="https://fontem.dast.void42.internal" \
    npx playwright test --project=chromium \
    --grep-invert "ASSIST" 2>&1 | tail -5 || true

# Wait for passive scan to process all recorded traffic
log "Waiting for passive scan to complete..."
while true; do
    RECORDS=$(curl -sf "http://${ZAP_SERVICE}/JSON/pscan/view/recordsToScan/" | python3 -c "import json,sys;print(json.load(sys.stdin)['recordsToScan'])")
    [ "$RECORDS" = "0" ] && break
    log "Passive scan: $RECORDS records remaining"
    sleep 5
done
log "Passive scan complete"

# ── Phase 4: Active scan ────────────────────────────────────
log "Starting active scan against $TARGET_CAPI"
SCAN_ID=$(curl -sf "http://${ZAP_SERVICE}/JSON/ascan/action/scan/?url=${TARGET_CAPI}&recurse=true&inScopeOnly=false" | python3 -c "import json,sys;print(json.load(sys.stdin)['scan'])")
log "Active scan started (ID: $SCAN_ID)"

ASCAN_START=$(date +%s)
ASCAN_TIMEOUT=1800  # 30 minutes max for active scan
while true; do
    ELAPSED=$(( $(date +%s) - ASCAN_START ))
    if [ "$ELAPSED" -gt "$ASCAN_TIMEOUT" ]; then
        log "Active scan timed out after ${ASCAN_TIMEOUT}s — proceeding with partial results"
        break
    fi
    RAW=$(curl -s --max-time 10 "http://${ZAP_SERVICE}/JSON/ascan/view/status/?scanId=${SCAN_ID}" || echo '{}')
    STATUS=$(echo "$RAW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status','0'))" 2>/dev/null || echo "0")
    [ "$STATUS" = "100" ] && break
    log "Active scan progress: ${STATUS}%"
    sleep 15
done
log "Active scan complete"

# ── Phase 5: Generate and download report ────────────────────
REPORT_FILE="/tmp/zap-report-${RUN_ID}.html"
log "Downloading HTML report..."
curl -sf "http://${ZAP_SERVICE}/OTHER/core/other/htmlreport/" -o "$REPORT_FILE"

# ── Phase 6: Upload to BookStack ─────────────────────────────
log "Uploading report to BookStack..."
BOOKSTACK_URL="$BOOKSTACK_URL" \
BOOKSTACK_TOKEN_ID="$BOOKSTACK_TOKEN_ID" \
BOOKSTACK_TOKEN_SECRET="$BOOKSTACK_TOKEN_SECRET" \
    python3 "${SCRIPT_DIR}/upload-zap-report.py" \
        "$REPORT_FILE" \
        "http://${ZAP_SERVICE}" \
        "$RUN_ID" \
        "$TARGET_CAPI"

log "ZAP phases complete — report uploaded to BookStack"
rm -f "$REPORT_FILE"

# ── Phase 7: Schemathesis API fuzzing ───────────────────────
# Runs LAST and intentionally outside the ZAP critical path.
# Property-based fuzz of /capi/openapi.json using the fuzz user
# (narrower privileges than researcher — can't trigger destructive
# mutations even if Schemathesis generates inputs that try).
#
# Pulled out of the ZAP critical path on 2026-05-10: with `--rate-limit
# 1/s` (pinned under nginx.conf's `limit_req sustained=1r/s` on /capi/)
# the fuzz takes ~95 min for the current ~5,000-case surface, exceeding
# even the bumped 7,200 s ZAP daemon deadline if the active scan also
# runs after. Doing schemathesis last lets the ZAP daemon die naturally
# while we keep generating signal.
if ! command -v schemathesis >/dev/null 2>&1; then
    pip install --user --break-system-packages --quiet schemathesis || true
    export PATH="$HOME/.local/bin:$PATH"
fi

if command -v schemathesis >/dev/null 2>&1; then
    log "Authenticating fuzz user..."
    FUZZ_JWT=$(curl -sf -k -X POST "${TARGET_CAPI}/auth/login" \
        -H "Content-Type: application/json" \
        -d '{"email":"fuzz@gmr.test","password":"FuzzPass123!"}' \
        | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
    if [ -n "$FUZZ_JWT" ]; then
        log "Running Schemathesis fuzz against ${TARGET_CAPI}/openapi.json..."
        # --max-examples 20 keeps each endpoint's hypothesis search to
        # ~20 generated inputs — smoke-style fuzz, not exhaustive
        # property testing. --tls-verify=false because the dast env
        # serves TLS via the void42 private CA that Python's requests
        # store doesn't trust by default.
        schemathesis run \
            --tls-verify=false \
            --url "${TARGET_CAPI}" \
            --max-examples=20 \
            --rate-limit 1/s \
            --header "Authorization: Bearer ${FUZZ_JWT}" \
            --report junit \
            --report-junit-path /tmp/schemathesis.xml \
            "${TARGET_CAPI}/openapi.json" 2>&1 | tail -40 || true
        log "Schemathesis complete — report at /tmp/schemathesis.xml"
    else
        log "Fuzz user auth failed; skipping Schemathesis"
    fi
else
    log "Schemathesis install failed; skipping (pip --break-system-packages not allowed?)"
fi

log "Done!"
