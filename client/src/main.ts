import * as THREE from 'three';
import './ui/styles.css';
import { client } from './net.js';
import { UI } from './ui/ui.js';
import { createScene } from './game/scene.js';
import { CameraRig } from './game/camera.js';
import { City, type Selectable } from './game/city.js';
import { Actors } from './game/actors.js';
import { Effects } from './game/effects.js';
import { sfx } from './audio.js';

const app = document.getElementById('app')!;
const { renderer, scene, camera } = createScene(app);
const rig = new CameraRig(camera, renderer.domElement);
const city = new City(scene);
const actors = new Actors(scene);
const effects = new Effects(scene);
const ui = new UI();

ui.onFocusLot = (lotId) => rig.focusOn(city.lotWorldPos(lotId));

// ---------- selection ----------
const raycaster = new THREE.Raycaster();
rig.onSelect = (x, y) => {
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  const hits = raycaster.intersectObjects(city.selectables, true);
  const sel = hits.find((h) => h.object.userData.sel)?.object.userData.sel as Selectable | undefined;
  if (!sel) return;
  sfx.click();
  if (sel.kind === 'wholesale') {
    ui.openWholesale();
    rig.focusOn(city.lotWorldPos(sel.lotId));
  } else if (sel.kind === 'business') {
    if (client.myBiz && sel.bizId === client.myBiz.id) {
      ui.openBusiness();
    } else if (sel.bizId != null) {
      ui.openInfo(sel.bizId);
      rig.focusOn(city.lotWorldPos(sel.lotId));
    }
  }
};

// ---------- state -> world sync ----------
client.on('welcome', () => {
  document.getElementById('auth-overlay')?.remove();
  ui.showHud();
  if (!client.myBiz) ui.showChoose();
  else ui.hideChoose();
  city.syncBusinesses([...client.businesses.values()]);
  actors.syncDeliveries([...client.deliveries.values()]);
  if (client.myBiz) rig.focusOn(city.lotWorldPos(client.myBiz.lotId));
});

let choseAt = 0;
client.on('update', () => {
  city.syncBusinesses([...client.businesses.values()]);
  actors.syncDeliveries([...client.deliveries.values()]);
  if (client.myBiz) {
    ui.hideChoose();
  } else if (client.you && Date.now() - choseAt > 5000) {
    ui.showChoose();
  }
});
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest?.('.choice')) choseAt = Date.now();
});

let myLastLevel = 0;
client.on('update', () => {
  const lvl = client.myBiz?.level ?? 0;
  if (myLastLevel && lvl > myLastLevel) {
    sfx.upgrade();
    const pos = city.lotWorldPos(client.myBiz!.lotId);
    effects.popupText(pos.clone().setY(9), 'UPGRADED!', '#ffd166');
  }
  myLastLevel = lvl;
});

client.on('sale', (e: { bizId: number; lotId: string; amount: number }) => {
  const mine = client.myBiz?.id === e.bizId;
  // A customer walks to the shop; the +$ pops when they reach the door.
  actors.spawnCustomer(e.lotId, () => {
    const pos = city.lotWorldPos(e.lotId);
    effects.popupText(pos.clone().setY(6.5), `+$${e.amount}`, mine ? '#7dff8a' : '#c8f5cd');
    if (mine) sfx.sale();
    else sfx.saleFar();
  });
});

client.on('lost_customer', (e: { bizId: number; lotId: string }) => {
  if (client.myBiz?.id === e.bizId) {
    const pos = city.lotWorldPos(e.lotId);
    effects.popupText(pos.clone().setY(6.5), 'out of stock!', '#ff9d9d');
  }
});

client.on('delivery', () => {
  // van spawn handled by syncDeliveries; small feedback if it's mine
});

client.on('delivery_done', (id: number) => {
  actors.deliveryArrived(id);
  sfx.delivery();
});

client.on('trade', () => {
  // trade toast comes from server; play purchase sound for participants
});

client.on('unauthorized', () => {
  ui.showAuth('Session expired — please log in again.');
});

// Dev-only hook for local testing/automation.
if ((import.meta as any).env?.DEV) {
  (window as any).__bd = { client, ui };
}

// ---------- boot ----------
if (client.token) {
  client.connect();
  // if the token is stale the 'unauthorized' handler shows auth
} else {
  ui.showAuth();
}

// ---------- render loop ----------
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  rig.update(dt);
  actors.update(dt, Date.now());
  effects.update(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
