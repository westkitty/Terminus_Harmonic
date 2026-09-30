/**
 * VEHICLE 1 — ORBITAL SKIFF (6-DOF)
 * ==================================
 *
 * Six degrees of freedom with real inertia. There is no atmospheric drag in
 * vacuum: a thruster impulse changes velocity and the craft keeps that velocity
 * until another impulse cancels it. Angular momentum is conserved the same way,
 * which is why the flight-assist toggle exists.
 *
 * Tethers are mass-spring constraints with a break threshold:
 *
 *     F = -k * (|d| - L0) * d̂  -  c * (v_rel · d̂) * d̂
 *
 * with `k` scaled by the anchor strength and the target mass. A spring/Verlet
 * approximation behaves convincingly here and stays stable at any timestep.
 *
 * Audio contract: vacuum carries no external sound. Everything the player hears
 * is transmitted through the hull — machinery, thruster bite, cable strain,
 * docking impacts.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/math';
import { VehicleBase, type CameraMode, type HudModel, type VehicleEnvironment, gauge, PALETTE } from './base';
import type { Entity, World } from '../core/ecs';

const PLANET_RADIUS = 6_371_000;
const SKIFF_MASS = 42_000; // kg
const TRANSLATION_THRUST = 0.85; // m/s^2 at full input
const ROTATION_THRUST = 0.55; // rad/s^2 at full input
const ANGULAR_DAMP = 0.12;
const RCS_FUEL_CAPACITY = 1; // normalised; the HUD renders it as a percentage

export interface DebrisObject {
  entity: Entity;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  angularVelocity: THREE.Vector3;
  /** kg */
  mass: number;
  /** Metres, approximate bounding radius. */
  radius: number;
  /** 0..1 structural integrity. */
  integrity: number;
  mesh: THREE.Mesh;
  tethered: boolean;
  /** True once captured into a stabilised corridor. */
  secured: boolean;
  /** Deterministic shape parameters. */
  shape: { sx: number; sy: number; sz: number };
  seed: number;
}

export interface Tether {
  id: number;
  debris: DebrisObject;
  /** Rest length in metres. */
  restLength: number;
  /** N/m */
  stiffness: number;
  /** N·s/m */
  damping: number;
  /** Newtons before failure. */
  breakThreshold: number;
  /** Current tension in newtons. */
  tension: number;
  /** Local anchor offset on the skiff. */
  anchor: THREE.Vector3;
  attached: boolean;
  age: number;
}

export class OrbitalSkiff extends VehicleBase {
  readonly kind = 'ORBITAL_SKIFF' as const;
  readonly availableCameraModes: readonly CameraMode[] = ['CHASE', 'COCKPIT', 'INSPECT'];

  // --- rigid body ---------------------------------------------------------
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  /** Angular velocity in body space (rad/s). */
  readonly angularVelocity = new THREE.Vector3();

  // --- consumables --------------------------------------------------------
  /** 0..1. The HUD renders it as a percentage. */
  /** 0..1. The HUD renders it as a percentage. */
  rcsFuel = RCS_FUEL_CAPACITY;
  power = 1;
  hullIntegrity = 1;

  // --- flight assist ------------------------------------------------------
  assistEnabled = true;
  private assistBlend = 1;

  // --- tethers ------------------------------------------------------------
  readonly tethers: Tether[] = [];
  private tetherIdCounter = 0;
  private maxTethers = 3;
  tetherLines!: THREE.LineSegments;
  private tetherLinePositions!: Float32Array;

  // --- targeting ----------------------------------------------------------
  target: DebrisObject | null = null;
  private targetRing: THREE.Mesh;
  private thrusterPlumes: THREE.Mesh[] = [];

  // --- environment --------------------------------------------------------
  readonly debris: DebrisObject[] = [];
  private debrisGroup = new THREE.Group();

  // --- corridor state -----------------------------------------------------
  corridorDensity = 1;
  capturedCount = 0;
  securedCount = 0;

