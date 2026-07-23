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
    const company = this.world.companyByOwner(playerId);
    if (company) this.sendToPlayer(playerId, { t: 'company', company: this.world.toCompanyPriv(company) });
    for (const biz of this.world.bizesByOwner(playerId)) {
      this.sendToPlayer(playerId, { t: 'my_biz', biz: this.world.toBizPriv(biz) });
    }
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
    w.on('company', (company: { ownerId: number }) => {
      const rec = w.companyByOwner(company.ownerId);
      if (rec) this.sendToPlayer(company.ownerId, { t: 'company', company: w.toCompanyPriv(rec) });
    });
    w.on('company_levelup', ({ ownerId, level }: { ownerId: number; level: number }) => {
      const rec = w.companyByOwner(ownerId);
      if (rec) this.sendToPlayer(ownerId, { t: 'company', company: w.toCompanyPriv(rec) });
      this.sendToPlayer(ownerId, { t: 'toast', code: 'toast.company_levelup', params: { level }, kind: 'success' });
    });
    w.on('biz_pub', (biz: BizRec) => {
      this.broadcast({ t: 'biz', biz: w.toBizPub(biz) });
    });
    w.on('my_biz_removed', ({ ownerId, bizId }: { ownerId: number; bizId: number }) => {
      this.sendToPlayer(ownerId, { t: 'my_biz_removed', bizId });
    });
    w.on('upgraded', ({ biz }: { biz: BizRec }) => {
      this.broadcast({ t: 'biz', biz: w.toBizPub(biz) });
      this.pushOwnState(biz.ownerId);
    });
    w.on('biz_removed', ({ bizId }: { bizId: number; lotId: string }) => {
      // Simplest correct refresh: clients get full biz list on next join;
      // for live clients broadcast a status-less stub they interpret as removal.
      this.broadcast({ t: 'toast', code: 'toast.lot_opened', kind: 'info' });
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
    w.on('contract', (c: any) => {
      // Contracts are private to their two parties.
      const pub = w.toContractPub(c);
      this.sendToPlayer(c.buyerId, { t: 'contract', contract: pub });
      this.sendToPlayer(c.sellerId, { t: 'contract', contract: pub });
      // A successful execution changes both businesses' public tradeCount.
      const bBiz = w.businesses.get(c.buyerBizId);
      if (bBiz) this.broadcast({ t: 'biz', biz: w.toBizPub(bBiz) });
      const sBiz = w.businesses.get(c.sellerBizId);
      if (sBiz) this.broadcast({ t: 'biz', biz: w.toBizPub(sBiz) });
    });
    w.on('level_up', ({ playerId, level }: { playerId: number; level: number }) => {
      this.sendToPlayer(playerId, { t: 'level_up', level });
      this.broadcastPlayers();
    });
    w.on('city_market', () => {
      this.broadcast({ t: 'city_market', market: w.toCityMarket() });
    });
    w.on('wholesale', () => {
      this.broadcast({ t: 'wholesale', wholesale: w.toWholesaleState() });
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
        this.send(ws, { t: 'error', code: 'err.invalid_session' });
        ws.close(4001, 'unauthorized');
        return;
      }
      await this.world.ensurePlayer(playerId);
      const conn: Conn = { ws, playerId };
      this.conns.add(conn);
      const awayReport = this.world.connect(playerId);

      const p = this.world.players.get(playerId)!;
      const company = this.world.companyByOwner(playerId);
      this.send(ws, {
        t: 'welcome',
        you: this.world.toPlayerPriv(p),
        company: company ? this.world.toCompanyPriv(company) : null,
        myBusinesses: this.world.bizesByOwner(playerId).map((b) => this.world.toBizPriv(b)),
        businesses: [...this.world.businesses.values()].map((b) => this.world.toBizPub(b)),
        orders: [...this.world.orders.values()].map((o) => this.world.toOrderPub(o)),
        deliveries: [...this.world.deliveries.values()].map((d) => this.world.toDeliveryPub(d)),
        players: [...this.world.players.values()].map((pp) => this.world.toPlayerPub(pp)),
        contracts: [],
        online: this.world.onlineCount(),
        devTools: config.devTools,
        serverTime: Date.now(),
      });
      this.send(ws, { t: 'city_market', market: this.world.toCityMarket() });
      this.send(ws, { t: 'wholesale', wholesale: this.world.toWholesaleState() });
      this.world.recentTrades().then((trades) => this.send(ws, { t: 'trades', trades }));
      this.world.contractsForPlayer(playerId).then((contracts) => this.send(ws, { t: 'contracts', contracts }));
      // V2.4 player experience: tutorial state, "What's New", brief, announcements.
      // Resolve the tutorial first — creating it seeds a new player's "seen
      // updates" so they get the tutorial, not an update backlog.
      this.world.getTutorial(playerId)
        .then((state) => {
          this.send(ws, { t: 'tutorial', state });
          return this.world.unseenUpdates(playerId);
        })
        .then((unseen) => this.send(ws, { t: 'updates', unseen, all: this.world.allUpdates() }))
        .catch(() => {});
      this.world.buildBrief(playerId, awayReport).then((brief) => {
        if (brief) this.send(ws, { t: 'brief', brief });
      }).catch((e) => console.error('[brief] failed', e));
      Promise.all([this.world.activeAnnouncements(), this.world.announcementHistory()])
        .then(([active, history]) => this.send(ws, { t: 'announcements', active, history })).catch(() => {});
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
          this.send(conn.ws, { t: 'toast', code: `toast.welcome.${msg.type}`, kind: 'success' });
          break;
        }
        case 'open_business': {
          const biz = await world.openBusiness(pid, msg.lotId, msg.type);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', code: `toast.business_opened.${biz.type}`, kind: 'success' });
          break;
        }
        case 'rename_company': {
          await world.renameCompany(pid, msg.name);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', code: 'toast.company_renamed', kind: 'success' });
          break;
        }
        case 'buy_npc':
          await world.buyNpc(pid, msg.product, msg.qty, msg.bizId);
          this.pushOwnState(pid);
          break;
        case 'order_create':
          await world.createOrder(pid, msg.side, msg.product, msg.qty, msg.price, msg.bizId);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', code: 'toast.order_placed', kind: 'success' });
          break;
        case 'order_cancel':
          await world.cancelOrder(pid, msg.orderId);
          this.pushOwnState(pid);
          break;
        case 'order_fulfill': {
          const trade = await world.fulfillOrder(pid, msg.orderId, msg.qty, msg.bizId);
          this.pushOwnState(pid);
          this.pushOwnState(trade.buyerName === '' ? pid : pid); // own state pushed; counterparty below
          for (const p of world.players.values()) {
            if (p.name === trade.buyerName || p.name === trade.sellerName) this.pushOwnState(p.id);
          }
          this.send(conn.ws, {
            t: 'toast',
            code: 'toast.trade_complete',
            params: { qty: trade.qty, product: trade.product, price: trade.price },
            kind: 'success',
          });
          break;
        }
        case 'upgrade':
          await world.upgrade(pid, msg.bizId);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', code: 'toast.upgrade_complete', kind: 'success' });
          break;
        case 'set_price':
          world.setPrice(pid, msg.price, msg.product, msg.bizId);
          this.pushOwnState(pid);
          break;
        case 'set_production':
          world.setProduction(pid, msg.product, msg.bizId);
          this.pushOwnState(pid);
          break;
        case 'contract_propose': {
          const c = await world.proposeContract(pid, msg.sellerBizId, msg.product, msg.quantity, msg.unitPrice, msg.deliveries, msg.buyerBizId);
          this.send(conn.ws, { t: 'toast', code: 'toast.contract_proposed', params: { name: world.players.get(c.sellerId)?.name ?? '' }, kind: 'success' });
          break;
        }
        case 'contract_accept': {
          const c = await world.acceptContract(pid, msg.contractId);
          this.sendToPlayer(c.buyerId, { t: 'toast', code: 'toast.contract_accepted', kind: 'success' });
          this.send(conn.ws, { t: 'toast', code: 'toast.contract_active', kind: 'success' });
          break;
        }
        case 'contract_reject':
          await world.rejectContract(pid, msg.contractId);
          this.send(conn.ws, { t: 'toast', code: 'toast.contract_rejected', kind: 'info' });
          break;
        case 'contract_cancel':
          await world.cancelContract(pid, msg.contractId);
          this.send(conn.ws, { t: 'toast', code: 'toast.contract_cancelled', kind: 'info' });
          break;
        case 'get_rankings': {
          const rankings = await world.computeCityRankings(pid);
          this.send(conn.ws, { t: 'rankings', rankings });
          break;
        }
        case 'get_company_profile': {
          const profile = await world.computeCompanyProfile(msg.companyId, pid);
          if (profile) this.send(conn.ws, { t: 'company_profile', profile });
          break;
        }
        case 'get_city_market':
          this.send(conn.ws, { t: 'city_market', market: world.toCityMarket() });
          break;
        case 'get_wholesale':
          this.send(conn.ws, { t: 'wholesale', wholesale: world.toWholesaleState() });
          break;
        case 'city_status':
          this.send(conn.ws, { t: 'city_status', status: world.getCityStatus() });
          break;
        case 'get_brief': {
          const brief = await world.buildBrief(pid, null);
          if (brief) this.send(conn.ws, { t: 'brief', brief });
          break;
        }
        case 'ack_update':
          await world.markUpdateSeen(pid, msg.updateId);
          break;
        case 'tutorial_advance': {
          const state = await world.advanceTutorial(pid, msg.step);
          this.send(conn.ws, { t: 'tutorial', state });
          break;
        }
        case 'tutorial_skip': {
          const state = await world.skipTutorial(pid);
          this.send(conn.ws, { t: 'tutorial', state });
          break;
        }
        case 'get_announcements': {
          const [active, history] = await Promise.all([world.activeAnnouncements(), world.announcementHistory()]);
          this.send(conn.ws, { t: 'announcements', active, history });
          break;
        }
        case 'create_announcement': {
          const a = await world.createAnnouncement(pid, {
            title: msg.title, message: msg.message, kind: msg.kind, priority: msg.priority, durationSecs: msg.durationSecs,
          });
          this.broadcast({ t: 'announcement', announcement: a });
          this.send(conn.ws, { t: 'toast', code: 'toast.announcement_sent', kind: 'success' });
          break;
        }
        case 'dev': {
          if (!config.devTools) throw new GameError('err.dev_disabled');
          const result = await world.devCommand(pid, msg.cmd, msg.value, msg.bizId);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', code: 'toast.dev', params: { result }, kind: 'info' });
          if (msg.cmd === 'reset_business') this.broadcastBizList();
          break;
        }
      }
    } catch (err) {
      if (err instanceof GameError) {
        this.send(conn.ws, { t: 'error', code: err.code, params: err.params });
      } else {
        // Game messages never contain credentials, so logging the payload is safe
        // and gives enough context to diagnose economic failures.
        console.error(`[econ] action failed player=${pid} msg=${JSON.stringify(msg)}`, err);
        this.send(conn.ws, { t: 'error', code: 'err.server' });
      }
    }
  }
}
