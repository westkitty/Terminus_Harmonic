/**
 * Generates the PWA icons deterministically (no binary assets in the repo).
 *
 * The mark: a dark field, a scarred ochre planetary disc with a wound arc, and a
 * thin azure phase ring — the Terminus Harmonic signature.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic value noise.
function hash2(x, y, s) {
  let h = (s ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}
function noise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
  const c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function fbm(x, y, s, oct = 4) {
  let v = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) {
    v += a * noise(x * f, y * f, (s + i * 1013) >>> 0);
    n += a;
    a *= 0.5;
    f *= 2;
  }
  return v / n;
}

function makeIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // Maskable icons need a safe zone: shrink the artwork to ~72% of the canvas.
  const r = maskable ? size * 0.33 : size * 0.34;
  const safe = maskable ? size * 0.72 : size * 0.86;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - cx) / (size * 0.5);
      const dy = (y - cy) / (size * 0.5);
      const d = Math.hypot(dx, dy);

      // Background: near-black with a faint vertical gradient.
      let r0 = 5 + (y / size) * 4;
      let g0 = 6 + (y / size) * 4;
      let b0 = 10 + (y / size) * 6;

      if (d < r / (size * 0.5)) {
        // Planet disc, scarred.
        const n = fbm(dx * 6, dy * 6, 0x51ed, 5);
        const wound = fbm(dx * 3.2 + 4, dy * 3.2, 0xa17, 3);
        const vit = Math.max(0, Math.min(1, (wound - 0.55) * 3));
        const scar = Math.max(0, Math.min(1, (n - 0.62) * 3.4));
        let pr = 0.115 + n * 0.13 + vit * 0.03 - scar * 0.03;
        let pg = 0.105 + n * 0.10 + vit * 0.01 - scar * 0.01;
        let pb = 0.098 + n * 0.08 + vit * 0.06 - scar * 0.02;
        // Terminator shading from the upper-left.
        const lit = Math.max(0, Math.min(1, (-dx * 0.6 - dy * 0.6 + 0.55) * 1.5));
        pr *= 0.25 + lit * 1.0;
        pg *= 0.25 + lit * 0.95;
        pb *= 0.25 + lit * 0.9;
        // Oxidation banding.
        const ox = fbm(dx * 12, dy * 12, 0x77aa, 3);
        pr += ox * 0.09;
        pg += ox * 0.035;
        pb += ox * 0.012;
        r0 = pr; g0 = pg; b0 = pb;
      }

      // Azure phase ring — the Terminus Harmonic signature, outside the disc.
      const ringR = (r / (size * 0.5)) * 1.16;
      const ringDist = Math.abs(d - ringR);
      const ringW = 0.012 + (d < ringR ? 0.004 : 0);
      if (ringDist < ringW) {
        const t = 1 - ringDist / ringW;
        const phase = Math.atan2(dy, dx);
        const seg = Math.max(0, Math.sin(phase * 3.0));
        const a = t * (0.35 + seg * 0.65) * safe;
        r0 = r0 * (1 - a) + 0.19 * a;
        g0 = g0 * (1 - a) + 0.62 * a;
        b0 = b0 * (1 - a) + 0.84 * a;
      }

      // Vignette to keep the icon legible at small sizes.
      const vig = Math.max(0, 1 - d * d * 0.55);
      r0 *= vig; g0 *= vig; b0 *= vig;

      px[i] = Math.round(Math.max(0, Math.min(1, r0)) * 255);
      px[i + 1] = Math.round(Math.max(0, Math.min(1, g0)) * 255);
      px[i + 2] = Math.round(Math.max(0, Math.min(1, b0)) * 255);
      px[i + 3] = 255;
    }
  }
  return encodePng(size, size, px);
}

writeFileSync(resolve(OUT, 'icon-192.png'), makeIcon(192, false));
writeFileSync(resolve(OUT, 'icon-512.png'), makeIcon(512, false));
writeFileSync(resolve(OUT, 'icon-maskable-512.png'), makeIcon(512, true));
console.log('icons written to', OUT);
