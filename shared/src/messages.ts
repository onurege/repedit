// ============================================================
// Wire protocol between client and server (JSON over WebSocket).
// The client only ever sends INTENT; the server owns all state.
// ============================================================

import type {
  BusinessType, ProductId, RankingCategory,
  CityEventType, CityEventStatus, CityEventEffects, DemandCategory,
  StockCategory,
} from './defs.js';
import type { DistrictId } from './city.js';
import type {
  AlertKind, AlertSeverity, OpportunityKind,
  AnnouncementType, AnnouncementPriority,
} from './content.js';

// ---------- client -> server ----------
// Actions that target one of the player's businesses carry an optional
// `bizId`. If omitted and the player owns exactly one business, the server
// uses that (keeps single-business play simple).
export type ClientMsg =
  | { t: 'choose_business'; type: BusinessType }
  | { t: 'open_business'; lotId: string; type: BusinessType }
  | { t: 'rename_company'; name: string }
  | { t: 'rename_business'; name: string; bizId?: number }
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
  | { t: 'get_city_market' }
  | { t: 'get_wholesale' }
  | { t: 'get_brief' }
  | { t: 'ack_update'; updateId: string }
  | { t: 'tutorial_advance'; step: number }
  | { t: 'tutorial_skip' }
  | { t: 'get_announcements' }
  | { t: 'create_announcement'; title: string; message: string; kind: AnnouncementType; priority: AnnouncementPriority; durationSecs?: number }
  | { t: 'city_status' }
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
  isAdmin: boolean;
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
  name: string | null;  // player-chosen name; null => default "<owner>'s <Type>"
  lotId: string;
  district: DistrictId; // derived from the lot; districts share one economy
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
  warning: string | null;     // V2.5: vague public trust warning, e.g. 'market_violation'
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

// ---------- V2.3: dynamic city demand & city events ----------

export interface CityEventPub {
  id: number;
  type: CityEventType;
  status: CityEventStatus;
  effects: CityEventEffects;
  announcedAt: number; // epoch ms
  startsAt: number;    // epoch ms
  endsAt: number;      // epoch ms
  major: boolean;
}

/** Current city demand for one final-consumer product. */
export interface ProductDemand {
  product: ProductId;
  effective: number;          // multiplier, 1.0 = base
  delta: number;              // effective - 1 (e.g. +0.32)
  category: DemandCategory;
  trend: 'up' | 'down' | 'flat';
}

/** NPC wholesale price status for an input product (Supply Disruption etc.). */
export interface WholesaleStatus {
  product: ProductId;
  modifier: number; // effective multiplier on the base wholesale price
}

export interface CityMarket {
  demand: ProductDemand[];
  wholesale: WholesaleStatus[];   // only inputs currently modified
  active: CityEventPub[];
  upcoming: CityEventPub[];
  serverTime: number;
}

// ---------- V2.5: Central Wholesale daily supply ----------

export interface WholesaleProduct {
  product: ProductId;
  remaining: number;
  dailyStock: number;
  basePrice: number;       // effective unit price (incl. active event modifier)
  category: StockCategory;
  resetAt: number;         // epoch ms of next daily reset
  emergency: boolean;      // out of stock -> emergency fallback applies
  importDependent: boolean; // no player producer -> Emergency Import is a lifeline, not a penalty
}

export interface WholesaleState {
  products: WholesaleProduct[];
  serverTime: number;
}

// ---------- V2.4: player experience & live service ----------

export interface BusinessAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  bizId: number;
  lotId: string;
  bizType: BusinessType;
  product?: ProductId;
  value?: number;      // e.g. remaining stock units
}

export interface Opportunity {
  kind: OpportunityKind;
  product?: ProductId;
  bizId?: number;
  lotId?: string;
}

export interface BriefSale {
  product: ProductId;
  units: number;
}

export interface BriefMarket {
  product: ProductId;
  demandCategory: DemandCategory;
  demandDelta: number;
  share: number | null;   // 0..1, null if no activity
  rank: number | null;
}

/** The Morning Business Brief shown on session return. */
export interface MorningBrief {
  playerName: string;
  companyName: string;
  awaySeconds: number;         // 0 when the player wasn't meaningfully away
  revenue: number;             // while away (gross inflows)
  netCashFlow: number;         // while away (signed)
  unitsProduced: number;       // aggregate produced while away
  sales: BriefSale[];          // final NPC sales while away, by product
  contractsCompleted: number;  // contract deliveries while away
  contractsMissed: number;     // contracts currently in a missed state
  market: BriefMarket[];       // products this company sells
  activeEvent: CityEventPub | null;
  upcomingEvent: CityEventPub | null;
  alerts: BusinessAlert[];
  opportunity: Opportunity | null;
}

export interface TutorialState {
  currentStep: number;    // 0 = not started, TUTORIAL_LAST_STEP+ = done
  completedSteps: number[];
  skipped: boolean;
  done: boolean;
}

export interface UpdatePub {
  id: string;
  version: string;
  titleKey: string;
  taglineKey: string;
  featureKeys: string[];
}

export interface AnnouncementPub {
  id: number;
  title: string;
  message: string;
  kind: AnnouncementType;
  priority: AnnouncementPriority;
  createdAt: number;
  startsAt: number;
  expiresAt: number | null;
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

// ---------- districts & city status (V2.6) ----------

/** Live occupancy for one district, used by the district selector. */
export interface DistrictOccupancy {
  id: DistrictId;
  nameKey: string;
  unlockOrder: number;
  total: number;      // buildable lots
  occupied: number;
  available: number;
  /** Free lots per business type, so the UI can show real expansion room. */
  freeByType: Partial<Record<BusinessType, number>>;
}

/**
 * Cheap, city-wide public aggregates. Contains no private information —
 * never cash, inventory, contracts or ledger data.
 */
export interface CityStatus {
  companies: number;
  businesses: number;
  occupiedLots: number;
  totalLots: number;
  activeDeliveries: number;
  districts: DistrictOccupancy[];
  recent: CityActivity[];
}

/** A recent, public city happening shown in the living-city feed. */
export interface CityActivity {
  kind: 'business_opened' | 'business_upgraded';
  companyName: string;
  bizType: BusinessType;
  district: DistrictId;
  level: number;
  at: number; // epoch ms
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
  | { t: 'city_market'; market: CityMarket }
  | { t: 'wholesale'; wholesale: WholesaleState }
  | { t: 'brief'; brief: MorningBrief }
  | { t: 'updates'; unseen: UpdatePub[]; all: UpdatePub[] }
  | { t: 'tutorial'; state: TutorialState }
  | { t: 'announcements'; active: AnnouncementPub[]; history: AnnouncementPub[] }
  | { t: 'announcement'; announcement: AnnouncementPub }  // live broadcast
  | { t: 'city_status'; status: CityStatus }
  | { t: 'pong' };
