#!/usr/bin/env node
'use strict';
// Command-line alternative to the settings screen in the Homebridge UI.
// One-time setup: extract the signing value from your own copy of the Philips Air+ APK,
// sign in with your Philips account (email + emailed code), and print the platform config.
//
//   npx philips-air-fan-setup /path/to/philips-air.apk
//
// Nothing is uploaded anywhere except the Philips login/API calls themselves.

const fs = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline/promises');
const { PhilipsCloud, requestOtp, verifyOtp } = require('./cloud');

// Minimal ZIP central-directory reader (stored + deflate), enough for APK/APKM/XAPK files.
function* zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip/APK file');
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    yield {
      name,
      read() {
        const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
        const raw = buf.subarray(start, start + compSize);
        return method === 0 ? raw : zlib.inflateRawSync(raw);
      },
    };
  }
}

// The mSecret has the distinctive form a_ + 32 hex chars inside the app's dex bytecode.
function extractMSecret(buf, hits = new Set()) {
  for (const e of zipEntries(buf)) {
    if (e.name.endsWith('.dex')) {
      for (const m of e.read().toString('latin1').matchAll(/a_[0-9a-f]{32}/g)) hits.add(m[0]);
    } else if (e.name.endsWith('.apk')) {
      try { extractMSecret(e.read(), hits); } catch { /* not a nested apk */ }
    }
  }
  return hits;
}

async function main() {
  const apk = process.argv[2];
  if (!apk) {
    console.error('Usage: npx philips-air-fan-setup /path/to/philips-air.apk');
    process.exit(1);
  }
  const hits = extractMSecret(fs.readFileSync(apk));
  if (hits.size !== 1) {
    console.error(hits.size ? `Ambiguous: found ${hits.size} candidates.` : 'Signing value not found. Use the base Philips Air+ APK (com.philips.ph.homecare).');
    process.exit(1);
  }
  const mSecret = [...hits][0];
  console.log('✓ Found signing value in APK');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const email = (await rl.question('Philips account email: ')).trim();
  const vToken = await requestOtp(email);
  const code = (await rl.question('6-digit code from the email: ')).trim();
  rl.close();
  const userId = await verifyOtp(email, code, vToken);
  console.log('✓ Signed in');

  const devices = await new PhilipsCloud({ userId, mSecret }).getDevices();
  console.log(`✓ Found ${devices.length} device(s):`);
  for (const d of devices) console.log(`   - ${d.device_info?.name || d.device_id} (${d.device_info?.modelid || '?'})`);

  console.log('\nAdd this block to "platforms" in your Homebridge config:\n');
  console.log(JSON.stringify({ platform: 'PhilipsAirFan', name: 'Philips Air+', userId, mSecret }, null, 4));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`Setup failed: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { extractMSecret };
