// ============================================================
// V2.8 Phase 1 — canonical Product-Economy foundation.
//
// One authoritative layer for: recipes, product licenses, business levels
// 1–50, the XP curve, and product slots. It is ADDITIVE: the existing 1–3
// facility "upgrade tier" (FARM_LEVELS/SHOP_LEVELS/… — capacity + production
// rates) is untouched. This adds an XP-driven Business Level that grants
// product slots, license eligibility and a modest storage bonus.
//
// The server is authoritative; clients treat everything here as presentation.
// ============================================================
import type { ProductId, BusinessType } from './defs.js';
import { PRODUCTION_TIMING } from './defs.js';

// ---------- Recipe engine (single canonical source) ----------
export interface RecipeInput { product: ProductId; qty: number; }
export interface Recipe { output: ProductId; outputQty: number; inputs: RecipeInput[]; }

// ---------- Product license & capability catalog ----------
// A LICENSE is a business's permanent right to make/sell a product. Capability
// distinguishes MANUFACTURE (produce, has a recipe) from RETAIL (stock & resell
// a finished good bought from others) — the Mini Market role.
//
// V2.8 Phase 3: the SAME product may be licensable by several business types
// with DIFFERENT requirements (e.g. a bakery PRODUCES cake at L18 with a
// prerequisite, while a mini market RETAILS it at L18 with no prereq). So the
// level/prereq/fee/starter/capability all live in a per-business-type RULE.
export type ProductCapability = 'produce' | 'retail';

export interface ProductBizRule {
  capability: ProductCapability;
  requiredLevel: number;             // min BUSINESS level to license it here
  prereqLicense: ProductId | null;   // another product license required first
  fee: number;                       // license purchase fee ($)
  starter: boolean;                  // granted free at creation/migration
}

export interface ProductLicenseDef {
  product: ProductId;
  recipe: Recipe | null;             // production recipe (null = raw/retail good)
  rules: Partial<Record<BusinessType, ProductBizRule>>;
}

// Recipe shorthands (canonical; the Phase-2 engine scales/batches these).
const R = (output: ProductId, outputQty: number, inputs: [ProductId, number][]): Recipe =>
  ({ output, outputQty, inputs: inputs.map(([product, qty]) => ({ product, qty })) });
const produce = (requiredLevel: number, fee: number, prereqLicense: ProductId | null = null, starter = false): ProductBizRule =>
  ({ capability: 'produce', requiredLevel, prereqLicense, fee, starter });
const retail = (requiredLevel: number, fee: number, starter = false): ProductBizRule =>
  ({ capability: 'retail', requiredLevel, prereqLicense: null, fee, starter });

