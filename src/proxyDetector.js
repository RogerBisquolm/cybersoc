/**
 * Proxy / VPN / Hosting Detector
 * Uses ip-api.com (free tier, no API key, 45 req/min).
 * Results are cached for 24 hours to avoid rate limiting.
 *
 * API docs: https://ip-api.com/docs/api:json
 */

import http from 'http';

// Cache: ip → { isProxy, isVpn, isHosting, ts }
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Rate limiter: minimum 1.5s between requests (safe for 45 req/min limit)
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1500;

// Queue for pending lookups to avoid hammering the API
const queue = [];
let queueRunning = false;

/**
 * Lookup proxy/VPN status for an IP address.
 * Returns a cached result if available, otherwise queues an API call.
 *
 * @param {string} ip
 * @returns {Promise<{ isProxy: boolean, isVpn: boolean, isHosting: boolean }>}
 */
export function checkProxy(ip) {
    if (!ip) return Promise.resolve({ isProxy: false, isVpn: false, isHosting: false });

    // Return cached result if still fresh
    const cached = cache.get(ip);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return Promise.resolve({ isProxy: cached.isProxy, isVpn: cached.isVpn, isHosting: cached.isHosting });
    }

    // Queue a fresh lookup
    return new Promise((resolve) => {
        queue.push({ ip, resolve });
        processQueue();
    });
}

function processQueue() {
    if (queueRunning || queue.length === 0) return;
    queueRunning = true;

    const next = queue.shift();
    const now = Date.now();
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - lastRequestTime));

    setTimeout(async () => {
        lastRequestTime = Date.now();
        const result = await fetchProxyStatus(next.ip);
        cache.set(next.ip, { ...result, ts: Date.now() });
        next.resolve(result);
        queueRunning = false;
        processQueue(); // continue processing queue
    }, wait);
}

/**
 * Perform the actual ip-api.com HTTP request.
 * @param {string} ip
 * @returns {Promise<{ isProxy: boolean, isVpn: boolean, isHosting: boolean }>}
 */
function fetchProxyStatus(ip) {
    const fallback = { isProxy: false, isVpn: false, isHosting: false };

    return new Promise((resolve) => {
        const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=proxy,hosting,mobile`;
        const req = http.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve({
                        isProxy: !!(json.proxy),
                        isVpn: !!(json.proxy),   // ip-api combines proxy/vpn into 'proxy'
                        isHosting: !!(json.hosting),
                    });
                } catch {
                    resolve(fallback);
                }
            });
        });
        req.on('error', () => resolve(fallback));
        req.on('timeout', () => { req.destroy(); resolve(fallback); });
    });
}

export default { checkProxy };
