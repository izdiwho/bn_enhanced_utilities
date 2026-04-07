# ─── Build stage ─────────────────────────────────────────────────────────────
# Use the Playwright-provided image so Chromium and its system deps are present.
# We use the noble (Ubuntu 24.04) variant which includes Node 20.
FROM mcr.microsoft.com/playwright:v1.52.0-noble AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ─── Runtime stage ────────────────────────────────────────────────────────────
# Same Playwright base image — contains Chromium and all required system libs.
FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# Install production deps (better-sqlite3 needs native build tools)
COPY package.json package-lock.json* ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

# Install the Chromium browser binary for Playwright
RUN npx playwright install chromium

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=4000
ENV DB_DIR=/data

EXPOSE 4000

CMD ["node", "dist/index.js"]
