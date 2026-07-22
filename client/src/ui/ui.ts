// All HTML UI: auth, business choice, HUD, management/market/wholesale/
// contract panels, onboarding objectives, toasts, away report, reconnect.
//
// Every visible string goes through `t()` — see ../i18n.ts. Tabs, statuses
// and contract results are identified by stable ids so switching language
// never changes behaviour, only labels.
import {
  PRODUCTS, NPC_WHOLESALE_PRICES, FARM_LEVELS, SHOP_LEVELS, BAKERY_LEVELS, MARKET_LEVELS,
  MAX_LEVEL, xpForLevel, MAX_PLAYER_LEVEL, contractableProducts, BAD_STATUSES,
  CONTRACT_FREQUENCY_SECS, LOTS, BUSINESS_CAPACITY, businessOpenCost,
  companyCapacity, COMPANY_NAME_MIN, COMPANY_NAME_MAX,
  type BizPub, type OrderPub, type AwayReport, type ProductId, type ContractPub,
  type BusinessType, type CompanyProfile, type RankingBoard, type CityRankings,
} from '@district/shared';
import { client } from '../net.js';
import { sfx, unlockAudio } from '../audio.js';
import { t, fmtMoney as fmt, LANGS, getLang, setLang, onLangChange, type Lang } from '../i18n.js';

const BIZ_ICON: Record<string, string> = {
  farm: '🐄', coffee_shop: '☕', bakery: '🥖', mini_market: '🛒',
};

type PanelKind = 'none' | 'business' | 'market' | 'wholesale' | 'dev' | 'info' | 'contracts' | 'rankings' | 'profile';

interface TabDef {
  id: string;
  label: string;
}

/** Localized display name for a business type. */
function bizName(type: string): string {
  return t(`biz.${type}`);
}

/** Localized "🐄 alice's Farm" heading used by the business and info panels. */
function bizTitle(type: string, owner: string): string {
  return t('biz.title', { icon: BIZ_ICON[type] ?? '🏪', owner, name: bizName(type) });
}

/** Business status code -> display text, with the vacant/unknown fallback. */
function statusText(status: string): string {
  return status ? t(`status.${status}`) : t('status.none');
}

function statusIsBad(status: string): boolean {
  return (BAD_STATUSES as string[]).includes(status);
}

/** Localized product name (the shared PRODUCTS table stays English/data-only). */
function pName(id: ProductId): string {
  return t(`product.${id}`);
}

