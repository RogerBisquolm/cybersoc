#!/bin/sh
# ─────────────────────────────────────────────────────────────
# CyberSOC Alpha — Docker Entrypoint
# 1. Initial GeoLite2 download (if DB missing or older than 6 days)
# 2. Start crond in background (weekly update every Tuesday 06:00 UTC)
# 3. Exec node server.js in foreground
# ─────────────────────────────────────────────────────────────

set -e

DB_PATH="/app/data/GeoLite2-City.mmdb"
SCRIPT="/app/scripts/updateGeoDb.js"

# ── GeoIP initial update ───────────────────────────────────
if [ -z "${MAXMIND_LICENSE_KEY}" ]; then
  echo "[geoip] ⚠  MAXMIND_LICENSE_KEY not set — skipping GeoLite2 download."
else
  NEEDS_UPDATE=0
  if [ ! -f "${DB_PATH}" ]; then
    echo "[geoip] DB not found — running initial download…"
    NEEDS_UPDATE=1
  elif [ -n "$(find "${DB_PATH}" -mmin +8640 2>/dev/null)" ]; then
    echo "[geoip] DB older than 6 days — updating…"
    NEEDS_UPDATE=1
  else
    echo "[geoip] ✅ GeoLite2 DB up to date ($(du -h ${DB_PATH} | cut -f1))"
  fi

  if [ "${NEEDS_UPDATE}" -eq 1 ]; then
    node "${SCRIPT}" || echo "[geoip] ⚠  Download failed — continuing without update."
  fi
fi

# ── Start crond in background ──────────────────────────────
echo "[geoip] ⏰ Starting crond (weekly update: Tue 06:00 UTC)…"
crond -b -d 8 -c /etc/crontabs

# ── Start CyberSOC server in foreground ───────────────────
echo "[server] Starting CyberSOC Alpha…"
exec node server.js
