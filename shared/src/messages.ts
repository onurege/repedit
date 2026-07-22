// ============================================================
// Wire protocol between client and server (JSON over WebSocket).
// The client only ever sends INTENT; the server owns all state.
// ============================================================

import type { BusinessType, ProductId } from './defs.js';

// ---------- client -> server ----------
export type ClientMsg =
  | { t: 'choose_business'; type: BusinessType }
  | { t: 'buy_npc'; product: ProductId; qty: number }
  | { t: 'order_create'; side: 'buy' | 'sell'; product: ProductId; qty: number; price: number }
  | { t: 'order_cancel'; orderId: number }
  | { t: 'order_fulfill'; orderId: number; qty: number }
  | { t: 'upgrade' }
  | { t: 'set_price'; price: number; product?: ProductId }
  | { t: 'set_production'; product: ProductId }
  | { t: 'contract_propose'; sellerBizId: number; product: ProductId; quantity: number; unitPrice: number; deliveries: number }
  | { t: 'contract_accept'; contractId: number }
  | { t: 'contract_reject'; contractId: number }
  | { t: 'contract_cancel'; contractId: number }
  | { t: 'dev'; cmd: string; value?: number }
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
  type: BusinessType;
  lotId: string;
  level: number;
  status: BizStatus;
  reputation: number;   // public: star rating
  supplies: ProductId[]; // products this business can supply via contract
  tradeCount: number;    // successful player trades + contract deliveries
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
      biz: BizPriv | null;
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
  | { t: 'biz'; biz: BizPub }             // someone else's business upsert
  | { t: 'my_biz'; biz: BizPriv }          // your business detail
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
  | { t: 'pong' };
