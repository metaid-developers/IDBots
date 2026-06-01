export default class MetafileUploadHelper {
  constructor(dependencies = {}) {
    this._deps = dependencies && typeof dependencies === 'object' ? dependencies : {};
  }

  async uploadFileToMetafile(file, stores, options = {}) {
    this._ensureOnchainReady(stores);
    if (!(file instanceof File)) {
      throw new Error('Invalid file object');
    }
    var chain = this._resolveChain(options);
    if (chain !== 'mvc') {
      return await this._uploadFileByCreatePinWithFallback(file, stores, options);
    }

    try {
      var directUpload = this._getDependency('uploadFileToChainDirect');
      var chunkedUpload = this._getDependency('runChunkedUploadFlow');
      var result;

      if (file.size > 5 * 1024 * 1024) {
        if (typeof chunkedUpload !== 'function') {
          return await this._uploadFileByCreatePinWithFallback(file, stores, options);
        }
        result = await chunkedUpload({ file: file, asynchronous: false });
      } else {
        if (typeof directUpload !== 'function') {
          return await this._uploadFileByCreatePinWithFallback(file, stores, options);
        }
        result = await directUpload(file);
      }

      var txid = this._extractUploadTxid(result);
      if (!txid) {
        throw new Error('File upload succeeded but txid is missing');
      }

      return this._buildMetafileUri(txid, file);
    } catch (error) {
      if (!this._shouldFallbackToCreatePin(error)) throw error;
      return await this._uploadFileByCreatePinWithFallback(file, stores, options);
    }
  }

  async uploadFileByCreatePin(file, stores, options = {}) {
    this._ensureOnchainReady(stores);
    if (!(file instanceof File)) throw new Error('upload fallback requires a file');
    var chain = this._resolveChain(options);
    var feeRate = this._getFeeRate({ chain: chain, feeRate: options.feeRate });

    var base64Body = await this._fileToBase64(file);
    var createPayload = {
      operation: 'create',
      body: base64Body,
      path: '/file/' + this._sanitizePathName(file.name),
      encoding: 'base64',
      contentType: this._buildContentType(file),
      chain: chain,
      feeRate: feeRate,
    };
    var createRes;
    if (
      window.IDFramework &&
      window.IDFramework.BuiltInCommands &&
      typeof window.IDFramework.BuiltInCommands.createPin === 'function'
    ) {
      createRes = await window.IDFramework.BuiltInCommands.createPin({
        payload: createPayload,
        stores: stores,
      });
    } else {
      if (!window.metaidwallet || typeof window.metaidwallet.createPin !== 'function') {
        throw new Error('Wallet createPin is not available for upload fallback');
      }
      createRes = await window.metaidwallet.createPin({
        chain: chain,
        feeRate: feeRate,
        dataList: [{
          metaidData: {
            operation: createPayload.operation,
            body: createPayload.body,
            path: createPayload.path,
            encoding: createPayload.encoding,
            contentType: createPayload.contentType,
          },
        }],
      });
    }

    var txid = this._extractTxid(createRes);
    if (!txid) throw new Error('fallback upload succeeded but txid is missing');
    return this._buildMetafileUri(txid, file);
  }

  _getDependency(name) {
    var deps = this._deps && typeof this._deps === 'object' ? this._deps : {};
    var fn = deps[name];
    return typeof fn === 'function' ? fn : null;
  }

  async _uploadFileByCreatePinWithFallback(file, stores, options = {}) {
    var fallback = this._getDependency('uploadFileByCreatePin');
    if (typeof fallback === 'function') {
      return await fallback(file, stores, options);
    }
    return await this.uploadFileByCreatePin(file, stores, options);
  }

  _ensureOnchainReady(stores) {
    var ensure = this._getDependency('ensureOnchainReady');
    if (typeof ensure === 'function') ensure(stores);
  }

  _normalizeChain(rawChain) {
    var chain = String(rawChain || '').trim().toLowerCase();
    if (chain === 'btc' || chain === 'bsv') return 'btc';
    if (chain === 'doge' || chain === 'dogecoin') return 'doge';
    if (chain === 'mvc' || chain === 'microvisionchain') return 'mvc';
    return '';
  }

  _resolveChain(source) {
    var resolve = this._getDependency('resolveChain');
    if (typeof resolve === 'function') {
      var fromResolve = this._normalizeChain(resolve(source));
      if (fromResolve) return fromResolve;
    }

    var fromSource = this._normalizeChain(source && source.chain ? source.chain : '');
    if (fromSource) return fromSource;
    return 'mvc';
  }

  _getFeeRate(options = {}) {
    var getFeeRate = this._getDependency('getFeeRate');
    if (typeof getFeeRate === 'function') {
      var fromDependency = Number(getFeeRate(options));
      if (Number.isFinite(fromDependency) && fromDependency > 0) return fromDependency;
    }

    var fromPayload = Number(options && options.feeRate);
    if (Number.isFinite(fromPayload) && fromPayload > 0) return fromPayload;
    return 1;
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

  _shouldFallbackToCreatePin(error) {
    if (typeof window === 'undefined' || !window.metaidwallet || typeof window.metaidwallet.createPin !== 'function') {
      return false;
    }
    var message = this._errorMessage(error).toLowerCase();
    if (!message) return false;
    return (
      message.indexOf('error 1290') >= 0 ||
      message.indexOf('lock_write') >= 0 ||
      message.indexOf('failed to save upload record') >= 0 ||
      message.indexOf('failed to create file metadata') >= 0
    );
  }

  _fileExtensionSuffix(fileName) {
    var name = String(fileName || '').trim();
    if (!name) return '';
    var match = name.match(/\.([a-zA-Z0-9]{1,16})$/);
    if (!match || !match[1]) return '';
    return '.' + String(match[1]).toLowerCase();
  }

  _buildMetafileUri(txid, file) {
    var id = String(txid || '').trim();
    if (!id) return '';
    if (!/i\d+$/i.test(id)) id += 'i0';
    return 'metafile://' + id + this._fileExtensionSuffix(file && file.name ? file.name : '');
  }

  _sanitizePathName(name) {
    var sanitize = this._getDependency('sanitizePathName');
    if (typeof sanitize === 'function') {
      var fromDependency = String(sanitize(name) || '').trim();
      if (fromDependency) return fromDependency;
    }
    return String(name || 'file').replace(/[^\w.-]/g, '_');
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
    var builder = this._getDependency('buildContentType');
    if (typeof builder === 'function') {
      var fromDependency = String(builder(file) || '').trim();
      if (fromDependency) return fromDependency;
    }

    var contentType = (file && file.type) ? file.type : 'application/octet-stream';
    if (!this._isTextType(contentType) && contentType.indexOf(';binary') < 0) {
      contentType += ';binary';
    }
    return contentType;
  }

  _fileToBase64(file) {
    var fileToBase64 = this._getDependency('fileToBase64');
    if (typeof fileToBase64 === 'function') return fileToBase64(file);

    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var value = typeof fr.result === 'string' ? fr.result : '';
        var idx = value.indexOf(',');
        resolve(idx >= 0 ? value.slice(idx + 1) : value);
      };
      fr.onerror = function () { reject(new Error('Failed to read file')); };
      fr.readAsDataURL(file);
    });
  }

  _extractUploadTxid(result) {
    var extractUploadTxid = this._getDependency('extractUploadTxid');
    if (typeof extractUploadTxid === 'function') {
      var fromDependency = String(extractUploadTxid(result) || '').trim();
      if (fromDependency) return fromDependency;
    }

    if (!result) return '';
    if (result.txId) return String(result.txId);
    if (result.indexTxId) return String(result.indexTxId);
    if (result.txid) return String(result.txid);
    return '';
  }

  _extractTxid(res) {
    var extractTxid = this._getDependency('extractTxid');
    if (typeof extractTxid === 'function') {
      var fromDependency = String(extractTxid(res) || '').trim();
      if (fromDependency) return fromDependency;
    }

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
