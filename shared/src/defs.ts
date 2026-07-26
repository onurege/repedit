// ============================================================
// Data-driven game definitions shared by client and server.
// Extend by adding entries — no engine changes needed.
// ============================================================

// V2.8 Phase 3 — 14-product catalog: raw materials, bakery goods, coffee drinks.
// `latte` was the Phase-1 foundation product. Everything else new here (eggs,
// strawberry, croissant, cookie, cake, strawberry_cake, cappuccino,
// strawberry_latte) is additive; existing ids/values are preserved.
export type ProductId =
  | 'milk' | 'beans' | 'wheat' | 'eggs' | 'strawberry'          // raw materials
  | 'bread' | 'croissant' | 'cookie' | 'cake' | 'strawberry_cake' // bakery goods
  | 'coffee' | 'latte' | 'cappuccino' | 'strawberry_latte';       // coffee drinks

export interface ProductDef {
  id: ProductId;
  name: string;
  basePrice: number; // reference price, whole dollars
  emoji: string;
}

export const PRODUCTS: Record<ProductId, ProductDef> = {
  // Raw materials
  milk: { id: 'milk', name: 'Milk', basePrice: 12, emoji: '🥛' },
  beans: { id: 'beans', name: 'Coffee Beans', basePrice: 8, emoji: '🫘' },
  wheat: { id: 'wheat', name: 'Wheat', basePrice: 8, emoji: '🌾' },
  eggs: { id: 'eggs', name: 'Eggs', basePrice: 14, emoji: '🥚' },
  strawberry: { id: 'strawberry', name: 'Strawberry', basePrice: 20, emoji: '🍓' },
  // Bakery finished goods
  bread: { id: 'bread', name: 'Bread', basePrice: 20, emoji: '🍞' },
  croissant: { id: 'croissant', name: 'Croissant', basePrice: 26, emoji: '🥐' },
  cookie: { id: 'cookie', name: 'Cookie', basePrice: 18, emoji: '🍪' },
  cake: { id: 'cake', name: 'Cake', basePrice: 70, emoji: '🍰' },
  strawberry_cake: { id: 'strawberry_cake', name: 'Strawberry Cake', basePrice: 110, emoji: '🎂' },
  // Coffee shop finished goods
  coffee: { id: 'coffee', name: 'Coffee', basePrice: 30, emoji: '☕' },
  latte: { id: 'latte', name: 'Latte', basePrice: 42, emoji: '🥤' },
  cappuccino: { id: 'cappuccino', name: 'Cappuccino', basePrice: 50, emoji: '☕' },
  strawberry_latte: { id: 'strawberry_latte', name: 'Strawberry Latte', basePrice: 66, emoji: '🥤' },
};

// Reference NPC retail prices — chosen against healthy player input cost so no
// finished product dominates (see DECISIONS.md V2.8 Phase 3 balancing). Volume
// (demandWeight) and event sensitivity carry the archetype differences.
export const RETAIL_BASE: Partial<Record<ProductId, number>> = {
  milk: 18,
  bread: 20,
  croissant: 30,
  cookie: 20,
  cake: 110,
  strawberry_cake: 180,
  coffee: 30,
  latte: 46,
  cappuccino: 58,
  strawberry_latte: 98,
};

export type BusinessType = 'farm' | 'coffee_shop' | 'bakery' | 'mini_market';

// What the farm can produce (owner-selectable).
export type FarmProduct = 'milk' | 'wheat' | 'eggs' | 'strawberry';

export interface FarmLevelDef {
  milkPerSec: number;
  milkCapacity: number;
  upgradeCost: number | null; // cost to reach NEXT level, null at max
}

export interface ShopLevelDef {
  brewPerSec: number;       // coffees brewed per second (given ingredients)
  customersPerSec: number;  // base customer arrival rate
  ingredientCapacity: number; // per ingredient (milk / beans)
  coffeeCapacity: number;
  upgradeCost: number | null;
}

export const FARM_LEVELS: Record<number, FarmLevelDef> = {
  1: { milkPerSec: 0.5, milkCapacity: 200, upgradeCost: 2500 },
  2: { milkPerSec: 1.0, milkCapacity: 500, upgradeCost: 7000 },
  3: { milkPerSec: 2.0, milkCapacity: 1200, upgradeCost: null },
};

