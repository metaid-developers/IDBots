/**
 * FetchProfileHeaderCommand
 *
 * Fetches normalized profile header data for /profile/:metaid:
 * - user profile (name/avatar/address/bio)
 * - following/follower totals
 * - follow relation for current viewer (isFollowing/followPinId)
 */
export default class FetchProfileHeaderCommand {
  async execute({ payload = {}, stores, delegate, userDelegate }) {
    if (typeof delegate !== 'function') {
      throw new Error('FetchProfileHeaderCommand: delegate is required');
    }

    var metaid = this._pickFirstString([
      payload.metaid,
      payload.metaId,
      payload.targetMetaid,
      payload.profileMetaid,
    ]);
    if (!metaid) {
      throw new Error('metaid is required');
    }

    var viewerMetaids = this._collectMetaidCandidates([
      payload.followerMetaid,
      payload.viewerMetaid,
      this._resolveViewerMetaid(stores),
    ], stores);
    var explicitViewerMetaid = this._pickFirstMetaid([
      payload.followerMetaid,
      payload.viewerMetaid,
    ]);

    var byAddressMetaid = await this._resolveViewerMetaidByAddress(stores, userDelegate);
    if (byAddressMetaid) {
      if (viewerMetaids.indexOf(byAddressMetaid) < 0) {
        if (explicitViewerMetaid) {
          viewerMetaids = viewerMetaids.concat([byAddressMetaid]);
        } else {
          viewerMetaids = [byAddressMetaid].concat(viewerMetaids);
        }
      }
    }
    var viewerMetaid = viewerMetaids.length > 0 ? viewerMetaids[0] : '';

    var profileInfo = await this._fetchProfileInfo(metaid, delegate);
    var address = this._pickFirstString([
      profileInfo.address,
      profileInfo.createAddress,
      profileInfo.creator,
      profileInfo.pinAddress,
    ]);

    var userByAddress = await this._fetchUserByAddress(address, userDelegate);
    var followingTotal = await this._fetchFollowTotal(metaid, 'following', delegate);
    var followerTotal = await this._fetchFollowTotal(metaid, 'follower', delegate);

    var relation = { isFollowing: false, followPinId: '' };
    var relationMetaids = viewerMetaids.filter((item) => !!item && item !== metaid);
    if (relationMetaids.length > 0) {
      var relationResult = await this._fetchFollowRelationByCandidates(metaid, relationMetaids, delegate);
      relation = relationResult.relation;
      viewerMetaid = relationResult.viewerMetaid || viewerMetaid;
    }

    var baseForRelative = this._resolveMetaidManBase();
    var normalized = {
      metaid: metaid,
      name: this._pickFirstString([
        profileInfo.name,
        profileInfo.nickName,
        userByAddress.name,
        userByAddress.nickName,
      ]),
      address: this._pickFirstString([address, userByAddress.address]),
      avatar: this._normalizeMaybeRelativeUrl(
        this._pickFirstString([profileInfo.avatar, profileInfo.avatarUrl, userByAddress.avatar]),
        baseForRelative
      ),
      bio: this._pickFirstString([profileInfo.bio, userByAddress.bio]),
      chainName: this._pickFirstString([profileInfo.chainName, profileInfo.chain]),
      followingTotal: Math.max(0, Number.isFinite(Number(followingTotal)) ? Number(followingTotal) : 0),
      followerTotal: Math.max(0, Number.isFinite(Number(followerTotal)) ? Number(followerTotal) : 0),
      isFollowing: !!relation.isFollowing,
      followPinId: this._normalizePinId(relation.followPinId || ''),
      viewerMetaid: viewerMetaid || '',
    };

    return normalized;
  }

