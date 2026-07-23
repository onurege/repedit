// Dynamic city life: delivery vans (server-driven), coffee customers
// (visual representation of server sales), ambient pedestrians & cars.
// Purely cosmetic — the economy never depends on these reaching anywhere.
import * as THREE from 'three';
import {
  roadPath, pointAlongPath, pathLength, nearestRoadPoint,
  ROAD_HALF_WIDTH, lotById, DISTRICTS, districtById,
  type DeliveryPub, type Vec2,
} from '@district/shared';
import { makeVan, makePerson, makeCar } from './buildings.js';

interface Van {
  id: number;
  mesh: THREE.Group;
  path: Vec2[];
  departAt: number;
  arriveAt: number;
  doneAt: number | null; // fade-out timer after arrival
}

interface Walker {
  mesh: THREE.Group;
  path: Vec2[];
  progress: number; // distance walked
  length: number;
  speed: number;
  phase: 'to' | 'dwell' | 'back';
  dwell: number;
  targetLot: string;
  onArrive?: () => void;
}

interface Ambient {
  mesh: THREE.Group;
  path: Vec2[];
  progress: number;
  length: number;
  speed: number;
  offset: number; // lane offset
}

export class Actors {
  private vans = new Map<number, Van>();
  private customers: Walker[] = [];
  private pedestrians: Ambient[] = [];
  private cars: Ambient[] = [];
  private rand = 12345;

  constructor(private scene: THREE.Scene) {
    this.spawnAmbient();
  }

  private rnd(): number {
    this.rand = (this.rand * 1103515245 + 12345) & 0x7fffffff;
    return this.rand / 0x7fffffff;
  }

  // ---------------- deliveries ----------------

  syncDeliveries(deliveries: DeliveryPub[]): void {
    const alive = new Set<number>();
    for (const d of deliveries) {
      alive.add(d.id);
      if (!this.vans.has(d.id)) this.addVan(d);
    }
    for (const [id, van] of this.vans) {
      if (!alive.has(id) && van.doneAt === null) {
        van.doneAt = performance.now() / 1000 + 1.2; // brief pause at door, then despawn
        const end = van.path[van.path.length - 1];
        van.mesh.position.set(end.x, 0, end.z);
      }
    }
  }

  private addVan(d: DeliveryPub): void {
    const from = lotById(d.fromLot);
    const to = lotById(d.toLot);
    if (!from || !to) return;
    const path = roadPath({ x: from.x, z: from.z }, { x: to.x, z: to.z });
    const mesh = makeVan(d.fromLot === 'wholesale' ? 0xdce7f0 : 0xfdf6e3);
    this.scene.add(mesh);
    this.vans.set(d.id, { id: d.id, mesh, path, departAt: d.departAt, arriveAt: d.arriveAt, doneAt: null });
  }

  deliveryArrived(id: number): void {
    const van = this.vans.get(id);
    if (van) van.doneAt = performance.now() / 1000 + 1.2;
  }

  // ---------------- customers (sale representation) ----------------

  spawnCustomer(lotId: string, onArrive: () => void): void {
    if (this.customers.length >= 18) {
      onArrive(); // pool exhausted: still show the sale feedback
      return;
    }
    const lot = lotById(lotId);
    if (!lot) return;
    const door: Vec2 = { x: lot.x, z: lot.z };
    const roadPt = nearestRoadPoint(door);
    // Start ~12 units along the road, clamped to the lot's own district so a
    // customer never walks off the end of its road network.
    const home = districtById(lot.district);
    const span = home?.roadSpan ?? 48;
    const ox = home?.origin.x ?? 0;
    const oz = home?.origin.z ?? 0;
    const clampX = (v: number) => Math.max(ox - span, Math.min(ox + span, v));
    const clampZ = (v: number) => Math.max(oz - span, Math.min(oz + span, v));
    const off = 12 * (this.rnd() > 0.5 ? 1 : -1);
    const start: Vec2 =
      Math.abs(roadPt.x - door.x) > Math.abs(roadPt.z - door.z)
        ? { x: roadPt.x, z: clampZ(roadPt.z + off) }
        : { x: clampX(roadPt.x + off), z: roadPt.z };
    const path = [start, roadPt, { x: door.x + (this.rnd() - 0.5) * 2, z: door.z + 2.5 }];
    const mesh = makePerson(Math.floor(this.rnd() * 1e6));
    mesh.position.set(start.x, 0, start.z);
    this.scene.add(mesh);
    this.customers.push({
      mesh, path, progress: 0, length: pathLength(path),
      speed: 2.6 + this.rnd() * 0.8, phase: 'to', dwell: 0.9, targetLot: lotId, onArrive,
    });
  }

