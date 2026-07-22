// ============================================================
// Wire protocol between client and server (JSON over WebSocket).
// The client only ever sends INTENT; the server owns all state.
// ============================================================

import type { BusinessType, ProductId, RankingCategory } from './defs.js';

// ---------- client -> server ----------
// Actions that target one of the player's businesses carry an optional
// `bizId`. If omitted and the player owns exactly one business, the server
// uses that (keeps single-business play simple).
export type ClientMsg =
  | { t: 'choose_business'; type: BusinessType }
  | { t: 'open_business'; lotId: string; type: BusinessType }
  | { t: 'rename_company'; name: string }
  | { t: 'buy_npc'; product: ProductId; qty: number; bizId?: number }
  | { t: 'order_create'; side: 'buy' | 'sell'; product: ProductId; qty: number; price: number; bizId?: number }
  | { t: 'order_cancel'; orderId: number }
  | { t: 'order_fulfill'; orderId: number; qty: number; bizId?: number }
  | { t: 'upgrade'; bizId?: number }
  | { t: 'set_price'; price: number; product?: ProductId; bizId?: number }
  | { t: 'set_production'; product: ProductId; bizId?: number }
  | { t: 'contract_propose'; sellerBizId: number; product: ProductId; quantity: number; unitPrice: number; deliveries: number; buyerBizId?: number }
  | { t: 'contract_accept'; contractId: number }
  | { t: 'contract_reject'; contractId: number }
  | { t: 'contract_cancel'; contractId: number }
  | { t: 'dev'; cmd: string; value?: number; bizId?: number }
  | { t: 'get_rankings' }
  | { t: 'get_company_profile'; companyId: number }
  | { t: 'ping' };

// ---------- server -> client ----------
export interface PlayerPub {
  id: number;
  name: string;
  level: number;
  online: boolean;
}

export interface PlayerPriv {
  id: number;
  name: string;
  cash: number;
  xp: number;
  level: number;
  reputation: number;
}

export interface InventoryEntry {
  qty: number;
  reserved: number;
  incoming: number;
  capacity: number;
}

/**
 * Business status as a locale-independent code. The client maps it to
 * display text; never send prose over the wire.
 */
export type BizStatus =
  | ''
  | 'producing'
  | 'storage_full'
  | 'open'
  | 'out_of_stock'
  | 'paused_away';

/** Statuses that should render as a warning rather than a healthy state. */
export const BAD_STATUSES: BizStatus[] = ['storage_full', 'out_of_stock', 'paused_away'];

/** Outcome of the most recent scheduled contract delivery. */
export type ContractResult = 'completed' | 'delivered' | 'missed_stock' | 'missed_funds';

/** Params interpolated into a localized message on the client. */
export type MsgParams = Record<string, string | number>;

export interface BizPub {
  id: number;
  ownerId: number;
  ownerName: string;
  companyId: number;
  companyName: string;
  type: BusinessType;
  lotId: string;
  level: number;
  status: BizStatus;
  reputation: number;   // public: star rating
  supplies: ProductId[]; // products this business can supply via contract
  tradeCount: number;    // successful player trades + contract deliveries
}

// A player owns exactly one company; a company owns one or more businesses.
export interface CompanyPub {
  id: number;
  ownerId: number;
  ownerName: string;
  name: string;
  level: number;
}
export interface CompanyPriv extends CompanyPub {
  xp: number;
  xpForNext: number | null;   // total XP needed for next level (null at max)
  capacity: number;           // total management capacity
  capacityUsed: number;       // sum of owned business capacities
  businessCount: number;
}

// ---------- V2.2: market share, company profile & city rankings ----------

/** A company's standing in one final-consumer product market. */
export interface MarketShareEntry {
  product: ProductId;
  units: number;        // this company's recent NPC sales (units)
  cityUnits: number;    // whole-city recent NPC sales for the product
  share: number;        // 0..1 (units / cityUnits)
  rank: number;         // 1-based city rank among companies with activity
  prevShare?: number;   // previous-window share, when cheaply available
}

/** A company's standing as an external supplier of a raw material. */
export interface SupplierRankEntry {
  product: ProductId;
  units: number;        // recent external (P2P/contract) units supplied
  rank: number;         // 1-based city rank among suppliers with activity
}

