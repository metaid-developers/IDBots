/**
 * id-attachments - Attachment processor component
 * - Processor layer: parse metafile://pinid and resolve file metadata
 * - UI layer: render file cards by detected file kind
 */
class AttachmentsProcessor {
  constructor() {
    this._metaInfoCache = new Map();
    this._contentCache = new Map();
    this._dbPromise = null;
  }

  extractPinId(item) {
    if (!item) return '';
    if (typeof item === 'string') {
      return this._normalizePinId(item);
    }
    if (typeof item === 'object') {
      if (item.pinid) return this._normalizePinId(String(item.pinid));
      if (item.pinId) return this._normalizePinId(String(item.pinId));
      if (item.url) return this._normalizePinId(String(item.url));
    }
    return '';
  }

  _normalizePinId(value) {
    if (!value) return '';
    var raw = String(value).trim();
    if (!raw) return '';
    if (raw.indexOf('metafile://') === 0) {
      raw = raw.slice('metafile://'.length);
    }
    raw = raw.split('?')[0].split('#')[0].trim();
    // Remove a trailing extension suffix, e.g. "...i0.jpg" -> "...i0"
    raw = raw.replace(/\.[a-zA-Z0-9]{1,10}$/i, '');
    return raw;
  }

  _getMetafsBase() {
    var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
    var fromLocator = serviceLocator.metafs || '';
    if (fromLocator) return fromLocator.replace(/\/+$/, '');
    var cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
    return (cfg.METAFS_BASE_URL || 'https://file.metaid.io/metafile-indexer/api').replace(/\/+$/, '');
  }

  async _initDB() {
    if (typeof indexedDB === 'undefined') return null;
    if (this._dbPromise) return this._dbPromise;

    this._dbPromise = new Promise((resolve) => {
      var request = indexedDB.open('idframework-attachments-db', 1);
      request.onerror = function () {
        resolve(null);
      };
      request.onsuccess = function () {
        resolve(request.result);
      };
      request.onupgradeneeded = function (event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains('AttachmentMetaInfo')) {
          db.createObjectStore('AttachmentMetaInfo', { keyPath: 'pinid' });
        }
        if (!db.objectStoreNames.contains('AttachmentContent')) {
          db.createObjectStore('AttachmentContent', { keyPath: 'pinid' });
        }
      };
    });
    return this._dbPromise;
  }

  async _idbGet(storeName, key) {
    try {
      var db = await this._initDB();
      if (!db) return null;
      return await new Promise(function (resolve) {
        var tx = db.transaction([storeName], 'readonly');
        var store = tx.objectStore(storeName);
        var request = store.get(key);
        request.onsuccess = function () {
          resolve(request.result || null);
        };
        request.onerror = function () {
          resolve(null);
        };
      });
    } catch (error) {
      return null;
    }
  }

  async _idbPut(storeName, value) {
    try {
      var db = await this._initDB();
      if (!db) return;
      await new Promise(function (resolve) {
        var tx = db.transaction([storeName], 'readwrite');
        var store = tx.objectStore(storeName);
        var request = store.put(value);
        request.onsuccess = function () {
          resolve();
        };
        request.onerror = function () {
          resolve();
        };
      });
    } catch (error) {
      // Ignore cache write errors.
    }
  }

  async getMetaFileInfo(pinid) {
    if (!pinid) throw new Error('pinid is required');
    if (this._metaInfoCache.has(pinid)) return this._metaInfoCache.get(pinid);

    var cached = await this._idbGet('AttachmentMetaInfo', pinid);
    if (cached && cached.metaInfo) {
      this._metaInfoCache.set(pinid, cached.metaInfo);
      return cached.metaInfo;
    }

    var url = this._getMetafsBase() + '/v1/files/' + encodeURIComponent(pinid);
    var response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error('Failed to fetch meta file info');
    }
    var json = await response.json();
    var payload = json;
    if (json && typeof json.code === 'number') payload = json.data || {};
    if (json && json.data && typeof json.data === 'object' && !json.code) payload = json.data;
    this._metaInfoCache.set(pinid, payload);
    this._idbPut('AttachmentMetaInfo', {
      pinid: pinid,
      metaInfo: payload,
      updatedAt: Date.now(),
    });
    return payload;
  }

  async getMetaFileContent(pinid) {
    if (!pinid) return '';
    if (this._contentCache.has(pinid)) return this._contentCache.get(pinid);

    var cached = await this._idbGet('AttachmentContent', pinid);
    if (cached && cached.contentUrl) {
      this._contentCache.set(pinid, cached.contentUrl);
      return cached.contentUrl;
    }

    var contentUrl = this._getMetafsBase() + '/v1/files/content/' + encodeURIComponent(pinid);
    this._contentCache.set(pinid, contentUrl);
    this._idbPut('AttachmentContent', {
      pinid: pinid,
      contentUrl: contentUrl,
      updatedAt: Date.now(),
    });
    return contentUrl;
  }

  resolveFileKind(metaInfo) {
    var fileType = String((metaInfo && metaInfo.file_type) || '').toLowerCase();
    var ext = String((metaInfo && metaInfo.file_extension) || '').toLowerCase().replace('.', '');

    var imageExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'];
    var videoExt = ['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv', 'flv'];
    var audioExt = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'];
    var officeExt = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'];
    var archiveExt = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
    var textExt = ['md', 'markdown', 'txt', 'json', 'log', 'yaml', 'yml'];

    if (fileType === 'image' || imageExt.includes(ext)) return 'image';
    if (fileType === 'video' || videoExt.includes(ext)) return 'video';
    if (fileType === 'audio' || audioExt.includes(ext)) return 'audio';
    if (fileType === 'pdf' || ext === 'pdf') return 'pdf';
    if (officeExt.includes(ext)) return 'office';
    if (archiveExt.includes(ext)) return 'archive';
    if (textExt.includes(ext)) return 'text';
    return 'unknown';
  }

  getDisplayName(metaInfo, pinid) {
    var fileName = String((metaInfo && metaInfo.file_name) || '').trim();
    var ext = String((metaInfo && metaInfo.file_extension) || '').replace('.', '').trim();
    if (!fileName && !ext) return pinid || 'unknown-file';
    if (!ext) return fileName;
    if (fileName.toLowerCase().endsWith('.' + ext.toLowerCase())) return fileName;
    return fileName + '.' + ext;
  }

  async process(item) {
    var pinid = this.extractPinId(item);
    if (!pinid) {
      return {
        pinid: '',
        kind: 'unknown',
        fileName: 'invalid-attachment',
        contentUrl: '',
        metaInfo: null,
      };
    }

    try {
      var metaInfo = await this.getMetaFileInfo(pinid);
      
      var contentUrl = await this.getMetaFileContent(pinid);
      var kind = this.resolveFileKind(metaInfo);
      return {
        pinid: pinid,
        kind: kind,
        fileName: this.getDisplayName(metaInfo, pinid),
        contentUrl: contentUrl,
        metaInfo: metaInfo,
      };
    } catch (error) {
      var fallbackContentUrl = await this.getMetaFileContent(pinid);
      return {
        pinid: pinid,
        kind: 'unknown',
        fileName: pinid,
        contentUrl: fallbackContentUrl,
        metaInfo: null,
      };
    }
  }
}

