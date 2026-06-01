import PostBuzzCommand from './PostBuzzCommand.js';
import '../stores/chat/useApprovedStore.js';

export default class SendChatMessageCommand {
  constructor() {
    this._uploader = new PostBuzzCommand();
    this._metaIdJSLib = null;
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
    var chain = this._resolveChain(params.payload);
    var feeRate = this._resolveFeeRate(params.payload, chain);
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
    }, feeRate, this._estimateMessageFeeSats(body, 0), chain);

    return {
      mode: mode,
      protocolPath: protocolPath,
      body: body,
      attachment: '',
      chain: chain,
      feeRate: feeRate,
      txid: this._extractTxid(txRes),
      pinRes: txRes,
    };
  }

  async _sendFileMessage(params) {
    var file = params.file;
    var fileType = this._fileTypeFromNameOrMime(file);
    var ext = this._fileExt(file);
    var chain = this._resolveChain(params.payload);
    var feeRate = this._resolveFeeRate(params.payload, chain);
    var attachment = '';
    var fileTxid = '';

    if (params.mode === 'group') {
      var filePin = await this._createGroupFilePin({
        file: file,
        chain: chain,
        feeRate: feeRate,
      });
      fileTxid = filePin.txid;
      if (!fileTxid) throw new Error('File createPin succeeded but txid is missing');
      var groupPinId = fileTxid + 'i0';
      attachment = 'metafile://' + groupPinId + (ext ? '.' + ext : '');
    } else {
      // Private file flow uses createPin directly and is capped to <= 1MB.
      if (file.size > 1024 * 1024) {
        throw new Error('Private file message only supports files <= 1MB');
      }

      var otherChatPubkey = await this._fetchOtherChatPubkey(params.to);
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
      }, feeRate, this._estimateFilePinFeeSats(fileHex), chain);

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
    }, feeRate, this._estimateMessageFeeSats(body, 1), chain);

    return {
      mode: params.mode,
      protocolPath: protocolPath,
      body: body,
      attachment: attachment,
      filePinTxid: fileTxid,
      chain: chain,
      feeRate: feeRate,
      txid: this._extractTxid(msgPinRes),
      pinRes: msgPinRes,
    };
  }

  async _createGroupFilePin(params) {
    var file = params && params.file ? params.file : null;
    if (!(file instanceof File)) throw new Error('Invalid file object');
    var chain = this._normalizeChain(params && params.chain ? params.chain : '') || 'mvc';
    var feeRate = Number(params && params.feeRate);
    var contentType = this._buildBinaryContentType(file);
    var estimate = this._estimateFilePinFeeByBytes(file.size);

    if (chain === 'mvc') {
      try {
        var binaryBody = await this._fileToUint8Array(file);
        var binaryRes = await this._createWithWallet({
          operation: 'create',
          path: '/file',
          body: binaryBody,
          contentType: contentType,
          encoding: 'binary',
        }, feeRate, estimate, chain);
        var binaryTxid = this._extractTxid(binaryRes);
        if (!binaryTxid) throw new Error('File createPin succeeded but txid is missing');
        return { txid: binaryTxid, pinRes: binaryRes };
      } catch (_) {
        // Metalet environments may not accept binary body; fallback to base64 for compatibility.
      }
    }

    var base64Body = await this._fileToBase64(file);
    var base64Res = await this._createWithWallet({
      operation: 'create',
      path: '/file',
      body: base64Body,
      contentType: contentType,
      encoding: 'base64',
    }, feeRate, estimate, chain);
    var base64Txid = this._extractTxid(base64Res);
    if (!base64Txid) throw new Error('File createPin succeeded but txid is missing');
    return { txid: base64Txid, pinRes: base64Res };
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
    if (!CryptoJS) throw new Error('CryptoJS is unavailable. Please include ../../idframework/vendors/crypto.js in demo HTML before chat encryption.');
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

  async _fileToUint8Array(file) {
    var buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async _fileToBase64(file) {
    if (typeof file.arrayBuffer === 'function') {
      var buf = await file.arrayBuffer();
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(buf).toString('base64');
      }
      var bytes = new Uint8Array(buf);
      var binary = '';
      var chunkSize = 0x8000;
      for (var i = 0; i < bytes.length; i += chunkSize) {
        var chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var v = typeof fr.result === 'string' ? fr.result : '';
        var idx = v.indexOf(',');
        resolve(idx >= 0 ? v.slice(idx + 1) : v);
      };
      fr.onerror = function () { reject(new Error('Failed to read file')); };
      fr.readAsDataURL(file);
    });
  }

  _buildBinaryContentType(file) {
    var contentType = String((file && file.type) || 'application/octet-stream').trim() || 'application/octet-stream';
    if (contentType.toLowerCase().indexOf(';binary') >= 0) return contentType;
    return contentType + ';binary';
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

  async _createWithWallet(metaidData, feeRate, estimatedSats, chain) {
    var normalizedChain = this._normalizeChain(chain) || 'mvc';
    if ((normalizedChain === 'btc' || normalizedChain === 'doge') && this._canUseChainInscribe(normalizedChain)) {
      try {
        return await this._createWithChainInscribe(normalizedChain, metaidData, feeRate);
      } catch (error) {
        if (!this._shouldFallbackToCreatePinFromInscribe(error)) throw error;
      }
    }
    if (normalizedChain === 'mvc') {
      var mvcSmallPayRes = await this._createWithMvcSmallPay(metaidData, feeRate);
      if (mvcSmallPayRes) return mvcSmallPayRes;
    }
    if (!window.metaidwallet || typeof window.metaidwallet.createPin !== 'function') {
      throw new Error('Metalet wallet createPin is unavailable');
    }
    var smallPayLimit = 10000;
    var canUseSmallPay = false;
    var autoPaymentAmount = smallPayLimit;

    if (normalizedChain === 'mvc' && window.useApprovedStore && typeof window.useApprovedStore === 'function') {
      var approvedStore = window.useApprovedStore();
      if (approvedStore && typeof approvedStore.getPaymentStatus === 'function') await approvedStore.getPaymentStatus();
      if (approvedStore && typeof approvedStore.getAutoPayment === 'function') await approvedStore.getAutoPayment();
      if (approvedStore && approvedStore.last && Number(approvedStore.last.autoPaymentAmount) > 0) {
        autoPaymentAmount = Number(approvedStore.last.autoPaymentAmount);
      }
      canUseSmallPay = !!(approvedStore && approvedStore.canUse);
    }

    return window.metaidwallet.createPin({
      chain: normalizedChain,
      feeRate: feeRate,
      dataList: [{ metaidData: metaidData }],
      useSmallPay: canUseSmallPay,
      smallPay: canUseSmallPay,
      autoPaymentAmount: autoPaymentAmount,
    });
  }

  async _createWithMvcSmallPay(metaidData, feeRate) {
    if (!this._shouldUseMvcSmallPayForPath(metaidData)) return null;
    if (!window.metaidwallet || typeof window.metaidwallet.smallPay !== 'function') return null;
    var approvedStore = null;
    if (window.useApprovedStore && typeof window.useApprovedStore === 'function') {
      approvedStore = window.useApprovedStore();
    }

    if (typeof window !== 'undefined') {
      window.__IDF_CHAT_SMALLPAY_LAST = {
        ts: Date.now(),
        stage: 'start',
        path: String(metaidData && metaidData.path ? metaidData.path : ''),
      };
    }

    try {
      if (typeof window !== 'undefined') {
        window.__IDF_CHAT_SMALLPAY_LAST = {
          ts: Date.now(),
          stage: 'status-check',
          path: String(metaidData && metaidData.path ? metaidData.path : ''),
        };
      }
      var status = null;
      if (approvedStore && typeof approvedStore.getPaymentStatus === 'function') {
        status = await approvedStore.getPaymentStatus();
      } else if (window.metaidwallet && typeof window.metaidwallet.autoPaymentStatus === 'function') {
        status = await window.metaidwallet.autoPaymentStatus();
      }

      if (status && status.isEnabled === false) {
        if (typeof window !== 'undefined') {
          window.__IDF_CHAT_SMALLPAY_LAST = {
            ts: Date.now(),
            stage: 'skip-disabled',
            status: status,
          };
        }
        return null;
      }

      var shouldApprove =
        status &&
        status.isEnabled !== false &&
        status.isApproved !== true &&
        window.metaidwallet &&
        typeof window.metaidwallet.autoPayment === 'function';
      if (shouldApprove) {
        if (typeof window !== 'undefined') {
          window.__IDF_CHAT_SMALLPAY_LAST = {
            ts: Date.now(),
            stage: 'auto-payment-request',
            status: status,
          };
        }
        await window.metaidwallet.autoPayment();
      } else if (approvedStore && typeof approvedStore.getAutoPayment === 'function') {
        if (typeof window !== 'undefined') {
          window.__IDF_CHAT_SMALLPAY_LAST = {
            ts: Date.now(),
            stage: 'auto-payment-store',
            status: status,
          };
        }
        await approvedStore.getAutoPayment();
      }

      if (typeof window !== 'undefined') {
        window.__IDF_CHAT_SMALLPAY_LAST = {
          ts: Date.now(),
          stage: 'build-composer',
          status: status,
        };
      }
      var lib = await this._loadMetaIdJS();
      var txComposer = await this._buildMvcSmallPayTxComposer(metaidData, lib);
      var payParams = {
        transactions: [{ txComposer: txComposer.serialize(), message: 'Create Pin' }],
        hasMetaid: true,
        feeb: feeRate,
      };

      if (typeof window !== 'undefined') {
        window.__IDF_CHAT_SMALLPAY_LAST = {
          ts: Date.now(),
          stage: 'smallpay-call',
          status: status,
        };
      }
      var payRes = await window.metaidwallet.smallPay(payParams);
      if (this._isSmallPayErrorResult(payRes) && this._isSmallPayApprovalError(payRes)) {
        if (window.metaidwallet && typeof window.metaidwallet.autoPayment === 'function') {
          await window.metaidwallet.autoPayment();
          payRes = await window.metaidwallet.smallPay(payParams);
        }
      }
      if (this._isSmallPayErrorResult(payRes)) {
        throw new Error(String(payRes.message || 'smallPay failed'));
      }

      var payedTransactions = Array.isArray(payRes && payRes.payedTransactions) ? payRes.payedTransactions : [];
      if (payedTransactions.length === 0) return null;

      if (typeof window !== 'undefined') {
        window.__IDF_CHAT_SMALLPAY_LAST = {
          ts: Date.now(),
          stage: 'broadcast',
          payRes: this._safeObjectForDebug(payRes),
        };
      }
      var txids = await this._broadcastMvcSmallPayTransactions(payedTransactions, lib);
      if (txids.length === 0) return null;
      if (typeof window !== 'undefined') {
        window.__IDF_CHAT_SMALLPAY_LAST = {
          ts: Date.now(),
          stage: 'success',
          txid: txids[0] || '',
        };
      }
      return { txids: txids };
    } catch (error) {
      if (typeof window !== 'undefined') {
        window.__IDF_CHAT_SMALLPAY_LAST = {
          ts: Date.now(),
          stage: 'fallback',
          message: this._errorMessage(error),
          stack: error && error.stack ? String(error.stack) : '',
        };
      }
      console.warn('SendChatMessageCommand: mvc smallPay path failed, fallback to createPin', error);
      return null;
    }
  }

  _safeObjectForDebug(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return { status: value.status, message: value.message };
    }
  }

  _isSmallPayErrorResult(payRes) {
    return !!(payRes && typeof payRes === 'object' && String(payRes.status || '').toLowerCase() === 'error');
  }

  _isSmallPayApprovalError(payRes) {
    var message = String(payRes && payRes.message ? payRes.message : '').toLowerCase();
    if (!message) return false;
    if (message.indexOf('not approved') >= 0) return true;
    if (message.indexOf('auto payment not approved') >= 0) return true;
    return false;
  }

  _shouldUseMvcSmallPayForPath(metaidData) {
    var path = String(metaidData && metaidData.path ? metaidData.path : '').trim();
    if (!path) return false;
    return path.indexOf('/protocols/') === 0;
  }

  async _loadMetaIdJS() {
    if (this._metaIdJSLib) return this._metaIdJSLib;
    if (typeof window !== 'undefined' && window.MetaIDJs) {
      this._metaIdJSLib = window.MetaIDJs;
      return this._metaIdJSLib;
    }
    throw new Error('MetaIDJs is unavailable');
  }

  _getMetaidBufferCtor(lib) {
    return lib && lib.mvc && lib.mvc.deps && lib.mvc.deps.Buffer
      ? lib.mvc.deps.Buffer
      : (typeof Buffer !== 'undefined' ? Buffer : null);
  }

  _normalizeMetaidBody(metaidBody, encoding, lib) {
    var body = metaidBody;
    if (body === undefined || body === null) return '';

    var BufferCtor = this._getMetaidBufferCtor(lib);
    var targetEncoding = String(encoding || 'utf-8');

    if (BufferCtor && typeof BufferCtor.isBuffer === 'function' && BufferCtor.isBuffer(body)) {
      return body;
    }
    if (typeof Uint8Array !== 'undefined' && body instanceof Uint8Array) {
      return BufferCtor ? BufferCtor.from(body) : body;
    }
    if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) {
      var bytes = new Uint8Array(body);
      return BufferCtor ? BufferCtor.from(bytes) : bytes;
    }
    if (typeof body === 'string') {
      return BufferCtor ? BufferCtor.from(body, targetEncoding) : body;
    }
    return BufferCtor ? BufferCtor.from(String(body), 'utf-8') : String(body);
  }

  _buildMvcMetaidOpReturn(metaidData, lib) {
    var operation = String(metaidData && metaidData.operation ? metaidData.operation : 'create');
    var opreturn = ['metaid', operation];
    if (operation !== 'init') {
      opreturn.push(String(metaidData && metaidData.path ? metaidData.path : ''));
      opreturn.push(String(metaidData && metaidData.encryption ? metaidData.encryption : '0'));
      opreturn.push(String(metaidData && metaidData.version ? metaidData.version : '1.0.0'));
      opreturn.push(String(metaidData && metaidData.contentType ? metaidData.contentType : 'text/plain;utf-8'));
      opreturn.push(this._normalizeMetaidBody(
        metaidData ? metaidData.body : '',
        metaidData ? metaidData.encoding : 'utf-8',
        lib
      ));
    }
    return opreturn;
  }

  async _resolveMvcAddress() {
    if (window.metaidwallet && typeof window.metaidwallet.getAddress === 'function') {
      var walletAddress = await window.metaidwallet.getAddress();
      if (walletAddress) return String(walletAddress);
    }
    if (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function') {
      var walletStore = Alpine.store('wallet');
      var storeAddress = walletStore && walletStore.address ? String(walletStore.address) : '';
      if (storeAddress) return storeAddress;
    }
    throw new Error('Wallet address is unavailable for mvc smallPay');
  }

  async _resolveMvcNetworkForAddress() {
    if (!window.metaidwallet || typeof window.metaidwallet.getNetwork !== 'function') return 'mainnet';
    try {
      var networkRes = await window.metaidwallet.getNetwork();
      var raw = networkRes && typeof networkRes === 'object'
        ? (networkRes.network || networkRes.net || '')
        : networkRes;
      var network = String(raw || '').toLowerCase();
      return network.indexOf('test') >= 0 ? 'testnet' : 'mainnet';
    } catch (_) {
      return 'mainnet';
    }
  }

  async _buildMvcSmallPayTxComposer(metaidData, lib) {
    var TxComposer = lib && lib.TxComposer ? lib.TxComposer : null;
    var mvc = lib && lib.mvc ? lib.mvc : null;
    if (!TxComposer || !mvc || typeof TxComposer !== 'function') {
      throw new Error('MetaIDJs TxComposer is unavailable');
    }

    var address = await this._resolveMvcAddress();
    var network = await this._resolveMvcNetworkForAddress();
    var addressObj;
    try {
      addressObj = new mvc.Address(address, network);
    } catch (_) {
      addressObj = new mvc.Address(address);
    }

    var txComposer = new TxComposer();
    txComposer.appendP2PKHOutput({
      address: addressObj,
      satoshis: 1,
    });
    txComposer.appendOpReturnOutput(this._buildMvcMetaidOpReturn(metaidData, lib));
    return txComposer;
  }

  async _resolveMvcBroadcastNet() {
    if (!window.metaidwallet || typeof window.metaidwallet.getNetwork !== 'function') return 'main';
    try {
      var networkRes = await window.metaidwallet.getNetwork();
      var raw = networkRes && typeof networkRes === 'object'
        ? (networkRes.network || networkRes.net || '')
        : networkRes;
      var network = String(raw || '').toLowerCase();
      return network.indexOf('test') >= 0 ? 'test' : 'main';
    } catch (_) {
      return 'main';
    }
  }

  _getMvcBroadcastUrl() {
    var cfg = window.IDConfig || {};
    var configured = String(cfg.MVC_BROADCAST_URL || cfg.METALET_BROADCAST_URL || '').trim();
    return configured || 'https://www.metalet.space/wallet-api/v3/tx/broadcast';
  }

  async _broadcastMvcRawTx(txHex, net) {
    var response = await fetch(this._getMvcBroadcastUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawTx: txHex,
        net: net,
        chain: 'mvc',
      }),
    });
    if (!response || !response.ok) {
      throw new Error('mvc broadcast HTTP ' + (response ? response.status : '0'));
    }
    var json = await response.json();
    if (!json || Number(json.code) !== 0) {
      throw new Error(json && json.message ? String(json.message) : 'mvc broadcast failed');
    }
    return this._extractTxidLike(json.data || json.result || json);
  }

  async _broadcastMvcSmallPayTransactions(payedTransactions, lib) {
    if (!Array.isArray(payedTransactions) || payedTransactions.length === 0) return [];
    var TxComposer = lib && lib.TxComposer ? lib.TxComposer : null;
    if (!TxComposer || typeof TxComposer.deserialize !== 'function') {
      throw new Error('MetaIDJs TxComposer.deserialize is unavailable');
    }

    var net = await this._resolveMvcBroadcastNet();
    var txids = [];
    for (var i = 0; i < payedTransactions.length; i += 1) {
      var txComposer = TxComposer.deserialize(payedTransactions[i]);
      if (!txComposer) continue;

      var txHex = '';
      if (typeof txComposer.getTx === 'function') {
        var txObj = txComposer.getTx();
        if (txObj && typeof txObj.toString === 'function') txHex = String(txObj.toString());
      }
      if (!txHex && typeof txComposer.getRawHex === 'function') {
        txHex = String(txComposer.getRawHex() || '');
      }
      if (!txHex) continue;

      var broadcastTxid = await this._broadcastMvcRawTx(txHex, net);
      if (!broadcastTxid && typeof txComposer.getTxId === 'function') {
        broadcastTxid = String(txComposer.getTxId() || '');
      }
      if (broadcastTxid) txids.push(broadcastTxid);
    }
    return txids;
  }

  _canUseChainInscribe(chain) {
    var wallet = window && window.metaidwallet ? window.metaidwallet : null;
    if (!wallet || !chain || !wallet[chain]) return false;
    return typeof wallet[chain].inscribe === 'function' && typeof wallet[chain].getAddress === 'function';
  }

  _errorMessage(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    if (error && error.message) return String(error.message);
    try {
      return JSON.stringify(error);
    } catch (_) {
      return String(error);
    }
  }

  _shouldFallbackToCreatePinFromInscribe(error) {
    var message = this._errorMessage(error).toLowerCase();
    if (!message) return false;
    if (message.indexOf('insufficient funds') >= 0) return true;
    if (message.indexOf('insufficient') >= 0 && message.indexOf('balance') >= 0) return true;
    if (message.indexOf('insufficient') >= 0 && message.indexOf('utxo') >= 0) return true;
    if (message.indexOf('need') >= 0 && message.indexOf('have') >= 0) return true;
    return false;
  }

  _normalizeInscribeFeeRate(chain, feeRate) {
    var numeric = Number(feeRate);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return chain === 'doge' ? 200000 : 1;
    }
    if (chain === 'btc' && numeric === 1) return 1.1;
    if (chain === 'doge') return Math.max(1, Math.round(numeric));
    return numeric;
  }

  async _createWithChainInscribe(chain, metaidData, feeRate) {
    var chainApi = window.metaidwallet[chain];
    var revealAddress = await chainApi.getAddress();
    if (!revealAddress) throw new Error('Metalet wallet address is unavailable for inscribe');

    var oneMetaidData = {
      operation: metaidData.operation,
      revealAddr: revealAddress,
      body: metaidData.body,
      path: metaidData.path,
      contentType: metaidData.contentType || 'text/plain',
      encryption: metaidData.encryption,
      flag: metaidData.flag,
      version: '1.0.0',
      encoding: metaidData.encoding || 'utf-8',
      outputs: Array.isArray(metaidData.outputs) ? metaidData.outputs : [],
    };

    var raw = await chainApi.inscribe({
      data: {
        feeRate: this._normalizeInscribeFeeRate(chain, feeRate),
        revealOutValue: chain === 'doge' ? 100000 : 546,
        metaidDataList: [oneMetaidData],
        changeAddress: revealAddress,
        outputs: Array.isArray(metaidData.outputs) ? metaidData.outputs : [],
      },
      options: { noBroadcast: false },
    });

    if (raw && typeof raw === 'object' && raw.status && String(raw.status).toLowerCase() !== 'success') {
      throw new Error(String(raw.status));
    }
    return this._normalizeInscribeResult(raw);
  }

  _extractTxidLike(value) {
    if (!value) return '';
    if (typeof value === 'string') {
      var raw = String(value).trim();
      if (!raw) return '';
      var pinMatch = raw.match(/([a-fA-F0-9]{64})i\d+$/);
      if (pinMatch && pinMatch[1]) return pinMatch[1];
      var txMatch = raw.match(/([a-fA-F0-9]{64})/);
      return txMatch && txMatch[1] ? txMatch[1] : '';
    }
    if (typeof value === 'object') {
      var direct = this._extractTxidLike(
        value.txid ||
        value.txId ||
        value.hash ||
        value.id ||
        value.pinId ||
        value.revealTxId ||
        value.revealTxid
      );
      if (direct) return direct;
      if (Array.isArray(value.txids)) {
        for (var i = 0; i < value.txids.length; i += 1) {
          var txidItem = this._extractTxidLike(value.txids[i]);
          if (txidItem) return txidItem;
        }
      }
      if (Array.isArray(value.txIDs)) {
        for (var j = 0; j < value.txIDs.length; j += 1) {
          var txidItem2 = this._extractTxidLike(value.txIDs[j]);
          if (txidItem2) return txidItem2;
        }
      }
      if (Array.isArray(value.revealTxIds)) {
        for (var k = 0; k < value.revealTxIds.length; k += 1) {
          var revealItem = this._extractTxidLike(value.revealTxIds[k]);
          if (revealItem) return revealItem;
        }
      }
      if (Array.isArray(value.res)) {
        for (var m = 0; m < value.res.length; m += 1) {
          var resItem = this._extractTxidLike(value.res[m]);
          if (resItem) return resItem;
        }
      }
    }
    return '';
  }

  _normalizeInscribeResult(raw) {
    var txids = [];
    var collectFromList = (list) => {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i += 1) {
        var candidate = this._extractTxidLike(list[i]);
        if (candidate) txids.push(candidate);
      }
    };
    if (Array.isArray(raw)) collectFromList(raw);
    if (raw && typeof raw === 'object') {
      collectFromList(raw.txids);
      collectFromList(raw.txIDs);
      collectFromList(raw.revealTxIds);
      collectFromList(raw.res);
      var direct = this._extractTxidLike(raw);
      if (direct) txids.push(direct);
    } else {
      var fromRaw = this._extractTxidLike(raw);
      if (fromRaw) txids.push(fromRaw);
    }
    var unique = Array.from(new Set(txids.filter(Boolean)));
    if (unique.length > 0) return { txids: unique };
    return raw;
  }

  _estimateFilePinFeeSats(fileHex) {
    return Math.ceil(900 + String(fileHex || '').length * 0.25);
  }

  _estimateFilePinFeeByBytes(byteLength) {
    var size = Number(byteLength || 0);
    if (!Number.isFinite(size) || size < 0) size = 0;
    return Math.ceil(900 + size * 0.5);
  }

  _estimateMessageFeeSats(body, attachmentCount) {
    var textSize = JSON.stringify(body || {}).length;
    return Math.ceil(600 + textSize * 1.2 + Number(attachmentCount || 0) * 240);
  }

  _resolveFeeRate(payload, chain) {
    var safePayload = payload && typeof payload === 'object' ? payload : {};
    var fromPayload = Number(safePayload.feeRate);
    if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;

    var normalizedChain = this._normalizeChain(chain) || this._resolveChain(safePayload);
    if (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function') {
      var chainFeeStore = Alpine.store('chainFee');
      if (chainFeeStore && typeof chainFeeStore.getSelectedFeeRate === 'function') {
        var fromStoreGetter = Number(chainFeeStore.getSelectedFeeRate(normalizedChain));
        if (Number.isFinite(fromStoreGetter) && fromStoreGetter > 0) return fromStoreGetter;
      }
      if (chainFeeStore && chainFeeStore[normalizedChain] && typeof chainFeeStore[normalizedChain] === 'object') {
        var chainState = chainFeeStore[normalizedChain];
        var selectedFeeType = String(chainState.selectedFeeType || '').trim();
        var fromStoreSelected = Number(chainState[selectedFeeType] || 0);
        if (Number.isFinite(fromStoreSelected) && fromStoreSelected > 0) return fromStoreSelected;
        var fromStoreEconomy = Number(chainState.economyFee || 0);
        if (Number.isFinite(fromStoreEconomy) && fromStoreEconomy > 0) return fromStoreEconomy;
      }
    }

    var cfg = window.IDConfig || {};
    var fromCfg = Number(cfg.FEE_RATE);
    return Number.isFinite(fromCfg) && fromCfg > 0 ? fromCfg : 1;
  }

  _resolveChain(payload) {
    var safePayload = payload && typeof payload === 'object' ? payload : {};
    var fromPayload = this._normalizeChain(safePayload.chain || safePayload.network || safePayload.blockchain);
    if (fromPayload) return fromPayload;

    if (typeof Alpine !== 'undefined' && Alpine && typeof Alpine.store === 'function') {
      var chainFeeStore = Alpine.store('chainFee');
      var fromStore = this._normalizeChain(chainFeeStore && chainFeeStore.currentChain ? chainFeeStore.currentChain : '');
      if (fromStore) return fromStore;
    }

    var cfg = window.IDConfig || {};
    var fromCfg = this._normalizeChain(cfg.CHAT_CHAIN || cfg.CHAIN || cfg.DEFAULT_CHAIN);
    return fromCfg || 'mvc';
  }

  _normalizeChain(rawChain) {
    var chain = String(rawChain || '').trim().toLowerCase();
    if (chain === 'btc' || chain === 'bsv') return 'btc';
    if (chain === 'doge' || chain === 'dogecoin') return 'doge';
    if (chain === 'mvc' || chain === 'microvisionchain') return 'mvc';
    return '';
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
    var extracted = this._extractTxidLike(res);
    if (extracted) return extracted;
    if (Array.isArray(res.revealTxIds) && res.revealTxIds[0]) {
      var revealTxid = this._extractTxidLike(res.revealTxIds[0]);
      if (revealTxid) return revealTxid;
    }
    if (res.data) {
      var nested = this._extractTxidLike(res.data);
      if (nested) return nested;
      if (Array.isArray(res.data.revealTxIds) && res.data.revealTxIds[0]) {
        var nestedReveal = this._extractTxidLike(res.data.revealTxIds[0]);
        if (nestedReveal) return nestedReveal;
      }
    }
    return '';
  }
}
