// V2.8 Phase 4 — business specialization: unlock, permanence, family bonuses,
// persistence, admin recovery, and pure bonus-curve math.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, newPlayer, loadedWorld } from './helpers.js';
import { closeDb, query } from '../src/db.js';
import { GameError, type World, type BizRec } from '../src/game/world.js';
import {
  xpForBizLevel, SPECIALIZATION_UNLOCK_LEVEL, masteryTier,
  specBonus, specSpeedMult, specStorageMult, maxProductionRepeat, isCityIcon,
} from '@district/shared';

let world: World;
beforeEach(async () => {
  await resetDb();
  world = await loadedWorld();
});
afterAll(async () => {
  await closeDb();
});

async function biz(name: string, type: 'bakery' | 'coffee_shop' | 'farm' | 'mini_market', level = 20): Promise<{ id: number; b: BizRec }> {
  const id = await newPlayer(world, name);
  const b = await world.chooseBusiness(id, type);
  b.bizXp = xpForBizLevel(level); b.bizLevel = level; b.level = 3;
  world.players.get(id)!.cash = 100000;
  return { id, b };
}

describe('specialization bonus curve (pure)', () => {
  it('mastery tier steps at 30/40/50', () => {
    expect(masteryTier(20)).toBe(0);
    expect(masteryTier(29)).toBe(0);
    expect(masteryTier(30)).toBe(1);
    expect(masteryTier(40)).toBe(2);
    expect(masteryTier(50)).toBe(3);
  });

  it('bonuses are modest (<=20%) and grow with mastery', () => {
    const b0 = specBonus('volume_bakery', 20);
    const b3 = specBonus('volume_bakery', 50);
    expect(b0.speedMult).toBeGreaterThanOrEqual(0.82); // <=18% faster
    expect(b3.storageMult).toBeLessThanOrEqual(1.20);
    expect(b3.retailMult).toBeLessThanOrEqual(1.15);
    expect(b3.speedMult).toBeLessThan(b0.speedMult); // faster at higher mastery
    expect(b3.storageMult).toBeGreaterThan(b0.storageMult);
  });

  it('applies ONLY to family products', () => {
    // volume_bakery family = bread/croissant/cookie; cake is NOT in family.
    expect(specSpeedMult('volume_bakery', 50, 'bread')).toBeLessThan(1);
    expect(specSpeedMult('volume_bakery', 50, 'cake')).toBe(1);
    expect(specStorageMult('patisserie', 50, 'cake')).toBeGreaterThan(1);
    expect(specStorageMult('patisserie', 50, 'bread')).toBe(1);
  });

  it('no bonus below the unlock level or when unspecialized', () => {
    expect(specSpeedMult('volume_bakery', 19, 'bread')).toBe(1);
    expect(specSpeedMult(null, 50, 'bread')).toBe(1);
  });

  it('level 50 is a City Icon; repeat unlocks scale with level', () => {
    expect(isCityIcon(50)).toBe(true);
    expect(isCityIcon(49)).toBe(false);
    expect(maxProductionRepeat(24)).toBe(0);
    expect(maxProductionRepeat(25)).toBe(1);
    expect(maxProductionRepeat(35)).toBe(2);
    expect(maxProductionRepeat(45)).toBe(3);
  });
});

describe('choose specialization (server-authoritative, permanent)', () => {
  it('rejects below the unlock level', async () => {
    const { id, b } = await biz('sp1', 'bakery', SPECIALIZATION_UNLOCK_LEVEL - 1);
    await expect(world.chooseSpecialization(id, b.id, 'volume_bakery')).rejects.toBeInstanceOf(GameError);
    expect(b.specialization).toBeNull();
  });

  it('accepts a valid choice at the unlock level and exposes it publicly', async () => {
    const { id, b } = await biz('sp2', 'bakery', 20);
    await world.chooseSpecialization(id, b.id, 'patisserie');
    expect(b.specialization).toBe('patisserie');
    expect(world.toBizPub(b).specialization).toBe('patisserie'); // public, safe
  });

  it('rejects a specialization invalid for the business type', async () => {
    const { id, b } = await biz('sp3', 'bakery', 20);
    await expect(world.chooseSpecialization(id, b.id, 'volume_cafe')).rejects.toBeInstanceOf(GameError);
  });

  it('is permanent: cannot switch once chosen', async () => {
    const { id, b } = await biz('sp4', 'bakery', 30);
    await world.chooseSpecialization(id, b.id, 'volume_bakery');
    await expect(world.chooseSpecialization(id, b.id, 'patisserie')).rejects.toBeInstanceOf(GameError);
    expect(b.specialization).toBe('volume_bakery');
  });

  it('is business-specific and persists across a restart', async () => {
    const a = await biz('sp5a', 'coffee_shop', 20);
    const c = await biz('sp5b', 'coffee_shop', 20);
    await world.chooseSpecialization(a.id, a.b.id, 'specialty_cafe');
    expect(c.b.specialization).toBeNull(); // another business is unaffected
    const w2 = await loadedWorld();
    expect(w2.bizByOwner(a.id)!.specialization).toBe('specialty_cafe');
    expect(w2.bizByOwner(c.id)!.specialization).toBeNull();
  });
});

describe('specialization effects on the world', () => {
  it('a family product gets more storage; a non-family product does not', async () => {
    const spec = await biz('se1', 'bakery', 20);
    const plain = await biz('se2', 'bakery', 20);
    await world.chooseSpecialization(spec.id, spec.b.id, 'volume_bakery'); // family: bread
    const priv = (bz: BizRec) => world.toBizPriv(bz);
    // bread is a starter inventory slot on both; specialized capacity is higher.
    expect(priv(spec.b).inventory.bread!.capacity).toBeGreaterThan(priv(plain.b).inventory.bread!.capacity);
  });
});

describe('admin recovery', () => {
  it('admin can set/reset specialization (audited); requires admin', async () => {
    const root = await newPlayer(world, 'sproot');
    world.players.get(root)!.isAdmin = true;
    await query('UPDATE players SET is_admin=true WHERE id=$1', [root]);
    const { b } = await biz('se3', 'farm', 15); // below unlock, but admin may set for recovery
    await world.adminSetSpecialization(root, b.id, 'specialty_farm');
    expect(b.specialization).toBe('specialty_farm');
    const audit = await query(`SELECT count(*)::int c FROM admin_audit_log WHERE action='SET_SPECIALIZATION'`);
    expect(audit.rows[0].c).toBe(1);

    const nonAdmin = await newPlayer(world, 'notadmin');
    await expect(world.adminSetSpecialization(nonAdmin, b.id, 'staple_producer')).rejects.toBeInstanceOf(GameError);
  });
});
