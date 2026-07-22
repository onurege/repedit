import { query, migrate } from '../src/db.js';
import { World } from '../src/game/world.js';
import { STARTING_CASH } from '@district/shared';

export async function resetDb(): Promise<void> {
  await query('DROP SCHEMA public CASCADE');
  await query('CREATE SCHEMA public');
  await migrate();
}

export async function newPlayer(world: World, name: string): Promise<number> {
  const res = await query(
    'INSERT INTO players (username, pass_hash, cash) VALUES ($1, $2, $3) RETURNING id',
    [name, 'x:y', STARTING_CASH]
  );
  const id = res.rows[0].id;
  await world.ensurePlayer(id);
  return id;
}

export async function loadedWorld(): Promise<World> {
  const world = new World();
  await world.load();
  return world;
}

/** Force all in-transit deliveries to arrive now, then tick once. */
export async function forceDeliveries(world: World): Promise<void> {
  for (const d of world.deliveries.values()) d.arriveAtMs = Date.now() - 1;
  await world.tick(0);
}
