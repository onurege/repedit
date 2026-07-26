// V2.8 Phase 3 — canonical catalog integrity, recipe engine, wholesale policy.
import { describe, it, expect } from 'vitest';
import {
  PRODUCTS, type ProductId, type BusinessType, SELLER_SUPPLIES, BUYER_CONSUMES,
  WHOLESALE_PRODUCTS, NPC_WHOLESALE_PRICES, RETAIL_BASE, DEMAND_PRODUCTS,
  CITY_EVENTS, CITY_EVENT_TYPES, unreachableInputs,
} from '@district/shared';
import {
  PRODUCT_LICENSES, licenseDef, recipeFor, ruleFor, licensableProducts,
  productCompatible, isRawProduct, wholesaleEligible, isProducibleProduct,
  planProduction, maxOutputForInputs, retailDemandWeight, npcRetailProducts,
} from '@district/shared';

const ALL: ProductId[] = Object.keys(PRODUCTS) as ProductId[];
const TYPES: BusinessType[] = ['farm', 'coffee_shop', 'bakery', 'mini_market'];

describe('catalog integrity — 14 products', () => {
  it('has exactly the intended 14 products with unique ids, names and emoji', () => {
    expect(ALL).toHaveLength(14);
    for (const id of ALL) {
      const p = PRODUCTS[id];
      expect(p.id).toBe(id);              // id matches key
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.emoji.length).toBeGreaterThan(0);
      expect(p.basePrice).toBeGreaterThan(0);
    }
  });

  it('every license references real products, recipes and prerequisites', () => {
    for (const def of PRODUCT_LICENSES) {
      expect(PRODUCTS[def.product]).toBeDefined();
      // Recipe validity: output exists and equals the product; inputs exist.
      if (def.recipe) {
        expect(def.recipe.output).toBe(def.product);
        expect(def.recipe.outputQty).toBeGreaterThan(0);
        for (const inp of def.recipe.inputs) {
          expect(PRODUCTS[inp.product]).toBeDefined();
          expect(inp.qty).toBeGreaterThan(0);
        }
      }
      // Per-business rules: valid capability + prereq exists in the catalog.
      for (const type of Object.keys(def.rules) as BusinessType[]) {
        const rule = def.rules[type]!;
        expect(['produce', 'retail']).toContain(rule.capability);
        expect(rule.requiredLevel).toBeGreaterThanOrEqual(1);
        expect(rule.fee).toBeGreaterThanOrEqual(0);
        if (rule.prereqLicense) expect(PRODUCTS[rule.prereqLicense]).toBeDefined();
        // A produce rule must have a recipe; a retail rule may not.
        if (rule.capability === 'produce' && isProducibleProduct(def.product)) {
          expect(def.recipe).not.toBeNull();
        }
      }
    }
  });

  it('classifies raw vs finished consistently', () => {
    const raw: ProductId[] = ['milk', 'beans', 'wheat', 'eggs', 'strawberry'];
    for (const p of ALL) expect(isRawProduct(p)).toBe(raw.includes(p));
    // Finished goods have a production recipe and NPC retail demand.
    for (const p of ALL) {
      if (!isRawProduct(p)) {
        expect(recipeFor(p)).not.toBeNull();
        expect(retailDemandWeight(p)).toBeGreaterThan(0);
      }
    }
  });

  it('no recipe input can hard-lock (every input has a supply path)', () => {
    expect(unreachableInputs()).toEqual([]);
  });

  it('business identity: producers make finished goods; the mini market only retails', () => {
    expect(npcRetailProducts('bakery')).toContain('cake');
    expect(npcRetailProducts('coffee_shop')).toContain('cappuccino');
    // Mini market retails a broad assortment but PRODUCES nothing.
    expect(licensableProducts('mini_market').every((l) => l.capability === 'retail')).toBe(true);
    expect(licensableProducts('mini_market').map((l) => l.product)).toContain('strawberry_cake');
    // Farm supplies raw; never a finished good.
    expect(SELLER_SUPPLIES.farm.every(isRawProduct)).toBe(true);
    expect(SELLER_SUPPLIES.bakery.every((p) => !isRawProduct(p))).toBe(true);
  });

  it('progression prerequisites form a sensible chain', () => {
    expect(ruleFor('bakery', 'croissant')!.prereqLicense).toBe('bread');
    expect(ruleFor('bakery', 'cake')!.prereqLicense).toBe('croissant');
    expect(ruleFor('bakery', 'strawberry_cake')!.prereqLicense).toBe('cake');
    expect(ruleFor('coffee_shop', 'latte')!.prereqLicense).toBe('coffee');
    expect(ruleFor('coffee_shop', 'cappuccino')!.prereqLicense).toBe('latte');
  });
});

