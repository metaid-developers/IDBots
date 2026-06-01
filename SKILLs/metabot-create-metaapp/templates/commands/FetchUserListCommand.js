/**
 * FetchUserListCommand
 *
 * Fetches user relationship lists for a profile:
 * - following
 * - followers
 *
 * Data source is aligned with shownow production endpoints:
 * - /api/metaid/followingList/:metaid
 * - /api/metaid/followerList/:metaid
 */
export default class FetchUserListCommand {
  async execute({ payload = {}, delegate, userDelegate }) {
    if (typeof delegate !== 'function') {
      throw new Error('FetchUserListCommand: delegate is required');
    }

    var metaid = this._pickFirstString([
      payload.metaid,
      payload.metaId,
      payload.profileMetaid,
      payload.targetMetaid,
    ]);
    if (!metaid) {
      throw new Error('FetchUserListCommand: metaid is required');
    }

    var type = this._normalizeType(payload.type || payload.mode || payload.kind);
    var cursor = this._normalizeCursor(payload.cursor, 0);
    var size = this._normalizePositiveInt(payload.size, 10, 1, 100);
    var followDetail = this._normalizeBool(payload.followDetail, true);

    var response = await this._fetchList({
      metaid: metaid,
      type: type,
      cursor: cursor,
      size: size,
      followDetail: followDetail,
      delegate: delegate,
    });

    var normalized = this._normalizeResponse(response, { cursor: cursor, size: size });
    var enriched = await this._enrichUsers(normalized.list, userDelegate);

    return {
      metaid: metaid,
      type: type,
      list: enriched,
      total: normalized.total,
      nextCursor: normalized.nextCursor,
      hasMore: normalized.hasMore,
      cursor: cursor,
      size: size,
    };
  }

  async _fetchList(context) {
    var metaid = context.metaid;
    var type = context.type;
    var cursor = context.cursor;
    var size = context.size;
    var followDetail = context.followDetail;
    var delegate = context.delegate;

    var endpointType = type === 'followers' ? 'follower' : 'following';
    var escapedMetaid = encodeURIComponent(metaid);
    var query = new URLSearchParams({
      cursor: String(cursor),
      size: String(size),
      followDetail: followDetail ? 'true' : 'false',
    }).toString();

    var candidates = [
      {
        service: 'metaid_man',
        endpoint: '/api/metaid/' + endpointType + 'List/' + escapedMetaid + '?' + query,
      },
      {
        service: 'man_api',
        endpoint: '/metaid/' + endpointType + 'List/' + escapedMetaid + '?' + query,
      },
    ];

    return await this._fetchFirstSuccess(candidates, delegate);
  }

