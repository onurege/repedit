import * as THREE from 'three';
import './ui/styles.css';
import { PRODUCTS } from '@district/shared';
import { client } from './net.js';

const PRODUCT_EMOJI: Record<string, string> = Object.fromEntries(
  Object.values(PRODUCTS).map((p) => [p.id, p.emoji])
);
import { UI } from './ui/ui.js';
import { createScene } from './game/scene.js';
import { CameraRig } from './game/camera.js';
import { City, type Selectable } from './game/city.js';
import { Actors } from './game/actors.js';
import { Effects } from './game/effects.js';
import { sfx } from './audio.js';
import { t, applyDocumentLang, onLangChange } from './i18n.js';

const app = document.getElementById('app')!;
const { renderer, scene, camera } = createScene(app);
const rig = new CameraRig(camera, renderer.domElement);
const city = new City(scene);
const actors = new Actors(scene);
const effects = new Effects(scene);
applyDocumentLang();
const ui = new UI();

// Sign sprites bake their text into a texture — rebuild them on language change.
onLangChange(() => city.syncBusinesses([...client.businesses.values()]));

ui.onFocusLot = (lotId) => {
  rig.focusOn(city.lotWorldPos(lotId));
  city.highlightLot(lotId);
};
ui.onCloseCity = () => city.highlightLot(null);
ui.onFocusDistrict = (id) => {
  city.highlightLot(null);
  rig.focusDistrict(id);
};

// ---------- selection ----------
const raycaster = new THREE.Raycaster();
rig.onSelect = (x, y) => {
  raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
  const hits = raycaster.intersectObjects(city.selectables, true);
  const sel = hits.find((h) => h.object.userData.sel)?.object.userData.sel as Selectable | undefined;
  if (!sel) {
    city.highlightLot(null);
    return;
  }
  sfx.click();
  city.highlightLot(sel.lotId);
  if (sel.kind === 'wholesale') {
    ui.openWholesale();
    rig.focusOn(city.lotWorldPos(sel.lotId));
  } else if (sel.kind === 'business') {
    if (sel.bizId != null && client.myBusinesses.has(sel.bizId)) {
      client.selectBiz(sel.bizId);
      ui.openBusiness();
      rig.focusOn(city.lotWorldPos(sel.lotId));
    } else if (sel.bizId != null) {
      ui.openInfo(sel.bizId);
      rig.focusOn(city.lotWorldPos(sel.lotId));
    }
  } else if (sel.kind === 'vacant') {
    // Clicking an empty lot offers to open a new business there (V2.1).
    if (client.company) {
      rig.focusOn(city.lotWorldPos(sel.lotId));
      ui.showOpenBusiness(sel.lotId);
    }
  }
};

// ---------- state -> world sync ----------
// District occupancy and city status are cheap server aggregates; refresh
// them on connect and on a slow timer rather than every tick.
let cityStatusTimer: ReturnType<typeof setInterval> | null = null;
client.on('welcome', () => {
  client.send({ t: 'city_status' });
  if (cityStatusTimer) clearInterval(cityStatusTimer);
  cityStatusTimer = setInterval(() => {
    if (client.connected) client.send({ t: 'city_status' });
  }, 15000);
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
    effects.popupText(pos.clone().setY(5.5), `LEVEL ${lvl}!`, '#ffd166');
    city.highlightLot(client.myBiz!.lotId);
  }
  myLastLevel = lvl;
});

// Throttle sale popups per lot so a busy shop shows tidy, occasional feedback
// (below the name label) rather than a spammy stack.
const lastSalePopup = new Map<string, number>();
client.on('sale', (e: { bizId: number; lotId: string; amount: number }) => {
  const mine = client.myBiz?.id === e.bizId;
  // A customer walks to the shop; the +$ pops when they reach the door.
  actors.spawnCustomer(e.lotId, () => {
    if (mine) sfx.sale();
    else sfx.saleFar();
    const now = performance.now();
    if (now - (lastSalePopup.get(e.lotId) ?? 0) < 900) return; // aggregate rapid sales
    lastSalePopup.set(e.lotId, now);
    const pos = city.lotWorldPos(e.lotId);
    // Popups rise from just above the storefront and fade out well below the
    // floating name label, so the two never collide.
    effects.popupText(
      pos.clone().setY(4.2).add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, 2)),
      `+$${e.amount}`,
      mine ? '#7dff8a' : '#bdeecb'
    );
  });
});

client.on('lost_customer', (e: { bizId: number; lotId: string }) => {
  if (client.myBiz?.id === e.bizId) {
    const now = performance.now();
    if (now - (lastSalePopup.get('lost:' + e.lotId) ?? 0) < 2500) return;
    lastSalePopup.set('lost:' + e.lotId, now);
    const pos = city.lotWorldPos(e.lotId);
    effects.popupText(pos.clone().setY(4.5), t('world.out_of_stock'), '#ff9d9d');
  }
});

client.on('delivery_done', (d: { id: number; product?: string; qty?: number; toBizId?: number }) => {
  actors.deliveryArrived(d.id);
  sfx.delivery();
  // Celebrate deliveries arriving at MY business with a clear popup.
  if (d.toBizId != null && client.myBiz?.id === d.toBizId && d.product && d.qty) {
    const emoji = PRODUCT_EMOJI[d.product] ?? '📦';
    const pos = city.lotWorldPos(client.myBiz.lotId);
    effects.popupText(pos.clone().setY(4.6), `+${d.qty} ${emoji}`, '#8fd3ff');
  }
});

client.on('trade', () => {
  // trade toast comes from server; play purchase sound for participants
});

client.on('unauthorized', () => {
  ui.showAuth(t('auth.session_expired'));
});

// Dev-only hook for local testing/automation.
if ((import.meta as any).env?.DEV) {
  (window as any).__bd = { client, ui, rig, city };
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
let bootHidden = false;
function hideBoot() {
  if (bootHidden) return;
  bootHidden = true;
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 600);
  }
}
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  rig.update(dt);
  actors.update(dt, Date.now());
  effects.update(dt);
  city.update(dt, camera.position);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Reveal the game once the first frames have rendered (city is visible).
requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(hideBoot, 250)));
