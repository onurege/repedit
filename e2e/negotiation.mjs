// BUSINESS DISTRICT — V2.7 Phase 3 Direct Messaging & Negotiation E2E.
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:negotiation
//
// Two real browsers negotiate a deal THROUGH THE REAL IN-GAME UI (no native
// dialogs, no offer_create/offer_counter/offer_accept shortcuts): open the
// Messages panel -> Teklif Ver -> the offer modal -> counter (same modal,
// prefilled) -> accept. Verifies money/stock/delivery move exactly once, the
// modal validates bad input, a duplicate accept is rejected, history persists
// across reload, and the storage invariant holds near capacity.
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
  // Dismiss any auto-shown modal (Morning Brief / What's New) so it can't
  // intercept later clicks.
  await page.waitForTimeout(700);
  await dismissModals(page);
  return page;
}
async function dismissModals(page) {
  for (let i = 0; i < 3; i++) {
    const btn = await page.$('#brief-close, #brief-go, #wn-ok');
    if (!btn) break;
    await btn.click().catch(() => {});
    await page.waitForTimeout(250);
  }
}
const send = (p, m) => p.evaluate((x) => window.__bd.client.send(x), m);
const cash = (p) => p.evaluate(() => window.__bd.client.you.cash);

// ---- Real-UI helpers (drive the DOM, never the offer_* wire messages) ----
async function openConversation(page, otherId) {
  await page.click('#nav-messages');
  await page.waitForTimeout(400);
  // If a thread is already open, step back to the conversation list first.
  if (await page.$('#dm-back')) { await page.click('#dm-back'); await page.waitForTimeout(300); }
  await page.waitForSelector(`[data-open-conv="${otherId}"]`, { timeout: 8000 });
  await page.click(`[data-open-conv="${otherId}"]`);
  await page.waitForSelector('#dm-offer', { timeout: 8000 });
}
async function createOfferUI(page, { side, product, qty, price, expMin }) {
  await page.click('#dm-offer');
  await page.waitForSelector('#offer-overlay', { timeout: 8000 });
  await page.click(`#offer-overlay [data-side="${side}"]`);
  await page.click(`#offer-overlay [data-prod="${product}"]`);
  await page.fill('#offer-qty', String(qty));
  await page.fill('#offer-price', String(price));
  await page.click(`#offer-overlay [data-exp="${expMin}"]`);
  await page.click('#offer-submit');
  await page.waitForSelector('#offer-overlay', { state: 'detached', timeout: 8000 });
}
async function counterOfferUI(page, { price }) {
  await page.waitForSelector('[data-offer-counter]', { timeout: 8000 });
  await page.click('[data-offer-counter]');
  await page.waitForSelector('#offer-overlay', { timeout: 8000 });
  await page.fill('#offer-price', String(price));
  await page.click('#offer-submit');
  await page.waitForSelector('#offer-overlay', { state: 'detached', timeout: 8000 });
}
async function acceptOfferUI(page) {
  await page.waitForSelector('[data-offer-accept]', { timeout: 8000 });
  await page.click('[data-offer-accept]');
}

// A = farm (milk seller), B = coffee shop (milk buyer).
const A = await player(`ngA_${run}`, 'farm');
const B = await player(`ngB_${run}`, 'bakery');
await send(A, { t: 'set_production', product: 'milk' }); // keep wheat stock fixed during the deal
await send(A, { t: 'dev', cmd: 'speed', value: 20 });
await send(A, { t: 'dev', cmd: 'add_wheat', value: 200 });
await send(B, { t: 'dev', cmd: 'add_money', value: 100000 });
await B.waitForTimeout(500);

const aId = await B.evaluate((n) => window.__bd.client.players.find((p) => p.name === n)?.id, `ngA_${run}`);
const bId = await A.evaluate((n) => window.__bd.client.players.find((p) => p.name === n)?.id, `ngB_${run}`);

// 1) B opens a DM to A and sends a message; A receives it in realtime.
await send(B, { t: 'dm_send', toId: aId, body: 'Need 100 wheat — deal?' });
await A.waitForTimeout(600);

// 2) B creates a BUY offer for 100 milk @ 6 THROUGH THE MODAL UI.
await openConversation(B, aId);
// Validation: quantity 0 disables the submit button (no alert, inline error).
await B.click('#dm-offer');
await B.waitForSelector('#offer-overlay', { timeout: 8000 });
await B.click('#offer-overlay [data-side="buy"]');
await B.click('#offer-overlay [data-prod="wheat"]');
await B.fill('#offer-qty', '0');
await B.waitForTimeout(200);
check('modal disables submit on invalid quantity', await B.evaluate(() => document.querySelector('#offer-submit')?.disabled === true));
await B.fill('#offer-price', '0');
await B.waitForTimeout(150);
check('modal disables submit on invalid price', await B.evaluate(() => document.querySelector('#offer-submit')?.disabled === true));
// Close and re-create cleanly with valid values.
await B.keyboard.press('Escape');
await B.waitForSelector('#offer-overlay', { state: 'detached', timeout: 5000 });
await createOfferUI(B, { side: 'buy', product: 'wheat', qty: 100, price: 6, expMin: 10 });
await A.waitForFunction(() => [...window.__bd.client.offers.values()].some((o) => o.status === 'pending' && o.awaitingPlayer === window.__bd.client.you.id), null, { timeout: 8000 });
check('A receives the BUY offer created via the modal and can act', await A.evaluate(() => [...window.__bd.client.offers.values()].some((o) => o.canAct)));
const offerId = await A.evaluate(() => [...window.__bd.client.offers.values()].find((o) => o.canAct).id);

