// BUSINESS DISTRICT — Phase 3 contract E2E.
//
// Two browser contexts form a recurring supply relationship through the
// real UI:
//   A (Farm)   produces WHEAT
//   B (Bakery) inspects A's farm and proposes a Wheat supply contract
//   A accepts; the contract executes automatically; the van delivers wheat
//
// Prereqs: dev stack running with dev tools (npm run dev), Chromium
// available (CHROMIUM_PATH env). Fresh accounts per run. Run: npm run e2e:contract

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
      biz: c.myBiz && { type: c.myBiz.type, inv: Object.fromEntries(Object.entries(c.myBiz.inventory).map(([k, v]) => [k, v.qty])) },
      contracts: [...c.contracts.values()],
      deliveries: c.deliveries.size,
      businessesSeen: [...c.businesses.values()].map((b) => ({ id: b.id, type: b.type, owner: b.ownerName })),
    };
  });
const send = (page, msg) => page.evaluate((m) => window.__bd.client.send(m), msg);

// ---------- A: farm producing wheat ----------
const A = await newPlayer(`ctA_${run}`, 'farm');
await send(A, { t: 'set_production', product: 'wheat' });
await send(A, { t: 'dev', cmd: 'speed', value: 20 });
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.wheat?.qty ?? 0) >= 60, null, { timeout: 90000 });
check('A (farm) producing wheat', (await S(A)).biz.inv.wheat >= 60);

// ---------- B: bakery inspects A and proposes a contract via the real UI ----------
const B = await newPlayer(`ctB_${run}`, 'bakery');
let b = await S(B);
const farmBiz = b.businessesSeen.find((x) => x.type === 'farm' && x.owner === `ctA_${run}`);
check('B sees A\'s farm in the city', !!farmBiz);

// Open the public inspection panel for A's farm and propose a contract.
await B.evaluate((id) => window.__bd.ui.openInfo(id), farmBiz.id);
await B.waitForSelector('#ct-open', { timeout: 5000 });
check('public business inspection shows Propose Supply Contract', true);
await B.click('#ct-open');
await B.waitForSelector('#ct-send', { timeout: 5000 });
await B.selectOption('#ct-product', 'wheat');
await B.fill('#ct-qty', '50');
await B.fill('#ct-price', '8');
await B.fill('#ct-deliv', '2');
await B.click('#ct-send');
await B.waitForFunction(() => [...window.__bd.client.contracts.values()].some((c) => c.status === 'proposed'), null, { timeout: 8000 });
check('B proposed a supply contract', true);

// ---------- A accepts the proposal via the Contracts panel ----------
await A.waitForFunction(() => [...window.__bd.client.contracts.values()].some((c) => c.status === 'proposed' && c.sellerId === window.__bd.client.you.id), null, { timeout: 8000 });
await A.click('#nav-contracts');
await A.waitForSelector('[data-ct-accept]', { timeout: 5000 });
// Slow to 1x so the farm's own production doesn't mask the -50 contract drop
// (contract execution is wall-clock and fires regardless of game speed).
await send(A, { t: 'dev', cmd: 'speed', value: 1 });
await sleep(1200);
const farmerCash0 = (await S(A)).cash;
const farmerWheat0 = (await S(A)).biz.inv.wheat;
const bakerCash0 = (await S(B)).cash;
await A.click('[data-ct-accept]');
await A.waitForFunction(() => [...window.__bd.client.contracts.values()].some((c) => c.status === 'active'), null, { timeout: 8000 });
check('A accepted — contract ACTIVE', true);

// ---------- first execution happens automatically ----------
// Detect execution unambiguously via the contract's remaining count on both
// sides (the farm produces continuously, so wheat won't drop by exactly 50).
await A.waitForFunction(
  () => [...window.__bd.client.contracts.values()].some((c) => c.remaining <= 1),
  null,
  { timeout: 20000 }
);
await B.waitForFunction(
  () => [...window.__bd.client.contracts.values()].some((c) => c.remaining <= 1),
  null,
  { timeout: 10000 }
);
const a1 = await S(A);
const b1 = await S(B);
check('A wheat dropped ~50 from the contract sale', a1.biz.inv.wheat <= farmerWheat0 - 45, `wheat ${farmerWheat0} -> ${a1.biz.inv.wheat}`);
check('A received $400 payment', a1.cash >= farmerCash0 + 400, `cash ${farmerCash0} -> ${a1.cash}`);
check('B paid $400', b1.cash <= bakerCash0 - 400, `cash ${bakerCash0} -> ${b1.cash}`);
check('contract delivery created', b1.deliveries >= 1 || a1.deliveries >= 1, `A=${a1.deliveries} B=${b1.deliveries}`);
const activeC = b1.contracts.find((c) => c.status === 'active' || c.status === 'completed');
check('remaining deliveries decremented to 1', activeC && activeC.remaining === 1, `remaining=${activeC?.remaining}`);

// ---------- delivery arrives: bakery receives wheat ----------
// (game speed already 1x, so the bakery won't bake the delivered wheat away.)
await B.waitForFunction(() => (window.__bd.client.myBiz.inventory.wheat?.qty ?? 0) >= 45, null, { timeout: 40000 });
check('B (bakery) received ~50 wheat by delivery', (await S(B)).biz.inv.wheat >= 45);
await browser.close();
console.log(failures === 0 ? '\nCONTRACT E2E: ALL CHECKS PASSED' : `\nCONTRACT E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
