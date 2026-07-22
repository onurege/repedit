// Builds the static city and keeps player-business meshes in sync with
// server state. Building meshes are selectable via raycasting.
import * as THREE from 'three';
import {
  CITY_EXTENT,
  ROAD_LINES,
  ROAD_SPAN,
  ROAD_HALF_WIDTH,
  LOTS,
  lotById,
  type BizPub,
} from '@district/shared';
import {
  box, mat,
  makeFarm, makeCoffeeShop, makeWholesale, makeHouse,
  makeTree, makeStreetlight, makeVacantSign,
} from './buildings.js';

export interface Selectable {
  lotId: string;
  kind: 'business' | 'wholesale' | 'vacant';
  bizId?: number;
}

export class City {
  root = new THREE.Group();
  private lotMeshes = new Map<string, THREE.Group>();
  private lotState = new Map<string, string>(); // lotId -> render key
  selectables: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {
    scene.add(this.root);
    this.buildStatic();
    // vacant lots + wholesale initial
    this.syncBusinesses([]);
  }

  private buildStatic(): void {
    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY_EXTENT * 2, CITY_EXTENT * 2),
      mat(0x8cc860)
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.root.add(ground);

    // Roads
    const roadMat = mat(0x4d4f5c);
    const lineMat = mat(0xe8e6da);
    for (const line of ROAD_LINES) {
      const h = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_SPAN * 2 + ROAD_HALF_WIDTH * 2, ROAD_HALF_WIDTH * 2),
        roadMat
      );
      h.rotation.x = -Math.PI / 2;
      h.position.set(0, 0.02, line);
      h.receiveShadow = true;
      this.root.add(h);
      const v = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, ROAD_SPAN * 2 + ROAD_HALF_WIDTH * 2),
        roadMat
      );
      v.rotation.x = -Math.PI / 2;
      v.position.set(line, 0.02, 0);
      v.receiveShadow = true;
      this.root.add(v);
      // dashed center lines
      for (let p = -ROAD_SPAN + 2; p < ROAD_SPAN; p += 5) {
        const dashH = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.28), lineMat);
        dashH.rotation.x = -Math.PI / 2;
        dashH.position.set(p, 0.03, line);
        this.root.add(dashH);
        const dashV = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 2.2), lineMat);
        dashV.rotation.x = -Math.PI / 2;
        dashV.position.set(line, 0.03, p);
        this.root.add(dashV);
      }
    }

    // NPC houses in the inner blocks (positions avoid lots)
    const housePositions: [number, number, number][] = [
      [-28, -28, 1], [-21, -30, 2], [-30, -21, 3],
      [28, 28, 4], [21, 30, 5], [30, 21, 6],
      [-28, 28, 7], [-21, 30, 8],
      [28, -28, 9], [30, -22, 10],
      [-9, -30, 11], [9, 30, 12], [-30, 9, 13], [30, -9, 14],
    ];
    for (const [x, z, seed] of housePositions) {
      const house = makeHouse(seed * 137);
      house.position.set(x, 0, z);
      house.rotation.y = (seed * 1.7) % (Math.PI * 2);
      this.root.add(house);
    }

    // Trees along roads and scattered
    const treeSpots: [number, number][] = [];
    for (let p = -ROAD_SPAN; p <= ROAD_SPAN; p += 12) {
      for (const line of ROAD_LINES) {
        treeSpots.push([p + 2, line + ROAD_HALF_WIDTH + 2.2]);
        treeSpots.push([line - ROAD_HALF_WIDTH - 2.2, p]);
      }
    }
    treeSpots.push([-50, -50], [50, 50], [-52, 40], [52, -40], [-64, 5], [64, -5], [5, -64], [-5, 64]);
    let seed = 1;
    for (const [x, z] of treeSpots) {
      // skip spots that collide with lots
      if (LOTS.some((l) => Math.abs(l.x - x) < 10 && Math.abs(l.z - z) < 8)) continue;
      // skip road surface
      if (ROAD_LINES.some((L) => Math.abs(x - L) < ROAD_HALF_WIDTH + 0.8) &&
          ROAD_LINES.some((L) => Math.abs(z - L) < ROAD_HALF_WIDTH + 0.8)) continue;
      const t = makeTree(seed++ * 971);
      t.position.set(x, 0, z);
      this.root.add(t);
    }

    // Streetlights at intersections and mid-blocks
    for (const lx of ROAD_LINES) {
      for (const lz of ROAD_LINES) {
        const lamp = makeStreetlight();
        lamp.position.set(lx + ROAD_HALF_WIDTH + 0.7, 0, lz + ROAD_HALF_WIDTH + 0.7);
        lamp.rotation.y = Math.PI * 1.25;
        this.root.add(lamp);
      }
      for (const p of [-21, 21]) {
        const lamp = makeStreetlight();
        lamp.position.set(p, 0, lx + ROAD_HALF_WIDTH + 0.7);
        lamp.rotation.y = Math.PI;
        this.root.add(lamp);
      }
    }

    // small plaza at center intersection corners
    const plaza = box(6, 0.18, 6, 0xd9d2c0, 8, 0, 8, false);
    this.root.add(plaza);
    const fountain = new THREE.Group();
    fountain.add(box(2.4, 0.5, 2.4, 0xaab4c0, 0, 0, 0));
    fountain.add(box(1.7, 0.35, 1.7, 0x7fc8de, 0, 0.5, 0, false));
    fountain.position.set(8, 0.18, 8);
    this.root.add(fountain);
  }

  lotWorldPos(lotId: string): THREE.Vector3 {
    const lot = lotById(lotId);
    return new THREE.Vector3(lot?.x ?? 0, 0, lot?.z ?? 0);
  }

  /** Rebuild lot meshes when occupancy/level/owner changes. */
  syncBusinesses(businesses: BizPub[]): void {
    const byLot = new Map(businesses.map((b) => [b.lotId, b]));
    for (const lot of LOTS) {
      const biz = byLot.get(lot.id);
      let key: string;
      if (lot.kind === 'wholesale') key = 'wholesale';
      else if (biz) key = `biz:${biz.id}:${biz.level}:${biz.ownerName}`;
      else key = 'vacant';
      if (this.lotState.get(lot.id) === key) continue;
      this.lotState.set(lot.id, key);

      const old = this.lotMeshes.get(lot.id);
      if (old) {
        this.root.remove(old);
        this.selectables = this.selectables.filter((o) => (o.userData.sel as Selectable)?.lotId !== lot.id);
      }
      let group: THREE.Group;
      let sel: Selectable;
      if (lot.kind === 'wholesale') {
        group = makeWholesale();
        sel = { lotId: lot.id, kind: 'wholesale' };
      } else if (biz) {
        group =
          biz.type === 'farm'
            ? makeFarm(biz.level, biz.ownerName)
            : makeCoffeeShop(biz.level, biz.ownerName);
        sel = { lotId: lot.id, kind: 'business', bizId: biz.id };
      } else {
        group = makeVacantSign(lot.kind);
        sel = { lotId: lot.id, kind: 'vacant' };
      }
      group.position.set(lot.x, 0, lot.z);
      group.rotation.y = lot.rotY;
      group.userData.sel = sel;
      group.traverse((o) => (o.userData.sel = sel));
      this.root.add(group);
      this.lotMeshes.set(lot.id, group);
      this.selectables.push(group);
    }
  }

  meshForLot(lotId: string): THREE.Group | undefined {
    return this.lotMeshes.get(lotId);
  }
}
