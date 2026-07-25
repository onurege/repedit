// Smooth elevated isometric-style camera (RTS/tycoon feel).
// WASD pan · LEFT click = select · RIGHT drag = rotate · MIDDLE drag = pan ·
// wheel zoom · R reset.
import * as THREE from 'three';
import { CITY_BOUNDS, districtById, type DistrictId } from '@district/shared';

const MIN_DIST = 18;
const MAX_DIST = 150;
const PITCH = THREE.MathUtils.degToRad(52);
// Panning is bounded by the union of every district plus a margin, so the
// player can reach the whole city but never drift into empty space.
const PAN_MARGIN = 26;
const PAN = {
  minX: CITY_BOUNDS.minX - PAN_MARGIN,
  maxX: CITY_BOUNDS.maxX + PAN_MARGIN,
  minZ: CITY_BOUNDS.minZ - PAN_MARGIN,
  maxZ: CITY_BOUNDS.maxZ + PAN_MARGIN,
};

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

  // --- Touch (mobile) gesture state: one-finger pan, tap-to-select, pinch
  // zoom, two-finger rotate. These are an ADAPTER over the same target/yaw/dist
  // the desktop mouse path drives — no separate mobile camera. ---
  private touchMode: 'none' | 'pan' | 'gesture' = 'none';
  private tLastX = 0;
  private tLastY = 0;
  private tMoved = 0;         // accumulated finger travel this sequence (tap vs drag)
  private tGestured = false;  // a multitouch gesture happened -> suppress tap-select
  private pinchDist = 0;      // last two-finger distance (px)
  private pinchMidX = 0;      // last two-finger midpoint (px)
  private static readonly TAP_THRESHOLD = 12; // px of travel below which a touch is a tap

  constructor(private camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    // Capture game gestures on the canvas only (never the whole page), so UI
    // panels keep native scrolling and the page never scroll/zoom-bounces.
    dom.style.touchAction = 'none';
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

    // ---- Touch adapter ----
    dom.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    dom.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    dom.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    dom.addEventListener('touchcancel', () => this.onTouchCancel(), { passive: false });
  }

  private setPinchBaseline(e: TouchEvent): void {
    const a = e.touches[0], b = e.touches[1];
    this.pinchDist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    this.pinchMidX = (a.clientX + b.clientX) / 2;
  }

  private onTouchStart(e: TouchEvent): void {
    e.preventDefault(); // also suppresses synthesized mouse events on touch
    if (e.touches.length === 1) {
      // New single-finger sequence (or a finger lifted back to one).
      if (this.touchMode === 'none') { this.tMoved = 0; this.tGestured = false; }
      this.touchMode = 'pan';
      this.tLastX = e.touches[0].clientX;
      this.tLastY = e.touches[0].clientY;
    } else if (e.touches.length >= 2) {
      // Second finger down -> pinch/rotate. Baseline set now = no camera jump.
      this.touchMode = 'gesture';
      this.tGestured = true;
      this.setPinchBaseline(e);
    }
  }

  private onTouchMove(e: TouchEvent): void {
    e.preventDefault();
    if (this.touchMode === 'pan' && e.touches.length === 1) {
      const t = e.touches[0];
      const dx = t.clientX - this.tLastX;
      const dy = t.clientY - this.tLastY;
      this.tMoved += Math.abs(dx) + Math.abs(dy);
      this.tLastX = t.clientX;
      this.tLastY = t.clientY;
      // One-finger drag pans across the ground plane (same math as middle-drag).
      const scale = this.curDist * 0.0016;
      const fwd = new THREE.Vector3(-Math.sin(this.curYaw), 0, -Math.cos(this.curYaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      this.target.addScaledVector(right, -dx * scale);
      this.target.addScaledVector(fwd, dy * scale);
      this.clampTarget();
    } else if (this.touchMode === 'gesture' && e.touches.length >= 2) {
      const a = e.touches[0], b = e.touches[1];
      const nd = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
      const mx = (a.clientX + b.clientX) / 2;
      if (this.pinchDist > 0) {
        // Fingers apart (nd grows) -> zoom IN (dist shrinks); together -> out.
        this.dist = THREE.MathUtils.clamp(this.dist * (this.pinchDist / Math.max(1, nd)), MIN_DIST, MAX_DIST);
        // Midpoint sliding horizontally rotates the city (yaw), like a map twist.
        this.yaw -= (mx - this.pinchMidX) * 0.006;
      }
      this.pinchDist = nd;
      this.pinchMidX = mx;
    }
  }

  private onTouchEnd(e: TouchEvent): void {
    e.preventDefault();
    if (e.touches.length === 0) {
      // Whole sequence ended: a short, single-finger, gesture-free touch = tap.
      if (this.touchMode === 'pan' && !this.tGestured && this.tMoved <= CameraRig.TAP_THRESHOLD && this.onSelect) {
        const t = e.changedTouches[0];
        const ndcX = (t.clientX / window.innerWidth) * 2 - 1;
        const ndcY = -(t.clientY / window.innerHeight) * 2 + 1;
        this.onSelect(ndcX, ndcY);
      }
      this.touchMode = 'none';
      this.pinchDist = 0;
    } else if (e.touches.length === 1) {
      // Two fingers -> one: re-baseline pan on the remaining finger (no jump),
      // and keep tGestured so lifting it never triggers a stray selection.
      this.touchMode = 'pan';
      this.tLastX = e.touches[0].clientX;
      this.tLastY = e.touches[0].clientY;
      this.pinchDist = 0;
    }
  }

  private onTouchCancel(): void {
    // Clear all gesture state — never leave the camera stuck moving.
    this.touchMode = 'none';
    this.pinchDist = 0;
    this.tGestured = false;
    this.tMoved = CameraRig.TAP_THRESHOLD + 1; // any pending touch won't count as a tap
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

  /** Move the camera to a district's centre, framing the whole district. */
  focusDistrict(id: DistrictId): void {
    const d = districtById(id);
    if (!d) return;
    this.target.set(d.origin.x, 0, d.origin.z);
    this.dist = Math.min(MAX_DIST, Math.max(MIN_DIST, d.groundHalf * 1.15));
  }

  private clampTarget(): void {
    this.target.x = THREE.MathUtils.clamp(this.target.x, PAN.minX, PAN.maxX);
    this.target.z = THREE.MathUtils.clamp(this.target.z, PAN.minZ, PAN.maxZ);
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
