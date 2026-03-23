/**
 * id-image-viewer - Global image lightbox driven by Alpine.store('app').imageViewer.
 * Opens when receiving `id:attachment:image-open` events from attachment components.
 */
class IdImageViewer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastSignature = '';
    this._bodyOverflowBackup = '';
    this._onAttachmentOpen = this._handleAttachmentOpen.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
  }

  connectedCallback() {
    this._ensureViewerStore();
    document.addEventListener('id:attachment:image-open', this._onAttachmentOpen);
    window.addEventListener('keydown', this._onKeyDown);
    this.render();
    this._watchTimer = setInterval(() => this._checkAndRender(false), 200);
  }

  disconnectedCallback() {
    document.removeEventListener('id:attachment:image-open', this._onAttachmentOpen);
    window.removeEventListener('keydown', this._onKeyDown);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    this._syncBodyScrollLock(false);
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureViewerStore() {
    var app = this._getStore('app');
    if (!app) return null;
    if (!app.imageViewer || typeof app.imageViewer !== 'object') app.imageViewer = {};
    if (!Array.isArray(app.imageViewer.images)) app.imageViewer.images = [];
    if (!Number.isFinite(Number(app.imageViewer.index))) app.imageViewer.index = 0;
    if (app.imageViewer.visible === undefined) app.imageViewer.visible = false;
    return app.imageViewer;
  }

  _normalizeImageItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var fullUrl = String(raw.fullUrl || raw.contentUrl || '').trim();
    if (!fullUrl) return null;
    var previewUrl = String(raw.previewUrl || fullUrl).trim();
    var pinid = String(raw.pinid || '').trim();
    var fileName = String(raw.fileName || raw.name || pinid || 'image').trim();
    return {
      pinid: pinid,
      fileName: fileName,
      previewUrl: previewUrl,
      fullUrl: fullUrl,
    };
  }

  _readViewerState() {
    var store = this._ensureViewerStore();
    if (!store) {
      return {
        visible: false,
        index: 0,
        images: [],
        current: null,
      };
    }

    var images = Array.isArray(store.images)
      ? store.images.map((item) => this._normalizeImageItem(item)).filter(Boolean)
      : [];
    var index = Number(store.index || 0);
    if (!Number.isFinite(index) || index < 0) index = 0;
    if (index >= images.length) index = images.length > 0 ? images.length - 1 : 0;

    return {
      visible: !!store.visible && images.length > 0,
      index: index,
      images: images,
      current: images[index] || null,
    };
  }

  _buildSignature(snapshot) {
    var current = snapshot.current || {};
    return [
      snapshot.visible ? '1' : '0',
      String(snapshot.index),
      String(snapshot.images.length),
      String(current.fullUrl || ''),
    ].join('|');
  }

  _checkAndRender(force) {
    var snapshot = this._readViewerState();
    var signature = this._buildSignature(snapshot);
    if (!force && signature === this._lastSignature) return;
    this._lastSignature = signature;
    this._renderSnapshot(snapshot);
  }

  _handleAttachmentOpen(event) {
    var viewerStore = this._ensureViewerStore();
    if (!viewerStore) return;

    var detail = event && event.detail ? event.detail : {};
    var images = Array.isArray(detail.images)
      ? detail.images.map((item) => this._normalizeImageItem(item)).filter(Boolean)
      : [];
    if (images.length === 0) {
      var single = this._normalizeImageItem(detail);
      if (single) images = [single];
    }
    if (images.length === 0) return;

    var index = Number(detail.index);
    if (!Number.isFinite(index) || index < 0 || index >= images.length) index = 0;

    viewerStore.images = images;
    viewerStore.index = index;
    viewerStore.visible = true;
    viewerStore.updatedAt = Date.now();
    this._checkAndRender(true);
  }

  _setVisible(visible) {
    var viewerStore = this._ensureViewerStore();
    if (!viewerStore) return;
    viewerStore.visible = !!visible;
    if (!viewerStore.visible) {
      viewerStore.index = 0;
    }
    viewerStore.updatedAt = Date.now();
    this._checkAndRender(true);
  }

  _move(delta) {
    var viewerStore = this._ensureViewerStore();
    if (!viewerStore || !viewerStore.visible) return;
    var images = Array.isArray(viewerStore.images) ? viewerStore.images : [];
    if (images.length === 0) return;
    var current = Number(viewerStore.index || 0);
    if (!Number.isFinite(current)) current = 0;
    var next = current + Number(delta || 0);
    if (next < 0) next = 0;
    if (next > images.length - 1) next = images.length - 1;
    if (next === current) return;
    viewerStore.index = next;
    viewerStore.updatedAt = Date.now();
    this._checkAndRender(true);
  }

  _downloadCurrent() {
    var current = this._readViewerState().current;
    if (!current || !current.fullUrl || typeof document === 'undefined') return;
    var link = document.createElement('a');
    link.href = current.fullUrl;
    link.download = current.fileName || current.pinid || 'image';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  _openCurrentInNewTab() {
    var current = this._readViewerState().current;
    if (!current || !current.fullUrl || typeof window === 'undefined') return;
    window.open(current.fullUrl, '_blank', 'noopener,noreferrer');
  }

  _handleKeyDown(event) {
    var snapshot = this._readViewerState();
    if (!snapshot.visible) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this._setVisible(false);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this._move(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      this._move(1);
    }
  }

  _syncBodyScrollLock(visible) {
    if (typeof document === 'undefined' || !document.body) return;
    var body = document.body;
    if (visible) {
      if (body.dataset.idImageViewerLock === '1') return;
      this._bodyOverflowBackup = body.style.overflow || '';
      body.style.overflow = 'hidden';
      body.dataset.idImageViewerLock = '1';
      return;
    }
    if (body.dataset.idImageViewerLock !== '1') return;
    body.style.overflow = this._bodyOverflowBackup || '';
    delete body.dataset.idImageViewerLock;
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _renderSnapshot(snapshot) {
    this._syncBodyScrollLock(snapshot.visible);

    if (!snapshot.visible || !snapshot.current) {
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            display: block;
          }
        </style>
      `;
      return;
    }

    var current = snapshot.current;
    var safeTitle = this._escapeHtml(current.fileName || current.pinid || 'image');
    var safeFullUrl = this._escapeHtml(current.fullUrl || '');
    var hasPrev = snapshot.index > 0;
    var hasNext = snapshot.index < snapshot.images.length - 1;
    var counter = (snapshot.index + 1) + ' / ' + snapshot.images.length;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: fixed;
          inset: 0;
          z-index: 100000;
          display: block;
        }
        .overlay {
          position: absolute;
          inset: 0;
          background: rgba(3, 7, 18, 0.84);
          backdrop-filter: blur(2px);
        }
        .toolbar {
          position: absolute;
          top: 14px;
          right: 14px;
          display: flex;
          gap: 8px;
          z-index: 2;
        }
        .tool-btn {
          border: 1px solid rgba(255, 255, 255, 0.24);
          background: rgba(17, 24, 39, 0.75);
          color: #f9fafb;
          border-radius: 10px;
          min-width: 36px;
          height: 36px;
          padding: 0 12px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
        }
        .tool-btn:hover {
          background: rgba(31, 41, 55, 0.85);
        }
        .stage {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 54px 60px 72px;
          box-sizing: border-box;
          z-index: 1;
        }
        .image {
          max-width: min(1200px, 94vw);
          max-height: min(84vh, 84dvh);
          width: auto;
          height: auto;
          border-radius: 10px;
          box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
          background: #111827;
          object-fit: contain;
          user-select: none;
          -webkit-user-drag: none;
        }
        .nav-btn {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 44px;
          height: 44px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.28);
          background: rgba(17, 24, 39, 0.72);
          color: #f9fafb;
          font-size: 18px;
          cursor: pointer;
          z-index: 2;
        }
        .nav-btn:hover:not([disabled]) {
          background: rgba(31, 41, 55, 0.9);
        }
        .nav-btn[disabled] {
          opacity: 0.35;
          cursor: not-allowed;
        }
        .nav-prev {
          left: 10px;
        }
        .nav-next {
          right: 10px;
        }
        .meta {
          position: absolute;
          left: 12px;
          right: 12px;
          bottom: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: #e5e7eb;
          font-size: 12px;
          z-index: 2;
          background: rgba(17, 24, 39, 0.7);
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 10px;
          padding: 8px 10px;
          box-sizing: border-box;
          gap: 10px;
        }
        .name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .counter {
          white-space: nowrap;
          color: #d1d5db;
        }
      </style>
      <div class="overlay" data-action="close"></div>
      <div class="toolbar">
        <button type="button" class="tool-btn" data-action="download">Download</button>
        <button type="button" class="tool-btn" data-action="open">Open</button>
        <button type="button" class="tool-btn" data-action="close" aria-label="Close viewer">×</button>
      </div>
      <button type="button" class="nav-btn nav-prev" data-action="prev" ${hasPrev ? '' : 'disabled'} aria-label="Previous image">‹</button>
      <button type="button" class="nav-btn nav-next" data-action="next" ${hasNext ? '' : 'disabled'} aria-label="Next image">›</button>
      <div class="stage" data-action="noop">
        <img class="image" src="${safeFullUrl}" alt="${safeTitle}" />
      </div>
      <div class="meta">
        <div class="name">${safeTitle}</div>
        <div class="counter">${this._escapeHtml(counter)}</div>
      </div>
    `;

    var actionNodes = this.shadowRoot.querySelectorAll('[data-action]');
    actionNodes.forEach((node) => {
      node.addEventListener('click', (event) => {
        var action = node.getAttribute('data-action');
        if (!action || action === 'noop') return;
        event.stopPropagation();
        if (action === 'close') {
          this._setVisible(false);
          return;
        }
        if (action === 'prev') {
          this._move(-1);
          return;
        }
        if (action === 'next') {
          this._move(1);
          return;
        }
        if (action === 'download') {
          this._downloadCurrent();
          return;
        }
        if (action === 'open') {
          this._openCurrentInNewTab();
        }
      });
    });
  }

  render() {
    this._checkAndRender(true);
  }
}

if (!customElements.get('id-image-viewer')) {
  customElements.define('id-image-viewer', IdImageViewer);
}
