# THE TERMINUS HARMONIC

A multi-scale planetary-engineering sandbox set in the Starsilk universe.

Observe a dying remnant world as a *system*, descend into one physical machine,
repair one real problem, and watch the planet mathematically change because of
what you did. There is no combat and no hidden lever: every crisis is an
engineering problem with a physical cause, and the only way through is to
understand the machine you are standing in.

Built as an installable, offline-first PWA. No remote dependencies, no
telemetry, no login, no accounts.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run build      # typecheck + canon gate + production build into dist/
npm run verify     # typecheck + canon gate + full test suite
npm test           # just the tests
npm run canon      # canon QA gate only (add --json for a machine report)
```

`dist/` is a static bundle — serve it from any static host. The app is fully
playable offline once the service worker has cached it.

## Controls

| | |
|---|---|
| Orbit the globe | drag |
| Zoom | wheel |
| Cycle overlay | `Tab` (or the overlay button) |
| Select a node | click it, or use the crisis list |
| Descend | the briefing's descend button |
| Ascend to the globe | `M` |
| Possess / release machine | `F` |
| Camera | `C` |
| Settings | `Esc` |

Touch is fully supported: an on-screen stick and context action buttons appear
whenever you are inside a sector, and every vehicle reads the same merged axis
whether it came from a keyboard, a pointer or a finger.

---

## How it fits together

```
src/
  main.ts              WebGL probe, boot, failure path, debug handle
  game/
    Game.ts            orchestrator: one rAF loop, four scales, pooled vehicles
    scale.ts           MACRO / ORBIT / SECTOR scenes and the masked transition
    crisis.ts          objective progress and proportional planetary effects
  render/
    globe.ts           the Command Lattice globe and its seven overlay fields
    sky.ts             three sky domes, one per scale
    environment.ts     sector lighting, dust, hazard fluids
    orbitalLayer.ts    the orbital debris and corridor layer
  sector/
    field.ts           the sector terrain field (elevation, material, carving)
    terrain.ts         sector mesh streaming
  state/
    planetary.ts       the authoritative 14-variable causal simulation
    world.ts           game-local content: crises, spires, settlements, biomes
    save.ts            versioned IndexedDB persistence with migrations
  vehicle/             four machines, one shared base
  systems/             eleven ordered ECS systems
  core/                compact typed ECS, events, input, math, perf
  audio/               one procedural engine, all layers pre-created
  ui/                  HUD, briefings, settings, crisis list
  canon/               invariants, fixtures and the worked canon examples
