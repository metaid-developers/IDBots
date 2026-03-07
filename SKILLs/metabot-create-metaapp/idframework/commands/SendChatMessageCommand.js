import PostBuzzCommand from './PostBuzzCommand.js';

export default class SendChatMessageCommand {
  constructor() {
    this._uploader = new PostBuzzCommand();
  }

  async execute({ payload = {}, stores }) {
    this._ensureOnchainReady(stores);

    var mode = payload.mode === 'private' ? 'private' : 'group';
    var groupId = String(payload.groupId || '').trim();
    var to = String(payload.to || '').trim();
    var replyPin = String(payload.replyPin || '').trim();
    var channelId = String(payload.channelId || '').trim();
    var nickName = this._resolveNickName(payload, stores);
    var content = typeof payload.content === 'string' ? payload.content : '';
    var mention = Array.isArray(payload.mention) ? payload.mention.filter(Boolean) : [];
    var file = payload.file instanceof File
      ? payload.file
      : (Array.isArray(payload.files) && payload.files[0] instanceof File ? payload.files[0] : null);

    if (mode === 'group' && !groupId) throw new Error('groupId is required for group mode');
    if (mode === 'private' && !to) throw new Error('to (globalMetaId) is required for private mode');
    if (!content.trim() && !file) throw new Error('Please enter message content or add file');

    if (file) {
      return this._sendFileMessage({
        file: file,
        mode: mode,
        groupId: groupId,
        to: to,
        nickName: nickName,
        channelId: channelId,
        replyPin: replyPin,
        payload: payload,
        stores: stores,
      });
    }

    return this._sendTextMessage({
      mode: mode,
      groupId: groupId,
      to: to,
      nickName: nickName,
      channelId: channelId,
      replyPin: replyPin,
      content: content,
      mention: mention,
      payload: payload,
    });
  }

  async _sendTextMessage(params) {
    var mode = params.mode;
    var body;
    var protocolPath;
    if (mode === 'group') {
      protocolPath = '/protocols/simplegroupchat';
      body = {
        groupId: params.groupId,
        nickName: params.nickName,
        content: this._groupEncrypt(params.content, params.groupId.substring(0, 16)),
        contentType: 'text/plain',
        encryption: 'aes',
        timestamp: Date.now(),
        replyPin: params.replyPin || '',
        channelId: params.channelId || '',
        mention: params.mention || [],
      };
    } else {
      protocolPath = '/protocols/simplemsg';
      var otherChatPubkey = await this._fetchOtherChatPubkey(params.to);
      if (!otherChatPubkey) throw new Error('get_ecdh_pubey_error');
      var sharedSecret = await this._getSharedSecret(otherChatPubkey);
      if (!sharedSecret) throw new Error('Failed to generate shared secret');
      body = {
        to: params.to,
        encrypt: 'ecdh',
        content: this._privateEncrypt(params.content, sharedSecret),
        contentType: 'text/plain',
        timestamp: Date.now(),
        replyPin: params.replyPin || '',
      };
    }

    var txRes = await this._createWithWallet({
      operation: 'create',
      path: protocolPath,
      body: JSON.stringify(body),
      contentType: 'application/json',
    }, this._resolveFeeRate(params.payload), this._estimateMessageFeeSats(body, 0));

    return {
      mode: mode,
      protocolPath: protocolPath,
      body: body,
      attachment: '',
      txid: this._extractTxid(txRes),
      pinRes: txRes,
    };
  }

