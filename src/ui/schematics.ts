/**
 * TECHNICAL BLUEPRINTS & DOMAIN EMBLEMS
 * =====================================
 *
 * Authored vector schematics for the four planetary engineering machines and
 * the five operational domains. Kept in code as deterministic inline SVGs so
 * they scale crisply at any DPI, require zero network fetches, and honour the
 * project's palette discipline (scorched ochre / oxidised rust / slate steel,
 * with azure reserved strictly for Harmonic / sealed containment traces).
 */

import type { Domain, VehicleKind } from '../state/world';

export interface VehicleSpec {
  kind: VehicleKind;
  designation: string;
  title: string;
  domain: Domain;
  massLabel: string;
  envelope: string;
  primarySystem: string;
  summary: string;
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  ORBITAL_SKIFF: {
    kind: 'ORBITAL_SKIFF',
    designation: 'ARS-VI',
    title: 'Orbital Skiff',
    domain: 'ORBIT',
    massLabel: '14.2 t dry · 6-DOF RCS truss',
    envelope: 'Low orbital wreckage belt · 420 km alt',
    primarySystem: 'Bow grappling winch & cold-gas attitude quads',
    summary:
      'Six-degree-of-freedom orbital salvage and corridor-clearing tug. Captures tumbling derelicts with a tensioned cable winch and seats them into stabilised transit slots.',
  },
  LAND_TRAIN: {
    kind: 'LAND_TRAIN',
    designation: 'ARS-VII',
    title: 'Heavy Land-Train',
    domain: 'SURFACE',
    massLabel: '180–540 t · 6 powered bogies',
    envelope: 'Vitrified basins, salt flats & basalt grades',
    primarySystem: 'Articulated multi-wagon consist & dynamic resistors',
    summary:
      'High-axle-load surface logistics consist. Balances tractive effort, ground bearing capacity, and thermal brake fade across up to five articulated cargo wagons.',
  },
  STRATA_CRAWLER: {
    kind: 'STRATA_CRAWLER',
    designation: 'ARS-IX',
    title: 'Strata-Crawler',
    domain: 'SUBSURFACE',
    massLabel: '92 t · twin-track boring rig',
    envelope: 'Crustal vents & fault strata · 0–240 m depth',
    primarySystem: 'Rotary tungsten cutterhead, coolant loop & exchanger bay',
    summary:
      'Subterranean excavation and geothermal relief vehicle. Bores through high-hardness rock under active coolant management, seats heat exchangers, and backfills unstable voids.',
  },
  GLIDER: {
    kind: 'GLIDER',
    designation: 'ARS-X',
    title: 'Atmospheric Glider',
    domain: 'SKY',
    massLabel: '1.85 t · 26 m high-aspect wing',
    envelope: 'Ash-veil shear corridors · 0–5,200 m AGL',
    primarySystem: 'Alpha-commanded laminar wing & ventral sonde dispenser',
    summary:
      'Unpowered high-aspect atmospheric survey craft. Rides convective thermals and shear boundaries while deploying calibration drop-sondes into toxic cloud decks.',
  },
};

/** Crisp geometric SVG badge for each of the five engineering domains. */
export function domainBadgeSvg(domain: Domain): string {
  switch (domain) {
    case 'ORBIT':
      return `<svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Orbit domain"><circle cx="12" cy="12" r="4.5" fill="none" stroke="#6fa8c8" stroke-width="1.5"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-24 12 12)" fill="none" stroke="#c98a3c" stroke-width="1.3"/><circle cx="19" cy="9" r="1.6" fill="#e0b060"/></svg>`;
    case 'SKY':
      return `<svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Sky domain"><path d="M3 9h14a2.5 2.5 0 1 0-2.4-3.2M2 13h17a2.5 2.5 0 1 1-2.4 3.2M5 17h9" fill="none" stroke="#9fb8c4" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    case 'SURFACE':
      return `<svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Surface domain"><path d="M2 17L8 10l5 5 4-4 5 6H2z" fill="none" stroke="#c98a3c" stroke-width="1.5" stroke-linejoin="round"/><line x1="2" y1="20" x2="22" y2="20" stroke="#8e8a80" stroke-width="1.3"/></svg>`;
    case 'SUBSURFACE':
      return `<svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Subsurface domain"><line x1="2" y1="6" x2="22" y2="6" stroke="#c98a3c" stroke-width="1.4"/><path d="M3 10h18M5 14h14M8 18h8" stroke="#b0563a" stroke-width="1.5" stroke-linecap="round"/><path d="M12 6v14" stroke="#e0b060" stroke-width="1.4" stroke-dasharray="2 2"/></svg>`;
    case 'HARMONIC':
      return `<svg viewBox="0 0 24 24" width="14" height="14" role="img" aria-label="Harmonic domain"><circle cx="12" cy="12" r="9" fill="none" stroke="#3fa9d8" stroke-width="1.3" stroke-dasharray="3 2"/><circle cx="12" cy="12" r="5" fill="none" stroke="#3fa9d8" stroke-width="1.4"/><circle cx="12" cy="12" r="1.8" fill="#4fc4ef"/></svg>`;
  }
}

