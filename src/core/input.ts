/**
 * INPUT — keyboard, mouse, touch and gamepad
 * ==========================================
 *
 * One listener set for the whole application. Actions are named, not key-bound,
 * so remapping is a data change rather than a code change. Touch devices get a
 * virtual stick + button surface driven from here (see `ui/touch.ts`).
 *
 * Pointer lock is used for look control on desktop; it is acquired lazily and
 * released whenever the UI takes focus.
 */

export type ActionName =
  | 'throttle'
  | 'reverse'
  | 'strafeLeft'
  | 'strafeRight'
  | 'ascend'
  | 'descend'
  | 'yawLeft'
  | 'yawRight'
  | 'pitchUp'
  | 'pitchDown'
  | 'rollLeft'
  | 'rollRight'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'assist'
  | 'brake'
  | 'boost'
  | 'interact'
  | 'ascendMacro'
  | 'cameraCycle'
  | 'overlayNext'
  | 'overlayPrev'
  | 'map'
  | 'pause'
  | 'codex'
  | 'quickSave'
  | 'quickLoad'
  | 'timeWarpPause'
  | 'timeWarpFaster'
  | 'timeWarpSlower'
  | 'headlights'
  | 'autoLevel'
  | 'cruiseControl'
  | 'muteToggle'
  | 'resetCamera';

export const ACTION_LABELS: Record<ActionName, string> = {
  throttle: 'Forward / Throttle',
  reverse: 'Reverse',
  strafeLeft: 'Strafe Left',
  strafeRight: 'Strafe Right',
  ascend: 'Ascend / Climb',
  descend: 'Descend / Dive',
  yawLeft: 'Yaw Left',
  yawRight: 'Yaw Right',
  pitchUp: 'Pitch Up',
  pitchDown: 'Pitch Down',
  rollLeft: 'Roll Left',
  rollRight: 'Roll Right',
  primary: 'Primary Tool',
  secondary: 'Secondary Tool',
  tertiary: 'Tertiary Tool',
  assist: 'Flight Assist / Stabilise',
  brake: 'Brake',
  boost: 'Boost',
  interact: 'Interact / Deploy',
  ascendMacro: 'Return to Command Lattice',
  cameraCycle: 'Cycle Camera',
  overlayNext: 'Next Overlay',
  overlayPrev: 'Previous Overlay',
  map: 'Toggle Map',
  pause: 'Pause / Menu',
  codex: 'Survey Archive & Codex',
  quickSave: 'Quick Save',
  quickLoad: 'Quick Load',
  timeWarpPause: 'Pause / Unpause Sim',
  timeWarpFaster: 'Increase Sim Speed',
  timeWarpSlower: 'Decrease Sim Speed',
  headlights: 'Toggle Headlights',
  autoLevel: 'Auto-Level Horizon',
  cruiseControl: 'Cruise Control Lock',
  muteToggle: 'Mute Audio',
  resetCamera: 'Reset Camera Orientation',
};

export type KeyBinding = Record<ActionName, string[]>;

export const DEFAULT_BINDINGS: KeyBinding = {
  throttle: ['KeyW', 'ArrowUp'],
  reverse: ['KeyS', 'ArrowDown'],
  strafeLeft: ['KeyA', 'ArrowLeft'],
  strafeRight: ['KeyD', 'ArrowRight'],
  ascend: ['KeyE', 'Space'],
  descend: ['KeyQ', 'ShiftLeft'],
  yawLeft: ['KeyZ'],
  yawRight: ['KeyC'],
  pitchUp: ['KeyI'],
  pitchDown: ['KeyK'],
  rollLeft: ['KeyJ'],
  rollRight: ['KeyL'],
  primary: ['Mouse0', 'Enter'],
  secondary: ['Mouse2', 'KeyF'],
  tertiary: ['KeyR'],
  assist: ['KeyX'],
  brake: ['KeyB'],
  boost: ['ShiftRight'],
  interact: ['KeyG'],
  ascendMacro: ['Escape', 'KeyM'],
  cameraCycle: ['KeyV'],
  overlayNext: ['Tab', 'KeyO'],
  overlayPrev: ['Backquote'],
  map: ['KeyM'],
  pause: ['KeyP'],
  codex: ['KeyC'],
  quickSave: ['F5'],
  quickLoad: ['F9'],
  timeWarpPause: ['Space'],
  timeWarpFaster: ['BracketRight', 'Period'],
  timeWarpSlower: ['BracketLeft', 'Comma'],
  headlights: ['KeyH'],
  autoLevel: ['KeyX'],
  cruiseControl: ['KeyZ'],
  muteToggle: ['KeyU'],
  resetCamera: ['Home'],
};

