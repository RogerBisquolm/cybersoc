/**
 * WebRTC + WebSocket Client
 * Handles real-time connection to the CyberSOC server.
 *
 * Strategy:
 *  1. Connect via WebSocket to the signaling server
 *  2. Attempt to establish a WebRTC DataChannel for low-latency streaming
 *  3. If WebRTC setup fails (ICE failure, browser restriction), fall back to WS
 *  4. Auto-reconnect on disconnect with exponential backoff
 *
 * Events emitted back to caller via the onMessage/onStatus callbacks.
 */

const WS_PROTOCOL = location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${location.host}`;
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 20000; // 20s — keeps connection alive through proxy timeouts
const WEBRTC_TIMEOUT_MS = 8000;

export class CyberSOCClient {
    /**
     * @param {Function} onMessage - Called with parsed event objects from server
     * @param {Function} onStatus  - Called with { connected, latency, mode }
     */
    constructor(onMessage, onStatus) {
        this.onMessage = onMessage;
        this.onStatus = onStatus;

        this._ws = null;
        this._pc = null;      // RTCPeerConnection
        this._dc = null;      // RTCDataChannel
        this._useWebRTC = false;     // Whether DataChannel is active
        this._retries = 0;
        this._pingTimer = null;
        this._pingTs = 0;
        this._reconnTimer = null;
        this._destroyed = false;
    }

    /** Start the connection */
    connect() {
        this._destroyed = false;
        this._openWS();
    }

    /** Permanently destroy the client */
    destroy() {
        this._destroyed = true;
        this._clearTimers();
        this._closeWS();
        this._closePeerConn();
    }

    // ─────────────────────────────
    // WebSocket Layer
    // ─────────────────────────────
    _openWS() {
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }

        try {
            this._ws = new WebSocket(WS_URL);
        } catch (err) {
            this._scheduleReconnect();
            return;
        }

        this._ws.onopen = () => {
            console.log('[WS] Connected');
            this._retries = 0;
            this._startPing();
            this._reportStatus(true, 'WebSocket');

            // Attempt WebRTC DataChannel setup
            this._setupWebRTC();
        };

        this._ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            this._handleServerMessage(msg);
        };

        this._ws.onerror = () => {
            console.warn('[WS] Error');
        };

        this._ws.onclose = () => {
            console.warn('[WS] Disconnected');
            this._clearTimers();
            this._closePeerConn();
            this._reportStatus(false, 'disconnected');
            this._scheduleReconnect();
        };
    }

    _closeWS() {
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }
    }

    _wsSend(obj) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(obj));
        }
    }

    // ─────────────────────────────
    // WebRTC Layer
    // ─────────────────────────────
    _setupWebRTC() {
        if (!window.RTCPeerConnection) {
            console.warn('[WebRTC] Not supported — using WS fallback');
            return;
        }

        this._closePeerConn();

        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ],
        };

        try {
            this._pc = new RTCPeerConnection(config);
        } catch (err) {
            console.warn('[WebRTC] RTCPeerConnection failed:', err.message);
            return;
        }

        // Create DataChannel (offerer side = client)
        this._dc = this._pc.createDataChannel('attacks', {
            ordered: false,        // UDP-like: drop old packets
            maxRetransmits: 0,
        });

        this._dc.onopen = () => {
            console.log('[WebRTC] DataChannel open');
            this._useWebRTC = true;
            this._reportStatus(true, 'WebRTC');
        };

        this._dc.onclose = () => {
            console.warn('[WebRTC] DataChannel closed — falling back to WS');
            this._useWebRTC = false;
            this._reportStatus(true, 'WebSocket');
        };

        this._dc.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                this._handleServerMessage(msg);
            } catch { /* ignore */ }
        };

        this._pc.onicecandidate = (ev) => {
            if (ev.candidate) {
                this._wsSend({ type: 'webrtc-ice-candidate', candidate: ev.candidate });
            }
        };

        this._pc.oniceconnectionstatechange = () => {
            const state = this._pc?.iceConnectionState;
            console.log('[WebRTC] ICE state:', state);
            if (state === 'failed' || state === 'disconnected') {
                this._useWebRTC = false;
                this._reportStatus(true, 'WebSocket (ICE failed)');
            }
        };

        // Create SDP offer
        this._pc.createOffer()
            .then(offer => this._pc.setLocalDescription(offer))
            .then(() => {
                this._wsSend({ type: 'webrtc-offer', sdp: this._pc.localDescription });
            })
            .catch(err => {
                console.warn('[WebRTC] Offer failed:', err.message);
            });

        // Timeout: if DataChannel doesn't open, stay on WS
        setTimeout(() => {
            if (!this._useWebRTC) {
                console.info('[WebRTC] Timeout — staying on WebSocket');
            }
        }, WEBRTC_TIMEOUT_MS);
    }

    _closePeerConn() {
        this._useWebRTC = false;
        if (this._dc) { try { this._dc.close(); } catch { } this._dc = null; }
        if (this._pc) { try { this._pc.close(); } catch { } this._pc = null; }
    }

    // ─────────────────────────────
    // Message Handling
    // ─────────────────────────────
    _handleServerMessage(msg) {
        switch (msg.type) {
            case 'attack':
                this.onMessage(msg.data);
                break;
            case 'stats':
                this.onMessage({ _type: 'stats', ...msg.data });
                break;

            case 'pong':
                this._latency = Date.now() - this._pingTs;
                this._reportStatus(true, this._useWebRTC ? 'WebRTC' : 'WebSocket');
                break;
            case 'status':
                console.log('[Server Status]', msg.data);
                break;
            case 'webrtc-ready':
            case 'webrtc-established':
                // Server acknowledged WebRTC signaling
                break;
            case 'lockdown-result':
                this.onMessage({ _type: 'lockdown-result', ...msg });
                break;
            case 'lockdown-state':
                this.onMessage({ _type: 'lockdown-state', ...msg });
                break;
            default:
                break;
        }
    }

    // ─────────────────────────────
    // Ping / Latency
    // ─────────────────────────────
    _startPing() {
        this._clearTimers();
        this._pingTimer = setInterval(() => {
            this._pingTs = Date.now();
            this._wsSend({ type: 'ping' });
        }, PING_INTERVAL_MS);
    }

    // ─────────────────────────────
    // Reconnect
    // ─────────────────────────────
    _scheduleReconnect() {
        if (this._destroyed) return;
        const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(1.5, this._retries),
            RECONNECT_MAX_MS,
        );
        this._retries++;
        console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this._retries})`);
        this._reconnTimer = setTimeout(() => this._openWS(), delay);
    }

    _clearTimers() {
        if (this._pingTimer) clearInterval(this._pingTimer);
        if (this._reconnTimer) clearTimeout(this._reconnTimer);
        this._pingTimer = null;
        this._reconnTimer = null;
    }

    // ─────────────────────────────
    // Status
    // ─────────────────────────────
    _reportStatus(connected, mode) {
        this.onStatus({
            connected,
            mode,
            latency: this._latency || null,
        });
    }

    /** Send lockdown command via WebSocket */
    sendLockdown(activate) {
        this._wsSend({ type: 'lockdown', activate });
    }
}

export default CyberSOCClient;