  async _fetchFirstSuccess(candidates, delegate) {
    var errors = [];
    for (var i = 0; i < candidates.length; i += 1) {
      var item = candidates[i];
      try {
        return await delegate(item.service, item.endpoint, { method: 'GET' });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
    throw new Error('FetchUserListCommand: no available endpoint');
  }

  _normalizeResponse(response, context) {
    var cursor = context && Number.isFinite(Number(context.cursor)) ? Number(context.cursor) : 0;
    var size = context && Number.isFinite(Number(context.size)) ? Number(context.size) : 10;

    var data = this._pickData(response);
    var sourceList = Array.isArray(data && data.list) ? data.list : [];
    var list = [];
    for (var i = 0; i < sourceList.length; i += 1) {
      var normalized = this._normalizeUserItem(sourceList[i], i);
      if (!normalized) continue;
      list.push(normalized);
    }

    var total = Number(data && data.total);
    if (!Number.isFinite(total) || total < 0) total = list.length;

    var nextCursorRaw = this._pickFirstString([
      data && data.nextCursor,
      data && data.cursor,
      data && data.lastId,
    ]);
    var nextCursor = this._normalizeCursor(nextCursorRaw, -1);

    var hasMore = false;
    if (nextCursor >= 0) {
      hasMore = nextCursor > cursor && list.length > 0;
    } else {
      var computedNext = cursor + list.length;
      if (Number.isFinite(total) && total >= 0) {
        hasMore = computedNext < total;
      } else {
        hasMore = list.length >= size;
      }
      nextCursor = hasMore ? computedNext : -1;
    }

    return {
      list: list,
      total: Math.max(total, cursor + list.length),
      nextCursor: hasMore ? String(nextCursor) : '',
      hasMore: hasMore,
    };
  }

  _normalizeUserItem(item, index) {
    var raw = item && typeof item === 'object' ? item : {};

    var metaid = this._pickFirstString([
      raw.metaid,
      raw.metaId,
      raw.metaID,
      raw.followMetaId,
      raw.followMetaID,
      raw.followMetaid,
      raw.follow_metaid,
      raw.followerMetaId,
      raw.followerMetaID,
      raw.followerMetaid,
      raw.userMetaId,
      raw.userMetaid,
      raw.user && (raw.user.metaid || raw.user.metaId),
    ]);
    metaid = this._normalizeMaybeMetaid(metaid);

    var address = this._pickFirstString([
      raw.address,
      raw.createAddress,
      raw.creatorAddress,
      raw.followAddress,
      raw.followerAddress,
      raw.user && raw.user.address,
    ]);

    var name = this._pickFirstString([
      raw.name,
      raw.nickName,
      raw.nickname,
      raw.userName,
      raw.user && (raw.user.name || raw.user.nickName || raw.user.nickname),
    ]);

    var avatar = this._normalizeMaybeRelativeUrl(
      this._pickFirstString([
        raw.avatarUrl,
        raw.avatar,
        raw.avatarImage,
        raw.user && (raw.user.avatarUrl || raw.user.avatar || raw.user.avatarImage),
      ])
    );

    var followPinId = this._normalizePinId(this._pickFirstString([
      raw.followPinId,
      raw.followPinID,
      raw.follow_pin_id,
      raw.pinId,
      raw.pinid,
    ]));

    var followTime = Number(raw.followTime || raw.timestamp || raw.time || 0);
    if (!Number.isFinite(followTime) || followTime < 0) followTime = 0;

    var rowId = this._pickFirstString([
      raw.id,
      raw._id,
      followPinId,
      metaid,
      address,
      String(index),
    ]);

    var chainName = this._pickFirstString([raw.chainName, raw.chain]);
    var bio = this._pickFirstString([raw.bio, raw.description, raw.desc]);
    var unfollowed = this._normalizeBool(raw.unfollow, false);

    return {
      id: rowId,
      metaid: metaid,
      address: address,
      name: name,
      avatar: avatar,
      bio: bio,
      chainName: chainName,
      followPinId: followPinId,
      followTime: followTime,
      unfollow: unfollowed,
      raw: raw,
    };
  }

  async _enrichUsers(list, userDelegate) {
    if (!Array.isArray(list) || list.length === 0) return [];
    if (typeof userDelegate !== 'function') return list.slice();

    var profileCache = new Map();
    return await Promise.all(list.map(async (item) => {
      if (item && item.name && item.avatar && item.metaid) return item;

      var cacheKey = item && item.address
        ? 'a:' + item.address
        : (item && item.metaid ? 'm:' + item.metaid : '');
      if (!cacheKey) return item;

      if (!profileCache.has(cacheKey)) {
        profileCache.set(cacheKey, this._fetchUserProfile(item, userDelegate));
      }

      var userProfile = await profileCache.get(cacheKey);
      if (!userProfile) return item;
      return {
        ...item,
        metaid: item.metaid || userProfile.metaid || '',
        address: item.address || userProfile.address || '',
        name: item.name || userProfile.name || '',
        avatar: item.avatar || userProfile.avatar || '',
        bio: item.bio || userProfile.bio || '',
      };
    }));
  }

  async _fetchUserProfile(item, userDelegate) {
    var byAddress = this._pickFirstString([item && item.address]);
    if (byAddress) {
      try {
        var fromAddress = await userDelegate('metafs', '/users/address/' + encodeURIComponent(byAddress), {
          address: byAddress,
        });
        var normalizedAddressProfile = this._normalizeUserProfilePayload(fromAddress);
        if (normalizedAddressProfile) return normalizedAddressProfile;
      } catch (_) {}
    }

    var byMetaid = this._pickFirstString([item && item.metaid]);
    if (byMetaid) {
      try {
        var fromMetaid = await userDelegate('metafs', '/info/metaid/' + encodeURIComponent(byMetaid), {
          metaid: byMetaid,
        });
        var normalizedMetaidProfile = this._normalizeUserProfilePayload(fromMetaid);
        if (normalizedMetaidProfile) return normalizedMetaidProfile;
      } catch (_) {}
    }

    return null;
  }

  _normalizeUserProfilePayload(payload) {
    var data = this._pickData(payload);
    if (!data || typeof data !== 'object') return null;

    var metaid = this._normalizeMaybeMetaid(this._pickFirstString([
      data.metaid,
      data.metaId,
      data.metaID,
      data.globalMetaId,
    ]));
    var address = this._pickFirstString([data.address, data.createAddress]);
    var name = this._pickFirstString([data.name, data.nickName, data.nickname]);
    var avatar = this._normalizeMaybeRelativeUrl(this._pickFirstString([
      data.avatarUrl,
      data.avatar,
      data.avatarImage,
    ]));
    var bio = this._pickFirstString([data.bio, data.description]);

    if (!metaid && !address && !name && !avatar && !bio) return null;
    return {
      metaid: metaid,
      address: address,
      name: name,
      avatar: avatar,
      bio: bio,
    };
  }

  _pickData(response) {
    if (!response || typeof response !== 'object') return {};
    if (response.data && typeof response.data === 'object') return response.data;
    return response;
  }

  _normalizeType(raw) {
    var type = String(raw || '').trim().toLowerCase();
    if (type === 'follower' || type === 'followers' || type === 'fans') return 'followers';
    return 'following';
  }

  _normalizeBool(value, defaultValue) {
    if (value === null || value === undefined) return !!defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    var text = String(value).trim().toLowerCase();
    if (!text) return !!defaultValue;
    if (text === '1' || text === 'true' || text === 'yes') return true;
    if (text === '0' || text === 'false' || text === 'no') return false;
    return !!defaultValue;
  }

  _normalizePositiveInt(raw, fallback, min, max) {
    var n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) n = Number(fallback);
    if (!Number.isFinite(n) || n <= 0) n = 10;
    if (Number.isFinite(min)) n = Math.max(min, n);
    if (Number.isFinite(max)) n = Math.min(max, n);
    return Math.round(n);
  }

  _normalizeCursor(raw, fallback) {
    if (raw === null || raw === undefined || raw === '') return fallback;
    var n = Number(String(raw).trim());
    if (!Number.isFinite(n)) return fallback;
    if (n < 0) return fallback;
    return Math.floor(n);
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

  _normalizeMaybeMetaid(raw) {
    var text = this._pickFirstString([raw]);
    if (!text) return '';
    var lowered = text.toLowerCase();
    if (/^[a-f0-9]{64}$/.test(lowered)) return lowered;
    var matched = lowered.match(/[a-f0-9]{64}/);
    if (matched && matched[0]) return matched[0];
    return text;
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

  _normalizeMaybeRelativeUrl(url) {
    var text = this._pickFirstString([url]);
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.indexOf('//') === 0) return window.location.protocol + text;
    if (text.indexOf('metafile://') === 0) return text;

    if (text[0] === '/') {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var manBase = this._pickFirstString([serviceLocator.metaid_man, 'https://www.show.now/man']).replace(/\/+$/, '');
      return manBase + text;
    }
    return text;
  }
}
