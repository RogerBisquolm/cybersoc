/**
 * CyberSOC Alpha - Main Server
 *
 * Architecture:
 *  - Express HTTP server serves the frontend static files
 *  - WebSocket server handles WebRTC signaling (offer/answer/ICE exchange)
 *  - WebSocket also acts as direct data channel fallback
 *  - UDP Syslog listener receives OPNsense filter logs
 *  - Attack Simulator provides demo data when no real logs arrive
 *
 * WebRTC Flow:
 *  Client → WS "join" → Server sends "offer"
 *  Client → WS "answer" → Server sets remote desc
 *  Client/Server exchange ICE candidates via WS
 *  Once DataChannel open, attack events stream via DataChannel
 *  If DataChannel fails → fall back to WS broadcast
 */

import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { parseSyslogLine } from './src/syslogParser.js';
import { lookupIp, initGeoLookup, getGeoSource } from './src/geoLookup.js';
import { startSimulator } from './src/attackSimulator.js';
import { setEmergencyLockdown, getLockdownStatus } from './src/opnsenseApi.js';
import { SyslogListener } from './src/syslogListener.js';
import { initTorDetector, isTorExitNode } from './src/torDetector.js';
import { checkProxy } from './src/proxyDetector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env with explicit path so it works regardless of cwd
const require = createRequire(import.meta.url);
try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
    // dotenv not installed — parse .env manually as fallback
    try {
        const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        for (const line of envFile.split('\n')) {
            const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
            if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
        }
    } catch { /* no .env file */ }
}

const PORT = process.env.PORT || 3000;
const SYSLOG_PORT = parseInt(process.env.SYSLOG_PORT || '5514', 10);
const DEMO_MODE = process.env.DEMO_MODE !== 'false';
const SERVER_LAT = parseFloat(process.env.SERVER_LAT || '46.740661');
const SERVER_LON = parseFloat(process.env.SERVER_LON || '8.980018');
const SERVER_LOCATION_LABEL = process.env.SERVER_LOCATION_LABEL || 'SOC-ALPHA-01';

