/**
 * VEHICLE 2 — HEAVY LAND-TRAIN
 * =============================
 *
 * A modular articulated consist. It must feel heavy: tractive effort is finite,
 * braking distance is long, and the limiting constraint on the glass basins is
 * ground bearing pressure rather than distance.
 *
 * Modelled explicitly:
 *   - six powered bogies with suspension travel and per-bogie load transfer
 *   - traction limited by friction x driven wheel load, reduced by grade
 *   - rolling resistance from the ground material
 *   - ground bearing pressure vs. local bearing capacity -> predicted failure
 *   - brake thermal accumulation and fade
 *   - cargo mass and cargo stability under lateral load
 *   - articulation: the consist follows a path history so it bends over terrain
 *
 * It does not handle like a sports car and is not tuned to.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, smoothstep } from '../core/math';
import { VehicleBase, type CameraMode, type HudModel, type VehicleEnvironment, gauge, PALETTE } from './base';
import type { World } from '../core/ecs';

const G = 9.81;
const LOCO_MASS = 180_000; // kg
const WAGON_MASS = 88_000;
const MAX_WAGONS = 6;
const CARGO_PER_MODULE = 34_000; // kg
const BOGIE_COUNT = 6;
const BOGIE_SPACING = 7.2; // m
const WHEEL_CONTACT_AREA = 0.62; // m^2 per wheel contact
const CONTACTS_PER_BOGIE = 2;
const MAX_TRACTIVE_EFFORT = 4.6e6; // N
const MAX_BRAKE_EFFORT = 6.2e6;
const ENGINE_POWER = 5.2e6; // W

interface Bogie {
  load: number;
  travel: number;
  stress: number;
  driven: boolean;
  mesh: THREE.Object3D;
  wheelMeshes: THREE.Mesh[];
}

interface Segment {
  position: THREE.Vector3;
  heading: number;
  length: number;
  mesh: THREE.Object3D;
}

export interface DeliveryZone {
  id: string;
  position: THREE.Vector3;
  radius: number;
  kind: 'PICKUP' | 'DROPOFF';
  label: string;
  marker: THREE.Mesh;
  delivered: number;
}

export class LandTrain extends VehicleBase {
  readonly kind = 'LAND_TRAIN' as const;
  readonly availableCameraModes: readonly CameraMode[] = ['CHASE', 'INSPECT'];

  speedAlong = 0;
  private steerAngle = 0;

  private segments: Segment[] = [];
  private trail: { p: THREE.Vector3; h: number }[] = [];
  private readonly trailSpacing = 2.2;
  private wagonCount = 3;

  private bogies: Bogie[] = [];

  locoMass = LOCO_MASS;
  private cargoMass = 0;
  private cargoModules = 0;
  readonly cargoCapacity = 6;

  brakeTemp = 0;
  private engineTemp = 0.35;

  groundBearing = 0;
  localBearingCapacity = 0;
  predictedFailure = 0;
  traction = 0;
  slip = 0;
  currentSlope = 0;
  materialName = '';

  readonly zones: DeliveryZone[] = [];

  /** Articulated consist: index 0 is the loco, the rest trail behind it. */
  get consist(): readonly Segment[] {
    return this.segments;
  }

  /** Total consist mass in kg: loco + wagons + cargo modules. */
  get totalMass(): number {
    return this.locoMass + this.wagonCount * WAGON_MASS + this.cargoMass;
  }

  /** Sum of every wheel contact patch, m^2. */
  get contactArea(): number {
    return BOGIE_COUNT * CONTACTS_PER_BOGIE * WHEEL_CONTACT_AREA;
  }
  private zoneGroup = new THREE.Group();
  private cargoMeshes: THREE.Object3D[] = [];
  private brakeMaterials: THREE.MeshStandardMaterial[] = [];

  private smoothEngine = 0;
  private smoothRumble = 0;
  private lastCreakAt = 0;

  private _v1 = new THREE.Vector3();
  private _v2 = new THREE.Vector3();

  constructor(world: World, env: VehicleEnvironment) {
    super(world, env, 'LAND_TRAIN');
    this.buildConsist();
    this.buildBogies();
    this.worldGroup.add(this.zoneGroup);
  }

  override get worldPosition(): THREE.Vector3 {
    return this.segments[0].position;
  }

  private buildConsist(): void {
    const locoMat = new THREE.MeshStandardMaterial({ color: PALETTE.rust, metalness: 0.62, roughness: 0.7 });
    const wagonMat = new THREE.MeshStandardMaterial({ color: PALETTE.darkRust, metalness: 0.55, roughness: 0.78 });
    const steelMat = new THREE.MeshStandardMaterial({ color: PALETTE.darkSteel, metalness: 0.7, roughness: 0.55 });

    const loco = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.4, 12.5), locoMat);
    body.position.y = 2.6;
    loco.add(body);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.8, 4.2), locoMat);
    cab.position.set(0, 5.0, -3.2);
    loco.add(cab);
    // Armored cab visor + twin forward headlamps + roof strobe.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(4.2, 0.75, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x1a262e, metalness: 0.9, roughness: 0.2 }),
    );
    visor.position.set(0, 5.35, -5.32);
    loco.add(visor);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffebb3, toneMapped: false });
    for (const lx of [-1.65, 1.65]) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.4, 8), lampMat);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(lx, 3.1, -6.35);
      loco.add(lamp);
    }
    const roofBeacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 8, 6),
      new THREE.MeshBasicMaterial({ color: PALETTE.amber, toneMapped: false }),
    );
    roofBeacon.position.set(0, 6.65, -3.2);
    loco.add(roofBeacon);
    for (const sx of [-1.5, 1.5]) {
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 3.2, 8), steelMat);
      stack.position.set(sx, 5.2, 1.4);
      loco.add(stack);
    }
    const grill = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.6, 0.3), steelMat);
    grill.position.set(0, 2.4, 6.3);
    loco.add(grill);
    const coupler = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.6), steelMat);
    coupler.position.set(0, 1.1, 6.6);
    loco.add(coupler);

    this.segments.push({ position: new THREE.Vector3(), heading: 0, length: 13, mesh: loco });
    this.object3D.add(loco);

    for (let i = 0; i < MAX_WAGONS; i++) {
      const wagon = new THREE.Group();
      const bed = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.0, 11), wagonMat);
      bed.position.y = 2.3;
      wagon.add(bed);
      const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2.2, 11), wagonMat);
      sideL.position.set(-2.35, 3.4, 0);
      wagon.add(sideL);
      const sideR = sideL.clone();
      sideR.position.x = 2.35;
      wagon.add(sideR);
      const deck = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.2, 10.4), steelMat);
      deck.position.y = 3.4;
      wagon.add(deck);

      // Removable habitat / reactor cargo module seated on the wagon deck.
      const cargo = new THREE.Group();
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(3.6, 2.1, 8.8),
        new THREE.MeshStandardMaterial({ color: PALETTE.steel, metalness: 0.58, roughness: 0.62 }),
      );
      crate.position.y = 4.55;
      cargo.add(crate);
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(3.68, 0.14, 8.86),
        new THREE.MeshBasicMaterial({ color: PALETTE.amber, toneMapped: false }),
      );
      band.position.y = 5.1;
      cargo.add(band);
      cargo.visible = false;
      wagon.add(cargo);
      this.cargoMeshes.push(cargo);

      wagon.visible = i < this.wagonCount;
      this.segments.push({ position: new THREE.Vector3(), heading: 0, length: 12, mesh: wagon });
      this.object3D.add(wagon);
    }
  }

  private buildBogies(): void {
    const frameMat = new THREE.MeshStandardMaterial({ color: PALETTE.darkSteel, metalness: 0.68, roughness: 0.6 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x24262a, metalness: 0.85, roughness: 0.45 });
    const wheelGeo = new THREE.CylinderGeometry(1.35, 1.35, 0.85, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const strutGeo = new THREE.CylinderGeometry(0.22, 0.28, 1.35, 6);
    const hubGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.96, 8);
    hubGeo.rotateZ(Math.PI / 2);

    for (let i = 0; i < BOGIE_COUNT; i++) {
      const bogie = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.6, 2.2), frameMat);
      frame.position.y = 1.5;
      bogie.add(frame);
      const brakeMat = new THREE.MeshStandardMaterial({
        color: 0x3b2820,
        emissive: 0x000000,
        metalness: 0.7,
        roughness: 0.45,
      });
      this.brakeMaterials.push(brakeMat);
      const wheels: THREE.Mesh[] = [];
      for (const wx of [-1.9, 1.9]) {
        const w = new THREE.Mesh(wheelGeo, wheelMat);
        w.position.set(wx, 0, 0);
        const hub = new THREE.Mesh(hubGeo, brakeMat);
        w.add(hub);
        bogie.add(w);
        wheels.push(w);

        const strut = new THREE.Mesh(strutGeo, frameMat);
        strut.position.set(wx * 0.82, 0.85, 0);
        bogie.add(strut);
      }
      const z = -BOGIE_SPACING * (BOGIE_COUNT - 1) * 0.5 + i * BOGIE_SPACING;
      bogie.position.set(0, 0, z);
      this.object3D.add(bogie);
      this.bogies.push({ load: 0, travel: 0.5, stress: 0, driven: i < 3, mesh: bogie, wheelMeshes: wheels });
    }
  }

  setZones(zones: Omit<DeliveryZone, 'marker' | 'delivered'>[]): void {
    this.clearZones();
    for (const z of zones) {
      const zoneColor = z.kind === 'PICKUP' ? 0x7fa8b8 : 0xc8a24a;
      const geo =
        z.kind === 'PICKUP'
          ? new THREE.CylinderGeometry(z.radius, z.radius, 1.2, 20)
          : new THREE.BoxGeometry(z.radius * 1.6, 1.2, z.radius * 1.6);
      const marker = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: zoneColor,
          transparent: true,
          opacity: 0.32,
          toneMapped: false,
        }),
      );
      // Tall depot gantry pylon + beacon ring so pickup/dropoff zones are visible across the sector.
      const pylon = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.85, 18, 6),
        new THREE.MeshStandardMaterial({ color: PALETTE.darkSteel, metalness: 0.7, roughness: 0.5 }),
      );
      pylon.position.set(z.radius * 0.75, 8.5, 0);
      marker.add(pylon);
      const beacon = new THREE.Mesh(
        new THREE.TorusGeometry(2.4, 0.28, 6, 16),
        new THREE.MeshBasicMaterial({ color: zoneColor, toneMapped: false }),
      );
      beacon.rotation.x = Math.PI / 2;
      beacon.position.set(z.radius * 0.75, 17.6, 0);
      marker.add(beacon);

      marker.position.copy(z.position);
      marker.position.y = this.env.field.elevation(z.position.x, z.position.z) + 0.6;
      this.zoneGroup.add(marker);
      this.zones.push({ ...z, marker, delivered: 0 });
    }
  }

  private clearZones(): void {
    for (const z of this.zones) {
      this.zoneGroup.remove(z.marker);
      z.marker.geometry.dispose();
      (z.marker.material as THREE.Material).dispose();
    }
    this.zones.length = 0;
  }

  spawn(position: THREE.Vector3, headingRad: number): void {
    this.segments[0].position.copy(position);
    this.segments[0].heading = headingRad;
    this.speedAlong = 0;
    this.brakeTemp = 0;
    this.cargoMass = 0;
    this.cargoModules = 0;
    // Seed the trail *behind* the spawn point. A trail of coincident points
    // would leave every following segment stacked on the spawn position until
    // the loco had travelled a full trail spacing.
    this.trail.length = 0;
    const maxTrail = Math.ceil((this.segments.length * 14 + 40) / this.trailSpacing);
    for (let i = 0; i < maxTrail; i++) {
      const back = i * this.trailSpacing;
      this.trail.push({
        p: new THREE.Vector3(
          position.x - Math.sin(headingRad) * back,
          position.y,
          position.z - Math.cos(headingRad) * back,
        ),
        h: headingRad,
      });
    }
    // Bogie loads are what traction is limited by, so they must exist before
    // the first frame or the consist starts with zero grip.
    this.updateBogies(0);
    this.updateSegmentPlacement(1 / 60);
  }

  setWagonCount(n: number): void {
    this.wagonCount = clamp(Math.round(n), 0, MAX_WAGONS);
    this.segments.forEach((s, i) => {
      s.mesh.visible = i === 0 || i <= this.wagonCount;
    });
  }

  update(dt: number): void {
    const input = this.env.input;
    const field = this.env.field;
    const step = Math.min(dt, 1 / 30);

    const pos = this.segments[0].position;
    const heading = this.segments[0].heading;

    const ahead = 14;
    const groundY = field.elevation(pos.x, pos.z);
    const aheadY = field.elevation(pos.x + Math.sin(heading) * ahead, pos.z + Math.cos(heading) * ahead);
    this.currentSlope = Math.atan2(aheadY - groundY, ahead);
    this.materialName = field.materialLabel;
    const graderBoost = this.hasModule('Route Grader') ? 1.28 : 1;
    const cap = field.material.bearingCapacity * 1000 * graderBoost;
    this.localBearingCapacity = cap;
    this.groundBearing = (this.totalMass * G) / this.contactArea;

    let worstBearing = 1;
    for (let d = 10; d <= 90; d += 12) {
      const b = field.bearing(pos.x + Math.sin(heading) * d, pos.z + Math.cos(heading) * d);
      if (b < worstBearing) worstBearing = b;
    }
    if (this.hasModule('Route Grader')) worstBearing = clamp01(worstBearing + 0.16);
    const pressureRatio = this.groundBearing / Math.max(1, cap);
    this.predictedFailure = clamp01(smoothstep(0.55, 1.25, pressureRatio) * 0.7 + (1 - worstBearing) * 0.3);

    const throttleIn = clamp(input.axis.throttle, -1, 1);
    const steerIn = clamp(input.axis.x, -1, 1);
    const braking = input.held('brake');

    const mu = field.material.friction * (this.hasModule('Bogie Load Balancer') ? 1.2 : 1);
    const drivenLoad = this.bogies.reduce((s, b) => s + (b.driven ? b.load : 0), 0);
    const tractionLimit = mu * drivenLoad * Math.cos(this.currentSlope);
    const gradeForce = this.totalMass * G * Math.sin(this.currentSlope);
    const crr = field.material.rollingResistance * (1 + Math.abs(this.speedAlong) * 0.006);
    const rollForce = crr * this.totalMass * G * Math.cos(this.currentSlope);

    const sinkPenalty = 1 + this.predictedFailure * 5.5;
    const resistForce = rollForce * sinkPenalty + gradeForce;

    let tractiveEffort = 0;
    if (throttleIn > 0.01) {
      const powerEffort = ENGINE_POWER / Math.max(2.5, Math.abs(this.speedAlong));
      tractiveEffort = Math.min(MAX_TRACTIVE_EFFORT, powerEffort) * throttleIn;
    } else if (throttleIn < -0.01) {
      tractiveEffort = MAX_TRACTIVE_EFFORT * 0.35 * throttleIn;
    }

    if (Math.abs(tractiveEffort) > tractionLimit) {
      this.slip = clamp01((Math.abs(tractiveEffort) - tractionLimit) / Math.max(1, tractionLimit));
      tractiveEffort = Math.sign(tractiveEffort) * tractionLimit;
    } else {
      this.slip = damp(this.slip, 0, 6, step);
    }
    this.traction = Math.abs(tractiveEffort);

    let brakeForce = 0;
    if (braking) {
      const thermalFade = 1 - smoothstep(0.55, 1.0, this.brakeTemp) * 0.65;
      let magnitude = MAX_BRAKE_EFFORT * thermalFade;
      if (Math.abs(this.speedAlong) < 0.35) magnitude = Math.abs(this.speedAlong) * magnitude * 3;
      // Brakes oppose the direction of travel. Without the sign they push a
      // consist that is already rolling backwards even faster backwards. When
      // the consist is stationary they hold against the grade instead.
      const dir =
        Math.abs(this.speedAlong) > 0.02 ? Math.sign(this.speedAlong) : Math.sign(-resistForce) || 1;
      brakeForce = dir * magnitude;
      this.brakeTemp = clamp01(this.brakeTemp + step * 0.055 * (0.4 + Math.abs(this.speedAlong) * 0.06));
    } else {
      this.brakeTemp = clamp01(this.brakeTemp - step * 0.045);
      brakeForce = Math.sign(this.speedAlong) * Math.min(Math.abs(this.speedAlong) * 40_000, MAX_BRAKE_EFFORT * 0.12);
    }

    const netForce = tractiveEffort - resistForce - brakeForce;
    this.speedAlong += (netForce / this.totalMass) * step;
    if (Math.abs(this.speedAlong) < 0.02 && Math.abs(throttleIn) < 0.01) this.speedAlong = 0;
    this.speedAlong = clamp(this.speedAlong, -9, 26);

    const steerAuthority = (1 - smoothstep(8, 24, Math.abs(this.speedAlong))) * (1 - this.predictedFailure * 0.6);
    this.steerAngle = damp(this.steerAngle, steerIn * 0.55 * steerAuthority, 3.5, step);

    const yawRate = (this.speedAlong / 13) * Math.tan(this.steerAngle);
    const newHeading = heading + yawRate * step;

    pos.x += Math.sin(newHeading) * this.speedAlong * step;
    pos.z += Math.cos(newHeading) * this.speedAlong * step;
    pos.y = groundY;

    this.pushTrail(pos, newHeading);
    this.segments[0].heading = newHeading;

    this.updateBogies(netForce);

    const loadFrac = clamp01(this.traction / MAX_TRACTIVE_EFFORT);
    this.engineTemp = clamp01(this.engineTemp + (loadFrac * 0.09 - 0.035) * step);
    this.heat = this.engineTemp * 0.6 + this.brakeTemp * 0.4;

    this.smoothEngine = damp(this.smoothEngine, loadFrac, 4, step);
    this.smoothRumble = damp(this.smoothRumble, clamp01(Math.abs(this.speedAlong) / 14 + this.predictedFailure), 5, step);
    const surfaceRattle = clamp01(Math.abs(this.speedAlong) / 12);
    if (surfaceRattle > 0.25 && performance.now() - this.lastCreakAt > 700) {
      this.lastCreakAt = performance.now();
      this.env.impact(surfaceRattle * 0.18, 0.55);
    }

    this.updateSegmentPlacement(step);
    this.speed = Math.abs(this.speedAlong);
    this.drive = this.smoothEngine;
    this.secondaryDrive = this.smoothRumble;
    this.turbulence = 0;
    this.stress = clamp01(
      Math.max(
        this.predictedFailure * 0.9,
        this.brakeTemp * 0.5,
        Math.max(...this.bogies.map((b) => b.stress)) * 0.8,
        this.slip * 0.6,
      ),
    );

    this.updateZones(step);

    if (input.pressed('primary')) this.primary();
    if (input.pressed('interact')) this.interact();
  }

  private pushTrail(pos: THREE.Vector3, heading: number): void {
    const last = this.trail[0];
    if (!last || last.p.distanceToSquared(pos) >= this.trailSpacing * this.trailSpacing) {
      this.trail.unshift({ p: pos.clone(), h: heading });
      const maxTrail = Math.ceil((this.segments.length * 14 + 40) / this.trailSpacing);
      if (this.trail.length > maxTrail) this.trail.length = maxTrail;
    } else {
      last.p.copy(pos);
      last.h = heading;
    }
  }

  private updateSegmentPlacement(dt: number): void {
    let arc = 0;
    let segIndex = 1;
    let trailIndex = 0;
    let targetArc = this.segments[0].length * 0.5 + 2.5;
    const spin = dt * (this.speedAlong / 1.35);

    while (segIndex < this.segments.length && trailIndex < this.trail.length - 1) {
      const a = this.trail[trailIndex];
      const b = this.trail[trailIndex + 1];
      const d = a.p.distanceTo(b.p);
      if (arc + d >= targetArc) {
        const t = (targetArc - arc) / Math.max(1e-4, d);
        const seg = this.segments[segIndex];
        seg.position.lerpVectors(a.p, b.p, clamp01(t));
        seg.heading = Math.atan2(b.p.x - a.p.x, b.p.z - a.p.z);
        seg.mesh.position.copy(seg.position);
        seg.mesh.position.y = this.env.field.elevation(seg.position.x, seg.position.z);
        seg.mesh.rotation.y = seg.heading;
        seg.mesh.rotation.x = -this.gradeAt(seg.position, seg.heading);
        targetArc += seg.length + 2.5;
        segIndex++;
      } else {
        arc += d;
        trailIndex++;
      }
    }

    const lead = this.segments[0];
    lead.mesh.position.copy(lead.position);
    lead.mesh.position.y = this.env.field.elevation(lead.position.x, lead.position.z);
    lead.mesh.rotation.y = lead.heading;
    lead.mesh.rotation.x = -this.gradeAt(lead.position, lead.heading);
    lead.mesh.rotation.z = damp(lead.mesh.rotation.z, -this.steerAngle * 0.12, 4, Math.max(dt, 1 / 60));

    for (let i = 0; i < this.bogies.length; i++) {
      const b = this.bogies[i];
      const host = this.segments[Math.min(i, this.segments.length - 1)];
      for (const w of b.wheelMeshes) w.rotation.x -= spin;
      b.travel = damp(b.travel, clamp01(1 - b.stress * 0.9), 6, Math.max(dt, 1 / 60));
      const gy = this.env.field.elevation(host.position.x, host.position.z);
      b.mesh.position.set(host.position.x, gy - 0.55 + b.travel * 0.5, host.position.z);
      b.mesh.rotation.y = host.heading + (i === 0 ? this.steerAngle * 0.25 : 0);
      b.mesh.visible = host.mesh.visible;
    }
    const glow = clamp01((this.brakeTemp - 110) / 520);
    for (const bm of this.brakeMaterials) {
      bm.emissive.setRGB(glow * 0.92, glow * 0.28, glow * 0.04);
    }
    for (let i = 0; i < this.cargoMeshes.length; i++) {
      this.cargoMeshes[i].visible = i < this.cargoModules;
    }
  }

  private gradeAt(p: THREE.Vector3, heading: number): number {
    const f = this.env.field;
    return Math.atan2(
      f.elevation(p.x + Math.sin(heading) * 6, p.z + Math.cos(heading) * 6) -
        f.elevation(p.x - Math.sin(heading) * 6, p.z - Math.cos(heading) * 6),
      12,
    );
  }

  private updateBogies(netForce: number): void {
    const W = this.totalMass * G;
    const transfer = clamp((netForce * 0.9) / W, -0.35, 0.35);
    const capacityPerBogie = W / BOGIE_COUNT;
    for (let i = 0; i < this.bogies.length; i++) {
      const b = this.bogies[i];
      const bias = (i - (BOGIE_COUNT - 1) / 2) / BOGIE_COUNT;
      let load = capacityPerBogie * (1 + transfer * bias * 2.4);
      load *= 1 + Math.abs(this.steerAngle) * 0.35;
      load *= 1 + Math.sin(this.segments[0].position.x * 0.05) * 0.06;
      b.load = Math.max(0, load);
      b.stress = clamp01(b.load / (capacityPerBogie * 1.9));
    }
  }

  private updateZones(dt: number): void {
    const pos = this.segments[0].position;
    for (const z of this.zones) {
      const d = Math.hypot(pos.x - z.position.x, pos.z - z.position.z);
      const inZone = d < z.radius && Math.abs(this.speedAlong) < 1.2;
      const mat = z.marker.material as THREE.MeshBasicMaterial;
      mat.opacity = inZone ? 0.55 + 0.25 * Math.sin(performance.now() * 0.006) : 0.28;
      z.marker.rotation.y += dt * (inZone ? 0.9 : 0.15);
    }
  }

  primary(): void {
    if (this.wagonCount < MAX_WAGONS) {
      this.setWagonCount(this.wagonCount + 1);
      const p = this.segments[0].position;
      this.env.blip(p.x, this.env.field.elevation(p.x, p.z) + 2, p.z, 240, 0.15);
      this.env.impact(0.3, 0.5);
    }
  }

  interact(): void {
    const pos = this.segments[0].position;
    const y = this.env.field.elevation(pos.x, pos.z) + 2;
    const radiusScale = this.hasModule('Depot Link') ? 1.35 : 1;
    for (const z of this.zones) {
      const d = Math.hypot(pos.x - z.position.x, pos.z - z.position.z);
      if (d > z.radius * radiusScale || Math.abs(this.speedAlong) > 1.2) continue;
      if (z.kind === 'PICKUP') {
        if (this.cargoModules >= this.cargoCapacity) {
          this.env.blip(pos.x, y, pos.z, 180, 0.1);
          return;
        }
        this.cargoModules++;
        this.cargoMass += CARGO_PER_MODULE;
        z.delivered++;
        this.env.impact(0.35, 0.35);
        this.env.blip(pos.x, y, pos.z, 420 + this.cargoModules * 40, 0.16);
        this.fireObjective('load');
      } else {
        if (this.cargoModules <= 0) {
          this.env.blip(pos.x, y, pos.z, 180, 0.1);
          return;
        }
        this.cargoModules--;
        this.cargoMass = Math.max(0, this.cargoMass - CARGO_PER_MODULE);
        z.delivered++;
        this.env.impact(0.45, 0.3);
        this.env.blip(pos.x, y, pos.z, 640, 0.2);
        this.fireObjective('deliver');
        this.fireObjective('clear');
      }
      return;
    }
    this.env.blip(pos.x, y, pos.z, 200, 0.08);
  }

  getCameraTarget(out: { position: THREE.Vector3; lookAt: THREE.Vector3 }): void {
    const lead = this.segments[0];
    const back = this._v1.set(-Math.sin(lead.heading), 0, -Math.cos(lead.heading));
    const y = this.env.field.elevation(lead.position.x, lead.position.z);
    const dist = this.cameraMode === 'INSPECT' ? 46 : 26;
    out.position.copy(lead.position).addScaledVector(back, dist).setY(y + (this.cameraMode === 'INSPECT' ? 22 : 12));
    out.lookAt.copy(lead.position).setY(y + (this.cameraMode === 'INSPECT' ? 4 : 5));
    void this._v2;
  }

  hud(): HudModel {
    const pressureKpa = this.groundBearing / 1000;
    const capKpa = this.localBearingCapacity / 1000;
    const brakingDist = (this.speedAlong * this.speedAlong) / (2 * Math.max(0.4, 2.4 * (1 - this.brakeTemp * 0.5)));
    const avgStress = this.bogies.reduce((s, b) => s + b.stress, 0) / BOGIE_COUNT;

    return {
      kind: this.kind,
      title: 'HEAVY LAND-TRAIN',
      subtitle: `ARS-VII · ${this.wagonCount} articulated wagons`,
      gauges: [
        gauge('speed', 'Ground Speed', Math.abs(this.speedAlong) * 3.6, 0, 90, 'km/h'),
        gauge('traction', 'Traction Used', clamp01(this.traction / MAX_TRACTIVE_EFFORT) * 100, 0, 100, '%'),
        { key: 'axle', label: 'Axle Load', value: this.totalMass / BOGIE_COUNT / 1000, min: 0, max: 200, unit: 't' },
        gauge('susp', 'Suspension Stress', avgStress * 100, 0, 100, '%', 55, 80),
        gauge('cargo', 'Cargo Stability', (1 - clamp01(this.steerAngle * 0.9)) * 100, 0, 100, '%'),
        gauge('brake', 'Brake Temperature', this.brakeTemp * 100, 0, 100, 'degC x10', 55, 80),
        { key: 'grade', label: 'Route Gradient', value: this.currentSlope * 100, min: -25, max: 25, unit: '%' },
        gauge('failure', 'Predicted Ground Failure', this.predictedFailure * 100, 0, 100, '%', 40, 70),
      ],
      flags: [
        { label: `Bearing ${pressureKpa.toFixed(0)} / ${capKpa.toFixed(0)} kPa`, on: pressureKpa < capKpa },
        { label: 'Wheel Slip', on: this.slip > 0.05 },
        { label: 'Brake Fade', on: this.brakeTemp > 0.6 },
        { label: `Cargo ${this.cargoModules}/${this.cargoCapacity}`, on: this.cargoModules > 0 },
        ...this.activeModules().map((m) => ({ label: `MOD · ${m}`, on: true })),
      ],
      readout: `Surface Crr ${field_crr(this.env)} · mu ${field_mu(this.env)} · braking distance ${brakingDist.toFixed(0)} m · ${this.materialName}`,
      objectives: [],
    };
  }

  get controls(): { label: string; detail: string }[] {
    return [
      { label: 'W / S', detail: 'Throttle / reverse — tractive effort is finite' },
      { label: 'A / D', detail: 'Steer the consist' },
      { label: 'B', detail: 'Service brakes — watch brake temperature' },
      { label: 'Mouse 1', detail: 'Couple another articulated wagon' },
      { label: 'G', detail: 'Load / unload cargo at a marked zone' },
      { label: 'V', detail: 'Switch between chase and inspection camera' },
    ];
  }

  toggleAssist(): void {
    this.setWagonCount(this.wagonCount === 0 ? 3 : this.wagonCount - 1);
  }

  get deliveredCount(): number {
    return this.zones.filter((z) => z.kind === 'DROPOFF').reduce((s, z) => s + z.delivered, 0);
  }

  get predictedFailureRatio(): number {
    return this.predictedFailure;
  }

  dispose(): void {
    this.clearZones();
    super.dispose();
  }
}

function field_crr(env: VehicleEnvironment): string {
  return env.field.material.rollingResistance.toFixed(2);
}
function field_mu(env: VehicleEnvironment): string {
  return env.field.material.friction.toFixed(2);
}
