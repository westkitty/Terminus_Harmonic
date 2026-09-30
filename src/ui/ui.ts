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
  couplingRules,
  varLabel,
  varSense,
  varUnit,
  type PlanetaryVar,
} from '../state/planetary';
import {
  ACOUSTIC_SPIRES,
  ARCHIVAL_REFERENCES,
  BIOME_LABEL,
  CANON_FACTS,
  DOMAINS,
  DOMAIN_LABEL,
  GAME_LOCAL_INVENTIONS,
  MATERIALS,
  type BiomeId,
  type CrisisNodeDef,
  type Domain,
} from '../state/world';
import { VEHICLE_SPECS, domainBadgeSvg, vehicleBlueprintSvg } from './schematics';
import type { CrisisRuntime } from '../game/crisis';
import type { HudModel } from '../vehicle/base';
import { ACTION_LABELS, DEFAULT_BINDINGS, type ActionName } from '../core/input';
import type { SettingsRecord, SpireRecord } from '../state/save';
import type { QualityTier } from '../core/perf';
import type { SettlementRuntime } from '../systems/systems';

export type CodexTab = 'DOMAINS' | 'BLUEPRINTS' | 'PROVENANCE' | 'LOG';

export interface BriefingData {
  node: CrisisNodeDef;
  status: CrisisRuntime['status'];
  objectives: { text: string; progress: number; done: boolean }[];
  forecast: { vars: Record<PlanetaryVar, number>; chain: string[] };
  canStart: boolean;
  lockReason?: string;
  unlockedModules?: string[];
  domainPoints?: Record<string, number>;
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
  onResetBindings?: () => void;
  onSave: () => void;
  onLoad: () => void;
  onExport: () => void;
  onImport: (text: string) => void;
  onNewWorld: () => void;
  onCycleCamera: () => void;
  onPingSpire?: (spireId: number) => void;
  onSelectSettlement?: (settlementId: string) => void;
  onAbandonCrisis?: (id: string) => void;
  onTimeWarpChange?: (multiplier: number) => void;
  onToggleMute?: () => boolean;
  onSnapCamera?: (angle: 'EQUATOR' | 'NORTH_POLE' | 'SOUTH_POLE' | 'RESET') => void;
  onCopySave?: () => Promise<void>;
  onPasteSave?: (text: string) => void;
  onSoundTrigger?: (sound: 'click' | 'hover' | 'modalOpen' | 'modalClose' | 'warning' | 'success') => void;
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
  private selectedSettlementId: string | null = null;
  private selectedPlanetaryVar: PlanetaryVar | null = 'harmonicCoherence';
  private codexTab: CodexTab = 'DOMAINS';
  private codexData: {
    domainPoints: Record<string, number>;
    unlockedModules: string[];
    log: { t: number; text: string }[];
  } = { domainPoints: {}, unlockedModules: [], log: [] };
  private rebindingAction: ActionName | null = null;
  private timeWarpMultiplier = 1;
  private isAudioMuted = false;
  private crisisFilterDomain: Domain | 'ALL' = 'ALL';
  private crisisSearchText = '';
  private codexSearchText = '';
  private readCodexModules = new Set<string>();
  private tooltipEl: HTMLElement | null = null;
  private lastCrisesList: CrisisRuntime[] = [];

  get currentTimeWarp(): number {
    return this.timeWarpMultiplier;
  }

  get audioMuted(): boolean {
    return this.isAudioMuted;
  }

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

  private cancelRebinding: (() => void) | null = null;
  private reticleHovered = false;

