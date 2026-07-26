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

// ---------- Recipe engine (single canonical source) ----------
export interface RecipeInput { product: ProductId; qty: number; }
export interface Recipe { output: ProductId; outputQty: number; inputs: RecipeInput[]; }

// ---------- Product license & capability catalog ----------
// A LICENSE is a business's permanent right to sell a product. Capability
// distinguishes MANUFACTURE (produce, has a recipe) from RETAIL (stock & sell
// a finished good bought from others) — important for the Mini Market role.
export type ProductCapability = 'produce' | 'retail';

export interface ProductLicenseDef {
  product: ProductId;
  businesses: Partial<Record<BusinessType, ProductCapability>>; // who may license + how
  requiredLevel: number;              // min BUSINESS level to buy it
  prereqLicense: ProductId | null;    // another product license required first
  fee: number;                        // license purchase fee ($)
  recipe: Recipe | null;              // production recipe (null = pure retail good)
  starter: BusinessType[];            // types that receive it free (creation/migration)
}

// Existing products keep exactly their current behaviour via starter licenses.
// `latte` is the Phase-1 foundation product: licensable, activatable and
// recipe-previewable now; its manual production lands in Phase 2.
export const PRODUCT_LICENSES: ProductLicenseDef[] = [
  { product: 'milk', businesses: { farm: 'produce', mini_market: 'retail' }, requiredLevel: 1, prereqLicense: null, fee: 0, recipe: null, starter: ['farm', 'mini_market'] },
  { product: 'wheat', businesses: { farm: 'produce' }, requiredLevel: 1, prereqLicense: null, fee: 0, recipe: null, starter: ['farm'] },
  { product: 'bread', businesses: { bakery: 'produce', mini_market: 'retail' }, requiredLevel: 1, prereqLicense: null, fee: 0, recipe: { output: 'bread', outputQty: 1, inputs: [{ product: 'wheat', qty: 1 }] }, starter: ['bakery', 'mini_market'] },
  { product: 'coffee', businesses: { coffee_shop: 'produce' }, requiredLevel: 1, prereqLicense: null, fee: 0, recipe: { output: 'coffee', outputQty: 1, inputs: [{ product: 'milk', qty: 1 }, { product: 'beans', qty: 1 }] }, starter: ['coffee_shop'] },
  // Foundation product — license-gated, multi-input recipe, produced in Phase 2.
  { product: 'latte', businesses: { coffee_shop: 'produce' }, requiredLevel: 5, prereqLicense: 'coffee', fee: 4000, recipe: { output: 'latte', outputQty: 1, inputs: [{ product: 'beans', qty: 2 }, { product: 'milk', qty: 1 }] }, starter: [] },
];

const LICENSE_BY_PRODUCT = new Map<ProductId, ProductLicenseDef>(PRODUCT_LICENSES.map((l) => [l.product, l]));

export function licenseDef(product: ProductId): ProductLicenseDef | undefined {
  return LICENSE_BY_PRODUCT.get(product);
}
export function recipeFor(product: ProductId): Recipe | null {
  return LICENSE_BY_PRODUCT.get(product)?.recipe ?? null;
}
/** Products a business type may ever license, with the capability it would get. */
export function licensableProducts(type: BusinessType): { product: ProductId; capability: ProductCapability; def: ProductLicenseDef }[] {
  return PRODUCT_LICENSES.filter((l) => l.businesses[type]).map((l) => ({ product: l.product, capability: l.businesses[type]!, def: l }));
}
export function starterLicenses(type: BusinessType): ProductId[] {
  return PRODUCT_LICENSES.filter((l) => l.starter.includes(type)).map((l) => l.product);
}
export function productCapability(type: BusinessType, product: ProductId): ProductCapability | null {
  return LICENSE_BY_PRODUCT.get(product)?.businesses[type] ?? null;
}
/** A product is compatible with a business iff that type can license it. */
export function productCompatible(type: BusinessType, product: ProductId): boolean {
  return !!LICENSE_BY_PRODUCT.get(product)?.businesses[type];
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
