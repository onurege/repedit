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
// ---------- V2.7 Phase 1: City Chat ----------

export type ChatKind = 'user' | 'system';
export type ChatReportReason = 'spam' | 'harassment' | 'offensive' | 'other';

/** A public city-chat message. Never carries private economic data. */
export interface ChatMessagePub {
  id: number;
  authorName: string;      // denormalised; survives author deletion
  companyName: string | null;
  kind: ChatKind;
  body: string;            // already sanitised server-side
  at: number;              // epoch ms
  self?: boolean;          // set per-recipient for the sender
}

// ---------- V2.7 Phase 2: Admin & Live Ops ----------

export type AdminCashOp = 'add' | 'remove' | 'set';
export type AdminInvOp = 'add' | 'remove' | 'set';
export type AdminWholesaleOp = 'add' | 'remove' | 'set' | 'refill' | 'set_daily' | 'set_price' | 'reset';

/** Cheap city-wide operational overview (admin-only). */
export interface AdminDashboard {
  online: number;
  players: number;
  companies: number;
  businesses: number;
  districts: number;
  deliveries: number;
  waitingDeliveries: number;
  contracts: number;
  orders: number;
  urgentOrders: number;   // reserved for a later phase; 0 for now
  cityEvents: number;
  wholesale: { product: ProductId; remaining: number; dailyStock: number; basePrice: number }[];
  recentAudit: AdminAuditEntry[];
  recentReports: AdminReportEntry[];
}

export interface AdminPlayerRow {
  id: number;
  username: string;
  companyName: string | null;
  online: boolean;
  suspended: boolean;
  cash: number;
  businesses: number;
}

export interface AdminInventorySlot {
  bizId: number;
  bizType: BusinessType;
  district: DistrictId;
  product: ProductId;
  qty: number;
  reserved: number;
  capacity: number;
}

/** Full admin-only player profile. Contains values normal players never see. */
export interface AdminPlayerDetail {
  id: number;
  username: string;
  online: boolean;
  suspended: boolean;
  suspendedReason: string | null;
  muted: boolean;
  joinedAt: number;
  cash: number;
  xp: number;
  level: number;
  reputation: number;
  company: { id: number; name: string; level: number; xp: number } | null;
  businesses: { id: number; type: BusinessType; district: DistrictId; level: number; lotId: string }[];
  inventory: AdminInventorySlot[];
  activeOrders: number;
  activeContracts: number;
  recentLedger: { type: string; amount: number; at: number }[];
}

export interface AdminAuditEntry {
  id: number;
  adminName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  at: number;
}

export interface AdminReportEntry {
  id: number;
  messageId: number;
  reason: string;
  note: string | null;
  body: string | null;      // the reported message body (may be deleted)
  authorName: string | null;
  at: number;
}

// ---------- V2.7 Phase 3: Direct messaging & trade offers ----------

export type OfferStatus = 'pending' | 'countered' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
export type OfferSide = 'buy' | 'sell';

/** A private DM (or an offer-event marker) in a company conversation. */
export interface DirectMessagePub {
  id: number;
  senderId: number | null;
  senderName: string;
  kind: 'text' | 'offer';
  body: string | null;
  offerId: number | null;
  at: number;
  self: boolean;
}

/** A negotiated trade offer, from the viewing player's perspective. */
export interface OfferPub {
  id: number;
  conversationWith: number;   // the other player's id
  product: ProductId;
  side: OfferSide;            // from the ORIGINAL proposer's perspective
  buyerPlayer: number;
  sellerPlayer: number;
  buyerBizId: number;
  sellerBizId: number;
  qty: number;               // current actionable terms
  price: number;
  total: number;
  status: OfferStatus;
  proposedBy: number;        // who made the current version
  awaitingPlayer: number;    // who must respond
  version: number;
  expiresAt: number;
  iAmBuyer: boolean;
  canAct: boolean;           // true if it's my turn on a live offer
}

