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

export interface BizPub {
  id: number;
  ownerId: number;
  ownerName: string;
  type: BusinessType;
  lotId: string;
  level: number;
  status: string; // PRODUCING | STORAGE FULL | OPEN | OUT OF STOCK ...
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
  | { t: 'away'; report: AwayReport }
  | { t: 'toast'; msg: string; kind?: 'info' | 'success' | 'error' }
  | { t: 'error'; msg: string }
  | { t: 'level_up'; level: number }
  | { t: 'pong' };
