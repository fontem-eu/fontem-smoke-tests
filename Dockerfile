FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Trust the void42 private CA so `npm ci` can reach nexus.void42.internal
# (the npm mirror) via HTTPS without cert errors.
COPY void42-ca.crt /usr/local/share/ca-certificates/void42-ca.crt
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    update-ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/void42-ca.crt

COPY package.json package-lock.json ./
RUN npm ci

COPY playwright.config.js eslint.config.js global-setup.js ./
COPY tests/ tests/
COPY docs/ docs/
# The scheduled DAST scan runs from this image (dast/scheduled-scan.sh),
# so it needs the scan script, the parser and the ignore list.
COPY dast/ dast/
# Upload fixtures. Missing here meant STORY-UPLOAD-SEC-* passed on a
# developer checkout and failed only inside the image, where
# fs.readFile(fixtures/uploads/...) has nothing to read — which is
# exactly the run that gates promotion.
COPY fixtures/ fixtures/

# kubectl + pyyaml for the scheduled DAST scan: the scan publishes its
# verdict into a ConfigMap that the prod-release gate reads, and the
# parser applies dast-ignore.yaml. Pinned to the cluster's minor version.
RUN curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && (pip install --no-cache-dir --break-system-packages pyyaml 2>/dev/null \
        || pip install --no-cache-dir pyyaml)

# Chromium is already present in the base image — matches the pinned
# @playwright/test version so no runtime download is attempted.

# Default target: TESTING, never production. e2e is a promotion gate —
# it runs against testing before staging and against staging before
# prod, and is not pointed at the live site. The promote workflows set
# BASE_URL explicitly; this default only matters if someone runs the
# image by hand.
ENV BASE_URL=https://fontem.testing.void42.internal

CMD ["npx", "playwright", "test", "--project=chromium"]
