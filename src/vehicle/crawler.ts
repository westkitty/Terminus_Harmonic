/**
 * VEHICLE 3 — SUBTERRANEAN STRATA-CRAWLER
 * ========================================
 *
 * A massive tracked machine that lives inside the {@link TunnelLattice}.
 *
 * Simulated explicitly:
 *   - differential track movement (left/right track speed difference steers)
 *   - material resistance from the rock profile: drill speed, heat generation,
 *     energy consumption, tunnel stability and vibration all depend on the
 *     material the cutter is currently in
 *   - thermal management: cutter heat rises with work done and rock hardness,
 *     falls with coolant; overheat forces a shutdown
 *   - power draw against an onboard reactor
 *   - geological pressure rising with depth
 *   - structural instability from nearby voids + overburden -> collapse risk
 *
 * It is not a fully destructible voxel planet. It is a bounded sparse lattice,
 * which is the honest way to get convincing deformation at 60 FPS.
 */

import * as THREE from 'three';
import { clamp, clamp01, damp } from '../core/math';
import { VehicleBase, type CameraMode, type HudModel, type VehicleEnvironment, gauge, PALETTE } from './base';
import type { World } from '../core/ecs';

const TRACK_WIDTH = 5.4;
const TRACK_LENGTH = 9.5;
const MAX_TRACK_SPEED = 7.5; // m/s
const TRACK_ACCEL = 3.2;
const REACTOR_POWER = 1.0; // normalized
const CUTTER_POWER_DRAW = 0.55;
const DRIVE_POWER_DRAW = 0.22;
const COOLANT_CAPACITY = 1;
const CUTTER_RADIUS = 3.2;
const HULL_LENGTH = 15;
const HULL_WIDTH = 6.4;
const HULL_HEIGHT = 4.2;

interface Track {
  /** Signed speed, m/s. */
  speed: number;
  mesh: THREE.Group;
  wheels: THREE.Mesh[];
}

export class StrataCrawler extends VehicleBase {
  readonly kind = 'STRATA_CRAWLER' as const;
  readonly availableCameraModes: readonly CameraMode[] = ['CHASE', 'COCKPIT', 'INSPECT'];

  readonly position = new THREE.Vector3();
  private heading = 0;
  private pitch = 0;
  /** Signed track speed, m/s. */
  trackSpeed = 0;

  // --- machine state -------------------------------------------------------
  coolant = COOLANT_CAPACITY;
  power = REACTOR_POWER;
  /** Cutter temperature 0..1 — the resource that actually limits the machine. */
  cutterTemp = 0.12;
  hullStress = 0;
  depth = 0;
  private cutterSpin = 0;
  drilling = false;
  private tunnelVersion = -1;
  private tunnelMeshDirty = true;

  // --- geology -------------------------------------------------------------
  private seismicPressure = 0;
  private instability = 0;
  private materialName = '';
  private materialHardness = 0;
  private rockTemp = 0;

  // --- objectives ----------------------------------------------------------
  installedExchangers = 0;
  private drillSeconds = 0;

  // --- audio ---------------------------------------------------------------
  private smoothDrill = 0;
  private smoothDrive = 0;
  private lastGroanAt = 0;

  // --- meshes --------------------------------------------------------------
  private tracks: Track[] = [];
  private cutterHead!: THREE.Mesh;
  private cutterRing!: THREE.Mesh;
  private tunnelMesh!: THREE.Mesh;
  private tunnelPositions!: Float32Array;
  private tunnelNormals!: Float32Array;
  private readonly TUNNEL_VERTS = 96;
  private exchangerGroup = new THREE.Group();

  private _v1 = new THREE.Vector3();
  private _v2 = new THREE.Vector3();

  constructor(world: World, env: VehicleEnvironment) {
    super(world, env, 'STRATA_CRAWLER');
    this.buildHull();
    this.buildTracks();
    this.cutterHead = this.buildCutter();
    this.cutterRing = this.buildCutterRing();
    this.buildTunnelMesh();
    this.object3D.add(this.exchangerGroup);
  }

  // -- construction ---------------------------------------------------------

