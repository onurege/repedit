// Smooth elevated isometric-style camera (RTS/tycoon feel).
// WASD pan · LEFT click = select · RIGHT drag = rotate · MIDDLE drag = pan ·
// wheel zoom · R reset.
import * as THREE from 'three';

const MIN_DIST = 18;
const MAX_DIST = 110;
const PITCH = THREE.MathUtils.degToRad(52);
const PAN_LIMIT = 85;

export class CameraRig {
  target = new THREE.Vector3(0, 0, 10);
  private curTarget = new THREE.Vector3(0, 0, 10);
  yaw = Math.PI * 0.25;
  private curYaw = Math.PI * 0.25;
  dist = 62;
  private curDist = 62;

  private keys = new Set<string>();
  private dragging = false;
  private dragButton = -1;   // 0 left (select), 1 middle (pan), 2 right (rotate)
  private dragMoved = 0;
  private lastX = 0;
  private lastY = 0;
  onSelect: ((ndcX: number, ndcY: number) => void) | null = null;

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.key.toLowerCase());
      if (e.key.toLowerCase() === 'r') this.reset();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    dom.addEventListener('mousedown', (e) => {
      // 0 = left (select), 1 = middle (pan), 2 = right (rotate)
      this.dragging = true;
      this.dragButton = e.button;
      this.dragMoved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.dragButton === 2) {
        // RIGHT drag: orbit (yaw) — horizontal; a little pitch on vertical.
        this.yaw -= dx * 0.006;
      } else if (this.dragButton === 1) {
        // MIDDLE drag: pan across the ground plane.
        const scale = this.curDist * 0.0016;
        const fwd = new THREE.Vector3(-Math.sin(this.curYaw), 0, -Math.cos(this.curYaw));
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        this.target.addScaledVector(right, -dx * scale);
        this.target.addScaledVector(fwd, dy * scale);
        this.clampTarget();
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      // LEFT click without a drag = select.
      if (e.button === 0 && this.dragButton === 0 && this.dragMoved <= 6 && this.onSelect) {
        const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
        this.onSelect(ndcX, ndcY);
      }
      this.dragButton = -1;
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = THREE.MathUtils.clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.12), MIN_DIST, MAX_DIST);
      },
      { passive: false }
    );
  }

  reset(): void {
    this.target.set(0, 0, 10);
    this.yaw = Math.PI * 0.25;
    this.dist = 62;
  }

  focusOn(pos: THREE.Vector3): void {
    this.target.copy(pos);
    this.dist = Math.min(this.dist, 40);
  }

  private clampTarget(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, -PAN_LIMIT, PAN_LIMIT);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -PAN_LIMIT, PAN_LIMIT);
  }

  update(dt: number): void {
    // WASD pan relative to camera yaw
    const speed = this.curDist * 0.75 * dt;
    const fwd = new THREE.Vector3(-Math.sin(this.curYaw), 0, -Math.cos(this.curYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (this.keys.has('w') || this.keys.has('arrowup')) this.target.addScaledVector(fwd, speed);
    if (this.keys.has('s') || this.keys.has('arrowdown')) this.target.addScaledVector(fwd, -speed);
    if (this.keys.has('a') || this.keys.has('arrowleft')) this.target.addScaledVector(right, -speed);
    if (this.keys.has('d') || this.keys.has('arrowright')) this.target.addScaledVector(right, speed);
    this.clampTarget();

    // smooth interpolation
    const k = 1 - Math.pow(0.0001, dt);
    this.curTarget.lerp(this.target, k);
    this.curYaw += (this.yaw - this.curYaw) * k;
    this.curDist += (this.dist - this.curDist) * k;

    const eye = new THREE.Vector3(
      this.curTarget.x + Math.sin(this.curYaw) * Math.cos(PITCH) * this.curDist,
      this.curTarget.y + Math.sin(PITCH) * this.curDist,
      this.curTarget.z + Math.cos(this.curYaw) * Math.cos(PITCH) * this.curDist
    );
    this.camera.position.copy(eye);
    this.camera.lookAt(this.curTarget);
  }
}
