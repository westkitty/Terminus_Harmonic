/**
 * VEHICLE 4 — ATMOSPHERIC GLIDER
 * ==============================
 *
 * Unpowered (minimally powered) flight. This is a real lift/drag model, not a
 * flying camera:
 *
 *   L = 0.5 * rho(h) * V^2 * S * CL(alpha)
 *   D = 0.5 * rho(h) * V^2 * S * (CD0 + CL^2 / (pi * AR * e))
 *
 * with a post-stall CL collapse, compressibility-free linear lift curve, and
 * air density from an exponential atmosphere. Thermals are explicit vertical
 * velocity fields the player has to find and circle in; turbulence is a
 * stochastic field driven by the crisis severity.
 *
 * Holding "forward" does nothing useful. Speed comes from trading altitude.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp, smoothstep } from '../core/math';
import { VehicleBase, type CameraMode, type HudModel, type VehicleEnvironment, gauge, PALETTE } from './base';
import type { World } from '../core/ecs';

const WING_AREA = 22.0; // m^2
const WING_SPAN = 17.5; // m
const ASPECT_RATIO = (WING_SPAN * WING_SPAN) / WING_AREA;
const OSWALD = 0.82;
const CD0 = 0.022;
const MASS = 620; // kg (airframe + survey payload)
const G = 9.81;
const SEA_LEVEL_DENSITY = 1.05; // kg/m^3 — remnant atmosphere, denser than Earth
const SCALE_HEIGHT = 7400; // m
const STALL_ALPHA = 0.30; // rad (~17 deg)
const ALPHA_MAX = 0.42;

interface Thermal {
  x: number;
  z: number;
  /** Radius in metres. */
  radius: number;
  /** Peak vertical velocity, m/s. */
  strength: number;
}

interface SensorPackage {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  mesh: THREE.Mesh;
  deployed: boolean;
  landed: boolean;
}

export class AtmosphericGlider extends VehicleBase {
  /** All-up mass, kg. */
  readonly MASS = MASS;
  readonly kind = 'GLIDER' as const;
  readonly availableCameraModes: readonly CameraMode[] = ['CHASE', 'COCKPIT', 'INSPECT'];

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();

  // --- aerodynamic state ---------------------------------------------------
  /** Angle of attack, radians. */
  alpha = 0.04;
  /** Sideslip, radians. */
  beta = 0;
  private bank = 0;
  /** Lift coefficient. */
  cl = 0;
  /** Drag coefficient. */
  cd = CD0;
  /** Airspeed, m/s. */
  airspeed = 0;
  /** Lift force, N. */
  liftForce = 0;
  /** Drag force, N. */
  dragForce = 0;
  private verticalSpeed = 0;
  /** True when the wing is stalled. */
  stalled = false;

  // --- environment ---------------------------------------------------------
  /** Local air density, kg/m^3. */
  airDensity = SEA_LEVEL_DENSITY;
  private windAtPos = new THREE.Vector3();
  /** Strength of the thermal currently under the wing, m/s. */
  thermalStrength = 0;
  private turbulenceLevel = 0;
  /** Height above the local ground, m. */
  altitude = 0;
  /** Deterministic thermal columns seeded across the sector. */
  readonly thermals: Thermal[] = [];

  /** Number of seeded thermals. */
  get thermalCount(): number {
    return this.thermals.length;
  }

  // --- payload -------------------------------------------------------------
  private sensorPackages: SensorPackage[] = [];
  readonly sensorCapacity = 8;
  private deployedSensors = 0;
  private sensorGroup = new THREE.Group();
  private thermalGroup = new THREE.Group();
  private navStrobes: THREE.Mesh[] = [];
  private mappedCells = 0;

  private _v1 = new THREE.Vector3();
  private _v2 = new THREE.Vector3();
  private _v3 = new THREE.Vector3();
  private _accel = new THREE.Vector3();
  private _dragDir = new THREE.Vector3();
  private _liftDir = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _q1 = new THREE.Quaternion();
  private _e1 = new THREE.Euler();
  private headingYaw = 0;