export const SHOP_LEVELS: Record<number, ShopLevelDef> = {
  1: { brewPerSec: 0.25, customersPerSec: 0.14, ingredientCapacity: 250, coffeeCapacity: 30, upgradeCost: 3000 },
  2: { brewPerSec: 0.5, customersPerSec: 0.28, ingredientCapacity: 600, coffeeCapacity: 80, upgradeCost: 9000 },
  3: { brewPerSec: 1.0, customersPerSec: 0.55, ingredientCapacity: 1500, coffeeCapacity: 200, upgradeCost: null },
};

// Bakery: 1 wheat -> 1 bread, sold to NPC customers at the owner's price.
export const BAKERY_LEVELS: Record<number, ShopLevelDef> = {
  1: { brewPerSec: 0.25, customersPerSec: 0.14, ingredientCapacity: 250, coffeeCapacity: 40, upgradeCost: 2800 },
  2: { brewPerSec: 0.5, customersPerSec: 0.28, ingredientCapacity: 600, coffeeCapacity: 100, upgradeCost: 8500 },
  3: { brewPerSec: 1.0, customersPerSec: 0.55, ingredientCapacity: 1500, coffeeCapacity: 260, upgradeCost: null },
};

// Mini market: pure retail (bread + milk), no production.
export interface MarketLevelDef {
  customersPerSec: number; // per product stream
  stockCapacity: number;   // per product
  upgradeCost: number | null;
}
export const MARKET_LEVELS: Record<number, MarketLevelDef> = {
  1: { customersPerSec: 0.09, stockCapacity: 300, upgradeCost: 2500 },
  2: { customersPerSec: 0.18, stockCapacity: 800, upgradeCost: 8000 },
  3: { customersPerSec: 0.36, stockCapacity: 2000, upgradeCost: null },
};

export const MAX_LEVEL = 3;

// Coffee recipe: 1 coffee = 1 milk + 1 beans
export const COFFEE_RECIPE: { product: ProductId; qty: number }[] = [
  { product: 'milk', qty: 1 },
  { product: 'beans', qty: 1 },
];

// ---- Economy constants ----
export const STARTING_CASH = 10000;
// V2.8 Phase 3: Central Wholesale is a RAW-MATERIAL safety net ONLY — it never
// sells processed/finished goods (those belong to the player economy). Core raw
// (wheat/milk/beans) stays reasonably available; advanced raw (eggs/strawberry)
// is priced to strongly favor player sourcing while preventing a hard deadlock.
export const NPC_WHOLESALE_PRICES: Partial<Record<ProductId, number>> = {
  milk: 15,
  beans: 8,
  wheat: 10,          // player farms can profitably undercut (~$6-9)
  eggs: 26,           // strong player dependency (healthy player price ~$14-18)
  strawberry: 40,     // strong player dependency (healthy player price ~$20-26)
};
export const DEFAULT_COFFEE_PRICE = 30;
export const DEFAULT_BREAD_PRICE = 20;
export const DEFAULT_RETAIL_MILK_PRICE = 18;
export const MIN_COFFEE_PRICE = 5;
export const MAX_COFFEE_PRICE = 100;

// Demand multiplier from sale price (1.0 at the product's reference price).
export function priceDemandMultiplier(price: number, base = PRODUCTS.coffee.basePrice): number {
  const m = 1.6 - 0.6 * (price / base);
  return Math.min(1.4, Math.max(0.2, m));
}

// Demand multiplier from reputation (1.0 at rep 3.0).
export function repDemandMultiplier(rep: number): number {
  return 0.7 + 0.1 * rep;
}

// ---- Progression ----
export const MAX_PLAYER_LEVEL = 10;
export function xpForLevel(level: number): number {
  // cumulative XP required to REACH `level`
  return 150 * (level - 1) * (level - 1);
}
export function levelForXp(xp: number): number {
  let lvl = 1;
  while (lvl < MAX_PLAYER_LEVEL && xp >= xpForLevel(lvl + 1)) lvl++;
  return lvl;
}
export const XP = {
  perSale: 3,
  perMilkProduced: 1,
  perTrade: 40,
  perUpgrade: 150,
  perNpcPurchase: 5,
};

