/**
 * COMMAND GLOBE OVERLAY FIELDS
 * =============================
 *
 * The globe's overlay texture is the game's primary diagnostic surface, so it
 * gets two kinds of coverage:
 *
 *  1. Every one of the seven overlays must paint a *real* spatial field — a
 *     flat fill would mean the field code had silently stopped running.
 *  2. The HARMONIC overlay is the only place the Starsilk-derived diagnostic
 *     language appears, and the canon lock is unambiguous: azure/cyan. These
 *     assertions read the actual pixels the renderer would upload.
 *
 * The globe is pure Three.js object construction plus a typed-array paint, so
 * it needs no DOM and no GL context.
 */

import { describe, expect, it } from 'vitest';
import { CommandGlobe, OVERLAY_MODES, type OverlayMode } from '../src/render/globe';
import { PlanetaryState } from '../src/state/planetary';

/** Feed the authoritative state in, then let one frame paint the texture. */
function paint(globe: CommandGlobe, planetary: PlanetaryState, mode: OverlayMode): void {
  globe.setOverlay(mode);
  globe.setPlanetaryState(planetary.snapshot(), 10_000, true);
  globe.update(1 / 60);
}

function channelMeans(globe: CommandGlobe): { r: number; g: number; b: number } {
  const px = globe.overlayPixels;
  let r = 0, g = 0, b = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i];
    g += px[i + 1];
    b += px[i + 2];
  }
  return { r: r / n, g: g / n, b: b / n };
}

describe('CommandGlobe overlays', () => {
  it('exposes exactly the six commanded overlays plus the harmonic network', () => {
    // The brief calls for six selectable overlays; the Terminus Harmonic is the
    // seventh and is the payoff surface, not a sixth map mode.
    expect(OVERLAY_MODES.length).toBe(7);
    expect(OVERLAY_MODES).toContain('HARMONIC');
  });

  it('paints a real spatial field for every overlay mode', () => {
    const globe = new CommandGlobe(0xc0ffee, 100);
    const planetary = new PlanetaryState(0xc0ffee);
    for (const mode of OVERLAY_MODES) {
      paint(globe, planetary, mode);
      const px = globe.overlayPixels;
      let min = 255, max = 0;
      for (let i = 0; i < px.length; i += 4) {
        const v = px[i + 2];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      // A flat fill would have max === min. Every overlay is a field.
      expect(max - min, `${mode} painted a flat texture`).toBeGreaterThan(20);
    }
    globe.dispose();
  });

  it('keeps the upsampled field continuous — no blocky quarter-resolution steps', () => {
    const globe = new CommandGlobe(0xc0ffee, 100);
    const planetary = new PlanetaryState(0xc0ffee);
    paint(globe, planetary, 'GEOLOGY');
    const px = globe.overlayPixels;
    // Compare a texel to its neighbour two rows down: a broken upsample shows
    // up as a hard discontinuity every fourth row.
    let worst = 0;
    for (let y = 0; y < 512 - 2; y += 7) {
      for (let x = 0; x < 1024; x += 13) {
        const a = (y * 1024 + x) * 4;
        const b = ((y + 2) * 1024 + x) * 4;
        worst = Math.max(worst, Math.abs(px[a] - px[b]), Math.abs(px[a + 1] - px[b + 1]));
      }
    }
    expect(worst).toBeLessThan(90);
    globe.dispose();
  });

  it('renders the harmonic overlay in the azure Starsilk diagnostic language', () => {
    const globe = new CommandGlobe(0xc0ffee, 100);
    const planetary = new PlanetaryState(0xc0ffee);

    // A coherent network reads azure; a drifting one reads as seismic
    // resonance and must not. Both halves of that are canon-relevant.
    planetary.vars.harmonicCoherence = 0.2;
    paint(globe, planetary, 'HARMONIC');
    const incoherent = channelMeans(globe);

    planetary.vars.harmonicCoherence = 0.95;
    paint(globe, planetary, 'HARMONIC');
    const coherent = channelMeans(globe);

    // Azure: blue dominant, green well above red. This is the canon lock.
    expect(coherent.b).toBeGreaterThan(coherent.r);
    expect(coherent.b).toBeGreaterThan(coherent.g);
    expect(coherent.g).toBeGreaterThan(coherent.r);
    // ...and the incoherent network is not painted in the same language.
    expect(incoherent.r).toBeGreaterThan(incoherent.b);

    // The other overlays must not borrow that language by accident.
    for (const mode of OVERLAY_MODES) {
      if (mode === 'HARMONIC') continue;
      paint(globe, planetary, mode);
      const m = channelMeans(globe);
      expect(m.b, `${mode} is not azure-dominant`).toBeLessThan(Math.max(m.r, m.g));
    }
    globe.dispose();
  });

  it('responds to the planetary state, not just to the seed', () => {
    const globe = new CommandGlobe(0xc0ffee, 100);
    const planetary = new PlanetaryState(0xc0ffee);
    paint(globe, planetary, 'ATMOSPHERE');
    const before = Uint8Array.from(globe.overlayPixels);

    // A real intervention: poison the atmosphere through the public effect API.
    planetary.applyEffect({
      label: 'test toxicity spike',
      immediate: { atmosphereToxicity: 0.8 },
      origin: 'test',
    });
    paint(globe, planetary, 'ATMOSPHERE');

    let changed = 0;
    for (let i = 0; i < before.length; i += 4) if (before[i] !== globe.overlayPixels[i]) changed++;
    expect(changed).toBeGreaterThan(1000);
    globe.dispose();
  });
});
