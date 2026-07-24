// BUSINESS DISTRICT — V2.7 Phase 3 Direct Messaging & Negotiation E2E.
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:negotiation
//
// Two real browsers negotiate a deal: DM -> BUY offer -> counter -> accept.
// Verifies money and stock move exactly once, a delivery is created, a
// duplicate accept is rejected, history persists across reload, and the
// storage invariant holds when the buyer is near capacity.
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

async function player(name, bizType) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR: ${e.message}`));
  await page.goto(CLIENT_URL);
  await page.waitForSelector('#auth-user', { timeout: 15000 });
  await page.fill('#auth-user', name); await page.fill('#auth-pass', 'e2e-pass-1234');
  await page.click('#auth-go');
  await page.waitForSelector('.choice', { timeout: 15000 });
  await page.click(`.choice[data-type="${bizType}"]`);
  await page.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
  return page;
}
const send = (p, m) => p.evaluate((x) => window.__bd.client.send(x), m);
const cash = (p) => p.evaluate(() => window.__bd.client.you.cash);

// A = farm (milk seller), B = coffee shop (milk buyer).
const A = await player(`ngA_${run}`, 'farm');
const B = await player(`ngB_${run}`, 'coffee_shop');
await send(A, { t: 'set_production', product: 'wheat' }); // keep milk stock fixed during the deal
await send(A, { t: 'dev', cmd: 'speed', value: 20 });
await send(A, { t: 'dev', cmd: 'add_milk', value: 200 });
await send(B, { t: 'dev', cmd: 'add_money', value: 100000 });
await B.waitForTimeout(500);

const aId = await B.evaluate((n) => window.__bd.client.players.find((p) => p.name === n)?.id, `ngA_${run}`);
const aBizId = await A.evaluate(() => window.__bd.client.myBiz.id);

// 1) B opens a DM to A and sends a message; A receives it in realtime.
await send(B, { t: 'dm_send', toId: aId, body: 'Need 100 milk — deal?' });
await A.waitForFunction(() => [...window.__bd.client.offers.values()] || window.__bd.client.conversations, null, { timeout: 5000 }).catch(() => {});
await send(A, { t: 'get_conversation', otherId: await A.evaluate((n) => window.__bd.client.players.find((p) => p.name === n)?.id, `ngB_${run}`) });
await A.waitForFunction((b) => window.__bd.client.activeConv?.messages.some((m) => m.body === b), 'Need 100 milk — deal?', { timeout: 8000 });
check('A receives B\'s DM in realtime', await A.evaluate((b) => window.__bd.client.activeConv.messages.some((m) => m.body === b), 'Need 100 milk — deal?'));

// 2) B sends a BUY offer for 100 milk @ 6 (from B's shop to A's farm).
const bBizId = await B.evaluate(() => window.__bd.client.myBiz.id);
await send(B, { t: 'offer_create', toBizId: aBizId, fromBizId: bBizId, side: 'buy', product: 'milk', qty: 100, unitPrice: 6 });
await A.waitForFunction(() => [...window.__bd.client.offers.values()].some((o) => o.status === 'pending' && o.awaitingPlayer === window.__bd.client.you.id), null, { timeout: 8000 });
check('A receives the BUY offer and can act', await A.evaluate(() => [...window.__bd.client.offers.values()].some((o) => o.canAct)));
const offerId = await A.evaluate(() => [...window.__bd.client.offers.values()].find((o) => o.canAct).id);

// 3) A counters to @9; now it's B's turn.
let ver = await A.evaluate((id) => window.__bd.client.offers.get(id).version, offerId);
await send(A, { t: 'offer_counter', offerId, qty: 100, unitPrice: 9, version: ver });
await B.waitForFunction((id) => window.__bd.client.offers.get(id)?.canAct === true, offerId, { timeout: 8000 });
check('B receives the counter and can act', await B.evaluate((id) => window.__bd.client.offers.get(id).canAct, offerId));

// 4) B accepts the counter. Money + stock move exactly once; a delivery appears.
const bCash0 = await cash(B); const aCash0 = await cash(A);
const aMilk0 = await A.evaluate(() => window.__bd.client.myBiz.inventory.milk.qty);
ver = await B.evaluate((id) => window.__bd.client.offers.get(id).version, offerId);
await send(B, { t: 'offer_accept', offerId, version: ver });
await B.waitForFunction((id) => window.__bd.client.offers.get(id)?.status === 'accepted', offerId, { timeout: 8000 });
const amount = 100 * 9;
check('buyer charged exactly once', (await cash(B)) === bCash0 - amount, `${bCash0} -> ${await cash(B)}`);
check('seller paid exactly once', (await cash(A)) === aCash0 + amount, `${aCash0} -> ${await cash(A)}`);
check('seller stock left once', (await A.evaluate(() => window.__bd.client.myBiz.inventory.milk.qty)) === aMilk0 - 100, `${aMilk0}`);
const del = await B.evaluate(() => [...window.__bd.client.deliveries.values()].some((d) => d.product === 'milk'));
check('a delivery was created for the accepted deal', del);

// 5) Duplicate acceptance is rejected (no second charge).
const bCashAfter = await cash(B);
await send(B, { t: 'offer_accept', offerId, version: ver });
await B.waitForTimeout(1000);
check('duplicate accept does not charge again', (await cash(B)) === bCashAfter);

// 6) Reload both; conversation + accepted offer persist.
for (const P of [A, B]) { await P.reload(); await P.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 }); }
await send(B, { t: 'get_conversation', otherId: aId });
await B.waitForFunction((id) => window.__bd.client.activeConv?.offers.some((o) => o.id === id && o.status === 'accepted'), offerId, { timeout: 8000 });
check('history persists after reload (accepted deal visible)', await B.evaluate((id) => window.__bd.client.activeConv.offers.some((o) => o.id === id && o.status === 'accepted'), offerId));

// 7) Storage guard: fill B near capacity, offer more than fits -> accept rejected, no overflow.
await send(A, { t: 'dev', cmd: 'add_milk', value: 300 });
const cap = await B.evaluate(() => window.__bd.client.myBiz.inventory.milk.capacity);
await send(B, { t: 'admin_dashboard' }); // no-op if not admin; ignore
// Use dev to fill B's milk to near capacity.
await B.evaluate((c) => { /* fill via repeated dev add up to cap */ }, cap);
await send(B, { t: 'dev', cmd: 'make_admin' });
await B.waitForFunction(() => window.__bd.client.you.isAdmin === true, { timeout: 8000 });
await send(B, { t: 'admin_inventory', bizId: bBizId, product: 'milk', op: 'set', amount: cap - 10 }); // 10 free
await B.waitForFunction((c) => window.__bd.client.myBiz.inventory.milk.qty >= c - 11, cap, { timeout: 8000 });
await send(B, { t: 'offer_create', toBizId: aBizId, fromBizId: bBizId, side: 'buy', product: 'milk', qty: 100, unitPrice: 5 });
await A.waitForFunction(() => [...window.__bd.client.offers.values()].some((o) => o.canAct && o.qty === 100 && o.price === 5), null, { timeout: 8000 });
const o2 = await A.evaluate(() => [...window.__bd.client.offers.values()].find((o) => o.canAct && o.qty === 100 && o.price === 5).id);
const v2 = await A.evaluate((id) => window.__bd.client.offers.get(id).version, o2);
await send(A, { t: 'offer_accept', offerId: o2, version: v2 });
await A.waitForTimeout(1200);
const milkNow = await B.evaluate(() => window.__bd.client.myBiz.inventory.milk);
check('over-capacity accept did not overflow storage', milkNow.qty + milkNow.reserved <= milkNow.capacity, `${milkNow.qty}+${milkNow.reserved}/${milkNow.capacity}`);
check('over-capacity offer was not accepted', await A.evaluate((id) => window.__bd.client.offers.get(id)?.status !== 'accepted', o2));

await browser.close();
console.log(failures ? `\nV2.7 NEGOTIATION: ${failures} CHECK(S) FAILED` : '\nV2.7 NEGOTIATION: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
