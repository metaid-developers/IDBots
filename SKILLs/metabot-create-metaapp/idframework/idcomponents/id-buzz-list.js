import './id-attachments.js';
import './id-post-buzz.js';

/**
 * id-buzz-list - Web Component for buzz feed rendering
 * Uses IDFramework command dispatch to fetch paginated buzz list.
 */
class IdBuzzList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._buzzList = [];
    this._total = 0;
    this._nextCursor = 0;
    this._hasMore = true;
    this._loading = false;
    this._loadingMore = false;
    this._error = '';
    this._observer = null;
    this._sentinel = null;
    this._quoteDetails = new Map();
    this._quoteLoading = new Set();
    this._userInfoCache = new Map();
    this._contentOverflow = new Map();
    this._contentExpanded = new Set();
    this._postModalOpen = false;
  }

  static get observedAttributes() {
    return ['path', 'page-size', 'auto-load'];
  }

  connectedCallback() {
    this.render();
    if (this.getAttribute('auto-load') !== 'false') {
      this.refresh();
    }
  }

  disconnectedCallback() {
    this._teardownObserver();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'path' || name === 'page-size') {
      this.refresh();
    }
  }

  async refresh() {
    this._nextCursor = 0;
    this._hasMore = true;
    this._error = '';
    await this._fetchBuzz(false);
  }

  async _loadMore() {
    if (!this._hasMore || this._loadingMore || this._nextCursor === null) {
      return;
    }
    await this._fetchBuzz(true);
  }

  _isCommandRegistered(commandName) {
    if (!window.IDFramework || !window.IDFramework.IDController) return false;
    var controller = window.IDFramework.IDController;
    var inFileCommands = controller.commands && typeof controller.commands.has === 'function'
      ? controller.commands.has(commandName)
      : false;
    var inBuiltInCommands = controller.builtInCommands && typeof controller.builtInCommands.has === 'function'
      ? controller.builtInCommands.has(commandName)
      : false;
    return inFileCommands || inBuiltInCommands;
  }

  async _fetchBuzz(isLoadMore) {
    if (this._loading || this._loadingMore) return;

    if (isLoadMore) {
      this._loadingMore = true;
    } else {
      this._loading = true;
    }
    this._error = '';
    this.render();

    try {
      if (!window.IDFramework) {
        throw new Error('IDFramework is not available');
      }
      await this._waitForFetchBuzzCommand();

      var cursor = isLoadMore ? (this._nextCursor ?? 0) : 0;
      var result = await window.IDFramework.dispatch('fetchBuzz', {
        path: this._getPath(),
        cursor: cursor,
        size: this._getPageSize(),
      });

      var list = Array.isArray(result && result.list) ? result.list : [];
      this._total = Number((result && result.total) ?? 0);
      this._nextCursor = (result && result.nextCursor !== undefined) ? result.nextCursor : null;
      this._hasMore = this._nextCursor !== null && list.length > 0;

      if (isLoadMore) {
        this._buzzList = this._buzzList.concat(list);
      } else {
        this._buzzList = list;
      }
    } catch (error) {
      this._error = error && error.message ? error.message : 'Failed to fetch buzz list';
      if (!isLoadMore) {
        this._buzzList = [];
      }
    } finally {
      this._loading = false;
      this._loadingMore = false;
      this.render();
      this._setupObserver();
    }
  }

  _getPath() {
    return this.getAttribute('path') || (window.IDConfig && window.IDConfig.BUZZ_PATH) || '/protocols/simplebuzz';
  }

  async _waitForFetchBuzzCommand(maxWaitMs = 5000) {
    var start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this._isCommandRegistered('fetchBuzz')) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('fetchBuzz command is not registered yet');
  }

  _parseContentSummary(pin) {
    if (!pin || !pin.contentSummary) return {};
    if (typeof pin.contentSummary === 'object') return pin.contentSummary;
    if (typeof pin.contentSummary === 'string') {
      try {
        return JSON.parse(pin.contentSummary);
      } catch (error) {
        return {};
      }
    }
    return {};
  }

  async _fetchUserInfoByAddress(address) {
    if (!address) return { name: '', metaId: '', avatar: '', address: '' };
    if (this._userInfoCache.has(address)) return this._userInfoCache.get(address);
    try {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var base = (serviceLocator.metafs || (window.IDConfig && window.IDConfig.METAFS_BASE_URL) || 'https://file.metaid.io/metafile-indexer/api').replace(/\/+$/, '');
      var response = await fetch(base + '/v1/users/address/' + encodeURIComponent(address), { method: 'GET' });
      if (!response.ok) throw new Error('fetch user info failed');
      var json = await response.json();
      var payload = json;
      if (json && typeof json.code === 'number') payload = json.data || {};
      if (json && json.data && typeof json.data === 'object' && !json.code) payload = json.data;
      var normalized = {
        name: (payload && payload.name) || '',
        metaId: (payload && (payload.metaId || payload.metaid || payload.globalMetaId)) || '',
        avatar: (payload && payload.avatar) || '',
        address: (payload && payload.address) || address,
      };
      this._userInfoCache.set(address, normalized);
      return normalized;
    } catch (error) {
      var fallback = { name: '', metaId: '', avatar: '', address: address };
      this._userInfoCache.set(address, fallback);
      return fallback;
    }
  }

  _normalizePinToBuzzItem(pin) {
    var contentSummary = this._parseContentSummary(pin);
    var modifyHistory = Array.isArray(pin && pin.modify_history) ? pin.modify_history : [];
    return {
      id: (pin && pin.id) || '',
      address: (pin && pin.address) || '',
      timestamp: Number(pin && pin.timestamp) * 1000 || Date.now(),
      path: (pin && pin.path) || '',
      metaid: (pin && pin.metaid) || '',
      chainName: (pin && pin.chainName) || '',
      content: contentSummary.content || '',
      attachments: Array.isArray(contentSummary.attachments) ? contentSummary.attachments : [],
      quotePin: contentSummary.quotePin || '',
      lastId: modifyHistory.length ? modifyHistory[modifyHistory.length - 1] : ((pin && pin.id) || ''),
    };
  }

  _extractTxIdFromPinId(pinid) {
    if (!pinid) return '';
    return String(pinid).replace(/i0$/i, '');
  }

  _resolveExplorerUrl(chainName, pinid) {
    var txid = this._extractTxIdFromPinId(pinid);
    var chain = String(chainName || '').toLowerCase();
    if (!txid) return '';
    if (chain === 'btc') return 'https://mempool.space/tx/' + encodeURIComponent(txid);
    if (chain === 'mvc') return 'https://www.mvcscan.com/tx/' + encodeURIComponent(txid);
    return '';
  }

  _renderPinLink(item, extraClass) {
    var pinid = (item && item.id) || '';
    var chainName = (item && (item.chainName || (item.raw && item.raw.chainName))) || '';
    var explorerUrl = this._resolveExplorerUrl(chainName, pinid);
    if (!pinid || !explorerUrl) return '';
    var chain = String(chainName || '').toLowerCase();
    var chainClass = chain === 'btc' ? 'btc' : (chain === 'mvc' ? 'mvc' : 'unknown');
    var label = this._escapeHtml(String(pinid).slice(0, 8));
    return `
      <a class="pin-link ${chainClass} ${extraClass || ''}" href="${this._escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer">
        <svg class="pin-link-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M10.59 13.41a1 1 0 0 1 0-1.41l3-3a3 3 0 1 1 4.24 4.24l-2 2a3 3 0 0 1-4.24 0a1 1 0 1 1 1.41-1.41a1 1 0 0 0 1.42 0l2-2a1 1 0 1 0-1.42-1.42l-3 3a1 1 0 0 1-1.41 0Zm2.82-2.82a1 1 0 0 1 0 1.41l-3 3a3 3 0 0 1-4.24-4.24l2-2a3 3 0 0 1 4.24 0a1 1 0 0 1-1.41 1.41a1 1 0 0 0-1.42 0l-2 2a1 1 0 1 0 1.42 1.42l3-3a1 1 0 0 1 1.41 0Z"/>
        </svg>
        <span>${label}</span>
      </a>
    `;
  }

  async _fetchQuoteDetail(pinid) {
    if (!pinid || this._quoteDetails.has(pinid) || this._quoteLoading.has(pinid)) return;
    this._quoteLoading.add(pinid);
    this.render();
    try {
      var pin = null;
      if (this._isCommandRegistered('getPinDetail')) {
        pin = await window.IDFramework.dispatch('getPinDetail', { numberOrId: pinid });
      } else {
        var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
        var base = (serviceLocator.metaid_man || 'https://manapi.metaid.io').replace(/\/+$/, '');
        var response = await fetch(base + '/pin/' + encodeURIComponent(pinid), { method: 'GET' });
        if (!response.ok) throw new Error('fetch quote detail failed');
        var json = await response.json();
        pin = (json && typeof json.code === 'number') ? (json.data || null) : (json.data || json);
      }

      if (!pin) throw new Error('empty quote detail');

      var normalized = this._normalizePinToBuzzItem(pin);
      normalized.userInfo = await this._fetchUserInfoByAddress(normalized.address);
      this._quoteDetails.set(pinid, normalized);
    } catch (error) {
      this._quoteDetails.set(pinid, { error: true, message: 'Failed to load quoted buzz', id: pinid, attachments: [] });
    } finally {
      this._quoteLoading.delete(pinid);
      this.render();
    }
  }

  _ensureQuoteDetail(pinid) {
    if (!pinid) return;
    if (this._quoteDetails.has(pinid) || this._quoteLoading.has(pinid)) return;
    this._fetchQuoteDetail(pinid);
  }

  _isExpanded(contentKey) {
    return this._contentExpanded.has(contentKey);
  }

  _isOverflow(contentKey) {
    return this._contentOverflow.get(contentKey) === true;
  }

  _toggleContent(contentKey) {
    if (this._contentExpanded.has(contentKey)) {
      this._contentExpanded.delete(contentKey);
    } else {
      this._contentExpanded.add(contentKey);
    }
    this.render();
  }

  _updateContentOverflowStates() {
    var nodes = this.shadowRoot.querySelectorAll('[data-content-key]');
    var changed = false;
    nodes.forEach((node) => {
      var key = node.getAttribute('data-content-key');
      if (!key) return;
      var isOverflow = node.scrollHeight > 500;
      if (this._contentOverflow.get(key) !== isOverflow) {
        this._contentOverflow.set(key, isOverflow);
        changed = true;
      }
    });
    return changed;
  }

  _getPageSize() {
    var value = Number(this.getAttribute('page-size') || (window.IDConfig && window.IDConfig.BUZZ_PAGE_SIZE) || 20);
    if (!Number.isFinite(value) || value <= 0) return 20;
    return value;
  }

  _setupObserver() {
    this._teardownObserver();
    this._sentinel = this.shadowRoot.querySelector('.buzz-sentinel');
    if (!this._sentinel || !this._hasMore) return;

    this._observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this._loadMore();
          }
        });
      },
      {
        root: null,
        rootMargin: '120px',
        threshold: 0.1,
      }
    );
    this._observer.observe(this._sentinel);
  }

  _teardownObserver() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  _formatTime(timestamp) {
    if (!timestamp) return '--';
    try {
      return new Date(timestamp).toLocaleString();
    } catch (error) {
      return '--';
    }
  }

  _formatMetaId(metaId) {
    if (!metaId) return '';
    return metaId.slice(0, 6);
  }

  _renderQuoteCard(quotePin) {
    var safePin = this._escapeHtml(quotePin || '');
    var quoteContentKey = 'quote-' + safePin;
    var quoteLoading = this._quoteLoading.has(quotePin);
    var quoteData = this._quoteDetails.get(quotePin);
    if (!quoteData) {
      return `<div class="quote-card quote-card-loading"><span class="spinner"></span>Loading quoted buzz...</div>`;
    }
    if (quoteLoading) {
      return `<div class="quote-card quote-card-loading"><span class="spinner"></span>Loading quoted buzz...</div>`;
    }
    if (quoteData.error) {
      return `<div class="quote-card quote-card-error" data-quote-pin="${safePin}">${this._escapeHtml(quoteData.message || 'Load failed, click retry')}</div>`;
    }

    var user = quoteData.userInfo || {};
    var metaId = this._formatMetaId(user.metaId || quoteData.metaid || '');
    var avatar = user.avatar || '';
    var name = user.name || 'Unknown';
    return `
      <div class="quote-card quote-card-loaded" data-quote-pin="${safePin}">
        <div class="quote-user">
          ${avatar ? `<img class="quote-avatar" src="${this._escapeHtml(avatar)}" alt="${this._escapeHtml(name)}" />` : `<span class="quote-avatar quote-avatar-fallback">${this._escapeHtml((name || '?').slice(0, 1))}</span>`}
          <div class="quote-user-meta">
            <div class="quote-name">${this._escapeHtml(name)}</div>
            <div class="quote-metaid">MetaID: ${this._escapeHtml(metaId || '--')}</div>
          </div>
        </div>
        <div class="quote-content ${this._isOverflow(quoteContentKey) && !this._isExpanded(quoteContentKey) ? 'is-collapsed' : ''}" data-content-key="${quoteContentKey}">${this._escapeHtml(quoteData.content || '(empty content)')}</div>
        ${this._isOverflow(quoteContentKey) ? `<button class="content-toggle" data-toggle-content="${quoteContentKey}">${this._isExpanded(quoteContentKey) ? '收起' : '展开'}</button>` : ''}
        <id-attachments class="attachments-host quote-attachments-host" data-quote-attachments-pin="${safePin}"></id-attachments>
        <div class="pin-time-row quote-pin-time-row">
          ${this._renderPinLink(quoteData, 'quote-pin-link')}
          <span class="row-time">${this._escapeHtml(this._formatTime(quoteData.timestamp))}</span>
        </div>
      </div>
    `;
  }

  _renderBuzzItem(item, index) {
    if (item.quotePin) this._ensureQuoteDetail(item.quotePin);
    var user = item.userInfo || {};
    var name = user.name || 'Unknown';
    var metaId = this._formatMetaId(user.metaId || item.metaid || '');
    var avatar = user.avatar || '';
    var content = item.content || '';
    var quotePin = item.quotePin || '';
    var mainContentKey = 'main-' + String(index);

    return `
      <article class="buzz-item">
        <div class="buzz-user">
          ${avatar ? `<img class="avatar" src="${this._escapeHtml(avatar)}" alt="avatar" />` : `<div class="avatar avatar-fallback">${this._escapeHtml(name.slice(0, 1) || '?')}</div>`}
          <div class="user-meta">
            <div class="name">${this._escapeHtml(name)}</div>
            <div class="sub">MetaID: ${this._escapeHtml(metaId || '--')}</div>
          </div>
        </div>
        <div class="buzz-content ${this._isOverflow(mainContentKey) && !this._isExpanded(mainContentKey) ? 'is-collapsed' : ''}" data-content-key="${mainContentKey}">${this._escapeHtml(content || '(empty content)')}</div>
        ${this._isOverflow(mainContentKey) ? `<button class="content-toggle" data-toggle-content="${mainContentKey}">${this._isExpanded(mainContentKey) ? '收起' : '展开'}</button>` : ''}
        <div class="buzz-footer">
          <id-attachments class="attachments-host" data-attachments-index="${index}"></id-attachments>
          ${quotePin ? this._renderQuoteCard(quotePin) : ''}
          <div class="pin-time-row buzz-pin-time-row">
            ${this._renderPinLink(item, 'buzz-pin-link')}
            <span class="row-time">${this._escapeHtml(this._formatTime(item.timestamp))}</span>
          </div>
        </div>
      </article>
    `;
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          max-width: 760px;
          margin: 0 auto;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
          color: var(--id-text-main, #111827);
        }
        .buzz-wrap {
          background: var(--id-bg-card, #ffffff);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          padding: 12px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
        }
        .header-actions {
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }
        .title {
          font-size: 16px;
          font-weight: 700;
        }
        .post-btn {
          border: 1px solid #2563eb;
          border-radius: 999px;
          height: 32px;
          padding: 0 14px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .post-btn:hover {
          filter: brightness(1.03);
        }
        .refresh-btn {
          border: 1px solid #d1d5db;
          border-radius: 8px;
          width: 32px;
          height: 32px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: #fff;
          cursor: pointer;
          font-size: 16px;
          line-height: 1;
        }
        .refresh-btn:hover {
          background: #f9fafb;
        }
        .refresh-btn:active {
          transform: rotate(20deg);
        }
        .buzz-list {
          display: flex;
          flex-direction: column;
          gap: 18px;
          min-height: 120px;
        }
        .buzz-item {
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 12px;
          background: #fff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
        }
        .buzz-user {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          object-fit: cover;
        }
        .avatar-fallback {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: #111827;
          color: #fff;
          font-size: 13px;
          font-weight: 600;
        }
        .user-meta {
          flex: 1;
          min-width: 0;
        }
        .name {
          font-size: 14px;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .sub {
          font-size: 12px;
          color: #6b7280;
        }
        .buzz-content {
          margin-top: 8px;
          line-height: 1.45;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 14px;
          max-height: none;
          overflow: visible;
          position: relative;
        }
        .buzz-content.is-collapsed,
        .quote-content.is-collapsed {
          max-height: 500px;
          overflow: hidden;
        }
        .buzz-content.is-collapsed::after,
        .quote-content.is-collapsed::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          height: 42px;
          background: linear-gradient(to bottom, rgba(255, 255, 255, 0), rgba(255, 255, 255, 1));
          pointer-events: none;
        }
        .quote-card {
          margin-top: 10px;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 10px;
          background: #f8fafc;
          width: 60%;
          max-width: 100%;
          min-width: 280px;
        }
        .quote-card:hover {
          background: #f1f5f9;
        }
        .quote-card-loading {
          font-size: 12px;
          color: #6b7280;
          display: flex;
          align-items: center;
        }
        .quote-card-error {
          font-size: 12px;
          color: #b91c1c;
        }
        .quote-user {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .quote-user-meta {
          flex: 1;
          min-width: 0;
        }
        .quote-name {
          font-size: 12px;
          font-weight: 600;
          color: #111827;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .quote-avatar {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
        }
        .quote-avatar-fallback {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          font-weight: 700;
          color: #fff;
          background: #6b7280;
        }
        .quote-metaid {
          font-size: 11px;
          color: #6b7280;
        }
        .quote-content {
          font-size: 13px;
          line-height: 1.45;
          color: #111827;
          margin-bottom: 8px;
          white-space: pre-wrap;
          word-break: break-word;
          position: relative;
        }
        .buzz-footer {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 10px;
          margin-top: 8px;
          flex-wrap: wrap;
          width: 100%;
        }
        .attachments-host {
          width: 100%;
        }
        .content-toggle {
          margin-top: 8px;
          border: none;
          background: transparent;
          color: #2563eb;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          padding: 0;
        }
        .content-toggle:hover {
          color: #1d4ed8;
        }
        .pin-link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          text-decoration: none;
          font-size: 12px;
          font-weight: 600;
        }
        .pin-link-icon {
          width: 25px;
          height: 25px;
          flex-shrink: 0;
        }
        .pin-link.btc {
          color: #d97706;
        }
        .pin-link.mvc {
          color: #2563eb;
        }
        .pin-link.unknown {
          color: #4b5563;
        }
        .pin-link:hover {
          text-decoration: underline;
        }
        .quote-pin-link {
          margin-top: 2px;
        }
        .pin-time-row {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .row-time {
          font-size: 12px;
          color: #9ca3af;
          white-space: nowrap;
          margin-left: auto;
        }
        .loading,
        .loading-more,
        .empty,
        .error {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 72px;
          color: #6b7280;
          font-size: 13px;
          text-align: center;
        }
        .error {
          color: #b91c1c;
        }
        .spinner {
          width: 16px;
          height: 16px;
          border: 2px solid #e5e7eb;
          border-top-color: #2563eb;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-right: 8px;
        }
        .buzz-sentinel {
          height: 1px;
        }
        .post-modal {
          position: fixed;
          inset: 0;
          background: rgba(15, 23, 42, 0.45);
          z-index: 99999;
          display: ${this._postModalOpen ? 'flex' : 'none'};
          align-items: center;
          justify-content: center;
          padding: 16px;
          box-sizing: border-box;
        }
        .post-modal-card {
          width: min(760px, 96vw);
          max-height: 92vh;
          overflow: auto;
          background: #ffffff;
          border-radius: 14px;
          border: 1px solid #e5e7eb;
          box-shadow: 0 16px 50px rgba(15, 23, 42, 0.25);
          padding: 12px;
          box-sizing: border-box;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
      <section class="buzz-wrap">
        <div class="header">
          <div>
            <div class="title">Buzz Feed</div>
          </div>
          <div class="header-actions">
            <button class="post-btn" data-action="open-post" title="Post" aria-label="Post">Post</button>
            <button class="refresh-btn" data-action="refresh" title="Refresh" aria-label="Refresh">↻</button>
          </div>
        </div>
        <div class="buzz-list">
          ${this._loading ? `<div class="loading"><span class="spinner"></span>Loading buzz...</div>` : ''}
          ${!this._loading && this._error ? `<div class="error">${this._escapeHtml(this._error)}</div>` : ''}
          ${!this._loading && !this._error && this._buzzList.length === 0 ? `<div class="empty">No buzz data.</div>` : ''}
          ${!this._loading ? this._buzzList.map((item, index) => this._renderBuzzItem(item, index)).join('') : ''}
          ${this._loadingMore ? `<div class="loading-more"><span class="spinner"></span>Loading more...</div>` : ''}
          <div class="buzz-sentinel"></div>
        </div>
      </section>
      <div class="post-modal" data-action="post-modal-overlay">
        <div class="post-modal-card">
          <id-post-buzz></id-post-buzz>
        </div>
      </div>
    `;

    var attachmentHosts = this.shadowRoot.querySelectorAll('id-attachments[data-attachments-index]');
    attachmentHosts.forEach((host) => {
      var index = Number(host.getAttribute('data-attachments-index'));
      var attachments = this._buzzList[index] && Array.isArray(this._buzzList[index].attachments)
        ? this._buzzList[index].attachments
        : [];
      host.attachments = attachments;
    });

    var quoteAttachmentHosts = this.shadowRoot.querySelectorAll('id-attachments[data-quote-attachments-pin]');
    quoteAttachmentHosts.forEach((host) => {
      var pinid = host.getAttribute('data-quote-attachments-pin');
      var quoteData = pinid ? this._quoteDetails.get(pinid) : null;
      var attachments = quoteData && Array.isArray(quoteData.attachments) ? quoteData.attachments : [];
      host.attachments = attachments;
    });

    var toggles = this.shadowRoot.querySelectorAll('[data-toggle-content]');
    toggles.forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        var contentKey = button.getAttribute('data-toggle-content');
        if (contentKey) this._toggleContent(contentKey);
      });
    });

    if (this._updateContentOverflowStates()) {
      this.render();
      return;
    }

    var refreshBtn = this.shadowRoot.querySelector('[data-action="refresh"]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refresh());
    }

    var openPostBtn = this.shadowRoot.querySelector('[data-action="open-post"]');
    if (openPostBtn) {
      openPostBtn.addEventListener('click', () => {
        this._postModalOpen = true;
        this.render();
      });
    }

    var modalOverlay = this.shadowRoot.querySelector('[data-action="post-modal-overlay"]');
    if (modalOverlay) {
      modalOverlay.addEventListener('click', (event) => {
        if (event.target === modalOverlay) {
          this._postModalOpen = false;
          this.render();
        }
      });
    }

    var postComposer = this.shadowRoot.querySelector('id-post-buzz');
    if (postComposer) {
      postComposer.addEventListener('close', () => {
        this._postModalOpen = false;
        this.render();
      });
      postComposer.addEventListener('buzz-posted', () => {
        this._postModalOpen = false;
        this.refresh();
      });
    }

    // Re-bind observer after every render because shadow DOM nodes are replaced.
    this._setupObserver();
  }
}

if (!customElements.get('id-buzz-list')) {
  customElements.define('id-buzz-list', IdBuzzList);
}
