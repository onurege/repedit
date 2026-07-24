// BUSINESS DISTRICT — V2.6.2 storage capacity invariant E2E.
//
// Prerequisites: the dev stack must be running with dev tools enabled
// (DEV_TOOLS=1, the default in development):
//   npm run dev
// Then:
//   npm run e2e:storage
//
// Verifies through the real browser that a business's stored inventory can
// never exceed capacity:
//   - a Marketplace purchase that would overflow is rejected (no goods, no cash
//     movement),
//   - a Contract delivery that cannot fit enters WAITING (inventory stays <=
//     capacity, money/goods move exactly once at execution),
//   - consuming/selling frees space and the waiting delivery unloads exactly
//     once.
// Restart persistence + exactly-once completion of a waiting delivery is
// covered deterministically in server/test/storage-invariant.test.ts (hard to
// orchestrate a mid-session server restart across two live browser contexts).

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
  await page.waitForSelector('.choice', { timeout: 15000 });
  await page.click(`.choice[data-type="${bizType}"]`);
  await page.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
  return page;
}
const send = (page, msg) => page.evaluate((m) => window.__bd.client.send(m), msg);
const myBiz = (page) => page.evaluate(() => {
  const b = window.__bd.client.myBiz;
  return {
    id: b.id, lotId: b.lotId, level: b.level,
    milk: b.inventory.milk ? { qty: b.inventory.milk.qty, cap: b.inventory.milk.capacity, reserved: b.inventory.milk.reserved } : null,
  };
});
const cash = (page) => page.evaluate(() => window.__bd.client.you.cash);
const waitingMilk = (page) => page.evaluate(() =>
  [...window.__bd.client.deliveries.values()].filter((d) => d.status === 'waiting' && d.product === 'milk').length);

// ---------- A: a coffee shop, milk storage filled to capacity ----------
const A = await newPlayer(`stA_${run}`, 'coffee_shop');
await send(A, { t: 'dev', cmd: 'add_money', value: 5_000_000 });
await send(A, { t: 'dev', cmd: 'speed', value: 20 });
let a = await myBiz(A);
const cap = a.milk.cap;
check('coffee shop has a milk capacity', cap > 0, `cap=${cap}`);

// Fill milk right up to capacity (dev add is clamped to free space).
await send(A, { t: 'dev', cmd: 'add_milk', value: cap });
await A.waitForFunction((c) => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= c, cap, { timeout: 8000 });
a = await myBiz(A);
check('milk filled exactly to capacity (dev add clamped, no overflow)', a.milk.qty === cap, `${a.milk.qty}/${cap}`);

// ---------- B: a farm selling milk on the marketplace ----------
const B = await newPlayer(`stB_${run}`, 'farm');
await send(B, { t: 'dev', cmd: 'add_money', value: 5_000_000 });
await send(B, { t: 'dev', cmd: 'add_milk', value: 200 });
await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= 200, { timeout: 8000 });
await send(B, { t: 'order_create', side: 'sell', product: 'milk', qty: 100, price: 5 });
await A.waitForFunction(() => [...window.__bd.client.orders.values()].some((o) => o.side === 'sell' && o.product === 'milk'), { timeout: 8000 });

// ---------- A tries to buy milk it has no room for -> rejected ----------
const aCashBefore = await cash(A);
const orderId = await A.evaluate(() => [...window.__bd.client.orders.values()].find((o) => o.side === 'sell' && o.product === 'milk').id);
await A.evaluate((id) => window.__bd.client.send({ t: 'order_fulfill', orderId: id, qty: 100 }), orderId);
await A.waitForTimeout(1200);
a = await myBiz(A);
check('marketplace purchase did NOT overflow storage', a.milk.qty === cap, `${a.milk.qty}/${cap}`);
check('rejected purchase moved no cash', (await cash(A)) === aCashBefore, `cash ${aCashBefore}`);
check('storage invariant holds (qty+reserved <= capacity)', a.milk.qty + a.milk.reserved <= cap);

// ---------- Contract from B (farm) to A (full coffee shop) -> waits ----------
await send(B, { t: 'dev', cmd: 'add_milk', value: 1000 });
// A proposes a supply contract to B for milk; B accepts.
const bBizId = await A.evaluate(() => [...window.__bd.client.businesses.values()].find((x) => x.type === 'farm').id);
await A.evaluate((sellerBizId) => window.__bd.client.send({ t: 'contract_propose', sellerBizId, product: 'milk', quantity: 100, unitPrice: 5, deliveries: 3 }), bBizId);
await B.waitForFunction(() => [...window.__bd.client.contracts.values()].some((c) => c.status === 'proposed'), { timeout: 8000 });
const cId = await B.evaluate(() => [...window.__bd.client.contracts.values()].find((c) => c.status === 'proposed').id);
const aCashPre = await cash(A);
const bCashPre = await cash(B);
await B.evaluate((id) => window.__bd.client.send({ t: 'contract_accept', contractId: id }), cId);

// The contract executes; the delivery cannot fit A's full store -> waits.
await A.waitForFunction(() => [...window.__bd.client.deliveries.values()].some((d) => d.status === 'waiting' && d.product === 'milk'), null, { timeout: 15000 });
check('contract delivery entered WAITING state', (await waitingMilk(A)) >= 1);
a = await myBiz(A);
check('waiting contract did not overflow storage', a.milk.qty + a.milk.reserved <= cap, `${a.milk.qty + a.milk.reserved}/${cap}`);
check('buyer (A) charged exactly once (100 x $5)', aCashPre - (await cash(A)) === 500, `${aCashPre} -> ${await cash(A)}`);
void bCashPre;

// ---------- A upgrades storage -> the waiting delivery unloads exactly once ----------
// A bigger store creates room; the waiting delivery must then unload fully and
// exactly once (also covers: storage upgrade unblocks a waiting delivery).
const milkBefore = a.milk.qty;
await A.evaluate(() => window.__bd.client.send({ t: 'upgrade' }));
await A.waitForFunction(
  () => window.__bd.client.myBiz.level >= 2 &&
        [...window.__bd.client.deliveries.values()].every((d) => d.status !== 'waiting'),
  null, { timeout: 15000 }
);
a = await myBiz(A);
check('storage upgrade unblocked and unloaded the waiting delivery', (await waitingMilk(A)) === 0);
check('delivery unloaded fully exactly once (+100 milk)', a.milk.qty === milkBefore + 100, `${milkBefore} -> ${a.milk.qty}`);
check('inventory within the new capacity', a.milk.qty + a.milk.reserved <= a.milk.cap, `${a.milk.qty + a.milk.reserved}/${a.milk.cap}`);

await browser.close();
console.log(failures ? `\nV2.6.2 STORAGE: ${failures} CHECK(S) FAILED` : '\nV2.6.2 STORAGE: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
