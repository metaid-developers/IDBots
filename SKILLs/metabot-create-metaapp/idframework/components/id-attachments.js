/**
 * id-attachments - Attachment processor component
 * - Processor layer: parse metafile://pinid and resolve file metadata
 * - UI layer: render file cards by detected file kind
 */
class AttachmentsProcessor {
  constructor() {
    this._metaInfoCache = new Map();
    this._contentCache = new Map();
    this._previewCache = new Map();
    this._dbPromise = null;
  }

  extractPinId(item) {
    return this.extractAttachmentRef(item).pinid;
  }

  extractAttachmentRef(item) {
    var rawValue = '';
    var explicitType = '';
    if (typeof item === 'string') {
      rawValue = item;
    } else if (item && typeof item === 'object') {
      rawValue = item.url || item.uri || item.content || item.path || item.pinid || item.pinId || item.pinID || '';
      explicitType = String(item.file_type || item.fileType || item.type || '').toLowerCase();
    }

    var cleaned = this._stripQueryAndHash(rawValue);
    if (!cleaned) {
      return {
        raw: '',
        pinid: '',
        extHint: '',
        kindHint: '',
        directUrl: '',
      };
    }

    var kindHint = this._detectKindHint(cleaned) || explicitType;
    var pinid = '';
    var extHint = '';
    var directUrl = '';

    if (this._isHttpUrl(cleaned)) {
      var fromContentPath = this._extractFromContentPath(cleaned);
      if (fromContentPath) {
        pinid = fromContentPath.pinid;
        extHint = fromContentPath.extHint;
      } else {
        var fromAnyUrl = this._extractPinAndExt(cleaned);
        pinid = fromAnyUrl.pinid;
        extHint = fromAnyUrl.extHint;
        if (!pinid) directUrl = cleaned;
      }
    } else if (cleaned.indexOf('metafile://') === 0) {
      var fromMetafile = this._extractFromMetafileUri(cleaned);
      pinid = fromMetafile.pinid;
      extHint = fromMetafile.extHint;
      if (!kindHint) kindHint = fromMetafile.kindHint;
    } else if (cleaned.indexOf('/video/') === 0 || cleaned.indexOf('/audio/') === 0 || cleaned.indexOf('/image/') === 0) {
      var fromLegacy = this._extractPinAndExt(cleaned);
      pinid = fromLegacy.pinid;
      extHint = fromLegacy.extHint;
      if (!kindHint) kindHint = this._detectKindHint(cleaned);
    } else {
      var generic = this._extractPinAndExt(cleaned);
      pinid = generic.pinid;
      extHint = generic.extHint;
    }

    return {
      raw: String(rawValue || '').trim(),
      pinid: pinid,
      extHint: extHint,
      kindHint: kindHint || '',
      directUrl: directUrl,
    };
  }

  _stripQueryAndHash(value) {
    if (!value) return '';
    return String(value).trim().split('?')[0].split('#')[0].trim();
  }

  _isHttpUrl(value) {
    return /^https?:\/\//i.test(String(value || ''));
  }

  _detectKindHint(raw) {
    var text = String(raw || '').toLowerCase();
    if (text.indexOf('/video/') >= 0 || text.indexOf('metafile://video/') === 0) return 'video';
    if (text.indexOf('/audio/') >= 0 || text.indexOf('metafile://audio/') === 0) return 'audio';
    if (text.indexOf('/image/') >= 0 || text.indexOf('metafile://image/') === 0) return 'image';
    return '';
  }

