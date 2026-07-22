// Client networking: auth REST + WebSocket game connection with
// automatic reconnect. Holds the client-side mirror of server state.
// The server is authoritative — on every (re)connect the full snapshot
// replaces local state.
import type {
  ServerMsg,
  ClientMsg,
  PlayerPriv,
  PlayerPub,
  BizPub,
  BizPriv,
  OrderPub,
  DeliveryPub,
  TradeRow,
  AwayReport,
  ContractPub,
} from '@district/shared';
import { t } from './i18n.js';

// Server URL resolution:
//  - explicit VITE_SERVER_URL always wins (set it at build time to point at a
//    separate API host);
//  - otherwise in dev the API runs on :2567 alongside the Vite dev server;
//  - otherwise (production build, no override) use the page's own origin, so a
//    reverse proxy (e.g. Caddy) can serve the client and proxy /api + /ws.
const env = (import.meta as any).env ?? {};
const SERVER_URL: string =
  env.VITE_SERVER_URL ||
  (env.DEV ? 'http://localhost:2567' : (typeof location !== 'undefined' ? location.origin : 'http://localhost:2567'));

type Handler = (...args: any[]) => void;

export class GameClient {
  you: PlayerPriv | null = null;
  myBiz: BizPriv | null = null;
  businesses = new Map<number, BizPub>();
  orders = new Map<number, OrderPub>();
  deliveries = new Map<number, DeliveryPub>();
  players: PlayerPub[] = [];
  online = 0;
  devTools = false;
  trades: TradeRow[] = [];
  contracts = new Map<number, ContractPub>();
  connected = false;

  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private reconnectDelay = 1000;
  private shouldReconnect = false;

  on(event: string, fn: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }

  emit(event: string, ...args: any[]): void {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }

  get token(): string | null {
    return localStorage.getItem('bd_token');
  }

  get username(): string | null {
    return localStorage.getItem('bd_username');
  }

  async auth(kind: 'login' | 'register', username: string, password: string): Promise<void> {
    const res = await fetch(`${SERVER_URL}/api/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.code ? t(data.code) : t('auth.failed'));
    localStorage.setItem('bd_token', data.token);
    localStorage.setItem('bd_username', data.username);
  }

  logout(): void {
    this.shouldReconnect = false;
    localStorage.removeItem('bd_token');
    localStorage.removeItem('bd_username');
    this.ws?.close();
    location.reload();
  }

  connect(): void {
    const token = this.token;
    if (!token) return;
    this.shouldReconnect = true;
    const wsUrl = SERVER_URL.replace(/^http/, 'ws') + `/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 1000;
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data) as ServerMsg);
    ws.onclose = (e) => {
      this.connected = false;
      this.emit('connection', false);
      if (e.code === 4001) {
        // bad token
        localStorage.removeItem('bd_token');
        this.emit('unauthorized');
        return;
      }
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(10000, this.reconnectDelay * 1.7);
      }
    };
    ws.onerror = () => ws.close();
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome': {
        this.you = msg.you;
        this.myBiz = msg.biz;
        this.businesses = new Map(msg.businesses.map((b) => [b.id, b]));
        this.orders = new Map(msg.orders.map((o) => [o.id, o]));
        this.deliveries = new Map(msg.deliveries.map((d) => [d.id, d]));
        this.contracts = new Map(msg.contracts.map((c) => [c.id, c]));
        this.players = msg.players;
        this.online = msg.online;
        this.devTools = msg.devTools;
        this.connected = true;
        this.emit('connection', true);
        this.emit('welcome');
        this.emit('update');
        break;
      }
      case 'you':
        this.you = msg.you;
        this.emit('update');
        break;
      case 'my_biz':
        this.myBiz = msg.biz;
        this.businesses.set(msg.biz.id, msg.biz);
        this.emit('update');
        break;
      case 'biz':
        this.businesses.set(msg.biz.id, msg.biz);
        if (this.myBiz && msg.biz.id === this.myBiz.id) {
          Object.assign(this.myBiz, { level: msg.biz.level, status: msg.biz.status });
        }
        this.emit('biz', msg.biz);
        this.emit('update');
        break;
      case 'order':
        if (msg.order.remaining > 0) this.orders.set(msg.order.id, msg.order);
        else this.orders.delete(msg.order.id);
        this.emit('update');
        break;
      case 'order_removed':
        this.orders.delete(msg.orderId);
        this.emit('update');
        break;
      case 'contract': {
        const prev = this.contracts.get(msg.contract.id);
        const terminal = ['completed', 'rejected', 'cancelled'].includes(msg.contract.status);
        this.contracts.set(msg.contract.id, msg.contract);
        this.emit('contract', msg.contract, prev);
        this.emit('update');
        if (terminal) {
          // keep terminal contracts client-side for the History view
        }
        break;
      }
      case 'contracts':
        for (const c of msg.contracts) this.contracts.set(c.id, c);
        this.emit('update');
        break;
      case 'delivery':
        this.deliveries.set(msg.delivery.id, msg.delivery);
        this.emit('delivery', msg.delivery);
        this.emit('update');
        break;
      case 'delivery_done': {
        const d = this.deliveries.get(msg.deliveryId);
        this.deliveries.delete(msg.deliveryId);
        const toBiz = d ? [...this.businesses.values()].find((b) => b.lotId === d.toLot) : undefined;
        this.emit('delivery_done', {
          id: msg.deliveryId,
          product: d?.product,
          qty: d?.qty,
          toBizId: toBiz?.id,
        });
        this.emit('update');
        break;
      }
      case 'sale':
        this.emit('sale', msg);
        break;
      case 'lost_customer':
        this.emit('lost_customer', msg);
        break;
      case 'trade':
        this.trades.unshift(msg.trade);
        this.trades = this.trades.slice(0, 30);
        this.emit('trade', msg.trade);
        this.emit('update');
        break;
      case 'trades':
        this.trades = msg.trades;
        this.emit('update');
        break;
      case 'players':
        this.players = msg.players;
        this.online = msg.online;
        this.emit('update');
        break;
      case 'away':
        this.emit('away', msg.report);
        break;
      case 'toast':
        // Server sends codes, never prose — resolve in the player's language.
        this.emit('toast', t(msg.code, msg.params), msg.kind ?? 'info');
        break;
      case 'error':
        this.emit('toast', t(msg.code, msg.params), 'error');
        break;
      case 'level_up':
        this.emit('level_up', msg.level);
        break;
    }
  }
}

export const client = new GameClient();
