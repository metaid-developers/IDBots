/**
 * FetchBuzzCommand
 *
 * Supports two modes:
 * 1) Timeline mode (new/hot/following/recommend/profile) via the metaso-p2p
 *    aggregation layer (social_agg, /api/social/feed) — the retired show.now
 *    /social/buzz/* routes went offline 2026-11-01 and are never requested.
 *    'recommend' degrades to sort=hot (no per-user ranking exists upstream)
 *    and flags the result `degraded` so the UI can declare it.
 * 2) Legacy path mode via manapi /api/pin/path/list (kept for compatibility)
 */
export default class FetchBuzzCommand {
  async execute({ payload = {}, stores, delegate }) {
    if (!delegate) {
      throw new Error('FetchBuzzCommand: delegate is required');
    }

    var tab = this._normalizeTab(payload.tab || payload.mode || '');
    var shouldUseTimelineApi = !!tab;
    if (shouldUseTimelineApi) {
      return await this._executeTimelineMode({ payload, stores, delegate, tab });
    }

    return await this._executeLegacyPathMode({ payload, stores, delegate });
  }

  async _executeTimelineMode(context) {
    var payload = context.payload;
    var stores = context.stores;
    var delegate = context.delegate;
    var tab = context.tab;

    var cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
    var wallet = stores && stores.wallet ? stores.wallet : (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
    var userStore = stores && stores.user ? stores.user : (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
    var userInfo = userStore && userStore.user ? userStore.user : null;

    var size = Number(payload.size ?? cfg.BUZZ_PAGE_SIZE ?? 10);
    if (!Number.isFinite(size) || size <= 0) size = 10;

    var lastId = this._normalizeCursor(payload.lastId !== undefined ? payload.lastId : payload.cursor);
    var userAddress = String(
      payload.userAddress ||
      (wallet && wallet.address) ||
      (userInfo && userInfo.address) ||
      ''
    ).trim();
    var rawMetaid = this._pickFirstString([
      payload.metaid,
      payload.metaId,
      payload.globalMetaId,
      payload.globalmetaid,
      wallet && wallet.metaid,
      wallet && wallet.metaId,
      userInfo && userInfo.metaid,
      userInfo && userInfo.metaId,
      userInfo && userInfo.metaID,
      userInfo && userInfo.globalMetaId,
      userInfo && userInfo.globalmetaid,
    ]);
    var onchainMetaid = this._normalizeOnchainMetaid(rawMetaid);
    var metaid = (tab === 'following') ? onchainMetaid : (onchainMetaid || String(rawMetaid || '').trim());

    if (tab === 'following' && !metaid && userAddress) {
      metaid = await this._resolveMetaidByAddress(userAddress, delegate);
    }

    var endpoint = this._buildTimelineEndpoint({
      tab: tab,
      size: size,
      lastId: lastId,
      metaid: metaid,
      userAddress: userAddress,
    });

    if (!endpoint) {
      return {
        list: [],
        total: 0,
        nextCursor: null,
        hasMore: false,
      };
    }

    var rawResponse = await delegate('social_agg', endpoint, { method: 'GET' });
    var normalized = this._normalizeSocialBuzzResponse(rawResponse);
    var enrichedList = await this._enrichBuzzList(normalized.list, delegate);

    var result = {
      list: enrichedList,
      total: normalized.total,
      nextCursor: normalized.nextCursor,
      hasMore: normalized.hasMore,
      degraded: tab === 'recommend',
    };

    if (stores && stores.buzz) {
      stores.buzz.total = result.total;
      stores.buzz.nextCursor = result.nextCursor;
      stores.buzz.lastUpdatedAt = Date.now();
      if (stores.buzz.tabs && stores.buzz.tabs[tab]) {
        // Declared degradation: recommend is served as hot; the UI must be
        // able to say so instead of silently passing it off as personalized.
        stores.buzz.tabs[tab].degraded = result.degraded === true;
      }
    }

    return result;
  }

  _buildTimelineEndpoint(params) {
    var tab = params.tab;
    var size = params.size;
    var lastId = params.lastId;
    var metaid = params.metaid;

    // Aggregation-layer feed (metaso-p2p /api/social/feed): cursor-paged,
    // newest by default; sort=hot is a single page (top engagement, last 48h).
    var query = new URLSearchParams({
      size: String(size),
    });
    if (lastId && tab !== 'hot') query.set('cursor', String(lastId));

    if (tab === 'new') {
      return '/api/social/feed?' + query.toString();
    }
    if (tab === 'hot') {
      query.set('sort', 'hot');
      return '/api/social/feed?' + query.toString();
    }
    if (tab === 'following') {
      if (!metaid) return '';
      query.set('scope', 'following');
      query.set('user', metaid);
      return '/api/social/feed?' + query.toString();
    }
    if (tab === 'recommend') {
      // Personalized ranking retired with show.now; degrade to hot and let
      // the caller flag it (result.degraded) so the UI declares the caliber.
      query.set('sort', 'hot');
      return '/api/social/feed?' + query.toString();
    }
    if (tab === 'profile') {
      if (!metaid) return '';
      query.set('publisher', metaid);
      return '/api/social/feed?' + query.toString();
    }

    return '/api/social/feed?' + query.toString();
  }

  async _executeLegacyPathMode(context) {
    var payload = context.payload;
    var stores = context.stores;
    var delegate = context.delegate;

    var cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
    var path = payload.path || cfg.BUZZ_PATH || '/protocols/simplebuzz';
    var rawCursor = payload.cursor;
    var cursor = (rawCursor === undefined || rawCursor === null || rawCursor === '') ? 0 : rawCursor;
    var size = Number(payload.size ?? cfg.BUZZ_PAGE_SIZE ?? 20);

    var query = new URLSearchParams({
      cursor: String(cursor),
      size: String(Number.isFinite(size) ? size : 20),
      path: path,
    }).toString();

    var rawResponse = await delegate('metaid_man', '/api/pin/path/list?' + query, { method: 'GET' });
    var normalized = this._normalizePinListResponse(rawResponse);
    var enrichedList = await this._enrichBuzzList(normalized.list, delegate);

    var result = {
      list: enrichedList,
      total: normalized.total,
      nextCursor: normalized.nextCursor,
      hasMore: normalized.nextCursor !== null && normalized.nextCursor !== undefined && normalized.nextCursor !== '',
    };

    if (stores && stores.buzz) {
      stores.buzz.total = result.total;
      stores.buzz.nextCursor = result.nextCursor;
      stores.buzz.lastUpdatedAt = Date.now();
    }

    return result;
  }

  _normalizeTab(raw) {
    var tab = String(raw || '').trim().toLowerCase();
    var allow = { new: true, hot: true, following: true, recommend: true, profile: true };
    return allow[tab] ? tab : '';
  }

  _normalizeOnchainMetaid(raw) {
    var text = String(raw || '').trim().toLowerCase();
    if (!text) return '';
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    var matched = text.match(/[a-f0-9]{64}/);
    return matched && matched[0] ? matched[0] : '';
  }

  async _resolveMetaidByAddress(address, delegate) {
    var normalizedAddress = String(address || '').trim();
    if (!normalizedAddress || typeof delegate !== 'function') return '';
    try {
      var userInfo = await this._getUserInfoByAddress(normalizedAddress, delegate);
      var fromUser = this._normalizeOnchainMetaid(userInfo && userInfo.metaId);
      return fromUser || '';
    } catch (_) {
      return '';
    }
  }

  _normalizeCursor(raw) {
    if (raw === undefined || raw === null) return '';
    var value = String(raw).trim();
    if (!value || value === '0' || value.toLowerCase() === 'null' || value.toLowerCase() === 'undefined') {
      return '';
    }
    return value;
  }

  _normalizeSocialBuzzResponse(response) {
    var payload = response;
    if (response && typeof response === 'object' && typeof response.code === 'number') {
      payload = response.data || {};
    } else if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
      payload = response.data;
    }

    // Aggregation-layer pages carry `items` + nextCursor/hasMore; the retired
    // show.now shape used `list` + lastId. Both are accepted.
    var list = [];
    if (Array.isArray(payload && payload.items)) {
      list = payload.items;
    } else if (Array.isArray(payload && payload.list)) {
      list = payload.list;
    }
    var total = Number((payload && payload.total) ?? list.length);
    if (!Number.isFinite(total)) total = list.length;

    var nextCursor = null;
    var rawLastId = payload && (payload.lastId !== undefined ? payload.lastId : payload.nextCursor);
    var normalizedLastId = this._normalizeCursor(rawLastId);
    if (normalizedLastId) {
      nextCursor = normalizedLastId;
    }

    var hasMore = !!(nextCursor && list.length > 0);
    if (payload && payload.hasMore !== undefined) {
      hasMore = payload.hasMore === true;
    }

    return {
      list: list,
      total: total,
      nextCursor: nextCursor,
      hasMore: hasMore,
    };
  }

  _normalizePinListResponse(response) {
    var payload = response;
    if (response && typeof response === 'object' && typeof response.code === 'number') {
      payload = response.data || {};
    } else if (response && typeof response === 'object' && response.data && Array.isArray(response.data.list)) {
      payload = response.data;
    }

    var list = Array.isArray(payload && payload.list) ? payload.list : [];
    var total = Number((payload && payload.total) ?? list.length);
    var nextCursor = null;
    if (payload && payload.nextCursor !== undefined && payload.nextCursor !== null && payload.nextCursor !== '') {
      nextCursor = payload.nextCursor;
    } else if (response && response.nextCursor !== undefined && response.nextCursor !== null && response.nextCursor !== '') {
      nextCursor = response.nextCursor;
    }

    return {
      list: list,
      total: Number.isFinite(total) ? total : list.length,
      nextCursor: nextCursor,
    };
  }

  async _enrichBuzzList(list, delegate) {
    var source = Array.isArray(list) ? list : [];
    return await Promise.all(
      source.map(async (pin) => {
        var parsed = this._parsePin(pin);
        var inlineUser = this._extractInlineUserInfo(pin, parsed.address);
        var userInfo = inlineUser;
        if (!inlineUser || (!inlineUser.name && !inlineUser.avatar)) {
          userInfo = await this._getUserInfoByAddress(parsed.address, delegate);
        }
        return {
          id: parsed.id,
          address: parsed.address,
          timestamp: parsed.timestamp,
          path: parsed.path,
          metaid: parsed.metaid,
          chainName: parsed.chainName,
          content: parsed.content,
          attachments: parsed.attachments,
          quotePin: parsed.quotePin,
          lastId: parsed.lastId,
          likeCount: parsed.likeCount,
          commentCount: parsed.commentCount,
          forwardCount: parsed.forwardCount,
          userInfo: userInfo,
          raw: pin,
        };
      })
    );
  }

  _extractInlineUserInfo(pin, address) {
    // Aggregation-layer rows carry the author inline (`pin.author`); the
    // retired show.now rows used `pin.userInfo`.
    var author = pin && pin.author && typeof pin.author === 'object' ? pin.author : null;
    if (author) {
      return {
        metaId: String(author.globalMetaId || author.metaId || author.metaid || '').trim(),
        name: String(author.name || author.nickName || author.nickname || '').trim(),
        avatar: String(author.avatar || author.avatarUrl || '').trim(),
        address: String(author.address || address || '').trim(),
      };
    }
    var userInfo = pin && pin.userInfo && typeof pin.userInfo === 'object' ? pin.userInfo : null;
    if (!userInfo) return null;

    return {
      metaId: String(userInfo.metaId || userInfo.metaid || userInfo.globalMetaId || userInfo.globalmetaid || '').trim(),
      name: String(userInfo.name || userInfo.nickName || userInfo.nickname || '').trim(),
      avatar: String(userInfo.avatar || userInfo.avatarImage || userInfo.avatarUrl || '').trim(),
      address: String(userInfo.address || address || '').trim(),
    };
  }

  _parsePin(pin) {
    var payload = this._pickBuzzPayload(pin);
    var modifyHistory = Array.isArray(pin && pin.modify_history) ? pin.modify_history : [];

    var id = String((pin && (pin.id || pin.pinId || pin.pinid)) || '').trim();
    var author = pin && pin.author && typeof pin.author === 'object' ? pin.author : null;
    var address = String((pin && (pin.address || pin.createAddress || pin.creatorAddress || (author && author.address))) || '').trim();
    var timestamp = this._normalizeTimestamp(pin && (pin.timestamp || pin.time || pin.createdAt));
    var path = String((pin && (pin.path || pin.protocolPath)) || '').trim();
    var metaid = String((pin && (pin.metaid || pin.metaId || pin.globalMetaId || (author && (author.metaId || author.metaid || author.globalMetaId)))) || '').trim();
    var chainName = String((pin && (pin.chainName || pin.chain || pin.network)) || '').trim();

    var content = this._extractBuzzContent(pin, payload);
    var attachments = this._extractBuzzAttachments(pin, payload);
    var quotePin = this._extractBuzzQuotePin(pin, payload);

    // Tri-state engagement counts: a finite number (including a real 0) is a
    // count; absent/null/"unavailable" means the index offered NO count for
    // this pin (outside the buzz-only coverage) and stays null — unknown ≠ 0.
    var likeCount = this._pickCount(pin, ['likeCount', 'likeNum']);
    var commentCount = this._pickCount(pin, ['commentCount', 'commentNum']);
    var forwardCount = this._pickCount(pin, ['forwardCount', 'forwardNum', 'repostCount', 'quoteCount']);

    return {
      id: id,
      address: address,
      timestamp: timestamp,
      path: path,
      metaid: metaid,
      chainName: chainName,
      content: content,
      attachments: attachments,
      quotePin: quotePin,
      lastId: modifyHistory.length ? modifyHistory[modifyHistory.length - 1] : id,
      likeCount: likeCount,
      commentCount: commentCount,
      forwardCount: forwardCount,
    };
  }

  /**
   * Engagement count, or null when the source offered none. A present finite
   * number — including an explicit 0 — is a real count; an absent/null/
   * "unavailable"/non-numeric field is unreadable and stays null so the UI
   * renders unknown ("—") instead of fabricating a zero.
   */
  _pickCount(pin, keys) {
    for (var i = 0; i < keys.length; i += 1) {
      var raw = pin ? pin[keys[i]] : undefined;
      if (raw === null || raw === undefined || raw === '') continue;
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
      var parsed = Number(String(raw).trim());
      if (raw !== undefined && String(raw).trim() !== '' && Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  _pickBuzzPayload(pin) {
    var candidates = [
      // Aggregation-layer rows expose the payload as a ready object.
      this._tryParseJsonObject(pin && pin.payload),
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
      if (fallback && typeof fallback === 'object') {
        return fallback;
      }
    }

    return {};
  }

  _tryParseJsonObject(rawValue) {
    if (!rawValue) return null;
    if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
      var text = rawValue.trim();
      if (!text) return null;
      if (!this._looksLikeJson(text)) return null;
      try {
        var parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
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

  _extractBuzzContent(pin, payload) {
    var fromPayload = this._pickFirstString([
      payload && payload.content,
      payload && payload.publicContent,
      payload && payload.text,
      payload && payload.message,
    ]);
    if (fromPayload) return fromPayload;

    var plainContent = this._pickFirstString([
      pin && pin.content,
      pin && pin.contentSummary,
      pin && pin.contentBody,
    ]);
    if (!plainContent) return '';
    if (this._looksLikeJson(plainContent)) return '';
    return plainContent;
  }

  _extractBuzzAttachments(pin, payload) {
    var attachmentsSource = [];
    if (Array.isArray(payload && payload.attachments)) {
      attachmentsSource = payload.attachments;
    } else if (Array.isArray(payload && payload.publicFiles)) {
      attachmentsSource = payload.publicFiles;
    } else if (Array.isArray(pin && pin.attachments)) {
      attachmentsSource = pin.attachments;
    }
    return this._normalizeAttachmentList(attachmentsSource);
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
      if (typeof item === 'object') {
        normalized.push(item);
      }
    });
    return normalized;
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

  _normalizePinReference(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    var exact = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (exact && exact[0]) return exact[0];

    var cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.indexOf('metafile://') === 0) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.indexOf('/pin/') >= 0) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.indexOf('/content/') >= 0) cleaned = cleaned.split('/content/').pop() || '';
    cleaned = cleaned.trim();
    var fromTail = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    if (fromTail && fromTail[0]) return fromTail[0];
    return cleaned;
  }

  _normalizeTimestamp(raw) {
    var value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return Date.now();
    if (value < 1000000000000) value *= 1000;
    return Math.floor(value);
  }

  async _getUserInfoByAddress(address, delegate) {
    if (!address) {
      return this._emptyUserInfo('');
    }

    var cached = await this._getCachedUserByAddress(address);
    if (cached) {
      return cached;
    }

    try {
      var endpoint = this._buildMetafsAddressEndpoint(address);
      var response = await delegate('metafs', endpoint, { method: 'GET' });
      var normalized = this._normalizeUserResponse(response, address);
      if (normalized.metaId) {
        await this._saveUserToCache(normalized);
      }
      return normalized;
    } catch (_) {
      return this._emptyUserInfo(address);
    }
  }

  _buildMetafsAddressEndpoint(address) {
    var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
    var base = String(serviceLocator.metafs || '').replace(/\/+$/, '').toLowerCase();
    var prefix = base.slice(-3) === '/v1' ? '' : '/v1';
    return prefix + '/users/address/' + encodeURIComponent(address);
  }

  _normalizeUserResponse(response, address) {
    var payload = response;
    if (response && typeof response === 'object' && typeof response.code === 'number') {
      payload = response.data || {};
    } else if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
      payload = response.data;
    }

    var metaId = (payload && (payload.metaId || payload.metaid || payload.globalMetaId)) || '';
    var avatar = (payload && payload.avatar) || '';
    var avatarUrl = this._resolveAvatarUrl(avatar, payload);

    return {
      metaId: String(metaId || '').trim(),
      name: String((payload && payload.name) || '').trim(),
      avatar: String(avatarUrl || '').trim(),
      address: String((payload && payload.address) || address || '').trim(),
    };
  }

  _resolveAvatarUrl(avatar, payload) {
    if (!avatar) return '';
    var pinIdMatch = String(avatar || '').match(/([a-fA-F0-9]{64}i\d+)/);
    var pinIdFromAvatar = pinIdMatch ? pinIdMatch[1] : '';
    if (
      typeof avatar === 'string' &&
      /^https?:\/\/file\.metaid\.io\/metafile-indexer\/(?:api\/v1\/files\/)?content\//i.test(avatar) &&
      pinIdFromAvatar
    ) {
      var serviceLocatorFromUrl = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var metafsBaseFromUrl = String(serviceLocatorFromUrl.metafs || '').replace(/\/+$/, '');
      var lowerFromUrl = metafsBaseFromUrl.toLowerCase();
      var prefixFromUrl = lowerFromUrl.slice(-3) === '/v1' ? '' : '/v1';
      return metafsBaseFromUrl + prefixFromUrl + '/users/avatar/accelerate/' + pinIdFromAvatar + '?process=thumbnail';
    }
    if (typeof avatar === 'string' && (avatar.indexOf('http://') === 0 || avatar.indexOf('https://') === 0)) {
      if (/\/users\/avatar\/accelerate\//i.test(avatar) && !/[?&]process=/i.test(avatar)) {
        return avatar + (avatar.indexOf('?') >= 0 ? '&' : '?') + 'process=thumbnail';
      }
      return avatar;
    }

    var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
    var metafsBase = String(serviceLocator.metafs || '').replace(/\/+$/, '');
    var avatarId = payload && (payload.avatarPinId || payload.avatarId || payload.avatar);
    if (avatarId && metafsBase) {
      var lower = metafsBase.toLowerCase();
      var prefix = lower.slice(-3) === '/v1' ? '' : '/v1';
      return metafsBase + prefix + '/users/avatar/accelerate/' + avatarId + '?process=thumbnail';
    }
    return avatar;
  }

  _emptyUserInfo(address) {
    return {
      metaId: '',
      name: '',
      avatar: '',
      address: address || '',
    };
  }

  async _initUserDB() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open('idframework-buzz-user-db', 1);

      request.onerror = function () {
        reject(new Error('Failed to open buzz user IndexedDB'));
      };

      request.onsuccess = function () {
        resolve(request.result);
      };

      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('BuzzUser')) {
          var store = db.createObjectStore('BuzzUser', { keyPath: 'metaId' });
          store.createIndex('address', 'address', { unique: false });
        }
      };
    });
  }

  async _getCachedUserByAddress(address) {
    if (!address) return null;
    try {
      var db = await this._initUserDB();
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(['BuzzUser'], 'readonly');
        var store = tx.objectStore('BuzzUser');
        var index = store.index('address');
        var request = index.get(address);
        request.onsuccess = function () {
          resolve(request.result || null);
        };
        request.onerror = function () {
          reject(new Error('Failed to read cached user by address'));
        };
      });
    } catch (_) {
      return null;
    }
  }

  async _saveUserToCache(user) {
    if (!user || !user.metaId) return;
    try {
      var db = await this._initUserDB();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(['BuzzUser'], 'readwrite');
        var store = tx.objectStore('BuzzUser');
        var request = store.put(user);
        request.onsuccess = function () {
          resolve();
        };
        request.onerror = function () {
          reject(new Error('Failed to save cached user'));
        };
      });
    } catch (_) {
      // Ignore cache errors.
    }
  }
}
