/**
 * UI — the planetary engineering instrument
 * =========================================
 *
 * All interface is DOM, not in-canvas: it gives real text sizing, real contrast
 * control, real keyboard navigation and real responsive layout for free, and it
 * keeps the WebGL surface doing only what it is good at.
 *
 * The HUD is driven entirely by the vehicle's {@link HudModel}, so a vehicle can
 * never show gauges that do not belong to it.
 */

import { Events } from '../core/events';
import type { EventBus } from '../core/events';
import {
  OVERLAY_LABEL,
  OVERLAY_LEGEND,
  OVERLAY_MODES,
  type OverlayMode,
} from '../render/globe';
import {
  PLANETARY_VARS,
  PlanetaryState,
  varLabel,
  varSense,
  varUnit,
  type PlanetaryVar,
} from '../state/planetary';
import { ACOUSTIC_SPIRES, DOMAIN_LABEL, type CrisisNodeDef } from '../state/world';
import type { CrisisRuntime } from '../game/crisis';
import type { HudModel } from '../vehicle/base';
import { ACTION_LABELS, type ActionName } from '../core/input';
import type { SettingsRecord, SpireRecord } from '../state/save';
import type { QualityTier } from '../core/perf';
import type { SettlementRuntime } from '../systems/systems';

export interface BriefingData {
  node: CrisisNodeDef;
  status: CrisisRuntime['status'];
  objectives: { text: string; progress: number; done: boolean }[];
  forecast: { vars: Record<PlanetaryVar, number>; chain: string[] };
  canStart: boolean;
  lockReason?: string;
}

export interface UIDependencies {
  bus: EventBus;
  planetary: PlanetaryState;
  settings: SettingsRecord;
  onOverlayChange: (mode: OverlayMode) => void;
  onSelectNode: (id: string) => void;
  onStartCrisis: (id: string) => void;
  onAscend: () => void;
  onSettingsChange: (patch: Partial<SettingsRecord>) => void;
  onRebind: (action: ActionName, code: string) => void;
  onSave: () => void;
  onLoad: () => void;
  onExport: () => void;
  onImport: (text: string) => void;
  onNewWorld: () => void;
  onCycleCamera: () => void;
  onPingSpire?: (spireId: number) => void;
}

type Listener = () => void;

/**
 * Handles to the mutable parts of one crisis list row. The row is built once
 * and then updated in place: rebuilding seven buttons (and re-attaching seven
 * click listeners) every frame cost several milliseconds of main-thread time
 * and churned the DOM 60 times a second for data that changes a few times a
 * minute.
 */
interface CrisisRow {
  btn: HTMLButtonElement;
  domain: HTMLElement;
  state: HTMLElement;
  pct: HTMLElement;
  status: string;
  pctText: string;
  aria: string;
}

export class UIController {
  private deps: UIDependencies;
  private settings: SettingsRecord;
  private overlay: OverlayMode = 'TOPOGRAPHY';
  private lastMacroPaint = 0;
  private disposers: Listener[] = [];
  private briefingNodeId: string | null = null;
  private selectedNodeId: string | null = null;
  private selectedSpireId = 0;
  private rebindingAction: ActionName | null = null;

  /** Update the planetary state reference when a new world or save is loaded. */
  setPlanetary(planetary: PlanetaryState): void {
    this.deps.planetary = planetary;
  }

  /** Node currently highlighted on the globe. */
  get highlightedNode(): string | null {
    return this.selectedNodeId;
  }

  /** Action awaiting a key press, or null. */
  get pendingRebind(): ActionName | null {
    return this.rebindingAction;
  }

  // Cached element refs.
  private el: Record<string, HTMLElement> = {};
  private gaugeEls = new Map<string, { root: HTMLElement; fill: HTMLElement; val: HTMLElement }>();
  private flagEls = new Map<string, HTMLElement>();
  private varEls = new Map<PlanetaryVar, { row: HTMLElement; fill: HTMLElement; val: HTMLElement }>();
  private crisisRows = new Map<string, CrisisRow>();

  constructor(deps: UIDependencies) {
    this.deps = deps;
    this.settings = { ...deps.settings };
    this.build();
    this.wire();
  }

  // -- construction ---------------------------------------------------------

