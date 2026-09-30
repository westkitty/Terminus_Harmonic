/**
 * AUDIO — procedural Web Audio soundscape
 * =======================================
 *
 * No external audio assets are used. Every layer is synthesised:
 *
 *  - ORBIT      near-silence + hull vibration + thruster transmission through
 *               structure + docking impacts + cable strain + cabin electronics.
 *               Vacuum does not carry external sound, so there is no "wind in
 *               space" and no cinematic explosion bed.
 *  - ATMOSPHERE wind pressure, turbulence, thunder, structural strain.
 *  - SURFACE    engines, suspension, crushed salt/glass, metal resonance.
 *  - SUBSURFACE drilling, machinery, reflected echoes, rock stress, seismic groan.
 *  - HARMONIC   an evolving low-frequency industrial signature whose structure
 *               changes as acoustic spires synchronise — the Terminus Harmonic.
 *
 * The graph is built once. Per-frame updates only touch AudioParam values, so
 * there is no node churn and no GC pressure.
 *
 * Browser autoplay policy is respected: the context stays suspended until a real
 * user gesture arrives (see {@link AudioEngine.unlock}).
 */

export type AudioEnvironment = 'ORBIT' | 'ATMOSPHERE' | 'SURFACE' | 'SUBSURFACE' | 'MACRO' | 'SILENT';

export interface HarmonicVoice {
  spireId: number;
  freq: number;
  /** 0..1 how locked this voice is to the network reference. */
  lock: number;
  gain: number;
}

const NOISE_SECONDS = 4;

function makeNoiseBuffer(ctx: AudioContext, seconds = NOISE_SECONDS): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Deterministic LCG so the "random" texture is reproducible.
  let s = 0x1234567;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const white = (s / 4294967296) * 2 - 1;
    // Cheap pinking filter (Paul Kellet's economy filter).
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
  }
  return buf;
}

/** One-shot impact thump with a decaying body. */
class ImpactVoice {
  private ctx: AudioContext;
  private out: GainNode;
  private noise: AudioBuffer;
  private osc: OscillatorNode;
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private available = true;

  constructor(ctx: AudioContext, out: GainNode, noise: AudioBuffer) {
    this.ctx = ctx;
    this.out = out;
    this.noise = noise;
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.osc.connect(this.filter);
    this.filter.connect(this.gain);
    this.gain.connect(out);
    this.osc.start();
  }

  get free(): boolean {
    return this.available;
  }

  trigger(intensity: number, brightness: number): void {
    if (!this.available) return;
    this.available = false;
    const t = this.ctx.currentTime;
    const peak = Math.min(1, Math.max(0.02, intensity)) * 0.6;
    this.osc.frequency.setValueAtTime(60 + brightness * 140, t);
    this.osc.frequency.exponentialRampToValueAtTime(28 + brightness * 40, t + 0.35);
    this.filter.frequency.setValueAtTime(400 + brightness * 2600, t);
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(0, t);
    this.gain.gain.linearRampToValueAtTime(peak, t + 0.006);
    this.gain.gain.exponentialRampToValueAtTime(0.0008, t + 0.45);
    // Noise transient for the metallic edge.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.6;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(peak * 0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
    const nf = this.ctx.createBiquadFilter();
    nf.type = 'bandpass';
    nf.frequency.value = 1200 + brightness * 3000;
    nf.Q.value = 1.2;
    src.connect(nf);
    nf.connect(ng);
    ng.connect(this.out);
    src.start(t, Math.random() * 2, 0.3);
    src.stop(t + 0.3);
    src.onended = () => {
      src.disconnect();
      nf.disconnect();
      ng.disconnect();
    };
    setTimeout(() => {
      this.available = true;
    }, 460);
  }

  dispose(): void {
    try {
      this.osc.stop();
    } catch {
      /* already stopped */
    }
    this.osc.disconnect();
    this.filter.disconnect();
    this.gain.disconnect();
  }
}

export interface AudioFrameState {
  environment: AudioEnvironment;
  /** 0..1 primary drive. */
  drive: number;
  /** 0..1 secondary drive (drill spin, thruster bite). */
  secondary: number;
  /** m/s. */
  speed: number;
  /** 0..1 hull/structural stress. */
  stress: number;
  /** 0..1 heat. */
  heat: number;
  /** 0..1 wind/turbulence. */
  turbulence: number;
  /** 0..1 distance-scaled impact intensity hint. */
  proximity: number;
  /** Harmonic network coherence 0..1. */
  coherence: number;
  /** Per-spire lock values for the harmonic signature. */
  spireLocks: number[];
  /** Spire base frequencies. */
  spireFreqs: number[];
  /** UI/menu open — duck everything. */
  uiOpen: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private unlocked = false;
  private disposed = false;

