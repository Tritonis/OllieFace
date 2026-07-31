// Pointer-locked FPS-style input. Exposes a stable per-frame snapshot so
// systems never touch raw DOM events.

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered, cleared each frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftEdge: false, rightEdge: false };
    this.locked = false;
    this.enabled = true;

    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) { canvas.requestPointerLock(); return; }
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftEdge = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightEdge = true; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
    });
  }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  // Movement intent in local space: x = strafe, z = forward.
  moveAxis() {
    const x = (this.down('KeyD') ? 1 : 0) - (this.down('KeyA') ? 1 : 0);
    const z = (this.down('KeyW') ? 1 : 0) - (this.down('KeyS') ? 1 : 0);
    const len = Math.hypot(x, z);
    return len > 1 ? { x: x / len, z: z / len } : { x, z };
  }

  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.leftEdge = false;
    this.mouse.rightEdge = false;
  }
}
