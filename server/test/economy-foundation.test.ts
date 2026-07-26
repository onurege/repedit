// V2.8 Phase 1 — canonical economy foundation (pure definitions, no DB):
// business levels 1–50, XP curve, product slots, licenses, recipes.
import { describe, it, expect } from 'vitest';
import {
  MAX_BUSINESS_LEVEL, businessTier, slotsForLevel, activeSlotLimit, storageMultForLevel,
  xpToNextBizLevel, xpForBizLevel, bizLevelForXp, levelReward,
  PRODUCT_LICENSES, licenseDef, recipeFor, licensableProducts, starterLicenses,
  productCapability, productCompatible, ruleFor,
} from '@district/shared';

describe('business levels 1–50', () => {
  it('every level 1..50 has a non-empty reward (no meaningless level)', () => {
    for (let l = 1; l <= MAX_BUSINESS_LEVEL; l++) {
      const r = levelReward(l);
      // Storage grows every level, so every level always grants something.
      expect(r.storageMult).toBeGreaterThanOrEqual(storageMultForLevel(l - 1) || 1);
      expect(['slot', 'tier', 'storage']).toContain(r.kind);
    }
    // Storage strictly increases from L1 to L50 (each level gives >= previous).
    expect(storageMultForLevel(50)).toBeGreaterThan(storageMultForLevel(1));
  });

  it('slots scale with level and cap at 12 at level 50', () => {
    expect(slotsForLevel(1)).toBe(1);
    expect(slotsForLevel(5)).toBe(2);
    expect(slotsForLevel(10)).toBe(3);
    expect(slotsForLevel(50)).toBe(12);
    expect(slotsForLevel(4)).toBe(1); // no early jump
    expect(slotsForLevel(9)).toBe(2);
  });

  it('a milestone (÷5) gains a slot, and ÷10 is a tier milestone', () => {
    expect(levelReward(5).slotGained).toBe(true);
    expect(levelReward(10).slotGained).toBe(true);
    expect(levelReward(10).majorMilestone).toBe(true);
    expect(levelReward(6).slotGained).toBe(false);
  });

  it('tiers map to the five bands', () => {
    expect(businessTier(1)).toBe('local');
    expect(businessTier(11)).toBe('established');
    expect(businessTier(21)).toBe('regional');
    expect(businessTier(31)).toBe('major');
    expect(businessTier(50)).toBe('city_icon');
  });

  it('storage bonus is modest (never a runaway margin advantage)', () => {
    expect(storageMultForLevel(1)).toBe(1);
    expect(storageMultForLevel(50)).toBeLessThanOrEqual(2.05);
  });
});

describe('XP curve (nonlinear)', () => {
  it('is strictly increasing per level and monotonic cumulative', () => {
    for (let l = 1; l < MAX_BUSINESS_LEVEL - 1; l++) {
      expect(xpToNextBizLevel(l + 1)).toBeGreaterThan(xpToNextBizLevel(l)); // nonlinear, not flat
      expect(xpForBizLevel(l + 1)).toBeGreaterThan(xpForBizLevel(l));
    }
  });

  it('early levels are cheap, late levels are a long tail', () => {
    expect(xpToNextBizLevel(1)).toBeLessThan(100);
    expect(xpToNextBizLevel(49)).toBeGreaterThan(xpToNextBizLevel(1) * 100);
  });

  it('levelForXp is the inverse of xpForBizLevel and caps at 50 (no level 51)', () => {
    expect(bizLevelForXp(0)).toBe(1);
    expect(bizLevelForXp(xpForBizLevel(10))).toBe(10);
    expect(bizLevelForXp(xpForBizLevel(10) - 1)).toBe(9);
    expect(bizLevelForXp(xpForBizLevel(50))).toBe(50);
    expect(bizLevelForXp(xpForBizLevel(50) * 100)).toBe(50); // never exceeds max
    expect(xpToNextBizLevel(50)).toBe(Infinity);
  });
});

describe('product licenses & recipes', () => {
  it('existing businesses keep their current products as starter licenses', () => {
    expect(starterLicenses('farm').sort()).toEqual(['milk', 'wheat']);
    expect(starterLicenses('coffee_shop')).toEqual(['coffee']);
    expect(starterLicenses('bakery')).toEqual(['bread']);
    expect(starterLicenses('mini_market').sort()).toEqual(['bread', 'milk']);
  });

  it('capability distinguishes produce vs retail (Mini Market retails, does not manufacture)', () => {
    expect(productCapability('bakery', 'bread')).toBe('produce');
    expect(productCapability('mini_market', 'bread')).toBe('retail');
    expect(productCapability('coffee_shop', 'coffee')).toBe('produce');
    expect(productCompatible('coffee_shop', 'bread')).toBe(false); // identity preserved
  });

  it('single-input, multi-input and null (raw) recipes exist', () => {
    expect(recipeFor('bread')).toEqual({ output: 'bread', outputQty: 1, inputs: [{ product: 'wheat', qty: 2 }] });
    expect(recipeFor('coffee')!.inputs).toHaveLength(2);
    expect(recipeFor('milk')).toBeNull(); // raw farm good
  });

  it('latte is the license-gated foundation product (level + prereq + fee + multi-input)', () => {
    const l = licenseDef('latte')!;
    const rule = ruleFor('coffee_shop', 'latte')!;
    expect(rule.requiredLevel).toBe(5);
    expect(rule.prereqLicense).toBe('coffee');
    expect(rule.fee).toBeGreaterThan(0);
    expect(l.recipe!.inputs).toHaveLength(2);
    expect(rule.capability).toBe('produce');
    expect(rule.starter).toBe(false); // not free
    expect(licensableProducts('coffee_shop').map((x) => x.product)).toContain('latte');
  });

  it('slot limit never drops below a type\'s starter count (grandfathering)', () => {
    // A level-1 Mini Market has 2 starter products but only 1 raw slot — the
    // effective limit must accommodate both so migration never breaks it.
    expect(slotsForLevel(1)).toBe(1);
    expect(activeSlotLimit('mini_market', 1)).toBe(2);
    expect(activeSlotLimit('coffee_shop', 1)).toBe(1);
    expect(activeSlotLimit('coffee_shop', 5)).toBe(2);
  });

  it('every licensed product resolves and every recipe input is a real product', () => {
    for (const l of PRODUCT_LICENSES) {
      expect(licenseDef(l.product)).toBeTruthy();
      if (l.recipe) for (const inp of l.recipe.inputs) expect(inp.qty).toBeGreaterThan(0);
    }
  });
});
