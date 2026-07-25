// BUSINESS DISTRICT — Desktop camera controls E2E (regression + left-drag pan).
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:desktop-camera
//
// Verifies the full desktop input model coexists:
//   LEFT-drag on the world -> pans (and does NOT select on release)
//   LEFT-click (no drag)    -> selects
//   WASD                    -> pans
//   RIGHT-drag              -> rotates
//   wheel                   -> zooms
//   MIDDLE-drag             -> pans (retained)
//   LEFT-drag inside a UI panel -> does NOT move the camera
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // desktop, no touch
const p = await ctx.newPage();
p.on('pageerror', (e) => console.log('PAGEERR:', e.message));

await p.goto(CLIENT_URL);
await p.waitForSelector('#auth-user', { timeout: 15000 });
await p.fill('#auth-user', `dc_${run}`); await p.fill('#auth-pass', 'e2e-pass-1234'); await p.click('#auth-go');
await p.waitForSelector('.choice', { timeout: 15000 });
await p.click('.choice[data-type="farm"]');
await p.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
await p.waitForTimeout(900);
await p.evaluate(() => document.querySelectorAll('.overlay.modal,#brief-overlay,.mira,#mobile-hint').forEach((o) => o.remove()));

const rig = async () => p.evaluate(() => ({ x: +window.__bd.rig.target.x.toFixed(3), z: +window.__bd.rig.target.z.toFixed(3), yaw: +window.__bd.rig.yaw.toFixed(4), dist: +window.__bd.rig.dist.toFixed(3) }));
await p.evaluate(() => { window.__sel = 0; const o = window.__bd.rig.onSelect; window.__bd.rig.onSelect = (x, y) => { window.__sel++; return o && o(x, y); }; });
const cx = 720, cy = 470; // a world point (canvas center-ish, away from HUD)

// 1) LEFT-drag on the world pans the camera and does NOT select.
await p.evaluate(() => { window.__sel = 0; });
let b0 = await rig();
await p.mouse.move(cx, cy); await p.mouse.down({ button: 'left' });
await p.mouse.move(cx - 160, cy - 70, { steps: 8 });
await p.mouse.up({ button: 'left' });
let a0 = await rig();
check('LEFT-drag pans the camera', Math.abs(a0.x - b0.x) + Math.abs(a0.z - b0.z) > 1, `Δx=${(a0.x - b0.x).toFixed(2)} Δz=${(a0.z - b0.z).toFixed(2)}`);
check('LEFT-drag does NOT trigger selection on release', (await p.evaluate(() => window.__sel)) === 0);

// 2) LEFT-click (no meaningful movement) selects.
await p.evaluate(() => { window.__sel = 0; });
await p.mouse.move(cx, cy); await p.mouse.down({ button: 'left' }); await p.mouse.up({ button: 'left' });
await p.waitForTimeout(50);
check('LEFT-click without drag selects', (await p.evaluate(() => window.__sel)) >= 1);

// 3) WASD still pans.
b0 = await rig();
await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })));
await p.waitForTimeout(320);
await p.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' })));
a0 = await rig();
check('WASD still pans', Math.abs(a0.x - b0.x) > 0.5, `Δx=${(a0.x - b0.x).toFixed(2)}`);

// 4) RIGHT-drag still rotates.
b0 = await rig();
await p.mouse.move(cx, cy); await p.mouse.down({ button: 'right' }); await p.mouse.move(cx - 160, cy, { steps: 6 }); await p.mouse.up({ button: 'right' });
a0 = await rig();
check('RIGHT-drag still rotates (yaw)', Math.abs(a0.yaw - b0.yaw) > 0.01, `yaw ${b0.yaw}->${a0.yaw}`);

// 5) Wheel still zooms.
b0 = await rig();
await p.mouse.move(cx, cy); await p.mouse.wheel(0, 300); await p.waitForTimeout(60);
a0 = await rig();
check('wheel still zooms', Math.abs(a0.dist - b0.dist) > 0.5, `dist ${b0.dist}->${a0.dist}`);

// 6) MIDDLE-drag still pans (retained).
b0 = await rig();
await p.mouse.move(cx, cy); await p.mouse.down({ button: 'middle' }); await p.mouse.move(cx - 120, cy + 80, { steps: 6 }); await p.mouse.up({ button: 'middle' });
a0 = await rig();
check('MIDDLE-drag still pans', Math.abs(a0.x - b0.x) + Math.abs(a0.z - b0.z) > 0.5, `Δx=${(a0.x - b0.x).toFixed(2)}`);

// 7) LEFT-drag INSIDE a UI panel does NOT move the camera.
await p.click('#nav-biz'); await p.waitForTimeout(500);
const box = await p.evaluate(() => { const r = document.querySelector('#panel-body').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 40 }; });
b0 = await rig();
await p.mouse.move(box.x, box.y); await p.mouse.down({ button: 'left' }); await p.mouse.move(box.x - 120, box.y + 160, { steps: 6 }); await p.mouse.up({ button: 'left' });
a0 = await rig();
check('LEFT-drag inside a UI panel does not move the world', b0.x === a0.x && b0.z === a0.z);

// 8) Desktop control hint still visible (touch hint only hides on touch).
check('desktop control hint is visible', await p.evaluate(() => { const el = document.querySelector('.controls-hint'); return !!el && getComputedStyle(el).display !== 'none'; }));

await browser.close();
console.log(failures ? `\nDESKTOP CAMERA: ${failures} CHECK(S) FAILED` : '\nDESKTOP CAMERA: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
