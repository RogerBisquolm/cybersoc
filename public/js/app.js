/**
 * CyberSOC Alpha — Main Application Orchestrator
 * Bootstraps all modules and wires the data flow:
 *   Server → WS/WebRTC → AttackEvent → Map + Log + Stats + Chart
 */

import { CyberSOCClient } from './wsClient.js';
import { initMap, renderAttack, setAttackRate, setHubLocation } from './worldMap.js';
import { initTerminal, logAttack, logSystem } from './logTerminal.js';
import { initPortsChart, recordPortHit } from './portsChart.js';
import { recordAttack, updateIntegrity, updateInterfaces } from './statsUpdater.js';

// ── State ──────────────────────────────────────
let lockdownActive = false;
let client = null;

// ── Bootstrap ──────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[CyberSOC] Initializing…');

    // 0. Load server config (hub coordinates etc.)
    try {
        const cfg = await fetch('/api/config').then(r => r.json());
        if (cfg?.hub) {
            const { lat, lon, label } = cfg.hub;
            setHubLocation(lat, lon, label);
            // Update footer coordinates display
            const coordEl = document.getElementById('footer-coord');
            if (coordEl) {
                const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
                const lonStr = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
                coordEl.textContent = `Coord: ${latStr}, ${lonStr}`;
            }
            const stationEl = document.getElementById('footer-station');
            if (stationEl) stationEl.textContent = `Station: ${label}`;
        }
    } catch (err) {
        console.warn('[App] Could not load /api/config:', err.message);
    }

    // Init UI modules
    initTerminal('terminal-body');
    initPortsChart('ports-chart');

    // Init D3 map (async — fetches world TopoJSON)
    await initMap('world-map').catch(err => {
        console.warn('[App] Map init failed:', err.message);
    });

    logSystem('info', 'CyberSOC Alpha dashboard initialized. Connecting to server…');

    // Start real-time clock
    startClock();

    // Ping/latency display
    startPeakLoadSim();

    // Connect to server
    client = new CyberSOCClient(handleEvent, handleStatus);
    client.connect();

    // Wire up Emergency Lockdown button
    wireLockdownButton();
});

// ── Event Handler ─────────────────────────────
/**
 * Handle an attack event OR system event from the server.
 * @param {Object} event
 */
function handleEvent(event) {
    // Stats message from server (every 5s)
    if (event._type === 'stats') {
        if (event.integrity) updateIntegrity(event.integrity);
        if (event.interfaces) updateInterfaces(event.interfaces);
        return;
    }

    // System events (lockdown state changes etc.)
    if (event._type === 'lockdown-result' || event._type === 'lockdown-state') {
        handleLockdownUpdate(event);
        return;
    }

    // Attack event
    console.log('[Attack Event]', event.action, event.remoteIp || event.srcIp,
        '→', event.country, `(lat:${event.srcLat}, lon:${event.srcLon})`, `geoBlock=${event.geoBlock}`);

    renderAttack(event);
    logAttack(event);
    recordAttack(event);
    recordOverlayMetrics(event);

    if (event.dstPort) {
        recordPortHit(event.dstPort, event.portName || `${event.dstPort}`);
    }

    // Flash notification badge only for real blocked attacks (not geo-policy blocks)
    if (event.action === 'block' && !event.geoBlock) {
        showNotifBadge();
    }
}

// ── Connection Status Handler ─────────────────
function handleStatus({ connected, mode, latency }) {
    const pill = document.getElementById('status-pill');
    const label = document.getElementById('status-label');
    const latencyEl = document.getElementById('hdr-latency');

    if (connected) {
        pill?.classList.remove('disconnected');
        if (label) label.textContent = mode?.includes('WebRTC') ? 'WebRTC Live' : 'System Live';
        if (latency && latencyEl) {
            latencyEl.textContent = `${latency}ms`;
        }
    } else {
        pill?.classList.add('disconnected');
        if (label) label.textContent = 'Reconnecting…';
        logSystem('warn', 'Connection to SOC server lost — attempting reconnect…');
    }
}

