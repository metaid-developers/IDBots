/**
 * PostBuzzCommand - Create buzz with optional local attachments.
 *
 * Flow:
 * 1) Upload each local file through MetaFS uploader.
 *    - >5MB: runChunkedUploadFlow({ asynchronous:false })
 *    - <=5MB: uploadFileToChainDirect(file)
 * 2) Convert txid -> pinid (txid + i0) and build metafile:// URIs.
 * 3) Create simplebuzz pin via IDFramework.BuiltInCommands.createPin.
 */
export default class PostBuzzCommand {
  async execute({ payload = {}, stores }) {
    if (!window.IDFramework || !window.IDFramework.BuiltInCommands || !window.IDFramework.BuiltInCommands.createPin) {
      throw new Error('IDFramework.BuiltInCommands.createPin is not available');
    }
    this._ensureOnchainReady(stores);

    var content = typeof payload.content === 'string' ? payload.content : '';
    var quotePin = typeof payload.quotePin === 'string' ? payload.quotePin : '';
    var files = Array.isArray(payload.files) ? payload.files : [];

    if (!content.trim() && files.length === 0) {
      throw new Error('Please enter content or add attachment');
    }

    var attachments = [];
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      var attachment = await this._uploadFileToMetafile(file, stores);
      attachments.push(attachment);
    }

    var body = {
      content: content,
      contentType: 'text/plain;utf-8',
      attachments: attachments,
      quotePin: quotePin || '',
    };

    var pinRes = await window.IDFramework.BuiltInCommands.createPin({
      payload: {
        operation: 'create',
        body: JSON.stringify(body),
        path: '/protocols/simplebuzz',
        contentType: 'application/json',
      },
      stores: stores,
    });

