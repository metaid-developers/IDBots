/**
 * FetchBuzzCommand - Business logic for fetching buzz list and user info
 *
 * This command:
 * 1. Fetches buzz list from MetaID MAN API by path (pagination)
 * 2. Fetches user info by buzz address from MetaFS API
 * 3. Caches user info in IndexedDB using metaId as primary key
 */
export default class FetchBuzzCommand {
  async execute({ payload = {}, stores, delegate }) {
    if (!delegate) {
      throw new Error('FetchBuzzCommand: delegate is required');
    }

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

    var rawResponse = await delegate('metaid_man', '/pin/path/list?' + query, { method: 'GET' });
    var normalized = this._normalizePinListResponse(rawResponse);

    var enrichedList = await Promise.all(
      normalized.list.map(async (pin) => {
        var parsed = this._parsePin(pin);
        var userInfo = await this._getUserInfoByAddress(parsed.address, delegate);
        return {
          id: parsed.id,
          address: parsed.address,
          timestamp: parsed.timestamp,
          path: parsed.path,
          metaid: parsed.metaid,
          content: parsed.content,
          attachments: parsed.attachments,
          quotePin: parsed.quotePin,
          lastId: parsed.lastId,
          userInfo: userInfo,
          raw: pin,
        };
      })
    );

    var result = {
      list: enrichedList,
      total: normalized.total,
      nextCursor: normalized.nextCursor,
    };

    if (stores && stores.buzz) {
      stores.buzz.total = result.total;
      stores.buzz.nextCursor = result.nextCursor;
      stores.buzz.lastUpdatedAt = Date.now();
    }

    return result;
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
    if (payload && payload.nextCursor !== undefined && payload.nextCursor !== null) {
      nextCursor = payload.nextCursor;
    } else if (response && response.nextCursor !== undefined && response.nextCursor !== null) {
      nextCursor = response.nextCursor;
    }

    return {
      list: list,
      total: Number.isFinite(total) ? total : list.length,
      nextCursor: nextCursor,
    };
  }

  _parsePin(pin) {
    var contentSummary = {};
    if (pin && pin.contentSummary && typeof pin.contentSummary === 'object') {
      contentSummary = pin.contentSummary;
    } else if (pin && typeof pin.contentSummary === 'string') {
      try {
        contentSummary = JSON.parse(pin.contentSummary);
      } catch (error) {
        contentSummary = {};
      }
    }

    var modifyHistory = Array.isArray(pin && pin.modify_history) ? pin.modify_history : [];
    var fallbackTimestamp = Date.now();
    var pinTimestamp = Number(pin && pin.timestamp);

    return {
      id: (pin && pin.id) || '',
      address: (pin && pin.address) || '',
      timestamp: Number.isFinite(pinTimestamp) ? pinTimestamp * 1000 : fallbackTimestamp,
      path: (pin && pin.path) || '',
      metaid: (pin && pin.metaid) || '',
      content: contentSummary.content || '',
      attachments: Array.isArray(contentSummary.attachments) ? contentSummary.attachments : [],
      quotePin: contentSummary.quotePin || '',
      lastId: modifyHistory.length ? modifyHistory[modifyHistory.length - 1] : ((pin && pin.id) || ''),
    };
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
      var endpoint = '/v1/users/address/' + encodeURIComponent(address);
      var response = await delegate('metafs', endpoint, { method: 'GET' });
      var normalized = this._normalizeUserResponse(response, address);
      if (normalized.metaId) {
        await this._saveUserToCache(normalized);
      }
      return normalized;
    } catch (error) {
      return this._emptyUserInfo(address);
    }
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
      metaId: metaId,
      name: (payload && payload.name) || '',
      avatar: avatarUrl,
      address: (payload && payload.address) || address || '',
    };
  }

  _resolveAvatarUrl(avatar, payload) {
    if (!avatar) return '';
    if (typeof avatar === 'string' && (avatar.indexOf('http://') === 0 || avatar.indexOf('https://') === 0)) {
      return avatar;
    }

    var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
    var metafsBase = serviceLocator.metafs || '';
    var avatarId = payload && (payload.avatarPinId || payload.avatarId);
    if (avatarId && metafsBase) {
      return metafsBase + '/v1/users/avatar/accelerate/' + avatarId;
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
    } catch (error) {
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
    } catch (error) {
      // Ignore cache errors to avoid breaking main flow.
    }
  }
}
