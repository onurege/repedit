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
      // Drop the business for every client (frees the lot; no ghost building),
      // then refresh the remaining list.
      this.broadcast({ t: 'toast', code: 'toast.lot_opened', kind: 'info' });
      this.broadcast({ t: 'biz_removed', bizId });
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
    // V2.7 Phase 1: City Chat realtime fan-out.
    w.on('chat', (m: any) => {
      // Send each client its own `self` flag so the sender's line renders as theirs.
      for (const c of this.conns) {
        const self = m.authorName === this.world.players.get(c.playerId)?.name && m.kind === 'user';
        this.send(c.ws, { t: 'chat', message: { ...m, self } });
      }
    });
    w.on('chat_deleted', (messageId: number) => this.broadcast({ t: 'chat_deleted', messageId }));
    // V2.7 Phase 3: direct messaging & offers — fan out to the two parties only.
    w.on('dm', ({ fromId, toId, message }: { fromId: number; toId: number; message: any }) => {
      this.sendToPlayer(fromId, { t: 'dm', otherId: toId, message: { ...message, self: true } });
      this.sendToPlayer(toId, { t: 'dm', otherId: fromId, message: { ...message, self: false } });
    });
    w.on('offer', (o: any) => {
      this.sendToPlayer(o.buyerPlayer, { t: 'offer', offer: w.toOfferPub(o, o.buyerPlayer) });
      this.sendToPlayer(o.sellerPlayer, { t: 'offer', offer: w.toOfferPub(o, o.sellerPlayer) });
    });
    // V2.7 Phase 4: urgent orders + city news are public (broadcast); a rival
    // alert is private to the affected player.
    w.on('urgent_order', (order: any) => this.broadcast({ t: 'urgent_order', order }));
    w.on('city_news_item', (item: any) => this.broadcast({ t: 'city_news_item', item }));
    w.on('rival_alert', ({ playerId, alert }: { playerId: number; alert: any }) => {
      this.sendToPlayer(playerId, { t: 'rival_alert', alert });
    });
    // V2.8 Phase 2: production completed (or storage-blocked) — non-blocking
    // feedback to the owner; the fresh business state rides the push_state above.
    w.on('production_complete', ({ ownerId, bizId, product, qty, blocked }: { ownerId: number; bizId: number; product: any; qty: number; blocked: boolean }) => {
      this.sendToPlayer(ownerId, { t: 'production_complete', bizId, product, qty, blocked });
    });
    // V2.8 Phase 4: a bounded auto-repeat couldn't run (e.g. out of ingredients) —
    // notify the owner (never auto-buys). The fresh state rides push_state.
    w.on('production_repeat_failed', ({ ownerId, product, reason }: { ownerId: number; product: string; reason: string }) => {
      this.sendToPlayer(ownerId, { t: 'toast', code: `toast.repeat_failed.${reason}`, params: { product }, kind: 'info' });
    });
    // V2.7 Phase 2: admin realtime effects.
    w.on('push_state', ({ playerId }: { playerId: number }) => this.pushOwnState(playerId));
    w.on('admin_force_logout', ({ playerId, reason }: { playerId: number; reason: string | null }) => {
      for (const c of [...this.conns]) {
        if (c.playerId === playerId) {
          this.send(c.ws, { t: 'force_logout', reason });
          try { c.ws.close(4003, 'force_logout'); } catch { /* ignore */ }
        }
      }
    });
    w.on('player_deleted', ({ playerId, bizIds }: { playerId: number; bizIds: number[] }) => {
      // Drop the deleted player's buildings for everyone (no ghost lots), refresh
      // presence, and disconnect the deleted player (their sessions are gone).
      for (const bizId of bizIds) this.broadcast({ t: 'biz_removed', bizId });
      this.broadcastPlayers();
      for (const c of [...this.conns]) {
        if (c.playerId === playerId) {
          this.send(c.ws, { t: 'force_logout', reason: null });
          try { c.ws.close(4004, 'deleted'); } catch { /* ignore */ }
        }
      }
    });
    w.on('player_muted', ({ playerId, until, reason }: { playerId: number; until: number | null; reason: string | null }) => {
      // until:0 is the "unmuted" signal; otherwise the player is now muted.
      const muted = until !== 0;
      this.sendToPlayer(playerId, { t: 'chat_muted', muted, until: muted ? until : null, reason: muted ? reason : null });
    });
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
      // V2.7 Phase 2: a suspended player cannot enter authenticated gameplay.
      if (this.world.isSuspended(playerId)) {
        this.send(ws, { t: 'error', code: 'err.suspended' });
        ws.close(4003, 'suspended');
        return;
      }
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
      // V2.7 Phase 1: seed recent City Chat on connect.
      this.send(ws, {
        t: 'chat_history',
        messages: this.world.recentChat().map((m) => ({ ...m, self: m.authorName === p.name && m.kind === 'user' })),
        muted: this.world.isMuted(playerId),
        canModerate: this.world.isAdmin(playerId),
      });
      // V2.7 Phase 4: seed live urgent orders, recent city news, and any rival
      // alerts so a reconnecting client recovers state (§28).
      this.send(ws, { t: 'urgent_orders', orders: this.world.listUrgentOrders() });
      this.send(ws, { t: 'rival_alerts', alerts: this.world.getRivalAlerts(playerId) });
      this.world.cityNews().then((items) => this.send(ws, { t: 'city_news', items })).catch(() => {});
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
        case 'rename_business': {
          await world.renameBusiness(pid, msg.name, msg.bizId);
          this.pushOwnState(pid);
          this.send(conn.ws, { t: 'toast', code: 'toast.business_renamed', kind: 'success' });
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
        // ---- V2.7 Phase 1: City Chat + moderation ----
        case 'get_chat': {
          this.send(conn.ws, {
            t: 'chat_history',
            messages: world.recentChat().map((m) => ({ ...m, self: m.authorName === world.players.get(pid)?.name })),
            muted: world.isMuted(pid),
            canModerate: world.isAdmin(pid),
          });
          break;
        }
        case 'chat_send': {
          await world.sendChat(pid, msg.body);
          // broadcast handled by the 'chat' world event
          break;
        }
        case 'chat_report': {
          await world.reportChat(pid, msg.messageId, msg.reason, msg.note);
          this.send(conn.ws, { t: 'toast', code: 'toast.chat_reported', kind: 'info' });
          break;
        }
        case 'admin_delete_chat': {
          await world.adminDeleteChat(pid, msg.messageId);
          break;
        }
        case 'admin_mute': {
          await world.adminMute(pid, msg.playerId, msg.minutes, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.player_muted', kind: 'success' });
          break;
        }
        case 'admin_unmute': {
          await world.adminUnmute(pid, msg.playerId);
          this.send(conn.ws, { t: 'toast', code: 'toast.player_unmuted', kind: 'success' });
          break;
        }
        // ---- V2.7 Phase 2: Admin & Live Ops (all authorized inside world.*) ----
        case 'admin_dashboard':
          this.send(conn.ws, { t: 'admin_dashboard', dashboard: await world.adminDashboard(pid) });
          break;
        case 'admin_search_players':
          this.send(conn.ws, { t: 'admin_players', results: await world.adminSearchPlayers(pid, msg.q) });
          break;
        case 'admin_player_detail':
          this.send(conn.ws, { t: 'admin_player_detail', detail: await world.adminPlayerDetail(pid, msg.playerId) });
          break;
        case 'admin_suspend':
          await world.adminSuspend(pid, msg.playerId, msg.suspend, msg.reason);
          this.send(conn.ws, { t: 'toast', code: msg.suspend ? 'toast.admin_suspended' : 'toast.admin_unsuspended', kind: 'success' });
          break;
        case 'admin_force_logout':
          await world.adminForceLogout(pid, msg.playerId, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_forced_logout', kind: 'success' });
          break;
        case 'admin_cash':
          await world.adminSetCash(pid, msg.playerId, msg.op, msg.amount, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.send(conn.ws, { t: 'admin_player_detail', detail: await world.adminPlayerDetail(pid, msg.playerId) });
          break;
        case 'admin_inventory': {
          await world.adminSetInventory(pid, msg.bizId, msg.product, msg.op, msg.amount, msg.reason);
          const biz = world.businesses.get(msg.bizId);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          if (biz) this.send(conn.ws, { t: 'admin_player_detail', detail: await world.adminPlayerDetail(pid, biz.ownerId) });
          break;
        }
        case 'admin_wholesale':
          await world.adminWholesale(pid, msg.product, msg.op, msg.amount, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          break;
        case 'admin_wholesale_refill_all':
          await world.adminWholesaleRefillAll(pid, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          break;
        case 'admin_announce_edit': {
          const a = await world.adminEditAnnouncement(pid, msg.id, { title: msg.title, message: msg.message, priority: msg.priority, durationSecs: msg.durationSecs });
          this.broadcast({ t: 'announcement', announcement: a });
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          break;
        }
        case 'admin_announce_deactivate':
          await world.adminDeactivateAnnouncement(pid, msg.id);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          break;
        case 'admin_rename_company': {
          await world.adminRenameCompany(pid, msg.playerId, msg.name);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.send(conn.ws, { t: 'admin_player_detail', detail: await world.adminPlayerDetail(pid, msg.playerId) });
          break;
        }
        case 'admin_rename_business': {
          await world.adminRenameBusiness(pid, msg.bizId, msg.name);
          const biz = world.businesses.get(msg.bizId);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          if (biz) this.send(conn.ws, { t: 'admin_player_detail', detail: await world.adminPlayerDetail(pid, biz.ownerId) });
          break;
        }
        case 'admin_hard_delete':
          await world.adminHardDeletePlayer(pid, msg.playerId, msg.confirmName);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_deleted', kind: 'success' });
          break;
        case 'admin_audit':
          this.send(conn.ws, { t: 'admin_audit', entries: await world.adminRecentAudit(pid, msg.limit) });
          break;
        // ---- V2.7 Phase 3: direct messaging & offers ----
        case 'get_conversations':
          this.send(conn.ws, { t: 'conversations', list: await world.listConversations(pid) });
          break;
        case 'get_conversation': {
          const { messages, offers } = await world.getConversation(pid, msg.otherId);
          this.send(conn.ws, { t: 'conversation', otherId: msg.otherId, messages, offers });
          break;
        }
        case 'dm_send':
          await world.sendDirectMessage(pid, msg.toId, msg.body);
          break;
        case 'dm_report':
          await world.reportDirectMessage(pid, msg.messageId, msg.reason, msg.note);
          this.send(conn.ws, { t: 'toast', code: 'toast.chat_reported', kind: 'info' });
          break;
        case 'offer_create':
          await world.createOffer(pid, msg.toBizId, msg.side, msg.product, msg.qty, msg.unitPrice, msg.expiresSecs, msg.fromBizId);
          break;
        case 'offer_counter':
          await world.counterOffer(pid, msg.offerId, msg.qty, msg.unitPrice, msg.version);
          break;
        case 'offer_accept':
          await world.acceptOffer(pid, msg.offerId, msg.version);
          this.send(conn.ws, { t: 'toast', code: 'toast.offer_accepted', kind: 'success' });
          break;
        case 'offer_reject':
          await world.rejectOffer(pid, msg.offerId);
          break;
        case 'offer_cancel':
          await world.cancelOffer(pid, msg.offerId);
          break;
        // ---- V2.7 Phase 4: urgent orders, city news ----
        case 'get_urgent_orders':
          this.send(conn.ws, { t: 'urgent_orders', orders: world.listUrgentOrders() });
          break;
        case 'urgent_fulfill': {
          const order = await world.fulfillUrgentOrder(pid, msg.orderId, msg.bizId);
          this.send(conn.ws, { t: 'toast', code: 'toast.urgent_won', params: { reward: order.reward, product: order.product }, kind: 'success' });
          break;
        }
        case 'get_city_news':
          this.send(conn.ws, { t: 'city_news', items: await world.cityNews() });
          break;
        case 'admin_create_urgent': {
          const order = await world.createUrgentOrder(pid, { product: msg.product, qty: msg.qty, reward: msg.reward, durationSecs: msg.durationSecs, kind: msg.kind });
          this.send(conn.ws, { t: 'toast', code: 'toast.urgent_created', params: { id: order.id }, kind: 'success' });
          break;
        }
        case 'admin_cancel_urgent':
          await world.cancelUrgentOrder(pid, msg.orderId, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.urgent_cancelled', kind: 'info' });
          break;
        // ---- V2.8 Phase 1: product economy ----
        case 'buy_license': {
          const biz = await world.buyLicense(pid, msg.bizId, msg.product);
          this.send(conn.ws, { t: 'my_biz', biz: world.toBizPriv(biz) });
          this.send(conn.ws, { t: 'toast', code: 'toast.license_bought', params: { product: msg.product }, kind: 'success' });
          break;
        }
        case 'set_product_active': {
          const biz = await world.setProductActive(pid, msg.bizId, msg.product, msg.active);
          this.send(conn.ws, { t: 'my_biz', biz: world.toBizPriv(biz) });
          break;
        }
        case 'admin_set_biz_xp': {
          const biz = await world.adminSetBizXp(pid, msg.bizId, msg.xp, msg.mode);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.broadcast({ t: 'biz', biz: world.toBizPub(biz) });
          break;
        }
        case 'admin_grant_license': {
          const biz = await world.adminGrantLicense(pid, msg.bizId, msg.product);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.sendToPlayer(biz.ownerId, { t: 'my_biz', biz: world.toBizPriv(biz) });
          break;
        }
        case 'admin_revoke_license': {
          const biz = await world.adminRevokeLicense(pid, msg.bizId, msg.product);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.sendToPlayer(biz.ownerId, { t: 'my_biz', biz: world.toBizPriv(biz) });
          break;
        }
        case 'get_supply_economy': {
          world.requireAdmin(pid);
          this.send(conn.ws, { t: 'supply_economy', economy: await world.playerSourcedRatio() });
          break;
        }
        // ---- V2.8 Phase 2: manual production ----
        case 'start_production': {
          const biz = await world.startProduction(pid, msg.bizId, msg.product, msg.qty, msg.repeat);
          this.send(conn.ws, { t: 'my_biz', biz: world.toBizPriv(biz) });
          this.send(conn.ws, { t: 'toast', code: 'toast.production_started', params: { product: msg.product }, kind: 'success' });
          break;
        }
        case 'choose_specialization': {
          const biz = await world.chooseSpecialization(pid, msg.bizId, msg.specId);
          this.send(conn.ws, { t: 'my_biz', biz: world.toBizPriv(biz) });
          this.send(conn.ws, { t: 'toast', code: 'toast.specialized', params: { spec: msg.specId }, kind: 'success' });
          this.broadcast({ t: 'biz', biz: world.toBizPub(biz) });
          break;
        }
        case 'admin_set_specialization': {
          const biz = await world.adminSetSpecialization(pid, msg.bizId, msg.specId);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.sendToPlayer(biz.ownerId, { t: 'my_biz', biz: world.toBizPriv(biz) });
          this.broadcast({ t: 'biz', biz: world.toBizPub(biz) });
          break;
        }
        case 'get_production': {
          const biz = msg.bizId != null ? world.businesses.get(msg.bizId) : world.bizByOwner(pid);
          if (!biz || biz.ownerId !== pid) throw new GameError('err.unknown_business');
          this.send(conn.ws, { t: 'my_biz', biz: world.toBizPriv(biz) });
          break;
        }
        case 'admin_production':
          this.send(conn.ws, { t: 'admin_production', jobs: await world.adminProductionJobs(pid) });
          break;
        case 'admin_production_complete':
          await world.adminCompleteProduction(pid, msg.jobId, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.send(conn.ws, { t: 'admin_production', jobs: await world.adminProductionJobs(pid) });
          break;
        case 'admin_production_remove':
          await world.adminRemoveProduction(pid, msg.jobId, msg.reason);
          this.send(conn.ws, { t: 'toast', code: 'toast.admin_done', kind: 'success' });
          this.send(conn.ws, { t: 'admin_production', jobs: await world.adminProductionJobs(pid) });
          break;
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