/** One entry in the conversation list. */
export interface ConversationSummary {
  otherId: number;
  otherName: string;
  otherCompany: string | null;
  online: boolean;
  lastBody: string | null;
  lastAt: number;
  unread: number;
}

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
  // ---- V2.7 Phase 1: City Chat + moderation ----
  | { t: 'get_chat' }
  | { t: 'chat_send'; body: string }
  | { t: 'chat_report'; messageId: number; reason: ChatReportReason; note?: string }
  | { t: 'admin_delete_chat'; messageId: number }
  | { t: 'admin_mute'; playerId: number; minutes?: number; reason?: string }
  | { t: 'admin_unmute'; playerId: number }
  // ---- V2.7 Phase 2: Admin & Live Ops ----
  | { t: 'admin_dashboard' }
  | { t: 'admin_search_players'; q: string }
  | { t: 'admin_player_detail'; playerId: number }
  | { t: 'admin_suspend'; playerId: number; suspend: boolean; reason?: string }
  | { t: 'admin_force_logout'; playerId: number; reason?: string }
  | { t: 'admin_cash'; playerId: number; op: AdminCashOp; amount: number; reason?: string }
  | { t: 'admin_inventory'; bizId: number; product: ProductId; op: AdminInvOp; amount: number; reason?: string }
  | { t: 'admin_wholesale'; product: ProductId; op: AdminWholesaleOp; amount?: number; reason?: string }
  | { t: 'admin_wholesale_refill_all'; reason?: string }
  | { t: 'admin_announce_edit'; id: number; title?: string; message?: string; priority?: AnnouncementPriority; durationSecs?: number }
  | { t: 'admin_announce_deactivate'; id: number }
  | { t: 'admin_rename_company'; playerId: number; name: string }
  | { t: 'admin_rename_business'; bizId: number; name: string }
  | { t: 'admin_hard_delete'; playerId: number; confirmName: string; reason?: string }
  | { t: 'admin_audit'; limit?: number }
  // ---- V2.7 Phase 3: direct messaging & offers ----
  | { t: 'get_conversations' }
  | { t: 'get_conversation'; otherId: number }
  | { t: 'dm_send'; toId: number; body: string }
  | { t: 'dm_report'; messageId: number; reason: ChatReportReason; note?: string }
  | { t: 'offer_create'; toBizId: number; fromBizId?: number; side: OfferSide; product: ProductId; qty: number; unitPrice: number; expiresSecs?: number }
  | { t: 'offer_counter'; offerId: number; qty: number; unitPrice: number; version: number }
  | { t: 'offer_accept'; offerId: number; version: number }
  | { t: 'offer_reject'; offerId: number }
  | { t: 'offer_cancel'; offerId: number }
  // ---- V2.7 Phase 4: urgent city orders, rival alerts, city news ----
  | { t: 'get_urgent_orders' }
  | { t: 'urgent_fulfill'; orderId: number; bizId?: number }
  | { t: 'get_city_news' }
  | { t: 'admin_create_urgent'; product: ProductId; qty: number; reward: number; durationSecs?: number; kind?: string }
  | { t: 'admin_cancel_urgent'; orderId: number; reason?: string }
  // ---- V2.8 Phase 1: product economy ----
  | { t: 'buy_license'; bizId: number; product: ProductId }
  | { t: 'set_product_active'; bizId: number; product: ProductId; active: boolean }
  | { t: 'admin_set_biz_xp'; bizId: number; xp: number; mode: 'set' | 'add'; reason?: string }
  | { t: 'admin_grant_license'; bizId: number; product: ProductId; reason?: string }
  | { t: 'admin_revoke_license'; bizId: number; product: ProductId; reason?: string }
  | { t: 'get_supply_economy' }
  // ---- V2.8 Phase 2: manual production ----
  | { t: 'start_production'; bizId: number; product: ProductId; qty: number }
  | { t: 'get_production'; bizId?: number }
  | { t: 'admin_production' }
  | { t: 'admin_production_complete'; jobId: number; reason?: string }
  | { t: 'admin_production_remove'; jobId: number; reason?: string }
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
  costBasis: number; // V2.8 Phase 3: weighted-avg acquisition $/unit (0 = unknown)
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
  level: number;        // facility upgrade tier (1–3) — unchanged legacy field
  bizLevel: number;     // V2.8: XP-driven Business Level (1–50)
  bizTier: string;      // V2.8: tier code (local/established/regional/major/city_icon)
  status: BizStatus;
  reputation: number;   // public: star rating
  supplies: ProductId[]; // products this business can supply via contract
  tradeCount: number;    // successful player trades + contract deliveries
}