// ── Lockdown ──────────────────────────────────
function wireLockdownButton() {
    const btn = document.getElementById('lockdown-btn');
    const overlay = document.getElementById('lockdown-overlay');
    const releaseBtn = document.getElementById('release-btn');

    btn?.addEventListener('click', () => {
        if (lockdownActive) return;
        triggerLockdown(true);
    });

    releaseBtn?.addEventListener('click', () => {
        triggerLockdown(false);
    });
}

function triggerLockdown(activate) {
    logSystem(
        activate ? 'crit' : 'info',
        activate
            ? '🔴 Emergency Lockdown ACTIVATED — all WAN rules suspended'
            : '🟢 Lockdown released — normal firewall rules restored'
    );

    // Send via WebSocket to server
    client?.sendLockdown(activate);

    // Optimistic UI update
    updateLockdownUI(activate);
}

function handleLockdownUpdate(event) {
    const active = event.active ?? event.lockdownActive ?? false;
    updateLockdownUI(active);
    if (event.message) {
        logSystem(active ? 'crit' : 'info', event.message);
    }
}

function updateLockdownUI(active) {
    lockdownActive = active;

    const btn = document.getElementById('lockdown-btn');
    const overlay = document.getElementById('lockdown-overlay');
    const status = document.getElementById('lockdown-status');

    btn?.classList.toggle('active', active);
    if (overlay) overlay.style.display = active ? 'flex' : 'none';
    if (status) {
        status.style.display = active ? 'block' : 'none';
        status.textContent = active ? '⚠ LOCKDOWN ACTIVE' : '';
    }
}

// ── Notification Badge ────────────────────────
let badgeTimer = null;
function showNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    badge.style.display = 'block';
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
        badge.style.display = 'none';
    }, 4000);
}

// ── Real-time Event Rate + Block Rate metrics ─────────────────────
// Rolling 60-second window: timestamps of recent events
const eventTimestamps = [];
let totalEventsAll = 0;
let totalBlocksAll = 0;

/**
 * Called for each incoming OPNsense event to update overlay metrics.
 * @param {Object} event
 */
function recordOverlayMetrics(event) {
    const now = Date.now();
    eventTimestamps.push({ ts: now, action: event.action });
    totalEventsAll++;
    if (event.action === 'block' && !event.geoBlock) totalBlocksAll++;

    // Trim events older than 60s
    const cutoff = now - 60_000;
    while (eventTimestamps.length && eventTimestamps[0].ts < cutoff) {
        eventTimestamps.shift();
    }
}

function startPeakLoadSim() {
    // Update overlay metrics every 2s from real OPNsense event counters
    setInterval(() => {
        // Events/min = events in the last 60s window
        const eventsPerMin = eventTimestamps.length;
        const evEl = document.getElementById('active-nodes');
        if (evEl) evEl.textContent = eventsPerMin.toLocaleString('en-US');

        // Block rate % over all-time events
        const blockRate = totalEventsAll > 0
            ? ((totalBlocksAll / totalEventsAll) * 100).toFixed(1)
            : '—';
        const loadEl = document.getElementById('peak-load');
        if (loadEl) loadEl.textContent = totalEventsAll > 0 ? `${blockRate}%` : '—';

        // Feed real blocks/min into the hub rate ring
        const blocksPerMin = eventTimestamps.filter(e => e.action === 'block' && !e.geoBlock).length;
        setAttackRate(blocksPerMin);
    }, 2000);
}

// ── Real-Time Clock ───────────────────────────
function startClock() {
    const el = document.getElementById('footer-timestamp');
    const tick = () => {
        if (!el) return;
        const now = new Date();
        const y = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        const h = String(now.getHours()).padStart(2, '0');
        const m = String(now.getMinutes()).padStart(2, '0');
        const s = String(now.getSeconds()).padStart(2, '0');
        const tz = `UTC${now.getTimezoneOffset() <= 0 ? '+' : ''}${-now.getTimezoneOffset() / 60}`;
        el.textContent = `${y}.${mo}.${d} | ${h}:${m}:${s} ${tz}`;
    };
    tick();
    setInterval(tick, 1000);
}
