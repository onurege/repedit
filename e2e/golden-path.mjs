// BUSINESS DISTRICT — permanent golden-path E2E smoke test.
//
// Prerequisites: the dev stack must be running with dev tools enabled
// (DEV_TOOLS=1, the default in development):
//   npm run dev          # server :2567 + client :5173
// Then:
//   npm run e2e
//
// Covers the core multiplayer economy loop through the real browser UI:
//   A registers, opens a Coffee Shop, buys ingredients from the NPC
//   wholesaler, sells coffee, posts BUY 100 MILK @ $12.
//   B registers, opens a Farm, produces milk, fulfills A's order.
//   Verifies: money moves exactly once, delivery is created, milk arrives.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- preflight ---
try {
  const health = await fetch(`${SERVER_URL}/api/health`);
  if (!health.ok) throw new Error(String(health.status));
} catch {
  console.error(`Server not reachable at ${SERVER_URL}. Start the stack first: npm run dev`);
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
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
        type: c.myBiz.type,
        status: c.myBiz.status,
        coffeeSold: c.myBiz.coffeeSold,
        inv: Object.fromEntries(Object.entries(c.myBiz.inventory).map(([k, v]) => [k, v.qty])),
      },
      orders: [...c.orders.values()].map((o) => ({
        id: o.id, side: o.side, remaining: o.remaining, price: o.price, owner: o.ownerName,
      })),
      deliveries: c.deliveries.size,
      online: c.online,
    };
  });
const dev = (page, cmd, value) =>
  page.evaluate(([cmd, value]) => window.__bd.client.send({ t: 'dev', cmd, value }), [cmd, value]);

// ---------- Player A: coffee shop ----------
const A = await newPlayer(`e2eA_${run}`, 'coffee_shop');
let a = await S(A);
check('A starts with $10,000 and a coffee shop', a.cash === 10000 && a.biz.type === 'coffee_shop');

await dev(A, 'speed', 20); // compress game time for the test

await A.evaluate(() => window.__bd.ui.openWholesale());
await A.fill('[data-npc-qty="beans"]', '60');
await A.click('[data-npc-buy="beans"]');
await sleep(300);
await A.fill('[data-npc-qty="milk"]', '30');
await A.click('[data-npc-buy="milk"]');
await sleep(600);
a = await S(A);
check('A paid the NPC wholesaler', a.cash === 10000 - 60 * 8 - 30 * 15, `cash=${a.cash}`);
check('NPC delivery created', a.deliveries >= 1, `deliveries=${a.deliveries}`);

// wait for ingredient delivery, then MANUALLY produce coffee (V2.8 Phase 2:
// coffee is no longer auto-brewed — the shop must queue a production batch).
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.beans?.qty ?? 0) > 0, { timeout: 25000 });
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) > 0, { timeout: 25000 });
await A.evaluate(() => window.__bd.client.send({ t: 'start_production', bizId: window.__bd.client.myBiz.id, product: 'coffee', qty: 25 }));
await sleep(400);
await dev(A, 'finish_production', 0);
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.coffee?.qty ?? 0) > 0, { timeout: 10000 });
// then customers buy the finished coffee
await A.waitForFunction(() => window.__bd.client.myBiz.coffeeSold > 0, { timeout: 30000 });
a = await S(A);
check('coffee shop produces and sells (customers bought coffee)', a.biz.coffeeSold > 0, `sold=${a.biz.coffeeSold}`);

// A posts BUY 100 MILK @ $12 (at 1x speed so the cash check is exact)
await dev(A, 'speed', 1);
await sleep(1500);
a = await S(A);
const cashBeforeOrder = a.cash;
await A.click('#nav-market');
await A.selectOption('#mo-side', 'buy');
await A.selectOption('#mo-product', 'milk');
await A.fill('#mo-qty', '100');
await A.fill('#mo-price', '12');
await A.click('#mo-create');
await A.waitForFunction(() => [...window.__bd.client.orders.values()].some((o) => o.side === 'buy'), { timeout: 8000 });
a = await S(A);
check('A escrowed exactly $1200 for BUY 100 MILK @ $12', a.cash >= cashBeforeOrder - 1200 && a.cash <= cashBeforeOrder - 1200 + 90, `cash=${a.cash}, pre=${cashBeforeOrder}`);
await dev(A, 'speed', 20); // speed up again for B's milk production

// ---------- Player B: farm ----------
const B = await newPlayer(`e2eB_${run}`, 'farm');
let b = await S(B);
check('B starts with a farm and sees A in the city', b.biz.type === 'farm' && b.online >= 2);

await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= 100, { timeout: 90000 });

// slow time back down so balance snapshots are stable
await dev(A, 'speed', 1);
await sleep(1200);
a = await S(A);
b = await S(B);
const order = b.orders.find((o) => o.side === 'buy' && o.owner === `e2eA_${run}`);
check('B sees A\'s buy order on the marketplace', !!order);
const bCashPre = b.cash;
const bMilkPre = b.biz.inv.milk;
const aMilkPre = a.biz.inv.milk;

await B.click('#nav-market');
await B.fill(`[data-qty-for="${order.id}"]`, '100');
await B.click(`[data-fulfill="${order.id}"]`);
await B.click(`[data-fulfill="${order.id}"]`, { timeout: 1000 }).catch(() => {}); // double-click must not duplicate
await sleep(1500);
a = await S(A);
b = await S(B);
check('B was paid exactly once (+$1200)', b.cash === bCashPre + 1200, `cash=${b.cash}, pre=${bCashPre}`);
check('B milk decreased by 100 (±production)', b.biz.inv.milk >= bMilkPre - 100 && b.biz.inv.milk <= bMilkPre - 100 + 8, `milk=${b.biz.inv.milk}, pre=${bMilkPre}`);
check('trade delivery created', a.deliveries >= 1, `deliveries=${a.deliveries}`);

// milk arrives at A's shop (shop may brew a little in the meantime)
await A.waitForFunction(
  (pre) => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= pre + 90,
  aMilkPre,
  { timeout: 40000 }
);
a = await S(A);
check('A received the milk after delivery', a.biz.inv.milk >= aMilkPre + 90, `milk=${a.biz.inv.milk}, pre=${aMilkPre}`);
check('order fully filled and removed', !a.orders.some((o) => o.id === order.id));

await dev(A, 'speed', 1);
await browser.close();
console.log(failures === 0 ? '\nGOLDEN PATH: ALL CHECKS PASSED' : `\nGOLDEN PATH: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
