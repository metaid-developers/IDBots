import './id-post-buzz.js';
import './id-avatar.js';
import { getBuzzRoutePathFromLocation } from '../utils/buzz-route.js';

/**
 * id-buzz-actions - Buzz interaction bar (comment/like/repost/quote)
 * Data source: Alpine.store('buzz') + Alpine.store('app') + Alpine.store('wallet')
 */
class IdBuzzActions extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    this._watchTimer = null;
    this._lastSignature = '';

    this._likedOverride = null;
    this._likeDelta = 0;
    this._commentDelta = 0;
    this._forwardDelta = 0;

    this._likeLoading = false;
    this._commentSubmitLoading = false;
    this._repostLoading = false;
    this._commentListLoading = false;

    this._commentModalOpen = false;
    this._quoteModalOpen = false;
    this._commentText = '';
    this._commentList = [];
    this._commentListError = '';
    this._commentListVersion = 0;
    this._userInfoCache = new Map();
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  static get observedAttributes() {
    return ['pin-id'];
  }

  connectedCallback() {
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    this.render();
    this._watchTimer = setInterval(() => this._checkAndRender(false), 280);
  }

  disconnectedCallback() {
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'pin-id') {
      this._resetLocalState();
      this.render();
    }
  }

  _resetLocalState() {
    this._likedOverride = null;
    this._likeDelta = 0;
    this._commentDelta = 0;
    this._forwardDelta = 0;

    this._likeLoading = false;
    this._commentSubmitLoading = false;
    this._repostLoading = false;
    this._commentListLoading = false;

    this._commentModalOpen = false;
    this._quoteModalOpen = false;
    this._commentText = '';
    this._commentList = [];
    this._commentListError = '';
    this._commentListVersion = 0;
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

  _normalizePinId(value) {
    var text = String(value || '').trim();
    if (!text) return '';

    var match = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (match && match[0]) return match[0];

    var cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.indexOf('metafile://') === 0) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.indexOf('/pin/') >= 0) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.indexOf('/content/') >= 0) cleaned = cleaned.split('/content/').pop() || '';

    match = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    return match && match[0] ? match[0] : String(cleaned || '').trim();
  }

  _getPinId() {
    return this._normalizePinId(this.getAttribute('pin-id') || '');
  }

  _normalizeTab(raw) {
    var tab = String(raw || '').trim().toLowerCase();
    var allow = { new: true, hot: true, following: true, recommend: true };
    return allow[tab] ? tab : 'new';
  }

  _getCurrentRoutePath() {
    var app = this._getStore('app');
    var fromStore = app && app.route && app.route.path ? String(app.route.path) : '';
    if (fromStore) return fromStore;

    return getBuzzRoutePathFromLocation(window.location, window);
  }

  _findItemInList(list, pinId) {
    var source = Array.isArray(list) ? list : [];
    for (var i = 0; i < source.length; i += 1) {
      var item = source[i];
      var id = this._normalizePinId(item && (item.id || item.pinId || item.pinid || ''));
      if (id && id === pinId) {
        return item;
      }
    }
    return null;
  }

  _findBuzzItem(pinId) {
    var buzz = this._getStore('buzz');
    var app = this._getStore('app');
    if (!buzz || !pinId) return null;

    var routePath = this._getCurrentRoutePath();
    if (routePath.indexOf('/profile/') === 0) {
      var matched = routePath.match(/^\/profile\/([^/?#]+)/);
      var profileMetaid = '';
      if (matched && matched[1]) {
        try {
          profileMetaid = decodeURIComponent(matched[1]);
        } catch (_) {
          profileMetaid = matched[1];
        }
      }
      if (!profileMetaid && app && app.profileMetaid) profileMetaid = String(app.profileMetaid);
      if (profileMetaid && buzz.profile && buzz.profile.byMetaid && buzz.profile.byMetaid[profileMetaid]) {
        var fromProfile = this._findItemInList(buzz.profile.byMetaid[profileMetaid].list, pinId);
        if (fromProfile) return fromProfile;
      }
    } else {
      var tab = this._normalizeTab(app && app.buzzTab ? app.buzzTab : 'new');
      if (buzz.tabs && buzz.tabs[tab]) {
        var fromTab = this._findItemInList(buzz.tabs[tab].list, pinId);
        if (fromTab) return fromTab;
      }
    }

    var tabKeys = ['new', 'hot', 'following', 'recommend'];
    for (var i = 0; i < tabKeys.length; i += 1) {
      var key = tabKeys[i];
      if (!buzz.tabs || !buzz.tabs[key]) continue;
      var fromAnyTab = this._findItemInList(buzz.tabs[key].list, pinId);
      if (fromAnyTab) return fromAnyTab;
    }

    if (buzz.profile && buzz.profile.byMetaid && typeof buzz.profile.byMetaid === 'object') {
      var profileKeys = Object.keys(buzz.profile.byMetaid);
      for (var j = 0; j < profileKeys.length; j += 1) {
        var metaidKey = profileKeys[j];
        var segment = buzz.profile.byMetaid[metaidKey];
        var fromAnyProfile = this._findItemInList(segment && segment.list, pinId);
        if (fromAnyProfile) return fromAnyProfile;
      }
    }

    return null;
  }

  _getCurrentUser() {
    var userStore = this._getStore('user');
    var walletStore = this._getStore('wallet');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : {};
    return {
      metaid: String(user.metaid || user.metaId || walletStore && walletStore.globalMetaId || '').trim(),
      address: String(user.address || walletStore && walletStore.address || '').trim(),
      name: String(user.name || user.nickName || user.nickname || '').trim(),
      avatar: String(user.avatar || user.avatarUrl || '').trim(),
    };
  }

  _extractLikeList(raw) {
    if (!raw || typeof raw !== 'object') return [];

    var list = [];
    var arrays = [
      raw.like,
      raw.likes,
      raw.likeMetaid,
      raw.likeMetaids,
      raw.likeAddress,
      raw.likeAddresses,
    ];

    arrays.forEach(function (arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function (value) {
        if (value === null || value === undefined) return;
        if (typeof value === 'string') {
          var text = value.trim();
          if (text) list.push(text);
          return;
        }
        if (typeof value === 'object') {
          var metaid = String(value.metaid || value.metaId || value.CreateMetaid || '').trim();
          var address = String(value.address || value.createAddress || value.pinAddress || '').trim();
          if (metaid) list.push(metaid);
          if (address) list.push(address);
        }
      });
    });

    return list;
  }

  _isLikedByCurrentUser(item, user) {
    if (!item || !user) return false;
    var likeList = this._extractLikeList(item.raw || {});
    var metaid = String(user.metaid || '').trim();
    var address = String(user.address || '').trim();
    if (!metaid && !address) return false;

    if (metaid && likeList.indexOf(metaid) >= 0) return true;
    if (address && likeList.indexOf(address) >= 0) return true;
    return false;
  }

  _makeSnapshot() {
    var pinId = this._getPinId();
    var item = this._findBuzzItem(pinId);

    var baseLikeCount = Number(item && item.likeCount || 0);
    var baseCommentCount = Number(item && item.commentCount || 0);
    var baseForwardCount = Number(item && item.forwardCount || 0);

    if (!Number.isFinite(baseLikeCount)) baseLikeCount = 0;
    if (!Number.isFinite(baseCommentCount)) baseCommentCount = 0;
    if (!Number.isFinite(baseForwardCount)) baseForwardCount = 0;

    var user = this._getCurrentUser();
    var liked = this._likedOverride === null
      ? this._isLikedByCurrentUser(item, user)
      : !!this._likedOverride;

    return {
      pinId: pinId,
      item: item,
      liked: liked,
      likeCount: Math.max(0, baseLikeCount + this._likeDelta),
      commentCount: Math.max(0, baseCommentCount + this._commentDelta),
      forwardCount: Math.max(0, baseForwardCount + this._forwardDelta),
      user: user,
      commentModalOpen: this._commentModalOpen,
      quoteModalOpen: this._quoteModalOpen,
      likeLoading: this._likeLoading,
      repostLoading: this._repostLoading,
      commentSubmitLoading: this._commentSubmitLoading,
      commentListLoading: this._commentListLoading,
      commentText: this._commentText,
      commentList: this._commentList,
      commentListError: this._commentListError,
      commentListVersion: this._commentListVersion,
    };
  }

  _buildSignature(snapshot) {
    return [
      snapshot.pinId,
      snapshot.likeCount,
      snapshot.commentCount,
      snapshot.forwardCount,
      snapshot.liked ? '1' : '0',
      snapshot.commentModalOpen ? '1' : '0',
      snapshot.quoteModalOpen ? '1' : '0',
      snapshot.likeLoading ? '1' : '0',
      snapshot.repostLoading ? '1' : '0',
      snapshot.commentSubmitLoading ? '1' : '0',
      snapshot.commentListLoading ? '1' : '0',
      snapshot.commentListError || '',
      String(snapshot.commentList.length),
      String(snapshot.commentListVersion || 0),
    ].join('|');
  }

  _checkAndRender(force) {
    var snapshot = this._makeSnapshot();
    var signature = this._buildSignature(snapshot);
    if (!force && signature === this._lastSignature) return;
    this._lastSignature = signature;
    this._renderSnapshot(snapshot);
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

  _isWalletReady() {
    var wallet = this._getStore('wallet');
    return !!(wallet && wallet.isConnected && wallet.address && typeof window !== 'undefined' && window.metaidwallet);
  }

  _ensureWalletReady() {
    if (this._isWalletReady()) return true;
    this._showMessage('error', this._t('buzz.actions.connectWalletFirst', 'Please connect your wallet first'));
    return false;
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

  _visitBuzzLists(visitor) {
    var buzz = this._getStore('buzz');
    if (!buzz || typeof visitor !== 'function') return;

    if (buzz.tabs && typeof buzz.tabs === 'object') {
      ['new', 'hot', 'following', 'recommend'].forEach(function (tab) {
        if (!buzz.tabs[tab] || !Array.isArray(buzz.tabs[tab].list)) return;
        visitor(buzz.tabs[tab].list, 'tab:' + tab);
      });
    }

    if (buzz.profile && buzz.profile.byMetaid && typeof buzz.profile.byMetaid === 'object') {
      Object.keys(buzz.profile.byMetaid).forEach(function (metaid) {
        var segment = buzz.profile.byMetaid[metaid];
        if (!segment || !Array.isArray(segment.list)) return;
        visitor(segment.list, 'profile:' + metaid);
      });
    }
  }

  _applyStoreMutationByPinId(pinId, mutator) {
    if (!pinId || typeof mutator !== 'function') return false;
    var buzz = this._getStore('buzz');
    if (!buzz) return false;

    var changed = false;
    this._visitBuzzLists(function (list) {
      for (var i = 0; i < list.length; i += 1) {
        var current = list[i];
        var currentId = String(current && current.id || '').trim();
        if (!currentId || currentId !== pinId) continue;
        var next = mutator(current);
        if (next && next !== current) {
          list[i] = next;
          changed = true;
        }
      }
    });

    if (changed) {
      buzz.lastUpdatedAt = Date.now();
    }
    return changed;
  }

  _incrementCountInStore(pinId, field, delta) {
    var safeDelta = Number(delta || 0);
    if (!Number.isFinite(safeDelta) || safeDelta === 0) return false;
    return this._applyStoreMutationByPinId(pinId, function (current) {
      var next = Object.assign({}, current || {});
      var base = Number(next[field] || 0);
      if (!Number.isFinite(base)) base = 0;
      next[field] = Math.max(0, base + safeDelta);
      return next;
    });
  }

  _appendLikeActorToStore(pinId, user) {
    var metaid = String(user && user.metaid || '').trim();
    var address = String(user && user.address || '').trim();
    if (!metaid && !address) return;

    this._applyStoreMutationByPinId(pinId, function (current) {
      var next = Object.assign({}, current || {});
      var raw = next.raw && typeof next.raw === 'object' ? Object.assign({}, next.raw) : {};

      var likeMetaList = Array.isArray(raw.like) ? raw.like.slice() : [];
      var likeAddressList = Array.isArray(raw.likeAddress) ? raw.likeAddress.slice() : [];

      if (metaid && likeMetaList.indexOf(metaid) < 0) likeMetaList.push(metaid);
      if (address && likeAddressList.indexOf(address) < 0) likeAddressList.push(address);

      raw.like = likeMetaList;
      raw.likeAddress = likeAddressList;
      next.raw = raw;
      return next;
    });
  }

  _formatTime(timestamp) {
    var value = Number(timestamp || 0);
    if (!Number.isFinite(value) || value <= 0) return '--';
    if (value < 1000000000000) value *= 1000;
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '--';
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('/') + ' ' + [
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
    ].join(':');
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
      }
    }
    return '';
  }

  _formatMetaId(metaId) {
    var text = String(metaId || '').trim();
    if (!text) return '';
    return text.slice(0, 8);
  }

  _resolveAvatarUrl(raw) {
    var text = String(raw || '').trim();
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
      var manBase = String(serviceLocator.metaid_man || 'https://www.show.now/man').replace(/\/+$/, '');
      return manBase + text;
    }
    return text;
  }

  _setCommentList(list) {
    this._commentList = Array.isArray(list) ? list : [];
    this._commentListVersion += 1;
  }

  _touchCommentList() {
    this._commentListVersion += 1;
  }

  async _fetchUserInfoByAddress(address) {
    var normalizedAddress = String(address || '').trim();
    if (!normalizedAddress) {
      return { name: '', metaId: '', avatar: '', address: '' };
    }

    if (this._userInfoCache.has(normalizedAddress)) {
      return this._userInfoCache.get(normalizedAddress);
    }

    try {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var base = String(
        serviceLocator.metafs ||
        (window.IDConfig && window.IDConfig.METAFS_BASE_URL) ||
        'https://file.metaid.io/metafile-indexer/api/v1'
      ).replace(/\/+$/, '');
      var prefix = base.toLowerCase().slice(-3) === '/v1' ? '' : '/v1';

      var response = await fetch(base + prefix + '/users/address/' + encodeURIComponent(normalizedAddress), {
        method: 'GET',
      });
      if (!response.ok) throw new Error('fetch user info failed');
      var json = await response.json();

      var payload = json;
      if (json && typeof json.code === 'number') payload = json.data || {};
      if (json && json.data && typeof json.data === 'object' && !json.code) payload = json.data;

      var normalized = {
        name: this._pickFirstString([payload && payload.name, payload && payload.nickName, payload && payload.nickname]),
        metaId: this._pickFirstString([
          payload && payload.metaId,
          payload && payload.metaid,
          payload && payload.globalMetaId,
          payload && payload.globalmetaid,
        ]),
        avatar: this._resolveAvatarUrl(this._pickFirstString([payload && payload.avatar, payload && payload.avatarUrl])),
        address: this._pickFirstString([payload && payload.address, normalizedAddress]) || normalizedAddress,
      };

      this._userInfoCache.set(normalizedAddress, normalized);
      return normalized;
    } catch (_) {
      var fallback = { name: '', metaId: '', avatar: '', address: normalizedAddress };
      this._userInfoCache.set(normalizedAddress, fallback);
      return fallback;
    }
  }

  _buildCommentIdentity(item) {
    var userInfo = item && item.userInfo && typeof item.userInfo === 'object' ? item.userInfo : {};
    var metaId = this._pickFirstString([
      userInfo.metaId,
      userInfo.metaid,
      item && item.createMetaid,
      item && item.metaid,
    ]);
    var address = this._pickFirstString([
      userInfo.address,
      item && item.createAddress,
      item && item.address,
    ]);
    var name = this._pickFirstString([
      userInfo.name,
      item && item.userName,
      item && item.name,
    ]);
    var avatar = this._resolveAvatarUrl(this._pickFirstString([
      userInfo.avatar,
      item && item.avatar,
      item && item.avatarUrl,
    ]));

    if (!name) {
      if (metaId) {
        name = this._t('buzz.profile.displayNamePrefix', 'MetaID {metaid}', { metaid: metaId.slice(0, 6) });
      } else if (address) {
        name = address.slice(0, 8) + '...';
      } else {
        name = this._t('buzz.actions.unknown', 'Unknown');
      }
    }

    return {
      name: name,
      avatar: avatar,
      metaId: metaId,
      address: address,
    };
  }

  async _hydrateCommentUsers(list) {
    if (!Array.isArray(list) || list.length === 0) return;

    var nextList = list.slice();
    var hasChange = false;

    await Promise.all(nextList.map(async (rawItem, index) => {
      var item = rawItem && typeof rawItem === 'object' ? rawItem : null;
      if (!item) return;

      var currentIdentity = this._buildCommentIdentity(item);
      var address = String(currentIdentity.address || '').trim();
      if (!address) {
        if (!item.userInfo) {
          nextList[index] = Object.assign({}, item, {
            userInfo: {
              name: currentIdentity.name,
              metaId: currentIdentity.metaId,
              avatar: currentIdentity.avatar,
              address: '',
            },
          });
          hasChange = true;
        }
        return;
      }

      var fetched = await this._fetchUserInfoByAddress(address);
      var mergedIdentity = {
        name: fetched.name || currentIdentity.name,
        metaId: fetched.metaId || currentIdentity.metaId,
        avatar: fetched.avatar || currentIdentity.avatar,
        address: fetched.address || address,
      };

      if (!item.userInfo ||
        item.userInfo.name !== mergedIdentity.name ||
        item.userInfo.metaId !== mergedIdentity.metaId ||
        item.userInfo.avatar !== mergedIdentity.avatar ||
        item.userInfo.address !== mergedIdentity.address) {
        nextList[index] = Object.assign({}, item, { userInfo: mergedIdentity });
        hasChange = true;
      }
    }));

    if (hasChange) {
      this._setCommentList(nextList);
      this._checkAndRender(true);
    }
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  async _handleLike(snapshot) {
    if (!snapshot.pinId) return;
    if (!this._ensureWalletReady()) return;
    if (snapshot.liked) {
      this._showMessage('error', this._t('buzz.actions.alreadyLiked', 'You have already liked this buzz'));
      return;
    }

    this._likeLoading = true;
    this._checkAndRender(true);

    try {
      await this._dispatch('likeBuzz', { pinId: snapshot.pinId });
      this._likedOverride = true;
      var likeChanged = this._incrementCountInStore(snapshot.pinId, 'likeCount', 1);
      if (!likeChanged) this._likeDelta += 1;
      this._appendLikeActorToStore(snapshot.pinId, snapshot.user);
      this._showMessage('success', this._t('buzz.actions.likedSuccess', 'Liked successfully'));
    } catch (error) {
      this._showMessage('error', (error && error.message) ? error.message : this._t('buzz.actions.likeFailed', 'Failed to like'));
    }

    this._likeLoading = false;
    this._checkAndRender(true);
  }

  async _handleQuickRepost(snapshot) {
    if (!snapshot.pinId) return;
    if (!this._ensureWalletReady()) return;

    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      var confirmed = window.confirm(this._t('buzz.actions.repostConfirm', 'Repost this buzz now?'));
      if (!confirmed) return;
    }

    this._repostLoading = true;
    this._checkAndRender(true);

    try {
      await this._dispatch('postBuzz', {
        content: '',
        files: [],
        quotePin: snapshot.pinId,
      });
      var repostChanged = this._incrementCountInStore(snapshot.pinId, 'forwardCount', 1);
      if (!repostChanged) this._forwardDelta += 1;
      this._showMessage('success', this._t('buzz.actions.repostedSuccess', 'Reposted successfully'));
    } catch (error) {
      this._showMessage('error', (error && error.message) ? error.message : this._t('buzz.actions.repostFailed', 'Failed to repost'));
    }

    this._repostLoading = false;
    this._checkAndRender(true);
  }

  async _openCommentModal(snapshot) {
    if (!snapshot.pinId) return;
    if (!this._ensureWalletReady()) return;

    this._commentModalOpen = true;
    this._commentListError = '';
    this._checkAndRender(true);
    await this._loadCommentList(snapshot.pinId);
  }

  _closeCommentModal() {
    this._commentModalOpen = false;
    this._commentText = '';
    this._checkAndRender(true);
  }

  async _loadCommentList(pinId) {
    if (!pinId) return;
    if (!this._isCommandRegistered('fetchBuzzComments')) {
      this._commentList = [];
      this._commentListError = '';
      this._checkAndRender(true);
      return;
    }

    this._commentListLoading = true;
    this._commentListError = '';
    this._checkAndRender(true);

    try {
      var result = await this._dispatch('fetchBuzzComments', { pinId: pinId });
      this._setCommentList(Array.isArray(result && result.list) ? result.list : []);
      this._commentListLoading = false;
      this._checkAndRender(true);
      await this._hydrateCommentUsers(this._commentList);
      return;
    } catch (error) {
      this._setCommentList([]);
      this._commentListError = (error && error.message) ? error.message : this._t('buzz.actions.loadCommentsFailed', 'Failed to load comments');
    }

    this._commentListLoading = false;
    this._checkAndRender(true);
  }

  async _submitComment(snapshot) {
    if (!snapshot.pinId) return;
    if (!this._ensureWalletReady()) return;

    var content = String(this._commentText || '').trim();
    if (!content) {
      this._showMessage('error', this._t('buzz.actions.enterComment', 'Please enter comment content'));
      return;
    }

    this._commentSubmitLoading = true;
    this._checkAndRender(true);

    try {
      var result = await this._dispatch('postComment', {
        pinId: snapshot.pinId,
        content: content,
      });

      var user = this._getCurrentUser();
      var commentPinId = result && result.txid ? (String(result.txid) + 'i0') : '';
      this._commentList.unshift({
        pinId: commentPinId,
        content: content,
        timestamp: Date.now(),
        createMetaid: user.metaid,
        createAddress: user.address,
        userInfo: {
          name: user.name || '',
          metaId: user.metaid || '',
          avatar: this._resolveAvatarUrl(user.avatar || ''),
          address: user.address || '',
        },
      });
      this._touchCommentList();
      this._commentText = '';
      var commentChanged = this._incrementCountInStore(snapshot.pinId, 'commentCount', 1);
      if (!commentChanged) this._commentDelta += 1;
      this._showMessage('success', this._t('buzz.actions.commentPosted', 'Comment posted successfully'));
      this._hydrateCommentUsers(this._commentList);
    } catch (error) {
      this._showMessage('error', (error && error.message) ? error.message : this._t('buzz.actions.commentFailed', 'Failed to comment'));
    }

    this._commentSubmitLoading = false;
    this._checkAndRender(true);
  }

  _openQuoteModal(snapshot) {
    if (!snapshot.pinId) return;
    if (!this._ensureWalletReady()) return;
    this._quoteModalOpen = true;
    this._checkAndRender(true);
  }

  _closeQuoteModal() {
    this._quoteModalOpen = false;
    this._checkAndRender(true);
  }

  _renderCommentList(snapshot) {
    if (snapshot.commentListLoading) {
      return '<div class="comment-empty">' + this._escapeHtml(this._t('buzz.actions.loadingComments', 'Loading comments...')) + '</div>';
    }
    if (snapshot.commentListError) {
      return '<div class="comment-empty comment-error">' + this._escapeHtml(snapshot.commentListError) + '</div>';
    }
    if (!Array.isArray(snapshot.commentList) || snapshot.commentList.length === 0) {
      return '<div class="comment-empty">' + this._escapeHtml(this._t('buzz.actions.noComments', 'No comments yet.')) + '</div>';
    }

    return snapshot.commentList.map((item) => {
      var identity = this._buildCommentIdentity(item || {});
      var displayName = this._escapeHtml(identity.name || this._t('buzz.actions.unknown', 'Unknown'));
      var shortMetaId = this._escapeHtml(this._formatMetaId(identity.metaId) || '--');
      var content = this._escapeHtml(item.content || '');
      var time = this._escapeHtml(this._formatTime(item.timestamp));
      return [
        '<article class="comment-item">',
        '  <div class="comment-head">',
        '    <div class="comment-identity">',
        '      <id-avatar class="comment-avatar-host" size="28" src="' + this._escapeHtml(identity.avatar || '') + '" name="' + displayName + '" metaid="' + this._escapeHtml(identity.metaId || '') + '"></id-avatar>',
        '      <div class="comment-identity-meta">',
        '        <span class="comment-user">' + displayName + '</span>',
        '        <span class="comment-metaid">' + this._escapeHtml(this._t('buzz.actions.metaidPrefix', 'MetaID: {metaid}', { metaid: shortMetaId })) + '</span>',
        '      </div>',
        '    </div>',
        '    <span class="comment-time">' + time + '</span>',
        '  </div>',
        '  <div class="comment-content">' + content + '</div>',
        '</article>',
      ].join('');
    }).join('');
  }

  _renderSnapshot(snapshot) {
    if (!snapshot.pinId) {
      this.shadowRoot.innerHTML = '<style>:host{display:none;}</style>';
      return;
    }

    var commentDisabled = snapshot.commentSubmitLoading ? 'disabled' : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          margin-top: 8px;
        }
        .actions {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
        }
        .action-btn {
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-action-bg, var(--id-bg-card, #ffffff));
          color: var(--id-action-text, var(--id-text-main, #111827));
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 12px;
          line-height: 1;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          min-height: 30px;
        }
        .action-btn:hover:not(:disabled) {
          background: var(--id-action-bg-hover, var(--id-border-color-light, #f8fafc));
        }
        .action-btn:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }
        .action-btn.is-liked {
          color: #b91c1c;
          border-color: rgba(185, 28, 28, 0.25);
          background: rgba(254, 242, 242, 0.85);
        }
        .count {
          font-weight: 600;
          color: var(--id-action-count, var(--id-text-secondary, #4b5563));
        }
        .overlay {
          position: fixed;
          inset: 0;
          z-index: 100010;
          background: rgba(15, 23, 42, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          box-sizing: border-box;
        }
        .dialog {
          width: min(720px, 96vw);
          max-height: 90vh;
          overflow: auto;
          border-radius: 14px;
          background: var(--id-modal-bg, var(--id-bg-card, #ffffff));
          border: 1px solid var(--id-border-color, #e5e7eb);
          box-shadow: 0 16px 48px rgba(15, 23, 42, 0.25);
          box-sizing: border-box;
        }
        .dialog-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
        }
        .dialog-title {
          font-size: 14px;
          font-weight: 700;
          color: var(--id-text-title, var(--id-text-main, #111827));
        }
        .close-btn {
          border: none;
          width: 30px;
          height: 30px;
          border-radius: 999px;
          background: transparent;
          font-size: 18px;
          color: var(--id-text-secondary, #6b7280);
          cursor: pointer;
        }
        .close-btn:hover {
          background: var(--id-border-color-light, #f3f4f6);
          color: var(--id-text-main, #111827);
        }
        .comment-body {
          padding: 12px 14px 14px;
        }
        .comment-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 12px;
          max-height: 280px;
          overflow: auto;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 10px;
          padding: 8px;
          background: var(--id-comment-list-bg, var(--id-bg-body, #f9fafb));
        }
        .comment-item {
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-comment-item-bg, var(--id-bg-card, #ffffff));
          border-radius: 8px;
          padding: 8px;
        }
        .comment-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 4px;
        }
        .comment-identity {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
        }
        .comment-avatar-host {
          width: 28px;
          height: 28px;
          min-width: 28px;
          min-height: 28px;
          flex-shrink: 0;
        }
        .comment-identity-meta {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .comment-user {
          font-size: 12px;
          font-weight: 600;
          color: var(--id-text-main, #1f2937);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .comment-metaid {
          font-size: 11px;
          color: var(--id-text-secondary, #6b7280);
          white-space: nowrap;
        }
        .comment-time {
          font-size: 11px;
          color: var(--id-text-secondary, #6b7280);
          white-space: nowrap;
        }
        .comment-content {
          font-size: 13px;
          color: var(--id-text-main, #111827);
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .comment-empty {
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
          text-align: center;
          padding: 18px 8px;
        }
        .comment-error {
          color: #b91c1c;
        }
        .comment-input {
          width: 100%;
          min-height: 88px;
          border: 1px solid var(--id-border-color, #d1d5db);
          border-radius: 10px;
          padding: 9px 10px;
          box-sizing: border-box;
          resize: vertical;
          font-size: 13px;
          line-height: 1.45;
          outline: none;
          color: var(--id-text-main, #111827);
          background: var(--id-input-bg, var(--id-bg-card, #ffffff));
        }
        .comment-input:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
        }
        .comment-actions {
          margin-top: 10px;
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .modal-btn {
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-action-bg, var(--id-bg-card, #ffffff));
          color: var(--id-text-main, #111827);
          border-radius: 999px;
          padding: 7px 12px;
          font-size: 13px;
          cursor: pointer;
        }
        .modal-btn:hover:not(:disabled) {
          background: var(--id-action-bg-hover, var(--id-border-color-light, #f9fafb));
        }
        .modal-btn:disabled {
          opacity: 0.65;
          cursor: not-allowed;
        }
        .modal-btn.primary {
          border-color: #2563eb;
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          color: #ffffff;
          font-weight: 600;
        }
        .quote-body {
          padding: 12px;
        }
      </style>

      <div class="actions">
        <button class="action-btn" data-action="open-comment" ${snapshot.commentSubmitLoading || snapshot.commentListLoading ? 'disabled' : ''}>
          <span>${this._escapeHtml(this._t('buzz.actions.comment', 'Comment'))}</span>
          <span class="count">${this._escapeHtml(String(snapshot.commentCount))}</span>
        </button>

        <button class="action-btn ${snapshot.liked ? 'is-liked' : ''}" data-action="like" ${snapshot.likeLoading || snapshot.liked ? 'disabled' : ''}>
          <span>${this._escapeHtml(snapshot.likeLoading ? this._t('buzz.actions.liking', 'Liking...') : (snapshot.liked ? this._t('buzz.actions.liked', 'Liked') : this._t('buzz.actions.like', 'Like')))}</span>
          <span class="count">${this._escapeHtml(String(snapshot.likeCount))}</span>
        </button>

        <button class="action-btn" data-action="repost" ${snapshot.repostLoading ? 'disabled' : ''}>
          <span>${this._escapeHtml(snapshot.repostLoading ? this._t('buzz.actions.reposting', 'Reposting...') : this._t('buzz.actions.repost', 'Repost'))}</span>
          <span class="count">${this._escapeHtml(String(snapshot.forwardCount))}</span>
        </button>

        <button class="action-btn" data-action="open-quote">
          <span>${this._escapeHtml(this._t('buzz.actions.quote', 'Quote'))}</span>
        </button>
      </div>

      ${snapshot.commentModalOpen ? `
        <div class="overlay" data-action="close-comment-modal">
          <div class="dialog" data-action="dialog-noop">
            <div class="dialog-header">
              <div class="dialog-title">${this._escapeHtml(this._t('buzz.actions.comments', 'Comments'))}</div>
              <button class="close-btn" data-action="close-comment-modal" aria-label="${this._escapeHtml(this._t('buzz.actions.closeAria', 'Close'))}">×</button>
            </div>
            <div class="comment-body">
              <div class="comment-list">${this._renderCommentList(snapshot)}</div>
              <textarea class="comment-input" data-action="comment-input" placeholder="${this._escapeHtml(this._t('buzz.actions.writeCommentPlaceholder', 'Write your comment...'))}">${this._escapeHtml(snapshot.commentText)}</textarea>
              <div class="comment-actions">
                <button class="modal-btn" data-action="close-comment-modal">${this._escapeHtml(this._t('buzz.actions.cancel', 'Cancel'))}</button>
                <button class="modal-btn primary" data-action="submit-comment" ${commentDisabled}>${this._escapeHtml(snapshot.commentSubmitLoading ? this._t('buzz.actions.posting', 'Posting...') : this._t('buzz.actions.comment', 'Comment'))}</button>
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      ${snapshot.quoteModalOpen ? `
        <div class="overlay" data-action="close-quote-modal">
          <div class="dialog" data-action="dialog-noop">
            <div class="dialog-header">
              <div class="dialog-title">${this._escapeHtml(this._t('buzz.actions.quoteBuzz', 'Quote Buzz'))}</div>
              <button class="close-btn" data-action="close-quote-modal" aria-label="${this._escapeHtml(this._t('buzz.actions.closeAria', 'Close'))}">×</button>
            </div>
            <div class="quote-body">
              <id-post-buzz quote-pin="${this._escapeHtml(snapshot.pinId)}"></id-post-buzz>
            </div>
          </div>
        </div>
      ` : ''}
    `;

    var openCommentBtn = this.shadowRoot.querySelector('[data-action="open-comment"]');
    if (openCommentBtn) {
      openCommentBtn.addEventListener('click', () => this._openCommentModal(snapshot));
    }

    var likeBtn = this.shadowRoot.querySelector('[data-action="like"]');
    if (likeBtn) {
      likeBtn.addEventListener('click', () => this._handleLike(snapshot));
    }

    var repostBtn = this.shadowRoot.querySelector('[data-action="repost"]');
    if (repostBtn) {
      repostBtn.addEventListener('click', () => this._handleQuickRepost(snapshot));
    }

    var openQuoteBtn = this.shadowRoot.querySelector('[data-action="open-quote"]');
    if (openQuoteBtn) {
      openQuoteBtn.addEventListener('click', () => this._openQuoteModal(snapshot));
    }

    var commentInput = this.shadowRoot.querySelector('[data-action="comment-input"]');
    if (commentInput) {
      commentInput.addEventListener('input', (event) => {
        this._commentText = event.target.value || '';
      });
    }

    var submitCommentBtn = this.shadowRoot.querySelector('[data-action="submit-comment"]');
    if (submitCommentBtn) {
      submitCommentBtn.addEventListener('click', () => this._submitComment(snapshot));
    }

    var closeCommentNodes = this.shadowRoot.querySelectorAll('[data-action="close-comment-modal"]');
    closeCommentNodes.forEach((node) => {
      node.addEventListener('click', (event) => {
        if (event.target !== node && node.getAttribute('data-action') === 'close-comment-modal' && node.classList.contains('overlay')) {
          return;
        }
        this._closeCommentModal();
      });
    });

    var closeQuoteNodes = this.shadowRoot.querySelectorAll('[data-action="close-quote-modal"]');
    closeQuoteNodes.forEach((node) => {
      node.addEventListener('click', (event) => {
        if (event.target !== node && node.getAttribute('data-action') === 'close-quote-modal' && node.classList.contains('overlay')) {
          return;
        }
        this._closeQuoteModal();
      });
    });

    var quoteComposer = this.shadowRoot.querySelector('id-post-buzz');
    if (quoteComposer) {
      quoteComposer.addEventListener('close', () => {
        this._closeQuoteModal();
      });
      quoteComposer.addEventListener('buzz-posted', () => {
        var quoteRepostChanged = this._incrementCountInStore(snapshot.pinId, 'forwardCount', 1);
        if (!quoteRepostChanged) this._forwardDelta += 1;
        this._closeQuoteModal();
      });
    }
  }

  render() {
    this._checkAndRender(true);
  }
}

if (!customElements.get('id-buzz-actions')) {
  customElements.define('id-buzz-actions', IdBuzzActions);
}