  async _sendFileMessage(params) {
    var file = params.file;
    var fileType = this._fileTypeFromNameOrMime(file);
    var ext = this._fileExt(file);
    var feeRate = this._resolveFeeRate(params.payload);
    var attachment = '';
    var fileTxid = '';

    if (params.mode === 'group') {
      attachment = await this._uploader._uploadFileToMetafile(file, params.stores);
      fileTxid = this._extractTxidFromMetafileUri(attachment);
    } else {
      // Private file flow uses createPin directly and is capped to <= 1MB.
      if (file.size > 1024 * 1024) {
        throw new Error('Private file message only supports files <= 1MB');
      }

      var otherChatPubkey = await this._fetchOtherChatPubkey(params.to);
      debugger
      if (!otherChatPubkey) throw new Error('get_ecdh_pubey_error');
      var sharedSecret = await this._getSharedSecret(otherChatPubkey);
      if (!sharedSecret) throw new Error('Failed to generate shared secret');
      var fileHex = await this._fileToHex(file);
      if (!fileHex) throw new Error('Failed to read file data');
      fileHex = this._privateEncryptHexFile(fileHex, sharedSecret);

      var filePinRes = await this._createWithWallet({
        operation: 'create',
        path: '/file',
        body: fileHex,
        contentType: file.type || 'application/octet-stream',
        encoding: 'hex',
      }, feeRate, this._estimateFilePinFeeSats(fileHex));

      fileTxid = this._extractTxid(filePinRes);
      if (!fileTxid) throw new Error('File createPin succeeded but txid is missing');
      var pinId = fileTxid + 'i0';
      attachment = 'metafile://' + pinId + (ext ? '.' + ext : '');
    }

    var protocolPath = params.mode === 'group' ? '/protocols/simplefilegroupchat' : '/protocols/simplefilemsg';
    var body = params.mode === 'group'
      ? {
          groupId: params.groupId,
          attachment: attachment,
          fileType: fileType,
          nickName: params.nickName,
          timestamp: Date.now(),
          encrypt: '0',
          replyPin: params.replyPin || '',
          channelId: params.channelId || '',
        }
      : {
          to: params.to,
          encrypt: 'ecdh',
          attachment: attachment,
          fileType: fileType,
          timestamp: Date.now(),
          replyPin: params.replyPin || '',
        };

    var msgPinRes = await this._createWithWallet({
      operation: 'create',
      path: protocolPath,
      body: JSON.stringify(body),
      contentType: 'application/json',
    }, feeRate, this._estimateMessageFeeSats(body, 1));

    return {
      mode: params.mode,
      protocolPath: protocolPath,
      body: body,
      attachment: attachment,
      filePinTxid: fileTxid,
      txid: this._extractTxid(msgPinRes),
      pinRes: msgPinRes,
    };
  }

  _extractTxidFromMetafileUri(uri) {
    var raw = String(uri || '');
    if (raw.indexOf('metafile://') === 0) raw = raw.slice('metafile://'.length);
    var pin = raw.split('.')[0] || '';
    if (pin.slice(-2) === 'i0') return pin.slice(0, -2);
    return '';
  }

  _getCryptoJS() {
    var CryptoJS = (typeof window !== 'undefined' && window.CryptoJS)
      ? window.CryptoJS
      : (typeof globalThis !== 'undefined' ? globalThis.CryptoJS : null);
    if (!CryptoJS) throw new Error('CryptoJS is unavailable. Please include ./crypto.js before using chat encryption.');
    return CryptoJS;
  }

  _base64ToHex(base64) {
    var binary = typeof atob === 'function' ? atob(base64) : '';
    var out = '';
    for (var i = 0; i < binary.length; i += 1) {
      var h = binary.charCodeAt(i).toString(16);
      out += h.length === 1 ? '0' + h : h;
    }
    return out;
  }

