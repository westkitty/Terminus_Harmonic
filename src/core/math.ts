/**
 * Shared numeric helpers.
 *
 * Everything in this project is deterministic and allocation-conscious: helpers
 * return plain numbers, and anything that would allocate per-frame is exposed as
 * an `into`-style out-parameter variant.
 */

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

/** Frame-rate independent exponential smoothing. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` at a bounded speed. */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Signed shortest angular difference in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Wrap into [0, 1). */
export function fract(v: number): number {
  return v - Math.floor(v);
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Unit vector on a sphere from degrees. Returns [x,y,z]. */
export function latLonToVec3(latDeg: number, lonDeg: number, radius = 1, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const phi = latDeg * DEG2RAD;
  const theta = lonDeg * DEG2RAD;
  const cp = Math.cos(phi);
  out[0] = radius * cp * Math.cos(theta);
  out[1] = radius * Math.sin(phi);
  out[2] = radius * cp * Math.sin(theta);
  return out;
}

/** Inverse of {@link latLonToVec3}. */
export function vec3ToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z) || 1;
  const lat = Math.asin(clamp(y / r, -1, 1)) * RAD2DEG;
  let lon = Math.atan2(z, x) * RAD2DEG;
  if (lon < 0) lon += 360;
  return { lat, lon };
}

/** Great-circle distance in radians between two lat/lon points. */
export function angularDistance(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const p1 = aLat * DEG2RAD;
  const p2 = bLat * DEG2RAD;
  const dp = p2 - p1;
  const dl = (bLon - aLon) * DEG2RAD;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Stable 32-bit string hash (FNV-1a). Used to derive sub-seeds from names. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine two 32-bit seeds into a new well-mixed 32-bit seed. */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number;
  /** Approximately normal, mean 0 stddev 1 (sum of 4 uniforms). */
  gauss(): number;
  /** True with probability p. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, deterministic. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    gauss: () => (next() + next() + next() + next() - 2) * 1.4142,
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}

/** Deterministic value noise in 2D, smoothed. Used for 2D (x, z) height/colour fields. */
export function valueNoise2(x: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const c00 = hash2(xi, zi, seed);
  const c10 = hash2(xi + 1, zi, seed);
  const c01 = hash2(xi, zi + 1, seed);
  const c11 = hash2(xi + 1, zi + 1, seed);
  const x0 = c00 + (c10 - c00) * u;
  const x1 = c01 + (c11 - c01) * u;
  return x0 + (x1 - x0) * w;
}

function hash2(x: number, z: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** Fractal Brownian motion over {@link valueNoise2} with pre-mixed octave seeds. */
export function fbm2Seeds(x: number, z: number, seeds: readonly number[], lacunarity = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < seeds.length; i++) {
    sum += amp * valueNoise2(x * freq, z * freq, seeds[i]);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Deterministic value noise in 3D, smoothed. Used for terrain/biome fields. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const w = zf * zf * zf * (zf * (zf * 6 - 15) + 10);
  const c000 = hash3(xi, yi, zi, seed);
  const c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed);
  const c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed);
  const c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed);
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = c000 + (c100 - c000) * u;
  const x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u;
  const x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x165667b1) >>> 0;
  h = Math.imul(h ^ (z | 0), 0x9e3779b1) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** Fractal Brownian motion over {@link valueNoise3}. */
export function fbm3(x: number, y: number, z: number, seed: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq, mixSeed(seed, i * 1013));
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