class IdAttachments extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._attachments = [];
    this._items = [];
    this._loading = false;
    this._processor = new AttachmentsProcessor();
  }

  set attachments(value) {
    this._attachments = Array.isArray(value) ? value : [];
    this._resolveItems();
  }

  get attachments() {
    return this._attachments;
  }

  connectedCallback() {
    this.render();
    this._resolveItems();
  }

  async _resolveItems() {
    if (!this.isConnected) return;
    if (!Array.isArray(this._attachments) || this._attachments.length === 0) {
      this._items = [];
      this._loading = false;
      this.render();
      return;
    }
    this._loading = true;
    this.render();
    this._items = await Promise.all(this._attachments.map((item) => this._processor.process(item)));
    this._loading = false;
    this.render();
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _renderByKind(item) {
    var safeName = this._escapeHtml(item.fileName || 'file');
    var safeUrl = this._escapeHtml(item.contentUrl || '#');
    if (item.kind === 'image') {
      return `<img class="media-image" src="${safeUrl}" alt="${safeName}" loading="lazy" />`;
    }
    if (item.kind === 'video') {
      return `<video class="media-video" src="${safeUrl}" controls preload="metadata"></video>`;
    }
    if (item.kind === 'audio') {
      return `
        <div class="file-line">
          <span class="icon">AUDIO</span>
          <span class="name">${safeName}</span>
        </div>
        <audio class="media-audio" src="${safeUrl}" controls preload="metadata"></audio>
      `;
    }

    var iconMap = {
      pdf: 'PDF',
      office: 'DOC',
      archive: 'ZIP',
      text: 'TXT',
      unknown: 'FILE',
    };
    var icon = iconMap[item.kind] || 'FILE';
    return `
      <a class="file-link" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
        <span class="icon">${icon}</span>
        <span class="name">${safeName}</span>
      </a>
    `;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .wrap {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 8px;
          width: 100%;
        }
        .loading {
          font-size: 12px;
          color: #6b7280;
        }
        .card {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 8px;
          background: #f9fafb;
          min-height: 54px;
        }
        .media-image,
        .media-video {
          width: 100%;
          border-radius: 6px;
          display: block;
          max-height: 160px;
          object-fit: cover;
          background: #000;
        }
        .media-audio {
          width: 100%;
          margin-top: 8px;
        }
        .file-line,
        .file-link {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #111827;
          text-decoration: none;
        }
        .icon {
          font-size: 10px;
          font-weight: 700;
          color: #374151;
          background: #e5e7eb;
          border-radius: 999px;
          padding: 2px 7px;
          flex-shrink: 0;
        }
        .name {
          font-size: 12px;
          line-height: 1.4;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      </style>
      <div class="wrap">
        ${this._loading ? '<div class="loading">Loading attachments...</div>' : ''}
        ${!this._loading ? this._items.map((item) => `<div class="card">${this._renderByKind(item)}</div>`).join('') : ''}
      </div>
    `;
  }
}

if (!customElements.get('id-attachments')) {
  customElements.define('id-attachments', IdAttachments);
}