// V2.8 — Business XP (per business, drives Business Level 1–50). Awarded only
// from committed, demand-limited activity; player-to-player XP is gated against
// self-circular trades by the caller. Deliberately small vs the nonlinear curve.
export const BIZ_XP = {
  perUnitProduced: 1,   // manufacturing output (bakery/coffee/farm)
  perRetailSale: 2,     // NPC final sale (demand-limited)
  perContractUnit: 2,   // fulfilled supply-contract delivery
  perUrgentUnit: 2,     // urgent city-order contribution
  perPlayerSaleUnit: 1, // player marketplace/offer sale (cross-owner only)
};

// ---- V2.8 Phase 2: manual production timing ----
// Batch-oriented, wall-clock durations. Small batch = quick decision; a
// meaningful batch = a real wait/plan; a large batch = a commitment — WITHOUT
// naive per-unit scaling (1 unit and 100 units do not differ by 100x). Tuned
// for the accelerated tycoon pace: a meaningful batch stays under a few minutes
// at level 1, and a level-50 business is up to 2x faster (see productionSpeedMult).
export interface ProductionTiming { batchSize: number; batchSecs: number; }
export const PRODUCTION_TIMING: Partial<Record<ProductId, ProductionTiming>> = {
  // Bakery — volume goods are fast/cheap; premium goods are slow/scarce.
  bread: { batchSize: 25, batchSecs: 20 },            // 100 = 80s @ L1
  croissant: { batchSize: 20, batchSecs: 25 },        // 100 = 125s
  cookie: { batchSize: 30, batchSecs: 22 },           // 120 = 88s
  cake: { batchSize: 8, batchSecs: 40 },              // 40  = 200s
  strawberry_cake: { batchSize: 5, batchSecs: 50 },   // 25  = 250s
  // Coffee shop.
  coffee: { batchSize: 20, batchSecs: 25 },           // 100 = 125s
  latte: { batchSize: 12, batchSecs: 30 },            // 96  = 240s
  cappuccino: { batchSize: 12, batchSecs: 32 },       // 96  = 256s
  strawberry_latte: { batchSize: 8, batchSecs: 40 },  // 40  = 200s
};

// ---- Reputation ----
export const REP_MIN = 1.0;
export const REP_MAX = 5.0;
export const REP_START = 3.0;
export const REP_SALE_FAIR_PRICE = 0.002;   // per sale at fair price
export const REP_SALE_GOUGING = -0.002;     // per sale above 1.2x base
export const REP_LOST_CUSTOMER = -0.005;    // out of stock when customer arrives
export const REP_TRADE_FULFILLED = 0.05;    // farm fulfils a marketplace trade

// ---- V2.8.2: Customer Satisfaction ----
// A BUSINESS-level (not player, not company) NPC service-quality metric, 0–100,
// SEPARATE from B2B reputation. New businesses start at 70. Driven only by real
// committed NPC retail outcomes, eased smoothly toward per-outcome targets so it
// evolves over many interactions and one customer can't swing it. Its only
// gameplay effect is a bounded multiplier on Business XP from NPC sales.
export const SATISFACTION_START = 70;
export const SATISFACTION_MIN = 0;
export const SATISFACTION_MAX = 100;
export const SAT_TARGET_FAIR_SALE = 90;       // a served customer at a fair price
export const SAT_TARGET_EXPENSIVE_SALE = 70;  // served, but above the fair price
export const SAT_TARGET_STOCKOUT = 35;        // demand arrived, nothing in stock

/** Smoothing weight for one retail tick — grows with volume but is capped so a
 *  single tick moves the score gradually, never wildly. */
export function satisfactionAlpha(customers: number): number {
  return Math.min(0.25, 0.02 * Math.max(0, customers));
}
/** Ease the score toward `target` given how many customers this tick, clamped. */
export function smoothSatisfaction(current: number, target: number, customers: number): number {
  const next = current + satisfactionAlpha(customers) * (target - current);
  return Math.max(SATISFACTION_MIN, Math.min(SATISFACTION_MAX, next));
}
/** Bounded Business-XP multiplier for NPC sales, by satisfaction band. */
export function satisfactionXpBand(sat: number): number {
  if (sat >= 90) return 1.20;
  if (sat >= 75) return 1.10;
  if (sat >= 60) return 1.00;
  if (sat >= 40) return 0.90;
  return 0.75;
}
export type SatisfactionStatus = 'excellent' | 'good' | 'normal' | 'poor' | 'critical';
export function satisfactionStatus(sat: number): SatisfactionStatus {
  if (sat >= 90) return 'excellent';
  if (sat >= 75) return 'good';
  if (sat >= 60) return 'normal';
  if (sat >= 40) return 'poor';
  return 'critical';
}

