// V2.8 Phase 3 — deterministic economy simulation (§44-46).
//
// Computes each finished product's profitability from HEALTHY player input prices
// and asserts the balance goals: every product is viable, no product dominates,
// and player sourcing beats Central Wholesale beats Emergency for the same recipe.
// The numeric table this produces is documented in DECISIONS.md.
import { describe, it, expect } from 'vitest';
import {
  PRODUCTS, RETAIL_BASE, NPC_WHOLESALE_PRICES, EMERGENCY_PRICE_MULT,
  PRODUCTION_TIMING, type ProductId,
} from '@district/shared';
import { recipeFor, retailDemandWeight, isRawProduct } from '@district/shared';

// Representative "healthy" player prices for raw inputs (what a farm sells at,
// undercutting the Central Wholesale). Beans are import-only (no farm), so their
// healthy price is the wholesale price.
const HEALTHY: Record<string, number> = {
  wheat: 7, milk: 13, beans: 8, eggs: 16, strawberry: 24,
};
const wholesalePrice = (p: ProductId) => NPC_WHOLESALE_PRICES[p] ?? HEALTHY[p] ?? PRODUCTS[p].basePrice;

// Input cost per 1 output unit at a given source price function.
function unitInputCost(product: ProductId, price: (p: ProductId) => number): number {
  const r = recipeFor(product)!;
  const batch = r.inputs.reduce((s, i) => s + i.qty * price(i.product), 0);
  return batch / r.outputQty;
}
// Seconds to make 1 output unit at level 1 (batch-oriented).
function unitSecs(product: ProductId): number {
  const t = PRODUCTION_TIMING[product]!;
  return t.batchSecs / t.batchSize;
}

const FINISHED: ProductId[] = (Object.keys(PRODUCTS) as ProductId[]).filter((p) => !isRawProduct(p));

interface Row { product: ProductId; cost: number; npc: number; margin: number; weightedMargin: number; marginPerMin: number; }
const table: Row[] = FINISHED.map((product) => {
  const cost = unitInputCost(product, (p) => HEALTHY[p] ?? PRODUCTS[p].basePrice);
  const npc = RETAIL_BASE[product] ?? PRODUCTS[product].basePrice;
  const margin = npc - cost;
  return {
    product, cost, npc, margin,
    weightedMargin: margin * retailDemandWeight(product), // demand-capped throughput proxy
    marginPerMin: (margin / unitSecs(product)) * 60,
  };
});

describe('economy simulation — profitability & balance', () => {
  it('every finished product is viable (positive margin at healthy prices)', () => {
    for (const r of table) {
      expect(r.margin, `${r.product} margin`).toBeGreaterThan(0);
    }
  });

  it('no product dominates: demand-weighted margin spread stays bounded (§45)', () => {
    const w = table.map((r) => r.weightedMargin);
    const max = Math.max(...w), min = Math.min(...w);
    // A 2.5x spread is healthy diversity; a runaway product would blow past it.
    expect(max / min).toBeLessThan(2.5);
  });

  it('bread (high-volume staple) remains a legitimate strategy vs premiums (§19)', () => {
    const bread = table.find((r) => r.product === 'bread')!;
    const premiums = table.filter((r) => ['cake', 'strawberry_cake', 'strawberry_latte'].includes(r.product));
    // Bread's demand-weighted throughput is competitive with the premium goods.
    for (const p of premiums) {
      expect(bread.weightedMargin).toBeGreaterThanOrEqual(p.weightedMargin * 0.8);
    }
  });

  it('player sourcing > Central Wholesale > Emergency for the same recipe (§52)', () => {
    // Compare a product's input cost under each sourcing mode.
    for (const product of FINISHED) {
      const player = unitInputCost(product, (p) => HEALTHY[p] ?? PRODUCTS[p].basePrice);
      const central = unitInputCost(product, wholesalePrice);
      const emergency = unitInputCost(product, (p) => wholesalePrice(p) * EMERGENCY_PRICE_MULT);
      expect(player, `${product} player<central`).toBeLessThanOrEqual(central);
      expect(central, `${product} central<emergency`).toBeLessThan(emergency);
    }
  });

  it('advanced raw (eggs/strawberry) strongly favors player sourcing', () => {
    for (const raw of ['eggs', 'strawberry'] as ProductId[]) {
      expect(HEALTHY[raw]).toBeLessThan(NPC_WHOLESALE_PRICES[raw]! * 0.75);
    }
  });
});
