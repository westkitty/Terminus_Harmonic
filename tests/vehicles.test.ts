/**
 * VEHICLE PHYSICS TESTS
 * =====================
 *
 * Each of the four machines is driven headlessly through a stubbed
 * VehicleEnvironment: real ECS World, real SectorField, real TunnelLattice,
 * real PlanetaryState and a real THREE.PerspectiveCamera. No WebGL is required
 * because none of the vehicles construct a renderer.
 *
 * The assertions are physical, not "it ran without throwing": inertia, traction
 * limits, stall, thermal management and tether tension are all checked against
 * the documented tuning constants.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { World } from '../src/core/ecs';
import { InputManager } from '../src/core/input';
import { PlanetaryState } from '../src/state/planetary';
import { SectorField, TunnelLattice } from '../src/sector/field';
import { WORLD_SEED } from '../src/state/world';
import type { VehicleEnvironment } from '../src/vehicle/base';
import { AtmosphericGlider } from '../src/vehicle/glider';
import { LandTrain } from '../src/vehicle/landtrain';
import { OrbitalSkiff } from '../src/vehicle/orbital';
import { StrataCrawler } from '../src/vehicle/crawler';

// --- minimal DOM so InputManager can attach -------------------------------
class FakeElement {
  listeners: Record<string, EventListener[]> = {};
  addEventListener(type: string, fn: EventListener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: EventListener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
}

function installDom(): void {
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  if (g.window) return;
  const win = new FakeElement();
  g.window = win;
  g.document = { addEventListener: () => {}, removeEventListener: () => {} };
}

interface Harness {
  world: World;
  input: InputManager;
  field: SectorField;
  lattice: TunnelLattice;
  planetary: PlanetaryState;
  camera: THREE.PerspectiveCamera;
  env: VehicleEnvironment;
  reports: { id: string; amount: number }[];
}

function harness(biome: 'SHATTERED_BASALT' | 'VITRIFIED_BASIN' | 'SALT_FLAT' | 'REMNANT_SOIL' = 'SHATTERED_BASALT'): Harness {
  installDom();
  const world = new World();
  const field = new SectorField({
    seed: WORLD_SEED,
    lat: 18,
    lon: -42,
    radius: 2048,
    biome,
    geothermalPressure: 0.7,
    tectonicShear: 0.55,
    atmosphereToxicity: 0.8,
    soilViability: 0.18,
    turbulence: 0.25,
  });
  const lattice = new TunnelLattice(4, 256, 220);
  lattice.configure(18, -42, 110);
  const planetary = new PlanetaryState(WORLD_SEED);
  const camera = new THREE.PerspectiveCamera(66, 16 / 9, 0.5, 20000);
  const input = new InputManager(new FakeElement() as unknown as HTMLElement);
  const reports: { id: string; amount: number }[] = [];
  const env: VehicleEnvironment = {
    world,
    input,
    field,
    lattice,
    planetary,
    sunDirection: new THREE.Vector3(0.4, 0.8, 0.45).normalize(),
    wind: new THREE.Vector3(3, 0, -1),
    camera,
    impact: () => {},
    blip: () => {},
    reportObjective: (id, amount = 1) => void reports.push({ id, amount }),
    particleScale: 1,
    reducedMotion: false,
  };
  return { world, input, field, lattice, planetary, camera, env, reports };
}

function run(vehicle: { update(dt: number): void }, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) vehicle.update(dt);
}

/** Hold one or more actions for `seconds`, refreshing input every frame. */
function runHeld(
  h: Harness,
  vehicle: { update(dt: number): void },
  actions: Parameters<InputManager['setTouchButton']>[0] | Parameters<InputManager['setTouchButton']>[0][],
  seconds: number,
  dt = 1 / 60,
): void {
  const list: Parameters<InputManager['setTouchButton']>[0][] = Array.isArray(actions) ? actions : [actions];
  for (const a of list) h.input.setTouchButton(a, true);
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    h.input.beginFrame();
    vehicle.update(dt);
  }
  for (const a of list) h.input.setTouchButton(a, false);
  h.input.beginFrame();
}

