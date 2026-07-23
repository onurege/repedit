// Builds the static city and keeps player-business meshes in sync with
// server state. Building meshes are selectable via raycasting.
import * as THREE from 'three';
import { getLang } from '../i18n.js';
import {
  ROAD_HALF_WIDTH,
  LOTS,
  lotById,
  DISTRICTS,
  CONNECTORS,
  CITY_BOUNDS,
  districtById,
  type BizPub,
  type DistrictDef,
  type DistrictId,
} from '@district/shared';
import { t } from '../i18n.js';
import {
  box, mat,
  makeFarm, makeCoffeeShop, makeBakery, makeMiniMarket, makeWholesale, makeHouse,
  makeTree, makeStreetlight, makeVacantSign, makeDistrictSign,
} from './buildings.js';

/** Per-district visual identity. Adding a district adds one entry here. */
interface DistrictTheme {
  turf: number;
  treeDensity: number;   // multiplier on the roadside tree pass
  houses: boolean;       // dense NPC housing (only the old centre has it)
  accent: number;        // district sign header colour
  subKey: string;        // i18n key for the sign's second line
}

const THEMES: Record<DistrictId, DistrictTheme> = {
  old_town: { turf: 0x8fca63, treeDensity: 1, houses: true, accent: 0xe4572e, subKey: 'district.old_town.sign' },
  // The expansion reads as newer and greener: brighter turf, more trees,
  // no dense housing yet — it is still being developed.
  green_valley: { turf: 0x9ad86a, treeDensity: 1.8, houses: false, accent: 0x2f9e5f, subKey: 'district.green_valley.sign' },
};

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
  private districtSigns: THREE.Group[] = [];
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
    // One ground plane covers every district plus the land between them, so
    // the connector road never crosses a visible seam and the outer edge is
    // lost in fog rather than reading as an "end of the world" line.
    const spanX = CITY_BOUNDS.maxX - CITY_BOUNDS.minX;
    const spanZ = CITY_BOUNDS.maxZ - CITY_BOUNDS.minZ;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(spanX + 620, spanZ + 620),
      mat(0x84c25b)
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((CITY_BOUNDS.minX + CITY_BOUNDS.maxX) / 2, -0.02, 0);
    ground.receiveShadow = true;
    this.root.add(ground);

    // Shared materials/geometries: a second district must not double the
    // number of distinct GPU resources.
    const roadMat = mat(0x4d4f5c);
    const lineMat = mat(0xe8e6da);
    const dashH = new THREE.PlaneGeometry(2.2, 0.28);
    const dashV = new THREE.PlaneGeometry(0.28, 2.2);

    for (const d of DISTRICTS) this.buildDistrict(d, roadMat, lineMat, dashH, dashV);
    this.buildConnectors(roadMat, lineMat, dashH);
  }

  /** Build one district's turf, roads, decoration and entrance sign. */
  private buildDistrict(
    d: DistrictDef,
    roadMat: THREE.Material,
    lineMat: THREE.Material,
    dashH: THREE.BufferGeometry,
    dashV: THREE.BufferGeometry
  ): void {
    const theme = THEMES[d.id];
    const { x: ox, z: oz } = d.origin;

    // Turf pad gives the district a defined footprint and its own colour.
    const turf = new THREE.Mesh(
      new THREE.PlaneGeometry(d.groundHalf * 2 + 20, d.groundHalf * 2 + 20),
      mat(theme.turf)
    );
    turf.rotation.x = -Math.PI / 2;
    turf.position.set(ox, 0, oz);
    turf.receiveShadow = true;
    this.root.add(turf);

    // Roads
    const span = d.roadSpan;
    for (const line of d.roadLines.horizontal) {
      const h = new THREE.Mesh(
        new THREE.PlaneGeometry(span * 2 + ROAD_HALF_WIDTH * 2, ROAD_HALF_WIDTH * 2),
        roadMat
      );
      h.rotation.x = -Math.PI / 2;
      h.position.set(ox, 0.02, oz + line);
      h.receiveShadow = true;
      this.root.add(h);
      for (let q = -span + 2; q < span; q += 5) {
        const dash = new THREE.Mesh(dashH, lineMat);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(ox + q, 0.03, oz + line);
        this.root.add(dash);
      }
    }
    for (const line of d.roadLines.vertical) {
      const v = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, span * 2 + ROAD_HALF_WIDTH * 2),
        roadMat
      );
      v.rotation.x = -Math.PI / 2;
      v.position.set(ox + line, 0.02, oz);
      v.receiveShadow = true;
      this.root.add(v);
      for (let q = -span + 2; q < span; q += 5) {
        const dash = new THREE.Mesh(dashV, lineMat);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(ox + line, 0.03, oz + q);
        this.root.add(dash);
      }
    }

    // NPC housing: only the established centre is densely built up.
    if (theme.houses) {
      const housePositions: [number, number, number][] = [
        [-42, -42, 2], [-42, 42, 3], [42, 42, 5], [42, -42, 6],
        [-9, -30, 11], [9, 30, 12], [-30, 9, 13], [30, -9, 14],
      ];
      for (const [x, z, seed] of housePositions) {
        const house = makeHouse(seed * 137);
        house.position.set(ox + x, 0, oz + z);
        house.rotation.y = (seed * 1.7) % (Math.PI * 2);
        this.root.add(house);
      }
    }

    // Trees: roadside rows, plus a denser scatter in the greener district.
    const treeSpots: [number, number][] = [];
    const step = Math.max(7, Math.round(12 / theme.treeDensity));
    for (let q = -span; q <= span; q += step) {
      for (const line of d.roadLines.horizontal) treeSpots.push([q + 2, line + ROAD_HALF_WIDTH + 2.2]);
      for (const line of d.roadLines.vertical) treeSpots.push([line - ROAD_HALF_WIDTH - 2.2, q]);
    }
    const edge = d.groundHalf - 12;
    treeSpots.push(
      [-edge, -edge], [edge, edge], [-edge, edge * 0.7], [edge, -edge * 0.7],
      [-edge * 0.8, 5], [edge * 0.8, -5], [5, -edge * 0.8], [-5, edge * 0.8]
    );

    // Keep decoration clear of the district sign so the name stays readable.
    const signSpot = this.districtSignSpot(d);

    let seed = d.unlockOrder * 1000 + 1;
    const onRoad = (x: number, z: number) =>
      d.roadLines.vertical.some((L) => Math.abs(x - L) < ROAD_HALF_WIDTH + 0.8) &&
      d.roadLines.horizontal.some((L) => Math.abs(z - L) < ROAD_HALF_WIDTH + 0.8);
    for (const [x, z] of treeSpots) {
      const wx = ox + x;
      const wz = oz + z;
      if (LOTS.some((l) => Math.abs(l.x - wx) < 10 && Math.abs(l.z - wz) < 8)) continue;
      if (Math.abs(wx - signSpot.x) < 11 && Math.abs(wz - signSpot.z) < 11) continue;
      if (onRoad(x, z)) continue;
      const tree = makeTree(seed++ * 971);
      tree.position.set(wx, 0, wz);
      this.root.add(tree);
    }

    // Streetlights at intersections.
    for (const lx of d.roadLines.vertical) {
      for (const lz of d.roadLines.horizontal) {
        const lamp = makeStreetlight();
        lamp.position.set(ox + lx + ROAD_HALF_WIDTH + 0.7, 0, oz + lz + ROAD_HALF_WIDTH + 0.7);
        lamp.rotation.y = Math.PI * 1.25;
        this.root.add(lamp);
      }
    }

    // Old Town keeps its plaza + fountain; the expansion has open green space.
    if (d.id === 'old_town') {
      this.root.add(box(6, 0.18, 6, 0xd9d2c0, ox + 8, 0, oz + 8, false));
      const fountain = new THREE.Group();
      fountain.add(box(2.4, 0.5, 2.4, 0xaab4c0, 0, 0, 0));
      fountain.add(box(1.7, 0.35, 1.7, 0x7fc8de, 0, 0.5, 0, false));
      fountain.position.set(ox + 8, 0.18, oz + 8);
      this.root.add(fountain);
    } else {
      // A village green: open lawn with a loose cluster of trees.
      const green = new THREE.Mesh(new THREE.CircleGeometry(13, 24), mat(0xa7e07a));
      green.rotation.x = -Math.PI / 2;
      green.position.set(ox + 26, 0.015, oz + 26);
      this.root.add(green);
      for (let i = 0; i < 5; i++) {
        const tree = makeTree(9000 + i * 733);
        const a = (i / 5) * Math.PI * 2;
        tree.position.set(ox + 26 + Math.cos(a) * 7, 0, oz + 26 + Math.sin(a) * 7);
        this.root.add(tree);
      }
    }

    // Entrance sign, placed on the district's inward-facing edge so it is
    // read while driving in along the connector.
    this.addDistrictSign(d, theme);
  }

  /** Where a district's entrance monument stands, in world coords. */
  private districtSignSpot(d: DistrictDef): { x: number; z: number } {
    const towardConnector = d.id === 'old_town' ? 1 : -1;
    return { x: d.origin.x + towardConnector * (d.roadSpan - 5), z: d.origin.z + 8.5 };
  }

  private addDistrictSign(d: DistrictDef, theme: DistrictTheme): void {
    const sign = makeDistrictSign(t(d.nameKey), t(theme.subKey), theme.accent);
    // Old Town's marker sits at its eastern gateway, Green Valley's at its
    // western one — both alongside the road that joins them. The board is
    // left unrotated: its name plate is a camera-facing sprite, so a rotated
    // board would read edge-on while the text stayed flat.
    const spot = this.districtSignSpot(d);
    sign.position.set(spot.x, 0, spot.z);
    sign.userData.bdDistrictSign = d.id;
    this.districtSigns.push(sign);
    this.root.add(sign);
  }

  /** The inter-district highway that makes cross-district deliveries drive. */
  private buildConnectors(
    roadMat: THREE.Material,
    lineMat: THREE.Material,
    dashH: THREE.BufferGeometry
  ): void {
    for (const c of CONNECTORS) {
      const len = Math.hypot(c.x2 - c.x1, c.z2 - c.z1);
      const horizontal = Math.abs(c.z1 - c.z2) < 1e-6;
      const road = new THREE.Mesh(
        horizontal
          ? new THREE.PlaneGeometry(len, ROAD_HALF_WIDTH * 2)
          : new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, len),
        roadMat
      );
      road.rotation.x = -Math.PI / 2;
      road.position.set((c.x1 + c.x2) / 2, 0.02, (c.z1 + c.z2) / 2);
      road.receiveShadow = true;
      this.root.add(road);
      if (horizontal) {
        for (let x = Math.min(c.x1, c.x2) + 3; x < Math.max(c.x1, c.x2); x += 5) {
          const dash = new THREE.Mesh(dashH, lineMat);
          dash.rotation.x = -Math.PI / 2;
          dash.position.set(x, 0.03, c.z1);
          this.root.add(dash);
        }
        // Tree belt hugging the highway so the drive between districts is
        // not an empty plain.
        const signSpots = DISTRICTS.map((d) => this.districtSignSpot(d));
        for (let x = Math.min(c.x1, c.x2) + 8; x < Math.max(c.x1, c.x2); x += 11) {
          for (const side of [-1, 1]) {
            const tz = c.z1 + side * (ROAD_HALF_WIDTH + 5);
            // Never plant on top of a district entrance monument.
            if (signSpots.some((sp) => Math.abs(sp.x - x) < 12 && Math.abs(sp.z - tz) < 12)) continue;
            const tree = makeTree(x * 31 + side * 7);
            tree.position.set(x, 0, tz);
            this.root.add(tree);
          }
        }
      }
    }
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
