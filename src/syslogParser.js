/**
 * OPNsense Syslog / Filter-Log Parser
 * Parses both RFC 5424 syslog and OPNsense PF filter log formats.
 *
 * OPNsense pf log example:
 * <134>1 2024-01-15T14:20:01Z opnsense.local filterlog 1234 - - 4,,,,,,0,pass,in,ether,192.168.1.1,8.8.8.8,TCP,123,,,443,SYN
 * Or the legacy format:
 * Jan 15 14:20:01 opnsense filterlog: 4,,,0,igb0,match,block,in,4,0x0,,64,12345,0,none,6,tcp,60,185.12.34.56,10.0.0.1,44123,22,0
 */

/**
 * Parse a raw OPNsense filterlog syslog line into a structured attack event.
 * Returns null if the line cannot be parsed.
 *
 * @param {string} rawLine - The raw syslog line
 * @returns {Object|null} Parsed event with { timestamp, srcIp, dstPort, action, proto }
 */

// Lazy geo-block sets — built on first use so dotenv in server.js has already run.
let _geoRuleNumbers = null;
let _geoUuids = null;

function getGeoSets() {
  if (!_geoRuleNumbers) {
    const parse = (key) => new Set(
      (process.env[key] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    );
    _geoRuleNumbers = parse('GEO_BLOCK_RULES');
    _geoUuids = parse('GEO_BLOCK_UUIDS');
    console.log(`[Parser] Geo sets initialised — rules:[${[..._geoRuleNumbers]}] uuids:[${[..._geoUuids].map(u => u.slice(0, 8) + '..')}]`);
  }
  return { geoRuleNumbers: _geoRuleNumbers, geoUuids: _geoUuids };
}

export function parseSyslogLine(rawLine) {
  if (!rawLine || typeof rawLine !== 'string') return null;

  const line = rawLine.trim();

  // Try RFC 5424 / OPNsense new format
  // OPNsense sends: filterlog[PID]: payload  — [^:]* skips the optional [PID] part
  const filterlogMatch = line.match(/filterlog[^:]*:\s*(.+)/i);
  if (filterlogMatch) {
    return parseFilterlogPayload(filterlogMatch[1], line);
  }

  return null;
}

/**
 * Parse the CSV payload from a filterlog syslog message.
 * OPNsense PF log format (IPv4 TCP example):
 * rulenr,subrulenr,anchorname,label,ifname,reason,action,dir,ipver,...
 *
 * Field indices (0-based):
 *  0  = rule number
 *  1  = sub rule
 *  2  = anchor
 *  3  = label
 *  4  = interface
 *  5  = reason
 *  6  = action (pass/block/match)
 *  7  = direction (in/out)
 *  8  = ip version (4/6)
 *  ...
 * For IPv4 TCP (ip_version=4, proto=tcp):
 *  9  = tos
 *  10 = ecn
 *  11 = ttl
 *  12 = id
 *  13 = offset
 *  14 = flags
 *  15 = proto_id
 *  16 = proto_txt
 *  17 = length
 *  18 = src_ip
 *  19 = dst_ip
 *  20 = src_port
 *  21 = dst_port
 */
function parseFilterlogPayload(payload, rawLine) {
  const parts = payload.split(',');

  if (parts.length < 12) return null;

  const label = (parts[3] || '').toLowerCase();  // OPNsense rule label (field 3)
  const reason = (parts[5] || '').toLowerCase();  // PF reason: match / bad-offset / etc.
  const action = (parts[6] || '').toLowerCase();  // pass / block / match / nat
  const direction = (parts[7] || '').toLowerCase();  // in / out
  const proto = (parts[16] || parts[15] || '').toLowerCase();

  // Detect geo-block: lazy read of env sets (built after dotenv runs in server.js).
  // Checks rule number (parts[0]) AND UUID label (parts[3]).
  const ruleNumber = (parts[0] || '').trim();
  const { geoRuleNumbers, geoUuids } = getGeoSets();
  const geoBlock = action === 'block' && (
    geoRuleNumbers.has(ruleNumber) ||
    geoUuids.has(label) // label is already lowercased
  );

  const srcIp = parts[18] || parts[17] || null;
  const dstIp = parts[19] || parts[18] || null;
  const srcPort = parseInt(parts[20] || '0', 10);
  const dstPort = parseInt(parts[21] || parts[20] || '0', 10);

  if (!srcIp) return null;

  // Filter out NAT events (action=nat) — these are pre-NAT duplicates.
  // OPNsense sends both nat,out AND pass,out for the same connection.
  // We only show pass,out (post-NAT with real public srcIp).
  if (action === 'nat') return null;

  // For block / geo-block events: always use srcIp (the attacker's public address).
  // For outbound pass events: srcIp is the local/LAN address → geo-locate dstIp instead.
  const isPrivateSrc = isPrivateIpParser(srcIp);
  const isBlock = action === 'block' || action === 'drop';
  let remoteIp;
  if (isBlock) {
    // Block & geo-block: source IP is always the attacker — use it regardless of direction
    remoteIp = isPrivateSrc ? dstIp : srcIp;
  } else {
    // Pass / outbound: use dstIp when src is private (LAN traffic heading out)
    remoteIp = (direction === 'out' || isPrivateSrc) ? dstIp : srcIp;
  }

  // Skip if remoteIp is also private (internal-to-internal)
  if (!remoteIp || isPrivateIpParser(remoteIp)) return null;

  // Extract timestamp from syslog header if present
  let timestamp = new Date().toISOString();
  const tsMatch = rawLine.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (tsMatch) {
    timestamp = new Date(tsMatch[1]).toISOString();
  } else {
    // Legacy: "Feb 27 09:06:02"
    const legacyMatch = rawLine.match(/(\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})/);
    if (legacyMatch) {
      timestamp = new Date(legacyMatch[1] + ' ' + new Date().getFullYear()).toISOString();
    }
  }

  const ifname = parts[4] || 'unknown';

  return {
    timestamp,
    srcIp,
    dstIp,
    remoteIp,
    ifname,
    ruleNumber,      // PF rule number — used by server.js for geo-block detection
    srcPort: isNaN(srcPort) ? 0 : srcPort,
    dstPort: isNaN(dstPort) ? 0 : dstPort,
    action: normalizeAction(action, direction),
    proto,
    direction,
    geoBlock,
    label,
    raw: rawLine.slice(0, 200),
  };
}


/** Lightweight private-IP check used inside parser (no import of geoLookup) */
function isPrivateIpParser(ip) {
  if (!ip) return true;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip);
}

/** Normalize action strings to 'block' or 'pass'. OPNsense 'nat' is a pass. */
function normalizeAction(action, direction) {
  if (action === 'block' || action === 'drop') return 'block';
  return 'pass';
}

export default { parseSyslogLine };
