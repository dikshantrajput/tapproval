#!/usr/bin/env node
/**
 * Generates the two notification action-button icons.
 *
 *   public/action-allow.png   green disc, white check
 *   public/action-deny.png    red disc, white cross
 *
 * Written by hand rather than pulled from a design tool because they are the only
 * two raster assets in the project that have to exist at a fixed size, and a
 * 60-line PNG writer is cheaper to keep honest than a binary blob nobody can diff.
 *
 * Chrome on Android is the only platform that renders notification action icons
 * (iOS ignores the `actions` array entirely), and it draws them at roughly 24dp
 * inside a 128px box. So: 128x128, one shape, no gradients, no text — anything
 * finer than this is invisible at the size it is actually shown.
 *
 *   node scripts/make-action-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* ---------------------------------------------------------------- drawing */

/** RGBA canvas, transparent. Chrome composites these over its own background. */
const canvas = () => new Uint8Array(SIZE * SIZE * 4);

const put = (buf, x, y, [r, g, b], a) => {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  // Source-over onto whatever is already there, so the white glyph can be laid
  // on the coloured disc without knowing the disc's shape.
  const sa = Math.min(1, a);
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let c = 0; c < 3; c++) {
    buf[i + c] = Math.round(([r, g, b][c] * sa + buf[i + c] * da * (1 - sa)) / oa);
  }
  buf[i + 3] = Math.round(oa * 255);
};

/**
 * Anti-aliased filled circle. Coverage is estimated from the distance to the
 * edge, which is exact enough for a shape this size and avoids supersampling.
 */
function disc(buf, cx, cy, radius, colour) {
  for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
    for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      put(buf, x, y, colour, Math.max(0, Math.min(1, radius + 0.5 - d)));
    }
  }
}

/** Anti-aliased round-capped line, drawn as the set of points near the segment. */
function stroke(buf, x0, y0, x1, y1, width, colour) {
  const half = width / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - x0;
      const py = y + 0.5 - y0;
      // Clamped projection onto the segment gives round caps for free.
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d = Math.hypot(px - dx * t, py - dy * t);
      put(buf, x, y, colour, Math.max(0, Math.min(1, half + 0.5 - d)));
    }
  }
}

/* -------------------------------------------------------------- encoding */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // colour type: RGBA
  // 10..12 = compression, filter, interlace — all zero.

  // Filter type 0 (none) per scanline. The shapes are flat colour, so deflate
  // already collapses them; a smarter filter would save nothing measurable.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * SIZE * 4, SIZE * 4)
      .copy(raw, y * (SIZE * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ icons */

const WHITE = [255, 255, 255];
const c = SIZE / 2;
const r = SIZE / 2 - 4;
const w = 13;

// Same greens and reds the PWA uses for its own Approve / Deny buttons, so the
// notification and the page do not disagree about which one is which.
const allow = canvas();
disc(allow, c, c, r, [22, 163, 106]);
stroke(allow, 40, 66, 57, 84, w, WHITE);
stroke(allow, 57, 84, 90, 46, w, WHITE);

const deny = canvas();
disc(deny, c, c, r, [214, 60, 60]);
stroke(deny, 45, 45, 83, 83, w, WHITE);
stroke(deny, 83, 45, 45, 83, w, WHITE);

for (const [name, buf] of [['action-allow', allow], ['action-deny', deny]]) {
  const out = join(PUBLIC, `${name}.png`);
  writeFileSync(out, png(buf));
  console.log(`wrote ${out}`);
}
