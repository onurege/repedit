// BUSINESS DISTRICT — V2.3 dynamic demand & city events E2E.
//
// One bakery experiences a City Festival driven entirely through the real
// event system (dev controls only schedule/advance time — they never fake
// demand or sales). We verify the full loop:
//   1. baseline bread sales rate (no event)
//   2. a City Festival is announced (UPCOMING) with Bread +40%
//   3. time advances -> event becomes ACTIVE, demand shows HIGH
//   4. the same bakery now sells MORE bread to NPC customers
//   5. real final_sale activity is recorded (Market Share updates)
//   6. the event ends -> demand returns to NORMAL
//
// Prereqs: dev stack with dev tools (npm run dev), Chromium. Run: npm run e2e:events

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

const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`PAGEERROR: ${e.message}`));
const send = (msg) => page.evaluate((m) => window.__bd.client.send(m), msg);
const market = () => page.evaluate(() => window.__bd.client.cityMarket);
const sold = () => page.evaluate(() => window.__bd.client.myBiz?.coffeeSold ?? 0);

async function measure(seconds) {
  const before = await sold();
  await sleep(seconds * 1000);
  return (await sold()) - before;
}

// ---------- register a bakery, stock bread, speed up ----------
await page.goto(CLIENT_URL);
await page.waitForSelector('#auth-user', { timeout: 15000 });
await page.fill('#auth-user', `evt_${run}`);
await page.fill('#auth-pass', 'e2e-pass-1234');
await page.click('#auth-go');
await page.waitForSelector('.choice', { timeout: 10000 });
await page.click('.choice[data-type="bakery"]');
await page.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 10000 });
await send({ t: 'dev', cmd: 'speed', value: 20 });
await send({ t: 'dev', cmd: 'add_bread', value: 8000 }); // demand, not baking, is the limiter
await sleep(1200);

// ---------- 1. baseline (no event) ----------
await page.waitForFunction(() => window.__bd.client.cityMarket != null, { timeout: 8000 });
const m0 = await market();
check('starts with calm market (no active events)', m0.active.length === 0, `active=${m0.active.length}`);
const baseSold = await measure(10);
check('baseline bread sales recorded', baseSold > 0, `base=${baseSold}`);

// ---------- 2. announce a City Festival (UPCOMING) ----------
await send({ t: 'dev', cmd: 'event_festival', value: 6 }); // starts in ~6s
await page.waitForFunction(
  () => (window.__bd.client.cityMarket?.upcoming ?? []).some((e) => e.type === 'city_festival'),
  { timeout: 8000 }
);
const mUp = await market();
const up = mUp.upcoming.find((e) => e.type === 'city_festival');
check('City Festival announced as UPCOMING', !!up);
check('announced effect is Bread +40%', up.effects.demand.bread === 0.4, `bread=${up.effects.demand.bread}`);
// UI shows it.
await page.click('#nav-citymarket');
await page.waitForSelector('.event-card.upcoming', { timeout: 6000 });
const uiUpcoming = await page.$$eval('.event-card.upcoming .ev-name', (els) => els.map((e) => e.textContent).join('|'));
check('City Market panel shows the upcoming festival', /Festival/i.test(uiUpcoming), uiUpcoming);

// ---------- 3. advance time -> ACTIVE ----------
await send({ t: 'dev', cmd: 'advance_events', value: 10 });
await page.waitForFunction(
  () => (window.__bd.client.cityMarket?.active ?? []).some((e) => e.type === 'city_festival'),
  { timeout: 8000 }
);
const mAct = await market();
const bread = mAct.demand.find((d) => d.product === 'bread');
check('festival is now ACTIVE', mAct.active.some((e) => e.type === 'city_festival'));
check('bread demand shows HIGH', bread.category === 'high', `cat=${bread.category}`);
check('bread demand delta is +40%', Math.abs(bread.delta - 0.4) < 1e-6, `delta=${bread.delta}`);

// ---------- 4. demand increases real NPC sales ----------
const eventSold = await measure(10);
check('bakery sells more bread during the festival', eventSold > baseSold, `event=${eventSold} base=${baseSold}`);

// ---------- 5. real final_sale activity feeds Market Share ----------
const cid = await page.evaluate(() => window.__bd.client.company.id);
const prof = await page.evaluate((c) => new Promise((resolve) => {
  const cl = window.__bd.client;
  const on = (p) => { if (p.id === c) resolve(p); };
  cl.on('company_profile', on);
  cl.send({ t: 'get_company_profile', companyId: c });
}), cid);
const share = prof.marketShares.find((s) => s.product === 'bread');
check('Market Share reflects real festival-driven bread sales', !!share && share.units >= eventSold, `units=${share?.units}`);

// ---------- 6. event ends -> demand returns to NORMAL ----------
await send({ t: 'dev', cmd: 'advance_events', value: 260 }); // past the festival's end
await page.waitForFunction(
  () => !(window.__bd.client.cityMarket?.active ?? []).some((e) => e.type === 'city_festival'),
  { timeout: 8000 }
);
const mEnd = await market();
const breadEnd = mEnd.demand.find((d) => d.product === 'bread');
check('festival is no longer active', !mEnd.active.some((e) => e.type === 'city_festival'));
check('bread demand returns to NORMAL', breadEnd.category === 'normal' && Math.abs(breadEnd.delta) < 1e-6, `cat=${breadEnd.category} delta=${breadEnd.delta}`);

await browser.close();
console.log(failures === 0 ? '\nV2.3 EVENTS: ALL CHECKS PASSED' : `\nV2.3 EVENTS: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
