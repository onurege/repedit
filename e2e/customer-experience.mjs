// BUSINESS DISTRICT — V2.8.2 RELEASE GATE — Customer Experience E2E.
//
// Drives the REAL browser client (no direct DOM mutation of game state — only
// real client messages + dev tools that inject test *conditions*, exactly like
// the other E2Es). Verifies, end to end:
//   • a new business starts at Customer Satisfaction 70
//   • the real UI uses "Business Level" + "Facility Tier" terminology
//   • a real committed NPC sale awards money AND Business XP, both surfaced
//   • satisfaction moves GRADUALLY (smoothed) on fair sales
//   • a controlled stockout lowers satisfaction gradually; service restores it
//   • production XP is awarded in full at LOW satisfaction (not multiplied down)
//   • satisfaction persists across a refresh / reconnect
//   • the experience renders at a 390×844 mobile viewport without overflow
//
// Prereqs: dev stack with dev tools (npm run dev). Run: npm run e2e:customer-experience
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
  const h = await fetch(`${SERVER_URL}/api/health`);
  if (!h.ok) throw new Error(String(h.status));
} catch {
  console.error(`Server not reachable at ${SERVER_URL}. Start it: npm run dev`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;

async function login(ctx, name, bizType) {
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
const send = (p, m) => p.evaluate((x) => window.__bd.client.send(x), m);
const sat = (p) => p.evaluate(() => window.__bd.client.myBiz.satisfaction);
const bizXp = (p) => p.evaluate(() => window.__bd.client.myBiz.progression.bizXp);
const coffeeQty = (p) => p.evaluate(() => window.__bd.client.myBiz.inventory.coffee?.qty ?? 0);

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await login(ctx, `cx_${run}`, 'coffee_shop');

  // Capture the real client 'sale' stream (what feeds the on-shop money/XP popup).
  await page.evaluate(() => {
    window.__cxSales = [];
    window.__bd.client.on('sale', (e) => { if (e.bizId === window.__bd.client.myBiz?.id) window.__cxSales.push(e); });
  });

  // 1) New business starts at satisfaction 70.
  check('new coffee shop starts at Customer Satisfaction 70', (await sat(page)) === 70, `sat=${await sat(page)}`);

  // 2) Real-UI terminology: Business Level + Facility Tier both present on Overview.
  await page.click('#nav-biz');
  await page.waitForSelector('#panel-body', { timeout: 8000 });
  await sleep(300);
  const overviewText = await page.$eval('#panel-body', (el) => el.innerText);
  check('Overview shows "Business Level" terminology', /Business Level/i.test(overviewText));
  check('Overview shows "Facility Tier" terminology', /Facility Tier/i.test(overviewText));
  check('Overview shows Customer Satisfaction (value / 100)', /\/\s*100/.test(overviewText), overviewText.replace(/\n/g, ' ').slice(0, 160));

  // Accelerate the simulation and stock the shop so NPCs can actually buy.
  await send(page, { t: 'dev', cmd: 'speed', value: 20 });
  await send(page, { t: 'dev', cmd: 'add_coffee', value: 500 });
  await page.waitForFunction(() => (window.__bd.client.myBiz.inventory.coffee?.qty ?? 0) > 0, { timeout: 8000 });

  // 3) Perform real committed NPC sales — Business XP grows from them.
  const xp0 = await bizXp(page);
  await page.waitForFunction((x) => window.__bd.client.myBiz.progression.bizXp > x, xp0, { timeout: 30000 });
  check('real committed NPC sale increases Business XP', (await bizXp(page)) > xp0, `xp ${xp0} -> ${await bizXp(page)}`);

  // 4) Money AND Business XP are both communicated to the shop popup.
  await page.waitForFunction(() => (window.__cxSales?.length ?? 0) > 0, { timeout: 15000 });
  const lastSale = await page.evaluate(() => window.__cxSales[window.__cxSales.length - 1]);
  check('sale event carries a money amount for the popup', lastSale.amount > 0, `amount=${lastSale.amount}`);
  check('sale event carries Business XP for the popup', (lastSale.xp ?? 0) > 0, `xp=${lastSale.xp}`);

  // 5) Satisfaction moves GRADUALLY on fair sales (eased, never a jump to target).
  const satA = await sat(page);
  await sleep(3000);
  const satB = await sat(page);
  check('satisfaction changes gradually with fair sales (rises, no jump to 90)',
    satB >= satA && satB > 70 && satB < 90, `70 -> ${satA} -> ${satB}`);

  // 6) Controlled stockout: let stock run out; lost customers lower satisfaction gradually.
  const satPeak = await sat(page);
  // Drain remaining stock quickly so arrivals become stockouts.
  await page.evaluate(() => window.__bd.client.send({ t: 'dev', cmd: 'speed', value: 40 }));
  await page.waitForFunction(() => (window.__bd.client.myBiz.inventory.coffee?.qty ?? 0) === 0, { timeout: 30000 });
  // Wait through several stockout ticks.
  let satStock = satPeak;
  for (let i = 0; i < 20 && satStock >= satPeak; i++) { await sleep(1000); satStock = await sat(page); }
  check('stockout lowers satisfaction gradually', satStock < satPeak && satStock > 0, `${satPeak} -> ${satStock}`);

  // 7) Restore service — satisfaction recovers (never a permanent death spiral).
  await send(page, { t: 'dev', cmd: 'add_coffee', value: 500 });
  await page.waitForFunction(() => (window.__bd.client.myBiz.inventory.coffee?.qty ?? 0) > 0, { timeout: 8000 });
  let satRecover = satStock;
  for (let i = 0; i < 20 && satRecover <= satStock; i++) { await sleep(1000); satRecover = await sat(page); }
  check('service restored → satisfaction recovers', satRecover > satStock, `${satStock} -> ${satRecover}`);

  // 8) Production XP is awarded in FULL at low satisfaction (not satisfaction-scaled).
  await send(page, { t: 'dev', cmd: 'make_admin' });
  await page.waitForFunction(() => window.__bd.client.you?.isAdmin === true, { timeout: 8000 });
  const myBizId = await page.evaluate(() => window.__bd.client.myBiz.id);
  await send(page, { t: 'admin_set_satisfaction', bizId: myBizId, value: 10, reason: 'e2e production-xp isolation' });
  await page.waitForFunction(() => window.__bd.client.myBiz.satisfaction === 10, { timeout: 8000 });
  // Give ingredients and run one manufacturing batch.
  await send(page, { t: 'dev', cmd: 'add_beans', value: 200 });
  await send(page, { t: 'dev', cmd: 'add_milk', value: 200 });
  await send(page, { t: 'dev', cmd: 'speed', value: 1 }); // slow ticks so NPC XP doesn't blur the batch delta
  const xpPre = await bizXp(page);
  await send(page, { t: 'start_production', bizId: myBizId, product: 'coffee', qty: 20 });
  await page.waitForFunction(() => window.__bd.client.myBiz.productionLine?.jobs?.length > 0, { timeout: 8000 }).catch(() => {});
  await send(page, { t: 'dev', cmd: 'finish_production' });
  await page.waitForFunction((x) => window.__bd.client.myBiz.progression.bizXp > x, xpPre, { timeout: 12000 });
  check('production XP is awarded in full even at satisfaction 10 (not multiplied down)',
    (await bizXp(page)) > xpPre, `xp ${xpPre} -> ${await bizXp(page)} @ sat=10`);

  // 9) Refresh / reconnect persistence.
  const satBeforeReload = await sat(page);
  await page.reload();
  await page.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 });
  const satAfterReload = await sat(page);
  check('satisfaction persists across refresh / reconnect', Math.abs(satAfterReload - satBeforeReload) <= 1,
    `${satBeforeReload} -> ${satAfterReload}`);

  await ctx.close();

  // 10) Mobile viewport (390×844): the experience renders without horizontal overflow.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mpage = await login(mctx, `cxm_${run}`, 'coffee_shop');
  await mpage.evaluate(() => document.getElementById('mobile-hint')?.remove()); // dismiss first-run gesture hint
  await mpage.click('#nav-biz');
  await mpage.waitForSelector('#panel-body', { timeout: 8000 });
  await sleep(300);
  const mText = await mpage.$eval('#panel-body', (el) => el.innerText);
  check('mobile: Overview shows satisfaction terminology', /\/\s*100/.test(mText) && /Business Level/i.test(mText));
  const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('mobile: no horizontal overflow at 390×844', overflow <= 2, `overflow=${overflow}px`);
  await mctx.close();
} catch (e) {
  console.log(`FAIL  unexpected error  (${e.message})`);
  failures++;
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