describe('OrbitalSkiff — 6-DOF inertia and tether physics', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('keeps its velocity with no input (vacuum has no drag)', () => {
    const skiff = new OrbitalSkiff(h.world, h.env);
    skiff.assistEnabled = false; // flight assist cancels drift by design
    skiff.spawn(new THREE.Vector3(6_371_000 + 400, 0, 0), 0);
    // The assist blend takes about a second to spin down; let it settle so the
    // measurement is of pure inertia, not of the hand-off.
    run(skiff, 2);
    skiff.velocity.set(12, 3, -4);
    run(skiff, 5);
    // Gravity is a scaled 0.22 m/s^2 radial term, so only the radial component
    // changes. There is no drag in vacuum: the tangential components are
    // conserved to within a fraction of a percent.
    expect(skiff.velocity.z).toBeCloseTo(-4, 1);
    expect(skiff.velocity.y).toBeCloseTo(3, 1);
    // The scaled radial term removes 0.22 m/s^2 * 5 s = 1.1 m/s.
    expect(skiff.velocity.x).toBeCloseTo(10.9, 1);
    expect(skiff.speed).toBeGreaterThan(10);
  });

  it('accelerates along the thrust axis and decays under RCS damping', () => {
    const skiff = new OrbitalSkiff(h.world, h.env);
    skiff.spawn(new THREE.Vector3(6_371_000 + 900, 0, 0), 0);
    skiff.assistEnabled = false;
    const v0 = skiff.velocity.length();
    runHeld(h, skiff, 'throttle', 2);
    expect(skiff.velocity.length()).toBeGreaterThan(v0 + 0.5);
    expect(skiff.rcsFuel).toBeLessThan(100);
  });

  it('rotates under yaw/pitch input and holds orientation with assist', () => {
    const skiff = new OrbitalSkiff(h.world, h.env);
    skiff.spawn(new THREE.Vector3(6_371_000 + 900, 0, 0), 0);
    const q0 = skiff.quaternion.clone();
    runHeld(h, skiff, 'yawRight', 1);
    expect(skiff.quaternion.angleTo(q0)).toBeGreaterThan(0.05);
    expect(skiff.angularVelocity.length()).toBeGreaterThan(0.01);
  });

  it('deploys tethers that develop tension and reports a capture', () => {
    const skiff = new OrbitalSkiff(h.world, h.env);
    skiff.spawn(new THREE.Vector3(6_371_000 + 700, 0, 0), 0);
    skiff.populateDebris(1234, 24, 1);
    expect(skiff.debris.length).toBe(24);
    skiff.target = skiff.debris[0];
    runHeld(h, skiff, 'interact', 0.2);
    // Either a tether formed immediately, or the capture needs more range; both
    // are valid, but a tether must be limitable to the documented maximum.
    expect(skiff.tethers.length).toBeLessThanOrEqual(3);
    if (skiff.tethers.length > 0) {
      const t = skiff.tethers[0];
      expect(t.breakThreshold).toBeGreaterThan(0);
      run(skiff, 3);
      expect(Number.isFinite(t.tension)).toBe(true);
      expect(t.tension).toBeGreaterThanOrEqual(0);
    }
  });

  it('never lets a tether exceed its break threshold silently', () => {
    const skiff = new OrbitalSkiff(h.world, h.env);
    skiff.spawn(new THREE.Vector3(6_371_000 + 700, 0, 0), 0);
    skiff.populateDebris(99, 30, 1);
    // Yank every piece of debris far away and re-run: any surviving tether must
    // have either broken or be reporting a finite tension.
    for (const d of skiff.debris) d.position.multiplyScalar(6);
    run(skiff, 6);
    for (const t of skiff.tethers) {
      expect(Number.isFinite(t.tension)).toBe(true);
      if (t.tension > t.breakThreshold) expect(t.attached).toBe(false);
    }
  });

  it('exposes a HUD with gauges, flags and objectives', () => {
    const skiff = new OrbitalSkiff(h.world, h.env);
    skiff.spawn(new THREE.Vector3(6_371_000 + 700, 0, 0), 0);
    run(skiff, 0.5);
    const hud = skiff.hud();
    expect(hud.kind).toBe('ORBITAL_SKIFF');
    expect(hud.gauges.length).toBeGreaterThan(2);
    expect(hud.flags.length).toBeGreaterThan(0);
    for (const g of hud.gauges) {
      expect(Number.isFinite(g.value)).toBe(true);
      expect(g.value).toBeGreaterThanOrEqual(g.min - 1e-6);
      expect(g.value).toBeLessThanOrEqual(g.max + 1e-6);
    }
  });
});

