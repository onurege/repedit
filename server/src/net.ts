// WebSocket layer: authenticates connections, routes client intent to
// the World, and pushes authoritative state to clients.
import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import type { ClientMsg, ServerMsg } from '@district/shared';
import { World, GameError, type BizRec } from './game/world.js';
import { playerIdForToken } from './auth.js';
import { config } from './config.js';

interface Conn {
  ws: WebSocket;
  playerId: number;
}

export class Net {
  private wss: WebSocketServer;
  private conns = new Set<Conn>();

  constructor(private world: World, httpServer: Server) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? ''));
    this.wireWorldEvents();
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) {
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  private sendToPlayer(playerId: number, msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) {
      if (c.playerId === playerId && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
    }
  }

  private broadcastPlayers(): void {
    this.broadcast({
      t: 'players',
      players: [...this.world.players.values()].map((p) => this.world.toPlayerPub(p)),
      online: this.world.onlineCount(),
    });
  }

  private pushOwnState(playerId: number): void {
    const p = this.world.players.get(playerId);
    if (!p) return;
    this.sendToPlayer(playerId, { t: 'you', you: this.world.toPlayerPriv(p) });
    const biz = this.world.bizByOwner(playerId);
    if (biz) this.sendToPlayer(playerId, { t: 'my_biz', biz: this.world.toBizPriv(biz) });
  }

  private wireWorldEvents(): void {
    const w = this.world;
    w.on('tick', () => {
      // Push each connected player their own private state every second.
      const seen = new Set<number>();
      for (const c of this.conns) {
        if (!seen.has(c.playerId)) {
          seen.add(c.playerId);
          this.pushOwnState(c.playerId);
        }
      }
    });
    w.on('sale', (e: { bizId: number; lotId: string; amount: number }) => {
      this.broadcast({ t: 'sale', bizId: e.bizId, lotId: e.lotId, amount: e.amount });
    });
    w.on('lost_customer', (e: { bizId: number; lotId: string }) => {
      this.broadcast({ t: 'lost_customer', bizId: e.bizId, lotId: e.lotId });
    });
    w.on('biz_created', (biz: BizRec) => {
      this.broadcast({ t: 'biz', biz: w.toBizPub(biz) });
      this.pushOwnState(biz.ownerId);
    });
    w.on('upgraded', ({ biz }: { biz: BizRec }) => {
      this.broadcast({ t: 'biz', biz: w.toBizPub(biz) });
      this.pushOwnState(biz.ownerId);
    });
    w.on('biz_removed', ({ bizId }: { bizId: number; lotId: string }) => {
      // Simplest correct refresh: clients get full biz list on next join;
      // for live clients broadcast a status-less stub they interpret as removal.
      this.broadcast({ t: 'toast', msg: 'A lot opened up in the district.', kind: 'info' });
      this.broadcastBizList();
    });
    w.on('order', (o: any) => {
      if (o.status === 'open') {
        this.broadcast({ t: 'order', order: w.toOrderPub(o) });
      } else {
        this.broadcast({ t: 'order_removed', orderId: o.id });
      }
    });
    w.on('order_removed', ({ orderId }: { orderId: number }) => {
      this.broadcast({ t: 'order_removed', orderId });
    });
    w.on('delivery', (d: any) => {
      this.broadcast({ t: 'delivery', delivery: w.toDeliveryPub(d) });
    });
    w.on('delivery_done', (d: any) => {
      this.broadcast({ t: 'delivery_done', deliveryId: d.id });
      const biz = w.businesses.get(d.toBusinessId);
      if (biz) this.pushOwnState(biz.ownerId);
    });
    w.on('trade', (trade: any) => {
      this.broadcast({ t: 'trade', trade });
    });
    w.on('level_up', ({ playerId, level }: { playerId: number; level: number }) => {
      this.sendToPlayer(playerId, { t: 'level_up', level });
      this.broadcastPlayers();
    });
    w.on('presence', () => this.broadcastPlayers());
  }

  private broadcastBizList(): void {
    for (const b of this.world.businesses.values()) {
      this.broadcast({ t: 'biz', biz: this.world.toBizPub(b) });
    }
  }

  private async onConnection(ws: WebSocket, url: string): Promise<void> {
    try {
      const token = new URL(url, 'http://x').searchParams.get('token') ?? '';
      const playerId = token ? await playerIdForToken(token) : null;
      if (!playerId) {
        this.send(ws, { t: 'error', msg: 'Invalid session. Please log in again.' });
        ws.close(4001, 'unauthorized');
        return;
      }
      await this.world.ensurePlayer(playerId);
      const conn: Conn = { ws, playerId };
      this.conns.add(conn);
      const awayReport = this.world.connect(playerId);

      const p = this.world.players.get(playerId)!;
      const biz = this.world.bizByOwner(playerId);
      this.send(ws, {
        t: 'welcome',
        you: this.world.toPlayerPriv(p),
        biz: biz ? this.world.toBizPriv(biz) : null,
        businesses: [...this.world.businesses.values()].map((b) => this.world.toBizPub(b)),
        orders: [...this.world.orders.values()].map((o) => this.world.toOrderPub(o)),
        deliveries: [...this.world.deliveries.values()].map((d) => this.world.toDeliveryPub(d)),
        players: [...this.world.players.values()].map((pp) => this.world.toPlayerPub(pp)),
        online: this.world.onlineCount(),
        devTools: config.devTools,
        serverTime: Date.now(),
      });
      this.world.recentTrades().then((trades) => this.send(ws, { t: 'trades', trades }));
      if (awayReport) this.send(ws, { t: 'away', report: awayReport });
      this.broadcastPlayers();

      ws.on('message', (raw) => this.onMessage(conn, raw.toString()));
      ws.on('close', () => {
        this.conns.delete(conn);
        this.world.disconnect(playerId);
        this.broadcastPlayers();
      });
      ws.on('error', () => ws.close());
    } catch (err) {
      console.error('[net] connection failed', err);
      try {
        ws.close(1011);
      } catch {}
    }
  }

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const { world } = this;
    const pid = conn.playerId;
    try {
      switch (msg.t) {
        case 'ping':
          this.send(conn.ws, { t: 'pong' });
          break;
        case 'choose_business': {
          await world.chooseBusiness(pid, msg.type);
          this.send(conn.ws, {
            t: 'toast',
            msg: msg.type === 'farm' ? 'Welcome to your new farm!' : 'Your coffee shop is open!',
            kind: 'success',
          });
          break;
        }
        case 'buy_npc':
          await world.buyNpc(pid, msg.product, msg.qty);
          this.pushOwnState(pid);
          break;
        case 'order_create':
          await world.createOrder(pid, msg.side, msg.product, msg.qty, msg.price);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', msg: 'Order placed on the marketplace.', kind: 'success' });
          break;
        case 'order_cancel':
          await world.cancelOrder(pid, msg.orderId);
          this.pushOwnState(pid);
          break;
        case 'order_fulfill': {
          const trade = await world.fulfillOrder(pid, msg.orderId, msg.qty);
          this.pushOwnState(pid);
          this.pushOwnState(trade.buyerName === '' ? pid : pid); // own state pushed; counterparty below
          for (const p of world.players.values()) {
            if (p.name === trade.buyerName || p.name === trade.sellerName) this.pushOwnState(p.id);
          }
          this.send(conn.ws, {
            t: 'toast',
            msg: `Trade complete: ${trade.qty} × ${trade.product} @ $${trade.price}. Delivery on its way!`,
            kind: 'success',
          });
          break;
        }
        case 'upgrade':
          await world.upgrade(pid);
          this.send(conn.ws, { t: 'toast', msg: 'Upgrade complete!', kind: 'success' });
          break;
        case 'set_price':
          world.setPrice(pid, msg.price);
          this.pushOwnState(pid);
          break;
        case 'dev': {
          if (!config.devTools) throw new GameError('Dev tools are disabled.');
          const result = await world.devCommand(pid, msg.cmd, msg.value);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', msg: `[dev] ${result}`, kind: 'info' });
          if (msg.cmd === 'reset_business') this.broadcastBizList();
          break;
        }
      }
    } catch (err) {
      if (err instanceof GameError) {
        this.send(conn.ws, { t: 'error', msg: err.message });
      } else {
        console.error('[net] action failed', err);
        this.send(conn.ws, { t: 'error', msg: 'Something went wrong on the server.' });
      }
    }
  }
}
