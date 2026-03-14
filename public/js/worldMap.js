/**
 * D3.js World Map Module — CyberSOC Alpha
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * Features:
 *   • Scroll-wheel zoom (1× – 16×) + click-drag pan
 *   • Progressive Level-of-Detail:
 *       z < 3   → world overview  (no labels)
 *       z ≥ 3   → country names fade in
 *       z ≥ 6   → major city dots + names fade in
 *   • Zoom-controls (+ / − / ⌂ Reset) rendered as SVG overlay
 *   • All attack arcs, heatmap, hub and rate-ring preserved
 */

// ── Hub location: loaded from /api/config (set via SERVER_LAT / SERVER_LON in .env) ──
let HUB_LAT = 46.740661; // fallback default
let HUB_LON = 8.980018;  // fallback default
let HUB_LABEL = 'SOC-ALPHA-01';

/** Update hub coordinates (called after /api/config is fetched) */
export function setHubLocation(lat, lon, label) {
    HUB_LAT = lat;
    HUB_LON = lon;
    if (label) HUB_LABEL = label;
}

// Max concurrent arcs / dots before oldest are pruned
const MAX_ARCS = 40;
const MAX_DOTS = 500;

let svg, g, projection, path;
let width = 0, height = 0;
let hubGroup, hubPulse;
let countryFeatures = [];        // stored for geoContains() lookup
let currentTransform = d3.zoomIdentity; // live zoom state

// ── Heatmap state (decaying) ──
const countryHeatMap = new Map(); // feature id → heat (float)
const featureById = new Map(); // feature id → feature (for redraw)
const HEAT_DECAY_RATE = 0.02;

// ── Top-attacker pulsing line ──
const attackerCounts = new Map(); // 'lat,lon' → { lat, lon, count }
let activeAttackerLine = null;
let activeAttackerTimer = null;

// ── Zoom behaviour ──
let zoomBehavior = null;

// ── City dataset (shown at high zoom) ──
// Format: [lon, lat, name]
const MAJOR_CITIES = [
    [-74.006, 40.7128, 'New York'],
    [-87.629, 41.8781, 'Chicago'],
    [-118.243, 34.0522, 'Los Angeles'],
    [-43.172, -22.907, 'Rio de Janeiro'],
    [-46.633, -23.548, 'São Paulo'],
    [-3.703, 40.416, 'Madrid'],
    [2.349, 48.864, 'Paris'],
    [-0.128, 51.508, 'London'],
    [13.405, 52.520, 'Berlin'],
    [37.618, 55.752, 'Moscow'],
    [28.979, 41.015, 'Istanbul'],
    [31.235, 30.045, 'Cairo'],
    [55.270, 25.204, 'Dubai'],
    [72.877, 19.076, 'Mumbai'],
    [77.209, 28.614, 'New Delhi'],
    [104.066, 30.572, 'Chengdu'],
    [116.407, 39.904, 'Beijing'],
    [121.473, 31.230, 'Shanghai'],
    [126.978, 37.566, 'Seoul'],
    [139.691, 35.689, 'Tokyo'],
    [151.209, -33.868, 'Sydney'],
    [174.764, -36.848, 'Auckland'],
    [18.423, -33.925, 'Cape Town'],
    [36.822, -1.286, 'Nairobi'],
    [3.379, 6.524, 'Lagos'],
    [-99.133, 19.433, 'Mexico City'],
    [-58.381, -34.604, 'Buenos Aires'],
    [8.542, 47.376, 'Zürich'],
    [12.496, 41.902, 'Rome'],
    [4.899, 52.379, 'Amsterdam'],
    [14.421, 50.088, 'Prague'],
    [19.040, 47.498, 'Budapest'],
    [21.012, 52.230, 'Warsaw'],
    [24.938, 60.170, 'Helsinki'],
    [10.752, 59.913, 'Oslo'],
    [18.063, 59.334, 'Stockholm'],
    [12.568, 55.676, 'Copenhagen'],
    [103.820, 1.352, 'Singapore'],
    [100.501, 13.754, 'Bangkok'],
    [106.660, 10.823, 'Ho Chi Minh'],
    [114.109, 22.397, 'Hong Kong'],
];