interface ActionState {
  /** 0..1 held amount (analog sources ramp). */
  value: number;
  /** True on the frame the action became active. */
  pressed: boolean;
  /** True on the frame the action was released. */
  released: boolean;
  /** Accumulated while held; reset by consume(). */
  held: boolean;
}

export interface PointerDelta {
  dx: number;
  dy: number;
}

export class InputManager {
  private bindings: KeyBinding;
  private keyToAction = new Map<string, ActionName>();
  private states = new Map<ActionName, ActionState>();
  private prevHeld = new Map<ActionName, boolean>();
  /** Analog axes filled from keyboard/gamepad/touch each frame. */
  readonly axis = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, throttle: 0 };
  private keysDown = new Set<string>();
  private mouseDown = new Set<number>();
  private accumDx = 0;
  private accumDy = 0;
  private wheel = 0;
  private touchLook: { dx: number; dy: number } | null = null;
  private touchButtons = new Map<ActionName, number>();
  private touchAxes = { x: 0, y: 0, z: 0 };
  private gamepadIndex: number | null = null;
  private element: HTMLElement;
  private enabled = true;
  private pointerLocked = false;
  /** Set while a modal/menu owns input; game actions are suppressed. */
  uiCapture = false;
  /** Callback for pointer-lock requests (the renderer handles the DOM call). */
  onPointerLockRequest: ((want: boolean) => void) | null = null;
  /** Fired when an action transitions to pressed. */
  onAction: ((action: ActionName) => void) | null = null;

  constructor(element: HTMLElement, bindings: KeyBinding = DEFAULT_BINDINGS) {
    this.element = element;
    this.bindings = { ...bindings };
    this.rebuildKeyMap();
    for (const a of Object.keys(DEFAULT_BINDINGS) as ActionName[]) {
      this.states.set(a, { value: 0, pressed: false, released: false, held: false });
      this.prevHeld.set(a, false);
    }
    this.attach();
  }

  private rebuildKeyMap(): void {
    this.keyToAction.clear();
    for (const action of Object.keys(this.bindings) as ActionName[]) {
      for (const code of this.bindings[action]) this.keyToAction.set(code, action);
    }
  }

  setBindings(bindings: KeyBinding): void {
    this.bindings = { ...bindings };
    this.rebuildKeyMap();
  }

  getBindings(): KeyBinding {
    return { ...this.bindings };
  }

  private attach(): void {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    this.element.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    this.element.addEventListener('mousemove', this.onMouseMove);
    this.element.addEventListener('wheel', this.onWheel, { passive: false });
    this.element.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('gamepadconnected', this.onGamepadConnected);
    window.addEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.element.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.element.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('wheel', this.onWheel);
    this.element.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('gamepadconnected', this.onGamepadConnected);
    window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnected);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) {
      // Still register held state.
      this.keysDown.add(e.code);
      return;
    }
    // Let the browser handle typing into fields.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    this.keysDown.add(e.code);
    const action = this.keyToAction.get(e.code);
    if (action) {
      e.preventDefault();
      if (this.enabled && !this.uiCapture) {
        const st = this.states.get(action);
        if (st) st.pressed = true;
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  private onBlur = (): void => {
    this.keysDown.clear();
    this.mouseDown.clear();
  };

  private onMouseDown = (e: MouseEvent): void => {
    this.mouseDown.add(e.button);
    const code = `Mouse${e.button}`;
    this.keysDown.add(code);
    const action = this.keyToAction.get(code);
    if (action && this.enabled && !this.uiCapture) {
      const st = this.states.get(action);
      if (st) st.pressed = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    this.mouseDown.delete(e.button);
    this.keysDown.delete(`Mouse${e.button}`);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked && !this.mouseDown.has(0) && !this.mouseDown.has(2)) return;
    this.accumDx += e.movementX;
    this.accumDy += e.movementY;
  };

  private onWheel = (e: WheelEvent): void => {
    this.wheel += Math.sign(e.deltaY);
    if (!this.uiCapture) e.preventDefault();
  };

  private onGamepadConnected = (e: GamepadEvent): void => {
    this.gamepadIndex = e.gamepad.index;
  };

  private onGamepadDisconnected = (): void => {
    this.gamepadIndex = null;
  };

  private onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.element;
  };

  requestPointerLock(want: boolean): void {
    if (want && !this.pointerLocked) {
      this.element.requestPointerLock?.();
    } else if (!want && this.pointerLocked) {
      document.exitPointerLock?.();
    }
  }

  get isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    if (!v) {
      this.keysDown.clear();
      this.mouseDown.clear();
    }
  }

  // -- touch surface -------------------------------------------------------

  setTouchAxis(x: number, y: number, z: number): void {
    this.touchAxes.x = x;
    this.touchAxes.y = y;
    this.touchAxes.z = z;
  }

  setTouchButton(action: ActionName, down: boolean): void {
    if (down) this.touchButtons.set(action, 1);
    else this.touchButtons.delete(action);
    if (down && this.enabled && !this.uiCapture) {
      const st = this.states.get(action);
      if (st) st.pressed = true;
    }
  }

  addTouchLook(dx: number, dy: number): void {
    if (!this.touchLook) this.touchLook = { dx: 0, dy: 0 };
    this.touchLook.dx += dx;
    this.touchLook.dy += dy;
  }

  clearTouchButtons(): void {
    this.touchButtons.clear();
    this.touchAxes.x = 0;
    this.touchAxes.y = 0;
    this.touchAxes.z = 0;
  }

  // -- per-frame -----------------------------------------------------------

  /** Resolve held state and build the analog axis block. Call once per frame. */
  beginFrame(): void {
    // Keyboard/gamepad/touch -> per-action held + analog.
    const heldNow = new Map<ActionName, boolean>();
    const setHeld = (a: ActionName, v: boolean) => {
      if (v) heldNow.set(a, true);
    };

    for (const code of this.keysDown) {
      const a = this.keyToAction.get(code);
      if (a) setHeld(a, true);
    }
    for (const a of this.touchButtons.keys()) setHeld(a, true);

    // Gamepad.
    const pad = this.readGamepad();
    if (pad) {
      const dz = 0.25;
      if (pad.axes[1] < -dz) setHeld('throttle', true);
      if (pad.axes[1] > dz) setHeld('reverse', true);
      if (pad.axes[0] < -dz) setHeld('strafeLeft', true);
      if (pad.axes[0] > dz) setHeld('strafeRight', true);
      if ((pad.buttons[0]?.value ?? 0) > 0.3) setHeld('primary', true);
      if ((pad.buttons[2]?.value ?? 0) > 0.3) setHeld('secondary', true);
      if ((pad.buttons[3]?.value ?? 0) > 0.3) setHeld('tertiary', true);
      if ((pad.buttons[1]?.value ?? 0) > 0.3) setHeld('interact', true);
      if ((pad.buttons[4]?.value ?? 0) > 0.3) setHeld('assist', true);
      if ((pad.buttons[5]?.value ?? 0) > 0.3) setHeld('brake', true);
      if ((pad.buttons[10]?.value ?? 0) > 0.3) setHeld('ascend', true);
      if ((pad.buttons[11]?.value ?? 0) > 0.3) setHeld('descend', true);
      if ((pad.buttons[7]?.value ?? 0) > 0.3) setHeld('boost', true);
      if ((pad.buttons[6]?.value ?? 0) > 0.3) setHeld('assist', true);
      if ((pad.buttons[9]?.value ?? 0) > 0.3) setHeld('ascendMacro', true);
    }

    const analog = (a: ActionName, padAxis: number): number => {
      let v = heldNow.get(a) ? 1 : 0;
      if (pad && Math.abs(padAxis) > 0.02) {
        // Merge analog axis for axes that have one.
        if (Math.abs(padAxis) > Math.abs(v)) v = padAxis;
      }
      return v;
    };

    this.axis.throttle = Math.max(analog('throttle', pad?.axes[1] ?? 0), 0);
    this.axis.throttle = this.axis.throttle === 0 ? Math.min(analog('reverse', pad?.axes[1] ?? 0), 0) : this.axis.throttle;
    this.axis.x = analog('strafeRight', pad?.axes[0] ?? 0) - analog('strafeLeft', -(pad?.axes[0] ?? 0));
    this.axis.z = analog('ascend', 0) - analog('descend', 0);
    this.axis.yaw = analog('yawRight', pad?.axes[2] ?? 0) - analog('yawLeft', -(pad?.axes[2] ?? 0));
    this.axis.pitch = analog('pitchDown', 0) - analog('pitchUp', 0);
    this.axis.roll = analog('rollRight', 0) - analog('rollLeft', 0);

    // Touch surface. The on-screen stick is an analog axis, not a button, so it
    // has to be merged here or the whole touch control scheme is dead weight.
    const touch = this.touchAxes;
    const merge = (v: number, t: number): number => (Math.abs(t) > Math.abs(v) ? t : v);
    this.axis.x = merge(this.axis.x, touch.x);
    this.axis.z = merge(this.axis.z, touch.z);
    this.axis.throttle = merge(this.axis.throttle, touch.y);

    // Commit state transitions.
    for (const [a, st] of this.states) {
      const held = (heldNow.get(a) ?? false) && this.enabled && !this.uiCapture;
      st.held = held;
      st.value = held ? 1 : 0;
      const was = this.prevHeld.get(a) ?? false;
      st.pressed = st.pressed || (held && !was);
      st.released = !held && was;
      this.prevHeld.set(a, held);
      if (st.pressed) this.onAction?.(a);
    }
  }

  private readGamepad(): Gamepad | null {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.index === this.gamepadIndex && p.connected) return p;
    }
    // Fall back to the first connected pad.
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** True while the action is held. */
  held(action: ActionName): boolean {
    return this.states.get(action)?.held ?? false;
  }

  /** True on the frame the action went down. */
  pressed(action: ActionName): boolean {
    return this.states.get(action)?.pressed ?? false;
  }

  /** True on the frame the action went up. */
  released(action: ActionName): boolean {
    return this.states.get(action)?.released ?? false;
  }

  /** Accumulated pointer movement since the last {@link consumePointer}. */
  consumePointer(): PointerDelta {
    let dx = this.accumDx;
    let dy = this.accumDy;
    if (this.touchLook) {
      dx += this.touchLook.dx;
      dy += this.touchLook.dy;
      this.touchLook = null;
    }
    this.accumDx = 0;
    this.accumDy = 0;
    return { dx, dy };
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Clear per-frame edge flags. Call at the very end of the frame. */
  endFrame(): void {
    for (const st of this.states.values()) {
      st.pressed = false;
      st.released = false;
    }
  }

  isKeyDown(code: string): boolean {
    return this.keysDown.has(code);
  }
}
