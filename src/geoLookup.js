/**
 * Geo-IP Lookup — MaxMind GeoLite2 + geoip-lite fallback
 *
 * Priority:
 *   1. MaxMind GeoLite2-City.mmdb  (highest accuracy, city-level)
 *   2. geoip-lite bundled database  (fallback, country-level)
 *
 * To enable MaxMind:
 *   1. Register free: https://www.maxmind.com/en/geolite2/signup
 *   2. Get license key from: https://www.maxmind.com/en/accounts/current/license-key
 *   3. Run: MAXMIND_LICENSE_KEY=<key> node scripts/updateGeoDb.js
 *   4. Restart server — it auto-detects ./data/GeoLite2-City.mmdb
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import geoipLite from 'geoip-lite';
import maxmind from 'maxmind';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MMDB_PATH = path.join(__dirname, '..', 'data', 'GeoLite2-City.mmdb');

// MaxMind reader (loaded if .mmdb file exists)
let mmdbReader = null;
let mmdbAvailable = false;

/**
 * Initialize the MaxMind reader.
 * Called once on server startup — async, non-blocking.
 */
export async function initGeoLookup() {
    if (!fs.existsSync(MMDB_PATH)) {
        console.log('[GeoIP] MaxMind GeoLite2-City.mmdb not found → using geoip-lite (fallback)');
        console.log(`[GeoIP] To enable MaxMind: MAXMIND_LICENSE_KEY=<key> node scripts/updateGeoDb.js`);
        return;
    }

    try {
        mmdbReader = await maxmind.open(MMDB_PATH, {
            watchForUpdates: true,   // Auto-reload if DB file is replaced
            watchForUpdatesNonPersistent: true,
        });
        mmdbAvailable = true;

        const stat = fs.statSync(MMDB_PATH);
        console.log(`[GeoIP] ✅ MaxMind GeoLite2-City loaded (${(stat.size / 1e6).toFixed(1)} MB)`);
        console.log(`[GeoIP]    Path: ${MMDB_PATH}`);
    } catch (err) {
        console.error('[GeoIP] MaxMind load failed:', err.message, '→ using geoip-lite');
        mmdbReader = null;
        mmdbAvailable = false;
    }
}

/**
 * Look up geo information for an IP address.
 * Uses MaxMind GeoLite2-City if available, otherwise geoip-lite.
 *
 * @param {string} ip - IPv4 or IPv6 address
 * @returns {{ lat: number, lon: number, country: string, countryCode: string, city: string, region: string, timezone: string } | null}
 */
export function lookupIp(ip) {
    if (!ip) return null;
    if (isPrivateIp(ip)) return null;

    // ── MaxMind GeoLite2 (best accuracy) ──────────────────
    if (mmdbAvailable && mmdbReader) {
        try {
            const result = mmdbReader.get(ip);
            if (result) {
                const lat = result.location?.latitude;
                const lon = result.location?.longitude;
                if (lat != null && lon != null) {
                    return {
                        lat,
                        lon,
                        country: result.country?.names?.en || result.registered_country?.names?.en || 'Unknown',
                        countryCode: result.country?.iso_code || result.registered_country?.iso_code || '',
                        city: result.city?.names?.en || '',
                        region: result.subdivisions?.[0]?.names?.en || '',
                        timezone: result.location?.time_zone || '',
                        postalCode: result.postal?.code || '',
                        accuracy: result.location?.accuracy_radius || null,
                        source: 'maxmind',
                    };
                }
            }
        } catch (err) {
            // MaxMind lookup failed for this IP — fall through to geoip-lite
        }
    }

    // ── geoip-lite fallback ────────────────────────────────
    const geo = geoipLite.lookup(ip);
    if (!geo || !geo.ll) return null;

    return {
        lat: geo.ll[0],
        lon: geo.ll[1],
        country: geo.country || 'Unknown',
        countryCode: geo.country || '',
        city: geo.city || '',
        region: geo.region || '',
        timezone: geo.timezone || '',
        postalCode: '',
        accuracy: null,
        source: 'geoip-lite',
    };
}

/**
 * Returns which database is currently active.
 * @returns {'maxmind' | 'geoip-lite'}
 */
export function getGeoSource() {
    return mmdbAvailable ? 'maxmind' : 'geoip-lite';
}

/**
 * Check if IP is in a private/reserved range.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === '::1') return true;

    const privateRanges = [
        /^10\./,
        /^192\.168\./,
        /^172\.(1[6-9]|2\d|3[01])\./,
        /^169\.254\./,
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
        /^::1$/,
        /^fe80:/i,
        /^fc00:/i,
        /^fd/i,
    ];

    return privateRanges.some((re) => re.test(ip));
}

export default { initGeoLookup, lookupIp, getGeoSource };
