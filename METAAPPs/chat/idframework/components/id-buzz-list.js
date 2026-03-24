import './id-attachments.js';
import './id-post-buzz.js';
import './id-image-viewer.js';
import './id-buzz-actions.js';
import './id-avatar.js';
import {
  buildBuzzRouteUrl,
  getBuzzRoutePathFromLocation,
  getCurrentBuzzRouteUrl,
  normalizeBuzzRoutePath,
  resolveBuzzRouteMode,
} from '../utils/buzz-route.js';

/**
 * id-buzz-list - Web Component for buzz feed rendering
 * Uses IDFramework command dispatch to fetch paginated buzz list.
 */
class IdBuzzList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._buzzList = [];
    this._total = 0;
    this._nextCursor = 0;
    this._hasMore = true;
    this._loading = false;
    this._loadingMore = false;
    this._error = '';
    this._observer = null;
    this._sentinel = null;
    this._quoteDetails = new Map();
    this._quoteLoading = new Set();
    this._userInfoCache = new Map();
    this._contentOverflow = new Map();
    this._contentExpanded = new Set();
    this._postModalOpen = false;
    this._emptyMessage = this._t('buzz.list.emptyDefault', 'No buzz data.');
    this._watchTimer = null;
    this._lastContextKey = '';
    this._hasUserScrolled = false;
    this._onWindowScroll = this._handleWindowScroll.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  static get observedAttributes() {
    return ['path', 'page-size', 'auto-load'];
  }

  connectedCallback() {
    this._ensureStoreShape();
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo(0, 0);
    }
    this._hasUserScrolled = false;
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    window.addEventListener('scroll', this._onWindowScroll, { passive: true });
    this.render();
    this._checkContext(true);
    this._watchTimer = setInterval(() => this._checkContext(false), 250);
  }

  disconnectedCallback() {
    this._teardownObserver();
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    window.removeEventListener('scroll', this._onWindowScroll);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'path' || name === 'page-size') {
      this.refresh();
    }
  }

  _handleLocaleChanged() {
    if (this._isGuestRestrictedMode()) {
      this._applyGuestRestrictedState();
    } else if (!this._error && (!Array.isArray(this._buzzList) || this._buzzList.length === 0)) {
      this._emptyMessage = this._isProfileMode()
        ? this._t('buzz.list.emptyProfile', 'No posts from this profile.')
        : this._t('buzz.list.emptyDefault', 'No buzz data.');
    }
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

  async refresh() {
    this._error = '';
    this._emptyMessage = this._t('buzz.list.emptyDefault', 'No buzz data.');
    this._resetCurrentSegment();
    this._syncViewFromStoreSegment();
    this._nextCursor = '';
    this._hasMore = true;
    this.render();
    if (this._isGuestRestrictedMode()) {
      this._applyGuestRestrictedState();
      this.render();
      return;
    }
    this._error = '';
    await this._fetchBuzz(false);
  }

  async _loadMore() {
    if (!this._hasMore || this._loadingMore || this._nextCursor === null || this._nextCursor === '') {
      return;
    }
    if (this._isGuestRestrictedMode()) return;
    await this._reportRecommendViewedBeforeLoadMore();
    await this._fetchBuzz(true);
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureStoreShape() {
    var buzz = this._getStore('buzz');
    var app = this._getStore('app');
    if (!buzz || !app) return;

    if (!buzz.tabs || typeof buzz.tabs !== 'object') buzz.tabs = {};
    ['new', 'hot', 'following', 'recommend'].forEach(function (tab) {
      if (!buzz.tabs[tab] || typeof buzz.tabs[tab] !== 'object') {
        buzz.tabs[tab] = {};
      }
      if (!Array.isArray(buzz.tabs[tab].list)) buzz.tabs[tab].list = [];
      if (buzz.tabs[tab].nextCursor === undefined) buzz.tabs[tab].nextCursor = '';
      if (buzz.tabs[tab].hasMore === undefined) buzz.tabs[tab].hasMore = true;
      if (buzz.tabs[tab].isLoading === undefined) buzz.tabs[tab].isLoading = false;
      if (buzz.tabs[tab].error === undefined) buzz.tabs[tab].error = '';
      if (buzz.tabs[tab].total === undefined) buzz.tabs[tab].total = 0;
    });
    if (!buzz.profile || typeof buzz.profile !== 'object') buzz.profile = {};
    if (!buzz.profile.byMetaid || typeof buzz.profile.byMetaid !== 'object') buzz.profile.byMetaid = {};
    if (!buzz.reportedRecommendIds || typeof buzz.reportedRecommendIds !== 'object') buzz.reportedRecommendIds = {};
    if (!buzz.pageSize || !Number.isFinite(Number(buzz.pageSize)) || Number(buzz.pageSize) <= 0) {
      buzz.pageSize = 10;
    }

    if (!app.route || typeof app.route !== 'object') app.route = {};
    if (!app.route.params || typeof app.route.params !== 'object') app.route.params = {};
    if (!app.buzzTab) app.buzzTab = 'new';
    if (app.profileMetaid === undefined || app.profileMetaid === null) app.profileMetaid = '';
  }

  _normalizeTab(raw) {
    var tab = String(raw || '').trim().toLowerCase();
    var allow = { new: true, hot: true, following: true, recommend: true };
    return allow[tab] ? tab : 'new';
  }

  _handleWindowScroll() {
    if (!this._hasUserScrolled && (window.scrollY || 0) > 12) {
      this._hasUserScrolled = true;
    }
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

  _setBrowserRoutePath(nextPath, useReplace) {
    var targetUrl = buildBuzzRouteUrl(window.location, nextPath, window);
    if (getCurrentBuzzRouteUrl(window.location, window) === targetUrl) return;
    if (useReplace) {
      window.history.replaceState({}, '', targetUrl);
    } else {
      window.history.pushState({}, '', targetUrl);
    }
  }

  _getCurrentRoutePath() {
    var fromLocation = this._getRoutePathFromLocation();
    if (fromLocation.indexOf('/home/') === 0 || fromLocation.indexOf('/profile/') === 0) {
      var appStore = this._getStore('app');
      if (appStore) {
        if (!appStore.route || typeof appStore.route !== 'object') appStore.route = {};
        appStore.route.path = fromLocation;
      }
      return fromLocation;
    }
    var app = this._getStore('app');
    var fromStore = app && app.route && app.route.path ? String(app.route.path) : '';
    if (fromStore.indexOf('/home/') === 0 || fromStore.indexOf('/profile/') === 0) return fromStore;
    return '/home/new';
  }

  _getCurrentTab() {
    var app = this._getStore('app');
    return this._normalizeTab(app && app.buzzTab ? app.buzzTab : 'new');
  }

  _parseProfileMetaidFromPath(path) {
    var matched = String(path || '').match(/^\/profile\/([^/?#]+)/);
    if (!matched || !matched[1]) return '';
    try {
      return decodeURIComponent(matched[1]);
    } catch (_) {
      return matched[1];
    }
  }

  _getCurrentProfileMetaid() {
    var path = this._getCurrentRoutePath();
    var fromPath = this._parseProfileMetaidFromPath(path);
    if (fromPath) {
      var appStore = this._getStore('app');
      if (appStore) appStore.profileMetaid = fromPath;
      return fromPath;
    }
    var app = this._getStore('app');
    var fromStore = String(app && app.profileMetaid ? app.profileMetaid : '').trim();
    if (fromStore) return fromStore;
    return '';
  }

  _isProfileMode() {
    var path = this._getCurrentRoutePath();
    return path.indexOf('/profile/') === 0 && !!this._getCurrentProfileMetaid();
  }

  _isWalletConnected() {
    var wallet = this._getStore('wallet');
    return !!(wallet && wallet.isConnected && wallet.address);
  }

  _isGuestRestrictedMode() {
    if (this._isProfileMode()) return false;
    var tab = this._getCurrentTab();
    if (tab !== 'following' && tab !== 'recommend') return false;
    return !this._isWalletConnected();
  }

  _applyGuestRestrictedState() {
    var tab = this._getCurrentTab();
    this._buzzList = [];
    this._total = 0;
    this._nextCursor = '';
    this._hasMore = false;
    this._error = '';
    this._emptyMessage = tab === 'following'
      ? this._t('buzz.list.guestFollowing', 'Connect wallet to view following feed.')
      : this._t('buzz.list.guestRecommend', 'Connect wallet to view recommended feed.');
  }

  _ensureProfileSegment(metaid) {
    var buzz = this._getStore('buzz');
    if (!buzz) return null;
    this._ensureStoreShape();
    var key = String(metaid || '').trim();
    if (!key) return null;
    if (!buzz.profile.byMetaid[key] || typeof buzz.profile.byMetaid[key] !== 'object') {
      buzz.profile.byMetaid[key] = {
        list: [],
        nextCursor: '',
        hasMore: true,
        isLoading: false,
        error: '',
        total: 0,
      };
    }
    return buzz.profile.byMetaid[key];
  }

  _getCurrentSegment() {
    var buzz = this._getStore('buzz');
    if (!buzz) return null;
    this._ensureStoreShape();
    if (this._isProfileMode()) {
      return this._ensureProfileSegment(this._getCurrentProfileMetaid());
    }
    var tab = this._getCurrentTab();
    return buzz.tabs[tab];
  }

  _resetCurrentSegment() {
    var segment = this._getCurrentSegment();
    if (!segment) return;
    segment.list = [];
    segment.nextCursor = '';
    segment.hasMore = true;
    segment.error = '';
    segment.total = 0;
  }

  _syncViewFromStoreSegment() {
    var segment = this._getCurrentSegment();
    if (!segment) return;
    this._buzzList = Array.isArray(segment.list) ? segment.list.slice() : [];
    this._total = Number(segment.total || 0);
    this._nextCursor = segment.nextCursor || '';
    this._hasMore = !!segment.hasMore;
    this._error = segment.error || '';
  }

  _contextKey() {
    var profileMetaid = this._getCurrentProfileMetaid();
    var tab = this._getCurrentTab();
    var path = this._getCurrentRoutePath();
    var connected = this._isWalletConnected() ? '1' : '0';
    var mode = this._isProfileMode() ? 'profile' : 'home';
    return [mode, tab, profileMetaid, path, connected].join('|');
  }

  _checkContext(force) {
    this._ensureStoreShape();
    var nextKey = this._contextKey();
    var changed = nextKey !== this._lastContextKey;
    if (!force && nextKey === this._lastContextKey) return;
    if (changed) {
      this._hasUserScrolled = false;
      if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
        window.scrollTo(0, 0);
      }
    }
    this._lastContextKey = nextKey;
    this._onContextChanged();
  }

  async _onContextChanged() {
    this._syncViewFromStoreSegment();
    if (this._isGuestRestrictedMode()) {
      this._applyGuestRestrictedState();
      this.render();
      this._setupObserver();
      return;
    }

    this._emptyMessage = this._t('buzz.list.emptyDefault', 'No buzz data.');
    this.render();
    this._setupObserver();

    var list = Array.isArray(this._buzzList) ? this._buzzList : [];
    if (list.length > 0) {
      return;
    }

    if (this.getAttribute('auto-load') === 'false') return;
    await this.refresh();
  }

  _isCommandRegistered(commandName) {
    if (!window.IDFramework || !window.IDFramework.IDController) return false;
    var controller = window.IDFramework.IDController;
    var inFileCommands = controller.commands && typeof controller.commands.has === 'function'
      ? controller.commands.has(commandName)
      : false;
    var inBuiltInCommands = controller.builtInCommands && typeof controller.builtInCommands.has === 'function'
      ? controller.builtInCommands.has(commandName)
      : false;
    return inFileCommands || inBuiltInCommands;
  }

  async _fetchBuzz(isLoadMore) {
    if (this._loading || this._loadingMore) return;
    if (this._isGuestRestrictedMode()) {
      this._applyGuestRestrictedState();
      this.render();
      return;
    }

    if (isLoadMore) {
      this._loadingMore = true;
    } else {
      this._loading = true;
    }
    this._error = '';
    this.render();

    try {
      if (!window.IDFramework) {
        throw new Error('IDFramework is not available');
      }
      await this._waitForCommand('fetchBuzz');

      var segment = this._getCurrentSegment();
      var cursor = isLoadMore ? (segment && segment.nextCursor ? segment.nextCursor : '') : '';
      var fetchPayload = this._buildFetchPayload(cursor);
      var result = await window.IDFramework.dispatch('fetchBuzz', fetchPayload);

      var rawList = Array.isArray(result && result.list) ? result.list : [];
      var pageSize = this._getPageSize();
      var list = rawList.length > pageSize ? rawList.slice(0, pageSize) : rawList;
      var total = Number((result && result.total) ?? 0);
      var nextCursor = (result && result.nextCursor !== undefined && result.nextCursor !== null)
        ? String(result.nextCursor)
        : '';
      if (!nextCursor && rawList.length > list.length && list.length > 0) {
        var lastItem = list[list.length - 1];
        var fallbackCursor = String((lastItem && (lastItem.id || lastItem.lastId)) || '').trim();
        if (fallbackCursor) nextCursor = fallbackCursor;
      }
      var hasMore = (result && result.hasMore !== undefined)
        ? !!result.hasMore
        : !!(nextCursor && list.length > 0);
      if (rawList.length > list.length) {
        hasMore = !!(nextCursor && list.length > 0);
      }

      if (segment) {
        segment.total = Number.isFinite(total) ? total : list.length;
        segment.nextCursor = nextCursor;
        segment.hasMore = hasMore;
        segment.error = '';
        if (isLoadMore) {
          segment.list = (Array.isArray(segment.list) ? segment.list : []).concat(list);
        } else {
          segment.list = list;
        }
      }

      this._syncViewFromStoreSegment();
      this._emptyMessage = this._isProfileMode()
        ? this._t('buzz.list.emptyProfile', 'No posts from this profile.')
        : this._t('buzz.list.emptyDefault', 'No buzz data.');
    } catch (error) {
      this._error = error && error.message ? error.message : this._t('buzz.list.fetchFailed', 'Failed to fetch buzz list');
      var segmentOnError = this._getCurrentSegment();
      if (segmentOnError) {
        segmentOnError.error = this._error;
        if (!isLoadMore) {
          segmentOnError.list = [];
          segmentOnError.nextCursor = '';
          segmentOnError.hasMore = false;
        }
      }
      this._syncViewFromStoreSegment();
    } finally {
      this._loading = false;
      this._loadingMore = false;
      this.render();
      this._setupObserver();
    }
  }

  _buildFetchPayload(cursor) {
    var payload = {
      size: this._getPageSize(),
      lastId: cursor || '',
    };

    if (this._isProfileMode()) {
      payload.tab = 'profile';
      payload.metaid = this._getCurrentProfileMetaid();
      return payload;
    }

    var tab = this._getCurrentTab();
    payload.tab = tab;

    var wallet = this._getStore('wallet');
    var userStore = this._getStore('user');
    var user = userStore && userStore.user ? userStore.user : null;
    var userAddress = String((wallet && wallet.address) || '').trim();
    var onchainMetaid = this._pickFirstOnchainMetaid([
      user && user.metaid,
      user && user.metaId,
      wallet && wallet.metaid,
      wallet && wallet.metaId,
      wallet && wallet.globalMetaIdInfo && wallet.globalMetaIdInfo.mvc && (wallet.globalMetaIdInfo.mvc.metaId || wallet.globalMetaIdInfo.mvc.metaid),
      wallet && wallet.globalMetaIdInfo && wallet.globalMetaIdInfo.btc && (wallet.globalMetaIdInfo.btc.metaId || wallet.globalMetaIdInfo.btc.metaid),
      user && user.globalMetaIdInfo && user.globalMetaIdInfo.mvc && (user.globalMetaIdInfo.mvc.metaId || user.globalMetaIdInfo.mvc.metaid),
      user && user.globalMetaIdInfo && user.globalMetaIdInfo.btc && (user.globalMetaIdInfo.btc.metaId || user.globalMetaIdInfo.btc.metaid),
    ]);

    if (tab === 'following') {
      payload.metaid = onchainMetaid;
      payload.userAddress = userAddress;
      payload.followed = '1';
    } else if (tab === 'recommend') {
      payload.userAddress = userAddress;
    }

    return payload;
  }

  _normalizeOnchainMetaid(raw) {
    var text = String(raw || '').trim().toLowerCase();
    if (!text) return '';
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    var matched = text.match(/[a-f0-9]{64}/);
    return matched && matched[0] ? matched[0] : '';
  }

  _pickFirstOnchainMetaid(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var normalized = this._normalizeOnchainMetaid(candidates[i]);
      if (normalized) return normalized;
    }
    return '';
  }

  async _waitForCommand(commandName, maxWaitMs = 5000) {
    var start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this._isCommandRegistered(commandName)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(commandName + ' command is not registered yet');
  }

  _pickBuzzPayload(pin) {
    var candidates = [
      this._tryParseJsonObject(pin && pin.content),
      this._tryParseJsonObject(pin && pin.contentSummary),
      this._tryParseJsonObject(pin && pin.contentBody),
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      var parsed = candidates[i];
      if (this._isBuzzPayload(parsed)) {
        return parsed;
      }
    }

    for (var j = 0; j < candidates.length; j += 1) {
      var fallback = candidates[j];
      if (fallback && typeof fallback === 'object') return fallback;
    }

    return {};
  }

  _tryParseJsonObject(rawValue) {
    if (!rawValue) return null;
    if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
      var text = rawValue.trim();
      if (!text || !this._looksLikeJson(text)) return null;
      try {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        return null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  _looksLikeJson(text) {
    if (!text) return false;
    var first = text[0];
    var last = text[text.length - 1];
    return (first === '{' && last === '}') || (first === '[' && last === ']');
  }

  _isBuzzPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    return payload.content !== undefined ||
      payload.publicContent !== undefined ||
      payload.attachments !== undefined ||
      payload.publicFiles !== undefined ||
      payload.quotePin !== undefined ||
      payload.quotePinId !== undefined;
  }

  _pickFirstString(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') {
        var text = value.trim();
        if (text) return text;
        continue;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        var converted = String(value).trim();
        if (converted) return converted;
        continue;
      }
      if (Array.isArray(value) && value.length > 0) {
        var nested = this._pickFirstString(value);
        if (nested) return nested;
      }
    }
    return '';
  }

  _flattenArray(input) {
    if (!Array.isArray(input)) return [];
    var output = [];
    input.forEach((item) => {
      if (Array.isArray(item)) {
        output = output.concat(this._flattenArray(item));
      } else {
        output.push(item);
      }
    });
    return output;
  }

  _normalizeAttachmentList(rawList) {
    var flattened = this._flattenArray(rawList);
    var normalized = [];
    flattened.forEach(function (item) {
      if (item === null || item === undefined) return;
      if (typeof item === 'string') {
        var text = item.trim();
        if (text) normalized.push(text);
        return;
      }
      if (typeof item === 'object') normalized.push(item);
    });
    return normalized;
  }

  _extractBuzzContent(pin, payload) {
    var fromPayload = this._pickFirstString([
      payload && payload.content,
      payload && payload.publicContent,
      payload && payload.text,
      payload && payload.message,
    ]);
    if (fromPayload) return fromPayload;

    var plain = this._pickFirstString([
      pin && pin.content,
      pin && pin.contentSummary,
      pin && pin.contentBody,
    ]);
    if (!plain) return '';
    if (this._looksLikeJson(plain)) return '';
    return plain;
  }

  _extractBuzzAttachments(pin, payload) {
    var source = [];
    if (Array.isArray(payload && payload.attachments)) {
      source = payload.attachments;
    } else if (Array.isArray(payload && payload.publicFiles)) {
      source = payload.publicFiles;
    } else if (Array.isArray(pin && pin.attachments)) {
      source = pin.attachments;
    }
    return this._normalizeAttachmentList(source);
  }

  _extractBuzzQuotePin(pin, payload) {
    var quoteRaw = this._pickFirstString([
      payload && payload.quotePin,
      payload && payload.quotePinId,
      payload && payload.quote_pin,
      pin && pin.quotePin,
      pin && pin.quotePinId,
      pin && pin.quote_pin,
    ]);
    return this._normalizePinReference(quoteRaw);
  }

  _normalizePinReference(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    var exact = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (exact && exact[0]) return exact[0];
    var cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.indexOf('metafile://') === 0) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.indexOf('/pin/') >= 0) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.indexOf('/content/') >= 0) cleaned = cleaned.split('/content/').pop() || '';
    var matched = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    if (matched && matched[0]) return matched[0];
    return cleaned.trim();
  }

  async _fetchUserInfoByAddress(address) {
    if (!address) return { name: '', metaId: '', avatar: '', address: '' };
    if (this._userInfoCache.has(address)) return this._userInfoCache.get(address);
    try {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var base = (serviceLocator.metafs || (window.IDConfig && window.IDConfig.METAFS_BASE_URL) || 'https://file.metaid.io/metafile-indexer/api/v1').replace(/\/+$/, '');
      var prefix = base.toLowerCase().slice(-3) === '/v1' ? '' : '/v1';
      var response = await fetch(base + prefix + '/users/address/' + encodeURIComponent(address), { method: 'GET' });
      if (!response.ok) throw new Error('fetch user info failed');
      var json = await response.json();
      var payload = json;
      if (json && typeof json.code === 'number') payload = json.data || {};
      if (json && json.data && typeof json.data === 'object' && !json.code) payload = json.data;
      var normalized = {
        name: (payload && payload.name) || '',
        metaId: (payload && (payload.metaId || payload.metaid || payload.globalMetaId)) || '',
        avatar: (payload && payload.avatar) || '',
        address: (payload && payload.address) || address,
      };
      this._userInfoCache.set(address, normalized);
      return normalized;
    } catch (error) {
      var fallback = { name: '', metaId: '', avatar: '', address: address };
      this._userInfoCache.set(address, fallback);
      return fallback;
    }
  }

  _normalizePinToBuzzItem(pin) {
    var payload = this._pickBuzzPayload(pin);
    var modifyHistory = Array.isArray(pin && pin.modify_history) ? pin.modify_history : [];
    return {
      id: (pin && pin.id) || '',
      address: (pin && pin.address) || '',
      timestamp: Number(pin && pin.timestamp) * 1000 || Date.now(),
      path: (pin && pin.path) || '',
      metaid: (pin && pin.metaid) || '',
      chainName: (pin && pin.chainName) || '',
      content: this._extractBuzzContent(pin, payload),
      attachments: this._extractBuzzAttachments(pin, payload),
      quotePin: this._extractBuzzQuotePin(pin, payload),
      lastId: modifyHistory.length ? modifyHistory[modifyHistory.length - 1] : ((pin && pin.id) || ''),
    };
  }

  _extractTxIdFromPinId(pinid) {
    if (!pinid) return '';
    return String(pinid).replace(/i0$/i, '');
  }

  _resolveExplorerUrl(chainName, pinid) {
    var txid = this._extractTxIdFromPinId(pinid);
    var chain = String(chainName || '').toLowerCase();
    if (!txid) return '';
    if (chain === 'btc') return 'https://mempool.space/tx/' + encodeURIComponent(txid);
    if (chain === 'mvc') return 'https://www.mvcscan.com/tx/' + encodeURIComponent(txid);
    return '';
  }

  _renderPinLink(item, extraClass) {
    var pinid = (item && item.id) || '';
    var chainName = (item && (item.chainName || (item.raw && item.raw.chainName))) || '';
    var explorerUrl = this._resolveExplorerUrl(chainName, pinid);
    if (!pinid || !explorerUrl) return '';
    var chain = String(chainName || '').toLowerCase();
    var chainClass = chain === 'btc' ? 'btc' : (chain === 'mvc' ? 'mvc' : 'unknown');
    var label = this._escapeHtml(String(pinid).slice(0, 8));
    return `
      <a class="pin-link ${chainClass} ${extraClass || ''}" href="${this._escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer">
        <svg class="pin-link-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M10.59 13.41a1 1 0 0 1 0-1.41l3-3a3 3 0 1 1 4.24 4.24l-2 2a3 3 0 0 1-4.24 0a1 1 0 1 1 1.41-1.41a1 1 0 0 0 1.42 0l2-2a1 1 0 1 0-1.42-1.42l-3 3a1 1 0 0 1-1.41 0Zm2.82-2.82a1 1 0 0 1 0 1.41l-3 3a3 3 0 0 1-4.24-4.24l2-2a3 3 0 0 1 4.24 0a1 1 0 0 1-1.41 1.41a1 1 0 0 0-1.42 0l-2 2a1 1 0 1 0 1.42 1.42l3-3a1 1 0 0 1 1.41 0Z"/>
        </svg>
        <span>${label}</span>
      </a>
    `;
  }

  async _fetchQuoteDetail(pinid) {
    var normalizedPinId = this._normalizePinReference(pinid);
    if (!normalizedPinId || this._quoteDetails.has(normalizedPinId) || this._quoteLoading.has(normalizedPinId)) return;
    this._quoteLoading.add(normalizedPinId);
    this.render();
    try {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var base = (serviceLocator.metaid_man || 'https://www.show.now/man').replace(/\/+$/, '');
      var response = await fetch(base + '/social/buzz/info?pinId=' + encodeURIComponent(normalizedPinId), { method: 'GET' });
      if (!response.ok) throw new Error('fetch quote detail failed');
      var json = await response.json();
      if (!json) throw new Error('fetch quote detail failed');
      var payload = (json && typeof json.code === 'number') ? (json.data || {}) : (json.data || json || {});
      var pin = payload && payload.tweet ? payload.tweet : payload;

      if (!pin || !pin.id) {
        // Backward-compatible fallback for non-social environments.
        if (this._isCommandRegistered('getPinDetail')) {
          pin = await window.IDFramework.dispatch('getPinDetail', { numberOrId: normalizedPinId });
        } else {
          var fallbackResp = await fetch(base + '/api/pin/' + encodeURIComponent(normalizedPinId), { method: 'GET' });
          if (!fallbackResp.ok) throw new Error('fetch quote detail failed');
          var fallbackJson = await fallbackResp.json();
          pin = (fallbackJson && typeof fallbackJson.code === 'number')
            ? (fallbackJson.data || null)
            : (fallbackJson.data || fallbackJson || null);
        }
      }

      if (!pin) throw new Error('empty quote detail');

      var normalized = this._normalizePinToBuzzItem(pin);
      normalized.id = normalized.id || normalizedPinId;
      normalized.userInfo = await this._fetchUserInfoByAddress(normalized.address);
      this._quoteDetails.set(normalizedPinId, normalized);
    } catch (error) {
      this._quoteDetails.set(normalizedPinId, {
        error: true,
        message: this._t('buzz.list.loadingQuotedBuzzFailed', 'Failed to load quoted buzz'),
        id: normalizedPinId,
        attachments: [],
      });
    } finally {
      this._quoteLoading.delete(normalizedPinId);
      this.render();
    }
  }

  _ensureQuoteDetail(pinid) {
    var normalizedPinId = this._normalizePinReference(pinid);
    if (!normalizedPinId) return;
    if (this._quoteDetails.has(normalizedPinId) || this._quoteLoading.has(normalizedPinId)) return;
    this._fetchQuoteDetail(normalizedPinId);
  }

  _isExpanded(contentKey) {
    return this._contentExpanded.has(contentKey);
  }

  _isOverflow(contentKey) {
    return this._contentOverflow.get(contentKey) === true;
  }

  _toggleContent(contentKey) {
    if (this._contentExpanded.has(contentKey)) {
      this._contentExpanded.delete(contentKey);
    } else {
      this._contentExpanded.add(contentKey);
    }
    this.render();
  }

  _updateContentOverflowStates() {
    var nodes = this.shadowRoot.querySelectorAll('[data-content-key]');
    var changed = false;
    nodes.forEach((node) => {
      var key = node.getAttribute('data-content-key');
      if (!key) return;
      var isOverflow = node.scrollHeight > 500;
      if (this._contentOverflow.get(key) !== isOverflow) {
        this._contentOverflow.set(key, isOverflow);
        changed = true;
      }
    });
    return changed;
  }

  _getPageSize() {
    var buzz = this._getStore('buzz');
    var fromStore = buzz ? Number(buzz.pageSize) : NaN;
    var value = Number(
      this.getAttribute('page-size') ||
      (Number.isFinite(fromStore) && fromStore > 0 ? fromStore : NaN) ||
      (window.IDConfig && window.IDConfig.BUZZ_PAGE_SIZE) ||
      10
    );
    if (!Number.isFinite(value) || value <= 0) return 10;
    return value;
  }

  async _reportRecommendViewedBeforeLoadMore() {
    if (this._isProfileMode()) return;
    if (this._getCurrentTab() !== 'recommend') return;
    if (!this._isWalletConnected()) return;
    if (!window.IDFramework) return;

    var wallet = this._getStore('wallet');
    var buzz = this._getStore('buzz');
    if (!wallet || !wallet.address || !buzz) return;

    var reported = buzz.reportedRecommendIds || {};
    var ids = (Array.isArray(this._buzzList) ? this._buzzList : [])
      .map(function (item) { return item && item.id ? String(item.id) : ''; })
      .filter(Boolean)
      .filter(function (id) { return !reported[id]; });

    if (ids.length === 0) return;
    if (!this._isCommandRegistered('reportBuzzViewed')) return;

    try {
      await this._waitForCommand('reportBuzzViewed', 2000);
      await window.IDFramework.dispatch('reportBuzzViewed', {
        address: wallet.address,
        pinIdList: ids,
      });
      ids.forEach(function (id) {
        buzz.reportedRecommendIds[id] = true;
      });
    } catch (_) {
      // Ignore reporting errors to avoid blocking feed pagination.
    }
  }

  _setupObserver() {
    this._teardownObserver();
    this._sentinel = this.shadowRoot.querySelector('.buzz-sentinel');
    if (!this._sentinel || !this._hasMore) return;

    this._observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            if (!this._hasUserScrolled) return;
            this._loadMore();
          }
        });
      },
      {
        root: null,
        rootMargin: '120px',
        threshold: 0.1,
      }
    );
    this._observer.observe(this._sentinel);
  }

  _teardownObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  _formatTime(timestamp) {
    if (!timestamp) return '--';
    try {
      return new Date(timestamp).toLocaleString();
    } catch (error) {
      return '--';
    }
  }

  _formatMetaId(metaId) {
    if (!metaId) return '';
    return metaId.slice(0, 6);
  }

  _tabLabel(tab) {
    var t = String(tab || '').toLowerCase();
    if (t === 'hot') return this._t('buzz.tabs.hot', 'Hot');
    if (t === 'following') return this._t('buzz.tabs.following', 'Following');
    if (t === 'recommend') return this._t('buzz.tabs.recommend', 'For You');
    return this._t('buzz.tabs.new', 'New');
  }

  _headerTitle() {
    return this._isProfileMode()
      ? this._t('buzz.list.headerTitleProfile', 'Profile Feed')
      : this._t('buzz.list.headerTitleFeed', 'Buzz Feed');
  }

  _headerSubtitle() {
    if (this._isProfileMode()) {
      return this._t('buzz.list.metaidPrefix', 'MetaID: {metaid}', {
        metaid: this._escapeHtml(this._getCurrentProfileMetaid() || '--'),
      });
    }
    return this._tabLabel(this._getCurrentTab()) + ' ' + this._t('buzz.list.timelineSuffix', 'Timeline');
  }

  _openProfile(metaid) {
    var profileMetaid = String(metaid || '').trim();
    if (!profileMetaid) return;
    var app = this._getStore('app');
    if (app) {
      if (!app.route || typeof app.route !== 'object') app.route = {};
      app.profileMetaid = profileMetaid;
      app.route.path = '/profile/' + encodeURIComponent(profileMetaid);
      app.route.params = { metaid: profileMetaid };
    }
    var path = '/profile/' + encodeURIComponent(profileMetaid);
    this._setBrowserRoutePath(path, false);
    this.dispatchEvent(new CustomEvent('id:buzz:profile-open', {
      detail: { metaid: profileMetaid },
      bubbles: true,
      composed: true,
    }));
    this._checkContext(true);
  }

  _goHome() {
    var app = this._getStore('app');
    if (app) {
      if (!app.route || typeof app.route !== 'object') app.route = {};
      app.buzzTab = 'new';
      app.profileMetaid = '';
      app.route.path = '/home/new';
      app.route.params = { tab: 'new' };
    }
    this._setBrowserRoutePath('/home/new', false);
    this.dispatchEvent(new CustomEvent('id:buzz:home-open', {
      detail: { tab: 'new' },
      bubbles: true,
      composed: true,
    }));
    this._checkContext(true);
  }

  _renderQuoteCard(quotePin) {
    var safePin = this._escapeHtml(quotePin || '');
    var quoteContentKey = 'quote-' + safePin;
    var quoteLoading = this._quoteLoading.has(quotePin);
    var quoteData = this._quoteDetails.get(quotePin);
    if (!quoteData) {
      return `<div class="quote-card quote-card-loading"><span class="spinner"></span>${this._t('buzz.list.loadingQuotedBuzz', 'Loading quoted buzz...')}</div>`;
    }
    if (quoteLoading) {
      return `<div class="quote-card quote-card-loading"><span class="spinner"></span>${this._t('buzz.list.loadingQuotedBuzz', 'Loading quoted buzz...')}</div>`;
    }
    if (quoteData.error) {
      return `<div class="quote-card quote-card-error" data-quote-pin="${safePin}">${this._escapeHtml(quoteData.message || this._t('buzz.list.quoteLoadFailedRetry', 'Load failed, click retry'))}</div>`;
    }

    var user = quoteData.userInfo || {};
    var metaId = this._formatMetaId(user.metaId || quoteData.metaid || '');
    var name = user.name || this._t('buzz.list.unknown', 'Unknown');
    var quoteContent = String(quoteData.content || '');
    var hasQuoteContent = quoteContent.trim().length > 0;
    return `
      <div class="quote-card quote-card-loaded" data-quote-pin="${safePin}">
        <div class="quote-user">
          <id-avatar class="quote-avatar-host" size="20" src="${this._escapeHtml(user.avatar || '')}" name="${this._escapeHtml(name)}" metaid="${this._escapeHtml(user.metaId || quoteData.metaid || '')}"></id-avatar>
          <div class="quote-user-meta">
            <div class="quote-name">${this._escapeHtml(name)}</div>
            <div class="quote-metaid">${this._escapeHtml(this._t('buzz.list.metaidPrefix', 'MetaID: {metaid}', { metaid: metaId || '--' }))}</div>
          </div>
        </div>
        ${hasQuoteContent ? `<div class="quote-content ${this._isOverflow(quoteContentKey) && !this._isExpanded(quoteContentKey) ? 'is-collapsed' : ''}" data-content-key="${quoteContentKey}">${this._escapeHtml(quoteContent)}</div>` : ''}
        ${hasQuoteContent && this._isOverflow(quoteContentKey) ? `<button class="content-toggle" data-toggle-content="${quoteContentKey}">${this._isExpanded(quoteContentKey) ? this._t('buzz.list.collapse', 'Collapse') : this._t('buzz.list.expand', 'Expand')}</button>` : ''}
        <id-attachments class="attachments-host quote-attachments-host" data-quote-attachments-pin="${safePin}"></id-attachments>
        <div class="pin-time-row quote-pin-time-row">
          ${this._renderPinLink(quoteData, 'quote-pin-link')}
          <span class="row-time">${this._escapeHtml(this._formatTime(quoteData.timestamp))}</span>
        </div>
      </div>
    `;
  }

  _renderBuzzItem(item, index) {
    if (item.quotePin) this._ensureQuoteDetail(item.quotePin);
    var user = item.userInfo || {};
    var name = user.name || this._t('buzz.list.unknown', 'Unknown');
    var metaId = this._formatMetaId(user.metaId || item.metaid || '');
    var profileMetaid = String(user.metaId || item.metaid || '').trim();
    var content = String(item.content || '');
    var hasContent = content.trim().length > 0;
    var quotePin = item.quotePin || '';
    var mainContentKey = 'main-' + String(index);

    return `
      <article class="buzz-item">
        <div class="buzz-user ${profileMetaid ? 'is-profile-link' : ''}" ${profileMetaid ? `data-profile-metaid="${this._escapeHtml(profileMetaid)}"` : ''}>
          <id-avatar class="avatar-host" size="36" src="${this._escapeHtml(user.avatar || '')}" name="${this._escapeHtml(name)}" metaid="${this._escapeHtml(user.metaId || item.metaid || '')}"></id-avatar>
          <div class="user-meta">
            <div class="name">${this._escapeHtml(name)}</div>
            <div class="sub">${this._escapeHtml(this._t('buzz.list.metaidPrefix', 'MetaID: {metaid}', { metaid: metaId || '--' }))}</div>
          </div>
        </div>
        ${hasContent ? `<div class="buzz-content ${this._isOverflow(mainContentKey) && !this._isExpanded(mainContentKey) ? 'is-collapsed' : ''}" data-content-key="${mainContentKey}">${this._escapeHtml(content)}</div>` : ''}
        ${hasContent && this._isOverflow(mainContentKey) ? `<button class="content-toggle" data-toggle-content="${mainContentKey}">${this._isExpanded(mainContentKey) ? this._t('buzz.list.collapse', 'Collapse') : this._t('buzz.list.expand', 'Expand')}</button>` : ''}
        <div class="buzz-footer">
          <id-attachments class="attachments-host" data-attachments-index="${index}"></id-attachments>
          ${quotePin ? this._renderQuoteCard(quotePin) : ''}
          <id-buzz-actions pin-id="${this._escapeHtml(item.id || '')}"></id-buzz-actions>
          <div class="pin-time-row buzz-pin-time-row">
            ${this._renderPinLink(item, 'buzz-pin-link')}
            <span class="row-time">${this._escapeHtml(this._formatTime(item.timestamp))}</span>
          </div>
        </div>
      </article>
    `;
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  render() {
    var title = this._headerTitle();
    var subtitle = this._headerSubtitle();
    var isProfileMode = this._isProfileMode();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          max-width: var(--id-feed-max-width, 760px);
          margin: 0 auto;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
          color: var(--id-text-main, #111827);
          box-sizing: border-box;
        }
        .buzz-wrap {
          background: var(--id-bg-card, #ffffff);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          padding: 12px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .header-actions {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .title {
          font-size: 16px;
          font-weight: 700;
          color: var(--id-text-title, #111827);
        }
        .subtitle {
          margin-top: 2px;
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
        }
        .post-btn {
          border: 1px solid #2563eb;
          border-radius: 999px;
          height: 32px;
          padding: 0 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .post-btn:hover {
          filter: brightness(1.03);
        }
        .refresh-btn {
          border: 1px solid var(--id-border-color, #d1d5db);
          border-radius: 8px;
          width: 32px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: var(--id-bg-card, #fff);
          color: var(--id-text-main, #111827);
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
        }
        .refresh-btn:hover {
          background: var(--id-border-color-light, #f9fafb);
        }
        .refresh-btn:active {
          transform: rotate(20deg);
        }
        .back-home-btn {
          border: 1px solid var(--id-border-color, #d1d5db);
          border-radius: 8px;
          height: 32px;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: var(--id-bg-card, #fff);
          color: var(--id-text-main, #111827);
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
        }
        .back-home-btn:hover {
          background: var(--id-border-color-light, #f9fafb);
        }
        .buzz-list {
          display: flex;
          flex-direction: column;
          gap: 18px;
          min-height: 120px;
        }
        .buzz-item {
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          padding: 12px;
          background: var(--id-bg-card, #fff);
          color: var(--id-text-main, #111827);
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        }
        .buzz-user {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .buzz-user.is-profile-link {
          cursor: pointer;
        }
        .buzz-user.is-profile-link:hover .name {
          text-decoration: underline;
          color: #1d4ed8;
        }
        .avatar-host {
          width: 36px;
          height: 36px;
          min-width: 36px;
          min-height: 36px;
          flex-shrink: 0;
        }
        .user-meta {
          flex: 1;
          min-width: 0;
        }
        .name {
          font-size: 14px;
          font-weight: 600;
          color: var(--id-text-main, #111827);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sub {
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
        }
        .buzz-content {
          margin-top: 8px;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 14px;
          color: var(--id-text-main, #111827);
          max-height: none;
          overflow: visible;
          position: relative;
        }
        .buzz-content.is-collapsed,
        .quote-content.is-collapsed {
          max-height: 500px;
          overflow: hidden;
        }
        .buzz-content.is-collapsed::after,
        .quote-content.is-collapsed::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 42px;
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0), var(--id-bg-card, #ffffff));
          pointer-events: none;
        }
        .quote-card {
          margin-top: 10px;
          margin-left: auto;
          margin-right: auto;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 10px;
          padding: 10px;
          background: var(--id-quote-bg, rgba(148, 163, 184, 0.12));
          width: 100%;
          max-width: 100%;
          min-width: 0;
          box-sizing: border-box;
          align-self: center;
        }
        .quote-card:hover {
          background: var(--id-quote-bg-hover, rgba(148, 163, 184, 0.2));
        }
        .quote-card-loading {
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
          display: flex;
          align-items: center;
        }
        .quote-card-error {
          font-size: 12px;
          color: var(--id-text-error, #b91c1c);
          cursor: pointer;
        }
        .quote-user {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .quote-user-meta {
          flex: 1;
          min-width: 0;
        }
        .quote-name {
          font-size: 12px;
          font-weight: 600;
          color: var(--id-text-main, #111827);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .quote-avatar-host {
          width: 20px;
          height: 20px;
          min-width: 20px;
          min-height: 20px;
          flex-shrink: 0;
        }
        .quote-metaid {
          font-size: 11px;
          color: var(--id-text-secondary, #6b7280);
        }
        .quote-content {
          font-size: 13px;
          line-height: 1.45;
          color: var(--id-text-main, #111827);
          margin-bottom: 8px;
          white-space: pre-wrap;
          word-break: break-word;
          position: relative;
        }
        .buzz-footer {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
          margin-top: 8px;
          flex-wrap: wrap;
          width: 100%;
        }
        .attachments-host {
          width: 100%;
        }
        .content-toggle {
          margin-top: 8px;
          border: none;
          background: transparent;
          color: #2563eb;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          padding: 0;
        }
        .content-toggle:hover {
          color: #1d4ed8;
        }
        .pin-link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          text-decoration: none;
          font-size: 12px;
          font-weight: 600;
        }
        .pin-link-icon {
          width: 25px;
          height: 25px;
          flex-shrink: 0;
        }
        .pin-link.btc {
          color: #d97706;
        }
        .pin-link.mvc {
          color: #2563eb;
        }
        .pin-link.unknown {
          color: #4b5563;
        }
        .pin-link:hover {
          text-decoration: underline;
        }
        .quote-pin-link {
          margin-top: 2px;
        }
        .pin-time-row {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .row-time {
          font-size: 12px;
          color: var(--id-text-tertiary, #9ca3af);
          white-space: nowrap;
          margin-left: auto;
        }
        .loading,
        .loading-more,
        .empty,
        .error {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 72px;
          color: #6b7280;
          font-size: 13px;
          text-align: center;
        }
        .error {
          color: var(--id-text-error, #b91c1c);
        }
        .spinner {
          width: 16px;
          height: 16px;
          border: 2px solid #e5e7eb;
          border-top-color: #2563eb;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-right: 8px;
        }
        .buzz-sentinel {
          height: 1px;
        }
        .post-modal {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          z-index: 99999;
          display: ${this._postModalOpen ? 'flex' : 'none'};
          align-items: center;
          justify-content: center;
          padding: 16px;
          box-sizing: border-box;
        }
        .post-modal-card {
          width: min(760px, 96vw);
          max-height: 92vh;
          overflow: auto;
          background: #ffffff;
          border-radius: 14px;
          border: 1px solid #e5e7eb;
          box-shadow: 0 16px 50px rgba(15, 23, 42, 0.25);
          padding: 12px;
          box-sizing: border-box;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
      <section class="buzz-wrap">
        <div class="header">
          <div>
            <div class="title">${title}</div>
            <div class="subtitle">${subtitle}</div>
          </div>
          <div class="header-actions">
            ${isProfileMode ? `<button class="back-home-btn" data-action="back-home" title="${this._escapeHtml(this._t('buzz.list.backHome', 'Back Home'))}" aria-label="${this._escapeHtml(this._t('buzz.list.backHome', 'Back Home'))}">← ${this._escapeHtml(this._t('buzz.list.backHome', 'Back Home'))}</button>` : ''}
            <button class="post-btn" data-action="open-post" title="${this._escapeHtml(this._t('buzz.list.post', 'Post'))}" aria-label="${this._escapeHtml(this._t('buzz.list.post', 'Post'))}">${this._escapeHtml(this._t('buzz.list.post', 'Post'))}</button>
            <button class="refresh-btn" data-action="refresh" title="${this._escapeHtml(this._t('buzz.list.refresh', 'Refresh'))}" aria-label="${this._escapeHtml(this._t('buzz.list.refresh', 'Refresh'))}">↻</button>
          </div>
        </div>
        <div class="buzz-list">
          ${this._loading ? `<div class="loading"><span class="spinner"></span>${this._escapeHtml(this._t('buzz.list.loadingBuzz', 'Loading buzz...'))}</div>` : ''}
          ${!this._loading && this._error ? `<div class="error">${this._escapeHtml(this._error)}</div>` : ''}
          ${!this._loading && !this._error && this._buzzList.length === 0 ? `<div class="empty">${this._escapeHtml(this._emptyMessage || this._t('buzz.list.emptyDefault', 'No buzz data.'))}</div>` : ''}
          ${!this._loading ? this._buzzList.map((item, index) => this._renderBuzzItem(item, index)).join('') : ''}
          ${this._loadingMore ? `<div class="loading-more"><span class="spinner"></span>${this._escapeHtml(this._t('buzz.list.loadingMore', 'Loading more...'))}</div>` : ''}
          <div class="buzz-sentinel"></div>
        </div>
      </section>
      <div class="post-modal" data-action="post-modal-overlay">
        <div class="post-modal-card">
          <id-post-buzz></id-post-buzz>
        </div>
      </div>
      <id-image-viewer></id-image-viewer>
    `;

    var attachmentHosts = this.shadowRoot.querySelectorAll('id-attachments[data-attachments-index]');
    attachmentHosts.forEach((host) => {
      var index = Number(host.getAttribute('data-attachments-index'));
      var attachments = this._buzzList[index] && Array.isArray(this._buzzList[index].attachments)
        ? this._buzzList[index].attachments
        : [];
      host.attachments = attachments;
    });

    var quoteAttachmentHosts = this.shadowRoot.querySelectorAll('id-attachments[data-quote-attachments-pin]');
    quoteAttachmentHosts.forEach((host) => {
      var pinid = host.getAttribute('data-quote-attachments-pin');
      var quoteData = pinid ? this._quoteDetails.get(pinid) : null;
      var attachments = quoteData && Array.isArray(quoteData.attachments) ? quoteData.attachments : [];
      host.attachments = attachments;
    });

    var toggles = this.shadowRoot.querySelectorAll('[data-toggle-content]');
    toggles.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        var contentKey = button.getAttribute('data-toggle-content');
        if (contentKey) this._toggleContent(contentKey);
      });
    });

    var profileLinks = this.shadowRoot.querySelectorAll('[data-profile-metaid]');
    profileLinks.forEach((node) => {
      node.addEventListener('click', () => {
        var metaid = node.getAttribute('data-profile-metaid');
        this._openProfile(metaid || '');
      });
    });

    var quoteRetryNodes = this.shadowRoot.querySelectorAll('.quote-card-error[data-quote-pin]');
    quoteRetryNodes.forEach((node) => {
      node.addEventListener('click', () => {
        var pinid = node.getAttribute('data-quote-pin');
        if (!pinid) return;
        this._quoteDetails.delete(pinid);
        this._fetchQuoteDetail(pinid);
      });
    });

    if (this._updateContentOverflowStates()) {
      this.render();
      return;
    }

    var refreshBtn = this.shadowRoot.querySelector('[data-action="refresh"]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refresh());
    }

    var backHomeBtn = this.shadowRoot.querySelector('[data-action="back-home"]');
    if (backHomeBtn) {
      backHomeBtn.addEventListener('click', () => this._goHome());
    }

    var openPostBtn = this.shadowRoot.querySelector('[data-action="open-post"]');
    if (openPostBtn) {
      openPostBtn.addEventListener('click', () => {
        this._postModalOpen = true;
        this.render();
      });
    }

    var modalOverlay = this.shadowRoot.querySelector('[data-action="post-modal-overlay"]');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (event) => {
        if (event.target === modalOverlay) {
          this._postModalOpen = false;
          this.render();
        }
      });
    }

    var postComposer = this.shadowRoot.querySelector('id-post-buzz');
    if (postComposer) {
      postComposer.addEventListener('close', () => {
        this._postModalOpen = false;
        this.render();
      });
      postComposer.addEventListener('buzz-posted', () => {
        this._postModalOpen = false;
        this.refresh();
      });
    }

    // Re-bind observer after every render because shadow DOM nodes are replaced.
    this._setupObserver();
  }
}

if (!customElements.get('id-buzz-list')) {
  customElements.define('id-buzz-list', IdBuzzList);
}
