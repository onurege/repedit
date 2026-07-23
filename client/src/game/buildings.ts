// Procedural low-poly building & prop factories. All original art,
// built from primitives with a shared miniature-city palette.
import * as THREE from 'three';
import { t } from '../i18n.js';

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
  canvas.height = 176;
  const g = canvas.getContext('2d')!;
  // rounded pill with a soft outline for readability over any background
  const pill = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  };
  g.fillStyle = 'rgba(17, 24, 39, 0.82)';
  pill(14, 14, 484, 148, 44);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  pill(14, 14, 484, 148, 44);
  g.stroke();
  g.textAlign = 'center';
  g.fillStyle = color;
  g.font = 'bold 60px system-ui, sans-serif';
  g.fillText(text.slice(0, 16), 256, 82);
  g.fillStyle = '#ffce6b';
  g.font = '600 40px system-ui, sans-serif';
  g.fillText(sub, 256, 138);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
  );
  const bw = 8.4;
  const bh = (bw * canvas.height) / canvas.width;
  sprite.scale.set(bw, bh, 1);
  sprite.renderOrder = 20;
  sprite.userData.bdLabel = { baseX: bw, baseY: bh };
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
  const lbl = label(ownerName, t('world.sign.farm', { level }), '#d7f9d0');
  lbl.position.set(0, 8.8, 0);
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

  const lbl = label(ownerName, t('world.sign.shop', { level }), '#ffe9c9');
  lbl.position.set(0, 8.2, 0);
  g.add(lbl);
  return g;
}

export function makeBakery(level: number, ownerName: string): THREE.Group {
  const g = new THREE.Group();
  const plaza = box(11, 0.22, 9, 0xd8cbb8, 0, 0, 0, false);
  plaza.receiveShadow = true;
  g.add(plaza);
  const w = level >= 3 ? 7.5 : level === 2 ? 5.8 : 4.2;
  const h = level >= 3 ? 4.4 : 2.8;
  g.add(box(w, h, 4.2, level >= 3 ? 0xf3d9a4 : 0xe8c187, 0, 0.2, -1.2));
  g.add(gableRoof(w + 0.6, 4.8, 1.5, 0xa9683f, 0, h + 0.2, -1.2));
  // brick chimney with smoke puffs
  g.add(box(0.7, 1.6, 0.7, 0xb35745, w / 3, h + 0.6, -1.6));
  for (let i = 0; i < (level >= 2 ? 3 : 2); i++) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.28 + i * 0.12, 7, 7), mat(0xf2f2ee));
    puff.position.set(w / 3, h + 2.5 + i * 0.7, -1.6 - i * 0.15);
    g.add(puff);
  }
  // shop window + door
  g.add(box(1.6, 1.1, 0.12, 0xbfe3ee, -w / 5, 0.9, 0.95));
  g.add(box(1, 1.7, 0.13, 0x6b4a2f, w / 4, 0.2, 0.95));
  g.add(awning(w * 0.85, 1.1, 0, 2.1, 1.35));
  if (level >= 2) {
    // bread stand
    g.add(box(1.8, 0.8, 0.9, 0x9a7148, -3.6, 0.2, 2.2));
    for (let i = 0; i < 4; i++) {
      const loaf = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.35, 3, 6), mat(0xd9a05f));
      loaf.rotation.z = Math.PI / 2;
      loaf.position.set(-4.2 + (i % 2) * 1.1, 1.15, 1.95 + Math.floor(i / 2) * 0.5);
      g.add(loaf);
    }
  }
  if (level >= 3) {
    g.add(cyl(0.09, 0.09, 3, 0x6b7280, -3.9, 0.2, 2.9));
    const pretzel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.18, 7, 12), mat(0xc07f3e));
    pretzel.position.set(-3.9, 3.5, 2.9);
    g.add(pretzel);
  }
  const lbl = label(ownerName, t('world.sign.bakery', { level }), '#ffe3bd');
  lbl.position.set(0, 8.2, 0);
  g.add(lbl);
  return g;
}