// 3) A counters to @9 via the SAME modal (counter mode, prefilled).
await openConversation(A, bId);
await counterOfferUI(A, { price: 9 });
await B.waitForFunction((id) => window.__bd.client.offers.get(id)?.canAct === true && window.__bd.client.offers.get(id)?.price === 9, offerId, { timeout: 8000 });
check('B receives the counter (price 9) and can act', await B.evaluate((id) => window.__bd.client.offers.get(id).canAct && window.__bd.client.offers.get(id).price === 9, offerId));

// 4) B accepts the counter via the offer card. Money + stock move exactly once.
const bCash0 = await cash(B); const aCash0 = await cash(A);
const aMilk0 = await A.evaluate(() => window.__bd.client.myBiz.inventory.wheat.qty);
await openConversation(B, aId);
await acceptOfferUI(B);
await B.waitForFunction((id) => window.__bd.client.offers.get(id)?.status === 'accepted', offerId, { timeout: 8000 });
const amount = 100 * 9;
check('buyer charged exactly once', (await cash(B)) === bCash0 - amount, `${bCash0} -> ${await cash(B)}`);
check('seller paid exactly once', (await cash(A)) === aCash0 + amount, `${aCash0} -> ${await cash(A)}`);
check('seller stock left once', (await A.evaluate(() => window.__bd.client.myBiz.inventory.wheat.qty)) === aMilk0 - 100, `${aMilk0}`);
const del = await B.evaluate(() => [...window.__bd.client.deliveries.values()].some((d) => d.product === 'wheat'));
check('a delivery was created for the accepted deal', del);

// 5) Duplicate acceptance is rejected (no second charge). The card is gone from
//    the UI, so this idempotency guard is exercised at the protocol level.
const bCashAfter = await cash(B);
const accVer = await B.evaluate((id) => window.__bd.client.offers.get(id)?.version ?? 1, offerId);
await send(B, { t: 'offer_accept', offerId, version: accVer });
await B.waitForTimeout(1000);
check('duplicate accept does not charge again', (await cash(B)) === bCashAfter);

// 6) Reload both; conversation + accepted offer persist.
for (const P of [A, B]) { await P.reload(); await P.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 }); await P.waitForTimeout(700); await dismissModals(P); }
await send(B, { t: 'get_conversation', otherId: aId });
await B.waitForFunction((id) => window.__bd.client.activeConv?.offers.some((o) => o.id === id && o.status === 'accepted'), offerId, { timeout: 8000 });
check('history persists after reload (accepted deal visible)', await B.evaluate((id) => window.__bd.client.activeConv.offers.some((o) => o.id === id && o.status === 'accepted'), offerId));

// 7) Storage guard: fill B near capacity, offer more than fits -> accept rejected, no overflow.
await send(A, { t: 'dev', cmd: 'add_wheat', value: 300 });
const cap = await B.evaluate(() => window.__bd.client.myBiz.inventory.wheat.capacity);
await send(B, { t: 'dev', cmd: 'make_admin' });
await B.waitForFunction(() => window.__bd.client.you.isAdmin === true, null, { timeout: 8000 });
const bBizId = await B.evaluate(() => window.__bd.client.myBiz.id);
await send(B, { t: 'admin_inventory', bizId: bBizId, product: 'wheat', op: 'set', amount: cap - 10 }); // 10 free
await B.waitForFunction((c) => window.__bd.client.myBiz.inventory.wheat.qty >= c - 11, cap, { timeout: 8000 });
// B proposes a BUY of 100 (won't fit its 10 free) via the modal.
await openConversation(B, aId);
await createOfferUI(B, { side: 'buy', product: 'wheat', qty: 100, price: 5, expMin: 10 });
await A.waitForFunction(() => [...window.__bd.client.offers.values()].some((o) => o.canAct && o.qty === 100 && o.price === 5), null, { timeout: 8000 });
const o2 = await A.evaluate(() => [...window.__bd.client.offers.values()].find((o) => o.canAct && o.qty === 100 && o.price === 5).id);
// A accepts via the card; the server must refuse (storage) and never overflow.
await openConversation(A, bId);
await acceptOfferUI(A);
await A.waitForTimeout(1200);
const milkNow = await B.evaluate(() => window.__bd.client.myBiz.inventory.wheat);
check('over-capacity accept did not overflow storage', milkNow.qty + milkNow.reserved <= milkNow.capacity, `${milkNow.qty}+${milkNow.reserved}/${milkNow.capacity}`);
check('over-capacity offer was not accepted', await A.evaluate((id) => window.__bd.client.offers.get(id)?.status !== 'accepted', o2));

await browser.close();
console.log(failures ? `\nV2.7 NEGOTIATION: ${failures} CHECK(S) FAILED` : '\nV2.7 NEGOTIATION: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
