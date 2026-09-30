/**
 * GAME — top-level orchestration
 * ==============================
 *
 * Owns the renderer, the ECS world, the three scale scenes, the four vehicles,
 * the audio engine, persistence and the UI. Nothing here is a render loop of its
 * own: there is exactly one `requestAnimationFrame` loop and exactly one place
 * that steps the world.
 *
 * Lifecycle:
 *   BOOT -> MACRO (Command Lattice) -> DESCEND -> ORBIT | SECTOR -> ASCEND -> MACRO
 */

import * as THREE from 'three';
import { World } from '../core/ecs';
import { EventBus, Events } from '../core/events';
import { InputManager, DEFAULT_BINDINGS, type ActionName, type KeyBinding } from '../core/input';
import { PerformanceMonitor, type QualitySettings } from '../core/perf';
import { clamp01, damp, DEG2RAD, latLonToVec3 } from '../core/math';
import { prefersHighContrast, prefersReducedMotion, watchPreference } from '../core/media';
import { PlanetaryState } from '../state/planetary';
import {
  ACOUSTIC_SPIRES,
  BIOME_LABEL,
  CRISIS_NODES,
  DOMAINS,
  SETTLEMENTS,
  WORLD_SEED,
  type BiomeId,
  type CrisisId,
  type Domain,
  type VehicleKind,
} from '../state/world';
import {
  SCHEMA_VERSION,
  SaveStore,
  computeChecksum,
  defaultSettings,
  newSave,
  type SaveData,
  type SettingsRecord,
  type SpireRecord,
} from '../state/save';
import { CrisisController, type CompletionReport } from './crisis';
import { ScaleManager, type Scale } from './scale';
import { CommandGlobe, OVERLAY_MODES, type OverlayMode } from '../render/globe';
import { SkyDome } from '../render/sky';
import { OrbitalLayer } from '../render/orbitalLayer';
import { SectorEnvironment, hazardForBiome, localAtmosphereDensity } from '../render/environment';
import { SectorField, TunnelLattice } from '../sector/field';
import { TerrainRenderer } from '../sector/terrain';
import { OrbitalSkiff } from '../vehicle/orbital';
import { LandTrain } from '../vehicle/landtrain';
import { StrataCrawler } from '../vehicle/crawler';
import { AtmosphericGlider } from '../vehicle/glider';
import type { VehicleBase, VehicleEnvironment } from '../vehicle/base';
import { AudioEngine } from '../audio/AudioEngine';
import { UIController, type BriefingData } from '../ui/ui';
import {
  AudioSystem,
  CameraSystem,
  GlobalStateSystem,
  HarmonicSystem,
  LogisticsSystem,
  PerformanceSystem,
  SaveSystem,
  type SettlementRuntime,
  TerrainStreamingSystem,
  UISystem,
  VehiclePossessionSystem,
  WeatherSystem,
} from '../systems/systems';

const BOOT_LINES = [
  'remnant survey 0-ark · post-war orbital link established',
  'command lattice … waking',
  'planetary telemetry … degraded but readable',
  'atmospheric processors … 3 of 11 responding',
  'acoustic spire network … dormant',
  'one crisis node is selectable',
];

export class Game {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private world = new World();
  private bus = new EventBus();
  private input: InputManager;
  private perf: PerformanceMonitor;
  private audio = new AudioEngine();
  private ui: UIController;
  private scale: ScaleManager;

  private planetary: PlanetaryState;
  private crises = new CrisisController(CRISIS_NODES);
  private settlements: SettlementRuntime[];
  private spires: SpireRecord[];
  private weather: WeatherSystem;
  private harmonic: HarmonicSystem;
  private logistics: LogisticsSystem;

  private globe: CommandGlobe;
  private skyMacro: SkyDome;
  private skyOrbit: SkyDome;
  private skySector: SkyDome;
  private orbitalLayer: OrbitalLayer;

  // --- sector runtime (one at a time) ---
  private sectorField: SectorField | null = null;
  private sectorTerrain: TerrainRenderer | null = null;
  private sectorEnv: SectorEnvironment | null = null;
  private sectorLattice: TunnelLattice | null = null;
  private activeVehicle: VehicleBase | null = null;
  private activeCrisisId: CrisisId | null = null;

  // --- vehicles (pooled, reused across descents) ---
  private vehicles = new Map<VehicleKind, VehicleBase>();

  private quality: QualitySettings;
  private settings: SettingsRecord;
  private save: SaveData;
  private started = false;
  private disposed = false;
  private rafId = 0;
  private lastFrameTime = 0;
  private playStart = 0;
  private shakeAmount = 0;

  // Scratch
  private _v1 = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _v3 = new THREE.Vector3();
  private _camPos = new THREE.Vector3();
  private _camLook = new THREE.Vector3();
  private _sunDir = new THREE.Vector3(0.55, 0.42, 0.72).normalize();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setClearColor(0x05060a, 1);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.perf = new PerformanceMonitor();
    this.quality = this.perf.settings;
    this.settings = defaultSettings();
    this.settings.qualityTier = this.perf.currentTier;
    this.settings.adaptiveQuality = true;
    // Seed the accessibility settings from the OS rather than from a hard-coded
    // default. A restored save or an explicit toggle still overrides this.
    this.settings.reducedMotion = prefersReducedMotion();
    this.settings.screenShake = !prefersReducedMotion();
    this.settings.highContrast = prefersHighContrast();

    this.planetary = new PlanetaryState(WORLD_SEED);
    this.settlements = SETTLEMENTS.map((s) => ({
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      viability: s.viability,
      populationK: s.populationK,
    }));
    this.spires = ACOUSTIC_SPIRES.map((s) => ({
      id: s.id,
      functional: s.id < 2,
      phase: (s.id * 37) % 360,
      repairs: s.id < 2 ? 2 : 0,
      seated: true,
    }));

    this.weather = new WeatherSystem(this.planetary, WORLD_SEED);
    this.logistics = new LogisticsSystem(this.planetary, this.settlements);
    this.harmonic = new HarmonicSystem(this.planetary, this.spires);

    this.globe = new CommandGlobe(WORLD_SEED, 100, 'ATMOSPHERE');
    this.skyMacro = new SkyDome(40000);
    this.skyOrbit = new SkyDome(2.4e7);
    this.skySector = new SkyDome(9000);
    this.orbitalLayer = new OrbitalLayer(WORLD_SEED);

    this.scale = new ScaleManager(this.renderer, this.settings.reducedMotion);
    // Wired here rather than in start(): a scale change is a simulation event,
    // not an input event, and must be handled whether or not the rAF loop runs.
    this.scale.onScaleChanged = (next) => this.onScaleChanged(next);
    this.scale.scenes.MACRO.add(this.globe.group, this.skyMacro.mesh);
    this.scale.scenes.ORBIT.add(this.orbitalLayer.group, this.skyOrbit.mesh);
    // SECTOR scene is populated on descent.

    this.input = new InputManager(canvas, DEFAULT_BINDINGS);
    this.save = newSave(WORLD_SEED, this.planetary.snapshot());

    this.ui = new UIController({
      bus: this.bus,
      planetary: this.planetary,
      settings: this.settings,
      onOverlayChange: (m) => this.globe.setOverlay(m),
      onSelectNode: (id) => this.selectNode(id),
      onStartCrisis: (id) => this.startCrisis(id as CrisisId),
      onAscend: () => this.ascend(),
      onSettingsChange: (patch) => this.applySettings(patch),
      onRebind: (action, code) => this.rebind(action, code),
      onResetBindings: () => this.resetBindings(),
      onSave: () => this.saveSystem.requestManualSave(),
      onLoad: () => void this.loadGame(),
      onExport: () => this.exportSave(),
      onImport: (text) => this.importSave(text),
      onNewWorld: () => this.newWorld(),
      onCycleCamera: () => this.cycleCamera(),
      onPingSpire: (spireId) => this.pingSpire(spireId),
      onSelectSettlement: (id) => this.selectSettlement(id),
    });
    this.ui.touchMove = (x, y) => this.input.setTouchAxis(x, 0, -y);
    this.ui.touchLook = (dx, dy) => this.input.addTouchLook(dx, dy);
    this.ui.touchButton = (action, down) => {
      this.input.setTouchButton(action, down);
      if (down && action === 'ascendMacro') this.ascend();
      if (down && action === 'cameraCycle') this.cycleCamera();
    };

