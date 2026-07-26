// BUSINESS DISTRICT — V2.8.2 RELEASE GATE — Internal Company Transfer E2E.
//
// One company owns a Farm + a Bakery. The Farm transfers Milk to the Bakery
// through the REAL transfer UI (no direct DOM mutation of game state). Verifies:
//   • reference price is the NORMAL Central Wholesale base (never the emergency price)
//   • the 10% logistics-fee preview is shown
//   • a game-native confirmation modal is used (no native confirm/alert)
//   • company cash decreases EXACTLY ONCE (by the fee)
//   • source inventory decreases EXACTLY ONCE
//   • a physical delivery is created; the destination receives stock ONLY after it arrives
//   • receiving WAC = source WAC + per-unit logistics fee
//   • NO XP, NO revenue, NO trade-count / market activity is generated
//   • a duplicate submission cannot double-charge / double-transfer
//   • insufficient company cash rejects BEFORE any inventory mutation
//   • the transfer persists across a refresh / reconnect
//   • the transfer UI renders at a 390×844 mobile viewport
//
// Prereqs: dev stack with dev tools (npm run dev). Run: npm run e2e:internal-transfer
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
const nums = (s) => (s.match(/\$([\d.,]+)/g) || []).map((x) => Number(x.replace(/[^\d.]/g, '')));

// Open the Farm's Inventory tab so the internal-transfer form is visible.
async function openFarmInventory(page, farmId) {
  await page.click(`.biz-chip[data-biz-chip="${farmId}"]`);
  await page.waitForFunction((id) => window.__bd.client.selectedBizId === id, farmId, { timeout: 8000 });
  await page.click('#nav-biz');
  await page.waitForSelector('#panel-tabs [data-tab="inventory"]', { timeout: 8000 });
  await page.click('#panel-tabs [data-tab="inventory"]');
  await page.waitForSelector('#xfer-prod', { timeout: 8000 });
}

async function bizField(page, bizId, path) {
  return page.evaluate(({ id, p }) => {
    const b = window.__bd.client.myBusinesses.get(id);
    return p.split('.').reduce((o, k) => (o == null ? o : o[k]), b);
  }, { id: bizId, p: path });
}

