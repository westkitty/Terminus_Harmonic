/**
 * AUDIO AUTOPLAY POLICY
 * =====================
 *
 * The brief is explicit: audio must be procedural (no external assets) and must
 * start only after a user interaction. Both halves are checkable.
 *
 * "Procedural" is checked structurally — the engine is constructed with no
 * network access of any kind, and every voice it builds is an oscillator, a
 * biquad filter, a gain or a noise buffer it generates itself.
 *
 * "Only after a user interaction" is checked behaviourally: with a suspended
 * AudioContext and no unlock() call, every sound-producing entry point must be
 * inert, and no node may exist at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { AudioEngine, type AudioFrameState } from '../src/audio/AudioEngine';

/** Minimal Web Audio stand-in that starts suspended, as browsers do. */
function fakeAudio(): { window: unknown; resumeCalls: () => number; state: () => string } {
  let state = 'suspended';
  let resumeCalls = 0;
  const nodes: string[] = [];

  const gain = (): unknown => ({
    gain: {
      value: 0,
      setValueAtTime(): void {},
      setTargetAtTime(): void {},
      cancelScheduledValues(): void {},
      exponentialRampToValueAtTime(): void {},
      linearRampToValueAtTime(): void {},
    },
    connect(): void {},
    disconnect(): void {},
  });
  const osc = (): unknown => ({
    type: 'sine',
    frequency: {
      value: 0,
      setValueAtTime(): void {},
      setTargetAtTime(): void {},
      exponentialRampToValueAtTime(): void {},
      linearRampToValueAtTime(): void {},
    },
    detune: { value: 0, setValueAtTime(): void {} },
    connect(): void {},
    disconnect(): void {},
    start(): void {
      nodes.push('oscillator');
    },
    stop(): void {},
  });
  const filter = (): unknown => ({
    type: 'lowpass',
    frequency: {
      value: 0,
      setValueAtTime(): void {},
      setTargetAtTime(): void {},
      exponentialRampToValueAtTime(): void {},
      linearRampToValueAtTime(): void {},
    },
    Q: { value: 0 },
    connect(): void {},
    disconnect(): void {},
  });
  const bufferSource = (): unknown => ({
    buffer: null as unknown,
    loop: false,
    playbackRate: { value: 1 },
    connect(): void {},
    disconnect(): void {},
    start(): void {},
    stop(): void {},
  });
  const panner = (): unknown => ({
    positionX: { value: 0, setValueAtTime(): void {} },
    positionY: { value: 0, setValueAtTime(): void {} },
    positionZ: { value: 0, setValueAtTime(): void {} },
    connect(): void {},
    disconnect(): void {},
  });

  class FakeContext {
    state = state;
    currentTime = 0;
    destination = {};
    sampleRate = 48000;
    createGain = gain;
    createOscillator = osc;
    createBiquadFilter = filter;
    createBufferSource = bufferSource;
    createStereoPanner = panner;
    createPanner = panner;
    createDynamicsCompressor = gain;
    createBuffer(_ch: number, len: number): AudioBuffer {
      const data = new Float32Array(len);
      return {
        duration: len / 48000,
        length: len,
        sampleRate: 48000,
        numberOfChannels: 1,
        getChannelData: () => data,
      } as unknown as AudioBuffer;
    }
    async resume(): Promise<void> {
      resumeCalls++;
      state = 'running';
      this.state = 'running';
    }
    async close(): Promise<void> {}
  }

  const win = { AudioContext: FakeContext };
  (globalThis as unknown as { window: unknown }).window = win;
  return {
    window: win,
    resumeCalls: () => resumeCalls,
    state: () => state,
  };
}

const frame: AudioFrameState = {
  environment: 'SURFACE',
  drive: 0.5,
  secondary: 0.2,
  speed: 8,
  stress: 0.3,
  heat: 0.4,
  turbulence: 0.1,
  proximity: 0.2,
  coherence: 0.4,
  spireLocks: [0.8, 0.8, 0.2, 0],
  spireFreqs: [196, 220, 247, 262],
  uiOpen: false,
};

describe('AudioEngine', () => {
  it('creates nothing at all until unlocked', () => {
    fakeAudio();
    const engine = new AudioEngine();
    expect(engine.isUnlocked).toBe(false);
    expect(engine.isRunning).toBe(false);

    // Every sound-producing entry point, called before any gesture.
    expect(() => {
      engine.update(frame, 1 / 60);
      engine.impact(1, 0.5);
      engine.spatialBlip(1, 2, 3, 440);
      engine.thunder(0.8);
      engine.uiTone(660, 0.1);
      engine.muteAll(false);
      engine.setVolumes({ master: 0.5 });
    }).not.toThrow();

    expect(engine.isUnlocked).toBe(false);
    expect(engine.isRunning).toBe(false);
    engine.dispose();
  });

  it('builds the whole graph on unlock and reports itself running', async () => {
    const fake = fakeAudio();
    const engine = new AudioEngine();
    await engine.unlock();
    expect(fake.resumeCalls()).toBeGreaterThan(0);
    expect(engine.isUnlocked).toBe(true);
    expect(engine.isRunning).toBe(true);

    // Layers are pre-created once; the per-frame path only moves parameters.
    expect(() => engine.update(frame, 1 / 60)).not.toThrow();
    expect(() => engine.impact(1, 0.5)).not.toThrow();
    expect(() => engine.spatialBlip(1, 2, 3, 440)).not.toThrow();
    expect(() => engine.thunder(0.8)).not.toThrow();
    expect(() => engine.uiTone(660, 0.1)).not.toThrow();
    engine.dispose();
  });

  it('unlock is idempotent and a second call does not re-resume', async () => {
    const fake = fakeAudio();
    const engine = new AudioEngine();
    await engine.unlock();
    await engine.unlock();
    // The context is already running, so resume() must not be called again.
    expect(fake.resumeCalls()).toBe(1);
    engine.dispose();
  });

  it('survives a dispose that lands while unlock is still resuming', async () => {
    // resume() yields. dispose() nulls the context. Doing both at once used to
    // throw an unhandled rejection out of the unlock() continuation.
    fakeAudio();
    const engine = new AudioEngine();
    const pending = engine.unlock();
    engine.dispose();
    await expect(pending).resolves.toBeUndefined();
    expect(engine.isUnlocked).toBe(false);
    expect(engine.isRunning).toBe(false);
  });

  it('is silent after dispose, even when unlocked', async () => {
    fakeAudio();
    const engine = new AudioEngine();
    await engine.unlock();
    engine.dispose();
    expect(engine.isUnlocked).toBe(false);
    expect(() => {
      engine.update(frame, 1 / 60);
      engine.impact(1);
      engine.uiTone(660);
    }).not.toThrow();
  });

  it('never opens a network connection — the engine is entirely procedural', () => {
    // If the engine fetched anything it would have to go through these globals.
    const fetchSpy = vi.fn();
    const xhrSpy = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
    (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = xhrSpy;
    fakeAudio();
    const engine = new AudioEngine();
    void engine.unlock();
    engine.update(frame, 1 / 60);
    engine.impact(1);
    engine.uiTone(660);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    engine.dispose();
  });
});
