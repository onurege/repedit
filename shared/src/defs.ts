// ============================================================
// Data-driven game definitions shared by client and server.
// Extend by adding entries — no engine changes needed.
// ============================================================

export type ProductId = 'milk' | 'beans' | 'coffee' | 'wheat' | 'bread';

export interface ProductDef {
  id: ProductId;
  name: string;
  basePrice: number; // reference price, whole dollars
  emoji: string;
}

export const PRODUCTS: Record<ProductId, ProductDef> = {
  milk: { id: 'milk', name: 'Milk', basePrice: 12, emoji: '🥛' },
  beans: { id: 'beans', name: 'Coffee Beans', basePrice: 8, emoji: '🫘' },
  coffee: { id: 'coffee', name: 'Coffee', basePrice: 30, emoji: '☕' },
  wheat: { id: 'wheat', name: 'Wheat', basePrice: 8, emoji: '🌾' },
  bread: { id: 'bread', name: 'Bread', basePrice: 20, emoji: '🍞' },
};

// Reference retail prices used for demand/fairness of retail sales.
export const RETAIL_BASE: Partial<Record<ProductId, number>> = {
  coffee: 30,
  bread: 20,
  milk: 18,
};

export type BusinessType = 'farm' | 'coffee_shop' | 'bakery' | 'mini_market';

// What the farm can produce (owner-selectable).
export type FarmProduct = 'milk' | 'wheat';

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
export const NPC_WHOLESALE_PRICES: Partial<Record<ProductId, number>> = {
  milk: 15,
  beans: 8,
  wheat: 10, // player farms can profitably undercut (~$6-9)
  bread: 16, // player bakeries can profitably undercut (~$12-15)
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

// ---- Reputation ----
export const REP_MIN = 1.0;
export const REP_MAX = 5.0;
export const REP_START = 3.0;
export const REP_SALE_FAIR_PRICE = 0.002;   // per sale at fair price
export const REP_SALE_GOUGING = -0.002;     // per sale above 1.2x base
export const REP_LOST_CUSTOMER = -0.005;    // out of stock when customer arrives
export const REP_TRADE_FULFILLED = 0.05;    // farm fulfils a marketplace trade

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