export function makeMiniMarket(level: number, ownerName: string): THREE.Group {
  const g = new THREE.Group();
  const pad = box(11, 0.22, 9, 0xc4c8cf, 0, 0, 0, false);
  pad.receiveShadow = true;
  g.add(pad);
  const w = level >= 3 ? 8.5 : level === 2 ? 6.5 : 4.6;
  const h = level >= 3 ? 3.6 : 2.7;
  g.add(box(w, h, 4.6, level >= 3 ? 0x7fc8a9 : 0x66b894, 0, 0.2, -1.2));
  g.add(box(w + 0.5, 0.35, 5.1, 0x3f7a63, 0, h + 0.2, -1.2)); // flat roof
  // storefront glass + sliding door
  const glassW = w * 0.8;
  g.add(box(glassW, 1.5, 0.12, 0xbfe3ee, 0, 0.75, 1.12));
  g.add(box(1.2, 1.9, 0.14, 0x37535f, 0, 0.2, 1.14));
  // fascia sign band
  g.add(box(w * 0.9, 0.6, 0.16, 0xf4a259, 0, h - 0.5, 1.15));
  if (level >= 2) {
    // sidewalk crates of goods
    g.add(box(1, 0.7, 1, 0xc9a06a, -w / 2 + 0.2, 0.22, 2.2));
    g.add(box(1, 0.5, 1, 0x74b658, -w / 2 + 1.4, 0.22, 2.2));
    // shopping cart hint
    g.add(box(0.8, 0.55, 0.55, 0x9aa5b1, w / 2 - 0.6, 0.5, 2.4));
  }
  if (level >= 3) {
    // small parking strip + cart bay
    g.add(box(3.2, 0.1, 2.2, 0x8a8f98, w / 2 + 1.4, 0.16, 1.4, false));
    g.add(box(2.6, 0.08, 0.25, 0xe8e6da, w / 2 + 1.4, 0.28, 1.4, false));
  }
  const lbl = label(ownerName, t('world.sign.market', { level }), '#d2f5e4');
  lbl.position.set(0, 8.2, 0);
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
  const lbl = label(t('world.wholesale'), t('world.wholesale.sub'), '#cfe3ff');
  lbl.position.set(0, 9.2, 0);
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

const LOT_LABEL_KEYS: Record<string, string> = {
  farm: 'world.lot.farm',
  coffee_shop: 'world.lot.cafe',
  bakery: 'world.lot.bakery',
  mini_market: 'world.lot.market',
};

export function makeVacantSign(kind: string): THREE.Group {
  const g = new THREE.Group();
  // A subtle mown-grass pad marks the empty lot without shouting.
  const pad = box(kind === 'farm' ? 15 : 9, 0.08, kind === 'farm' ? 11 : 7, 0x93cf6a, 0, 0, 0, false);
  pad.receiveShadow = true;
  g.add(pad);
  // small realtor-style sign board on a post
  const post = box(0.14, 1.5, 0.14, 0x9b8368, 0, 0, 0);
  g.add(post);
  const boardMesh = box(1.9, 1.0, 0.08, 0xf4f1e8, 0, 1.35, 0);
  g.add(boardMesh);
  g.add(box(2.0, 0.22, 0.1, 0xe4572e, 0, 1.75, 0.02)); // red header strip
  const spr = smallSign(t('world.for_sale'), t(LOT_LABEL_KEYS[kind] ?? 'world.lot.generic'));
  spr.position.set(0, 1.35, 0.09);
  g.add(spr);
  return g;
}

// Compact flat sign face (used on vacant-lot boards) — much smaller and
// quieter than a floating business label.
function smallSign(title: string, sub: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 136;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#e4572e';
  g.fillText('', 0, 0);
  g.textAlign = 'center';
  g.fillStyle = '#b3401f';
  g.font = 'bold 40px system-ui, sans-serif';
  g.fillText(title, 128, 52);
  g.fillStyle = '#5b6572';
  g.font = '600 30px system-ui, sans-serif';
  g.fillText(sub, 128, 100);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  spr.scale.set(1.85, 0.98, 1);
  return spr;
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

/**
 * Roadside district marker: a low monument with a name board, used at each
 * district's entrance so players can see where one district ends and the
 * next begins without a UI overlay.
 */
export function makeDistrictSign(title: string, sub: string, accent: number): THREE.Group {
  const g = new THREE.Group();
  // stone base + two posts carrying the board
  g.add(box(7.2, 0.5, 1.8, 0xcfc9b8, 0, 0, 0, false));
  g.add(box(0.35, 3.0, 0.35, 0x8b7355, -2.6, 0.5, 0));
  g.add(box(0.35, 3.0, 0.35, 0x8b7355, 2.6, 0.5, 0));
  const board = box(6.6, 2.1, 0.22, 0xf7f3e8, 0, 2.6, 0);
  g.add(board);
  g.add(box(6.6, 0.34, 0.26, accent, 0, 3.5, 0.02)); // accent header strip

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 168;
  const c = canvas.getContext('2d')!;
  // Opaque pill: the plate floats over grass, tarmac and buildings alike.
  c.fillStyle = 'rgba(255, 253, 247, 0.96)';
  c.beginPath();
  c.roundRect(8, 8, 496, 152, 34);
  c.fill();
  c.lineWidth = 6;
  c.strokeStyle = `#${accent.toString(16).padStart(6, '0')}`;
  c.beginPath();
  c.roundRect(8, 8, 496, 152, 34);
  c.stroke();
  c.textAlign = 'center';
  c.fillStyle = '#1f2937';
  c.font = 'bold 62px system-ui, sans-serif';
  c.fillText(title.slice(0, 18), 256, 78);
  c.fillStyle = '#6b7280';
  c.font = '600 34px system-ui, sans-serif';
  c.fillText(sub.slice(0, 26), 256, 126);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  // The plate floats above the monument rather than sitting on the board:
  // a camera-facing sprite pinned to a fixed board clips through it as soon
  // as the camera rotates.
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  spr.scale.set(9.5, 3.1, 1);
  spr.position.set(0, 5.6, 0);
  g.add(spr);
  return g;
}
