/**
 * Stats Updater — Left Sidebar
 * Manages Total Attacks Blocked counter and Top Threat Sources bar chart.
 */

let totalBlocked = 0;
let totalAllowed = 0;
let lastHourBlocked = 0;
const countryCounts = new Map();

// Rolling window for delta calculation (past 24h simulation)
let prev24hSnapshot = 0;
let snapshotTime = Date.now();
const SNAPSHOT_INTERVAL = 60_000; // refresh delta every minute

/**
 * Record an incoming attack event and update all stats elements.
 * @param {Object} event
 */
export function recordAttack(event) {
    const { action, country } = event;

    const isRealBlock = action === 'block' && !event.geoBlock;

    if (isRealBlock) {
        totalBlocked++;
        lastHourBlocked++;
    } else if (action !== 'block') {
        totalAllowed++;
    }

    // Only real blocked attacks count as threat sources (geo-blocks are policy, not attacks)
    if (action === 'block' && !event.geoBlock && country) {
        countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    }

    updateBlockedCounter();
    updateThreatSources();
    updateDelta();
}

function updateBlockedCounter() {
    const el = document.getElementById('total-blocked');
    if (!el) return;

    const prev = parseInt(el.textContent.replace(/,/g, ''), 10) || 0;
    el.textContent = formatNumber(totalBlocked);

    if (totalBlocked !== prev) {
        el.classList.remove('num-flash');
        void el.offsetWidth; // reflow
        el.classList.add('num-flash');
    }
}

function updateDelta() {
    const now = Date.now();
    if (now - snapshotTime > SNAPSHOT_INTERVAL) {
        prev24hSnapshot = Math.max(1, totalBlocked - lastHourBlocked);
        lastHourBlocked = 0;
        snapshotTime = now;
    }

    const pct = prev24hSnapshot > 0
        ? (((totalBlocked - prev24hSnapshot) / prev24hSnapshot) * 100).toFixed(1)
        : '0.0';
    const isUp = parseFloat(pct) >= 0;
    const deltaEl = document.getElementById('delta-pct');
    if (deltaEl) {
        deltaEl.textContent = `${isUp ? '+' : ''}${pct}%`;
        deltaEl.classList.toggle('cyan', isUp);
        deltaEl.classList.toggle('red', !isUp);
    }
}

function updateThreatSources() {
    const container = document.getElementById('threat-sources');
    if (!container) return;

    // Top 3 countries by count, skip unknown
    const sorted = [...countryCounts.entries()]
        .filter(([country]) => country && country.toLowerCase() !== 'unknown')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

    // Grand total across ALL countries for accurate percentage share
    const grandTotal = [...countryCounts.values()].reduce((s, c) => s + c, 0) || 1;

    container.innerHTML = sorted.map(([country, count], idx) => {
        const pct = Math.round((count / grandTotal) * 100);
        // #1 red, #2 orange-dark, #3 orange-light
        const colorCls = idx === 0 ? 'threat-rank-1' : idx === 1 ? 'threat-rank-2' : 'threat-rank-3';

        return `
      <div class="threat-row">
        <div class="threat-meta">
          <span class="threat-country">${escHtml(country)}</span>
          <span class="threat-pct ${colorCls}">${pct}%</span>
        </div>
        <div class="threat-bar-bg">
          <div class="threat-bar-fill ${colorCls}" style="width:${pct}%"></div>
        </div>
      </div>
    `;
    }).join('');
}

function formatNumber(n) {
    return n.toLocaleString('en-US');
}

function escHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;');
}

// ── Integrity Rings ───────────────────────────────────────────────────────────

/**
 * Update the Integrity Stats rings with server-computed values.
 * @param {{ firewall: number, network: number }} integrity
 */
export function updateIntegrity({ firewall, network }) {
    setRing('ring-firewall', firewall, 'ring-green');
    setRing('ring-network', network, network >= 60 ? 'ring-cyan' : 'ring-orange');
}

function setRing(id, pct, colorClass) {
    const el = document.getElementById(id);
    if (!el) return;
    const valueEl = el.querySelector('.ring-value');
    if (valueEl) valueEl.textContent = `${Math.round(pct)}%`;
    // Swap color class
    el.className = `integrity-ring ${colorClass}`;
}

// ── Network Interfaces Panel ──────────────────────────────────────────────────

/**
 * Render the Network Interfaces panel from server stats.
 * @param {Object} interfaces  — { ifname: { blocks, passes, wanIps } }
 */
export function updateInterfaces(interfaces) {
    const container = document.getElementById('interfaces-panel');
    if (!container) return;

    const entries = Object.entries(interfaces);
    if (entries.length === 0) {
        container.innerHTML = '<p class="no-iface">Waiting for traffic…</p>';
        return;
    }

    container.innerHTML = entries.map(([ifname, st]) => {
        const total = st.blocks + st.passes || 1;
        const blockPct = Math.round((st.blocks / total) * 100);
        const ipList = st.wanIps.length
            ? st.wanIps.map(ip => `<span class="wan-ip">${escHtml(ip)}</span>`).join('')
            : '<span class="wan-ip muted">—</span>';

        return `
        <div class="iface-card">
          <div class="iface-header">
            <span class="iface-name">${escHtml(ifname)}</span>
            <span class="iface-dot active"></span>
          </div>
          <div class="iface-ips">${ipList}</div>
          <div class="iface-bar-bg">
            <div class="iface-bar-fill" style="width:${blockPct}%"></div>
          </div>
          <div class="iface-counts">
            <span class="red">${st.blocks.toLocaleString()} blocked</span>
            <span class="muted">${st.passes.toLocaleString()} passed</span>
          </div>
        </div>`;
    }).join('');
}

export default { recordAttack, updateIntegrity, updateInterfaces };

