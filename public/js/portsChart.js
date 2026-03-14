/**
 * Ports Donut Chart (Chart.js)
 * Tracks and displays distribution of targeted ports in real-time.
 */

const COLORS = {
    primary: '#ec5b13',
    cyan: '#00f2ff',
    red: '#ff004c',
    green: '#22c55e',
    purple: '#a855f7',
    yellow: '#eab308',
    slate: '#64748b',
    blue: '#3b82f6',
};

// Port name → display color mapping
const PORT_COLORS = {
    22: { name: 'SSH', color: COLORS.primary },
    80: { name: 'HTTP', color: COLORS.cyan },
    443: { name: 'HTTPS', color: COLORS.cyan },
    3389: { name: 'RDP', color: COLORS.red },
    23: { name: 'Telnet', color: COLORS.yellow },
    3306: { name: 'MySQL', color: COLORS.purple },
    8080: { name: 'HTTP-Alt', color: COLORS.blue },
    1433: { name: 'MSSQL', color: COLORS.green },
    21: { name: 'FTP', color: '#f97316' },
    25: { name: 'SMTP', color: '#f97316' },
    53: { name: 'DNS', color: '#06b6d4' },
    123: { name: 'NTP', color: '#8b5cf6' },
    445: { name: 'SMB', color: '#ef4444' },
    993: { name: 'IMAPS', color: '#10b981' },
    8443: { name: 'HTTPS-Alt', color: '#0ea5e9' },
    5900: { name: 'VNC', color: '#f59e0b' },
    6379: { name: 'Redis', color: '#dc2626' },
    8728: { name: 'Winbox', color: '#ec4899' },
    8729: { name: 'Winbox-TLS', color: '#db2777' },
    9993: { name: 'Tailscale', color: '#6366f1' },
    19302: { name: 'STUN/TURN', color: '#14b8a6' },
    5060: { name: 'SIP', color: '#f472b6' },
    11211: { name: 'Memcached', color: '#fb923c' },
    5061: { name: 'SIP-TLS', color: '#e879f9' },
};

// Rotating palette for ports not in PORT_COLORS
const FALLBACK_PALETTE = [
    '#f97316', '#06b6d4', '#a855f7', '#22d3ee',
    '#fbbf24', '#34d399', '#f43f5e', '#818cf8',
];
const dynamicColorMap = new Map(); // port → color
let paletteIndex = 0;

function getPortColor(port) {
    if (PORT_COLORS[port]) return PORT_COLORS[port];
    if (!dynamicColorMap.has(port)) {
        dynamicColorMap.set(port, FALLBACK_PALETTE[paletteIndex % FALLBACK_PALETTE.length]);
        paletteIndex++;
    }
    return { name: `Port ${port}`, color: dynamicColorMap.get(port) };
}

const MAX_LEGEND_ITEMS = 5;
// Port hit count map
const portCounts = new Map();
let chart = null;

/**
 * Initialize the donut chart.
 * @param {string} canvasId
 */
export function initPortsChart(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    chart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Waiting…'],
            datasets: [{
                data: [1],
                backgroundColor: ['rgba(255,255,255,0.05)'],
                borderColor: ['rgba(255,255,255,0.05)'],
                borderWidth: 2,
                hoverOffset: 6,
            }],
        },
        options: {
            cutout: '72%',
            responsive: false,
            animation: { duration: 500, easing: 'easeOutCubic' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${ctx.label}: ${ctx.formattedValue} hits`,
                    },
                    backgroundColor: 'rgba(10,10,20,0.9)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    padding: 10,
                    titleFont: { family: 'Space Grotesk', size: 11 },
                    bodyFont: { family: 'JetBrains Mono', size: 11 },
                },
            },
        },
    });
}

/**
 * Record a new port hit and update the chart.
 * @param {number} port
 * @param {string} portName
 */
export function recordPortHit(port, portName) {
    const key = port || 0;
    portCounts.set(key, (portCounts.get(key) || 0) + 1);
    updateChart(port, portName);
}

function updateChart(latestPort, latestPortName) {
    if (!chart) return;

    // Sort by count descending, take top entries
    const sorted = [...portCounts.entries()]
        .sort((a, b) => b[1] - a[1]);

    const topPorts = sorted.slice(0, MAX_LEGEND_ITEMS);
    const otherHits = sorted.slice(MAX_LEGEND_ITEMS).reduce((s, [, v]) => s + v, 0);

    const labels = [];
    const data = [];
    const colors = [];

    for (const [port, count] of topPorts) {
        const info = getPortColor(port);
        labels.push(info.name);
        data.push(count);
        colors.push(info.color);
    }

    if (otherHits > 0) {
        labels.push('Other');
        data.push(otherHits);
        colors.push(COLORS.slate);
    }

    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.data.datasets[0].backgroundColor = colors.map(c => c + 'cc');
    chart.data.datasets[0].borderColor = colors;
    chart.update('active');

    // Update total
    const total = [...portCounts.values()].reduce((s, v) => s + v, 0);
    const totalEl = document.getElementById('port-total');
    if (totalEl) totalEl.textContent = formatCount(total);

    // Update legend
    updateLegend(topPorts, otherHits, colors);
}

function updateLegend(topPorts, otherHits, colors) {
    const legend = document.getElementById('donut-legend');
    if (!legend) return;

    const totalHits = [...portCounts.values()].reduce((s, v) => s + v, 0);

    let html = '';
    topPorts.forEach(([port, count], idx) => {
        const info = getPortColor(port);
        const pct = totalHits > 0 ? ((count / totalHits) * 100).toFixed(1) : '0';
        html += `
      <div class="legend-item">
        <div class="legend-left">
          <div class="legend-dot" style="background:${colors[idx]}; box-shadow: 0 0 5px ${colors[idx]}"></div>
          <span class="legend-port">:${port} (${info.name})</span>
        </div>
        <span class="legend-count">${pct}%</span>
      </div>`;
    });

    if (otherHits > 0) {
        const pct = totalHits > 0 ? ((otherHits / totalHits) * 100).toFixed(1) : '0';
        html += `
      <div class="legend-item">
        <div class="legend-left">
          <div class="legend-dot" style="background:${COLORS.slate}"></div>
          <span class="legend-port">Other</span>
        </div>
        <span class="legend-count">${pct}%</span>
      </div>`;
    }

    legend.innerHTML = html;
}

function formatCount(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

export default { initPortsChart, recordPortHit };