export const PRODUCT_LICENSES: ProductLicenseDef[] = [
  // ---- Raw materials (farm produces; mini market may retail milk) ----
  { product: 'milk', recipe: null, rules: { farm: produce(1, 0, null, true), mini_market: retail(1, 0, true) } },
  { product: 'wheat', recipe: null, rules: { farm: produce(1, 0, null, true) } },
  { product: 'eggs', recipe: null, rules: { farm: produce(5, 2500) } },
  { product: 'strawberry', recipe: null, rules: { farm: produce(12, 6000) } },
  // ---- Bakery goods (bakery produces; mini market retails) ----
  { product: 'bread', recipe: R('bread', 1, [['wheat', 2]]), rules: { bakery: produce(1, 0, null, true), mini_market: retail(1, 0, true) } },
  { product: 'croissant', recipe: R('croissant', 2, [['wheat', 2], ['milk', 1]]), rules: { bakery: produce(5, 4000, 'bread'), mini_market: retail(5, 2000) } },
  { product: 'cookie', recipe: R('cookie', 3, [['wheat', 2], ['eggs', 1]]), rules: { bakery: produce(10, 7500, 'bread'), mini_market: retail(10, 4000) } },
  { product: 'cake', recipe: R('cake', 1, [['wheat', 3], ['milk', 2], ['eggs', 2]]), rules: { bakery: produce(18, 15000, 'croissant'), mini_market: retail(18, 8000) } },
  { product: 'strawberry_cake', recipe: R('strawberry_cake', 1, [['wheat', 3], ['milk', 2], ['eggs', 2], ['strawberry', 2]]), rules: { bakery: produce(28, 30000, 'cake'), mini_market: retail(28, 15000) } },
  // ---- Coffee shop drinks (coffee shop produces; mini market retails) ----
  { product: 'coffee', recipe: R('coffee', 1, [['milk', 1], ['beans', 1]]), rules: { coffee_shop: produce(1, 0, null, true), mini_market: retail(5, 2000) } },
  { product: 'latte', recipe: R('latte', 1, [['beans', 2], ['milk', 1]]), rules: { coffee_shop: produce(5, 4000, 'coffee'), mini_market: retail(10, 4000) } },
  { product: 'cappuccino', recipe: R('cappuccino', 1, [['beans', 2], ['milk', 2]]), rules: { coffee_shop: produce(10, 7500, 'latte'), mini_market: retail(18, 8000) } },
  { product: 'strawberry_latte', recipe: R('strawberry_latte', 1, [['beans', 2], ['milk', 1], ['strawberry', 2]]), rules: { coffee_shop: produce(28, 30000, 'latte'), mini_market: retail(28, 15000) } },
];

const LICENSE_BY_PRODUCT = new Map<ProductId, ProductLicenseDef>(PRODUCT_LICENSES.map((l) => [l.product, l]));

export function licenseDef(product: ProductId): ProductLicenseDef | undefined {
  return LICENSE_BY_PRODUCT.get(product);
}
export function recipeFor(product: ProductId): Recipe | null {
  return LICENSE_BY_PRODUCT.get(product)?.recipe ?? null;
}
/** The per-business-type rule for licensing `product`, or null if incompatible. */
export function ruleFor(type: BusinessType, product: ProductId): ProductBizRule | null {
  return LICENSE_BY_PRODUCT.get(product)?.rules[type] ?? null;
}
/** Products a business type may ever license, with its rule + capability. */
export function licensableProducts(type: BusinessType): { product: ProductId; capability: ProductCapability; rule: ProductBizRule; recipe: Recipe | null }[] {
  return PRODUCT_LICENSES
    .filter((l) => l.rules[type])
    .map((l) => ({ product: l.product, capability: l.rules[type]!.capability, rule: l.rules[type]!, recipe: l.recipe }));
}
export function starterLicenses(type: BusinessType): ProductId[] {
  return PRODUCT_LICENSES.filter((l) => l.rules[type]?.starter).map((l) => l.product);
}
export function productCapability(type: BusinessType, product: ProductId): ProductCapability | null {
  return LICENSE_BY_PRODUCT.get(product)?.rules[type]?.capability ?? null;
}
/** A product is compatible with a business iff that type can license it. */
export function productCompatible(type: BusinessType, product: ProductId): boolean {
  return !!LICENSE_BY_PRODUCT.get(product)?.rules[type];
}

// ---------- Product category & NPC retail archetype ----------
export const RAW_PRODUCTS: ProductId[] = ['milk', 'beans', 'wheat', 'eggs', 'strawberry'];
export function isRawProduct(product: ProductId): boolean { return RAW_PRODUCTS.includes(product); }
export function productCategory(product: ProductId): 'raw' | 'finished' { return isRawProduct(product) ? 'raw' : 'finished'; }

// Central Wholesale is a RAW-material safety net only (Phase 3 policy §14): it
// never sells processed/finished goods.
export function wholesaleEligible(product: ProductId): boolean { return isRawProduct(product); }

