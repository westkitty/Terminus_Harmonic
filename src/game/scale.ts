/**
 * SCALE MANAGER — multi-scale world architecture
 * ==============================================
 *
 * The game never tries to hold astronomical orbit and centimetre-scale ground
 * physics in one coordinate space. It runs three scenes, each with its own
 * coordinate system and its own camera:
 *
 *   PLANETARY  planet radius 100 units, camera 130..900 units out
 *   ORBITAL    metres, planet radius 6.371e6, debris cluster within ~1.4 km
 *   SECTOR     metres, sector-local floating frame, ~2 km across
 *
 * Transitions between them are spatially coherent rather than teleports:
 *
 *   1. the planetary camera dives toward the selected node along its normal;
 *   2. a lattice-engagement wipe masks the cut while the sun direction, horizon
 *      colour and approach vector are carried across into the new scene;
 *   3. the sector camera starts high above the arrival point looking down the
 *      approach vector, then settles onto the possessed machine.
 *
 * Only one scene is ever fully simulated and rendered at a time.
 */

import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/math';

export type Scale = 'MACRO' | 'DESCENDING' | 'ORBIT' | 'SECTOR' | 'ASCENDING' | 'BOOT';

const WIPE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const WIPE_FRAG = /* glsl */ `
precision highp float;
uniform float uProgress;   // 0 = fully clear, 1 = fully covered
uniform float uTime;
uniform vec3 uColor;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  // Vertical wipe driven by noise so it reads as instrumentation, not a fade.
  float band = smoothstep(0.0, 1.0, vUv.y);
  float n = hash(floor(vUv * vec2(90.0, 26.0)) + floor(uTime * 22.0));
  float threshold = uProgress * 1.35 - 0.18;
  float cover = step(threshold - n * 0.22, band);
  // Thin scanlines inside the covered region.
  float scan = 0.85 + 0.15 * sin(vUv.y * 900.0 + uTime * 30.0);
  vec3 c = uColor * scan;
  // Azure instrumentation edge.
  float edge = smoothstep(threshold - 0.06, threshold, band) - smoothstep(threshold, threshold + 0.06, band);
  c += vec3(0.12, 0.55, 0.8) * edge * 1.4;
  float alpha = clamp(cover + edge * 0.8, 0.0, 1.0) * clamp(uProgress * 3.0, 0.0, 1.0);
  gl_FragColor = vec4(c, alpha);
}
`;

export interface TransitionState {
  scale: Scale;
  /** 0..1 progress of the current transition. */
  t: number;
  label: string;
}

/** Named scenes make the render pipeline readable in logs and profiles. */
function scene(name: string): THREE.Scene {
  const s = new THREE.Scene();
  s.name = name;
  return s;
}

export class ScaleManager {
  readonly renderer: THREE.WebGLRenderer;
readonly scenes = {
  MACRO: scene('MACRO'),
  ORBIT: scene('ORBIT'),
  SECTOR: scene('SECTOR'),
};
  readonly cameras = {
    MACRO: new THREE.PerspectiveCamera(46, 1, 0.5, 20000),
    ORBIT: new THREE.PerspectiveCamera(62, 1, 1, 4e7),
    SECTOR: new THREE.PerspectiveCamera(66, 1, 0.35, 12000),
  };

  scale: Scale = 'BOOT';
  private transitionT = 0;
  private transitionDuration = 1.0;
  private transitionFrom: Scale = 'MACRO';
  private transitionTo: Scale = 'MACRO';
  private wipeMaterial: THREE.ShaderMaterial;
  private wipeScene = scene('WIPE');
  private wipeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private wipeQuad: THREE.Mesh;
  private reducedMotion: boolean;

  /** Camera rig state for the sector scene. */
  private sectorCamPos = new THREE.Vector3();
  private sectorCamLook = new THREE.Vector3();
  private sectorCamTargetPos = new THREE.Vector3();
  private sectorCamTargetLook = new THREE.Vector3();
  private camInitialised = false;

  /** Planetary camera orbit state. */
  macroOrbit = { theta: 0.7, phi: 1.15, distance: 290, targetDistance: 290 };
  macroFocus = new THREE.Vector3(0, 0, 0);

  onScaleChanged: ((scale: Scale) => void) | null = null;