// ---- V2.8.2: Internal company transfer logistics ----
// A transfer between two businesses of the same company is an internal inventory
// move + a small LOGISTICS FEE paid by the company to the city — never a fake
// sale. The fee is a fraction of a single authoritative reference value.
export const INTERNAL_TRANSFER_FEE_RATE = 0.10;
/** The ONE reference value for internal-transfer logistics: the NORMAL Central
 *  Wholesale base price for raw goods (never emergency/scarcity/event-adjusted),
 *  else the product's canonical retail/base reference for finished goods. */
export function getInternalTransferReferencePrice(product: ProductId): number {
  return NPC_WHOLESALE_PRICES[product] ?? RETAIL_BASE[product] ?? PRODUCTS[product].basePrice;
}

// ---- Offline / catch-up ----
export const OFFLINE_CAP_SECONDS = 8 * 3600;

// ---- Deliveries ----
export const VAN_SPEED = 7;              // world units per second
export const MIN_DELIVERY_SECONDS = 6;
export const NPC_DELIVERY_SECONDS = 8;   // wholesale -> business (path-based, min clamp)

// ---- Marketplace ----
export const MARKET_MIN_PRICE = 1;
export const MARKET_MAX_PRICE = 500;
export const MARKET_MAX_QTY = 10000;

// V2.8.1 — the ONE authoritative list of products that can change hands between
// players (marketplace / offers / contracts). Client and server both read this;
// no screen may hardcode its own product list.
export const TRADABLE_PRODUCTS: ProductId[] = [
  'milk', 'beans', 'wheat', 'eggs', 'strawberry',
  'bread', 'croissant', 'cookie', 'cake', 'strawberry_cake',
  'coffee', 'latte', 'cappuccino', 'strawberry_latte',
];
export function isTradable(product: ProductId): boolean {
  return TRADABLE_PRODUCTS.includes(product);
}

// ---- Supply contracts (Phase 3) ----
// A business can SUPPLY these tradable products (things it produces),
// and can CONSUME these as recurring inputs. A contract for `product`
// is valid iff the seller supplies it and the buyer consumes it.
// V2.8 Phase 3 — what each business can SUPPLY to others (marketplace/contracts).
// Farms supply raw; processors supply their finished goods to Mini Markets.
export const SELLER_SUPPLIES: Record<BusinessType, ProductId[]> = {
  farm: ['milk', 'wheat', 'eggs', 'strawberry'],
  bakery: ['bread', 'croissant', 'cookie', 'cake', 'strawberry_cake'],
  coffee_shop: ['coffee', 'latte', 'cappuccino', 'strawberry_latte'],
  mini_market: [],
};
// What each business recurrently CONSUMES (recipe inputs for producers; retail
// assortment for the Mini Market, which buys finished goods to resell to NPCs).
export const BUYER_CONSUMES: Record<BusinessType, ProductId[]> = {
  coffee_shop: ['milk', 'beans', 'strawberry'],
  bakery: ['wheat', 'milk', 'eggs', 'strawberry'],
  mini_market: ['milk', 'bread', 'coffee', 'croissant', 'latte', 'cookie', 'cappuccino', 'cake', 'strawberry_cake', 'strawberry_latte'],
  farm: [],
};

/** Products a buyer business could contract to receive from a seller business. */
export function contractableProducts(
  sellerType: BusinessType,
  buyerType: BusinessType
): ProductId[] {
  const supplies = SELLER_SUPPLIES[sellerType] ?? [];
  const consumes = BUYER_CONSUMES[buyerType] ?? [];
  return supplies.filter((p) => consumes.includes(p));
}

