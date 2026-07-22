// Procedural low-poly building & prop factories. All original art,
// built from primitives with a shared miniature-city palette.
import * as THREE from 'three';

const mats = new Map<number, THREE.MeshLambertMaterial>();
export function mat(color: number): THREE.MeshLambertMaterial {
  let m = mats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    mats.set(color, m);
  }
  return m;
}

export function box(
  w: number, h: number, d: number, color: number,
  x = 0, y = 0, z = 0, castShadow = true
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

export function cyl(
  rTop: number, rBot: number, h: number, color: number,
  x = 0, y = 0, z = 0, segments = 10
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, segments), mat(color));
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function cone(r: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 8): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), mat(color));
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  return mesh;
}

/** Triangular-prism gable roof spanning w (x) by d (z), height h. */
export function gableRoof(w: number, d: number, h: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const hw = w / 2;
  const hd = d / 2;
  const verts = new Float32Array([
    // front triangle
    -hw, 0, hd, hw, 0, hd, 0, h, hd,
    // back triangle
    hw, 0, -hd, -hw, 0, -hd, 0, h, -hd,
    // left slope
    -hw, 0, hd, 0, h, hd, 0, h, -hd,
    -hw, 0, hd, 0, h, -hd, -hw, 0, -hd,
    // right slope
    hw, 0, hd, hw, 0, -hd, 0, h, -hd,
    hw, 0, hd, 0, h, -hd, 0, h, hd,
    // bottom
    -hw, 0, hd, -hw, 0, -hd, hw, 0, -hd,
    -hw, 0, hd, hw, 0, -hd, hw, 0, hd,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat(color));
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function label(text: string, sub: string, color = '#ffffff'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 160;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(30, 41, 59, 0.85)';
  const r = 36;
  g.beginPath();
  g.roundRect(16, 12, 480, 136, r);
  g.fill();
  g.fillStyle = color;
  g.font = 'bold 58px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(text.slice(0, 16), 256, 76);
  g.fillStyle = '#ffd166';
  g.font = '600 42px system-ui, sans-serif';
  g.fillText(sub, 256, 130);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  sprite.scale.set(9, 2.8, 1);
  return sprite;
}

// ---------------- player businesses ----------------

export function makeFarm(level: number, ownerName: string): THREE.Group {
  const g = new THREE.Group();
  // fenced field
  const field = box(16, 0.24, 12, 0x9dc768, 0, 0, 0, false);
  field.receiveShadow = true;
  g.add(field);
  // crop rows
  for (let i = -2; i <= 2; i++) {
    g.add(box(14, 0.3, 0.9, 0x7fb356, 0, 0.2, i * 2.2, false));
  }
  // fence posts
  for (let i = -4; i <= 4; i++) {
    g.add(box(0.22, 1, 0.22, 0xb08968, i * 2, 0, -6.2));
    g.add(box(0.22, 1, 0.22, i === 0 ? 0xb08968 : 0xb08968, i * 2, 0, 6.2));
  }
  g.add(box(16, 0.14, 0.14, 0xc9a27e, 0, 0.75, -6.2));
  g.add(box(16, 0.14, 0.14, 0xc9a27e, 0, 0.75, 6.2));

  // barn
  const barnW = level >= 2 ? 6.5 : 5;
  const barnD = level >= 2 ? 5 : 4;
  const barnH = level >= 2 ? 3.2 : 2.6;
  g.add(box(barnW, barnH, barnD, 0xd9534f, -4, 0.2, -1));
  g.add(gableRoof(barnW + 0.6, barnD + 0.6, 1.8, 0x8d3b36, -4, barnH + 0.2, -1));
  g.add(box(1.4, 1.7, 0.2, 0x6b4f3a, -4, 0.2, -1 + barnD / 2 + 0.05)); // door
  // milk tank
  const tank = cyl(0.9, 0.9, 1.6, 0xe8eef2, 0.5, 0.2, -4);
  g.add(tank);

  if (level >= 2) {
    // silo
    g.add(cyl(1.1, 1.1, 4.4, 0xf0f3f5, -8.4, 0.2, -3));
    g.add(cone(1.15, 1, 0xd9534f, -8.4, 4.6, -3, 10));
  }
  if (level >= 3) {
    // modern milking hall + solar panels
    g.add(box(5, 2.2, 3.4, 0xf2f5f7, 4.5, 0.2, -4));
    g.add(box(5.4, 0.3, 3.8, 0x94a3b8, 4.5, 2.4, -4));
    for (let i = 0; i < 3; i++) {
      const panel = box(1.6, 0.1, 1.1, 0x2b4c7e, 3.4 + i * 1.7, 2.72, -4);
      panel.rotation.x = -0.25;
      g.add(panel);
    }
  }
  // cows
  const cowCount = level + 1;
  for (let i = 0; i < cowCount; i++) {
    const cow = new THREE.Group();
    const bodyMesh = box(1.3, 0.75, 0.7, 0xffffff, 0, 0.45, 0);
    cow.add(bodyMesh);
    cow.add(box(0.45, 0.4, 0.5, 0x333333, 0.55, 0.75, 0));
    cow.add(box(0.35, 0.3, 0.32, 0x222222, -0.4, 0.6, 0.2, false));
    cow.position.set(1 + (i % 3) * 2.4, 0.15, 1.6 + Math.floor(i / 3) * 2.4);
    cow.rotation.y = i * 1.3;
    g.add(cow);
  }
  const lbl = label(ownerName, `Farm · Lv ${level}`, '#d7f9d0');
  lbl.position.set(0, 8.2, 0);
  g.add(lbl);
  return g;
}

export function makeCoffeeShop(level: number, ownerName: string): THREE.Group {
  const g = new THREE.Group();
  const plaza = box(11, 0.22, 9, 0xcfc3b4, 0, 0, 0, false);
  plaza.receiveShadow = true;
  g.add(plaza);

  if (level === 1) {
    // kiosk
    g.add(box(3.4, 2.4, 2.6, 0x8b5e3c, 0, 0.2, -1));
    g.add(box(3.9, 0.3, 3.1, 0x5f4630, 0, 2.6, -1));
    // striped awning
    g.add(awning(3.6, 1.2, 0, 2.1, 0.7));
    g.add(box(0.9, 1.1, 0.15, 0x3f2f22, 0.8, 1.1, 0.31));
  } else {
    const w = level >= 3 ? 7.5 : 5.5;
    const h = level >= 3 ? 4.6 : 2.9;
    g.add(box(w, h, 4.4, level >= 3 ? 0xe8b46a : 0xcf9053, 0, 0.2, -1.4));
    g.add(box(w + 0.5, 0.35, 4.9, 0x74553a, 0, h + 0.2, -1.4));
    // windows
    for (let i = 0; i < (level >= 3 ? 3 : 2); i++) {
      const wx = (i - (level >= 3 ? 1 : 0.5)) * 2.1;
      g.add(box(1.3, 1.15, 0.12, 0xbfe3ee, wx, 1.0, 0.85));
      if (level >= 3) g.add(box(1.3, 1.0, 0.12, 0xbfe3ee, wx, 3.0, 0.85));
    }
    g.add(awning(w * 0.8, 1.3, 0, 2.35, 1.5));
    g.add(box(1.05, 1.85, 0.14, 0x4a3626, w / 2 - 1.1, 0.2, 0.86)); // door
    // terrace umbrellas
    const umbrellas = level >= 3 ? 3 : 1;
    for (let i = 0; i < umbrellas; i++) {
      const ux = -3 + i * 3;
      g.add(cyl(0.07, 0.07, 2.1, 0x8a8a8a, ux, 0.2, 2.6));
      g.add(cone(1.25, 0.65, i % 2 ? 0xef767a : 0xf4a259, ux, 2.1, 2.6, 8));
      g.add(cyl(0.55, 0.55, 0.5, 0xf5efe6, ux, 0.2, 2.6, 8));
    }
  }
  // coffee cup sign
  const signPole = cyl(0.09, 0.09, 3.4, 0x6b7280, -3.9, 0.2, 2.9);
  g.add(signPole);
  g.add(cyl(0.55, 0.4, 0.75, 0xffffff, -3.9, 3.4, 2.9, 12));
  g.add(cyl(0.58, 0.58, 0.1, 0x7a4a2b, -3.9, 4.1, 2.9, 12));

  const lbl = label(ownerName, `Coffee Shop · Lv ${level}`, '#ffe9c9');
  lbl.position.set(0, 7.6, 0);
  g.add(lbl);
  return g;
}

function awning(w: number, depth: number, x: number, y: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const stripes = Math.max(3, Math.round(w / 0.8));
  for (let i = 0; i < stripes; i++) {
    const sw = w / stripes;
    const s = box(sw, 0.09, depth, i % 2 ? 0xffffff : 0xe4572e, x - w / 2 + sw * (i + 0.5), y, z);
    s.rotation.x = -0.35;
    g.add(s);
  }
  return g;
}

// ---------------- NPC / scenery ----------------

export function makeWholesale(): THREE.Group {
  const g = new THREE.Group();
  const pad = box(14, 0.22, 11, 0xb9bdc4, 0, 0, 0, false);
  g.add(pad);
  g.add(box(10, 4.2, 7, 0x7a9cc6, -1, 0.2, -1));
  g.add(gableRoof(10.6, 7.6, 1.6, 0x51698c, -1, 4.4, -1));
  // loading dock + shutter doors
  g.add(box(3.4, 1.1, 2.4, 0x9aa5b1, 4.6, 0.2, 1.5));
  for (let i = 0; i < 2; i++) {
    g.add(box(2.1, 2.3, 0.14, 0xdde3e8, -3.5 + i * 3.1, 0.4, 2.55));
  }
  // crates
  g.add(box(1, 1, 1, 0xc9a06a, 5.4, 0.2, -2.4));
  g.add(box(0.85, 0.85, 0.85, 0xb08a55, 5.5, 1.2, -2.4));
  g.add(box(1, 1, 1, 0xc9a06a, 4.2, 0.2, -3.3));
  const lbl = label('Central Wholesale', 'Milk & Beans · NPC', '#cfe3ff');
  lbl.position.set(0, 8.6, 0);
  g.add(lbl);
  return g;
}

const HOUSE_COLORS = [0xf4d8a8, 0xf2b5a0, 0xbcd8b7, 0xa8c8e4, 0xe9d3f0, 0xf7e3b0];
export function makeHouse(seed: number): THREE.Group {
  const g = new THREE.Group();
  const rnd = mulberry(seed);
  const w = 3.4 + rnd() * 2.2;
  const d = 3.2 + rnd() * 1.6;
  const h = 2.2 + rnd() * 1.4;
  const color = HOUSE_COLORS[Math.floor(rnd() * HOUSE_COLORS.length)];
  g.add(box(w, h, d, color));
  g.add(gableRoof(w + 0.5, d + 0.5, 1.2 + rnd() * 0.8, 0xa96f44, 0, h, 0));
  g.add(box(0.8, 1.3, 0.12, 0x59473a, w / 4, 0, d / 2 + 0.02));
  g.add(box(0.9, 0.8, 0.12, 0xbfe3ee, -w / 4, 0.9, d / 2 + 0.02));
  return g;
}

export function makeTree(seed: number): THREE.Group {
  const g = new THREE.Group();
  const rnd = mulberry(seed);
  const s = 0.8 + rnd() * 0.7;
  g.add(cyl(0.16 * s, 0.22 * s, 1.1 * s, 0x8a5a3b, 0, 0, 0, 6));
  const foliage = rnd() > 0.5 ? 0x63a24a : 0x74b658;
  if (rnd() > 0.55) {
    g.add(cone(1.15 * s, 2.6 * s, foliage, 0, 0.9 * s, 0, 7));
  } else {
    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15 * s, 0), mat(foliage));
    ball.position.y = 2.1 * s;
    ball.castShadow = true;
    g.add(ball);
  }
  return g;
}