// ── Country name lookup (numeric topojson id → label) ──
// Just a small selection for the most recognizable ones.
const COUNTRY_NAMES = {
    840: 'USA', 124: 'Canada', 484: 'Mexico', 76: 'Brazil', 32: 'Argentina',
    156: 'China', 392: 'Japan', 356: 'India', 643: 'Russia', 276: 'Germany',
    250: 'France', 826: 'UK', 380: 'Italy', 724: 'Spain', 792: 'Turkey',
    818: 'Egypt', 710: 'South Africa', 404: 'Kenya', 566: 'Nigeria',
    36: 'Australia', 554: 'New Zealand', 410: 'South Korea', 682: 'Saudi Arabia',
    784: 'UAE', 364: 'Iran', 586: 'Pakistan', 50: 'Bangladesh',
    840: 'USA', 616: 'Poland', 703: 'Slovakia', 804: 'Ukraine',
    191: 'Croatia', 705: 'Slovenia', 703: 'Slovakia',
    752: 'Sweden', 578: 'Norway', 246: 'Finland', 208: 'Denmark',
    528: 'Netherlands', 56: 'Belgium', 756: 'Switzerland', 40: 'Austria',
    203: 'Czechia', 348: 'Hungary', 620: 'Portugal', 300: 'Greece',
    104: 'Myanmar', 360: 'Indonesia', 458: 'Malaysia', 702: 'Singapore',
    764: 'Thailand', 704: 'Vietnam', 608: 'Philippines',
};

/**
 * Initialize the D3 world map.
 * @param {string} containerId - ID of the SVG element
 */