  _extractFromMetafileUri(raw) {
    var withoutScheme = String(raw || '').replace(/^metafile:\/\//i, '');
    var kindHint = this._detectKindHint(raw);
    if (withoutScheme.indexOf('video/') === 0 || withoutScheme.indexOf('audio/') === 0 || withoutScheme.indexOf('image/') === 0) {
      withoutScheme = withoutScheme.split('/').slice(1).join('/');
    }
    return Object.assign({ kindHint: kindHint }, this._extractPinAndExt(withoutScheme));
  }

  _extractFromContentPath(url) {
    var cleaned = this._stripQueryAndHash(url);
    var marker = '/content/';
    var pos = cleaned.toLowerCase().lastIndexOf(marker);
    if (pos < 0) return null;
    var after = cleaned.slice(pos + marker.length);
    if (!after) return null;
    return this._extractPinAndExt(after);
  }

  _extractPinAndExt(rawValue) {
    var text = this._stripQueryAndHash(rawValue);
    if (!text) return { pinid: '', extHint: '' };

    var pinMatch = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (pinMatch && pinMatch[0]) {
      var pinidFromMatch = pinMatch[0];
      var suffix = text.slice(text.indexOf(pinidFromMatch) + pinidFromMatch.length);
      var extFromMatch = this._extractExtFromSuffix(suffix);
      return { pinid: pinidFromMatch, extHint: extFromMatch };
    }

    var tail = text.split('/').pop() || text;
    var extHint = this._extractExtFromSuffix(tail);
    var pinid = tail.replace(/\.[a-zA-Z0-9]{1,10}$/i, '');
    if (pinid && pinid.indexOf(':') >= 0) {
      pinid = pinid.split(':').pop() || '';
    }
    return { pinid: pinid.trim(), extHint: extHint };
  }

  _extractExtFromSuffix(value) {
    var matched = String(value || '').match(/\.([a-zA-Z0-9]{1,10})$/);
    return matched && matched[1] ? matched[1].toLowerCase() : '';
  }

  _getMetafsBase() {
    var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
    var fromLocator = serviceLocator.metafs || '';
    if (fromLocator) return fromLocator.replace(/\/+$/, '');
    var cfg = (typeof window !== 'undefined' && window.IDConfig) ? window.IDConfig : {};
    return (cfg.METAFS_BASE_URL || 'https://file.metaid.io/metafile-indexer/api/v1').replace(/\/+$/, '');
  }

  _buildMetafsV1Url(pathname) {
    var base = this._getMetafsBase();
    var normalizedPath = String(pathname || '');
    if (!normalizedPath) normalizedPath = '/';
    if (normalizedPath[0] !== '/') normalizedPath = '/' + normalizedPath;
    var lower = base.toLowerCase();
    if (lower.endsWith('/v1')) return base + normalizedPath;
    return base + '/v1' + normalizedPath;
  }

  _normalizeMetafsContentUrl(cachedUrl, pinid) {
    var canonical = this._buildMetafsV1Url('/files/content/' + encodeURIComponent(pinid));
    var url = String(cachedUrl || '').trim();
    if (!url) return canonical;
    // Legacy bad cache data compatibility: .../v1/v1/files/...
    if (url.indexOf('/v1/v1/') >= 0) {
      url = url.replace('/v1/v1/', '/v1/');
    }
    // Always use canonical path from current ServiceLocator to avoid stale baseURL pollution.
    return canonical;
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

    var url = this._buildMetafsV1Url('/files/' + encodeURIComponent(pinid));
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
    var inMemory = this._contentCache.get(pinid);
    if (inMemory) {
      var memoryFixed = this._normalizeMetafsContentUrl(inMemory, pinid);
      if (memoryFixed !== inMemory) {
        this._contentCache.set(pinid, memoryFixed);
      }
      return memoryFixed;
    }

    var cached = await this._idbGet('AttachmentContent', pinid);
    if (cached && cached.contentUrl) {
      var fixedCachedUrl = this._normalizeMetafsContentUrl(cached.contentUrl, pinid);
      this._contentCache.set(pinid, fixedCachedUrl);
      if (fixedCachedUrl !== cached.contentUrl) {
        this._idbPut('AttachmentContent', {
          pinid: pinid,
          contentUrl: fixedCachedUrl,
          updatedAt: Date.now(),
        });
      }
      return fixedCachedUrl;
    }

    var contentUrl = this._normalizeMetafsContentUrl('', pinid);
    this._contentCache.set(pinid, contentUrl);
    this._idbPut('AttachmentContent', {
      pinid: pinid,
      contentUrl: contentUrl,
      updatedAt: Date.now(),
    });
    return contentUrl;
  }

  async getMetaFilePreview(pinid) {
    if (!pinid) return '';
    if (this._previewCache.has(pinid)) return this._previewCache.get(pinid);
    var previewUrl = this._buildMetafsV1Url('/files/accelerate/content/' + encodeURIComponent(pinid) + '?process=preview');
    this._previewCache.set(pinid, previewUrl);
    return previewUrl;
  }

  resolveFileKind(metaInfo, attachmentRef) {
    var kindHint = String((attachmentRef && attachmentRef.kindHint) || '').toLowerCase();
    if (kindHint === 'image' || kindHint === 'video' || kindHint === 'audio') {
      return kindHint;
    }

    var fileType = String((metaInfo && metaInfo.file_type) || '').toLowerCase();
    var ext = String((metaInfo && metaInfo.file_extension) || (attachmentRef && attachmentRef.extHint) || '').toLowerCase().replace('.', '');

    var imageExt = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico'];
    var videoExt = ['mp4', 'webm', 'av1', 'avi', 'mov', 'wmv', 'flv', 'mkv', '3gp', 'm4v'];
    var audioExt = ['mp3', 'aac', 'wav', 'flac', 'ogg', 'wma', 'm4a'];
    var officeExt = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'];
    var archiveExt = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
    var textExt = ['md', 'markdown', 'txt', 'json', 'log', 'yaml', 'yml', 'rtf'];

    if (fileType === 'image' || imageExt.includes(ext)) return 'image';
    if (fileType === 'video' || videoExt.includes(ext)) return 'video';
    if (fileType === 'audio' || audioExt.includes(ext)) return 'audio';
    if (fileType === 'pdf' || ext === 'pdf') return 'pdf';
    if (officeExt.includes(ext)) return 'office';
    if (archiveExt.includes(ext)) return 'archive';
    if (textExt.includes(ext)) return 'text';
    // For social buzz attachments, missing extension should be treated as image by default.
    if (!fileType && !ext) return 'image';
    return 'unknown';
  }

  getDisplayName(metaInfo, pinid, attachmentRef) {
    var fileName = String((metaInfo && metaInfo.file_name) || '').trim();
    var ext = String((metaInfo && metaInfo.file_extension) || (attachmentRef && attachmentRef.extHint) || '').replace('.', '').trim();
    if (!fileName && !ext) return pinid || 'unknown-file';
    if (!fileName) {
      return ext ? ((pinid || 'unknown-file') + '.' + ext) : (pinid || 'unknown-file');
    }
    if (!ext) return fileName;
    if (fileName.toLowerCase().endsWith('.' + ext.toLowerCase())) return fileName;
    return fileName + '.' + ext;
  }

  async process(item) {
    var attachmentRef = this.extractAttachmentRef(item);
    var pinid = attachmentRef.pinid;
    var fallbackKind = this.resolveFileKind(null, attachmentRef);

    if (!pinid) {
      if (attachmentRef.directUrl) {
        return {
          pinid: '',
          kind: fallbackKind,
          fileName: this.getDisplayName(null, 'external-file', attachmentRef),
          previewUrl: attachmentRef.directUrl,
          contentUrl: attachmentRef.directUrl,
          metaInfo: null,
        };
      }
      return {
        pinid: '',
        kind: fallbackKind,
        fileName: 'invalid-attachment',
        previewUrl: '',
        contentUrl: '',
        metaInfo: null,
      };
    }

    try {
      var metaInfo = await this.getMetaFileInfo(pinid);
      var contentUrl = await this.getMetaFileContent(pinid);
      var kind = this.resolveFileKind(metaInfo, attachmentRef);
      var previewUrl = kind === 'image'
        ? await this.getMetaFilePreview(pinid)
        : contentUrl;
      return {
        pinid: pinid,
        kind: kind,
        fileName: this.getDisplayName(metaInfo, pinid, attachmentRef),
        previewUrl: previewUrl,
        contentUrl: contentUrl,
        metaInfo: metaInfo,
      };
    } catch (error) {
      var fallbackContentUrl = await this.getMetaFileContent(pinid);
      var fallbackPreviewUrl = fallbackKind === 'image'
        ? await this.getMetaFilePreview(pinid)
        : fallbackContentUrl;
      return {
        pinid: pinid,
        kind: fallbackKind,
        fileName: this.getDisplayName(null, pinid, attachmentRef),
        previewUrl: fallbackPreviewUrl,
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
    this._attachmentsKey = '';
    this._resolveVersion = 0;
    this._viewportObserver = null;
    this._activatedByViewport = false;
    this._processor = new AttachmentsProcessor();
  }

  set attachments(value) {
    var nextAttachments = Array.isArray(value) ? value : [];
    var nextKey = this._buildAttachmentsKey(nextAttachments);
    if (nextKey === this._attachmentsKey) return;
    this._attachments = nextAttachments;
    this._attachmentsKey = nextKey;
    this._items = [];
    this._loading = false;
    this.render();

    if (!this.isConnected) return;
    if (this._activatedByViewport) {
      this._resolveItems();
      return;
    }
    this._observeViewport();
  }

  get attachments() {
    return this._attachments;
  }

  connectedCallback() {
    this.render();
    this._observeViewport();
  }

  disconnectedCallback() {
    this._teardownViewportObserver();
    this._resolveVersion += 1;
  }

  _buildAttachmentsKey(list) {
    if (!Array.isArray(list) || list.length === 0) return '';
    return list.map(function (item) {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      var candidate = item.pinid || item.pinId || item.pinID || item.url || item.uri || item.content || item.path || '';
      if (candidate) return String(candidate).trim();
      try {
        return JSON.stringify(item);
      } catch (_) {
        return String(item);
      }
    }).join('|');
  }

  _observeViewport() {
    if (this._activatedByViewport) return;
    if (!Array.isArray(this._attachments) || this._attachments.length === 0) return;
    if (typeof IntersectionObserver === 'undefined') {
      this._activatedByViewport = true;
      this._resolveItems();
      return;
    }
    if (this._viewportObserver) return;
    this._viewportObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        this._activatedByViewport = true;
        this._teardownViewportObserver();
        this._resolveItems();
      });
    }, {
      root: null,
      rootMargin: '220px 0px',
      threshold: 0.01,
    });
    this._viewportObserver.observe(this);
  }

  _teardownViewportObserver() {
    if (!this._viewportObserver) return;
    this._viewportObserver.disconnect();
    this._viewportObserver = null;
  }

  async _resolveItems() {
    if (!this.isConnected) return;
    var version = ++this._resolveVersion;
    if (!Array.isArray(this._attachments) || this._attachments.length === 0) {
      this._items = [];
      this._loading = false;
      this.render();
      return;
    }
    this._loading = true;
    this.render();
    var resolved = await Promise.all(this._attachments.map((item) => this._processor.process(item)));
    if (!this.isConnected || version !== this._resolveVersion) return;
    this._items = resolved;
    this._loading = false;
    this.render();
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _renderByKind(item, index) {
    var safeName = this._escapeHtml(item.fileName || 'file');
    var safeUrl = this._escapeHtml(item.contentUrl || '#');
    var safePreviewUrl = this._escapeHtml(item.previewUrl || item.contentUrl || '#');
    var hasUrl = !!(item.contentUrl && String(item.contentUrl).trim());
    if (!hasUrl) {
      return `
        <div class="file-line">
          <span class="icon">FILE</span>
          <span class="name">${safeName}</span>
        </div>
      `;
    }

    if (item.kind === 'image') {
      return `
        <button type="button" class="image-trigger" data-image-index="${Number(index)}" aria-label="Open image ${safeName}">
          <img class="media-image" src="${safePreviewUrl}" alt="${safeName}" loading="lazy" decoding="async" fetchpriority="low" />
        </button>
      `;
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

  _normalizeViewerImage(item) {
    if (!item || item.kind !== 'image') return null;
    var fullUrl = String(item.contentUrl || '').trim();
    if (!fullUrl) return null;
    return {
      pinid: String(item.pinid || '').trim(),
      fileName: String(item.fileName || '').trim(),
      previewUrl: String(item.previewUrl || fullUrl).trim(),
      fullUrl: fullUrl,
    };
  }

  _openImageViewerByItemIndex(itemIndex) {
    var selected = this._items[itemIndex];
    var selectedImage = this._normalizeViewerImage(selected);
    if (!selectedImage) return;

    var images = this._items
      .map((item) => this._normalizeViewerImage(item))
      .filter(Boolean);
    if (images.length === 0) return;

    var selectedIndex = images.findIndex((image) => {
      if (selectedImage.pinid && image.pinid) return image.pinid === selectedImage.pinid;
      return image.fullUrl === selectedImage.fullUrl;
    });
    if (selectedIndex < 0) selectedIndex = 0;

    this.dispatchEvent(new CustomEvent('id:attachment:image-open', {
      detail: {
        images: images,
        index: selectedIndex,
      },
      bubbles: true,
      composed: true,
    }));
  }

  _bindImageTriggers() {
    var nodes = this.shadowRoot.querySelectorAll('[data-image-index]');
    nodes.forEach((node) => {
      node.addEventListener('click', () => {
        var index = Number(node.getAttribute('data-image-index'));
        if (!Number.isFinite(index) || index < 0) return;
        this._openImageViewerByItemIndex(index);
      });
    });
  }

  render() {
    var hasAttachments = Array.isArray(this._attachments) && this._attachments.length > 0;
    var deferred = hasAttachments && !this._activatedByViewport;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .wrap {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
          gap: 8px;
          width: 100%;
        }
        .loading {
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
        }
        .card {
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 8px;
          padding: 8px;
          background: var(--id-attachment-bg, #f9fafb);
          min-height: 54px;
        }
        .media-image {
          width: 100%;
          border-radius: 6px;
          display: block;
          aspect-ratio: 4 / 3;
          max-height: 440px;
          object-fit: cover;
          background: #111827;
        }
        .media-video {
          width: 100%;
          height: auto;
          max-width: 100%;
          border-radius: 6px;
          display: block;
          background: #111827;
        }
        .image-trigger {
          width: 100%;
          border: none;
          padding: 0;
          margin: 0;
          background: transparent;
          cursor: zoom-in;
          display: block;
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
          color: var(--id-text-main, #111827);
          text-decoration: none;
        }
        .icon {
          font-size: 10px;
          font-weight: 700;
          color: var(--id-text-secondary, #374151);
          background: var(--id-border-color, #e5e7eb);
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
        ${deferred ? '<div class="loading">Attachments will load when visible...</div>' : ''}
        ${!deferred && this._loading ? '<div class="loading">Loading attachments...</div>' : ''}
        ${!deferred && !this._loading ? this._items.map((item, index) => `<div class="card">${this._renderByKind(item, index)}</div>`).join('') : ''}
      </div>
    `;

    this._bindImageTriggers();
  }
}

if (!customElements.get('id-attachments')) {
  customElements.define('id-attachments', IdAttachments);
}