  // ---------------- ambient life ----------------

  private spawnAmbient(): void {
    // pedestrians strolling between random road points
    for (let i = 0; i < 8; i++) {
      const mesh = makePerson(i * 977 + 13);
      this.scene.add(mesh);
      const ped: Ambient = {
        mesh, path: [], progress: 0, length: 0,
        speed: 1.6 + this.rnd() * 1.2, offset: ROAD_HALF_WIDTH + 0.9,
      };
      this.newAmbientPath(ped);
      this.pedestrians.push(ped);
    }
    // civilian cars
    for (let i = 0; i < 4; i++) {
      const mesh = makeCar(i * 331 + 7);
      this.scene.add(mesh);
      const car: Ambient = {
        mesh, path: [], progress: 0, length: 0,
        speed: 7 + this.rnd() * 3, offset: 1.6,
      };
      this.newAmbientPath(car);
      this.cars.push(car);
    }
  }

  /** A random point on a random district's road grid. */
  private randomRoadPoint(): Vec2 {
    const d = DISTRICTS[Math.floor(this.rnd() * DISTRICTS.length)];
    const p = -d.roadSpan + this.rnd() * d.roadSpan * 2;
    if (this.rnd() > 0.5) {
      const line = d.roadLines.vertical[Math.floor(this.rnd() * d.roadLines.vertical.length)];
      return { x: d.origin.x + line, z: d.origin.z + p };
    }
    const line = d.roadLines.horizontal[Math.floor(this.rnd() * d.roadLines.horizontal.length)];
    return { x: d.origin.x + p, z: d.origin.z + line };
  }

  private newAmbientPath(a: Ambient): void {
    const from = a.path.length ? a.path[a.path.length - 1] : this.randomRoadPoint();
    let to = this.randomRoadPoint();
    let guard = 0;
    while (Math.hypot(to.x - from.x, to.z - from.z) < 25 && guard++ < 8) to = this.randomRoadPoint();
    a.path = roadPath(from, to);
    a.length = pathLength(a.path);
    a.progress = 0;
  }

  // ---------------- frame update ----------------

  update(dt: number, nowMs: number): void {
    const nowS = performance.now() / 1000;
    // vans
    for (const [id, van] of [...this.vans]) {
      if (van.doneAt !== null) {
        if (nowS > van.doneAt) {
          this.scene.remove(van.mesh);
          this.vans.delete(id);
        }
        continue;
      }
      const t = (nowMs - van.departAt) / Math.max(1, van.arriveAt - van.departAt);
      const { p, angle } = pointAlongPath(van.path, Math.min(1, t));
      van.mesh.position.set(p.x, 0, p.z);
      van.mesh.rotation.y = angle;
    }
    // customers
    for (let i = this.customers.length - 1; i >= 0; i--) {
      const c = this.customers[i];
      if (c.phase === 'dwell') {
        c.dwell -= dt;
        if (c.dwell <= 0) {
          c.phase = 'back';
          c.path = [...c.path].reverse();
          c.progress = 0;
        }
        continue;
      }
      c.progress += c.speed * dt;
      const t = Math.min(1, c.progress / Math.max(0.01, c.length));
      const { p, angle } = pointAlongPath(c.path, t);
      c.mesh.position.set(p.x, 0, p.z);
      c.mesh.rotation.y = angle;
      c.mesh.position.y = Math.abs(Math.sin(c.progress * 6)) * 0.08; // walk bob
      if (t >= 1) {
        if (c.phase === 'to') {
          c.phase = 'dwell';
          c.onArrive?.();
          c.onArrive = undefined;
        } else {
          this.scene.remove(c.mesh);
          this.customers.splice(i, 1);
        }
      }
    }
    // ambient walkers & cars
    for (const group of [this.pedestrians, this.cars]) {
      for (const a of group) {
        a.progress += a.speed * dt;
        const t = a.progress / Math.max(0.01, a.length);
        if (t >= 1) {
          this.newAmbientPath(a);
          continue;
        }
        const { p, angle } = pointAlongPath(a.path, t);
        // offset to the side of the road (right-hand side of travel)
        const ox = Math.cos(angle) * a.offset;
        const oz = -Math.sin(angle) * a.offset;
        a.mesh.position.set(p.x + ox, 0, p.z + oz);
        a.mesh.rotation.y = angle;
        if (group === this.pedestrians) {
          a.mesh.position.y = Math.abs(Math.sin(a.progress * 5)) * 0.07;
        }
      }
    }
  }
}
