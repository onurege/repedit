// All HTML UI: auth, business choice, HUD, management/market/wholesale
// panels, onboarding objectives, toasts, away report, reconnect overlay.
import {
  PRODUCTS, NPC_WHOLESALE_PRICES, FARM_LEVELS, SHOP_LEVELS, MAX_LEVEL,
  xpForLevel, MAX_PLAYER_LEVEL,
  type BizPub, type OrderPub, type AwayReport, type ProductId,
} from '@district/shared';
import { client } from '../net.js';
import { sfx, unlockAudio } from '../audio.js';

type PanelKind = 'none' | 'business' | 'market' | 'wholesale' | 'dev' | 'info';

const fmt = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

export class UI {
  private root: HTMLElement;
  private hud!: HTMLElement;
  private panel!: HTMLElement;
  private panelKind: PanelKind = 'none';
  private panelTab = '';
  private infoBizId: number | null = null;
  private flags: Record<string, boolean> = {};
  private objectivesHidden = false;

  onFocusLot: ((lotId: string) => void) | null = null;

  constructor() {
    this.root = document.getElementById('app')!;
    document.addEventListener('pointerdown', () => unlockAudio(), { once: true });
    this.buildHud();
    client.on('update', () => this.refresh());
    client.on('toast', (msg: string, kind: string) => this.toast(msg, kind as any));
    client.on('away', (r: AwayReport) => this.showAway(r));
    client.on('level_up', (level: number) => {
      sfx.levelUp();
      this.toast(`Level up! You reached level ${level} 🎉`, 'success');
    });
    client.on('connection', (ok: boolean) => {
      document.getElementById('reconnect')!.classList.toggle('visible', !ok && !!client.token);
    });
  }

  private loadFlags(): void {
    if (!client.you) return;
    try {
      this.flags = JSON.parse(localStorage.getItem(`bd_flags_${client.you.id}`) || '{}');
    } catch {
      this.flags = {};
    }
  }

  private setFlag(name: string): void {
    if (!client.you || this.flags[name]) return;
    this.flags[name] = true;
    localStorage.setItem(`bd_flags_${client.you.id}`, JSON.stringify(this.flags));
    this.refresh();
  }

  // ================= AUTH =================

