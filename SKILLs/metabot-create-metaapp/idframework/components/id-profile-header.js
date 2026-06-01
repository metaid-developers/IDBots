/**
 * id-profile-header
 *
 * Profile summary header for /profile/:metaid route.
 * Data source: Alpine.store('buzz').profileHeader.byMetaid + commands.
 */
import './id-avatar.js';
import {
  getBuzzRoutePathFromLocation,
  normalizeBuzzRoutePath,
  resolveBuzzRouteMode,
} from '../utils/buzz-route.js';

class IdProfileHeader extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastSignature = '';
    this._pendingRefreshTimer = null;
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    this._ensureStoreShape();
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    this.render();
    this._checkAndRender(true);
    this._watchTimer = setInterval(() => this._checkAndRender(false), 260);
  }

  disconnectedCallback() {
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    if (this._pendingRefreshTimer) {
      clearTimeout(this._pendingRefreshTimer);
      this._pendingRefreshTimer = null;
    }
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureStoreShape() {
    var buzz = this._getStore('buzz');
    var app = this._getStore('app');
    if (!buzz || !app) return;

    if (!buzz.profileHeader || typeof buzz.profileHeader !== 'object') {
      buzz.profileHeader = {};
    }
    if (!buzz.profileHeader.byMetaid || typeof buzz.profileHeader.byMetaid !== 'object') {
      buzz.profileHeader.byMetaid = {};
    }

    if (!app.route || typeof app.route !== 'object') app.route = {};
    if (!app.route.params || typeof app.route.params !== 'object') app.route.params = {};
    if (app.profileMetaid === undefined || app.profileMetaid === null) app.profileMetaid = '';
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

  _getCurrentRoutePath() {
    var pathFromLocation = this._getRoutePathFromLocation();
    if (pathFromLocation.indexOf('/home/') === 0 || pathFromLocation.indexOf('/profile/') === 0) {
      var appStore = this._getStore('app');
      if (appStore) {
        if (!appStore.route || typeof appStore.route !== 'object') appStore.route = {};
        appStore.route.path = pathFromLocation;
      }
      return pathFromLocation;
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

  _isWalletConnected() {
    var wallet = this._getStore('wallet');
    return !!(wallet && wallet.isConnected && wallet.address);
  }

  _resolveViewerMetaid() {
    var userStore = this._getStore('user');
    var walletStore = this._getStore('wallet');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    return this._pickFirstMetaid([
      user && user.metaid,
      user && user.metaId,
      walletStore && walletStore.metaid,
    ]);
  }

  _ensureProfileSegment(metaid) {
    var buzz = this._getStore('buzz');
    if (!buzz) return null;
    this._ensureStoreShape();
    var key = this._pickFirstString([metaid]);
    if (!key) return null;

    if (!buzz.profileHeader.byMetaid[key] || typeof buzz.profileHeader.byMetaid[key] !== 'object') {
      buzz.profileHeader.byMetaid[key] = {
        metaid: key,
        name: '',
        address: '',
        avatar: '',
        bio: '',
        chainName: '',
        followingTotal: 0,
        followerTotal: 0,
        isFollowing: false,
        followPinId: '',
        viewerMetaid: '',
        viewerAddress: '',
        followOptimisticUntil: 0,
        isLoading: false,
        followLoading: false,
        hasLoaded: false,
        error: '',
        lastUpdatedAt: 0,
      };
    }

    return buzz.profileHeader.byMetaid[key];
  }

  _getCurrentSegment() {
    if (!this._isProfileMode()) return null;
    var metaid = this._getCurrentProfileMetaid();
    return this._ensureProfileSegment(metaid);
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

  _pickFirstMetaid(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var normalized = this._normalizeMetaid(candidates[i]);
      if (normalized) return normalized;
    }
    return '';
  }

  _normalizeMetaid(raw) {
    var text = this._pickFirstString([raw]).toLowerCase();
    if (!text) return '';
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    var matched = text.match(/[a-f0-9]{64}/);
    return matched && matched[0] ? matched[0] : '';
  }

  _buildSignature() {
    var mode = this._isProfileMode() ? 'profile' : 'home';
    var metaid = this._getCurrentProfileMetaid();
    var walletConnected = this._isWalletConnected() ? '1' : '0';
    var wallet = this._getStore('wallet');
    var walletAddress = this._normalizeAddress(wallet && wallet.address ? wallet.address : '');
    var viewerMetaid = this._resolveViewerMetaid();
    var segment = this._getCurrentSegment();
    var segmentSignature = '';
    if (segment) {
      segmentSignature = [
        segment.name,
        segment.address,
        segment.avatar,
        String(segment.followingTotal || 0),
        String(segment.followerTotal || 0),
        segment.isFollowing ? '1' : '0',
        segment.followPinId || '',
        segment.isLoading ? '1' : '0',
        segment.followLoading ? '1' : '0',
        segment.hasLoaded ? '1' : '0',
        this._pickFirstString([segment.viewerMetaid]),
        this._pickFirstString([segment.viewerAddress]),
        String(segment.followOptimisticUntil || 0),
        String(segment.lastUpdatedAt || 0),
        segment.error || '',
      ].join('|');
    }
    return [mode, metaid, walletConnected, walletAddress, viewerMetaid, segmentSignature].join('||');
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

  _checkAndRender(force) {
    this._ensureStoreShape();
    var signature = this._buildSignature();
    var changed = signature !== this._lastSignature;
    if (force || changed) {
      this._lastSignature = signature;
      this.render();
    }
    if (force || changed) {
      this._maybeFetchProfileHeader(force);
    }
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

  _maybeFetchProfileHeader(force) {
    if (!this._isProfileMode()) return;
    var metaid = this._getCurrentProfileMetaid();
    if (!metaid) return;
    var segment = this._ensureProfileSegment(metaid);
    if (!segment || segment.isLoading) return;

    var wallet = this._getStore('wallet');
    var walletAddress = this._normalizeAddress(wallet && wallet.address ? wallet.address : '');
    var shouldFetch = !!force || !segment.hasLoaded;

    if (!shouldFetch) {
      if (walletAddress && (segment.viewerAddress || '') !== walletAddress) {
        shouldFetch = true;
      }
    }

    if (!shouldFetch) return;
    this._loadProfileHeader(metaid, segment);
  }

  _showMessage(type, message) {
    if (!message) return;
    if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage(type, message);
      return;
    }
    if (type === 'error' && typeof window.alert === 'function') {
      window.alert(message);
      return;
    }
    console.log(message);
  }

  async _loadProfileHeader(metaid, segment) {
    if (!this._isCommandRegistered('fetchProfileHeader')) return;
    segment.isLoading = true;
    segment.error = '';
    this.render();

    try {
      var viewerMetaid = this._pickFirstMetaid([
        segment && segment.viewerMetaid,
        this._resolveViewerMetaid(),
      ]);
      var result = await this._dispatch('fetchProfileHeader', {
        metaid: metaid,
        followerMetaid: viewerMetaid,
      });
      this._applyProfileResult(segment, metaid, result);
    } catch (error) {
      segment.error = (error && error.message) ? error.message : this._t('buzz.profile.loadFailed', 'Failed to load profile header');
      segment.isLoading = false;
      segment.hasLoaded = false;
    }

    this.render();
  }

  _applyProfileResult(segment, metaid, result) {
    var data = result && typeof result === 'object' ? result : {};
    var now = Date.now();
    var serverIsFollowing = !!data.isFollowing;
    var optimisticUntil = Number(segment && segment.followOptimisticUntil ? segment.followOptimisticUntil : 0);
    var optimisticActive = !!(segment && segment.isFollowing && !serverIsFollowing && optimisticUntil > now);
    var serverFollowPinId = this._normalizePinId(data.followPinId || '');

    segment.metaid = this._pickFirstString([data.metaid, metaid]) || metaid;
    segment.name = this._pickFirstString([data.name, data.nickName]);
    segment.address = this._pickFirstString([data.address]);
    segment.avatar = this._resolveAvatarUrl(this._pickFirstString([data.avatar, data.avatarUrl]));
    segment.bio = this._pickFirstString([data.bio]);
    segment.chainName = this._pickFirstString([data.chainName, data.chain]);
    segment.followingTotal = this._normalizeCount(data.followingTotal);
    segment.followerTotal = this._normalizeCount(data.followerTotal);
    if (optimisticActive) {
      segment.isFollowing = true;
      if (serverFollowPinId) segment.followPinId = serverFollowPinId;
    } else {
      segment.isFollowing = serverIsFollowing;
      segment.followPinId = serverFollowPinId;
      segment.followOptimisticUntil = 0;
    }
    if (serverIsFollowing) {
      segment.followOptimisticUntil = 0;
    }
    segment.viewerMetaid = this._pickFirstString([data.viewerMetaid, this._resolveViewerMetaid()]);
    var wallet = this._getStore('wallet');
    segment.viewerAddress = this._normalizeAddress(wallet && wallet.address ? wallet.address : '');
    segment.error = '';
    segment.isLoading = false;
    segment.hasLoaded = true;
    segment.lastUpdatedAt = Date.now();

    var buzz = this._getStore('buzz');
    if (buzz) buzz.lastUpdatedAt = Date.now();
  }

  _normalizeCount(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  _normalizePinId(raw) {
    var text = this._pickFirstString([raw]);
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

  _resolveAvatarUrl(raw) {
    var text = this._pickFirstString([raw]);
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.indexOf('//') === 0) {
      var protocol = (typeof window !== 'undefined' && window.location && window.location.protocol)
        ? window.location.protocol
        : 'https:';
      return protocol + text;
    }
    if (text[0] === '/') {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var manBase = this._pickFirstString([serviceLocator.metaid_man, 'https://www.show.now/man']).replace(/\/+$/, '');
      return manBase + text;
    }
    return text;
  }

  _formatMetaid(metaid) {
    var text = this._pickFirstString([metaid]);
    if (!text) return '--';
    return text.slice(0, 8);
  }

  _profileDisplayName(segment) {
    var name = this._pickFirstString([segment && segment.name]);
    if (name) return name;
    var metaid = this._pickFirstString([segment && segment.metaid]);
    if (metaid) return this._t('buzz.profile.displayNamePrefix', 'MetaID {metaid}', { metaid: metaid.slice(0, 6) });
    return this._t('buzz.profile.unknown', 'Unknown');
  }

  _scheduleProfileRefresh(metaid, delayMs) {
    if (this._pendingRefreshTimer) {
      clearTimeout(this._pendingRefreshTimer);
      this._pendingRefreshTimer = null;
    }
    this._pendingRefreshTimer = setTimeout(() => {
      this._pendingRefreshTimer = null;
      if (!this._isProfileMode()) return;
      if (this._getCurrentProfileMetaid() !== metaid) return;
      var segment = this._ensureProfileSegment(metaid);
      if (!segment) return;
      this._loadProfileHeader(metaid, segment);
    }, Number.isFinite(Number(delayMs)) ? Number(delayMs) : 1200);
  }

  async _handleFollowToggle() {
    if (!this._isProfileMode()) return;
    var targetMetaid = this._getCurrentProfileMetaid();
    var segment = this._ensureProfileSegment(targetMetaid);
    if (!segment || segment.followLoading) return;

    if (!this._isWalletConnected()) {
      this._showMessage('error', this._t('buzz.profile.connectWalletFirst', 'Please connect your wallet first'));
      return;
    }

    var viewerMetaid = this._resolveViewerMetaid();
    var normalizedTargetMetaid = this._normalizeMetaid(targetMetaid);
    var wallet = this._getStore('wallet');
    var walletAddress = this._normalizeAddress(wallet && wallet.address ? wallet.address : '');
    var profileAddress = this._normalizeAddress(segment.address || '');
    var isSelfByMetaid = !!(viewerMetaid && normalizedTargetMetaid && viewerMetaid === normalizedTargetMetaid);
    var isSelfByAddress = !!(walletAddress && profileAddress && walletAddress === profileAddress);
    if (isSelfByMetaid || isSelfByAddress) return;

    var followerMetaid = viewerMetaid || this._pickFirstMetaid([segment.viewerMetaid]);

    if (segment.isFollowing) {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        var confirmed = window.confirm(this._t('buzz.profile.unfollowConfirm', 'Unfollow this user?'));
        if (!confirmed) return;
      }
      await this._handleUnfollow(targetMetaid, followerMetaid, segment);
      return;
    }

    await this._handleFollow(targetMetaid, followerMetaid, segment);
  }

  async _handleFollow(targetMetaid, viewerMetaid, segment) {
    if (!this._isCommandRegistered('followUser')) {
      this._showMessage('error', this._t('buzz.profile.followCommandMissing', 'followUser command is not registered'));
      return;
    }

    segment.followLoading = true;
    segment.error = '';
    this.render();

    try {
      var followRes = await this._dispatch('followUser', {
        metaid: targetMetaid,
        followerMetaid: viewerMetaid,
      });
      segment.isFollowing = true;
      segment.followPinId = this._normalizePinId(this._pickFirstString([
        followRes && followRes.pinId,
        followRes && followRes.followPinId,
      ]));
      segment.followerTotal = this._normalizeCount(segment.followerTotal + 1);
      segment.viewerMetaid = this._pickFirstMetaid([
        followRes && followRes.followerMetaid,
        viewerMetaid,
        segment.viewerMetaid,
      ]);
      segment.followOptimisticUntil = Date.now() + 120000;
      segment.lastUpdatedAt = Date.now();
      this._showMessage('success', this._t('buzz.profile.followedSuccess', 'Followed successfully'));
      this._scheduleProfileRefresh(targetMetaid, 5000);
    } catch (error) {
      this._showMessage('error', (error && error.message) ? error.message : this._t('buzz.profile.followFailed', 'Failed to follow'));
    }

    segment.followLoading = false;
    this.render();
  }

  async _handleUnfollow(targetMetaid, viewerMetaid, segment) {
    if (!this._isCommandRegistered('unfollowUser')) {
      this._showMessage('error', this._t('buzz.profile.unfollowCommandMissing', 'unfollowUser command is not registered'));
      return;
    }

    segment.followLoading = true;
    segment.error = '';
    this.render();

    try {
      await this._dispatch('unfollowUser', {
        metaid: targetMetaid,
        followerMetaid: viewerMetaid,
        followPinId: segment.followPinId || '',
      });
      segment.isFollowing = false;
      segment.followPinId = '';
      segment.followerTotal = this._normalizeCount(Math.max(0, segment.followerTotal - 1));
      segment.viewerMetaid = viewerMetaid;
      segment.followOptimisticUntil = 0;
      segment.lastUpdatedAt = Date.now();
      this._showMessage('success', this._t('buzz.profile.unfollowedSuccess', 'Unfollowed successfully'));
      this._scheduleProfileRefresh(targetMetaid, 1500);
    } catch (error) {
      this._showMessage('error', (error && error.message) ? error.message : this._t('buzz.profile.unfollowFailed', 'Failed to unfollow'));
    }

    segment.followLoading = false;
    this.render();
  }

  _renderFollowButton(segment, targetMetaid) {
    var normalizedTarget = this._normalizeMetaid(targetMetaid);
    var viewerMetaid = this._pickFirstMetaid([
      segment && segment.viewerMetaid,
      this._resolveViewerMetaid(),
    ]);
    var wallet = this._getStore('wallet');
    var walletAddress = this._normalizeAddress(wallet && wallet.address ? wallet.address : '');
    var profileAddress = this._normalizeAddress(segment && segment.address ? segment.address : '');
    var isLoading = !!(segment && segment.isLoading);
    var hasLoaded = !!(segment && segment.hasLoaded);

    if (isLoading || !hasLoaded) return '';
    if (!this._isWalletConnected()) return '';
    if ((normalizedTarget && viewerMetaid && viewerMetaid === normalizedTarget) || (walletAddress && profileAddress && walletAddress === profileAddress)) {
      return '<span class="self-tag">' + this._escapeHtml(this._t('buzz.profile.self', 'You')) + '</span>';
    }

    var loading = !!(segment && segment.followLoading);
    var isFollowing = !!(segment && segment.isFollowing);
    var cls = 'follow-btn ' + (isFollowing ? 'is-following' : 'is-not-following');
    var label = loading
      ? this._t('buzz.profile.processing', 'Processing...')
      : (isFollowing ? this._t('buzz.profile.unfollow', 'Unfollow') : this._t('buzz.profile.follow', 'Follow'));
    var disabled = loading ? 'disabled' : '';
    return '<button class="' + cls + '" data-action="follow-toggle" ' + disabled + '>' + label + '</button>';
  }

  _openUserListPanel(type) {
    var normalized = String(type || '').trim().toLowerCase() === 'followers' ? 'followers' : 'following';
    this.dispatchEvent(new CustomEvent('id:user-list:switch', {
      detail: {
        type: normalized,
        open: true,
      },
      bubbles: true,
      composed: true,
    }));
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _normalizeAddress(raw) {
    return this._pickFirstString([raw]);
  }

  render() {
    var inProfile = this._isProfileMode();
    var metaid = this._getCurrentProfileMetaid();
    var segment = this._getCurrentSegment();
    var isVisible = inProfile && !!metaid;

    if (!isVisible) {
      this.shadowRoot.innerHTML = '<style>:host{display:none;}</style>';
      return;
    }

    var displayName = this._profileDisplayName(segment || {});
    var displayMetaid = this._formatMetaid(metaid);
    var avatar = this._resolveAvatarUrl(segment && segment.avatar ? segment.avatar : '');
    var followerTotal = this._normalizeCount(segment && segment.followerTotal);
    var followingTotal = this._normalizeCount(segment && segment.followingTotal);
    var bio = this._pickFirstString([segment && segment.bio]);
    var loading = !!(segment && segment.isLoading);
    var error = this._pickFirstString([segment && segment.error]);
    var followButton = this._renderFollowButton(segment || {}, metaid);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          max-width: var(--id-feed-max-width, 760px);
          margin: 0 auto 12px;
          box-sizing: border-box;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
        }
        .wrap {
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          background: var(--id-bg-card, #ffffff);
          padding: 12px;
          box-shadow: var(--id-shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.06));
        }
        .top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .identity {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 1;
        }
        .avatar-host {
          width: 52px;
          height: 52px;
          min-width: 52px;
          min-height: 52px;
          flex-shrink: 0;
        }
        .meta {
          min-width: 0;
        }
        .name {
          color: var(--id-text-title, #111827);
          font-weight: 700;
          font-size: 16px;
          line-height: 1.3;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .metaid {
          margin-top: 3px;
          color: var(--id-text-secondary, #6b7280);
          font-size: 12px;
        }
        .follow-btn {
          border-radius: 999px;
          border: 1px solid #2563eb;
          min-height: 32px;
          padding: 0 14px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .follow-btn.is-not-following {
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          color: #ffffff;
        }
        .follow-btn.is-following {
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          border-color: var(--id-border-color, #d1d5db);
        }
        .follow-btn.is-disabled {
          cursor: not-allowed;
          opacity: 0.7;
          border-color: var(--id-border-color, #d1d5db);
          color: var(--id-text-secondary, #6b7280);
          background: var(--id-border-color-light, #f3f4f6);
        }
        .self-tag {
          border-radius: 999px;
          border: 1px solid var(--id-border-color, #d1d5db);
          color: var(--id-text-secondary, #6b7280);
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
        }
        .stats {
          display: flex;
          align-items: center;
          gap: 18px;
          margin-top: 12px;
          flex-wrap: wrap;
        }
        .stat {
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          color: var(--id-text-secondary, #6b7280);
          font-size: 13px;
        }
        .stat-btn {
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-bg-card, #ffffff);
          color: inherit;
          border-radius: 10px;
          min-height: 34px;
          padding: 0 10px;
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          cursor: pointer;
        }
        .stat-btn:hover {
          background: var(--id-border-color-light, #f8fafc);
        }
        .stat strong {
          color: var(--id-text-main, #111827);
          font-size: 15px;
          font-weight: 700;
        }
        .bio {
          margin-top: 10px;
          color: var(--id-text-main, #111827);
          font-size: 13px;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .error {
          margin-top: 10px;
          color: var(--id-text-error, #b91c1c);
          font-size: 12px;
        }
        .loading {
          margin-top: 10px;
          color: var(--id-text-secondary, #6b7280);
          font-size: 12px;
        }
      </style>
      <section class="wrap">
        <div class="top">
          <div class="identity">
            <id-avatar class="avatar-host" size="52" src="${this._escapeHtml(avatar || '')}" name="${this._escapeHtml(displayName)}" metaid="${this._escapeHtml(metaid || '')}"></id-avatar>
            <div class="meta">
              <div class="name">${this._escapeHtml(displayName)}</div>
              <div class="metaid">${this._escapeHtml(this._t('buzz.profile.metaidPrefix', 'MetaID: {metaid}', { metaid: displayMetaid }))}</div>
            </div>
          </div>
          ${followButton}
        </div>
        <div class="stats">
          <button class="stat stat-btn" data-action="open-user-list" data-type="following">
            <strong>${followingTotal}</strong><span>${this._escapeHtml(this._t('buzz.profile.following', 'Following'))}</span>
          </button>
          <button class="stat stat-btn" data-action="open-user-list" data-type="followers">
            <strong>${followerTotal}</strong><span>${this._escapeHtml(this._t('buzz.profile.followers', 'Followers'))}</span>
          </button>
        </div>
        ${bio ? `<div class="bio">${this._escapeHtml(bio)}</div>` : ''}
        ${loading ? `<div class="loading">${this._escapeHtml(this._t('buzz.profile.loadingProfile', 'Loading profile...'))}</div>` : ''}
        ${!loading && error ? `<div class="error">${this._escapeHtml(error)}</div>` : ''}
      </section>
    `;

    var followBtn = this.shadowRoot.querySelector('[data-action="follow-toggle"]');
    if (followBtn && !followBtn.disabled) {
      followBtn.addEventListener('click', () => {
        this._handleFollowToggle();
      });
    }

    var statButtons = this.shadowRoot.querySelectorAll('[data-action="open-user-list"]');
    statButtons.forEach((button) => {
      button.addEventListener('click', () => {
        var type = button.getAttribute('data-type') || 'following';
        this._openUserListPanel(type);
      });
    });
  }
}

if (!customElements.get('id-profile-header')) {
  customElements.define('id-profile-header', IdProfileHeader);
}
