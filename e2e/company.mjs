// BUSINESS DISTRICT — V2.1 company & multi-business E2E.
//
// One browser context walks the full V2.1 flow:
//   1. Register as a Farm  -> a company is auto-created, MY BUSINESSES shows 1
//   2. Unlock capacity + cash via dev tools, OPEN a Bakery through the UI
//   3. MY BUSINESSES now shows BOTH businesses; switch between them
//   4. Reload the page (server restart-equivalent): both businesses persist
//   5. Attempt to open a business that EXCEEDS capacity -> rejected, no cash lost
//
// Prerequisites: dev stack running with dev tools (npm run dev), Chromium
// available. Fresh account per run. Run: npm run e2e:company
//
// Capacity model (shared/defs): farm=2, bakery=3; company L1 cap=4, L2 cap=6.
// So farm(2)+bakery(3)=5 needs company level 2; a 3rd business would need 7 > 6.

import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';

let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const health = await fetch(`${SERVER_URL}/api/health`);
  if (!health.ok) throw new Error(String(health.status));
} catch {
  console.error(`Server not reachable at ${SERVER_URL}. Start the stack first: npm run dev`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;
const name = `co_${run}`;
const PASS = 'e2e-pass-1234';

const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`PAGEERROR: ${e.message}`));

const send = (msg) => page.evaluate((m) => window.__bd.client.send(m), msg);
const state = () =>
  page.evaluate(() => {
    const c = window.__bd.client;
    return {
      cash: c.you?.cash,
      companyName: c.company?.name,
      companyLevel: c.company?.level,
      capacity: c.company?.capacity,
      capacityUsed: c.company?.capacityUsed,
      businessCount: c.company?.businessCount,
      selectedBizId: c.selectedBizId,
      myBizIds: [...c.myBusinesses.keys()],
      myBizTypes: [...c.myBusinesses.values()].map((b) => b.type).sort(),
    };
  });

// ---------- 1. register as Farm; company auto-created ----------
await page.goto(CLIENT_URL);
await page.waitForSelector('#auth-user', { timeout: 15000 });
await page.fill('#auth-user', name);
await page.fill('#auth-pass', PASS);
await page.click('#auth-go');
await page.waitForSelector('.choice', { timeout: 10000 });
await page.click('.choice[data-type="farm"]');
await page.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 10000 });
await page.waitForFunction(() => window.__bd.client.myBusinesses.size === 1, { timeout: 10000 });

let s = await state();
check('company auto-created for new player', !!s.companyName, `name=${s.companyName}`);
check('MY BUSINESSES shows 1 business', s.businessCount === 1 && s.myBizTypes.join() === 'farm');
check('company starts at level 1 (capacity 4)', s.companyLevel === 1 && s.capacity === 4, `lvl=${s.companyLevel} cap=${s.capacity}`);
check('farm consumes 2 capacity', s.capacityUsed === 2, `used=${s.capacityUsed}`);
// The company bar chip is visible in the DOM.
const chips1 = await page.$$eval('.biz-chip[data-biz-chip]', (els) => els.length);
check('company bar renders 1 business chip', chips1 === 1, `chips=${chips1}`);

// ---------- 2. unlock capacity + cash, open a Bakery via the UI ----------
await send({ t: 'dev', cmd: 'add_money', value: 30000 });
await send({ t: 'dev', cmd: 'company_xp', value: 800 }); // -> company level 2, cap 6
await page.waitForFunction(() => window.__bd.client.company.level >= 2, { timeout: 8000 });

// Open the new-business overlay from the company bar and pick a bakery lot.
await page.click('#co-open');
await page.waitForSelector('#open-overlay', { timeout: 8000 });
await page.click('.open-lot[data-type="bakery"]:not(.disabled)');
await page.waitForFunction(() => window.__bd.client.myBusinesses.size === 2, { timeout: 10000 });

s = await state();
check('MY BUSINESSES shows BOTH businesses', s.businessCount === 2 && s.myBizTypes.join() === 'bakery,farm', s.myBizTypes.join());
check('capacity used is farm(2)+bakery(3)=5', s.capacityUsed === 5, `used=${s.capacityUsed}`);
check('opening the bakery deducted the $15000 cost', s.cash === 30000 + 10000 - 15000, `cash=${s.cash}`);
const chips2 = await page.$$eval('.biz-chip[data-biz-chip]', (els) => els.length);
check('company bar renders 2 business chips', chips2 === 2, `chips=${chips2}`);

// ---------- 3. switch the active business via the switcher ----------
const bakeryId = await page.evaluate(
  () => [...window.__bd.client.myBusinesses.values()].find((b) => b.type === 'bakery').id
);
await page.click(`.biz-chip[data-biz-chip="${bakeryId}"]`);
await page.waitForFunction(
  (id) => window.__bd.client.selectedBizId === id,
  bakeryId,
  { timeout: 8000 }
);
s = await state();
check('switching selects the bakery as the active business', s.selectedBizId === bakeryId);
// The business panel now reflects the bakery.
const panelIsBakery = await page.evaluate(() => window.__bd.client.myBiz.type === 'bakery');
check('management panel follows the selected business', panelIsBakery);

// ---------- 4. reload (restart-equivalent): both businesses persist ----------
await sleep(1500); // let the server flush the new business to the DB
await page.reload();
await page.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 15000 });
await page.waitForFunction(() => window.__bd.client.myBusinesses.size === 2, { timeout: 10000 });
s = await state();
check('both businesses persist after reload', s.businessCount === 2 && s.myBizTypes.join() === 'bakery,farm', s.myBizTypes.join());
check('company level/capacity persist after reload', s.companyLevel === 2 && s.capacity === 6, `lvl=${s.companyLevel} cap=${s.capacity}`);

// ---------- 5. attempt to exceed capacity -> rejected, no cash lost ----------
const cashBefore = (await state()).cash;
// used=5, cap=6; any additional business (min farm=2) needs 7 > 6.
const vacantFarm = await page.evaluate(() => {
  const c = window.__bd.client;
  const taken = new Set([...c.businesses.values()].map((b) => b.lotId));
  const ids = ['farm_1', 'farm_2', 'farm_3', 'farm_4', 'farm_5', 'farm_6'];
  return ids.find((id) => !taken.has(id));
});
await send({ t: 'open_business', lotId: vacantFarm, type: 'farm' });
await sleep(1200);
s = await state();
check('capacity-exceeding open is rejected (still 2 businesses)', s.businessCount === 2, `count=${s.businessCount}`);
check('no cash lost on the rejected open', s.cash === cashBefore, `cash=${s.cash}, before=${cashBefore}`);

await browser.close();
console.log(failures === 0 ? '\nV2.1 COMPANY: ALL CHECKS PASSED' : `\nV2.1 COMPANY: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
