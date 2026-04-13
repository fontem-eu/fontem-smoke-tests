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

NAMESPACE="gmr-dast"
TARGET_URL="http://gmr-web.${NAMESPACE}.svc.cluster.local"
TARGET_CAPI="http://gmr-community-api.${NAMESPACE}.svc.cluster.local:8001"
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
for i in $(seq 1 30); do
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

# ── Phase 3: Passive scan — e2e + smoke tests through ZAP ──
log "Running e2e tests through ZAP proxy (passive scan)..."
cd "$WEB_REPO"
BASE_URL="http://gmr-dast.void42.internal" \
    npx playwright test --project=chromium \
    --config=playwright.config.js \
    --grep-invert "ASSIST" 2>&1 | tail -5 || true

log "Running smoke tests through ZAP proxy (passive scan)..."
cd "$SMOKE_REPO"
BASE_URL="http://gmr-dast.void42.internal" \
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOKSTACK_URL="$BOOKSTACK_URL" \
BOOKSTACK_TOKEN_ID="$BOOKSTACK_TOKEN_ID" \
BOOKSTACK_TOKEN_SECRET="$BOOKSTACK_TOKEN_SECRET" \
    python3 "${SCRIPT_DIR}/upload-zap-report.py" \
        "$REPORT_FILE" \
        "http://${ZAP_SERVICE}" \
        "$RUN_ID" \
        "$TARGET_CAPI"

log "Done!"
rm -f "$REPORT_FILE"
