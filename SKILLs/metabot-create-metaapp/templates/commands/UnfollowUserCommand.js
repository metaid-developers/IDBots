/**
 * UnfollowUserCommand - revoke follow pin.
 *
 * Requires followPinId, or resolves it from follow record by
 * (target metaid + follower metaid).
 */
export default class UnfollowUserCommand {
  async execute({ payload = {}, stores, delegate }) {
    if (!window.IDFramework || !window.IDFramework.BuiltInCommands || !window.IDFramework.BuiltInCommands.createPin) {
      throw new Error('IDFramework.BuiltInCommands.createPin is not available');
    }

    this._ensureOnchainReady(stores);

    var targetMetaid = this._pickFirstString([
      payload.metaid,
      payload.metaId,
      payload.targetMetaid,
      payload.followMetaid,
    ]);
    var followerMetaids = this._collectMetaidCandidates([
      payload.followerMetaid,
      payload.viewerMetaid,
      this._resolveViewerMetaid(stores),
    ], stores);
    var followerMetaid = followerMetaids.length > 0 ? followerMetaids[0] : '';

    var followPinId = this._normalizePinId(
      this._pickFirstString([payload.followPinId, payload.followPinID, payload.pinId])
    );

    if (!followPinId && typeof delegate === 'function' && targetMetaid) {
      if (followerMetaids.length > 0) {
        for (var i = 0; i < followerMetaids.length; i += 1) {
          var candidateFollowerMetaid = this._normalizeMetaid(followerMetaids[i]);
          if (!candidateFollowerMetaid) continue;
          followPinId = await this._fetchFollowPinId(targetMetaid, candidateFollowerMetaid, delegate);
          if (followPinId) {
            followerMetaid = candidateFollowerMetaid;
            break;
          }
        }
      } else if (followerMetaid) {
        followPinId = await this._fetchFollowPinId(targetMetaid, followerMetaid, delegate);
      }
    }

    if (!followPinId) {
      throw new Error('followPinId is required for unfollow');
    }

    var pinRes = await window.IDFramework.BuiltInCommands.createPin({
      payload: {
        operation: 'revoke',
        path: '@' + followPinId,
        body: this._pickFirstString([payload.body, followPinId, 'revoke']),
        contentType: 'text/plain;utf-8',
      },
      stores: stores,
    });

    var txid = this._extractTxid(pinRes);
    return {
      targetMetaid: targetMetaid,
      followPinId: followPinId,
      pinRes: pinRes,
      txid: txid,
      pinId: txid ? (txid + 'i0') : '',
    };
  }

  _getStore(stores, name) {
    if (stores && stores[name]) return stores[name];
    if (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function') {
      return Alpine.store(name);
    }
    return null;
  }

  _resolveViewerMetaid(stores) {
    var userStore = this._getStore(stores, 'user');
    var walletStore = this._getStore(stores, 'wallet');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    return this._pickFirstMetaid([
      user && user.metaid,
      user && user.metaId,
      walletStore && walletStore.metaid,
    ]);
  }

  _collectMetaidCandidates(candidates, stores) {
    var bucket = [];
    var walletStore = this._getStore(stores, 'wallet');
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

  async _fetchFollowPinId(targetMetaid, followerMetaid, delegate) {
    var query = new URLSearchParams({
      metaId: targetMetaid,
      followerMetaId: followerMetaid,
    }).toString();

    var candidates = [
      { service: 'metaid_man', endpoint: '/api/follow/record?' + query },
      { service: 'man_api', endpoint: '/follow/record?' + query },
    ];

    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      try {
        var response = await delegate(candidate.service, candidate.endpoint, { method: 'GET' });
        var data = this._pickData(response);
        var followPinId = this._normalizePinId(this._pickFirstString([
          data && data.followPinId,
          data && data.followPinID,
          data && data.pinId,
        ]));
        if (followPinId) return followPinId;
      } catch (_) {
        // try next candidate
      }
    }

    return '';
  }

  _pickData(response) {
    if (!response || typeof response !== 'object') return {};
    if (response.data && typeof response.data === 'object') return response.data;
    return response;
  }

  _normalizePinId(value) {
    var text = this._pickFirstString([value]);
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

  _notifyNeedLoginWallet(message) {
    if (typeof window !== 'undefined' && window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage('error', message);
      return;
    }
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message);
    }
  }

  _ensureOnchainReady(stores) {
    var message = 'Please log in to your wallet before proceeding.';
    var walletStore = this._getStore(stores, 'wallet');
    var userStore = this._getStore(stores, 'user');
    var userObj = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    var walletReady = !!(walletStore && walletStore.isConnected && walletStore.address);
    var userReady = !!(userObj && Object.keys(userObj).length > 0);
    var walletApiReady = !!(typeof window !== 'undefined' && window.metaidwallet);

    if (!walletReady || !userReady || !walletApiReady) {
      this._notifyNeedLoginWallet(message);
      var error = new Error(message);
      error._alreadyShown = true;
      throw error;
    }
  }

  _extractTxid(result) {
    if (!result) return '';

    var direct = [result.txid, result.txId, result.pinTxId, result.pinid, result.pinId];
    for (var i = 0; i < direct.length; i += 1) {
      var candidate = this._pickFirstString([direct[i]]);
      if (!candidate) continue;
      var tx = candidate.match(/[A-Fa-f0-9]{64}/);
      if (tx && tx[0]) return tx[0];
    }

    var nested = result.data && typeof result.data === 'object' ? result.data : null;
    if (nested) {
      var nestedTx = this._extractTxid(nested);
      if (nestedTx) return nestedTx;
    }

    if (Array.isArray(result.revealTxIds) && result.revealTxIds.length > 0) {
      var firstReveal = this._pickFirstString([result.revealTxIds[0]]);
      var revealTx = firstReveal.match(/[A-Fa-f0-9]{64}/);
      if (revealTx && revealTx[0]) return revealTx[0];
    }

    return '';
  }
}