  constructor(world: World, env: VehicleEnvironment) {
    super(world, env, 'GLIDER');
    this.buildAirframe();
    this.buildSensors();
    this.worldGroup.add(this.sensorGroup);
    this.worldGroup.add(this.thermalGroup);
  }

  override get worldPosition(): THREE.Vector3 {
    return this.position;
  }

  // -- construction ---------------------------------------------------------

  private buildAirframe(): void {
    const airframe = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0x8a8578, metalness: 0.35, roughness: 0.62 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2e3134, metalness: 0.6, roughness: 0.55 });
    const amber = new THREE.MeshStandardMaterial({ color: PALETTE.amber, metalness: 0.5, roughness: 0.5 });

    // Fuselage: slender, high-aspect.
    const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.34, 9.2, 10), skin);
    fuselage.rotation.x = Math.PI / 2;
    airframe.add(fuselage);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.2, 10), dark);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 5.7;
    airframe.add(nose);
    const pitot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, 1.8, 6), amber);
    pitot.rotation.x = Math.PI / 2;
    pitot.position.z = 7.4;
    airframe.add(pitot);

    // Wing: long, thin, slightly swept with upper sensor/solar strips.
    const wingGeo = new THREE.BoxGeometry(WING_SPAN, 0.22, 3.1);
    const wing = new THREE.Mesh(wingGeo, skin);
    wing.position.set(0, 0.1, 0.6);
    airframe.add(wing);
    const solarMat = new THREE.MeshStandardMaterial({
      color: 0x1e2c36,
      metalness: 0.78,
      roughness: 0.24,
    });
    const solarStrip = new THREE.Mesh(new THREE.BoxGeometry(WING_SPAN * 0.82, 0.04, 1.55), solarMat);
    solarStrip.position.set(0, 0.23, 0.55);
    airframe.add(solarStrip);

    // Wingtip fairings + port/starboard navigation strobes.
    for (const sx of [-1, 1]) {
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 2.4), dark);
      tip.position.set(sx * WING_SPAN * 0.5, 0.15, 0.7);
      airframe.add(tip);
      const navColor = sx < 0 ? 0xe05244 : 0x48c878;
      const nav = new THREE.Mesh(
        new THREE.SphereGeometry(0.16, 8, 6),
        new THREE.MeshBasicMaterial({ color: navColor, toneMapped: false }),
      );
      nav.position.set(sx * (WING_SPAN * 0.5 + 0.28), 0.22, 1.1);
      airframe.add(nav);
      this.navStrobes.push(nav);
    }

    // Tail.
    const tail = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.16, 1.5), skin);
    tail.position.set(0, 0.25, -4.3);
    airframe.add(tail);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.9, 1.8), skin);
    fin.position.set(0, 1.0, -4.4);
    airframe.add(fin);

    // Canopy.
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x1a2a30, metalness: 0.9, roughness: 0.15, transparent: true, opacity: 0.75 }),
    );
    canopy.position.set(0, 0.5, 2.2);
    canopy.scale.set(1, 0.8, 2.0);
    airframe.add(canopy);

    // Sensor bay under the fuselage.
    const bay = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 3.2), dark);
    bay.position.set(0, -0.75, 1.2);
    airframe.add(bay);

    // Survey strobe — engineering marking, not decoration.
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ color: amber.color, toneMapped: false }));
    strobe.position.set(0, 1.95, -4.4);
    airframe.add(strobe);
    this.navStrobes.push(strobe);

    this.object3D.add(airframe);
  }

  private buildSensors(): void {
    const geo = new THREE.BoxGeometry(0.5, 0.9, 0.5);
    for (let i = 0; i < this.sensorCapacity; i++) {
      const m = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0xb8b0a0, metalness: 0.6, roughness: 0.5 }),
      );
      m.visible = false;
      this.sensorGroup.add(m);
      this.sensorPackages.push({
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        mesh: m,
        deployed: false,
        landed: false,
      });
    }
  }

  /** Seed deterministic thermals across the sector. */
  seedThermals(seed: number, count = 26, strength = 4.5): void {
    this.thermals.length = 0;
    for (const c of [...this.thermalGroup.children]) {
      this.thermalGroup.remove(c);
    }
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const colGeo = new THREE.CylinderGeometry(1, 1.25, 420, 14, 1, true);
    for (let i = 0; i < count; i++) {
      const x = (rnd() - 0.5) * 3600;
      const z = (rnd() - 0.5) * 3600;
      const radius = 120 + rnd() * 320;
      const str = strength * (0.45 + rnd() * 0.9);
      this.thermals.push({
        x,
        z,
        radius,
        strength: str,
      });
      const gy = this.env.field.elevation(x, z);
      const col = new THREE.Mesh(
        colGeo,
        new THREE.MeshBasicMaterial({
          color: 0xd09a48,
          transparent: true,
          opacity: 0.065,
          side: THREE.DoubleSide,
          depthWrite: false,
          toneMapped: false,
        }),
      );
      col.scale.set(radius * 0.42, 1, radius * 0.42);
      col.position.set(x, gy + 220, z);
      this.thermalGroup.add(col);
    }
  }

  // -- lifecycle ------------------------------------------------------------

  spawn(position: THREE.Vector3, headingRad: number): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.quaternion.setFromEuler(new THREE.Euler(0, headingRad, 0, 'YXZ'));
    this.alpha = 0.04;
    this.bank = 0;
    this.altitude = position.y;
    for (const s of this.sensorPackages) {
      s.deployed = false;
      s.landed = false;
      s.mesh.visible = false;
    }
    this.deployedSensors = 0;
    this.mappedCells = 0;
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.quaternion);
  }

  // -- aerodynamics ---------------------------------------------------------

  private airDensityAt(altitude: number): number {
    return SEA_LEVEL_DENSITY * Math.exp(-Math.max(0, altitude) / SCALE_HEIGHT);
  }

  /**
   * Lift coefficient with a post-stall collapse. Exposed for tests.
   *
   * Below the stall angle the curve is linear. Above it, CL falls away toward a
   * flat-plate value and never recovers — an earlier quadratic term let the
   * coefficient climb back into a second, fictional lift peak.
   */
  liftCoefficient(alpha: number): number {
    const clAlpha = 5.2; // per radian
    const clMax = clAlpha * STALL_ALPHA;
    if (alpha <= STALL_ALPHA) return clAlpha * alpha;
    const over = alpha - STALL_ALPHA;
    const flatPlate = 0.3 * clMax;
    const decay = Math.exp(-over / 0.12);
    return flatPlate + (clMax - flatPlate) * decay;
  }

  /** Vertical wind velocity at a world position (thermals + turbulence). */
  private verticalWind(x: number, y: number, z: number, t: number): number {
    let w = 0;
    const radiusBoost = this.hasModule('Thermal Reader') ? 1.25 : 1;
    const liftBoost = this.hasModule('Thermal Reader') ? 1.2 : 1;
    for (const th of this.thermals) {
      const dx = x - th.x;
      const dz = z - th.z;
      const effRadius = th.radius * radiusBoost;
      const d2 = dx * dx + dz * dz;
      if (d2 > effRadius * effRadius) continue;
      const d = Math.sqrt(d2);
      // Bell-shaped profile, strongest at the core, decaying with altitude.
      const radial = Math.cos((d / effRadius) * Math.PI * 0.5);
      const altFade = Math.exp(-Math.max(0, y - 200) / 2600);
      w += th.strength * liftBoost * radial * radial * altFade;
    }
    // Stochastic turbulence (shear corridor).
    if (this.turbulenceLevel > 0.01) {
      const n =
        Math.sin(x * 0.013 + t * 1.7) * Math.cos(z * 0.011 - t * 1.3) +
        Math.sin(x * 0.031 - t * 2.6) * Math.cos(z * 0.027 + t * 2.1);
      w += n * this.turbulenceLevel * 7.0;
    }
    return w;
  }

  private horizontalWind(x: number, z: number, t: number): THREE.Vector3 {
    const base = this.env.wind;
    const gust = this.turbulenceLevel * 4.5;
    return this._v3.set(
      base.x + Math.sin(z * 0.01 + t * 0.8) * gust,
      0,
      base.z + Math.cos(x * 0.01 - t * 0.7) * gust,
    );
  }

  update(dt: number): void {
    const input = this.env.input;
    const field = this.env.field;
    const step = Math.min(dt, 1 / 30);
    const t = this.env.world.elapsed;

    // --- environment -------------------------------------------------------
    this.altitude = this.position.y - field.elevation(this.position.x, this.position.z);
    this.airDensity = this.airDensityAt(this.altitude);
    const wind = this.horizontalWind(this.position.x, this.position.z, t);
    this.windAtPos.copy(wind);
    const vWind = this.verticalWind(this.position.x, this.position.y, this.position.z, t);

    // Thermal strength readout.
    let best = 0;
    for (const th of this.thermals) {
      const dx = this.position.x - th.x;
      const dz = this.position.z - th.z;
      if (dx * dx + dz * dz < th.radius * th.radius) best = Math.max(best, th.strength);
    }
    this.thermalStrength = best;
    this.turbulenceLevel = field.params.turbulence ?? 0;

    // --- airspeed relative to the air mass ---------------------------------
    const airRel = this._v1.copy(this.velocity).sub(wind);
    this.airspeed = airRel.length();

    // --- control input -----------------------------------------------------
    const pitchIn = clamp(input.axis.throttle, -1, 1); // pull back = slow, climb
    const rollIn = clamp(input.axis.x, -1, 1);
    const yawIn = clamp(input.axis.yaw, -1, 1);

    // Angle of attack: the pilot commands alpha, not pitch.
    const targetAlpha = clamp(0.02 + pitchIn * 0.13, -0.12, ALPHA_MAX);
    this.alpha = damp(this.alpha, targetAlpha, 3.0, step);

    // Bank into the turn; roll rate limited.
    const targetBank = rollIn * 1.15;
    this.bank = damp(this.bank, targetBank, 2.6, step);

    // --- orientation -------------------------------------------------------
    // Heading follows bank (coordinated turn) plus rudder.
    const turnRate = (G / Math.max(12, this.airspeed)) * Math.tan(this.bank);
    this.headingYaw += (turnRate + yawIn * 0.35) * step;

    // Pitch attitude: flight path angle minus alpha.
    const horizSpeed = Math.max(6, Math.hypot(this.velocity.x, this.velocity.z));
    const flightPath = Math.atan2(this.velocity.y, horizSpeed);
    const pitchAttitude = flightPath + this.alpha;

    this._e1.set(pitchAttitude, this.headingYaw, -this.bank, 'YXZ');
    this._q1.setFromEuler(this._e1);
    this.quaternion.slerp(this._q1, clamp01(step * 8));

    // --- forces ------------------------------------------------------------
    this.cl = this.liftCoefficient(this.alpha);
    const q = 0.5 * this.airDensity * this.airspeed * this.airspeed;
    this.liftForce = q * WING_AREA * this.cl;
    const cd0Eff = CD0 * (this.hasModule('Sampler Winch') ? 0.84 : 1);
    this.cd = cd0Eff + (this.cl * this.cl) / (Math.PI * ASPECT_RATIO * OSWALD);
    this.dragForce = q * WING_AREA * this.cd;

    this.stalled = this.alpha > STALL_ALPHA && this.airspeed > 4;

    // Right vector in body space (wing span axis).
    this._right.set(1, 0, 0).applyQuaternion(this.quaternion);

    const accel = this._accel.set(0, 0, 0);
    if (this.airspeed > 0.01) {
      // Drag opposes the relative wind.
      this._dragDir.copy(airRel).multiplyScalar(-1 / this.airspeed);
      accel.addScaledVector(this._dragDir, this.dragForce / MASS);
      // Lift is perpendicular to the relative wind, along the wing span axis.
      this._liftDir.crossVectors(this._dragDir, this._right);
      if (this._liftDir.lengthSq() < 1e-6) this._liftDir.set(0, 1, 0);
      this._liftDir.normalize();
      accel.addScaledVector(this._liftDir, this.liftForce / MASS);
    }
    // Gravity and the vertical air motion.
    accel.y -= G;
    accel.y += vWind;

    this.velocity.addScaledVector(accel, step);

    // --- integrate ---------------------------------------------------------
    this.position.addScaledVector(this.velocity, step);

    // --- ground collision --------------------------------------------------
    const groundY = field.elevation(this.position.x, this.position.z);
    const clearance = this.position.y - groundY;
    if (clearance < 2.5) {
      if (this.verticalSpeed < -6) {
        this.env.impact(clamp01(-this.verticalSpeed / 20), 0.7);
      }
      this.position.y = groundY + 2.5;
      if (this.velocity.y < 0) this.velocity.y = 0;
      // Ground roll friction.
      this.velocity.x *= 1 - step * 1.6;
      this.velocity.z *= 1 - step * 1.6;
    }
    // Ceiling.
    if (this.altitude > 5200) {
      this.position.y = field.elevation(this.position.x, this.position.z) + 5200;
      if (this.velocity.y > 0) this.velocity.y = 0;
    }

    this.verticalSpeed = this.velocity.y;
    this.speed = this.velocity.length();
    this.drive = 0;
    this.secondaryDrive = clamp01(this.airspeed / 60);
    this.turbulence = this.turbulenceLevel;
    this.stress = clamp01(
      Math.max(
        (this.airspeed > 55 ? smoothstep(55, 78, this.airspeed) : 0) * 0.8,
        this.stalled ? 0.5 : 0,
        Math.abs(this.bank) > 1.0 ? 0.35 : 0,
      ),
    );

    // --- sensor deployment -------------------------------------------------
    this.updateSensors(step);

    // --- mapping -----------------------------------------------------------
    // The glider maps the shear corridor by flying through it.
    if (this.turbulenceLevel > 0.25) {
      const mapRate = this.hasModule('Sensor Dispenser') ? 19 : 14;
      this.mappedCells = Math.min(100, this.mappedCells + step * mapRate);
      if (Math.random() < step * 0.5) this.fireObjective('map');
    }

    // --- actions -----------------------------------------------------------
    if (input.pressed('primary')) this.primary();
    if (input.pressed('interact')) this.interact();

    // --- audio & strobe pulse ----------------------------------------------
    const blink = 0.65 + 0.55 * Math.sin(t * 6.0);
    for (const s of this.navStrobes) {
      s.scale.setScalar(blink);
    }
    this.object3D.position.copy(this.position);
    this.object3D.quaternion.copy(this.quaternion);
  }

  private updateSensors(dt: number): void {
    for (const s of this.sensorPackages) {
      if (!s.deployed) continue;
      if (s.landed) continue;
      s.velocity.y -= 9.81 * dt;
      s.position.addScaledVector(s.velocity, dt);
      const gy = this.env.field.elevation(s.position.x, s.position.z);
      if (s.position.y <= gy + 0.4) {
        s.position.y = gy + 0.4;
        s.velocity.set(0, 0, 0);
        s.landed = true;
        this.env.blip(s.position.x, s.position.y, s.position.z, 720, 0.14);
      }
      s.mesh.position.copy(s.position);
    }
  }

  // -- actions --------------------------------------------------------------

  primary(): void {
    const pkg = this.sensorPackages.find((s) => !s.deployed);
    if (!pkg) {
      this.env.blip(this.position.x, this.position.y, this.position.z, 180, 0.08);
      return;
    }
    pkg.deployed = true;
    pkg.mesh.visible = true;
    // Release with the glider's velocity, biased downward.
    pkg.position.copy(this.position);
    pkg.velocity.copy(this.velocity).multiplyScalar(0.85);
    pkg.velocity.y -= 2.0;
    pkg.mesh.position.copy(pkg.position);
    this.deployedSensors++;
    this.env.impact(0.15, 0.9);
    this.env.blip(this.position.x, this.position.y, this.position.z, 980, 0.16);
    this.fireObjective('seed');
  }

  /** Ballast dump — rapid descent without gaining airspeed. */
  interact(): void {
    this.velocity.y -= 3.5;
    this.env.impact(0.2, 0.4);
    this.env.blip(this.position.x, this.position.y, this.position.z, 420, 0.12);
  }

  // -- camera ---------------------------------------------------------------

  getCameraTarget(out: { position: THREE.Vector3; lookAt: THREE.Vector3 }): void {
    const fwd = this._v1.set(0, 0, 1).applyQuaternion(this.quaternion);
    switch (this.cameraMode) {
      case 'COCKPIT':
        out.position.set(0, 0.9, 2.4).applyQuaternion(this.quaternion).add(this.position);
        out.lookAt.copy(this._v2.set(0, 0.4, 60).applyQuaternion(this.quaternion)).add(this.position);
        break;
      case 'INSPECT':
        out.position.copy(this.position).addScaledVector(fwd, -34).setY(this.position.y + 12);
        out.lookAt.copy(this.position);
        break;
      default:
        out.position.copy(this.position).addScaledVector(fwd, -22).setY(this.position.y + 7);
        out.lookAt.copy(this.position).addScaledVector(fwd, 24);
    }
  }

  // -- hud ------------------------------------------------------------------

  hud(): HudModel {
    const loadFactor = this.liftForce / (MASS * G);
    return {
      kind: this.kind,
      title: 'ATMOSPHERIC GLIDER',
      subtitle: 'ARS-X · survey and calibration platform',
      gauges: [
        { key: 'alt', label: 'Altitude', value: this.altitude, min: 0, max: 5200, unit: 'm AGL' },
        gauge('vs', 'Vertical Speed', this.verticalSpeed, -30, 15, 'm/s'),
        gauge('ias', 'Airspeed', this.airspeed, 0, 90, 'm/s'),
        { key: 'aoa', label: 'Angle of Attack', value: this.alpha * (180 / Math.PI), min: -10, max: 26, unit: 'deg' },
        { key: 'lift', label: 'Lift Coefficient', value: this.cl, min: -0.5, max: 1.6, unit: 'CL' },
        gauge('stall', 'Stall Margin', (1 - clamp01(this.alpha / STALL_ALPHA)) * 100, 0, 100, '%', 25, 8),
        { key: 'wind', label: 'Wind Vector', value: Math.hypot(this.windAtPos.x, this.windAtPos.z), min: 0, max: 40, unit: 'm/s' },
        gauge('thermal', 'Thermal Strength', this.thermalStrength, 0, 8, 'm/s'),
      ],
      flags: [
        { label: 'STALL', on: this.stalled },
        { label: `Load ${loadFactor.toFixed(2)} g`, on: loadFactor < 3.5 },
        { label: 'In Thermal', on: this.thermalStrength > 1 },
        { label: 'Turbulence', on: this.turbulenceLevel > 0.25 },
        { label: `Sensors ${this.deployedSensors}/${this.sensorCapacity}`, on: this.deployedSensors > 0 },
        ...this.activeModules().map((m) => ({ label: `MOD · ${m}`, on: true })),
      ],
      readout: `Air density ${(this.airDensity * 1000).toFixed(0)} g/m3 · CL ${this.cl.toFixed(2)} · CD ${this.cd.toFixed(3)} · glide ratio ${(this.cl / Math.max(0.001, this.cd)).toFixed(1)}`,
      objectives: [],
    };
  }

  get controls(): { label: string; detail: string }[] {
    return [
      { label: 'W / S', detail: 'Angle of attack — pull back to slow and climb' },
      { label: 'A / D', detail: 'Bank — turn rate follows bank angle' },
      { label: 'Z / C', detail: 'Rudder trim' },
      { label: 'Mouse 1 / F', detail: 'Release a sensor package' },
      { label: 'G', detail: 'Dump ballast for a rapid descent' },
      { label: 'V', detail: 'Chase / cockpit / inspection camera' },
    ];
  }

  toggleAssist(): void {
    // No flight assist on a glider; the assist action trims to best glide.
    this.alpha = Math.atan(Math.sqrt(CD0 * Math.PI * ASPECT_RATIO * OSWALD) / 1) * 0.5;
  }

  get sensorsDeployed(): number {
    return this.deployedSensors;
  }

  get mappedFraction(): number {
    return clamp01(this.mappedCells / 100);
  }

  get isStalled(): boolean {
    return this.stalled;
  }

  get currentAltitude(): number {
    return this.altitude;
  }

  get currentAirspeed(): number {
    return this.airspeed;
  }

  dispose(): void {
    for (const s of this.sensorPackages) {
      s.mesh.geometry.dispose();
      (s.mesh.material as THREE.Material).dispose();
    }
    super.dispose();
  }
}
