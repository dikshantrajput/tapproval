#!/usr/bin/env node
/**
 * Writes ~/.claude/tapproval.json (so the hook knows where to call)
 * and prints a QR code pointing the phone at the PWA.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import qrcode from 'qrcode-terminal';

const url = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
const deviceId = process.env.DEVICE_ID ?? '';

if (!url || !deviceId) {
  console.error('Set PUBLIC_URL and DEVICE_ID in .env first.');
  process.exit(1);
}

const dir = join(homedir(), '.claude');
mkdirSync(dir, { recursive: true });
const path = join(dir, 'tapproval.json');
writeFileSync(path, JSON.stringify({ url, deviceId, timeoutSec: 90 }, null, 2) + '\n', { mode: 0o600 });

// The QR carries the device secret — the phone stores it and authenticates
// with it from then on. It is deliberately not fetchable from the server.
const pairUrl = `${url}/p/${deviceId}`;

console.log(`\n  wrote ${path}\n`);
console.log(`  Scan this on your phone, then tap "Enable notifications":\n`);
qrcode.generate(pairUrl, { small: true });
console.log(`\n  ${pairUrl}\n`);
console.log(`  ⚠ This link contains your device secret. Anyone with it can`);
console.log(`    approve tool calls on your machine — don't share or screenshot it.\n`);
console.log(`  iPhone: open in Safari → Share → Add to Home Screen → open from the icon.`);
console.log(`          Web push does not work in a plain Safari tab.\n`);
