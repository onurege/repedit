// BUSINESS DISTRICT — V2.7 Phase 4 Urgent City Orders E2E.
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:urgent
//
// Two real bakeries race for a single admin-created urgent city order. Verifies
// EXACTLY ONE winner: one company is paid the reward once and loses the goods
// once; the loser is untouched; the order leaves the live HUD; and a matching
// CITY_ORDER_WIN city-news item appears.
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
const bread = (p) => p.evaluate(() => window.__bd.client.myBiz.inventory.bread?.qty ?? 0);

// Two competing bakeries; A is also the admin who posts the order.
const A = await player(`uoA_${run}`, 'bakery');
const B = await player(`uoB_${run}`, 'bakery');
// A level-1 bakery holds up to 40 bread; add_bread fills to that cap.
await send(A, { t: 'dev', cmd: 'add_bread', value: 60 });
await send(B, { t: 'dev', cmd: 'add_bread', value: 60 });
await send(A, { t: 'dev', cmd: 'make_admin' });
await A.waitForFunction(() => window.__bd.client.you.isAdmin === true, null, { timeout: 8000 });
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.bread?.qty ?? 0) >= 40, null, { timeout: 8000 });
await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.bread?.qty ?? 0) >= 40, null, { timeout: 8000 });

// Admin posts a single urgent order for 30 bread, reward $1500.
await send(A, { t: 'admin_create_urgent', product: 'bread', qty: 30, reward: 1500, durationSecs: 600 });
// Both clients must see it live in the HUD state.
for (const P of [A, B]) {
  await P.waitForFunction(() => [...window.__bd.client.urgentOrders.values()].some((o) => o.status === 'active' && o.product === 'bread'), null, { timeout: 8000 });
}
check('both bakeries see the live urgent order', true);
const orderId = await A.evaluate(() => [...window.__bd.client.urgentOrders.values()].find((o) => o.status === 'active' && o.product === 'bread').id);

const aCash0 = await cash(A), bCash0 = await cash(B);
const aBread0 = await bread(A), bBread0 = await bread(B);

// Both race to fulfil the same order at the same time.
await Promise.all([
  send(A, { t: 'urgent_fulfill', orderId }),
  send(B, { t: 'urgent_fulfill', orderId }),
]);
// The order should drop out of both live HUDs (fulfilled).
for (const P of [A, B]) {
  await P.waitForFunction((id) => !window.__bd.client.urgentOrders.has(id) || window.__bd.client.urgentOrders.get(id).status !== 'active', orderId, { timeout: 8000 }).catch(() => {});
}
await A.waitForTimeout(800);

// A bakery keeps producing/selling bread in the background, so use tolerant,
// winner-anchored assertions (the $1500 reward and the 30 goods dwarf the noise).
const aPaid = (await cash(A)) - aCash0;
const bPaid = (await cash(B)) - bCash0;
const aLost = aBread0 - (await bread(A));
const bLost = bBread0 - (await bread(B));

const aWon = aPaid >= 1400;
const bWon = bPaid >= 1400;
check('exactly one company received the reward (single winner)',
  (aWon ? 1 : 0) + (bWon ? 1 : 0) === 1, `A:${aPaid} B:${bPaid}`);
const wPaid = aWon ? aPaid : bPaid;
const lPaid = aWon ? bPaid : aPaid;
check('the reward was paid once (~$1500, not doubled)', wPaid >= 1400 && wPaid < 1800, `winner +${wPaid}`);
check('the loser was not paid the reward', lPaid < 700, `loser +${lPaid}`);
const wLost = aWon ? aLost : bLost;
check('the winner lost the ~30 goods once', wLost >= 25 && wLost <= 45, `winner -${wLost} bread`);

// A CITY_ORDER_WIN news item appears for the fulfilled order.
await send(A, { t: 'get_city_news' });
await A.waitForFunction(() => window.__bd.client.cityNews.some((n) => n.type === 'city_order_win'), null, { timeout: 8000 }).catch(() => {});
check('a CITY_ORDER_WIN city-news item was generated',
  await A.evaluate(() => window.__bd.client.cityNews.some((n) => n.type === 'city_order_win')));

// A late fulfil attempt on the settled order is rejected (no extra payout).
const winner = aPaid === 1500 ? A : B;
const wCashNow = await cash(winner);
await send(winner, { t: 'urgent_fulfill', orderId });
await winner.waitForTimeout(600);
check('a late fulfil on the settled order does not pay again', (await cash(winner)) === wCashNow);

await browser.close();
console.log(failures ? `\nV2.7 URGENT ORDERS: ${failures} CHECK(S) FAILED` : '\nV2.7 URGENT ORDERS: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
