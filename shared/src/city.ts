// ============================================================
// The shared city map: districts, road graph, lots, and pathfinding.
// Both the client (visuals) and server (delivery timing) use the exact
// same data and path routine.
//
// ---- Adding a district (see DECISIONS.md) ----
// 1. Append a DistrictDef to DISTRICTS with a unique `id`, a world
//    `origin`, its local road segments and its local lots.
// 2. Add a CONNECTORS entry joining it to an existing district so the
//    road graph stays one connected component.
// 3. Add `district.<id>.name` to the client i18n dictionaries and a
//    visual theme branch in client/src/game/city.ts.
// Nothing else needs to change: lots, pathfinding, camera bounds and
// occupancy are all derived from these definitions.
// ============================================================

export interface Vec2 {
  x: number;
  z: number;
}

export const ROAD_HALF_WIDTH = 3.2; // road half width, uniform city-wide

export type LotKind = 'farm' | 'coffee_shop' | 'bakery' | 'mini_market' | 'wholesale';

/** A road piece. Always axis-aligned: either x1===x2 or z1===z2. */
export interface RoadSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

/** A lot as authored inside a district definition (district-local coords). */
interface LocalLotDef {
  id: string;
  kind: LotKind;
  x: number;
  z: number;
  rotY: number; // radians, building faces its road
}

/** A lot in world coordinates, tagged with the district that owns it. */
export interface LotDef extends LocalLotDef {
  district: DistrictId;
}

export type DistrictId = 'old_town' | 'green_valley';

export interface DistrictDef {
  id: DistrictId;
  /** i18n key for the player-facing name. */
  nameKey: string;
  /** Display/unlock ordering; District 1 is the original city. */
  unlockOrder: number;
  /** Where this district's local origin sits in world space. */
  origin: Vec2;
  /** Ground half-size in local coords (square). */
  groundHalf: number;
  /** Visual theme key consumed by the client renderer. */
  theme: 'old_town' | 'green_valley';
  /** Road centrelines in local coords; used for decoration placement. */
  roadLines: { vertical: number[]; horizontal: number[] };
  /** How far roads run from the local origin along each axis. */
  roadSpan: number;
  /** Lots in local coords. */
  lots: LocalLotDef[];
}

// ---------------- District definitions ----------------

// District 1 — the original city. Coordinates are unchanged from before
// districts existed, so every pre-existing business keeps its exact
// position and lot id, and therefore lands in Old Town for free.
const OLD_TOWN: DistrictDef = {
  id: 'old_town',
  nameKey: 'district.old_town.name',
  unlockOrder: 1,
  origin: { x: 0, z: 0 },
  groundHalf: 78,
  theme: 'old_town',
  roadLines: { vertical: [-42, 0, 42], horizontal: [-42, 0, 42] },
  roadSpan: 48,
  lots: [
    // Farms (outskirts)
    { id: 'farm_1', kind: 'farm', x: -21, z: -58, rotY: 0 },
    { id: 'farm_2', kind: 'farm', x: 21, z: -58, rotY: 0 },
    { id: 'farm_3', kind: 'farm', x: -21, z: 58, rotY: Math.PI },
    { id: 'farm_4', kind: 'farm', x: 21, z: 58, rotY: Math.PI },
    { id: 'farm_5', kind: 'farm', x: -58, z: -21, rotY: Math.PI / 2 },
    { id: 'farm_6', kind: 'farm', x: 58, z: 21, rotY: -Math.PI / 2 },
    // Coffee shops (downtown blocks)
    { id: 'cafe_1', kind: 'coffee_shop', x: -14, z: -14, rotY: Math.PI / 2 },
    { id: 'cafe_2', kind: 'coffee_shop', x: 14, z: 14, rotY: -Math.PI / 2 },
    { id: 'cafe_3', kind: 'coffee_shop', x: -14, z: 14, rotY: Math.PI / 2 },
    { id: 'cafe_4', kind: 'coffee_shop', x: 14, z: -30, rotY: -Math.PI / 2 },
    { id: 'cafe_5', kind: 'coffee_shop', x: -30, z: -14, rotY: 0 },
    { id: 'cafe_6', kind: 'coffee_shop', x: 30, z: 14, rotY: Math.PI },
    // Bakeries (block corners)
    { id: 'bakery_1', kind: 'bakery', x: -28, z: -28, rotY: Math.PI / 2 },
    { id: 'bakery_2', kind: 'bakery', x: 28, z: 28, rotY: -Math.PI / 2 },
    { id: 'bakery_3', kind: 'bakery', x: 30, z: -22, rotY: -Math.PI / 2 },
    // Mini markets
    { id: 'market_1', kind: 'mini_market', x: -28, z: 28, rotY: Math.PI / 2 },
    { id: 'market_2', kind: 'mini_market', x: 28, z: -28, rotY: -Math.PI / 2 },
    { id: 'market_3', kind: 'mini_market', x: -21, z: 30, rotY: 0 },
    // NPC wholesale depot (city-wide, lives in the original centre)
    { id: 'wholesale', kind: 'wholesale', x: 16, z: -14, rotY: Math.PI },
  ],
};