  constructor(
    renderer: THREE.WebGLRenderer,
    reducedMotion = false,
  ) {
    this.renderer = renderer;
    this.reducedMotion = reducedMotion;
    this.wipeMaterial = new THREE.ShaderMaterial({
      vertexShader: WIPE_VERT,
      fragmentShader: WIPE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uProgress: { value: 0 },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x07080a) },
      },
    });
    this.wipeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.wipeMaterial);
    this.wipeQuad.frustumCulled = false;
    this.wipeScene.add(this.wipeQuad);

    this.cameras.MACRO.position.set(180, 140, 220);
    this.cameras.ORBIT.position.set(0, 200, 900);
    this.cameras.SECTOR.position.set(0, 300, 600);

    // Descend/ascend are driven explicitly by the game via beginDescend()/
    // beginAscend(); the events are emitted by the game itself.
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
  }

  // -- transitions ----------------------------------------------------------

  beginDescend(toOrbit: boolean): void {
    if (this.scale === 'DESCENDING' || this.scale === 'ASCENDING') return;
    this.transitionFrom = 'MACRO';
    this.transitionTo = toOrbit ? 'ORBIT' : 'SECTOR';
    this.scale = 'DESCENDING';
    this.transitionT = 0;
    this.transitionDuration = this.reducedMotion ? 0.45 : 1.35;
    this.onScaleChanged?.(this.scale);
  }

  beginAscend(): void {
    if (this.scale === 'DESCENDING' || this.scale === 'ASCENDING') return;
    this.transitionFrom = this.scale === 'ORBIT' ? 'ORBIT' : 'SECTOR';
    this.transitionTo = 'MACRO';
    this.scale = 'ASCENDING';
    this.transitionT = 0;
    this.transitionDuration = this.reducedMotion ? 0.45 : 1.35;
    this.onScaleChanged?.(this.scale);
  }

  /** Force a scale without a transition (used by save restoration). */
  setScale(scale: Scale): void {
    this.scale = scale;
    this.transitionT = 1;
    this.onScaleChanged?.(scale);
  }

  get inTransition(): boolean {
    return this.scale === 'DESCENDING' || this.scale === 'ASCENDING';
  }

  /** 0..1 progress of the current transition. */
  get transitionProgress(): number {
    return clamp01(this.transitionT / this.transitionDuration);
  }

  /** Which scene should be updated/rendered this frame. */
  get activeScale(): Scale {
    if (this.scale === 'DESCENDING') return this.transitionT < this.transitionDuration * 0.5 ? 'MACRO' : this.transitionTo;
    if (this.scale === 'ASCENDING') return this.transitionT < this.transitionDuration * 0.5 ? this.transitionFrom : 'MACRO';
    if (this.scale === 'ORBIT' || this.scale === 'SECTOR') return this.scale;
    return 'MACRO';
  }

  // -- planetary camera -----------------------------------------------------

  /** Orbit the macro camera by a pointer delta. */
  orbitMacro(dx: number, dy: number, dt: number): void {
    const speed = 0.0042;
    this.macroOrbit.theta -= dx * speed;
    this.macroOrbit.phi = clamp01(this.macroOrbit.phi - dy * speed) * Math.PI;
    this.macroOrbit.phi = Math.min(Math.PI - 0.05, Math.max(0.05, this.macroOrbit.phi));
    void dt;
  }

  zoomMacro(delta: number): void {
    this.macroOrbit.targetDistance = THREE.MathUtils.clamp(
      this.macroOrbit.targetDistance * (1 + delta * 0.12),
      128,
      1400,
    );
  }

  /** Focus the macro camera on a lat/lon and start the dive. */
  focusNode(lat: number, lon: number, radius: number): void {
    const phi = lat * (Math.PI / 180);
    const theta = lon * (Math.PI / 180);
    this.macroOrbit.theta = theta;
    this.macroOrbit.phi = Math.PI / 2 - phi;
    this.macroOrbit.targetDistance = radius * 1.35;
    this.macroFocus.set(
      Math.cos(phi) * Math.cos(theta) * radius,
      Math.sin(phi) * radius,
      Math.cos(phi) * Math.sin(theta) * radius,
    );
  }

  /** Snap macro camera to standard viewing perspectives (Equator, Poles, or Reset). */
  snapMacroCamera(angle: 'EQUATOR' | 'NORTH_POLE' | 'SOUTH_POLE' | 'RESET'): void {
    this.macroFocus.set(0, 0, 0);
    switch (angle) {
      case 'EQUATOR':
        this.macroOrbit.phi = Math.PI / 2;
        break;
      case 'NORTH_POLE':
        this.macroOrbit.phi = 0.08;
        break;
      case 'SOUTH_POLE':
        this.macroOrbit.phi = Math.PI - 0.08;
        break;
      case 'RESET':
        this.macroOrbit.theta = 0.7;
        this.macroOrbit.phi = 1.15;
        this.macroOrbit.targetDistance = 290;
        break;
    }
  }

  updateMacroCamera(dt: number): void {
    const cam = this.cameras.MACRO;
    const o = this.macroOrbit;
    o.distance = damp(o.distance, o.targetDistance, 3.5, dt);
    const sp = Math.sin(o.phi);
    cam.position.set(
      this.macroFocus.x + o.distance * sp * Math.cos(o.theta),
      this.macroFocus.y + o.distance * Math.cos(o.phi),
      this.macroFocus.z + o.distance * sp * Math.sin(o.theta),
    );
    cam.lookAt(this.macroFocus);
    cam.updateMatrixWorld();
  }

  // -- sector camera --------------------------------------------------------

  /**
   * Place the sector camera to continue the descent: high above the arrival
   * point, looking down the approach vector.
   */
  setSectorEntry(arrival: THREE.Vector3, approachDir: THREE.Vector3, distance: number): void {
    this.sectorCamPos.copy(arrival).addScaledVector(approachDir, distance).add(new THREE.Vector3(0, distance * 0.72, 0));
    this.sectorCamLook.copy(arrival);
    this.sectorCamTargetPos.copy(this.sectorCamPos);
    this.sectorCamTargetLook.copy(this.sectorCamLook);
    this.camInitialised = false;
  }

  /** Feed the vehicle's desired camera transform; the rig smooths toward it. */
  setSectorCameraTarget(position: THREE.Vector3, lookAt: THREE.Vector3, snap = false): void {
    this.sectorCamTargetPos.copy(position);
    this.sectorCamTargetLook.copy(lookAt);
    if (snap || !this.camInitialised) {
      this.sectorCamPos.copy(position);
      this.sectorCamLook.copy(lookAt);
      this.camInitialised = true;
    }
  }

  updateSectorCamera(dt: number): void {
    const cam = this.cameras.SECTOR;
    // Blend rate rises as the descent transition completes so the rig settles.
    const settle = this.scale === 'SECTOR' ? 6.5 : 12;
    const rate = this.reducedMotion ? settle * 2.5 : settle;
    this.sectorCamPos.x = damp(this.sectorCamPos.x, this.sectorCamTargetPos.x, rate, dt);
    this.sectorCamPos.y = damp(this.sectorCamPos.y, this.sectorCamTargetPos.y, rate, dt);
    this.sectorCamPos.z = damp(this.sectorCamPos.z, this.sectorCamTargetPos.z, rate, dt);
    this.sectorCamLook.x = damp(this.sectorCamLook.x, this.sectorCamTargetLook.x, rate, dt);
    this.sectorCamLook.y = damp(this.sectorCamLook.y, this.sectorCamTargetLook.y, rate, dt);
    this.sectorCamLook.z = damp(this.sectorCamLook.z, this.sectorCamTargetLook.z, rate, dt);
    cam.position.copy(this.sectorCamPos);
    cam.lookAt(this.sectorCamLook);
    cam.updateMatrixWorld();

    const orbitCam = this.cameras.ORBIT;
    orbitCam.position.copy(this.sectorCamPos);
    orbitCam.lookAt(this.sectorCamLook);
    orbitCam.updateMatrixWorld();
  }

  /** Hard-set the sector camera (used when switching vehicles or teleporting). */
  snapSectorCamera(): void {
    this.sectorCamPos.copy(this.sectorCamTargetPos);
    this.sectorCamLook.copy(this.sectorCamTargetLook);
    this.camInitialised = true;
  }

  // -- render ---------------------------------------------------------------

  resize(width: number, height: number): void {
    for (const cam of Object.values(this.cameras)) {
      cam.aspect = width / Math.max(1, height);
      cam.updateProjectionMatrix();
    }
  }

  /** Advance the transition and render the active scene. */
  render(dt: number, elapsed: number): void {
    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    if (this.inTransition) {
      this.transitionT += dt;
      const half = this.transitionDuration * 0.5;
      const localT = clamp01(this.transitionT / half);
      // First half: cover the outgoing scene. Second half: reveal the incoming.
      const cover = this.scale === 'DESCENDING' ? localT : 1 - localT;
      const outgoing: 'MACRO' | 'ORBIT' | 'SECTOR' =
        this.scale === 'DESCENDING' ? 'MACRO' : this.transitionFrom === 'ORBIT' ? 'ORBIT' : 'SECTOR';

      renderer.render(this.scenes[outgoing], this.cameras[outgoing]);
      this.wipeMaterial.uniforms.uProgress.value = cover;
      this.wipeMaterial.uniforms.uTime.value = elapsed;
      renderer.autoClear = false;
      renderer.render(this.wipeScene, this.wipeCamera);
      renderer.autoClear = true;
      renderer.clearDepth();

      if (this.transitionT >= this.transitionDuration) {
        this.scale = this.scale === 'DESCENDING' ? this.transitionTo : 'MACRO';
        this.transitionT = this.transitionDuration;
        this.onScaleChanged?.(this.scale);
      }
    } else {
      const active = this.scale === 'ORBIT' ? 'ORBIT' : this.scale === 'SECTOR' ? 'SECTOR' : 'MACRO';
      renderer.render(this.scenes[active], this.cameras[active]);
    }

    renderer.autoClear = prevAutoClear;
  }

  dispose(): void {
    this.wipeQuad.geometry.dispose();
    this.wipeMaterial.dispose();
  }
}

export { lerp };
