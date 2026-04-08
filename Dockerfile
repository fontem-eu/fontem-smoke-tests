FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY playwright.config.js eslint.config.js ./
COPY tests/ tests/
COPY docs/ docs/

# Install only chromium (all we need for smoke tests)
RUN npx playwright install chromium

# Default target
ENV BASE_URL=https://gmr.void42.net

CMD ["npx", "playwright", "test", "--project=chromium"]