  // Continuous layers -----------------------------------------------------
  private machinerySrc: AudioBufferSourceNode | null = null;
  private machineryGain: GainNode | null = null;
  private machineryFilter: BiquadFilterNode | null = null;
  private machineryLfo: OscillatorNode | null = null;
  private machineryLfoGain: GainNode | null = null;

  private hullSrc: AudioBufferSourceNode | null = null;
  private hullGain: GainNode | null = null;
  private hullFilter: BiquadFilterNode | null = null;

  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windLfo: OscillatorNode | null = null;

  private drillSrc: AudioBufferSourceNode | null = null;
  private drillGain: GainNode | null = null;
  private drillFilter: BiquadFilterNode | null = null;
  private drillOsc: OscillatorNode | null = null;
  private drillOscGain: GainNode | null = null;

  private rumbleOsc: OscillatorNode | null = null;
  private rumbleGain: GainNode | null = null;

  // Harmonic network ------------------------------------------------------
  private harmonicVoices: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode }[] = [];
  private harmonicBus: GainNode | null = null;
  private harmonicReferenceOsc: OscillatorNode | null = null;

  // One-shots -------------------------------------------------------------
  private impacts: ImpactVoice[] = [];
  private lastImpactAt = 0;

  // Volumes ---------------------------------------------------------------
  private volumes = { master: 0.8, sfx: 0.9, ambient: 0.7, music: 0.55 };
  private envMix: Record<AudioEnvironment, number> = {
    ORBIT: 0,
    ATMOSPHERE: 0,
    SURFACE: 0,
    SUBSURFACE: 0,
    MACRO: 0,
    SILENT: 0,
  };

  /** Positional emitters, pooled. */
  private spatialPool: { panner: PannerNode; gain: GainNode; osc: OscillatorNode; busy: boolean }[] = [];

  constructor() {
    // Nothing is created here: the AudioContext must be created lazily so the
    // autoplay policy is respected.
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }
  get isRunning(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Must be called from a user-gesture handler. */
  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.ctx) this.build();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('[Audio] resume failed', err);
        return;
      }
    }
    this.unlocked = this.ctx.state === 'running';
  }

  private build(): void {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.warn('[Audio] Web Audio API unavailable');
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch (err) {
      console.warn('[Audio] context creation failed', err);
      return;
    }
    this.ctx = ctx;
    this.noiseBuffer = makeNoiseBuffer(ctx);

    const master = ctx.createGain();
    master.gain.value = this.volumes.master;
    master.connect(ctx.destination);
    this.master = master;

    const sfx = ctx.createGain();
    sfx.gain.value = this.volumes.sfx;
    sfx.connect(master);
    this.sfxBus = sfx;

    const ambient = ctx.createGain();
    ambient.gain.value = this.volumes.ambient;
    ambient.connect(master);
    this.ambientBus = ambient;

    const music = ctx.createGain();
    music.gain.value = this.volumes.music;
    music.connect(master);
    this.musicBus = music;

    // --- machinery (engines / thruster transmission) ----------------------
    const mSrc = ctx.createBufferSource();
    mSrc.buffer = this.noiseBuffer;
    mSrc.loop = true;
    const mFilter = ctx.createBiquadFilter();
    mFilter.type = 'bandpass';
    mFilter.frequency.value = 220;
    mFilter.Q.value = 1.4;
    const mGain = ctx.createGain();
    mGain.gain.value = 0;
    mSrc.connect(mFilter);
    mFilter.connect(mGain);
    mGain.connect(sfx);
    mSrc.start();
    this.machinerySrc = mSrc;
    this.machineryFilter = mFilter;
    this.machineryGain = mGain;

    // Amplitude wobble so the machinery is not a static hiss.
    const mLfo = ctx.createOscillator();
    mLfo.type = 'sine';
    mLfo.frequency.value = 6.5;
    const mLfoGain = ctx.createGain();
    mLfoGain.gain.value = 0.4;
    mLfo.connect(mLfoGain);
    mLfoGain.connect(mGain.gain);
    mLfo.start();
    this.machineryLfo = mLfo;
    this.machineryLfoGain = mLfoGain;

    // --- hull / structural vibration -------------------------------------
    const hSrc = ctx.createBufferSource();
    hSrc.buffer = this.noiseBuffer;
    hSrc.loop = true;
    hSrc.playbackRate.value = 0.35;
    const hFilter = ctx.createBiquadFilter();
    hFilter.type = 'lowpass';
    hFilter.frequency.value = 140;
    const hGain = ctx.createGain();
    hGain.gain.value = 0;
    hSrc.connect(hFilter);
    hFilter.connect(hGain);
    hGain.connect(sfx);
    hSrc.start();
    this.hullSrc = hSrc;
    this.hullFilter = hFilter;
    this.hullGain = hGain;

    // --- wind / turbulence -------------------------------------------------
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = this.noiseBuffer;
    wSrc.loop = true;
    const wFilter = ctx.createBiquadFilter();
    wFilter.type = 'bandpass';
    wFilter.frequency.value = 480;
    wFilter.Q.value = 0.6;
    const wGain = ctx.createGain();
    wGain.gain.value = 0;
    wSrc.connect(wFilter);
    wFilter.connect(wGain);
    wGain.connect(ambient);
    wSrc.start();
    this.windSrc = wSrc;
    this.windFilter = wFilter;
    this.windGain = wGain;

    const wLfo = ctx.createOscillator();
    wLfo.type = 'sine';
    wLfo.frequency.value = 0.17;
    const wLfoGain = ctx.createGain();
    wLfoGain.gain.value = 260;
    wLfo.connect(wLfoGain);
    wLfoGain.connect(wFilter.frequency);
    wLfo.start();
    this.windLfo = wLfo;

    // --- drill -------------------------------------------------------------
    const dSrc = ctx.createBufferSource();
    dSrc.buffer = this.noiseBuffer;
    dSrc.loop = true;
    dSrc.playbackRate.value = 1.9;
    const dFilter = ctx.createBiquadFilter();
    dFilter.type = 'bandpass';
    dFilter.frequency.value = 1400;
    dFilter.Q.value = 3.5;
    const dGain = ctx.createGain();
    dGain.gain.value = 0;
    dSrc.connect(dFilter);
    dFilter.connect(dGain);
    dGain.connect(sfx);
    dSrc.start();
    this.drillSrc = dSrc;
    this.drillFilter = dFilter;
    this.drillGain = dGain;

    const dOsc = ctx.createOscillator();
    dOsc.type = 'sawtooth';
    dOsc.frequency.value = 62;
    const dOscGain = ctx.createGain();
    dOscGain.gain.value = 0;
    const dOscFilter = ctx.createBiquadFilter();
    dOscFilter.type = 'lowpass';
    dOscFilter.frequency.value = 420;
    dOsc.connect(dOscFilter);
    dOscFilter.connect(dOscGain);
    dOscGain.connect(sfx);
    dOsc.start();
    this.drillOsc = dOsc;
    this.drillOscGain = dOscGain;

    // --- seismic rumble ----------------------------------------------------
    const rOsc = ctx.createOscillator();
    rOsc.type = 'sine';
    rOsc.frequency.value = 31;
    const rGain = ctx.createGain();
    rGain.gain.value = 0;
    rOsc.connect(rGain);
    rGain.connect(sfx);
    rOsc.start();
    this.rumbleOsc = rOsc;
    this.rumbleGain = rGain;

    // --- harmonic network bus ---------------------------------------------
    const hBus = ctx.createGain();
    hBus.gain.value = 0;
    const hShaper = ctx.createBiquadFilter();
    hShaper.type = 'lowpass';
    hShaper.frequency.value = 1200;
    hBus.connect(hShaper);
    hShaper.connect(music);
    this.harmonicBus = hBus;

    const refOsc = ctx.createOscillator();
    refOsc.type = 'sine';
    refOsc.frequency.value = 44;
    const refGain = ctx.createGain();
    refGain.gain.value = 0.05;
    refOsc.connect(refGain);
    refGain.connect(hBus);
    refOsc.start();
    this.harmonicReferenceOsc = refOsc;

    // --- impact voice pool -------------------------------------------------
    for (let i = 0; i < 8; i++) this.impacts.push(new ImpactVoice(ctx, sfx, this.noiseBuffer));

    // --- spatial emitter pool ---------------------------------------------
    for (let i = 0; i < 12; i++) {
      const panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 40;
      panner.maxDistance = 4000;
      panner.rolloffFactor = 1.1;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(panner);
      panner.connect(sfx);
      osc.start();
      this.spatialPool.push({ panner, gain, osc, busy: false });
    }

    // Start in the MACRO mix so the opening resonance is audible immediately.
    this.envMix.MACRO = 1;
  }

  setVolumes(v: Partial<typeof this.volumes>): void {
    Object.assign(this.volumes, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master?.gain.setTargetAtTime(Math.max(0, this.volumes.master), t, 0.05);
    this.sfxBus?.gain.setTargetAtTime(Math.max(0, this.volumes.sfx), t, 0.05);
    this.ambientBus?.gain.setTargetAtTime(Math.max(0, this.volumes.ambient), t, 0.05);
    this.musicBus?.gain.setTargetAtTime(Math.max(0, this.volumes.music), t, 0.05);
  }

  muteAll(muted: boolean): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(muted ? 0 : this.volumes.master, this.ctx.currentTime, 0.05);
  }

  /** One-shot impact. `intensity` 0..1, `brightness` 0..1 (metal vs thud). */
  impact(intensity: number, brightness = 0.4): void {
    if (!this.unlocked) return;
    const now = performance.now();
    if (now - this.lastImpactAt < 25) return;
    this.lastImpactAt = now;
    const v = this.impacts.find((i) => i.free) ?? this.impacts[0];
    v.trigger(intensity, brightness);
  }

  /** Positional blip (beacon, tether latch, sensor release). */
  spatialBlip(x: number, y: number, z: number, freq: number, gainValue = 0.15): void {
    if (!this.unlocked || !this.ctx) return;
    const v = this.spatialPool.find((s) => !s.busy);
    if (!v) return;
    v.busy = true;
    const t = this.ctx.currentTime;
    if (v.panner.positionX) {
      v.panner.positionX.setValueAtTime(x, t);
      v.panner.positionY.setValueAtTime(y, t);
      v.panner.positionZ.setValueAtTime(z, t);
    } else {
      v.panner.setPosition(x, y, z);
    }
    v.osc.frequency.setValueAtTime(freq, t);
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(0, t);
    v.gain.gain.linearRampToValueAtTime(gainValue, t + 0.02);
    v.gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.6);
    setTimeout(() => {
      v.busy = false;
    }, 650);
  }

  /** Ensure the harmonic voice array matches the spire count. */
  private ensureHarmonicVoices(count: number): void {
    if (!this.ctx || !this.harmonicBus) return;
    while (this.harmonicVoices.length < count) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 44;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.harmonicBus);
      osc.start();
      this.harmonicVoices.push({ osc, gain, filter });
    }
  }

  /** Update all continuous layers. Called once per rendered frame. */
  update(state: AudioFrameState, dt: number): void {
    if (!this.ctx || !this.unlocked || this.disposed) return;
    const t = this.ctx.currentTime;
    const tau = 0.08;

    // Cross-fade environment mixes.
    const mixRate = 1.2 * dt;
    for (const env of Object.keys(this.envMix) as AudioEnvironment[]) {
      const target = env === state.environment ? 1 : 0;
      this.envMix[env] += (target - this.envMix[env]) * Math.min(1, mixRate);
    }
    const mOrbit = this.envMix.ORBIT;
    const mAtmo = this.envMix.ATMOSPHERE;
    const mSurf = this.envMix.SURFACE;
    const mSub = this.envMix.SUBSURFACE;
    const mMacro = this.envMix.MACRO;

    const uiDuck = state.uiOpen ? 0.25 : 1;

    // Machinery: engines / thrusters transmitted through structure.
    const machTarget = (mOrbit * 0.35 + mSurf * 0.85 + mSub * 0.6) * state.drive * uiDuck;
    this.machineryGain?.gain.setTargetAtTime(Math.min(0.5, machTarget), t, tau);
    this.machineryFilter?.frequency.setTargetAtTime(
      140 + state.drive * 620 + mSurf * 260 + mSub * 300,
      t,
      tau,
    );
    this.machineryLfo?.frequency.setTargetAtTime(4 + state.drive * 14 + state.stress * 10, t, tau);
    this.machineryLfoGain?.gain.setTargetAtTime(0.25 + state.stress * 0.5, t, tau);

    // Hull: vibration, transmitted impacts, structural strain.
    const hullTarget = (mOrbit * 0.5 + mSurf * 0.32 + mSub * 0.45) * (0.12 + state.stress * 0.8) * uiDuck;
    this.hullGain?.gain.setTargetAtTime(Math.min(0.45, hullTarget), t, tau);
    this.hullFilter?.frequency.setTargetAtTime(90 + state.stress * 260 + state.speed * 0.4, t, tau);

    // Wind: atmospheric pressure only. Never in vacuum.
    const windTarget = mAtmo * (0.12 + state.turbulence * 0.55 + state.speed * 0.004) * uiDuck;
    this.windGain?.gain.setTargetAtTime(Math.min(0.6, windTarget), t, tau);
    this.windFilter?.frequency.setTargetAtTime(300 + state.turbulence * 1500 + state.speed * 1.4, t, tau);
    this.windLfo?.frequency.setTargetAtTime(0.1 + state.turbulence * 1.4, t, tau);

    // Drill: cutter bite + heat.
    const drillTarget = mSub * state.secondary * (0.35 + state.heat * 0.4) * uiDuck;
    this.drillGain?.gain.setTargetAtTime(Math.min(0.5, drillTarget), t, tau);
    this.drillFilter?.frequency.setTargetAtTime(700 + state.secondary * 2600 + state.heat * 900, t, tau);
    this.drillOsc?.frequency.setTargetAtTime(45 + state.secondary * 120, t, tau);
    this.drillOscGain?.gain.setTargetAtTime(Math.min(0.3, mSub * state.secondary * 0.3), t, tau);

    // Seismic / geological groan.
    const rumbleTarget = (mSub * 0.25 + mSurf * 0.06) * (0.1 + state.stress * 0.7) * uiDuck;
    this.rumbleGain?.gain.setTargetAtTime(Math.min(0.4, rumbleTarget), t, tau);
    this.rumbleOsc?.frequency.setTargetAtTime(24 + state.stress * 26, t, tau);

    // --- Terminus Harmonic signature --------------------------------------
    const spireCount = Math.max(state.spireFreqs.length, state.spireLocks.length);
    if (spireCount > 0) {
      this.ensureHarmonicVoices(spireCount);
      let activeSum = 0;
      for (let i = 0; i < spireCount; i++) {
        const v = this.harmonicVoices[i];
        if (!v) continue;
        const lock = state.spireLocks[i] ?? 0;
        const freq = state.spireFreqs[i] ?? 44;
        // Locked voices track the network reference; unlocked ones detune,
        // which is exactly what "out of phase" should sound like.
        const detune = (1 - lock) * (i % 2 === 0 ? 1.011 : 0.987);
        v.osc.frequency.setTargetAtTime(freq * detune, t, tau * 2);
        v.filter.frequency.setTargetAtTime(320 + lock * 1800 + state.coherence * 900, t, tau * 2);
        const amp = (0.035 + lock * 0.11) * (0.35 + state.coherence * 0.65) * uiDuck;
        v.gain.gain.setTargetAtTime(amp, t, tau * 3);
        activeSum += lock;
      }
      const busTarget = (mMacro * 0.9 + mSurf * 0.12 + mSub * 0.16 + mOrbit * 0.05) * (0.3 + state.coherence * 0.7) * uiDuck;
      this.harmonicBus?.gain.setTargetAtTime(Math.min(0.5, busTarget), t, tau * 4);
    }
  }

  /** Environmental thunder / discharge burst. */
  thunder(intensity: number): void {
    if (!this.unlocked || !this.ctx || !this.ambientBus || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.35;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(90, t + 2.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.min(0.7, intensity), t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 2.8);
    src.connect(f);
    f.connect(g);
    g.connect(this.ambientBus);
    src.start(t, Math.random() * 2, 3.2);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  /** Short UI confirmation tone. */
  uiTone(freq = 660, dur = 0.09): void {
    if (!this.unlocked || !this.ctx || !this.sfxBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    osc.connect(g);
    g.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      g.disconnect();
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const i of this.impacts) i.dispose();
    for (const v of this.harmonicVoices) {
      try {
        v.osc.stop();
      } catch {
        /* noop */
      }
      v.osc.disconnect();
      v.filter.disconnect();
      v.gain.disconnect();
    }
    for (const s of this.spatialPool) {
      try {
        s.osc.stop();
      } catch {
        /* noop */
      }
      s.osc.disconnect();
      s.gain.disconnect();
      s.panner.disconnect();
    }
    const srcs: (AudioBufferSourceNode | OscillatorNode | null)[] = [
      this.machinerySrc, this.hullSrc, this.windSrc, this.drillSrc,
      this.machineryLfo, this.windLfo, this.drillOsc, this.rumbleOsc,
      this.harmonicReferenceOsc,
    ];
    for (const s of srcs) {
      if (!s) continue;
      try {
        s.stop();
      } catch {
        /* noop */
      }
      s.disconnect();
    }
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.unlocked = false;
  }
}
