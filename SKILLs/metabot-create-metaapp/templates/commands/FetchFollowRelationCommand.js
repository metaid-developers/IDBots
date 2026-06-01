/**
 * FetchFollowRelationCommand
 *
 * Resolve follow relationship between viewer and target metaid.
 * Uses:
 * - GET /api/follow/record?metaId={target}&followerMetaId={viewer}
 */
export default class FetchFollowRelationCommand {
  async execute({ payload = {}, stores, delegate, userDelegate }) {
    if (typeof delegate !== 'function') {
      throw new Error('FetchFollowRelationCommand: delegate is required');
    }

    var targetMetaid = this._pickFirstMetaid([
      payload.metaid,
      payload.metaId,
      payload.targetMetaid,
      payload.followMetaid,
    ]);
    if (!targetMetaid) {
      throw new Error('FetchFollowRelationCommand: target metaid is required');
    }

    var viewerMetaid = this._pickFirstMetaid([
      payload.followerMetaid,
      payload.viewerMetaid,
      this._resolveViewerMetaid(stores),
    ]);

    if (!viewerMetaid) {
      viewerMetaid = await this._resolveViewerMetaidByAddress(stores, userDelegate);
    }

    if (!viewerMetaid || viewerMetaid === targetMetaid) {
      return {
        targetMetaid: targetMetaid,
        viewerMetaid: viewerMetaid || '',
        isFollowing: false,
        followPinId: '',
      };
    }

    var query = new URLSearchParams({
      metaId: targetMetaid,
      followerMetaId: viewerMetaid,
      _t: String(Date.now()),
    }).toString();

    var response = await this._fetchFirstSuccess([
      { service: 'metaid_man', endpoint: '/api/follow/record?' + query },
      { service: 'man_api', endpoint: '/follow/record?' + query },
    ], delegate);

    var normalized = this._normalizeFollowRelation(this._pickData(response));
    return {
      targetMetaid: targetMetaid,
      viewerMetaid: viewerMetaid,
      isFollowing: !!normalized.isFollowing,
      followPinId: normalized.followPinId || '',
    };
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
    throw new Error('FetchFollowRelationCommand: no candidate endpoint available');
  }

  _getStore(stores, name) {
    if (stores && stores[name]) return stores[name];
    if (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function') {
      return Alpine.store(name);
    }
    return null;
  }

  _resolveViewerMetaid(stores) {
    var walletStore = this._getStore(stores, 'wallet');
    var userStore = this._getStore(stores, 'user');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;

    var candidates = [];
    this._pushMetaidCandidates(candidates, [
      user && user.metaid,
      user && user.metaId,
      walletStore && walletStore.metaid,
      walletStore && walletStore.metaId,
    ]);
    this._pushMetaidsFromUnknown(walletStore && walletStore.globalMetaIdInfo, candidates);
    return candidates.length > 0 ? candidates[0] : '';
  }

  async _resolveViewerMetaidByAddress(stores, userDelegate) {
    if (typeof userDelegate !== 'function') return '';
    var walletStore = this._getStore(stores, 'wallet');
    var userStore = this._getStore(stores, 'user');
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

    var followPinId = this._normalizePinId(this._pickFirstString([
      data.followPinId,
      data.followPinID,
      data.follow_pin_id,
      data.pinId,
      data.pinid,
    ]));
    if (!status && followPinId) isFollowing = true;

    return {
      isFollowing: isFollowing,
      followPinId: followPinId,
    };
  }

  _pickData(response) {
    if (!response || typeof response !== 'object') return {};
    if (response.data && typeof response.data === 'object') return response.data;
    return response;
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
      var metaid = this._normalizeMetaid(candidates[i]);
      if (metaid) return metaid;
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
}