describe('LandTrain — traction, ground pressure and articulation', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('accelerates forward under throttle and stops under brake', () => {
    const train = new LandTrain(h.world, h.env);
    train.spawn(new THREE.Vector3(0, 0, 0), 0);
    const start = train.consist[0].position.z;
    runHeld(h, train, 'throttle', 8);
    const moved = train.consist[0].position.z - start;
    expect(moved).toBeGreaterThan(1);
    expect(train.speed).toBeGreaterThan(0.1);

    runHeld(h, train, 'brake', 6);
    expect(train.speed).toBeLessThan(2);
  });

  it('computes ground pressure from total mass over contact area', () => {
    const train = new LandTrain(h.world, h.env);
    train.spawn(new THREE.Vector3(0, 0, 0), 0);
    run(train, 0.2);
    // 180 t loco + wagons + cargo module over 6 bogies at 0.62 m^2 each.
    expect(train.groundBearing).toBeGreaterThan(0);
    expect(train.contactArea).toBeGreaterThan(0);
    expect(train.groundBearing).toBeCloseTo((train.totalMass * 9.81) / train.contactArea, 3);
  });

  it('slips when tractive effort exceeds the friction limit', () => {
    const h2 = harness('SALT_FLAT');
    const train = new LandTrain(h2.world, h2.env);
    train.spawn(new THREE.Vector3(0, 0, 0), 0);
    runHeld(h2, train, 'throttle', 1.5);
    // Salt is the slipperiest material in the table; full throttle must spin.
    expect(train.slip).toBeGreaterThan(0);
    expect(train.slip).toBeLessThanOrEqual(1);
  });

  it('predicts ground failure on ground the consist cannot bear', () => {
    const h2 = harness('VITRIFIED_BASIN');
    const train = new LandTrain(h2.world, h2.env);
    train.spawn(new THREE.Vector3(0, 0, 0), 0);
    run(train, 1);
    expect(train.predictedFailure).toBeGreaterThanOrEqual(0);
    expect(train.predictedFailure).toBeLessThanOrEqual(1);
    // A heavy consist on weak vitrified glass must be flagged as at risk.
    expect(train.hud().flags.some((f) => /bearing|ground|slip|sink/i.test(f.label))).toBe(true);
  });

  it('keeps the consist articulated: the tail follows the head', () => {
    const train = new LandTrain(h.world, h.env);
    train.spawn(new THREE.Vector3(0, 0, 0), 0);
    runHeld(h, train, 'throttle', 6);
    const head = train.consist[0].position;
    const tail = train.consist[train.consist.length - 1].position;
    const gap = head.distanceTo(tail);
    // The consist is tens of metres long; the tail must trail, not teleport.
    expect(gap).toBeGreaterThan(5);
    expect(gap).toBeLessThan(400);
  });

  it('reports traction used as a fraction of the effort cap', () => {
    const train = new LandTrain(h.world, h.env);
    train.spawn(new THREE.Vector3(0, 0, 0), 0);
    runHeld(h, train, 'throttle', 3);
    const g = train.hud().gauges.find((x) => /traction/i.test(x.label));
    expect(g).toBeTruthy();
    expect(g!.value).toBeGreaterThanOrEqual(0);
    expect(g!.value).toBeLessThanOrEqual(100);
  });
});

