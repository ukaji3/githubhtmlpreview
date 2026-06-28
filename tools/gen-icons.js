/*
 * Generates the extension icons (16/32/48/128 PNG) with no external deps.
 * A brand-colored rounded square with a white "document + lines" glyph.
 * Run: node tools/gen-icons.js
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function makeIcon(N) {
  const bg = [0x3a, 0x36, 0xc4];   // brand indigo
  const fg = [255, 255, 255];
  const rgba = Buffer.alloc(N * N * 4);
  const radius = N * 0.18;
  const dx0 = N * 0.30, dx1 = N * 0.70, dy0 = N * 0.20, dy1 = N * 0.82;
  const pad = (dx1 - dx0) * 0.16;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      let col = bg;
      // white document body
      if (x >= dx0 && x < dx1 && y >= dy0 && y < dy1) {
        col = fg;
        const rel = (y - dy0) / (dy1 - dy0);
        const inText = x > dx0 + pad && x < dx1 - pad;
        if (inText && ((rel > 0.18 && rel < 0.28) || (rel > 0.44 && rel < 0.54) || (rel > 0.70 && rel < 0.80))) {
          col = bg; // brand "text" lines
        }
      }
      // rounded-corner alpha
      let a = 255;
      const inX = Math.min(x + 0.5, N - 0.5 - x);
      const inY = Math.min(y + 0.5, N - 0.5 - y);
      if (inX < radius && inY < radius) {
        const ddx = radius - inX, ddy = radius - inY;
        if (ddx * ddx + ddy * ddy > radius * radius) a = 0;
      }
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2]; rgba[i + 3] = a;
    }
  }
  return encodePng(N, N, rgba);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const N of [16, 32, 48, 128]) {
  const out = path.join(outDir, `icon${N}.png`);
  fs.writeFileSync(out, makeIcon(N));
  console.log('wrote', out, fs.statSync(out).size, 'bytes');
}
