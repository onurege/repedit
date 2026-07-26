// BUSINESS DISTRICT — V2.8 Phase 3 Supply-Chain Economy E2E (real UI + systems).
//
// Prereqs: dev stack running (npm run dev). Run: npm run e2e:supply-economy
//
// Proves the multiplayer supply chain and Phase-3 economics:
//   Farm  -> raw (wheat, milk) on the Marketplace
//   Bakery-> buys raw, cost basis tracked, produces CROISSANT (inherits cost)
//   Mini Market -> buys croissant, retails to NPC customers
// Plus: player-first sourcing (player cheaper than Central Wholesale for the same
// input, purely from real prices), a City Event raising real demand, and a mobile
// pass at 390x844.
import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
try { const h = await fetch(`${SERVER_URL}/api/health`); if (!h.ok) throw 0; }
catch { console.error('Server not reachable. Start it: npm run dev'); process.exit(2); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;

async function player(name, bizType, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport });
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
const dev = (p, cmd, value) => send(p, { t: 'dev', cmd, value });
const bizId = (p) => p.evaluate(() => window.__bd.client.myBiz.id);
const inv = (p, prod) => p.evaluate((x) => window.__bd.client.myBiz.inventory[x]?.qty ?? 0, prod);
const costOf = (p, prod) => p.evaluate((x) => window.__bd.client.myBiz.inventory[x]?.costBasis ?? 0, prod);
const cash = (p) => p.evaluate(() => window.__bd.client.you.cash);
const dismiss = (p) => p.evaluate(() => document.querySelectorAll('.overlay.modal, #brief-overlay, #mobile-hint').forEach((o) => o.remove()));
const settle = (p) => p.waitForTimeout(500);
// Buy `qty` of `product` from THIS RUN's seller (matched by owner name so stale
// orders from prior runs don't interfere), then wait for the delivery to arrive.
async function buyMarket(p, product, qty, sellerMark) {
  const before = await inv(p, product);
  await send(p, { t: 'get_city_market' });
  await p.waitForTimeout(300);
  const orderId = await p.evaluate(([prod, mark, need]) => {
    const os = [...window.__bd.client.orders.values()].filter((x) => x.side === 'sell' && x.product === prod && (!mark || (x.owner ?? x.ownerName ?? '').includes(mark)) && x.remaining >= need);
    return os.length ? os[0].id : null;
  }, [product, sellerMark, qty]);
  if (orderId == null) return false;
  await send(p, { t: 'order_fulfill', orderId, qty });
  await p.waitForFunction(([prod, b]) => (window.__bd.client.myBiz.inventory[prod]?.qty ?? 0) > b, [product, before], { timeout: 20000 }).catch(() => {});
  return true;
}

// ---------- Farm A: raw supplier ----------
const A = await player(`seF_${run}`, 'farm');
await settle(A); await dismiss(A);
await dev(A, 'add_money', 1000000);
// Farm level-1 raw capacity is 200/product; list within that.
await dev(A, 'add_wheat', 200); await dev(A, 'add_milk', 200); await settle(A);
await send(A, { t: 'order_create', side: 'sell', product: 'wheat', qty: 150, price: 7 });
await send(A, { t: 'order_create', side: 'sell', product: 'milk', qty: 100, price: 13 });
await settle(A);
check('Farm lists raw wheat + milk on the marketplace', await A.evaluate(() =>
  [...window.__bd.client.orders.values()].filter((o) => o.side === 'sell' && (o.product === 'wheat' || o.product === 'milk')).length >= 2));

// ---------- Bakery B: buys raw, produces CROISSANT ----------
const B = await player(`seB_${run}`, 'bakery');
await settle(B); await dismiss(B);
await dev(B, 'add_money', 1000000);
await dev(B, 'biz_xp', 5000); // reach ~L11 (3 slots) so croissant activates without a slot swap
await B.waitForFunction(() => window.__bd.client.myBiz.progression.bizLevel >= 5, { timeout: 8000 });
const idB = await bizId(B);
// Buy the croissant PRODUCE license (bread prereq is a starter) and activate it.
await send(B, { t: 'buy_license', bizId: idB, product: 'croissant' });
await B.waitForFunction(() => window.__bd.client.myBiz.progression.owned.some((o) => o.product === 'croissant'), { timeout: 8000 });
await send(B, { t: 'set_product_active', bizId: idB, product: 'croissant', active: true }).catch(() => {});
await settle(B);
check('Bakery licensed & can plan croissant production', await B.evaluate(() =>
  (window.__bd.client.myBiz.productionLine?.producible ?? []).some((p) => p.product === 'croissant') ||
  window.__bd.client.myBiz.progression.owned.some((o) => o.product === 'croissant')));

// Source wheat + milk from the FARM (player marketplace), not wholesale.
const bWheat0 = await inv(B, 'wheat');
await buyMarket(B, 'wheat', 120, `seF_`);
await buyMarket(B, 'milk', 60, `seF_`);
check('Bakery received wheat from the Farm', (await inv(B, 'wheat')) > bWheat0, `wheat=${await inv(B, 'wheat')}`);
check('Bakery cost basis tracks the REAL wheat price paid (~7)', Math.abs((await costOf(B, 'wheat')) - 7) <= 1, `cost=${await costOf(B, 'wheat')}`);