// Relative NPC customer VOLUME per product (multiplies a business's base
// customers/sec). Archetypes: staples move volume at thin margin; premium goods
// move little volume at fat margin. See DECISIONS.md V2.8 Phase 3 balancing.
export const RETAIL_DEMAND_WEIGHT: Partial<Record<ProductId, number>> = {
  milk: 1.10, bread: 1.40, croissant: 0.60, cookie: 0.70, cake: 0.18, strawberry_cake: 0.10,
  coffee: 1.00, latte: 0.60, cappuccino: 0.45, strawberry_latte: 0.30,
};
export function retailDemandWeight(product: ProductId): number { return RETAIL_DEMAND_WEIGHT[product] ?? 0; }
/** Products this business type sells to NPC customers (its active ones only, at runtime). */
export function npcRetailProducts(type: BusinessType): ProductId[] {
  return licensableProducts(type)
    .filter((l) => retailDemandWeight(l.product) > 0)
    .map((l) => l.product);
}

// ---------- Business level 1–50 ----------
export const MAX_BUSINESS_LEVEL = 50;

export type BusinessTier = 'local' | 'established' | 'regional' | 'major' | 'city_icon';
export function businessTier(level: number): BusinessTier {
  if (level >= 41) return 'city_icon';
  if (level >= 31) return 'major';
  if (level >= 21) return 'regional';
  if (level >= 11) return 'established';
  return 'local';
}

// Active product slots by level — milestones every 5, a +2 jump at 50.
const SLOT_MILESTONES: [number, number][] = [
  [1, 1], [5, 2], [10, 3], [15, 4], [20, 5], [25, 6], [30, 7], [35, 8], [40, 9], [45, 10], [50, 12],
];
export function slotsForLevel(level: number): number {
  let slots = 1;
  for (const [lvl, n] of SLOT_MILESTONES) if (level >= lvl) slots = n;
  return slots;
}
/**
 * Effective active-slot limit for a business. Never below the number of starter
 * products for its type, so existing/migrated businesses always keep what they
 * already sell (e.g. a Mini Market's bread + milk) even at level 1.
 */
export function activeSlotLimit(type: BusinessType, level: number): number {
  return Math.max(slotsForLevel(level), starterLicenses(type).length);
}

// Modest additive storage bonus. Never a margin advantage — L1 = 1.0, L50 ≈ 2.0.
export function storageMultForLevel(level: number): number {
  return 1 + Math.min(1.0, Math.max(0, level - 1) * 0.02);
}

// ---------- Nonlinear XP curve ----------
// XP to advance FROM `level` TO level+1 — quick early, a long tail late.
export function xpToNextBizLevel(level: number): number {
  if (level >= MAX_BUSINESS_LEVEL) return Infinity;
  return Math.round(45 * Math.pow(level, 1.6));
}
export function xpForBizLevel(level: number): number { // cumulative XP to REACH `level`
  let sum = 0;
  for (let l = 1; l < level; l++) sum += xpToNextBizLevel(l);
  return sum;
}
export function bizLevelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_BUSINESS_LEVEL && xp >= xpForBizLevel(level + 1)) level++;
  return level;
}

// ---------- Per-level reward (every level gives something — no empty levels) ----------
export interface BusinessLevelReward {
  level: number;
  tier: BusinessTier;
  slots: number;
  storageMult: number;
  milestone: boolean;      // every 5 levels
  majorMilestone: boolean; // every 10 levels (tier boundary)
  slotGained: boolean;     // this level added a product slot
  kind: 'slot' | 'tier' | 'storage'; // headline reward class for the UI
}
export function levelReward(level: number): BusinessLevelReward {
  const slots = slotsForLevel(level);
  const slotGained = level > 1 && slots > slotsForLevel(level - 1);
  const majorMilestone = level % 10 === 0;
  return {
    level, tier: businessTier(level), slots, storageMult: storageMultForLevel(level),
    milestone: level % 5 === 0, majorMilestone, slotGained,
    kind: slotGained ? 'slot' : majorMilestone ? 'tier' : 'storage',
  };
}

// Active-product configuration change cooldown — for planning, not annoyance.
// The game runs accelerated, so keep it short; admin/dev may bypass.
export const SLOT_SWITCH_COOLDOWN_SECS = 120;