describe('Central Wholesale policy — raw only (§14)', () => {
  it('sells only raw materials, never processed/finished goods', () => {
    for (const p of WHOLESALE_PRODUCTS) {
      expect(wholesaleEligible(p)).toBe(true);
      expect(isRawProduct(p)).toBe(true);
      expect(NPC_WHOLESALE_PRICES[p]).toBeGreaterThan(0);
    }
    const finished: ProductId[] = ['bread', 'croissant', 'cookie', 'cake', 'strawberry_cake', 'coffee', 'latte', 'cappuccino', 'strawberry_latte'];
    for (const p of finished) {
      expect(WHOLESALE_PRODUCTS).not.toContain(p);
      expect(NPC_WHOLESALE_PRICES[p]).toBeUndefined();
    }
  });

  it('advanced raw (eggs/strawberry) is priced well above the healthy player price', () => {
    // Player farms produce these at ~$0 cost; wholesale sits far above, so player
    // sourcing is strongly preferred but a deadlock is still avoidable.
    expect(NPC_WHOLESALE_PRICES.eggs!).toBeGreaterThan(PRODUCTS.eggs.basePrice);
    expect(NPC_WHOLESALE_PRICES.strawberry!).toBeGreaterThan(PRODUCTS.strawberry.basePrice);
  });
});

describe('recipe engine — all new recipes scale/MAX correctly (§49)', () => {
  const cases: [ProductId, number][] = [
    ['bread', 1], ['croissant', 2], ['cookie', 3], ['cake', 1], ['strawberry_cake', 1],
    ['coffee', 1], ['latte', 1], ['cappuccino', 1], ['strawberry_latte', 1],
  ];
  it.each(cases)('%s scales inputs and output by whole batches', (product, outputQty) => {
    const r = recipeFor(product)!;
    expect(r.outputQty).toBe(outputQty);
    const plan = planProduction(r, outputQty * 10)!; // 10 batches
    expect(plan.batches).toBe(10);
    expect(plan.output).toBe(outputQty * 10);
    for (const inp of r.inputs) {
      expect(plan.inputs.find((i) => i.product === inp.product)!.qty).toBe(inp.qty * 10);
    }
  });

  it('MAX is bounded by the scarcest ingredient across multi-input recipes', () => {
    const cake = recipeFor('cake')!; // 3 wheat + 2 milk + 2 eggs -> 1 cake
    expect(maxOutputForInputs(cake, { wheat: 300, milk: 300, eggs: 10 })).toBe(5); // eggs: 10/2=5
    const sc = recipeFor('strawberry_cake')!;
    expect(maxOutputForInputs(sc, { wheat: 999, milk: 999, eggs: 999, strawberry: 6 })).toBe(3); // straw 6/2=3
  });
});

describe('City Events — product-specific demand for the catalog (§25)', () => {
  it('every demand product is a finished good (or milk) that businesses retail', () => {
    for (const p of DEMAND_PRODUCTS) {
      expect(retailDemandWeight(p)).toBeGreaterThan(0);
    }
  });

  it('event effects reference real products and include the new events', () => {
    expect(CITY_EVENT_TYPES).toContain('morning_rush');
    expect(CITY_EVENT_TYPES).toContain('family_weekend');
    for (const t of CITY_EVENT_TYPES) {
      const eff = CITY_EVENTS[t].effects;
      for (const p of Object.keys(eff.demand ?? {}) as ProductId[]) expect(PRODUCTS[p]).toBeDefined();
      for (const p of Object.keys(eff.wholesale ?? {}) as ProductId[]) expect(PRODUCTS[p]).toBeDefined();
    }
    // City Festival drives premium demand.
    expect(CITY_EVENTS.city_festival.effects.demand!.strawberry_cake).toBeGreaterThan(0);
  });
});