  private build(): void {
    const root = document.getElementById('app');
    if (!root) throw new Error('#app not found');

    // --- boot screen ---
    const boot = document.createElement('div');
    boot.id = 'boot';
    boot.innerHTML = `
      <h1>The Terminus Harmonic</h1>
      <div class="sub">Remnant Survey 0-ARK &middot; Command Lattice</div>
      <div class="lines" id="boot-lines"></div>
      <button class="enter" id="boot-enter">Establish Link</button>
    `;
    root.appendChild(boot);
    this.el.boot = boot;
    this.el.bootLines = boot.querySelector('#boot-lines') as HTMLElement;
    this.el.bootEnter = boot.querySelector('#boot-enter') as HTMLButtonElement;

    // --- macro UI ---
    const macro = document.createElement('div');
    macro.id = 'macro-ui';
    macro.innerHTML = `
      <div class="macro-row">
        <div class="macro-block panel" id="planetary-health">
          <div class="panel-title"><span>Planetary State</span><span id="health-pct">--</span></div>
          <div class="body">
            <div class="health-bar"><i id="health-fill" style="width:0%"></i></div>
            <div class="health-meta">
              <span id="instability">instability --</span>
              <span id="sim-time">t+0</span>
            </div>
            <div class="var-grid" id="var-grid"></div>
          </div>
        </div>
        <div class="macro-block">
          <div id="overlay-selector"></div>
          <div id="overlay-legend"></div>
        </div>
      </div>
      <div class="macro-row" style="align-items:flex-end">
        <div class="macro-block">
          <div class="panel" id="harmonic-scope">
            <div class="panel-title"><span>Harmonic Lattice</span><span id="harmonic-order-pct">0% lock</span></div>
            <div class="harmonic-scope-grid">
              <div class="harmonic-polar-wrap">
                <svg id="harmonic-polar-svg" viewBox="-60 -60 120 120" aria-label="Harmonic Phase-Lock Polar Scope">
                  <circle cx="0" cy="0" r="48" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="0.8" stroke-dasharray="2 2"/>
                  <circle cx="0" cy="0" r="32" fill="none" stroke="rgba(47,159,208,0.2)" stroke-width="0.8"/>
                  <circle cx="0" cy="0" r="16" fill="none" stroke="rgba(47,159,208,0.34)" stroke-width="0.8"/>
                  <line x1="-52" y1="0" x2="52" y2="0" stroke="rgba(255,255,255,0.07)" stroke-width="0.6"/>
                  <line x1="0" y1="-52" x2="0" y2="52" stroke="rgba(255,255,255,0.07)" stroke-width="0.6"/>
                  <line id="harmonic-ref-needle" x1="0" y1="0" x2="0" y2="-48" stroke="#4fc4ef" stroke-width="1.3" stroke-opacity="0.75"/>
                  <g id="harmonic-spire-dots"></g>
                  <circle cx="0" cy="0" r="2.2" fill="#4fc4ef"/>
                </svg>
              </div>
              <div class="harmonic-stats">
                <div class="harmonic-stat-row"><span>Coverage</span><b id="harmonic-cov-val">5/12</b></div>
                <div class="harmonic-stat-row"><span>Phase Agreement</span><b class="azure" id="harmonic-ord-val">0%</b></div>
                <div id="spire-detail">
                  <div class="spire-name"><span id="spire-name-lbl">Spire I · Verdigris</span><button class="btn" id="spire-ping-btn" type="button">Ping</button></div>
                  <div id="spire-meta-lbl">110 Hz · Δ0° · online</div>
                </div>
              </div>
            </div>
          </div>
          <div class="panel" id="crisis-list" style="margin-top:8px">
            <div class="panel-title"><span>Crisis Nodes</span><span id="crisis-count"></span></div>
            <div id="crisis-items"></div>
            <div id="settlement-ledger">
              <div class="ledger-head"><span>Settlement Viability</span><span id="ledger-avg">--</span></div>
              <div class="settlement-grid" id="settlement-grid"></div>
              <div id="module-tags"></div>
            </div>
          </div>
        </div>
        <div id="macro-toolbar"></div>
      </div>
      <div id="globe-reticle" aria-live="polite">
        <div class="reticle-card" id="reticle-card">
          <div class="reticle-top"><span id="reticle-title"></span><span id="reticle-tag"></span></div>
          <div class="reticle-sub" id="reticle-sub"></div>
          <div class="reticle-actions">
            <button class="btn primary" id="reticle-action" type="button">Inspect</button>
          </div>
        </div>
      </div>
    `;
    root.appendChild(macro);
    this.el.macro = macro;
    this.el.healthFill = macro.querySelector('#health-fill') as HTMLElement;
    this.el.healthPct = macro.querySelector('#health-pct') as HTMLElement;
    this.el.instability = macro.querySelector('#instability') as HTMLElement;
    this.el.simTime = macro.querySelector('#sim-time') as HTMLElement;
    this.el.varGrid = macro.querySelector('#var-grid') as HTMLElement;
    this.el.overlaySelector = macro.querySelector('#overlay-selector') as HTMLElement;
    this.el.overlayLegend = macro.querySelector('#overlay-legend') as HTMLElement;
    this.el.crisisItems = macro.querySelector('#crisis-items') as HTMLElement;
    this.el.crisisCount = macro.querySelector('#crisis-count') as HTMLElement;
    this.el.macroToolbar = macro.querySelector('#macro-toolbar') as HTMLElement;
    this.el.harmonicOrderPct = macro.querySelector('#harmonic-order-pct') as HTMLElement;
    this.el.harmonicRefNeedle = macro.querySelector('#harmonic-ref-needle') as HTMLElement;
    this.el.harmonicSpireDots = macro.querySelector('#harmonic-spire-dots') as HTMLElement;
    this.el.harmonicCovVal = macro.querySelector('#harmonic-cov-val') as HTMLElement;
    this.el.harmonicOrdVal = macro.querySelector('#harmonic-ord-val') as HTMLElement;
    this.el.spireNameLbl = macro.querySelector('#spire-name-lbl') as HTMLElement;
    this.el.spireMetaLbl = macro.querySelector('#spire-meta-lbl') as HTMLElement;
    this.el.spirePingBtn = macro.querySelector('#spire-ping-btn') as HTMLButtonElement;
    this.el.settlementGrid = macro.querySelector('#settlement-grid') as HTMLElement;
    this.el.ledgerAvg = macro.querySelector('#ledger-avg') as HTMLElement;
    this.el.moduleTags = macro.querySelector('#module-tags') as HTMLElement;
    this.el.globeReticle = macro.querySelector('#globe-reticle') as HTMLElement;
    this.el.reticleCard = macro.querySelector('#reticle-card') as HTMLElement;
    this.el.reticleTitle = macro.querySelector('#reticle-title') as HTMLElement;
    this.el.reticleTag = macro.querySelector('#reticle-tag') as HTMLElement;
    this.el.reticleSub = macro.querySelector('#reticle-sub') as HTMLElement;
    this.el.reticleAction = macro.querySelector('#reticle-action') as HTMLButtonElement;

    // Overlay buttons.
    for (const mode of OVERLAY_MODES) {
      const b = document.createElement('button');
      b.className = 'overlay-btn';
      b.textContent = OVERLAY_LABEL[mode];
      b.setAttribute('aria-pressed', String(mode === this.overlay));
      b.dataset.mode = mode;
      b.addEventListener('click', () => this.setOverlay(mode));
      this.el.overlaySelector.appendChild(b);
    }

    // Variable rows.
    for (const v of PLANETARY_VARS) {
      const row = document.createElement('div');
      row.className = 'var-row';
      row.title = `${varLabel(v)} (${varUnit(v)})`;
      row.innerHTML = `<span class="name">${varLabel(v)}</span><span class="tick"><i></i></span><span class="val">--</span>`;
      this.el.varGrid.appendChild(row);
      this.varEls.set(v, {
        row,
        fill: row.querySelector('.tick > i') as HTMLElement,
        val: row.querySelector('.val') as HTMLElement,
      });
    }

    // --- HUD ---
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.innerHTML = `
      <div class="hud-top">
        <div class="hud-title panel">
          <div style="padding:8px 10px">
            <div class="name" id="hud-name">--</div>
            <div class="sub" id="hud-sub"></div>
          </div>
          <div id="sector-bar">
            <span class="sector-cam-badge" id="hud-cam-mode">CAM · CHASE</span>
            <button class="btn" id="hud-cam-btn" type="button" title="Cycle Camera [V]">Camera [V]</button>
            <button class="btn" id="hud-ascend-btn" type="button" title="Return to Command Lattice [ESC]">Lattice [ESC]</button>
            <button class="btn" id="hud-settings-btn" type="button" title="Open Configuration">Config</button>
          </div>
        </div>
        <div class="panel" id="objectives">
          <div class="panel-title"><span>Engineering Tasks</span><span id="obj-count"></span></div>
          <div class="body" id="obj-body"></div>
        </div>
      </div>
      <div class="hud-bottom">
        <div>
          <div id="gauges"></div>
          <div id="hud-readout"></div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end">
          <div id="hud-flags"></div>
          <div id="hud-controls"></div>
        </div>
      </div>
    `;
    root.appendChild(hud);
    this.el.hud = hud;
    this.el.hudName = hud.querySelector('#hud-name') as HTMLElement;
    this.el.hudSub = hud.querySelector('#hud-sub') as HTMLElement;
    this.el.gauges = hud.querySelector('#gauges') as HTMLElement;
    this.el.flags = hud.querySelector('#hud-flags') as HTMLElement;
    this.el.readout = hud.querySelector('#hud-readout') as HTMLElement;
    this.el.objBody = hud.querySelector('#obj-body') as HTMLElement;
    this.el.objCount = hud.querySelector('#obj-count') as HTMLElement;
    this.el.hudCamMode = hud.querySelector('#hud-cam-mode') as HTMLElement;
    this.el.hudCamBtn = hud.querySelector('#hud-cam-btn') as HTMLButtonElement;
    this.el.hudAscendBtn = hud.querySelector('#hud-ascend-btn') as HTMLButtonElement;
    this.el.hudSettingsBtn = hud.querySelector('#hud-settings-btn') as HTMLButtonElement;
    this.el.hudControls = hud.querySelector('#hud-controls') as HTMLElement;

    // --- briefing modal ---
    const brief = document.createElement('div');
    brief.id = 'briefing';
    brief.setAttribute('role', 'dialog');
    brief.setAttribute('aria-modal', 'true');
    brief.setAttribute('aria-labelledby', 'briefing-title');
    brief.innerHTML = `
      <div class="briefing-card">
        <header>
          <div>
            <h2 id="briefing-title"></h2>
            <div class="domain" id="briefing-domain"></div>
          </div>
          <button class="btn" id="briefing-close">Close</button>
        </header>
        <div class="body">
          <div id="briefing-lock-reason" role="status"></div>
          <p class="brief" id="briefing-brief"></p>
          <h3>Engineering Objectives</h3>
          <ul class="obj-list" id="briefing-objectives"></ul>
          <h3>Predicted Planetary Consequences</h3>
          <div class="forecast" id="briefing-forecast"></div>
          <h3>Archival Record</h3>
          <div class="forecast" id="briefing-archive"></div>
        </div>
        <footer>
          <button class="btn" id="briefing-abort" style="display:none">Abandon</button>
          <button class="btn primary" id="briefing-descend">Descend</button>
        </footer>
      </div>
    `;
    root.appendChild(brief);
    this.el.briefing = brief;
    this.el.briefTitle = brief.querySelector('#briefing-title') as HTMLElement;
    this.el.briefDomain = brief.querySelector('#briefing-domain') as HTMLElement;
    this.el.briefLockReason = brief.querySelector('#briefing-lock-reason') as HTMLElement;
    this.el.briefBrief = brief.querySelector('#briefing-brief') as HTMLElement;
    this.el.briefObjectives = brief.querySelector('#briefing-objectives') as HTMLElement;
    this.el.briefForecast = brief.querySelector('#briefing-forecast') as HTMLElement;
    this.el.briefArchive = brief.querySelector('#briefing-archive') as HTMLElement;
    this.el.briefDescend = brief.querySelector('#briefing-descend') as HTMLButtonElement;
    this.el.briefAbort = brief.querySelector('#briefing-abort') as HTMLButtonElement;
    this.el.briefClose = brief.querySelector('#briefing-close') as HTMLButtonElement;

    // --- settings modal ---
    const settings = document.createElement('div');
    settings.id = 'settings';
    settings.setAttribute('role', 'dialog');
    settings.setAttribute('aria-modal', 'true');
    settings.innerHTML = `
      <div class="settings-card">
        <header>
          <h2>Configuration</h2>
          <button class="btn" id="settings-close">Close</button>
        </header>
        <div class="settings-body" id="settings-body"></div>
        <footer>
          <button class="btn" id="settings-export">Export Save</button>
          <button class="btn" id="settings-import">Import Save</button>
          <button class="btn" id="settings-save">Save Now</button>
          <button class="btn" id="settings-load">Load</button>
          <button class="btn" id="settings-newworld">New World</button>
        </footer>
      </div>
    `;
    root.appendChild(settings);
    this.el.settings = settings;
    this.el.settingsBody = settings.querySelector('#settings-body') as HTMLElement;
    this.el.settingsClose = settings.querySelector('#settings-close') as HTMLButtonElement;

    // --- touch controls ---
    const touch = document.createElement('div');
    touch.id = 'touch';
    touch.innerHTML = `
      <div class="touch-stick left" id="touch-left"><div class="cap">Move</div><div class="knob"></div></div>
      <div class="touch-stick right" id="touch-right"><div class="cap">Look</div><div class="knob"></div></div>
      <div class="touch-buttons">
        <button class="touch-btn primary" data-action="primary">Tool 1</button>
        <button class="touch-btn" data-action="secondary">Tool 2</button>
        <button class="touch-btn" data-action="interact">Deploy</button>
        <button class="touch-btn" data-action="assist">Assist</button>
      </div>
      <div id="touch-macro">
        <button class="touch-btn" data-action="ascendMacro" style="width:88px">Lattice</button>
        <button class="touch-btn" data-action="cameraCycle" style="width:88px">Camera</button>
      </div>
    `;
    root.appendChild(touch);
    this.el.touch = touch;
    this.el.touchLeft = touch.querySelector('#touch-left') as HTMLElement;
    this.el.touchRight = touch.querySelector('#touch-right') as HTMLElement;

    // --- perf overlay ---
    const perf = document.createElement('div');
    perf.id = 'perf';
    root.appendChild(perf);
    this.el.perf = perf;

    // --- toasts ---
    const toasts = document.createElement('div');
    toasts.id = 'toasts';
    root.appendChild(toasts);
    this.el.toasts = toasts;

    // --- harmonic banner ---
    const banner = document.createElement('div');
    banner.id = 'harmonic-banner';
    banner.textContent = 'Terminus Harmonic · dormant';
    root.appendChild(banner);
    this.el.harmonicBanner = banner;

    this.buildSettings();
  }