// District 2 — the first expansion. Deliberately more open than Old
// Town: wider road spacing (52 vs 42), bigger blocks, farms pushed to a
// generous outer ring. 24 lots, evenly split so no business type
// becomes the new bottleneck.
const GREEN_VALLEY: DistrictDef = {
  id: 'green_valley',
  nameKey: 'district.green_valley.name',
  unlockOrder: 2,
  origin: { x: 190, z: 0 },
  groundHalf: 88,
  theme: 'green_valley',
  roadLines: { vertical: [-52, 0, 52], horizontal: [-52, 0, 52] },
  roadSpan: 72,
  lots: [
    // Farms — the valley's outer ring, well spaced
    { id: 'gv_farm_1', kind: 'farm', x: -30, z: -72, rotY: 0 },
    { id: 'gv_farm_2', kind: 'farm', x: 30, z: -72, rotY: 0 },
    { id: 'gv_farm_3', kind: 'farm', x: -30, z: 72, rotY: Math.PI },
    { id: 'gv_farm_4', kind: 'farm', x: 30, z: 72, rotY: Math.PI },
    { id: 'gv_farm_5', kind: 'farm', x: -72, z: -30, rotY: Math.PI / 2 },
    { id: 'gv_farm_6', kind: 'farm', x: 72, z: 30, rotY: -Math.PI / 2 },
    // Coffee shops
    { id: 'gv_cafe_1', kind: 'coffee_shop', x: -18, z: -18, rotY: Math.PI / 2 },
    { id: 'gv_cafe_2', kind: 'coffee_shop', x: 18, z: -18, rotY: -Math.PI / 2 },
    { id: 'gv_cafe_3', kind: 'coffee_shop', x: -18, z: 18, rotY: Math.PI / 2 },
    { id: 'gv_cafe_4', kind: 'coffee_shop', x: 18, z: 18, rotY: -Math.PI / 2 },
    { id: 'gv_cafe_5', kind: 'coffee_shop', x: -68, z: -18, rotY: Math.PI / 2 },
    { id: 'gv_cafe_6', kind: 'coffee_shop', x: 68, z: 18, rotY: -Math.PI / 2 },
    // Bakeries
    { id: 'gv_bakery_1', kind: 'bakery', x: -34, z: -34, rotY: 0 },
    { id: 'gv_bakery_2', kind: 'bakery', x: 34, z: -34, rotY: Math.PI },
    { id: 'gv_bakery_3', kind: 'bakery', x: -34, z: 34, rotY: 0 },
    { id: 'gv_bakery_4', kind: 'bakery', x: 34, z: 34, rotY: Math.PI },
    { id: 'gv_bakery_5', kind: 'bakery', x: -68, z: 18, rotY: Math.PI / 2 },
    { id: 'gv_bakery_6', kind: 'bakery', x: 68, z: -18, rotY: -Math.PI / 2 },
    // Mini markets
    { id: 'gv_market_1', kind: 'mini_market', x: -34, z: -18, rotY: 0 },
    { id: 'gv_market_2', kind: 'mini_market', x: 34, z: -18, rotY: Math.PI },
    { id: 'gv_market_3', kind: 'mini_market', x: -34, z: 18, rotY: 0 },
    { id: 'gv_market_4', kind: 'mini_market', x: 34, z: 18, rotY: Math.PI },
    { id: 'gv_market_5', kind: 'mini_market', x: -14, z: -68, rotY: 0 },
    { id: 'gv_market_6', kind: 'mini_market', x: 14, z: 68, rotY: Math.PI },
  ],
};