// ---- V2.8 Phase 1: product-economy progression (owner-private detail) ----
export interface RecipePub { output: ProductId; outputQty: number; inputs: { product: ProductId; qty: number }[]; }
export interface OwnedLicensePub { product: ProductId; capability: 'produce' | 'retail'; active: boolean; recipe: RecipePub | null; }
export interface AvailableLicensePub {
  product: ProductId;
  capability: 'produce' | 'retail';
  requiredLevel: number;
  prereqLicense: ProductId | null;
  fee: number;
  recipe: RecipePub | null;
  met: boolean;               // all requirements satisfied (level + prereq + funds not checked here)
  levelMet: boolean;
  prereqMet: boolean;
}
export interface BusinessProgression {
  bizLevel: number;
  bizXp: number;
  tier: string;
  xpIntoLevel: number;        // xp accumulated within the current level
  xpForNextLevel: number;     // xp span of the current level (Infinity-safe: 0 at max)
  atMax: boolean;
  slotsUsed: number;
  slotLimit: number;
  nextRewardKind: string | null;   // 'slot' | 'tier' | 'storage' | null(at max)
  nextRewardLevel: number | null;
  owned: OwnedLicensePub[];
  available: AvailableLicensePub[];
}

// ---------- V2.8 Phase 2: manual production ----------
export type ProductionStatus = 'queued' | 'producing' | 'completed' | 'waiting_storage';

/** One production job on a business's line (owner-private). */
export interface ProductionJobPub {
  id: number;
  product: ProductId;
  outputQty: number;                 // finished units this job yields
  status: ProductionStatus;
  startedAt: number | null;          // epoch ms (null while queued)
  completesAt: number | null;        // epoch ms (null while queued)
  recipe: RecipePub;                 // snapshot taken at start (survives rebalancing)
  inputs: { product: ProductId; qty: number }[]; // ingredients already committed
}

/** A product this business can currently plan/produce, with a live input snapshot. */
export interface ProducibleProductPub {
  product: ProductId;
  recipe: RecipePub;
  onHand: { product: ProductId; qty: number }[]; // uncommitted stock of each input
  maxOutput: number;                 // ingredient-limited max output (server truth)
  batchSize: number;                 // output units per timing batch
  batchSecs: number;                 // seconds per timing batch (before level speed)
  // V2.8 Phase 3 profitability: ingredient cost per 1 output unit from real cost
  // basis (-1 = unavailable), and the NPC retail reference for the output.
  unitInputCost: number;
  retailPrice: number;
}

