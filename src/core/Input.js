/**
 * Pointer-lock keyboard/mouse input. Accumulates raw mouse deltas per frame so
 * look sampling is framerate-independent, and exposes edge-triggered actions.
 */
const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  nextWeapon: ['KeyQ'],
  frag: ['KeyG'],
  flash: ['KeyH'],
  lean_left: ['KeyE'],
  inspect: ['KeyI'],
  flashlight: ['KeyL'],
};

export class Input {
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;
    this.bindings = { ...DEFAULT_BINDINGS };
    this.down = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.mouse = { dx: 0, dy: 0, wheel: 0, left: false, right: false };
    this.mousePressed = { left: false, right: false };
    this.locked = false;
    this.sensitivity = 0.0022;
    this.adsSensScale = 0.65;
    this.invertY = false;
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (e.repeat) return;
      if (!this.down.has(e.code)) this.pressedThisFrame.add(e.code);
      this.down.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    const ku = (e) => {
      this.down.delete(e.code);
      this.releasedThisFrame.add(e.code);
    };
    window.addEventListener('keydown', kd, { passive: false });
    window.addEventListener('keyup', ku);

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.mousePressed.left = true; }
      if (e.button === 2) this.mouse.right = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });
    window.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.bus.emit('input:lock', this.locked);
      if (!this.locked) { this.down.clear(); this.mouse.left = false; this.mouse.right = false; }
    });
  }

  requestLock() {
    if (!this.locked) this.canvas.requestPointerLock?.();
  }

  action(name) {
    const codes = this.bindings[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = this.bindings[name];
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  /** Consume per-frame accumulators. Call once at the end of each frame. */
  endFrame() {
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.mousePressed.left = false;
    this.mousePressed.right = false;
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }
}