  get isReticleHovered(): boolean {
    return this.reticleHovered;
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
      <div id="coord-bar">
        <span>SURVEY: <b id="coord-latlon">--° N · --° E</b></span>
        <span>ELEV: <b id="coord-elev">-- m</b></span>
        <span class="coord-biome" id="coord-biome">--</span>
      </div>
      <div class="macro-row">
        <div class="macro-block panel" id="planetary-health">
          <div class="panel-title"><span>Planetary State</span><span id="health-pct">--</span></div>
          <div class="body">
            <div class="health-bar"><i id="health-fill" style="width:0%"></i></div>
            <div class="health-meta">
              <span id="instability">instability --</span>
              <span id="sim-time">t+0</span>
              <div id="time-warp-bar" title="Simulation Speed [Space: Pause, [ / ]: Speed]">
                <button class="time-warp-btn" data-speed="0" type="button" title="Pause simulation [Space]">||</button>
                <button class="time-warp-btn active" data-speed="1" type="button" title="1x Real-time speed">1x</button>
                <button class="time-warp-btn" data-speed="2" type="button" title="2x Speed [ ] ]">2x</button>
                <button class="time-warp-btn" data-speed="5" type="button" title="5x Warp speed [ ] ]">5x</button>
              </div>
            </div>
            <div class="var-grid" id="var-grid"></div>
            <div class="var-inspector" id="var-inspector" aria-live="polite"></div>
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
            <div class="crisis-filter-bar" id="crisis-filters">
              <button class="crisis-filter-pill active" data-domain="ALL" type="button">All</button>
              <button class="crisis-filter-pill" data-domain="ATMOSPHERE" type="button">Air</button>
              <button class="crisis-filter-pill" data-domain="CRYOSPHERE" type="button">Ice</button>
              <button class="crisis-filter-pill" data-domain="CRUST" type="button">Crust</button>
              <button class="crisis-filter-pill" data-domain="BIOSPHERE" type="button">Bio</button>
              <button class="crisis-filter-pill" data-domain="HARMONIC" type="button">Harmonic</button>
            </div>
            <input type="text" class="search-input" id="crisis-search" placeholder="Filter crises…" aria-label="Filter crises" />
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
    this.el.varInspector = macro.querySelector('#var-inspector') as HTMLElement;
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

    this.el.globeReticle.addEventListener('pointerenter', () => {
      this.reticleHovered = true;
    });
    this.el.globeReticle.addEventListener('pointerleave', () => {
      this.reticleHovered = false;
    });

    // Overlay buttons.
    OVERLAY_MODES.forEach((mode, idx) => {
      const b = document.createElement('button');
      b.className = 'overlay-btn';
      b.textContent = OVERLAY_LABEL[mode];
      b.title = `${OVERLAY_LABEL[mode]} [Key ${idx + 1}]`;
      b.setAttribute('aria-pressed', String(mode === this.overlay));
      b.dataset.mode = mode;
      b.dataset.shortcut = String(idx + 1);
      b.addEventListener('click', () => this.setOverlay(mode));
      this.el.overlaySelector.appendChild(b);
    });

    // Variable rows.
    for (const v of PLANETARY_VARS) {
      const row = document.createElement('div');
      row.className = 'var-row';
      row.dataset.var = v;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-pressed', String(v === this.selectedPlanetaryVar));
      row.title = `Inspect causal couplings for ${varLabel(v)} (${varUnit(v)})`;
      row.innerHTML = `<span class="name">${varLabel(v)}</span><span class="tick"><i></i></span><span class="val">--</span>`;
      row.addEventListener('click', () => {
        this.selectPlanetaryVar(this.selectedPlanetaryVar === v ? null : v);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.selectPlanetaryVar(this.selectedPlanetaryVar === v ? null : v);
        }
      });
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
            <button class="btn" id="hud-mute-btn" type="button" title="Mute/Unmute Audio [U]">Audio</button>
            <button class="btn" id="hud-codex-btn" type="button" title="Open Survey Archive &amp; Codex [C]">Archive [C]</button>
            <button class="btn" id="hud-ascend-btn" type="button" title="Return to Command Lattice [ESC]">Lattice [ESC]</button>
            <button class="btn" id="hud-settings-btn" type="button" title="Open Configuration">Config</button>
          </div>
        </div>
        <div class="panel" id="objectives">
          <div class="panel-title"><span>Engineering Tasks</span><span id="obj-count"></span></div>
          <div class="body" id="obj-body"></div>
        </div>
      </div>
      <div id="gpws-alert">⚠ TERRAIN PULL UP ⚠</div>
      <div id="sector-waypoint">
        <div class="wp-icon">◆</div>
        <div class="wp-dist" id="wp-dist-lbl">-- m</div>
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
    this.el.hudMuteBtn = hud.querySelector('#hud-mute-btn') as HTMLButtonElement;
    this.el.hudCodexBtn = hud.querySelector('#hud-codex-btn') as HTMLButtonElement;
    this.el.hudAscendBtn = hud.querySelector('#hud-ascend-btn') as HTMLButtonElement;
    this.el.hudSettingsBtn = hud.querySelector('#hud-settings-btn') as HTMLButtonElement;
    this.el.hudControls = hud.querySelector('#hud-controls') as HTMLElement;
    this.el.gpwsAlert = hud.querySelector('#gpws-alert') as HTMLElement;
    this.el.sectorWaypoint = hud.querySelector('#sector-waypoint') as HTMLElement;
    this.el.wpDistLbl = hud.querySelector('#wp-dist-lbl') as HTMLElement;

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
          <div class="briefing-blueprint" id="briefing-blueprint"></div>
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
    this.el.briefBlueprint = brief.querySelector('#briefing-blueprint') as HTMLElement;
    this.el.briefObjectives = brief.querySelector('#briefing-objectives') as HTMLElement;
    this.el.briefForecast = brief.querySelector('#briefing-forecast') as HTMLElement;
    this.el.briefArchive = brief.querySelector('#briefing-archive') as HTMLElement;
    this.el.briefDescend = brief.querySelector('#briefing-descend') as HTMLButtonElement;
    this.el.briefAbort = brief.querySelector('#briefing-abort') as HTMLButtonElement;
    this.el.briefClose = brief.querySelector('#briefing-close') as HTMLButtonElement;

    // --- abandon confirmation popover ---
    const abandonConfirm = document.createElement('div');
    abandonConfirm.id = 'abandon-confirm';
    abandonConfirm.innerHTML = `
      <div class="abandon-card">
        <h3>Confirm Abort</h3>
        <p>Abort current descent and return to the Command Lattice? Unfinished repairs will be lost.</p>
        <div class="abandon-actions">
          <button class="btn" id="abandon-cancel-btn" type="button">Stay in Sector</button>
          <button class="btn primary" id="abandon-ok-btn" type="button">Confirm Abandon</button>
        </div>
      </div>
    `;
    root.appendChild(abandonConfirm);
    this.el.abandonConfirm = abandonConfirm;
    this.el.abandonCancelBtn = abandonConfirm.querySelector('#abandon-cancel-btn') as HTMLButtonElement;
    this.el.abandonOkBtn = abandonConfirm.querySelector('#abandon-ok-btn') as HTMLButtonElement;

    // --- survey archive & engineering codex modal ---
    const codex = document.createElement('div');
    codex.id = 'codex';
    codex.setAttribute('role', 'dialog');
    codex.setAttribute('aria-modal', 'true');
    codex.setAttribute('aria-labelledby', 'codex-title');
    codex.innerHTML = `
      <div class="codex-card">
        <header>
          <div>
            <h2 id="codex-title">Survey Archive &amp; Engineering Codex</h2>
            <div class="domain">0-ARK Field Manual · Provenance &amp; Subsystem Registry</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn" id="codex-mark-read" type="button" style="font-size:0.68rem">Mark All Read</button>
            <button class="btn" id="codex-close" type="button">Close</button>
          </div>
        </header>
        <div style="padding: 0 16px 6px 16px">
          <input type="text" class="search-input" id="codex-search" placeholder="Search archive lore, blueprints, materials, or log…" aria-label="Search Codex" />
        </div>
        <div class="codex-tabs" id="codex-tabs" role="tablist">
          <button class="codex-tab" role="tab" data-tab="DOMAINS" aria-selected="true" type="button">Domains &amp; Modules</button>
          <button class="codex-tab" role="tab" data-tab="BLUEPRINTS" aria-selected="false" type="button">Blueprints &amp; Biomes</button>
          <button class="codex-tab" role="tab" data-tab="PROVENANCE" aria-selected="false" type="button">Archival Provenance</button>
          <button class="codex-tab" role="tab" data-tab="LOG" aria-selected="false" type="button">Engineering Log</button>
        </div>
        <div class="codex-body" id="codex-body"></div>
      </div>
    `;
    root.appendChild(codex);
    this.el.codex = codex;
    this.el.codexTabs = codex.querySelector('#codex-tabs') as HTMLElement;
    this.el.codexBody = codex.querySelector('#codex-body') as HTMLElement;
    this.el.codexClose = codex.querySelector('#codex-close') as HTMLButtonElement;
    this.el.codexSearch = codex.querySelector('#codex-search') as HTMLInputElement;
    this.el.codexMarkRead = codex.querySelector('#codex-mark-read') as HTMLButtonElement;

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
          <button class="btn" id="settings-copy-save" type="button" title="Copy full campaign save code to clipboard">Copy Save</button>
          <button class="btn" id="settings-paste-save" type="button" title="Load campaign save code from clipboard">Paste Save</button>
          <button class="btn" id="settings-export">Export</button>
          <button class="btn" id="settings-import">Import</button>
          <button class="btn" id="settings-save">Save Now [F5]</button>
          <button class="btn" id="settings-load">Load [F9]</button>
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
    toasts.setAttribute('role', 'status');
    toasts.setAttribute('aria-live', 'polite');
    root.appendChild(toasts);
    this.el.toasts = toasts;

    // --- harmonic banner ---
    const banner = document.createElement('div');
    banner.id = 'harmonic-banner';
    banner.textContent = 'Terminus Harmonic · dormant';
    root.appendChild(banner);
    this.el.harmonicBanner = banner;

    // --- universal tooltip ---
    const tooltip = document.createElement('div');
    tooltip.id = 'ui-tooltip';
    root.appendChild(tooltip);
    this.tooltipEl = tooltip;

    this.buildSettings();
    this.selectPlanetaryVar(this.selectedPlanetaryVar);
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
    const intervals = [
      { v: '0', l: 'Disabled' },
      { v: '1', l: 'Every 1 minute' },
      { v: '3', l: 'Every 3 minutes' },
      { v: '5', l: 'Every 5 minutes' },
      { v: '10', l: 'Every 10 minutes' },
    ];
    gDisplay.appendChild(
      this.row(
        'Auto-save interval',
        this.select(intervals, String(this.settings.autoSaveIntervalMinutes ?? 5), (v) =>
          this.deps.onSettingsChange({ autoSaveIntervalMinutes: Number(v) }),
        ),
      ),
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
    const volumeRow = (label: string, initial: number, onChange: (n: number) => void): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = '8px';
      const val = document.createElement('span');
      val.className = 'value';
      val.textContent = `${Math.round(initial * 100)}%`;
      const s = slider(initial, (n) => {
        val.textContent = `${Math.round(n * 100)}%`;
        onChange(n);
      });
      wrap.append(s, val);
      return this.row(label, wrap);
    };
    gAudio.appendChild(volumeRow('Master volume', this.settings.masterVolume, (n) => this.deps.onSettingsChange({ masterVolume: n })));
    gAudio.appendChild(volumeRow('Machinery / impact', this.settings.sfxVolume, (n) => this.deps.onSettingsChange({ sfxVolume: n })));
    gAudio.appendChild(volumeRow('Ambient / atmosphere', this.settings.ambientVolume, (n) => this.deps.onSettingsChange({ ambientVolume: n })));
    gAudio.appendChild(volumeRow('Terminus Harmonic', this.settings.musicVolume, (n) => this.deps.onSettingsChange({ musicVolume: n })));

    // --- accessibility ---
    const gA11y = group('Accessibility');
    gA11y.appendChild(
      this.row('Reduced motion', this.checkbox(this.settings.reducedMotion, (v) => this.deps.onSettingsChange({ reducedMotion: v }))),
    );
    gA11y.appendChild(
      this.row('High contrast', this.checkbox(this.settings.highContrast, (v) => this.deps.onSettingsChange({ highContrast: v }))),
    );
    gA11y.appendChild(
      this.row(
        'Colorblind mode',
        this.checkbox(this.settings.colorblindMode ?? false, (v) => {
          this.deps.onSettingsChange({ colorblindMode: v });
          document.body.classList.toggle('colorblind-mode', v);
        }),
      ),
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
        this.cancelRebinding?.();
        this.rebindingAction = action;
        btn.textContent = 'Press a key (Esc to cancel)…';
        const cleanup = (): void => {
          window.removeEventListener('keydown', onKey, true);
          btn.textContent = 'Rebind';
          this.rebindingAction = null;
          this.cancelRebinding = null;
        };
        const onKey = (e: KeyboardEvent): void => {
          e.preventDefault();
          e.stopPropagation();
          cleanup();
          if (e.code === 'Escape') return;
          this.deps.onRebind(action, e.code);
          this.settings = { ...this.settings, bindings: { ...this.settings.bindings, [action]: [e.code] } };
          renderKeys();
        };
        this.cancelRebinding = cleanup;
        window.addEventListener('keydown', onKey, true);
      });
      row.append(lbl, keys, btn);
      gControls.appendChild(row);
    }

    const resetRow = document.createElement('div');
    resetRow.style.marginTop = '8px';
    resetRow.style.display = 'flex';
    resetRow.style.justifyContent = 'flex-end';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn';
    resetBtn.id = 'settings-reset-binds';
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset Controls to Default';
    resetBtn.addEventListener('click', () => {
      const defaults: Record<string, string[]> = {};
      for (const k of Object.keys(DEFAULT_BINDINGS) as ActionName[]) {
        defaults[k] = [...DEFAULT_BINDINGS[k]];
      }
      this.settings = { ...this.settings, bindings: defaults };
      this.deps.onResetBindings?.();
      this.deps.onSettingsChange({ bindings: defaults });
      this.buildSettings();
    });
    resetRow.appendChild(resetBtn);
    gControls.appendChild(resetRow);
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
    this.el.bootEnter.addEventListener('click', () => {
      this.deps.onSoundTrigger?.('click');
      this.dismissBoot();
    });
    this.el.briefClose.addEventListener('click', () => {
      this.deps.onSoundTrigger?.('modalClose');
      this.closeBriefing();
    });
    this.el.briefDescend.addEventListener('click', () => {
      this.deps.onSoundTrigger?.('click');
      if (this.briefingNodeId) this.deps.onStartCrisis(this.briefingNodeId);
    });
    this.el.briefAbort.addEventListener('click', () => {
      this.el.abandonConfirm.classList.add('open');
      this.deps.onSoundTrigger?.('warning');
    });
    this.el.abandonCancelBtn?.addEventListener('click', () => {
      this.el.abandonConfirm.classList.remove('open');
      this.deps.onSoundTrigger?.('click');
    });
    this.el.abandonOkBtn?.addEventListener('click', () => {
      this.el.abandonConfirm.classList.remove('open');
      const id = this.briefingNodeId;
      this.closeBriefing();
      if (id) this.deps.onAbandonCrisis?.(id);
      else this.deps.onAscend();
      this.deps.onSoundTrigger?.('click');
    });
    this.el.settingsClose.addEventListener('click', () => {
      this.deps.onSoundTrigger?.('modalClose');
      this.closeSettings();
    });

    const backdrop = (e: MouseEvent): void => {
      if (e.target === this.el.briefing) {
        this.deps.onSoundTrigger?.('modalClose');
        this.closeBriefing();
      }
      if (e.target === this.el.settings) {
        this.deps.onSoundTrigger?.('modalClose');
        this.closeSettings();
      }
      if (e.target === this.el.codex) {
        this.deps.onSoundTrigger?.('modalClose');
        this.closeCodex();
      }
      if (e.target === this.el.abandonConfirm) {
        this.el.abandonConfirm.classList.remove('open');
      }
    };
    this.el.briefing.addEventListener('click', backdrop);
    this.el.settings.addEventListener('click', backdrop);
    this.el.codex.addEventListener('click', backdrop);
    this.el.abandonConfirm.addEventListener('click', backdrop);
    this.el.codexClose.addEventListener('click', () => {
      this.deps.onSoundTrigger?.('modalClose');
      this.closeCodex();
    });
    this.el.codexSearch?.addEventListener('input', () => {
      this.codexSearchText = ((this.el.codexSearch as HTMLInputElement).value || '').toLowerCase().trim();
      this.renderCodex();
    });
    this.el.codexMarkRead?.addEventListener('click', () => {
      this.deps.onSoundTrigger?.('click');
      this.markAllCodexRead();
    });

    for (const tabBtn of this.el.codexTabs.querySelectorAll<HTMLButtonElement>('.codex-tab')) {
      tabBtn.addEventListener('click', () => {
        this.deps.onSoundTrigger?.('click');
        const tab = (tabBtn.dataset.tab as CodexTab) ?? 'DOMAINS';
        this.openCodex(tab);
      });
    }

    const d = this.deps;
    this.disposers.push(d.bus.on(Events.Toast, (p) => this.toast(p?.message as string, p?.kind as string)));
    this.disposers.push(
      d.bus.on(Events.CrisisResolved, (p) => {
        this.deps.onSoundTrigger?.('success');
        this.toast(`${p?.name as string} stabilised`, 'good');
      }),
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
    const mk = (label: string, fn: () => void, primary = false, id?: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = `btn${primary ? ' primary' : ''}`;
      if (id) b.id = id;
      b.textContent = label;
      b.addEventListener('click', () => {
        d.onSoundTrigger?.('click');
        fn();
      });
      return b;
    };
    this.el.macroToolbar.append(
      mk('Archive [C]', () => this.openCodex(), false, 'macro-codex-btn'),
      mk('Audio [U]', () => this.toggleMute(), false, 'macro-mute-btn'),
      mk('Equator', () => d.onSnapCamera?.('EQUATOR')),
      mk('N-Pole', () => d.onSnapCamera?.('NORTH_POLE')),
      mk('S-Pole', () => d.onSnapCamera?.('SOUTH_POLE')),
      mk('Reset [Home]', () => d.onSnapCamera?.('RESET')),
      mk('Settings', () => this.openSettings()),
      mk('Camera', () => d.onCycleCamera()),
      mk('Save', () => d.onSave()),
      mk('Load', () => d.onLoad()),
    );

    // Simulation time warp buttons.
    const warpButtons = this.el.macro.querySelectorAll<HTMLButtonElement>('.time-warp-btn');
    for (const wb of warpButtons) {
      wb.addEventListener('click', () => {
        const sp = Number(wb.dataset.speed ?? 1);
        this.setTimeWarp(sp);
        d.onTimeWarpChange?.(sp);
        d.onSoundTrigger?.('click');
      });
    }

    // Crisis filter pills and live search.
    const filterButtons = this.el.macro.querySelectorAll<HTMLButtonElement>('.crisis-filter-pill');
    for (const fb of filterButtons) {
      fb.addEventListener('click', () => {
        for (const other of filterButtons) other.classList.remove('active');
        fb.classList.add('active');
        this.crisisFilterDomain = (fb.dataset.domain as Domain | 'ALL') ?? 'ALL';
        this.filterCrisisList();
        d.onSoundTrigger?.('click');
      });
    }
    const crisisSearchInput = this.el.macro.querySelector('#crisis-search') as HTMLInputElement | null;
    crisisSearchInput?.addEventListener('input', () => {
      this.crisisSearchText = (crisisSearchInput.value || '').toLowerCase().trim();
      this.filterCrisisList();
    });

    // Sector HUD command bar + spire ping wiring.
    this.el.hudCamBtn?.addEventListener('click', () => {
      d.onSoundTrigger?.('click');
      d.onCycleCamera();
    });
    this.el.hudMuteBtn?.addEventListener('click', () => {
      this.toggleMute();
    });
    this.el.hudCodexBtn?.addEventListener('click', () => this.openCodex());
    this.el.hudAscendBtn?.addEventListener('click', () => d.onAscend());
    this.el.hudSettingsBtn?.addEventListener('click', () => this.openSettings());
    this.el.spirePingBtn?.addEventListener('click', () => {
      d.onPingSpire?.(this.selectedSpireId);
    });
    this.el.reticleAction?.addEventListener('click', () => {
      d.onSoundTrigger?.('click');
      const nodeId = this.el.reticleAction.dataset.nodeId;
      const spireId = this.el.reticleAction.dataset.spireId;
      const settlementId = this.el.reticleAction.dataset.settlementId;
      if (nodeId) d.onSelectNode(nodeId);
      else if (spireId !== undefined) d.onPingSpire?.(Number(spireId));
      else if (settlementId) d.onSelectSettlement?.(settlementId);
    });

    const close = this.el.settings.querySelector('#settings-close') as HTMLButtonElement;
    close.addEventListener('click', () => this.closeSettings());
    const cp = this.el.settings.querySelector('#settings-copy-save') as HTMLButtonElement | null;
    cp?.addEventListener('click', async () => {
      d.onSoundTrigger?.('click');
      if (d.onCopySave) await d.onCopySave();
    });
    const pst = this.el.settings.querySelector('#settings-paste-save') as HTMLButtonElement | null;
    pst?.addEventListener('click', () => {
      d.onSoundTrigger?.('click');
      let text: string | null = null;
      if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
        text = window.prompt('Paste campaign save JSON:');
      }
      if (text && d.onPasteSave) d.onPasteSave(text);
    });
    const exp = this.el.settings.querySelector('#settings-export') as HTMLButtonElement;
    exp.addEventListener('click', () => d.onExport());
    const imp = this.el.settings.querySelector('#settings-import') as HTMLButtonElement;
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.style.display = 'none';
    this.el.settings.appendChild(fileInput);
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        d.onImport(String(r.result));
        this.buildSettings();
      };
      r.readAsText(f);
      fileInput.value = '';
    });
    imp.addEventListener('click', () => fileInput.click());
    const sv = this.el.settings.querySelector('#settings-save') as HTMLButtonElement;
    sv.addEventListener('click', () => d.onSave());
    const ld = this.el.settings.querySelector('#settings-load') as HTMLButtonElement;
    ld.addEventListener('click', () => {
      d.onLoad();
      this.buildSettings();
    });
    const nw = this.el.settings.querySelector('#settings-newworld') as HTMLButtonElement;
    nw.addEventListener('click', () => {
      if (confirm('Discard the current campaign and generate a new world?')) {
        d.onNewWorld();
        this.closeSettings();
      }
    });

    // Universal Tooltip registration.
    this.initTooltips();

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
    this.el.bootEnter.addEventListener('click', () => {
      this.cleanupBootKey();
      this.enterHandler?.();
    });
  }

  private enterHandler: (() => void) | null = null;
  private bootKeyHandler: ((e: KeyboardEvent) => void) | null = null;

  private cleanupBootKey(): void {
    if (this.bootKeyHandler) {
      window.removeEventListener('keydown', this.bootKeyHandler);
      this.bootKeyHandler = null;
    }
  }

  startBootSequence(lines: string[]): void {
    this.el.bootLines.innerHTML = '';
    lines.forEach((l, i) => {
      const s = document.createElement('span');
      s.textContent = l;
      s.style.animationDelay = `${i * 0.55}s`;
      this.el.bootLines.appendChild(s);
    });
    this.el.bootEnter.focus();
    this.cleanupBootKey();
    this.bootKeyHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' || e.key === ' ') {
        this.cleanupBootKey();
        this.dismissBoot();
        this.enterHandler?.();
      }
    };
    window.addEventListener('keydown', this.bootKeyHandler);
  }

  dismissBoot(): void {
    this.cleanupBootKey();
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

    if (this.selectedPlanetaryVar && this.el.varInspectorVal) {
      const sv = this.selectedPlanetaryVar;
      const txt = PlanetaryState.readout(sv, planetary.vars[sv]);
      if (this.el.varInspectorVal.textContent !== txt) {
        this.el.varInspectorVal.textContent = txt;
      }
    }
  }

  /** Select or clear the inspected planetary variable in the Causal Coupling Inspector. */
  selectPlanetaryVar(v: PlanetaryVar | null): void {
    this.selectedPlanetaryVar = v;
    const rules = couplingRules();
    const drivers = new Set<PlanetaryVar>();
    const driven = new Set<PlanetaryVar>();
    if (v) {
      for (const r of rules) {
        if (r.to === v) drivers.add(r.from);
        if (r.from === v) driven.add(r.to);
      }
    }
    for (const [k, el] of this.varEls) {
      const isSel = k === v;
      el.row.classList.toggle('is-selected', isSel);
      el.row.classList.toggle('is-driver', !isSel && drivers.has(k));
      el.row.classList.toggle('is-driven', !isSel && driven.has(k));
      el.row.setAttribute('aria-pressed', String(isSel));
    }
    this.renderVarInspector();
  }

  private renderVarInspector(): void {
    const root = this.el.varInspector;
    if (!root) return;
    const v = this.selectedPlanetaryVar;
    if (!v) {
      root.innerHTML = `<div class="var-inspector-empty">Select any planetary variable above to inspect its causal network.</div>`;
      delete this.el.varInspectorVal;
      return;
    }
    const rules = couplingRules();
    const upstream = rules.filter((r) => r.to === v);
    const downstream = rules.filter((r) => r.from === v);
    const polarity = varSense(v) === 'good' ? 'HIGHER IS HEALTHIER' : 'LOWER IS HEALTHIER';
    const valTxt = PlanetaryState.readout(v, this.deps.planetary.vars[v]);

    root.innerHTML = `
      <div class="var-insp-head">
        <div>
          <span class="var-insp-title">${varLabel(v)}</span>
          <span class="var-insp-pol">${polarity}</span>
        </div>
        <b class="var-insp-val" id="var-inspector-val">${valTxt}</b>
      </div>
      <div class="var-insp-cols">
        <div class="var-insp-col">
          <div class="var-insp-sub">Driven By (&larr; ${upstream.length})</div>
          <div class="var-insp-list" id="var-insp-up"></div>
        </div>
        <div class="var-insp-col">
          <div class="var-insp-sub">Drives (&rarr; ${downstream.length})</div>
          <div class="var-insp-list" id="var-insp-down"></div>
        </div>
      </div>
    `;
    this.el.varInspectorVal = root.querySelector('#var-inspector-val') as HTMLElement;
    const upEl = root.querySelector('#var-insp-up') as HTMLElement;
    const downEl = root.querySelector('#var-insp-down') as HTMLElement;

    const addRuleChip = (
      parent: HTMLElement,
      other: PlanetaryVar,
      weight: number,
      note: string,
    ): void => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'var-coup-chip';
      btn.dataset.var = other;
      btn.title = note;
      const sign = weight > 0 ? '+' : '';
      btn.innerHTML = `<span class="lbl">${varLabel(other)}</span><span class="wt ${weight > 0 ? 'pos' : 'neg'}">${sign}${weight.toFixed(2)}</span>`;
      btn.addEventListener('click', () => this.selectPlanetaryVar(other));
      parent.appendChild(btn);
    };

    if (upstream.length === 0) {
      upEl.innerHTML = `<span class="var-insp-none">Baseline / direct work</span>`;
    } else {
      for (const r of upstream) addRuleChip(upEl, r.from, r.gain, r.why);
    }

    if (downstream.length === 0) {
      downEl.innerHTML = `<span class="var-insp-none">Terminal indicator</span>`;
    } else {
      for (const r of downstream) addRuleChip(downEl, r.to, r.gain, r.why);
    }
  }

  /** Rebuild the crisis list from runtimes. */
  setCrises(runtimes: CrisisRuntime[], selected: string | null): void {
    this.lastCrisesList = runtimes;
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
    this.filterCrisisList();
  }

  filterCrisisList(): void {
    for (const [id, row] of this.crisisRows) {
      const rt = this.lastCrisesList.find((c) => c.def.id === id);
      if (!rt) continue;
      const matchesDomain = this.crisisFilterDomain === 'ALL' || rt.def.domain === this.crisisFilterDomain;
      const search = this.crisisSearchText;
      const matchesSearch = !search ||
        rt.def.name.toLowerCase().includes(search) ||
        rt.def.headline.toLowerCase().includes(search) ||
        DOMAIN_LABEL[rt.def.domain].toLowerCase().includes(search);
      row.btn.style.display = (matchesDomain && matchesSearch) ? '' : 'none';
    }
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
      if (!this.el.hud.classList.contains('active')) return;
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
    let done = 0;
    let osig = '';
    for (const o of model.objectives) {
      const pct = (o.progress * 100).toFixed(0);
      osig += `${o.text}:${pct}:${o.done ? 1 : 0}|`;
      if (o.done) done++;
    }
    if (this.el.objBody.dataset.sig !== osig) {
      this.el.objBody.dataset.sig = osig;
      this.el.objBody.innerHTML = '';
      for (const o of model.objectives) {
        const d = document.createElement('div');
        d.className = `obj${o.done ? ' done' : ''}`;
        d.innerHTML = `<span class="bar"><i style="width:${(o.progress * 100).toFixed(0)}%"></i></span><span>${o.text}</span>`;
        this.el.objBody.appendChild(d);
      }
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

    if (this.el.briefBlueprint) {
      const spec = VEHICLE_SPECS[node.vehicle];
      const biomeId: BiomeId = node.biomes[0] ?? 'SHATTERED_BASALT';
      const mat = MATERIALS[biomeId];
      const domProg = DOMAINS.find((d) => d.id === node.domain);
      const unlocked = new Set(data.unlockedModules ?? this.codexData.unlockedModules);
      const domPts = data.domainPoints?.[node.domain] ?? this.codexData.domainPoints[node.domain] ?? 0;
      const level = Math.floor(domPts / 3) + 1;
      const modHtml = (domProg?.unlocks ?? [])
        .map((m) => {
          const isOn = unlocked.has(m.module);
          const reqPts = m.level === 1 ? 1 : (m.level - 1) * 3;
          const badge = isOn ? 'ACTIVE' : `REQ ${reqPts} PT`;
          return `<div class="bp-mod ${isOn ? 'on' : ''}"><div><b>${m.module}</b> <span class="bp-mod-badge">${badge}</span></div><div class="bp-mod-desc">${m.note}</div></div>`;
        })
        .join('');

      this.el.briefBlueprint.innerHTML = `
        <div class="bp-header">
          <span>${domainBadgeSvg(node.domain)} <b>${spec.designation} · ${spec.title}</b></span>
          <span>${spec.massLabel}</span>
        </div>
        <div class="bp-diagram">${vehicleBlueprintSvg(node.vehicle)}</div>
        <div class="bp-meta-grid">
          <div><span>Primary Biome</span><b>${BIOME_LABEL[biomeId]}</b></div>
          <div><span>Hardness / Bearing</span><b>${Math.round(mat.hardness * 100)}% / ${mat.bearingCapacity} kPa</b></div>
          <div><span>Conductivity / Friction</span><b>${Math.round(mat.conductivity * 100)}% / ${mat.friction.toFixed(2)}</b></div>
          <div><span>Density / Toxicity</span><b>${mat.density.toFixed(1)} g/cm³ / ${Math.round(mat.toxicity * 100)}%</b></div>
        </div>
        <div class="bp-mods-wrap">
          <div class="bp-mods-title"><span>${DOMAIN_LABEL[node.domain]} Subsystems</span><span>Domain Pts: ${domPts} (Lvl ${level})</span></div>
          <div class="bp-mods-list">${modHtml}</div>
        </div>
      `;
    }

    this.el.briefObjectives.innerHTML = '';
    for (const o of data.objectives) {
      const li = document.createElement('li');
      const pct = Math.round((o.progress ?? 0) * 100);
      const prefix = o.done ? '✓ ' : '○ ';
      li.textContent = pct > 0 && !o.done ? `${prefix}${o.text} (${pct}%)` : `${prefix}${o.text}`;
      if (o.done) {
        li.style.color = 'var(--good)';
        li.classList.add('done');
      }
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
    this.cancelRebinding?.();
    this.el.settings.classList.remove('open');
  }

  get isSettingsOpen(): boolean {
    return this.el.settings.classList.contains('open');
  }

  // -- survey archive & engineering codex -----------------------------------

  setCodexData(data: {
    domainPoints: Record<string, number>;
    unlockedModules: string[];
    log: { t: number; text: string }[];
  }): void {
    this.codexData = {
      domainPoints: { ...data.domainPoints },
      unlockedModules: [...data.unlockedModules],
      log: [...data.log],
    };
    if (this.isCodexOpen) this.renderCodex();
  }

  openCodex(tab: CodexTab = this.codexTab): void {
    this.codexTab = tab;
    for (const b of this.el.codexTabs.querySelectorAll<HTMLButtonElement>('.codex-tab')) {
      const active = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(active));
      b.classList.toggle('active', active);
    }
    this.renderCodex();
    this.el.codex.classList.add('open');
    this.el.codexClose.focus();
  }

  closeCodex(): void {
    this.el.codex.classList.remove('open');
  }

  get isCodexOpen(): boolean {
    return this.el.codex.classList.contains('open');
  }

  private renderCodex(): void {
    const body = this.el.codexBody;
    if (!body) return;
    const unlocked = new Set(this.codexData.unlockedModules);
    const q = (this.codexSearchText || '').toLowerCase();

    if (this.codexTab === 'DOMAINS') {
      const filtered = DOMAINS.filter((d) => {
        if (!q) return true;
        if (d.label.toLowerCase().includes(q) || d.blurb.toLowerCase().includes(q)) return true;
        return d.unlocks.some((m) => m.module.toLowerCase().includes(q) || m.note.toLowerCase().includes(q));
      });
      body.innerHTML = filtered.map((d) => {
        const pts = this.codexData.domainPoints[d.id] ?? 0;
        const level = Math.floor(pts / 3) + 1;
        const mods = d.unlocks
          .filter((m) => !q || m.module.toLowerCase().includes(q) || m.note.toLowerCase().includes(q) || d.label.toLowerCase().includes(q))
          .map((m) => {
            const on = unlocked.has(m.module);
            const isUnread = on && !this.readCodexModules.has(m.module);
            const reqPts = m.level === 1 ? 1 : (m.level - 1) * 3;
            const badge = on ? (isUnread ? '<span class="unread-badge">NEW</span> ACTIVE' : 'ACTIVE') : `REQ ${reqPts} PT`;
            return `
              <div class="codex-mod ${on ? 'on' : ''}" data-mod="${m.module}" style="cursor:pointer">
                <div class="codex-mod-top">
                  <b>${m.module}</b>
                  <span class="codex-badge ${on ? 'on' : ''}">${badge}</span>
                </div>
                <div class="codex-mod-desc">${m.note}</div>
              </div>
            `;
          })
          .join('');
        return `
          <div class="codex-section">
            <div class="codex-sec-head">
              <span>${domainBadgeSvg(d.id)} <b>${d.label} Domain</b></span>
              <span class="codex-pts">${pts} PT${pts === 1 ? '' : 'S'} · LVL ${level}</span>
            </div>
            <p class="codex-desc">${d.blurb}</p>
            <div class="codex-mod-grid">${mods}</div>
          </div>
        `;
      }).join('');
      for (const card of body.querySelectorAll<HTMLElement>('.codex-mod[data-mod]')) {
        card.addEventListener('click', () => {
          const mod = card.dataset.mod;
          if (mod) {
            this.readCodexModules.add(mod);
            const badge = card.querySelector('.unread-badge');
            if (badge) badge.remove();
          }
        });
      }
      return;
    }

    if (this.codexTab === 'BLUEPRINTS') {
      const vehiclesHtml = Object.values(VEHICLE_SPECS)
        .filter((v) => !q || v.title.toLowerCase().includes(q) || v.designation.toLowerCase().includes(q) || v.summary.toLowerCase().includes(q))
        .map(
          (v) => `
          <div class="codex-section">
            <div class="codex-sec-head">
              <span>${domainBadgeSvg(v.domain)} <b>${v.designation} · ${v.title}</b></span>
              <span class="codex-pts">${v.massLabel}</span>
            </div>
            <div class="bp-diagram">${vehicleBlueprintSvg(v.kind)}</div>
            <p class="codex-desc">${v.summary}</p>
            <div class="codex-kv">
              <span><b>Operational Envelope:</b> ${v.envelope}</span>
              <span><b>Primary Subsystem:</b> ${v.primarySystem}</span>
            </div>
          </div>
        `,
        )
        .join('');

      const biomesHtml = (Object.keys(MATERIALS) as BiomeId[])
        .filter((id) => !q || BIOME_LABEL[id].toLowerCase().includes(q))
        .map((id) => {
          const b = MATERIALS[id];
          return `
          <div class="codex-biome-card">
            <div class="codex-mod-top"><b>${BIOME_LABEL[id]}</b><span>${b.bearingCapacity} kPa</span></div>
            <div class="codex-biome-stats">
              <span>Hardness ${Math.round(b.hardness * 100)}%</span>
              <span>Conductivity ${Math.round(b.conductivity * 100)}%</span>
              <span>Density ${b.density.toFixed(1)}</span>
              <span>Friction ${b.friction.toFixed(2)}</span>
              <span>Toxicity ${Math.round(b.toxicity * 100)}%</span>
            </div>
          </div>
        `;
        })
        .join('');

      body.innerHTML = `
        <h3 class="codex-subhead">Field Machine Schematics</h3>
        ${vehiclesHtml || '<div class="codex-desc">No machines match query.</div>'}
        <h3 class="codex-subhead">Sector Biome Material Ledger</h3>
        <div class="codex-biome-grid">${biomesHtml || '<div class="codex-desc">No biomes match query.</div>'}</div>
      `;
      return;
    }

    if (this.codexTab === 'PROVENANCE') {
      const refEntries: { title: string; tag: string; lines: readonly string[] }[] = [
        { title: 'Starsilk Substrate', tag: 'CANON LOCK', lines: ARCHIVAL_REFERENCES.starsilk },
        { title: 'Siege Wall', tag: 'NAVIGATION EXCLUSION', lines: ARCHIVAL_REFERENCES.siegeWall },
        { title: 'Blood Rings', tag: 'ARCHIVAL RECORD', lines: ARCHIVAL_REFERENCES.bloodRings },
      ];
      const refsHtml = refEntries
        .filter((r) => !q || r.title.toLowerCase().includes(q) || r.lines.some((l) => l.toLowerCase().includes(q)))
        .map(
          (r) => `
          <div class="codex-mod on">
            <div class="codex-mod-top">
              <b>${r.title}</b>
              <span class="codex-badge on">${r.tag}</span>
            </div>
            ${r.lines.map((l) => `<div class="codex-mod-desc">— ${l}</div>`).join('')}
          </div>
        `,
        )
        .join('');

      const localRows: { label: string; items: string }[] = [
        { label: 'Survey World', items: GAME_LOCAL_INVENTIONS.planet },
        { label: 'Settlements', items: GAME_LOCAL_INVENTIONS.settlements.join(' · ') },
        { label: 'Acoustic Spires', items: GAME_LOCAL_INVENTIONS.spires.join(' · ') },
        { label: 'Crisis Sectors', items: GAME_LOCAL_INVENTIONS.crises.join(' · ') },
        { label: 'Engineering Terms', items: GAME_LOCAL_INVENTIONS.terms.join(' · ') },
      ];
      const localHtml = localRows
        .filter((g) => !q || g.label.toLowerCase().includes(q) || g.items.toLowerCase().includes(q))
        .map(
          (g) => `
          <div class="codex-local-row">
            <div><b>${g.label}</b> <span class="codex-badge">0-ARK LOCAL</span></div>
            <div class="codex-mod-desc">${g.items}</div>
          </div>
        `,
        )
        .join('');

      const locksHtml = Object.entries(CANON_FACTS)
        .filter(([k, v]) => !q || k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q))
        .map(
          ([k, v]) => `
          <div class="codex-lock-pill"><span>${k}</span><b>${String(v)}</b></div>
        `,
        )
        .join('');

      body.innerHTML = `
        <h3 class="codex-subhead">Dossier Archival Records (Established Canon)</h3>
        <div class="codex-mod-grid">${refsHtml || '<div class="codex-desc">No records match query.</div>'}</div>
        <h3 class="codex-subhead">0-ARK Survey Designations (Game-Local Inventions)</h3>
        <p class="codex-desc">${GAME_LOCAL_INVENTIONS.note}</p>
        <div class="codex-local-list">${localHtml}</div>
        <h3 class="codex-subhead">Active Cosmological Invariant Locks</h3>
        <div class="codex-lock-grid">${locksHtml}</div>
      `;
      return;
    }

    // LOG tab
    const entries = [...this.codexData.log].reverse();
    const filteredEntries = entries.filter((e) => !q || e.text.toLowerCase().includes(q));
    const logHtml =
      filteredEntries.length === 0
        ? `<div class="codex-desc">No engineering log entries match query.</div>`
        : filteredEntries
            .map((e, idx) => {
              return `<div class="codex-log-row"><span class="t">#${entries.length - idx}</span><span class="msg">${e.text}</span></div>`;
            })
            .join('');
    body.innerHTML = `
      <h3 class="codex-subhead">Chronological Campaign Telemetry Log (${filteredEntries.length})</h3>
      <div class="codex-log-list">${logHtml}</div>
    `;
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

  private lastPerfHtml = '';
  private settlementValEls: HTMLElement[] = [];

  setPerf(m: ReturnType<import('../core/perf').PerformanceMonitor['metrics']>): void {
    if (!this.settings.showPerf) return;
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
    if (html !== this.lastPerfHtml) {
      this.lastPerfHtml = html;
      this.el.perf.innerHTML = html;
    }
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

  selectSettlement(settlementId: string | null): void {
    this.selectedSettlementId = settlementId;
    if (this.el.settlementGrid) {
      for (const r of this.el.settlementGrid.querySelectorAll<HTMLElement>('.settlement-row')) {
        const isSel = r.dataset.id === settlementId;
        r.classList.toggle('selected', isSel);
        r.setAttribute('aria-pressed', String(isSel));
      }
    }
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
        c.setAttribute('tabindex', '0');
        c.setAttribute('role', 'button');
        c.setAttribute('aria-label', `Select and ping Acoustic Spire ${idx + 1}`);
        const pingThis = (): void => {
          this.selectedSpireId = idx;
          this.deps.onPingSpire?.(idx);
        };
        c.addEventListener('click', pingThis);
        c.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pingThis();
          }
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
        this.settlementValEls = [];
        for (const s of settlements) {
          const r = document.createElement('div');
          r.className = 'settlement-row';
          r.dataset.id = s.id;
          r.dataset.settlement = s.id;
          r.tabIndex = 0;
          r.setAttribute('role', 'button');
          r.setAttribute('aria-pressed', String(s.id === this.selectedSettlementId));
          r.title = `Focus globe on ${s.name} (${s.populationK}k survivors)`;
          const nameEl = document.createElement('span');
          nameEl.textContent = s.name;
          const valEl = document.createElement('b');
          valEl.textContent = '--';
          r.append(nameEl, valEl);
          const activate = (): void => {
            const next = this.selectedSettlementId === s.id ? null : s.id;
            this.selectSettlement(next);
            if (next) this.deps.onSelectSettlement?.(next);
            else this.deps.onSelectSettlement?.('');
          };
          r.addEventListener('click', activate);
          r.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
          });
          this.el.settlementGrid.appendChild(r);
          this.settlementValEls.push(valEl);
        }
      }
      let sum = 0;
      for (let i = 0; i < settlements.length; i++) {
        const s = settlements[i];
        sum += s.viability;
        const b = this.settlementValEls[i];
        if (b) {
          const txt = `${Math.round(s.viability * 100)}%`;
          if (b.textContent !== txt) b.textContent = txt;
        }
        const rowEl = this.el.settlementGrid.children[i] as HTMLElement | undefined;
        if (rowEl) {
          const isCrit = s.viability < 0.3;
          rowEl.classList.toggle('crit', isCrit);
          let badge = rowEl.querySelector('.critical-badge') as HTMLElement | null;
          if (isCrit && !badge) {
            badge = document.createElement('span');
            badge.className = 'critical-badge';
            badge.textContent = 'COLLAPSE RISK';
            rowEl.appendChild(badge);
          } else if (!isCrit && badge) {
            badge.remove();
          }
        }
      }
      if (this.el.ledgerAvg && settlements.length > 0) {
        const avgTxt = `avg ${Math.round((sum / settlements.length) * 100)}%`;
        if (this.el.ledgerAvg.textContent !== avgTxt) this.el.ledgerAvg.textContent = avgTxt;
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

  /** Set simulation time warp speed and update toolbar buttons. */
  setTimeWarp(speed: number): void {
    this.timeWarpMultiplier = speed;
    const warpButtons = this.el.macro.querySelectorAll<HTMLButtonElement>('.time-warp-btn');
    for (const b of warpButtons) {
      b.classList.toggle('active', Number(b.dataset.speed) === speed);
    }
  }

  setAudioMuted(muted: boolean): void {
    this.isAudioMuted = muted;
    if (this.el.hudMuteBtn) {
      this.el.hudMuteBtn.textContent = muted ? 'Muted [U]' : 'Audio [U]';
      this.el.hudMuteBtn.classList.toggle('muted', muted);
    }
    const macroMute = this.el.macroToolbar.querySelector('#macro-mute-btn') as HTMLElement | null;
    if (macroMute) {
      macroMute.textContent = muted ? 'Muted [U]' : 'Audio [U]';
      macroMute.classList.toggle('muted', muted);
    }
  }

  toggleMute(): boolean {
    const next = this.deps.onToggleMute ? this.deps.onToggleMute() : !this.isAudioMuted;
    this.setAudioMuted(next);
    return next;
  }

  updateCoordinates(lat: number, lon: number, elev: number, biome: string): void {
    const latLonEl = this.el.macro.querySelector('#coord-latlon');
    const elevEl = this.el.macro.querySelector('#coord-elev');
    const biomeEl = this.el.macro.querySelector('#coord-biome');
    if (latLonEl) {
      const latStr = `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? 'N' : 'S'}`;
      const lonStr = `${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? 'E' : 'W'}`;
      latLonEl.textContent = `${latStr} · ${lonStr}`;
    }
    if (elevEl) elevEl.textContent = `${elev.toFixed(0)} m`;
    if (biomeEl) biomeEl.textContent = biome;
  }

  updateWaypoint(screenX: number, screenY: number, distMeters: number, visible: boolean): void {
    if (!this.el.sectorWaypoint) return;
    if (!visible) {
      this.el.sectorWaypoint.style.display = 'none';
      return;
    }
    this.el.sectorWaypoint.style.display = 'flex';
    const pad = 36;
    const clampedX = Math.max(pad, Math.min(window.innerWidth - pad, screenX));
    const clampedY = Math.max(pad, Math.min(window.innerHeight - pad, screenY));
    this.el.sectorWaypoint.style.left = `${clampedX}px`;
    this.el.sectorWaypoint.style.top = `${clampedY}px`;
    if (this.el.wpDistLbl) {
      this.el.wpDistLbl.textContent = distMeters > 1000
        ? `${(distMeters / 1000).toFixed(2)} km`
        : `${Math.round(distMeters)} m`;
    }
  }

  showGpwsWarning(active: boolean, altMeters?: number): void {
    if (!this.el.gpwsAlert) return;
    this.el.gpwsAlert.classList.toggle('visible', active);
    if (active && altMeters !== undefined) {
      this.el.gpwsAlert.textContent = `⚠ TERRAIN PULL UP (${altMeters.toFixed(0)}m) ⚠`;
    } else {
      this.el.gpwsAlert.textContent = '⚠ TERRAIN PULL UP ⚠';
    }
  }

  markAllCodexRead(): void {
    for (const m of this.codexData.unlockedModules) {
      this.readCodexModules.add(m);
    }
    this.renderCodex();
    this.toast('All engineering archive entries marked read', 'good');
  }

  initTooltips(): void {
    if (!this.tooltipEl) return;
    const show = (el: HTMLElement) => {
      const title = el.getAttribute('title') || el.dataset.cachedTitle;
      if (!title) return;
      if (!el.dataset.cachedTitle) el.dataset.cachedTitle = title;
      el.removeAttribute('title');
      const shortcut = el.dataset.shortcut ? `[${el.dataset.shortcut}]` : '';
      this.showTooltip(title, shortcut, el.getBoundingClientRect());
    };
    const hide = (el: HTMLElement) => {
      if (el.dataset.cachedTitle) {
        el.setAttribute('title', el.dataset.cachedTitle);
      }
      this.hideTooltip();
    };

    document.addEventListener('pointerover', (e) => {
      const target = (e.target as HTMLElement)?.closest?.('[title], [data-cached-title]') as HTMLElement | null;
      if (target) show(target);
    });
    document.addEventListener('pointerout', (e) => {
      const target = (e.target as HTMLElement)?.closest?.('[data-cached-title]') as HTMLElement | null;
      if (target) hide(target);
    });
  }

  showTooltip(text: string, shortcut: string, rect: DOMRect): void {
    if (!this.tooltipEl) return;
    this.tooltipEl.innerHTML = shortcut ? `${text} <kbd>${shortcut}</kbd>` : text;
    this.tooltipEl.classList.add('visible');
    const tipRect = this.tooltipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 8;
    if (top < 8) top = rect.bottom + 8;
    left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, left));
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${top}px`;
  }

  hideTooltip(): void {
    if (this.tooltipEl) this.tooltipEl.classList.remove('visible');
  }

  /** Position and populate the 3D-projected floating reticle callout on the globe. */
  updateGlobeReticle(
    reticle: {
      visible: boolean;
      x: number;
      y: number;
      kind: 'node' | 'spire' | 'settlement';
      title: string;
      tag: string;
      sub: string;
      actionLabel: string;
      nodeId?: string;
      spireId?: number;
      settlementId?: string;
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
    this.el.reticleCard.classList.toggle('settlement', reticle.kind === 'settlement');
    if (this.el.reticleTitle.textContent !== reticle.title) this.el.reticleTitle.textContent = reticle.title;
    if (this.el.reticleTag.textContent !== reticle.tag) this.el.reticleTag.textContent = reticle.tag;
    if (this.el.reticleSub.textContent !== reticle.sub) this.el.reticleSub.textContent = reticle.sub;
    if (this.el.reticleAction.textContent !== reticle.actionLabel) {
      this.el.reticleAction.textContent = reticle.actionLabel;
    }
    delete this.el.reticleAction.dataset.nodeId;
    delete this.el.reticleAction.dataset.spireId;
    delete this.el.reticleAction.dataset.settlementId;
    if (reticle.nodeId) {
      this.el.reticleAction.dataset.nodeId = reticle.nodeId;
    } else if (reticle.spireId !== undefined) {
      this.el.reticleAction.dataset.spireId = String(reticle.spireId);
    } else if (reticle.settlementId) {
      this.el.reticleAction.dataset.settlementId = reticle.settlementId;
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
