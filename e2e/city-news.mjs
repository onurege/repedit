// BUSINESS DISTRICT — V2.7 Phase 4 Rival Alerts & City News E2E.
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:citynews
//
// Verifies rival alerts and city news are generated from REAL committed events:
//  * a materially cheaper sell listing raises a price-undercut rival alert;
//  * opening a business posts a BUSINESS_OPENED city-news item;
//  * a large committed deal posts a MAJOR_DEAL city-news item;
//  * the news payload never leaks private fields (cash / inventory / integrity).
//
// Uses coffee shops trading MILK (roomy 250 ingredient capacity, plenty of
// free lots) so the listings and the $5k deal all fit without overflow.
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

// A = victim seller, B = the undercutting rival + big buyer. Both coffee shops.
const A = await player(`cnA_${run}`, 'coffee_shop');
const B = await player(`cnB_${run}`, 'coffee_shop');
await send(A, { t: 'dev', cmd: 'add_milk', value: 250 });
await send(B, { t: 'dev', cmd: 'add_milk', value: 150 });
await send(B, { t: 'dev', cmd: 'add_money', value: 100000 });
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= 200, null, { timeout: 8000 });
await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= 120, null, { timeout: 8000 });

const aBizId = await A.evaluate(() => window.__bd.client.myBiz.id);
const bBizId = await B.evaluate(() => window.__bd.client.myBiz.id);
const aCompany = await A.evaluate(() => window.__bd.client.company?.name ?? '');

// 1) A lists milk at $20; B then lists clearly cheaper at $14 -> A is undercut.
await send(A, { t: 'order_create', side: 'sell', product: 'milk', qty: 100, price: 20 });
await A.waitForTimeout(400);
await send(B, { t: 'order_create', side: 'sell', product: 'milk', qty: 100, price: 14 });
await A.waitForFunction(() => window.__bd.client.rivalAlerts.some((r) => r.type === 'price_undercut' && r.product === 'milk'), null, { timeout: 8000 }).catch(() => {});
check('A receives a price-undercut rival alert from real committed data',
  await A.evaluate(() => window.__bd.client.rivalAlerts.some((r) => r.type === 'price_undercut')));

// 2) BUSINESS_OPENED: A's own opening at test start is public city news.
await send(A, { t: 'get_city_news' });
await A.waitForFunction((nm) => window.__bd.client.cityNews.some((n) => n.type === 'business_opened' && (n.params?.company ?? '') === nm), aCompany, { timeout: 8000 }).catch(() => {});
check('opening a business posts a BUSINESS_OPENED city-news item',
  await A.evaluate((nm) => window.__bd.client.cityNews.some((n) => n.type === 'business_opened' && (n.params?.company ?? '') === nm), aCompany));

// 3) MAJOR_DEAL: B buys 100 milk @ $50 (=$5000, above threshold) from A via a
//    negotiated offer; the committed deal posts a MAJOR_DEAL news item.
//    (offer_create opens the conversation itself — no separate DM needed.)
await send(B, { t: 'offer_create', toBizId: aBizId, fromBizId: bBizId, side: 'buy', product: 'milk', qty: 100, unitPrice: 50 });
await A.waitForFunction(() => [...window.__bd.client.offers.values()].some((o) => o.canAct && o.product === 'milk' && o.qty === 100), null, { timeout: 8000 });
const offerId = await A.evaluate(() => [...window.__bd.client.offers.values()].find((o) => o.canAct && o.product === 'milk' && o.qty === 100).id);
const ver = await A.evaluate((id) => window.__bd.client.offers.get(id).version, offerId);
await send(A, { t: 'offer_accept', offerId, version: ver });
await A.waitForFunction((id) => window.__bd.client.offers.get(id)?.status === 'accepted', offerId, { timeout: 8000 });
await send(A, { t: 'get_city_news' });
await A.waitForFunction(() => window.__bd.client.cityNews.some((n) => n.type === 'major_deal'), null, { timeout: 8000 }).catch(() => {});
check('a large committed deal posts a MAJOR_DEAL city-news item',
  await A.evaluate(() => window.__bd.client.cityNews.some((n) => n.type === 'major_deal')));

// 4) Privacy: no city-news payload leaks a private field.
const leak = await A.evaluate(() => window.__bd.client.cityNews.some((n) =>
  Object.keys(n.params || {}).some((k) => /cash|balance|inventory|integrity|secret|note/i.test(k))));
check('no city-news payload leaks private fields', !leak);

await browser.close();
console.log(failures ? `\nV2.7 CITY NEWS: ${failures} CHECK(S) FAILED` : '\nV2.7 CITY NEWS: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
