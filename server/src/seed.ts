// Seed script: ensures schema exists. The city itself is data-driven
// from @district/shared and needs no rows; player accounts are created
// through the auth API. Kept as a distinct step so a future phase can
// seed NPC content here.
import { migrate, query, closeDb } from './db.js';

async function main() {
  await migrate();
  const players = await query('SELECT count(*)::int AS n FROM players');
  console.log(`[seed] database ready (${players.rows[0].n} player(s) present)`);
  await closeDb();
}

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