  _groupEncrypt(message, secretKeyStr) {
    var CryptoJS = this._getCryptoJS();
    var Utf8 = CryptoJS.enc.Utf8;
    var iv = Utf8.parse('0000000000000000');
    var encrypted = CryptoJS.AES.encrypt(Utf8.parse(String(message || '')), Utf8.parse(String(secretKeyStr || '')), {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    return this._base64ToHex(encrypted.toString());
  }

  _privateEncrypt(message, sharedSecret) {
    var CryptoJS = this._getCryptoJS();
    return CryptoJS.AES.encrypt(String(message || ''), String(sharedSecret || '')).toString();
  }

  _privateEncryptHexFile(messageHex, sharedSecretHex) {
    var CryptoJS = this._getCryptoJS();
    var enc = CryptoJS.enc;
    var iv = enc.Utf8.parse('0000000000000000');
    var encrypted = CryptoJS.AES.encrypt(enc.Hex.parse(String(messageHex || '')), enc.Hex.parse(String(sharedSecretHex || '')), {
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
      iv: iv,
    });
    return encrypted.ciphertext.toString(enc.Hex);
  }

  async _fileToHex(file) {
    var chunkSize = 20 * 1024 * 1024;
    var hex = '';
    for (var index = 0; index < file.size; index += chunkSize) {
      var chunk = file.slice(index, index + chunkSize);
      var buf = await chunk.arrayBuffer();
      var bytes = new Uint8Array(buf);
      for (var i = 0; i < bytes.length; i += 1) {
        var h = bytes[i].toString(16);
        hex += h.length === 1 ? '0' + h : h;
      }
    }
    return hex;
  }

  _fileExt(file) {
    var name = String((file && file.name) || '');
    var idx = name.lastIndexOf('.');
    return idx > -1 ? name.slice(idx + 1).toLowerCase() : '';
  }

  _fileTypeFromNameOrMime(file) {
    var ext = this._fileExt(file);
    if (ext) return ext;
    var mime = String((file && file.type) || '').toLowerCase();
    if (!mime) return 'file';
    var parts = mime.split('/');
    return parts[1] || parts[0] || 'file';
  }

  async _fetchOtherChatPubkey(globalMetaId) {
    if (!globalMetaId) return '';
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') throw new Error('IDFramework is not available');
    var userInfo = await window.IDFramework.dispatch('fetchUserInfo', { globalMetaId: globalMetaId });
    return this._pickChatPubkey(userInfo);
  }

  _pickChatPubkey(userData) {
    if (!userData || typeof userData !== 'object') return '';
    var root = userData.data && typeof userData.data === 'object' ? userData.data : userData;
    return String(root.chatpubkey || root.chatPubkey || root.chatPublicKey || root.pubkey || '').trim();
  }

  async _getSharedSecret(otherChatPubkey) {
    if (!window.metaidwallet || !window.metaidwallet.common || typeof window.metaidwallet.common.ecdh !== 'function') {
      throw new Error('Metalet ecdh API is unavailable');
    }
    var ecdh = await window.metaidwallet.common.ecdh({ externalPubKey: otherChatPubkey });
    return ecdh && ecdh.sharedSecret ? ecdh.sharedSecret : '';
  }

  async _createWithWallet(metaidData, feeRate, estimatedSats) {
    if (!window.metaidwallet || typeof window.metaidwallet.createPin !== 'function') {
      throw new Error('Metalet wallet createPin is unavailable');
    }
    debugger
    var smallPayLimit = 10000;
    var canUseSmallPay = false;
    var autoPaymentAmount = smallPayLimit;

    if (window.useApprovedStore && typeof window.useApprovedStore === 'function') {
      var approvedStore = window.useApprovedStore();
      if (approvedStore && typeof approvedStore.getPaymentStatus === 'function') await approvedStore.getPaymentStatus();
      if (approvedStore && typeof approvedStore.getAutoPayment === 'function') await approvedStore.getAutoPayment();
      if (approvedStore && approvedStore.last && Number(approvedStore.last.autoPaymentAmount) > 0) {
        autoPaymentAmount = Number(approvedStore.last.autoPaymentAmount);
      }
      canUseSmallPay = !!(
        approvedStore &&
        approvedStore.canUse &&
        estimatedSats <= autoPaymentAmount &&
        estimatedSats <= smallPayLimit
      );
    }

    return window.metaidwallet.createPin({
      chain: 'mvc',
      feeRate: feeRate,
      dataList: [{ metaidData: metaidData }],
      useSmallPay: canUseSmallPay,
      smallPay: canUseSmallPay,
      autoPaymentAmount: autoPaymentAmount,
    });
  }

  _estimateFilePinFeeSats(fileHex) {
    return Math.ceil(900 + String(fileHex || '').length * 0.25);
  }

  _estimateMessageFeeSats(body, attachmentCount) {
    var textSize = JSON.stringify(body || {}).length;
    return Math.ceil(600 + textSize * 1.2 + Number(attachmentCount || 0) * 240);
  }

  _resolveFeeRate(payload) {
    var fromPayload = Number(payload.feeRate);
    if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;
    var cfg = window.IDConfig || {};
    var fromCfg = Number(cfg.FEE_RATE);
    return Number.isFinite(fromCfg) && fromCfg > 0 ? fromCfg : 1;
  }

  _resolveNickName(payload, stores) {
    if (payload.nickName && String(payload.nickName).trim()) return String(payload.nickName).trim();
    var userStore = stores && stores.user ? stores.user : (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
    if (userStore && userStore.user) return String(userStore.user.name || userStore.user.nickname || userStore.user.metaid || '');
    return '';
  }

  _ensureOnchainReady(stores) {
    var walletStore = stores && stores.wallet ? stores.wallet : (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
    var userStore = stores && stores.user ? stores.user : (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
    var userObj = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    var walletReady = !!(walletStore && walletStore.isConnected && walletStore.address);
    var userReady = !!(userObj && Object.keys(userObj).length > 0);
    var walletApiReady = !!window.metaidwallet;
    if (!walletReady || !userReady || !walletApiReady) {
      var message = 'Please log in to your wallet before proceeding.';
      if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') window.IDUtils.showMessage('error', message);
      var error = new Error(message);
      error._alreadyShown = true;
      throw error;
    }
  }

  _extractTxid(res) {
    if (!res) return '';
    if (Array.isArray(res.txids) && res.txids[0]) return String(res.txids[0]);
    if (res.txid) return String(res.txid);
    if (res.data) {
      if (Array.isArray(res.data.txids) && res.data.txids[0]) return String(res.data.txids[0]);
      if (res.data.txid) return String(res.data.txid);
    }
    return '';
  }
}