// Ledger kind for a license purchase (consistent with existing UPPER_SNAKE types).
export const LEDGER_PRODUCT_LICENSE = 'PRODUCT_LICENSE';

// ---------- Central Wholesale player-first reference pricing ----------
// Central Wholesale is a SAFETY NET: its price is derived from trustworthy
// COMPLETED player trades and sits a premium ABOVE the healthy player price, so
// player-to-player sourcing stays the cheaper option. Falls back to the base
// NPC price when there isn't enough trustworthy history.
export const WHOLESALE_PREMIUM = 0.2;          // wholesale ≈ player reference +20%
export const WHOLESALE_REF_WINDOW_SECS = 24 * 3600; // completed-trade window
export const WHOLESALE_REF_MIN_TRADES = 5;     // min distinct completed trades
export const WHOLESALE_REF_MIN_VOLUME = 60;    // min total units (anti tiny-wash)
export const WHOLESALE_REF_MAX_OBS_WEIGHT = 150; // cap one trade's weight (anti single-spike)
export const WHOLESALE_REF_CLAMP_LO = 0.7;     // never below 70% of the base NPC price
export const WHOLESALE_REF_CLAMP_HI = 2.5;     // never above 250% of the base NPC price
export const WHOLESALE_REPRICE_SECS = 300;     // conservative refresh cadence
export const WHOLESALE_MAX_STEP_FRAC = 0.08;   // move at most ±8% of base per refresh

// Player-Sourced Input Ratio health bands (operator diagnostic only — never
// affects gameplay). PLAYER = marketplace/contract/offer; CENTRAL = wholesale.
export const SUPPLY_HEALTHY_MIN = 0.7;         // >= 70% player-sourced = healthy
export const SUPPLY_CENTRAL_DEPENDENT_MIN = 0.4; // 40–70% = central-dependent; < 40% = critical
export type SupplyHealth = 'healthy' | 'central_dependent' | 'critical';
export function supplyHealth(playerRatio: number): SupplyHealth {
  if (playerRatio >= SUPPLY_HEALTHY_MIN) return 'healthy';
  if (playerRatio >= SUPPLY_CENTRAL_DEPENDENT_MIN) return 'central_dependent';
  return 'critical';
}

// ============================================================
// V2.8 Phase 2 — manual production planning (single canonical calculation).
//
// The client uses these ONLY for previews; the server recomputes everything
// authoritatively at start_production. Recipes may output more than one unit
// and take multiple inputs — never assume outputQty === 1.
// ============================================================

export interface ProductionPlan {
  batches: number;                 // whole recipe executions
  output: number;                  // finished units = batches * recipe.outputQty
  inputs: RecipeInput[];           // total ingredient commitment for this plan
}

/**
 * Plan production of `desiredOutput` finished units from `recipe`. Only whole
 * recipe batches run — a request that isn't a multiple of outputQty is
 * NORMALISED DOWN to the largest valid output (never fractional, never up).
 * Returns null if not even one batch fits in the request.
 */
export function planProduction(recipe: Recipe, desiredOutput: number): ProductionPlan | null {
  if (!Number.isFinite(desiredOutput) || desiredOutput <= 0) return null;
  const outQty = recipe.outputQty > 0 ? recipe.outputQty : 1;
  const batches = Math.floor(desiredOutput / outQty);
  if (batches < 1) return null;
  return {
    batches,
    output: batches * outQty,
    inputs: recipe.inputs.map((i) => ({ product: i.product, qty: i.qty * batches })),
  };
}

/** Max whole batches producible from an on-hand ingredient snapshot. */
export function maxBatchesForInputs(recipe: Recipe, have: Map<ProductId, number> | Record<string, number>): number {
  const get = (p: ProductId): number =>
    have instanceof Map ? (have.get(p) ?? 0) : ((have as Record<string, number>)[p] ?? 0);
  let max = Infinity;
  for (const inp of recipe.inputs) {
    if (inp.qty <= 0) continue;
    max = Math.min(max, Math.floor(get(inp.product) / inp.qty));
  }
  return Number.isFinite(max) ? Math.max(0, max) : 0;
}

