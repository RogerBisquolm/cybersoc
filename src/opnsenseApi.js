/**
 * OPNsense Mock API
 * Simulates OPNsense API endpoints for Emergency Lockdown.
 * Replace with real OPNsense API credentials in production.
 */

const CONFIG = {
    host: process.env.OPNSENSE_HOST || 'https://192.168.1.1',
    apiKey: process.env.OPNSENSE_API_KEY || 'DEMO_KEY',
    apiSecret: process.env.OPNSENSE_API_SECRET || 'DEMO_SECRET',
    // Set to true to enable real API calls
    realMode: process.env.OPNSENSE_REAL_MODE === 'true',
};

let lockdownActive = false;

/**
 * Toggle emergency WAN lockdown.
 * In real mode: calls OPNsense firewall rule API.
 * In mock mode: returns simulated response.
 *
 * @param {boolean} activate - true to lock down, false to release
 * @returns {Promise<Object>} API response
 */
export async function setEmergencyLockdown(activate) {
    if (CONFIG.realMode) {
        return callRealOpnsense(activate);
    }
    return mockLockdown(activate);
}

async function mockLockdown(activate) {
    // Simulate network delay
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));

    lockdownActive = activate;

    return {
        success: true,
        mock: true,
        lockdownActive,
        message: activate
            ? '🔴 EMERGENCY LOCKDOWN ACTIVE — All WAN traffic BLOCKED. (Mock Mode)'
            : '🟢 Lockdown Released — Normal firewall rules restored. (Mock Mode)',
        timestamp: new Date().toISOString(),
        config: {
            applyAlias: 'EmergencyBlock',
            affectedRules: activate ? ['WAN_IN', 'WAN_OUT', 'WAN_FORWARD'] : [],
        },
    };
}

async function callRealOpnsense(activate) {
    const auth = Buffer.from(`${CONFIG.apiKey}:${CONFIG.apiSecret}`).toString('base64');
    const endpoint = activate
        ? `${CONFIG.host}/api/firewall/alias/setItem`
        : `${CONFIG.host}/api/firewall/alias/delItem`;

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${auth}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ alias: 'EmergencyBlock', enabled: activate ? '1' : '0' }),
            // Skip SSL verification for self-signed certs (common on OPNsense)
            // In production, use a proper cert or NODE_TLS_REJECT_UNAUTHORIZED=0
        });

        if (!response.ok) {
            throw new Error(`OPNsense API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        lockdownActive = activate;
        return { success: true, mock: false, lockdownActive, data };
    } catch (err) {
        return { success: false, mock: false, error: err.message };
    }
}

export function getLockdownStatus() {
    return { lockdownActive };
}

export default { setEmergencyLockdown, getLockdownStatus };
