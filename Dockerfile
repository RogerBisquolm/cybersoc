# ─────────────────────────────────────────────
# Stage 1: Build
# ─────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies only (layer cache)
COPY package*.json ./
RUN npm ci --omit=dev

# ─────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────
FROM node:20-alpine

LABEL org.opencontainers.image.title="CyberSOC Alpha"
LABEL org.opencontainers.image.description="Real-Time Cyber Attack Map Dashboard"
LABEL org.opencontainers.image.version="1.0.0"

WORKDIR /app

# Install tar (needed by updateGeoDb.js to extract MaxMind archive)
RUN apk add --no-cache tar

# Copy installed modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY package.json  ./
COPY server.js     ./
COPY src/          ./src/
COPY public/       ./public/

# Copy GeoIP updater script
COPY scripts/updateGeoDb.js ./scripts/updateGeoDb.js

# GeoLite2 cron: every Tuesday at 06:00 UTC
# Logs are forwarded to Docker log stream via /proc/1/fd/1
RUN echo '0 6 * * 2  cd /app && node scripts/updateGeoDb.js >> /proc/1/fd/1 2>&1' \
  > /etc/crontabs/root

# Copy and prepare entrypoint
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Data directory (MaxMind .mmdb mounted here)
RUN mkdir -p /app/data

# Expose HTTP + UDP Syslog ports
EXPOSE 3000
EXPOSE 5514/udp

# Environment defaults (override via docker-compose or -e flags)
ENV PORT=3000 \
  SYSLOG_PORT=5514 \
  DEMO_MODE=true \
  NODE_ENV=production

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/api/lockdown || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