  private buildHull(): void {
    const hull = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: PALETTE.darkRust, metalness: 0.66, roughness: 0.66 });
    const steelMat = new THREE.MeshStandardMaterial({ color: PALETTE.darkSteel, metalness: 0.74, roughness: 0.5 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(HULL_WIDTH, HULL_HEIGHT, HULL_LENGTH), bodyMat);
    body.position.y = HULL_HEIGHT * 0.5 + 1.2;
    hull.add(body);

    // Sloped glacis plate at the front — the cutter housing.
    const glacis = new THREE.Mesh(new THREE.BoxGeometry(HULL_WIDTH, 1.4, 3.2), steelMat);
    glacis.position.set(0, 1.9, HULL_LENGTH * 0.5 + 1.0);
    glacis.rotation.x = -0.5;
    hull.add(glacis);

    // Reactor hump.
    const reactor = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.4, 3.0, 10), steelMat);
    reactor.position.set(0, HULL_HEIGHT + 2.6, -2.0);
    hull.add(reactor);

    // Coolant tanks.
    for (const sx of [-2.9, 2.9]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 8.5, 10), bodyMat);
      tank.rotation.x = Math.PI / 2;
      tank.position.set(sx, 2.0, -3.0);
      hull.add(tank);
    }

    // Azure sealed-containment instrumentation strip.
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(HULL_WIDTH * 0.7, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ color: PALETTE.azureTrace, toneMapped: false }),
    );
    strip.position.set(0, HULL_HEIGHT + 1.0, HULL_LENGTH * 0.5);
    hull.add(strip);

    this.object3D.add(hull);
  }

  private buildTracks(): void {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1e2124, metalness: 0.8, roughness: 0.55 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.85, roughness: 0.45 });
    const wheelGeo = new THREE.CylinderGeometry(1.1, 1.1, 0.7, 12);
    wheelGeo.rotateX(Math.PI / 2);
    const roadWheelGeo = new THREE.CylinderGeometry(0.85, 0.85, 0.55, 10);
    roadWheelGeo.rotateX(Math.PI / 2);

    for (const side of [-1, 1]) {
      const track = new THREE.Group();
      // Track frame + shoe belt.
      const belt = new THREE.Mesh(new THREE.BoxGeometry(TRACK_WIDTH, 0.45, TRACK_LENGTH), frameMat);
      belt.position.y = 0.35;
      track.add(belt);
      // Drive sprocket + idler.
      for (const [z, r] of [[TRACK_LENGTH * 0.45, 1.25], [-TRACK_LENGTH * 0.45, 1.25]] as [number, number][]) {
        const sprocket = new THREE.Mesh(wheelGeo, wheelMat);
        sprocket.scale.set(1, r / 1.1, r / 1.1);
        sprocket.position.set(0, 0.9, z);
        track.add(sprocket);
      }
      // Road wheels.
      const wheels: THREE.Mesh[] = [];
      for (let i = 0; i < 5; i++) {
        const w = new THREE.Mesh(roadWheelGeo, wheelMat);
        w.position.set(0, 0.8, -TRACK_LENGTH * 0.4 + (i * TRACK_LENGTH * 0.8) / 4);
        track.add(w);
        wheels.push(w);
      }
      track.position.set(side * (HULL_WIDTH * 0.5 + TRACK_WIDTH * 0.5), 0, 0);
      this.object3D.add(track);
      this.tracks.push({ speed: 0, mesh: track, wheels });
    }
  }

  private buildCutter(): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(CUTTER_RADIUS, CUTTER_RADIUS * 0.7, 2.4, 12);
    geo.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: 0x3a3d40, metalness: 0.9, roughness: 0.35 }),
    );
    m.position.set(0, 1.4, HULL_LENGTH * 0.5 + 1.4);
    // Cutter teeth — this is a machine, not a creature.
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const tooth = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 1.5, 0.9),
        new THREE.MeshStandardMaterial({ color: 0x6e6a60, metalness: 0.85, roughness: 0.4 }),
      );
      tooth.position.set(Math.cos(a) * CUTTER_RADIUS * 0.92, 1.4 + Math.sin(a) * CUTTER_RADIUS * 0.92, HULL_LENGTH * 0.5 + 2.6);
      tooth.rotation.z = a;
      m.add(tooth);
    }
    this.object3D.add(m);
    return m;
  }

  private buildCutterRing(): THREE.Mesh {
    const geo = new THREE.RingGeometry(CUTTER_RADIUS * 0.98, CUTTER_RADIUS * 1.25, 24);
    const m = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: 0xd08a3a, transparent: true, opacity: 0.35, side: THREE.DoubleSide, toneMapped: false }),
    );
    m.position.set(0, 1.4, HULL_LENGTH * 0.5 + 2.8);
    this.object3D.add(m);
    return m;
  }

  /**
   * The tunnel is drawn as a tube of instanced quads rebuilt from the lattice
   * only when the lattice version changes. Cheap and bounded.
   */
  private buildTunnelMesh(): void {
    const n = this.TUNNEL_VERTS;
    this.tunnelPositions = new Float32Array(n * 4 * 3);
    this.tunnelNormals = new Float32Array(n * 4 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.tunnelPositions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.tunnelNormals, 3));
    const indices = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const b = i * 4;
      indices[i * 6] = b;
      indices[i * 6 + 1] = b + 1;
      indices[i * 6 + 2] = b + 2;
      indices[i * 6 + 3] = b;
      indices[i * 6 + 4] = b + 2;
      indices[i * 6 + 5] = b + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.setDrawRange(0, 0);
    this.tunnelMesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: 0x0d0e10,
        roughness: 0.98,
        metalness: 0.02,
        side: THREE.DoubleSide,
      }),
    );
    this.tunnelMesh.frustumCulled = false;
    this.tunnelMesh.name = 'tunnel-shell';
    this.object3D.add(this.tunnelMesh);
  }

  /** Rebuild the tunnel shell geometry from the lattice. */
  private rebuildTunnelMesh(): void {
    const lattice = this.env.lattice;
    const keys = [...lattice.carvedKeys()];
    if (keys.length === 0) {
      this.tunnelMesh.geometry.setDrawRange(0, 0);
      return;
    }
    // Sort by depth along +Z so the tube is contiguous-ish; cap at the budget.
    keys.sort((a, b) => a - b);
    const count = Math.min(keys.length, this.TUNNEL_VERTS);
    let w = 0;
    for (let i = 0; i < count; i++) {
      const [wx, wy, wz] = lattice.keyToWorld(keys[i]);
      const r = CUTTER_RADIUS * 0.98;
      // Ring of 4 verts.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.4;
        this.tunnelPositions[w * 3] = wx + Math.cos(a) * r;
        this.tunnelPositions[w * 3 + 1] = wy + Math.sin(a) * r;
        this.tunnelPositions[w * 3 + 2] = wz;
        this.tunnelNormals[w * 3] = Math.cos(a);
        this.tunnelNormals[w * 3 + 1] = Math.sin(a);
        this.tunnelNormals[w * 3 + 2] = 0;
        w++;
      }
    }
    const attr = this.tunnelMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nattr = this.tunnelMesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    nattr.needsUpdate = true;
    this.tunnelMesh.geometry.setDrawRange(0, count * 6);
    this.tunnelMesh.geometry.computeBoundingSphere();
  }

  // -- lifecycle ------------------------------------------------------------

  spawn(position: THREE.Vector3, headingRad: number): void {
    this.position.copy(position);
    this.heading = headingRad;
    this.trackSpeed = 0;
    this.coolant = COOLANT_CAPACITY;
    this.cutterTemp = 0.12;
    this.hullStress = 0;
    this.depth = 0;
    this.drilling = false;
    this.tunnelVersion = -1;
    this.object3D.position.copy(this.position);
    this.object3D.rotation.y = headingRad;
  }

  // -- physics --------------------------------------------------------------

  update(dt: number): void {
    const input = this.env.input;
    const field = this.env.field;
    const lattice = this.env.lattice;
    const step = Math.min(dt, 1 / 30);

    const pos = this.position;

    // --- geology at the cutter --------------------------------------------
    const cutterPos = this._v1.set(
      pos.x + Math.sin(this.heading) * (HULL_LENGTH * 0.5 + 2.6),
      pos.y + 1.4,
      pos.z + Math.cos(this.heading) * (HULL_LENGTH * 0.5 + 2.6),
    );
    this.materialHardness = field.material.hardness;
    this.materialName = field.materialLabel;
    this.depth = Math.max(0, field.surfaceY - pos.y);
    this.rockTemp = lattice.rockTemperature(pos.y, field.params.geothermalPressure);
    this.instability = lattice.instability(pos.x, pos.y, pos.z);
    this.seismicPressure = clamp01(this.instability * 0.6 + field.params.geothermalPressure * 0.4 + this.depth / 400);

    // --- drive -------------------------------------------------------------
    const throttle = clamp(input.axis.throttle, -1, 1);
    const steer = clamp(input.axis.x, -1, 1);
    const materialResistance = 0.55 + field.material.hardness * 0.9;
    // Moving through intact rock is much slower than moving through a tunnel.
    const inTunnel = lattice.isVoid(cutterPos.x, cutterPos.y, cutterPos.z) ||
      lattice.isVoid(pos.x, pos.y, pos.z);
    const resistance = inTunnel ? 0.18 : materialResistance;

    const targetSpeed = throttle * MAX_TRACK_SPEED * (inTunnel ? 1 : 0.45);
    const accel = TRACK_ACCEL / resistance;
    this.trackSpeed = moveTowards(this.trackSpeed, targetSpeed, accel * step);

    // Differential track steering.
    const turnRate = steer * (inTunnel ? 1.1 : 0.55) * clamp01(Math.abs(this.trackSpeed) / 3 + 0.25);
    this.heading += turnRate * step * (this.trackSpeed >= 0 ? 1 : -1);

    pos.x += Math.sin(this.heading) * this.trackSpeed * step;
    pos.z += Math.cos(this.heading) * this.trackSpeed * step;

    // Vertical: the crawler follows a commanded depth. In tunnel it is free;
    // in rock it must drill.
    const depthInput = clamp(input.axis.z, -1, 1);
    const targetDepth = clamp(this.depth + depthInput * 90 * step, 0, lattice.depth * 0.85);
    pos.y = field.surfaceY - targetDepth;
    this.pitch = damp(this.pitch, depthInput * -0.16, 3, step);

    // --- drilling ----------------------------------------------------------
    const wantDrill = input.held('primary') || input.held('secondary');
    const overheated = this.cutterTemp > 0.94;
    this.drilling = wantDrill && !overheated && this.power > 0.05;

    let powerDraw = DRIVE_POWER_DRAW * clamp01(Math.abs(this.trackSpeed) / MAX_TRACK_SPEED);
    if (this.drilling) {
      powerDraw += CUTTER_POWER_DRAW * (0.5 + field.material.hardness * 0.8);
      // Heat generated: work done against hardness, minus what coolant removes.
      // The balance is deliberately tight in hard rock — the cutter reaches the
      // overheat ceiling in a few seconds and then has to be left to cool, which
      // is the whole thermal-management loop. In soft rock the same cutter runs
      // indefinitely.
      const generated = (0.22 + field.material.hardness * 0.55) * (0.35 + this.cutterSpin * 0.65);
      const removed = 0.10 + this.coolant * 0.30;
      this.cutterTemp = clamp01(this.cutterTemp + (generated - removed) * step);
      this.coolant = clamp01(this.coolant - step * (0.035 + field.material.hardness * 0.05));
      this.cutterSpin = damp(this.cutterSpin, 1, 2.5, step);
      this.drillSeconds += step;

      // Excavate ahead of the cutter.
      const carve = this._v2.set(
        pos.x + Math.sin(this.heading) * (HULL_LENGTH * 0.5 + 3.0),
        pos.y + 1.4,
        pos.z + Math.cos(this.heading) * (HULL_LENGTH * 0.5 + 3.0),
      );
      const carved = lattice.excavate(carve.x, carve.y, carve.z, CUTTER_RADIUS / lattice.cell);
      if (carved > 0) this.tunnelMeshDirty = true;
      lattice.addHeat(carve.x, carve.y, carve.z, 0.02);
      this.fireObjective('bore');
    } else {
      this.cutterSpin = damp(this.cutterSpin, 0, 3, step);
      // Cooling: pumps run whenever the cutter is off.
      this.cutterTemp = clamp01(this.cutterTemp - step * (0.06 + this.coolant * 0.12));
      this.coolant = clamp01(this.coolant + step * 0.012);
    }

    // Coolant regenerates slowly from the reactor loop.
    this.coolant = clamp01(this.coolant + step * 0.004);
    this.power = clamp01(this.power - powerDraw * step * 0.06 + step * 0.05);

    // Hull stress: seismic pressure + instability + thermal load.
    this.hullStress = clamp01(
      this.instability * 0.55 + this.seismicPressure * 0.35 + this.cutterTemp * 0.25 + (1 - this.power) * 0.2,
    );

    // Collapse warning groan.
    if (this.hullStress > 0.6 && performance.now() - this.lastGroanAt > 1400) {
      this.lastGroanAt = performance.now();
      this.env.impact(this.hullStress * 0.3, 0.15);
    }

    // --- audio smoothing ---------------------------------------------------
    this.smoothDrill = damp(this.smoothDrill, this.drilling ? 1 : 0, 6, step);
    this.smoothDrive = damp(this.smoothDrive, clamp01(Math.abs(this.trackSpeed) / MAX_TRACK_SPEED), 5, step);

    // --- commit ------------------------------------------------------------
    this.object3D.position.copy(this.position);
    this.object3D.rotation.set(this.pitch, this.heading, 0);

    this.tracks[0].speed = this.trackSpeed + turnRate * 2.4;
    this.tracks[1].speed = this.trackSpeed - turnRate * 2.4;
    const spin = step * ((this.tracks[0].speed + this.tracks[1].speed) * 0.5) / 1.1;
    for (const t of this.tracks) {
      for (const w of t.wheels) w.rotation.y -= spin;
    }
    this.cutterHead.rotation.z -= step * (0.4 + this.cutterSpin * 9);
    const ringMat = this.cutterRing.material as THREE.MeshBasicMaterial;
    ringMat.opacity = this.drilling ? 0.3 + 0.35 * Math.abs(Math.sin(performance.now() * 0.02)) : 0.12;
    ringMat.color.setHex(overheated ? 0xd03a1a : 0xd08a3a);

    if (this.tunnelMeshDirty && lattice.version !== this.tunnelVersion) {
      this.rebuildTunnelMesh();
      this.tunnelVersion = lattice.version;
      this.tunnelMeshDirty = false;
    }

    this.speed = Math.abs(this.trackSpeed);
    this.drive = this.smoothDrive;
    this.secondaryDrive = this.smoothDrill;
    this.heat = this.cutterTemp;
    this.turbulence = 0;
    this.stress = this.hullStress;

    if (input.pressed('interact')) this.interact();
    if (input.pressed('tertiary')) this.secondary();
  }

  // -- actions --------------------------------------------------------------

  /** Deploy a heat exchanger into the surrounding rock. */
  interact(): void {
    const pos = this.position;
    const lattice = this.env.lattice;
    const deployPos = this._v1.set(pos.x, pos.y - 1.0, pos.z);
    lattice.addHeat(deployPos.x, deployPos.y, deployPos.z, -0.55);
    this.installedExchangers++;
    this.env.blip(pos.x, pos.y, pos.z, 300 + this.installedExchangers * 60, 0.22);
    this.env.impact(0.4, 0.25);
    this.fireObjective('exchanger');
  }

  /** Coolant purge — dumps heat fast but consumes the reserve. */
  secondary(): void {
    if (this.coolant < 0.12) return;
    this.coolant = clamp01(this.coolant - 0.35);
    this.cutterTemp = clamp01(this.cutterTemp - 0.28);
    this.env.impact(0.35, 0.6);
    this.env.blip(this.position.x, this.position.y, this.position.z, 900, 0.18);
  }

  /** Seal the tunnel behind the crawler to confine disturbed strata. */
  sealBehind(): void {
    const lattice = this.env.lattice;
    const behind = this._v1.set(
      this.position.x - Math.sin(this.heading) * 8,
      this.position.y,
      this.position.z - Math.cos(this.heading) * 8,
    );
    const filled = lattice.backfill(behind.x, behind.y, behind.z, CUTTER_RADIUS / lattice.cell);
    if (filled > 0) this.tunnelMeshDirty = true;
    this.env.impact(0.3, 0.4);
    this.env.blip(this.position.x, this.position.y, this.position.z, 520, 0.16);
    this.fireObjective('seal');
  }

  // -- camera ---------------------------------------------------------------

  getCameraTarget(out: { position: THREE.Vector3; lookAt: THREE.Vector3 }): void {
    const back = this._v1.set(-Math.sin(this.heading), 0, -Math.cos(this.heading));
    switch (this.cameraMode) {
      case 'COCKPIT':
        out.position.set(0, 5.2, -2.5).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading).add(this.position);
        out.lookAt
          .copy(this._v2.set(0, 4.0, 30).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.heading))
          .add(this.position);
        break;
      case 'INSPECT':
        out.position.copy(this.position).addScaledVector(back, 34).setY(this.position.y + 18);
        out.lookAt.copy(this.position);
        break;
      default:
        out.position.copy(this.position).addScaledVector(back, 24).setY(this.position.y + 11);
        out.lookAt.copy(this.position);
    }
  }

  // -- hud ------------------------------------------------------------------

  hud(): HudModel {
    const torque = this.drilling ? (0.35 + this.materialHardness * 0.65) * 100 : 0;
    return {
      kind: this.kind,
      title: 'STRATA-CRAWLER',
      subtitle: 'ARS-IX · subterranean engineering platform',
      gauges: [
        gauge('torque', 'Cutter Torque', torque, 0, 100, '%'),
        gauge('cuttertemp', 'Cutter Temperature', this.cutterTemp * 100, 0, 100, 'degC x12', 70, 90),
        gauge('coolant', 'Coolant Reserve', this.coolant * 100, 0, 100, '%', 0, 0),
        gauge('hull', 'Hull Stress', this.hullStress * 100, 0, 100, '%', 55, 80),
        { key: 'depth', label: 'Depth', value: this.depth, min: 0, max: 240, unit: 'm' },
        gauge('seismic', 'Seismic Pressure', this.seismicPressure * 100, 0, 100, 'MPa x9', 60, 85),
        gauge('collapse', 'Predicted Collapse Risk', this.instability * 100, 0, 100, '%', 45, 75),
        gauge('power', 'Reactor Output', this.power * 100, 0, 100, '%', 0, 0),
      ],
      flags: [
        { label: `Material: ${this.materialName}`, on: true },
        { label: `Hardness ${this.materialHardness.toFixed(2)}`, on: this.materialHardness < 0.8 },
        { label: 'Cutter Overheat', on: this.cutterTemp > 0.9 },
        { label: this.drilling ? 'Cutting' : 'Cutter Idle', on: this.drilling },
        { label: 'In Tunnel', on: this.env.lattice.isVoid(this.position.x, this.position.y, this.position.z) },
      ],
      readout: `Rock temperature ${(this.rockTemp * 900).toFixed(0)} degC · depth ${this.depth.toFixed(0)} m · drilled ${this.drillSeconds.toFixed(0)} s`,
      objectives: [],
    };
  }

  get controls(): { label: string; detail: string }[] {
    return [
      { label: 'W / S', detail: 'Track drive forward / reverse' },
      { label: 'A / D', detail: 'Differential track steering' },
      { label: 'Q / E', detail: 'Descend / ascend the bore' },
      { label: 'Mouse 1 / F', detail: 'Run the cutter (heat and coolant)' },
      { label: 'Mouse 2 / R', detail: 'Coolant purge — fast cooldown, costs reserve' },
      { label: 'G', detail: 'Install a heat exchanger into the surrounding rock' },
    ];
  }

  get cutterTemperature(): number {
    return this.cutterTemp;
  }

  get exchangersInstalled(): number {
    return this.installedExchangers;
  }

  get collapseRisk(): number {
    return this.instability;
  }

  get drillTime(): number {
    return this.drillSeconds;
  }

  dispose(): void {
    this.cutterHead.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    this.tunnelMesh.geometry.dispose();
    (this.tunnelMesh.material as THREE.Material).dispose();
    this.cutterRing.geometry.dispose();
    (this.cutterRing.material as THREE.Material).dispose();
    super.dispose();
  }
}

function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}