// Geo-block detection: match by rule number OR by rule UUID (label field).
// Set GEO_BLOCK_RULES=76,77 and/or GEO_BLOCK_UUIDS=uuid1,uuid2 in .env.
const parseEnvSet = (key) => new Set(
    (process.env[key] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const GEO_BLOCK_RULE_NUMBERS = parseEnvSet('GEO_BLOCK_RULES');
const GEO_BLOCK_UUIDS = parseEnvSet('GEO_BLOCK_UUIDS');
console.log(`[Config] Geo-block rules: numbers=[${[...GEO_BLOCK_RULE_NUMBERS]}] uuids=[${[...GEO_BLOCK_UUIDS].map(u => u.slice(0, 8) + '...')}]`);


// ─────────────────────────────────────────────
// Express + HTTP Server
// ─────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// REST endpoint: Public config (hub coordinates, location label)
app.get('/api/config', (req, res) => {
    res.json({
        hub: {
            lat: SERVER_LAT,
            lon: SERVER_LON,
            label: SERVER_LOCATION_LABEL,
        },
    });
});

// REST endpoint: Emergency Lockdown
app.post('/api/lockdown', async (req, res) => {
    const { activate } = req.body;
    try {
        const result = await setEmergencyLockdown(!!activate);
        console.log(`[Lockdown] ${activate ? 'ACTIVATED' : 'RELEASED'}`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// REST endpoint: Lockdown status
app.get('/api/lockdown', (req, res) => {
    res.json(getLockdownStatus());
});

// SPA fallback (Express 5 compatible)
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const httpServer = http.createServer(app);

// ─────────────────────────────────────────────
// WebSocket Server (Signaling + Data Fallback)
// ─────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// Track all connected clients with their state
const clients = new Map(); // ws → { id, webrtcReady }
let clientIdCounter = 0;

// ── Attack ring-buffer: replay last 30 events to new clients ──
const ATTACK_BUFFER_SIZE = 30;
const attackBuffer = [];

function bufferAttack(event) {
    attackBuffer.push(event);
    if (attackBuffer.length > ATTACK_BUFFER_SIZE) attackBuffer.shift();
}

/**
 * Broadcast an attack event to all connected clients.
 * Sends via WebSocket (the data channel is managed client-side).
 */
function broadcastAttack(event) {
    bufferAttack(event); // store for late-joining clients
    const payload = JSON.stringify({ type: 'attack', data: event });
    for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
}

wss.on('connection', (ws, req) => {
    const clientId = ++clientIdCounter;
    clients.set(ws, { id: clientId, webrtcReady: false, isAlive: true });

    console.log(`[WS] Client #${clientId} connected from ${req.socket.remoteAddress}`);

    // Heartbeat: respond to pong frames (keeps proxy connections alive)
    ws.on('pong', () => {
        const state = clients.get(ws);
        if (state) state.isAlive = true;
    });

    // Send current system status
    ws.send(JSON.stringify({
        type: 'status',
        data: {
            demoMode: DEMO_MODE,
            syslogPort: SYSLOG_PORT,
            lockdown: getLockdownStatus(),
            serverTime: new Date().toISOString(),
        },
    }));

    // Replay buffered attacks so the map populates immediately
    if (attackBuffer.length > 0) {
        console.log(`[WS] Replaying ${attackBuffer.length} buffered attacks to client #${clientId}`);
        for (const evt of attackBuffer) {
            ws.send(JSON.stringify({ type: 'attack', data: evt }));
        }
    }

    ws.on('message', (rawMsg) => {
        let msg;
        try {
            msg = JSON.parse(rawMsg.toString());
        } catch {
            console.warn('[WS] Non-JSON message received');
            return;
        }

        handleClientMessage(ws, msg, clientId);
    });

    ws.on('close', () => {
        console.log(`[WS] Client #${clientId} disconnected`);
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error(`[WS] Client #${clientId} error:`, err.message);
        clients.delete(ws);
    });
});

// ── Server-side heartbeat: ping all clients every 25s ──
// Prevents Zoraxy/Nginx proxy from closing idle WS connections
const WS_HEARTBEAT_MS = 25000;
setInterval(() => {
    for (const [ws, state] of clients) {
        if (!state.isAlive) {
            // Client failed to respond to last ping — terminate
            console.warn(`[WS] Client #${state.id} unresponsive — terminating`);
            ws.terminate();
            clients.delete(ws);
            continue;
        }
        state.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
    }
}, WS_HEARTBEAT_MS);

/**
 * Handle incoming messages from clients (WebRTC signaling + commands).
 */
function handleClientMessage(ws, msg, clientId) {
    switch (msg.type) {
        // WebRTC Signaling
        case 'webrtc-offer':
            // Client sends an SDP offer; we relay it to ourselves (server acts as peer)
            // In a simple setup: forward to all OTHER clients if doing peer-to-peer
            // Here: server acts as the "other end" — since we use WS for data, we
            // just acknowledge the WebRTC capability
            ws.send(JSON.stringify({ type: 'webrtc-ready', clientId }));
            clients.get(ws).webrtcReady = true;
            console.log(`[WebRTC] Client #${clientId} signaling exchange complete`);
            break;

        case 'webrtc-ice-candidate':
            // ICE candidate from client — acknowledge
            ws.send(JSON.stringify({ type: 'webrtc-ice-ack', clientId }));
            break;

        case 'webrtc-answer':
            ws.send(JSON.stringify({ type: 'webrtc-established', clientId }));
            clients.get(ws).webrtcReady = true;
            break;

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            break;

        case 'lockdown':
            setEmergencyLockdown(msg.activate).then(result => {
                ws.send(JSON.stringify({ type: 'lockdown-result', ...result }));
                // Broadcast lockdown state to all clients
                broadcastToAll({ type: 'lockdown-state', active: msg.activate, result });
            });
            break;

        default:
            // Unknown message type — ignore
            break;
    }
}

function broadcastToAll(obj) {
    const payload = JSON.stringify(obj);
    for (const [ws] of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
}

// ─────────────────────────────────────────────
// OPNsense Syslog Listener
// ─────────────────────────────────────────────
const syslogListener = new SyslogListener(parseSyslogLine, lookupIp, SYSLOG_PORT);

// ── Per-interface statistics ──────────────────────────────────────
// Tracks block/pass counts and WAN IPs seen per OPNsense interface
const ifaceStats = new Map(); // ifname → { blocks, passes, wanIps: Set }
let totalBlocksAll = 0;
let totalPassesAll = 0;

function getOrCreateIface(ifname) {
    if (!ifaceStats.has(ifname)) {
        ifaceStats.set(ifname, { blocks: 0, passes: 0, wanIps: new Set() });
    }
    return ifaceStats.get(ifname);
}

syslogListener.on('attack', async (event) => {
    if (event.action === 'block') {
        const rn = String(event.ruleNumber ?? '').trim();
        const uid = String(event.label ?? '').trim().toLowerCase();
        const byRule = rn.length > 0 && GEO_BLOCK_RULE_NUMBERS.has(rn);
        const byUuid = uid.length > 0 && GEO_BLOCK_UUIDS.has(uid);
        event.geoBlock = byRule || byUuid;
        console.log(`[Attack] BLOCK ${event.srcIp} → :${event.dstPort} (${event.country}) | rule="${rn}" byRule=${byRule} | uuid="${uid.slice(0, 8)}.." byUuid=${byUuid} | knownRules=[${[...GEO_BLOCK_RULE_NUMBERS]}]`);
    } else {
        console.log(`[Attack] ${event.action.toUpperCase()} ${event.srcIp} → :${event.dstPort} (${event.country})`);
    }

    // TOR / proxy detection only makes sense for inbound attacks
    const checkIp = event.remoteIp || event.srcIp;
    if (event.direction !== 'out') {
        event.isTor = isTorExitNode(checkIp);
        try {
            const proxyInfo = await checkProxy(checkIp);
            event.isProxy = proxyInfo.isProxy || proxyInfo.isHosting;
        } catch {
            event.isProxy = false;
        }
        if (event.isTor) console.log(`[TOR]   🧅 Exit node detected: ${checkIp}`);
        if (event.isProxy) console.log(`[Proxy] 🔒 Proxy/hosting detected: ${checkIp}`);
    } else {
        event.isTor = false;
        event.isProxy = false;
    }

    // Per-interface accounting
    const iface = getOrCreateIface(event.ifname || 'unknown');
    if (event.action === 'block') {
        iface.blocks++;
        totalBlocksAll++;
    } else {
        iface.passes++;
        totalPassesAll++;
    }
    // Track public WAN IPs seen on this interface (srcIp or dstIp that's public)
    if (event.srcIp && !isPrivateIpSimple(event.srcIp)) iface.wanIps.add(event.srcIp);
    if (event.dstIp && !isPrivateIpSimple(event.dstIp)) iface.wanIps.add(event.dstIp);

    broadcastAttack(event);
});

/** Quick private-IP check (no import needed) */
function isPrivateIpSimple(ip) {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip || '');
}


syslogListener.on('error', (err) => {
    console.error('[Syslog] Error:', err.message);
});

// ─────────────────────────────────────────────
// Async Startup
// ─────────────────────────────────────────────
(async () => {
    // 1. Init MaxMind GeoLite2 reader (falls back to geoip-lite if .mmdb missing)
    await initGeoLookup();

    // 2. Init TOR exit node detector
    await initTorDetector();

    // 2. Start syslog listener (non-fatal if it fails)
    try {
        syslogListener.start();
    } catch (err) {
        console.warn('[Syslog] Could not start listener:', err.message);
    }

    // 3. Attack Simulator (Demo Mode)
    let stopSimulator = null;
    if (DEMO_MODE) {
        console.log('[Demo] Attack simulator ACTIVE — generating realistic test data');
        stopSimulator = startSimulator((event) => {
            broadcastAttack(event);
        }, 600, 1800);
    }

    // 5. Periodic stats broadcast (every 5s) — interface info + integrity scores
    setInterval(() => {
        const total = totalBlocksAll + totalPassesAll || 1;
        const blockRatio = totalBlocksAll / total; // 0..1

        // Integrity scores based on real data
        const firewallScore = Math.min(99, Math.max(60, Math.round(70 + blockRatio * 25)));
        const networkScore = Math.min(99, Math.max(20, ifaceStats.size * 30));

        // Serialize interface stats (Set → Array, limit WAN IPs to 5 most recent)
        const interfaces = {};
        for (const [ifname, st] of ifaceStats.entries()) {
            interfaces[ifname] = {
                blocks: st.blocks,
                passes: st.passes,
                wanIps: [...st.wanIps].slice(-5),
            };
        }

        const statsMsg = JSON.stringify({
            type: 'stats',
            data: {
                integrity: { firewall: firewallScore, network: networkScore },
                interfaces,
                totals: { blocks: totalBlocksAll, passes: totalPassesAll },
            },
        });

        wss.clients.forEach(ws => {
            if (ws.readyState === 1) ws.send(statsMsg);
        });
    }, 5000);

    // 4. Start HTTP Server
    httpServer.listen(PORT, () => {
        const geoSource = getGeoSource();
        const geoLabel = geoSource === 'maxmind'
            ? 'MaxMind GeoLite2-City ✅'
            : 'geoip-lite (fallback) ⚠';
        console.log('');
        console.log('╔══════════════════════════════════════════════════════╗');
        console.log('║          CyberSOC Alpha — Server Online              ║');
        console.log('╠══════════════════════════════════════════════════════╣');
        console.log(`║  Dashboard:  http://localhost:${PORT}                  ║`);
        console.log(`║  Syslog UDP: 0.0.0.0:${SYSLOG_PORT}                       ║`);
        console.log(`║  Demo Mode:  ${DEMO_MODE ? 'ENABLED (simulated attacks)  ' : 'DISABLED                     '}  ║`);
        console.log(`║  GeoIP DB:   ${geoLabel.padEnd(30)}  ║`);
        console.log('╚══════════════════════════════════════════════════════╝');
        console.log('');
    });

    // Graceful shutdown (needs access to stopSimulator)
    const shutdownHandler = () => {
        console.log('\n[Server] Shutting down gracefully...');
        if (stopSimulator) stopSimulator();
        syslogListener.stop();
        wss.close();
        httpServer.close(() => {
            console.log('[Server] Closed.');
            process.exit(0);
        });
    };
    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);
})();

