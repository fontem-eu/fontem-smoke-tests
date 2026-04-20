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

# Chromium is already present in the base image — matches the pinned
# @playwright/test version so no runtime download is attempted.

# Default target
ENV BASE_URL=https://gmr.void42.net

CMD ["npx", "playwright", "test", "--project=chromium"]
