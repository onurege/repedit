// BUSINESS DISTRICT — Phase 2 chain E2E.
//
// Three browser contexts trade value down the supply chain:
//   A (Farm)        produces WHEAT, lists SELL 100 @ $7
//   B (Bakery)      buys A's wheat, bakes & sells BREAD, lists SELL 30 @ $14
//   C (Mini Market) buys B's bread, retails it to NPC customers
//
// Prerequisites: dev stack running with dev tools (npm run dev), Chromium
// available (CHROMIUM_PATH env or default Playwright install). Fresh
// accounts per run — no DB reset needed. Run: npm run e2e:chain

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
const S = (page) =>
  page.evaluate(() => {
    const c = window.__bd.client;
    return {
      cash: c.you?.cash,
      biz: c.myBiz && {
        type: c.myBiz.type, status: c.myBiz.status, sold: c.myBiz.coffeeSold,
        revenue: c.myBiz.revenue, production: c.myBiz.production,
        inv: Object.fromEntries(Object.entries(c.myBiz.inventory).map(([k, v]) => [k, v.qty])),
      },
      orders: [...c.orders.values()].map((o) => ({
        id: o.id, side: o.side, product: o.product, remaining: o.remaining, price: o.price, owner: o.ownerName,
      })),
      deliveries: c.deliveries.size,
    };
  });
const send = (page, msg) => page.evaluate((m) => window.__bd.client.send(m), msg);

// ---------- A: farm producing wheat ----------
const A = await newPlayer(`chainA_${run}`, 'farm');
await send(A, { t: 'set_production', product: 'wheat' });
await send(A, { t: 'dev', cmd: 'speed', value: 20 });
await A.waitForFunction(() => window.__bd.client.myBiz.production === 'wheat', { timeout: 8000 });
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.wheat?.qty ?? 0) >= 100, null, { timeout: 90000 });
let a = await S(A);
check('A (farm) produced ≥100 wheat', a.biz.inv.wheat >= 100, `wheat=${a.biz.inv.wheat}`);

await A.click('#nav-market');
await A.selectOption('#mo-side', 'sell');
await A.selectOption('#mo-product', 'wheat');
await A.fill('#mo-qty', '100');
await A.fill('#mo-price', '7');
await A.click('#mo-create');
await A.waitForFunction(() => [...window.__bd.client.orders.values()].some((o) => o.product === 'wheat'), { timeout: 8000 });
check('A listed SELL 100 WHEAT @ $7', true);

// ---------- B: bakery buys A's wheat ----------
const B = await newPlayer(`chainB_${run}`, 'bakery');
let b = await S(B);
const wheatOrder = b.orders.find((o) => o.product === 'wheat' && o.side === 'sell');
check('B (bakery) sees A\'s wheat offer', !!wheatOrder);
await B.click('#nav-market');
await B.fill(`[data-qty-for="${wheatOrder.id}"]`, '100');
await B.click(`[data-fulfill="${wheatOrder.id}"]`);
await B.click(`[data-fulfill="${wheatOrder.id}"]`, { timeout: 1000 }).catch(() => {}); // duplicate attempt
await sleep(1500);
a = await S(A);
b = await S(B);
check('A was paid exactly once (+$700)', a.cash === 10700, `cash=${a.cash}`);
check('B paid exactly once (−$700)', b.cash === 9300, `cash=${b.cash}`);
check('wheat delivery created', b.deliveries >= 1, `deliveries=${b.deliveries}`);