export async function initMap(containerId) {
    svg = d3.select(`#${containerId}`);
    const container = document.getElementById(containerId).parentElement;

    const resize = () => {
        width = container.clientWidth;
        height = container.clientHeight;
        svg.attr('width', width).attr('height', height);
        if (projection) {
            projection
                .scale(width / 5.2)
                .translate([width / 2, height / 1.85]);
            redrawAll();
        }
    };

    resize();
    window.addEventListener('resize', resize);

    // ── Projection ──
    projection = d3.geoNaturalEarth1()
        .scale(width / 5.2)
        .translate([width / 2, height / 1.85]);

    path = d3.geoPath().projection(projection);

    // ── SVG Defs (gradients, filters) ──
    const defs = svg.append('defs');

    // Block-marker gradient
    const markerGrad = defs.append('radialGradient').attr('id', 'block-marker-gradient');
    markerGrad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(255,0,76,0.95)');
    markerGrad.append('stop').attr('offset', '55%').attr('stop-color', 'rgba(255,0,76,0.55)');
    markerGrad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(255,0,76,0)');

    // Zoom clip (so arcs/dots stay inside the map area)
    defs.append('clipPath').attr('id', 'map-clip')
        .append('rect').attr('width', width * 10).attr('height', height * 10)
        .attr('x', -width * 4).attr('y', -height * 4);

    // ── Root group — receives zoom transform ──
    g = svg.append('g').attr('class', 'map-g');

    // ── Load world topology ──
    try {
        const world = await d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
        const countries = topojson.feature(world, world.objects.countries);

        // Ocean gradient
        const oceanGrad = defs.append('linearGradient')
            .attr('id', 'ocean-gradient')
            .attr('x1', '0%').attr('y1', '0%')
            .attr('x2', '100%').attr('y2', '100%');
        oceanGrad.append('stop').attr('offset', '0%').attr('stop-color', '#050d18');
        oceanGrad.append('stop').attr('offset', '100%').attr('stop-color', '#030810');

        g.insert('rect', ':first-child')
            .attr('class', 'ocean-bg')
            .attr('width', width * 5).attr('height', height * 5)
            .attr('x', -width * 2).attr('y', -height * 2)
            .attr('fill', 'url(#ocean-gradient)');

        // Sphere outline
        g.append('path')
            .datum({ type: 'Sphere' })
            .attr('class', 'sphere-outline')
            .attr('d', path)
            .attr('fill', 'none')
            .attr('stroke', 'rgba(30,90,140,0.3)')
            .attr('stroke-width', 1.2);

        // Graticules
        const gratMinor = d3.geoGraticule().step([10, 10])();
        const gratMajor = d3.geoGraticule().step([30, 30])();

        g.append('path').datum(gratMinor).attr('class', 'grat-minor').attr('d', path)
            .attr('fill', 'none').attr('stroke', 'rgba(30,90,140,0.07)').attr('stroke-width', 0.4);
        g.append('path').datum(gratMajor).attr('class', 'grat-major').attr('d', path)
            .attr('fill', 'none').attr('stroke', 'rgba(30,90,140,0.15)').attr('stroke-width', 0.6);

        // Country fills
        g.selectAll('.country')
            .data(countries.features)
            .enter()
            .append('path')
            .attr('class', 'country')
            .attr('d', path);

        // Store feature refs
        countryFeatures = countries.features;
        countryFeatures.forEach(f => {
            const id = f.id ?? f.properties?.name;
            if (id != null) featureById.set(id, f);
        });

        // Country-name labels (hidden until zoom ≥ 3)
        g.selectAll('.country-label')
            .data(countries.features)
            .enter()
            .append('text')
            .attr('class', 'country-label')
            .attr('text-anchor', 'middle')
            .attr('dy', '0.35em')
            .attr('font-family', 'Space Grotesk, sans-serif')
            .style('font-size', '6px')   /* CSS px → screen-space, unaffected by g transform */
            .attr('fill', 'rgba(180,220,255,0.7)')
            .attr('pointer-events', 'none')
            .attr('opacity', 0)
            .text(d => COUNTRY_NAMES[d.id] || '')
            .attr('transform', d => {
                const c = path.centroid(d);
                return isNaN(c[0]) ? 'translate(-9999,-9999)' : `translate(${c[0]},${c[1]})`;
            });

        // City dots (hidden until zoom ≥ 6)
        const cityGroup = g.append('g').attr('class', 'city-group');

        MAJOR_CITIES.forEach(([lon, lat, name]) => {
            const [cx, cy] = projection([lon, lat]);
            cityGroup.append('circle')
                .attr('class', 'city-dot')
                .attr('cx', cx).attr('cy', cy)
                .attr('r', 1.8)
                .attr('opacity', 0);
            cityGroup.append('text')
                .attr('class', 'city-label')
                .attr('x', cx).attr('y', cy)
                .attr('dy', '-0.4em')          /* relative to CSS font-size → constant screen offset */
                .attr('text-anchor', 'middle')
                .attr('font-family', 'Space Grotesk, sans-serif')
                .style('font-size', '4px')   /* CSS px → screen-space */
                .attr('fill', 'rgba(0,242,255,0.75)')
                .attr('pointer-events', 'none')
                .attr('opacity', 0)
                .text(name);

            // mark hub city distinctly
            if (name === 'Zürich') {
                cityGroup.select('circle:last-of-type')
                    .attr('fill', '#00f2ff').attr('r', 3);
            }
        });

        // ── Heatmap decay interval (every second) ──
        setInterval(() => {
            let changed = false;
            countryHeatMap.forEach((heat, id) => {
                const next = Math.max(0, heat - HEAT_DECAY_RATE);
                if (next === 0) {
                    countryHeatMap.delete(id);
                    const feature = featureById.get(id);
                    if (feature) {
                        g.selectAll('.country').filter(d => d === feature).style('fill', null);
                    }
                } else {
                    countryHeatMap.set(id, next);
                }
                changed = true;
            });
            if (changed) updateHeatmap();
        }, 1000);

    } catch (err) {
        console.warn('[Map] Could not load world topology:', err.message);
        g.append('rect').attr('width', width).attr('height', height).attr('fill', '#080818');
    }

    // ── Hub Group (appended to SVG, not g, so it's not clipped by zoom distortion) ──
    hubGroup = g.append('g').attr('id', 'hub-group');
    hubPulse = hubGroup.append('circle').attr('class', 'hub-pulse');

    for (let r of [18, 12]) {
        hubGroup.append('circle')
            .attr('class', 'hub-ring')
            .attr('r', r)
            .attr('stroke-width', 0.5 + (18 - r) * 0.02)
            .attr('opacity', 0.3 + (18 - r) * 0.02);
    }

    hubGroup.append('circle').attr('class', 'hub-core').attr('r', 2);



    repositionHub();

    // ── D3 Zoom ──
    zoomBehavior = d3.zoom()
        .scaleExtent([1, 16])
        .translateExtent([[-width * 0.3, -height * 0.3], [width * 1.3, height * 1.3]])
        .on('zoom', (event) => {
            currentTransform = event.transform;
            g.attr('transform', event.transform);
            applyLOD(event.transform.k);
            adjustStrokeWidths(event.transform.k);
            updateExistingDotSizes(event.transform.k);
        });

    svg.call(zoomBehavior);

    // Prevent default scroll on map container to avoid page scroll conflict
    document.getElementById('map-container').addEventListener('wheel', e => e.preventDefault(), { passive: false });

    // ── Zoom control buttons ──
    addZoomControls();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function repositionHub() {
    if (!projection || !hubGroup) return;
    const [hx, hy] = projection([HUB_LON, HUB_LAT]);
    hubGroup.attr('transform', `translate(${hx},${hy})`);
}

function redrawAll() {
    if (!g || !path) return;
    g.selectAll('.country').attr('d', path);
    g.selectAll('.sphere-outline').attr('d', path);
    g.selectAll('.grat-minor').attr('d', path);
    g.selectAll('.grat-major').attr('d', path);
    g.selectAll('.country-label').attr('transform', d => {
        const c = path.centroid(d);
        return isNaN(c[0]) ? 'translate(-9999,-9999)' : `translate(${c[0]},${c[1]})`;
    });
    repositionHub();
}

/**
 * Apply progressive level-of-detail based on zoom scale k.
 * Labels shrink on-screen as you zoom in (font / k^1.4).
 */
function applyLOD(k) {
    if (!g) return;

    // Country labels: fade in at k ≥ 3, then shrink further as k grows
    // Screen size = (base / k^1.4) * k ∝ 1/k^0.4  → visibly shrinks
    const labelOpacity = k < 3 ? 0 : Math.min(1, (k - 3) / 1.5) * 0.78;
    const labelPx = Math.max(1.5, 6 / Math.pow(k, 1.4));
    g.selectAll('.country-label')
        .filter(d => COUNTRY_NAMES[d.id])
        .style('opacity', labelOpacity)
        .style('font-size', `${labelPx}px`);

    // City dots + labels: fade in at k ≥ 6, shrink similarly
    const cityOpacity = k < 6 ? 0 : Math.min(1, (k - 6) / 2);
    const cityPx = Math.max(1, 5 / Math.pow(k, 1.4));
    const dotR = Math.max(0.3, 2.2 / Math.pow(k, 1.4));
    g.selectAll('.city-dot')
        .style('opacity', cityOpacity)
        .attr('r', dotR);
    g.selectAll('.city-label')
        .style('opacity', cityOpacity)
        .style('font-size', `${cityPx}px`);

    // Hub label: small but legible at every zoom level
    g.select('.hub-label')
        .style('font-size', `${Math.max(3, 9 / Math.pow(k, 1.4))}px`);
}

/**
 * Rescale all live attack dots and block markers so they shrink on
 * screen as the user zooms in, instead of growing with the map.
 * Screen radius = (base / k^1.4) * k ∝ 1/k^0.4  → shrinks.
 */
function updateExistingDotSizes(k) {
    if (!g) return;
    const pow = Math.pow(k, 1.4);
    g.selectAll('.attack-dot.blocked, .attack-dot.geo-blocked, .attack-dot.tor, .attack-dot.proxy')
        .attr('r', Math.max(0.5, 4 / pow));
    g.selectAll('.attack-dot.allowed, .attack-dot.passed-inbound')
        .attr('r', Math.max(0.3, 2.5 / pow));
    g.selectAll('.block-marker')
        .attr('r', Math.max(1, 6 / pow));
}

/** Keep stroke widths visually consistent regardless of zoom */
function adjustStrokeWidths(k) {
    if (!g) return;
    const inv = 1 / k;

    // Map geography
    g.selectAll('.country').style('stroke-width', `${inv * 0.5}px`);
    g.selectAll('.sphere-outline').attr('stroke-width', inv * 1.2);
    g.selectAll('.grat-minor').attr('stroke-width', inv * 0.4);
    g.selectAll('.grat-major').attr('stroke-width', inv * 0.6);
    g.select('#hub-group').selectAll('.hub-ring')
        .attr('r', d => d / k)
        .attr('stroke-width', inv * 0.8);
    g.select('.hub-core').attr('r', 2 / k);
    g.select('.hub-label').attr('y', 26 / k);

    // Attack arcs — single selector catches all arc variants
    g.selectAll('.attack-arc').style('stroke-width', `${inv * 1.5}px`);
    // Narrower override for non-threat arcs
    g.selectAll('.attack-arc.allowed').style('stroke-width', `${inv * 0.5}px`);
    g.selectAll('.attack-arc.passed-inbound').style('stroke-width', `${inv * 1.8}px`);

    // Active top-attacker persistent line
    g.selectAll('.active-attacker-line')
        .style('stroke-width', `${inv * 1.5}px`);

    // Rate rings (hub pulse rings)
    g.selectAll('.rate-ring')
        .style('stroke-width', `${inv * 1.2}px`);
}

/** Inject + / − / ⌂ zoom control buttons as SVG-foreign objects */
function addZoomControls() {
    const controls = d3.select('#map-container')
        .append('div')
        .attr('class', 'map-zoom-controls');

    const btnData = [
        { label: '+', title: 'Zoom in', fn: () => svg.transition().duration(300).call(zoomBehavior.scaleBy, 2) },
        { label: '−', title: 'Zoom out', fn: () => svg.transition().duration(300).call(zoomBehavior.scaleBy, 0.5) },
        { label: '⌂', title: 'Reset view', fn: () => svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity) },
    ];

    btnData.forEach(({ label, title, fn }) => {
        controls.append('button')
            .attr('class', 'zoom-btn')
            .attr('title', title)
            .text(label)
            .on('click', fn);
    });
}

