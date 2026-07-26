// BUSINESS DISTRICT — V2.8 Phase 2 Manual Production E2E (real UI).
//
// Prereqs: dev stack running with dev tools (npm run dev). Run: npm run e2e:production
//
// Drives the real Production planner + queue: recipe/requirements/MAX/est-time,
// exactly-once ingredient commitment, job progress, restart persistence,
// authoritative completion + XP, the production queue (two jobs), the
// storage-blocked (WAITING_FOR_STORAGE) path, and a 390x844 mobile pass.
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
const line = (p) => p.evaluate(() => window.__bd.client.myBiz.productionLine);
const inv = (p, prod) => p.evaluate((x) => window.__bd.client.myBiz.inventory[x]?.qty ?? 0, prod);
const bizXp = (p) => p.evaluate(() => window.__bd.client.myBiz.progression.bizXp);
const bizId = (p) => p.evaluate(() => window.__bd.client.myBiz.id);
const bizTab = async (p, tab) => {
  await p.click('#nav-biz'); await p.waitForTimeout(300);
  await p.evaluate((tb) => { const b = [...document.querySelectorAll('#panel-tabs button')].find((x) => x.dataset.tab === tb); b && b.click(); }, tab);
  await p.waitForTimeout(300);
};
const dismiss = (p) => p.evaluate(() => document.querySelectorAll('.overlay.modal, #brief-overlay, #mobile-hint').forEach((o) => o.remove()));

const A = await player(`prodA_${run}`, 'coffee_shop');
await A.waitForTimeout(700); await dismiss(A);
const id = await bizId(A);
// Suppress NPC retail demand so finished-goods counts are deterministic under
// the live tick (production, not retail, is what we are measuring here).
await send(A, { t: 'set_price', price: 100 });
await dev(A, 'make_admin', 0); await A.waitForTimeout(300);
const setCoffee = async (n) => { await send(A, { t: 'admin_inventory', bizId: id, product: 'coffee', op: 'set', amount: n, reason: 'e2e' }); await A.waitForTimeout(300); };

// The Produce tab exists for a producer business.
await A.click('#nav-biz'); await A.waitForTimeout(300);
check('Produce tab is available for a coffee shop', await A.evaluate(() => [...document.querySelectorAll('#panel-tabs button')].some((b) => b.dataset.tab === 'produce')));

// 1) With no ingredients, the planner explains what is missing and START is disabled.
await bizTab(A, 'produce');
check('missing-ingredients panel is shown when short', await A.evaluate(() => !!document.querySelector('.pp-missing')));
check('START is disabled without ingredients', await A.evaluate(() => document.querySelector('#pp-start')?.disabled === true));
check('recipe (inputs → output) is visible', await A.evaluate(() => /→/.test(document.querySelector('.pp-recipe')?.textContent || '')));

// 2) Acquire raw materials via dev, then the planner shows requirements/MAX/time.
await dev(A, 'add_milk', 100); await dev(A, 'add_beans', 100);
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.milk?.qty ?? 0) >= 100, { timeout: 8000 });
await bizTab(A, 'produce');
check('MAX available is shown from ingredients', await A.evaluate(() => /MAX AVAILABLE|MAKS/.test(document.querySelector('.pp-max-lbl')?.textContent || '')));
check('estimated time is shown', await A.evaluate(() => /\d+s/.test(document.body.textContent) && /Estimated time|Tahmini süre/i.test(document.body.textContent)));
check('before → after ingredient preview is shown', await A.evaluate(() => /→/.test(document.querySelector('.pp-reqs')?.textContent || '')));

// 3) Start production of 20 coffee via the real UI; ingredients commit immediately.
const milk0 = await inv(A, 'milk');
await A.evaluate(() => { const i = document.querySelector('#pp-qty'); i.value = '20'; i.dispatchEvent(new Event('change')); });
await A.waitForTimeout(200);
await A.click('#pp-start');
await A.waitForFunction(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) >= 1, { timeout: 8000 });
check('ingredients committed at START (milk −20)', (await inv(A, 'milk')) === milk0 - 20, `${milk0} -> ${await inv(A, 'milk')}`);
check('a producing job appears on the line', await A.evaluate(() => window.__bd.client.myBiz.productionLine.jobs[0].status === 'producing'));
check('coffee not yet in inventory (arrives on completion)', (await inv(A, 'coffee')) === 0);
await bizTab(A, 'produce');
check('progress bar renders for the producing job', await A.evaluate(() => !!document.querySelector('.pq-bar')));

// 4) Persist across a browser reload.
await A.reload(); await A.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 }); await A.waitForTimeout(700); await dismiss(A);
check('production job persists after reload', await A.evaluate(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 1));

// 5) Advance authoritative time (dev fast-forward): coffee enters inventory, job completes, XP up.
const xp0 = await bizXp(A);
await dev(A, 'finish_production', 0);
await A.waitForFunction(() => (window.__bd.client.myBiz.inventory.coffee?.qty ?? 0) >= 20, { timeout: 8000 });
check('finished coffee entered inventory (exactly the batch)', (await inv(A, 'coffee')) === 20);
check('production job left the line on completion', await A.evaluate(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 0));
check('business XP increased from completed production', (await bizXp(A)) === xp0 + 20, `${xp0} -> ${await bizXp(A)}`);