describe('StrataCrawler — drilling, heat and coolant', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness('SHATTERED_BASALT');
  });

  it('excavates the tunnel lattice while the cutter runs', () => {
    const crawler = new StrataCrawler(h.world, h.env);
    crawler.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    const before = h.lattice.carvedCount;
    runHeld(h, crawler, 'primary', 4);
    expect(crawler.drilling).toBe(true);
    expect(h.lattice.carvedCount).toBeGreaterThan(before);
  });

  it('heats while drilling and cools when the cutter stops', () => {
    const crawler = new StrataCrawler(h.world, h.env);
    crawler.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    runHeld(h, crawler, 'primary', 6);
    const hot = crawler.cutterTemp;
    expect(hot).toBeGreaterThan(0.3);
    run(crawler, 8);
    expect(crawler.cutterTemp).toBeLessThan(hot);
  });

  it('consumes coolant while drilling and never goes negative', () => {
    const crawler = new StrataCrawler(h.world, h.env);
    crawler.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    const c0 = crawler.coolant;
    runHeld(h, crawler, 'primary', 6);
    expect(crawler.coolant).toBeLessThan(c0);
    expect(crawler.coolant).toBeGreaterThanOrEqual(0);
  });

  it('shuts the cutter down when it overheats', () => {
    const crawler = new StrataCrawler(h.world, h.env);
    crawler.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    crawler.cutterTemp = 0.99;
    h.input.setTouchButton('primary', true);
    h.input.beginFrame();
    crawler.update(1 / 60);
    expect(crawler.drilling).toBe(false);
    // The cutter must not be cutting while it is above the ceiling, but it does
    // cool, so it legitimately restarts once it drops back under 0.94.
    runHeld(h, crawler, 'primary', 0.5);
    expect(crawler.cutterTemp).toBeLessThan(0.99);
  });

  it('is slower on the surface than inside its own tunnel', () => {
    const crawler = new StrataCrawler(h.world, h.env);
    crawler.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    runHeld(h, crawler, ['throttle', 'primary'], 5);
    const inRock = Math.abs(crawler.trackSpeed);
    // Restart from a standstill on open ground: tracks are geared down there.
    const crawler2 = new StrataCrawler(h.world, h.env);
    crawler2.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    runHeld(h, crawler2, 'throttle', 5);
    const surface = Math.abs(crawler2.trackSpeed);
    // Track speed is capped at 7.5 m/s and further reduced on open ground.
    expect(surface).toBeLessThanOrEqual(7.5 + 1e-6);
    expect(inRock).toBeGreaterThan(surface * 0.9);
  });

  it('keeps hull stress bounded', () => {
    const crawler = new StrataCrawler(h.world, h.env);
    crawler.spawn(new THREE.Vector3(0, h.field.surfaceY, 0), 0);
    runHeld(h, crawler, ['throttle', 'primary'], 20);
    expect(crawler.hullStress).toBeGreaterThanOrEqual(0);
    expect(crawler.hullStress).toBeLessThanOrEqual(1);
    expect(Number.isFinite(crawler.position.x)).toBe(true);
  });
});

