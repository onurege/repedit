// ============================================================
// The shared city map: road grid, lots, and road pathfinding.
// Both the client (visuals) and server (delivery timing) use
// the exact same data and path routine.
// ============================================================

export interface Vec2 {
  x: number;
  z: number;
}

export const CITY_EXTENT = 78;      // ground half-size
export const ROAD_HALF_WIDTH = 3.2; // road half width
export const ROAD_LINES = [-42, 0, 42]; // grid road centerlines (both axes)
export const ROAD_SPAN = 48;        // roads run from -ROAD_SPAN..ROAD_SPAN

export type LotKind = 'farm' | 'coffee_shop' | 'bakery' | 'mini_market' | 'wholesale';

export interface LotDef {
  id: string;
  kind: LotKind;
  x: number;
  z: number;
  rotY: number; // radians, building faces its road
}

// Farm lots ring the outskirts; coffee lots sit in the inner blocks.
export const LOTS: LotDef[] = [
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
  // NPC wholesale depot
  { id: 'wholesale', kind: 'wholesale', x: 16, z: -14, rotY: Math.PI },
];

export const WHOLESALE_LOT_ID = 'wholesale';

export function lotById(id: string): LotDef | undefined {
  return LOTS.find((l) => l.id === id);
}

export function lotsOfKind(kind: LotKind): LotDef[] {
  return LOTS.filter((l) => l.kind === kind);
}

// ---------------- Road graph pathfinding ----------------
// Roads form a grid: lines at ROAD_LINES on both axes over
// [-ROAD_SPAN, ROAD_SPAN]. Nodes are the 9 intersections plus
// temporary projected start/end points.

interface Node {
  id: number;
  x: number;
  z: number;
  edges: { to: number; cost: number }[];
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

// Project a point onto the nearest road centerline point.
export function nearestRoadPoint(p: Vec2): Vec2 {
  let best: Vec2 = { x: ROAD_LINES[0], z: clampSpan(p.z) };
  let bestD = Infinity;
  for (const line of ROAD_LINES) {
    // vertical road x = line
    const v = { x: line, z: clampSpan(p.z) };
    const dv = dist(p.x, p.z, v.x, v.z);
    if (dv < bestD) {
      bestD = dv;
      best = v;
    }
    // horizontal road z = line
    const h = { x: clampSpan(p.x), z: line };
    const dh = dist(p.x, p.z, h.x, h.z);
    if (dh < bestD) {
      bestD = dh;
      best = h;
    }
  }
  return best;
}

function clampSpan(v: number): number {
  return Math.max(-ROAD_SPAN, Math.min(ROAD_SPAN, v));
}

// Which road line (if any) a point sits on, with tolerance.
function onVertical(p: Vec2): number | null {
  for (const line of ROAD_LINES) if (Math.abs(p.x - line) < 0.01) return line;
  return null;
}
function onHorizontal(p: Vec2): number | null {
  for (const line of ROAD_LINES) if (Math.abs(p.z - line) < 0.01) return line;
  return null;
}

/**
 * Compute a path along the road network between two arbitrary world
 * points. Returns waypoints: from -> road entry -> ...roads... -> road
 * exit -> to. Deterministic and shared between client and server.
 */
export function roadPath(from: Vec2, to: Vec2): Vec2[] {
  const a = nearestRoadPoint(from);
  const b = nearestRoadPoint(to);

  const nodes: Node[] = [];
  const addNode = (x: number, z: number): Node => {
    const n: Node = { id: nodes.length, x, z, edges: [] };
    nodes.push(n);
    return n;
  };
  const connect = (n1: Node, n2: Node) => {
    const c = dist(n1.x, n1.z, n2.x, n2.z);
    n1.edges.push({ to: n2.id, cost: c });
    n2.edges.push({ to: n1.id, cost: c });
  };

  // Intersection nodes
  const grid: Node[][] = [];
  for (let i = 0; i < ROAD_LINES.length; i++) {
    grid.push([]);
    for (let j = 0; j < ROAD_LINES.length; j++) {
      grid[i].push(addNode(ROAD_LINES[i], ROAD_LINES[j]));
    }
  }
  for (let i = 0; i < ROAD_LINES.length; i++) {
    for (let j = 0; j < ROAD_LINES.length; j++) {
      if (i + 1 < ROAD_LINES.length) connect(grid[i][j], grid[i + 1][j]);
      if (j + 1 < ROAD_LINES.length) connect(grid[i][j], grid[i][j + 1]);
    }
  }

  // Insert a projected point as a node connected to its segment's
  // neighbouring intersections (or road ends).
  const insert = (p: Vec2): Node => {
    const n = addNode(p.x, p.z);
    const vx = onVertical(p);
    const hz = onHorizontal(p);
    if (vx !== null) {
      const i = ROAD_LINES.indexOf(vx);
      // connect along the vertical road to nearest intersections above/below
      let below: Node | null = null;
      let above: Node | null = null;
      for (let j = 0; j < ROAD_LINES.length; j++) {
        const inter = grid[i][j];
        if (inter.z <= p.z && (!below || inter.z > below.z)) below = inter;
        if (inter.z >= p.z && (!above || inter.z < above.z)) above = inter;
      }
      if (below) connect(n, below);
      if (above && above !== below) connect(n, above);
    }
    if (hz !== null) {
      const j = ROAD_LINES.indexOf(hz);
      let left: Node | null = null;
      let right: Node | null = null;
      for (let i2 = 0; i2 < ROAD_LINES.length; i2++) {
        const inter = grid[i2][j];
        if (inter.x <= p.x && (!left || inter.x > left.x)) left = inter;
        if (inter.x >= p.x && (!right || inter.x < right.x)) right = inter;
      }
      if (left) connect(n, left);
      if (right && right !== left) connect(n, right);
    }
    return n;
  };

  const start = insert(a);
  const end = insert(b);
  // Same segment shortcut: if both on same road line, connect directly.
  if (
    (onVertical(a) !== null && onVertical(a) === onVertical(b)) ||
    (onHorizontal(a) !== null && onHorizontal(a) === onHorizontal(b))
  ) {
    connect(start, end);
  }

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
  let cur = end.id;
  while (cur !== -1) {
    roadPts.unshift({ x: nodes[cur].x, z: nodes[cur].z });
    if (cur === start.id) break;
    cur = prev[cur];
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
