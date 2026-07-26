// BUSINESS DISTRICT — V2.2 market share & city rankings E2E.
//
// Two bakeries compete for the city's NPC BREAD demand. Sales are generated
// through the real game systems (dev tools accelerate time and seed wheat —
// no ranking tables are touched directly). We then verify:
//   - both companies appear in the Bread ranking, ordered by real sales
//   - each company's Bread market share reflects its share of total city sales
//   - the Company Profile shows the Bread market share
//   - clicking a City Rankings row opens that company's profile (navigation)
//
// Prereqs: dev stack running with dev tools (npm run dev), Chromium available.
// Run: npm run e2e:rankings

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

async function newBakery(name) {
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] PAGEERROR: ${e.message}`));
  await page.goto(CLIENT_URL);
  await page.waitForSelector('#auth-user', { timeout: 15000 });
  await page.fill('#auth-user', name);
  await page.fill('#auth-pass', 'e2e-pass-1234');
  await page.click('#auth-go');
  await page.waitForSelector('.choice', { timeout: 10000 });
  await page.click('.choice[data-type="bakery"]');
  await page.waitForFunction(() => window.__bd?.client?.company != null, { timeout: 10000 });
  return page;
}
const send = (page, msg) => page.evaluate((m) => window.__bd.client.send(m), msg);
const soldBread = (page) => page.evaluate(() => window.__bd.client.myBiz?.coffeeSold ?? 0);
const companyId = (page) => page.evaluate(() => window.__bd.client.company.id);

// Turn `wheat` units into bread (V2.8 Phase 2: manual production) and wait until
// it has all sold out to NPCs, so each company's bread total is stable and the
// ordering is deterministic. Batches are sized to the free finished-goods space
// so they always fit as customers drain stock.
async function sellOut(page, wheat) {
  await send(page, { t: 'dev', cmd: 'speed', value: 20 });
  await send(page, { t: 'dev', cmd: 'add_wheat', value: wheat });
  await page.waitForFunction(
    () => {
      const c = window.__bd.client; const b = c.myBiz;
      const e = b.inventory.bread ?? { qty: 0, reserved: 0, capacity: 0 };
      const w = b.inventory.wheat?.qty ?? 0;
      const busy = (b.productionLine?.jobs?.length ?? 0) > 0;
      if (!busy && w === 0 && (e.qty ?? 0) === 0 && b.coffeeSold > 0) return true;
      const free = Math.max(0, e.capacity - e.qty - e.reserved);
      const batch = Math.min(free, w);
      if (!busy && batch >= 1) {
        c.send({ t: 'start_production', bizId: b.id, product: 'bread', qty: batch });
        setTimeout(() => c.send({ t: 'dev', cmd: 'finish_production' }), 250);
      }
      return false;
    },
    null,
    { timeout: 90000 }
  );
  await send(page, { t: 'dev', cmd: 'speed', value: 1 });
}

// ---------- generate real bread sales ----------
const A = await newBakery(`bakeA_${run}`);
const B = await newBakery(`bakeB_${run}`);
await sellOut(A, 80); // A gets the larger stock -> should out-sell B
await sellOut(B, 25);
await sleep(2500); // let the server flush activity to the DB

const aSold = await soldBread(A);
const bSold = await soldBread(B);
const aCo = await companyId(A);
const bCo = await companyId(B);
check('A sold bread to NPC customers', aSold > 0, `A=${aSold}`);
check('B sold bread to NPC customers', bSold > 0, `B=${bSold}`);
check('A out-sold B (deterministic ordering)', aSold > bSold, `A=${aSold} B=${bSold}`);

// ---------- A opens City Rankings ----------
await A.click('#nav-rankings');
await A.waitForFunction(() => window.__bd.client.rankings != null, { timeout: 8000 });
// Select the Bread board.
await A.click('.panel-tabs button[data-tab="bread"]');
await A.waitForFunction(() => {
  const p = document.querySelector('.panel-tabs button[data-tab="bread"]');
  return p && p.classList.contains('active');
}, { timeout: 5000 });

const breadBoard = await A.evaluate(() =>
  window.__bd.client.rankings.boards.find((x) => x.category === 'bread')
);
const inBoard = breadBoard.top.map((r) => r.companyId);
check('A appears in the Bread ranking', inBoard.includes(aCo));
check('B appears in the Bread ranking', inBoard.includes(bCo));
check('Bread ranking is ordered by sales (A above B)',
  inBoard.indexOf(aCo) < inBoard.indexOf(bCo),
  `order=${inBoard.join(',')}`);
check('Bread ranking value matches A\'s real sales', breadBoard.top[0].value === aSold,
  `board=${breadBoard.top[0].value} sold=${aSold}`);

// ---------- market share reflects real sales ----------
const profA = await A.evaluate((cid) =>
  new Promise((resolve) => {
    const c = window.__bd.client;
    const on = (p) => { if (p.id === cid) { resolve(p); } };
    c.on('company_profile', on);
    c.send({ t: 'get_company_profile', companyId: cid });
  }), aCo);
const share = profA.marketShares.find((m) => m.product === 'bread');
check('Company Profile shows a Bread market share', !!share);
check('market share city total = A + B bread sales', share.cityUnits === aSold + bSold,
  `city=${share.cityUnits} expected=${aSold + bSold}`);
check('A\'s bread units match its real sales', share.units === aSold, `units=${share.units}`);
check('A\'s bread share is A / city', Math.abs(share.share - aSold / (aSold + bSold)) < 1e-6,
  `share=${share.share.toFixed(4)}`);
check('A is city rank #1 for bread', share.rank === 1, `rank=${share.rank}`);

// ---------- City Rankings links to Company Profile ----------
await A.click('#nav-rankings');
await A.waitForSelector('.rank-row[data-rank-co]', { timeout: 8000 });
await A.click(`.rank-row[data-rank-co="${bCo}"]`);
await A.waitForFunction((cid) => window.__bd.client.companyProfile?.id === cid, bCo, { timeout: 8000 });
const openedName = await A.evaluate(() => document.getElementById('panel-title')?.textContent || '');
check('clicking a ranking row opens that company\'s profile', openedName.includes('bake'), `title="${openedName}"`);

await browser.close();
console.log(failures === 0 ? '\nV2.2 RANKINGS: ALL CHECKS PASSED' : `\nV2.2 RANKINGS: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