/** Escape user-supplied text (company names) before interpolating into HTML. */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class UI {
  private root: HTMLElement;
  private hud!: HTMLElement;
  private panel!: HTMLElement;
  private panelKind: PanelKind = 'none';
  private panelTab = '';
  private infoBizId: number | null = null;
  private proposeFor: number | null = null;
  private profileCompanyId: number | null = null;
  private rankingCat = '';
  private flags: Record<string, boolean> = {};
  private objectivesHidden = false;
  private authError = '';
  private authVisible = false;

  onFocusLot: ((lotId: string) => void) | null = null;
  onCloseCity: (() => void) | null = null;

  constructor() {
    this.root = document.getElementById('app')!;
    document.addEventListener('pointerdown', () => unlockAudio(), { once: true });
    this.buildLangBar();
    this.buildHud();
    onLangChange(() => this.onLanguageChanged());
    client.on('update', () => this.refresh());
    client.on('toast', (msg: string, kind: string) => this.toast(msg, kind as any));
    client.on('away', (r: AwayReport) => this.showAway(r));
    client.on('level_up', (level: number) => {
      sfx.levelUp();
      this.toast(t('toast.level_up', { level }), 'success');
    });
    client.on('connection', (ok: boolean) => {
      document.getElementById('reconnect')!.classList.toggle('visible', !ok && !!client.token);
    });
    client.on('rankings', () => {
      if (this.panelKind === 'rankings') { this.lastBodyHTML = ''; this.renderPanel(); }
    });
    client.on('company_profile', (p: CompanyProfile) => {
      if (this.panelKind === 'profile' && p.id === this.profileCompanyId) {
        this.lastBodyHTML = '';
        this.renderPanel();
      }
    });
    client.on('contract', (c: ContractPub, prev: ContractPub | undefined) => {
      const me = client.you?.id;
      // A new proposal arrived for me as supplier.
      if (c.status === 'proposed' && c.sellerId === me && !prev) {
        sfx.levelUp();
        this.toast(t('toast.contract_proposal', {
          name: c.buyerName, qty: c.quantity, product: c.product, price: fmt(c.unitPrice),
        }), 'info');
      }
      if (prev && prev.status !== c.status) {
        if (c.status === 'active' && c.buyerId === me) this.toast(t('toast.contract_now_active'), 'success');
        if (c.status === 'completed') {
          this.toast(t('toast.contract_completed', { qty: c.quantity, product: c.product }), 'success');
        }
      }
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

  // ================= LANGUAGE =================

  /** Always-visible switcher so the language can be changed before login. */
  private buildLangBar(): void {
    const bar = document.createElement('div');
    bar.id = 'langbar';
    bar.title = t('lang.label');
    bar.innerHTML = LANGS.map(
      (l) => `<button data-lang="${l.id}" class="${l.id === getLang() ? 'active' : ''}">${l.flag} ${l.label}</button>`
    ).join('');
    document.body.appendChild(bar);
    bar.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', () => {
        sfx.click();
        setLang((b as HTMLElement).dataset.lang as Lang);
      })
    );
  }

  private refreshLangBar(): void {
    const bar = document.getElementById('langbar');
    if (!bar) return;
    bar.title = t('lang.label');
    bar.querySelectorAll('button').forEach((b) =>
      b.classList.toggle('active', (b as HTMLElement).dataset.lang === getLang())
    );
  }

  /**
   * Re-render everything currently on screen in the new language. The HUD
   * shell is rebuilt (its labels are static markup); panels and overlays
   * re-render from their existing state.
   */
  private onLanguageChanged(): void {
    this.refreshLangBar();
    const wasVisible = this.hud.classList.contains('visible');
    const panelKind = this.panelKind;
    const panelTab = this.panelTab;
    this.hud.remove();
    document.getElementById('toasts')?.remove();
    document.getElementById('reconnect')?.remove();
    this.buildHud();
    if (wasVisible) this.hud.classList.add('visible');
    this.invalidateCaches();
    if (panelKind !== 'none') {
      this.panelKind = panelKind;
      this.panel.classList.add('visible');
      this.panelTab = panelTab;
      this.renderPanel();
      this.updateNav();
    }
    document.getElementById('reconnect')!.classList.toggle('visible', !client.connected && !!client.token);
    if (client.you) this.refresh();
    // Overlays hold static copy — rebuild the ones that are open.
    if (this.authVisible) {
      document.getElementById('auth-overlay')?.remove();
      this.showAuth(this.authError);
    }
    if (document.getElementById('choose-overlay')) {
      this.hideChoose();
      this.showChoose();
    }
  }

  private invalidateCaches(): void {
    this.lastBodyHTML = '';
    this.lastTabsHTML = '';
    this.lastObjHTML = '';
  }

  // ================= AUTH =================

  showAuth(initialError = ''): void {
    this.authVisible = true;
    this.authError = initialError;
    this.hud.classList.remove('visible');
    let mode: 'login' | 'register' = 'register';
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.id = 'auth-overlay';
    overlay.innerHTML = `
      <div class="card">
        <h1>BUSINESS <span class="accent">DISTRICT</span></h1>
        <div class="tagline">${t('app.tagline')}</div>
        <div class="tabs">
          <button data-mode="register" class="active">${t('auth.tab.register')}</button>
          <button data-mode="login">${t('auth.tab.login')}</button>
        </div>
        <div class="auth-error">${initialError}</div>
        <div class="field"><label>${t('auth.username')}</label><input id="auth-user" maxlength="20" placeholder="${t('auth.username.placeholder')}" /></div>
        <div class="field"><label>${t('auth.password')}</label><input id="auth-pass" type="password" placeholder="${t('auth.password.placeholder')}" /></div>
        <button class="btn primary" id="auth-go">${t('auth.submit.register')}</button>
        <div class="hint">${t('auth.hint')}</div>
      </div>`;
    document.body.appendChild(overlay);
    const err = overlay.querySelector('.auth-error') as HTMLElement;
    const go = overlay.querySelector('#auth-go') as HTMLButtonElement;
    overlay.querySelectorAll('.tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        overlay.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        mode = (b as HTMLElement).dataset.mode as any;
        go.textContent = t(mode === 'register' ? 'auth.submit.register' : 'auth.submit.login');
        sfx.click();
      })
    );
    const submit = async () => {
      const username = (overlay.querySelector('#auth-user') as HTMLInputElement).value.trim();
      const password = (overlay.querySelector('#auth-pass') as HTMLInputElement).value;
      go.disabled = true;
      err.textContent = '';
      this.authError = '';
      try {
        await client.auth(mode, username, password);
        this.authVisible = false;
        overlay.remove();
        client.connect();
      } catch (e: any) {
        err.textContent = e.message;
        this.authError = e.message;
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
        <h1>${t('choose.title')}</h1>
        <div class="tagline">${t('choose.tagline', { cash: `<b>${fmt(client.you?.cash ?? 10000)}</b>` })}</div>
        <div class="choose-wrap" style="flex-wrap:wrap">
          <div class="choice" data-type="farm" style="flex-basis:44%">
            <div class="icon">🐄</div>
            <h3>${t('biz.farm')}</h3>
            <span class="role-tag producer">${t('role.producer')}</span>
            <p>${t('choose.farm.desc2')}</p>
          </div>
          <div class="choice" data-type="coffee_shop" style="flex-basis:44%">
            <div class="icon">☕</div>
            <h3>${t('biz.coffee_shop')}</h3>
            <span class="role-tag processor">${t('role.processor')}</span>
            <p>${t('choose.shop.desc2')}</p>
          </div>
          <div class="choice" data-type="bakery" style="flex-basis:44%">
            <div class="icon">🥖</div>
            <h3>${t('biz.bakery')}</h3>
            <span class="role-tag processor">${t('role.processor')}</span>
            <p>${t('choose.bakery.desc')}</p>
          </div>
          <div class="choice" data-type="mini_market" style="flex-basis:44%">
            <div class="icon">🛒</div>
            <h3>${t('biz.mini_market')}</h3>
            <span class="role-tag retailer">${t('role.retailer')}</span>
            <p>${t('choose.market.desc')}</p>
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
        <div class="stat"><span class="k">${t('hud.cash')}</span><span class="v" id="st-cash">$0</span></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">${t('hud.profit')}</span><span class="v" id="st-profit">$0</span></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">${t('hud.level')}</span><span class="v" id="st-level">1</span><div class="xpbar"><div id="st-xp" style="width:0%"></div></div></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">${t('hud.reputation')}</span><span class="v" id="st-rep">★ 3.0</span></div>
        <div class="sep"></div>
        <div class="stat"><span class="k">${t('hud.online')}</span><span class="v" id="st-online">1</span></div>
      </div>
      <div class="company-bar" id="company-bar"></div>
      <div class="nav">
        <button id="nav-city">${t('nav.city')}</button>
        <button id="nav-biz">${t('nav.business')}</button>
        <button id="nav-market">${t('nav.market')}</button>
        <button id="nav-contracts">${t('nav.contracts')} <span id="nav-contracts-badge"></span></button>
        <button id="nav-rankings">${t('nav.rankings')}</button>
        <button id="nav-dev" style="display:none">${t('nav.dev')}</button>
      </div>
      <div class="panel" id="panel">
        <div class="panel-head"><h2 id="panel-title">${t('panel.title')}</h2><button class="close" id="panel-close">✕</button></div>
        <div class="panel-tabs" id="panel-tabs"></div>
        <div class="panel-body" id="panel-body"></div>
      </div>
      <div class="objectives" id="objectives" style="display:none"></div>
      <div class="controls-hint">${t('hud.controls')}</div>
    `;
    document.body.appendChild(this.hud);
    const toasts = document.createElement('div');
    toasts.id = 'toasts';
    document.body.appendChild(toasts);
    const rec = document.createElement('div');
    rec.id = 'reconnect';
    rec.innerHTML = `<div class="spinner"></div><div>${t('hud.reconnecting')}</div>`;
    document.body.appendChild(rec);

    document.getElementById('nav-city')!.addEventListener('click', () => {
      sfx.click();
      this.closePanel();
      this.onCloseCity?.();
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
    document.getElementById('nav-contracts')!.addEventListener('click', () => {
      sfx.click();
      this.openPanel('contracts');
    });
    document.getElementById('nav-rankings')!.addEventListener('click', () => {
      sfx.click();
      this.openRankings();
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
    this.authVisible = false;
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

  openRankings(): void {
    client.send({ t: 'get_rankings' });
    this.openPanel('rankings');
  }

  /** Open a company's public profile (own or another player's). */
  openCompanyProfile(companyId: number): void {
    this.profileCompanyId = companyId;
    // Show cached immediately if it's already the right company; always refresh.
    if (client.companyProfile?.id !== companyId) client.companyProfile = null;
    client.send({ t: 'get_company_profile', companyId });
    this.openPanel('profile');
  }

  openPanel(kind: PanelKind): void {
    this.panelKind = kind;
    this.panelTab = '';
    this.invalidateCaches();
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
    document.getElementById('nav-contracts')!.classList.toggle('active', this.panelKind === 'contracts');
    document.getElementById('nav-rankings')!.classList.toggle('active', this.panelKind === 'rankings');
    document.getElementById('nav-dev')!.classList.toggle('active', this.panelKind === 'dev');
  }

  private updateContractBadge(): void {
    const badge = document.getElementById('nav-contracts-badge');
    if (!badge) return;
    const incoming = [...client.contracts.values()].filter(
      (c) => c.status === 'proposed' && c.sellerId === client.you?.id
    ).length;
    badge.textContent = incoming ? String(incoming) : '';
    badge.className = incoming ? 'badge' : '';
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
    this.updateContractBadge();
    this.renderCompanyBar();
    this.renderObjectives();
    if (this.panelKind !== 'none') this.renderPanel();
  }

  // ================= COMPANY BAR / MY BUSINESSES =================

  private lastCompanyHTML = '';

  private renderCompanyBar(): void {
    const bar = document.getElementById('company-bar');
    if (!bar) return;
    const company = client.company;
    const mine = [...client.myBusinesses.values()];
    if (!company || mine.length === 0) {
      if (this.lastCompanyHTML !== '') { bar.innerHTML = ''; this.lastCompanyHTML = ''; }
      return;
    }
    const used = mine.reduce((s, b) => s + (BUSINESS_CAPACITY[b.type] ?? 0), 0);
    const cap = companyCapacity(company.level);
    const chips = mine
      .map((b) => {
        const sel = b.id === client.selectedBizId;
        return `<button class="biz-chip ${sel ? 'active' : ''}" data-biz-chip="${b.id}" title="${bizName(b.type)}">${BIZ_ICON[b.type] ?? '🏪'}</button>`;
      })
      .join('');
    const canOpen = used < cap; // at least the cheapest (farm=2) might still not fit, checked on open
    const html = `
      <button class="company-name" id="co-name" title="${t('company.rename_hint')}">🏢 ${escapeHtml(company.name)}</button>
      <span class="company-meta">${t('company.level', { level: company.level })} · ${t('company.capacity', { used, cap })}</span>
      <span class="biz-chips">${chips}</span>
      <button class="biz-chip open ${canOpen ? '' : 'dim'}" id="co-open" title="${t('company.open_business')}">＋</button>`;
    if (html !== this.lastCompanyHTML) {
      this.lastCompanyHTML = html;
      bar.innerHTML = html;
      bar.querySelectorAll('[data-biz-chip]').forEach((el) =>
        el.addEventListener('click', () => {
          const id = parseInt((el as HTMLElement).dataset.bizChip!, 10);
          sfx.click();
          client.selectBiz(id);
          const b = client.myBusinesses.get(id);
          if (b) {
            this.openPanel('business');
            this.onFocusLot?.(b.lotId);
          }
        })
      );
      bar.querySelector('#co-open')!.addEventListener('click', () => {
        sfx.click();
        this.showOpenBusiness();
      });
      bar.querySelector('#co-name')!.addEventListener('click', () => {
        sfx.click();
        if (client.company) this.openCompanyProfile(client.company.id);
      });
    }
  }

  /** Overlay: pick a vacant lot to open a new business (type set by the lot). */
  showOpenBusiness(preLotId?: string): void {
    document.getElementById('open-overlay')?.remove();
    const company = client.company;
    if (!company) return;
    const mine = [...client.myBusinesses.values()];
    const used = mine.reduce((s, b) => s + (BUSINESS_CAPACITY[b.type] ?? 0), 0);
    const cap = companyCapacity(company.level);
    const cost = businessOpenCost(mine.length);
    const cash = client.you?.cash ?? 0;
    const occupied = new Set([...client.businesses.values()].map((b) => b.lotId));
    const vacant = LOTS.filter((l) => l.kind !== 'wholesale' && !occupied.has(l.id));

    const rows = vacant
      .map((l) => {
        const type = l.kind as BusinessType;
        const need = BUSINESS_CAPACITY[type];
        const fitsCap = used + need <= cap;
        const disabled = !fitsCap || cash < cost;
        return `<button class="open-lot ${disabled ? 'disabled' : ''}" data-lot="${l.id}" data-type="${type}" ${disabled ? 'disabled' : ''}>
          <span class="icon">${BIZ_ICON[type] ?? '🏪'}</span>
          <span class="ol-main"><b>${bizName(type)}</b><br/><span class="cap">${l.id}</span></span>
          <span class="ol-meta">${t('company.needs_cap', { need })}${fitsCap ? '' : ` <span class="neg">${t('company.no_cap')}</span>`}</span>
        </button>`;
      })
      .join('');

    const overlay = document.createElement('div');
    overlay.className = 'overlay modal';
    overlay.id = 'open-overlay';
    overlay.innerHTML = `
      <div class="card" style="width:min(560px,94vw)">
        <h1>${t('company.open_title')}</h1>
        <div class="tagline">${t('company.open_tagline', { cost: fmt(cost), used, cap })}</div>
        <div class="open-list">${rows || `<p class="hint">${t('company.no_lots')}</p>`}</div>
        <div class="hint">${cash < cost ? `<span class="neg">${t('company.need_cash', { cost: fmt(cost) })}</span>` : t('company.open_hint')}</div>
        <button class="btn ghost" id="open-cancel" style="margin-top:8px">${t('company.cancel')}</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll('[data-lot]').forEach((el) =>
      el.addEventListener('click', () => {
        const lotId = (el as HTMLElement).dataset.lot!;
        const type = (el as HTMLElement).dataset.type as BusinessType;
        sfx.click();
        client.send({ t: 'open_business', lotId, type });
        overlay.remove();
      })
    );
    overlay.querySelector('#open-cancel')!.addEventListener('click', () => {
      sfx.click();
      overlay.remove();
    });
    if (preLotId) {
      const btn = overlay.querySelector(`[data-lot="${preLotId}"]`) as HTMLElement | null;
      btn?.scrollIntoView({ block: 'center' });
      btn?.classList.add('active');
    }
  }

  /** Overlay: rename the company with light client-side validation. */
  showRenameCompany(): void {
    document.getElementById('rename-overlay')?.remove();
    const company = client.company;
    if (!company) return;
    const overlay = document.createElement('div');
    overlay.className = 'overlay modal';
    overlay.id = 'rename-overlay';
    overlay.innerHTML = `
      <div class="card" style="width:min(420px,94vw)">
        <h1>${t('company.rename_title')}</h1>
        <div class="field"><label>${t('company.name_label')}</label>
          <input id="co-rename-input" maxlength="${COMPANY_NAME_MAX}" value="${escapeHtml(company.name)}" /></div>
        <div class="auth-error" id="co-rename-err"></div>
        <div class="mkt-row">
          <button class="btn primary" id="co-rename-go">${t('company.save')}</button>
          <button class="btn ghost" id="co-rename-cancel">${t('company.cancel')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#co-rename-input') as HTMLInputElement;
    const err = overlay.querySelector('#co-rename-err') as HTMLElement;
    const submit = () => {
      const name = input.value.trim();
      if (name.length < COMPANY_NAME_MIN || name.length > COMPANY_NAME_MAX) {
        err.textContent = t('err.company_name_len', { min: COMPANY_NAME_MIN, max: COMPANY_NAME_MAX });
        sfx.error();
        return;
      }
      client.send({ t: 'rename_company', name });
      overlay.remove();
    };
    overlay.querySelector('#co-rename-go')!.addEventListener('click', submit);
    overlay.querySelector('#co-rename-cancel')!.addEventListener('click', () => overlay.remove());
    input.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') submit(); });
    input.focus();
    input.select();
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
      case 'contracts':
        this.renderContractsPanel(title, tabs, body);
        break;
      case 'rankings':
        this.renderRankingsPanel(title, tabs, body);
        break;
      case 'profile':
        this.renderProfilePanel(title, tabs, body);
        break;
    }
  }

  private tabBar(tabs: HTMLElement, defs: TabDef[]): string {
    const ids = defs.map((d) => d.id);
    if (!this.panelTab || !ids.includes(this.panelTab)) this.panelTab = ids[0];
    const html = defs
      .map((d) => `<button data-tab="${d.id}" class="${d.id === this.panelTab ? 'active' : ''}">${d.label}</button>`)
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
      title.textContent = t('biz.none.title');
      tabs.innerHTML = '';
      this.setBody(body, `<p>${t('biz.none.body')}</p>`);
      return;
    }
    const isFarm = biz.type === 'farm';
    title.textContent = bizTitle(biz.type, biz.ownerName);
    const tab = this.tabBar(tabs, [
      { id: 'overview', label: t('tab.overview') },
      { id: 'inventory', label: t('tab.inventory') },
      isFarm
        ? { id: 'production', label: t('tab.production') }
        : { id: 'pricing', label: t('tab.pricing') },
      { id: 'upgrade', label: t('tab.upgrade') },
    ]);

    const profit = biz.revenue - biz.expenses;
    if (tab === 'overview') {
      const soldLabel = t(`biz.sold.${biz.type}`) || t('biz.sold.default');
      const hint = isFarm
        ? t('biz.hint.farm2', { milk: NPC_WHOLESALE_PRICES.milk!, wheat: NPC_WHOLESALE_PRICES.wheat! })
        : t(`biz.hint.${biz.type}`, { wheat: NPC_WHOLESALE_PRICES.wheat! });
      this.setBody(body, `
        <div class="bigstatus ${statusIsBad(biz.status) ? 'bad' : 'ok'}">${statusText(biz.status)}</div>
        <div class="kv"><span class="k">${t('biz.level')}</span><span class="v">${biz.level} / ${MAX_LEVEL}</span></div>
        <div class="kv"><span class="k">${t('biz.revenue')}</span><span class="v pos">${fmt(biz.revenue)}</span></div>
        <div class="kv"><span class="k">${t('biz.expenses')}</span><span class="v neg">${fmt(biz.expenses)}</span></div>
        <div class="kv"><span class="k">${t('biz.profit')}</span><span class="v ${profit >= 0 ? 'pos' : 'neg'}">${fmt(profit)}</span></div>
        ${isFarm
          ? `<div class="kv"><span class="k">${t('biz.units_produced')}</span><span class="v">${biz.milkProduced}</span></div>
             <div class="kv"><span class="k">${t('biz.producing')}</span><span class="v">${biz.production === 'wheat' ? `🌾 ${pName('wheat')}` : `🥛 ${pName('milk')}`}</span></div>`
          : `<div class="kv"><span class="k">${soldLabel}</span><span class="v">${biz.coffeeSold}</span></div>
             <div class="kv"><span class="k">${t('biz.customers')}</span><span class="v">${biz.customers}</span></div>`}
        <div class="kv"><span class="k">${t('biz.reputation')}</span><span class="v">★ ${biz.reputation.toFixed(2)}</span></div>
        <div class="hint">${hint}</div>
      `);
    } else if (tab === 'inventory') {
      this.setBody(body, Object.entries(biz.inventory)
        .map(([pid, e]) => {
          const p = PRODUCTS[pid as ProductId];
          const used = e.qty + e.reserved;
          const pct = e.capacity > 0 ? Math.min(100, (used / e.capacity) * 100) : 0;
          return `<div class="invrow">
            <span class="emoji">${p.emoji}</span>
            <span class="name">${pName(pid as ProductId)}
              <div class="capbar"><div style="width:${pct}%"></div></div>
            </span>
            <span>
              <span class="qty">${e.qty}</span>
              <span class="cap">/ ${e.capacity}</span><br/>
              <span class="cap">${e.reserved ? `${t('inv.on_market', { qty: e.reserved })} · ` : ''}${e.incoming ? t('inv.incoming', { qty: e.incoming }) : ''}</span>
            </span>
          </div>`;
        })
        .join('') +
        `<div class="hint">${t('inv.hint')}</div>`);
    } else if (tab === 'production' && isFarm) {
      const lv = FARM_LEVELS[biz.level];
      const producing = biz.production === 'wheat' ? 'wheat' : 'milk';
      this.setBody(body, `
        <div class="bigstatus ${statusIsBad(biz.status) ? 'bad' : 'ok'}">${statusText(biz.status)}</div>
        <div class="kv"><span class="k">${t('biz.producing')}</span><span class="v">${producing === 'wheat' ? `🌾 ${pName('wheat')}` : `🥛 ${pName('milk')}`}</span></div>
        <div class="qtyrow">
          <button class="btn small ${producing === 'milk' ? 'primary' : 'ghost'}" data-prod="milk">🥛 ${pName('milk')}</button>
          <button class="btn small ${producing === 'wheat' ? 'primary' : 'ghost'}" data-prod="wheat">🌾 ${pName('wheat')}</button>
        </div>
        <div class="kv"><span class="k">${t('prod.rate')}</span><span class="v">${t('prod.rate.generic', { n: (lv.milkPerSec * 60).toFixed(0) })}</span></div>
        <div class="kv"><span class="k">${t('prod.capacity.per_product')}</span><span class="v">${lv.milkCapacity}</span></div>
        <div class="kv"><span class="k">${t('prod.units_lifetime')}</span><span class="v">${biz.milkProduced}</span></div>
        <div class="hint">${t('prod.hint2')}</div>`, (b) => {
        b.querySelectorAll('[data-prod]').forEach((btn) =>
          btn.addEventListener('click', () => {
            client.send({ t: 'set_production', product: (btn as HTMLElement).dataset.prod as ProductId });
            sfx.click();
          })
        );
      });
    } else if (tab === 'pricing' && !isFarm) {
      if (biz.type === 'mini_market') {
        this.setBody(body, `
          <div class="kv"><span class="k">${t('price.bread_retail')}</span><span class="v">${fmt(biz.price)}</span></div>
          <div class="qtyrow">
            <input id="price-input" type="number" min="5" max="100" value="${biz.price}" />
            <button class="btn small primary" id="price-set">${t('price.set_bread')}</button>
          </div>
          <div class="kv"><span class="k">${t('price.milk_retail')}</span><span class="v">${fmt(biz.price2)}</span></div>
          <div class="qtyrow">
            <input id="price2-input" type="number" min="5" max="100" value="${biz.price2}" />
            <button class="btn small primary" id="price2-set">${t('price.set_milk')}</button>
          </div>
          <div class="hint">${t('price.hint.market')}</div>`, (b) => {
          b.querySelector('#price-set')!.addEventListener('click', () => {
            client.send({ t: 'set_price', price: parseInt((b.querySelector('#price-input') as HTMLInputElement).value, 10) });
            sfx.click();
          });
          b.querySelector('#price2-set')!.addEventListener('click', () => {
            client.send({ t: 'set_price', price: parseInt((b.querySelector('#price2-input') as HTMLInputElement).value, 10), product: 'milk' });
            sfx.click();
          });
        });
      } else {
        const isBakery = biz.type === 'bakery';
        this.setBody(body, `
          <div class="kv"><span class="k">${t(isBakery ? 'price.current.bread' : 'price.current.coffee')}</span><span class="v">${fmt(biz.price)}</span></div>
          <div class="qtyrow">
            <input id="price-input" type="number" min="5" max="100" value="${biz.price}" />
            <button class="btn small primary" id="price-set">${t('price.set')}</button>
          </div>
          <div class="hint">${t(isBakery ? 'price.hint.bakery' : 'price.hint')}</div>`, (b) => {
          b.querySelector('#price-set')!.addEventListener('click', () => {
            const v = parseInt((b.querySelector('#price-input') as HTMLInputElement).value, 10);
            client.send({ t: 'set_price', price: v });
            sfx.click();
          });
        });
      }
    } else if (tab === 'upgrade') {
      const levels: Record<string, any> = {
        farm: FARM_LEVELS, coffee_shop: SHOP_LEVELS, bakery: BAKERY_LEVELS, mini_market: MARKET_LEVELS,
      };
      const lvs = levels[biz.type];
      const cost = lvs[biz.level].upgradeCost;
      const next = biz.level + 1;
      let improvements = '';
      if (cost != null) {
        const a = lvs[biz.level];
        const bb = lvs[next];
        if (isFarm) {
          improvements = `
            <div class="kv"><span class="k">${t('upg.units_per_min')}</span><span class="v">${(a.milkPerSec * 60).toFixed(0)} → <b class="pos">${(bb.milkPerSec * 60).toFixed(0)}</b></span></div>
            <div class="kv"><span class="k">${t('upg.storage')}</span><span class="v">${a.milkCapacity} → <b class="pos">${bb.milkCapacity}</b></span></div>`;
        } else if (biz.type === 'mini_market') {
          improvements = `
            <div class="kv"><span class="k">${t('upg.customers_per_min.per_product')}</span><span class="v">~${(a.customersPerSec * 60).toFixed(0)} → <b class="pos">~${(bb.customersPerSec * 60).toFixed(0)}</b></span></div>
            <div class="kv"><span class="k">${t('upg.shelf_capacity')}</span><span class="v">${a.stockCapacity} → <b class="pos">${bb.stockCapacity}</b></span></div>`;
        } else {
          improvements = `
            <div class="kv"><span class="k">${t('upg.customers_per_min')}</span><span class="v">~${(a.customersPerSec * 60).toFixed(0)} → <b class="pos">~${(bb.customersPerSec * 60).toFixed(0)}</b></span></div>
            <div class="kv"><span class="k">${t(biz.type === 'bakery' ? 'upg.bake_speed' : 'upg.brew_speed')}</span><span class="v">${t('upg.brew_speed.value', { n: `${(a.brewPerSec * 60).toFixed(0)} → <b class="pos">${(bb.brewPerSec * 60).toFixed(0)}</b>` })}</span></div>
            <div class="kv"><span class="k">${t('upg.ingredient_storage')}</span><span class="v">${a.ingredientCapacity} → <b class="pos">${bb.ingredientCapacity}</b></span></div>`;
        }
      }
      const html = cost == null
        ? `<div class="bigstatus ok">${t('upg.max')}</div><p class="hint">${t('upg.max.hint', { biz: t(`biz.${biz.type}.lower`) })}</p>`
        : `
        <div class="kv"><span class="k">${t('upg.current_level')}</span><span class="v">${biz.level}</span></div>
        ${improvements}
        <div style="margin-top:14px">
          <button class="btn success" style="width:100%" id="do-upgrade" ${((client.you?.cash ?? 0) < cost) ? 'disabled' : ''}>
            ${t('upg.button', { level: next, cost: fmt(cost) })}
          </button>
        </div>
        <div class="hint">${t('upg.hint')}</div>`;
      this.setBody(body, html, (b) => {
        b.querySelector('#do-upgrade')?.addEventListener('click', () => {
          client.send({ t: 'upgrade' });
        });
      });
    }
  }

  private renderMarketPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = t('market.title');
    const tab = this.tabBar(tabs, [
      { id: 'orders', label: t('tab.orders') },
      { id: 'my_orders', label: t('tab.my_orders') },
      { id: 'history', label: t('tab.history') },
    ]);
    const myId = client.you?.id;
    if (tab === 'orders') {
      const orders = [...client.orders.values()].sort((a, b) => b.createdAt - a.createdAt);
      const rows = orders.map((o) => this.orderRow(o, o.ownerId !== myId)).join('');
      this.setBody(body, `
        <div class="mkt-form">
          <h4>${t('market.create')}</h4>
          <div class="mkt-row">
            <select id="mo-side"><option value="sell">${t('market.side.sell')}</option><option value="buy">${t('market.side.buy')}</option></select>
            <select id="mo-product">${(['milk', 'wheat', 'bread', 'beans'] as ProductId[])
              .map((pid) => `<option value="${pid}">${pName(pid)}</option>`).join('')}</select>
            <input id="mo-qty" type="number" min="1" value="100" style="width:76px" title="${t('market.qty')}" />
            <span>@</span>
            <input id="mo-price" type="number" min="1" value="12" style="width:64px" title="${t('market.unit_price')}" />
          </div>
          <button class="btn small primary" id="mo-create">${t('market.place')}</button>
          <div class="hint">${t('market.hint', { price: NPC_WHOLESALE_PRICES.milk! })}</div>
        </div>
        ${rows || `<p class="hint">${t('market.empty')}</p>`}`, (b) => {
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
    } else if (tab === 'my_orders') {
      const mine = [...client.orders.values()].filter((o) => o.ownerId === myId);
      this.setBody(body,
        (mine.map((o) => `
          <div class="order">
            <span class="side ${o.side}">${t(`market.side.${o.side}`)}</span>
            <span class="grow">${PRODUCTS[o.product].emoji} ${o.remaining}/${o.qty} ${pName(o.product)} @ ${fmt(o.price)}</span>
            <button class="btn small warn" data-cancel="${o.id}">${t('market.cancel')}</button>
          </div>`).join('') || `<p class="hint">${t('market.mine.empty')}</p>`) +
        `<div class="hint">${t('market.cancel.hint')}</div>`, (bd) => {
        bd.querySelectorAll('[data-cancel]').forEach((b) =>
          b.addEventListener('click', () => {
            client.send({ t: 'order_cancel', orderId: parseInt((b as HTMLElement).dataset.cancel!, 10) });
            sfx.click();
          })
        );
      });
    } else {
      this.setBody(body,
        `<h4 style="font-size:13px;color:#334155;margin-bottom:6px">${t('market.recent_trades')}</h4>` +
        (client.trades.map((tr) => `
          <div class="trade-row">${PRODUCTS[tr.product].emoji} <b>${tr.qty}</b> ${pName(tr.product)} @ ${fmt(tr.price)} — <b>${tr.sellerName}</b> → <b>${tr.buyerName}</b></div>`).join('') ||
          `<p class="hint">${t('market.trades.empty')}</p>`));
    }
  }

  private orderRow(o: OrderPub, canFulfill: boolean): string {
    const p = PRODUCTS[o.product];
    const action = canFulfill
      ? `<input type="number" min="1" max="${o.remaining}" value="${o.remaining}" data-qty-for="${o.id}" />
         <button class="btn small ${o.side === 'buy' ? 'success' : 'primary'}" data-fulfill="${o.id}">
           ${t(o.side === 'buy' ? 'market.sell_to' : 'market.buy_from')}</button>`
      : `<span class="who">${t('market.your_order')}</span>`;
    return `<div class="order">
      <span class="side ${o.side}">${t(`market.side.${o.side}`)}</span>
      <span class="grow">${p.emoji} <b>${o.remaining}</b> ${pName(o.product)} @ <b>${fmt(o.price)}</b><br/>
      <span class="who">${t(o.side === 'buy' ? 'market.wanted_by' : 'market.offered_by', { name: o.ownerName })}</span></span>
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
    title.textContent = t('wholesale.title');
    tabs.innerHTML = '';
    const rows = (['beans', 'milk', 'wheat', 'bread'] as ProductId[])
      .map((pid) => {
        const price = NPC_WHOLESALE_PRICES[pid]!;
        return `<div class="invrow">
          <span class="emoji">${PRODUCTS[pid].emoji}</span>
          <span class="name">${pName(pid)}<br/><span class="cap" style="white-space:nowrap">${t('wholesale.per_unit', { price: fmt(price) })}</span></span>
          <input type="number" min="1" value="50" style="width:70px;padding:7px;border:1.5px solid #dbe3ee;border-radius:8px" data-npc-qty="${pid}" />
          <button class="btn small primary" data-npc-buy="${pid}">${t('wholesale.buy')}</button>
        </div>`;
      })
      .join('');
    this.setBody(body, `
      ${rows}
      <div class="hint">${t('wholesale.hint')}</div>`, (bd) => {
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
      title.textContent = t('info.title');
      this.setBody(body, `<p class="hint">${t('info.vacant')}</p>`);
      return;
    }
    title.textContent = bizTitle(biz.type, biz.ownerName);
    const online = client.players.find((p) => p.id === biz.ownerId)?.online;
    const supplies = biz.supplies ?? [];
    const suppliesTxt = supplies.length
      ? supplies.map((pid) => `${PRODUCTS[pid].emoji} ${pName(pid)}`).join(', ')
      : t('info.retailer_no_supply');

    // Can MY business form a supply contract to buy from this one?
    const myBiz = client.myBiz;
    const canContract =
      !!myBiz && biz.ownerId !== client.you?.id &&
      contractableProducts(biz.type, myBiz.type).length > 0;
    const compatProducts = myBiz ? contractableProducts(biz.type, myBiz.type) : [];

    const proposeOpen = this.proposeFor === biz.id;
    let proposeBlock = '';
    if (canContract) {
      proposeBlock = proposeOpen
        ? `<div class="mkt-form">
            <h4>${t('contract.propose_title')}</h4>
            <div class="mkt-row">
              <select id="ct-product">${compatProducts.map((pid) => `<option value="${pid}">${PRODUCTS[pid].emoji} ${pName(pid)}</option>`).join('')}</select>
            </div>
            <div class="mkt-row">
              <span style="font-size:12px">${t('contract.qty_short')}</span><input id="ct-qty" type="number" min="1" value="50" style="width:70px" />
              <span style="font-size:12px">@ $</span><input id="ct-price" type="number" min="1" value="8" style="width:60px" />
              <span style="font-size:12px">${t('contract.per_unit')}</span>
            </div>
            <div class="mkt-row">
              <span style="font-size:12px">${t('contract.deliveries_label')}</span><input id="ct-deliv" type="number" min="1" max="30" value="5" style="width:60px" />
              <span class="hint" style="margin:0">${t('contract.freq_hint', { secs: CONTRACT_FREQUENCY_SECS })}</span>
            </div>
            <div class="mkt-row">
              <button class="btn small success" id="ct-send">${t('contract.send')}</button>
              <button class="btn small ghost" id="ct-cancel">${t('contract.cancel')}</button>
            </div>
          </div>`
        : `<button class="btn primary" id="ct-open" style="width:100%;margin-top:10px">${t('info.propose_btn')}</button>`;
    }

    this.setBody(body, `
      <div class="kv"><span class="k">${t('info.company')}</span><span class="v">🏢 ${escapeHtml(biz.companyName ?? '')}</span></div>
      <div class="kv"><span class="k">${t('info.owner')}</span><span class="v">${escapeHtml(biz.ownerName)} ${t(online ? 'info.online' : 'info.offline')}</span></div>
      <div class="kv"><span class="k">${t('info.type')}</span><span class="v">${bizName(biz.type)}</span></div>
      <div class="kv"><span class="k">${t('biz.level')}</span><span class="v">${biz.level} / ${MAX_LEVEL}</span></div>
      <div class="kv"><span class="k">${t('biz.reputation')}</span><span class="v">★ ${(biz.reputation ?? 3).toFixed(2)}</span></div>
      <div class="kv"><span class="k">${t('info.supplies_label')}</span><span class="v">${suppliesTxt}</span></div>
      <div class="kv"><span class="k">${t('info.successful_trades')}</span><span class="v">${biz.tradeCount ?? 0}</span></div>
      <div class="kv"><span class="k">${t('info.status')}</span><span class="v">${statusText(biz.status)}</span></div>
      <button class="btn ghost" id="view-company" style="width:100%;margin-top:8px">${t('profile.view_company')}</button>
      ${proposeBlock}
      ${!canContract ? `<div class="hint">${t(myBiz ? 'info.cannot_contract' : 'info.choose_business_first')}</div>` : ''}
    `, (b) => {
      b.querySelector('#view-company')?.addEventListener('click', () => {
        sfx.click();
        this.openCompanyProfile(biz.companyId);
      });
      b.querySelector('#ct-open')?.addEventListener('click', () => {
        this.proposeFor = biz.id;
        this.lastBodyHTML = '';
        sfx.click();
        this.renderPanel();
      });
      b.querySelector('#ct-cancel')?.addEventListener('click', () => {
        this.proposeFor = null;
        this.lastBodyHTML = '';
        sfx.click();
        this.renderPanel();
      });
      b.querySelector('#ct-send')?.addEventListener('click', () => {
        const product = (b.querySelector('#ct-product') as HTMLSelectElement).value as ProductId;
        const quantity = parseInt((b.querySelector('#ct-qty') as HTMLInputElement).value, 10);
        const unitPrice = parseInt((b.querySelector('#ct-price') as HTMLInputElement).value, 10);
        const deliveries = parseInt((b.querySelector('#ct-deliv') as HTMLInputElement).value, 10);
        client.send({ t: 'contract_propose', sellerBizId: biz.id, product, quantity, unitPrice, deliveries });
        this.proposeFor = null;
        this.lastBodyHTML = '';
        sfx.click();
      });
    });
  }

  private contractRow(c: ContractPub, role: 'incoming' | 'outgoing' | 'active' | 'history'): string {
    const p = PRODUCTS[c.product];
    const iAmBuyer = c.buyerId === client.you?.id;
    const counterparty = iAmBuyer ? c.sellerName : c.buyerName;
    const counterCompany = iAmBuyer ? c.sellerCompany : c.buyerCompany;
    const label = counterCompany ? `${counterparty} · 🏢 ${counterCompany}` : counterparty;
    const dir = t(iAmBuyer ? 'contract.dir.from' : 'contract.dir.to', { name: label });
    const total = c.quantity * c.unitPrice;
    let actions = '';
    if (role === 'incoming') {
      actions = `<button class="btn small success" data-ct-accept="${c.id}">${t('contract.accept')}</button>
                 <button class="btn small warn" data-ct-reject="${c.id}">${t('contract.reject')}</button>`;
    } else if (role === 'outgoing') {
      actions = `<span class="who">${t('contract.awaiting_supplier')}</span><button class="btn small ghost" data-ct-cancel="${c.id}">${t('contract.withdraw')}</button>`;
    } else if (role === 'active') {
      const next = c.nextExecutionAt ? Math.max(0, Math.round((c.nextExecutionAt - Date.now()) / 1000)) : null;
      actions = `<span class="who">${t('contract.left', { n: c.remaining })}${next != null ? ` · ${t('contract.next_in', { secs: next })}` : ''}</span><button class="btn small ghost" data-ct-cancel="${c.id}">${t('contract.cancel')}</button>`;
    } else {
      actions = `<span class="who">${t(`contract.status.${c.status}`)}</span>`;
    }
    // `lastResult` is a code ('delivered' | 'missed_stock' | ...), not prose.
    const missed = c.lastResult?.startsWith('missed');
    const statusNote = c.lastResult && role !== 'incoming' && role !== 'outgoing'
      ? `<br/><span class="who" style="color:${missed ? '#dc2626' : '#16a34a'}">${t(`contract.result.${c.lastResult}`)}</span>` : '';
    return `<div class="order">
      <span class="grow">${p.emoji} <b>${c.quantity}</b> ${pName(c.product)} @ <b>${fmt(c.unitPrice)}</b> ${dir}<br/>
        <span class="who">${t('contract.deliveries_total', { n: c.deliveries, total: fmt(total * c.deliveries) })}</span>${statusNote}</span>
      <span style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">${actions}</span>
    </div>`;
  }

  private renderContractsPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = t('contracts.title');
    const tab = this.tabBar(tabs, [
      { id: 'incoming', label: t('tab.incoming') },
      { id: 'outgoing', label: t('tab.outgoing') },
      { id: 'active', label: t('tab.active') },
      { id: 'history', label: t('tab.history') },
    ]);
    const me = client.you?.id;
    const all = [...client.contracts.values()];
    let rows = '';
    let empty = '';
    if (tab === 'incoming') {
      const list = all.filter((c) => c.status === 'proposed' && c.sellerId === me);
      rows = list.map((c) => this.contractRow(c, 'incoming')).join('');
      empty = t('contracts.empty.incoming');
    } else if (tab === 'outgoing') {
      const list = all.filter((c) => c.status === 'proposed' && c.buyerId === me);
      rows = list.map((c) => this.contractRow(c, 'outgoing')).join('');
      empty = t('contracts.empty.outgoing');
    } else if (tab === 'active') {
      const list = all.filter((c) => c.status === 'active');
      rows = list.map((c) => this.contractRow(c, 'active')).join('');
      empty = t('contracts.empty.active');
    } else {
      const list = all
        .filter((c) => ['completed', 'rejected', 'cancelled'].includes(c.status))
        .sort((a, b) => b.createdAt - a.createdAt);
      rows = list.map((c) => this.contractRow(c, 'history')).join('');
      empty = t('contracts.empty.history');
    }
    this.setBody(body, rows || `<p class="hint">${empty}</p>`, (b) => {
      b.querySelectorAll('[data-ct-accept]').forEach((el) => el.addEventListener('click', () => {
        client.send({ t: 'contract_accept', contractId: parseInt((el as HTMLElement).dataset.ctAccept!, 10) });
        sfx.click();
      }));
      b.querySelectorAll('[data-ct-reject]').forEach((el) => el.addEventListener('click', () => {
        client.send({ t: 'contract_reject', contractId: parseInt((el as HTMLElement).dataset.ctReject!, 10) });
        sfx.click();
      }));
      b.querySelectorAll('[data-ct-cancel]').forEach((el) => el.addEventListener('click', () => {
        client.send({ t: 'contract_cancel', contractId: parseInt((el as HTMLElement).dataset.ctCancel!, 10) });
        sfx.click();
      }));
    });
  }

  // ================= CITY RANKINGS =================

  private renderRankingsPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = t('rankings.title');
    const data = client.rankings;
    if (!data) {
      tabs.innerHTML = '';
      this.setBody(body, `<p class="hint">${t('rankings.loading')}</p>`);
      return;
    }
    const tab = this.tabBar(tabs, data.boards.map((b) => ({ id: b.category, label: t(`rank.cat.${b.category}`) })));
    const board = data.boards.find((b) => b.category === tab) ?? data.boards[0];
    this.rankingCat = board.category;
    this.setBody(body, this.rankingBoardHtml(board), (b) => {
      b.querySelectorAll('[data-rank-co]').forEach((el) =>
        el.addEventListener('click', () => {
          sfx.click();
          this.openCompanyProfile(parseInt((el as HTMLElement).dataset.rankCo!, 10));
        })
      );
    });
  }

  private fmtRankValue(unit: RankingBoard['unit'], value: number): string {
    if (unit === 'money') return fmt(value);
    if (unit === 'stars') return `★ ${value.toFixed(2)}`;
    if (unit === 'percent') return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
    return `${Math.round(value).toLocaleString()}`;
  }

  private rankingBoardHtml(board: RankingBoard): string {
    const meId = client.company?.id;
    const rows = board.top.map((r, i) => {
      const mine = r.companyId === meId;
      return `<div class="rank-row ${mine ? 'mine' : ''}" data-rank-co="${r.companyId}">
        <span class="rank-pos">${i + 1}</span>
        <span class="rank-name">🏢 ${escapeHtml(r.name)}</span>
        <span class="rank-val">${this.fmtRankValue(board.unit, r.value)}</span>
      </div>`;
    }).join('');
    let selfLine = '';
    if (board.self) {
      selfLine = `<div class="rank-sep">···</div>
        <div class="rank-row mine" data-rank-co="${board.self.companyId}">
          <span class="rank-pos">${board.self.rank}</span>
          <span class="rank-name">🏢 ${escapeHtml(board.self.name)}</span>
          <span class="rank-val">${this.fmtRankValue(board.unit, board.self.value)}</span>
        </div>`;
    } else if (board.selfRank && meId != null) {
      selfLine = `<div class="rank-selfnote">${t('rankings.your_rank', { rank: board.selfRank })}</div>`;
    }
    const desc = t(`rank.desc.${board.category}`);
    return `<div class="rank-desc">${desc}</div>` +
      (rows ? rows : `<p class="hint">${t('rankings.empty')}</p>`) + selfLine;
  }

  // ================= COMPANY PROFILE =================

  private renderProfilePanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    tabs.innerHTML = '';
    const p = client.companyProfile;
    if (!p || p.id !== this.profileCompanyId) {
      title.textContent = t('profile.title');
      this.setBody(body, `<p class="hint">${t('profile.loading')}</p>`);
      return;
    }
    title.textContent = `🏢 ${p.name}`;
    const online = client.players.find((pl) => pl.id === p.ownerId)?.online;
    const founded = new Date(p.foundedAt).toLocaleDateString(getLang() === 'tr' ? 'tr-TR' : 'en-US');
    const badges = p.badges.map((bd) => `<span class="profile-badge">${t(`badge.${bd}`)}</span>`).join('');

    const shareCards = p.marketShares.map((m) => {
      const pct = (m.share * 100).toFixed(1);
      const barW = Math.min(100, m.share * 100);
      let trend = '';
      if (m.prevShare != null) {
        const prevPct = m.prevShare * 100;
        const delta = m.share * 100 - prevPct;
        const arrow = delta >= 0 ? '↑' : '↓';
        trend = `<div class="share-trend ${delta >= 0 ? 'pos' : 'neg'}">${prevPct.toFixed(1)}% → ${pct}% ${arrow} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} ${t('profile.pts')}</div>`;
      }
      return `<div class="share-card">
        <div class="share-head"><span>${PRODUCTS[m.product].emoji} ${t(`rank.cat.${m.product === 'milk' ? 'milk_retail' : m.product}`)}</span>
          <span class="share-rank">${t('profile.city_rank', { rank: m.rank })}</span></div>
        <div class="share-bar"><div style="width:${barW}%"></div><span class="share-pct">${pct}%</span></div>
        <div class="share-sub">${t('profile.window_sales', { n: Math.round(m.units).toLocaleString() })}</div>
        ${trend}
      </div>`;
    }).join('');

    const supplierRows = p.supplierRanks.map((s) =>
      `<div class="kv"><span class="k">${PRODUCTS[s.product].emoji} ${t(`rank.cat.${s.product}_supplier`)}</span>
        <span class="v">${t('profile.city_rank', { rank: s.rank })} · ${Math.round(s.units).toLocaleString()} ${t('profile.units')}</span></div>`
    ).join('');

    const bizRows = p.businesses.map((b) =>
      `<div class="profile-biz" data-focus-lot="${b.lotId}">
        <span class="pb-icon">${BIZ_ICON[b.type] ?? '🏪'}</span>
        <span class="pb-main"><b>${bizName(b.type)}</b><br/><span class="cap">${t('biz.level')} ${b.level} · ★ ${(b.reputation ?? 3).toFixed(1)}</span></span>
      </div>`
    ).join('');

    const html = `
      <div class="profile-top">
        <div>${badges || ''}</div>
        <div class="kv"><span class="k">${t('info.owner')}</span><span class="v">${escapeHtml(p.ownerName)} ${t(online ? 'info.online' : 'info.offline')}</span></div>
        <div class="kv"><span class="k">${t('company.level_label')}</span><span class="v">${p.level}</span></div>
        <div class="kv"><span class="k">${t('company.capacity_label')}</span><span class="v">${p.capacityUsed} / ${p.capacity}</span></div>
        <div class="kv"><span class="k">${t('biz.reputation')}</span><span class="v">★ ${p.reputation.toFixed(2)}</span></div>
        <div class="kv"><span class="k">${t('profile.businesses')}</span><span class="v">${p.businessCount}</span></div>
        <div class="kv"><span class="k">${t('info.successful_trades')}</span><span class="v">${p.tradeCount}</span></div>
        <div class="kv"><span class="k">${t('profile.active_contracts')}</span><span class="v">${p.activeContracts}</span></div>
        <div class="kv"><span class="k">${t('profile.founded')}</span><span class="v">${founded}</span></div>
      </div>
      <div class="profile-window">
        <h4>${t('profile.last_days')}</h4>
        <div class="kv"><span class="k">${t('profile.recent_revenue')}</span><span class="v pos">${fmt(p.recentRevenue)}</span></div>
        <div class="kv"><span class="k">${t('profile.recent_net')}</span><span class="v ${p.recentNet >= 0 ? 'pos' : 'neg'}">${p.recentNet >= 0 ? '+' : ''}${fmt(p.recentNet)}</span></div>
      </div>
      ${shareCards ? `<h4 class="profile-h">${t('profile.market_share')}</h4>${shareCards}` : ''}
      ${supplierRows ? `<h4 class="profile-h">${t('profile.supplier_ranks')}</h4>${supplierRows}` : ''}
      <h4 class="profile-h">${t('profile.owned_businesses')}</h4>
      ${bizRows}
      ${p.isSelf ? `<button class="btn ghost" id="profile-rename" style="width:100%;margin-top:12px">${t('company.rename_title')}</button>` : ''}
    `;
    this.setBody(body, html, (b) => {
      b.querySelectorAll('[data-focus-lot]').forEach((el) =>
        el.addEventListener('click', () => {
          sfx.click();
          const lotId = (el as HTMLElement).dataset.focusLot!;
          this.onFocusLot?.(lotId);
          const biz = [...client.businesses.values()].find((x) => x.lotId === lotId);
          if (biz && !client.myBusinesses.has(biz.id)) this.openInfo(biz.id);
          else if (biz) { client.selectBiz(biz.id); this.openBusiness(); }
        })
      );
      b.querySelector('#profile-rename')?.addEventListener('click', () => {
        sfx.click();
        this.showRenameCompany();
      });
    });
  }

  private renderDevPanel(title: HTMLElement, tabs: HTMLElement, body: HTMLElement): void {
    title.textContent = t('dev.title');
    tabs.innerHTML = '';
    this.setBody(body, `
      <div class="hint" style="margin-bottom:10px">${t('dev.hint')}</div>
      <div class="mkt-row"><button class="btn small ghost" data-dev="add_money" data-val="5000">${t('dev.add_money')}</button>
      <button class="btn small ghost" data-dev="add_milk" data-val="100">${t('dev.add_milk')}</button>
      <button class="btn small ghost" data-dev="add_beans" data-val="100">${t('dev.add_beans')}</button>
      <button class="btn small ghost" data-dev="add_wheat" data-val="100">${t('dev.add_wheat')}</button>
      <button class="btn small ghost" data-dev="add_bread" data-val="100">${t('dev.add_bread')}</button></div>
      <div class="mkt-row"><span style="font-size:13px">${t('dev.speed')}</span>
      <button class="btn small ghost" data-dev="speed" data-val="1">×1</button>
      <button class="btn small ghost" data-dev="speed" data-val="5">×5</button>
      <button class="btn small ghost" data-dev="speed" data-val="20">×20</button></div>
      <div class="mkt-row"><button class="btn small warn" data-dev="reset_business">${t('dev.reset')}</button></div>
      <div class="kv"><span class="k">${t('dev.open_orders')}</span><span class="v">${client.orders.size}</span></div>
      <div class="kv"><span class="k">${t('dev.deliveries')}</span><span class="v">${client.deliveries.size}</span></div>
      <div class="kv"><span class="k">${t('dev.businesses')}</span><span class="v">${client.businesses.size}</span></div>
      <div style="margin-top:12px"><button class="btn small ghost" id="dev-logout">${t('dev.logout')}</button></div>`, (bd) => {
      bd.querySelectorAll('[data-dev]').forEach((b) =>
        b.addEventListener('click', () => {
          const el = b as HTMLElement;
          if (el.dataset.dev === 'reset_business' && !confirm(t('dev.reset.confirm'))) return;
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
      (tr) => tr.buyerName === client.you?.name || tr.sellerName === client.you?.name
    );
    const has = (pid: ProductId) =>
      (biz.inventory[pid]?.qty ?? 0) + (biz.inventory[pid]?.incoming ?? 0) > 0;
    const objsByType: Record<string, [string, boolean][]> = {
      farm: [
        ['obj.farm.open', !!this.flags.opened_business],
        ['obj.farm.produce2', biz.milkProduced > 0],
        ['obj.market.open', !!this.flags.opened_market],
        ['obj.farm.sell_order', !!this.flags.created_order],
        ['obj.farm.trade', tradedWithMe || biz.revenue > 0],
        ['obj.farm.upgrade', biz.level >= 2],
      ],
      coffee_shop: [
        ['obj.shop.open', !!this.flags.opened_business],
        ['obj.shop.beans', has('beans') || biz.expenses > 0],
        ['obj.shop.milk', has('milk')],
        ['obj.shop.sale', biz.coffeeSold > 0],
        ['obj.market.open', !!this.flags.opened_market],
        ['obj.shop.upgrade', biz.level >= 2],
      ],
      bakery: [
        ['obj.bakery.open', !!this.flags.opened_business],
        ['obj.bakery.wheat', has('wheat') || biz.expenses > 0],
        ['obj.bakery.sale', biz.coffeeSold > 0],
        ['obj.market.open', !!this.flags.opened_market],
        ['obj.bakery.buy_wheat', tradedWithMe],
        ['obj.bakery.upgrade', biz.level >= 2],
      ],
      mini_market: [
        ['obj.market.openbiz', !!this.flags.opened_business],
        ['obj.market.stock', has('bread') || has('milk')],
        ['obj.market.sale', biz.coffeeSold > 0],
        ['obj.market.open', !!this.flags.opened_market],
        ['obj.market.buy_stock', tradedWithMe],
        ['obj.market.upgrade', biz.level >= 2],
      ],
    };
    const objs = objsByType[biz.type] ?? objsByType.farm;
    const allDone = objs.every(([, d]) => d);
    if (allDone) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const html =
      `<h3>${t('obj.title')} <button id="obj-hide">${t('obj.hide')}</button></h3>` +
      objs
        .map(([key, done]) => `<div class="obj ${done ? 'done' : ''}"><span class="tick">${done ? '✓' : '·'}</span>${t(key)}</div>`)
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
    const dur = hours > 0 ? t('away.hours', { h: hours, m: mins }) : t('away.minutes', { m: mins });
    const isFarm = biz?.type === 'farm';
    const overlay = document.createElement('div');
    overlay.className = 'overlay modal';
    overlay.innerHTML = `
      <div class="card">
        <h1>${t('away.title')}</h1>
        <div class="tagline">${t(isFarm ? 'away.tagline.farm' : 'away.tagline.generic', { dur })}</div>
        <div class="away-grid">
          <div class="away-cell"><div class="k">${t('away.revenue')}</div><div class="v" style="color:#16a34a">${fmt(r.revenue)}</div></div>
          <div class="away-cell"><div class="k">${t('away.expenses')}</div><div class="v" style="color:#dc2626">${fmt(r.expenses)}</div></div>
          <div class="away-cell"><div class="k">${t('away.profit')}</div><div class="v">${fmt(r.profit)}</div></div>
          ${isFarm
            ? `<div class="away-cell"><div class="k">${t('away.units_produced')}</div><div class="v">${biz!.production === 'wheat' ? '🌾' : '🥛'} ${r.milkProduced}</div></div>`
            : `<div class="away-cell"><div class="k">${t('away.items_sold')}</div><div class="v">${biz?.type === 'bakery' ? '🍞' : biz?.type === 'mini_market' ? '🛒' : '☕'} ${r.coffeeSold}</div></div>`}
        </div>
        <button class="btn primary" id="away-ok">${t('away.ok')}</button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#away-ok')!.addEventListener('click', () => {
      sfx.click();
      overlay.remove();
    });
  }
}