  _resolveViewerMetaid(stores) {
    var userStore = stores && stores.user ? stores.user : (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
    var walletStore = stores && stores.wallet ? stores.wallet : (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    return this._pickFirstMetaid([
      user && user.metaid,
      user && user.metaId,
      walletStore && walletStore.metaid,
    ]);
  }

  _collectMetaidCandidates(candidates, stores) {
    var bucket = [];
    var walletStore = stores && stores.wallet ? stores.wallet : (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
    var walletMetaidInfo = walletStore && walletStore.globalMetaIdInfo;

    this._pushMetaidCandidates(bucket, candidates);
    this._pushMetaidsFromUnknown(walletMetaidInfo, bucket);
    return bucket;
  }

  _pushMetaidCandidates(bucket, candidates) {
    if (!Array.isArray(candidates)) return;
    for (var i = 0; i < candidates.length; i += 1) {
      var metaid = this._normalizeMetaid(candidates[i]);
      if (!metaid) continue;
      if (bucket.indexOf(metaid) >= 0) continue;
      bucket.push(metaid);
    }
  }

  _pushMetaidsFromUnknown(input, bucket) {
    if (!input) return;
    if (Array.isArray(input)) {
      for (var i = 0; i < input.length; i += 1) {
        this._pushMetaidsFromUnknown(input[i], bucket);
      }
      return;
    }
    if (typeof input === 'object') {
      var keys = Object.keys(input);
      for (var j = 0; j < keys.length; j += 1) {
        this._pushMetaidsFromUnknown(input[keys[j]], bucket);
      }
      return;
    }
    var metaid = this._normalizeMetaid(input);
    if (!metaid) return;
    if (bucket.indexOf(metaid) >= 0) return;
    bucket.push(metaid);
  }

  async _resolveViewerMetaidByAddress(stores, userDelegate) {
    if (typeof userDelegate !== 'function') return '';

    var userStore = stores && stores.user ? stores.user : (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
    var walletStore = stores && stores.wallet ? stores.wallet : (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    var address = this._pickFirstString([
      user && user.address,
      walletStore && walletStore.address,
    ]);
    if (!address) return '';

    try {
      var ret = await userDelegate('metafs', '/users/address/' + encodeURIComponent(address), { address: address });
      var data = this._pickData(ret);
      return this._pickFirstMetaid([
        data && data.metaid,
        data && data.metaId,
        data && data.globalMetaId,
      ]);
    } catch (_) {
      return '';
    }
  }

  async _fetchProfileInfo(metaid, delegate) {
    var escaped = encodeURIComponent(metaid);
    var candidates = [
      { service: 'metaid_man', endpoint: '/api/info/metaid/' + escaped },
      { service: 'man_api', endpoint: '/info/metaid/' + escaped },
    ];
    var payload = await this._fetchFirstSuccess(candidates, delegate);
    return this._pickData(payload);
  }

  async _fetchUserByAddress(address, userDelegate) {
    var normalizedAddress = this._pickFirstString([address]);
    if (!normalizedAddress || typeof userDelegate !== 'function') return {};
    try {
      var ret = await userDelegate('metafs', '/users/address/' + encodeURIComponent(normalizedAddress), {
        address: normalizedAddress,
      });
      return this._pickData(ret);
    } catch (_) {
      return {};
    }
  }

  async _fetchFollowTotal(metaid, kind, delegate) {
    var escaped = encodeURIComponent(metaid);
    var type = kind === 'following' ? 'following' : 'follower';
    var pathName = '/api/metaid/' + type + 'List/' + escaped + '?cursor=0&size=1&followDetail=false';
    var fallbackPath = '/metaid/' + type + 'List/' + escaped + '?cursor=0&size=1&followDetail=false';

    try {
      var payload = await this._fetchFirstSuccess([
        { service: 'metaid_man', endpoint: pathName },
        { service: 'man_api', endpoint: fallbackPath },
      ], delegate);
      var data = this._pickData(payload);
      var total = Number(data && data.total);
      if (Number.isFinite(total) && total >= 0) return total;
      if (Array.isArray(data && data.list)) return data.list.length;
      return 0;
    } catch (_) {
      return 0;
    }
  }

  async _fetchFollowRelation(metaid, viewerMetaid, delegate) {
    var query = new URLSearchParams({
      metaId: metaid,
      followerMetaId: viewerMetaid,
      _t: String(Date.now()),
    }).toString();

    try {
      var payload = await this._fetchFirstSuccess([
        { service: 'metaid_man', endpoint: '/api/follow/record?' + query },
        { service: 'man_api', endpoint: '/follow/record?' + query },
      ], delegate);
      var data = this._pickData(payload);
      return this._normalizeFollowRelation(data);
    } catch (_) {
      return { isFollowing: false, followPinId: '' };
    }
  }

  async _fetchFollowRelationByCandidates(metaid, viewerMetaids, delegate) {
    var firstMetaid = '';
    var lastRelation = { isFollowing: false, followPinId: '' };
    for (var i = 0; i < viewerMetaids.length; i += 1) {
      var viewerMetaid = this._normalizeMetaid(viewerMetaids[i]);
      if (!viewerMetaid) continue;
      if (!firstMetaid) firstMetaid = viewerMetaid;
      var relation = await this._fetchFollowRelation(metaid, viewerMetaid, delegate);
      if (relation && relation.isFollowing) {
        return {
          viewerMetaid: viewerMetaid,
          relation: relation,
        };
      }
      lastRelation = relation || lastRelation;
    }
    return {
      viewerMetaid: firstMetaid || '',
      relation: lastRelation,
    };
  }

  async _fetchFirstSuccess(candidates, delegate) {
    var errors = [];
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      try {
        return await delegate(candidate.service, candidate.endpoint, { method: 'GET' });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw errors[0];
    throw new Error('No candidate endpoint available');
  }

  _normalizeFollowRelation(input) {
    var data = input && typeof input === 'object' ? input : {};
    var status = this._pickFirstNonEmpty([
      data.status,
      data.isFollowing,
      data.isFollow,
      data.followed,
      data.followStatus,
      data.follow_state,
    ]);
    var isFollowing = false;
    if (typeof status === 'boolean') {
      isFollowing = status;
    } else if (typeof status === 'number') {
      isFollowing = status === 1;
    } else if (typeof status === 'string') {
      var lowered = status.toLowerCase();
      isFollowing = lowered === '1' || lowered === 'true' || lowered === 'followed';
    }

    var followPinId = this._normalizePinId(
      this._pickFirstString([
        data.followPinId,
        data.followPinID,
        data.follow_pin_id,
        data.pinId,
        data.pinid,
      ])
    );

    if (!status && followPinId) isFollowing = true;

    return {
      isFollowing: isFollowing,
      followPinId: followPinId,
    };
  }

  _pickFirstNonEmpty(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      return value;
    }
    return null;
  }

  _pickData(response) {
    if (!response || typeof response !== 'object') return {};
    if (response.data && typeof response.data === 'object') return response.data;
    return response;
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

  _resolveMetaidManBase() {
    var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
    var base = this._pickFirstString([serviceLocator.metaid_man, 'https://www.show.now/man']);
    return base.replace(/\/+$/, '');
  }

  _normalizeMaybeRelativeUrl(url, base) {
    var text = this._pickFirstString([url]);
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.indexOf('//') === 0) {
      var protocol = (typeof window !== 'undefined' && window.location && window.location.protocol)
        ? window.location.protocol
        : 'https:';
      return protocol + text;
    }
    if (text[0] === '/') {
      var baseText = this._pickFirstString([base]).replace(/\/+$/, '');
      return baseText ? (baseText + text) : text;
    }
    return text;
  }
}