export function makeStreetlight(): THREE.Group {
  const g = new THREE.Group();
  g.add(cyl(0.09, 0.12, 4, 0x54606c, 0, 0, 0, 6));
  g.add(box(1.1, 0.12, 0.12, 0x54606c, 0.5, 3.95, 0));
  const lamp = box(0.4, 0.18, 0.26, 0xfff2b8, 1, 3.85, 0, false);
  g.add(lamp);
  return g;
}

export function makeVan(color = 0xf5f7fa): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1.4, 1.15, 3, color, 0, 0.35, 0)); // cargo
  g.add(box(1.3, 0.75, 0.9, 0x8fb7d9, 0, 0.35, 1.85)); // cabin
  g.add(box(1.32, 0.35, 0.2, color, 0, 0.35, 2.3)); // bumper/hood
  for (const [x, z] of [[-0.62, 1.6], [0.62, 1.6], [-0.62, -0.9], [0.62, -0.9]] as const) {
    const wheel = cyl(0.3, 0.3, 0.24, 0x2c2c34, x, 0, z, 10);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.y = 0.3;
    g.add(wheel);
  }
  // milk crate on top hint
  g.add(box(0.8, 0.32, 0.8, 0x74b658, 0, 1.52, -0.4));
  return g;
}

const SHIRT_COLORS = [0xef767a, 0x49beaa, 0x456990, 0xf4a259, 0x9d8df1, 0x6a994e];
export function makePerson(seed: number): THREE.Group {
  const g = new THREE.Group();
  const rnd = mulberry(seed);
  const shirt = SHIRT_COLORS[Math.floor(rnd() * SHIRT_COLORS.length)];
  const legs = box(0.34, 0.42, 0.22, 0x3d405b, 0, 0, 0);
  g.add(legs);
  const bodyM = box(0.44, 0.55, 0.3, shirt, 0, 0.42, 0);
  g.add(bodyM);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), mat(0xf1c9a5));
  head.position.y = 1.18;
  head.castShadow = true;
  g.add(head);
  g.add(box(0.42, 0.12, 0.3, 0x59473a, 0, 1.3, 0, false)); // hair
  g.scale.setScalar(0.9 + rnd() * 0.25);
  return g;
}

