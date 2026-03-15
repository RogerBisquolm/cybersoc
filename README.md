# CyberSOC Alpha — Real-Time Cyber Attack Map Dashboard

A fully functional, real-time cyber attack intelligence dashboard with:

- **Live D3.js world map** with animated attack arcs
- **WebRTC DataChannel** streaming (WebSocket fallback)
- **OPNsense Syslog/FilterLog** parser (UDP 514)
- **Geo-IP lookup** via `geoip-lite`
- **Chart.js** port distribution donut
- **Live log terminal** (max 50 entries, fade effect)
- **Glassmorphism dark UI** with neon accents
- **Emergency Lockdown** button (mocked OPNsense API)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start in demo mode (simulated attacks — no OPNsense needed)
npm run dev

# 3. Open dashboard
open http://localhost:3000
```

---

## Piping OPNsense Logs → CyberSOC

### Method 1: Configure OPNsense Remote Syslog

1. In OPNsense go to **System → Settings → Logging / Targets**
2. Click **+** to add a new target:
   | Field         | Value                              |
   |---------------|------------------------------------|
   | **Transport** | UDP(4)                             |
   | **Destination** | `<your-cybersoc-server-ip>`      |
   | **Port**      | `5514` (or `514` if root)          |
   | **Program**   | `filterlog`                        |
   | **Level**     | Informational                      |
   | **Facility**  | security                           |

3. Click **Save & Apply**

> **Note:** Port 514 requires root. The app listens on **5514 by default** to avoid this. You can forward 514→5514 using `socat` (see Method 3).

### Method 2: Test with netcat

```bash
# Send a test OPNsense filterlog line
echo '<134>1 2024-01-15T14:20:01Z opnsense.local filterlog 1234 - - 4,,,,,,0,block,in,ether,185.220.101.45,192.168.1.1,TCP,60,,,22,SYN' \
  | nc -u 127.0.0.1 5514
```

### Method 3: Redirect OPNsense Port 514 → 5514

On your CyberSOC server:
```bash
# Using socat (install if needed: brew install socat)
socat UDP4-RECVFROM:514,fork UDP4-SENDTO:127.0.0.1:5514
```

Or use an `iptables` redirect (Linux):
```bash
iptables -t nat -A PREROUTING -p udp --dport 514 -j REDIRECT --to-port 5514
```

### Method 4: Use the OPNsense API (Pull Mode)

Configure environment variables and set `OPNSENSE_REAL_MODE=true`:

```env
OPNSENSE_HOST=https://192.168.1.1
OPNSENSE_API_KEY=your_key_here
OPNSENSE_API_SECRET=your_secret_here
OPNSENSE_REAL_MODE=true
```

---

## Environment Variables

| Variable              | Default     | Description                            |
|-----------------------|-------------|----------------------------------------|
| `PORT`                | `3000`      | HTTP server port                       |
| `SYSLOG_PORT`         | `5514`      | UDP syslog listener port               |
| `DEMO_MODE`           | `true`      | Enable attack simulator (no OPNsense)  |
| `HEALTHCHECK_URL`     | `http://localhost:5021/api/lockdown` | URL used by Docker healthcheck (`wget`) |
| `SERVER_LAT`          | `46.740661` | Latitude of SOC server (shown on map)  |
| `SERVER_LON`          | `8.980018`  | Longitude of SOC server (shown on map) |
| `SERVER_LOCATION_LABEL` | `SOC-ALPHA-01` | Label shown on map and footer    |
| `OPNSENSE_HOST`       | —           | OPNsense base URL                      |
| `OPNSENSE_API_KEY`    | —           | OPNsense API key                       |
| `OPNSENSE_API_SECRET` | —           | OPNsense API secret                    |
| `OPNSENSE_REAL_MODE`  | `false`     | Use real OPNsense API for lockdown     |

### Start with real OPNsense logs:

```bash
DEMO_MODE=false SYSLOG_PORT=5514 node server.js
```

---

## Architecture

```
OPNsense → UDP 5514 ──→ SyslogListener → parseSyslogLine()
                                              ↓
                                        lookupIp() (geoip-lite)
                                              ↓
                                        broadcastAttack()
                                              ↓
                              ┌───────────────────────────┐
                              │   WebSocket Server (ws)   │
                              │  + WebRTC Signaling       │
                              └───────────────────────────┘
                                              ↓
                              ┌───────────────────────────┐
                              │   Browser Client          │
                              │   ├─ wsClient.js (WebRTC) │
                              │   ├─ worldMap.js (D3)     │
                              │   ├─ logTerminal.js        │
                              │   ├─ portsChart.js (CJS)  │
                              │   └─ statsUpdater.js       │
                              └───────────────────────────┘
```

---

## OPNsense Filter Log Format

The parser supports both the new RFC 5424 format and the legacy PF filter log CSV:

```
# New format (filterlog after process name):
<134>1 2024-01-15T14:20:01Z opnsense.local filterlog 1234 - - \
  4,,,,igb0,,block,in,4,0x0,,64,0,0,none,6,tcp,60,185.12.34.56,10.0.0.1,44123,22,0

# Fields (0-indexed after "filterlog: "):
# 0=rule, 1=subrule, 2=anchor, 3=label, 4=interface,
# 5=reason, 6=action, 7=direction, 8=ipver,
# ... (IPv4 TCP): 18=src_ip, 19=dst_ip, 20=src_port, 21=dst_port
```

---

## WebRTC Data Flow

1. Browser connects to WS server
2. Browser creates `RTCPeerConnection` + `DataChannel`
3. SDP offer sent via WS to server → server acknowledges
4. ICE candidates exchanged via WS
5. Once DataChannel opens: attack events stream via DataChannel
6. If DataChannel fails: events continue via WebSocket (automatic fallback)
7. Client reconnects automatically with exponential backoff on disconnect

---

## Emergency Lockdown

The **Emergency Lockdown** button calls `/api/lockdown` via the server.

**Mock mode** (default): Simulates the API response with a 300–700ms delay.

**Real mode** (`OPNSENSE_REAL_MODE=true`): Calls `POST /api/firewall/alias/setItem` on the OPNsense REST API to enable/disable the `EmergencyBlock` alias.

To set up the OPNsense alias:
1. Go to **Firewall → Aliases**
2. Create alias `EmergencyBlock` of type `Host(s)` (leave empty)
3. Create a WAN blocking rule referencing this alias
4. When lockdown is triggered, the server enables the alias → all WAN traffic blocked

---

## Project Structure

```
Cybersoc/
├── server.js              # Main Node.js server
├── src/
│   ├── syslogParser.js    # OPNsense filterlog parser
│   ├── geoLookup.js       # IP → Lat/Lon via geoip-lite
│   ├── attackSimulator.js # Demo attack generator
│   ├── syslogListener.js  # UDP syslog listener (EventEmitter)
│   └── opnsenseApi.js     # Mock/real OPNsense API
├── public/
│   ├── index.html         # Main dashboard HTML
│   ├── style.css          # Glassmorphism dark theme
│   └── js/
│       ├── app.js         # Main orchestrator (ES6 module)
│       ├── wsClient.js    # WebRTC+WS client
│       ├── worldMap.js    # D3.js world map + attack arcs
│       ├── logTerminal.js # Live log terminal
│       ├── portsChart.js  # Chart.js donut chart
│       └── statsUpdater.js# Stats counter + threat sources
└── README.md
```
