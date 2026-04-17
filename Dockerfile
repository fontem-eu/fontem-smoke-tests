FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY playwright.config.js eslint.config.js ./
COPY tests/ tests/
COPY docs/ docs/

# Chromium is already present in the base image — matches the pinned
# @playwright/test version so no runtime download is attempted.

# Default target
ENV BASE_URL=https://gmr.void42.net

CMD ["npx", "playwright", "test", "--project=chromium"]