/** Authored CAD-style technical blueprint SVG for each engineering vehicle. */
export function vehicleBlueprintSvg(kind: VehicleKind): string {
  switch (kind) {
    case 'ORBITAL_SKIFF':
      return `<svg viewBox="0 0 320 110" class="blueprint-svg" role="img" aria-label="ARS-VI Orbital Skiff technical blueprint">
        <defs>
          <pattern id="bp-grid-skiff" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.6"/>
          </pattern>
        </defs>
        <rect width="320" height="110" fill="url(#bp-grid-skiff)"/>
        <line x1="18" y1="55" x2="302" y2="55" stroke="rgba(255,255,255,0.12)" stroke-width="0.7" stroke-dasharray="4 3"/>
        <!-- Rear propellant tanks -->
        <rect x="44" y="33" width="46" height="16" rx="4" fill="#1a1e22" stroke="#6f8a96" stroke-width="1.2"/>
        <rect x="44" y="61" width="46" height="16" rx="4" fill="#1a1e22" stroke="#6f8a96" stroke-width="1.2"/>
        <!-- Main structural spine & pressurized cab -->
        <rect x="86" y="36" width="118" height="38" fill="#171a1d" stroke="#c98a3c" stroke-width="1.5"/>
        <line x1="86" y1="45" x2="204" y2="45" stroke="#2f9fd0" stroke-width="1.3"/>
        <polygon points="204,38 236,45 236,65 204,72" fill="#1c2226" stroke="#e0b060" stroke-width="1.4"/>
        <!-- RCS quad pods -->
        <rect x="96" y="24" width="16" height="9" fill="#262a2e" stroke="#8e8a80" stroke-width="1"/>
        <rect x="96" y="77" width="16" height="9" fill="#262a2e" stroke="#8e8a80" stroke-width="1"/>
        <rect x="176" y="24" width="16" height="9" fill="#262a2e" stroke="#8e8a80" stroke-width="1"/>
        <rect x="176" y="77" width="16" height="9" fill="#262a2e" stroke="#8e8a80" stroke-width="1"/>
        <!-- Bow docking collar & tether winch -->
        <circle cx="250" cy="55" r="13" fill="none" stroke="#e0b060" stroke-width="2"/>
        <circle cx="250" cy="55" r="7" fill="none" stroke="#c98a3c" stroke-width="1" stroke-dasharray="3 2"/>
        <line x1="263" y1="55" x2="296" y2="55" stroke="#d8c48a" stroke-width="1.2" stroke-dasharray="2 2"/>
        <polygon points="296,51 304,55 296,59" fill="#e0b060"/>
        <!-- Annotations -->
        <text x="12" y="16" fill="#8e8a80" font-size="8" font-family="monospace">ARS-VI // 6-DOF ORBITAL TUG</text>
        <text x="44" y="98" fill="#6f8a96" font-size="7.5" font-family="monospace">RCS PROP</text>
        <text x="122" y="98" fill="#2f9fd0" font-size="7.5" font-family="monospace">SEALED TRACE</text>
        <text x="232" y="98" fill="#e0b060" font-size="7.5" font-family="monospace">WINCH RING</text>
      </svg>`;

    case 'LAND_TRAIN':
      return `<svg viewBox="0 0 320 110" class="blueprint-svg" role="img" aria-label="ARS-VII Heavy Land-Train technical blueprint">
        <defs>
          <pattern id="bp-grid-train" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.6"/>
          </pattern>
        </defs>
        <rect width="320" height="110" fill="url(#bp-grid-train)"/>
        <line x1="10" y1="78" x2="310" y2="78" stroke="#8a5f28" stroke-width="1.2"/>
        <!-- Articulated wagon 2 -->
        <rect x="20" y="42" width="66" height="24" fill="#181a1c" stroke="#6f8a96" stroke-width="1.2"/>
        <rect x="26" y="34" width="54" height="9" fill="#242019" stroke="#c98a3c" stroke-width="1"/>
        <!-- Coupler -->
        <line x1="86" y1="56" x2="100" y2="56" stroke="#e0b060" stroke-width="2"/>
        <!-- Articulated wagon 1 -->
        <rect x="100" y="42" width="70" height="24" fill="#181a1c" stroke="#6f8a96" stroke-width="1.2"/>
        <rect x="106" y="32" width="58" height="11" fill="#242019" stroke="#c98a3c" stroke-width="1"/>
        <!-- Coupler -->
        <line x1="170" y1="56" x2="184" y2="56" stroke="#e0b060" stroke-width="2"/>
        <!-- Lead Locomotive -->
        <polygon points="184,66 184,32 268,32 288,46 288,66" fill="#201a16" stroke="#e0b060" stroke-width="1.5"/>
        <rect x="194" y="37" width="44" height="14" fill="#14181b" stroke="#8e8a80" stroke-width="0.9"/>
        <polygon points="288,54 302,66 288,66" fill="#b0563a" stroke="#e0b060" stroke-width="1"/>
        <!-- 6 Powered Bogies -->
        <circle cx="36" cy="72" r="6" fill="#121416" stroke="#c98a3c" stroke-width="1.4"/>
        <circle cx="70" cy="72" r="6" fill="#121416" stroke="#c98a3c" stroke-width="1.4"/>
        <circle cx="116" cy="72" r="6" fill="#121416" stroke="#c98a3c" stroke-width="1.4"/>
        <circle cx="154" cy="72" r="6" fill="#121416" stroke="#c98a3c" stroke-width="1.4"/>
        <circle cx="206" cy="72" r="6.5" fill="#121416" stroke="#e0b060" stroke-width="1.6"/>
        <circle cx="262" cy="72" r="6.5" fill="#121416" stroke="#e0b060" stroke-width="1.6"/>
        <text x="12" y="16" fill="#8e8a80" font-size="8" font-family="monospace">ARS-VII // ARTICULATED SURFACE CONSIST</text>
        <text x="22" y="96" fill="#6f8a96" font-size="7.5" font-family="monospace">MODULAR WAGONS</text>
        <text x="188" y="96" fill="#e0b060" font-size="7.5" font-family="monospace">DRIVEN BOGIES · 6x6</text>
      </svg>`;

    case 'STRATA_CRAWLER':
      return `<svg viewBox="0 0 320 110" class="blueprint-svg" role="img" aria-label="ARS-IX Strata-Crawler technical blueprint">
        <defs>
          <pattern id="bp-grid-crawler" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.6"/>
          </pattern>
        </defs>
        <rect width="320" height="110" fill="url(#bp-grid-crawler)"/>
        <!-- Exchanger dorsal bay -->
        <rect x="42" y="26" width="54" height="14" fill="#1a1d20" stroke="#6f8a96" stroke-width="1.1"/>
        <!-- Heavy pressure hull & coolant manifold -->
        <rect x="36" y="40" width="168" height="30" fill="#221915" stroke="#c98a3c" stroke-width="1.5"/>
        <line x1="48" y1="52" x2="192" y2="52" stroke="#b0563a" stroke-width="2"/>
        <!-- Twin armored tracks -->
        <rect x="32" y="66" width="176" height="15" rx="7" fill="#141618" stroke="#8e8a80" stroke-width="1.4"/>
        <circle cx="48" cy="73.5" r="4.5" fill="none" stroke="#c98a3c" stroke-width="1.1"/>
        <circle cx="84" cy="73.5" r="4.5" fill="none" stroke="#c98a3c" stroke-width="1.1"/>
        <circle cx="120" cy="73.5" r="4.5" fill="none" stroke="#c98a3c" stroke-width="1.1"/>
        <circle cx="156" cy="73.5" r="4.5" fill="none" stroke="#c98a3c" stroke-width="1.1"/>
        <circle cx="190" cy="73.5" r="4.5" fill="none" stroke="#c98a3c" stroke-width="1.1"/>
        <!-- Forward rotary cutterhead -->
        <polygon points="204,42 238,32 238,76 204,68" fill="#1b1e22" stroke="#e0b060" stroke-width="1.4"/>
        <circle cx="256" cy="54" r="22" fill="none" stroke="#d08a3a" stroke-width="1.8" stroke-dasharray="5 3"/>
        <circle cx="256" cy="54" r="14" fill="#181a1d" stroke="#e0b060" stroke-width="1.4"/>
        <line x1="242" y1="40" x2="270" y2="68" stroke="#c98a3c" stroke-width="1.3"/>
        <line x1="242" y1="68" x2="270" y2="40" stroke="#c98a3c" stroke-width="1.3"/>
        <text x="12" y="16" fill="#8e8a80" font-size="8" font-family="monospace">ARS-IX // SUBTERRANEAN BORING RIG</text>
        <text x="36" y="98" fill="#6f8a96" font-size="7.5" font-family="monospace">EXCHANGER RACK</text>
        <text x="124" y="98" fill="#b0563a" font-size="7.5" font-family="monospace">COOLANT LOOP</text>
        <text x="220" y="98" fill="#e0b060" font-size="7.5" font-family="monospace">CUTTERHEAD</text>
      </svg>`;

    case 'GLIDER':
      return `<svg viewBox="0 0 320 110" class="blueprint-svg" role="img" aria-label="ARS-X Atmospheric Glider technical blueprint">
        <defs>
          <pattern id="bp-grid-glider" width="16" height="16" patternUnits="userSpaceOnUse">
            <path d="M 16 0 L 0 0 0 16" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="0.6"/>
          </pattern>
        </defs>
        <rect width="320" height="110" fill="url(#bp-grid-glider)"/>
        <!-- Planform high-aspect wings -->
        <polygon points="152,52 128,12 146,12 178,52" fill="#1a1f24" stroke="#9fb8c4" stroke-width="1.3"/>
        <polygon points="152,58 128,98 146,98 178,58" fill="#1a1f24" stroke="#9fb8c4" stroke-width="1.3"/>
        <!-- Fuselage & tailplane -->
        <polygon points="40,55 62,49 246,50 278,55 246,60 62,61" fill="#202428" stroke="#e0b060" stroke-width="1.4"/>
        <polygon points="42,55 28,36 48,36 58,52" fill="#1a1f24" stroke="#c98a3c" stroke-width="1.2"/>
        <polygon points="42,55 28,74 48,74 58,58" fill="#1a1f24" stroke="#c98a3c" stroke-width="1.2"/>
        <!-- Canopy & ventral sonde dispenser -->
        <ellipse cx="218" cy="55" rx="20" ry="4.2" fill="#142228" stroke="#6fa8c8" stroke-width="1.1"/>
        <rect x="148" y="51" width="28" height="8" fill="none" stroke="#c98a3c" stroke-width="1" stroke-dasharray="2 2"/>
        <!-- Pitot / alpha boom -->
        <line x1="278" y1="55" x2="304" y2="55" stroke="#e0b060" stroke-width="1.3"/>
        <circle cx="304" cy="55" r="2" fill="#c98a3c"/>
        <text x="12" y="16" fill="#8e8a80" font-size="8" font-family="monospace">ARS-X // 26M HIGH-ASPECT SURVEY AEROFRAME</text>
        <text x="18" y="98" fill="#9fb8c4" font-size="7.5" font-family="monospace">AR 18.7 WING</text>
        <text x="150" y="98" fill="#c98a3c" font-size="7.5" font-family="monospace">SONDE BAY</text>
        <text x="238" y="98" fill="#e0b060" font-size="7.5" font-family="monospace">ALPHA BOOM</text>
      </svg>`;
  }
}