// ─── Exported API ────────────────────────────────────────────────────────────

/**
 * Briefly flash a country red when an attack originates there.
 */
export function highlightCountry(lon, lat, isGeoBlock = false) {
    if (!g || !countryFeatures.length) return;
    if (isGeoBlock) return;

    const point = [lon, lat];
    const feature = countryFeatures.find(f => d3.geoContains(f, point));
    if (!feature) return;

    const id = feature.id ?? feature.properties?.name;
    if (id != null) {
        countryHeatMap.set(id, (countryHeatMap.get(id) || 0) + 1);
        updateHeatmap();
    }

    const countryPath = g.selectAll('.country').filter(d => d === feature);
    if (countryPath.empty()) return;

    countryPath.classed('country-flash', true)
        .style('stroke', 'rgba(255, 0, 76, 0.9)')
        .style('stroke-width', `${1.2 / currentTransform.k}px`);

    setTimeout(() => {
        countryPath.transition().duration(6000).ease(d3.easeCubicOut)
            .style('stroke', null)
            .style('stroke-width', null)
            .on('end', () => countryPath.classed('country-flash', false));
    }, 3000);
}

/** Recolour heated countries */
function updateHeatmap() {
    if (!g || countryHeatMap.size === 0) return;
    let maxHeat = 0;
    countryHeatMap.forEach(v => { if (v > maxHeat) maxHeat = v; });
    if (maxHeat === 0) return;

    countryHeatMap.forEach((heat, id) => {
        const feature = featureById.get(id);
        if (!feature) return;
        const t = heat / maxHeat;
        const r = Math.round(236 + t * (255 - 236));
        const gv = Math.round(91 + t * (0 - 91));
        const b = Math.round(19 + t * (76 - 19));
        const alpha = 0.12 + t * 0.40;

        g.selectAll('.country')
            .filter(d => d === feature)
            .style('fill', `rgba(${r},${gv},${b},${alpha.toFixed(3)})`);
    });
}

