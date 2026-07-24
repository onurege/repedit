// ============================================================
// The authoritative game world.
//
// All economic state lives here in memory while the server runs;
// PostgreSQL is the durable record. Mutations happen synchronously
// in memory (Node's single thread = no interleaving), then persist
// via transactions. Critical multi-party operations (trades,
// purchases, upgrades) persist immediately and atomically; ambient
// simulation state flushes every few seconds.
// ============================================================

import { EventEmitter } from 'node:events';
import {
  PRODUCTS,
  ProductId,
  BusinessType,
  FARM_LEVELS,
  SHOP_LEVELS,
  BAKERY_LEVELS,
  MARKET_LEVELS,
  RETAIL_BASE,
  DEFAULT_BREAD_PRICE,
  DEFAULT_RETAIL_MILK_PRICE,
  MAX_LEVEL,
  STARTING_CASH,
  NPC_WHOLESALE_PRICES,
  DEFAULT_COFFEE_PRICE,
  MIN_COFFEE_PRICE,
  MAX_COFFEE_PRICE,
  priceDemandMultiplier,
  repDemandMultiplier,
  levelForXp,
  XP,
  REP_MIN,
  REP_MAX,
  REP_START,
  REP_SALE_FAIR_PRICE,
  REP_SALE_GOUGING,
  REP_LOST_CUSTOMER,
  REP_TRADE_FULFILLED,
  REP_CONTRACT_FULFILLED,
  BUSINESS_CAPACITY,
  companyCapacity,
  companyLevelForXp,
  COMPANY_LEVELS,
  MAX_COMPANY_LEVEL,
  COMPANY_XP,
  businessOpenCost,
  COMPANY_NAME_MIN,
  COMPANY_NAME_MAX,
  defaultCompanyName,
  SELLER_SUPPLIES,
  BUYER_CONSUMES,
  contractableProducts,
  CONTRACT_MAX_QTY,
  CONTRACT_MIN_DELIVERIES,
  CONTRACT_MAX_DELIVERIES,
  CONTRACT_FREQUENCY_SECS,
  OFFLINE_CAP_SECONDS,
  VAN_SPEED,
  MIN_DELIVERY_SECONDS,
  MARKET_MIN_PRICE,
  MARKET_MAX_PRICE,
  MARKET_MAX_QTY,
  BUSINESS_NAME_MIN,
  BUSINESS_NAME_MAX,
  LOTS,
  lotById,
  lotsOfKind,
  DISTRICTS,
  districtLots,
  DEFAULT_DISTRICT,
  WHOLESALE_LOT_ID,
  roadPath,
  pathLength,
  type PlayerPriv,
  type PlayerPub,
  type BizPub,
  type DistrictId,
  type DistrictOccupancy,
  type CityStatus,
  type CityActivity,
  type BizPriv,
  type OrderPub,
  type DeliveryPub,
  type TradeRow,
  type AwayReport,
  type InventoryEntry,
  type BizStatus,
  type ContractResult,
  type MsgParams,
  type ContractPub,
  type CompanyPriv,
  RANKING_WINDOW_SECONDS,
  FINAL_MARKET_PRODUCTS,
  SUPPLIER_PRODUCTS,
  GROWTH_MIN_REVENUE,
  RANKING_TOP_N,
  RANKING_CATEGORIES,
  type RankingCategory,
  type CompanyProfile,
  type MarketShareEntry,
  type SupplierRankEntry,
  type CityRankings,
  type RankingBoard,
  type RankingRow,
  DEMAND_PRODUCTS,
  DEMAND_MIN,
  DEMAND_MAX,
  WHOLESALE_MOD_MAX,
  demandCategory,
  CITY_EVENTS,
  CITY_EVENT_TYPES,
  EVENT_GAP_MIN_SECS,
  EVENT_GAP_MAX_SECS,
  EVENT_TYPE_COOLDOWN_SECS,
  type CityEventType,
  type CityEventStatus,
  type CityEventEffects,
  type CityEventPub,
  type CityMarket,
  type ProductDemand,
  type WholesaleStatus,
  UPDATES,
  TUTORIAL_LAST_STEP,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  type MorningBrief,
  type BusinessAlert,
  type Opportunity,
  type BriefSale,
  type BriefMarket,
  type TutorialState,
  type UpdatePub,
  type AnnouncementPub,
  type AnnouncementType,
  type AnnouncementPriority,
  WHOLESALE_PRODUCTS,
  WHOLESALE_DAILY_STOCK,
  WHOLESALE_DAY_SECONDS,
  EMERGENCY_PRICE_MULT,
  EMERGENCY_MAX_PER_BUY,
  stockCategory,
  INTEGRITY_START,
  SIGNAL_HIGH_SHARE,
  SIGNAL_DEPLETION,
  isImportDependent,
  BUSINESS_INPUTS,
  SIGNAL_EXTREME_RESALE,
  HIGH_SHARE_FRACTION,
  EXTREME_RESALE_MULT,
  SUSPICION_DAY_THRESHOLD,
  SCORE_DROP_PER_FLAG,
  SCORE_RECOVER_PER_CLEAN_DAY,
  REP_VIOLATION_PENALTY,
  VIOLATION_WARNING_SECONDS,
  type IntegrityState,
  type WholesaleProduct,
  type WholesaleState,
} from '@district/shared';
import { query, tx } from '../db.js';

/** Cached raw per-metric value maps (companyId -> value) for city rankings. */
interface RankingMaps {
  revenue: Map<number, number>;
  net: Map<number, number>;
  rep: Map<number, number>;
  growth: Map<number, number>;
  bread: Map<number, number>;
  coffee: Map<number, number>;
  milkRetail: Map<number, number>;
  wheatSup: Map<number, number>;
  milkSup: Map<number, number>;
}

/**
 * A player-facing failure. Carries a locale-independent `code` (plus
 * interpolation params) so the client renders it in the player's language;
 * the Error message itself is only for server logs.
 */
export class GameError extends Error {
  constructor(readonly code: string, readonly params?: MsgParams) {
    super(code);
  }
}

export interface PlayerRec {
  id: number;
  name: string;
  cash: number;
  xp: number;
  level: number;
  lastSeenMs: number;
  connections: number;
  isAdmin: boolean;
  awaySnapshot: {
    ts: number;
    revenue: number;
    expenses: number;
    milkProduced: number;
    coffeeSold: number;
  } | null;
  dirty: boolean;
}

interface InvRec {
  qty: number;
  reserved: number;
}

export interface CompanyRec {
  id: number;
  ownerId: number;
  name: string;
  level: number;
  xp: number;
  revenueAccum: number; // fractional revenue toward the next company XP point
  createdAtMs: number;
  dirty: boolean;
}

export interface BizRec {
  id: number;
  ownerId: number;
  companyId: number;
  type: BusinessType;
  name: string | null;
  lotId: string;
  createdAtMs: number;
  level: number;
  price: number;
  price2: number;      // mini market milk retail price
  production: string;  // farm: 'milk' | 'wheat'
  reputation: number;
  revenue: number;
  expenses: number;
  milkProduced: number;
  coffeeSold: number;
  customers: number;
  prodAccum: number;
  brewAccum: number;
  custAccum: number;
  status: BizStatus;
  inv: Map<ProductId, InvRec>;
  tradeCount: number; // successful player trades + contract deliveries (public)
  dirty: boolean;
}

export interface ContractRec {
  id: number;
  buyerId: number;
  sellerId: number;
  buyerBizId: number;
  sellerBizId: number;
  product: ProductId;
  quantity: number;
  unitPrice: number;
  frequencySecs: number;
  totalDeliveries: number;
  remaining: number;
  status: 'proposed' | 'active' | 'completed' | 'rejected' | 'cancelled';
  lastResult: ContractResult | null;
  nextExecutionAtMs: number | null;
  createdAtMs: number;
}

export interface OrderRec {
  id: number;
  playerId: number;
  businessId: number;
  side: 'buy' | 'sell';
  product: ProductId;
  qty: number;
  remaining: number;
  price: number;
  status: 'open' | 'filled' | 'cancelled';
  createdAtMs: number;
}

export interface DeliveryRec {
  id: number;
  product: ProductId;
  qty: number;
  fromLot: string;
  toLot: string;
  toBusinessId: number;
  status: 'in_transit' | 'waiting' | 'delivered';
  departAtMs: number;
  arriveAtMs: number;
}

// V2.3: a city event in memory (only upcoming/active are kept live).
export interface EventRec {
  id: number;
  type: CityEventType;
  status: CityEventStatus;
  effects: CityEventEffects;
  announcedAtMs: number;
  startsAtMs: number;
  endsAtMs: number;
  major: boolean;
}

// V2.5: finite Central Wholesale daily supply for one product.
export interface WholesaleRec {
  product: ProductId;
  dailyStock: number;
  remaining: number;
  basePrice: number;
  resetAtMs: number;
  dirty: boolean;
}

// V2.5: hidden per-company economic-trust record.
export interface IntegrityRec {
  companyId: number;
  score: number;
  state: IntegrityState;
  suspicionToday: number;
  flaggedDays: number;
  violationUntilMs: number | null;
  crossedHighShare: Set<ProductId>; // in-memory: 50%-crossing already scored today
  dirty: boolean;
}

// Append-only economic ledger entry (see migrations/002).
interface LedgerEntry {
  playerId: number;
  businessId: number | null;
  type: string; // NPC_PURCHASE | CUSTOMER_SALE | MARKET_ESCROW | MARKET_REFUND | MARKET_BUY | MARKET_SELL | BUSINESS_UPGRADE
  amount: number; // signed: positive credits player cash
  refType: string | null;
  refId: number | null;
  before: number;
  after: number;
}

