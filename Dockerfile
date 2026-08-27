FROM mcr.microsoft.com/playwright:v1.61.1-noble

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
# python3-yaml from apt, not pip: this base image ships python3 with no
# pip at all, so `pip install pyyaml` fails and so does the `|| pip`
# fallback — both halves of it were the same missing binary.
RUN curl -fsSLo /usr/local/bin/kubectl https://dl.k8s.io/release/v1.31.0/bin/linux/amd64/kubectl \
    && chmod +x /usr/local/bin/kubectl \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3-yaml \
    && rm -rf /var/lib/apt/lists/*

# Install the browser the INSTALLED package asks for, rather than trusting
# the base image to carry it.
#
# The base image ships browsers for its own version and nothing else, so a
# Renovate bump of @playwright/test on its own left the two out of step and
# every test died at launch with
#
#   browserType.launch: Executable doesn't exist at
#   /ms-playwright/chromium_headless_shell-<build>/chrome-headless-shell
#
# which reads as a broken environment rather than a version mismatch. That
# blocked every promotion three times running (1.60.0, 1.61.0, 1.61.1),
# because nothing links a Dockerfile FROM to a package.json dependency and
# Renovate cannot see across the two.
#
# Done at build time, not at run time, deliberately: this layer already
# reaches the network (kubectl above), whereas the e2e Job is on the
# promotion gate's critical path and currently needs no egress for browsers.
# Downloading per-run would trade a version mismatch for a CDN outage, and an
# ephemeral Job has nowhere to cache to without a shared volume.
#
# `npx playwright install` resolves the build from the version in
# node_modules, so the base image now only has to supply the OS libraries.
# Keep the FROM roughly current for those, but a drifted tag is no longer
# able to break the run.
RUN npx playwright install chromium

# Default target: TESTING, never production. e2e is a promotion gate —
# it runs against testing before staging and against staging before
# prod, and is not pointed at the live site. The promote workflows set
# BASE_URL explicitly; this default only matters if someone runs the
# image by hand.
ENV BASE_URL=https://fontem.testing.void42.internal

CMD ["npx", "playwright", "test", "--project=chromium"]