```

### The three scales

The planetary, sector and orbital scenes do **not** share a coordinate space.
The planet is ~100 units, a sector is ~2 km, and the orbital scene works in
metres against a 6,371 km radius. Transitions re-root rather than scale one
world, and the cut between them is masked by a noise-driven vertical wipe. Sun
direction, horizon colour and the approach vector are carried across by the
caller, so descending feels like going closer rather than like a reload.

### The four machines

Each is a different physical model, not a reskin.

- **Orbital skiff** — 6-DOF, 42 t, RCS fuel budget, and tethers whose tension
  you have to manage while you haul derelict hulls into a stabilised corridor.
- **Land train** — 180 t loco, six bogies at 0.62 m² of contact each, tractive
  cap 4.6 MN. Ground pressure against bearing capacity is what decides whether
  a route is drivable, so salt flats bog you down and basalt does not.
- **Strata crawler** — drills, and carries a real heat budget: cutter
  temperature and hull stress both have to stay inside limits while you install
  heat-exchange infrastructure.
- **Atmospheric glider** — 620 kg on 22 m², stalls at 0.30 rad, and finds its
  altitude in thermals you have to read off the air.

### The planet responds

Fourteen variables — atmosphere, geology, hydrology, biosphere, orbit,
logistics, the harmonic network — are coupled by explicit rules. Completing an
objective applies a *proportional slice* of that crisis's resolution as a
permanent baseline shift, so the planet changes while you work, not only when
you finish. Local observations feed back into the macro state, and the macro
state changes what the sector feels like next time you land.

### The Terminus Harmonic

Twelve acoustic spires, of which only two work at the start. Coherence is phase
agreement times coverage, and the network only locks onto spires that have
actually been serviced — a freshly functional but unrepaired spire wanders, so
you cannot farm the Harmonic by waiting. It establishes itself once enough of
the network is live and what is live agrees on phase, and the reward is a
permanent baseline shift: a network holding the crust and atmosphere together
is infrastructure, not a buff.

---

## Canon

Starsilk is rare and dangerous, and it appears only as the azure/cyan
barcode-ribbon language of Macro traces and contained infrastructure — never as
fuel, never as something you mine, and never by pulling it out of a star. The
Blood Rings are atrocity artifacts, not jewellery around this world. The Siege
Wall is a starless absence. Death is final. There are no named canon characters,
no recordings of them, and no machines that think they are them. Drakken appear
only as geology, fossils and remnants — never as enemies.

These are not guidelines; they are enforced. `src/canon/invariants.json` holds
eleven prohibitions and eight required locks, each citing the lock it comes
from, with worked benign/violating examples in `src/canon/fixtures.json`.
`scripts/canon-check.mjs` runs over `src`, `scripts`, `public`, `tests` and
`index.html`, and is wired into both `npm run verify` and `npm run build`.

`tests/globe.test.ts` goes further and reads the actual overlay pixels the
renderer would upload, asserting that the Starsilk diagnostic language really
is azure and that no other overlay borrows it.

Game-local invention — the planet, the settlements, the corporations — is
labelled as such in `src/state/world.ts` and is not presented as established
canon.

---

## Verification

Everything below was run in this workspace:

| Check | Result |
|---|---|
| `npm run verify` | green — typecheck, canon gate, 167 tests |
| Canon gate | 50 files, 21,629 lines, 11 prohibitions, 8 required locks |
| `npx vitest run` | 167 passed across 16 files |
| `npm run build` | 2.46 kB html · 282.37 kB js · 484.12 kB three chunk · 28.41 kB css |
| Production preview | every route HTTP 200, hashed assets as `text/javascript` |
| Dev server | HTTP 200 on the preview host |
| `node --check public/sw.js` | parses as plain JavaScript |

The integration suite drives the real `Game` orchestrator inside jsdom with the
WebGL renderer replaced by a recording stub: boot, campaign start, node
selection, descent, sector construction, a possessed machine, simulated frames,
ascent, save, reload, export/import, teardown, and the full Terminus Harmonic
establishment path.

Two suites exist because the things they cover were asserted but unproven:

- `tests/serviceworker.test.ts` loads `public/sw.js` into a VM with stubbed
  `caches` and `fetch` and drives it through install, activation, asset
  precaching, offline navigation and offline asset fetch. It earned its keep
  immediately by catching a TypeScript type annotation that had been pasted into
  the plain-JS worker — which would have stopped the worker parsing at all and
  taken offline support down with it.
- `tests/audio.test.ts` asserts that no `AudioContext` node exists before a user
  gesture, that the engine is silent after disposal, and that it never opens a
  network connection. It also caught a race: `unlock()` awaited `resume()` and
  then read `this.ctx.state`, but `dispose()` nulls the context, so unlocking
  and disposing in the same tick threw an unhandled rejection.
- `tests/media.test.ts` and the OS-preference cases in the integration suite cover
  the accessibility settings: the game now *starts* in the configuration the
  user's operating system already asked for, instead of defaulting to full
  motion and screen shake and making them hunt for the toggle.
- `tests/newworld.test.ts` drives a real `Game` all the way to
  `harmonicUnlocked` through the crisis objectives, then calls `newWorld()` and
  asserts the result is genuinely fresh. It failed on its first run — all eight
  repaired spires, the unlocked Harmonic and the old campaign's domain points
  survived the "New World" button — which is the bug it was written to find.
- `tests/canon.test.ts` proves the canon gate has teeth rather than merely being
  green: it plants eight real violations in a real scannable file in a scratch
  copy of the tree and demands a non-zero exit that names the rule, then confirms
  an identical clean tree passes. A checker that always exited zero could not
  pass this suite. That test also found that the gate was not scanning
  `README.md` — the project's front door and its most canon-sensitive prose.
- `tests/uplift.test.ts` verifies possessed-vehicle stepping during sector and
  low-orbit gameplay, `worldGroup` separation from `object3D` across all four
  machines (so deployed debris, tethers, tunnel shells, heat-exchanger rigs and
  dropped sensors remain anchored in world coordinates), the Harmonic Phase-Lock
  Polar Scope, the 3D-projected globe reticle callout, the Settlement & Module
  Ledger, `varSense`-aware briefing forecast polarity, lock-reason banners, and
  ECS/UI rebinding across `newWorld()`.
- `tests/perf.test.ts` benchmarks and enforces regression guardrails across cold
  startup, cold/warm 7-mode overlay cycling, 300-frame MACRO and SECTOR loops,
  120-frame ORBIT and SECTOR descent transitions, `CommandGlobe` construction
  and state repaints, `TerrainRenderer` far/ring/chunk streaming, and repeated
  descent/ascent stress cycles.

### What is *not* verified

**Real browser rendering, frame rate, and PWA install.** Playwright's browser
download is blocked in this environment (`ECONNRESET` on `cdn.playwright.dev`),
so no GPU frame timing was measured and **no frame-rate claim is made anywhere
in this repository**. The performance figures quoted in the commit history are
Node CPU timings of the real code paths, obtained through the same test
harness; they are honest measurements of main-thread cost, but they are not
frame times.