// ---- V2.5.1: supply origin classification ----
// A product is PLAYER-PRODUCIBLE if some business type supplies it, and
// IMPORT-DEPENDENT otherwise. Derived from SELLER_SUPPLIES so the distinction
// lives in one place instead of being hard-coded around the app. Import goods
// (currently Coffee Beans) have no player production path, so the Central
// Wholesale + Emergency Import is their only source and must never hard-lock.
export function playerProducerOf(product: ProductId): BusinessType | null {
  for (const type of Object.keys(SELLER_SUPPLIES) as BusinessType[]) {
    if (SELLER_SUPPLIES[type].includes(product)) return type;
  }
  return null;
}
export function isImportDependent(product: ProductId): boolean {
  return playerProducerOf(product) === null;
}

// The raw inputs each business type consumes to make its goods (its recipe).
// Single source of truth for supply-chain reasoning and low-stock alerts.
export const BUSINESS_INPUTS: Record<BusinessType, ProductId[]> = {
  farm: [],
  coffee_shop: ['milk', 'beans', 'strawberry'],
  bakery: ['wheat', 'milk', 'eggs', 'strawberry'],
  mini_market: ['bread', 'milk'], // retailer: primary stock; full assortment via BUYER_CONSUMES
};

/** True if a product can be obtained at all: a player producer or the NPC. */
export function hasSupplyPath(product: ProductId): boolean {
  return playerProducerOf(product) !== null || NPC_WHOLESALE_PRICES[product] != null;
}

/**
 * Audit: every recipe input must have at least one reachable supply path, so
 * no business can ever hard-lock. Returns offending inputs (always empty in a
 * correct configuration). Import-dependent inputs count as reachable via the
 * Central Wholesale + Emergency Import.
 */
export function unreachableInputs(): { business: BusinessType; product: ProductId }[] {
  const out: { business: BusinessType; product: ProductId }[] = [];
  for (const type of Object.keys(BUSINESS_INPUTS) as BusinessType[]) {
    for (const product of BUSINESS_INPUTS[type]) {
      if (!hasSupplyPath(product)) out.push({ business: type, product });
    }
  }
  return out;
}

export const CONTRACT_MIN_QTY = 1;
export const CONTRACT_MAX_QTY = 2000;
export const CONTRACT_MIN_DELIVERIES = 1;
export const CONTRACT_MAX_DELIVERIES = 30;
// A "game day" between recurring deliveries, in real seconds.
export const CONTRACT_FREQUENCY_SECS = 45;
export const REP_CONTRACT_FULFILLED = 0.03; // small bump for the supplier on success

// ============================================================
// V2.1 — Companies & multi-business
// ============================================================
// Each business consumes a fixed amount of the company's management capacity.
// This is the ONLY specialization constraint: it forces an opportunity cost
// between vertical integration and specialising + trading with other players.
export const BUSINESS_CAPACITY: Record<BusinessType, number> = {
  farm: 2,
  coffee_shop: 3,
  bakery: 3,
  mini_market: 3,
};

// Company level unlocks more management capacity. Deliberately simple.
export const COMPANY_LEVELS: Record<number, { capacity: number; xp: number }> = {
  1: { capacity: 4, xp: 0 },
  2: { capacity: 6, xp: 800 },
  3: { capacity: 8, xp: 2400 },
  4: { capacity: 10, xp: 5000 },
  5: { capacity: 12, xp: 9000 },
};
export const MAX_COMPANY_LEVEL = 5;

export function companyCapacity(level: number): number {
  return (COMPANY_LEVELS[level] ?? COMPANY_LEVELS[MAX_COMPANY_LEVEL]).capacity;
}
export function companyLevelForXp(xp: number): number {
  let lvl = 1;
  while (lvl < MAX_COMPANY_LEVEL && xp >= COMPANY_LEVELS[lvl + 1].xp) lvl++;
  return lvl;
}

// Company XP is earned from meaningful business activity (not routine sales),
// so it can't be trivially farmed and mainly gates capacity.
export const COMPANY_XP = {
  perUpgrade: 200,     // a business upgrade
  perTrade: 60,        // each side of a marketplace trade
  perContract: 60,     // each contract delivery
  revenuePerXp: 500,   // +1 company XP per $500 of business revenue
};

// Opening additional businesses costs escalating money (progression gate +
// economic sink). Argument is how many businesses the company already owns.
export function businessOpenCost(currentCount: number): number {
  const table = [15000, 40000, 90000]; // 2nd, 3rd, 4th
  if (currentCount >= 1 && currentCount <= table.length) return table[currentCount - 1];
  return table[table.length - 1] + (currentCount - table.length) * 70000;
}