/** Max finished output producible from on-hand ingredients (MAX button truth). */
export function maxOutputForInputs(recipe: Recipe, have: Map<ProductId, number> | Record<string, number>): number {
  const outQty = recipe.outputQty > 0 ? recipe.outputQty : 1;
  return maxBatchesForInputs(recipe, have) * outQty;
}

// A level-50 business produces up to 2x faster than a level-1 one — a material
// edge, never magical, and it never lets high level dodge the planning decision.
export function productionSpeedMult(level: number): number {
  const clamped = Math.max(1, Math.min(MAX_BUSINESS_LEVEL, level));
  return 1 - Math.min(0.5, (clamped - 1) * (0.5 / (MAX_BUSINESS_LEVEL - 1)));
}

/** Wall-clock seconds to produce `output` units of `product` at `bizLevel`. */
export function productionDurationSecs(product: ProductId, output: number, bizLevel: number): number {
  const t = PRODUCTION_TIMING[product];
  if (!t || output <= 0) return 0;
  const batches = Math.ceil(output / t.batchSize);
  const raw = batches * t.batchSecs;
  return Math.max(1, Math.round(raw * productionSpeedMult(bizLevel)));
}

export function isProducibleProduct(product: ProductId): boolean {
  return !!PRODUCTION_TIMING[product] && !!recipeFor(product);
}

// Per-business production line depth (currently-producing job + queued). Small
// early so new businesses plan modestly; more planning capacity late-game. This
// is an ADDITIVE Phase-2 progression reward on top of Phase-1 levels/slots.
export function productionQueueLimit(level: number): number {
  const clamped = Math.max(1, Math.min(MAX_BUSINESS_LEVEL, level));
  return 2 + Math.floor((clamped - 1) / 10) * 2; // L1–10:2, 11–20:4, 21–30:6, 31–40:8, 41–50:10
}

// ============================================================
// V2.8 Phase 4 — business specialization, mastery & controlled automation.
//
// Specialization is a permanent, per-BUSINESS strategic choice unlocked at
// level 20. It gives MODEST, family-scoped operational bonuses (never a
// universal margin multiplier), deepening business identity without breaking
// multiplayer dependency. Mastery (L30/40/50) strengthens the SAME choice.
// ============================================================
export const SPECIALIZATION_UNLOCK_LEVEL = 20;
export const MASTERY_LEVELS = [30, 40, 50] as const;

export interface SpecializationDef {
  id: string;                 // stable public id (also the i18n key suffix)
  type: BusinessType;
  family: ProductId[];        // products this path is "best at"
}

// Two strategic paths per business type. Families never overlap within a type.
export const SPECIALIZATIONS: Record<BusinessType, SpecializationDef[]> = {
  bakery: [
    { id: 'volume_bakery', type: 'bakery', family: ['bread', 'croissant', 'cookie'] },
    { id: 'patisserie', type: 'bakery', family: ['cake', 'strawberry_cake'] },
  ],
  coffee_shop: [
    { id: 'volume_cafe', type: 'coffee_shop', family: ['coffee', 'latte'] },
    { id: 'specialty_cafe', type: 'coffee_shop', family: ['cappuccino', 'strawberry_latte'] },
  ],
  farm: [
    { id: 'staple_producer', type: 'farm', family: ['wheat', 'milk'] },
    { id: 'specialty_farm', type: 'farm', family: ['eggs', 'strawberry'] },
  ],
  mini_market: [
    { id: 'everyday_retail', type: 'mini_market', family: ['bread', 'milk', 'coffee', 'croissant'] },
    { id: 'premium_grocer', type: 'mini_market', family: ['cake', 'strawberry_cake', 'cappuccino', 'strawberry_latte'] },
  ],
};

