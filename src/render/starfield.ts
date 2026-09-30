/**
 * STARFIELD — Multi-tiered 3D celestial starfield with motion parallax
 * =====================================================================
 *
 * Renders an expansive celestial sphere populated with thousands of stars
 * across distinct parallax depth tiers (deep cosmological background,
 * midground stellar field, and foreground stellar neighborhood).
 *
 * As the camera orbits or translates through space, stars shift at rates
 * proportional to their depth tier, creating true astronomical parallax.
 *
 * Respects the canonical Siege Wall starless absence swath overhead.
 */

import * as THREE from 'three';

const STAR_VERT = /* glsl */ `
precision highp float;

uniform vec3 uCameraPos;
uniform float uParallaxScale;
uniform float uRadius;
uniform float uTime;
uniform float uStarIntensity;

attribute vec3 aColor;
attribute float aSize;
attribute float aBrightness;
attribute float aParallax;
attribute float aTwinkle;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 baseDir = normalize(position);

  // Motion Parallax:
  // Displace the celestial direction inversely to camera displacement from coordinate center.
  // Deep background stars (aParallax = 0.0) stay pinned to infinity as a fixed celestial sphere.
  // Midground and foreground stars shift dynamically, producing depth parallax.
  vec3 parallaxOffset = -(uCameraPos * uParallaxScale * aParallax) / uRadius;
  vec3 apparentDir = normalize(baseDir + parallaxOffset);

  // Position on celestial sphere centered on the camera
  vec3 worldPos = uCameraPos + apparentDir * uRadius;

  vec4 mvPosition = viewMatrix * vec4(worldPos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Multi-frequency twinkling
  float tw = 0.82 + 0.18 * sin(uTime * 2.8 + aTwinkle * 6.28318);

  // Point size with subtle twinkle pulsation
  gl_PointSize = aSize * (0.92 + 0.16 * tw);

  vColor = aColor;
  vAlpha = aBrightness * tw * uStarIntensity;
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float distSq = dot(coord, coord);
  if (distSq > 0.25) discard;

  float dist = sqrt(distSq) * 2.0; // 0.0 at center, 1.0 at rim
  // Dual-layer Gaussian: brilliant stellar core + soft airy diffraction halo
  float core = exp(-dist * dist * 10.0);
  float halo = exp(-dist * 2.8) * 0.32;
  float profile = clamp(core + halo, 0.0, 1.0);

  // Smooth antialiasing at the outer edge
  float antialias = smoothstep(1.0, 0.72, dist);

  vec3 rgb = vColor * (1.0 + core * 0.85);
  float a = vAlpha * profile * antialias;

  gl_FragColor = vec4(rgb, a);
}
`;

export interface StarFieldOptions {
  count?: number;
  radius?: number;
  parallaxScale?: number;
  seed?: number;
}

export class StarField {
  readonly points: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private disposed = false;
  readonly radius: number;

