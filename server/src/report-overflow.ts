// V2.6.2 — admin-safe over-capacity report.
// Lists businesses whose stored inventory exceeds a product's capacity (legacy
// overflow from before the storage invariant was enforced). READ-ONLY: it never
// modifies or deletes any player goods.
//
//   npm run report:overflow -w server
import { World } from './game/world.js';
import { closeDb } from './db.js';

async function main() {
  const world = new World();
  await world.load();
  const rows = world.overCapacityReport();
  if (rows.length === 0) {
    console.log('No over-capacity businesses. Storage invariant holds everywhere.');
  } else {
    console.log(`${rows.length} over-capacity slot(s) found (goods preserved, further inbound blocked until reduced):\n`);
    console.log('business  owner            type          product  capacity   used  overflow');
    for (const r of rows) {
      console.log(
        String(r.bizId).padEnd(9) +
        r.ownerName.slice(0, 15).padEnd(17) +
        r.type.padEnd(14) +
        r.product.padEnd(9) +
        String(r.capacity).padStart(8) +
        String(r.used).padStart(7) +
        String(r.overflow).padStart(10)
      );
    }
  }
  await closeDb();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
