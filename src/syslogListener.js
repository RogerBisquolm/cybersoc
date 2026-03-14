/**
 * UDP Syslog Listener (port 514 / configurable)
 * Listens for incoming OPNsense syslog packets and emits parsed events.
 */

import dgram from 'dgram';
import { EventEmitter } from 'events';

export class SyslogListener extends EventEmitter {
    /**
     * @param {Function} parser - parseSyslogLine(rawLine) → event | null
     * @param {Function} geoLookup - lookupIp(ip) → geo | null
     * @param {number} port - UDP port (default 514, use 5514 for non-root)
     */
    constructor(parser, geoLookup, port = 5514) {
        super();
        this.parser = parser;
        this.geoLookup = geoLookup;
        this.port = port;
        this.server = null;
    }

    start() {
        this.server = dgram.createSocket('udp4');

        this.server.on('error', (err) => {
            console.error(`[Syslog] UDP socket error: ${err.message}`);
            this.emit('error', err);
        });

        this.server.on('message', (msgBuffer, rinfo) => {
            const raw = msgBuffer.toString('utf8');
            this.processLine(raw, rinfo.address);
        });

        this.server.on('listening', () => {
            const addr = this.server.address();
            console.log(`[Syslog] Listening on UDP ${addr.address}:${addr.port}`);
            this.emit('listening', addr);
        });

        this.server.bind(this.port, '0.0.0.0');
    }

    processLine(rawLine, remoteAddr) {
        // Set DEBUG_SYSLOG=true to log every raw UDP packet
        if (process.env.DEBUG_SYSLOG === 'true') {
            console.log(`[Syslog RAW] from=${remoteAddr} → ${rawLine.trim().slice(0, 200)}`);
        }
        try {
            const event = this.parser(rawLine);
            if (!event) return;

            // Use remoteIp (the public endpoint chosen by the parser based on direction):
            //   - For inbound blocks  → srcIp (attacker's real IP)
            //   - For outbound/NAT    → dstIp (public destination, LAN src is private)
            const ipToGeo = event.remoteIp || event.srcIp;
            const geo = this.geoLookup(ipToGeo);

            if (geo) {
                event.srcLat = geo.lat;
                event.srcLon = geo.lon;
                event.country = geo.country;
                event.countryCode = geo.countryCode;
                event.city = geo.city;
                event.region = geo.region;
            } else {
                // Last-resort: try the UDP sender if remoteIp geo failed
                const senderGeo = this.geoLookup(remoteAddr);
                if (senderGeo) {
                    event.srcLat = senderGeo.lat;
                    event.srcLon = senderGeo.lon;
                    event.country = senderGeo.country;
                }
            }

            // Only emit if we can place the event on the map
            if (event.srcLat !== undefined && event.srcLon !== undefined) {
                this.emit('attack', event);
            } else if (process.env.DEBUG_SYSLOG === 'true') {
                console.log(`[Syslog] No geo for remoteIp=${ipToGeo} — event skipped`);
            }
        } catch (err) {
            console.error('[Syslog] Parse error:', err.message);
        }
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            console.log('[Syslog] UDP server stopped');
        }
    }
}

export default SyslogListener;