  showAuth(initialError = ''): void {
    this.hud.classList.remove('visible');
    let mode: 'login' | 'register' = 'register';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'auth-overlay';
    overlay.innerHTML = `
      <div class="card">
        <h1>BUSINESS <span class="accent">DISTRICT</span></h1>
        <div class="tagline">Build your business in a shared miniature city.</div>
        <div class="tabs">
          <button data-mode="register" class="active">New player</button>
          <button data-mode="login">Log in</button>
        </div>
        <div class="auth-error">${initialError}</div>
        <div class="field"><label>Username</label><input id="auth-user" maxlength="20" placeholder="e.g. barista_joe" /></div>
        <div class="field"><label>Password</label><input id="auth-pass" type="password" placeholder="min. 4 characters" /></div>
        <button class="btn primary" id="auth-go">Create account &amp; play</button>
        <div class="hint">Tip: open a second browser (or private window) with another account to trade with yourself.</div>
      </div>`;
    document.body.appendChild(overlay);
    const err = overlay.querySelector('.auth-error') as HTMLElement;
    const go = overlay.querySelector('#auth-go') as HTMLButtonElement;
    overlay.querySelectorAll('.tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        overlay.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        mode = (b as HTMLElement).dataset.mode as any;
        go.textContent = mode === 'register' ? 'Create account & play' : 'Log in & play';
        sfx.click();
      })
    );
    const submit = async () => {
      const username = (overlay.querySelector('#auth-user') as HTMLInputElement).value.trim();
      const password = (overlay.querySelector('#auth-pass') as HTMLInputElement).value;
      go.disabled = true;
      err.textContent = '';
      try {
        await client.auth(mode, username, password);
        overlay.remove();
        client.connect();
      } catch (e: any) {
        err.textContent = e.message;
        go.disabled = false;
        sfx.error();
      }
    };
    go.addEventListener('click', submit);
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }

  // ================= CHOOSE BUSINESS =================

  showChoose(): void {
    if (document.getElementById('choose-overlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'choose-overlay';
    overlay.innerHTML = `
      <div class="card" style="width:min(560px,94vw)">
        <h1>Choose your business</h1>
        <div class="tagline">You have <b>${fmt(client.you?.cash ?? 10000)}</b> to get started. Pick your path:</div>
        <div class="choose-wrap">
          <div class="choice" data-type="farm">
            <div class="icon">🐄</div>
            <h3>Farm</h3>
            <p>Produce fresh milk automatically. Sell it to coffee shops on the player marketplace for steady profit.</p>
          </div>
          <div class="choice" data-type="coffee_shop">
            <div class="icon">☕</div>
            <h3>Coffee Shop</h3>
            <p>Buy milk &amp; beans, brew coffee, and serve a stream of townsfolk. Set your own prices.</p>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('.choice').forEach((c) =>
      c.addEventListener('click', () => {
        sfx.click();
        client.send({ t: 'choose_business', type: (c as HTMLElement).dataset.type as any });
        overlay.remove();
      })
    );
  }

  hideChoose(): void {
    document.getElementById('choose-overlay')?.remove();
  }

  // ================= HUD =================

  private buildHud(): void {
    this.hud = document.createElement('div');
    this.hud.id = 'hud';
    this.hud.innerHTML = `
      <div class="topbar">
        <div class="stat"><span class="k">Cash</span><span class="v" id="st-cash">$0</span></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">Profit</span><span class="v" id="st-profit">$0</span></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">Level</span><span class="v" id="st-level">1</span><div class="xpbar"><div id="st-xp" style="width:0%"></div></div></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">Reputation</span><span class="v" id="st-rep">★ 3.0</span></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">Online</span><span class="v" id="st-online">1</span></div>
      </div>
      <div class="nav">
        <button id="nav-city">🏙️ City</button>
        <button id="nav-biz">🏪 Business</button>
        <button id="nav-market">📦 Market</button>
        <button id="nav-dev" style="display:none">🛠️ Dev</button>
      </div>
      <div class="panel" id="panel">
        <div class="panel-head"><h2 id="panel-title">Panel</h2><button class="close" id="panel-close">✕</button></div>
        <div class="panel-tabs" id="panel-tabs"></div>
        <div class="panel-body" id="panel-body"></div>
      </div>
      <div class="objectives" id="objectives" style="display:none"></div>
      <div class="controls-hint">WASD pan · drag rotate · wheel zoom · click select · R reset</div>
    `;
    document.body.appendChild(this.hud);
    const toasts = document.createElement('div');
    toasts.id = 'toasts';
    document.body.appendChild(toasts);
    const rec = document.createElement('div');
    rec.id = 'reconnect';
    rec.innerHTML = `<div class="spinner"></div><div>Reconnecting to the city…</div>`;
    document.body.appendChild(rec);

    document.getElementById('nav-city')!.addEventListener('click', () => {
      sfx.click();
      this.closePanel();
    });
    document.getElementById('nav-biz')!.addEventListener('click', () => {
      sfx.click();
      this.openBusiness();
    });
    document.getElementById('nav-market')!.addEventListener('click', () => {
      sfx.click();
      this.openPanel('market');
      this.setFlag('opened_market');
    });
    document.getElementById('nav-dev')!.addEventListener('click', () => {
      sfx.click();
      this.openPanel('dev');
    });
    document.getElementById('panel-close')!.addEventListener('click', () => {
      sfx.click();
      this.closePanel();
    });
    this.panel = document.getElementById('panel')!;
  }

  showHud(): void {
    this.hud.classList.add('visible');
    this.loadFlags();
    this.refresh();
  }

  openBusiness(): void {
    if (!client.myBiz) return;
    this.setFlag('opened_business');
    this.openPanel('business');
    if (this.onFocusLot) this.onFocusLot(client.myBiz.lotId);
  }

  openWholesale(): void {
    this.openPanel('wholesale');
  }

  openInfo(bizId: number): void {
    this.infoBizId = bizId;
    this.openPanel('info');
  }

  openPanel(kind: PanelKind): void {
    this.panelKind = kind;
    this.panelTab = '';
    this.lastBodyHTML = '';
    this.lastTabsHTML = '';
    this.panel.classList.add('visible');
    this.renderPanel();
    this.updateNav();
  }

  closePanel(): void {
    this.panelKind = 'none';
    this.panel.classList.remove('visible');
    this.updateNav();
  }

  private updateNav(): void {
    document.getElementById('nav-city')!.classList.toggle('active', this.panelKind === 'none');
    document.getElementById('nav-biz')!.classList.toggle('active', this.panelKind === 'business');
    document.getElementById('nav-market')!.classList.toggle('active', this.panelKind === 'market');
    document.getElementById('nav-dev')!.classList.toggle('active', this.panelKind === 'dev');
  }

  // ================= REFRESH =================

  refresh(): void {
    const you = client.you;
    if (!you) return;
    document.getElementById('nav-dev')!.style.display = client.devTools ? '' : 'none';
    (document.getElementById('st-cash') as HTMLElement).textContent = fmt(you.cash);
    const biz = client.myBiz;
    const profit = biz ? biz.revenue - biz.expenses : 0;
    const profitEl = document.getElementById('st-profit')!;
    profitEl.textContent = (profit >= 0 ? '+' : '−') + fmt(Math.abs(profit)).slice(0);
    profitEl.className = 'v ' + (profit >= 0 ? 'pos' : 'neg');
    (document.getElementById('st-level') as HTMLElement).textContent = String(you.level);
    const lo = xpForLevel(you.level);
    const hi = you.level >= MAX_PLAYER_LEVEL ? lo + 1 : xpForLevel(you.level + 1);
    const pct = Math.min(100, Math.round(((you.xp - lo) / Math.max(1, hi - lo)) * 100));
    (document.getElementById('st-xp') as HTMLElement).style.width =
      (you.level >= MAX_PLAYER_LEVEL ? 100 : pct) + '%';
    (document.getElementById('st-rep') as HTMLElement).textContent =
      '★ ' + (biz ? biz.reputation.toFixed(1) : you.reputation.toFixed(1));
    (document.getElementById('st-online') as HTMLElement).textContent = String(client.online);
    this.renderObjectives();
    if (this.panelKind !== 'none') this.renderPanel();
  }

  // ================= PANEL RENDERING =================

  private lastBodyHTML = '';
  private lastTabsHTML = '';

  /**
   * Replace panel body DOM only when the rendered HTML actually changed.
   * Keeps buttons stable across the 1 Hz server updates so clicks never
   * land on a freshly detached element.
   */
  private setBody(body: HTMLElement, html: string, bind?: (b: HTMLElement) => void): void {
    if (html === this.lastBodyHTML) return;
    this.lastBodyHTML = html;
    body.innerHTML = html;
    bind?.(body);
  }

  private renderPanel(): void {
    const title = document.getElementById('panel-title')!;
    const tabs = document.getElementById('panel-tabs')!;
    const body = document.getElementById('panel-body')!;
    // Don't clobber a form the user is typing in.
    const active = document.activeElement as HTMLElement | null;
    if (active && body.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
      return;
    }
    switch (this.panelKind) {
      case 'business':
        this.renderBusinessPanel(title, tabs, body);
        break;
      case 'market':
        this.renderMarketPanel(title, tabs, body);
        break;
      case 'wholesale':
        this.renderWholesalePanel(title, tabs, body);
        break;
      case 'dev':
        this.renderDevPanel(title, tabs, body);
        break;
      case 'info':
        this.renderInfoPanel(title, tabs, body);
        break;
    }
  }

  private tabBar(tabs: HTMLElement, names: string[]): string {
    if (!this.panelTab || !names.includes(this.panelTab)) this.panelTab = names[0];
    const html = names
      .map((n) => `<button data-tab="${n}" class="${n === this.panelTab ? 'active' : ''}">${n}</button>`)
      .join('');
    if (html !== this.lastTabsHTML) {
      this.lastTabsHTML = html;
      tabs.innerHTML = html;
      tabs.querySelectorAll('button').forEach((b) =>
        b.addEventListener('click', () => {
          sfx.click();
          this.panelTab = (b as HTMLElement).dataset.tab!;
          this.lastBodyHTML = '';
          this.lastTabsHTML = '';
          this.renderPanel();
        })
      );
    }
    return this.panelTab;
  }

  private renderBusinessPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    const biz = client.myBiz;
    if (!biz) {
      title.textContent = 'No business yet';
      tabs.innerHTML = '';
      this.setBody(body, '<p>Choose a business to get started.</p>');
      return;
    }
    const isFarm = biz.type === 'farm';
    title.textContent = isFarm ? `🐄 ${biz.ownerName}'s Farm` : `☕ ${biz.ownerName}'s Coffee Shop`;
    const tab = this.tabBar(tabs, isFarm
      ? ['Overview', 'Inventory', 'Production', 'Upgrade']
      : ['Overview', 'Inventory', 'Pricing', 'Upgrade']);

    const profit = biz.revenue - biz.expenses;
    if (tab === 'Overview') {
      const statusClass = /FULL|OUT|PAUSED/.test(biz.status) ? 'bad' : 'ok';
      this.setBody(body, `
        <div class="bigstatus ${statusClass}">${biz.status || '—'}</div>
        <div class="kv"><span class="k">Level</span><span class="v">${biz.level} / ${MAX_LEVEL}</span></div>
        <div class="kv"><span class="k">Revenue (lifetime)</span><span class="v pos">${fmt(biz.revenue)}</span></div>
        <div class="kv"><span class="k">Expenses (lifetime)</span><span class="v neg">${fmt(biz.expenses)}</span></div>
        <div class="kv"><span class="k">Profit</span><span class="v ${profit >= 0 ? 'pos' : 'neg'}">${fmt(profit)}</span></div>
        ${isFarm
          ? `<div class="kv"><span class="k">Milk produced</span><span class="v">${biz.milkProduced}</span></div>`
          : `<div class="kv"><span class="k">Coffee sold</span><span class="v">${biz.coffeeSold}</span></div>
             <div class="kv"><span class="k">Customers</span><span class="v">${biz.customers}</span></div>`}
        <div class="kv"><span class="k">Reputation</span><span class="v">★ ${biz.reputation.toFixed(2)}</span></div>
        ${!isFarm ? `<div class="hint">Restock milk &amp; beans from the Market (player offers) or Central Wholesale (click the blue depot).</div>` : `<div class="hint">Sell your milk on the Market — coffee shops need it! Central Wholesale charges them $${NPC_WHOLESALE_PRICES.milk} per milk, so undercut that.</div>`}
      `);
    } else if (tab === 'Inventory') {
      this.setBody(body, Object.entries(biz.inventory)
        .map(([pid, e]) => {
          const p = PRODUCTS[pid as ProductId];
          const used = e.qty + e.reserved;
          const pct = e.capacity > 0 ? Math.min(100, (used / e.capacity) * 100) : 0;
          return `<div class="invrow">
            <span class="emoji">${p.emoji}</span>
            <span class="name">${p.name}
              <div class="capbar"><div style="width:${pct}%"></div></div>
            </span>
            <span>
              <span class="qty">${e.qty}</span>
              <span class="cap">/ ${e.capacity}</span><br/>
              <span class="cap">${e.reserved ? `${e.reserved} on market · ` : ''}${e.incoming ? `${e.incoming} incoming 🚚` : ''}</span>
            </span>
          </div>`;
        })
        .join('') +
        `<div class="hint">Reserved goods are listed on the marketplace. Incoming goods are on a delivery van.</div>`);
    } else if (tab === 'Production' && isFarm) {
      const lv = FARM_LEVELS[biz.level];
      this.setBody(body, `
        <div class="bigstatus ${biz.status === 'PRODUCING' ? 'ok' : 'bad'}">${biz.status}</div>
        <div class="kv"><span class="k">Production rate</span><span class="v">${(lv.milkPerSec * 60).toFixed(0)} milk / min</span></div>
        <div class="kv"><span class="k">Storage capacity</span><span class="v">${lv.milkCapacity}</span></div>
        <div class="kv"><span class="k">Milk produced (lifetime)</span><span class="v">${biz.milkProduced}</span></div>
        <div class="hint">Milk is produced automatically, even while you're offline (up to 8 hours). When storage is full, production pauses — sell milk on the Market to keep the cows busy!</div>`);
    } else if (tab === 'Pricing' && !isFarm) {
      this.setBody(body, `
        <div class="kv"><span class="k">Current coffee price</span><span class="v">${fmt(biz.price)}</span></div>
        <div class="qtyrow">
          <input id="price-input" type="number" min="5" max="100" value="${biz.price}" />
          <button class="btn small primary" id="price-set">Set price</button>
        </div>
        <div class="hint">Base price is $30. Cheaper coffee attracts more customers and builds reputation; pricing above ~$36 slows traffic and hurts your stars. Each coffee consumes 1 milk + 1 beans.</div>`, (b) => {
        b.querySelector('#price-set')!.addEventListener('click', () => {
          const v = parseInt((b.querySelector('#price-input') as HTMLInputElement).value, 10);
          client.send({ t: 'set_price', price: v });
          sfx.click();
        });
      });
    } else if (tab === 'Upgrade') {
      const cost = isFarm ? FARM_LEVELS[biz.level].upgradeCost : SHOP_LEVELS[biz.level].upgradeCost;
      const next = biz.level + 1;
      let improvements = '';
      if (cost != null) {
        if (isFarm) {
          const a = FARM_LEVELS[biz.level];
          const b = FARM_LEVELS[next];
          improvements = `
            <div class="kv"><span class="k">Milk / min</span><span class="v">${(a.milkPerSec * 60).toFixed(0)} → <b class="pos">${(b.milkPerSec * 60).toFixed(0)}</b></span></div>
            <div class="kv"><span class="k">Storage</span><span class="v">${a.milkCapacity} → <b class="pos">${b.milkCapacity}</b></span></div>`;
        } else {
          const a = SHOP_LEVELS[biz.level];
          const b = SHOP_LEVELS[next];
          improvements = `
            <div class="kv"><span class="k">Customers / min</span><span class="v">~${(a.customersPerSec * 60).toFixed(0)} → <b class="pos">~${(b.customersPerSec * 60).toFixed(0)}</b></span></div>
            <div class="kv"><span class="k">Brew speed</span><span class="v">${(a.brewPerSec * 60).toFixed(0)} → <b class="pos">${(b.brewPerSec * 60).toFixed(0)}</b> / min</span></div>
            <div class="kv"><span class="k">Ingredient storage</span><span class="v">${a.ingredientCapacity} → <b class="pos">${b.ingredientCapacity}</b></span></div>`;
        }
      }
      const html = cost == null
        ? `<div class="bigstatus ok">MAX LEVEL REACHED 🏆</div><p class="hint">Your ${isFarm ? 'farm' : 'coffee shop'} is fully upgraded.</p>`
        : `
        <div class="kv"><span class="k">Current level</span><span class="v">${biz.level}</span></div>
        ${improvements}
        <div style="margin-top:14px">
          <button class="btn success" style="width:100%" id="do-upgrade" ${((client.you?.cash ?? 0) < cost) ? 'disabled' : ''}>
            Upgrade to Level ${next} — ${fmt(cost)}
          </button>
        </div>
        <div class="hint">Upgrading visibly expands your building in the city.</div>`;
      this.setBody(body, html, (b) => {
        b.querySelector('#do-upgrade')?.addEventListener('click', () => {
          client.send({ t: 'upgrade' });
        });
      });
    }
  }

  private renderMarketPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = '📦 Marketplace';
    const tab = this.tabBar(tabs, ['Orders', 'My Orders', 'History']);
    const myId = client.you?.id;
    if (tab === 'Orders') {
      const orders = [...client.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
      const rows = orders.map((o) => this.orderRow(o, o.ownerId !== myId)).join('');
      this.setBody(body, `
        <div class="mkt-form">
          <h4>Create order</h4>
          <div class="mkt-row">
            <select id="mo-side"><option value="sell">SELL</option><option value="buy">BUY</option></select>
            <select id="mo-product"><option value="milk">Milk</option><option value="beans">Coffee Beans</option></select>
            <input id="mo-qty" type="number" min="1" value="100" style="width:76px" title="Quantity" />
            <span>@</span>
            <input id="mo-price" type="number" min="1" value="12" style="width:64px" title="Unit price ($)" />
          </div>
          <button class="btn small primary" id="mo-create">Place order</button>
          <div class="hint">SELL escrows your goods; BUY escrows your cash. NPC wholesale milk costs $${NPC_WHOLESALE_PRICES.milk} — player milk is usually cheaper.</div>
        </div>
        ${rows || '<p class="hint">No open orders. Create one above!</p>'}`, (b) => {
        b.querySelector('#mo-create')!.addEventListener('click', () => {
          const side = (b.querySelector('#mo-side') as HTMLSelectElement).value as 'buy' | 'sell';
          const product = (b.querySelector('#mo-product') as HTMLSelectElement).value as ProductId;
          const qty = parseInt((b.querySelector('#mo-qty') as HTMLInputElement).value, 10);
          const price = parseInt((b.querySelector('#mo-price') as HTMLInputElement).value, 10);
          client.send({ t: 'order_create', side, product, qty, price });
          this.setFlag('created_order');
          sfx.click();
        });
        this.bindOrderButtons(b);
      });
    } else if (tab === 'My Orders') {
      const mine = [...client.orders.values()].filter((o) => o.ownerId === myId);
      this.setBody(body,
        (mine.map((o) => `
          <div class="order">
            <span class="side ${o.side}">${o.side.toUpperCase()}</span>
            <span class="grow">${PRODUCTS[o.product].emoji} ${o.remaining}/${o.qty} ${PRODUCTS[o.product].name} @ ${fmt(o.price)}</span>
            <button class="btn small warn" data-cancel="${o.id}">Cancel</button>
          </div>`).join('') || '<p class="hint">You have no open orders.</p>') +
        `<div class="hint">Cancelling refunds escrowed cash / returns reserved goods.</div>`, (bd) => {
        bd.querySelectorAll('[data-cancel]').forEach((b) =>
          b.addEventListener('click', () => {
            client.send({ t: 'order_cancel', orderId: parseInt((b as HTMLElement).dataset.cancel!, 10) });
            sfx.click();
          })
        );
      });
    } else {
      this.setBody(body,
        `<h4 style="font-size:13px;color:#334155;margin-bottom:6px">Recent player trades</h4>` +
        (client.trades.map((t) => `
          <div class="trade-row">${PRODUCTS[t.product].emoji} <b>${t.qty}</b> ${PRODUCTS[t.product].name} @ ${fmt(t.price)} — <b>${t.sellerName}</b> → <b>${t.buyerName}</b></div>`).join('') ||
          '<p class="hint">No trades yet. Be the first!</p>'));
    }
  }

  private orderRow(o: OrderPub, canFulfill: boolean): string {
    const p = PRODUCTS[o.product];
    const action = canFulfill
      ? `<input type="number" min="1" max="${o.remaining}" value="${o.remaining}" data-qty-for="${o.id}" />
         <button class="btn small ${o.side === 'buy' ? 'success' : 'primary'}" data-fulfill="${o.id}">
           ${o.side === 'buy' ? 'Sell to' : 'Buy from'}</button>`
      : `<span class="who">your order</span>`;
    return `<div class="order">
      <span class="side ${o.side}">${o.side.toUpperCase()}</span>
      <span class="grow">${p.emoji} <b>${o.remaining}</b> ${p.name} @ <b>${fmt(o.price)}</b><br/>
      <span class="who">${o.side === 'buy' ? 'wanted by' : 'offered by'} ${o.ownerName}</span></span>
      ${action}
    </div>`;
  }

  private bindOrderButtons(body: HTMLElement): void {
    body.querySelectorAll('[data-fulfill]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = parseInt((b as HTMLElement).dataset.fulfill!, 10);
        const qtyInput = body.querySelector(`[data-qty-for="${id}"]`) as HTMLInputElement | null;
        const qty = qtyInput ? parseInt(qtyInput.value, 10) : 1;
        client.send({ t: 'order_fulfill', orderId: id, qty });
        sfx.click();
      })
    );
  }

  private renderWholesalePanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = '🏭 Central Wholesale';
    tabs.innerHTML = '';
    const rows = (['beans', 'milk'] as ProductId[])
      .map((pid) => {
        const price = NPC_WHOLESALE_PRICES[pid]!;
        return `<div class="invrow">
          <span class="emoji">${PRODUCTS[pid].emoji}</span>
          <span class="name">${PRODUCTS[pid].name}<br/><span class="cap" style="white-space:nowrap">${fmt(price)} / unit</span></span>
          <input type="number" min="1" value="50" style="width:70px;padding:7px;border:1.5px solid #dbe3ee;border-radius:8px" data-npc-qty="${pid}" />
          <button class="btn small primary" data-npc-buy="${pid}">Buy</button>
        </div>`;
      })
      .join('');
    this.setBody(body, `
      ${rows}
      <div class="hint">The NPC wholesaler guarantees supply so your shop never stalls — but player milk on the Market is usually cheaper. Goods arrive by delivery van.</div>`, (bd) => {
      bd.querySelectorAll('[data-npc-buy]').forEach((b) =>
        b.addEventListener('click', () => {
          const pid = (b as HTMLElement).dataset.npcBuy as ProductId;
          const qty = parseInt((bd.querySelector(`[data-npc-qty="${pid}"]`) as HTMLInputElement).value, 10);
          client.send({ t: 'buy_npc', product: pid, qty });
          sfx.purchase();
        })
      );
    });
  }

  private renderInfoPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    tabs.innerHTML = '';
    const biz = this.infoBizId != null ? client.businesses.get(this.infoBizId) : null;
    if (!biz) {
      title.textContent = 'Business';
      this.setBody(body, '<p class="hint">This lot is vacant.</p>');
      return;
    }
    const isFarm = biz.type === 'farm';
    title.textContent = `${isFarm ? '🐄' : '☕'} ${biz.ownerName}'s ${isFarm ? 'Farm' : 'Coffee Shop'}`;
    const online = client.players.find((p) => p.id === biz.ownerId)?.online;
    this.setBody(body, `
      <div class="kv"><span class="k">Owner</span><span class="v">${biz.ownerName} ${online ? '🟢' : '⚪'}</span></div>
      <div class="kv"><span class="k">Type</span><span class="v">${isFarm ? 'Dairy Farm' : 'Coffee Shop'}</span></div>
      <div class="kv"><span class="k">Level</span><span class="v">${biz.level} / ${MAX_LEVEL}</span></div>
      <div class="kv"><span class="k">Status</span><span class="v">${biz.status || '—'}</span></div>
      <div class="hint">${isFarm ? 'Farms sell milk on the marketplace — check the Market for their offers.' : 'Coffee shops buy milk — check the Market for their buy orders.'}</div>`);
  }

  private renderDevPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = '🛠️ Dev Tools';
    tabs.innerHTML = '';
    this.setBody(body, `
      <div class="hint" style="margin-bottom:10px">Development-only helpers (disabled in production builds).</div>
      <div class="mkt-row"><button class="btn small ghost" data-dev="add_money" data-val="5000">+ $5,000</button>
      <button class="btn small ghost" data-dev="add_milk" data-val="100">+ 100 Milk</button>
      <button class="btn small ghost" data-dev="add_beans" data-val="100">+ 100 Beans</button></div>
      <div class="mkt-row"><span style="font-size:13px">Game speed:</span>
      <button class="btn small ghost" data-dev="speed" data-val="1">×1</button>
      <button class="btn small ghost" data-dev="speed" data-val="5">×5</button>
      <button class="btn small ghost" data-dev="speed" data-val="20">×20</button></div>
      <div class="mkt-row"><button class="btn small warn" data-dev="reset_business">Reset my business</button></div>
      <div class="kv"><span class="k">Open orders</span><span class="v">${client.orders.size}</span></div>
      <div class="kv"><span class="k">Deliveries in transit</span><span class="v">${client.deliveries.size}</span></div>
      <div class="kv"><span class="k">Businesses</span><span class="v">${client.businesses.size}</span></div>
      <div style="margin-top:12px"><button class="btn small ghost" id="dev-logout">Log out</button></div>`, (bd) => {
      bd.querySelectorAll('[data-dev]').forEach((b) =>
        b.addEventListener('click', () => {
          const el = b as HTMLElement;
          if (el.dataset.dev === 'reset_business' && !confirm('Really reset your business?')) return;
          client.send({ t: 'dev', cmd: el.dataset.dev!, value: el.dataset.val ? parseInt(el.dataset.val, 10) : undefined });
          sfx.click();
        })
      );
      bd.querySelector('#dev-logout')!.addEventListener('click', () => client.logout());
    });
  }

  // ================= OBJECTIVES =================

  private renderObjectives(): void {
    const el = document.getElementById('objectives')!;
    const biz = client.myBiz;
    if (!biz || this.objectivesHidden) {
      el.style.display = 'none';
      return;
    }
    const isFarm = biz.type === 'farm';
    const tradedWithMe = client.trades.some(
      (t) => t.buyerName === client.you?.name || t.sellerName === client.you?.name
    );
    const objs: [string, boolean][] = isFarm
      ? [
          ['Open your Farm', !!this.flags.opened_business],
          ['Produce Milk', biz.milkProduced > 0],
          ['Open the Marketplace', !!this.flags.opened_market],
          ['Create a Sell Order', !!this.flags.created_order],
          ['Complete a player trade', tradedWithMe || biz.revenue > 0],
          ['Upgrade your Farm', biz.level >= 2],
        ]
      : [
          ['Open your Coffee Shop', !!this.flags.opened_business],
          ['Buy Coffee Beans', (biz.inventory.beans?.qty ?? 0) + (biz.inventory.beans?.incoming ?? 0) > 0 || biz.expenses > 0],
          ['Buy Milk', (biz.inventory.milk?.qty ?? 0) + (biz.inventory.milk?.incoming ?? 0) > 0],
          ['Make your first sale', biz.coffeeSold > 0],
          ['Open the Marketplace', !!this.flags.opened_market],
          ['Upgrade your Coffee Shop', biz.level >= 2],
        ];
    const allDone = objs.every(([, d]) => d);
    if (allDone) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const html =
      `<h3>Objectives <button id="obj-hide">hide</button></h3>` +
      objs
        .map(([name, done]) => `<div class="obj ${done ? 'done' : ''}"><span class="tick">${done ? '✓' : '·'}</span>${name}</div>`)
        .join('');
    if (html === this.lastObjHTML) return;
    this.lastObjHTML = html;
    el.innerHTML = html;
    el.querySelector('#obj-hide')!.addEventListener('click', () => {
      this.objectivesHidden = true;
      el.style.display = 'none';
    });
  }
  private lastObjHTML = '';

  // ================= MISC =================

  toast(msg: string, kind: 'info' | 'success' | 'error' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = msg;
    document.getElementById('toasts')!.appendChild(el);
    if (kind === 'error') sfx.error();
    setTimeout(() => {
      el.style.transition = 'opacity 0.4s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 450);
    }, 3200);
  }

  showAway(r: AwayReport): void {
    const biz = client.myBiz;
    const hours = Math.floor(r.seconds / 3600);
    const mins = Math.floor((r.seconds % 3600) / 60);
    const dur = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    const overlay = document.createElement('div');
    overlay.className = 'overlay modal';
    overlay.innerHTML = `
      <div class="card">
        <h1>While you were away</h1>
        <div class="tagline">Your ${biz?.type === 'farm' ? 'farm kept working' : 'shop kept serving'} for ${dur}.</div>
        <div class="away-grid">
          <div class="away-cell"><div class="k">Revenue</div><div class="v" style="color:#16a34a">${fmt(r.revenue)}</div></div>
          <div class="away-cell"><div class="k">Expenses</div><div class="v" style="color:#dc2626">${fmt(r.expenses)}</div></div>
          <div class="away-cell"><div class="k">Profit</div><div class="v">${fmt(r.profit)}</div></div>
          ${biz?.type === 'farm'
            ? `<div class="away-cell"><div class="k">Milk produced</div><div class="v">🥛 ${r.milkProduced}</div></div>`
            : `<div class="away-cell"><div class="k">Coffee sold</div><div class="v">☕ ${r.coffeeSold}</div></div>`}
        </div>
        <button class="btn primary" id="away-ok">Back to business</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#away-ok')!.addEventListener('click', () => {
      sfx.click();
      overlay.remove();
    });
  }
}
