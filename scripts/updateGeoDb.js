#!/usr/bin/env node
/**
 * Download MaxMind GeoLite2 City database (.mmdb)
 *
 * Prerequisites:
 *   1. Create a FREE MaxMind account: https://www.maxmind.com/en/geolite2/signup
 *   2. Generate a License Key:
 *      My Account → Manage License Keys → Generate new key
 *   3. Run: MAXMIND_LICENSE_KEY=<your_key> node scripts/updateGeoDb.js
 *
 * The script downloads GeoLite2-City.mmdb to ./data/GeoLite2-City.mmdb
 * Schedule via cron for weekly auto-updates (MaxMind updates Tuesdays).
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'GeoLite2-City.mmdb');
const TEMP_TAR = path.join(DATA_DIR, 'GeoLite2-City.tar.gz');

const LICENSE_KEY = process.env.MAXMIND_LICENSE_KEY;
const EDITION_ID = 'GeoLite2-City';  // Free tier

if (!LICENSE_KEY) {
    console.error('\n❌  MAXMIND_LICENSE_KEY environment variable not set.\n');
    console.error('Steps:');
    console.error('  1. Register free at https://www.maxmind.com/en/geolite2/signup');
    console.error('  2. Generate a license key at:');
    console.error('     https://www.maxmind.com/en/accounts/current/license-key\n');
    console.error('  3. Run:  MAXMIND_LICENSE_KEY=<your_key> node scripts/updateGeoDb.js\n');
    process.exit(1);
}

// MaxMind download URL (permanent download endpoint)
const DOWNLOAD_URL = `https://download.maxmind.com/app/geoip_download` +
    `?edition_id=${EDITION_ID}&license_key=${LICENSE_KEY}&suffix=tar.gz`;

async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const request = https.get(url, (res) => {
            // Handle redirects
            if (res.statusCode === 302 || res.statusCode === 301) {
                file.close();
                fs.unlinkSync(destPath);
                return downloadFile(res.headers.location, destPath)
                    .then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}\n` +
                    'Check that your license key is valid.'));
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;

            res.on('data', (chunk) => {
                downloaded += chunk.length;
                if (total > 0) {
                    const pct = ((downloaded / total) * 100).toFixed(0);
                    process.stdout.write(`\r  Downloading… ${pct}% (${(downloaded / 1e6).toFixed(1)} MB)`);
                }
            });

            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        });

        request.on('error', (err) => { fs.unlink(destPath, () => { }); reject(err); });
    });
}

/**
 * Extract the .mmdb file from the tar.gz archive.
 * The archive structure is: GeoLite2-City_YYYYMMDD/GeoLite2-City.mmdb
 */
async function extractMmdb(tarPath, destPath) {
    const tar = await import('tar').catch(() => null);

    if (tar) {
        // Use the `tar` package if available
        await tar.default.extract({
            file: tarPath,
            cwd: path.dirname(tarPath),
            filter: (p) => p.endsWith('.mmdb'),
            strip: 1,
        });
        const extracted = path.join(path.dirname(tarPath), 'GeoLite2-City.mmdb');
        if (fs.existsSync(extracted)) {
            fs.renameSync(extracted, destPath);
        }
    } else {
        // Fallback: manual tar extraction using built-in zlib
        console.log('\n  Extracting archive (built-in)…');
        await extractTarGz(tarPath, destPath);
    }
}

/** Minimal tar.gz extractor (no external dependency) */
async function extractTarGz(tarPath, mmdbDest) {
    return new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        const input = fs.createReadStream(tarPath);

        let buffer = Buffer.alloc(0);
        const chunks = [];

        input.pipe(gunzip);
        gunzip.on('data', (chunk) => chunks.push(chunk));
        gunzip.on('end', () => {
            buffer = Buffer.concat(chunks);
            const mmdb = parseTarForMmdb(buffer);
            if (mmdb) {
                fs.writeFileSync(mmdbDest, mmdb);
                resolve();
            } else {
                reject(new Error('Could not find .mmdb file in tar archive'));
            }
        });
        gunzip.on('error', reject);
        input.on('error', reject);
    });
}

/** Parse a raw tar buffer and extract the first .mmdb file found */
function parseTarForMmdb(buffer) {
    let offset = 0;
    while (offset + 512 <= buffer.length) {
        const header = buffer.slice(offset, offset + 512);
        const name = header.slice(0, 100).toString('utf8').replace(/\0/g, '');
        const sizeOctal = header.slice(124, 136).toString('utf8').replace(/\0/g, '').trim();
        const size = parseInt(sizeOctal, 8) || 0;

        offset += 512;

        if (name.endsWith('.mmdb') && size > 0) {
            return buffer.slice(offset, offset + size);
        }

        // Round up to 512-byte block boundary
        offset += Math.ceil(size / 512) * 512;
    }
    return null;
}

// ── Main ──────────────────────────────────────────

async function main() {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║  MaxMind GeoLite2-City Database Updater      ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    console.log(`  Edition:  ${EDITION_ID}`);
    console.log(`  Dest:     ${DB_PATH}\n`);

    // Download
    console.log('  Step 1/3: Downloading archive from MaxMind…');
    await downloadFile(DOWNLOAD_URL, TEMP_TAR);
    console.log('\n  ✅ Download complete');

    // Extract
    console.log('\n  Step 2/3: Extracting GeoLite2-City.mmdb…');
    await extractMmdb(TEMP_TAR, DB_PATH);
    console.log('  ✅ Extraction complete');

    // Cleanup temp file
    console.log('\n  Step 3/3: Cleaning up…');
    try { fs.unlinkSync(TEMP_TAR); } catch { }

    const stat = fs.statSync(DB_PATH);
    console.log(`  ✅ Database ready: ${(stat.size / 1e6).toFixed(1)} MB`);
    console.log(`\n  📍 Location: ${DB_PATH}`);
    console.log('\n  ℹ️  MaxMind updates GeoLite2 every Tuesday.');
    console.log('     Add to cron for auto-updates:');
    console.log('     0 6 * * 2 cd /path/to/Cybersoc && MAXMIND_LICENSE_KEY=<key> node scripts/updateGeoDb.js\n');
}

main().catch((err) => {
    console.error('\n❌  Update failed:', err.message);
    process.exit(1);
});