const LEDGER_SQL = `INSERT INTO economic_ledger
  (player_id, business_id, transaction_type, amount, reference_type, reference_id, balance_before, balance_after)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

function ledgerParams(e: LedgerEntry): any[] {
  return [e.playerId, e.businessId, e.type, e.amount, e.refType, e.refId, e.before, e.after];
}

// V2.2 competitive activity (see migrations/006). Recorded only from committed
// economic events, so a failed/duplicate transaction never inflates a stat.
interface ActivityEntry {
  companyId: number;
  businessId: number | null;
  kind: 'final_sale' | 'supplier_sale';
  product: ProductId;
  units: number;
  amount: number;
}

const ACTIVITY_SQL = `INSERT INTO company_activity
  (company_id, business_id, kind, product, units, amount)
  VALUES ($1,$2,$3,$4,$5,$6)`;

function activityParams(e: ActivityEntry): any[] {
  return [e.companyId, e.businessId, e.kind, e.product, e.units, e.amount];
}

const TRADABLE: ProductId[] = ['milk', 'beans', 'wheat', 'bread'];

const STARTING_PRODUCTS: Record<BusinessType, ProductId[]> = {
  farm: ['milk', 'wheat'],
  coffee_shop: ['milk', 'beans', 'coffee'],
  bakery: ['wheat', 'bread'],
  mini_market: ['bread', 'milk'],
};

// V2.4: which final-consumer products each business type sells to NPCs, and
// which inputs it needs (for low-stock alerts).
const FINAL_PRODUCTS_OF: Record<BusinessType, ProductId[]> = {
  coffee_shop: ['coffee'], bakery: ['bread'], mini_market: ['bread', 'milk'], farm: [],
};
// Recipe inputs come from the shared single source of truth (BUSINESS_INPUTS).
const INPUTS_OF = BUSINESS_INPUTS;

function inv(biz: BizRec, product: ProductId): InvRec {
  let rec = biz.inv.get(product);
  if (!rec) {
    rec = { qty: 0, reserved: 0 };
    biz.inv.set(product, rec);
  }
  return rec;
}

/**
 * Physical goods currently occupying a product's storage slot: on-hand plus
 * goods reserved for outgoing market sell orders (still on the lot).
 */
function usedStorage(biz: BizRec, product: ProductId): number {
  const rec = biz.inv.get(product);
  return rec ? rec.qty + rec.reserved : 0;
}

/**
 * Free space in a product's storage slot right now (never negative). A
 * business over its (possibly reduced/legacy) capacity reports 0 free.
 */
function freeSpaceFor(biz: BizRec, product: ProductId): number {
  return Math.max(0, capacityFor(biz, product) - usedStorage(biz, product));
}

function capacityFor(biz: BizRec, product: ProductId): number {
  switch (biz.type) {
    case 'farm':
      return product === 'milk' || product === 'wheat'
        ? FARM_LEVELS[biz.level].milkCapacity
        : 0;
    case 'coffee_shop': {
      const lv = SHOP_LEVELS[biz.level];
      if (product === 'coffee') return lv.coffeeCapacity;
      return product === 'milk' || product === 'beans' ? lv.ingredientCapacity : 0;
    }
    case 'bakery': {
      const lv = BAKERY_LEVELS[biz.level];
      if (product === 'bread') return lv.coffeeCapacity;
      return product === 'wheat' ? lv.ingredientCapacity : 0;
    }
    case 'mini_market':
      return product === 'bread' || product === 'milk'
        ? MARKET_LEVELS[biz.level].stockCapacity
        : 0;
  }
}

export class World extends EventEmitter {
  players = new Map<number, PlayerRec>();
  companies = new Map<number, CompanyRec>(); // keyed by ownerId (1 company/player)
  businesses = new Map<number, BizRec>();
  orders = new Map<number, OrderRec>();
  deliveries = new Map<number, DeliveryRec>();
  contracts = new Map<number, ContractRec>();
  // V2.3: live (upcoming + active) city events and derived demand state.
  cityEvents: EventRec[] = [];
  private demand = new Map<ProductId, number>();       // effective multiplier
  private demandTrend = new Map<ProductId, 'up' | 'down' | 'flat'>();
  private wholesaleMods = new Map<ProductId, number>();  // >1 while modified
  private lastEventTypeAtMs = new Map<CityEventType, number>();
  private nextEventAtMs = 0;
  private marketSig = '';   // signature of current market; emit only on change
  // V2.5: finite wholesale supply + hidden company integrity.
  wholesale = new Map<ProductId, WholesaleRec>();
  private integrity = new Map<number, IntegrityRec>(); // keyed by companyId
  // Per-company per-product units bought this wholesale day (in-memory).
  private dailyBuys = new Map<number, Map<ProductId, number>>();
  timeScale = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private ticksSinceFlush = 0;
  private tickInProgress = false;
  private fulfillLocks = new Set<number>();
  private contractLocks = new Set<number>();
  private openLocks = new Set<number>(); // per-player lock for business opening
  // CUSTOMER_SALE ledger entries accumulate here (simulate() is synchronous)
  // and are persisted in batch by flush().
  private ledgerQueue: LedgerEntry[] = [];
  // V2.2: final-consumer sales from the tick accumulate here and persist in the
  // same transaction as the ledger (exactly-once with the economic activity).
  private activityQueue: ActivityEntry[] = [];
  // Cache the expensive per-metric value maps briefly; per-viewer boards (which
  // add each player's own-rank marker) are then built cheaply in memory.
  private rankingsCache: { at: number; maps: RankingMaps } | null = null;

  /** All businesses owned by a player (may be several since V2.1). */
  bizesByOwner(playerId: number): BizRec[] {
    const list: BizRec[] = [];
    for (const b of this.businesses.values()) if (b.ownerId === playerId) list.push(b);
    return list;
  }

  /** Aggregate lifetime counters across all of a player's businesses. */
  private bizTotals(playerId: number): {
    revenue: number;
    expenses: number;
    milkProduced: number;
    coffeeSold: number;
  } {
    const t = { revenue: 0, expenses: 0, milkProduced: 0, coffeeSold: 0 };
    for (const b of this.bizesByOwner(playerId)) {
      t.revenue += b.revenue;
      t.expenses += b.expenses;
      t.milkProduced += b.milkProduced;
      t.coffeeSold += b.coffeeSold;
    }
    return t;
  }

  /** Legacy single-business accessor: the player's first business, if any. */
  bizByOwner(playerId: number): BizRec | undefined {
    for (const b of this.businesses.values()) if (b.ownerId === playerId) return b;
    return undefined;
  }

  private player(id: number): PlayerRec {
    const p = this.players.get(id);
    if (!p) throw new GameError('err.unknown_player');
    return p;
  }

  private requireBiz(playerId: number): BizRec {
    const b = this.bizByOwner(playerId);
    if (!b) throw new GameError('err.need_business');
    return b;
  }

  /**
   * Resolve which of a player's businesses an action targets. With an explicit
   * `bizId` it must be owned by the player; otherwise, if the player owns
   * exactly one business, that one is used (keeps single-business play simple).
   */
  private requireOwnedBiz(playerId: number, bizId?: number): BizRec {
    if (bizId != null) {
      const b = this.businesses.get(bizId);
      if (!b || b.ownerId !== playerId) throw new GameError('err.not_your_business');
      return b;
    }
    const list = this.bizesByOwner(playerId);
    if (list.length === 0) throw new GameError('err.need_business');
    if (list.length > 1) throw new GameError('err.select_business');
    return list[0];
  }

  companyByOwner(playerId: number): CompanyRec | undefined {
    return this.companies.get(playerId);
  }

  private capacityUsed(playerId: number): number {
    let used = 0;
    for (const b of this.bizesByOwner(playerId)) used += BUSINESS_CAPACITY[b.type];
    return used;
  }

  private addCompanyXp(company: CompanyRec, amount: number): void {
    if (amount <= 0) return;
    company.xp += Math.round(amount);
    const newLevel = companyLevelForXp(company.xp);
    if (newLevel > company.level) {
      company.level = newLevel;
      this.emit('company_levelup', { ownerId: company.ownerId, level: newLevel });
    }
    company.dirty = true;
  }

  /** Company XP earned from business revenue (steady, non-exploitable). */
  private addCompanyRevenueXp(playerId: number, revenue: number): void {
    const company = this.companies.get(playerId);
    if (!company || revenue <= 0) return;
    company.revenueAccum += revenue;
    const xp = Math.floor(company.revenueAccum / COMPANY_XP.revenuePerXp);
    if (xp > 0) {
      company.revenueAccum -= xp * COMPANY_XP.revenuePerXp;
      this.addCompanyXp(company, xp);
    }
  }

  // ---------------- loading & persistence ----------------

  async load(): Promise<void> {
    const now = Date.now();
    const players = await query('SELECT * FROM players');
    for (const r of players.rows) {
      this.players.set(r.id, {
        id: r.id,
        name: r.username,
        cash: r.cash,
        xp: r.xp,
        level: r.level,
        lastSeenMs: new Date(r.last_seen).getTime(),
        connections: 0,
        isAdmin: r.is_admin ?? false,
        awaySnapshot: r.away_snapshot ?? null,
        dirty: false,
      });
    }
    const companyRows = await query('SELECT * FROM companies');
    for (const r of companyRows.rows) {
      this.companies.set(r.player_id, {
        id: r.id,
        ownerId: r.player_id,
        name: r.name,
        level: r.level,
        xp: r.xp,
        revenueAccum: 0,
        createdAtMs: new Date(r.created_at).getTime(),
        dirty: false,
      });
    }
    const bizRows = await query('SELECT * FROM businesses');
    const invRows = await query('SELECT * FROM inventories');
    for (const r of bizRows.rows) {
      const accums = r.accums || {};
      const biz: BizRec = {
        id: r.id,
        ownerId: r.player_id,
        companyId: r.company_id ?? this.companies.get(r.player_id)?.id ?? 0,
        type: r.type,
        name: r.name ?? null,
        lotId: r.lot_id,
        createdAtMs: new Date(r.created_at).getTime(),
        level: r.level,
        price: r.price,
        price2: r.price2 ?? DEFAULT_RETAIL_MILK_PRICE,
        production: r.production ?? 'milk',
        reputation: r.reputation,
        revenue: r.revenue,
        expenses: r.expenses,
        milkProduced: r.milk_produced,
        coffeeSold: r.coffee_sold,
        customers: r.customers,
        prodAccum: accums.prod ?? 0,
        brewAccum: accums.brew ?? 0,
        custAccum: accums.cust ?? 0,
        status: '',
        inv: new Map(),
        tradeCount: 0,
        dirty: false,
      };
      this.businesses.set(biz.id, biz);
      // Catch up simulation for downtime (capped).
      const elapsed = Math.max(0, (now - new Date(r.sim_ts).getTime()) / 1000);
      (biz as any).__catchup = Math.min(elapsed, OFFLINE_CAP_SECONDS);
    }
    for (const r of invRows.rows) {
      const biz = this.businesses.get(r.business_id);
      if (biz) biz.inv.set(r.product, { qty: r.qty, reserved: r.reserved });
    }
    const orders = await query("SELECT * FROM market_orders WHERE status = 'open'");
    for (const r of orders.rows) {
      this.orders.set(r.id, {
        id: r.id,
        playerId: r.player_id,
        businessId: r.business_id ?? this.bizByOwner(r.player_id)?.id ?? 0,
        side: r.side,
        product: r.product,
        qty: r.qty,
        remaining: r.remaining,
        price: r.price,
        status: r.status,
        createdAtMs: new Date(r.created_at).getTime(),
      });
    }
    const deliveries = await query("SELECT * FROM deliveries WHERE status IN ('in_transit','waiting')");
    for (const r of deliveries.rows) {
      this.deliveries.set(r.id, {
        id: r.id,
        product: r.product,
        qty: r.qty,
        fromLot: r.from_lot,
        toLot: r.to_lot,
        toBusinessId: r.to_business,
        status: r.status,
        departAtMs: new Date(r.depart_at).getTime(),
        arriveAtMs: new Date(r.arrive_at).getTime(),
      });
    }

    // Supply contracts (proposed + active survive restarts).
    const contracts = await query(
      "SELECT * FROM contracts WHERE status IN ('proposed','active')"
    );
    for (const r of contracts.rows) {
      this.contracts.set(r.id, this.contractRowToRec(r));
    }
    // Seed public trade counts from historical market trades.
    const counts = await query(
      `SELECT player_id, sum(n)::int AS total FROM (
         SELECT buyer_id AS player_id, count(*) AS n FROM trades GROUP BY buyer_id
         UNION ALL
         SELECT seller_id AS player_id, count(*) AS n FROM trades GROUP BY seller_id
       ) x GROUP BY player_id`
    );
    for (const r of counts.rows) {
      const biz = this.bizByOwner(r.player_id);
      if (biz) biz.tradeCount = r.total;
    }

    // Run capped catch-up simulation for server downtime.
    for (const biz of this.businesses.values()) {
      const secs = (biz as any).__catchup as number;
      delete (biz as any).__catchup;
      if (secs > 1) this.catchUp(biz, secs);
    }
    // Complete overdue deliveries.
    for (const d of [...this.deliveries.values()]) {
      if (d.arriveAtMs <= now) await this.completeDelivery(d);
    }
    // Execute any contracts that came due while the server was down.
    for (const c of [...this.contracts.values()]) {
      if (c.status === 'active' && c.nextExecutionAtMs != null && c.nextExecutionAtMs <= now) {
        await this.executeContract(c.id);
      }
    }

    // V2.3: restore live city events and resolve any transitions missed while
    // the server was down, then derive current demand.
    const evRows = await query(`SELECT * FROM city_events WHERE status IN ('upcoming','active')`);
    this.cityEvents = evRows.rows.map((r) => ({
      id: r.id,
      type: r.event_type as CityEventType,
      status: r.status as CityEventStatus,
      effects: r.effects as CityEventEffects,
      announcedAtMs: new Date(r.announced_at).getTime(),
      startsAtMs: new Date(r.starts_at).getTime(),
      endsAtMs: new Date(r.ends_at).getTime(),
      major: CITY_EVENTS[r.event_type as CityEventType]?.major ?? false,
    }));
    for (const e of this.cityEvents) this.lastEventTypeAtMs.set(e.type, e.announcedAtMs);
    this.nextEventAtMs = now + this.randInt(EVENT_GAP_MIN_SECS, EVENT_GAP_MAX_SECS) * 1000;
    await this.processEvents(now);

    // V2.5: restore (or seed) wholesale supply and company integrity records.
    await this.loadWholesale(now);
    const intRows = await query('SELECT * FROM company_integrity');
    for (const r of intRows.rows) {
      this.integrity.set(r.company_id, {
        companyId: r.company_id, score: r.score, state: r.state,
        suspicionToday: r.suspicion_today, flaggedDays: r.flagged_days,
        violationUntilMs: r.violation_until ? new Date(r.violation_until).getTime() : null,
        crossedHighShare: new Set(), dirty: false,
      });
    }
    await this.processWholesale(now);
    await this.seedExpansionAnnouncement();

    await this.flush();
    console.log(
      `[world] loaded ${this.players.size} players, ${this.businesses.size} businesses, ` +
        `${this.orders.size} open orders, ${this.deliveries.size} deliveries in transit, ` +
        `${this.contracts.size} contracts`
    );
  }

  private contractRowToRec(r: any): ContractRec {
    return {
      id: r.id,
      buyerId: r.buyer_player_id,
      sellerId: r.seller_player_id,
      buyerBizId: r.buyer_business_id,
      sellerBizId: r.seller_business_id,
      product: r.product,
      quantity: r.quantity,
      unitPrice: r.unit_price,
      frequencySecs: r.frequency_secs,
      totalDeliveries: r.total_deliveries,
      remaining: r.remaining_deliveries,
      status: r.status,
      lastResult: r.last_result ?? null,
      nextExecutionAtMs: r.next_execution_at ? new Date(r.next_execution_at).getTime() : null,
      createdAtMs: new Date(r.created_at).getTime(),
    };
  }

  async flush(): Promise<void> {
    const dirtyPlayers = [...this.players.values()].filter((p) => p.dirty);
    const dirtyBiz = [...this.businesses.values()].filter((b) => b.dirty);
    const dirtyCompanies = [...this.companies.values()].filter((c) => c.dirty);
    const ledger = this.ledgerQueue;
    const activity = this.activityQueue;
    if (!dirtyPlayers.length && !dirtyBiz.length && !dirtyCompanies.length && !ledger.length && !activity.length) return;
    this.ledgerQueue = [];
    this.activityQueue = [];
    try {
      await this.flushTx(dirtyPlayers, dirtyBiz, dirtyCompanies, ledger, activity);
    } catch (err) {
      // don't lose audit rows on a transient failure
      this.ledgerQueue.unshift(...ledger);
      this.activityQueue.unshift(...activity);
      throw err;
    }
  }

  private async flushTx(
    dirtyPlayers: PlayerRec[], dirtyBiz: BizRec[], dirtyCompanies: CompanyRec[],
    ledger: LedgerEntry[], activity: ActivityEntry[] = []
  ): Promise<void> {
    await tx(async (c) => {
      for (const e of ledger) await c.query(LEDGER_SQL, ledgerParams(e));
      for (const a of activity) await c.query(ACTIVITY_SQL, activityParams(a));
      for (const co of dirtyCompanies) {
        await c.query('UPDATE companies SET name=$1, level=$2, xp=$3 WHERE id=$4', [co.name, co.level, co.xp, co.id]);
        co.dirty = false;
      }
      for (const p of dirtyPlayers) {
        await c.query(
          `UPDATE players SET cash=$1, xp=$2, level=$3, last_seen=to_timestamp($4/1000.0), away_snapshot=$5 WHERE id=$6`,
          [p.cash, p.xp, p.level, p.lastSeenMs, p.awaySnapshot ? JSON.stringify(p.awaySnapshot) : null, p.id]
        );
        p.dirty = false;
      }
      for (const b of dirtyBiz) {
        await c.query(
          `UPDATE businesses SET level=$1, price=$2, reputation=$3, revenue=$4, expenses=$5,
             milk_produced=$6, coffee_sold=$7, customers=$8, accums=$9, sim_ts=now(),
             price2=$11, production=$12 WHERE id=$10`,
          [
            b.level,
            b.price,
            b.reputation,
            b.revenue,
            b.expenses,
            b.milkProduced,
            b.coffeeSold,
            b.customers,
            JSON.stringify({ prod: b.prodAccum, brew: b.brewAccum, cust: b.custAccum }),
            b.id,
            b.price2,
            b.production,
          ]
        );
        for (const [product, rec] of b.inv) {
          await c.query(
            `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
             ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
            [b.id, product, rec.qty, rec.reserved]
          );
        }
        b.dirty = false;
      }
    });
  }

  // ---------------- ticking ----------------

  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      // Two economic ticks must never run concurrently: skip this beat if
      // the previous tick's async persistence hasn't finished yet.
      if (this.tickInProgress) return;
      this.tickInProgress = true;
      this.tick(1 * this.timeScale)
        .catch((err) => console.error('[world] tick error', err))
        .finally(() => {
          this.tickInProgress = false;
        });
    }, 1000);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  async tick(dt: number): Promise<void> {
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.connections > 0) {
        p.lastSeenMs = now;
        p.dirty = true;
      }
    }
    for (const biz of this.businesses.values()) {
      const owner = this.players.get(biz.ownerId);
      // Offline progression cap: pause businesses whose owner has been
      // away for a long time (prevents unbounded idle income).
      if (owner && owner.connections === 0 && now - owner.lastSeenMs > OFFLINE_CAP_SECONDS * 1000) {
        biz.status = 'paused_away';
        continue;
      }
      this.simulate(biz, dt, false);
    }
    for (const d of [...this.deliveries.values()]) {
      if (d.status === 'in_transit' && d.arriveAtMs <= now) {
        await this.completeDelivery(d);
      } else if (d.status === 'waiting') {
        // Periodic fallback: retry a delivery that couldn't fit earlier.
        await this.completeDelivery(d);
      }
    }
    for (const c of [...this.contracts.values()]) {
      if (c.status === 'active' && c.nextExecutionAtMs != null && c.nextExecutionAtMs <= now) {
        await this.executeContract(c.id);
      }
    }
    await this.processEvents(now);
    await this.processWholesale(now);
    this.ticksSinceFlush++;
    if (this.ticksSinceFlush >= 5) {
      this.ticksSinceFlush = 0;
      await this.flush();
    }
    this.emit('tick');
  }

  /** Aggregated offline / downtime catch-up in 60s chunks. */
  catchUp(biz: BizRec, seconds: number): void {
    let remaining = Math.min(seconds, OFFLINE_CAP_SECONDS);
    while (remaining > 0) {
      const step = Math.min(60, remaining);
      this.simulate(biz, step, true);
      remaining -= step;
    }
  }

  // ============================================================
  // V2.3 — dynamic city demand & city events
  // ============================================================

  /** Effective demand multiplier for a final product (1.0 = base). */
  cityDemand(product: ProductId): number {
    return this.demand.get(product) ?? 1;
  }

  /** Effective NPC wholesale price multiplier for an input product. */
  private wholesaleModifier(product: ProductId): number {
    return this.wholesaleMods.get(product) ?? 1;
  }

  /**
   * Recompute demand & wholesale multipliers from the currently-ACTIVE events.
   * Derived fresh every tick (never accumulated), so a restart or a double tick
   * can never apply or remove a modifier twice.
   */
  private recomputeDemand(): void {
    const demandDelta = new Map<ProductId, number>();
    const wholesaleDelta = new Map<ProductId, number>();
    for (const e of this.cityEvents) {
      if (e.status !== 'active') continue;
      for (const [p, d] of Object.entries(e.effects.demand ?? {})) {
        demandDelta.set(p as ProductId, (demandDelta.get(p as ProductId) ?? 0) + (d as number));
      }
      for (const [p, d] of Object.entries(e.effects.wholesale ?? {})) {
        wholesaleDelta.set(p as ProductId, (wholesaleDelta.get(p as ProductId) ?? 0) + (d as number));
      }
    }
    for (const p of DEMAND_PRODUCTS) {
      const prev = this.demand.get(p) ?? 1;
      const eff = Math.min(DEMAND_MAX, Math.max(DEMAND_MIN, 1 + (demandDelta.get(p) ?? 0)));
      this.demand.set(p, eff);
      const d = eff - prev;
      if (d > 0.001) this.demandTrend.set(p, 'up');
      else if (d < -0.001) this.demandTrend.set(p, 'down');
      else if (!this.demandTrend.has(p)) this.demandTrend.set(p, 'flat');
    }
    const wm = new Map<ProductId, number>();
    for (const [p, d] of wholesaleDelta) {
      wm.set(p, Math.min(WHOLESALE_MOD_MAX, Math.max(1, 1 + d)));
    }
    this.wholesaleMods = wm;
  }

  /** Stable signature of the live event set, so we emit only on real change. */
  private marketSignature(): string {
    return this.cityEvents
      .map((e) => `${e.id}:${e.status}`)
      .sort()
      .join('|');
  }

  private async transitionEvent(e: EventRec, to: CityEventStatus): Promise<boolean> {
    const from = e.status;
    // Guard on the current status so a transition can never be applied twice.
    const res = await query(
      `UPDATE city_events SET status=$1 WHERE id=$2 AND status=$3 RETURNING id`,
      [to, e.id, from]
    );
    if (!res.rowCount) return false;
    e.status = to;
    console.log(`[event] ${e.type} #${e.id} ${from} -> ${to}`);
    return true;
  }

  private randInt(min: number, max: number): number {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  private weightedPick(types: CityEventType[]): CityEventType {
    const total = types.reduce((s, t) => s + CITY_EVENTS[t].weight, 0);
    let r = Math.random() * total;
    for (const t of types) {
      r -= CITY_EVENTS[t].weight;
      if (r <= 0) return t;
    }
    return types[types.length - 1];
  }

  /** Create an UPCOMING event (announced now, starting after its lead time). */
  async createEvent(
    type: CityEventType,
    opts: { announceSecs?: number; durationSecs?: number } = {},
    now = Date.now()
  ): Promise<EventRec> {
    const def = CITY_EVENTS[type];
    const announceSecs = opts.announceSecs ?? def.announceSecs;
    const durationSecs = opts.durationSecs ?? def.durationSecs;
    const startsAt = now + announceSecs * 1000;
    const endsAt = startsAt + durationSecs * 1000;
    const res = await query(
      `INSERT INTO city_events (event_type, status, effects, announced_at, starts_at, ends_at)
       VALUES ($1,'upcoming',$2, to_timestamp($3/1000.0), to_timestamp($4/1000.0), to_timestamp($5/1000.0))
       RETURNING id`,
      [type, JSON.stringify(def.effects), now, startsAt, endsAt]
    );
    const rec: EventRec = {
      id: res.rows[0].id, type, status: 'upcoming', effects: def.effects,
      announcedAtMs: now, startsAtMs: startsAt, endsAtMs: endsAt, major: def.major,
    };
    this.cityEvents.push(rec);
    this.lastEventTypeAtMs.set(type, now);
    console.log(`[event] scheduled ${type} #${rec.id} starts in ${announceSecs}s, lasts ${durationSecs}s`);
    return rec;
  }

  /** Auto-scheduler: keeps at most one upcoming event and one active major. */
  private async maybeScheduleEvent(now: number): Promise<boolean> {
    if (this.cityEvents.some((e) => e.status === 'upcoming')) return false;
    if (now < this.nextEventAtMs) return false;
    const activeMajor = this.cityEvents.some((e) => e.status === 'active' && e.major);
    const pool = CITY_EVENT_TYPES.filter((t) => {
      if (activeMajor && CITY_EVENTS[t].major) return false; // never two majors
      const last = this.lastEventTypeAtMs.get(t) ?? -Infinity;
      return now - last >= EVENT_TYPE_COOLDOWN_SECS * 1000;   // no quick repeats
    });
    if (!pool.length) { this.nextEventAtMs = now + 30_000; return false; }
    await this.createEvent(this.weightedPick(pool), {}, now);
    this.nextEventAtMs = now + this.randInt(EVENT_GAP_MIN_SECS, EVENT_GAP_MAX_SECS) * 1000;
    return true;
  }

  /** Per-tick event processing: transitions, scheduling, demand refresh. */
  async processEvents(now = Date.now()): Promise<void> {
    for (const e of this.cityEvents) {
      if (e.status === 'upcoming' && now >= e.startsAtMs) await this.transitionEvent(e, 'active');
    }
    for (const e of this.cityEvents) {
      if (e.status === 'active' && now >= e.endsAtMs) await this.transitionEvent(e, 'ended');
    }
    this.cityEvents = this.cityEvents.filter((e) => e.status !== 'ended');
    await this.maybeScheduleEvent(now);
    this.recomputeDemand();
    const sig = this.marketSignature();
    if (sig !== this.marketSig) {
      this.marketSig = sig;
      this.emit('city_market');
    }
  }

  /** DEV: advance all live events by `seconds` (fast-forward for testing). */
  async advanceEvents(seconds: number): Promise<void> {
    const ms = seconds * 1000;
    for (const e of this.cityEvents) {
      e.announcedAtMs -= ms; e.startsAtMs -= ms; e.endsAtMs -= ms;
    }
    await query(
      `UPDATE city_events SET announced_at = announced_at - ($1 || ' seconds')::interval,
         starts_at = starts_at - ($1 || ' seconds')::interval,
         ends_at = ends_at - ($1 || ' seconds')::interval
       WHERE status IN ('upcoming','active')`,
      [seconds]
    );
    this.nextEventAtMs -= ms;
    await this.processEvents();
  }

  /** DEV: end every live event immediately. */
  async clearEvents(): Promise<void> {
    for (const e of this.cityEvents) await this.transitionEvent(e, 'ended');
    this.cityEvents = this.cityEvents.filter((e) => e.status !== 'ended');
    this.recomputeDemand();
    this.marketSig = this.marketSignature();
    this.emit('city_market');
  }

  toCityEventPub(e: EventRec): CityEventPub {
    return {
      id: e.id, type: e.type, status: e.status, effects: e.effects,
      announcedAt: e.announcedAtMs, startsAt: e.startsAtMs, endsAt: e.endsAtMs, major: e.major,
    };
  }

  toCityMarket(): CityMarket {
    const demand: ProductDemand[] = DEMAND_PRODUCTS.map((p) => {
      const eff = this.cityDemand(p);
      return {
        product: p,
        effective: Math.round(eff * 1000) / 1000,
        delta: Math.round((eff - 1) * 1000) / 1000,
        category: demandCategory(eff),
        trend: this.demandTrend.get(p) ?? 'flat',
      };
    });
    const wholesale: WholesaleStatus[] = [];
    for (const [p, m] of this.wholesaleMods) {
      if (m > 1.001) wholesale.push({ product: p, modifier: Math.round(m * 1000) / 1000 });
    }
    return {
      demand,
      wholesale,
      active: this.cityEvents.filter((e) => e.status === 'active').map((e) => this.toCityEventPub(e)),
      upcoming: this.cityEvents.filter((e) => e.status === 'upcoming').map((e) => this.toCityEventPub(e)),
      serverTime: Date.now(),
    };
  }

  // ============================================================
  // V2.5 — Central Wholesale daily supply & market integrity
  // ============================================================

  /** Load (or seed) the finite wholesale supply rows. */
  private async loadWholesale(now: number): Promise<void> {
    const rows = await query('SELECT * FROM wholesale_supply');
    const byProduct = new Map<string, any>(rows.rows.map((r) => [r.product, r]));
    for (const product of WHOLESALE_PRODUCTS) {
      const daily = WHOLESALE_DAILY_STOCK[product]!;
      const base = NPC_WHOLESALE_PRICES[product]!;
      const existing = byProduct.get(product);
      if (existing) {
        this.wholesale.set(product, {
          product, dailyStock: existing.daily_stock, remaining: existing.remaining,
          basePrice: existing.base_price, resetAtMs: new Date(existing.reset_at).getTime(), dirty: false,
        });
      } else {
        const resetAt = new Date(now + WHOLESALE_DAY_SECONDS * 1000);
        await query(
          `INSERT INTO wholesale_supply (product, daily_stock, remaining, base_price, reset_at)
           VALUES ($1,$2,$2,$3,$4) ON CONFLICT (product) DO NOTHING`,
          [product, daily, base, resetAt]
        );
        this.wholesale.set(product, { product, dailyStock: daily, remaining: daily, basePrice: base, resetAtMs: resetAt.getTime(), dirty: false });
      }
    }
  }

  /** Per-tick: reset any wholesale product whose day has elapsed (idempotent). */
  async processWholesale(now = Date.now()): Promise<void> {
    let changed = false;
    for (const ws of this.wholesale.values()) {
      if (now >= ws.resetAtMs) {
        // A day boundary: evaluate integrity for the day just ended, then refill.
        await this.rolloverWholesaleDay(ws, now);
        changed = true;
      }
    }
    if (changed) this.emitWholesale();
  }

  private async rolloverWholesaleDay(ws: WholesaleRec, now: number): Promise<void> {
    // Advance resetAt by whole days until it's in the future (guards restart).
    let next = ws.resetAtMs;
    let days = 0;
    while (now >= next) { next += WHOLESALE_DAY_SECONDS * 1000; days++; }
    ws.remaining = ws.dailyStock;
    ws.resetAtMs = next;
    ws.dirty = true;
    await query('UPDATE wholesale_supply SET remaining=$1, reset_at=$2, updated_at=now() WHERE product=$3',
      [ws.remaining, new Date(ws.resetAtMs), ws.product]);
    // Evaluate every company's integrity once per elapsed day boundary.
    if (this.wholesaleDayAnchor !== ws.product) return; // only the anchor product drives daily evaluation
    for (let i = 0; i < days; i++) await this.evaluateAllIntegrity();
    this.dailyBuys.clear();
  }

  // Use the first wholesale product as the daily-evaluation anchor, so a day
  // boundary evaluates integrity exactly once (not once per product).
  private wholesaleDayAnchor: ProductId = WHOLESALE_PRODUCTS[0];

  private emitWholesale(): void { this.emit('wholesale'); }

  toWholesaleState(): WholesaleState {
    const products: WholesaleProduct[] = [];
    for (const product of WHOLESALE_PRODUCTS) {
      const ws = this.wholesale.get(product);
      if (!ws) continue;
      const mod = this.wholesaleModifier(product);
      products.push({
        product,
        remaining: Math.max(0, ws.remaining),
        dailyStock: ws.dailyStock,
        basePrice: Math.max(1, Math.round(ws.basePrice * mod)),
        category: stockCategory(ws.remaining, ws.dailyStock),
        resetAt: ws.resetAtMs,
        emergency: ws.remaining <= 0,
        importDependent: isImportDependent(product),
      });
    }
    return { products, serverTime: Date.now() };
  }

  // ---- Hidden market-integrity system ----

  private ensureIntegrity(companyId: number): IntegrityRec {
    let rec = this.integrity.get(companyId);
    if (!rec) {
      rec = {
        companyId, score: INTEGRITY_START, state: 'normal',
        suspicionToday: 0, flaggedDays: 0, violationUntilMs: null,
        crossedHighShare: new Set(), dirty: true,
      };
      this.integrity.set(companyId, rec);
      query(`INSERT INTO company_integrity (company_id) VALUES ($1) ON CONFLICT DO NOTHING`, [companyId]).catch(() => {});
    }
    return rec;
  }

  /** Accrue weak manipulation signals from a committed wholesale purchase. */
  private recordWholesaleBuy(playerId: number, product: ProductId, normalQty: number, emerQty: number, ws: WholesaleRec): void {
    const company = this.companies.get(playerId);
    if (!company) return;
    const rec = this.ensureIntegrity(company.id);
    let buys = this.dailyBuys.get(company.id);
    if (!buys) { buys = new Map(); this.dailyBuys.set(company.id, buys); }
    const cumulative = (buys.get(product) ?? 0) + normalQty + emerQty;
    buys.set(product, cumulative);
    // Signal 1: this company took a large share of a product's daily stock.
    if (cumulative >= ws.dailyStock * HIGH_SHARE_FRACTION && !rec.crossedHighShare.has(product)) {
      rec.crossedHighShare.add(product);
      this.addSuspicion(rec, SIGNAL_HIGH_SHARE);
    }
    // Signal 2: this buy dipped into the emergency reserve (depletion). Skipped
    // for import-dependent goods (e.g. Coffee Beans): with no player producer,
    // using Emergency Import when normal stock is out is forced, not
    // manipulation, so it must never accrue suspicion.
    if (emerQty > 0 && !isImportDependent(product)) this.addSuspicion(rec, SIGNAL_DEPLETION);
  }

  private addSuspicion(rec: IntegrityRec, amount: number): void {
    rec.suspicionToday += amount;
    rec.dirty = true;
  }

  /** Called once per wholesale day: adjust every company's integrity score. */
  private async evaluateAllIntegrity(): Promise<void> {
    for (const rec of this.integrity.values()) await this.evaluateIntegrity(rec);
  }

  private async evaluateIntegrity(rec: IntegrityRec): Promise<void> {
    const flaggedDay = rec.suspicionToday >= SUSPICION_DAY_THRESHOLD;
    if (flaggedDay) {
      rec.score = Math.max(0, rec.score - SCORE_DROP_PER_FLAG);
      rec.flaggedDays += 1;
    } else {
      rec.score = Math.min(INTEGRITY_START, rec.score + SCORE_RECOVER_PER_CLEAN_DAY);
      rec.flaggedDays = Math.max(0, rec.flaggedDays - 1);
    }
    const prevState = rec.state;
    rec.state = this.integrityState(rec);
    // Only a gradual escalation to CONFIRMED applies consequences, once.
    if (rec.state === 'confirmed' && prevState !== 'confirmed') {
      await this.applyConfirmedConsequences(rec);
    }
    rec.suspicionToday = 0;
    rec.crossedHighShare.clear();
    rec.dirty = true;
    await this.persistIntegrity(rec);
  }

  private integrityState(rec: IntegrityRec): IntegrityState {
    if (rec.flaggedDays >= 3 && rec.score <= 40) return 'confirmed';
    if (rec.flaggedDays >= 2 && rec.score <= 60) return 'investigating';
    if (rec.flaggedDays >= 1 && rec.score <= 80) return 'watchlist';
    return 'normal';
  }

  private async applyConfirmedConsequences(rec: IntegrityRec): Promise<void> {
    const company = this.companyById(rec.companyId);
    if (!company) return;
    const owner = this.players.get(company.ownerId);
    // Reputation penalty across the company's businesses (recoverable).
    for (const b of this.bizesByOwner(company.ownerId)) {
      b.reputation = Math.max(REP_MIN, b.reputation - REP_VIOLATION_PENALTY);
      b.dirty = true;
      this.emit('biz_pub', b);
    }
    rec.violationUntilMs = Date.now() + VIOLATION_WARNING_SECONDS * 1000;
    // Audit trail (amount 0 — this is a trust event, not a cash movement).
    if (owner) {
      this.ledgerQueue.push({
        playerId: owner.id, businessId: null, type: 'INTEGRITY_VIOLATION', amount: 0,
        refType: 'company', refId: company.id, before: owner.cash, after: owner.cash,
      });
    }
    console.log(`[integrity] CONFIRMED manipulation company=${rec.companyId} score=${rec.score} — reputation penalty applied`);
  }

  private async persistIntegrity(rec: IntegrityRec): Promise<void> {
    await query(
      `INSERT INTO company_integrity (company_id, score, state, suspicion_today, flagged_days, violation_until, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (company_id) DO UPDATE SET score=$2, state=$3, suspicion_today=$4, flagged_days=$5, violation_until=$6, updated_at=now()`,
      [rec.companyId, rec.score, rec.state, rec.suspicionToday, rec.flaggedDays,
       rec.violationUntilMs ? new Date(rec.violationUntilMs) : null]
    );
    rec.dirty = false;
  }

  /** Public trust warning for a company (vague; never reveals internals). */
  private companyWarning(companyId: number): string | null {
    const rec = this.integrity.get(companyId);
    if (rec && rec.violationUntilMs && rec.violationUntilMs > Date.now()) return 'market_violation';
    return null;
  }

  /** Signal: an extreme resale listing (weak, capped once per day per company). */
  private recordResaleSignal(playerId: number, product: ProductId, price: number): void {
    const company = this.companies.get(playerId);
    if (!company) return;
    const base = PRODUCTS[product].basePrice;
    if (price > base * EXTREME_RESALE_MULT) {
      const rec = this.ensureIntegrity(company.id);
      this.addSuspicion(rec, SIGNAL_EXTREME_RESALE);
    }
  }

  /** DEV/test: force a wholesale day rollover now (refills + integrity eval). */
  async devRolloverWholesale(now = Date.now()): Promise<void> {
    for (const ws of this.wholesale.values()) { ws.resetAtMs = now - 1; }
    await this.processWholesale(now);
  }

  /** Test helper: read a company's hidden integrity (never sent to clients). */
  integrityOf(companyId: number): IntegrityRec | undefined {
    return this.integrity.get(companyId);
  }

  /** Core economy simulation for one business over dt seconds. */
  simulate(biz: BizRec, dt: number, silent: boolean): void {
    const owner = this.players.get(biz.ownerId);
    if (!owner) return;
    switch (biz.type) {
      case 'farm': {
        const lv = FARM_LEVELS[biz.level];
        const product: ProductId = biz.production === 'wheat' ? 'wheat' : 'milk';
        const rec = inv(biz, product);
        biz.prodAccum += lv.milkPerSec * dt;
        const want = Math.floor(biz.prodAccum);
        const space = Math.max(0, lv.milkCapacity - rec.qty - rec.reserved);
        const add = Math.min(want, space);
        if (add > 0) {
          rec.qty += add;
          biz.milkProduced += add; // total units produced (milk or wheat)
          biz.prodAccum -= add;
          this.addXp(owner, add * XP.perMilkProduced, silent);
          biz.dirty = true;
        }
        // Full storage must not bank production time.
        if (biz.prodAccum > 1) biz.prodAccum = 1;
        biz.status = space - add <= 0 ? 'storage_full' : 'producing';
        break;
      }
      case 'coffee_shop': {
        const lv = SHOP_LEVELS[biz.level];
        const milk = inv(biz, 'milk');
        const beans = inv(biz, 'beans');
        const coffee = inv(biz, 'coffee');
        // Brew coffee from ingredients.
        biz.brewAccum += lv.brewPerSec * dt;
        const brewWant = Math.floor(biz.brewAccum);
        const brewed = Math.max(
          0,
          Math.min(brewWant, milk.qty, beans.qty, lv.coffeeCapacity - coffee.qty)
        );
        if (brewed > 0) {
          milk.qty -= brewed;
          beans.qty -= brewed;
          coffee.qty += brewed;
          biz.brewAccum -= brewed;
          biz.dirty = true;
        }
        if (biz.brewAccum > 1) biz.brewAccum = 1;
        biz.custAccum +=
          lv.customersPerSec *
          priceDemandMultiplier(biz.price, RETAIL_BASE.coffee) *
          repDemandMultiplier(biz.reputation) *
          this.cityDemand('coffee') * dt;
        const arrivals = Math.floor(biz.custAccum);
        biz.custAccum -= arrivals;
        this.applyRetail(biz, owner, 'coffee', biz.price, arrivals, silent);
        const canServe = coffee.qty > 0 || (milk.qty > 0 && beans.qty > 0);
        biz.status = canServe ? 'open' : 'out_of_stock';
        break;
      }
      case 'bakery': {
        const lv = BAKERY_LEVELS[biz.level];
        const wheat = inv(biz, 'wheat');
        const bread = inv(biz, 'bread');
        // Bake bread from wheat (1:1). Stops when wheat is empty.
        biz.brewAccum += lv.brewPerSec * dt;
        const bakeWant = Math.floor(biz.brewAccum);
        const baked = Math.max(0, Math.min(bakeWant, wheat.qty, lv.coffeeCapacity - bread.qty));
        if (baked > 0) {
          wheat.qty -= baked;
          bread.qty += baked;
          biz.brewAccum -= baked;
          biz.dirty = true;
        }
        if (biz.brewAccum > 1) biz.brewAccum = 1;
        biz.custAccum +=
          lv.customersPerSec *
          priceDemandMultiplier(biz.price, RETAIL_BASE.bread) *
          repDemandMultiplier(biz.reputation) *
          this.cityDemand('bread') * dt;
        const arrivals = Math.floor(biz.custAccum);
        biz.custAccum -= arrivals;
        this.applyRetail(biz, owner, 'bread', biz.price, arrivals, silent);
        biz.status = bread.qty > 0 || wheat.qty > 0 ? 'open' : 'out_of_stock';
        break;
      }
      case 'mini_market': {
        const lv = MARKET_LEVELS[biz.level];
        const rep = repDemandMultiplier(biz.reputation);
        // Two independent customer streams: bread (custAccum) and milk
        // (prodAccum, unused by retail businesses otherwise).
        biz.custAccum += lv.customersPerSec * priceDemandMultiplier(biz.price, RETAIL_BASE.bread) * rep * this.cityDemand('bread') * dt;
        const breadArrivals = Math.floor(biz.custAccum);
        biz.custAccum -= breadArrivals;
        this.applyRetail(biz, owner, 'bread', biz.price, breadArrivals, silent);
        biz.prodAccum += lv.customersPerSec * priceDemandMultiplier(biz.price2, RETAIL_BASE.milk) * rep * this.cityDemand('milk') * dt;
        const milkArrivals = Math.floor(biz.prodAccum);
        biz.prodAccum -= milkArrivals;
        this.applyRetail(biz, owner, 'milk', biz.price2, milkArrivals, silent);
        biz.status =
          inv(biz, 'bread').qty > 0 || inv(biz, 'milk').qty > 0 ? 'open' : 'out_of_stock';
        break;
      }
    }
  }

  /** Sell up to `arrivals` units of `product` to NPC customers. */
  private applyRetail(
    biz: BizRec,
    owner: PlayerRec,
    product: ProductId,
    price: number,
    arrivals: number,
    silent: boolean
  ): void {
    if (arrivals <= 0) return;
    const rec = inv(biz, product);
    const sold = Math.min(arrivals, rec.qty);
    const lost = arrivals - sold;
    rec.qty -= sold;
    const gross = sold * price;
    if (sold > 0) {
      this.ledgerQueue.push({
        playerId: owner.id, businessId: biz.id, type: 'CUSTOMER_SALE',
        amount: gross, refType: 'business', refId: biz.id,
        before: owner.cash, after: owner.cash + gross,
      });
      owner.cash += gross;
      owner.dirty = true;
      biz.revenue += gross;
      biz.coffeeSold += sold; // total units sold at retail
      // V2.2: final-consumer sale -> market-share activity (units to NPCs).
      this.activityQueue.push({
        companyId: biz.companyId, businessId: biz.id,
        kind: 'final_sale', product, units: sold, amount: gross,
      });
      this.addXp(owner, sold * XP.perSale, silent);
      const fair = Math.round((RETAIL_BASE[product] ?? PRODUCTS[product].basePrice) * 1.2);
      biz.reputation += sold * (price <= fair ? REP_SALE_FAIR_PRICE : REP_SALE_GOUGING);
    }
    if (lost > 0) biz.reputation += lost * REP_LOST_CUSTOMER;
    biz.reputation = Math.min(REP_MAX, Math.max(REP_MIN, biz.reputation));
    biz.customers += arrivals;
    biz.dirty = true;
    if (!silent) {
      for (let i = 0; i < Math.min(sold, 3); i++) {
        this.emit('sale', { bizId: biz.id, lotId: biz.lotId, amount: price });
      }
      if (lost > 0) this.emit('lost_customer', { bizId: biz.id, lotId: biz.lotId });
    }
  }

  private addXp(player: PlayerRec, amount: number, silent = false): void {
    if (amount <= 0) return;
    player.xp += Math.round(amount);
    const newLevel = levelForXp(player.xp);
    if (newLevel > player.level) {
      player.level = newLevel;
      if (!silent) this.emit('level_up', { playerId: player.id, level: newLevel });
    }
    player.dirty = true;
  }

  // ---------------- player lifecycle ----------------

  async ensurePlayer(playerId: number): Promise<PlayerRec> {
    let p = this.players.get(playerId);
    if (!p) {
      const res = await query('SELECT * FROM players WHERE id=$1', [playerId]);
      if (!res.rowCount) throw new GameError('err.unknown_player');
      const r = res.rows[0];
      p = {
        id: r.id,
        name: r.username,
        cash: r.cash,
        xp: r.xp,
        level: r.level,
        lastSeenMs: new Date(r.last_seen).getTime(),
        connections: 0,
        isAdmin: r.is_admin ?? false,
        awaySnapshot: r.away_snapshot ?? null,
        dirty: false,
      };
      this.players.set(p.id, p);
    }
    return p;
  }

  connect(playerId: number): AwayReport | null {
    const p = this.player(playerId);
    p.connections++;
    const now = Date.now();
    let report: AwayReport | null = null;
    const totals = this.bizTotals(playerId);
    if (p.awaySnapshot && this.bizesByOwner(playerId).length > 0 && p.connections === 1) {
      const seconds = Math.floor((now - p.awaySnapshot.ts) / 1000);
      if (seconds > 60) {
        report = {
          seconds,
          revenue: totals.revenue - p.awaySnapshot.revenue,
          expenses: totals.expenses - p.awaySnapshot.expenses,
          profit:
            totals.revenue - p.awaySnapshot.revenue - (totals.expenses - p.awaySnapshot.expenses),
          milkProduced: totals.milkProduced - p.awaySnapshot.milkProduced,
          coffeeSold: totals.coffeeSold - p.awaySnapshot.coffeeSold,
        };
      }
    }
    p.awaySnapshot = null;
    p.lastSeenMs = now;
    p.dirty = true;
    this.emit('presence');
    return report;
  }

  disconnect(playerId: number): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connections = Math.max(0, p.connections - 1);
    if (p.connections === 0) {
      const totals = this.bizTotals(playerId);
      p.awaySnapshot = {
        ts: Date.now(),
        revenue: totals.revenue,
        expenses: totals.expenses,
        milkProduced: totals.milkProduced,
        coffeeSold: totals.coffeeSold,
      };
      p.lastSeenMs = Date.now();
      p.dirty = true;
    }
    this.emit('presence');
  }

  // ---------------- actions ----------------

  /** Create (or return) the player's single company. */
  private async ensureCompany(playerId: number): Promise<CompanyRec> {
    let company = this.companies.get(playerId);
    if (company) return company;
    const p = this.player(playerId);
    const res = await query(
      `INSERT INTO companies (player_id, name) VALUES ($1,$2)
       ON CONFLICT (player_id) DO UPDATE SET name = companies.name
       RETURNING id, name, level, xp, created_at`,
      [playerId, defaultCompanyName(p.name)]
    );
    const r = res.rows[0];
    company = {
      id: r.id,
      ownerId: playerId,
      name: r.name,
      level: r.level,
      xp: r.xp,
      revenueAccum: 0,
      createdAtMs: new Date(r.created_at).getTime(),
      dirty: false,
    };
    this.companies.set(playerId, company);
    return company;
  }

  /** Persist a new business row + empty inventories inside `c`. */
  private async insertBusinessRow(
    c: import('pg').PoolClient,
    playerId: number,
    companyId: number,
    type: BusinessType,
    lotId: string
  ): Promise<number> {
    const defaultPrice = type === 'coffee_shop' ? DEFAULT_COFFEE_PRICE : DEFAULT_BREAD_PRICE;
    const ins = await c.query(
      `INSERT INTO businesses (player_id, company_id, type, lot_id, price, reputation, price2, production)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'milk') RETURNING id`,
      [playerId, companyId, type, lotId, defaultPrice, REP_START, DEFAULT_RETAIL_MILK_PRICE]
    );
    const bizId = ins.rows[0].id;
    for (const product of STARTING_PRODUCTS[type]) {
      await c.query('INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,0,0)', [bizId, product]);
    }
    return bizId;
  }

  private buildBizRec(id: number, playerId: number, companyId: number, type: BusinessType, lotId: string): BizRec {
    const biz: BizRec = {
      id,
      ownerId: playerId,
      companyId,
      type,
      name: null,
      lotId,
      createdAtMs: Date.now(),
      level: 1,
      price: type === 'coffee_shop' ? DEFAULT_COFFEE_PRICE : DEFAULT_BREAD_PRICE,
      price2: DEFAULT_RETAIL_MILK_PRICE,
      production: 'milk',
      reputation: REP_START,
      revenue: 0,
      expenses: 0,
      milkProduced: 0,
      coffeeSold: 0,
      customers: 0,
      prodAccum: 0,
      brewAccum: 0,
      custAccum: 0,
      status: type === 'farm' ? 'producing' : 'out_of_stock',
      inv: new Map(),
      tradeCount: 0,
      dirty: false,
    };
    for (const product of STARTING_PRODUCTS[type]) biz.inv.set(product, { qty: 0, reserved: 0 });
    return biz;
  }

  async chooseBusiness(playerId: number, type: BusinessType): Promise<BizRec> {
    this.player(playerId);
    if (this.bizByOwner(playerId)) throw new GameError('err.already_own_business');
    if (!STARTING_PRODUCTS[type]) throw new GameError('err.unknown_business_type');
    const taken = new Set([...this.businesses.values()].map((b) => b.lotId));
    // Prefer the earliest-unlocked district so new players start in the
    // established centre; spill into later districts only once it is full.
    const order = new Map(DISTRICTS.map((d) => [d.id, d.unlockOrder]));
    const lot = lotsOfKind(type)
      .filter((l) => !taken.has(l.id))
      .sort((a, b) => (order.get(a.district) ?? 99) - (order.get(b.district) ?? 99))[0];
    // Distinguish "this type is taken everywhere" from "the whole city is
    // built out", so the UI can explain that expansion land is coming.
    if (!lot) throw new GameError(this.cityIsFull() ? 'err.city_full' : 'err.no_free_lots');

    const company = await this.ensureCompany(playerId);
    const bizId = await tx((c) => this.insertBusinessRow(c, playerId, company.id, type, lot.id));
    const biz = this.buildBizRec(bizId, playerId, company.id, type, lot.id);
    this.businesses.set(biz.id, biz);
    this.emit('biz_created', biz);
    this.emit('company', company);
    return biz;
  }

  /**
   * Open an ADDITIONAL business on a vacant lot. Atomic and idempotent under
   * double-click: a per-player lock plus a lot-taken re-check guarantee cash is
   * charged once, one business is created, one lot occupied, capacity updated
   * once, and a single BUSINESS_OPENING ledger entry.
   */
  async openBusiness(playerId: number, lotId: string, type: BusinessType): Promise<BizRec> {
    if (this.openLocks.has(playerId)) throw new GameError('err.busy_try_again');
    const p = this.player(playerId);
    if (!STARTING_PRODUCTS[type]) throw new GameError('err.unknown_business_type');
    const lot = lotById(lotId);
    if (!lot || (lot.kind !== 'farm' && lot.kind !== 'coffee_shop' && lot.kind !== 'bakery' && lot.kind !== 'mini_market')) {
      throw new GameError('err.bad_lot');
    }
    if (lot.kind !== type) throw new GameError('err.lot_type_mismatch');
    if ([...this.businesses.values()].some((b) => b.lotId === lotId)) throw new GameError('err.lot_taken');

    const company = await this.ensureCompany(playerId);
    // Capacity check.
    const cap = companyCapacity(company.level);
    const used = this.capacityUsed(playerId);
    const need = BUSINESS_CAPACITY[type];
    if (used + need > cap) throw new GameError('err.not_enough_capacity', { need, free: cap - used });
    // Cost check (escalating with how many businesses already owned).
    const count = this.bizesByOwner(playerId).length;
    const cost = businessOpenCost(count);
    if (p.cash < cost) throw new GameError('err.requires_cash', { cost });

    this.openLocks.add(playerId);
    p.cash -= cost;
    p.dirty = true;
    try {
      const bizId = await tx(async (c) => {
        // Re-check lot inside the transaction to defeat concurrent opens.
        const taken = await c.query('SELECT 1 FROM businesses WHERE lot_id=$1', [lotId]);
        if (taken.rowCount) throw new GameError('err.lot_taken');
        const id = await this.insertBusinessRow(c, playerId, company.id, type, lotId);
        await c.query('UPDATE players SET cash=$1 WHERE id=$2', [p.cash, p.id]);
        await c.query(LEDGER_SQL, ledgerParams({
          playerId, businessId: id, type: 'BUSINESS_OPENING', amount: -cost,
          refType: 'business', refId: id, before: p.cash + cost, after: p.cash,
        }));
        return id;
      });
      const biz = this.buildBizRec(bizId, playerId, company.id, type, lotId);
      this.businesses.set(biz.id, biz);
      console.log(`[econ] BUSINESS_OPENING player=${playerId} biz=${bizId} type=${type} lot=${lotId} cost=$${cost}`);
      this.emit('biz_created', biz);
      this.emit('company', company);
      return biz;
    } catch (err) {
      p.cash += cost; // revert on failure
      throw err;
    } finally {
      this.openLocks.delete(playerId);
    }
  }

  async renameCompany(playerId: number, name: string): Promise<CompanyRec> {
    const company = await this.ensureCompany(playerId);
    name = (name ?? '').replace(/\s+/g, ' ').trim().replace(/[<>]/g, '');
    if (name.length < COMPANY_NAME_MIN || name.length > COMPANY_NAME_MAX) {
      throw new GameError('err.company_name_len', { min: COMPANY_NAME_MIN, max: COMPANY_NAME_MAX });
    }
    company.name = name;
    company.dirty = true;
    await query('UPDATE companies SET name=$1 WHERE id=$2', [name, company.id]);
    this.emit('company', company);
    // Company name shows on every owned business's public card.
    for (const b of this.bizesByOwner(playerId)) this.emit('biz_pub', b);
    return company;
  }

  /**
   * Give one of the player's businesses a custom display name. An empty name
   * clears it, restoring the default "<owner>'s <Type>" label.
   */
  async renameBusiness(playerId: number, name: string, bizId?: number): Promise<BizRec> {
    const biz = this.requireOwnedBiz(playerId, bizId);
    const clean = (name ?? '').replace(/\s+/g, ' ').trim().replace(/[<>]/g, '');
    if (clean.length === 0) {
      biz.name = null;
    } else if (clean.length < BUSINESS_NAME_MIN || clean.length > BUSINESS_NAME_MAX) {
      throw new GameError('err.business_name_len', { min: BUSINESS_NAME_MIN, max: BUSINESS_NAME_MAX });
    } else {
      biz.name = clean;
    }
    biz.dirty = true;
    await query('UPDATE businesses SET name=$1 WHERE id=$2', [biz.name, biz.id]);
    this.emit('biz_pub', biz);   // public card shows the new name
    return biz;
  }

  async buyNpc(playerId: number, product: ProductId, qty: number, bizId?: number): Promise<void> {
    const p = this.player(playerId);
    const biz = this.requireOwnedBiz(playerId, bizId);
    qty = Math.floor(qty);
    if (!Number.isFinite(qty) || qty < 1 || qty > MARKET_MAX_QTY) throw new GameError('err.invalid_qty');
    const baseUnit = NPC_WHOLESALE_PRICES[product];
    if (!baseUnit) throw new GameError('err.wholesale_no_product');
    const mod = this.wholesaleModifier(product); // V2.3 event price modifier
    const cap = capacityFor(biz, product);
    if (cap <= 0) throw new GameError('err.cannot_store_product', { bizType: biz.type, product });
    const rec = inv(biz, product);
    const incoming = this.incomingFor(biz.id, product);
    if (rec.qty + rec.reserved + incoming + qty > cap) {
      throw new GameError('err.not_enough_storage', { cap });
    }

    // V2.5: the Central Wholesale is a finite daily supplier. Buy from daily
    // stock at the base price; past depletion an EMERGENCY reserve is available
    // — expensive and capped per purchase, so new players are never blocked but
    // hoarding is discouraged.
    const ws = this.wholesale.get(product);
    let normalQty = qty;
    let emerQty = 0;
    let cost: number;
    if (ws) {
      normalQty = Math.min(qty, Math.max(0, ws.remaining));
      emerQty = qty - normalQty;
      if (emerQty > EMERGENCY_MAX_PER_BUY) {
        throw new GameError('err.wholesale_limited', { left: Math.max(0, ws.remaining), cap: EMERGENCY_MAX_PER_BUY });
      }
      const normalUnit = Math.max(1, Math.round(ws.basePrice * mod));
      const emerUnit = Math.max(1, Math.round(ws.basePrice * EMERGENCY_PRICE_MULT * mod));
      cost = normalQty * normalUnit + emerQty * emerUnit;
    } else {
      cost = Math.max(1, Math.round(baseUnit * mod)) * qty;
    }
    if (p.cash < cost) throw new GameError('err.not_enough_cash', { cost });

    // Mutate memory synchronously, then persist.
    p.cash -= cost;
    p.dirty = true;
    biz.expenses += cost;
    biz.dirty = true;
    if (ws && normalQty > 0) { ws.remaining -= normalQty; ws.dirty = true; }
    this.addXp(p, XP.perNpcPurchase);

    try {
      const delivery = await this.createDelivery(product, qty, WHOLESALE_LOT_ID, biz);
      await tx(async (c) => {
        await c.query('UPDATE players SET cash=$1, xp=$2, level=$3 WHERE id=$4', [
          p.cash,
          p.xp,
          p.level,
          p.id,
        ]);
        await c.query('UPDATE businesses SET expenses=$1 WHERE id=$2', [biz.expenses, biz.id]);
        if (ws) await c.query('UPDATE wholesale_supply SET remaining=$1, updated_at=now() WHERE product=$2', [ws.remaining, product]);
        await c.query(LEDGER_SQL, ledgerParams({
          playerId, businessId: biz.id, type: emerQty > 0 ? 'WHOLESALE_EMERGENCY' : 'NPC_PURCHASE', amount: -cost,
          refType: 'delivery', refId: delivery.id, before: p.cash + cost, after: p.cash,
        }));
      });
      console.log(`[econ] NPC_PURCHASE player=${playerId} ${qty}x${product} (${normalQty} stock + ${emerQty} emergency) cost=$${cost} delivery=${delivery.id}`);
      // V2.5: feed the hidden market-integrity system (committed purchases only).
      if (ws) this.recordWholesaleBuy(playerId, product, normalQty, emerQty, ws);
      this.emit('delivery', delivery);
      this.emit('purchase', { playerId, product, qty, cost });
      if (ws) this.emitWholesale();
    } catch (err) {
      if (ws && normalQty > 0) ws.remaining += normalQty; // revert stock on failure
      // Roll back the in-memory mutation on persistence failure.
      p.cash += cost;
      biz.expenses -= cost;
      throw err;
    }
  }

  private incomingFor(bizId: number, product: ProductId): number {
    let total = 0;
    for (const d of this.deliveries.values()) {
      if (d.toBusinessId === bizId && d.product === product &&
          (d.status === 'in_transit' || d.status === 'waiting')) {
        total += d.qty;
      }
    }
    return total;
  }

  private async createDelivery(
    product: ProductId,
    qty: number,
    fromLotId: string,
    toBiz: BizRec
  ): Promise<DeliveryRec> {
    const fromLot = lotById(fromLotId);
    const toLot = lotById(toBiz.lotId);
    if (!fromLot || !toLot) throw new GameError('err.bad_delivery_route');
    const path = roadPath({ x: fromLot.x, z: fromLot.z }, { x: toLot.x, z: toLot.z });
    const seconds = Math.max(MIN_DELIVERY_SECONDS, pathLength(path) / VAN_SPEED);
    const now = Date.now();
    const arrive = now + seconds * 1000;
    const res = await query(
      `INSERT INTO deliveries (product, qty, from_lot, to_lot, to_business, depart_at, arrive_at)
       VALUES ($1,$2,$3,$4,$5,to_timestamp($6/1000.0),to_timestamp($7/1000.0)) RETURNING id`,
      [product, qty, fromLotId, toBiz.lotId, toBiz.id, now, arrive]
    );
    const d: DeliveryRec = {
      id: res.rows[0].id,
      product,
      qty,
      fromLot: fromLotId,
      toLot: toBiz.lotId,
      toBusinessId: toBiz.id,
      status: 'in_transit',
      departAtMs: now,
      arriveAtMs: arrive,
    };
    this.deliveries.set(d.id, d);
    return d;
  }

  /**
   * Try to unload an arrived (or waiting) delivery into its destination while
   * preserving the storage invariant: physical stock never exceeds capacity.
   *
   * - Fits fully -> unload all goods, mark delivered exactly once.
   * - Does not fit (incl. legacy over-capacity) -> enter WAITING_FOR_STORAGE.
   *   Goods stay with the delivery (money was already settled at creation), so
   *   nothing is destroyed, duplicated, or overflowed. It is retried when space
   *   frees (consumption, sale, upgrade) via the tick and explicit retries.
   *
   * No partial unload in V2.6.2: the full quantity must fit or the delivery
   * keeps waiting. Runs synchronously in-memory then persists, so concurrent
   * deliveries into the same slot serialise — exactly one can take the space.
   */
  private async completeDelivery(d: DeliveryRec): Promise<void> {
    if (d.status === 'delivered') return;
    const biz = this.businesses.get(d.toBusinessId);
    if (!biz) {
      // Destination is gone (e.g. business reset). Money was already settled;
      // there is nowhere to deliver, so retire the delivery without overflow.
      d.status = 'delivered';
      await query("UPDATE deliveries SET status='delivered' WHERE id=$1", [d.id]).catch(() => {});
      this.deliveries.delete(d.id);
      return;
    }
    const rec = inv(biz, d.product);
    const cap = capacityFor(biz, d.product);
    // All-or-nothing: the full quantity must fit alongside current physical
    // stock (on-hand + reserved). Over-capacity slots report 0 free -> waits.
    if (rec.qty + rec.reserved + d.qty > cap) {
      if (d.status !== 'waiting') {
        d.status = 'waiting';
        await query("UPDATE deliveries SET status='waiting' WHERE id=$1 AND status='in_transit'", [d.id]).catch(() => {});
        console.log(`[econ] DELIVERY_WAIT id=${d.id} ${d.qty}x${d.product} biz=${biz.id} (free=${Math.max(0, cap - rec.qty - rec.reserved)})`);
        this.emit('delivery', d); // push updated (waiting) state to clients
      }
      return;
    }
    // Fits — unload the whole delivery.
    rec.qty += d.qty;
    biz.dirty = true;
    d.status = 'delivered';
    await tx(async (c) => {
      await c.query("UPDATE deliveries SET status='delivered' WHERE id=$1 AND status<>'delivered'", [d.id]);
      await c.query(
        `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
        [biz.id, d.product, rec.qty, rec.reserved]
      );
    });
    this.deliveries.delete(d.id);
    console.log(`[econ] DELIVERY_DONE id=${d.id} ${d.qty}x${d.product} -> biz=${d.toBusinessId}`);
    this.emit('delivery_done', d);
  }

  /**
   * Retry every waiting delivery bound for a business (e.g. after a capacity
   * upgrade or inventory drop). Cheap: iterates only the small deliveries map.
   */
  private async retryWaitingDeliveries(bizId: number): Promise<void> {
    for (const d of [...this.deliveries.values()]) {
      if (d.status === 'waiting' && d.toBusinessId === bizId) {
        await this.completeDelivery(d);
      }
    }
  }

  async createOrder(
    playerId: number,
    side: 'buy' | 'sell',
    product: ProductId,
    qty: number,
    price: number,
    bizId?: number
  ): Promise<OrderRec> {
    const p = this.player(playerId);
    const biz = this.requireOwnedBiz(playerId, bizId);
    qty = Math.floor(qty);
    price = Math.floor(price);
    if (!TRADABLE.includes(product)) throw new GameError('err.not_tradable');
    if (!Number.isFinite(qty) || qty < 1 || qty > MARKET_MAX_QTY) throw new GameError('err.invalid_qty');
    if (!Number.isFinite(price) || price < MARKET_MIN_PRICE || price > MARKET_MAX_PRICE) {
      throw new GameError('err.price_range', { min: MARKET_MIN_PRICE, max: MARKET_MAX_PRICE });
    }

    if (side === 'sell') {
      const rec = inv(biz, product);
      if (rec.qty < qty) throw new GameError('err.only_have', { qty: rec.qty, product });
      rec.qty -= qty;
      rec.reserved += qty; // physically still on the lot, escrowed for the market
    } else {
      const cost = qty * price;
      if (p.cash < cost) throw new GameError('err.not_enough_cash_escrow', { cost });
      if (capacityFor(biz, product) <= 0) throw new GameError('err.cannot_store_that');
      p.cash -= cost; // escrow
      p.dirty = true;
    }
    biz.dirty = true;

    try {
      const res = await tx(async (c) => {
        const ins = await c.query(
          `INSERT INTO market_orders (player_id, business_id, side, product, qty, remaining, price)
           VALUES ($1,$2,$3,$4,$5,$5,$6) RETURNING id, created_at`,
          [playerId, biz.id, side, product, qty, price]
        );
        await c.query('UPDATE players SET cash=$1 WHERE id=$2', [p.cash, p.id]);
        const rec = inv(biz, product);
        await c.query(
          `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
          [biz.id, product, rec.qty, rec.reserved]
        );
        if (side === 'buy') {
          const cost = qty * price;
          await c.query(LEDGER_SQL, ledgerParams({
            playerId, businessId: biz.id, type: 'MARKET_ESCROW', amount: -cost,
            refType: 'order', refId: ins.rows[0].id, before: p.cash + cost, after: p.cash,
          }));
        }
        return ins.rows[0];
      });
      const order: OrderRec = {
        id: res.id,
        playerId,
        businessId: biz.id,
        side,
        product,
        qty,
        remaining: qty,
        price,
        status: 'open',
        createdAtMs: new Date(res.created_at).getTime(),
      };
      this.orders.set(order.id, order);
      // V2.5: an extreme resale price is a weak manipulation signal (legitimate
      // speculation is never punished on its own — this only feeds the score).
      if (side === 'sell') this.recordResaleSignal(playerId, product, price);
      this.emit('order', order);
      return order;
    } catch (err) {
      // revert escrow
      if (side === 'sell') {
        const rec = inv(biz, product);
        rec.qty += qty;
        rec.reserved -= qty;
      } else {
        p.cash += qty * price;
      }
      throw err;
    }
  }

  async cancelOrder(playerId: number, orderId: number): Promise<void> {
    const p = this.player(playerId);
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'open') throw new GameError('err.order_not_open');
    if (order.playerId !== playerId) throw new GameError('err.not_your_order');
    // Return escrowed goods to the exact business that placed the order.
    const biz = this.businesses.get(order.businessId) ?? this.requireBiz(playerId);

    order.status = 'cancelled';
    if (order.side === 'sell') {
      const rec = inv(biz, order.product);
      rec.reserved -= order.remaining;
      rec.qty += order.remaining;
      biz.dirty = true;
    } else {
      p.cash += order.remaining * order.price;
      p.dirty = true;
    }
    const remaining = order.remaining;
    order.remaining = 0;
    this.orders.delete(orderId);

    await tx(async (c) => {
      await c.query("UPDATE market_orders SET status='cancelled', remaining=0 WHERE id=$1", [orderId]);
      await c.query('UPDATE players SET cash=$1 WHERE id=$2', [p.cash, p.id]);
      if (order.side === 'buy' && remaining > 0) {
        const refund = remaining * order.price;
        await c.query(LEDGER_SQL, ledgerParams({
          playerId, businessId: biz.id, type: 'MARKET_REFUND', amount: refund,
          refType: 'order', refId: orderId, before: p.cash - refund, after: p.cash,
        }));
      }
      const rec = inv(biz, order.product);
      await c.query(
        `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
         ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
        [biz.id, order.product, rec.qty, rec.reserved]
      );
    });
    this.emit('order_removed', { orderId, refund: remaining });
  }

  /**
   * Fulfill someone else's order. This is THE multiplayer trade.
   * Exactly-once: in-memory checks and mutations are synchronous, and a
   * per-order lock guards the async persistence window.
   */
  async fulfillOrder(playerId: number, orderId: number, qty: number, bizId?: number): Promise<TradeRow> {
    if (this.fulfillLocks.has(orderId)) throw new GameError('err.order_processing');
    const fulfiller = this.player(playerId);
    const fulfillerBiz = this.requireOwnedBiz(playerId, bizId);
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'open' || order.remaining <= 0) {
      throw new GameError('err.order_unavailable');
    }
    if (order.playerId === playerId) throw new GameError('err.own_order');
    const owner = this.player(order.playerId);
    // The order was placed by a specific business; goods move to/from that one.
    const ownerBiz = this.businesses.get(order.businessId) ?? this.bizByOwner(order.playerId);
    if (!ownerBiz) throw new GameError('err.counterparty_no_business');
    qty = Math.floor(qty);
    if (!Number.isFinite(qty) || qty < 1) throw new GameError('err.invalid_qty');
    qty = Math.min(qty, order.remaining);
    const amount = qty * order.price;

    let buyer: PlayerRec, seller: PlayerRec, sellerBiz: BizRec, buyerBiz: BizRec;
    if (order.side === 'buy') {
      // Order owner wants to BUY (cash already escrowed); fulfiller SELLS.
      buyer = owner;
      buyerBiz = ownerBiz;
      seller = fulfiller;
      sellerBiz = fulfillerBiz;
      const rec = inv(sellerBiz, order.product);
      if (rec.qty < qty) throw new GameError('err.only_have', { qty: rec.qty, product: order.product });
      rec.qty -= qty;
      seller.cash += amount; // buyer's escrow pays out
    } else {
      // Order owner SELLS (goods reserved); fulfiller BUYS.
      seller = owner;
      sellerBiz = ownerBiz;
      buyer = fulfiller;
      buyerBiz = fulfillerBiz;
      if (capacityFor(buyerBiz, order.product) <= 0) throw new GameError('err.cannot_store_that');
      // Pre-validate storage: the buyer is acting now, so reject up front rather
      // than escrow for an impossible immediate purchase. completeDelivery
      // revalidates atomically at unload, so a concurrent change can only make
      // the delivery wait, never overflow.
      const availBuy = Math.max(0, capacityFor(buyerBiz, order.product)
        - usedStorage(buyerBiz, order.product) - this.incomingFor(buyerBiz.id, order.product));
      if (qty > availBuy) throw new GameError('err.insufficient_storage', { required: qty, available: availBuy });
      if (buyer.cash < amount) throw new GameError('err.not_enough_cash', { cost: amount });
      const rec = inv(sellerBiz, order.product);
      if (rec.reserved < qty) throw new GameError('err.seller_stock_unavailable');
      buyer.cash -= amount;
      seller.cash += amount;
      rec.reserved -= qty;
    }
    order.remaining -= qty;
    if (order.remaining === 0) order.status = 'filled';
    buyer.dirty = seller.dirty = true;
    sellerBiz.dirty = buyerBiz.dirty = true;
    buyerBiz.expenses += amount;
    sellerBiz.revenue += amount;
    sellerBiz.tradeCount += 1;
    buyerBiz.tradeCount += 1;
    if (sellerBiz.type === 'farm') {
      sellerBiz.reputation = Math.min(REP_MAX, sellerBiz.reputation + REP_TRADE_FULFILLED);
    }
    this.addXp(buyer, XP.perTrade);
    this.addXp(seller, XP.perTrade);
    // Company progression from meaningful trade activity (both parties).
    const buyerCo = this.companies.get(buyer.id);
    const sellerCo = this.companies.get(seller.id);
    if (buyerCo) this.addCompanyXp(buyerCo, COMPANY_XP.perTrade);
    if (sellerCo) this.addCompanyXp(sellerCo, COMPANY_XP.perTrade);
    this.addCompanyRevenueXp(seller.id, amount);

    this.fulfillLocks.add(orderId);
    try {
      const delivery = await this.createDelivery(order.product, qty, sellerBiz.lotId, buyerBiz);
      const tradeId = await tx(async (c) => {
        const upd = await c.query(
          `UPDATE market_orders SET remaining=$1, status=$2 WHERE id=$3 AND status='open' RETURNING id`,
          [order.remaining, order.status, orderId]
        );
        if (!upd.rowCount && order.status === 'open') {
          throw new GameError('err.order_state_changed');
        }
        await c.query('UPDATE players SET cash=$1, xp=$2, level=$3 WHERE id=$4', [
          buyer.cash, buyer.xp, buyer.level, buyer.id,
        ]);
        await c.query('UPDATE players SET cash=$1, xp=$2, level=$3 WHERE id=$4', [
          seller.cash, seller.xp, seller.level, seller.id,
        ]);
        const sRec = inv(sellerBiz, order.product);
        await c.query(
          `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
          [sellerBiz.id, order.product, sRec.qty, sRec.reserved]
        );
        await c.query(
          `UPDATE businesses SET revenue=$1, reputation=$2 WHERE id=$3`,
          [sellerBiz.revenue, sellerBiz.reputation, sellerBiz.id]
        );
        await c.query(`UPDATE businesses SET expenses=$1 WHERE id=$2`, [buyerBiz.expenses, buyerBiz.id]);
        const ins = await c.query(
          `INSERT INTO trades (order_id, buyer_id, seller_id, product, qty, price)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
          [orderId, buyer.id, seller.id, order.product, qty, order.price]
        );
        const newTradeId = ins.rows[0].id;
        await c.query(LEDGER_SQL, ledgerParams({
          playerId: seller.id, businessId: sellerBiz.id, type: 'MARKET_SELL', amount,
          refType: 'trade', refId: newTradeId, before: seller.cash - amount, after: seller.cash,
        }));
        if (order.side === 'sell') {
          // buyer pays now (buy-order escrow was already recorded at creation)
          await c.query(LEDGER_SQL, ledgerParams({
            playerId: buyer.id, businessId: buyerBiz.id, type: 'MARKET_BUY', amount: -amount,
            refType: 'trade', refId: newTradeId, before: buyer.cash + amount, after: buyer.cash,
          }));
        }
        // V2.2: external supplier sale (marketplace is always player-to-player).
        await c.query(ACTIVITY_SQL, activityParams({
          companyId: sellerBiz.companyId, businessId: sellerBiz.id,
          kind: 'supplier_sale', product: order.product, units: qty, amount,
        }));
        return ins.rows[0];
      });
      if (order.remaining === 0) this.orders.delete(orderId);
      const trade: TradeRow = {
        id: tradeId.id,
        product: order.product,
        qty,
        price: order.price,
        buyerName: buyer.name,
        sellerName: seller.name,
        at: new Date(tradeId.created_at).getTime(),
      };
      console.log(
        `[econ] TRADE id=${trade.id} order=${orderId} ${qty}x${order.product} @$${order.price} ` +
          `seller=${seller.id} buyer=${buyer.id} delivery=${delivery.id}`
      );
      this.emit('delivery', delivery);
      this.emit('trade', trade);
      this.emit('order', order);
      return trade;
    } catch (err) {
      // Revert the in-memory mutation.
      order.remaining += qty;
      order.status = 'open';
      buyerBiz.expenses -= amount;
      sellerBiz.revenue -= amount;
      sellerBiz.tradeCount -= 1;
      buyerBiz.tradeCount -= 1;
      if (order.side === 'buy') {
        inv(sellerBiz, order.product).qty += qty;
        seller.cash -= amount;
      } else {
        buyer.cash += amount;
        seller.cash -= amount;
        inv(sellerBiz, order.product).reserved += qty;
      }
      throw err;
    } finally {
      this.fulfillLocks.delete(orderId);
    }
  }

  async upgrade(playerId: number, bizId?: number): Promise<void> {
    const p = this.player(playerId);
    const biz = this.requireOwnedBiz(playerId, bizId);
    if (biz.level >= MAX_LEVEL) throw new GameError('err.max_level');
    const cost = {
      farm: FARM_LEVELS[biz.level].upgradeCost,
      coffee_shop: SHOP_LEVELS[biz.level].upgradeCost,
      bakery: BAKERY_LEVELS[biz.level].upgradeCost,
      mini_market: MARKET_LEVELS[biz.level].upgradeCost,
    }[biz.type];
    if (cost == null) throw new GameError('err.max_level');
    if (p.cash < cost) throw new GameError('err.upgrade_cost', { cost });
    p.cash -= cost;
    p.dirty = true;
    biz.level += 1;
    biz.expenses += cost;
    biz.dirty = true;
    this.addXp(p, XP.perUpgrade);
    try {
      await tx(async (c) => {
        await c.query('UPDATE players SET cash=$1, xp=$2, level=$3 WHERE id=$4', [
          p.cash, p.xp, p.level, p.id,
        ]);
        await c.query('UPDATE businesses SET level=$1, expenses=$2 WHERE id=$3', [
          biz.level, biz.expenses, biz.id,
        ]);
        await c.query(LEDGER_SQL, ledgerParams({
          playerId, businessId: biz.id, type: 'BUSINESS_UPGRADE', amount: -cost,
          refType: 'business', refId: biz.id, before: p.cash + cost, after: p.cash,
        }));
      });
      console.log(`[econ] BUSINESS_UPGRADE player=${playerId} biz=${biz.id} level=${biz.level} cost=$${cost}`);
      const company = this.companies.get(playerId);
      if (company) this.addCompanyXp(company, COMPANY_XP.perUpgrade);
      this.emit('upgraded', { biz });
      // A bigger store may now fit deliveries that were WAITING_FOR_STORAGE.
      await this.retryWaitingDeliveries(biz.id);
    } catch (err) {
      p.cash += cost;
      biz.level -= 1;
      biz.expenses -= cost;
      throw err;
    }
  }

  // ---------------- supply contracts (Phase 3) ----------------

  private requireContract(id: number): ContractRec {
    const c = this.contracts.get(id);
    if (!c) throw new GameError('err.contract_not_found');
    return c;
  }

  /** A buyer proposes a recurring supply contract to a seller's business. */
  async proposeContract(
    buyerId: number,
    sellerBizId: number,
    product: ProductId,
    quantity: number,
    unitPrice: number,
    deliveries: number,
    buyerBizId?: number
  ): Promise<ContractRec> {
    const buyerBiz = this.requireOwnedBiz(buyerId, buyerBizId);
    const sellerBiz = this.businesses.get(sellerBizId);
    if (!sellerBiz) throw new GameError('err.business_gone');
    if (sellerBiz.ownerId === buyerId) throw new GameError('err.contract_self');
    quantity = Math.floor(quantity);
    unitPrice = Math.floor(unitPrice);
    deliveries = Math.floor(deliveries);
    if (!contractableProducts(sellerBiz.type, buyerBiz.type).includes(product)) {
      throw new GameError('err.contract_bad_supply');
    }
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > CONTRACT_MAX_QTY) {
      throw new GameError('err.contract_qty_range', { max: CONTRACT_MAX_QTY });
    }
    if (!Number.isFinite(unitPrice) || unitPrice < MARKET_MIN_PRICE || unitPrice > MARKET_MAX_PRICE) {
      throw new GameError('err.contract_price_range', { min: MARKET_MIN_PRICE, max: MARKET_MAX_PRICE });
    }
    if (!Number.isFinite(deliveries) || deliveries < CONTRACT_MIN_DELIVERIES || deliveries > CONTRACT_MAX_DELIVERIES) {
      throw new GameError('err.contract_deliveries_range', { min: CONTRACT_MIN_DELIVERIES, max: CONTRACT_MAX_DELIVERIES });
    }
    if (capacityFor(buyerBiz, product) <= 0) throw new GameError('err.cannot_store_that');

    const res = await query(
      `INSERT INTO contracts
         (buyer_player_id, seller_player_id, buyer_business_id, seller_business_id,
          product, quantity, unit_price, frequency_secs, total_deliveries, remaining_deliveries, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,'proposed') RETURNING id, created_at`,
      [buyerId, sellerBiz.ownerId, buyerBiz.id, sellerBiz.id, product, quantity, unitPrice, CONTRACT_FREQUENCY_SECS, deliveries]
    );
    const c: ContractRec = {
      id: res.rows[0].id,
      buyerId,
      sellerId: sellerBiz.ownerId,
      buyerBizId: buyerBiz.id,
      sellerBizId: sellerBiz.id,
      product,
      quantity,
      unitPrice,
      frequencySecs: CONTRACT_FREQUENCY_SECS,
      totalDeliveries: deliveries,
      remaining: deliveries,
      status: 'proposed',
      lastResult: null,
      nextExecutionAtMs: null,
      createdAtMs: new Date(res.rows[0].created_at).getTime(),
    };
    this.contracts.set(c.id, c);
    console.log(`[econ] CONTRACT_PROPOSED id=${c.id} ${quantity}x${product} @$${unitPrice} buyer=${buyerId} seller=${c.sellerId}`);
    this.emit('contract', c);
    return c;
  }

  async acceptContract(playerId: number, contractId: number): Promise<ContractRec> {
    const c = this.requireContract(contractId);
    if (c.sellerId !== playerId) throw new GameError('err.contract_only_supplier_accept');
    if (c.status !== 'proposed') throw new GameError('err.contract_not_pending');
    c.status = 'active';
    c.nextExecutionAtMs = Date.now(); // first delivery attempts almost immediately
    await query(
      "UPDATE contracts SET status='active', next_execution_at=to_timestamp($2/1000.0) WHERE id=$1 AND status='proposed'",
      [c.id, c.nextExecutionAtMs]
    );
    console.log(`[econ] CONTRACT_ACCEPTED id=${c.id}`);
    this.emit('contract', c);
    return c;
  }

  async rejectContract(playerId: number, contractId: number): Promise<ContractRec> {
    const c = this.requireContract(contractId);
    if (c.sellerId !== playerId) throw new GameError('err.contract_only_supplier_reject');
    if (c.status !== 'proposed') throw new GameError('err.contract_not_pending');
    c.status = 'rejected';
    await query("UPDATE contracts SET status='rejected' WHERE id=$1 AND status='proposed'", [c.id]);
    this.emit('contract', c);
    this.contracts.delete(c.id); // terminal: drop from live memory (history stays in DB)
    return c;
  }

  async cancelContract(playerId: number, contractId: number): Promise<ContractRec> {
    const c = this.requireContract(contractId);
    if (c.buyerId !== playerId && c.sellerId !== playerId) throw new GameError('err.contract_not_yours');
    if (c.status !== 'active' && c.status !== 'proposed') throw new GameError('err.contract_not_cancellable');
    c.status = 'cancelled';
    c.nextExecutionAtMs = null;
    await query("UPDATE contracts SET status='cancelled', next_execution_at=NULL WHERE id=$1", [c.id]);
    console.log(`[econ] CONTRACT_CANCELLED id=${c.id} by=${playerId}`);
    this.emit('contract', c);
    this.contracts.delete(c.id);
    return c;
  }

  /**
   * Execute one scheduled delivery of an active contract. Exactly-once:
   * an in-memory lock plus a DB guard on (status, remaining) prevent any
   * double payment / inventory removal / delivery / ledger entry.
   * On insufficient seller stock or buyer funds the execution is skipped
   * (recorded, rescheduled) without moving money or goods.
   */
  async executeContract(contractId: number): Promise<'delivered' | 'missed_stock' | 'missed_funds' | 'skipped'> {
    if (this.contractLocks.has(contractId)) return 'skipped';
    const c = this.contracts.get(contractId);
    if (!c || c.status !== 'active') return 'skipped';
    const seller = this.players.get(c.sellerId);
    const buyer = this.players.get(c.buyerId);
    const sellerBiz = this.businesses.get(c.sellerBizId);
    const buyerBiz = this.businesses.get(c.buyerBizId);
    if (!seller || !buyer || !sellerBiz || !buyerBiz) {
      // A party disappeared (e.g. business reset): cancel the contract.
      c.status = 'cancelled';
      c.nextExecutionAtMs = null;
      await query("UPDATE contracts SET status='cancelled', next_execution_at=NULL WHERE id=$1", [c.id]);
      this.emit('contract', c);
      this.contracts.delete(c.id);
      return 'skipped';
    }
    const amount = c.quantity * c.unitPrice;
    const sellerStock = inv(sellerBiz, c.product);
    const nextAt = Date.now() + c.frequencySecs * 1000;

    // --- Skip cases: never move money or goods. ---
    if (sellerStock.qty < c.quantity) {
      return this.recordContractMiss(c, 'missed_stock', nextAt);
    }
    if (buyer.cash < amount) {
      return this.recordContractMiss(c, 'missed_funds', nextAt);
    }

    // --- Success path (mirrors marketplace fulfillment discipline). ---
    this.contractLocks.add(contractId);
    const prevRemaining = c.remaining;
    const wasResult = c.lastResult;
    try {
      // Mutate memory synchronously.
      sellerStock.qty -= c.quantity;
      seller.cash += amount;
      buyer.cash -= amount;
      seller.dirty = buyer.dirty = true;
      sellerBiz.revenue += amount;
      buyerBiz.expenses += amount;
      sellerBiz.tradeCount += 1;
      buyerBiz.tradeCount += 1;
      sellerBiz.reputation = Math.min(REP_MAX, sellerBiz.reputation + REP_CONTRACT_FULFILLED);
      sellerBiz.dirty = buyerBiz.dirty = true;
      this.addXp(seller, XP.perTrade);
      this.addXp(buyer, XP.perTrade);
      c.remaining -= 1;
      c.status = c.remaining <= 0 ? 'completed' : 'active';
      c.nextExecutionAtMs = c.remaining <= 0 ? null : nextAt;
      c.lastResult = c.remaining <= 0 ? 'completed' : 'delivered';

      const delivery = await this.createDelivery(c.product, c.quantity, sellerBiz.lotId, buyerBiz);
      await tx(async (cl) => {
        const upd = await cl.query(
          `UPDATE contracts SET remaining_deliveries=$1, status=$2, last_result=$3,
             next_execution_at=$4 WHERE id=$5 AND status='active' AND remaining_deliveries=$6 RETURNING id`,
          [
            c.remaining,
            c.status,
            c.lastResult,
            c.nextExecutionAtMs ? new Date(c.nextExecutionAtMs) : null,
            c.id,
            prevRemaining,
          ]
        );
        if (!upd.rowCount) throw new GameError('err.contract_state_changed');
        await cl.query('UPDATE players SET cash=$1, xp=$2, level=$3 WHERE id=$4', [seller.cash, seller.xp, seller.level, seller.id]);
        await cl.query('UPDATE players SET cash=$1, xp=$2, level=$3 WHERE id=$4', [buyer.cash, buyer.xp, buyer.level, buyer.id]);
        await cl.query(
          `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
          [sellerBiz.id, c.product, sellerStock.qty, sellerStock.reserved]
        );
        await cl.query('UPDATE businesses SET revenue=$1, reputation=$2 WHERE id=$3', [sellerBiz.revenue, sellerBiz.reputation, sellerBiz.id]);
        await cl.query('UPDATE businesses SET expenses=$1 WHERE id=$2', [buyerBiz.expenses, buyerBiz.id]);
        await cl.query(LEDGER_SQL, ledgerParams({
          playerId: seller.id, businessId: sellerBiz.id, type: 'CONTRACT_SELL', amount,
          refType: 'contract', refId: c.id, before: seller.cash - amount, after: seller.cash,
        }));
        await cl.query(LEDGER_SQL, ledgerParams({
          playerId: buyer.id, businessId: buyerBiz.id, type: 'CONTRACT_BUY', amount: -amount,
          refType: 'contract', refId: c.id, before: buyer.cash + amount, after: buyer.cash,
        }));
        // V2.2: external supplier sale (contracts are between two companies).
        await cl.query(ACTIVITY_SQL, activityParams({
          companyId: sellerBiz.companyId, businessId: sellerBiz.id,
          kind: 'supplier_sale', product: c.product, units: c.quantity, amount,
        }));
      });

      console.log(`[econ] CONTRACT_EXEC id=${c.id} ${c.quantity}x${c.product} @$${c.unitPrice} remaining=${c.remaining} delivery=${delivery.id}`);
      // Company progression for both parties on each fulfilled delivery.
      const sellerCo = this.companies.get(c.sellerId);
      const buyerCo = this.companies.get(c.buyerId);
      if (sellerCo) this.addCompanyXp(sellerCo, COMPANY_XP.perContract);
      if (buyerCo) this.addCompanyXp(buyerCo, COMPANY_XP.perContract);
      this.addCompanyRevenueXp(c.sellerId, amount);
      this.emit('delivery', delivery);
      this.emit('contract', c);
      if (c.status === 'completed') this.contracts.delete(c.id);
      return 'delivered';
    } catch (err) {
      // Revert in-memory mutation on persistence failure.
      sellerStock.qty += c.quantity;
      seller.cash -= amount;
      buyer.cash += amount;
      sellerBiz.revenue -= amount;
      buyerBiz.expenses -= amount;
      sellerBiz.tradeCount -= 1;
      buyerBiz.tradeCount -= 1;
      c.remaining = prevRemaining;
      c.status = 'active';
      c.lastResult = wasResult;
      c.nextExecutionAtMs = nextAt;
      throw err;
    } finally {
      this.contractLocks.delete(contractId);
    }
  }

  private async recordContractMiss(
    c: ContractRec,
    reason: 'missed_stock' | 'missed_funds',
    nextAt: number
  ): Promise<'missed_stock' | 'missed_funds'> {
    c.lastResult = reason;
    c.nextExecutionAtMs = nextAt;
    await query(
      "UPDATE contracts SET last_result=$1, next_execution_at=to_timestamp($2/1000.0) WHERE id=$3 AND status='active'",
      [reason, nextAt, c.id]
    );
    console.log(`[econ] CONTRACT_MISS id=${c.id} ${reason}`);
    this.emit('contract', c);
    return reason;
  }

  toContractPub(c: ContractRec): ContractPub {
    const buyer = this.players.get(c.buyerId);
    const seller = this.players.get(c.sellerId);
    const buyerBiz = this.businesses.get(c.buyerBizId);
    const sellerBiz = this.businesses.get(c.sellerBizId);
    return {
      id: c.id,
      buyerId: c.buyerId,
      sellerId: c.sellerId,
      buyerName: buyer?.name ?? '???',
      sellerName: seller?.name ?? '???',
      buyerCompany: this.companies.get(c.buyerId)?.name ?? (buyer ? defaultCompanyName(buyer.name) : '???'),
      sellerCompany: this.companies.get(c.sellerId)?.name ?? (seller ? defaultCompanyName(seller.name) : '???'),
      buyerType: (buyerBiz?.type ?? 'farm') as any,
      sellerType: (sellerBiz?.type ?? 'farm') as any,
      product: c.product,
      quantity: c.quantity,
      unitPrice: c.unitPrice,
      deliveries: c.totalDeliveries,
      remaining: c.remaining,
      status: c.status,
      lastResult: c.lastResult,
      nextExecutionAt: c.nextExecutionAtMs,
      createdAt: c.createdAtMs,
    };
  }

  /** All contracts (any status, incl. history) involving a player. */
  async contractsForPlayer(playerId: number, limit = 40): Promise<ContractPub[]> {
    const res = await query(
      `SELECT c.*, bp.username AS buyer_name, sp.username AS seller_name,
              bb.type AS buyer_type, sb.type AS seller_type,
              bco.name AS buyer_company, sco.name AS seller_company
       FROM contracts c
       JOIN players bp ON bp.id = c.buyer_player_id
       JOIN players sp ON sp.id = c.seller_player_id
       JOIN businesses bb ON bb.id = c.buyer_business_id
       JOIN businesses sb ON sb.id = c.seller_business_id
       LEFT JOIN companies bco ON bco.player_id = c.buyer_player_id
       LEFT JOIN companies sco ON sco.player_id = c.seller_player_id
       WHERE c.buyer_player_id=$1 OR c.seller_player_id=$1
       ORDER BY c.created_at DESC LIMIT $2`,
      [playerId, limit]
    );
    return res.rows.map((r) => ({
      id: r.id,
      buyerId: r.buyer_player_id,
      sellerId: r.seller_player_id,
      buyerName: r.buyer_name,
      sellerName: r.seller_name,
      buyerCompany: r.buyer_company ?? `${r.buyer_name} Co.`,
      sellerCompany: r.seller_company ?? `${r.seller_name} Co.`,
      buyerType: r.buyer_type,
      sellerType: r.seller_type,
      product: r.product,
      quantity: r.quantity,
      unitPrice: r.unit_price,
      deliveries: r.total_deliveries,
      remaining: r.remaining_deliveries,
      status: r.status,
      lastResult: r.last_result ?? null,
      nextExecutionAt: r.next_execution_at ? new Date(r.next_execution_at).getTime() : null,
      createdAt: new Date(r.created_at).getTime(),
    }));
  }

  setPrice(playerId: number, price: number, product?: ProductId, bizId?: number): void {
    const biz = this.requireOwnedBiz(playerId, bizId);
    if (biz.type === 'farm') throw new GameError('err.farms_use_market');
    price = Math.floor(price);
    if (!Number.isFinite(price) || price < MIN_COFFEE_PRICE || price > MAX_COFFEE_PRICE) {
      throw new GameError('err.retail_price_range', { min: MIN_COFFEE_PRICE, max: MAX_COFFEE_PRICE });
    }
    if (biz.type === 'mini_market' && product === 'milk') {
      biz.price2 = price;
    } else {
      biz.price = price;
    }
    biz.dirty = true;
    this.emit('upgraded', { biz }); // reuse: broadcast public/private refresh
  }

  setProduction(playerId: number, product: ProductId, bizId?: number): void {
    const biz = this.requireOwnedBiz(playerId, bizId);
    if (biz.type !== 'farm') throw new GameError('err.only_farms_production');
    if (product !== 'milk' && product !== 'wheat') throw new GameError('err.farm_product_choice');
    if (biz.production === product) return;
    biz.production = product;
    biz.prodAccum = 0;
    biz.dirty = true;
    this.emit('upgraded', { biz });
  }

  async resetBusiness(playerId: number, bizId?: number): Promise<void> {
    const biz = bizId != null ? this.businesses.get(bizId) : this.bizByOwner(playerId);
    if (!biz || biz.ownerId !== playerId) return;
    // Cancel this business's open orders first (refund escrow).
    for (const o of [...this.orders.values()]) {
      if (o.businessId === biz.id && o.status === 'open') {
        await this.cancelOrder(playerId, o.id);
      }
    }
    this.businesses.delete(biz.id);
    await query('DELETE FROM businesses WHERE id=$1', [biz.id]);
    this.emit('biz_removed', { bizId: biz.id, lotId: biz.lotId });
    this.emit('my_biz_removed', { ownerId: playerId, bizId: biz.id });
  }

  // ---------------- dev tools ----------------

  async devCommand(playerId: number, cmd: string, value?: number, bizId?: number): Promise<string> {
    const p = this.player(playerId);
    const v = Math.floor(value ?? 0);
    switch (cmd) {
      case 'add_money':
        p.cash += v > 0 ? v : 5000;
        p.dirty = true;
        return `+$${v > 0 ? v : 5000}`;
      case 'add_milk':
      case 'add_beans':
      case 'add_wheat':
      case 'add_bread': {
        const biz = this.requireOwnedBiz(playerId, bizId);
        const product = cmd.slice(4) as ProductId;
        // Respect the storage invariant even for dev/admin adds (V2.6.2): clamp
        // to free space so no mutation path can push stock over capacity.
        const want = v > 0 ? v : 50;
        const added = Math.min(want, freeSpaceFor(biz, product));
        inv(biz, product).qty += added;
        biz.dirty = true;
        return `+${added} ${PRODUCTS[product].name}${added < want ? ' (storage full)' : ''}`;
      }
      case 'company_xp': {
        const company = await this.ensureCompany(playerId);
        this.addCompanyXp(company, v > 0 ? v : 1000);
        this.emit('company', company);
        return `company xp +${v > 0 ? v : 1000} (lvl ${company.level})`;
      }
      case 'event_festival':
      case 'event_university':
      case 'event_heatwave':
      case 'event_supply':
      case 'event_market_day': {
        const map: Record<string, CityEventType> = {
          event_festival: 'city_festival', event_university: 'university_week',
          event_heatwave: 'heat_wave', event_supply: 'supply_disruption',
          event_market_day: 'local_market_day',
        };
        // A short announce window keeps dev/E2E fast while still exercising the
        // upcoming -> active transition (v overrides the announce seconds).
        const rec = await this.createEvent(map[cmd], { announceSecs: v > 0 ? v : 5 });
        await this.processEvents();
        return `event ${rec.type} #${rec.id} upcoming`;
      }
      case 'advance_events':
        await this.advanceEvents(v > 0 ? v : 30);
        return `advanced events by ${v > 0 ? v : 30}s`;
      case 'clear_events':
        await this.clearEvents();
        return 'events cleared';
      case 'reset_updates':
        await query(`DELETE FROM player_seen_updates WHERE player_id=$1`, [playerId]);
        return 'update history reset';
      case 'make_admin':
        this.player(playerId).isAdmin = true;
        await query(`UPDATE players SET is_admin=true WHERE id=$1`, [playerId]);
        return 'you are now admin';
      case 'reset_tutorial':
        await query(`DELETE FROM tutorial_progress WHERE player_id=$1`, [playerId]);
        await query(`DELETE FROM player_seen_updates WHERE player_id=$1`, [playerId]);
        return 'tutorial reset';
      case 'wholesale_reset':
        await this.devRolloverWholesale();
        return 'wholesale day rolled over';
      case 'speed':
        this.timeScale = Math.min(60, Math.max(1, v || 1));
        return `time scale x${this.timeScale}`;
      case 'reset_business':
        await this.resetBusiness(playerId, bizId);
        return 'business reset';
      default:
        throw new GameError('err.unknown_dev_cmd', { cmd });
    }
  }

  // ---------------- snapshots for the wire ----------------

  toPlayerPriv(p: PlayerRec): PlayerPriv {
    const biz = this.bizByOwner(p.id);
    return {
      id: p.id,
      name: p.name,
      cash: p.cash,
      xp: p.xp,
      level: p.level,
      reputation: biz?.reputation ?? REP_START,
      isAdmin: p.isAdmin,
    };
  }

  toPlayerPub(p: PlayerRec): PlayerPub {
    return { id: p.id, name: p.name, level: p.level, online: p.connections > 0 };
  }

  toBizPub(b: BizRec): BizPub {
    const owner = this.players.get(b.ownerId);
    const company = this.companies.get(b.ownerId);
    return {
      id: b.id,
      ownerId: b.ownerId,
      ownerName: owner?.name ?? '???',
      companyId: company?.id ?? b.companyId,
      companyName: company?.name ?? (owner ? defaultCompanyName(owner.name) : '???'),
      type: b.type,
      name: b.name,
      lotId: b.lotId,
      district: lotById(b.lotId)?.district ?? DEFAULT_DISTRICT,
      level: b.level,
      status: b.status,
      reputation: Math.round(b.reputation * 100) / 100,
      supplies: SELLER_SUPPLIES[b.type] ?? [],
      tradeCount: b.tradeCount,
    };
  }

  // ---------------- districts & city status (V2.6) ----------------

  /** Lot ids currently occupied by a business. */
  private occupiedLotIds(): Set<string> {
    return new Set([...this.businesses.values()].map((b) => b.lotId));
  }

  /**
   * Live occupancy per district, including free lots per business type so the
   * UI can tell a player *what* they can still build, not just how many.
   */
  districtOccupancy(): DistrictOccupancy[] {
    const taken = this.occupiedLotIds();
    return [...DISTRICTS]
      .sort((a, b) => a.unlockOrder - b.unlockOrder)
      .map((d) => {
        const lots = districtLots(d.id);
        const free = lots.filter((l) => !taken.has(l.id));
        const freeByType: Partial<Record<BusinessType, number>> = {};
        for (const l of free) {
          const t = l.kind as BusinessType;
          freeByType[t] = (freeByType[t] ?? 0) + 1;
        }
        return {
          id: d.id,
          nameKey: d.nameKey,
          unlockOrder: d.unlockOrder,
          total: lots.length,
          occupied: lots.length - free.length,
          available: free.length,
          freeByType,
        };
      });
  }

  /** True when no district has a free lot of any type. */
  cityIsFull(): boolean {
    return this.districtOccupancy().every((d) => d.available === 0);
  }

  /**
   * Cheap public city aggregates for the status panel. Everything here is
   * derived from in-memory state — no queries, no analytics tables — and is
   * strictly public: no cash, inventory, contract or ledger data.
   */
  getCityStatus(): CityStatus {
    const districts = this.districtOccupancy();
    const recent: CityActivity[] = [...this.businesses.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, 6)
      .map((b) => ({
        kind: 'business_opened' as const,
        companyName:
          this.companies.get(b.ownerId)?.name ??
          defaultCompanyName(this.players.get(b.ownerId)?.name ?? '???'),
        bizType: b.type,
        district: lotById(b.lotId)?.district ?? DEFAULT_DISTRICT,
        level: b.level,
        at: b.createdAtMs,
      }));
    return {
      companies: this.companies.size,
      businesses: this.businesses.size,
      occupiedLots: districts.reduce((n, d) => n + d.occupied, 0),
      totalLots: districts.reduce((n, d) => n + d.total, 0),
      activeDeliveries: [...this.deliveries.values()].filter((d) => d.status === 'in_transit').length,
      districts,
      recent,
    };
  }

  /**
   * V2.6.2 admin/report helper: businesses whose physical stock exceeds a
   * product's capacity (legacy overflow). Read-only — never deletes goods.
   */
  overCapacityReport(): {
    bizId: number; ownerName: string; type: BusinessType; product: ProductId;
    capacity: number; used: number; overflow: number;
  }[] {
    const rows = [];
    for (const biz of this.businesses.values()) {
      for (const [product, rec] of biz.inv) {
        const cap = capacityFor(biz, product);
        const used = rec.qty + rec.reserved;
        if (used > cap) {
          rows.push({
            bizId: biz.id,
            ownerName: this.players.get(biz.ownerId)?.name ?? '???',
            type: biz.type,
            product,
            capacity: cap,
            used,
            overflow: used - cap,
          });
        }
      }
    }
    return rows.sort((a, b) => b.overflow - a.overflow);
  }

  toCompanyPriv(company: CompanyRec): CompanyPriv {
    const owner = this.players.get(company.ownerId);
    const next = company.level < MAX_COMPANY_LEVEL ? COMPANY_LEVELS[company.level + 1].xp : null;
    return {
      id: company.id,
      ownerId: company.ownerId,
      ownerName: owner?.name ?? '???',
      name: company.name,
      level: company.level,
      xp: company.xp,
      xpForNext: next,
      capacity: companyCapacity(company.level),
      capacityUsed: this.capacityUsed(company.ownerId),
      businessCount: this.bizesByOwner(company.ownerId).length,
    };
  }

  // ============================================================
  // V2.2 — competitive metrics (market share, profile, rankings)
  // ============================================================

  /** Locate a company by its own id (companies map is keyed by ownerId). */
  private companyById(id: number): CompanyRec | undefined {
    for (const c of this.companies.values()) if (c.id === id) return c;
    return undefined;
  }

  /**
   * Aggregated company reputation: an activity-weighted average of the
   * company's businesses' reputations (weight = 1 + lifetime units the business
   * has moved), so busy businesses dominate and empty ones barely count.
   * Falls back to a plain average when there is no activity yet.
   */
  private companyReputation(ownerId: number): number {
    const bizes = this.bizesByOwner(ownerId);
    if (!bizes.length) return REP_START;
    let wsum = 0;
    let w = 0;
    for (const b of bizes) {
      const weight = 1 + b.coffeeSold + b.milkProduced;
      wsum += b.reputation * weight;
      w += weight;
    }
    return Math.round((wsum / w) * 100) / 100;
  }

  private activeContractsFor(ownerId: number): number {
    let n = 0;
    for (const c of this.contracts.values()) {
      if (c.status === 'active' && (c.buyerId === ownerId || c.sellerId === ownerId)) n++;
    }
    return n;
  }

  private windowStartISO(windowsBack = 0): string {
    return new Date(Date.now() - (windowsBack + 1) * RANKING_WINDOW_SECONDS * 1000).toISOString();
  }

  /** Recent competitive units grouped by company for one kind+product. */
  private async recentUnits(
    kind: 'final_sale' | 'supplier_sale',
    product: ProductId,
    fromISO: string
  ): Promise<Map<number, number>> {
    const r = await query(
      `SELECT company_id, SUM(units)::bigint AS units FROM company_activity
       WHERE kind=$1 AND product=$2 AND created_at >= $3 GROUP BY company_id`,
      [kind, product, fromISO]
    );
    const m = new Map<number, number>();
    for (const row of r.rows) m.set(row.company_id, Number(row.units));
    return m;
  }

  /** Recent ledger money grouped by company (optionally by transaction types). */
  private async recentLedger(
    fromISO: string,
    types: string[] | null,
    toISO: string | null = null
  ): Promise<Map<number, number>> {
    const conds = ['l.created_at >= $1'];
    const params: any[] = [fromISO];
    if (toISO) { params.push(toISO); conds.push(`l.created_at < $${params.length}`); }
    if (types) { params.push(types); conds.push(`l.transaction_type = ANY($${params.length})`); }
    const r = await query(
      `SELECT c.id AS cid, COALESCE(SUM(l.amount),0)::bigint AS v
       FROM companies c
       LEFT JOIN economic_ledger l ON l.player_id = c.player_id AND ${conds.join(' AND ')}
       GROUP BY c.id`,
      params
    );
    const m = new Map<number, number>();
    for (const row of r.rows) m.set(row.cid, Number(row.v));
    return m;
  }

  private static REVENUE_TYPES = ['CUSTOMER_SALE', 'MARKET_SELL', 'CONTRACT_SELL'];

  private rankingRow(companyId: number, value: number): RankingRow | null {
    const co = this.companyById(companyId);
    if (!co) return null;
    return { companyId, ownerId: co.ownerId, name: co.name, value };
  }

  /** Turn a companyId->value map into a board (top N + viewer's own rank). */
  private buildBoard(
    category: RankingCategory,
    unit: RankingBoard['unit'],
    values: Map<number, number>,
    viewerCompanyId: number | null,
    positiveOnly = false
  ): RankingBoard {
    let rows: RankingRow[] = [];
    for (const [cid, v] of values) {
      if (positiveOnly && v <= 0) continue;
      const row = this.rankingRow(cid, Math.round(v * 100) / 100);
      if (row) rows.push(row);
    }
    rows.sort((a, b) => b.value - a.value || a.companyId - b.companyId);
    const top = rows.slice(0, RANKING_TOP_N);
    const board: RankingBoard = { category, unit, top };
    if (viewerCompanyId != null) {
      const idx = rows.findIndex((r) => r.companyId === viewerCompanyId);
      if (idx >= 0) {
        board.selfRank = idx + 1;
        if (idx >= RANKING_TOP_N) board.self = { ...rows[idx], rank: idx + 1 };
      }
    }
    return board;
  }

  /** Recompute (or reuse cached) the raw per-metric value maps. */
  private async rankingMaps(): Promise<RankingMaps> {
    const now = Date.now();
    if (this.rankingsCache && now - this.rankingsCache.at < 5000) return this.rankingsCache.maps;
    const curFrom = this.windowStartISO(0);
    const prevFrom = this.windowStartISO(1);

    const [revenue, net, prevRev, bread, coffee, milkRetail, wheatSup, milkSup] = await Promise.all([
      this.recentLedger(curFrom, World.REVENUE_TYPES),
      this.recentLedger(curFrom, null),
      this.recentLedger(prevFrom, World.REVENUE_TYPES, curFrom),
      this.recentUnits('final_sale', 'bread', curFrom),
      this.recentUnits('final_sale', 'coffee', curFrom),
      this.recentUnits('final_sale', 'milk', curFrom),
      this.recentUnits('supplier_sale', 'wheat', curFrom),
      this.recentUnits('supplier_sale', 'milk', curFrom),
    ]);

    // Reputation from live in-memory business state (authoritative, cheap).
    const rep = new Map<number, number>();
    for (const co of this.companies.values()) rep.set(co.id, this.companyReputation(co.ownerId));

    // Fastest growing: % change cur vs prev, both windows above the floor.
    const growth = new Map<number, number>();
    for (const [cid, cur] of revenue) {
      const prev = prevRev.get(cid) ?? 0;
      if (cur >= GROWTH_MIN_REVENUE && prev >= GROWTH_MIN_REVENUE) {
        growth.set(cid, ((cur - prev) / prev) * 100);
      }
    }

    const maps: RankingMaps = { revenue, net, rep, growth, bread, coffee, milkRetail, wheatSup, milkSup };
    this.rankingsCache = { at: now, maps };
    return maps;
  }

  /** All city rankings, with the requesting player's own-rank markers. */
  async computeCityRankings(viewerOwnerId: number | null): Promise<CityRankings> {
    const viewerCid = viewerOwnerId != null ? this.companies.get(viewerOwnerId)?.id ?? null : null;
    const m = await this.rankingMaps();
    const boards: RankingBoard[] = [
      this.buildBoard('recent_revenue', 'money', m.revenue, viewerCid, true),
      this.buildBoard('net_cash_flow', 'money', m.net, viewerCid),
      this.buildBoard('reputation', 'stars', m.rep, viewerCid),
      this.buildBoard('growth', 'percent', m.growth, viewerCid),
      this.buildBoard('bread', 'units', m.bread, viewerCid, true),
      this.buildBoard('coffee', 'units', m.coffee, viewerCid, true),
      this.buildBoard('milk_retail', 'units', m.milkRetail, viewerCid, true),
      this.buildBoard('wheat_supplier', 'units', m.wheatSup, viewerCid, true),
      this.buildBoard('milk_supplier', 'units', m.milkSup, viewerCid, true),
    ];
    return { boards, serverTime: Date.now() };
  }

  /** Public competitive profile for a company. Only exposes public data. */
  async computeCompanyProfile(companyId: number, viewerOwnerId: number | null): Promise<CompanyProfile | null> {
    const company = this.companyById(companyId);
    if (!company) return null;
    const ownerId = company.ownerId;
    const owner = this.players.get(ownerId);
    const bizes = this.bizesByOwner(ownerId);
    const curFrom = this.windowStartISO(0);
    const prevFrom = this.windowStartISO(1);

    const [revenueMap, netMap] = await Promise.all([
      this.recentLedger(curFrom, World.REVENUE_TYPES),
      this.recentLedger(curFrom, null),
    ]);

    // Market shares for the final-consumer products this company actually sells.
    const marketShares: MarketShareEntry[] = [];
    const badges: string[] = [];
    for (const product of FINAL_MARKET_PRODUCTS) {
      const cur = await this.recentUnits('final_sale', product, curFrom);
      const mine = cur.get(companyId) ?? 0;
      if (mine <= 0) continue;
      let cityUnits = 0;
      for (const v of cur.values()) cityUnits += v;
      const ranked = [...cur.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const rank = ranked.findIndex(([cid]) => cid === companyId) + 1;
      const prev = await this.recentUnits('final_sale', product, prevFrom);
      let prevShare: number | undefined;
      const prevCur = prev.get(companyId);
      if (prevCur != null) {
        let prevCity = 0;
        for (const v of prev.values()) prevCity += v;
        // prev map covers [prevFrom, now]; subtract current to get prior window
        const priorMine = prevCur - mine;
        const priorCity = prevCity - cityUnits;
        if (priorCity > 0 && priorMine >= 0) prevShare = priorMine / priorCity;
      }
      marketShares.push({
        product, units: mine, cityUnits,
        share: cityUnits > 0 ? mine / cityUnits : 0, rank, prevShare,
      });
      if (rank === 1) badges.push(`top_${product === 'milk' ? 'milk_retail' : product}`);
    }

    // Supplier ranks for raw materials this company externally supplies.
    const supplierRanks: SupplierRankEntry[] = [];
    for (const product of SUPPLIER_PRODUCTS) {
      const cur = await this.recentUnits('supplier_sale', product, curFrom);
      const mine = cur.get(companyId) ?? 0;
      if (mine <= 0) continue;
      const ranked = [...cur.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const rank = ranked.findIndex(([cid]) => cid === companyId) + 1;
      supplierRanks.push({ product, units: mine, rank });
      if (rank === 1) badges.push(`top_${product}_supplier`);
    }

    return {
      id: company.id,
      ownerId,
      ownerName: owner?.name ?? '???',
      name: company.name,
      level: company.level,
      capacity: companyCapacity(company.level),
      capacityUsed: this.capacityUsed(ownerId),
      reputation: this.companyReputation(ownerId),
      businessCount: bizes.length,
      foundedAt: company.createdAtMs,
      tradeCount: bizes.reduce((s, b) => s + b.tradeCount, 0),
      activeContracts: this.activeContractsFor(ownerId),
      recentRevenue: Math.max(0, revenueMap.get(companyId) ?? 0),
      recentNet: netMap.get(companyId) ?? 0,
      isSelf: viewerOwnerId === ownerId,
      businesses: bizes.map((b) => this.toBizPub(b)),
      marketShares,
      supplierRanks,
      badges,
      warning: this.companyWarning(company.id),
    };
  }

  // ============================================================
  // V2.4 — player experience: brief, alerts, opportunity, tutorial,
  // updates ("What's New") and admin announcements.
  // ============================================================

  /** Actionable, prioritized alerts across all of a player's businesses. */
  computeAlerts(playerId: number): BusinessAlert[] {
    const alerts: BusinessAlert[] = [];
    for (const b of this.bizesByOwner(playerId)) {
      const base = { bizId: b.id, lotId: b.lotId, bizType: b.type } as const;
      if (b.status === 'paused_away') {
        alerts.push({ ...base, kind: 'not_operating', severity: 'warning' });
        continue;
      }
      if (b.status === 'storage_full') alerts.push({ ...base, kind: 'capacity_full', severity: 'info' });
      if (b.status === 'out_of_stock') alerts.push({ ...base, kind: 'sold_out', severity: 'warning' });
      for (const pr of INPUTS_OF[b.type]) {
        const have = (b.inv.get(pr)?.qty ?? 0) + this.incomingFor(b.id, pr);
        if (have < 10) {
          alerts.push({ ...base, kind: 'low_stock', severity: have === 0 ? 'warning' : 'info', product: pr, value: have });
        }
      }
    }
    // Contracts currently in a missed state.
    for (const c of this.contracts.values()) {
      const mine = c.sellerId === playerId || c.buyerId === playerId;
      if (mine && c.lastResult && c.lastResult.startsWith('missed')) {
        const bizId = c.sellerId === playerId ? c.sellerBizId : c.buyerBizId;
        const b = this.businesses.get(bizId);
        if (b) alerts.push({ bizId: b.id, lotId: b.lotId, bizType: b.type, kind: 'missed_contract', severity: 'critical' });
      }
    }
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity]);
    return alerts.slice(0, 6);
  }

  /** ONE most-important, deterministic opportunity (rule-based, no AI). */
  computeOpportunity(playerId: number, sells: Set<ProductId>, alerts: BusinessAlert[]): Opportunity | null {
    const bizes = this.bizesByOwner(playerId);
    const hasFarm = bizes.some((b) => b.type === 'farm');
    // 1) An announced/active demand event for something we sell -> stock up.
    const demandEvents = [...this.cityEvents]
      .filter((e) => e.status === 'upcoming' || e.status === 'active')
      .sort((a, b) => (a.status === 'upcoming' ? -1 : 1) - (b.status === 'upcoming' ? -1 : 1));
    for (const e of demandEvents) {
      for (const [pr, d] of Object.entries(e.effects.demand ?? {})) {
        if ((d as number) > 0 && sells.has(pr as ProductId)) {
          const biz = bizes.find((b) => FINAL_PRODUCTS_OF[b.type].includes(pr as ProductId));
          return { kind: 'event_stock_up', product: pr as ProductId, bizId: biz?.id, lotId: biz?.lotId };
        }
      }
    }
    // 2) A product we sell is already in high demand -> produce more.
    for (const pr of sells) {
      if (this.cityDemand(pr) >= 1.10) {
        const biz = bizes.find((b) => FINAL_PRODUCTS_OF[b.type].includes(pr));
        return { kind: 'high_demand_produce', product: pr, bizId: biz?.id, lotId: biz?.lotId };
      }
    }
    // 3) Farms benefit when inputs get scarce (Supply Disruption raises prices).
    if (hasFarm) {
      for (const [pr, m] of this.wholesaleMods) {
        if (m > 1.001 && (pr === 'wheat' || pr === 'milk')) {
          const farm = bizes.find((b) => b.type === 'farm');
          return { kind: 'supplier_demand', product: pr, bizId: farm?.id, lotId: farm?.lotId };
        }
      }
    }
    // 4) Encourage the first upgrade.
    const upgradable = bizes.find((b) => b.level < MAX_LEVEL);
    if (upgradable && !alerts.some((a) => a.severity === 'critical')) {
      return { kind: 'first_upgrade', bizId: upgradable.id, lotId: upgradable.lotId };
    }
    // 5) Nudge toward the marketplace.
    return { kind: 'join_market' };
  }

  /** The Morning Business Brief. Returns null for brand-new players (no biz). */
  async buildBrief(playerId: number, away: AwayReport | null): Promise<MorningBrief | null> {
    const p = this.players.get(playerId);
    const company = this.companies.get(playerId);
    const bizes = this.bizesByOwner(playerId);
    if (!p || !company || bizes.length === 0) return null;

    const awaySeconds = away?.seconds ?? 0;
    let revenue = 0, netCashFlow = 0, contractsCompleted = 0, unitsProduced = 0;
    const sales: BriefSale[] = [];
    if (awaySeconds > 60) {
      const fromISO = new Date(Date.now() - awaySeconds * 1000).toISOString();
      const rev = await query(
        `SELECT COALESCE(SUM(amount),0)::bigint v FROM economic_ledger
         WHERE player_id=$1 AND created_at>=$2 AND transaction_type = ANY($3)`,
        [playerId, fromISO, World.REVENUE_TYPES]
      );
      revenue = Number(rev.rows[0].v);
      const nt = await query(
        `SELECT COALESCE(SUM(amount),0)::bigint v FROM economic_ledger WHERE player_id=$1 AND created_at>=$2`,
        [playerId, fromISO]
      );
      netCashFlow = Number(nt.rows[0].v);
      const cc = await query(
        `SELECT count(*)::int n FROM economic_ledger WHERE player_id=$1 AND created_at>=$2
         AND transaction_type IN ('CONTRACT_SELL','CONTRACT_BUY')`,
        [playerId, fromISO]
      );
      contractsCompleted = cc.rows[0].n;
      const sl = await query(
        `SELECT product, SUM(units)::int u FROM company_activity
         WHERE company_id=$1 AND kind='final_sale' AND created_at>=$2 GROUP BY product`,
        [company.id, fromISO]
      );
      for (const r of sl.rows) if (r.u > 0) sales.push({ product: r.product, units: r.u });
      unitsProduced = Math.max(0, away?.milkProduced ?? 0);
    }

    let contractsMissed = 0;
    for (const c of this.contracts.values()) {
      if ((c.sellerId === playerId || c.buyerId === playerId) && c.lastResult?.startsWith('missed')) contractsMissed++;
    }

    const sells = new Set<ProductId>();
    for (const b of bizes) for (const pr of FINAL_PRODUCTS_OF[b.type]) sells.add(pr);
    const market: BriefMarket[] = [];
    const winFrom = this.windowStartISO(0);
    for (const pr of sells) {
      const eff = this.cityDemand(pr);
      const units = await this.recentUnits('final_sale', pr, winFrom);
      let cityUnits = 0;
      for (const v of units.values()) cityUnits += v;
      const mine = units.get(company.id) ?? 0;
      const ranked = [...units.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      market.push({
        product: pr,
        demandCategory: demandCategory(eff),
        demandDelta: Math.round((eff - 1) * 1000) / 1000,
        share: cityUnits > 0 && mine > 0 ? mine / cityUnits : null,
        rank: mine > 0 ? ranked.findIndex(([cid]) => cid === company.id) + 1 : null,
      });
    }

    const activeEvent = this.cityEvents.filter((e) => e.status === 'active').map((e) => this.toCityEventPub(e))[0] ?? null;
    const upcomingEvent = this.cityEvents.filter((e) => e.status === 'upcoming').map((e) => this.toCityEventPub(e))[0] ?? null;
    const alerts = this.computeAlerts(playerId);
    const opportunity = this.computeOpportunity(playerId, sells, alerts);

    return {
      playerName: p.name, companyName: company.name, awaySeconds,
      revenue: Math.max(0, revenue), netCashFlow, unitsProduced, sales,
      contractsCompleted, contractsMissed, market, activeEvent, upcomingEvent, alerts, opportunity,
    };
  }

  // ---- Tutorial ----
  async getTutorial(playerId: number): Promise<TutorialState> {
    const r = await query(
      `SELECT current_step, completed_steps, skipped FROM tutorial_progress WHERE player_id=$1`,
      [playerId]
    );
    if (!r.rowCount) {
      // Brand-new player: create progress and mark existing release notes as
      // already seen, so they get the tutorial rather than an update backlog.
      await query(`INSERT INTO tutorial_progress (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [playerId]);
      for (const u of UPDATES) {
        await query(`INSERT INTO player_seen_updates (player_id, update_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [playerId, u.id]);
      }
      return { currentStep: 0, completedSteps: [], skipped: false, done: false };
    }
    const row = r.rows[0];
    return {
      currentStep: row.current_step,
      completedSteps: row.completed_steps ?? [],
      skipped: row.skipped,
      done: row.skipped || row.current_step > TUTORIAL_LAST_STEP,
    };
  }

  async advanceTutorial(playerId: number, step: number): Promise<TutorialState> {
    const cur = await this.getTutorial(playerId);
    if (cur.skipped) return cur;
    const completed = new Set<number>(cur.completedSteps);
    if (step >= 1 && step <= TUTORIAL_LAST_STEP) completed.add(step);
    const next = Math.min(TUTORIAL_LAST_STEP + 1, Math.max(cur.currentStep, step + 1));
    await query(
      `INSERT INTO tutorial_progress (player_id, current_step, completed_steps, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (player_id) DO UPDATE SET current_step=$2, completed_steps=$3, updated_at=now()`,
      [playerId, next, JSON.stringify([...completed])]
    );
    return { currentStep: next, completedSteps: [...completed], skipped: false, done: next > TUTORIAL_LAST_STEP };
  }

  async skipTutorial(playerId: number): Promise<TutorialState> {
    await query(
      `INSERT INTO tutorial_progress (player_id, current_step, skipped, updated_at)
       VALUES ($1,$2,true, now())
       ON CONFLICT (player_id) DO UPDATE SET skipped=true, updated_at=now()`,
      [playerId, TUTORIAL_LAST_STEP + 1]
    );
    const cur = await this.getTutorial(playerId);
    return { ...cur, skipped: true, done: true };
  }

  // ---- Updates ("What's New") ----
  private toUpdatePub(u: (typeof UPDATES)[number]): UpdatePub {
    return { id: u.id, version: u.version, titleKey: u.titleKey, taglineKey: u.taglineKey, featureKeys: u.featureKeys };
  }
  allUpdates(): UpdatePub[] { return UPDATES.map((u) => this.toUpdatePub(u)); }
  async unseenUpdates(playerId: number): Promise<UpdatePub[]> {
    const seen = await query(`SELECT update_id FROM player_seen_updates WHERE player_id=$1`, [playerId]);
    const seenSet = new Set(seen.rows.map((r) => r.update_id));
    return UPDATES.filter((u) => !seenSet.has(u.id)).map((u) => this.toUpdatePub(u));
  }
  async markUpdateSeen(playerId: number, updateId: string): Promise<void> {
    if (!UPDATES.some((u) => u.id === updateId)) return;
    await query(
      `INSERT INTO player_seen_updates (player_id, update_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [playerId, updateId]
    );
  }

  // ---- Admin announcements ----
  private announceTimes = new Map<number, number[]>(); // simple per-admin rate limit
  private toAnnouncementPub(r: any): AnnouncementPub {
    return {
      id: r.id, title: r.title, message: r.message, kind: r.type, priority: r.priority,
      createdAt: new Date(r.created_at).getTime(),
      startsAt: new Date(r.starts_at).getTime(),
      expiresAt: r.expires_at ? new Date(r.expires_at).getTime() : null,
    };
  }

  isAdmin(playerId: number): boolean {
    return this.players.get(playerId)?.isAdmin ?? false;
  }

  async createAnnouncement(
    byId: number,
    input: { title: string; message: string; kind: AnnouncementType; priority: AnnouncementPriority; durationSecs?: number }
  ): Promise<AnnouncementPub> {
    if (!this.isAdmin(byId)) throw new GameError('err.not_admin');
    const title = (input.title ?? '').replace(/\s+/g, ' ').trim().replace(/[<>]/g, '');
    const message = (input.message ?? '').trim().replace(/[<>]/g, '');
    if (title.length < 3 || title.length > ANNOUNCEMENT_TITLE_MAX) throw new GameError('err.announce_title_len', { max: ANNOUNCEMENT_TITLE_MAX });
    if (message.length < 3 || message.length > ANNOUNCEMENT_MESSAGE_MAX) throw new GameError('err.announce_msg_len', { max: ANNOUNCEMENT_MESSAGE_MAX });
    const kinds: AnnouncementType[] = ['general', 'update', 'event', 'maintenance', 'critical'];
    const prios: AnnouncementPriority[] = ['normal', 'important', 'critical'];
    const kind = kinds.includes(input.kind) ? input.kind : 'general';
    const priority = prios.includes(input.priority) ? input.priority : 'normal';
    // Spam guard: at most 5 announcements per admin per minute.
    const now = Date.now();
    const recent = (this.announceTimes.get(byId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 5) throw new GameError('err.announce_rate');
    recent.push(now);
    this.announceTimes.set(byId, recent);

    const expiresAt = input.durationSecs && input.durationSecs > 0 ? new Date(now + input.durationSecs * 1000) : null;
    const res = await query(
      `INSERT INTO announcements (title, message, type, priority, created_by, starts_at, expires_at)
       VALUES ($1,$2,$3,$4,$5, now(), $6) RETURNING *`,
      [title, message, kind, priority, byId, expiresAt]
    );
    console.log(`[announce] #${res.rows[0].id} by=${byId} ${priority}/${kind}: ${title}`);
    return this.toAnnouncementPub(res.rows[0]);
  }

  /**
   * Post the city-expansion announcement exactly once, ever. Keyed on a
   * marker in the title so a server restart (or a redeploy) never re-posts
   * it; it is created by the system, not an admin, so it bypasses the
   * admin-only createAnnouncement path.
   */
  async seedExpansionAnnouncement(): Promise<void> {
    const MARKER = '[v2.6-expansion]';
    const existing = await query('SELECT 1 FROM announcements WHERE message LIKE $1 LIMIT 1', [`%${MARKER}%`]);
    if (existing.rowCount) return;
    const newLots = DISTRICTS
      .filter((d) => d.unlockOrder > 1)
      .reduce((n, d) => n + districtLots(d.id).length, 0);
    await query(
      `INSERT INTO announcements (title, message, type, priority, created_by, starts_at, expires_at)
       VALUES ($1,$2,'update','important',NULL, now(), NULL)`,
      [
        'THE CITY IS EXPANDING',
        `Green Valley is now open for business. ${newLots} new commercial lots are available. ${MARKER}`,
      ]
    );
    console.log(`[announce] seeded city expansion announcement (${newLots} lots)`);
  }

  async activeAnnouncements(): Promise<AnnouncementPub[]> {
    const r = await query(
      `SELECT * FROM announcements WHERE is_active AND starts_at <= now()
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC LIMIT 20`
    );
    return r.rows.map((row) => this.toAnnouncementPub(row));
  }

  async announcementHistory(): Promise<AnnouncementPub[]> {
    const r = await query(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 30`);
    return r.rows.map((row) => this.toAnnouncementPub(row));
  }

  toBizPriv(b: BizRec): BizPriv {
    const inventory: Partial<Record<ProductId, InventoryEntry>> = {};
    for (const [product, rec] of b.inv) {
      inventory[product] = {
        qty: rec.qty,
        reserved: rec.reserved,
        incoming: this.incomingFor(b.id, product),
        capacity: capacityFor(b, product),
      };
    }
    return {
      ...this.toBizPub(b),
      inventory,
      price: b.price,
      price2: b.price2,
      production: b.production,
      revenue: b.revenue,
      expenses: b.expenses,
      milkProduced: b.milkProduced,
      coffeeSold: b.coffeeSold,
      customers: b.customers,
      reputation: Math.round(b.reputation * 100) / 100,
    };
  }

  toOrderPub(o: OrderRec): OrderPub {
    const owner = this.players.get(o.playerId);
    return {
      id: o.id,
      side: o.side,
      product: o.product,
      qty: o.qty,
      remaining: o.remaining,
      price: o.price,
      ownerId: o.playerId,
      ownerName: owner?.name ?? '???',
      createdAt: o.createdAtMs,
    };
  }

  toDeliveryPub(d: DeliveryRec): DeliveryPub {
    return {
      id: d.id,
      product: d.product,
      qty: d.qty,
      fromLot: d.fromLot,
      toLot: d.toLot,
      departAt: d.departAtMs,
      arriveAt: d.arriveAtMs,
      status: d.status,
    };
  }

  async recentTrades(limit = 20): Promise<TradeRow[]> {
    const res = await query(
      `SELECT t.id, t.product, t.qty, t.price, t.created_at,
              b.username AS buyer_name, s.username AS seller_name
       FROM trades t
       JOIN players b ON b.id = t.buyer_id
       JOIN players s ON s.id = t.seller_id
       ORDER BY t.created_at DESC LIMIT $1`,
      [limit]
    );
    return res.rows.map((r) => ({
      id: r.id,
      product: r.product,
      qty: r.qty,
      price: r.price,
      buyerName: r.buyer_name,
      sellerName: r.seller_name,
      at: new Date(r.created_at).getTime(),
    }));
  }

  onlineCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connections > 0) n++;
    return n;
  }
}