  constructor(options: StarFieldOptions = {}) {
    const count = options.count ?? 4500;
    const radius = options.radius ?? 8000;
    const parallaxScale = options.parallaxScale ?? 1.4;
    const seed = options.seed ?? 0x57415253; // "STARS"
    this.radius = radius;

    this.geometry = this.generateGeometry(count, seed);
    this.material = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uParallaxScale: { value: parallaxScale },
        uRadius: { value: radius },
        uTime: { value: 0 },
        uStarIntensity: { value: 1.0 },
      },
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'celestial-starfield';
    this.points.frustumCulled = false;
    this.points.renderOrder = -999;
  }

  private generateGeometry(count: number, baseSeed: number): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const brightnesses = new Float32Array(count);
    const parallaxes = new Float32Array(count);
    const twinkles = new Float32Array(count);

    // Simple deterministic LCG random generator
    let s = baseSeed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };

    // Stellar spectral classification palettes (O/B, A/F, G, K, M)
    const spectralColors = [
      new THREE.Color(0.72, 0.85, 1.0),  // O/B: Blue-White
      new THREE.Color(0.95, 0.98, 1.0),  // A/F: White
      new THREE.Color(1.0, 0.95, 0.85),   // G: Warm solar
      new THREE.Color(1.0, 0.80, 0.55),   // K: Amber
      new THREE.Color(1.0, 0.55, 0.38),   // M: Red giant
    ];

    let written = 0;
    let attempts = 0;
    const maxAttempts = count * 4;

    while (written < count && attempts < maxAttempts) {
      attempts++;

      // Distribute stars on unit sphere with 35% concentrated in a galactic band
      let uX: number, uY: number, uZ: number;
      if (rnd() < 0.35) {
        // Galactic band (inclined plane)
        const lon = rnd() * Math.PI * 2;
        const lat = (rnd() - 0.5) * 0.35; // concentrated near equator
        const cosLat = Math.cos(lat);
        const gx = cosLat * Math.cos(lon);
        const gy = Math.sin(lat);
        const gz = cosLat * Math.sin(lon);
        // Tilt galactic plane by ~28 degrees around Z axis
        const tilt = 0.48;
        const cosT = Math.cos(tilt);
        const sinT = Math.sin(tilt);
        uX = gx * cosT - gy * sinT;
        uY = gx * sinT + gy * cosT;
        uZ = gz;
      } else {
        // Uniform spherical distribution across all celestial directions
        const u = rnd() * 2 - 1;
        const theta = rnd() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - u * u));
        uX = r * Math.cos(theta);
        uY = u;
        uZ = r * Math.sin(theta);
      }

      // Check canonical Siege Wall starless absence swath
      const swathCoord = uX * 0.78 - uZ * 0.62;
      const swathWarp = Math.sin(uZ * 5.3 + uY * 3.7) * 0.09 + Math.cos(uX * 9.1 - uY * 4.2) * 0.05;
      const distFromWall = Math.abs(swathCoord + swathWarp - 0.22);
      if (distFromWall < 0.14) {
        // Complete starless blackness inside the core of the absence
        continue;
      }
      const absenceFactor = distFromWall < 0.26 ? (distFromWall - 0.14) / 0.12 : 1.0;

      // Parallax assignment across 3 distinct astronomical tiers:
      // - 60% Tier 0: Deep celestial background (parallax = 0.0)
      // - 25% Tier 1: Midground stars (parallax = 0.25..0.45)
      // - 15% Tier 2: Foreground stellar neighborhood (parallax = 0.70..1.0)
      const tierRoll = rnd();
      let parallax = 0.0;
      if (tierRoll > 0.85) {
        parallax = 0.70 + rnd() * 0.30; // Foreground
      } else if (tierRoll > 0.60) {
        parallax = 0.25 + rnd() * 0.20; // Midground
      } else {
        parallax = 0.0;                 // Deep background
      }

      // Spectral type selection
      const typeRoll = rnd();
      let col: THREE.Color;
      if (typeRoll < 0.15) col = spectralColors[0];      // O/B
      else if (typeRoll < 0.60) col = spectralColors[1]; // A/F
      else if (typeRoll < 0.80) col = spectralColors[2]; // G
      else if (typeRoll < 0.92) col = spectralColors[3]; // K
      else col = spectralColors[4];                      // M

      // Magnitude distribution (few bright anchor stars, many faint field stars)
      const magRoll = rnd();
      let size: number;
      let brightness: number;
      if (magRoll > 0.94) {
        // Bright primary anchor star
        size = 5.0 + rnd() * 3.5;
        brightness = (1.4 + rnd() * 0.8) * absenceFactor;
      } else if (magRoll > 0.72) {
        // Mid-tier navigational star
        size = 3.0 + rnd() * 1.8;
        brightness = (0.8 + rnd() * 0.5) * absenceFactor;
      } else {
        // Faint field star / cosmic dust
        size = 1.6 + rnd() * 1.2;
        brightness = (0.35 + rnd() * 0.35) * absenceFactor;
      }

      const idx = written * 3;
      positions[idx] = uX;
      positions[idx + 1] = uY;
      positions[idx + 2] = uZ;

      colors[idx] = col.r;
      colors[idx + 1] = col.g;
      colors[idx + 2] = col.b;

      sizes[written] = size;
      brightnesses[written] = brightness;
      parallaxes[written] = parallax;
      twinkles[written] = rnd();

      written++;
    }

    geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, written * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors.subarray(0, written * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes.subarray(0, written), 1));
    geo.setAttribute('aBrightness', new THREE.BufferAttribute(brightnesses.subarray(0, written), 1));
    geo.setAttribute('aParallax', new THREE.BufferAttribute(parallaxes.subarray(0, written), 1));
    geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkles.subarray(0, written), 1));

    return geo;
  }

  setStarIntensity(intensity: number): void {
    this.material.uniforms.uStarIntensity.value = intensity;
  }

  setParallaxScale(scale: number): void {
    this.material.uniforms.uParallaxScale.value = scale;
  }

  update(time: number, camera: THREE.Camera, starIntensity = 1.0): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uCameraPos.value as THREE.Vector3).copy(camera.position);
    u.uStarIntensity.value = starIntensity;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }
}