export function makeCar(seed: number): THREE.Group {
  const g = new THREE.Group();
  const rnd = mulberry(seed);
  const color = SHIRT_COLORS[Math.floor(rnd() * SHIRT_COLORS.length)];
  g.add(box(1.3, 0.5, 2.6, color, 0, 0.28, 0));
  g.add(box(1.15, 0.45, 1.4, 0xbfe3ee, 0, 0.78, -0.1));
  for (const [x, z] of [[-0.58, 0.85], [0.58, 0.85], [-0.58, -0.85], [0.58, -0.85]] as const) {
    const wheel = cyl(0.26, 0.26, 0.2, 0x2c2c34, x, 0, z, 8);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.y = 0.26;
    g.add(wheel);
  }
  return g;
}

export function makeVacantSign(kind: 'farm' | 'coffee_shop'): THREE.Group {
  const g = new THREE.Group();
  const pad = box(kind === 'farm' ? 16 : 10, 0.16, kind === 'farm' ? 12 : 8, 0xd6cdA0, 0, 0, 0, false);
  (pad.material as THREE.Material).transparent = true;
  (pad.material as any).opacity = 0.5;
  g.add(pad);
  g.add(box(0.18, 2.2, 0.18, 0x8a6f4d, 0, 0, 0));
  const board = label('FOR SALE', kind === 'farm' ? 'Farm lot' : 'Café lot', '#ffd166');
  board.position.y = 3.1;
  board.scale.set(7, 2.2, 1);
  g.add(board);
  return g;
}

function mulberry(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