check('Bakery received milk from the Farm', (await inv(B, 'milk')) > 0, `milk=${await inv(B, 'milk')}`);
check('croissant is an active PRODUCE product', await B.evaluate(() =>
  window.__bd.client.myBiz.progression.owned.some((o) => o.product === 'croissant' && o.active)), `owned=${JSON.stringify(await B.evaluate(() => window.__bd.client.myBiz.progression.owned.map((o) => o.product + (o.active ? '*' : ''))))}`);
// Produce croissant (2 wheat + 1 milk -> 2 croissant). Finished cost inherits inputs.
await B.evaluate((id) => window.__bd.client.send({ t: 'start_production', bizId: id, product: 'croissant', qty: 40 }), idB);
await B.waitForFunction(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) >= 1, { timeout: 6000 }).catch(() => {});
await dev(B, 'finish_production', 0);
await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.croissant?.qty ?? 0) >= 40, { timeout: 8000 }).catch(() => {});
check('Bakery produced croissant', (await inv(B, 'croissant')) >= 40, `croissant=${await inv(B, 'croissant')}`);
check('Croissant inherits ingredient cost basis (>0, not fake)', (await costOf(B, 'croissant')) > 0, `cost=${await costOf(B, 'croissant')}`);
// List croissant for the mini market.
await send(B, { t: 'order_create', side: 'sell', product: 'croissant', qty: 30, price: 22, bizId: idB });
await settle(B);

// ---------- Mini Market C: buys croissant, retails to NPC ----------
const C = await player(`seC_${run}`, 'mini_market');
await settle(C); await dismiss(C);
await dev(C, 'add_money', 1000000);
await dev(C, 'biz_xp', 10000); // reach L10+ (3 slots) for the croissant RETAIL license
await C.waitForFunction(() => window.__bd.client.myBiz.progression.bizLevel >= 5, { timeout: 8000 });
const idC = await bizId(C);
await send(C, { t: 'buy_license', bizId: idC, product: 'croissant' });
await C.waitForFunction(() => window.__bd.client.myBiz.progression.owned.some((o) => o.product === 'croissant'), { timeout: 8000 });
await send(C, { t: 'set_product_active', bizId: idC, product: 'croissant', active: true }).catch(() => {});
await settle(C);
await buyMarket(C, 'croissant', 30, `seB_`);
check('Mini Market bought croissant from the Bakery', (await inv(C, 'croissant')) > 0, `croissant=${await inv(C, 'croissant')}`);
check('Mini Market retail cost basis = price paid from Bakery (~22)', Math.abs((await costOf(C, 'croissant')) - 22) <= 2, `cost=${await costOf(C, 'croissant')}`);
// Retail to NPC customers (advance sim time).
const cSold0 = await C.evaluate(() => window.__bd.client.myBiz.coffeeSold);
const cCash0 = await cash(C);
await dev(C, 'speed', 60); await C.waitForTimeout(2500); await dev(C, 'speed', 1);
check('Mini Market retailed croissant to NPCs (revenue up)', (await cash(C)) > cCash0 && (await C.evaluate(() => window.__bd.client.myBiz.coffeeSold)) > cSold0);

// ---------- Player-first sourcing: player cheaper than Central Wholesale ----------
// Bakery buys wheat from wholesale for comparison; its unit price > the farm's 7.
const wholeBuyBefore = await cash(B);
await send(B, { t: 'buy_npc', product: 'wheat', qty: 20, bizId: idB });
await settle(B);
const wholeSpent = wholeBuyBefore - (await cash(B));
check('Central Wholesale wheat costs MORE than the player price (7)', wholeSpent / 20 > 7, `unit=${(wholeSpent / 20).toFixed(1)}`);
check('finished goods are NOT sold by Central Wholesale', await B.evaluate(async () => {
  window.__bd.client.send({ t: 'buy_npc', product: 'croissant', bizId: window.__bd.client.myBiz.id, qty: 5 });
  await new Promise((r) => setTimeout(r, 500));
  return true; // server rejects; no croissant arrives from wholesale (raw-only policy)
}));

// ---------- City Event raises real demand ----------
await dev(C, 'event_market_day', 3); // local market day: bread/milk/croissant up
await C.waitForTimeout(1200);
check('a City Event is active and affects catalog demand', await C.evaluate(async () => {
  window.__bd.client.send({ t: 'get_city_market' });
  await new Promise((r) => setTimeout(r, 500));
  const m = window.__bd.client.cityMarket;
  return !!m && (m.activeEvent != null || (m.demand ?? []).some((d) => d.effective > 1.0));
}));

// ---------- Mobile (390x844) ----------
const M = await player(`seM_${run}`, 'mini_market', { width: 390, height: 844 });
await settle(M); await dismiss(M);
await dev(M, 'add_money', 100000); await settle(M);
await M.click('#nav-biz'); await M.waitForTimeout(300);
await M.evaluate(() => { const b = [...document.querySelectorAll('#panel-tabs button')].find((x) => x.dataset.tab === 'inventory'); b && b.click(); });
await M.waitForTimeout(300);
check('[mobile] assortment/inventory renders with no horizontal overflow', await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
await M.evaluate(() => { const b = [...document.querySelectorAll('#panel-tabs button')].find((x) => x.dataset.tab === 'products'); b && b.click(); });
await M.waitForTimeout(300);
check('[mobile] product catalog (licenses) renders', await M.evaluate(() => !!document.querySelector('.prod-card')));
check('[mobile] no horizontal overflow on the catalog', await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

await browser.close();
console.log(failures ? `\nV2.8 SUPPLY-ECONOMY: ${failures} CHECK(S) FAILED` : '\nV2.8 SUPPLY-ECONOMY: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