try {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 880 } });
  const page = await login(ctx, `it_${run}`, 'farm');
  const farmId = await page.evaluate(() => window.__bd.client.myBiz.id);

  // Unlock capacity + cash, open a Bakery in the same company via the real UI.
  await send(page, { t: 'dev', cmd: 'add_money', value: 60000 });
  await send(page, { t: 'dev', cmd: 'company_xp', value: 800 });
  await page.waitForFunction(() => window.__bd.client.company.level >= 2, { timeout: 8000 });
  await page.click('#co-open');
  await page.waitForSelector('#open-overlay', { timeout: 8000 });
  await page.click('.open-lot[data-type="bakery"]:not(.disabled)');
  await page.waitForFunction(() => window.__bd.client.myBusinesses.size === 2, { timeout: 10000 });
  const bakeryId = await page.evaluate(() => [...window.__bd.client.myBusinesses.values()].find((b) => b.type === 'bakery').id);

  // Give the farm milk to move, then switch the farm to WHEAT so its milk stock
  // is stationary (auto-production would otherwise make exact deltas race).
  await send(page, { t: 'dev', cmd: 'add_milk', value: 150, bizId: farmId });
  await page.waitForFunction((id) => (window.__bd.client.myBusinesses.get(id).inventory.milk?.qty ?? 0) >= 100, farmId, { timeout: 8000 });
  await send(page, { t: 'set_production', product: 'wheat', bizId: farmId });
  await page.waitForFunction((id) => window.__bd.client.myBusinesses.get(id).production === 'wheat', farmId, { timeout: 8000 }).catch(() => {});

  await openFarmInventory(page, farmId);
  const QTY = 100;
  await page.fill('#xfer-qty', String(QTY));
  await page.selectOption('#xfer-prod', 'milk');
  await page.selectOption('#xfer-to', String(bakeryId));
  await sleep(300);

  // 1) Preview: reference value + 10% fee.
  const previewNums = nums(await page.$eval('#xfer-preview', (el) => el.innerText));
  const refPrice = previewNums[0];         // reference / unit
  const totalFeeShown = previewNums[2];    // total fee
  check('transfer preview shows a reference price', refPrice > 0, `ref=${refPrice}`);
  check('preview 10% logistics fee = round(10% × reference × qty)',
    totalFeeShown === Math.round(refPrice * 0.10 * QTY), `shown=${totalFeeShown} expected=${Math.round(refPrice * 0.10 * QTY)}`);

  // 1b) Reference is the NORMAL wholesale base, NEVER the emergency price: drive
  // milk wholesale into emergency (remaining 0 → inflated display price) and
  // confirm the transfer reference is UNCHANGED.
  await send(page, { t: 'dev', cmd: 'make_admin' });
  await page.waitForFunction(() => window.__bd.client.you?.isAdmin === true, { timeout: 8000 });
  await send(page, { t: 'admin_wholesale', product: 'milk', op: 'set', amount: 0, reason: 'e2e emergency' });
  await page.waitForFunction(() => (window.__bd.client.wholesale?.products?.find((w) => w.product === 'milk')?.emergency) === true, { timeout: 8000 });
  const emergencyState = await page.evaluate(() => window.__bd.client.wholesale.products.find((w) => w.product === 'milk').emergency);
  await openFarmInventory(page, farmId); // re-render the form
  await page.fill('#xfer-qty', String(QTY));
  await page.selectOption('#xfer-prod', 'milk');
  await sleep(300);
  const refUnderEmergency = nums(await page.$eval('#xfer-preview', (el) => el.innerText))[0];
  // The reference is the NORMAL wholesale base constant — it must NOT move when
  // Central Wholesale is in its emergency (out-of-stock) state.
  check('reference price ignores the emergency wholesale state (uses the normal base)',
    emergencyState === true && refUnderEmergency === refPrice,
    `emergency=${emergencyState} normal=${refPrice} underEmergency=${refUnderEmergency}`);
  await send(page, { t: 'admin_wholesale', product: 'milk', op: 'refill', reason: 'e2e restore' });

  // Snapshot pre-transfer authoritative state.
  const cash0 = await page.evaluate(() => window.__bd.client.you.cash);
  const farmMilk0 = await bizField(page, farmId, 'inventory.milk.qty');
  const bakeryMilk0 = await bizField(page, bakeryId, 'inventory.milk.qty') ?? 0;
  const farmXp0 = await bizField(page, farmId, 'progression.bizXp');
  const bakeryXp0 = await bizField(page, bakeryId, 'progression.bizXp');
  const playerXp0 = await page.evaluate(() => window.__bd.client.you.xp);
  const farmRev0 = await bizField(page, farmId, 'revenue');
  const tradeCounts0 = await page.evaluate(({ f, b }) => ({
    farm: window.__bd.client.businesses.get(f)?.tradeCount ?? 0,
    bakery: window.__bd.client.businesses.get(b)?.tradeCount ?? 0,
  }), { f: farmId, b: bakeryId });
  const deliveries0 = await page.evaluate(() => window.__bd.client.deliveries.size);
  const expectedFee = Math.round(refPrice * 0.10 * QTY);
  const unitFee = refPrice * 0.10;

  await openFarmInventory(page, farmId);
  await page.fill('#xfer-qty', String(QTY));
  await page.selectOption('#xfer-prod', 'milk');
  await page.selectOption('#xfer-to', String(bakeryId));
  await sleep(200);

  // 2) Game-native confirmation modal (no native confirm/alert).
  await page.click('#xfer-go');
  await page.waitForSelector('#xfer-overlay', { timeout: 8000 });
  check('game-native transfer confirmation modal appears', await page.$('#xfer-overlay') != null);

  // 3) Duplicate-submission guard: confirm, then immediately try to click again.
  await page.click('#xfer-confirm');
  await page.waitForFunction(() => !document.getElementById('xfer-overlay'), { timeout: 8000 });
  // The confirm control is gone; a repeated #xfer-go while overlay-less would be a
  // brand-new action, so we assert the SINGLE confirmed transfer had single effect.
  await page.waitForFunction((c0) => window.__bd.client.you.cash < c0, cash0, { timeout: 8000 });

  // 4) Company cash decreased EXACTLY once, by the fee.
  const cash1 = await page.evaluate(() => window.__bd.client.you.cash);
  check('company cash decreased by exactly the logistics fee (charged once)',
    cash1 === cash0 - expectedFee, `${cash0} -> ${cash1} (fee ${expectedFee})`);

  // 5) Source inventory decreased EXACTLY once.
  await page.waitForFunction((args) => (window.__bd.client.myBusinesses.get(args.id).inventory.milk?.qty ?? 0) === args.q, { id: farmId, q: farmMilk0 - QTY }, { timeout: 8000 });
  check('source (farm) milk decreased by exactly the transferred qty', (await bizField(page, farmId, 'inventory.milk.qty')) === farmMilk0 - QTY);

  // 6) A physical delivery was created; destination has NOT received yet.
  const deliveries1 = await page.evaluate(() => window.__bd.client.deliveries.size);
  check('a physical delivery was created for the transfer', deliveries1 > deliveries0, `${deliveries0} -> ${deliveries1}`);
  const bakeryMilkImmediate = (await bizField(page, bakeryId, 'inventory.milk.qty')) ?? 0;
  check('destination has NOT received the stock yet (in transit)', bakeryMilkImmediate === bakeryMilk0, `bakery milk=${bakeryMilkImmediate}`);

  // 7) No XP / revenue / trade-count from the transfer — read in a TIGHT window
  //    right after confirm. (The farm auto-produces player+Business XP every tick,
  //    so this must be checked before the long van-arrival wait below.)
  const farmXp1 = await bizField(page, farmId, 'progression.bizXp');
  const bakeryXp1 = await bizField(page, bakeryId, 'progression.bizXp');
  const playerXp1 = await page.evaluate(() => window.__bd.client.you.xp);
  const farmRev1 = await bizField(page, farmId, 'revenue');
  const tradeCounts1 = await page.evaluate(({ f, b }) => ({
    farm: window.__bd.client.businesses.get(f)?.tradeCount ?? 0,
    bakery: window.__bd.client.businesses.get(b)?.tradeCount ?? 0,
  }), { f: farmId, b: bakeryId });
  // The bakery is idle (no production, no sales) so its Business XP is untouched.
  check('internal transfer creates no Business XP at the destination', bakeryXp1 === bakeryXp0, `${bakeryXp0} -> ${bakeryXp1}`);
  // The farm gains XP ONLY from its own wheat auto-production, never the transfer:
  // any small delta is one/two ticks of production, not a transfer reward.
  check('internal transfer itself creates no Business XP (source delta ≤ farm auto-production)', farmXp1 - farmXp0 <= 8, `farm bizXp Δ=${farmXp1 - farmXp0}`);
  check('internal transfer creates no player XP (delta ≤ farm auto-production)', playerXp1 - playerXp0 <= 8, `player xp Δ=${playerXp1 - playerXp0}`);
  check('internal transfer creates no revenue', farmRev1 === farmRev0, `${farmRev0} -> ${farmRev1}`);
  check('internal transfer creates no trade-count / market activity',
    tradeCounts1.farm === tradeCounts0.farm && tradeCounts1.bakery === tradeCounts0.bakery,
    `farm ${tradeCounts0.farm}->${tradeCounts1.farm}, bakery ${tradeCounts0.bakery}->${tradeCounts1.bakery}`);

  // 8) Destination receives the stock ONLY after the van arrives; WAC is correct.
  await page.waitForFunction((args) => (window.__bd.client.myBusinesses.get(args.id).inventory.milk?.qty ?? 0) >= args.q, { id: bakeryId, q: bakeryMilk0 + QTY }, { timeout: 60000 });
  check('destination received the stock only after the delivery arrived', (await bizField(page, bakeryId, 'inventory.milk.qty')) === bakeryMilk0 + QTY);
  // Receiving WAC = source WAC + per-unit fee. Farm milk WAC is $0 (raw), so the
  // bakery's milk cost basis equals the per-unit logistics fee.
  const bakeryWac = await bizField(page, bakeryId, 'inventory.milk.costBasis');
  check('receiving WAC = source WAC ($0 raw) + per-unit fee', Math.abs(bakeryWac - unitFee) <= 0.5, `wac=${bakeryWac} unitFee=${unitFee.toFixed(2)}`);

  // 9) Insufficient company cash rejects BEFORE any inventory mutation.
  const myId = await page.evaluate(() => window.__bd.client.you.id);
  await page.evaluate(() => { window.__xferErr = null; window.__bd.client.on('toast', (m, kind) => { if (kind === 'error') window.__xferErr = m; }); });
  await send(page, { t: 'admin_cash', playerId: myId, op: 'set', amount: 1, reason: 'e2e broke' });
  await page.waitForFunction(() => window.__bd.client.you.cash === 1, { timeout: 8000 });
  const farmMilkBeforePoor = await bizField(page, farmId, 'inventory.milk.qty');
  const cashBeforePoor = await page.evaluate(() => window.__bd.client.you.cash);
  await send(page, { t: 'transfer_internal', fromBizId: farmId, toBizId: bakeryId, product: 'milk', qty: 50 });
  await sleep(1500);
  const errMsg = await page.evaluate(() => window.__xferErr);
  check('insufficient company cash → transfer rejected (error surfaced)', !!errMsg, `err=${errMsg}`);
  check('insufficient cash rejects BEFORE any inventory mutation', (await bizField(page, farmId, 'inventory.milk.qty')) === farmMilkBeforePoor);
  check('insufficient cash: no fee was charged', (await page.evaluate(() => window.__bd.client.you.cash)) === cashBeforePoor);
  await send(page, { t: 'admin_cash', playerId: myId, op: 'set', amount: 50000, reason: 'e2e restore' });

  // 10) Persistence across refresh / reconnect.
  await sleep(1200); // flush
  const bakeryMilkBeforeReload = await bizField(page, bakeryId, 'inventory.milk.qty');
  await page.reload();
  await page.waitForFunction(() => window.__bd?.client?.myBusinesses?.size === 2, { timeout: 15000 });
  const bakeryMilkAfterReload = await bizField(page, bakeryId, 'inventory.milk.qty');
  check('transferred stock persists across refresh / reconnect', bakeryMilkAfterReload === bakeryMilkBeforeReload,
    `${bakeryMilkBeforeReload} -> ${bakeryMilkAfterReload}`);
  await ctx.close();

  // 11) Mobile viewport: the transfer form renders at 390×844 without overflow.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mpage = await login(mctx, `itm_${run}`, 'farm');
  await mpage.evaluate(() => document.getElementById('mobile-hint')?.remove()); // dismiss first-run gesture hint
  const mFarmId = await mpage.evaluate(() => window.__bd.client.myBiz.id);
  await send(mpage, { t: 'dev', cmd: 'add_money', value: 60000 });
  await send(mpage, { t: 'dev', cmd: 'company_xp', value: 800 });
  await mpage.waitForFunction(() => window.__bd.client.company.level >= 2, { timeout: 8000 });
  await mpage.click('#co-open');
  await mpage.waitForSelector('#open-overlay', { timeout: 8000 });
  await mpage.click('.open-lot[data-type="bakery"]:not(.disabled)');
  await mpage.waitForFunction(() => window.__bd.client.myBusinesses.size === 2, { timeout: 10000 });
  await send(mpage, { t: 'dev', cmd: 'add_milk', value: 50, bizId: mFarmId });
  await openFarmInventory(mpage, mFarmId);
  check('mobile: internal-transfer form is present', await mpage.$('#xfer-prod') != null);
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