    this.bindCrisisHandler();
    this.bindGlobePointer();
    this.bindShortcutKeys();
    this.registerSystems();
    this.ui.applySettings(this.settings);
    this.watchPreferences();
    this.ui.startBootSequence(BOOT_LINES);
    this.crises.refreshAvailability(this.functionalSpireCount());
    this.ui.setCrises(this.crises.all(), null);
    this.ui.setOverlay('ATMOSPHERE');
    this.globe.setOverlay('ATMOSPHERE');
    this.harmonic.setUnlockedModules(this.save.campaign.unlockedModules);
    this.syncCodexData();
  }

  /**
   * If the user flips the OS motion or contrast preference while playing, adopt
   * it immediately rather than waiting for a reload.
   */
  private watchPreferences(): void {
    this.prefDisposers.push(
      watchPreference('(prefers-reduced-motion: reduce)', (on) => {
        this.applySettings({ reducedMotion: on, screenShake: !on });
      }),
      watchPreference('(prefers-contrast: more)', (on) => {
        this.applySettings({ highContrast: on });
      }),
    );
  }

  // -- systems --------------------------------------------------------------

  private saveSystem!: SaveSystem;
  private globalStateSystem!: GlobalStateSystem;
  private possessionSystem!: VehiclePossessionSystem;
  private uiSystem!: UISystem;

  private bindCrisisHandler(): void {
    this.crises.setCompletionHandler((r) => {
      // Partial slices (0 < completion < 1) and the pre-resolve undo slice
      // (completion === 0) adjust the planetary baseline incrementally.
      if (r.completion < 1) {
        this.planetary.raiseBaseline(r.applied, 1);
      }
      if (r.completion > 0) {
        this.bus.emit(Events.CrisisProgress, {
          id: r.crisisId,
          name: r.name,
          completion: r.completion,
        });
      }
    });
  }

  private registerSystems(): void {
    this.possessionSystem = new VehiclePossessionSystem(
      this.bus,
      this.input,
      () => this.cycleCamera(),
      () => this.scale.scale,
      (v) => this.tickContinuousObjectives(v),
    );
    this.globalStateSystem = new GlobalStateSystem(this.planetary);
    this.world.addSystem(this.globalStateSystem);
    this.world.addSystem(this.weather);
    this.world.addSystem(this.logistics);
    this.world.addSystem(this.harmonic);
    this.world.addSystem(
      new TerrainStreamingSystem(
        () => this.sectorTerrain,
        () => this.playerPosition,
        () => this.quality,
      ),
    );
    this.world.addSystem(this.possessionSystem);
    this.world.addSystem(new CameraSystem([]));
    this.world.addSystem(
      new AudioSystem(
        this.audio,
        () => this.activeVehicle,
        () => this.scale.scale,
        () => this.harmonic.coherence,
        () => this.harmonic.locks,
        () => ACOUSTIC_SPIRES.map((s) => s.baseFreq),
        () => this.ui.isBriefingOpen || this.ui.isSettingsOpen || this.ui.isCodexOpen,
        () => undefined,
        () => undefined,
      ),
    );
    this.world.addSystem(
      new PerformanceSystem(
        this.perf,
        this.renderer,
        () => this.world.tagged('vehicle').size + this.world.tagged('debris').size,
        () => (this.sectorTerrain ? this.sectorTerrain.drawCalls : 0),
        () => 0,
        (q) => this.applyQuality(q),
      ),
    );
    this.saveSystem = new SaveSystem();
    this.saveSystem.setSaveHandler((manual) => void this.saveGame(manual));
    this.world.addSystem(this.saveSystem);
    this.uiSystem = new UISystem(
      this.ui,
      this.planetary,
      () => this.scale.scale,
      () => this.activeVehicle,
      () => this.crises.all(),
      () => ({
        coherence: this.harmonic.coherence,
        harmonicUnlocked: this.harmonicUnlocked,
        spireCoverage: this.harmonic.coverage,
        phaseOrder: this.harmonic.phaseOrder,
        functional: this.functionalSpireCount(),
        total: this.spires.length,
        unlocked: this.harmonicUnlocked,
      }),
      () => this.crises.objectiveLines(),
      () => this.selectedNodeId,
    );
    this.world.addSystem(this.uiSystem);
  }

  // -- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.resize();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);

    // Audio must be unlocked by a user gesture.
    const unlock = (): void => {
      void this.audio.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.ui.onEnter(() => {
      void this.audio.unlock();
      this.audio.setVolumes({
        master: this.settings.masterVolume,
        sfx: this.settings.sfxVolume,
        ambient: this.settings.ambientVolume,
        music: this.settings.musicVolume,
      });
      this.beginCampaign();
    });

    this.bus.on(Events.DescendRequested, () => this.onDescendRequested());
    this.bus.on(Events.AscendRequested, () => this.onAscendRequested());

    this.registerServiceWorker();
    this.lastFrameTime = performance.now();
    this.playStart = this.lastFrameTime;
    this.rafId = requestAnimationFrame(this.loop);
  }

  private registerServiceWorker(): void {
    if (!('serviceWorker' in navigator)) return;
    // Only register for http(s) origins; file:// and dev without SW support skip.
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    window.addEventListener('load', () => {
      const url = new URL('sw.js', document.baseURI).href;
      navigator.serviceWorker.register(url, { scope: './' })
        .then((reg) => this.precacheBundles(reg))
        .catch((err) => {
          console.info('[PWA] service worker not registered:', err?.message ?? err);
        });
    });
  }

  /**
   * Hand the worker the hashed bundles this page just loaded. Their names change
   * every build, so they cannot be precached statically — and until they are
   * cached, the first visit is not offline-capable.
   */
  private precacheBundles(reg: ServiceWorkerRegistration): void {
    const urls = new Set<string>();
    for (const tag of ['script[src]', 'link[rel="stylesheet"][href]', 'link[rel="modulepreload"][href]']) {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(tag))) {
        const raw = el.getAttribute('src') ?? el.getAttribute('href');
        if (!raw) continue;
        try {
          const u = new URL(raw, document.baseURI);
          if (u.origin === location.origin) urls.add(u.pathname);
        } catch {
          /* ignore malformed URLs */
        }
      }
    }
    if (urls.size === 0) return;
    const send = (worker: ServiceWorker | null): void => {
      worker?.postMessage({ type: 'cache-assets', urls: [...urls] });
    };
    // On a first visit the worker is still installing, so wait for it to take
    // control rather than dropping the message on the floor.
    if (reg.active) send(reg.active);
    else void navigator.serviceWorker.ready.then((r) => send(r.active));
  }

  beginCampaign(): void {
    this.ui.dismissBoot();
    this.scale.setScale('MACRO');
    this.ui.setMode('MACRO');
    this.bus.emit(Events.Toast, { message: 'Command Lattice online. Select a crisis node.', kind: '' });
    // First-minute experience: the globe resolves, overlays wake, one node pulses.
    this.globe.setOverlayVisible(true);
    this.logEvent('Command Lattice link established (Survey 0-ARK)');
  }

  private logEvent(msg: string): void {
    this.save.log.push({
      t: Date.now(),
      text: `[t+${this.planetary.simTime.toFixed(0)}s] ${msg}`,
    });
    if (this.save.log.length > 200) {
      this.save.log = this.save.log.slice(-200);
    }
    this.syncCodexData();
  }

  private syncCodexData(): void {
    this.ui.setCodexData({
      domainPoints: this.save.campaign.domainPoints,
      unlockedModules: this.save.campaign.unlockedModules,
      log: this.save.log,
    });
  }

  // -- main loop ------------------------------------------------------------

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    const rawDt = (now - this.lastFrameTime) / 1000;
    this.lastFrameTime = now;
    const dt = Math.min(0.1, Math.max(0.0005, rawDt));
    this.update(dt, now);
  };

  /**
   * Advance exactly one frame. Split out of the rAF callback so the whole game
   * can be driven deterministically by tests and by the debug handle.
   */
  update(dt: number, now = performance.now()): void {
    if (this.disposed) return;

    this.perf.beginFrame(now);
    const cpuStart = performance.now();

    this.input.beginFrame();

    // Global keyboard handling that is not vehicle-specific.
    this.handleGlobalInput();

    // Simulation.
    this.world.update(dt);

    // The Terminus Harmonic is the campaign's payoff: the network establishes
    // itself once enough of it is live and what is live agrees on phase.
    this.checkHarmonicEstablished();

    // Scale-specific updates.
    this.updateScale(dt, now);

    // Render.
    this.scale.render(dt, now / 1000);

    // Metrics.
    this.perf.cpuMs = performance.now() - cpuStart;
    this.ui.setPerf(this.perf.metrics());
    this.perf.endFrame(now);
    this.input.endFrame();
  };

  private handleGlobalInput(): void {
    if (this.ui.isSettingsOpen || this.ui.isBriefingOpen || this.ui.isCodexOpen) {
      this.input.setEnabled(false);
      if (this.input.pressed('pause')) {
        if (this.ui.isSettingsOpen) this.ui.closeSettings();
        if (this.ui.isBriefingOpen) this.ui.closeBriefing();
        if (this.ui.isCodexOpen) this.ui.closeCodex();
      }
      return;
    }
    this.input.setEnabled(true);

    if (this.input.pressed('pause')) {
      this.ui.openSettings();
      return;
    }
    if (this.input.pressed('map')) {
      if (this.scale.scale !== 'MACRO') this.ascend();
      return;
    }
    if (this.input.pressed('overlayNext') && this.scale.scale === 'MACRO') {
      const modes: OverlayMode[] = ['TOPOGRAPHY', 'ATMOSPHERE', 'GEOLOGY', 'BIOSPHERE', 'ORBIT', 'LOGISTICS', 'HARMONIC'];
      const i = modes.indexOf(this.globe.getOverlay());
      this.ui.setOverlay(modes[(i + 1) % modes.length]);
    }
    if (this.scale.scale === 'MACRO') {
      const p = this.input.consumePointer();
      if (Math.abs(p.dx) + Math.abs(p.dy) > 0) this.scale.orbitMacro(p.dx, p.dy, 1 / 60);
      const wheel = this.input.consumeWheel();
      if (wheel !== 0) this.scale.zoomMacro(wheel);
      // Drag-to-orbit without pointer lock.
      if (this.input.isKeyDown('Mouse0') && !this.input.isPointerLocked) {
        // handled by pointer consumption above
      }
    } else {
      this.input.consumePointer();
      this.input.consumeWheel();
    }
  }

  private markerStatusMap: Record<string, 'LOCKED' | 'AVAILABLE' | 'ACTIVE' | 'RESOLVED'> = {};
  private markerProgressMap: Record<string, number> = {};
  private spireFunctionalFlags: boolean[] = [];
  private lastMacroUiTime = -Infinity;
  private lastScopeSpireId = -1;

  private updateScale(dt: number, now: number): void {
    const s = this.scale.scale;
    if (s === 'MACRO') {
      this.scale.updateMacroCamera(dt);
      this.globe.setPlanetaryState(
        {
          vars: this.planetary.vars,
          baselines: this.planetary.baselines,
          tick: this.planetary.tick,
          simTime: this.planetary.simTime,
        },
        now,
        false,
      );
      this.globe.update(dt);
      const crises = this.crises.all();
      for (let i = 0; i < crises.length; i++) {
        const c = crises[i];
        this.markerStatusMap[c.def.id] = c.status;
        this.markerProgressMap[c.def.id] = this.crisisProgress(c);
      }
      this.spireFunctionalFlags.length = this.spires.length;
      for (let i = 0; i < this.spires.length; i++) {
        this.spireFunctionalFlags[i] = this.spires[i].functional;
      }
      this.globe.updateMarkers(
        now,
        dt,
        this.markerStatusMap,
        this.markerProgressMap,
        this.spireFunctionalFlags,
        this.harmonic.phases,
      );
      this.skyMacro.setSun(this._sunDir);
      this.skyMacro.setEnvironment(0.85, this.planetary.vars.atmosphereToxicity, 1.0);
      this.skyMacro.follow(this.scale.cameras.MACRO);
      this.globe.setSunDirection(this._sunDir);
      this.globe.setAtmosphereToxicity(this.planetary.vars.atmosphereToxicity);
      if (now - this.lastMacroUiTime >= 66 || this.selectedSpireId !== this.lastScopeSpireId) {
        this.lastMacroUiTime = now;
        this.lastScopeSpireId = this.selectedSpireId;
        this.ui.updateHarmonicScope(
          this.spires,
          this.harmonic.phases,
          this.harmonic.locks,
          this.harmonic.refPhase,
          this.harmonic.coverage,
          this.harmonic.phaseOrder,
          this.selectedSpireId,
        );
        this.ui.updateLedger(this.settlements, this.save.campaign.unlockedModules);
      }
      this.updateMacroReticle();
      return;
    }

    this.ui.updateGlobeReticle(null);

    if (s === 'ORBIT') {
      this.scale.updateSectorCamera(dt);
      this.orbitalLayer.update(now / 1000);
      this.orbitalLayer.setSunDirection(this._sunDir);
      this.orbitalLayer.setToxicity(this.planetary.vars.atmosphereToxicity);
      this.skyOrbit.setSun(this._sunDir);
      this.skyOrbit.setEnvironment(0.05, 0.05, 1.15);
      this.skyOrbit.follow(this.scale.cameras.ORBIT);
      this.updateVehicleCamera();
      if (this.activeVehicle) {
        this.ui.setVehicleTelemetry(this.activeVehicle.cameraMode, this.activeVehicle.controls);
      }
      return;
    }

    if (s === 'SECTOR') {
      this.scale.updateSectorCamera(dt);
      this.sectorEnv?.update(dt, now / 1000, this.scale.cameras.SECTOR);
      this.skySector.setSun(this._sectorSunDir);
      const density = this.sectorField
        ? localAtmosphereDensity(this.sectorField.params.biome, this.planetary.vars.atmosphereToxicity)
        : 0.8;
      this.skySector.setEnvironment(density, this.planetary.vars.atmosphereToxicity, 0.95);
      this.skySector.follow(this.scale.cameras.SECTOR);
      this.updateVehicleCamera();
      if (this.activeVehicle) {
        this.ui.setVehicleTelemetry(this.activeVehicle.cameraMode, this.activeVehicle.controls);
      }
      this.applyShake(dt);
      return;
    }

    // Transitioning: keep both cameras coherent.
    this.scale.updateMacroCamera(dt);
    this.scale.updateSectorCamera(dt);
  }

  private _sectorSunDir = new THREE.Vector3();

  /** Sector-local position of the possessed machine, for terrain streaming. */
  private readonly playerPosition = new THREE.Vector3();

  private updateVehicleCamera(): void {
    const v = this.activeVehicle;
    if (!v) return;
    v.getCameraTarget({ position: this._camPos, lookAt: this._camLook });
    this.scale.setSectorCameraTarget(this._camPos, this._camLook);
    const wp = v.worldPosition;
    this.playerPosition.set(wp.x, 0, wp.z);
  }

  private applyShake(dt: number): void {
    if (!this.settings.screenShake || this.settings.reducedMotion) {
      this.shakeAmount = damp(this.shakeAmount, 0, 6, dt);
      return;
    }
    const v = this.activeVehicle;
    const target = v ? clamp01(v.stress) * 0.5 : 0;
    this.shakeAmount = damp(this.shakeAmount, target, 4, dt);
    if (this.shakeAmount < 0.01) return;
    const cam = this.scale.cameras.SECTOR;
    const k = this.shakeAmount * 0.35;
    cam.position.x += (Math.random() - 0.5) * k;
    cam.position.y += (Math.random() - 0.5) * k;
    cam.position.z += (Math.random() - 0.5) * k;
  }

  // -- globe picking & reticle ---------------------------------------------

  private pointerDownPos: { x: number; y: number; t: number } | null = null;
  private hoveredNodeId: string | null = null;
  private hoveredSpireId: number | null = null;
  private hoveredSettlementId: string | null = null;
  private selectedSpireId = 0;
  private selectedSettlementId: string | null = null;
  private globePointerCleanup: (() => void) | null = null;
  private shortcutKeyCleanup: (() => void) | null = null;

  private bindShortcutKeys(): void {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (this.ui.pendingRebind) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.code === 'KeyC' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.ui.isCodexOpen) this.ui.closeCodex();
        else this.ui.openCodex();
        return;
      }
      if (
        this.scale.scale === 'MACRO' &&
        !this.ui.isBriefingOpen &&
        !this.ui.isSettingsOpen &&
        !this.ui.isCodexOpen
      ) {
        const digitMatch = /^Digit([1-7])$/.exec(e.code);
        if (digitMatch) {
          const idx = Number(digitMatch[1]) - 1;
          const mode = OVERLAY_MODES[idx];
          if (mode) this.ui.setOverlay(mode);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    this.shortcutKeyCleanup = () => window.removeEventListener('keydown', onKeyDown);
  }

  private bindGlobePointer(): void {
    const canvas = this.canvas;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    const castAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { nodeId: null, spireId: null, settlementId: null };
      }
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(ndc, this.scale.cameras.MACRO);
      return this.globe.pick(ray);
    };

    const onDown = (e: PointerEvent): void => {
      if (this.scale.scale !== 'MACRO') return;
      this.pointerDownPos = { x: e.clientX, y: e.clientY, t: performance.now() };
    };

    const onMove = (e: PointerEvent): void => {
      if (this.scale.scale !== 'MACRO') return;
      const hit = castAt(e.clientX, e.clientY);
      this.hoveredNodeId = hit.nodeId;
      this.hoveredSpireId = hit.spireId;
      this.hoveredSettlementId = hit.settlementId;
      this.globe.hoveredNode = hit.nodeId;
    };

    const onUp = (e: PointerEvent): void => {
      const d = this.pointerDownPos;
      this.pointerDownPos = null;
      if (!d || this.scale.scale !== 'MACRO') return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
      if (performance.now() - d.t > 600) return;
      const hit = castAt(e.clientX, e.clientY);
      if (hit.nodeId) {
        this.selectNode(hit.nodeId);
      } else if (hit.spireId !== null) {
        this.pingSpire(hit.spireId);
      } else if (hit.settlementId) {
        this.selectSettlement(hit.settlementId);
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    this.globePointerCleanup = () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
    };
  }

  /** Focus the Command Lattice camera and reticle on a survivor settlement. */
  selectSettlement(settlementId: string): void {
    const st = this.settlements.find((s) => s.id === settlementId);
    const def = SETTLEMENTS.find((s) => s.id === settlementId);
    if (!st || !def) return;
    this.selectedSettlementId = settlementId;
    this.selectedNodeId = null;
    this.ui.setSelectedNode(null);
    this.ui.selectSettlement(settlementId);
    this.scale.focusNode(st.lat, st.lon, 100);
    this.audio.uiTone(460, 0.08);
    this.bus.emit(Events.Toast, {
      message: `${st.name} · ${Math.round(st.viability * 100)}% viability · ${st.populationK}k survivors (${BIOME_LABEL[def.biome]})`,
      kind: '',
    });
  }

  /** Ping and phase-nudge an acoustic spire from the Command Lattice. */
  pingSpire(spireId: number): void {
    const sp = this.spires.find((s) => s.id === spireId);
    const def = ACOUSTIC_SPIRES[spireId];
    if (!sp || !def) return;
    this.selectedSpireId = spireId;
    this.ui.selectSpire(spireId);
    this.scale.focusNode(def.lat, def.lon, 100);
    this.audio.uiTone(def.baseFreq * 4, 0.16);
    if (sp.functional) {
      this.harmonic.lockSpire(spireId, 1);
      this.bus.emit(Events.Toast, {
        message: `${def.name} phase-pulsed (${def.baseFreq} Hz · reference aligned)`,
        kind: 'good',
      });
    } else {
      this.bus.emit(Events.Toast, {
        message: `${def.name} dormant (${def.foundation}) — resolve a sector crisis to restore.`,
        kind: '',
      });
    }
  }

  private updateMacroReticle(): void {
    const w = this.canvas.clientWidth || window.innerWidth || 1280;
    const h = this.canvas.clientHeight || window.innerHeight || 720;
    const nodeId = this.hoveredNodeId ?? this.selectedNodeId;
    if (nodeId) {
      const rt = this.crises.get(nodeId as CrisisId);
      if (rt && this.globe.projectNode(nodeId, this.scale.cameras.MACRO, this._v1)) {
        const x = (this._v1.x * 0.5 + 0.5) * w;
        const y = (-this._v1.y * 0.5 + 0.5) * h;
        this.ui.updateGlobeReticle({
          visible: true,
          x,
          y,
          kind: 'node',
          title: rt.def.name,
          tag: rt.status,
          sub: `${rt.def.lat.toFixed(0)}° / ${rt.def.lon.toFixed(0)}° · ${rt.def.headline}`,
          actionLabel: rt.status === 'LOCKED' ? 'Inspect Lock' : 'Open Briefing',
          nodeId,
        });
        return;
      }
    }
    const spireId = this.hoveredSpireId;
    if (spireId !== null) {
      const sp = this.spires[spireId];
      const def = ACOUSTIC_SPIRES[spireId];
      if (sp && def && this.globe.projectSpire(spireId, this.scale.cameras.MACRO, this._v1)) {
        const x = (this._v1.x * 0.5 + 0.5) * w;
        const y = (-this._v1.y * 0.5 + 0.5) * h;
        this.ui.updateGlobeReticle({
          visible: true,
          x,
          y,
          kind: 'spire',
          title: def.name,
          tag: sp.functional ? `${def.baseFreq} Hz` : 'OFFLINE',
          sub: `${def.lat.toFixed(0)}° / ${def.lon.toFixed(0)}° · ${def.foundation}`,
          actionLabel: sp.functional ? 'Pulse Phase' : 'Ping Spire',
          spireId,
        });
        return;
      }
    }
    const settlementId = this.hoveredSettlementId ?? this.selectedSettlementId;
    if (settlementId) {
      const st = this.settlements.find((s) => s.id === settlementId);
      const def = SETTLEMENTS.find((s) => s.id === settlementId);
      if (st && def && this.globe.projectSettlement(settlementId, this.scale.cameras.MACRO, this._v1)) {
        const x = (this._v1.x * 0.5 + 0.5) * w;
        const y = (-this._v1.y * 0.5 + 0.5) * h;
        this.ui.updateGlobeReticle({
          visible: true,
          x,
          y,
          kind: 'settlement',
          title: st.name,
          tag: `${Math.round(st.viability * 100)}% VIABLE`,
          sub: `${st.populationK}k survivors · ${BIOME_LABEL[def.biome]}`,
          actionLabel: 'Focus Settlement',
          settlementId,
        });
        return;
      }
    }
    this.ui.updateGlobeReticle(null);
  }

  // -- node selection & briefing -------------------------------------------

  private selectedNodeId: string | null = null;

  selectNode(id: string): void {
    const rt = this.crises.get(id as CrisisId);
    if (!rt) return;
    this.selectedNodeId = id;
    this.selectedSettlementId = null;
    this.ui.setSelectedNode(id);
    this.ui.selectSettlement(null);
    this.scale.focusNode(rt.def.lat, rt.def.lon, 100);
    const forecast = this.planetary.forecast(rt.def.resolution, 180);
    const data: BriefingData = {
      node: rt.def,
      status: rt.status,
      objectives: rt.def.objectives.map((o) => ({
        text: o.text,
        progress: Math.min(1, (rt.progress[o.id] ?? 0) / o.target),
        done: (rt.progress[o.id] ?? 0) >= o.target,
      })),
      forecast,
      canStart: rt.status === 'AVAILABLE' || rt.status === 'ACTIVE',
      lockReason:
        rt.status === 'LOCKED'
          ? `Requires ${rt.def.requiresSpires} functional acoustic spires.`
          : undefined,
      unlockedModules: this.save.campaign.unlockedModules,
      domainPoints: this.save.campaign.domainPoints,
    };
    this.ui.openBriefing(data);
    this.audio.uiTone(520, 0.08);
  }

  // -- descent --------------------------------------------------------------

  private onDescendRequested(): void {
    void 0;
  }

  startCrisis(id: CrisisId): void {
    const rt = this.crises.get(id);
    if (!rt || rt.status === 'RESOLVED' || rt.status === 'LOCKED') return;
    this.crises.begin(id, rt.progress);
    this.activeCrisisId = id;
    this.ui.closeBriefing();
    const toOrbit = rt.def.vehicle === 'ORBITAL_SKIFF' && rt.def.domain === 'ORBIT';
    this.scale.beginDescend(toOrbit);
    this.bus.emit(Events.Toast, { message: `Descending into ${rt.def.name}`, kind: '' });
    this.logEvent(`Descended into ${rt.def.name} (${rt.def.vehicle})`);
  }

  private onScaleChanged(next: Scale): void {
    if (next === 'ORBIT' || next === 'SECTOR') {
      this.buildSector();
      this.ui.setMode(next);
    }
    if (next === 'MACRO') {
      this.teardownSector();
      this.ui.setMode('MACRO');
      this.ui.setSelectedNode(null);
    }
    this.ui.setMode(next === 'MACRO' ? 'MACRO' : next === 'ORBIT' ? 'ORBIT' : 'SECTOR');
  }

  // -- sector construction --------------------------------------------------

  private buildSector(): void {
    const rt = this.crises.activeCrisis;
    if (!rt) return;
    const def = rt.def;
    const biome: BiomeId = def.biomes[0] ?? 'SHATTERED_BASALT';

    this.sectorField = new SectorField({
      seed: WORLD_SEED,
      lat: def.lat,
      lon: def.lon,
      radius: 2048,
      biome,
      geothermalPressure: this.planetary.vars.geothermalPressure,
      tectonicShear: this.planetary.vars.tectonicShear,
      atmosphereToxicity: this.planetary.vars.atmosphereToxicity,
      soilViability: this.planetary.vars.soilViability,
      turbulence: def.domain === 'SKY' ? 0.55 + def.severity * 0.45 : 0.12,
    });
    const spawnX = 0;
    const spawnZ = 0;
    this.sectorField.surfaceY = this.sectorField.elevation(spawnX, spawnZ);

    this.sectorLattice = new TunnelLattice(4, 512, 240);
    this.sectorLattice.configure(spawnX, spawnZ, this.sectorField.surfaceY);
    const savedTunnels = this.crises.tunnelData.get(def.id);
    if (savedTunnels) this.sectorLattice.restore(savedTunnels);

    const isOrbitScale = this.scale.scale === 'ORBIT' || (def.vehicle === 'ORBITAL_SKIFF' && def.domain === 'ORBIT');

    // Sector sun direction: carried from the macro sun, projected onto the node
    // normal, so the lighting is continuous across the transition.
    const nodeNormal = latLonToVec3(def.lat, def.lon, 1, [0, 0, 0]);
    this._sectorSunDir.set(nodeNormal[0], nodeNormal[1], nodeNormal[2]);
    const sunComponent = this._sunDir.dot(this._sectorSunDir);
    this._sectorSunDir.multiplyScalar(sunComponent).addScaledVector(this._sunDir, 1 - sunComponent).normalize();
    if (this._sectorSunDir.y < 0.12) this._sectorSunDir.y = 0.12;
    this._sectorSunDir.normalize();

    if (!isOrbitScale) {
      this.sectorTerrain = new TerrainRenderer(this.sectorField);
      this.scale.scenes.SECTOR.add(this.sectorTerrain.group);

      this.sectorEnv = new SectorEnvironment(this.sectorField, {
        shadows: this.quality.shadowsEnabled,
        shadowMapSize: this.quality.shadowMapSize,
        particleScale: this.quality.particleScale,
      });
      this.scale.scenes.SECTOR.add(this.sectorEnv.group);

      // Hazard fluids where the biome justifies them.
      const hazard = hazardForBiome(biome);
      if (hazard) {
        let s = (WORLD_SEED ^ def.lat * 977) >>> 0;
        const rnd = (): number => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          return s / 4294967296;
        };
        for (let i = 0; i < 4; i++) {
          this.sectorEnv.addHazardFluid(
            (rnd() - 0.5) * 1400,
            (rnd() - 0.5) * 1400,
            60 + rnd() * 190,
            hazard,
          );
        }
      }

      // Spires near this sector.
      const spireIds: number[] = [];
      for (const sp of ACOUSTIC_SPIRES) {
        const dLat = sp.lat - def.lat;
        const dLon = sp.lon - def.lon;
        if (Math.hypot(dLat, dLon * Math.cos(def.lat * DEG2RAD)) < 12) spireIds.push(sp.id);
      }
      if (spireIds.length === 0) spireIds.push(0);
      this.sectorEnv.buildSpires(spireIds, this.spires.map((x) => x.functional));
      this.sectorEnv.setSunDirection(this._sectorSunDir);
    }

    // Vehicle.
    const vehicle = this.getOrCreateVehicle(def.vehicle);
    const spawnY =
      def.vehicle === 'ORBITAL_SKIFF'
        ? isOrbitScale
          ? 0
          : this.sectorField.surfaceY + 85
        : this.sectorField.surfaceY;
    vehicle.spawn(this._v1.set(spawnX, spawnY, spawnZ), 0);
    const targetScene = isOrbitScale ? this.scale.scenes.ORBIT : this.scale.scenes.SECTOR;
    targetScene.add(vehicle.object3D, vehicle.worldGroup);
    this.activeVehicle = vehicle;
    this.possessionSystem.possess(vehicle);

    // Sector-local wind.
    this.envWind = this._v2.set(this.weather.wind.x, 0, this.weather.wind.z).clone();

    // Sector entry camera: continue the descent.
    const approach = latLonToVec3(def.lat, def.lon, 1, [0, 0, 0]);
    this.scale.setSectorEntry(
      this._v3.set(spawnX, isOrbitScale ? 12 : this.sectorField.surfaceY + 2, spawnZ),
      this._v1.set(-approach[0], -approach[1], -approach[2]).normalize(),
      isOrbitScale ? 260 : 900,
    );

    // Vehicle-specific setup.
    if (vehicle.kind === 'ORBITAL_SKIFF') {
      const skiff = vehicle as OrbitalSkiff;
      skiff.populateDebris(WORLD_SEED ^ def.lat * 31, 54, 1.3 - this.planetary.vars.orbitalSafety);
    } else if (vehicle.kind === 'LAND_TRAIN') {
      const train = vehicle as LandTrain;
      train.setZones([
        { id: 'pickup', position: new THREE.Vector3(-260, 0, -180), radius: 26, kind: 'PICKUP', label: 'Depot' },
        { id: 'dropoff', position: new THREE.Vector3(340, 0, 240), radius: 30, kind: 'DROPOFF', label: 'Basin-edge settlement' },
      ]);
    } else if (vehicle.kind === 'STRATA_CRAWLER') {
      const crawler = vehicle as StrataCrawler;
      crawler.spawn(
        this._v1.set(spawnX, this.sectorField.surfaceY - 6, spawnZ),
        Math.PI / 2,
      );
    } else if (vehicle.kind === 'GLIDER') {
      const glider = vehicle as AtmosphericGlider;
      glider.seedThermals(WORLD_SEED ^ def.lon * 17, 28, 3.5 + def.severity * 3.5);
      glider.spawn(this._v1.set(spawnX, this.sectorField.surfaceY + 1400, spawnZ), Math.PI);
    }

    this.registerObjectiveHooks(vehicle);
    this.sectorTerrain?.update(0, 0, 1);
  }

  private envWind = new THREE.Vector3();

  private registerObjectiveHooks(vehicle: VehicleBase): void {
    const rt = this.crises.activeCrisis;
    if (!rt) return;
    vehicle.clearObjectives();
    for (const obj of rt.def.objectives) {
      vehicle.onObjective(obj.id, () => {
        const completed = this.crises.report(obj.id, 1);
        if (completed) {
          this.audio.uiTone(880, 0.12);
          this.bus.emit(Events.Toast, { message: `Objective complete: ${obj.text}`, kind: 'good' });
        }
        if (this.crises.isComplete()) this.resolveCrisis();
      });
    }
    // Continuous objectives (mapping, corridor density) tick every frame.
    vehicle.onObjective('tick', () => {
      this.tickContinuousObjectives(vehicle);
    });
  }

  private tickContinuousObjectives(vehicle: VehicleBase): void {
    const rt = this.crises.activeCrisis;
    if (!rt) return;
    if (vehicle.kind === 'ORBITAL_SKIFF') {
      const skiff = vehicle as OrbitalSkiff;
      if (skiff.corridorDensity < 0.12) this.crises.report('corridor', 1);
      if (skiff.target && skiff.position.distanceTo(skiff.target.position) < 380) {
        this.crises.report('diagnose', 1);
      }
    } else if (vehicle.kind === 'STRATA_CRAWLER') {
      const c = vehicle as StrataCrawler;
      if (c.depth > 40) this.crises.report('descend', 1);
      if (c.depth > 16 || c.drillTime > 2.5) this.crises.report('survey', 1);
      if (c.exchangersInstalled >= 2) this.crises.report('exchanger', 2);
      if ((c.depth > 20 || c.exchangersInstalled >= 1) && c.cutterTemperature < 0.9) {
        this.crises.report('coolant', 1);
      }
      if (c.drillTime > 12) this.crises.report('bore', 1);
      if (this.sectorLattice && this.sectorLattice.carvedCount > 400) this.crises.report('seal', 1);
    } else if (vehicle.kind === 'GLIDER') {
      const g = vehicle as AtmosphericGlider;
      if (g.sensorsDeployed >= 5) this.crises.report('seed', 5);
      if (g.mappedFraction >= 1) this.crises.report('map', 1);
      if (g.currentAltitude > 2600 && g.currentAirspeed > 22) this.crises.report('thermal', 1);
    } else if (vehicle.kind === 'LAND_TRAIN') {
      const t = vehicle as LandTrain;
      if (t.deliveredCount >= 3) this.crises.report('deliver', 3);
      if (t.deliveredCount >= 1) this.crises.report('clear', 1);
      if ((t.deliveredCount >= 1 || Math.abs(t.speed) > 4) && t.predictedFailureRatio < 0.35) {
        this.crises.report('route', 1);
      }
    }
    if (this.crises.isComplete()) this.resolveCrisis();
  }

  resolveCrisis(): void {
    const report = this.crises.resolve(this.planetary);
    if (!report) return;
    this.onCrisisResolved(report);
  }

  private onCrisisResolved(report: CompletionReport): void {
    // Reward the domain and unlock modules.
    const campaign = this.save.campaign;
    const key = report.rewards.domain as Domain;
    campaign.domainPoints[key] = (campaign.domainPoints[key] ?? 0) + report.rewards.points;
    const domainInfo = DOMAINS.find((d) => d.id === key);
    const level = Math.floor(campaign.domainPoints[key] / 3) + 1;
    for (const u of domainInfo?.unlocks ?? []) {
      if (u.level <= level && !campaign.unlockedModules.includes(u.module)) {
        campaign.unlockedModules.push(u.module);
        this.bus.emit(Events.Toast, { message: `Module unlocked: ${u.module} — ${u.note}`, kind: 'good' });
        this.logEvent(`Subsystem unlocked: ${u.module} (${key})`);
      }
    }
    this.harmonic.setUnlockedModules(campaign.unlockedModules);
    if (this.activeVehicle && this.sectorField && this.sectorLattice) {
      this.activeVehicle.setEnvironment(this.buildVehicleEnvironment());
    }
    // A resolved crisis repairs one more acoustic spire.
    this.repairNextSpire();
    this.crises.refreshAvailability(this.functionalSpireCount());
    this.ui.setCrises(this.crises.all(), null);
    this.logEvent(`Stabilised ${report.name} (+${report.rewards.points} ${key} pts)`);
    this.bus.emit(Events.Toast, {
      message: `${report.name} stabilised. Permanent baseline shift applied.`,
      kind: 'good',
    });
    this.audio.uiTone(740, 0.2);
    void this.saveGame(false);
  }

  private repairNextSpire(): void {
    const next = this.spires.find((s) => !s.functional);
    if (!next) return;
    next.functional = true;
    next.repairs = 2;
    const name = ACOUSTIC_SPIRES[next.id]?.name ?? `Spire #${next.id}`;
    this.bus.emit(Events.SpireRepaired, { id: next.id, name });
    this.harmonic.lockSpire(next.id, 2);
    this.logEvent(`Restored acoustic spire ${name}`);
  }

  private functionalSpireCount(): number {
    return this.spires.filter((s) => s.functional).length;
  }

  private harmonicUnlocked = false;
  private readonly prefDisposers: (() => void)[] = [];

  /**
   * Fire once, the first frame the spire network is both broad enough and
   * phase-locked enough to count as the Terminus Harmonic. The reward is a
   * permanent baseline shift, because a network that keeps the planet's crust
   * and atmosphere coherent is infrastructure, not a buff.
   */
  private checkHarmonicEstablished(): void {
    if (this.harmonicUnlocked || !this.harmonic.established) return;
    this.harmonicUnlocked = true;
    this.planetary.raiseBaseline(
      {
        tectonicShear: -0.06,
        atmosphereToxicity: -0.05,
        geothermalPressure: -0.04,
        hydrologyStability: 0.05,
        soilViability: 0.05,
        biosphereViability: 0.04,
        logisticsIntegrity: 0.05,
        orbitalSafety: 0.04,
      },
      1,
    );
    this.bus.emit(Events.HarmonicEstablished, { coherence: this.harmonic.coherence });
    this.bus.emit(Events.Toast, {
      message: 'Terminus Harmonic established. The network is holding the world together.',
      kind: 'good',
    });
    this.logEvent('Terminus Harmonic established across the planetary lattice');
    this.audio.uiTone(392, 0.9);
    void this.saveGame(false);
  }

  private crisisProgress(rt: { def: { objectives: { id: string; target: number }[] }; progress: Record<string, number> }): number {
    let sum = 0;
    for (const o of rt.def.objectives) sum += Math.min(1, (rt.progress[o.id] ?? 0) / o.target);
    return sum / Math.max(1, rt.def.objectives.length);
  }

  // -- vehicle management ---------------------------------------------------

  private buildVehicleEnvironment(): VehicleEnvironment {
    const field = this.sectorField!;
    const lattice = this.sectorLattice!;
    const isOrbit = this.scale.scale === 'ORBIT';
    return {
      world: this.world,
      input: this.input,
      field,
      lattice,
      planetary: this.planetary,
      sunDirection: this._sectorSunDir,
      wind: this.envWind,
      camera: isOrbit ? this.scale.cameras.ORBIT : this.scale.cameras.SECTOR,
      impact: (i, b) => this.audio.impact(i, b),
      blip: (x, y, z, f, g) => this.audio.spatialBlip(x, y, z, f, g),
      reportObjective: (id, amount = 1) => {
        const completed = this.crises.report(id, amount);
        if (completed) this.audio.uiTone(880, 0.12);
        if (this.crises.isComplete()) this.resolveCrisis();
      },
      particleScale: this.quality.particleScale,
      reducedMotion: this.settings.reducedMotion,
      unlockedModules: this.save.campaign.unlockedModules,
    };
  }

  private getOrCreateVehicle(kind: VehicleKind): VehicleBase {
    const env = this.buildVehicleEnvironment();
    let v = this.vehicles.get(kind);
    if (v) {
      v.setEnvironment(env);
      return v;
    }
    // Vehicles are created lazily and reused; the environment is rebuilt each
    // descent so the machine always sees the live sector.
    switch (kind) {
      case 'ORBITAL_SKIFF':
        v = new OrbitalSkiff(this.world, env);
        break;
      case 'LAND_TRAIN':
        v = new LandTrain(this.world, env);
        break;
      case 'STRATA_CRAWLER':
        v = new StrataCrawler(this.world, env);
        break;
      case 'GLIDER':
        v = new AtmosphericGlider(this.world, env);
        break;
    }
    this.vehicles.set(kind, v);
    return v;
  }

  private teardownSector(): void {
    this.possessionSystem?.release();
    if (this.activeVehicle) {
      this.scale.scenes.SECTOR.remove(this.activeVehicle.object3D, this.activeVehicle.worldGroup);
      this.scale.scenes.ORBIT.remove(this.activeVehicle.object3D, this.activeVehicle.worldGroup);
      // Keep the vehicle object alive (pooled) but detach it from the scene.
    }
    if (this.sectorTerrain) {
      this.scale.scenes.SECTOR.remove(this.sectorTerrain.group);
      this.sectorTerrain.dispose();
      this.sectorTerrain = null;
    }
    if (this.sectorEnv) {
      this.scale.scenes.SECTOR.remove(this.sectorEnv.group);
      this.sectorEnv.dispose();
      this.sectorEnv = null;
    }
    if (this.activeCrisisId && this.sectorLattice) {
      this.crises.tunnelData.set(this.activeCrisisId, this.sectorLattice.serialize());
    }
    this.sectorLattice = null;
    this.sectorField = null;
    this.activeVehicle = null;
    this.activeCrisisId = null;
  }

  // -- ascend ---------------------------------------------------------------

  private onAscendRequested(): void {
    if (this.scale.scale === 'MACRO') return;
    this.ascend();
  }

  ascend(): void {
    if (this.scale.scale !== 'SECTOR' && this.scale.scale !== 'ORBIT') return;
    // Commit any excavation before leaving.
    if (this.activeCrisisId && this.sectorLattice) {
      this.crises.tunnelData.set(this.activeCrisisId, this.sectorLattice.serialize());
    }
    this.scale.beginAscend();
    this.bus.emit(Events.Toast, { message: 'Returning to the Command Lattice', kind: '' });
  }

  // -- camera ---------------------------------------------------------------

  /** Set the Command Lattice overlay. Mirrors the UI callback. */
  setOverlay(mode: OverlayMode): void {
    this.globe.setOverlay(mode);
    this.ui.setOverlay(mode);
  }

  cycleCamera(): void {
    const v = this.activeVehicle;
    if (!v) return;
    const modes = v.availableCameraModes;
    const i = modes.indexOf(v.cameraMode);
    v.cameraMode = modes[(i + 1) % modes.length];
    this.audio.uiTone(v.cameraMode === 'COCKPIT' ? 720 : 480, 0.06);
  }

  // -- settings -------------------------------------------------------------

  applySettings(patch: Partial<SettingsRecord>): void {
    this.settings = { ...this.settings, ...patch };
    this.ui.applySettings(this.settings);
    this.scale.setReducedMotion(this.settings.reducedMotion);
    this.audio.setVolumes({
      master: this.settings.masterVolume,
      sfx: this.settings.sfxVolume,
      ambient: this.settings.ambientVolume,
      music: this.settings.musicVolume,
    });
    if (patch.qualityTier) {
      this.perf.setTier(patch.qualityTier, true);
      this.applyQuality(this.perf.settings);
    }
    if (patch.adaptiveQuality !== undefined) {
      this.perf.setAdaptive(patch.adaptiveQuality);
    }
    if (patch.bindings) this.input.setBindings({ ...DEFAULT_BINDINGS, ...patch.bindings });
  }

  applyQuality(q: QualitySettings): void {
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPixelRatio));
    this.renderer.shadowMap.enabled = q.shadowsEnabled;
    this.sectorEnv?.setQuality({ shadows: q.shadowsEnabled, shadowMapSize: q.shadowMapSize });
    this.settings.qualityTier = q.tier;
    this.resize();
  }

  rebind(action: ActionName, code: string): void {
    const bindings: KeyBinding = { ...DEFAULT_BINDINGS, ...this.settings.bindings, [action]: [code] };
    this.settings.bindings = { ...this.settings.bindings, [action]: [code] };
    this.input.setBindings(bindings);
  }

  resetBindings(): void {
    const defaults: Record<string, string[]> = {};
    for (const k of Object.keys(DEFAULT_BINDINGS) as ActionName[]) {
      defaults[k] = [...DEFAULT_BINDINGS[k]];
    }
    this.settings.bindings = defaults;
    this.input.setBindings({ ...DEFAULT_BINDINGS });
    this.bus.emit(Events.Toast, { message: 'Controls reset to default bindings.', kind: 'good' });
  }

  // -- persistence ----------------------------------------------------------

  /** Synchronise live simulation state and checksum into `this.save`. */
  private syncSaveRecord(appendAutosaveLog = false): SaveData {
    this.save.updatedAt = Date.now();
    this.save.playSeconds = (performance.now() - this.playStart) / 1000;
    this.save.planetary = this.planetary.snapshot();
    this.save.spires = this.spires.map((s) => ({ ...s }));
    this.save.settlements = this.settlements.map((s) => ({ id: s.id, viability: s.viability }));
    if (this.activeCrisisId && this.sectorLattice) {
      this.crises.tunnelData.set(this.activeCrisisId, this.sectorLattice.serialize());
    }
    this.save.crises = this.crises.serialize();
    this.save.settings = { ...this.settings, bindings: { ...this.settings.bindings } };
    this.save.campaign.activeCrisis = this.activeCrisisId;
    this.save.campaign.harmonicUnlocked = this.harmonicUnlocked;
    if (appendAutosaveLog) {
      this.save.log.push({ t: Date.now(), text: `autosave t+${this.planetary.simTime.toFixed(0)}s` });
      if (this.save.log.length > 200) this.save.log = this.save.log.slice(-200);
    }
    const { checksum: _c, ...rest } = this.save;
    this.save.checksum = computeChecksum(rest);
    this.syncCodexData();
    return this.save;
  }

  /**
   * Write the campaign to IndexedDB and return what was written. Returning the
   * record (rather than void) lets callers and tests verify the payload.
   */
  async saveGame(manual: boolean): Promise<SaveData> {
    this.syncSaveRecord(true);
    const result = manual ? await SaveStore.writeManual(this.save) : await SaveStore.writeAutosave(this.save);
    if (result.ok) {
      this.bus.emit(Events.SaveWritten, { bytes: result.bytes, manual });
    } else {
      this.bus.emit(Events.Toast, { message: `Save failed: ${result.error}`, kind: 'crit' });
    }
    return this.save;
  }

  async loadGame(): Promise<void> {
    const data = await SaveStore.readAny();
    if (!data) {
      this.bus.emit(Events.Toast, { message: 'No valid save found.', kind: 'warn' });
      return;
    }
    this.applySave(data);
    this.bus.emit(Events.Toast, { message: 'Campaign restored.', kind: 'good' });
  }

  private applySave(data: SaveData): void {
    this.teardownSector();
    this.save = data;
    this.planetary.restore(data.planetary);
    for (const s of data.spires) {
      const target = this.spires.find((x) => x.id === s.id);
      if (target) {
        target.functional = s.functional;
        target.phase = s.phase;
        target.repairs = s.repairs;
      }
    }
    for (const sv of data.settlements) {
      const target = this.settlements.find((x) => x.id === sv.id);
      if (target) target.viability = sv.viability;
    }
    this.crises.restore(data.crises);
    for (const c of data.crises) {
      if (c.tunnels) this.crises.tunnelData.set(c.id as CrisisId, c.tunnels);
    }
    this.harmonicUnlocked = data.campaign.harmonicUnlocked;
    this.harmonic.setUnlockedModules(data.campaign.unlockedModules);
    this.applySettings({ ...data.settings, bindings: data.settings.bindings });
    this.crises.refreshAvailability(this.functionalSpireCount());
    this.ui.setCrises(this.crises.all(), null);
    this.syncCodexData();
    this.resumeActiveCrisis();
    this.bus.emit(Events.SaveLoaded, { version: data.version });
  }

  /**
   * Rebuild the sector for a crisis that was still in progress when the game
   * was closed. Reloading drops you back exactly where you were — same machine,
   * same excavation lattice — rather than at the macro globe, which would make
   * a mid-descent save meaningless.
   */
  private resumeActiveCrisis(): void {
    const rt = this.crises.activeCrisis;
    if (!rt || rt.status !== 'ACTIVE') {
      this.activeCrisisId = null;
      this.scale.setScale('MACRO');
      return;
    }
    this.activeCrisisId = rt.def.id;
    const toOrbit = rt.def.vehicle === 'ORBITAL_SKIFF' && rt.def.domain === 'ORBIT';
    this.scale.setScale(toOrbit ? 'ORBIT' : 'SECTOR');
    this.scale.snapSectorCamera();
  }

  /** Pure serialisation of the current campaign to a portable JSON string. */
  serializeSave(): string {
    this.syncSaveRecord(false);
    return SaveStore.exportJson(this.save);
  }

  exportSave(): void {
    try {
      const json = this.serializeSave();
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `terminus-harmonic-${this.save.worldSeed.toString(16)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.bus.emit(Events.Toast, { message: 'Save exported.', kind: 'good' });
    } catch (err) {
      this.bus.emit(Events.Toast, { message: `Export failed: ${String(err)}`, kind: 'crit' });
    }
  }

  importSave(text: string): void {
    try {
      const data = SaveStore.importJson(text);
      this.applySave(data);
      this.bus.emit(Events.Toast, { message: 'Save imported.', kind: 'good' });
    } catch (err) {
      this.bus.emit(Events.Toast, { message: `Import failed: ${err instanceof Error ? err.message : String(err)}`, kind: 'crit' });
    }
  }

  /**
   * Abandon this world and generate another.
   *
   * This used to replace only the planetary simulation and the crisis list,
   * which produced a chimera: a pristine crisis list on a planet whose spires
   * had already been repaired, with the previous campaign's domain points and
   * unlocked modules still attached. The "new" world therefore started with the
   * Harmonic network already at two thirds coverage — the payoff of the last
   * campaign handed over for free.
   *
   * Everything derived from the world seed is now regenerated together, and
   * everything carried over from the old campaign is discarded.
   */
  newWorld(): void {
    const seed = (WORLD_SEED ^ 0x9e3779b9 ^ ((Math.random() * 0xffffffff) >>> 0)) >>> 0;

    // Leave whatever sector we are standing in before tearing the world down.
    this.teardownSector();
    this.ascend();

    this.planetary = new PlanetaryState(seed);
    this.crises = new CrisisController(CRISIS_NODES);
    this.bindCrisisHandler();
    this.settlements = SETTLEMENTS.map((s) => ({ ...s }));
    this.spires = ACOUSTIC_SPIRES.map((s) => ({
      id: s.id,
      functional: s.id < 2,
      phase: (s.id * 37) % 360,
      repairs: s.id < 2 ? 2 : 0,
      seated: true,
    }));
    this.globalStateSystem.rebind(this.planetary);
    this.weather.rebind(this.planetary, seed);
    this.logistics.rebind(this.planetary, this.settlements);
    this.harmonic.rebind(this.planetary, this.spires);
    this.uiSystem.rebind(this.planetary);
    this.ui.setPlanetary(this.planetary);
    this.harmonicUnlocked = false;

    // Pooled machines hold sector-specific tuning and objective state.
    for (const v of this.vehicles.values()) v.dispose();
    this.vehicles.clear();
    this.activeVehicle = null;

    this.selectedNodeId = null;
    this.selectedSettlementId = null;
    this.save = newSave(seed, this.planetary.snapshot());
    this.harmonic.setUnlockedModules(this.save.campaign.unlockedModules);
    this.syncCodexData();
    this.crises.refreshAvailability(this.functionalSpireCount());
    this.ui.setCrises(this.crises.all(), null);
    this.ui.setSelectedNode(null);
    this.ui.selectSettlement(null);
    this.ui.setMode('MACRO');
    this.globe.setPlanetaryState(this.planetary.snapshot(), performance.now(), true);
    this.bus.emit(Events.Toast, { message: 'New survey parameters generated.', kind: 'good' });
    void this.saveGame(false);
  }

  // -- events ---------------------------------------------------------------

  private onResize = (): void => {
    this.resize();
  };

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    this.scale.resize(w, h);
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      void this.saveGame(false);
    }
  };

  // -- teardown -------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.globePointerCleanup?.();
    this.globePointerCleanup = null;
    this.shortcutKeyCleanup?.();
    this.shortcutKeyCleanup = null;
    this.input.dispose();
    this.audio.dispose();
    this.ui.dispose();
    for (const v of this.vehicles.values()) v.dispose();
    this.vehicles.clear();
    this.teardownSector();
    this.globe.dispose();
    this.skyMacro.dispose();
    this.skyOrbit.dispose();
    this.skySector.dispose();
    this.orbitalLayer.dispose();
    this.scale.dispose();
    this.world.dispose();
    this.renderer.dispose();
    for (const d of this.prefDisposers) d();
    this.prefDisposers.length = 0;
  }

  // -- debug hooks ----------------------------------------------------------

  /** Exposed for the console and for automated smoke tests. */
  /** Structured snapshot for the debug handle, the smoke tests and the report. */
  debugState() {
    const active = this.crises.activeCrisis;
    return {
      scale: this.scale.scale,
      started: this.started,
      globalHealth: this.planetary.globalHealth(),
      instability: this.planetary.instability(),
      planetary: this.planetary.snapshot(),
      coherence: this.harmonic.coherence,
      harmonicUnlocked: this.harmonicUnlocked,
      spireCoverage: this.harmonic.coverage,
      phaseOrder: this.harmonic.phaseOrder,
      crisisCount: this.crises.all().length,
      resolvedCount: this.crises.resolvedCount,
      activeCrisis: active ? active.def.id : null,
      crisisProgress: active ? this.crises.completionFraction() : 0,
      crises: this.crises.all().map((c) => ({ id: c.def.id, status: c.status, progress: c.progress })),
      spireCount: this.spires.length,
      functionalSpires: this.spires.filter((x) => x.functional).length,
      spires: this.spires.map((x) => ({ id: x.id, functional: x.functional })),
      settlements: this.settlements.map((x) => ({ id: x.id, viability: x.viability })),
      entityCount: this.world.systemNames().length + this.spires.length,
      overlay: this.globe.overlay,
      activeVehicle: this.activeVehicle ? this.activeVehicle.kind : null,
      vehicles: this.vehicles.size,
      sector: this.sectorField ? this.sectorField.materialLabel : null,
      carved: this.sectorLattice ? this.sectorLattice.carvedCount : 0,
      settings: { ...this.settings },
      qualityTier: this.quality.tier,
      saveVersion: SCHEMA_VERSION,
    };
  }

  /**
   * Drive every objective of the active crisis to completion. Used by the
   * integration tests and by the debug handle to verify the resolution path
   * without having to fly four different machines perfectly.
   */
  completeActiveObjectives(): boolean {
    const rt = this.crises.activeCrisis;
    if (!rt) return false;
    for (const o of rt.def.objectives) {
      const have = rt.progress[o.id] ?? 0;
      if (have < o.target) this.crises.report(o.id, o.target - have);
    }
    // Completing the objectives is what the player does; stabilising is the
    // separate act that commits the planetary change. The debug hook does both
    // so the whole resolution path can be exercised without flying perfectly.
    if (this.crises.isComplete()) this.resolveCrisis();
    return this.crises.activeCrisis === null;
  }
}