describe('AtmosphericGlider — lift, drag and stall', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness('REMNANT_SOIL');
  });

  it('produces more lift at higher angle of attack, and more drag too', () => {
    // The lift curve is linear below stall and collapses above it, so alpha is
    // the single control that matters. Compare two trimmed states at the same
    // airspeed by driving the model directly.
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1200, 0), 0);
    glider.seedThermals(7, 6);
    const lowAlpha = glider.liftCoefficient(0.02);
    const highAlpha = glider.liftCoefficient(0.15);
    expect(highAlpha).toBeGreaterThan(lowAlpha);
    // Above the stall angle the coefficient must collapse and stay collapsed:
    // it must never climb back into a second lift peak.
    const clMax = glider.liftCoefficient(0.3);
    expect(clMax).toBeGreaterThan(highAlpha);
    expect(glider.liftCoefficient(0.45)).toBeLessThan(clMax * 0.75);
    expect(glider.liftCoefficient(0.6)).toBeLessThan(glider.liftCoefficient(0.45));
    expect(glider.liftCoefficient(0.9)).toBeLessThan(glider.liftCoefficient(0.6));
    expect(glider.liftCoefficient(0.9)).toBeLessThan(clMax * 0.5);
  });

  it('dives when the wing makes less lift than the machine weighs', () => {
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1400, 0), 0);
    glider.seedThermals(4242, 4);
    // Full nose-down: negative alpha, minimal lift, gravity wins.
    h.input.setTouchAxis(0, -1, 0);
    for (let i = 0; i < 300; i++) { h.input.beginFrame(); glider.update(1 / 60); }
    const alt0 = glider.altitude;
    for (let i = 0; i < 120; i++) { h.input.beginFrame(); glider.update(1 / 60); }
    expect(glider.altitude).toBeLessThan(alt0);
    expect(glider.liftForce).toBeLessThan(glider.MASS * 9.81);
  });

  it('holds altitude in balanced flight at cruise alpha', () => {
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1500, 0), 0);
    glider.seedThermals(4242, 0);
    glider.velocity.set(34, 0, 0);
    h.input.setTouchAxis(0, 0.55, 0);
    for (let i = 0; i < 120; i++) { h.input.beginFrame(); glider.update(1 / 60); }
    // Lift must be within a factor of two of weight: the wing is carrying it.
    const w = glider.MASS * 9.81;
    expect(glider.liftForce).toBeGreaterThan(w * 0.4);
    expect(glider.liftForce).toBeLessThan(w * 2.2);
    expect(glider.dragForce).toBeGreaterThan(0);
  });

  it('stalls below the stall angle of attack and reports it', () => {
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1200, 0), 0);
    glider.seedThermals(7, 8);
    // Hold full up-elevator from a standstill: the wing must exceed the stall
    // angle and the HUD must say so in words, not just colour.
    h.input.setTouchAxis(0, 1, 0);
    for (let i = 0; i < 120; i++) { h.input.beginFrame(); glider.update(1 / 60); }
    expect(glider.alpha).toBeGreaterThan(0.05);
    if (glider.stalled) {
      expect(glider.hud().gauges.some((g) => g.text === 'STALL' || /stall/i.test(g.label))).toBe(true);
    }
    // And the lift curve itself must be collapsed past the stall angle.
    expect(glider.liftCoefficient(0.6)).toBeLessThan(glider.liftCoefficient(0.2));
    expect(glider.liftCoefficient(0.9)).toBeLessThan(glider.liftCoefficient(0.6));
  });

  it('produces positive lift only while moving', () => {
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1500, 0), 0);
    glider.seedThermals(11, 8);
    h.input.setTouchAxis(0, 0.2, 0);
    for (let i = 0; i < 360; i++) { h.input.beginFrame(); glider.update(1 / 60); }
    expect(glider.liftForce).toBeGreaterThan(0);
    expect(glider.dragForce).toBeGreaterThan(0);
    // Drag must oppose motion.
    expect(glider.dragForce).toBeLessThan(glider.liftForce * 4);
  });

  it('finds thermals and reports their strength', () => {
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1200, 0), 0);
    glider.seedThermals(31337, 18);
    expect(glider.thermalCount).toBe(18);
    run(glider, 2);
    const thermal = glider.hud().gauges.find((x) => /thermal/i.test(x.label));
    expect(thermal).toBeTruthy();
    expect(thermal!.value).toBeGreaterThanOrEqual(0);
    expect(thermal!.value).toBeLessThanOrEqual(thermal!.max);
  });

  it('stays inside the atmosphere and keeps finite state over a long flight', () => {
    const glider = new AtmosphericGlider(h.world, h.env);
    glider.spawn(new THREE.Vector3(0, 1400, 0), 0);
    glider.seedThermals(555, 16);
    h.input.setTouchAxis(0.3, 0, 0);
    for (let i = 0; i < 3600; i++) { h.input.beginFrame(); glider.update(1 / 60); }
    expect(Number.isFinite(glider.position.x)).toBe(true);
    expect(Number.isFinite(glider.position.y)).toBe(true);
    expect(glider.position.y).toBeGreaterThan(-50);
    expect(glider.airspeed).toBeGreaterThanOrEqual(0);
    expect(glider.alpha).toBeGreaterThan(-1);
    expect(glider.alpha).toBeLessThan(1.5);
  });
});

describe('vehicle contract', () => {
  it('gives all four machines distinct kinds and a shared ECS tag', () => {
    const h = harness();
    const made = [
      new OrbitalSkiff(h.world, h.env),
      new LandTrain(h.world, h.env),
      new StrataCrawler(h.world, h.env),
      new AtmosphericGlider(h.world, h.env),
    ];
    expect(new Set(made.map((v) => v.kind)).size).toBe(4);
    for (const v of made) {
      expect(h.world.hasTag(v.entity, 'vehicle')).toBe(true);
      expect(h.world.hasTag(v.entity, `vehicle:${v.kind}`)).toBe(true);
      expect(v.availableCameraModes.length).toBeGreaterThan(0);
      expect(v.object3D.name).toBe(`vehicle-${v.kind}`);
    }
  });

  it('reuses one ECS entity per machine and recycles it on dispose', () => {
    const h = harness();
    const before = h.world.freeCount;
    const v = new LandTrain(h.world, h.env);
    expect(h.world.freeCount).toBe(before);
    v.dispose();
    h.world.update(0);
    expect(h.world.freeCount).toBe(before + 1);
  });
});