    return {
      body: body,
      pinRes: pinRes,
      txid: this._extractTxid(pinRes),
    };
  }

  async _uploadFileToMetafile(file, stores) {
    this._ensureOnchainReady(stores);
    if (!(file instanceof File)) {
      throw new Error('Invalid file object');
    }

    var result;
    if (file.size > 5 * 1024 * 1024) {
      result = await this.runChunkedUploadFlow({ file: file, asynchronous: false });
    } else {
      result = await this.uploadFileToChainDirect(file);
    }

    var txid = this._extractUploadTxid(result);
    if (!txid) {
      throw new Error('File upload succeeded but txid is missing');
    }

    return 'metafile://' + txid + 'i0';
  }

  async runChunkedUploadFlow(options) {
    this._ensureOnchainReady();
    var file = options && options.file;
    var asynchronous = options && typeof options.asynchronous === 'boolean' ? options.asynchronous : true;
    if (!(file instanceof File)) throw new Error('runChunkedUploadFlow: file is required');

    var storageKey = await this._uploadFileToOSS(file);
    var estimateResult = await this._estimateChunkedUploadFee(file, storageKey);

    var feeRate = this._getFeeRate();
    var chunkPreTxBuildFee = Math.ceil((200 + 150) * feeRate);
    var indexPreTxBuildFee = Math.ceil((200 + 150) * feeRate);
    var chunkPreTxOutputAmount = Number(estimateResult.chunkPreTxFee || 0) + chunkPreTxBuildFee;
    var indexPreTxOutputAmount = Number(estimateResult.indexPreTxFee || 0) + indexPreTxBuildFee;
    var mergeTxFee = Math.ceil((200 + 150 * 2 + 34 * 2) * feeRate);
    var totalRequiredAmount = chunkPreTxOutputAmount + indexPreTxOutputAmount + mergeTxFee;

    var allUtxos = await this._getWalletUTXOs(totalRequiredAmount);
    var mergeResult = await this._buildChunkedUploadMergeTx(
      allUtxos,
      chunkPreTxOutputAmount,
      indexPreTxOutputAmount,
      mergeTxFee
    );

    var chunkPreTxHex = await this._buildPreTxFromSingleUtxo({
      txId: mergeResult.mergeTxId,
      outputIndex: mergeResult.chunkPreTxOutputIndex,
      script: mergeResult.chunkPreTxScript,
      satoshis: chunkPreTxOutputAmount,
    });

    var indexPreTxHex = await this._buildPreTxFromSingleUtxo({
      txId: mergeResult.mergeTxId,
      outputIndex: mergeResult.indexPreTxOutputIndex,
      script: mergeResult.indexPreTxScript,
      satoshis: indexPreTxOutputAmount,
    });

    if (asynchronous) {
      await this._createChunkedUploadTask(file, storageKey, chunkPreTxHex, indexPreTxHex, mergeResult.mergeTxHex);
      return null;
    }

    var uploadResult = await this._chunkedUpload(file, storageKey, chunkPreTxHex, indexPreTxHex, mergeResult.mergeTxHex);
    if (uploadResult && uploadResult.status && uploadResult.status !== 'success') {
      throw new Error(uploadResult.message || 'chunked upload failed');
    }

    return {
      txId: uploadResult && uploadResult.indexTxId ? uploadResult.indexTxId : '',
      pinId: uploadResult && uploadResult.indexTxId ? (uploadResult.indexTxId + 'i0') : '',
      status: uploadResult && uploadResult.status ? uploadResult.status : 'success',
    };
  }

  async uploadFileToChainDirect(file) {
    this._ensureOnchainReady();
    if (!(file instanceof File)) throw new Error('uploadFileToChainDirect: file is required');

    var estimatedFee = await this._estimateUploadFee(file);
    var utxos = await this._getWalletUTXOs(estimatedFee);
    var finalUtxoData = utxos;
    var mergeTxHex = '';

    if (utxos.utxos.length > 1) {
      var merge = await this._mergeUTXOs(utxos, estimatedFee);
      finalUtxoData = { utxos: merge.utxos, totalAmount: merge.totalAmount };
      mergeTxHex = merge.mergeTxHex || '';
    }

    var preTxHex = await this._buildAndSignBaseTx(finalUtxoData);
    var result = await this._directUpload(file, preTxHex, finalUtxoData.totalAmount, mergeTxHex);
    return result;
  }

  async _loadMetaIdJS() {
    if (this._metaIdJSLib) return this._metaIdJSLib;
    for (var i = 0; i < 100; i += 1) {
      if (typeof window !== 'undefined' && window.MetaIDJs) {
        this._metaIdJSLib = window.MetaIDJs;
        return this._metaIdJSLib;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    throw new Error('MetaIDJs is not available, please include ./metaid.js in index.html');
  }

  _getUploadBase() {
    var cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
    var fromCfg = (cfg.METAFS_UPLOAD_URL || '').trim();
    if (fromCfg) return fromCfg.replace(/\/+$/, '');
    return 'https://file.metaid.io/metafile-uploader';
  }

  _getFeeRate() {
    var cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
    var rate = Number(cfg.FEE_RATE);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
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

  _getAddress() {
    if (typeof Alpine !== 'undefined' && Alpine.store('wallet') && Alpine.store('wallet').address) {
      return Alpine.store('wallet').address;
    }
    return '';
  }

  async _getMetaId() {
    if (typeof Alpine !== 'undefined' && Alpine.store('user') && Alpine.store('user').user && Alpine.store('user').user.metaid) {
      return Alpine.store('user').user.metaid;
    }
    if (typeof Alpine !== 'undefined' && Alpine.store('wallet') && Alpine.store('wallet').globalMetaId) {
      return Alpine.store('wallet').globalMetaId;
    }
    if (window.metaidwallet && window.metaidwallet.getMetaId) {
      try { return await window.metaidwallet.getMetaId(); } catch (e) {}
    }
    return '';
  }

  _isTextType(contentType) {
    return (
      contentType.indexOf('text/') === 0 ||
      contentType === 'application/json' ||
      contentType === 'application/javascript' ||
      contentType === 'application/xml'
    );
  }

  _buildContentType(file) {
    var contentType = (file && file.type) ? file.type : 'application/octet-stream';
    if (!this._isTextType(contentType) && contentType.indexOf(';binary') < 0) {
      contentType += ';binary';
    }
    return contentType;
  }

  _fileToBase64(file) {
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

  _toHexBytes(hex, lib) {
    var clean = String(hex || '').replace(/^0x/, '');
    var BufferCtor = lib && lib.mvc && lib.mvc.deps && lib.mvc.deps.Buffer
      ? lib.mvc.deps.Buffer
      : (typeof Buffer !== 'undefined' ? Buffer : null);
    if (BufferCtor && typeof BufferCtor.from === 'function') {
      return BufferCtor.from(clean, 'hex');
    }

    var arr = new Uint8Array(Math.floor(clean.length / 2));
    for (var i = 0; i < arr.length; i += 1) {
      arr[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return arr;
  }

  async _getWalletUTXOs(requiredAmount) {
    var utxos = await window.metaidwallet.getUtxos();
    if (!Array.isArray(utxos) || utxos.length === 0) throw new Error('No available UTXOs in wallet');
    var lib = await this._loadMetaIdJS();
    var mvc = lib.mvc;
    var filtered = utxos.filter(function (u) { return Number(u.value) > 600; }).sort(function (a, b) { return Number(b.value) - Number(a.value); });
    if (filtered.length === 0) throw new Error('No UTXOs larger than 600 satoshis');

    var picked = [];
    var total = 0;
    for (var i = 0; i < filtered.length; i += 1) {
      var u = filtered[i];
      picked.push({
        txId: u.txid,
        outputIndex: u.outIndex,
        script: mvc.Script.buildPublicKeyHashOut(u.address).toHex(),
        satoshis: Number(u.value),
      });
      total += Number(u.value);
      if (total >= requiredAmount + 1) break;
    }
    if (total < requiredAmount + 1) throw new Error('Insufficient wallet balance');
    return { utxos: picked, totalAmount: total };
  }

  async _mergeUTXOs(utxoData, estimatedFee) {
    var lib = await this._loadMetaIdJS();
    var TxComposer = lib.TxComposer;
    var mvc = lib.mvc;
    var address = this._getAddress();
    var feeRate = this._getFeeRate();

    var mergeTx = new mvc.Transaction();
    mergeTx.version = 10;
    mergeTx.to(address, estimatedFee);

    var txComposer = new TxComposer(mergeTx);
    var payResult = await window.metaidwallet.pay({
      transactions: [{ txComposer: txComposer.serialize(), message: 'Merge UTXOs' }],
      feeb: feeRate,
    });

    var payed = TxComposer.deserialize(payResult.payedTransactions[0]);
    var rawHex = payed.getRawHex();
    var mergeTxId = payed.getTxId();
    var parsed = new mvc.Transaction(rawHex);
    var outIndex = 0;
    var outAmount = parsed.outputs[0].satoshis;
    for (var i = 0; i < parsed.outputs.length; i += 1) {
      if (Math.abs(parsed.outputs[i].satoshis - estimatedFee) <= 1000) {
        outIndex = i;
        outAmount = parsed.outputs[i].satoshis;
        break;
      }
    }

    return {
      utxos: [{
        txId: mergeTxId,
        outputIndex: outIndex,
        script: parsed.outputs[outIndex].script.toHex(),
        satoshis: outAmount,
      }],
      totalAmount: outAmount,
      mergeTxId: mergeTxId,
      mergeTxHex: rawHex,
    };
  }

  async _buildAndSignBaseTx(utxoData) {
    if (!utxoData || !Array.isArray(utxoData.utxos) || utxoData.utxos.length !== 1) {
      throw new Error('SIGHASH_SINGLE requires exactly 1 UTXO');
    }
    var lib = await this._loadMetaIdJS();
    var mvc = lib.mvc;
    var utxo = utxoData.utxos[0];
    var address = this._getAddress();

    var tx = new mvc.Transaction();
    tx.version = 10;
    tx.from({
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      script: utxo.script,
      satoshis: utxo.satoshis,
    });
    tx.to(address, 1);

    var signResult = await window.metaidwallet.signTransaction({
      transaction: {
        txHex: tx.toString(),
        address: address,
        inputIndex: 0,
        scriptHex: utxo.script,
        satoshis: utxo.satoshis,
        sigtype: 0x3 | 0x80 | 0x40,
      },
    });

    var sig = signResult.signature.sig;
    var pub = signResult.signature.publicKey;
    var unlocking = mvc.Script.buildPublicKeyHashIn(
      pub,
      mvc.crypto.Signature.fromTxFormat(this._toHexBytes(sig, lib)).toDER(),
      0x3 | 0x80 | 0x40
    );
    tx.inputs[0].setScript(unlocking);
    return tx.toString();
  }

  async _directUpload(file, preTxHex, totalInputAmount, mergeTxHex) {
    var uploadBase = this._getUploadBase();
    var address = this._getAddress();
    var metaId = await this._getMetaId();
    var formData = new FormData();
    formData.append('file', file);
    formData.append('path', '/file/' + this._sanitizePathName(file.name));
    if (mergeTxHex) formData.append('mergeTxHex', mergeTxHex);
    formData.append('preTxHex', preTxHex);
    formData.append('operation', 'create');
    formData.append('contentType', this._buildContentType(file));
    formData.append('metaId', metaId);
    formData.append('address', address);
    formData.append('changeAddress', address);
    formData.append('feeRate', String(this._getFeeRate()));
    formData.append('totalInputAmount', String(totalInputAmount));

    var response = await fetch(uploadBase + '/api/v1/files/direct-upload', {
      method: 'POST',
      body: formData,
      mode: 'cors',
    });
    if (!response.ok) throw new Error('direct-upload HTTP ' + response.status);
    var result = await response.json();
    if (result.code !== 0) throw new Error(result.message || 'direct upload failed');
    return result.data || {};
  }

  async _estimateUploadFee(file) {
    var baseSize = 200;
    var inputSize = 150;
    var outputSize = 34;
    var opReturnOverhead = 50;
    var path = '/file/' + this._sanitizePathName(file.name || '');
    var metadataSize = 6 + 10 + path.length + 10 + 10 + 50;
    var opReturnSize = opReturnOverhead + metadataSize + Number(file.size || 0);
    var estimatedTxSize = baseSize + inputSize + outputSize * 2 + opReturnSize;
    return Math.ceil(estimatedTxSize * this._getFeeRate() * 1.2);
  }

  async _uploadFileToOSS(file) {
    var uploadBase = this._getUploadBase();
    var metaId = await this._getMetaId();
    var address = this._getAddress();

    var initiate = await fetch(uploadBase + '/api/v1/files/multipart/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        metaId: metaId,
        address: address,
      }),
    });
    if (!initiate.ok) throw new Error('multipart initiate HTTP ' + initiate.status);
    var initiateJson = await initiate.json();
    if (initiateJson.code !== 0) throw new Error(initiateJson.message || 'multipart initiate failed');
    var uploadId = initiateJson.data.uploadId;
    var key = initiateJson.data.key;

    var chunkSize = 1024 * 1024;
    var totalParts = Math.ceil(file.size / chunkSize);
    var parts = [];
    for (var partNumber = 1; partNumber <= totalParts; partNumber += 1) {
      var start = (partNumber - 1) * chunkSize;
      var end = Math.min(start + chunkSize, file.size);
      var chunk = file.slice(start, end);
      var content = await this._fileToBase64(chunk);

      var uploadPart = await fetch(uploadBase + '/api/v1/files/multipart/upload-part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId: uploadId,
          key: key,
          partNumber: partNumber,
          content: content,
        }),
      });
      if (!uploadPart.ok) throw new Error('multipart upload-part HTTP ' + uploadPart.status);
      var uploadPartJson = await uploadPart.json();
      if (uploadPartJson.code !== 0) throw new Error(uploadPartJson.message || 'multipart upload-part failed');
      parts.push({
        partNumber: partNumber,
        etag: uploadPartJson.data.etag,
        size: end - start,
      });
    }

    var complete = await fetch(uploadBase + '/api/v1/files/multipart/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: uploadId,
        key: key,
        parts: parts.sort(function (a, b) { return a.partNumber - b.partNumber; }),
      }),
    });
    if (!complete.ok) throw new Error('multipart complete HTTP ' + complete.status);
    var completeJson = await complete.json();
    if (completeJson.code !== 0) throw new Error(completeJson.message || 'multipart complete failed');
    return completeJson.data.key;
  }

  async _estimateChunkedUploadFee(file, storageKey) {
    var uploadBase = this._getUploadBase();
    var response = await fetch(uploadBase + '/api/v1/files/estimate-chunked-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        path: '/file/' + this._sanitizePathName(file.name),
        contentType: this._buildContentType(file),
        feeRate: this._getFeeRate(),
        storageKey: storageKey,
      }),
      mode: 'cors',
    });
    if (!response.ok) throw new Error('estimate-chunked-upload HTTP ' + response.status);
    var json = await response.json();
    if (json.code !== 0) throw new Error(json.message || 'estimate chunked fee failed');
    return json.data || {};
  }

  async _buildChunkedUploadMergeTx(utxoData, chunkPreTxOutputAmount, indexPreTxOutputAmount) {
    var lib = await this._loadMetaIdJS();
    var TxComposer = lib.TxComposer;
    var mvc = lib.mvc;
    var address = this._getAddress();
    var feeRate = this._getFeeRate();

    var mergeTx = new mvc.Transaction();
    mergeTx.version = 10;
    for (var i = 0; i < utxoData.utxos.length; i += 1) {
      var u = utxoData.utxos[i];
      mergeTx.from({
        txId: u.txId,
        outputIndex: u.outputIndex,
        script: u.script,
        satoshis: u.satoshis,
      });
    }
    mergeTx.to(address, chunkPreTxOutputAmount);
    mergeTx.to(address, indexPreTxOutputAmount);

    var txComposer = new TxComposer(mergeTx);
    var payResult = await window.metaidwallet.pay({
      transactions: [{ txComposer: txComposer.serialize(), message: 'Merge UTXOs for chunked upload' }],
      feeb: feeRate,
    });
    var payed = TxComposer.deserialize(payResult.payedTransactions[0]);
    var mergeTxHex = payed.getRawHex();
    var mergeTxId = payed.getTxId();
    var parsed = new mvc.Transaction(mergeTxHex);

    var chunkPreTxOutputIndex = 0;
    var indexPreTxOutputIndex = 1;
    var chunkPreTxScript = parsed.outputs[0].script.toHex();
    var indexPreTxScript = parsed.outputs[1].script.toHex();
    for (var j = 0; j < parsed.outputs.length; j += 1) {
      var sat = parsed.outputs[j].satoshis;
      if (Math.abs(sat - chunkPreTxOutputAmount) <= 1000) {
        chunkPreTxOutputIndex = j;
        chunkPreTxScript = parsed.outputs[j].script.toHex();
      } else if (Math.abs(sat - indexPreTxOutputAmount) <= 1000) {
        indexPreTxOutputIndex = j;
        indexPreTxScript = parsed.outputs[j].script.toHex();
      }
    }

    return {
      mergeTxId: mergeTxId,
      mergeTxHex: mergeTxHex,
      chunkPreTxOutputIndex: chunkPreTxOutputIndex,
      indexPreTxOutputIndex: indexPreTxOutputIndex,
      chunkPreTxScript: chunkPreTxScript,
      indexPreTxScript: indexPreTxScript,
    };
  }

  async _buildPreTxFromSingleUtxo(utxo) {
    var lib = await this._loadMetaIdJS();
    var mvc = lib.mvc;
    var address = this._getAddress();

    var tx = new mvc.Transaction();
    tx.version = 10;
    tx.from({
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      script: utxo.script,
      satoshis: utxo.satoshis,
    });

    var signResult = await window.metaidwallet.signTransaction({
      transaction: {
        txHex: tx.toString(),
        address: address,
        inputIndex: 0,
        scriptHex: utxo.script,
        satoshis: utxo.satoshis,
        sigtype: 0x2 | 0x40,
      },
    });
    var sig = signResult.signature.sig;
    var pub = signResult.signature.publicKey;
    var unlocking = mvc.Script.buildPublicKeyHashIn(
      pub,
      mvc.crypto.Signature.fromTxFormat(this._toHexBytes(sig, lib)).toDER(),
      0x2 | 0x40
    );
    tx.inputs[0].setScript(unlocking);
    return tx.toString();
  }

  async _chunkedUpload(file, storageKey, chunkPreTxHex, indexPreTxHex, mergeTxHex) {
    var uploadBase = this._getUploadBase();
    var metaId = await this._getMetaId();
    var address = this._getAddress();
    var response = await fetch(uploadBase + '/api/v1/files/chunked-upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metaId: metaId,
        address: address,
        fileName: file.name,
        path: '/file/' + this._sanitizePathName(file.name),
        operation: 'create',
        contentType: this._buildContentType(file),
        chunkPreTxHex: chunkPreTxHex,
        indexPreTxHex: indexPreTxHex,
        mergeTxHex: mergeTxHex,
        feeRate: this._getFeeRate(),
        isBroadcast: true,
        storageKey: storageKey,
      }),
    });
    if (!response.ok) throw new Error('chunked-upload HTTP ' + response.status);
    var json = await response.json();
    if (json.code !== 0) throw new Error(json.message || 'chunked upload failed');
    if (json.data && json.data.status && json.data.status !== 'success') {
      throw new Error(json.data.message || 'chunked upload failed');
    }
    return json.data || {};
  }

  async _createChunkedUploadTask(file, storageKey, chunkPreTxHex, indexPreTxHex, mergeTxHex) {
    var uploadBase = this._getUploadBase();
    var metaId = await this._getMetaId();
    var address = this._getAddress();
    var response = await fetch(uploadBase + '/api/v1/files/chunked-upload-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metaId: metaId,
        address: address,
        fileName: file.name,
        path: '/file/' + this._sanitizePathName(file.name),
        operation: 'create',
        contentType: this._buildContentType(file),
        chunkPreTxHex: chunkPreTxHex,
        indexPreTxHex: indexPreTxHex,
        mergeTxHex: mergeTxHex,
        feeRate: this._getFeeRate(),
        storageKey: storageKey,
      }),
    });
    if (!response.ok) throw new Error('chunked-upload-task HTTP ' + response.status);
    var json = await response.json();
    if (json.code !== 0) throw new Error(json.message || 'chunked task failed');
    return json.data || {};
  }

  _sanitizePathName(name) {
    return String(name || 'file').replace(/[^\w.-]/g, '_');
  }

  _extractUploadTxid(result) {
    if (!result) return '';
    if (result.txId) return String(result.txId);
    if (result.indexTxId) return String(result.indexTxId);
    if (result.txid) return String(result.txid);
    return '';
  }

  _extractTxid(res) {
    if (!res) return '';

    if (Array.isArray(res.txids) && res.txids[0]) return String(res.txids[0]);
    if (Array.isArray(res.revealTxIds) && res.revealTxIds[0]) return String(res.revealTxIds[0]);
    if (res.txid) return String(res.txid);

    if (res.data) {
      if (Array.isArray(res.data.txids) && res.data.txids[0]) return String(res.data.txids[0]);
      if (Array.isArray(res.data.revealTxIds) && res.data.revealTxIds[0]) return String(res.data.revealTxIds[0]);
      if (res.data.txid) return String(res.data.txid);
    }

    return '';
  }
}
