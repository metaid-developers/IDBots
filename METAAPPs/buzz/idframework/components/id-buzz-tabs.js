import {
  buildBuzzRouteUrl,
  getBuzzRoutePathFromLocation,
  getCurrentBuzzRouteUrl,
  normalizeBuzzRoutePath,
  resolveBuzzRouteMode,
} from '../utils/buzz-route.js';

class IdBuzzTabs extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastStateSignature = '';
    this._onPopState = this._handlePopState.bind(this);
    this._onHashChange = this._handlePopState.bind(this);
    this._onConnected = this._handleWalletStateChanged.bind(this);
    this._onDisconnected = this._handleWalletStateChanged.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    this._syncStoreFromLocation(true);
    window.addEventListener('popstate', this._onPopState);
    window.addEventListener('hashchange', this._onHashChange);
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    document.addEventListener('connected', this._onConnected);
    document.addEventListener('disconnected', this._onDisconnected);
    this._watchTimer = setInterval(() => this._checkStateAndRender(), 250);
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener('popstate', this._onPopState);
    window.removeEventListener('hashchange', this._onHashChange);
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    document.removeEventListener('connected', this._onConnected);
    document.removeEventListener('disconnected', this._onDisconnected);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureAppStoreShape() {
    var app = this._getStore('app');
    if (!app) return null;
    if (!app.route || typeof app.route !== 'object') app.route = {};
    if (!app.route.params || typeof app.route.params !== 'object') app.route.params = {};
    if (!app.buzzTab) app.buzzTab = 'new';
    if (app.profileMetaid === undefined || app.profileMetaid === null) app.profileMetaid = '';
    return app;
  }

  _isWalletConnected() {
    var wallet = this._getStore('wallet');
    return !!(wallet && wallet.isConnected && wallet.address);
  }

  _availableTabs() {
    var tabs = ['new', 'hot'];
    if (this._isWalletConnected()) {
      tabs.push('following', 'recommend');
    }
    return tabs;
  }

  _normalizeHomeTab(tab) {
    var normalized = String(tab || '').trim().toLowerCase();
    var allow = { new: true, hot: true, following: true, recommend: true };
    return allow[normalized] ? normalized : 'new';
  }

  _parseProfileMetaid(pathname) {
    var path = String(pathname || '');
    var matched = path.match(/^\/profile\/([^/?#]+)/);
    if (!matched || !matched[1]) return '';
    try {
      return decodeURIComponent(matched[1]);
    } catch (_) {
      return matched[1];
    }
  }

  _setRoute(pathname, params) {
    var app = this._ensureAppStoreShape();
    if (!app) return;
    app.route.path = pathname;
    app.route.params = params || {};
  }

  _isDemoDocumentPath() {
    return resolveBuzzRouteMode(window.location, window) === 'hash';
  }

  _normalizeRoutePath(pathname) {
    return normalizeBuzzRoutePath(pathname);
  }

  _getRoutePathFromLocation() {
    return getBuzzRoutePathFromLocation(window.location, window);
  }

  _replaceUrl(pathname) {
    var targetUrl = buildBuzzRouteUrl(window.location, pathname, window);
    if (getCurrentBuzzRouteUrl(window.location, window) === targetUrl) return;
    window.history.replaceState({}, '', targetUrl);
  }

  _pushUrl(pathname) {
    var targetUrl = buildBuzzRouteUrl(window.location, pathname, window);
    if (getCurrentBuzzRouteUrl(window.location, window) === targetUrl) return;
    window.history.pushState({}, '', targetUrl);
  }

  _syncStoreFromLocation(rewriteDefaultHome) {
    var app = this._ensureAppStoreShape();
    if (!app) return;

    var pathname = this._getRoutePathFromLocation();
    var isRoot = pathname === '/';
    var isHomeRoot = pathname === '/home';

    if (isRoot || isHomeRoot) {
      var defaultPath = '/home/new';
      this._replaceUrl(defaultPath);
      app.buzzTab = 'new';
      app.profileMetaid = '';
      this._setRoute(defaultPath, { tab: 'new' });
      return;
    }

    if (pathname.indexOf('/home/') === 0) {
      var tab = this._normalizeHomeTab(pathname.slice('/home/'.length));
      var canonical = '/home/' + tab;
      if (canonical !== pathname) {
        this._replaceUrl(canonical);
        pathname = canonical;
      }
      app.buzzTab = tab;
      app.profileMetaid = '';
      this._setRoute(pathname, { tab: tab });
      return;
    }

    if (pathname.indexOf('/profile/') === 0) {
      var metaid = this._parseProfileMetaid(pathname);
      app.profileMetaid = metaid;
      this._setRoute(pathname, { metaid: metaid });
      return;
    }

    var fallback = '/home/new';
    this._replaceUrl(fallback);
    app.buzzTab = 'new';
    app.profileMetaid = '';
    this._setRoute(fallback, { tab: 'new' });
  }

  _handlePopState() {
    this._syncStoreFromLocation(false);
    this._checkStateAndRender(true);
  }

  _handleWalletStateChanged() {
    this._checkStateAndRender(true);
  }

  _handleLocaleChanged() {
    this.render();
  }

  _t(key, fallback, params) {
    if (
      typeof window !== 'undefined' &&
      window.IDFramework &&
      window.IDFramework.I18n &&
      typeof window.IDFramework.I18n.t === 'function'
    ) {
      return window.IDFramework.I18n.t(key, params || {}, fallback || '');
    }
    return fallback || '';
  }

  _buildStateSignature() {
    var app = this._ensureAppStoreShape();
    var path = app && app.route ? String(app.route.path || '') : '';
    var tab = app ? String(app.buzzTab || '') : '';
    var connected = this._isWalletConnected() ? '1' : '0';
    return [path, tab, connected].join('|');
  }

  _checkStateAndRender(force) {
    this._syncStoreFromLocation(false);
    var signature = this._buildStateSignature();
    if (!force && signature === this._lastStateSignature) return;
    this._lastStateSignature = signature;
    this.render();
  }

  _onTabClick(tab) {
    var app = this._ensureAppStoreShape();
    if (!app) return;
    var nextTab = this._normalizeHomeTab(tab);
    app.buzzTab = nextTab;
    app.profileMetaid = '';
    var nextPath = '/home/' + nextTab;
    this._setRoute(nextPath, { tab: nextTab });
    this._pushUrl(nextPath);
    this.dispatchEvent(new CustomEvent('id:buzz:tab-change', {
      detail: { tab: nextTab },
      bubbles: true,
      composed: true,
    }));
    this._checkStateAndRender(true);
  }

  render() {
    var app = this._ensureAppStoreShape();
    var path = app && app.route ? String(app.route.path || this._getRoutePathFromLocation() || '/home/new') : '/home/new';
    var inHome = path.indexOf('/home/') === 0 || path === '/home/new' || path === '/home/hot' || path === '/home/following' || path === '/home/recommend';
    var activeTab = app ? this._normalizeHomeTab(app.buzzTab || 'new') : 'new';
    var availableTabs = this._availableTabs();

    var tabDefs = [
      { key: 'new', label: this._t('buzz.tabs.new', 'New') },
      { key: 'hot', label: this._t('buzz.tabs.hot', 'Hot') },
      { key: 'following', label: this._t('buzz.tabs.following', 'Following') },
      { key: 'recommend', label: this._t('buzz.tabs.recommend', 'For You') },
    ];

    var tabHtml = tabDefs
      .filter(function (item) { return availableTabs.indexOf(item.key) > -1; })
      .map((item) => {
        var isActive = item.key === activeTab;
        return '<button class="tab-btn ' + (isActive ? 'is-active' : '') + '" data-tab="' + item.key + '">' + item.label + '</button>';
      })
      .join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          max-width: var(--id-feed-max-width, 760px);
          margin: 0 auto;
          box-sizing: border-box;
        }
        .tabs-wrap {
          display: ${inHome ? 'flex' : 'none'};
          align-items: center;
          gap: 8px;
          padding: 8px;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          background: var(--id-bg-card, #ffffff);
          margin-bottom: 12px;
          overflow-x: auto;
        }
        .tab-btn {
          border: 1px solid #d1d5db;
          background: #fff;
          color: #111827;
          border-radius: 999px;
          height: 32px;
          padding: 0 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .tab-btn:hover {
          background: #f9fafb;
        }
        .tab-btn.is-active {
          color: #ffffff;
          border-color: #2563eb;
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
        }
      </style>
      <section class="tabs-wrap">
        ${tabHtml}
      </section>
    `;

    var buttons = this.shadowRoot.querySelectorAll('[data-tab]');
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        var tab = button.getAttribute('data-tab') || 'new';
        this._onTabClick(tab);
      });
    });
  }
}

if (!customElements.get('id-buzz-tabs')) {
  customElements.define('id-buzz-tabs', IdBuzzTabs);
}
