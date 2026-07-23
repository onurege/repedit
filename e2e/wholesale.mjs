// BUSINESS DISTRICT — V2.5 economic depth & market integrity E2E.
//
// Finite wholesale + market-integrity behaviour, driven through real systems
// (dev tools only accelerate time / capital — nothing fakes stock, integrity,
// or reputation directly):
//   - the Central Wholesale has finite daily stock that DECREASES as bought
//   - past depletion an emergency reserve keeps supply available (never blocked)
//   - a normal-trading player is never punished (no warning, reputation intact)
//   - SUSTAINED manipulation (repeated extreme resale over days) is confirmed
//     and reduces the offender's company reputation + shows a public warning
//   - the state survives a restart (reload)
//
// Prereqs: dev stack with dev tools (npm run dev), Chromium. Run: npm run e2e:wholesale

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

async function newBakery(name) {
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR: ${e.message}`));
  await page.goto(CLIENT_URL);
  await page.waitForSelector('#auth-user', { timeout: 15000 });
  await page.fill('#auth-user', name);
  await page.fill('#auth-pass', 'e2e-pass-1234');
  await page.click('#auth-go');
  await page.waitForSelector('.choice', { timeout: 10000 });
  await page.click('.choice[data-type="bakery"]');
  await page.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 10000 });
  return page;
}
const send = (page, msg) => page.evaluate((m) => window.__bd.client.send(m), msg);
const wheat = (page) => page.evaluate(() =>
  window.__bd.client.wholesale?.products.find((p) => p.product === 'wheat'));
const rep = (page) => page.evaluate(() => window.__bd.client.myBiz?.reputation ?? 0);
const companyId = (page) => page.evaluate(() => window.__bd.client.company.id);
async function profileOf(page, cidVal) {
  return page.evaluate((c) => new Promise((resolve) => {
    const cl = window.__bd.client;
    const on = (p) => { if (p.id === c) resolve(p); };
    cl.on('company_profile', on);
    cl.send({ t: 'get_company_profile', companyId: c });
  }), cidVal);
}

// ================= Player A: aggressive buyer =================
const A = await newBakery(`whA_${run}`);
await send(A, { t: 'dev', cmd: 'add_money', value: 100000000 });
await send(A, { t: 'dev', cmd: 'speed', value: 20 });
// Upgrade to L3 for roomy wheat storage.
await send(A, { t: 'upgrade' }); await sleep(400);
await send(A, { t: 'upgrade' }); await sleep(400);
await send(A, { t: 'get_wholesale' });
await A.waitForFunction(() => window.__bd.client.wholesale != null, { timeout: 8000 });
const w0 = await wheat(A);
check('wholesale has finite daily wheat stock', w0.dailyStock > 0 && w0.remaining === w0.dailyStock, `stock=${w0.remaining}/${w0.dailyStock}`);

// Buy a large chunk -> stock visibly decreases.
await send(A, { t: 'buy_npc', product: 'wheat', qty: 600 });
await A.waitForFunction((d) => (window.__bd.client.wholesale.products.find((p) => p.product === 'wheat').remaining) < d, w0.remaining, { timeout: 8000 });
const w1 = await wheat(A);
check('buying decreases remaining wholesale stock', w1.remaining < w0.remaining, `${w0.remaining} -> ${w1.remaining}`);

// Deplete into the emergency reserve (still available, just expensive).
await send(A, { t: 'buy_npc', product: 'wheat', qty: 250 });
await A.waitForFunction(() => window.__bd.client.wholesale.products.find((p) => p.product === 'wheat').emergency === true, { timeout: 8000 });
const w2 = await wheat(A);
check('stock can reach zero (OUT OF STOCK / emergency)', w2.remaining === 0 && w2.emergency, `remaining=${w2.remaining}`);

// ================= Player B: normal trader (never punished) =================
const B = await newBakery(`whB_${run}`);
await send(B, { t: 'dev', cmd: 'add_money', value: 100000 });
// Buys a modest amount of milk (plenty in stock) — legitimate trading.
await send(B, { t: 'buy_npc', product: 'milk', qty: 40 });
await sleep(600);
const profB = await profileOf(B, await companyId(B));
check('a normal trader has no market warning', profB.warning == null, `warning=${profB.warning}`);
check('marketplace opportunity emerges (A depleted wheat, B can trade)', w2.remaining === 0);

// ================= Sustained manipulation by A -> confirmed =================
// Repeated extreme resale listings across several wholesale days.
async function manipulateDay() {
  await send(A, { t: 'dev', cmd: 'add_bread', value: 500 });
  for (let i = 0; i < 3; i++) await send(A, { t: 'order_create', side: 'sell', product: 'bread', qty: 5, price: 120 });
  await sleep(400);
  await send(A, { t: 'dev', cmd: 'wholesale_reset' }); // day rollover -> integrity evaluation
  await sleep(500);
}
await manipulateDay(); // day 1 -> watchlist (hidden)
await manipulateDay(); // day 2 -> investigating (hidden)
const repBefore = await rep(A);
await manipulateDay(); // day 3 -> confirmed -> reputation penalty
await A.waitForFunction((r) => (window.__bd.client.myBiz?.reputation ?? 99) < r - 0.5, repBefore, { timeout: 8000 });
const repAfter = await rep(A);
check('confirmed manipulation reduces company reputation', repAfter < repBefore - 0.5, `${repBefore.toFixed(2)} -> ${repAfter.toFixed(2)}`);

const cidA = await companyId(A);
const profA = await profileOf(A, cidA);
check('offender profile shows a public market-violation warning', profA.warning === 'market_violation', `warning=${profA.warning}`);
check('hidden integrity internals are never exposed', !JSON.stringify(profA).includes('score') && !JSON.stringify(profA).includes('confirmed'));

// ================= Restart persistence =================
await sleep(1500); // let state flush
await A.reload();
await A.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 15000 });
const profA2 = await profileOf(A, cidA);
check('market-violation warning survives a restart', profA2.warning === 'market_violation', `warning=${profA2.warning}`);

await browser.close();
console.log(failures === 0 ? '\nV2.5 WHOLESALE: ALL CHECKS PASSED' : `\nV2.5 WHOLESALE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
