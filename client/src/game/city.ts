// Builds the static city and keeps player-business meshes in sync with
// server state. Building meshes are selectable via raycasting.
import * as THREE from 'three';
import { getLang } from '../i18n.js';
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
  makeFarm, makeCoffeeShop, makeBakery, makeMiniMarket, makeWholesale, makeHouse,
  makeTree, makeStreetlight, makeVacantSign,
} from './buildings.js';

export interface Selectable {
  lotId: string;
  kind: 'business' | 'wholesale' | 'vacant';
  bizId?: number;
}

const _tmpVec = new THREE.Vector3();

export class City {
  root = new THREE.Group();
  private lotMeshes = new Map<string, THREE.Group>();
  private lotState = new Map<string, string>(); // lotId -> render key
  private labels: THREE.Sprite[] = [];
  private selectionRing: THREE.Mesh;
  private selectedLot: string | null = null;
  selectables: THREE.Object3D[] = [];

  constructor(private scene: THREE.Scene) {
    scene.add(this.root);
    this.buildStatic();

    // Reusable ground ring that highlights the currently selected/focused lot.
    const ringGeo = new THREE.RingGeometry(6.2, 7.0, 40);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd166,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.rotation.x = -Math.PI / 2;
    this.selectionRing.position.y = 0.08;
    this.selectionRing.visible = false;
    this.selectionRing.renderOrder = 5;
    this.root.add(this.selectionRing);

    // vacant lots + wholesale initial
    this.syncBusinesses([]);
  }

  highlightLot(lotId: string | null): void {
    this.selectedLot = lotId;
    if (lotId) {
      const p = this.lotWorldPos(lotId);
      this.selectionRing.position.set(p.x, 0.08, p.z);
      this.selectionRing.visible = true;
    } else {
      this.selectionRing.visible = false;
    }
  }

  /** Per-frame: pulse the selection ring and fade/scale labels by distance. */
  update(dt: number, cameraPos: THREE.Vector3): void {
    if (this.selectionRing.visible) {
      const t = performance.now() / 1000;
      const mat = this.selectionRing.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 + 0.35 * Math.sin(t * 3.5);
      const s = 1 + 0.04 * Math.sin(t * 3.5);
      this.selectionRing.scale.set(s, s, s);
    }
    // Distance-based label presentation: readable up close, gently fading
    // and shrinking with distance so a zoomed-out city stays clean.
    for (const spr of this.labels) {
      const base = spr.userData.bdLabel as { baseX: number; baseY: number };
      const d = spr.getWorldPosition(_tmpVec).distanceTo(cameraPos);
      const m = spr.material as THREE.SpriteMaterial;
      let opacity: number;
      if (d < 55) opacity = 1;
      else if (d > 140) opacity = 0;
      else opacity = 1 - (d - 55) / 85;
      m.opacity = opacity;
      spr.visible = opacity > 0.02;
      // grow slightly with distance so labels don't shrink to nothing
      const scale = 1 + Math.min(0.5, Math.max(0, (d - 45) / 120));
      spr.scale.set(base.baseX * scale, base.baseY * scale, 1);
    }
  }

  private buildStatic(): void {
    // Large ground plane — extends far past the city so its edge is lost in
    // fog rather than reading as an "end of the world" line.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), mat(0x84c25b));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.root.add(ground);

    // A slightly brighter turf pad under the built-up area gives the district
    // a defined footprint against the surrounding countryside.
    const turf = new THREE.Mesh(
      new THREE.PlaneGeometry(CITY_EXTENT * 2 + 20, CITY_EXTENT * 2 + 20),
      mat(0x8fca63)
    );
    turf.rotation.x = -Math.PI / 2;
    turf.receiveShadow = true;
    this.root.add(turf);

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
    // (several former house spots now host bakery / mini market lots)
    // Houses fill the empty outer-diagonal gaps and never sit in front of a
    // business lot (which would hide the building the player came to see).
    const housePositions: [number, number, number][] = [
      [-42, -42, 2], [-42, 42, 3], [42, 42, 5], [42, -42, 6],
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
    // Countryside tree belts rings the district and dissolves into the fog,
    // so the surrounding land reads as forest rather than empty plane.
    for (let ring = 90; ring <= 140; ring += 16) {
      const count = Math.floor(ring / 7);
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + ring * 0.13;
        const jitter = ((i * 53) % 17) - 8;
        treeSpots.push([Math.cos(a) * (ring + jitter), Math.sin(a) * (ring + jitter)]);
      }
    }
    let seed = 1;
    for (const [x, z] of treeSpots) {
      // skip spots that collide with lots
      if (LOTS.some((l) => Math.abs(l.x - x) < 10 && Math.abs(l.z - z) < 8)) continue;
      // skip road surface
      if (ROAD_LINES.some((L) => Math.abs(x - L) < ROAD_HALF_WIDTH + 0.8) &&
          ROAD_LINES.some((L) => Math.abs(z - L) < ROAD_HALF_WIDTH + 0.8)) continue;
      const t = makeTree(seed++ * 971);
      t.position.set(x, 0, z);
      if (Math.hypot(x, z) > 85) t.scale.multiplyScalar(1.2 + (seed % 5) * 0.15); // bigger, varied countryside trees
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
      // Language is part of the key: sign sprites bake text into a texture,
      // so switching language must invalidate them.
      const lang = getLang();
      if (lot.kind === 'wholesale') key = `wholesale:${lang}`;
      else if (biz) key = `biz:${biz.id}:${biz.level}:${biz.ownerName}:${lang}`;
      else key = `vacant:${lang}`;
      if (this.lotState.get(lot.id) === key) continue;
      this.lotState.set(lot.id, key);

      const old = this.lotMeshes.get(lot.id);
      if (old) {
        this.root.remove(old);
        this.selectables = this.selectables.filter((o) => (o.userData.sel as Selectable)?.lotId !== lot.id);
        old.traverse((o) => {
          if ((o as THREE.Sprite).userData?.bdLabel) {
            this.labels = this.labels.filter((l) => l !== o);
          }
        });
      }
      let group: THREE.Group;
      let sel: Selectable;
      if (lot.kind === 'wholesale') {
        group = makeWholesale();
        sel = { lotId: lot.id, kind: 'wholesale' };
      } else if (biz) {
        const builders: Record<string, (lv: number, name: string) => THREE.Group> = {
          farm: makeFarm,
          coffee_shop: makeCoffeeShop,
          bakery: makeBakery,
          mini_market: makeMiniMarket,
        };
        group = (builders[biz.type] ?? makeFarm)(biz.level, biz.ownerName);
        sel = { lotId: lot.id, kind: 'business', bizId: biz.id };
      } else {
        group = makeVacantSign(lot.kind);
        sel = { lotId: lot.id, kind: 'vacant' };
      }
      group.position.set(lot.x, 0, lot.z);
      group.rotation.y = lot.rotY;
      group.userData.sel = sel;
      group.traverse((o) => {
        o.userData.sel = sel;
        if ((o as THREE.Sprite).userData?.bdLabel) this.labels.push(o as THREE.Sprite);
      });
      this.root.add(group);
      this.lotMeshes.set(lot.id, group);
      this.selectables.push(group);
    }
  }

  meshForLot(lotId: string): THREE.Group | undefined {
    return this.lotMeshes.get(lotId);
  }
}
