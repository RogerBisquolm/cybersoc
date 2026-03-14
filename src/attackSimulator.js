/**
 * Attack Simulator - Demo Mode
 * Generates realistic fake attack events when no OPNsense feed is connected.
 */

// Realistic attack source IPs with known geo locations
// IPs marked isTor are real known TOR exit nodes
const SIMULATED_SOURCES = [
    { ip: '185.220.101.45', country: 'Germany', city: 'Frankfurt', lat: 50.1155, lon: 8.6842, isTor: true },
    { ip: '185.220.101.182', country: 'Germany', city: 'Frankfurt', lat: 50.1155, lon: 8.6842, isTor: true },
    { ip: '185.220.102.8', country: 'Germany', city: 'Nuremberg', lat: 49.4521, lon: 11.0767, isTor: true },
    { ip: '101.41.52.1', country: 'China', city: 'Shanghai', lat: 31.2304, lon: 121.4737 },
    { ip: '121.206.212.47', country: 'China', city: 'Beijing', lat: 39.9042, lon: 116.4074 },
    { ip: '175.45.176.1', country: 'North Korea', city: 'Pyongyang', lat: 39.0392, lon: 125.7625 },
    { ip: '5.62.56.160', country: 'Iran', city: 'Tehran', lat: 35.6892, lon: 51.389 },
    { ip: '2.56.57.128', country: 'Romania', city: 'Bucharest', lat: 44.4268, lon: 26.1025 },
    { ip: '185.176.26.99', country: 'Ukraine', city: 'Kyiv', lat: 50.4501, lon: 30.5234 },
    { ip: '91.108.4.11', country: 'Germany', city: 'Berlin', lat: 52.5200, lon: 13.4050 },
    { ip: '198.96.155.3', country: 'United States', city: 'San Jose', lat: 37.3861, lon: -122.0839 },
    { ip: '45.148.10.89', country: 'Netherlands', city: 'Amsterdam', lat: 52.3676, lon: 4.9041, isProxy: true },
    { ip: '179.43.128.1', country: 'Brazil', city: 'São Paulo', lat: -23.5505, lon: -46.6333 },
    { ip: '196.219.143.1', country: 'South Africa', city: 'Cape Town', lat: -33.9249, lon: 18.4241 },
    { ip: '103.21.244.0', country: 'India', city: 'Mumbai', lat: 19.0760, lon: 72.8777 },
    { ip: '80.94.95.1', country: 'Moldova', city: 'Chișinău', lat: 47.0105, lon: 28.8638 },
    { ip: '5.188.206.14', country: 'Russian Federation', city: 'Moscow', lat: 55.7558, lon: 37.6176 },
    { ip: '45.141.215.111', country: 'Russian Federation', city: 'Yekaterinburg', lat: 56.8519, lon: 60.6122 },
    { ip: '218.92.0.218', country: 'China', city: 'Shanghai', lat: 31.0500, lon: 121.2600 },
    { ip: '212.102.34.1', country: 'United Kingdom', city: 'London', lat: 51.5099, lon: -0.1181, isProxy: true },
    { ip: '77.83.247.1', country: 'Bulgaria', city: 'Sofia', lat: 42.6977, lon: 23.3219 },
];

const COMMON_PORTS = [
    { port: 22, name: 'SSH' },
    { port: 80, name: 'HTTP' },
    { port: 443, name: 'HTTPS' },
    { port: 3389, name: 'RDP' },
    { port: 23, name: 'Telnet' },
    { port: 3306, name: 'MySQL' },
    { port: 5900, name: 'VNC' },
    { port: 8080, name: 'HTTP-Alt' },
    { port: 1433, name: 'MSSQL' },
    { port: 21, name: 'FTP' },
    { port: 25, name: 'SMTP' },
    { port: 53, name: 'DNS' },
    { port: 445, name: 'SMB' },
    { port: 8443, name: 'HTTPS-Alt' },
    { port: 6379, name: 'Redis' },
];

const PROTOS = ['tcp', 'udp', 'icmp'];

/**
 * Generate a single simulated attack event.
 * @returns {Object} Attack event with geo coordinates
 */
export function generateAttackEvent() {
    const source = SIMULATED_SOURCES[Math.floor(Math.random() * SIMULATED_SOURCES.length)];
    const portEntry = COMMON_PORTS[Math.floor(Math.random() * COMMON_PORTS.length)];
    const action = Math.random() < 0.82 ? 'block' : 'pass'; // 82% blocked
    const proto = PROTOS[Math.floor(Math.random() * PROTOS.length)];
    // ~25% of block events are geo-blocks (country-level firewall policy, not an attack)
    const geoBlock = action === 'block' && Math.random() < 0.25;

    const isTor = !!(source.isTor) || (!source.isProxy && Math.random() < 0.08);
    const isProxy = !!(source.isProxy) || (!isTor && Math.random() < 0.12);

    // direction: blocks are always inbound; pass events are ~90% inbound, ~10% outbound
    const direction = action === 'block' ? 'in' : (Math.random() < 0.9 ? 'in' : 'out');

    return {
        timestamp: new Date().toISOString(),
        srcIp: source.ip,
        srcLat: source.lat + (Math.random() - 0.5) * 2,
        srcLon: source.lon + (Math.random() - 0.5) * 2,
        country: source.country,
        city: source.city || '',
        dstPort: portEntry.port,
        portName: portEntry.name,
        action,
        direction,
        proto,
        geoBlock,
        isTor,
        isProxy,
        simulated: true,
    };
}

/**
 * Start the attack simulator.
 * Calls onEvent at random intervals between minMs and maxMs.
 *
 * @param {Function} onEvent - Callback receiving a generated event
 * @param {number} minMs - Minimum interval in milliseconds (default 400)
 * @param {number} maxMs - Maximum interval in milliseconds (default 2000)
 * @returns {Function} Stop function to halt the simulator
 */
export function startSimulator(onEvent, minMs = 400, maxMs = 2000) {
    let timeoutId = null;
    let running = true;

    function scheduleNext() {
        if (!running) return;
        const delay = minMs + Math.random() * (maxMs - minMs);
        timeoutId = setTimeout(() => {
            if (running) {
                onEvent(generateAttackEvent());
                scheduleNext();
            }
        }, delay);
    }

    scheduleNext();

    return function stop() {
        running = false;
        if (timeoutId) clearTimeout(timeoutId);
    };
}

export default { generateAttackEvent, startSimulator };