export const DISTRICTS: DistrictDef[] = [OLD_TOWN, GREEN_VALLEY];

/**
 * Roads that join districts to each other. Keeping the graph one
 * connected component is what makes cross-district deliveries drive
 * rather than teleport.
 */
export const CONNECTORS: RoadSegment[] = [
  // Old Town's eastern trunk road -> Green Valley's western trunk road,
  // both of which sit on world z = 0.
  { x1: OLD_TOWN.origin.x + OLD_TOWN.roadSpan, z1: 0, x2: GREEN_VALLEY.origin.x - 52, z2: 0 },
];

export function districtById(id: string): DistrictDef | undefined {
  return DISTRICTS.find((d) => d.id === id);
}

export const DEFAULT_DISTRICT: DistrictId = 'old_town';

// ---------------- Derived world-space data ----------------

/** Every lot in the city, in world coordinates, tagged with its district. */
export const LOTS: LotDef[] = DISTRICTS.flatMap((d) =>
  d.lots.map((l) => ({
    ...l,
    x: l.x + d.origin.x,
    z: l.z + d.origin.z,
    district: d.id,
  }))
);

/** Road segments for one district, in world coordinates. */
export function districtRoadSegments(d: DistrictDef): RoadSegment[] {
  const segs: RoadSegment[] = [];
  for (const vx of d.roadLines.vertical) {
    segs.push({
      x1: vx + d.origin.x,
      z1: -d.roadSpan + d.origin.z,
      x2: vx + d.origin.x,
      z2: d.roadSpan + d.origin.z,
    });
  }
  for (const hz of d.roadLines.horizontal) {
    segs.push({
      x1: -d.roadSpan + d.origin.x,
      z1: hz + d.origin.z,
      x2: d.roadSpan + d.origin.x,
      z2: hz + d.origin.z,
    });
  }
  return segs;
}

/** The whole city road network in world coordinates. */
export const ROAD_SEGMENTS: RoadSegment[] = [
  ...DISTRICTS.flatMap(districtRoadSegments),
  ...CONNECTORS,
];

/** World-space bounds covering every district, used for camera limits. */
export const CITY_BOUNDS = (() => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const d of DISTRICTS) {
    minX = Math.min(minX, d.origin.x - d.groundHalf);
    maxX = Math.max(maxX, d.origin.x + d.groundHalf);
    minZ = Math.min(minZ, d.origin.z - d.groundHalf);
    maxZ = Math.max(maxZ, d.origin.z + d.groundHalf);
  }
  return { minX, maxX, minZ, maxZ };
})();

export const WHOLESALE_LOT_ID = 'wholesale';

export function lotById(id: string): LotDef | undefined {
  return LOTS.find((l) => l.id === id);
}

/** Lots of a kind, optionally restricted to one district. */
export function lotsOfKind(kind: LotKind, district?: DistrictId): LotDef[] {
  return LOTS.filter((l) => l.kind === kind && (!district || l.district === district));
}

