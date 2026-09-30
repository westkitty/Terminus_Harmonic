/**
 * VEHICLE BASE — shared contract for all four machines
 * ====================================================
 *
 * Every vehicle is a self-contained controller that owns:
 *   - an ECS entity (so it participates in queries, persistence and telemetry);
 *   - a THREE.Object3D rig (so the renderer never needs to know the physics);
 *   - a world-space companion group (`worldGroup`) for detached/deployed
 *     elements (debris, tethers, delivery zones, excavated tunnel shells,
 *     installed exchangers, dropped sensors) that must not inherit the hull's
 *     transform;
 *   - a HUD model (so the UI renders gauges without knowing the machine);
 *   - its own physics step (they are deliberately NOT unified — a 6-DOF skiff
 *     and a 6-bogie land-train share nothing worth abstracting).
 *
 * The one thing they do share is the {@link VehicleEnvironment}, which is how a
 * local action reaches the authoritative planetary state.
 */

import * as THREE from 'three';
import type { Entity, World } from '../core/ecs';
import type { InputManager } from '../core/input';
import type { SectorField, TunnelLattice } from '../sector/field';
import type { VehicleKind } from '../state/world';
import type { PlanetaryState } from '../state/planetary';

export interface Gauge {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  /** Caution band. */
  warn?: boolean;
  /** Critical band — also drives a non-colour indicator (the UI pulses it). */
  crit?: boolean;
  /** Optional textual override, e.g. "STALL". */
  text?: string;
}

export interface HudFlag {
  label: string;
  on: boolean;
}

export interface HudModel {
  kind: VehicleKind;
  title: string;
  subtitle: string;
  gauges: Gauge[];
  flags: HudFlag[];
  /** Free-form status line. */
  readout: string;
  /** Crosshair/targeting info when applicable. */
  target?: string;
  /** Objective progress lines. */
  objectives: { text: string; progress: number; done: boolean }[];
}

export interface VehicleEnvironment {
  world: World;
  input: InputManager;
  field: SectorField;
  lattice: TunnelLattice;
  planetary: PlanetaryState;
  /** Sector-local sun direction (normalised). */
  sunDirection: THREE.Vector3;
  /** Sector-local wind vector in m/s. */
  wind: THREE.Vector3;
  /** Camera to drive. */
  camera: THREE.PerspectiveCamera;
  /** Fire an audio one-shot. */
  impact: (intensity: number, brightness: number) => void;
  /** Positional audio blip in sector-local coords. */
  blip: (x: number, y: number, z: number, freq: number, gain: number) => void;
  /** Report a completed objective step back to the crisis controller. */
  reportObjective: (objectiveId: string, amount?: number) => void;
  /** Quality-driven particle scale 0..2. */
  particleScale: number;
  reducedMotion: boolean;
}

export type CameraMode = 'CHASE' | 'COCKPIT' | 'INSPECT' | 'ORBIT';

export abstract class VehicleBase {
  readonly kind: VehicleKind;
  readonly object3D = new THREE.Group();
  /** World-space group for deployed/sector elements that do not move with the hull. */
  readonly worldGroup = new THREE.Group();
  readonly entity: Entity;
  protected world: World;
  protected env: VehicleEnvironment;
  protected disposed = false;

  /** Current speed magnitude in m/s. */
  speed = 0;
  /** Camera mode; vehicles may restrict which are available. */
  cameraMode: CameraMode = 'CHASE';
  abstract readonly availableCameraModes: readonly CameraMode[];

  /** Accumulated machine stress 0..1 — feeds hull audio and damage warnings. */
  stress = 0;
  /** Thermal load 0..1. */
  heat = 0;
  /** Primary drive output 0..1. */
  drive = 0;
  /** Secondary drive output 0..1 (drill, thruster bite). */
  secondaryDrive = 0;
  /** Environmental turbulence 0..1. */
  turbulence = 0;

  /** Objective completion callbacks registered by the crisis controller. */
  protected objectiveHooks = new Map<string, () => void>();