export const COMPANY_NAME_MIN = 2;
export const COMPANY_NAME_MAX = 24;
export const BUSINESS_NAME_MIN = 2;
export const BUSINESS_NAME_MAX = 28;

export function defaultCompanyName(username: string): string {
  return `${username} Co.`.slice(0, COMPANY_NAME_MAX);
}

// ============================================================
// V2.2 — Market share, company profile & city rankings
// ============================================================
// Competitive rankings use a rolling "recent activity" window rather than
// lifetime totals, so early players cannot lock in the top spots. We interpret
// the spec's "last 7 game days" as 7 real days: the natural "recent" horizon
// for a persistent, mostly-offline idle economy. (The contract cadence's
// 45s "game day" is a separate concept and deliberately not reused here.)
export const RANKING_WINDOW_SECONDS = 7 * 24 * 3600;

// Products whose NPC retail sales define final-consumer market share.
export const FINAL_MARKET_PRODUCTS: ProductId[] = ['bread', 'coffee', 'milk'];
// Raw materials ranked by external (player-to-player) supplier volume instead.
export const SUPPLIER_PRODUCTS: ProductId[] = ['wheat', 'milk'];

// Fastest-growing compares this window's revenue with the previous window's.
// A company must clear this recent-revenue floor (in $) to be eligible, so a
// brand-new company going $0 -> $100 cannot vault to #1 on a % change.
export const GROWTH_MIN_REVENUE = 5000;

// How many entries a ranking board shows before falling back to "your rank".
export const RANKING_TOP_N = 10;

// ============================================================
// V2.7 Phase 4 — Urgent City Orders, Rival Alerts, City News.
// ============================================================

// Urgent City Orders — short-lived city procurement opportunities. The city
// buys FINISHED goods, so only final-consumer products are ever requested.
export const URGENT_ORDER_PRODUCTS: ProductId[] = ['bread', 'coffee', 'milk'];
// Conservative scheduler: at most this many ACTIVE at once (small populations).
export const URGENT_MAX_ACTIVE = 1;
export const URGENT_MIN_DURATION_SECS = 5 * 60;   // shortest live window (5 min)
export const URGENT_MAX_DURATION_SECS = 15 * 60;  // longest live window (15 min)
// Minimum gap between two auto-spawned orders (keeps the feed calm).
export const URGENT_SPAWN_COOLDOWN_SECS = 8 * 60;
// Per-eligible-tick spawn probability once the cooldown has elapsed.
export const URGENT_SPAWN_CHANCE = 0.05;
// Need at least this many players online for the city to post an auto order.
export const URGENT_MIN_ONLINE = 1;
export const URGENT_MIN_QTY = 40;
export const URGENT_MAX_QTY = 220;
// Reward is qty * per-unit bounty (randomised inside this band) at spawn time.
export const URGENT_REWARD_PER_UNIT_MIN = 8;
export const URGENT_REWARD_PER_UNIT_MAX = 18;
// Admin-authored orders are bounded to the same safe envelope.
export const URGENT_ADMIN_MAX_QTY = 5000;
export const URGENT_ADMIN_MAX_REWARD = 1_000_000;
export const URGENT_ADMIN_MIN_DURATION_SECS = 60;
export const URGENT_ADMIN_MAX_DURATION_SECS = 60 * 60;
// Locale-independent order-flavour codes the client maps to a title.
export const URGENT_ORDER_KINDS = ['festival', 'restock', 'shortage', 'vip_event', 'city_hall'] as const;
export type UrgentOrderKind = (typeof URGENT_ORDER_KINDS)[number];

// Rival Alerts — derived only from committed data, with dedupe + cooldown so a
// rival nudging a price by a cent never spams the feed.
export const RIVAL_SWEEP_SECONDS = 60;            // coarse share sweep cadence
export const RIVAL_ALERT_COOLDOWN_SECS = 15 * 60; // per dedupe-key silence
export const RIVAL_MIN_UNITS = 20;                // ignore trivial-volume products
export const RIVAL_MIN_UNDERCUT_FRACTION = 0.05;  // rival must be >=5% cheaper
export const RIVAL_MAX_ALERTS = 20;               // bounded per-player buffer

