/**
 * FollowUserCommand - create follow pin for target metaid.
 */
export default class FollowUserCommand {
  async execute({ payload = {}, stores }) {
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
    if (!targetMetaid) {
      throw new Error('target metaid is required');
    }
    var followerMetaid = this._resolveFollowerMetaid(payload, stores);

    var path = this._pickFirstString([payload.path, '/follow']) || '/follow';
    if (path[0] !== '/' && path[0] !== '@') path = '/' + path;

    var pinRes = await window.IDFramework.BuiltInCommands.createPin({
      payload: {
        operation: 'create',
        path: path,
        body: targetMetaid,
        contentType: 'text/plain;utf-8',
      },
      stores: stores,
    });

    var txid = this._extractTxid(pinRes);
    if (!txid && this._isCreatePinRejected(pinRes)) {
      throw new Error('followUser canceled or failed');
    }
    if (!txid && typeof console !== 'undefined' && console && typeof console.warn === 'function') {
      console.warn('FollowUserCommand: createPin returned without txid, proceed with optimistic state');
    }
    return {
      targetMetaid: targetMetaid,
      followerMetaid: followerMetaid,
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

    var direct = [
      result.txid,
      result.txId,
      result.pinTxId,
      result.pinid,
      result.pinId,
      Array.isArray(result.txids) && result.txids.length > 0 ? result.txids[0] : '',
      Array.isArray(result.revealTxIds) && result.revealTxIds.length > 0 ? result.revealTxIds[0] : '',
    ];
    for (var i = 0; i < direct.length; i += 1) {
      var candidate = this._pickFirstString([direct[i]]);
      if (!candidate) continue;
      var tx = candidate.match(/[A-Fa-f0-9]{64}/);
      if (tx && tx[0]) return tx[0];
    }

    if (Array.isArray(result.transactions) && result.transactions.length > 0) {
      for (var j = 0; j < result.transactions.length; j += 1) {
        var item = result.transactions[j];
        if (!item || typeof item !== 'object') continue;
        var nestedCandidate = this._pickFirstString([
          item.txid,
          item.txId,
          item.id,
          item.hash,
        ]);
        if (!nestedCandidate) continue;
        var nestedTx = nestedCandidate.match(/[A-Fa-f0-9]{64}/);
        if (nestedTx && nestedTx[0]) return nestedTx[0];
      }
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

  _isCreatePinRejected(result) {
    if (!result || typeof result !== 'object') return false;
    var status = this._pickFirstString([
      result.status,
      result.state,
      result.code,
      result.message,
      result.msg,
    ]).toLowerCase();
    if (!status && result.data && typeof result.data === 'object') {
      return this._isCreatePinRejected(result.data);
    }
    if (!status) return false;
    return status.indexOf('cancel') >= 0 ||
      status.indexOf('reject') >= 0 ||
      status.indexOf('fail') >= 0 ||
      status.indexOf('error') >= 0;
  }

  _resolveFollowerMetaid(payload, stores) {
    var walletStore = this._getStore(stores, 'wallet');
    var userStore = this._getStore(stores, 'user');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    var walletMetaidInfo = walletStore && walletStore.globalMetaIdInfo;

    var candidates = [];
    this._pushMetaidCandidates(candidates, [
      payload && payload.followerMetaid,
      payload && payload.viewerMetaid,
      walletMetaidInfo && walletMetaidInfo.mvc && walletMetaidInfo.mvc.metaId,
      walletMetaidInfo && walletMetaidInfo.mvc && walletMetaidInfo.mvc.metaid,
      user && user.metaid,
      user && user.metaId,
      walletStore && walletStore.metaid,
    ]);
    this._pushMetaidsFromUnknown(walletMetaidInfo, candidates);
    return candidates.length > 0 ? candidates[0] : '';
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

  _normalizeMetaid(raw) {
    var text = this._pickFirstString([raw]).toLowerCase();
    if (!text) return '';
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    var matched = text.match(/[a-f0-9]{64}/);
    return matched && matched[0] ? matched[0] : '';
  }
}