/** Owner-private production state for one business. */
export interface ProductionLinePub {
  queueLimit: number;                // producing + queued cap for this level
  jobCount: number;                  // producing + queued jobs currently on the line
  speedMult: number;                 // duration multiplier from business level (<=1)
  jobs: ProductionJobPub[];          // producing first, then queued in order
  producible: ProducibleProductPub[];// active PRODUCE-licensed recipes
  serverTime: number;                // authoritative clock for progress bars
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
  // V2.7 Phase 4 — minimal integration: the current live city order (if any)
  // and the player's most recent unseen rival alert (if any).
  urgentOrder?: UrgentOrderPub | null;
  rivalAlert?: RivalAlert | null;
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
  progression: BusinessProgression; // V2.8 Phase 1
  productionLine: ProductionLinePub | null; // V2.8 Phase 2 (null for non-producers)
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
  status: 'in_transit' | 'waiting' | 'delivered';
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
  | { t: 'biz_removed'; bizId: number }  // public: drop the business everywhere
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
  // ---- V2.7 Phase 1: City Chat ----
  | { t: 'chat_history'; messages: ChatMessagePub[]; muted: boolean; canModerate: boolean }
  | { t: 'chat'; message: ChatMessagePub }
  | { t: 'chat_deleted'; messageId: number }
  | { t: 'chat_muted'; muted: boolean; until: number | null; reason: string | null }
  // ---- V2.7 Phase 2: Admin & Live Ops ----
  | { t: 'admin_dashboard'; dashboard: AdminDashboard }
  | { t: 'admin_players'; results: AdminPlayerRow[] }
  | { t: 'admin_player_detail'; detail: AdminPlayerDetail }
  | { t: 'admin_audit'; entries: AdminAuditEntry[] }
  | { t: 'force_logout'; reason: string | null }
  // ---- V2.7 Phase 3: direct messaging & offers ----
  | { t: 'conversations'; list: ConversationSummary[] }
  | { t: 'conversation'; otherId: number; messages: DirectMessagePub[]; offers: OfferPub[] }
  | { t: 'dm'; otherId: number; message: DirectMessagePub }
  | { t: 'offer'; offer: OfferPub }
  // ---- V2.7 Phase 4: urgent city orders, rival alerts, city news ----
  | { t: 'urgent_orders'; orders: UrgentOrderPub[] }   // full snapshot (connect / request)
  | { t: 'urgent_order'; order: UrgentOrderPub }        // single upsert (realtime)
  | { t: 'rival_alerts'; alerts: RivalAlert[] }          // snapshot on connect
  | { t: 'rival_alert'; alert: RivalAlert }              // realtime push to the affected player
  | { t: 'city_news'; items: CityNewsItem[] }            // bounded feed snapshot
  | { t: 'city_news_item'; item: CityNewsItem }          // realtime append
  // ---- V2.8 Phase 1 ----
  | { t: 'supply_economy'; economy: SupplyEconomy }      // admin diagnostic
  // ---- V2.8 Phase 2 ----
  | { t: 'production_complete'; bizId: number; product: ProductId; qty: number; blocked: boolean }
  | { t: 'admin_production'; jobs: AdminProductionJob[] }
  | { t: 'pong' };

// V2.8 Phase 2 — admin view of a single job (operator inspection/recovery).
export interface AdminProductionJob {
  id: number;
  businessId: number;
  ownerName: string;
  product: ProductId;
  outputQty: number;
  status: ProductionStatus;
  startedAt: number | null;
  completesAt: number | null;
  serverTime: number;
}

// V2.8 — aggregate supply-economy health for the Admin Console (operator-only).
export interface SupplyEconomy {
  overall: { player: number; central: number; ratio: number; health: string };
  byProduct: { product: ProductId; player: number; central: number; ratio: number }[];
}

// ---------- V2.7 Phase 4 domain types ----------

export type UrgentOrderStatus = 'upcoming' | 'active' | 'fulfilled' | 'expired' | 'cancelled';
// A short-lived city procurement opportunity. Exactly one company can win it.
// The payload is fully public: it never carries any viewer's private state.
export interface UrgentOrderPub {
  id: number;
  kind: string;                    // locale-independent flavour code (see URGENT_ORDER_KINDS)
  product: ProductId;
  requiredQty: number;
  reward: number;
  status: UrgentOrderStatus;
  startsAt: number;
  expiresAt: number;
  winnerCompanyId: number | null;  // set once fulfilled
  winnerName: string | null;       // winning company's public name
  fulfilledAt: number | null;
  serverTime: number;              // authoritative clock for the countdown
}

// A rival alert derived only from committed market data. `id` is a stable
// dedupe key; `params` carries render values that are public/derived only.
export type RivalAlertType = 'market_share_overtaken' | 'price_undercut';
export interface RivalAlert {
  id: string;
  type: RivalAlertType;
  product: ProductId;
  rivalName: string;               // rival company's public name
  at: number;
  params: MsgParams;               // never secrets — units/prices only
}

// A city-news item generated from a real committed event. Rendered client-side
// via i18n from `params`; the payload is privacy-safe (no cash/inventory/etc).
export type CityNewsType =
  | 'city_order_win'
  | 'major_deal'
  | 'market_leader_change'
  | 'business_opened'
  | 'wholesale_low';
export interface CityNewsItem {
  id: number;
  type: CityNewsType;
  at: number;
  actorName: string | null;        // public company/player name
  product: ProductId | null;
  params: MsgParams;               // extra render values — never secrets
}