// City News — a bounded feed generated from real committed events.
export const NEWS_MAJOR_DEAL_MIN = 4000;   // single-deal money threshold ($)
export const NEWS_MAX_ITEMS = 40;          // bounded persistent history
export const NEWS_WHOLESALE_LOW_FRACTION = 0.1; // "running low" when <=10% remains

// Locale-independent ranking category codes (client maps to labels).
export type RankingCategory =
  | 'recent_revenue'
  | 'net_cash_flow'
  | 'reputation'
  | 'growth'
  | 'bread'
  | 'coffee'
  | 'milk_retail'
  | 'wheat_supplier'
  | 'milk_supplier';

export const RANKING_CATEGORIES: RankingCategory[] = [
  'recent_revenue', 'net_cash_flow', 'reputation', 'growth',
  'bread', 'coffee', 'milk_retail', 'wheat_supplier', 'milk_supplier',
];

// ============================================================
// V2.3 — Dynamic city demand & city events
// ============================================================
// City demand is server-authoritative shared state, one multiplier per final
// consumer product. It is DERIVED from currently-active events every tick
// (never accumulated), so restarts and double ticks can't corrupt it.
// Every NPC-retailed finished good (plus milk) carries a city-demand multiplier.
export const DEMAND_PRODUCTS: ProductId[] = [
  'milk', 'bread', 'croissant', 'cookie', 'cake', 'strawberry_cake',
  'coffee', 'latte', 'cappuccino', 'strawberry_latte',
];

// Effective demand is clamped to a safe band. Normal events stay well inside
// 0.70–1.50; the hard clamp only guards against pathological stacking.
export const DEMAND_MIN = 0.5;
export const DEMAND_MAX = 2.0;
export const WHOLESALE_MOD_MAX = 2.0; // NPC fallback never more than 3x, never gone

export type DemandCategory = 'very_low' | 'low' | 'normal' | 'high' | 'very_high';

/** Map an effective demand multiplier (1.0 = base) to a display category. */
export function demandCategory(effective: number): DemandCategory {
  if (effective <= 0.80) return 'very_low';
  if (effective <= 0.93) return 'low';
  if (effective < 1.10) return 'normal';
  if (effective < 1.45) return 'high';   // e.g. Festival +40% reads HIGH
  return 'very_high';                    // +50%+ (e.g. Festival coffee) reads VERY HIGH
}

export type CityEventType =
  | 'city_festival'
  | 'university_week'
  | 'heat_wave'
  | 'supply_disruption'
  | 'local_market_day'
  | 'morning_rush'
  | 'family_weekend';

export type CityEventStatus = 'upcoming' | 'active' | 'ended';

/** Additive deltas: demand 0.40 = +40% customers; wholesale 0.30 = +30% price. */
export interface CityEventEffects {
  demand?: Partial<Record<ProductId, number>>;
  wholesale?: Partial<Record<ProductId, number>>;
}

export interface CityEventDef {
  type: CityEventType;
  major: boolean;
  effects: CityEventEffects;
  announceSecs: number; // preparation lead time before it starts
  durationSecs: number; // how long it stays ACTIVE
  weight: number;       // relative scheduler likelihood
}

// Deliberately small, understandable set. Effects are additive percentage
// deltas applied while the event is ACTIVE.
// V2.8 Phase 3: product-specific demand so players can prepare for the catalog.
// Additive % deltas while ACTIVE; announce lead time gives preparation runway.
export const CITY_EVENTS: Record<CityEventType, CityEventDef> = {
  city_festival: {
    type: 'city_festival', major: true,
    effects: { demand: { cake: 0.70, strawberry_cake: 1.00, cookie: 0.35, coffee: 0.20 } },
    announceSecs: 120, durationSecs: 240, weight: 2,
  },
  university_week: {
    type: 'university_week', major: true,
    effects: { demand: { coffee: 0.50, latte: 0.50, cookie: 0.30, croissant: 0.20 } },
    announceSecs: 120, durationSecs: 240, weight: 2,
  },
  heat_wave: { // "Summer Heat"
    type: 'heat_wave', major: true,
    effects: { demand: { strawberry_latte: 0.60, milk: 0.20, coffee: -0.10 } },
    announceSecs: 90, durationSecs: 200, weight: 2,
  },
  supply_disruption: {
    type: 'supply_disruption', major: true,
    effects: { wholesale: { wheat: 0.30, milk: 0.20, eggs: 0.25 } },
    announceSecs: 120, durationSecs: 240, weight: 2,
  },
  morning_rush: {
    type: 'morning_rush', major: false,
    effects: { demand: { coffee: 0.60, latte: 0.40, cappuccino: 0.35, croissant: 0.25 } },
    announceSecs: 60, durationSecs: 150, weight: 4,
  },
  family_weekend: {
    type: 'family_weekend', major: true,
    effects: { demand: { cake: 0.60, strawberry_cake: 0.80, milk: 0.20, cookie: 0.25 } },
    announceSecs: 120, durationSecs: 240, weight: 2,
  },
  local_market_day: {
    type: 'local_market_day', major: false,
    effects: { demand: { bread: 0.20, milk: 0.20, croissant: 0.15 } },
    announceSecs: 45, durationSecs: 90, weight: 5,
  },
};

