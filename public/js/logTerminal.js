/**
 * Live Log Terminal Module
 * Appends log entries with timestamp, severity, message.
 * Maintains max 50 entries with fading effect on older items.
 */

const MAX_ENTRIES = 50;
const FADE_START = 35; // Entries older than this index start fading

let terminalBody = null;
const logEntries = [];

/**
 * Initialize the terminal with a DOM element.
 * @param {string} elementId
 */
export function initTerminal(elementId) {
    terminalBody = document.getElementById(elementId);
    if (!terminalBody) {
        console.warn('[Terminal] Element not found:', elementId);
    }
}

/**
 * Severity → CSS class + level label mapping
 */
const SEVERITY_MAP = {
    block: { cls: 'log-block', label: 'BLCK' },
    geo: { cls: 'log-geo', label: 'GEO ' },
    tor: { cls: 'log-tor', label: 'TOR ' },
    pass: { cls: 'log-pass', label: 'PASS' }, // inbound allowed → green
    scan: { cls: 'log-scan', label: 'OUT ' }, // outbound / generic → cyan
    info: { cls: 'log-info', label: 'INFO' },
    warn: { cls: 'log-warn', label: 'WARN' },
    crit: { cls: 'log-crit', label: 'CRIT' },
};

/**
 * Append an attack event as a log entry.
 * @param {Object} event - Attack event from server
 */
export function logAttack(event) {
    const { timestamp, srcIp, remoteIp, dstPort, action, direction, country, city, portName, proto, geoBlock, isTor, isProxy } = event;
    const ts = formatTimestamp(timestamp);

    const displayIp = remoteIp || srcIp;

    // Threat badges: TOR and Proxy
    const badges = [];
    if (isTor) badges.push('[TOR]');
    if (isProxy && !isTor) badges.push('[VPN/Proxy]');
    const badgeStr = badges.length ? badges.join(' ') + ' ' : '';

    // Build location string: "City, Country" or just "Country"
    const locationParts = [city, country].filter(Boolean);
    const location = locationParts.length ? ` [${locationParts.join(', ')}]` : '';

    const portLabel = portName ? `/${portName}` : '';
    const protoStr = proto ? proto.toUpperCase() : 'TCP';

    let msg;
    if (action === 'block') {
        if (geoBlock) {
            msg = `GEO BLOCK: ${badgeStr}${displayIp}${location} → :${dstPort}${portLabel} (${protoStr})`;
        } else {
            msg = `BLOCKED: ${badgeStr}${displayIp}${location} → :${dstPort}${portLabel} (${protoStr})`;
        }
    } else if (direction === 'out') {
        msg = `OUTBOUND: ${badgeStr}${displayIp}${location} :${dstPort}${portLabel} (${protoStr})`;
    } else {
        msg = `ALLOWED: ${badgeStr}${displayIp}${location} → :${dstPort}${portLabel} (${protoStr})`;
    }

    let severity;
    if (isTor) {
        severity = 'tor';
    } else if (action === 'block') {
        severity = geoBlock ? 'geo' : 'block';
    } else if (direction === 'out') {
        severity = 'scan'; // outbound → cyan (gedimmt)
    } else {
        severity = 'pass'; // inbound allowed → grün
    }
    appendEntry(severity, msg, ts);
}

/**
 * Append a system message to the terminal.
 * @param {string} severity - 'info' | 'warn' | 'crit' | 'scan'
 * @param {string} message
 */
export function logSystem(severity, message) {
    appendEntry(severity, message);
}

/** Internal: create and insert a log entry DOM node. */
function appendEntry(severity, message, customTs) {
    if (!terminalBody) return;

    const ts = customTs || formatTimestamp(new Date().toISOString());
    const { cls, label } = SEVERITY_MAP[severity] || SEVERITY_MAP.info;

    const entry = document.createElement('div');
    entry.className = `log-entry ${cls} log-new`;
    entry.innerHTML = `
    <span class="log-ts">[${ts}]</span>
    <span class="log-lvl">${label}:</span>
    <span class="log-msg">${escapeHtml(message)}</span>
  `;

    // Prepend (newest at top)
    terminalBody.insertBefore(entry, terminalBody.firstChild);
    logEntries.unshift(entry);

    // Remove 'new' flash class after animation
    setTimeout(() => entry.classList.remove('log-new'), 600);

    // Enforce max entries
    if (logEntries.length > MAX_ENTRIES) {
        const old = logEntries.pop();
        old?.remove();
    }

    // Apply fading to older entries
    applyFading();
}

function applyFading() {
    logEntries.forEach((el, idx) => {
        el.classList.toggle('fading', idx >= FADE_START);
    });
}

function formatTimestamp(isoStr) {
    try {
        const d = new Date(isoStr);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    } catch {
        return '--:--:--';
    }
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export default { initTerminal, logAttack, logSystem };