  private buildSettings(): void {
    const body = this.el.settingsBody;
    body.innerHTML = '';

    const group = (title: string): HTMLElement => {
      const g = document.createElement('div');
      g.className = 'settings-group';
      const h = document.createElement('h3');
      h.textContent = title;
      g.appendChild(h);
      body.appendChild(g);
      return g;
    };

    // --- display ---
    const gDisplay = group('Display & Performance');
    const tiers: QualityTier[] = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];
    gDisplay.appendChild(
      this.row('Quality tier', this.select(tiers.map((t) => ({ v: t, l: t })), this.settings.qualityTier, (v) =>
        this.deps.onSettingsChange({ qualityTier: v as QualityTier }),
      )),
    );
    gDisplay.appendChild(
      this.row(
        'Adaptive quality',
        this.checkbox(this.settings.adaptiveQuality, (v) => this.deps.onSettingsChange({ adaptiveQuality: v })),
      ),
    );
    gDisplay.appendChild(
      this.row('Performance overlay', this.checkbox(this.settings.showPerf, (v) => this.deps.onSettingsChange({ showPerf: v }))),
    );

    // --- audio ---
    const gAudio = group('Audio');
    const slider = (v: number, cb: (n: number) => void): HTMLElement => {
      const s = document.createElement('input');
      s.type = 'range';
      s.min = '0';
      s.max = '100';
      s.value = String(Math.round(v * 100));
      s.addEventListener('input', () => cb(Number(s.value) / 100));
      return s;
    };
    gAudio.appendChild(
      this.row(
        'Master volume',
        (() => {
          const wrap = document.createElement('div');
          wrap.style.display = 'flex';
          wrap.style.alignItems = 'center';
          wrap.style.gap = '8px';
          const val = document.createElement('span');
          val.className = 'value';
          val.textContent = `${Math.round(this.settings.masterVolume * 100)}%`;
          const s = slider(this.settings.masterVolume, (n) => {
            val.textContent = `${Math.round(n * 100)}%`;
            this.deps.onSettingsChange({ masterVolume: n });
          });
          wrap.append(s, val);
          return wrap;
        })(),
      ),
    );
    gAudio.appendChild(
      this.row(
        'Machinery / impact',
        slider(this.settings.sfxVolume, (n) => this.deps.onSettingsChange({ sfxVolume: n })),
      ),
    );
    gAudio.appendChild(
      this.row(
        'Ambient / atmosphere',
        slider(this.settings.ambientVolume, (n) => this.deps.onSettingsChange({ ambientVolume: n })),
      ),
    );
    gAudio.appendChild(
      this.row(
        'Terminus Harmonic',
        slider(this.settings.musicVolume, (n) => this.deps.onSettingsChange({ musicVolume: n })),
      ),
    );

