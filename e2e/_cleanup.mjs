// E2E maintenance: hard-delete leftover E2E test players (usernames with 4+
// consecutive digits, e.g. cx_123456) through the game's own admin API, freeing
// their city lots. Never touches real accounts. Run: node e2e/_cleanup.mjs
import { chromium } from 'playwright';

const CLIENT_URL = process.env.E2E_CLIENT_URL || 'http://localhost:5173';
const SERVER_URL = process.env.E2E_SERVER_URL || 'http://localhost:2567';
const KEEP = new Set(['ege']); // never delete real accounts

try { const h = await fetch(`${SERVER_URL}/api/health`); if (!h.ok) throw 0; }
catch { console.error('Server not reachable'); process.exit(2); }

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const run = Date.now() % 1000000;
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(CLIENT_URL);
await page.waitForSelector('#auth-user', { timeout: 15000 });
await page.fill('#auth-user', `cleanup_${run}`); // no business chosen -> consumes no lot
await page.fill('#auth-pass', 'e2e-pass-1234');
await page.click('#auth-go');
await page.waitForFunction(() => window.__bd?.client?.you != null, { timeout: 15000 });
const send = (m) => page.evaluate((x) => window.__bd.client.send(x), m);
await send({ t: 'dev', cmd: 'make_admin' });
await page.waitForFunction(() => window.__bd.client.you?.isAdmin === true, { timeout: 8000 });

const isTest = (u) => /\d{4,}/.test(u) && !KEEP.has(u) && u !== `cleanup_${run}`;
let deleted = 0;
for (let round = 0; round < 40; round++) {
  await page.evaluate(() => { window.__bd.client.adminPlayers = []; window.__bd.client.send({ t: 'admin_search_players', q: '', filter: 'all' }); });
  await page.waitForFunction(() => window.__bd.client.adminPlayers.length >= 0, null, { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 400));
  const targets = await page.evaluate(() => window.__bd.client.adminPlayers.map((p) => ({ id: p.id, u: p.username })));
  const todo = targets.filter((t) => isTest(t.u));
  if (!todo.length) break;
  for (const t of todo) {
    await send({ t: 'admin_hard_delete', playerId: t.id, confirmName: t.u, reason: 'e2e cleanup' });
    deleted++;
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`cleanup: hard-deleted ${deleted} test player(s)`);
await browser.close();
process.exit(0);
