/**
 * TOR Exit Node Detector
 * Downloads the official Tor Project exit node list hourly.
 * No API key required.
 *
 * Source: https://check.torproject.org/torbulkexitlist
 */

import https from 'https';

const TOR_LIST_URL = 'https://check.torproject.org/torbulkexitlist';
const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let torExitNodes = new Set();
let lastUpdated = null;

/**
 * Fetch the current TOR exit node list from the Tor Project.
 * @returns {Promise<number>} Number of nodes loaded
 */
async function fetchTorList() {
    return new Promise((resolve, reject) => {
        https.get(TOR_LIST_URL, { timeout: 10000 }, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                const nodes = new Set(
                    data.split('\n')
                        .map(line => line.trim())
                        .filter(line => line && !line.startsWith('#'))
                );
                torExitNodes = nodes;
                lastUpdated = new Date();
                resolve(nodes.size);
            });
        }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
    });
}

/**
 * Initialize the TOR detector: load list immediately, then refresh hourly.
 */
export async function initTorDetector() {
    try {
        const count = await fetchTorList();
        console.log(`[TOR] ✅ Loaded ${count} exit nodes from check.torproject.org`);
    } catch (err) {
        console.warn(`[TOR] ⚠ Could not load exit node list: ${err.message} — detection disabled`);
    }

    // Refresh hourly
    setInterval(async () => {
        try {
            const count = await fetchTorList();
            console.log(`[TOR] Refreshed — ${count} exit nodes loaded`);
        } catch (err) {
            console.warn(`[TOR] Refresh failed: ${err.message}`);
        }
    }, REFRESH_INTERVAL_MS);
}

/**
 * Check if an IP address is a known TOR exit node.
 * @param {string} ip
 * @returns {boolean}
 */
export function isTorExitNode(ip) {
    if (!ip) return false;
    return torExitNodes.has(ip);
}

/**
 * Returns metadata about the TOR detector state.
 */
export function getTorDetectorStatus() {
    return {
        nodeCount: torExitNodes.size,
        lastUpdated: lastUpdated?.toISOString() ?? null,
    };
}

export default { initTorDetector, isTorExitNode, getTorDetectorStatus };