  // --- audio smoothing ----------------------------------------------------
  private smoothThrust = 0;
  private smoothSpin = 0;
  private lastBlipAt = 0;

  // --- scratch ------------------------------------------------------------
  private _v1 = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _v3 = new THREE.Vector3();
  private _q1 = new THREE.Quaternion();

  constructor(world: World, env: VehicleEnvironment) {
    super(world, env, 'ORBITAL_SKIFF');
    this.buildHull();
    this.buildTetherLines();
    this.targetRing = this.buildTargetRing();
    this.worldGroup.add(this.targetRing);
  }

  override get worldPosition(): THREE.Vector3 {
    return this.position;
  }

  // -- construction ---------------------------------------------------------

  private buildHull(): void {
    const hull = new THREE.Group();
    hull.name = 'skiff-hull';

    // Main hull: an angular, brutalist capsule. Not sleek.
    // Rotate -PI/2 around Z so radiusTop (2.6) sits at +X (bow) flush with the nose cone (2.6).
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(2.6, 3.4, 13, 6, 1),
      new THREE.MeshStandardMaterial({ color: PALETTE.steel, metalness: 0.72, roughness: 0.55 }),
    );
    body.rotation.z = -Math.PI / 2;
    hull.add(body);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(2.6, 5, 6),
      new THREE.MeshStandardMaterial({ color: PALETTE.darkSteel, metalness: 0.7, roughness: 0.5 }),
    );
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = 9;
    hull.add(nose);

    // Aft main thruster bell + reactive plasma/RCS plumes.
    const thrusterMat = new THREE.MeshStandardMaterial({ color: PALETTE.darkSteel, metalness: 0.8, roughness: 0.4 });
    const mainBell = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.3, 2.4, 8), thrusterMat);
    mainBell.rotation.z = -Math.PI / 2;
    mainBell.position.x = -7.4;
    hull.add(mainBell);

    const plumeGeo = new THREE.ConeGeometry(1.35, 5.2, 8);
    plumeGeo.rotateZ(Math.PI / 2);
    plumeGeo.translate(-2.6, 0, 0);
    const mainPlume = new THREE.Mesh(
      plumeGeo,
      new THREE.MeshBasicMaterial({
        color: 0x6ecbff,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    mainPlume.position.x = -8.4;
    hull.add(mainPlume);
    this.thrusterPlumes.push(mainPlume);

    // Radiator fins — weathered, oxidised.
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(
        new THREE.BoxGeometry(6.5, 0.22, 2.4),
        new THREE.MeshStandardMaterial({ color: PALETTE.rust, metalness: 0.5, roughness: 0.85 }),
      );
      const a = (i / 4) * Math.PI * 2;
      fin.position.set(-1, Math.cos(a) * 3.2, Math.sin(a) * 3.2);
      fin.rotation.x = -a;
      hull.add(fin);
    }

    // Thruster blocks + auxiliary RCS plumes.
    const rcsPlumeGeo = new THREE.ConeGeometry(0.55, 2.4, 6);
    rcsPlumeGeo.rotateZ(Math.PI / 2);
    rcsPlumeGeo.translate(-1.2, 0, 0);
    for (const [px, py, pz] of [[0, 2.6, 0], [0, -2.6, 0], [0, 0, 2.6], [0, 0, -2.6]]) {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.15, 2.2, 8), thrusterMat);
      t.position.set(px, py, pz);
      t.rotation.z = -Math.PI / 2;
      hull.add(t);

      const rp = new THREE.Mesh(
        rcsPlumeGeo,
        new THREE.MeshBasicMaterial({
          color: 0xd8c48a,
          transparent: true,
          opacity: 0.0,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      rp.position.set(px - 1.1, py, pz);
      hull.add(rp);
      this.thrusterPlumes.push(rp);
    }

    // Docking ring at the bow.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.9, 0.34, 8, 20),
      new THREE.MeshStandardMaterial({ color: PALETTE.amber, metalness: 0.6, roughness: 0.5 }),
    );
    ring.rotation.y = Math.PI / 2;
    ring.position.x = 10.6;
    hull.add(ring);

    // Azure diagnostic strip: sealed containment instrumentation, not decoration.
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(11, 0.1, 0.1),
      new THREE.MeshBasicMaterial({ color: PALETTE.azureTrace, toneMapped: false }),
    );
    strip.position.set(0, 3.35, 0);
    hull.add(strip);

    this.object3D.add(hull);
  }

  private buildTetherLines(): void {
    const geo = new THREE.BufferGeometry();
    this.tetherLinePositions = new Float32Array(this.maxTethers * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.tetherLinePositions, 3));
    geo.setDrawRange(0, 0);
    this.tetherLines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0xb8c4c8, transparent: true, opacity: 0.85, toneMapped: false }),
    );
    this.tetherLines.frustumCulled = false;
    this.tetherLines.name = 'tether-lines';
    this.worldGroup.add(this.tetherLines);
  }

  private buildTargetRing(): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(6.5, 8.2, 28),
      new THREE.MeshBasicMaterial({ color: 0xd8c48a, transparent: true, opacity: 0.6, side: THREE.DoubleSide, toneMapped: false }),
    );
    m.visible = false;
    return m;
  }

  // -- sector population ----------------------------------------------------

  /** Populate the local debris field deterministically around the skiff. */
  populateDebris(seed: number, count = 54, density = 1): void {
    this.clearDebris();
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const geoPool: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
      new THREE.IcosahedronGeometry(0.6, 0),
      new THREE.BoxGeometry(1, 0.35, 0.7),
    ];
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0x6a6259, metalness: 0.65, roughness: 0.7 }),
      new THREE.MeshStandardMaterial({ color: 0x4a4640, metalness: 0.6, roughness: 0.8 }),
      new THREE.MeshStandardMaterial({ color: 0x7a6a52, metalness: 0.55, roughness: 0.75 }),
    ];

    for (let i = 0; i < count; i++) {
      const shape = {
        sx: 3 + rnd() * 14,
        sy: 2.5 + rnd() * 11,
        sz: 2.5 + rnd() * 11,
      };
      const mesh = new THREE.Mesh(geoPool[Math.floor(rnd() * geoPool.length)], mats[Math.floor(rnd() * mats.length)]);
      mesh.scale.set(shape.sx, shape.sy, shape.sz);

      const radius = Math.max(shape.sx, shape.sy, shape.sz) * 0.5;
      // Cluster within a workable volume.
      const r = 120 + rnd() * 900 * Math.min(1.4, density);
      const theta = rnd() * Math.PI * 2;
      const phi = Math.acos(2 * rnd() - 1);
      const position = new THREE.Vector3(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi) * 0.55,
        r * Math.sin(phi) * Math.sin(theta),
      );

      const mass = (shape.sx * shape.sy * shape.sz) * 180 * (0.5 + rnd());
      const debris: DebrisObject = {
        entity: this.world.create(),
        position,
        velocity: new THREE.Vector3((rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.3, (rnd() - 0.5) * 0.6),
        quaternion: new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28),
        ),
        angularVelocity: new THREE.Vector3((rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12),
        mass,
        radius,
        integrity: 1,
        mesh,
        tethered: false,
        secured: false,
        shape,
        seed: Math.floor(rnd() * 0xffffff),
      };
      mesh.position.copy(position);
      mesh.quaternion.copy(debris.quaternion);
      this.debrisGroup.add(mesh);
      this.debris.push(debris);
      this.world.tag(debris.entity, 'debris');
    }
    this.worldGroup.add(this.debrisGroup);
  }

  private clearDebris(): void {
    for (const d of this.debris) {
      this.world.destroy(d.entity);
      this.debrisGroup.remove(d.mesh);
      d.mesh.geometry.dispose();
    }
    this.debris.length = 0;
  }

  // -- lifecycle ------------------------------------------------------------

  spawn(position: THREE.Vector3, headingRad: number): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    this.quaternion.setFromEuler(new THREE.Euler(0, headingRad, 0));
    this.rcsFuel = RCS_FUEL_CAPACITY;
    this.hullIntegrity = 1;
    this.power = 1;
    this.tethers.length = 0;
    this.corridorDensity = 1;
    this.capturedCount = 0;
    this.securedCount = 0;
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.quaternion);
  }

  // -- controls -------------------------------------------------------------

  private _fwd = new THREE.Vector3();
  private _up = new THREE.Vector3();
  private _right = new THREE.Vector3();

  update(dt: number): void {
    const input = this.env.input;
    const step = Math.min(dt, 1 / 30);

    // --- translation input ------------------------------------------------
    this._fwd.set(0, 0, 1).applyQuaternion(this.quaternion);
    this._up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(this.quaternion);

    const throttle = input.axis.throttle; // -1..1
    const strafe = input.axis.x;
    const lift = input.axis.z;

    const thrustVec = this._v1.set(0, 0, 0);
    thrustVec.addScaledVector(this._fwd, throttle * TRANSLATION_THRUST);
    thrustVec.addScaledVector(this._right, strafe * TRANSLATION_THRUST);
    thrustVec.addScaledVector(this._up, lift * TRANSLATION_THRUST);

    const boosting = input.held('boost');
    const thrustScale = boosting ? 2.1 : 1;
    const fuelEfficiency = this.hasModule('Rendezvous Assist') ? 0.75 : 1;
    const thrustMag = thrustVec.length();
    if (thrustMag > 1e-4) {
      this.velocity.addScaledVector(thrustVec, step * thrustScale);
      // Reaction control propellant burn.
      this.rcsFuel = clamp01(this.rcsFuel - step * thrustMag * 0.0035 * thrustScale * fuelEfficiency);
      this.drive = damp(this.drive, Math.min(1, thrustMag * thrustScale), 8, step);
    } else {
      this.drive = damp(this.drive, 0, 5, step);
    }

    // --- rotation input ---------------------------------------------------
    const yaw = input.axis.yaw;
    const pitch = input.axis.pitch;
    const roll = input.axis.roll;
    const rotVec = this._v2.set(0, 0, 0);
    rotVec.x += pitch * ROTATION_THRUST; // body X
    rotVec.y += yaw * ROTATION_THRUST; // body Y
    rotVec.z += roll * ROTATION_THRUST; // body Z
    const rotMag = rotVec.length();
    if (rotMag > 1e-4 && this.rcsFuel > 0) {
      this.angularVelocity.addScaledVector(rotVec, step);
      this.rcsFuel = clamp01(this.rcsFuel - step * rotMag * 0.0022 * fuelEfficiency);
    }

    // --- flight assist ----------------------------------------------------
    if (input.pressed('assist')) this.toggleAssist();
    this.assistBlend = damp(this.assistBlend, this.assistEnabled ? 1 : 0, 4, step);
    if (this.assistBlend > 0.001) {
      const a = this.assistBlend;
      const dampScale = this.hasModule('Rendezvous Assist') ? 1.4 : 1;
      // Angular damping (attitude hold) — this is what makes the craft flyable.
      this.angularVelocity.multiplyScalar(Math.max(0, 1 - 2.4 * a * dampScale * step));
      // Optional translational stabilisation: cancel drift when no thrust.
      if (thrustMag < 1e-4) {
        this.velocity.multiplyScalar(Math.max(0, 1 - 0.35 * a * dampScale * step));
      }
    }

    // --- integrate --------------------------------------------------------
    this.velocity.y += 0; // no fake drag in vacuum
    this.position.addScaledVector(this.velocity, step);

    // Angular momentum: integrate orientation from body-space angular velocity.
    if (this.angularVelocity.lengthSq() > 1e-10) {
      this._q1.setFromAxisAngle(
        this._v3.copy(this.angularVelocity).normalize(),
        this.angularVelocity.length() * step,
      );
      this.quaternion.multiply(this._q1).normalize();
      this.angularVelocity.multiplyScalar(Math.max(0, 1 - ANGULAR_DAMP * step));
    }

    // --- gravity -----------------------------------------------------------
    // A scaled radial term gives the craft a sense of "down" and makes holding
    // station cost propellant. It is deliberately not a full n-body model: this
    // is an engineering craft working inside a debris cluster, not an orbital
    // mechanics sandbox. Full mu/r^2 at this altitude would be ~8.6 m/s^2 and
    // would make the machine unflyable.
    const r = this.position.length();
    if (r > PLANET_RADIUS * 0.5) {
      const g = 0.22;
      // Unit vector from the craft toward the planet centre, scaled by g*dt and
      // *added* to velocity. Getting this sign wrong makes the skiff fall up.
      const inward = this._v1.copy(this.position).multiplyScalar(-1 / r);
      this.velocity.addScaledVector(inward, g * step);
    }

    // --- tethers ----------------------------------------------------------
    this.updateTethers(step);

    // --- debris -----------------------------------------------------------
    for (const d of this.debris) {
      if (!d.secured) {
        d.position.addScaledVector(d.velocity, step);
        d.quaternion.multiply(
          this._q1.setFromAxisAngle(
            this._v3.copy(d.angularVelocity).normalize(),
            d.angularVelocity.length() * step,
          ),
        );
        d.mesh.position.copy(d.position);
        d.mesh.quaternion.copy(d.quaternion);
      } else {
        d.mesh.position.copy(d.position);
      }
    }

    // --- targeting --------------------------------------------------------
    this.updateTargeting();

    // --- actions ----------------------------------------------------------
    if (input.pressed('primary')) this.primary();
    if (input.pressed('secondary')) this.secondary();
    if (input.pressed('interact')) this.interact();

    // --- audio smoothing & thruster plume VFX -----------------------------
    this.smoothThrust = damp(this.smoothThrust, thrustMag / TRANSLATION_THRUST, 6, step);
    this.smoothSpin = damp(this.smoothSpin, rotMag / ROTATION_THRUST, 6, step);
    const plumeIntensity = clamp01(this.drive * 0.85 + this.smoothSpin * 0.45);
    for (let i = 0; i < this.thrusterPlumes.length; i++) {
      const p = this.thrusterPlumes[i];
      const mat = p.material as THREE.MeshBasicMaterial;
      const flicker = 0.82 + 0.18 * Math.sin(this.env.world.elapsed * 38 + i * 2.1);
      const op = (i === 0 ? this.drive * 0.78 : plumeIntensity * 0.52) * flicker;
      mat.opacity = op;
      p.visible = op > 0.02;
      p.scale.set(0.7 + op * 0.95, 0.85 + op * 0.3, 0.85 + op * 0.3);
    }

    // --- commit transform -------------------------------------------------
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.quaternion);
    this.speed = this.velocity.length();
    this.secondaryDrive = this.smoothThrust;
    this.heat = clamp01(this.heat + (boosting ? step * 0.06 : -step * 0.04));
    this.turbulence = 0; // vacuum
    this.stress = clamp01(
      Math.max(
        this.tensionRatio() * 0.9,
        (1 - this.hullIntegrity) * 0.8,
        (1 - this.rcsFuel) * 0.25,
      ),
    );

    this.updateTetherLines();
  }

  // -- tethers --------------------------------------------------------------

  private tensionRatio(): number {
    if (this.tethers.length === 0) return 0;
    let max = 0;
    for (const t of this.tethers) max = Math.max(max, t.tension / t.breakThreshold);
    return max;
  }

  private updateTethers(dt: number): void {
    for (let i = this.tethers.length - 1; i >= 0; i--) {
      const t = this.tethers[i];
      t.age += dt;
      // World-space anchor on the skiff.
      const anchorWorld = this._v1.copy(t.anchor).applyQuaternion(this.quaternion).add(this.position);
      const delta = this._v2.copy(t.debris.position).sub(anchorWorld);
      const dist = delta.length();
      if (dist < 1e-3) {
        t.tension = 0;
        continue;
      }
      const dir = this._v3.copy(delta).multiplyScalar(1 / dist);
      const stretch = dist - t.restLength;

      // Relative velocity along the tether axis.
      const debrisVel = t.debris.velocity;
      const relVel = (debrisVel.x - this.velocity.x) * dir.x +
        (debrisVel.y - this.velocity.y) * dir.y +
        (debrisVel.z - this.velocity.z) * dir.z;

      // Only pull, never push (a cable cannot push).
      let tension = 0;
      if (stretch > 0) {
        tension = t.stiffness * stretch + t.damping * Math.max(0, relVel);
      }
      t.tension = tension;

      if (tension > t.breakThreshold) {
        this.detachTether(t, true);
        continue;
      }

      if (tension > 0) {
        // Apply equal and opposite impulses.
        const impulse = tension * dt;
        const totalMass = SKIFF_MASS + t.debris.mass;
        const dv = impulse / totalMass;
        // Debris is pulled toward the anchor.
        t.debris.velocity.addScaledVector(dir, -dv * (SKIFF_MASS / t.debris.mass));
        // Skiff is pulled toward the debris.
        this.velocity.addScaledVector(dir, dv * (t.debris.mass / SKIFF_MASS));
        // Cable strain audio.
        if (performance.now() - this.lastBlipAt > 240) {
          this.lastBlipAt = performance.now();
          const strain = clamp01(tension / t.breakThreshold);
          if (strain > 0.35) this.env.impact(strain * 0.25, 0.7);
        }
      }
    }
  }

  private updateTetherLines(): void {
    let n = 0;
    for (const t of this.tethers) {
      const anchorWorld = this._v1.copy(t.anchor).applyQuaternion(this.quaternion).add(this.position);
      const base = n * 6;
      this.tetherLinePositions[base] = anchorWorld.x;
      this.tetherLinePositions[base + 1] = anchorWorld.y;
      this.tetherLinePositions[base + 2] = anchorWorld.z;
      this.tetherLinePositions[base + 3] = t.debris.position.x;
      this.tetherLinePositions[base + 4] = t.debris.position.y;
      this.tetherLinePositions[base + 5] = t.debris.position.z;
      n++;
    }
    const attr = this.tetherLines.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.tetherLines.geometry.setDrawRange(0, n * 2);
  }

  /** Fire a grappling tether at the current target. */
  primary(): void {
    if (!this.target) {
      this.env.blip(this.position.x, this.position.y, this.position.z, 180, 0.08);
      return;
    }
    if (this.tethers.length >= this.maxTethers) {
      this.env.blip(this.position.x, this.position.y, this.position.z, 140, 0.08);
      return;
    }
    const d = this.target.position.distanceTo(this.position);
    const maxRange = this.hasModule('Tether Winch') ? 1850 : 1400;
    if (d > maxRange) {
      this.env.blip(this.position.x, this.position.y, this.position.z, 120, 0.08);
      return;
    }
    const winchBoost = this.hasModule('Tether Winch') ? 1.35 : 1;
    const tether: Tether = {
      id: ++this.tetherIdCounter,
      debris: this.target,
      restLength: Math.max(24, d * 0.82),
      stiffness: clamp(2.2e6 / Math.max(1, this.target.mass / 4000), 900, 26000) * winchBoost,
      damping: 5200 * winchBoost,
      breakThreshold: 3.4e6 * (0.55 + this.hullIntegrity * 0.45) * winchBoost,
      tension: 0,
      anchor: new THREE.Vector3(0, -1.2, -6.5),
      attached: true,
      age: 0,
    };
    this.tethers.push(tether);
    this.target.tethered = true;
    this.env.blip(this.position.x, this.position.y, this.position.z, 520, 0.16);
    this.env.impact(0.25, 0.8);
    this.fireObjective('diagnose');
  }

  /** Release the tether on the current target. */
  secondary(): void {
    const idx = this.tethers.findIndex((t) => t.debris === this.target);
    if (idx >= 0) this.detachTether(this.tethers[idx], false);
    else if (this.tethers.length > 0) this.detachTether(this.tethers[0], false);
  }

  private detachTether(t: Tether, broke: boolean): void {
    const i = this.tethers.indexOf(t);
    if (i >= 0) this.tethers.splice(i, 1);
    t.debris.tethered = false;
    if (broke) {
      t.debris.integrity = Math.max(0.25, t.debris.integrity - 0.15);
      this.env.impact(0.7, 0.9);
    }
  }

  /**
   * Interact: secure the current target into a stabilised corridor slot.
   * This is the actual engineering work — it reduces local density.
   */
  interact(): void {
    const t = this.tethers.find((x) => x.debris === this.target) ?? this.tethers[0];
    if (!t) {
      if (this.target && !this.target.tethered) {
        this.primary();
        return;
      }
      this.env.blip(this.position.x, this.position.y, this.position.z, 200, 0.08);
      return;
    }
    const d = t.debris;
    if (d.secured) return;
    const dist = d.position.distanceTo(this.position);
    // Must be close and slow relative to the skiff.
    const relSpeed = d.velocity.distanceTo(this.velocity);
    const maxSlotDist = this.hasModule('Corridor Beacon') ? 460 : 320;
    const maxSlotSpeed = this.hasModule('Corridor Beacon') ? 6.4 : 4.5;
    if (dist > maxSlotDist || relSpeed > maxSlotSpeed) {
      this.env.blip(this.position.x, this.position.y, this.position.z, 190, 0.08);
      return;
    }
    d.secured = true;
    d.velocity.set(0, 0, 0);
    d.angularVelocity.set(0, 0, 0);
    this.detachTether(t, false);
    this.securedCount++;
    this.capturedCount++;
    this.corridorDensity = Math.max(0, 1 - this.securedCount / 12);
    this.env.impact(0.45, 0.35);
    this.env.blip(this.position.x, this.position.y, this.position.z, 880, 0.2);
    this.fireObjective('capture');
    this.fireObjective('correct');
  }

  // -- targeting ------------------------------------------------------------

  private updateTargeting(): void {
    let best: DebrisObject | null = null;
    let bestScore = -Infinity;
    const fwd = this._v1.set(0, 0, 1).applyQuaternion(this.quaternion);
    for (const d of this.debris) {
      if (d.secured) continue;
      const to = this._v2.copy(d.position).sub(this.position);
      const dist = to.length();
      if (dist > 1400 || dist < 1) continue;
      to.multiplyScalar(1 / dist);
      const align = to.dot(fwd);
      if (align < 0.72) continue;
      const score = align * 2 - dist / 1400;
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    this.target = best;
    if (best) {
      this.targetRing.visible = true;
      // Keep the ring a constant screen size and face the camera.
      const dist = best.position.distanceTo(this.position);
      this.targetRing.position.copy(best.position);
      this.targetRing.scale.setScalar(Math.max(0.35, dist / 900));
      this.targetRing.quaternion.copy(this.env.camera.quaternion);
      const mat = this.targetRing.material as THREE.MeshBasicMaterial;
      mat.color.setHex(best.tethered ? 0x8fd0e8 : 0xd8c48a);
    } else {
      this.targetRing.visible = false;
    }
  }

  // -- camera ---------------------------------------------------------------

  getCameraTarget(out: { position: THREE.Vector3; lookAt: THREE.Vector3 }): void {
    const back = this._v1.set(0, 0, -1).applyQuaternion(this.quaternion);
    const up = this._v2.set(0, 1, 0).applyQuaternion(this.quaternion);
    switch (this.cameraMode) {
      case 'COCKPIT':
        out.position.set(0, 1.4, 4.2).applyQuaternion(this.quaternion).add(this.position);
        out.lookAt.copy(this._v3.set(0, 0, 60).applyQuaternion(this.quaternion).add(this.position));
        break;
      case 'INSPECT':
        out.position.copy(back).multiplyScalar(38).add(this.position).addScaledVector(up, 10);
        out.lookAt.copy(this.position);
        break;
      default:
        out.position.copy(back).multiplyScalar(30).add(this.position).addScaledVector(up, 7);
        out.lookAt.copy(this.position).addScaledVector(back, -18);
    }
  }

  // -- hud ------------------------------------------------------------------

  hud(): HudModel {
    const maxTension = this.tethers.reduce((m, t) => Math.max(m, t.tension), 0);
    const breakT = this.tethers[0]?.breakThreshold ?? 1;
    const relVel = this.velocity.length();
    const angVel = this.angularVelocity.length();

    const nearest = this.debris.reduce(
      (best, d) => (d.secured ? best : Math.min(best, d.position.distanceTo(this.position))),
      Infinity,
    );

    const gauges = [
      gauge('relvel', 'Relative Velocity', relVel, 0, 60, 'm/s', 25, 45),
      gauge('angvel', 'Angular Velocity', angVel, 0, 1.6, 'rad/s', 0.8, 1.3),
      gauge('fuel', 'RCS Propellant', this.rcsFuel * 100, 0, 100, '%', 0, 0),
      gauge('power', 'Reactor Output', this.power * 100, 0, 100, '%'),
      gauge('tension', 'Tether Tension', maxTension, 0, breakT, 'N', breakT * 0.6, breakT * 0.85),
      gauge('hull', 'Hull Integrity', this.hullIntegrity * 100, 0, 100, '%'),
    ];
    gauges[2].warn = this.rcsFuel < 0.25;
    gauges[2].crit = this.rcsFuel < 0.08;
    gauges[5].warn = this.hullIntegrity < 0.6;
    gauges[5].crit = this.hullIntegrity < 0.3;

    return {
      kind: this.kind,
      title: 'ORBITAL SKIFF',
      subtitle: 'ARS-VI · salvage and corridor engineering',
      gauges,
      flags: [
        { label: 'Flight Assist', on: this.assistEnabled },
        { label: 'Tether Latched', on: this.tethers.length > 0 },
        { label: 'Boost', on: this.env.input.held('boost') },
        { label: 'Vacuum — no external audio', on: true },
        ...this.activeModules().map((m) => ({ label: `MOD · ${m}`, on: true })),
      ],
      readout: this.target
        ? `TARGET ${this.target.mass.toFixed(0)} kg · ${this.target.position.distanceTo(this.position).toFixed(0)} m`
        : Number.isFinite(nearest)
          ? `Nearest derelict ${nearest.toFixed(0)} m`
          : 'No derelicts in range',
      target: this.target ? `${(this.target.mass / 1000).toFixed(1)} t` : undefined,
      objectives: [],
    };
  }

  get controls(): { label: string; detail: string }[] {
    return [
      { label: 'W / S', detail: 'Translation thrust along hull axis' },
      { label: 'A / D', detail: 'Lateral translation thrust' },
      { label: 'Q / E', detail: 'Vertical translation thrust' },
      { label: 'Z / C', detail: 'Yaw thrusters' },
      { label: 'I / K', detail: 'Pitch thrusters' },
      { label: 'J / L', detail: 'Roll thrusters' },
      { label: 'Mouse 1 / F', detail: 'Fire grappling tether at target' },
      { label: 'Mouse 2 / R', detail: 'Release tether' },
      { label: 'G', detail: 'Secure target into stabilised corridor' },
      { label: 'X', detail: 'Toggle flight assist (attitude hold)' },
      { label: 'Shift', detail: 'Boost — burns propellant fast' },
    ];
  }

  toggleAssist(): void {
    this.assistEnabled = !this.assistEnabled;
    this.env.blip(this.position.x, this.position.y, this.position.z, this.assistEnabled ? 620 : 380, 0.14);
  }

  /** Secured-corridor progress used by the crisis controller. */
  get corridorProgress(): number {
    return clamp01(this.securedCount / 6);
  }

  dispose(): void {
    this.clearDebris();
    this.tetherLines.geometry.dispose();
    (this.tetherLines.material as THREE.Material).dispose();
    this.targetRing.geometry.dispose();
    (this.targetRing.material as THREE.Material).dispose();
    super.dispose();
  }
}

export { PLANET_RADIUS, SKIFF_MASS };