/** Business lots (everything the player can build on) in a district. */
export function districtLots(district: DistrictId): LotDef[] {
  return LOTS.filter((l) => l.district === district && l.kind !== 'wholesale');
}

/** Total buildable lots per district, keyed by district id. */
export function districtCapacity(district: DistrictId): number {
  return districtLots(district).length;
}

// ---------------- Road graph pathfinding ----------------
// Roads are a set of axis-aligned segments (see ROAD_SEGMENTS). The
// graph is built by cutting every segment at its endpoints, at each
// crossing with a perpendicular segment, and at the projected start/end
// points, then linking consecutive cuts. This is layout-agnostic, so a
// new district only needs to contribute segments.

interface Node {
  id: number;
  x: number;
  z: number;
  edges: { to: number; cost: number }[];
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function isVertical(s: RoadSegment): boolean {
  return Math.abs(s.x1 - s.x2) < 1e-6;
}

/** Closest point on an axis-aligned segment to p. */
function projectOnSegment(s: RoadSegment, p: Vec2): Vec2 {
  if (isVertical(s)) {
    const lo = Math.min(s.z1, s.z2);
    const hi = Math.max(s.z1, s.z2);
    return { x: s.x1, z: Math.max(lo, Math.min(hi, p.z)) };
  }
  const lo = Math.min(s.x1, s.x2);
  const hi = Math.max(s.x1, s.x2);
  return { x: Math.max(lo, Math.min(hi, p.x)), z: s.z1 };
}

/** Project a point onto the nearest point of the whole road network. */
export function nearestRoadPoint(p: Vec2): Vec2 {
  let best: Vec2 = { x: 0, z: 0 };
  let bestD = Infinity;
  for (const s of ROAD_SEGMENTS) {
    const q = projectOnSegment(s, p);
    const d = dist(p.x, p.z, q.x, q.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Does p lie on segment s (within tolerance)? */
function pointOnSegment(s: RoadSegment, p: Vec2): boolean {
  const eps = 0.05;
  if (isVertical(s)) {
    if (Math.abs(p.x - s.x1) > eps) return false;
    const lo = Math.min(s.z1, s.z2) - eps;
    const hi = Math.max(s.z1, s.z2) + eps;
    return p.z >= lo && p.z <= hi;
  }
  if (Math.abs(p.z - s.z1) > eps) return false;
  const lo = Math.min(s.x1, s.x2) - eps;
  const hi = Math.max(s.x1, s.x2) + eps;
  return p.x >= lo && p.x <= hi;
}

/** Intersection of a vertical and a horizontal segment, if they cross. */
function crossing(v: RoadSegment, h: RoadSegment): Vec2 | null {
  const x = v.x1;
  const z = h.z1;
  const eps = 1e-6;
  const vLo = Math.min(v.z1, v.z2) - eps;
  const vHi = Math.max(v.z1, v.z2) + eps;
  const hLo = Math.min(h.x1, h.x2) - eps;
  const hHi = Math.max(h.x1, h.x2) + eps;
  if (z >= vLo && z <= vHi && x >= hLo && x <= hHi) return { x, z };
  return null;
}

/**
 * Compute a path along the road network between two arbitrary world
 * points. Returns waypoints: from -> road entry -> ...roads... -> road
 * exit -> to. Deterministic and shared between client and server, so a
 * van's visible route matches the server's delivery timing exactly.
 */
export function roadPath(from: Vec2, to: Vec2): Vec2[] {
  const a = nearestRoadPoint(from);
  const b = nearestRoadPoint(to);

  const nodes: Node[] = [];
  const byKey = new Map<string, Node>();
  const key = (x: number, z: number) => `${x.toFixed(3)}:${z.toFixed(3)}`;
  const nodeAt = (x: number, z: number): Node => {
    const k = key(x, z);
    const hit = byKey.get(k);
    if (hit) return hit;
    const n: Node = { id: nodes.length, x, z, edges: [] };
    nodes.push(n);
    byKey.set(k, n);
    return n;
  };
  const connect = (n1: Node, n2: Node) => {
    if (n1 === n2) return;
    const c = dist(n1.x, n1.z, n2.x, n2.z);
    n1.edges.push({ to: n2.id, cost: c });
    n2.edges.push({ to: n1.id, cost: c });
  };

  // Cut every segment at endpoints, crossings and the two projections.
  for (const s of ROAD_SEGMENTS) {
    const cuts: Vec2[] = [
      { x: s.x1, z: s.z1 },
      { x: s.x2, z: s.z2 },
    ];
    for (const o of ROAD_SEGMENTS) {
      if (o === s || isVertical(o) === isVertical(s)) continue;
      const c = isVertical(s) ? crossing(s, o) : crossing(o, s);
      if (c) cuts.push(c);
    }
    for (const p of [a, b]) if (pointOnSegment(s, p)) cuts.push(p);

    // Order cuts along the segment, then link neighbours.
    const vertical = isVertical(s);
    cuts.sort((p, q) => (vertical ? p.z - q.z : p.x - q.x));
    for (let i = 1; i < cuts.length; i++) {
      const n1 = nodeAt(cuts[i - 1].x, cuts[i - 1].z);
      const n2 = nodeAt(cuts[i].x, cuts[i].z);
      connect(n1, n2);
    }
  }

  const start = nodeAt(a.x, a.z);
  const end = nodeAt(b.x, b.z);

  // Dijkstra
  const distArr = new Array(nodes.length).fill(Infinity);
  const prev = new Array<number>(nodes.length).fill(-1);
  const visited = new Array(nodes.length).fill(false);
  distArr[start.id] = 0;
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!visited[i] && distArr[i] < best) {
        best = distArr[i];
        u = i;
      }
    }
    if (u === -1) break;
    if (u === end.id) break;
    visited[u] = true;
    for (const e of nodes[u].edges) {
      const nd = distArr[u] + e.cost;
      if (nd < distArr[e.to]) {
        distArr[e.to] = nd;
        prev[e.to] = u;
      }
    }
  }

  const roadPts: Vec2[] = [];
  if (distArr[end.id] < Infinity) {
    let cur = end.id;
    while (cur !== -1) {
      roadPts.unshift({ x: nodes[cur].x, z: nodes[cur].z });
      if (cur === start.id) break;
      cur = prev[cur];
    }
  } else {
    // Disconnected graph should be impossible, but never strand a van.
    roadPts.push(a, b);
  }

  const pts: Vec2[] = [{ x: from.x, z: from.z }, ...roadPts, { x: to.x, z: to.z }];
  // Remove consecutive duplicates
  return pts.filter(
    (p, i) => i === 0 || dist(p.x, p.z, pts[i - 1].x, pts[i - 1].z) > 0.05
  );
}

export function pathLength(pts: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += dist(pts[i].x, pts[i].z, pts[i - 1].x, pts[i - 1].z);
  }
  return total;
}

/** Position along a path at 0..1 progress (by arc length). */
export function pointAlongPath(pts: Vec2[], t: number): { p: Vec2; angle: number } {
  const total = pathLength(pts);
  if (total <= 0 || pts.length < 2) {
    return { p: pts[0] ?? { x: 0, z: 0 }, angle: 0 };
  }
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i].x, pts[i].z, pts[i - 1].x, pts[i - 1].z);
    if (target <= seg) {
      const k = seg > 0 ? target / seg : 0;
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k;
      const z = pts[i - 1].z + (pts[i].z - pts[i - 1].z) * k;
      const angle = Math.atan2(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      return { p: { x, z }, angle };
    }
    target -= seg;
  }
  const last = pts[pts.length - 1];
  const prevPt = pts[pts.length - 2];
  return {
    p: { x: last.x, z: last.z },
    angle: Math.atan2(last.x - prevPt.x, last.z - prevPt.z),
  };
}