export const CITY_EVENT_TYPES = Object.keys(CITY_EVENTS) as CityEventType[];

// Scheduler timing (real seconds). Gaps preserve periods of normal economy;
// a type won't recur within its cooldown so events don't feel repetitive.
export const EVENT_GAP_MIN_SECS = 150;
export const EVENT_GAP_MAX_SECS = 360;
export const EVENT_TYPE_COOLDOWN_SECS = 600;

// ============================================================
// V2.5 — Central Wholesale daily supply & market integrity
// ============================================================
// The Central Wholesale is a finite daily institution, not an infinite shop, and
// (V2.8 Phase 3) a RAW-material safety net only — never processed/finished goods.
// Advanced raw (eggs/strawberry) has thin daily stock so player farms are the
// real source; it only prevents a hard deadlock at a premium.
export const WHOLESALE_PRODUCTS: ProductId[] = ['wheat', 'milk', 'beans', 'eggs', 'strawberry'];
// Modest daily supply so a few aggressive buyers create real scarcity (which
// pushes players toward the marketplace) rather than an infinite shop.
export const WHOLESALE_DAILY_STOCK: Partial<Record<ProductId, number>> = {
  wheat: 800, milk: 700, beans: 900, eggs: 250, strawberry: 150,
};
// A "wholesale day" in real seconds. Long for live play; tests use dev resets.
export const WHOLESALE_DAY_SECONDS = 24 * 3600;

// Emergency fallback so new players are never blocked when stock runs out:
// expensive and capped per purchase to discourage abuse.
export const EMERGENCY_PRICE_MULT = 2.5;
export const EMERGENCY_MAX_PER_BUY = 100;

export type StockCategory = 'out_of_stock' | 'low' | 'limited' | 'normal';
/** Remaining stock as a display category. */
export function stockCategory(remaining: number, dailyStock: number): StockCategory {
  if (remaining <= 0) return 'out_of_stock';
  const pct = remaining / Math.max(1, dailyStock);
  if (pct <= 0.15) return 'low';
  if (pct <= 0.40) return 'limited';
  return 'normal';
}

// ---- Market integrity (hidden economic-trust system) ----
export type IntegrityState = 'normal' | 'watchlist' | 'investigating' | 'confirmed';

export const INTEGRITY_START = 100;
// Per-day signal weights (accumulate into a day's suspicion). Individually weak
// so a single action never flags a day — evidence must combine and repeat.
export const SIGNAL_HIGH_SHARE = 3;     // bought >50% of a product's daily stock
export const SIGNAL_DEPLETION = 3;      // a buy pushed a product into emergency
export const SIGNAL_EXTREME_RESALE = 2; // listed a sell order at >3x base price
export const HIGH_SHARE_FRACTION = 0.5;
export const EXTREME_RESALE_MULT = 3;
// A day is "flagged" only when combined signals reach this (e.g. cornering the
// supply AND depleting it, or repeated extreme-price listings).
export const SUSPICION_DAY_THRESHOLD = 5;
export const SCORE_DROP_PER_FLAG = 20;
export const SCORE_RECOVER_PER_CLEAN_DAY = 10;
// Confirmed manipulation: reputation penalty (recoverable) + public warning.
export const REP_VIOLATION_PENALTY = 1.0;
export const VIOLATION_WARNING_SECONDS = 3 * 24 * 3600;
