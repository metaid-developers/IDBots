/**
 * LikeBuzzCommand - Create a paylike pin for a buzz.
 */
export default class LikeBuzzCommand {
  async execute({ payload = {}, stores }) {
    if (!window.IDFramework || !window.IDFramework.BuiltInCommands || !window.IDFramework.BuiltInCommands.createPin) {
      throw new Error('IDFramework.BuiltInCommands.createPin is not available');
    }

    this._ensureOnchainReady(stores);

    var pinId = this._normalizePinId(payload.pinId || payload.pinid || payload.id || payload.likeTo || '');
    var path = String(payload.path || '').trim() || '/protocols/paylike';
    if (!pinId) {
      throw new Error('pinId is required');
    }

    var body = {
      isLike: '1',
      likeTo: pinId,
    };

    var pinRes = await window.IDFramework.BuiltInCommands.createPin({
      payload: {
        operation: 'create',
        body: JSON.stringify(body),
        path: path,
        contentType: 'application/json;utf-8',
      },
      stores: stores,
    });

    return {
      pinId: pinId,
      body: body,
      pinRes: pinRes,
      txid: this._extractTxid(pinRes),
    };
  }

  _getStore(stores, name) {
    if (stores && stores[name]) return stores[name];
    if (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function') {
      return Alpine.store(name);
    }
    return null;
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

  _extractTxid(result) {
    if (!result) return '';

    var direct = [result.txid, result.txId, result.pinTxId, result.pinid, result.pinId];
    for (var i = 0; i < direct.length; i += 1) {
      var candidate = String(direct[i] || '').trim();
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
      var firstReveal = String(result.revealTxIds[0] || '').trim();
      var revealTx = firstReveal.match(/[A-Fa-f0-9]{64}/);
      if (revealTx && revealTx[0]) return revealTx[0];
    }

    return '';
  }
}
