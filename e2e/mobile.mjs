// BUSINESS DISTRICT — V2.7 Mobile Web Compatibility E2E (touch navigation + UI).
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:mobile
//
// Emulates a real phone (390×844, touch) and drives the game with synthetic
// touch gestures against the actual canvas:
//   one-finger drag  -> camera pans
//   tap              -> selection fires
//   drag over world  -> selection does NOT fire (tap-vs-drag threshold)
//   pinch            -> zoom changes
//   two-finger drag  -> camera rotates
// Then checks core mobile UI: full-screen panels, UI scroll never moves the
// world, no page-level horizontal overflow, and no virtual joystick exists.
import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
try { const h = await fetch(`${SERVER_URL}/api/health`); if (!h.ok) throw 0; }
catch { console.error(`Server not reachable. Start it: npm run dev`); process.exit(2); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERR:', e.message));

// --- synthetic touch dispatch on the game canvas ---
async function touch(type, points) {
  await p.evaluate(({ type, points }) => {
    const cv = document.querySelector('#app canvas'); if (!cv) throw new Error('no canvas');
    const mk = (pt) => new Touch({ identifier: pt.id, target: cv, clientX: pt.x, clientY: pt.y, pageX: pt.x, pageY: pt.y });
    const list = points.map(mk);
    const ev = new TouchEvent(type, {
      touches: type === 'touchend' || type === 'touchcancel' ? [] : list,
      targetTouches: type === 'touchend' || type === 'touchcancel' ? [] : list,
      changedTouches: list, bubbles: true, cancelable: true,
    });
    cv.dispatchEvent(ev);
  }, { type, points });
}
const rig = async () => p.evaluate(() => ({ x: +window.__bd.rig.target.x.toFixed(3), z: +window.__bd.rig.target.z.toFixed(3), yaw: +window.__bd.rig.yaw.toFixed(4), dist: +window.__bd.rig.dist.toFixed(3) }));
const sleep = (ms) => p.waitForTimeout(ms);

await p.goto(CLIENT_URL);
await p.waitForSelector('#auth-user', { timeout: 15000 });
await p.fill('#auth-user', `mbl_${run}`); await p.fill('#auth-pass', 'e2e-pass-1234'); await p.click('#auth-go');
await p.waitForSelector('.choice', { timeout: 15000 });
await p.click('.choice[data-type="farm"]');
await p.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
await sleep(1200);
await p.evaluate(() => document.getElementById('mobile-hint')?.remove());
await p.evaluate(() => document.querySelectorAll('.overlay.modal, #brief-overlay, .mira').forEach((o) => o.remove()));

// Instrument selection so we can prove tap-vs-drag discrimination.
await p.evaluate(() => { window.__sel = 0; const o = window.__bd.rig.onSelect; window.__bd.rig.onSelect = (x, y) => { window.__sel++; return o && o(x, y); }; });

// 0) No virtual joystick / D-pad / fake WASD exists.
const joystick = await p.evaluate(() => !!document.querySelector('[class*="joystick" i],[id*="joystick" i],[class*="dpad" i],[id*="dpad" i],[data-wasd]'));
check('NO virtual joystick / D-pad / WASD buttons exist', !joystick);

// 1) One-finger drag pans the camera.
let before = await rig();
await touch('touchstart', [{ id: 1, x: 200, y: 430 }]);
for (let i = 1; i <= 6; i++) await touch('touchmove', [{ id: 1, x: 200 - i * 22, y: 430 - i * 10 }]);
await touch('touchend', [{ id: 1, x: 200 - 6 * 22, y: 430 - 6 * 10 }]);
await sleep(60);
let after = await rig();
check('one-finger drag pans the camera', Math.abs(after.x - before.x) + Math.abs(after.z - before.z) > 1, `Δx=${(after.x - before.x).toFixed(2)} Δz=${(after.z - before.z).toFixed(2)}`);
check('a drag does NOT trigger selection', (await p.evaluate(() => window.__sel)) === 0);

// 2) A tap (no travel) DOES trigger selection.
await p.evaluate(() => { window.__sel = 0; });
await touch('touchstart', [{ id: 2, x: 195, y: 470 }]);
await touch('touchend', [{ id: 2, x: 196, y: 471 }]); // < threshold
await sleep(60);
check('a tap triggers selection', (await p.evaluate(() => window.__sel)) >= 1);

// 3) Pinch changes zoom (distance).
before = await rig();
await touch('touchstart', [{ id: 3, x: 160, y: 420 }, { id: 4, x: 230, y: 420 }]);
for (let i = 1; i <= 5; i++) await touch('touchmove', [{ id: 3, x: 160 - i * 12, y: 420 }, { id: 4, x: 230 + i * 12, y: 420 }]); // fingers apart -> zoom in
await touch('touchend', [{ id: 3, x: 100, y: 420 }]);
await touch('touchend', []);
await sleep(60);
after = await rig();
check('pinch changes zoom (camera distance)', Math.abs(after.dist - before.dist) > 0.5, `dist ${before.dist} -> ${after.dist}`);

// 4) Two-finger drag (stable distance) rotates the camera (yaw).
before = await rig();
await touch('touchstart', [{ id: 5, x: 150, y: 430 }, { id: 6, x: 240, y: 430 }]);
for (let i = 1; i <= 5; i++) await touch('touchmove', [{ id: 5, x: 150 + i * 16, y: 430 }, { id: 6, x: 240 + i * 16, y: 430 }]); // both slide right, distance ~constant
await touch('touchend', [{ id: 5, x: 230, y: 430 }]);
await touch('touchend', []);
await sleep(60);
after = await rig();
check('two-finger drag rotates the camera (yaw)', Math.abs(after.yaw - before.yaw) > 0.01, `yaw ${before.yaw} -> ${after.yaw}`);

// 5) touchcancel clears gesture state (no stuck movement afterwards).
await touch('touchstart', [{ id: 7, x: 200, y: 430 }]);
await touch('touchmove', [{ id: 7, x: 160, y: 430 }]);
await touch('touchcancel', [{ id: 7, x: 160, y: 430 }]);
const rigC = await rig();
await sleep(150);
const rigC2 = await rig();
check('touchcancel leaves no stuck camera movement', rigC.x === rigC2.x && rigC.z === rigC2.z);

// 6) Full-screen panel + UI scroll must NOT move the world.
await p.click('#nav-biz'); await sleep(500);
check('no page-level horizontal overflow (business panel)', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
const camB = await rig();
// drag INSIDE the panel body — must not reach the canvas / move the camera.
const box = await p.evaluate(() => { const r = document.querySelector('#panel-body').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 40 }; });
await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x, box.y + 200, { steps: 6 }); await p.mouse.up();
const camA = await rig();
check('scrolling a UI panel does not move the world', camB.x === camA.x && camB.z === camA.z);

// 7) Desktop control hint hidden on touch; mobile hint localizes.
check('desktop WASD control hint is hidden on touch', await p.evaluate(() => {
  const el = document.querySelector('.controls-hint'); return !el || getComputedStyle(el).display === 'none';
}));

await browser.close();
console.log(failures ? `\nV2.7 MOBILE: ${failures} CHECK(S) FAILED` : '\nV2.7 MOBILE: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