/** Public competitive profile of a company (safe to show to anyone). */
export interface CompanyProfile {
  id: number;
  ownerId: number;
  ownerName: string;
  name: string;
  level: number;
  capacity: number;
  capacityUsed: number;
  reputation: number;         // aggregated company reputation (1..5)
  businessCount: number;
  foundedAt: number;          // epoch ms
  tradeCount: number;         // successful trades + contract deliveries
  activeContracts: number;
  recentRevenue: number;      // rolling window, $ (gross inflows)
  recentNet: number;          // rolling window net cash flow, $ (signed)
  isSelf: boolean;
  businesses: BizPub[];       // owned businesses (public view)
  marketShares: MarketShareEntry[];
  supplierRanks: SupplierRankEntry[];
  badges: string[];           // e.g. 'top_bread' — small profile badges
}

export interface RankingRow {
  companyId: number;
  ownerId: number;
  name: string;
  value: number;      // metric value (units, $, rep, or growth %)
}

export interface RankingBoard {
  category: RankingCategory;
  unit: 'money' | 'units' | 'stars' | 'percent';
  top: RankingRow[];              // up to RANKING_TOP_N
  self?: RankingRow & { rank: number }; // present if outside the top N
  selfRank?: number;              // the player's own rank (any position)
}

export interface CityRankings {
  boards: RankingBoard[];
  serverTime: number;
}

export interface BizPriv extends BizPub {
  inventory: Partial<Record<ProductId, InventoryEntry>>;
  price: number;   // retail price (coffee / bread)
  price2: number;  // mini market milk retail price
  production: string; // farm: 'milk' | 'wheat'
  revenue: number;
  expenses: number;
  milkProduced: number;
  coffeeSold: number;
  customers: number;
  reputation: number;
}

export interface OrderPub {
  id: number;
  side: 'buy' | 'sell';
  product: ProductId;
  qty: number;
  remaining: number;
  price: number;
  ownerId: number;
  ownerName: string;
  createdAt: number;
}

export interface DeliveryPub {
  id: number;
  product: ProductId;
  qty: number;
  fromLot: string;
  toLot: string;
  departAt: number; // epoch ms
  arriveAt: number; // epoch ms
  status: 'in_transit' | 'delivered';
}

export interface TradeRow {
  id: number;
  product: ProductId;
  qty: number;
  price: number;
  buyerName: string;
  sellerName: string;
  at: number;
}

export type ContractStatus = 'proposed' | 'active' | 'completed' | 'rejected' | 'cancelled';

export interface ContractPub {
  id: number;
  buyerId: number;
  sellerId: number;
  buyerName: string;
  sellerName: string;
  buyerCompany: string;
  sellerCompany: string;
  buyerType: BusinessType;
  sellerType: BusinessType;
  product: ProductId;
  quantity: number;
  unitPrice: number;
  deliveries: number;      // total agreed deliveries
  remaining: number;
  status: ContractStatus;
  lastResult: ContractResult | null;
  nextExecutionAt: number | null; // epoch ms
  createdAt: number;
}

export interface AwayReport {
  seconds: number;
  revenue: number;
  expenses: number;
  profit: number;
  milkProduced: number;
  coffeeSold: number;
}

export type ServerMsg =
  | {
      t: 'welcome';
      you: PlayerPriv;
      company: CompanyPriv | null;
      myBusinesses: BizPriv[];
      businesses: BizPub[];
      orders: OrderPub[];
      deliveries: DeliveryPub[];
      players: PlayerPub[];
      contracts: ContractPub[];
      online: number;
      devTools: boolean;
      serverTime: number;
    }
  | { t: 'you'; you: PlayerPriv }
  | { t: 'company'; company: CompanyPriv }  // your company detail
  | { t: 'biz'; biz: BizPub }             // someone else's business upsert
  | { t: 'my_biz'; biz: BizPriv }          // one of your businesses' detail
  | { t: 'my_biz_removed'; bizId: number }
  | { t: 'order'; order: OrderPub }        // upsert (remaining=0 -> remove)
  | { t: 'order_removed'; orderId: number }
  | { t: 'delivery'; delivery: DeliveryPub }
  | { t: 'delivery_done'; deliveryId: number }
  | { t: 'sale'; bizId: number; lotId: string; amount: number }
  | { t: 'lost_customer'; bizId: number; lotId: string }
  | { t: 'trade'; trade: TradeRow }
  | { t: 'trades'; trades: TradeRow[] }
  | { t: 'players'; players: PlayerPub[]; online: number }
  | { t: 'contract'; contract: ContractPub }
  | { t: 'contracts'; contracts: ContractPub[] }
  | { t: 'away'; report: AwayReport }
  | { t: 'toast'; code: string; params?: MsgParams; kind?: 'info' | 'success' | 'error' }
  | { t: 'error'; code: string; params?: MsgParams }
  | { t: 'level_up'; level: number }
  | { t: 'rankings'; rankings: CityRankings }
  | { t: 'company_profile'; profile: CompanyProfile }
  | { t: 'pong' };