/** Update the persistent pulsing line to the current top attacker */
function updateTopAttackerLine(srcLat, srcLon) {
    if (!svg || !projection) return;

    const key = `${srcLat.toFixed(2)},${srcLon.toFixed(2)}`;
    const entry = attackerCounts.get(key) || { lat: srcLat, lon: srcLon, count: 0 };
    entry.count++;
    attackerCounts.set(key, entry);

    let topKey = null, topCount = 0;
    attackerCounts.forEach((v, k) => { if (v.count > topCount) { topCount = v.count; topKey = k; } });
    if (!topKey) return;

    const top = attackerCounts.get(topKey);
    const [rx, ry] = projection([top.lon, top.lat]);
    const [hx, hy] = projection([HUB_LON, HUB_LAT]);
    const mx = (rx + hx) / 2 - (hy - ry) * 0.2;
    const my = (ry + hy) / 2 + (hx - rx) * 0.2;
    const d = `M${rx},${ry} Q${mx},${my} ${hx},${hy}`;

    if (activeAttackerLine) {
        activeAttackerLine.attr('d', d);
    } else {
        activeAttackerLine = g.insert('path', '#hub-group')
            .attr('class', 'active-attacker-line')
            .attr('d', d)
            .style('opacity', 0)
            .transition().duration(800).style('opacity', 1);
        activeAttackerLine = g.select('.active-attacker-line');
    }

    if (activeAttackerTimer) clearTimeout(activeAttackerTimer);
    activeAttackerTimer = setTimeout(() => {
        if (activeAttackerLine) {
            activeAttackerLine.transition().duration(3000).style('opacity', 0).remove();
            activeAttackerLine = null;
        }
        activeAttackerTimer = null;
    }, 30000);
}