// wheat arrives, bakery bakes and sells bread
await B.waitForFunction(
  () => {
    const inv = window.__bd.client.myBiz.inventory;
    return (inv.wheat?.qty ?? 0) + (inv.bread?.qty ?? 0) > 0;
  },
  null,
  { timeout: 40000 }
);
check('B received wheat', true);
// V2.8 Phase 2: bread is manufactured on the production line. Top up wheat and
// queue a batch, then customers buy the finished bread.
await send(B, { t: 'dev', cmd: 'add_wheat', value: 300 });
await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.wheat?.qty ?? 0) >= 40, null, { timeout: 40000 });
await B.evaluate(() => window.__bd.client.send({ t: 'start_production', bizId: window.__bd.client.myBiz.id, product: 'bread', qty: 40 }));
await B.evaluate(() => new Promise((r) => setTimeout(r, 400)));
await send(B, { t: 'dev', cmd: 'finish_production' });
await B.waitForFunction(() => window.__bd.client.myBiz.coffeeSold > 0, null, { timeout: 40000 });
b = await S(B);
check('B produced and sold bread to NPC customers', b.biz.sold > 0 && b.biz.revenue > 0, `sold=${b.biz.sold}, revenue=$${b.biz.revenue}`);

// B builds up a bread surplus (more production batches) and lists it. Batches
// are sized to the free finished-goods space so they always fit as customers
// drain stock, climbing toward the 32 needed for the listing.
await send(B, { t: 'dev', cmd: 'add_wheat', value: 300 });
await B.evaluate(() => new Promise((r) => setTimeout(r, 400)));
await B.waitForFunction(async () => {
  const c = window.__bd.client; const e = c.myBiz.inventory.bread ?? { qty: 0, reserved: 0, capacity: 0 };
  if (e.qty >= 32) return true;
  const wheat = c.myBiz.inventory.wheat?.qty ?? 0;
  const free = Math.max(0, e.capacity - e.qty - e.reserved);
  const batch = Math.min(free, wheat);
  if ((c.myBiz.productionLine?.jobs?.length ?? 0) === 0 && batch >= 5) {
    c.send({ t: 'start_production', bizId: c.myBiz.id, product: 'bread', qty: batch });
    setTimeout(() => c.send({ t: 'dev', cmd: 'finish_production' }), 300);
  }
  return false;
}, null, { timeout: 90000 });
await B.click('#nav-market');
await B.selectOption('#mo-side', 'sell');
await B.selectOption('#mo-product', 'bread');
await B.fill('#mo-qty', '30');
await B.fill('#mo-price', '14');
await B.click('#mo-create');
await B.waitForFunction(() => [...window.__bd.client.orders.values()].some((o) => o.product === 'bread'), { timeout: 8000 });
check('B listed SELL 30 BREAD @ $14', true);

// ---------- C: mini market buys B's bread and retails it ----------
const C = await newPlayer(`chainC_${run}`, 'mini_market');
let c = await S(C);
const breadOrder = c.orders.find((o) => o.product === 'bread' && o.side === 'sell');
check('C (mini market) sees B\'s bread offer', !!breadOrder);
const bCashPre = (await S(B)).cash;
await C.click('#nav-market');
await C.fill(`[data-qty-for="${breadOrder.id}"]`, '30');
await C.click(`[data-fulfill="${breadOrder.id}"]`);
await sleep(1500);
c = await S(C);
b = await S(B);
check('C paid exactly once (−$420)', c.cash === 10000 - 420, `cash=${c.cash}`);
check('B received bread payment (+$420, plus own sales)', b.cash >= bCashPre + 420, `cash=${b.cash}, pre=${bCashPre}`);

await C.waitForFunction(() => (window.__bd.client.myBiz.inventory.bread?.qty ?? 0) > 0, null, { timeout: 40000 });
check('C received bread by delivery', true);
await C.waitForFunction(() => window.__bd.client.myBiz.coffeeSold > 0, null, { timeout: 60000 });
c = await S(C);
check('C retailed bread to NPC customers and earned money', c.biz.sold > 0 && c.cash > 10000 - 420, `sold=${c.biz.sold}, cash=${c.cash}`);

await send(A, { t: 'dev', cmd: 'speed', value: 1 });
await browser.close();
console.log(failures === 0 ? '\nBUSINESS CHAIN: ALL CHECKS PASSED' : `\nBUSINESS CHAIN: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
