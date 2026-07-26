// V2.8 Phase 2 — pure production math (recipe scaling, MAX, duration, queue).
import { describe, it, expect } from 'vitest';
import {
  planProduction, maxBatchesForInputs, maxOutputForInputs,
  productionDurationSecs, productionSpeedMult, productionQueueLimit,
  isProducibleProduct, recipeFor, type Recipe,
} from '@district/shared';

const coffee = recipeFor('coffee')!;           // 1 milk + 1 beans -> 1 coffee
const bread = recipeFor('bread')!;              // 1 wheat -> 1 bread
const latte = recipeFor('latte')!;              // 2 beans + 1 milk -> 1 latte
// Synthetic multi-input, output>1 recipe to prove scaling generality.
const multi: Recipe = { output: 'bread', outputQty: 2, inputs: [{ product: 'wheat', qty: 3 }, { product: 'milk', qty: 2 }] };

describe('planProduction — recipe scaling', () => {
  it('scales a single-input recipe', () => {
    const p = planProduction(bread, 100)!; // V2.8 Phase 3: bread = 2 wheat -> 1 bread
    expect(p.batches).toBe(100);
    expect(p.output).toBe(100);
    expect(p.inputs).toEqual([{ product: 'wheat', qty: 200 }]);
  });

  it('scales a multi-input recipe', () => {
    const p = planProduction(latte, 50)!;
    expect(p.output).toBe(50);
    expect(p.inputs).toEqual([{ product: 'beans', qty: 100 }, { product: 'milk', qty: 50 }]);
  });

  it('scales an outputQty>1 recipe by whole batches', () => {
    const p = planProduction(multi, 100)!;
    expect(p.batches).toBe(50);
    expect(p.output).toBe(100);
    expect(p.inputs).toEqual([{ product: 'wheat', qty: 150 }, { product: 'milk', qty: 100 }]);
  });

  it('normalises a non-multiple output DOWN to whole batches (never fractional)', () => {
    const p = planProduction(multi, 101)!;
    expect(p.output).toBe(100); // 50 batches * 2, not 101
  });

  it('rejects quantities below one batch, zero, negative, and NaN', () => {
    expect(planProduction(multi, 1)).toBeNull();
    expect(planProduction(coffee, 0)).toBeNull();
    expect(planProduction(coffee, -5)).toBeNull();
    expect(planProduction(coffee, NaN)).toBeNull();
  });
});

describe('MAX / limiting ingredient', () => {
  it('MAX is bounded by the scarcest ingredient', () => {
    expect(maxOutputForInputs(latte, { beans: 500, milk: 180 })).toBe(180); // milk limits (1/latte)
    expect(maxOutputForInputs(latte, { beans: 300, milk: 180 })).toBe(150); // beans limit (2/latte)
  });

  it('MAX respects outputQty>1 batching', () => {
    expect(maxBatchesForInputs(multi, { wheat: 150, milk: 80 })).toBe(40); // milk: 80/2=40 < wheat 150/3=50
    expect(maxOutputForInputs(multi, { wheat: 150, milk: 80 })).toBe(80);  // 40 batches * 2
  });

  it('MAX is 0 with no ingredients', () => {
    expect(maxOutputForInputs(coffee, {})).toBe(0);
  });
});

describe('duration & speed', () => {
  it('is batch-oriented (not naive per-unit) and rounds up partial batches', () => {
    // bread: 25/batch, 20s/batch @ L1
    expect(productionDurationSecs('bread', 25, 1)).toBe(20);
    expect(productionDurationSecs('bread', 26, 1)).toBe(40);  // 2 batches
    expect(productionDurationSecs('bread', 100, 1)).toBe(80); // 4 batches
    // NOT 100x the single-unit time
    expect(productionDurationSecs('bread', 100, 1)).toBeLessThan(productionDurationSecs('bread', 1, 1) * 100);
  });

  it('level 50 is up to 2x faster, level 1 is baseline', () => {
    expect(productionSpeedMult(1)).toBe(1);
    expect(productionSpeedMult(50)).toBeCloseTo(0.5, 5);
    expect(productionDurationSecs('coffee', 100, 50)).toBeLessThan(productionDurationSecs('coffee', 100, 1));
  });
});

describe('queue depth (additive Phase-2 reward)', () => {
  it('grows with level but stays bounded', () => {
    expect(productionQueueLimit(1)).toBe(2);
    expect(productionQueueLimit(10)).toBe(2);
    expect(productionQueueLimit(11)).toBe(4);
    expect(productionQueueLimit(50)).toBe(10);
  });
});

describe('producible classification', () => {
  it('recipe goods are producible; raw/none are not', () => {
    expect(isProducibleProduct('coffee')).toBe(true);
    expect(isProducibleProduct('bread')).toBe(true);
    expect(isProducibleProduct('latte')).toBe(true);
    expect(isProducibleProduct('milk')).toBe(false);  // raw farm output, no recipe
    expect(isProducibleProduct('wheat')).toBe(false);
    expect(isProducibleProduct('beans')).toBe(false); // import good, no recipe
  });
});

describe('malicious client recipe is ignored (server owns the recipe)', () => {
  it('planProduction only reads the passed canonical recipe, never a client value', () => {
    // A caller cannot ask for coffee "for free" — the recipe drives inputs.
    const p = planProduction(coffee, 10)!;
    expect(p.inputs).toEqual([{ product: 'milk', qty: 10 }, { product: 'beans', qty: 10 }]);
  });
});