/**
 * Render an attack arc from source coordinates to the hub.
 */
export function renderAttack(event) {
    if (!svg || !projection) return;

    const { srcLat, srcLon, action, direction, geoBlock } = event;
    if (srcLat == null || srcLon == null) return;

    const isBlocked = action === 'block';
    const isOutbound = direction === 'out';
    const isRealBlock = isBlocked && !geoBlock;

    let cls;
    if (isBlocked) {
        if (geoBlock) cls = 'geo-blocked';
        else if (event.isTor) cls = 'tor';
        else if (event.isProxy) cls = 'proxy';
        else cls = 'blocked';
    } else {
        cls = (!isOutbound && direction === 'in') ? 'passed-inbound' : 'allowed';
    }

    const [rx, ry] = projection([srcLon, srcLat]);
    const [hx, hy] = projection([HUB_LON, HUB_LAT]);

    const [ax, ay] = isOutbound ? [hx, hy] : [rx, ry];
    const [bx, by] = isOutbound ? [rx, ry] : [hx, hy];

    if (isBlocked) highlightCountry(srcLon, srcLat, !!geoBlock);
    if (isRealBlock) updateTopAttackerLine(srcLat, srcLon);

    // Remote dot — created at screen-stable size for current zoom
    const kpow = Math.pow(currentTransform.k, 1.4);
    const dot = g.append('circle')
        .attr('class', `attack-dot ${cls}`)
        .attr('cx', rx).attr('cy', ry)
        .attr('r', (isBlocked ? 4 : 2.5) / kpow)
        .style('opacity', 1);

    if (isRealBlock) {
        setTimeout(() => {
            dot.transition().duration(2000).style('opacity', 0).remove();
        }, 30000);

        const marker = g.append('circle')
            .attr('class', 'block-marker')
            .attr('cx', rx).attr('cy', ry)
            .attr('r', 6 / kpow)
            .attr('fill', 'url(#block-marker-gradient)')
            .style('opacity', 1);

        setTimeout(() => {
            marker.transition().duration(120000).ease(d3.easeCubicIn)
                .style('opacity', 0).remove();
        }, 180000);
    } else {
        setTimeout(() => {
            dot.transition().duration(2000).style('opacity', 0).remove();
        }, isBlocked ? 30000 : 10000);
    }

    // Arc
    const mx = (ax + bx) / 2 - (by - ay) * 0.25;
    const my = (ay + by) / 2 + (bx - ax) * 0.25;
    const arcPath = `M${ax},${ay} Q${mx},${my} ${bx},${by}`;
    const arcLen = Math.hypot(bx - ax, by - ay) * 2;

    const arcStrokeBase = cls === 'allowed' ? 0.5 : cls === 'passed-inbound' ? 1.8 : 1.5;

    const arc = g.append('path')
        .attr('class', `attack-arc ${cls}`)
        .attr('d', arcPath)
        .style('stroke-width', `${arcStrokeBase / currentTransform.k}px`)
        .attr('stroke-dasharray', `${arcLen} ${arcLen}`)
        .attr('stroke-dashoffset', arcLen);

    arc.transition()
        .duration(1000).ease(d3.easeCubicOut)
        .attr('stroke-dashoffset', 0)
        .on('end', () => {
            setTimeout(() => {
                arc.transition().duration(3000).style('opacity', 0).remove();
            }, 12000);
        });

    if (!isOutbound) setTimeout(() => pulseHub(), 1000);

    pruneElements('.attack-arc', MAX_ARCS);
    pruneElements('.attack-dot', MAX_DOTS);
    pruneElements('.block-marker', MAX_DOTS);
}