const SPEC_BY_ID = new Map<string, SpecializationDef>();
for (const list of Object.values(SPECIALIZATIONS)) for (const s of list) SPEC_BY_ID.set(s.id, s);

export function specializationDef(id: string | null | undefined): SpecializationDef | undefined {
  return id ? SPEC_BY_ID.get(id) : undefined;
}
export function specializationsFor(type: BusinessType): SpecializationDef[] {
  return SPECIALIZATIONS[type] ?? [];
}
/** True if `specId` is a valid specialization for `type`. */
export function isValidSpecialization(type: BusinessType, specId: string): boolean {
  return specializationsFor(type).some((s) => s.id === specId);
}

// Mastery tier from level: 0 = specialized (L20–29), then I/II/III at 30/40/50.
export function masteryTier(level: number): 0 | 1 | 2 | 3 {
  if (level >= 50) return 3;
  if (level >= 40) return 2;
  if (level >= 30) return 1;
  return 0;
}

// Family-scoped bonus curve by mastery tier. Deliberately MODEST (≤18%). Speed
// is a production-DURATION multiplier (lower = faster); the rest are >1.
export interface SpecBonus {
  speedMult: number;    // production duration for family products (<=1)
  storageMult: number;  // finished/family storage capacity (>=1)
  retailMult: number;   // NPC retail volume for family products (>=1)
  queueBonus: number;   // extra production-queue depth (whole business)
}
const SPEC_SPEED = [0.93, 0.90, 0.87, 0.84];
const SPEC_STORAGE = [1.08, 1.12, 1.16, 1.20];
const SPEC_RETAIL = [1.06, 1.09, 1.12, 1.15];
const SPEC_QUEUE = [1, 1, 2, 2];

/** The active bonus for a business given its specialization id and level. */
export function specBonus(specId: string | null | undefined, level: number): SpecBonus {
  if (!specId || !SPEC_BY_ID.has(specId) || level < SPECIALIZATION_UNLOCK_LEVEL) {
    return { speedMult: 1, storageMult: 1, retailMult: 1, queueBonus: 0 };
  }
  const t = masteryTier(level);
  return { speedMult: SPEC_SPEED[t], storageMult: SPEC_STORAGE[t], retailMult: SPEC_RETAIL[t], queueBonus: SPEC_QUEUE[t] };
}
/** Whether a product is in the business's specialization family (gets the bonus). */
export function specAppliesTo(specId: string | null | undefined, product: ProductId): boolean {
  const def = SPEC_BY_ID.get(specId ?? '');
  return !!def && def.family.includes(product);
}
/** Family-scoped production speed multiplier (1.0 if not specialized / not in family). */
export function specSpeedMult(specId: string | null | undefined, level: number, product: ProductId): number {
  return specAppliesTo(specId, product) ? specBonus(specId, level).speedMult : 1;
}
/** Family-scoped storage multiplier (1.0 outside the family). */
export function specStorageMult(specId: string | null | undefined, level: number, product: ProductId): number {
  return specAppliesTo(specId, product) ? specBonus(specId, level).storageMult : 1;
}
/** Family-scoped retail-volume multiplier (1.0 outside the family). */
export function specRetailMult(specId: string | null | undefined, level: number, product: ProductId): number {
  return specAppliesTo(specId, product) ? specBonus(specId, level).retailMult : 1;
}

// Master / City Icon prestige — level 50 businesses.
export const CITY_ICON_LEVEL = 50;
export function isCityIcon(level: number): boolean { return level >= CITY_ICON_LEVEL; }

// ---------- Controlled automation: bounded production repeat ----------
// Repeat re-queues the SAME job when it finishes, at most N more times, and ONLY
// if ingredients/license/slot/storage allow at that moment. It never auto-buys.
export const REPEAT_UNLOCK_LEVEL = 25;
export function maxProductionRepeat(level: number): number {
  if (level >= 45) return 3;
  if (level >= 35) return 2;
  if (level >= 25) return 1;
  return 0;
}
