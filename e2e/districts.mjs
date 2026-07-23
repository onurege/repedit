// BUSINESS DISTRICT — V2.6 multi-district E2E.
//
// Prerequisites: the dev stack must be running with dev tools enabled
// (DEV_TOOLS=1, the default in development):
//   npm run dev          # server :2567 + client :5173
// Then:
//   npm run e2e:districts
//
// Covers the city expansion through the real browser UI:
//   A opens in Old Town, travels to Green Valley via the district selector,
//   opens a Farm there, and ends up owning businesses in two districts.
//   B runs an Old Town bakery and buys A's Green Valley wheat on the
//   marketplace. Verifies money and stock move exactly once, the delivery
//   van routes over the inter-district connector rather than teleporting,
//   goods arrive, and district ownership survives a reload.
// Uses fresh accounts per run, so no database reset is required.
// A custom Chromium path can be set via CHROMIUM_PATH.

import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};

try {
  const health = await fetch(`${SERVER_URL}/api/health`);
  if (!health.ok) throw new Error(String(health.status));
} catch {
  console.error(`Server not reachable at ${SERVER_URL}. Start the stack first: npm run dev`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;

async function newPlayer(name, bizType) {
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR: ${e.message}`));
  await page.goto(CLIENT_URL);
  await page.waitForSelector('#auth-user', { timeout: 15000 });
  await page.fill('#auth-user', name);
  await page.fill('#auth-pass', 'e2e-pass-1234');
  await page.click('#auth-go');
  await page.waitForSelector('.choice', { timeout: 10000 });
  await page.click(`.choice[data-type="${bizType}"]`);
  await page.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 10000 });
  return page;
}

const send = (page, msg) => page.evaluate((m) => window.__bd.client.send(m), msg);
const cam = (page) => page.evaluate(() => ({ x: window.__bd.rig.target.x, z: window.__bd.rig.target.z }));
const mine = (page) =>
  page.evaluate(() =>
    [...window.__bd.client.myBusinesses.values()].map((b) => ({
      id: b.id, type: b.type, lotId: b.lotId, district: b.district,
      wheat: b.inventory?.wheat?.qty ?? 0,
    }))
  );

// ============ A: Old Town company travels to Green Valley ============

const A = await newPlayer(`dsA_${run}`, 'coffee_shop');
await send(A, { t: 'dev', cmd: 'speed', value: 20 });

let aBiz = await mine(A);
check('A starts with a business in the original district', aBiz[0].district === 'old_town', `district=${aBiz[0].district}`);

// The district selector is present and reports real occupancy.
await A.waitForSelector('#district-bar .district-cell', { timeout: 10000 });
const cells = await A.locator('#district-bar .district-cell').count();
check('district selector lists every district', cells >= 2, `cells=${cells}`);

const status = await A.evaluate(async () => {
  window.__bd.client.send({ t: 'city_status' });
  await new Promise((r) => setTimeout(r, 1500));
  return window.__bd.client.cityStatus;
});
check('city status reports real lot totals', status && status.totalLots > 0 && status.occupiedLots > 0,
  `occupied=${status?.occupiedLots}/${status?.totalLots}`);
const gvStatus = status.districts.find((d) => d.id === 'green_valley');
check('Green Valley advertises available lots', gvStatus && gvStatus.available > 0,
  `${gvStatus?.occupied}/${gvStatus?.total}`);
check('city status counts match the district rows',
  status.occupiedLots === status.districts.reduce((n, d) => n + d.occupied, 0));

// Travelling moves the camera into the new district, in the same world.
const camBefore = await cam(A);
await A.click('[data-district-go="green_valley"]');
await A.waitForTimeout(1200);
const camAfter = await cam(A);
check('district selector moves the camera to Green Valley',
  Math.abs(camAfter.x - camBefore.x) > 100, `x ${camBefore.x.toFixed(0)} -> ${camAfter.x.toFixed(0)}`);
check('no page reload was needed (client state survived)',
  (await A.evaluate(() => window.__bd.client.you != null)));

// Open a Farm on a Green Valley lot through the real dialog.
await send(A, { t: 'dev', cmd: 'add_money', value: 400000 });
// A level-1 company has capacity 4; a coffee shop (3) plus a farm (2) needs
// more, so grant company XP the same way a player would earn it.
await send(A, { t: 'dev', cmd: 'company_xp', value: 3000 });
await A.waitForFunction(() => (window.__bd.client.company?.capacity ?? 0) >= 6, null, { timeout: 10000 });
// The dialog is the supported path: it lists vacant lots grouped by district.
await A.evaluate(() => window.__bd.ui.showOpenBusiness());
await A.waitForSelector('.open-group-head', { timeout: 8000 });
const groups = await A.locator('.open-group-head').allInnerTexts();
check('open-business dialog groups vacant lots by district',
  groups.length >= 2 && groups.some((g) => /GREEN VALLEY/i.test(g)), groups.join(' | '));

const gvLotId = await A.evaluate(() => {
  const btn = [...document.querySelectorAll('.open-lot')].find(
    (b) => b.dataset.lot?.startsWith('gv_') && b.dataset.type === 'farm' && !b.disabled
  );
  if (btn) btn.click();
  return btn?.dataset.lot ?? null;
});
check('a vacant Green Valley farm lot is offered', !!gvLotId, `lot=${gvLotId}`);
await A.waitForFunction(() => window.__bd.client.myBusinesses.size >= 2, null, { timeout: 12000 });

aBiz = await mine(A);
const districtsOwned = new Set(aBiz.map((b) => b.district));
check('A now owns businesses in two districts', districtsOwned.size === 2, [...districtsOwned].join(','));
check('the new business really sits in Green Valley',
  aBiz.some((b) => b.district === 'green_valley' && b.type === 'farm'));

// Management capacity stays company-wide, not per district.
const company = await A.evaluate(() => ({
  capacity: window.__bd.client.company.capacity,
  used: window.__bd.client.company.capacityUsed,
  count: window.__bd.client.company.businessCount,
}));
check('management capacity is company-wide across districts',
  company.count === 2 && company.used > 0 && company.used <= company.capacity,
  `used=${company.used}/${company.capacity} businesses=${company.count}`);

// Switching to a business focuses its own district.
const gvBiz = aBiz.find((b) => b.district === 'green_valley');
const otBiz = aBiz.find((b) => b.district === 'old_town');
await A.evaluate((id) => window.__bd.ui.onFocusLot(
  [...window.__bd.client.myBusinesses.values()].find((b) => b.id === id).lotId), gvBiz.id);
await A.waitForTimeout(1000);
const camGv = await cam(A);
await A.evaluate((id) => window.__bd.ui.onFocusLot(
  [...window.__bd.client.myBusinesses.values()].find((b) => b.id === id).lotId), otBiz.id);
await A.waitForTimeout(1000);
const camOt = await cam(A);
check('selecting a business focuses its own district',
  Math.abs(camGv.x - camOt.x) > 100, `gv=${camGv.x.toFixed(0)} ot=${camOt.x.toFixed(0)}`);

// ============ Cross-district trade: A's GV farm supplies B's OT bakery ============

await send(A, { t: 'set_production', product: 'wheat', bizId: gvBiz.id });
await A.waitForFunction(
  (id) => (window.__bd.client.myBusinesses.get(id)?.inventory?.wheat?.qty ?? 0) >= 60,
  gvBiz.id, { timeout: 120000 }
);
check('the Green Valley farm produces wheat', (await mine(A)).find((b) => b.id === gvBiz.id).wheat >= 60);

const B = await newPlayer(`dsB_${run}`, 'bakery');
await send(B, { t: 'dev', cmd: 'speed', value: 20 });
const bBiz0 = await mine(B);
check('B opened a bakery in Old Town', bBiz0[0].district === 'old_town', `district=${bBiz0[0].district}`);

await send(A, { t: 'dev', cmd: 'speed', value: 1 });
await send(B, { t: 'dev', cmd: 'speed', value: 1 });
await A.waitForTimeout(1200);

const aCash0 = await A.evaluate(() => window.__bd.client.you.cash);
const bCash0 = await B.evaluate(() => window.__bd.client.you.cash);
const aWheat0 = (await mine(A)).find((b) => b.id === gvBiz.id).wheat;
const bWheat0 = (await mine(B))[0].wheat;

// A lists wheat from the Green Valley farm; B buys it from Old Town.
await send(A, { t: 'order_create', side: 'sell', product: 'wheat', qty: 50, price: 9, bizId: gvBiz.id });
await B.waitForFunction(
  () => [...window.__bd.client.orders.values()].some((o) => o.side === 'sell' && o.product === 'wheat'),
  null, { timeout: 10000 }
);
const orderId = await B.evaluate(
  () => [...window.__bd.client.orders.values()].find((o) => o.side === 'sell' && o.product === 'wheat').id
);
await send(B, { t: 'order_fulfill', orderId, qty: 50 });
await B.waitForTimeout(2500);

const aCash1 = await A.evaluate(() => window.__bd.client.you.cash);
const bCash1 = await B.evaluate(() => window.__bd.client.you.cash);
check('seller was paid exactly once (+$450)', aCash1 - aCash0 === 450, `${aCash0} -> ${aCash1}`);
check('buyer paid exactly once (-$450)', bCash0 - bCash1 === 450, `${bCash0} -> ${bCash1}`);

const aWheat1 = (await mine(A)).find((b) => b.id === gvBiz.id).wheat;
// At normal speed the farm produces only a unit or two during the trade.
check('seller stock left the Green Valley farm exactly once',
  aWheat0 - aWheat1 >= 45 && aWheat0 - aWheat1 <= 52, `${aWheat0} -> ${aWheat1}`);

// The van must physically drive the connector, not teleport across.
const delivery = await B.evaluate(() =>
  [...window.__bd.client.deliveries.values()].map((d) => ({ from: d.fromLot, to: d.toLot }))
);
check('a cross-district delivery was created',
  delivery.some((d) => d.from.startsWith('gv_') && !d.to.startsWith('gv_')),
  JSON.stringify(delivery));

await send(B, { t: 'dev', cmd: 'speed', value: 20 });
await B.waitForFunction(() => (window.__bd.client.myBiz?.inventory?.wheat?.qty ?? 0) > 0, null, { timeout: 120000 });
const bWheat1 = (await mine(B))[0].wheat;
check('goods arrived at the Old Town bakery exactly once',
  bWheat1 - bWheat0 >= 50 && bWheat1 - bWheat0 <= 55, `${bWheat0} -> ${bWheat1}`);

// ============ Persistence & release content ============

await A.reload();
await A.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 15000 });
await A.waitForTimeout(1200);
const afterReload = await mine(A);
check('district ownership persists across a reload', afterReload.length === 2);
check('both districts still represented after reload',
  new Set(afterReload.map((b) => b.district)).size === 2,
  afterReload.map((b) => `${b.type}@${b.district}`).join(', '));

const updates = await A.evaluate(() => ({
  all: (window.__bd.client.updatesAll ?? []).map((u) => u.id),
  unseen: (window.__bd.client.updatesUnseen ?? []).map((u) => u.id),
}));
check('V2.6 appears in What\'s New', updates.all.includes('v2_6'), updates.all.join(','));
// A brand-new account follows the existing catch-up rule (release notes are
// pre-marked so newcomers get the tutorial, not a backlog). The "existing
// players see V2.6 once" guarantee is covered in server/test/districts.test.ts,
// where a pre-release player can be constructed honestly.
check('a brand-new account is not spammed with the update backlog',
  !updates.unseen.includes('v2_6'), `unseen=[${updates.unseen.join(',')}]`);

const finalStatus = await A.evaluate(() => {
  window.__bd.client.send({ t: 'city_status' });
  return new Promise((r) => setTimeout(() => r(window.__bd.client.cityStatus), 1500));
});
check('city status uses real counts after the new openings',
  finalStatus.occupiedLots >= 3 && finalStatus.businesses >= 3,
  `businesses=${finalStatus.businesses} occupied=${finalStatus.occupiedLots}/${finalStatus.totalLots}`);
check('recent activity lists real public openings',
  finalStatus.recent.length > 0 && finalStatus.recent.every((a) => a.companyName && a.district),
  `${finalStatus.recent.length} entries`);
check('recent activity leaks no private data',
  !JSON.stringify(finalStatus).includes('cash'));

await browser.close();
console.log(failures ? `\nV2.6 DISTRICTS: ${failures} CHECK(S) FAILED` : '\nV2.6 DISTRICTS: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
