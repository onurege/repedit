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
  LOTS,
  lotById,
  lotsOfKind,
  WHOLESALE_LOT_ID,
  roadPath,
  pathLength,
  type PlayerPriv,
  type PlayerPub,
  type BizPub,
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
} from '@district/shared';
import { query, tx } from '../db.js';

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
  lotId: string;
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
  status: 'in_transit' | 'delivered';
  departAtMs: number;
  arriveAtMs: number;
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

const TRADABLE: ProductId[] = ['milk', 'beans', 'wheat', 'bread'];

const STARTING_PRODUCTS: Record<BusinessType, ProductId[]> = {
  farm: ['milk', 'wheat'],
  coffee_shop: ['milk', 'beans', 'coffee'],
  bakery: ['wheat', 'bread'],
  mini_market: ['bread', 'milk'],
};

function inv(biz: BizRec, product: ProductId): InvRec {
  let rec = biz.inv.get(product);
  if (!rec) {
    rec = { qty: 0, reserved: 0 };
    biz.inv.set(product, rec);
  }
  return rec;
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
        lotId: r.lot_id,
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
    const deliveries = await query("SELECT * FROM deliveries WHERE status = 'in_transit'");
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
    if (!dirtyPlayers.length && !dirtyBiz.length && !dirtyCompanies.length && !ledger.length) return;
    this.ledgerQueue = [];
    try {
      await this.flushTx(dirtyPlayers, dirtyBiz, dirtyCompanies, ledger);
    } catch (err) {
      // don't lose audit rows on a transient failure
      this.ledgerQueue.unshift(...ledger);
      throw err;
    }
  }

  private async flushTx(dirtyPlayers: PlayerRec[], dirtyBiz: BizRec[], dirtyCompanies: CompanyRec[], ledger: LedgerEntry[]): Promise<void> {
    await tx(async (c) => {
      for (const e of ledger) await c.query(LEDGER_SQL, ledgerParams(e));
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
      }
    }
    for (const c of [...this.contracts.values()]) {
      if (c.status === 'active' && c.nextExecutionAtMs != null && c.nextExecutionAtMs <= now) {
        await this.executeContract(c.id);
      }
    }
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
          repDemandMultiplier(biz.reputation) * dt;
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
          repDemandMultiplier(biz.reputation) * dt;
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
        biz.custAccum += lv.customersPerSec * priceDemandMultiplier(biz.price, RETAIL_BASE.bread) * rep * dt;
        const breadArrivals = Math.floor(biz.custAccum);
        biz.custAccum -= breadArrivals;
        this.applyRetail(biz, owner, 'bread', biz.price, breadArrivals, silent);
        biz.prodAccum += lv.customersPerSec * priceDemandMultiplier(biz.price2, RETAIL_BASE.milk) * rep * dt;
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
      lotId,
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
    const lot = lotsOfKind(type).find((l) => !taken.has(l.id));
    if (!lot) throw new GameError('err.no_free_lots');

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

  async buyNpc(playerId: number, product: ProductId, qty: number, bizId?: number): Promise<void> {
    const p = this.player(playerId);
    const biz = this.requireOwnedBiz(playerId, bizId);
    qty = Math.floor(qty);
    if (!Number.isFinite(qty) || qty < 1 || qty > MARKET_MAX_QTY) throw new GameError('err.invalid_qty');
    const unit = NPC_WHOLESALE_PRICES[product];
    if (!unit) throw new GameError('err.wholesale_no_product');
    const cap = capacityFor(biz, product);
    if (cap <= 0) throw new GameError('err.cannot_store_product', { bizType: biz.type, product });
    const rec = inv(biz, product);
    const incoming = this.incomingFor(biz.id, product);
    if (rec.qty + rec.reserved + incoming + qty > cap) {
      throw new GameError('err.not_enough_storage', { cap });
    }
    const cost = unit * qty;
    if (p.cash < cost) throw new GameError('err.not_enough_cash', { cost });

    // Mutate memory synchronously, then persist.
    p.cash -= cost;
    p.dirty = true;
    biz.expenses += cost;
    biz.dirty = true;
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
        await c.query(LEDGER_SQL, ledgerParams({
          playerId, businessId: biz.id, type: 'NPC_PURCHASE', amount: -cost,
          refType: 'delivery', refId: delivery.id, before: p.cash + cost, after: p.cash,
        }));
      });
      console.log(`[econ] NPC_PURCHASE player=${playerId} ${qty}x${product} cost=$${cost} delivery=${delivery.id}`);
      this.emit('delivery', delivery);
      this.emit('purchase', { playerId, product, qty, cost });
    } catch (err) {
      // Roll back the in-memory mutation on persistence failure.
      p.cash += cost;
      biz.expenses -= cost;
      throw err;
    }
  }

  private incomingFor(bizId: number, product: ProductId): number {
    let total = 0;
    for (const d of this.deliveries.values()) {
      if (d.toBusinessId === bizId && d.product === product && d.status === 'in_transit') {
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

  private async completeDelivery(d: DeliveryRec): Promise<void> {
    if (d.status !== 'in_transit') return;
    d.status = 'delivered';
    const biz = this.businesses.get(d.toBusinessId);
    if (biz) {
      // Paid goods are never lost: deliveries may exceed nominal capacity.
      inv(biz, d.product).qty += d.qty;
      biz.dirty = true;
    }
    await tx(async (c) => {
      await c.query("UPDATE deliveries SET status='delivered' WHERE id=$1 AND status='in_transit'", [d.id]);
      if (biz) {
        const rec = inv(biz, d.product);
        await c.query(
          `INSERT INTO inventories (business_id, product, qty, reserved) VALUES ($1,$2,$3,$4)
           ON CONFLICT (business_id, product) DO UPDATE SET qty=$3, reserved=$4`,
          [biz.id, d.product, rec.qty, rec.reserved]
        );
      }
    });
    this.deliveries.delete(d.id);
    console.log(`[econ] DELIVERY_DONE id=${d.id} ${d.qty}x${d.product} -> biz=${d.toBusinessId}`);
    this.emit('delivery_done', d);
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
        inv(biz, product).qty += v > 0 ? v : 50;
        biz.dirty = true;
        return `+${v > 0 ? v : 50} ${PRODUCTS[product].name}`;
      }
      case 'company_xp': {
        const company = await this.ensureCompany(playerId);
        this.addCompanyXp(company, v > 0 ? v : 1000);
        this.emit('company', company);
        return `company xp +${v > 0 ? v : 1000} (lvl ${company.level})`;
      }
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
      lotId: b.lotId,
      level: b.level,
      status: b.status,
      reputation: Math.round(b.reputation * 100) / 100,
      supplies: SELLER_SUPPLIES[b.type] ?? [],
      tradeCount: b.tradeCount,
    };
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
