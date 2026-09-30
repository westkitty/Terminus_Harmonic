/**
 * Generates the PWA icons deterministically (no external binary dependencies).
 *
 * Visual contract:
 *   - Obsidian void field (#07080a) with subtle radial depth vignette
 *   - Scarred, oxidised ochre/rust planetary disc with tectonic fault lines and
 *     warm amber terminator rim light
 *   - Crisp azure phase-lock ring (#3fa9d8) with four cardinal harmonic nodes
 *     and outer dashed orbital telemetry track, matching `public/icons/mark.svg`
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

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function makeIcon(size, maskable) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  // Normalised radii in 0..1 half-canvas coordinates.
  const scale = maskable ? 0.80 : 0.94;
  const planetR = 0.54 * scale;
  const ringR = 0.72 * scale;
  const outerR = 0.82 * scale;
  const aa = 2.2 / size;

  for (let y = 0; y < size; y++) {
    const vy = y / size;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - cx) / (size * 0.5);
      const dy = (y - cy) / (size * 0.5);
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);

      // 1. Obsidian void background in 0..1 colour space (#07080a -> #0c0f14).
      const bgGlow = Math.max(0, 1 - d * 0.85);
      let r0 = 0.027 + vy * 0.012 + bgGlow * 0.018;
      let g0 = 0.031 + vy * 0.014 + bgGlow * 0.024;
      let b0 = 0.041 + vy * 0.018 + bgGlow * 0.032;

      // 2. Subtle atmospheric limb halo around the planet disc.
      if (d >= planetR * 0.92 && d < planetR * 1.24) {
        const halo = Math.exp(-Math.pow((d - planetR) / (0.07 * scale), 2));
        const sunSide = Math.max(0.15, (-dx * 0.65 - dy * 0.65 + 0.45));
        r0 += 0.22 * halo * sunSide;
        g0 += 0.16 * halo * sunSide;
        b0 += 0.11 * halo * sunSide;
      }

      // 3. Scarred planetary sphere with 3D spherical normals & tectonic fissures.
      if (d < planetR + aa) {
        const edgeAlpha = 1 - smoothstep(planetR - aa, planetR + aa, d);
        const nx = dx / planetR;
        const ny = dy / planetR;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));

        // Spherical continent / basin / oxidation noise.
        const cont = fbm(nx * 3.4 + 1.7, ny * 3.4 + nz * 1.2, 0x51ed, 5);
        const ox = fbm(nx * 7.5 - 2.1, ny * 7.5 + nz * 2.0, 0x77aa, 4);
        const ridge = Math.abs(fbm(nx * 5.2, ny * 5.2, 0xa17, 3) - 0.5);
        const fissure = smoothstep(0.045, 0.0, ridge);

        // Base scorched rock + vitrified basin + rust oxidation.
        let pr = 0.14 + cont * 0.22 + ox * 0.16;
        let pg = 0.10 + cont * 0.14 + ox * 0.07;
        let pb = 0.08 + cont * 0.09 + ox * 0.03;

        if (cont < 0.46) {
          // Vitrified dark basin.
          pr = 0.08 + ox * 0.06;
          pg = 0.085 + ox * 0.05;
          pb = 0.105 + ox * 0.07;
        }

        // Glowing tectonic wound fissure (#c98a3c / #e0b060).
        pr = pr * (1 - fissure * 0.7) + 0.86 * fissure * 0.75;
        pg = pg * (1 - fissure * 0.7) + 0.54 * fissure * 0.75;
        pb = pb * (1 - fissure * 0.7) + 0.22 * fissure * 0.75;

        // Directional stellar lighting from upper-left + warm limb rim.
        const ndl = Math.max(0, -nx * 0.58 - ny * 0.55 + nz * 0.60);
        const rim = Math.pow(1 - nz, 2.6) * Math.max(0, -nx * 0.5 - ny * 0.5 + 0.35);
        const shade = 0.22 + ndl * 1.15;
        pr = pr * shade + rim * 0.55;
        pg = pg * shade + rim * 0.38;
        pb = pb * shade + rim * 0.20;

        // Ochre crust outline on the planet limb.
        const limbBand = smoothstep(planetR - aa * 2.2, planetR - aa * 0.4, d);
        pr = pr * (1 - limbBand * 0.45) + 0.78 * limbBand * 0.45;
        pg = pg * (1 - limbBand * 0.45) + 0.54 * limbBand * 0.45;
        pb = pb * (1 - limbBand * 0.45) + 0.24 * limbBand * 0.45;

        r0 = r0 * (1 - edgeAlpha) + pr * edgeAlpha;
        g0 = g0 * (1 - edgeAlpha) + pg * edgeAlpha;
        b0 = b0 * (1 - edgeAlpha) + pb * edgeAlpha;
      }

      // 4. Outer dashed orbital telemetry ring (#1d4c63).
      const outerDist = Math.abs(d - outerR);
      const outerW = 0.011 * scale;
      if (outerDist < outerW + aa) {
        const dash = Math.sin(ang * 18) > -0.15 ? 1 : 0;
        const a = (1 - smoothstep(outerW - aa, outerW + aa, outerDist)) * 0.55 * dash;
        r0 = r0 * (1 - a) + 0.16 * a;
        g0 = g0 * (1 - a) + 0.38 * a;
        b0 = b0 * (1 - a) + 0.49 * a;
      }

      // 5. Primary azure Terminus Harmonic phase-lock ring (#3fa9d8).
      const ringDist = Math.abs(d - ringR);
      const ringW = 0.018 * scale;
      if (ringDist < ringW + aa) {
        const core = 1 - smoothstep(ringW * 0.35, ringW + aa, ringDist);
        const phaseMod = 0.72 + 0.28 * Math.cos(ang * 4);
        const a = core * phaseMod * 0.92;
        r0 = r0 * (1 - a) + 0.25 * a;
        g0 = g0 * (1 - a) + 0.68 * a;
        b0 = b0 * (1 - a) + 0.86 * a;
      }

      // 6. Four cardinal acoustic spire phase-lock nodes on the azure ring.
      const nodePositions = [
        [0, -ringR],
        [ringR, 0],
        [0, ringR],
        [-ringR, 0],
      ];
      for (const [nx, ny] of nodePositions) {
        const nd = Math.hypot(dx - nx, dy - ny);
        const nr = 0.042 * scale;
        if (nd < nr + aa * 2) {
          const a = 1 - smoothstep(nr - aa, nr + aa, nd);
          r0 = r0 * (1 - a) + 0.38 * a;
          g0 = g0 * (1 - a) + 0.80 * a;
          b0 = b0 * (1 - a) + 0.96 * a;
        }
      }

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
