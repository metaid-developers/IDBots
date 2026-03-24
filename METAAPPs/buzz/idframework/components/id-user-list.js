import './id-avatar.js';
import './id-follow-button.js';
import {
  buildBuzzRouteUrl,
  getBuzzRoutePathFromLocation,
  getCurrentBuzzRouteUrl,
  normalizeBuzzRoutePath,
  resolveBuzzRouteMode,
} from '../utils/buzz-route.js';

/**
 * id-user-list
 *
 * Relationship list component for profile pages:
 * - following
 * - followers
 *
 * Data source:
 * - Alpine.store('buzz').userList.byMetaid
 * - fetchUserList command
 */
class IdUserList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastContextKey = '';
    this._currentType = 'following';
    this._list = [];
    this._loading = false;
    this._error = '';
    this._hasMore = false;
    this._total = 0;
    this._nextCursor = '';
    this._panelOpen = false;
    this._onExternalSwitch = this._handleExternalSwitch.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  static get observedAttributes() {
    return ['page-size'];
  }

  connectedCallback() {
    this._ensureStoreShape();
    document.addEventListener('id:user-list:switch', this._onExternalSwitch);
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    this.render();
    this._checkContext(true);
    this._watchTimer = setInterval(() => this._checkContext(false), 280);
  }

  disconnectedCallback() {
    document.removeEventListener('id:user-list:switch', this._onExternalSwitch);
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'page-size' && this.isConnected) {
      this.refresh();
    }
  }

  _handleExternalSwitch(event) {
    var detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
    var type = this._normalizeType(event && event.detail ? event.detail.type : '');
    if (!type || !this._isProfileMode()) return;
    var shouldOpen = detail.open !== false;
    if (shouldOpen) this._setPanelOpen(true);
    this._setActiveType(type, shouldOpen);
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

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureStoreShape() {
    var buzz = this._getStore('buzz');
    var app = this._getStore('app');
    if (!buzz || !app) return;

    if (!buzz.userList || typeof buzz.userList !== 'object') {
      buzz.userList = {};
    }
    if (!buzz.userList.byMetaid || typeof buzz.userList.byMetaid !== 'object') {
      buzz.userList.byMetaid = {};
    }
    if (!buzz.userList.pageSize || !Number.isFinite(Number(buzz.userList.pageSize)) || Number(buzz.userList.pageSize) <= 0) {
      var fromBuzzPageSize = Number(buzz.pageSize);
      buzz.userList.pageSize = (Number.isFinite(fromBuzzPageSize) && fromBuzzPageSize > 0) ? Math.round(fromBuzzPageSize) : 10;
    }

    if (!app.route || typeof app.route !== 'object') app.route = {};
    if (!app.route.params || typeof app.route.params !== 'object') app.route.params = {};
    if (app.profileMetaid === undefined || app.profileMetaid === null) app.profileMetaid = '';
  }

  _createListState() {
    return {
      list: [],
      nextCursor: '0',
      hasMore: true,
      isLoading: false,
      hasLoaded: false,
      error: '',
      total: 0,
      lastUpdatedAt: 0,
    };
  }

  _ensureProfileSegment(metaid) {
    var buzz = this._getStore('buzz');
    if (!buzz) return null;
    this._ensureStoreShape();
    var key = this._pickFirstString([metaid]);
    if (!key) return null;

    if (!buzz.userList.byMetaid[key] || typeof buzz.userList.byMetaid[key] !== 'object') {
      buzz.userList.byMetaid[key] = {
        activeType: 'following',
        panelOpen: false,
        following: this._createListState(),
        followers: this._createListState(),
      };
    }
    var segment = buzz.userList.byMetaid[key];
    if (!segment.following || typeof segment.following !== 'object') segment.following = this._createListState();
    if (!segment.followers || typeof segment.followers !== 'object') segment.followers = this._createListState();
    segment.activeType = this._normalizeType(segment.activeType);
    segment.panelOpen = !!segment.panelOpen;
    return segment;
  }

  _getCurrentSegment() {
    if (!this._isProfileMode()) return null;
    var metaid = this._getCurrentProfileMetaid();
    return this._ensureProfileSegment(metaid);
  }

  _getCurrentType() {
    var segment = this._getCurrentSegment();
    if (!segment) return 'following';
    return this._normalizeType(segment.activeType);
  }

  _getCurrentListState() {
    var segment = this._getCurrentSegment();
    if (!segment) return null;
    var type = this._getCurrentType();
    return type === 'followers' ? segment.followers : segment.following;
  }

  _setActiveType(type, shouldFetch) {
    var segment = this._getCurrentSegment();
    if (!segment) return;
    var nextType = this._normalizeType(type);
    if (segment.activeType === nextType && !shouldFetch) return;
    segment.activeType = nextType;
    this._syncViewFromStore();
    this.render();
    var state = this._getCurrentListState();
    if (shouldFetch && state && !state.hasLoaded && !state.isLoading) {
      this._fetchUsers(false);
    }
  }

  _setPanelOpen(open) {
    var segment = this._getCurrentSegment();
    if (!segment) return;
    segment.panelOpen = !!open;
    this._syncViewFromStore();
    this.render();
  }

  _closePanel() {
    this._setPanelOpen(false);
  }

  _normalizeType(raw) {
    var type = String(raw || '').trim().toLowerCase();
    if (type === 'follower' || type === 'followers' || type === 'fans') return 'followers';
    return 'following';
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

  _parseProfileMetaid(pathname) {
    var matched = String(pathname || '').match(/^\/profile\/([^/?#]+)/);
    if (!matched || !matched[1]) return '';
    try {
      return decodeURIComponent(matched[1]);
    } catch (_) {
      return matched[1];
    }
  }

  _getCurrentProfileMetaid() {
    var path = this._getCurrentRoutePath();
    var fromPath = this._parseProfileMetaid(path);
    if (fromPath) {
      var app = this._getStore('app');
      if (app) app.profileMetaid = fromPath;
      return fromPath;
    }
    var appStore = this._getStore('app');
    return this._pickFirstString([appStore && appStore.profileMetaid]);
  }

  _isProfileMode() {
    var path = this._getCurrentRoutePath();
    return path.indexOf('/profile/') === 0 && !!this._getCurrentProfileMetaid();
  }

  _effectivePageSize() {
    var attr = Number(this.getAttribute('page-size'));
    if (Number.isFinite(attr) && attr > 0) return Math.max(1, Math.min(50, Math.round(attr)));
    var buzz = this._getStore('buzz');
    var fromUserList = Number(buzz && buzz.userList && buzz.userList.pageSize);
    if (Number.isFinite(fromUserList) && fromUserList > 0) return Math.max(1, Math.min(50, Math.round(fromUserList)));
    var fromBuzz = Number(buzz && buzz.pageSize);
    if (Number.isFinite(fromBuzz) && fromBuzz > 0) return Math.max(1, Math.min(50, Math.round(fromBuzz)));
    return 10;
  }

  async refresh() {
    var state = this._getCurrentListState();
    if (!state) return;
    state.list = [];
    state.nextCursor = '0';
    state.hasMore = true;
    state.error = '';
    state.total = 0;
    state.hasLoaded = false;
    this._syncViewFromStore();
    this.render();
    await this._fetchUsers(false);
  }

  _contextKey() {
    var mode = this._isProfileMode() ? 'profile' : 'home';
    var path = this._getCurrentRoutePath();
    var metaid = this._getCurrentProfileMetaid();
    var type = this._getCurrentType();
    var segment = this._getCurrentSegment();
    var panelOpen = segment && segment.panelOpen ? '1' : '0';
    var state = this._getCurrentListState();
    var stateSignature = '';
    if (state) {
      stateSignature = [
        String(state.list && state.list.length || 0),
        state.nextCursor || '',
        state.hasMore ? '1' : '0',
        state.isLoading ? '1' : '0',
        state.hasLoaded ? '1' : '0',
        state.error || '',
        String(state.total || 0),
        String(state.lastUpdatedAt || 0),
      ].join('|');
    }
    return [mode, path, metaid, type, panelOpen, stateSignature].join('||');
  }

  _checkContext(force) {
    this._ensureStoreShape();
    var nextKey = this._contextKey();
    if (!force && nextKey === this._lastContextKey) return;
    this._lastContextKey = nextKey;
    this._syncViewFromStore();
    this.render();

    if (!this._isProfileMode()) return;
    if (!this._panelOpen) return;
    var state = this._getCurrentListState();
    if (!state || state.hasLoaded || state.isLoading) return;
    this._fetchUsers(false);
  }

  _syncViewFromStore() {
    var state = this._getCurrentListState();
    this._currentType = this._getCurrentType();
    var segment = this._getCurrentSegment();
    this._panelOpen = !!(segment && segment.panelOpen);
    if (!state) {
      this._list = [];
      this._loading = false;
      this._error = '';
      this._hasMore = false;
      this._total = 0;
      this._nextCursor = '';
      this._panelOpen = false;
      return;
    }
    this._list = Array.isArray(state.list) ? state.list.slice() : [];
    this._loading = !!state.isLoading;
    this._error = this._pickFirstString([state.error]);
    this._hasMore = !!state.hasMore;
    this._total = Number(state.total || 0);
    this._nextCursor = this._pickFirstString([state.nextCursor]);
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

  async _dispatch(commandName, payload) {
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') {
      throw new Error('IDFramework dispatch is not available');
    }
    if (!this._isCommandRegistered(commandName)) {
      throw new Error('Command is not registered: ' + commandName);
    }
    return await window.IDFramework.dispatch(commandName, payload || {});
  }

  _normalizeCursor(raw, fallback) {
    var n = Number(this._pickFirstString([raw]));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n);
  }

  async _fetchUsers(append) {
    if (!this._isProfileMode()) return;
    if (!this._panelOpen) return;
    var profileMetaid = this._getCurrentProfileMetaid();
    var state = this._getCurrentListState();
    if (!state || !profileMetaid) return;
    if (state.isLoading) return;
    if (append && !state.hasMore) return;

    if (!this._isCommandRegistered('fetchUserList')) {
      state.error = this._t('buzz.userList.fetchCommandMissing', 'fetchUserList command is not registered');
      state.hasLoaded = true;
      this._syncViewFromStore();
      this.render();
      return;
    }

    var requestCursor = append
      ? this._normalizeCursor(state.nextCursor, state.list.length)
      : 0;
    var requestSize = this._effectivePageSize();
    var requestType = this._getCurrentType();

    state.isLoading = true;
    if (!append) {
      state.error = '';
      state.list = [];
      state.nextCursor = '0';
      state.hasMore = true;
      state.total = 0;
    }
    this._syncViewFromStore();
    this.render();

    try {
      var response = await this._dispatch('fetchUserList', {
        metaid: profileMetaid,
        type: requestType,
        cursor: requestCursor,
        size: requestSize,
        followDetail: true,
      });

      var incoming = Array.isArray(response && response.list) ? response.list : [];
      if (append) {
        state.list = this._mergeUserList(state.list, incoming);
      } else {
        state.list = incoming.slice();
      }

      var total = Number(response && response.total);
      if (!Number.isFinite(total) || total < 0) total = state.list.length;
      state.total = total;

      var nextCursor = this._pickFirstString([response && response.nextCursor]);
      var hasMoreFromResponse = !!(response && response.hasMore);
      if (!nextCursor && hasMoreFromResponse) {
        nextCursor = String(requestCursor + incoming.length);
      }

      state.nextCursor = nextCursor || '';
      state.hasMore = hasMoreFromResponse && !!state.nextCursor;
      state.error = '';
      state.hasLoaded = true;
      state.lastUpdatedAt = Date.now();
    } catch (error) {
      state.error = (error && error.message) ? error.message : this._t('buzz.userList.loadFailed', 'Failed to load user list');
      state.hasLoaded = true;
    } finally {
      state.isLoading = false;
    }

    this._syncViewFromStore();
    this.render();
  }

  _mergeUserList(existing, incoming) {
    var merged = [];
    var seen = new Set();
    var source = []
      .concat(Array.isArray(existing) ? existing : [])
      .concat(Array.isArray(incoming) ? incoming : []);

    for (var i = 0; i < source.length; i += 1) {
      var item = source[i];
      if (!item || typeof item !== 'object') continue;
      var key = this._userIdentityKey(item, i);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  }

  _userIdentityKey(item, index) {
    var metaid = this._pickFirstString([item && item.metaid]);
    var address = this._pickFirstString([item && item.address]);
    var followPinId = this._pickFirstString([item && item.followPinId]);
    var id = this._pickFirstString([item && item.id]);
    return [metaid, address, followPinId, id, String(index)].join('|');
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
        var normalized = String(value).trim();
        if (normalized) return normalized;
      }
    }
    return '';
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _formatMetaid(metaid) {
    var text = this._pickFirstString([metaid]);
    if (!text) return '--';
    if (text.length <= 14) return text;
    return text.slice(0, 6) + '...' + text.slice(-4);
  }

  _formatAddress(address) {
    var text = this._pickFirstString([address]);
    if (!text) return '';
    if (text.length <= 16) return text;
    return text.slice(0, 8) + '...' + text.slice(-6);
  }

  _resolveDisplayName(item) {
    var name = this._pickFirstString([item && item.name]);
    if (name) return name;
    var metaid = this._pickFirstString([item && item.metaid]);
    if (metaid) return this._t('buzz.profile.displayNamePrefix', 'MetaID {metaid}', { metaid: this._formatMetaid(metaid) });
    var address = this._pickFirstString([item && item.address]);
    if (address) return this._formatAddress(address);
    return this._t('buzz.userList.unknownUser', 'Unknown User');
  }

  _resolveProfileCounters(profileMetaid) {
    var buzz = this._getStore('buzz');
    var segment = this._ensureProfileSegment(profileMetaid);
    var following = Number(segment && segment.following ? segment.following.total : 0);
    var followers = Number(segment && segment.followers ? segment.followers.total : 0);

    if (buzz && buzz.profileHeader && buzz.profileHeader.byMetaid && buzz.profileHeader.byMetaid[profileMetaid]) {
      var header = buzz.profileHeader.byMetaid[profileMetaid];
      var fromHeaderFollowing = Number(header && header.followingTotal);
      var fromHeaderFollowers = Number(header && header.followerTotal);
      if (Number.isFinite(fromHeaderFollowing) && fromHeaderFollowing >= 0) following = fromHeaderFollowing;
      if (Number.isFinite(fromHeaderFollowers) && fromHeaderFollowers >= 0) followers = fromHeaderFollowers;
    }

    if (!Number.isFinite(following) || following < 0) following = 0;
    if (!Number.isFinite(followers) || followers < 0) followers = 0;
    return {
      following: following,
      followers: followers,
    };
  }

  _renderRows() {
    if (this._loading && this._list.length === 0) {
      return '<div class="state loading">' + this._escapeHtml(this._t('buzz.userList.loadingUsers', 'Loading users...')) + '</div>';
    }
    if (this._error && this._list.length === 0) {
      return `
        <div class="state error">
          <div>${this._escapeHtml(this._error)}</div>
          <button class="action-btn" data-action="retry">${this._escapeHtml(this._t('buzz.userList.retry', 'Retry'))}</button>
        </div>
      `;
    }
    if (this._list.length === 0) {
      return '<div class="state empty">' + this._escapeHtml(this._t('buzz.userList.empty', 'No users yet.')) + '</div>';
    }

    var rows = this._list.map((item) => {
      var name = this._resolveDisplayName(item);
      var metaid = this._pickFirstString([item && item.metaid]);
      var address = this._pickFirstString([item && item.address]);
      var avatar = this._pickFirstString([item && item.avatar]);
      var subtitle = metaid
        ? this._t('buzz.userList.metaidPrefix', 'MetaID: {value}', { value: this._formatMetaid(metaid) })
        : (address ? this._t('buzz.userList.addressPrefix', 'Address: {value}', { value: this._formatAddress(address) }) : '');
      var profileKey = this._pickFirstString([metaid, address]);

      var profileButton = profileKey
        ? `
          <button class="row-main-btn is-clickable" data-action="open-profile" data-profile-id="${this._escapeHtml(profileKey)}">
            <id-avatar class="avatar" size="40" src="${this._escapeHtml(avatar)}" name="${this._escapeHtml(name)}" metaid="${this._escapeHtml(metaid)}"></id-avatar>
            <span class="row-main">
              <span class="name">${this._escapeHtml(name)}</span>
              ${subtitle ? `<span class="sub">${this._escapeHtml(subtitle)}</span>` : ''}
            </span>
          </button>
        `
        : `
          <div class="row-main-btn is-disabled">
            <id-avatar class="avatar" size="40" src="${this._escapeHtml(avatar)}" name="${this._escapeHtml(name)}" metaid="${this._escapeHtml(metaid)}"></id-avatar>
            <span class="row-main">
              <span class="name">${this._escapeHtml(name)}</span>
              ${subtitle ? `<span class="sub">${this._escapeHtml(subtitle)}</span>` : ''}
            </span>
          </div>
        `;
      var followButton = metaid
        ? `<id-follow-button class="follow-host" size="sm" target-metaid="${this._escapeHtml(metaid)}" target-address="${this._escapeHtml(address)}" auto-check="true"></id-follow-button>`
        : '';

      return `
        <div class="row">
          ${profileButton}
          ${followButton}
        </div>
      `;
    }).join('');

    var loadMore = this._hasMore
      ? `<button class="action-btn load-more" data-action="load-more" ${this._loading ? 'disabled' : ''}>${this._loading ? this._escapeHtml(this._t('buzz.userList.loading', 'Loading...')) : this._escapeHtml(this._t('buzz.userList.loadMore', 'Load more'))}</button>`
      : '';
    var inlineError = this._error && this._list.length > 0
      ? `<div class="state inline-error">${this._escapeHtml(this._error)}</div>`
      : '';

    return `
      <div class="rows">${rows}</div>
      ${inlineError}
      ${loadMore}
    `;
  }

  _openProfile(profileId) {
    var target = this._pickFirstString([profileId]);
    if (!target) return;

    var app = this._getStore('app');
    if (app) {
      if (!app.route || typeof app.route !== 'object') app.route = {};
      app.profileMetaid = target;
      app.route.path = '/profile/' + encodeURIComponent(target);
      app.route.params = { metaid: target };
    }

    var path = '/profile/' + encodeURIComponent(target);
    this._setBrowserRoutePath(path, false);
    this.dispatchEvent(new CustomEvent('id:user-list:profile-open', {
      detail: { profileId: target },
      bubbles: true,
      composed: true,
    }));
    this._checkContext(true);
  }

  render() {
    var inProfile = this._isProfileMode();
    var profileMetaid = this._getCurrentProfileMetaid();
    if (!inProfile || !profileMetaid) {
      this.shadowRoot.innerHTML = '<style>:host{display:none;}</style>';
      return;
    }
    if (!this._panelOpen) {
      this.shadowRoot.innerHTML = '<style>:host{display:none;}</style>';
      return;
    }

    var counters = this._resolveProfileCounters(profileMetaid);
    var followingActive = this._currentType === 'following';
    var followersActive = this._currentType === 'followers';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          position: fixed;
          inset: 0;
          z-index: 1300;
          box-sizing: border-box;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
        }
        .overlay {
          position: absolute;
          inset: 0;
          background: rgba(15, 23, 42, 0.44);
          backdrop-filter: blur(1px);
        }
        .wrap {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: min(92vw, var(--id-feed-max-width, 760px));
          max-height: min(82vh, 900px);
          overflow: auto;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          background: var(--id-bg-card, #ffffff);
          padding: 10px;
          box-shadow: var(--id-shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06));
        }
        .panel-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          margin-bottom: 10px;
        }
        .panel-title {
          color: var(--id-text-title, #111827);
          font-size: 14px;
          font-weight: 700;
          margin: 0;
        }
        .close-btn {
          min-height: 30px;
          border-radius: 8px;
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          padding: 0 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .close-btn:hover {
          background: var(--id-border-color-light, #f8fafc);
        }
        .tabs {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 10px;
        }
        .tab-btn {
          width: 100%;
          min-height: 34px;
          border-radius: 10px;
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        .tab-btn.is-active {
          color: #ffffff;
          border-color: #2563eb;
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
        }
        .rows {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .row {
          width: 100%;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 10px;
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          padding: 8px 10px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .row-main-btn {
          flex: 1;
          min-width: 0;
          border: none;
          background: transparent;
          color: inherit;
          padding: 2px 0;
          text-align: left;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .row-main-btn.is-clickable {
          cursor: pointer;
        }
        .row-main-btn.is-clickable:hover {
          background: var(--id-border-color-light, #f8fafc);
          border-radius: 8px;
        }
        .row-main-btn.is-disabled {
          opacity: 0.75;
        }
        .follow-host {
          margin-left: auto;
          flex-shrink: 0;
        }
        .avatar {
          width: 40px;
          height: 40px;
          min-width: 40px;
          min-height: 40px;
          flex-shrink: 0;
        }
        .row-main {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .name {
          color: var(--id-text-title, #111827);
          font-size: 14px;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sub {
          color: var(--id-text-secondary, #6b7280);
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .state {
          border: 1px dashed var(--id-border-color, #d1d5db);
          border-radius: 10px;
          padding: 16px;
          text-align: center;
          color: var(--id-text-secondary, #6b7280);
          font-size: 13px;
        }
        .state.error,
        .state.inline-error {
          color: var(--id-text-error, #b91c1c);
        }
        .state.inline-error {
          margin-top: 8px;
          border-style: solid;
          padding: 10px;
          text-align: left;
        }
        .action-btn {
          margin-top: 10px;
          min-height: 34px;
          border-radius: 10px;
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          padding: 0 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .action-btn:hover:not(:disabled) {
          background: var(--id-border-color-light, #f8fafc);
        }
        .action-btn:disabled {
          opacity: 0.7;
          cursor: not-allowed;
        }
        .load-more {
          width: 100%;
        }
      </style>
      <span class="overlay" data-action="close"></span>
      <section class="wrap" role="dialog" aria-modal="true" aria-label="${this._escapeHtml(this._t('buzz.userList.dialogAria', 'User relationship list'))}">
        <div class="panel-head">
          <h3 class="panel-title">${this._escapeHtml(followingActive ? this._t('buzz.userList.panelTitleFollowing', 'Following') : this._t('buzz.userList.panelTitleFollowers', 'Followers'))}</h3>
          <button class="close-btn" data-action="close">${this._escapeHtml(this._t('buzz.userList.close', 'Close'))}</button>
        </div>
        <div class="tabs">
          <button class="tab-btn ${followingActive ? 'is-active' : ''}" data-action="switch-tab" data-type="following">
            <span>${this._escapeHtml(this._t('buzz.userList.following', 'Following'))}</span>
            <span>${this._escapeHtml(String(counters.following))}</span>
          </button>
          <button class="tab-btn ${followersActive ? 'is-active' : ''}" data-action="switch-tab" data-type="followers">
            <span>${this._escapeHtml(this._t('buzz.userList.followers', 'Followers'))}</span>
            <span>${this._escapeHtml(String(counters.followers))}</span>
          </button>
        </div>
        ${this._renderRows()}
      </section>
    `;

    var tabButtons = this.shadowRoot.querySelectorAll('[data-action="switch-tab"]');
    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        var type = this._normalizeType(button.getAttribute('data-type'));
        this._setActiveType(type, true);
      });
    });

    var loadMoreBtn = this.shadowRoot.querySelector('[data-action="load-more"]');
    if (loadMoreBtn && !loadMoreBtn.disabled) {
      loadMoreBtn.addEventListener('click', () => {
        this._fetchUsers(true);
      });
    }

    var retryBtn = this.shadowRoot.querySelector('[data-action="retry"]');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        this.refresh();
      });
    }

    var closeButtons = this.shadowRoot.querySelectorAll('[data-action="close"]');
    closeButtons.forEach((button) => {
      button.addEventListener('click', () => {
        this._closePanel();
      });
    });

    var profileButtons = this.shadowRoot.querySelectorAll('[data-action="open-profile"]');
    profileButtons.forEach((button) => {
      button.addEventListener('click', () => {
        var profileId = this._pickFirstString([button.getAttribute('data-profile-id')]);
        this._openProfile(profileId);
      });
    });
  }
}

if (!customElements.get('id-user-list')) {
  customElements.define('id-user-list', IdUserList);
}