    // --- accessibility ---
    const gA11y = group('Accessibility');
    gA11y.appendChild(
      this.row('Reduced motion', this.checkbox(this.settings.reducedMotion, (v) => this.deps.onSettingsChange({ reducedMotion: v }))),
    );
    gA11y.appendChild(
      this.row('High contrast', this.checkbox(this.settings.highContrast, (v) => this.deps.onSettingsChange({ highContrast: v }))),
    );
    gA11y.appendChild(
      this.row('Larger text', this.checkbox(this.settings.largeText, (v) => this.deps.onSettingsChange({ largeText: v }))),
    );
    gA11y.appendChild(
      this.row('Screen shake', this.checkbox(this.settings.screenShake, (v) => this.deps.onSettingsChange({ screenShake: v }))),
    );
    gA11y.appendChild(
      this.row('Invert vertical look', this.checkbox(this.settings.invertY, (v) => this.deps.onSettingsChange({ invertY: v }))),
    );
    gA11y.appendChild(
      this.row('On-screen controls (touch)', this.checkbox(this.settings.touchControls, (v) => this.deps.onSettingsChange({ touchControls: v }))),
    );

    // --- controls ---
    const gControls = group('Controls');
    const actions = Object.keys(ACTION_LABELS) as ActionName[];
    for (const action of actions) {
      const row = document.createElement('div');
      row.className = 'keybind-row';
      const lbl = document.createElement('span');
      lbl.className = 'action';
      lbl.textContent = ACTION_LABELS[action];
      const keys = document.createElement('span');
      keys.className = 'keys';
      const renderKeys = (): void => {
        keys.innerHTML = '';
        for (const code of this.settings.bindings[action] ?? []) {
          const k = document.createElement('kbd');
          k.textContent = prettyCode(code);
          keys.appendChild(k);
        }
      };
      renderKeys();
      const btn = document.createElement('button');
      btn.textContent = 'Rebind';
      btn.addEventListener('click', () => {
        this.rebindingAction = action;
        btn.textContent = 'Press a key…';
        const onKey = (e: KeyboardEvent): void => {
          e.preventDefault();
          this.deps.onRebind(action, e.code);
          this.settings = { ...this.settings, bindings: { ...this.settings.bindings, [action]: [e.code] } };
          renderKeys();
          btn.textContent = 'Rebind';
          window.removeEventListener('keydown', onKey, true);
          this.rebindingAction = null;
        };
        window.addEventListener('keydown', onKey, true);
      });
      row.append(lbl, keys, btn);
      gControls.appendChild(row);
    }
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    const r = document.createElement('div');
    r.className = 'setting-row';
    const l = document.createElement('label');
    l.textContent = label;
    r.append(l, control);
    return r;
  }

  private select(options: { v: string; l: string }[], value: string, cb: (v: string) => void): HTMLElement {
    const s = document.createElement('select');
    for (const o of options) {
      const opt = document.createElement('option');
      opt.value = o.v;
      opt.textContent = o.l;
      s.appendChild(opt);
    }
    s.value = value;
    s.addEventListener('change', () => cb(s.value));
    return s;
  }

  private checkbox(value: boolean, cb: (v: boolean) => void): HTMLElement {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = value;
    c.addEventListener('change', () => cb(c.checked));
    return c;
  }

  // -- wiring ---------------------------------------------------------------

  private wire(): void {
    this.el.bootEnter.addEventListener('click', () => this.dismissBoot());
    this.el.briefClose.addEventListener('click', () => this.closeBriefing());
    this.el.briefDescend.addEventListener('click', () => {
      if (this.briefingNodeId) this.deps.onStartCrisis(this.briefingNodeId);
    });
    this.el.briefAbort.addEventListener('click', () => {
      this.closeBriefing();
      this.deps.onAscend();
    });
    this.el.settingsClose.addEventListener('click', () => this.closeSettings());

    const backdrop = (e: MouseEvent): void => {
      if (e.target === this.el.briefing) this.closeBriefing();
      if (e.target === this.el.settings) this.closeSettings();
    };
    this.el.briefing.addEventListener('click', backdrop);
    this.el.settings.addEventListener('click', backdrop);

    const d = this.deps;
    this.disposers.push(d.bus.on(Events.Toast, (p) => this.toast(p?.message as string, p?.kind as string)));
    this.disposers.push(
      d.bus.on(Events.CrisisResolved, (p) =>
        this.toast(`${p?.name as string} stabilised`, 'good'),
      ),
    );
    this.disposers.push(
      d.bus.on(Events.CrisisProgress, (p) => {
        if (p && p.completion === 0) return;
        if (p && p.completion) this.toast(`${p.name as string}: ${Math.round((p.completion as number) * 100)}%`, '');
      }),
    );
    this.disposers.push(d.bus.on(Events.SaveWritten, (p) => this.toast(`Saved (${p?.bytes as number} bytes)`, 'good')));
    this.disposers.push(d.bus.on(Events.SaveLoaded, () => this.toast('Campaign restored', 'good')));

    // Toolbar buttons in the macro toolbar.
    const mk = (label: string, fn: () => void, primary = false): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = `btn${primary ? ' primary' : ''}`;
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    this.el.macroToolbar.append(
      mk('Settings', () => this.openSettings()),
      mk('Camera', () => d.onCycleCamera()),
      mk('Save', () => d.onSave()),
      mk('Load', () => d.onLoad()),
    );

    // Sector HUD command bar + spire ping wiring.
    this.el.hudCamBtn?.addEventListener('click', () => d.onCycleCamera());
    this.el.hudAscendBtn?.addEventListener('click', () => d.onAscend());
    this.el.hudSettingsBtn?.addEventListener('click', () => this.openSettings());
    this.el.spirePingBtn?.addEventListener('click', () => {
      d.onPingSpire?.(this.selectedSpireId);
    });
    this.el.reticleAction?.addEventListener('click', () => {
      const nodeId = this.el.reticleAction.dataset.nodeId;
      const spireId = this.el.reticleAction.dataset.spireId;
      if (nodeId) d.onSelectNode(nodeId);
      else if (spireId !== undefined) d.onPingSpire?.(Number(spireId));
    });

    const close = this.el.settings.querySelector('#settings-close') as HTMLButtonElement;
    close.addEventListener('click', () => this.closeSettings());
    const exp = this.el.settings.querySelector('#settings-export') as HTMLButtonElement;
    exp.addEventListener('click', () => d.onExport());
    const imp = this.el.settings.querySelector('#settings-import') as HTMLButtonElement;
    imp.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => d.onImport(String(r.result));
        r.readAsText(f);
      });
      input.click();
    });
    const sv = this.el.settings.querySelector('#settings-save') as HTMLButtonElement;
    sv.addEventListener('click', () => d.onSave());
    const ld = this.el.settings.querySelector('#settings-load') as HTMLButtonElement;
    ld.addEventListener('click', () => d.onLoad());
    const nw = this.el.settings.querySelector('#settings-newworld') as HTMLButtonElement;
    nw.addEventListener('click', () => {
      if (confirm('Discard the current campaign and generate a new world?')) d.onNewWorld();
    });

    // Touch wiring.
    this.wireTouch();
  }

  private wireTouch(): void {
    const stick = (el: HTMLElement, onChange: (x: number, y: number) => void): void => {
      const knob = el.querySelector('.knob') as HTMLElement;
      let active = false;
      const rect = (): DOMRect => el.getBoundingClientRect();
      const handle = (e: PointerEvent): void => {
        if (!active) return;
        const r = rect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dx = (e.clientX - cx) / (r.width / 2);
        const dy = (e.clientY - cy) / (r.height / 2);
        const len = Math.hypot(dx, dy);
        const k = len > 1 ? 1 / len : 1;
        const nx = dx * k;
        const ny = dy * k;
        knob.style.transform = `translate(calc(-50% + ${nx * 34}px), calc(-50% + ${ny * 34}px))`;
        onChange(nx, ny);
      };
      el.addEventListener('pointerdown', (e) => {
        active = true;
        el.setPointerCapture(e.pointerId);
        handle(e);
        e.preventDefault();
      });
      el.addEventListener('pointermove', (e) => handle(e));
      const end = (e: PointerEvent): void => {
        active = false;
        knob.style.transform = 'translate(-50%, -50%)';
        onChange(0, 0);
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    };

    let lookDx = 0;
    let lookDy = 0;
    stick(this.el.touchLeft, (x, y) => {
      this.touchMove?.(x, y);
    });
    stick(this.el.touchRight, (x, y) => {
      lookDx = x * 14;
      lookDy = y * 14;
      this.touchLook?.(lookDx, lookDy);
    });

    for (const btn of this.el.touch.querySelectorAll<HTMLButtonElement>('.touch-btn')) {
      const action = btn.dataset.action as ActionName;
      const down = (e: PointerEvent): void => {
        e.preventDefault();
        this.touchButton?.(action, true);
        btn.style.background = 'rgba(201,138,60,0.4)';
      };
      const up = (e: PointerEvent): void => {
        e.preventDefault();
        this.touchButton?.(action, false);
        btn.style.background = '';
      };
      btn.addEventListener('pointerdown', down);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
      btn.addEventListener('pointerleave', up);
    }
  }

  /** Hooks installed by the game to route touch into the input manager. */
  touchMove: ((x: number, y: number) => void) | null = null;
  touchLook: ((dx: number, dy: number) => void) | null = null;
  touchButton: ((action: ActionName, down: boolean) => void) | null = null;

  // -- boot -----------------------------------------------------------------

  /** Register the callback for the boot screen's "Establish Link" button. */
  onEnter(fn: () => void): void {
    this.enterHandler = fn;
    this.el.bootEnter.addEventListener('click', () => this.enterHandler?.());
  }

  private enterHandler: (() => void) | null = null;

  startBootSequence(lines: string[]): void {
    this.el.bootLines.innerHTML = '';
    lines.forEach((l, i) => {
      const s = document.createElement('span');
      s.textContent = l;
      s.style.animationDelay = `${i * 0.55}s`;
      this.el.bootLines.appendChild(s);
    });
  }

  dismissBoot(): void {
    this.el.boot.classList.add('done');
    setTimeout(() => {
      this.el.boot.style.display = 'none';
    }, 1200);
  }

  // -- overlay --------------------------------------------------------------

  setOverlay(mode: OverlayMode): void {
    this.overlay = mode;
    for (const b of this.el.overlaySelector.querySelectorAll<HTMLButtonElement>('.overlay-btn')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    }
    this.paintLegend();
    this.deps.onOverlayChange(mode);
  }

  private paintLegend(): void {
    const items = OVERLAY_LEGEND[this.overlay];
    this.el.overlayLegend.innerHTML = '';
    for (const it of items) {
      const d = document.createElement('div');
      d.innerHTML = `<b>${it.label}</b><span>${it.low} → ${it.high}</span>`;
      this.el.overlayLegend.appendChild(d);
    }
  }

  // -- macro ----------------------------------------------------------------

  /** Called each frame while the macro view is active. */
  updateMacro(planetary: PlanetaryState, now: number, force = false): void {
    if (!force && now - this.lastMacroPaint < 120) return;
    this.lastMacroPaint = now;

    const health = planetary.globalHealth();
    this.el.healthFill.style.width = `${(health * 100).toFixed(1)}%`;
    this.el.healthPct.textContent = `${(health * 100).toFixed(0)}%`;
    this.el.instability.textContent = `instability ${(planetary.instability() * 100).toFixed(1)}`;
    const t = planetary.simTime;
    this.el.simTime.textContent = `t+${t < 3600 ? `${t.toFixed(0)}s` : `${(t / 3600).toFixed(1)}h`}`;

    for (const v of PLANETARY_VARS) {
      const e = this.varEls.get(v);
      if (!e) continue;
      const val = planetary.vars[v];
      const base = planetary.baselines[v];
      const dev = val - base;
      e.fill.style.width = `${(val * 100).toFixed(1)}%`;
      e.val.textContent = PlanetaryState.readout(v, val);
      const bad = varSense(v) === 'bad' ? val > 0.7 : val < 0.3;
      const worse = varSense(v) === 'bad' ? dev > 0.06 : dev < -0.06;
      e.row.classList.toggle('warn', bad && !worse);
      e.row.classList.toggle('crit', bad && worse);
    }
  }

  /** Rebuild the crisis list from runtimes. */
  setCrises(runtimes: CrisisRuntime[], selected: string | null): void {
    let resolved = 0;
    const live = new Set<string>();
    for (const rt of runtimes) {
      if (rt.status === 'RESOLVED') resolved++;
      live.add(rt.def.id);
      let row = this.crisisRows.get(rt.def.id);
      if (!row) row = this.buildCrisisRow(rt);
      this.updateCrisisRow(row, rt, selected === rt.def.id);
    }
    for (const [id, row] of this.crisisRows) {
      if (live.has(id)) continue;
      row.btn.remove();
      this.crisisRows.delete(id);
    }
    const count = `${resolved}/${runtimes.length}`;
    if (this.el.crisisCount.textContent !== count) this.el.crisisCount.textContent = count;
  }

  /** Create the DOM for one crisis. Runs once per crisis per session. */
  private buildCrisisRow(rt: CrisisRuntime): CrisisRow {
    const btn = document.createElement('button');
    btn.className = 'crisis-item';
    btn.dataset.id = rt.def.id;

    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = rt.def.name;
    const domain = document.createElement('span');
    domain.className = 'dom';
    domain.textContent = DOMAIN_LABEL[rt.def.domain];
    top.append(name, domain);

    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = rt.def.headline;

    const sev = document.createElement('div');
    sev.className = 'sev';
    const fill = document.createElement('i');
    fill.style.width = `${(rt.def.severity * 100).toFixed(0)}%`;
    sev.append(fill);

    const foot = document.createElement('div');
    foot.className = 'top';
    foot.style.marginTop = '4px';
    const state = document.createElement('span');
    state.className = 'dom';
    const pct = document.createElement('span');
    pct.className = 'dom';
    foot.append(state, pct);

    btn.append(top, head, sev, foot);
    btn.addEventListener('click', () => {
      this.selectedNodeId = rt.def.id;
      this.deps.onSelectNode(rt.def.id);
    });
    this.el.crisisItems.append(btn);

    const row: CrisisRow = {
      btn,
      domain,
      state,
      pct,
      status: '',
      pctText: '',
      aria: '',
    };
    this.crisisRows.set(rt.def.id, row);
    return row;
  }

  /** Push the live status of one crisis into its row. */
  private updateCrisisRow(row: CrisisRow, rt: CrisisRuntime, isSelected: boolean): void {
    if (row.btn.dataset.status !== rt.status) row.btn.dataset.status = rt.status;
    const prog =
      rt.def.objectives.reduce((sum, o) => sum + Math.min(1, (rt.progress[o.id] ?? 0) / o.target), 0) /
      Math.max(1, rt.def.objectives.length);
    const stateText =
      rt.status === 'RESOLVED'
        ? 'stabilised'
        : rt.status === 'LOCKED'
          ? `requires ${rt.def.requiresSpires} spires`
          : rt.status === 'ACTIVE'
            ? 'in progress'
            : 'available';
    if (row.state.textContent !== stateText) row.state.textContent = stateText;
    const pctText = `${(prog * 100).toFixed(0)}%`;
    if (row.pctText !== pctText) {
      row.pctText = pctText;
      row.pct.textContent = pctText;
    }
    const aria = `${rt.def.name}, ${rt.status}`;
    if (row.aria !== aria) {
      row.aria = aria;
      row.btn.setAttribute('aria-label', aria);
    }
    row.btn.style.background = isSelected ? 'rgba(224,176,96,0.14)' : '';
  }

  // -- HUD ------------------------------------------------------------------

  setHud(model: HudModel | null): void {
    if (!model) {
      this.el.hud.classList.remove('active');
      this.gaugeEls.clear();
      this.el.gauges.innerHTML = '';
      return;
    }
    this.el.hud.classList.add('active');
    this.el.hudName.textContent = model.title;
    this.el.hudSub.textContent = model.subtitle;

    // Rebuild gauges only when the gauge set changes.
    const sig = model.gauges.map((g) => g.key).join('|');
    if (this.el.gauges.dataset.sig !== sig) {
      this.el.gauges.dataset.sig = sig;
      this.el.gauges.innerHTML = '';
      this.gaugeEls.clear();
      for (const g of model.gauges) {
        const d = document.createElement('div');
        d.className = 'gauge';
        d.innerHTML = `<div class="lbl"><span>${g.label}</span></div><div class="val"><span class="num">--</span><span class="unit">${g.unit}</span></div><div class="meter"><i style="width:0%"></i></div>`;
        this.el.gauges.appendChild(d);
        this.gaugeEls.set(g.key, {
          root: d,
          fill: d.querySelector('.meter > i') as HTMLElement,
          val: d.querySelector('.num') as HTMLElement,
        });
      }
    }

    for (const g of model.gauges) {
      const e = this.gaugeEls.get(g.key);
      if (!e) continue;
      const span = g.max - g.min;
      const pct = span > 0 ? Math.max(0, Math.min(1, (g.value - g.min) / span)) : 0;
      e.fill.style.width = `${(pct * 100).toFixed(1)}%`;
      e.val.textContent = g.text ?? formatGaugeValue(g.value);
      e.root.classList.toggle('warn', !!g.warn && !g.crit);
      e.root.classList.toggle('crit', !!g.crit);
    }

    // Flags.
    const fsig = model.flags.map((f) => f.label).join('|');
    if (this.el.flags.dataset.sig !== fsig) {
      this.el.flags.dataset.sig = fsig;
      this.el.flags.innerHTML = '';
      this.flagEls.clear();
      for (const f of model.flags) {
        const d = document.createElement('div');
        d.className = 'flag';
        d.textContent = f.label;
        this.el.flags.appendChild(d);
        this.flagEls.set(f.label, d);
      }
    }
    for (const f of model.flags) {
      const d = this.flagEls.get(f.label);
      if (!d) continue;
      d.classList.toggle('on', f.on);
      const alert = /overheat|stall|collapse|fade|fail/i.test(f.label) && f.on;
      d.classList.toggle('alert', alert);
    }

    this.el.readout.textContent = model.readout + (model.target ? `  ·  mass ${model.target}` : '');

    // Objectives.
    this.el.objBody.innerHTML = '';
    let done = 0;
    for (const o of model.objectives) {
      const d = document.createElement('div');
      d.className = `obj${o.done ? ' done' : ''}`;
      d.innerHTML = `<span class="bar"><i style="width:${(o.progress * 100).toFixed(0)}%"></i></span><span>${o.text}</span>`;
      this.el.objBody.appendChild(d);
      if (o.done) done++;
    }
    this.el.objCount.textContent = model.objectives.length ? `${done}/${model.objectives.length}` : '';
  }

  setTouchVisible(visible: boolean): void {
    this.el.touch.classList.toggle('active', visible && this.settings.touchControls);
  }

  // -- briefing -------------------------------------------------------------

  openBriefing(data: BriefingData): void {
    const { node } = data;
    this.briefingNodeId = node.id;
    this.el.briefTitle.textContent = node.name;
    this.el.briefDomain.textContent = `${DOMAIN_LABEL[node.domain]} · vehicle ${node.vehicle.replace(/_/g, ' ').toLowerCase()}`;
    this.el.briefBrief.textContent = node.brief;

    const canStart = data.canStart && (data.status === 'AVAILABLE' || data.status === 'ACTIVE');
    if (this.el.briefLockReason) {
      if (!canStart && data.lockReason) {
        this.el.briefLockReason.textContent = `LOCKED · ${data.lockReason}`;
        this.el.briefLockReason.classList.add('visible');
      } else {
        this.el.briefLockReason.textContent = '';
        this.el.briefLockReason.classList.remove('visible');
      }
    }

    this.el.briefObjectives.innerHTML = '';
    for (const o of data.objectives) {
      const li = document.createElement('li');
      const pct = Math.round((o.progress ?? 0) * 100);
      li.textContent = pct > 0 && !o.done ? `${o.text} (${pct}%)` : o.text;
      if (o.done) li.style.color = 'var(--good)';
      this.el.briefObjectives.appendChild(li);
    }

    this.el.briefForecast.innerHTML = '';
    const rows: { key: PlanetaryVar; label: string; delta: number }[] = [];
    for (const k of Object.keys(node.resolution) as PlanetaryVar[]) {
      const base = this.deps.planetary.vars[k];
      const next = data.forecast.vars[k];
      rows.push({ key: k, label: varLabel(k), delta: next - base });
    }
    rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'row';
      // Evaluate whether the delta improves planetary health according to varSense.
      const polarity = varSense(r.key) === 'good' ? 1 : -1;
      const improvement = r.delta * polarity;
      const cls = improvement > 0.001 ? 'up' : improvement < -0.001 ? 'down' : 'neutral';
      const sign = r.delta > 0 ? '+' : '';
      d.innerHTML = `<span class="lbl">${r.label}</span><span class="delta ${cls}">${sign}${(r.delta * 100).toFixed(1)}%</span>`;
      this.el.briefForecast.appendChild(d);
    }
    const chain = document.createElement('div');
    chain.className = 'chain';
    chain.textContent = data.forecast.chain.length
      ? data.forecast.chain.slice(0, 5).join(' · ')
      : 'No significant coupling predicted at this horizon.';
    this.el.briefForecast.appendChild(chain);

    this.el.briefArchive.innerHTML = '';
    for (const a of node.archive) {
      const d = document.createElement('div');
      d.textContent = `— ${a}`;
      d.style.color = 'var(--text-faint)';
      d.style.fontSize = '0.6rem';
      this.el.briefArchive.appendChild(d);
    }

    (this.el.briefDescend as HTMLButtonElement).disabled = !canStart;
    this.el.briefDescend.textContent = data.status === 'RESOLVED' ? 'Stabilised' : data.status === 'ACTIVE' ? 'Resume Descent' : 'Descend';
    this.el.briefAbort.style.display = data.status === 'ACTIVE' ? '' : 'none';

    this.el.briefing.classList.add('open');
    if (canStart) this.el.briefDescend.focus();
    else this.el.briefClose.focus();
  }

  closeBriefing(): void {
    this.el.briefing.classList.remove('open');
    this.briefingNodeId = null;
  }

  get isBriefingOpen(): boolean {
    return this.el.briefing.classList.contains('open');
  }

  // -- settings -------------------------------------------------------------

  openSettings(): void {
    this.buildSettings();
    this.el.settings.classList.add('open');
  }

  closeSettings(): void {
    this.el.settings.classList.remove('open');
  }

  get isSettingsOpen(): boolean {
    return this.el.settings.classList.contains('open');
  }

  applySettings(s: SettingsRecord): void {
    this.settings = { ...s };
    document.body.classList.toggle('large-text', s.largeText);
    document.body.classList.toggle('high-contrast', s.highContrast);
    document.body.classList.toggle('reduced-motion', s.reducedMotion);
    this.el.perf.classList.toggle('on', s.showPerf);
    if (this.el.touch.classList.contains('active')) this.setTouchVisible(true);
  }

  // -- perf -----------------------------------------------------------------

  setPerf(m: ReturnType<import('../core/perf').PerformanceMonitor['metrics']>): void {
    const rows: [string, string][] = [
      ['FPS', m.fps.toFixed(0)],
      ['frame', `${m.frameMs.toFixed(2)} ms`],
      ['worst', `${m.worstFrameMs.toFixed(1)} ms`],
      ['draws', String(m.drawCalls)],
      ['tris', formatCount(m.triangles)],
      ['geos', String(m.geometries)],
      ['tex', String(m.textures)],
      ['entities', String(m.activeEntities)],
      ['chunks', String(m.loadedChunks)],
      ['heap', `${m.jsHeapMb.toFixed(0)} MB`],
      ['tier', `${m.tier}${m.adaptive ? ' (auto)' : ''}`],
    ];
    let html = '';
    for (const [k, v] of rows) html += `<div class="row"><span>${k}</span><b>${v}</b></div>`;
    this.el.perf.innerHTML = html;
  }

  // -- toasts ---------------------------------------------------------------

  toast(message: string, kind = ''): void {
    if (!message) return;
    const d = document.createElement('div');
    d.className = `toast ${kind}`;
    d.textContent = message;
    this.el.toasts.appendChild(d);
    setTimeout(() => {
      d.style.opacity = '0';
      d.style.transition = 'opacity 0.4s';
      setTimeout(() => d.remove(), 450);
    }, 4200);
    while (this.el.toasts.children.length > 4) this.el.toasts.firstChild?.remove();
  }

  // -- harmonic banner ------------------------------------------------------

  setHarmonicState(coherence: number, functional: number, total: number, unlocked: boolean): void {
    // Progress is always legible: the Harmonic is a long-term goal and the
    // player needs to see how close the network is, not just whether it landed.
    const pct = Math.round(coherence * 100);
    const state = unlocked && coherence > 0.85 ? 'phase-coherent' : `${pct}% coherent`;
    this.el.harmonicBanner.textContent = `Terminus Harmonic · ${state} · ${functional}/${total} spires`;
    this.el.harmonicBanner.classList.toggle('coherent', unlocked && coherence > 0.6);
  }

  setMode(mode: 'MACRO' | 'ORBIT' | 'SECTOR'): void {
    this.el.macro.classList.toggle('hidden', mode !== 'MACRO');
    this.setTouchVisible(mode !== 'MACRO');
  }

  setSelectedNode(id: string | null): void {
    this.selectedNodeId = id;
    for (const [cid, row] of this.crisisRows) {
      row.btn.style.background = cid === id ? 'rgba(224,176,96,0.14)' : '';
    }
  }

  selectSpire(spireId: number): void {
    this.selectedSpireId = spireId;
  }

  /** Render live camera mode and machine control chips on the sector HUD. */
  setVehicleTelemetry(cameraMode: string, controls: { label: string; detail: string }[]): void {
    if (this.el.hudCamMode) {
      const txt = `CAM · ${cameraMode}`;
      if (this.el.hudCamMode.textContent !== txt) this.el.hudCamMode.textContent = txt;
    }
    if (this.el.hudControls) {
      const sig = controls.map((c) => `${c.label}:${c.detail}`).join('|');
      if (this.el.hudControls.dataset.sig !== sig) {
        this.el.hudControls.dataset.sig = sig;
        this.el.hudControls.innerHTML = '';
        for (const c of controls) {
          const chip = document.createElement('span');
          chip.className = 'hud-ctrl-chip';
          chip.innerHTML = `<kbd>${c.label}</kbd>${c.detail}`;
          this.el.hudControls.appendChild(chip);
        }
      }
    }
  }

  /** Update the polar phase-lock instrument and selected spire telemetry. */
  updateHarmonicScope(
    spires: SpireRecord[],
    phases: number[],
    locks: number[],
    refPhase: number,
    coverage: number,
    phaseOrder: number,
    selectedSpireId = this.selectedSpireId,
  ): void {
    this.selectedSpireId = selectedSpireId;
    const functionalCount = spires.filter((s) => s.functional).length;
    if (this.el.harmonicOrderPct) {
      this.el.harmonicOrderPct.textContent = `${Math.round(coverage * phaseOrder * 100)}% lock`;
    }
    if (this.el.harmonicCovVal) {
      this.el.harmonicCovVal.textContent = `${functionalCount}/${spires.length}`;
    }
    if (this.el.harmonicOrdVal) {
      this.el.harmonicOrdVal.textContent = `${Math.round(phaseOrder * 100)}%`;
    }
    if (this.el.harmonicRefNeedle) {
      const rad = ((refPhase - 90) * Math.PI) / 180;
      this.el.harmonicRefNeedle.setAttribute('x2', (Math.cos(rad) * 48).toFixed(2));
      this.el.harmonicRefNeedle.setAttribute('y2', (Math.sin(rad) * 48).toFixed(2));
    }
    if (this.el.harmonicSpireDots) {
      const ns = 'http://www.w3.org/2000/svg';
      while (this.el.harmonicSpireDots.children.length < spires.length) {
        const idx = this.el.harmonicSpireDots.children.length;
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('r', '3.1');
        c.style.cursor = 'pointer';
        c.addEventListener('click', () => {
          this.selectedSpireId = idx;
          this.deps.onPingSpire?.(idx);
        });
        this.el.harmonicSpireDots.appendChild(c);
      }
      for (let i = 0; i < spires.length; i++) {
        const s = spires[i];
        const c = this.el.harmonicSpireDots.children[i] as SVGCircleElement;
        const ph = phases[i] ?? s.phase;
        const lk = locks[i] ?? (s.functional ? 0.8 : 0.1);
        const r = s.functional ? 44 - lk * 28 : 48;
        const rad = ((ph - 90) * Math.PI) / 180;
        c.setAttribute('cx', (Math.cos(rad) * r).toFixed(2));
        c.setAttribute('cy', (Math.sin(rad) * r).toFixed(2));
        c.setAttribute('fill', s.functional ? '#4fc4ef' : '#4a555d');
        c.setAttribute('stroke', i === this.selectedSpireId ? '#f0c068' : 'none');
        c.setAttribute('stroke-width', i === this.selectedSpireId ? '1.4' : '0');
        c.setAttribute('r', i === this.selectedSpireId ? '4.2' : s.functional ? '3.1' : '2.3');
      }
    }
    const sel = spires[this.selectedSpireId] ?? spires[0];
    const def = ACOUSTIC_SPIRES[sel?.id ?? 0];
    if (sel && def && this.el.spireNameLbl && this.el.spireMetaLbl) {
      this.el.spireNameLbl.textContent = def.name;
      const ph = phases[sel.id] ?? sel.phase;
      let diff = ((ph - refPhase) % 360 + 540) % 360 - 180;
      if (!Number.isFinite(diff)) diff = 0;
      const status = sel.functional ? `Δ${Math.abs(diff).toFixed(0)}° · ${sel.repairs} sync` : 'offline · uncalibrated';
      this.el.spireMetaLbl.textContent = `${def.baseFreq} Hz · ${status}`;
    }
  }

  /** Update the settlement viability ledger and unlocked domain modules. */
  updateLedger(settlements: SettlementRuntime[], unlockedModules: string[]): void {
    if (this.el.settlementGrid) {
      if (this.el.settlementGrid.children.length !== settlements.length) {
        this.el.settlementGrid.innerHTML = '';
        for (const s of settlements) {
          const r = document.createElement('div');
          r.className = 'settlement-row';
          r.dataset.id = s.id;
          r.innerHTML = `<span>${s.name.split(' ')[0]}</span><b>--</b>`;
          this.el.settlementGrid.appendChild(r);
        }
      }
      let sum = 0;
      for (let i = 0; i < settlements.length; i++) {
        const s = settlements[i];
        sum += s.viability;
        const b = this.el.settlementGrid.children[i]?.querySelector('b');
        if (b) b.textContent = `${Math.round(s.viability * 100)}%`;
      }
      if (this.el.ledgerAvg && settlements.length > 0) {
        this.el.ledgerAvg.textContent = `avg ${Math.round((sum / settlements.length) * 100)}%`;
      }
    }
    if (this.el.moduleTags) {
      const sig = unlockedModules.join('|');
      if (this.el.moduleTags.dataset.sig !== sig) {
        this.el.moduleTags.dataset.sig = sig;
        this.el.moduleTags.innerHTML = '';
        for (const m of unlockedModules) {
          const t = document.createElement('span');
          t.className = 'module-tag';
          t.textContent = m;
          this.el.moduleTags.appendChild(t);
        }
      }
    }
  }

  /** Position and populate the 3D-projected floating reticle callout on the globe. */
  updateGlobeReticle(
    reticle: {
      visible: boolean;
      x: number;
      y: number;
      kind: 'node' | 'spire';
      title: string;
      tag: string;
      sub: string;
      actionLabel: string;
      nodeId?: string;
      spireId?: number;
    } | null,
  ): void {
    if (!this.el.globeReticle) return;
    if (!reticle || !reticle.visible) {
      this.el.globeReticle.classList.remove('visible');
      return;
    }
    this.el.globeReticle.classList.add('visible');
    this.el.globeReticle.style.left = `${reticle.x.toFixed(1)}px`;
    this.el.globeReticle.style.top = `${reticle.y.toFixed(1)}px`;
    this.el.reticleCard.classList.toggle('spire', reticle.kind === 'spire');
    if (this.el.reticleTitle.textContent !== reticle.title) this.el.reticleTitle.textContent = reticle.title;
    if (this.el.reticleTag.textContent !== reticle.tag) this.el.reticleTag.textContent = reticle.tag;
    if (this.el.reticleSub.textContent !== reticle.sub) this.el.reticleSub.textContent = reticle.sub;
    if (this.el.reticleAction.textContent !== reticle.actionLabel) {
      this.el.reticleAction.textContent = reticle.actionLabel;
    }
    if (reticle.nodeId) {
      this.el.reticleAction.dataset.nodeId = reticle.nodeId;
      delete this.el.reticleAction.dataset.spireId;
    } else if (reticle.spireId !== undefined) {
      this.el.reticleAction.dataset.spireId = String(reticle.spireId);
      delete this.el.reticleAction.dataset.nodeId;
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}

function formatGaugeValue(v: number): string {
  if (!Number.isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function prettyCode(code: string): string {
  return code
    .replace('Key', '')
    .replace('Digit', '')
    .replace('Arrow', '↕')
    .replace('Left', '←')
    .replace('Right', '→')
    .replace('Up', '↑')
    .replace('Down', '↓')
    .replace('Shift', 'Sh')
    .replace('Control', 'Ctrl')
    .replace('Space', 'Spc')
    .replace('Mouse', 'M');
}