/** Remove oldest excess elements */
function pruneElements(selector, maxCount) {
    if (!g) return;
    const nodes = g.selectAll(selector);
    const excess = nodes.size() - maxCount;
    if (excess <= 0) return;
    nodes.filter((_, i) => i < excess).each(function () {
        d3.select(this).interrupt().remove();
    });
}

/** Trigger the hub pulse animation */
export function pulseHub() {
    if (!hubPulse || !projection) return;
    const [hx, hy] = projection([HUB_LON, HUB_LAT]);

    g.append('circle')
        .attr('cx', hx).attr('cy', hy)
        .attr('r', 6 / currentTransform.k)
        .attr('fill', '#00f2ff').attr('opacity', 0.9)
        .transition().duration(800).ease(d3.easeCubicOut)
        .attr('r', 30 / currentTransform.k)
        .attr('opacity', 0)
        .remove();
}

// ── Attack-Rate Hub Ring ──────────────────────────────────────────────────────
let rateRingTimer = null;

/**
 * Update the rate-indicator ring at the hub.
 */
export function setAttackRate(attacksPerMin) {
    if (!svg || !projection) return;

    let interval, maxR, color;
    if (attacksPerMin <= 0) {
        if (rateRingTimer) { clearInterval(rateRingTimer); rateRingTimer = null; }
        return;
    } else if (attacksPerMin < 5) { interval = 4000; maxR = 22; color = '#00c8d4'; }
    else if (attacksPerMin < 20) { interval = 2000; maxR = 34; color = '#00e8f5'; }
    else { interval = 800; maxR = 48; color = '#00f2ff'; }

    if (rateRingTimer) clearInterval(rateRingTimer);

    const fireRing = () => {
        if (!g || !projection) return;
        const [hx, hy] = projection([HUB_LON, HUB_LAT]);
        const k = currentTransform.k;
        g.append('circle')
            .attr('class', 'rate-ring')
            .attr('cx', hx).attr('cy', hy)
            .attr('r', 8 / k)
            .attr('fill', 'none')
            .attr('stroke', color)
            .attr('stroke-width', 1.2 / k)
            .attr('opacity', 0.7)
            .transition().duration(interval * 0.9).ease(d3.easeCubicOut)
            .attr('r', maxR / k)
            .attr('opacity', 0)
            .remove();
    };

    fireRing();
    rateRingTimer = setInterval(fireRing, interval);
}

export default { initMap, renderAttack, pulseHub, setAttackRate };