  constructor(world: World, env: VehicleEnvironment, kind: VehicleKind) {
    this.world = world;
    this.env = env;
    this.kind = kind;
    this.entity = world.create();
    world.tag(this.entity, 'vehicle');
    world.tag(this.entity, `vehicle:${kind}`);
    this.object3D.name = `vehicle-${kind}`;
    this.worldGroup.name = `vehicle-world-${kind}`;
  }

  /** Rebind the vehicle to a freshly constructed sector environment. */
  setEnvironment(env: VehicleEnvironment): void {
    this.env = env;
  }

  /** Authoritative world-space position of the vehicle for streaming and camera tracking. */
  get worldPosition(): THREE.Vector3 {
    return this.object3D.position;
  }

  /** Spawn/place the machine at a sector-local position with a heading. */
  abstract spawn(position: THREE.Vector3, headingRad: number): void;

  /** Physics + control step. */
  abstract update(dt: number): void;

  /** HUD snapshot for the UI layer. */
  abstract hud(): HudModel;

  /** Register an objective hook the vehicle can fire. */
  onObjective(id: string, fn: () => void): void {
    this.objectiveHooks.set(id, fn);
  }

  /** Drop all registered objective hooks (called when a sector is rebuilt). */
  clearObjectives(): void {
    this.objectiveHooks.clear();
  }

  protected fireObjective(id: string): void {
    this.objectiveHooks.get(id)?.();
  }

  /** Primary tool action (context dependent). */
  primary(): void {}
  /** Secondary tool action. */
  secondary(): void {}
  /** Interact / deploy. */
  interact(): void {}
  /** Flight assist / stabilise toggle. */
  toggleAssist(): void {}

  /** Camera transform for the current mode. */
  abstract getCameraTarget(out: { position: THREE.Vector3; lookAt: THREE.Vector3 }): void;

  /** Short instruction lines for the control guidance panel. */
  abstract get controls(): { label: string; detail: string }[];

  /** Audio frame state contribution. */
  audioState(): {
    drive: number;
    secondary: number;
    speed: number;
    stress: number;
    heat: number;
    turbulence: number;
  } {
    return {
      drive: this.drive,
      secondary: this.secondaryDrive,
      speed: this.speed,
      stress: this.stress,
      heat: this.heat,
      turbulence: this.turbulence,
    };
  }

  /** True when the machine is in a state that should end the local session. */
  get isBroken(): boolean {
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.destroy(this.entity);
    for (const root of [this.object3D, this.worldGroup]) {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
      root.clear();
    }
  }
}

/** Shared gauge construction helper with warn/crit bands. */
export function gauge(
  key: string,
  label: string,
  value: number,
  min: number,
  max: number,
  unit: string,
  warnAbove?: number,
  critAbove?: number,
): Gauge {
  return {
    key,
    label,
    value,
    min,
    max,
    unit,
    warn: warnAbove !== undefined && value >= warnAbove,
    crit: critAbove !== undefined && value >= critAbove,
  };
}

/** Simple reusable procedural mesh builders (no external assets). */
export const Meshes = {
  box(w: number, h: number, d: number, color: number, metalness = 0.55, roughness = 0.72): THREE.Mesh {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, metalness, roughness }),
    );
    return m;
  },
  cylinder(rt: number, rb: number, h: number, seg: number, color: number, metalness = 0.6, roughness = 0.6): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.CylinderGeometry(rt, rb, h, seg),
      new THREE.MeshStandardMaterial({ color, metalness, roughness }),
    );
  },
  plate(w: number, h: number, d: number, color: number): THREE.Mesh {
    return new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.85 }),
    );
  },
};

/** Weathered industrial palette — scorched, oxidised, utilitarian. */
export const PALETTE = {
  rust: 0x6b3a24,
  darkRust: 0x4a2717,
  steel: 0x5a5f63,
  darkSteel: 0x33383c,
  ceramic: 0x2a2622,
  glass: 0x14161a,
  amber: 0xc98a3c,
  warning: 0xd05a2a,
  azureTrace: 0x2f9fd0,
  dust: 0x8a7c68,
} as const;