// 6) Queue: clear finished coffee first (room for two batches), then queue two.
await setCoffee(0);
await dev(A, 'add_milk', 100); await dev(A, 'add_beans', 100);
await A.waitForTimeout(400);
const milkQ0 = await inv(A, 'milk');
// Queue two batches. Like a real user, each click lands after the previous
// job appears (the per-business start lock rejects a genuine double-submit).
await send(A, { t: 'start_production', bizId: id, product: 'coffee', qty: 10 });
await A.waitForFunction(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 1, { timeout: 8000 });
await send(A, { t: 'start_production', bizId: id, product: 'coffee', qty: 10 });
await A.waitForFunction(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 2, { timeout: 8000 });
check('two jobs on the line: first producing, second queued', await A.evaluate(() => {
  const j = window.__bd.client.myBiz.productionLine.jobs;
  return j[0].status === 'producing' && j[1].status === 'queued';
}));
check('ingredients committed for BOTH queued jobs (milk −20)', (await inv(A, 'milk')) === milkQ0 - 20);
await bizTab(A, 'produce');
check('queue UI shows NOW + UP NEXT', await A.evaluate(() => !!document.querySelector('.pq-now') && /UP NEXT|SIRADAKİLER/i.test(document.querySelector('.pq')?.textContent || '')));

// Reload mid-queue: state persists.
await A.reload(); await A.waitForFunction(() => window.__bd?.client?.myBiz != null, { timeout: 15000 }); await A.waitForTimeout(700); await dismiss(A);
check('queue persists across reload', await A.evaluate(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 2));

// Finish the whole line: both complete, no duplicate output.
const coffeeBefore = await inv(A, 'coffee');
await dev(A, 'finish_production', 0);
await A.waitForFunction((c) => (window.__bd.client.myBiz.inventory.coffee?.qty ?? 0) === c + 20, coffeeBefore, { timeout: 8000 }).catch(() => {});
check('both queued batches completed (coffee +20, no duplicates)', (await inv(A, 'coffee')) === coffeeBefore + 20, `+${(await inv(A, 'coffee')) - coffeeBefore}`);
check('line empty after finishing the queue', await A.evaluate(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 0));

// 7) Storage-blocked (WAITING_FOR_STORAGE): fill coffee to capacity, then produce.
const cap = await A.evaluate(() => window.__bd.client.myBiz.inventory.coffee?.capacity ?? 0);
await setCoffee(cap); // fill finished-goods storage so a new batch cannot fit
await dev(A, 'add_milk', 100); await dev(A, 'add_beans', 100); await A.waitForTimeout(300);
await send(A, { t: 'start_production', bizId: id, product: 'coffee', qty: 10 });
await A.waitForTimeout(400);
await dev(A, 'finish_production', 0); // completes -> cannot fit -> waiting_storage
await A.waitForFunction(() => window.__bd.client.myBiz.productionLine?.jobs?.[0]?.status === 'waiting_storage', { timeout: 8000 }).catch(() => {});
check('output that will not fit becomes WAITING_FOR_STORAGE', await A.evaluate(() => window.__bd.client.myBiz.productionLine?.jobs?.[0]?.status === 'waiting_storage'));
check('inventory did not overflow capacity', await A.evaluate(() => {
  const e = window.__bd.client.myBiz.inventory.coffee; return e.qty + e.reserved <= e.capacity;
}));
await bizTab(A, 'produce');
check('blocked state is shown to the player', await A.evaluate(() => !!document.querySelector('.pq-now.blocked')));

// Free storage: the server tick completes the blocked job exactly once.
await setCoffee(0);
await A.waitForFunction(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 0, { timeout: 10000 }).catch(() => {});
check('blocked output enters exactly once when space frees', (await inv(A, 'coffee')) === 10, `coffee=${await inv(A, 'coffee')}`);
check('blocked job cleared after completion', await A.evaluate(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) === 0));

// 8) Mobile (390x844): the planner is operable with no horizontal overflow.
const M = await player(`prodM_${run}`, 'coffee_shop', { width: 390, height: 844 });
await M.waitForTimeout(800); await dismiss(M);
await dev(M, 'add_milk', 100); await dev(M, 'add_beans', 100); await M.waitForTimeout(400);
await bizTab(M, 'produce');
check('[mobile] planner renders', await M.evaluate(() => !!document.querySelector('.pp')));
check('[mobile] quantity input + MAX + START all present', await M.evaluate(() => !!document.querySelector('#pp-qty') && !!document.querySelector('#pp-max') && !!document.querySelector('#pp-start')));
check('[mobile] no horizontal overflow', await M.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check('[mobile] START button is a comfortable touch target (>=40px)', await M.evaluate(() => (document.querySelector('#pp-start')?.getBoundingClientRect().height ?? 0) >= 40));
// Start a batch on mobile via the real button.
await M.click('#pp-start');
await M.waitForFunction(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) >= 1, { timeout: 8000 }).catch(() => {});
check('[mobile] production starts from the mobile UI', await M.evaluate(() => (window.__bd.client.myBiz.productionLine?.jobs?.length ?? 0) >= 1));

await browser.close();
console.log(failures ? `\nV2.8 PRODUCTION: ${failures} CHECK(S) FAILED` : '\nV2.8 PRODUCTION: ALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
