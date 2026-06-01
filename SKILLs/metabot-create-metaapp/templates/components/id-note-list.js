import './id-note-card.js';
import './id-note-empty-state.js';
import { buildNoteRouteUrl } from '../utils/note-route.js';

class IdNoteList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastContextKey = '';
    this._items = [];
    this._loading = false;
    this._error = '';
    this._hasMore = false;
    this._onLocaleChanged = this.render.bind(this);
    this._observer = null;
    this._sentinel = null;
    this._onNoteOpen = this._handleNoteOpen.bind(this);
    this._pagerPrev = null;
    this._pagerNext = null;
    this._onPagerClick = this._handlePagerClick.bind(this);
    this._page = 1;
    this._pageSize = 20;
    this._currentCursor = '0';
    this._cursorHistory = ['0'];
  }

  static get observedAttributes() {
    return ['mode'];
  }

  connectedCallback() {
    this._ensureStoreShape();
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this.render();
    this._checkContext(true);
    this._watchTimer = setInterval(() => this._checkContext(false), 260);
    if (this._watchTimer && typeof this._watchTimer.unref === 'function') this._watchTimer.unref();
    if (typeof this.addEventListener === 'function') {
      this.addEventListener('note-open', this._onNoteOpen);
    }
  }

  disconnectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    this._teardownObserver();
    this._teardownPager();
    if (typeof this.removeEventListener === 'function') {
      this.removeEventListener('note-open', this._onNoteOpen);
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'mode') {
      this._checkContext(true);
    }
  }

  _t(key, fallback, params) {
    if (
      typeof window !== 'undefined' &&
      window.IDFramework &&
      window.IDFramework.I18n &&
      typeof window.IDFramework.I18n.t === 'function'
    ) {
      return window.IDFramework.I18n.t(key, params || {}, fallback || '');
    }
    return fallback || '';
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _escapeAttribute(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _normalizeMode(raw) {
    var mode = String(raw || '').trim().toLowerCase();
    if (mode === 'my' || mode === 'mynote') return 'my';
    return 'public';
  }

  _ensureStoreShape() {
    var note = this._getStore('note');
    if (!note) return;
    if (!note.route || typeof note.route !== 'object') note.route = { path: '/', view: 'list', params: {}, query: {} };
    if (!note.publicList || typeof note.publicList !== 'object') note.publicList = {};
    if (!note.myList || typeof note.myList !== 'object') note.myList = {};

    [note.publicList, note.myList].forEach(function ensureListShape(list) {
      if (!Array.isArray(list.items)) list.items = [];
      if (list.cursor === undefined) list.cursor = 0;
      if (list.hasMore === undefined) list.hasMore = true;
      if (list.isLoading === undefined) list.isLoading = false;
      if (list.error === undefined) list.error = '';
      if (list.page === undefined) list.page = 1;
      if (list.pageSize === undefined) list.pageSize = 20;
      if (list.currentCursor === undefined) list.currentCursor = '0';
      if (!Array.isArray(list.cursorHistory)) list.cursorHistory = ['0'];
    });
  }

  _segmentFromStore() {
    var note = this._getStore('note');
    if (!note) return null;
    var mode = this._normalizeMode(this.getAttribute('mode'));
    return mode === 'my' ? note.myList : note.publicList;
  }

  _contextKey() {
    this._ensureStoreShape();
    var mode = this._normalizeMode(this.getAttribute('mode'));
    var segment = this._segmentFromStore();
    if (!segment) return mode;
    return [
      mode,
      String(segment.items && segment.items.length || 0),
      String(segment.cursor ?? ''),
      segment.hasMore ? '1' : '0',
      segment.isLoading ? '1' : '0',
      String(segment.error || ''),
      String(segment.page ?? ''),
      String(segment.pageSize ?? ''),
      String(segment.currentCursor ?? ''),
      Array.isArray(segment.cursorHistory) ? segment.cursorHistory.join(',') : '',
    ].join('|');
  }

  _checkContext(force) {
    var nextKey = this._contextKey();
    if (!force && nextKey === this._lastContextKey) return;
    this._lastContextKey = nextKey;
    this._syncViewFromStore();
    this.render();
  }

  _syncViewFromStore() {
    var segment = this._segmentFromStore();
    if (!segment) {
      this._items = [];
      this._loading = false;
      this._error = '';
      this._hasMore = false;
      return;
    }
    this._items = Array.isArray(segment.items) ? segment.items.slice() : [];
    this._loading = !!segment.isLoading;
    this._error = String(segment.error || '').trim();
    this._hasMore = !!segment.hasMore;
    this._page = Number(segment.page ?? 1) || 1;
    this._pageSize = Number(segment.pageSize ?? 20) || 20;
    this._currentCursor = String(segment.currentCursor ?? '0');
    this._cursorHistory = Array.isArray(segment.cursorHistory) ? segment.cursorHistory.slice() : ['0'];
    if (!this._cursorHistory.length) {
      this._cursorHistory = ['0'];
    }
  }

  _teardownObserver() {
    if (this._observer) {
      try { this._observer.disconnect(); } catch (_) {}
    }
    this._observer = null;
    this._sentinel = null;
  }

  _setupObserver() {
    this._teardownObserver();
    if (typeof IntersectionObserver === 'undefined') return;
    if (!this.shadowRoot || typeof this.shadowRoot.querySelector !== 'function') return;
    var sentinel = this.shadowRoot.querySelector('.sentinel');
    if (!sentinel) return;
    this._sentinel = sentinel;
    this._observer = new IntersectionObserver((entries) => {
      var entry = entries && entries[0] ? entries[0] : null;
      if (!entry || !entry.isIntersecting) return;
      // Pagination wiring happens in later tasks; keep this component presentational for now.
    });
    this._observer.observe(sentinel);
  }

  _renderState() {
    var mode = this._normalizeMode(this.getAttribute('mode'));
    if (this._error) {
      var title = this._t('note.list.errorTitle', 'Failed to load notes');
      return `<id-note-empty-state variant="error" title="${this._escapeAttribute(title)}" message="${this._escapeAttribute(this._error)}"></id-note-empty-state>`;
    }

    if (this._loading && (!this._items || this._items.length === 0)) {
      var loadingTitle = this._t('note.list.loadingTitle', 'Loading');
      var loadingMsg = this._t('note.list.loadingMessage', 'Loading...');
      return `<id-note-empty-state variant="loading" title="${this._escapeAttribute(loadingTitle)}" message="${this._escapeAttribute(loadingMsg)}"></id-note-empty-state>`;
    }

    if (!this._items || this._items.length === 0) {
      var emptyMsg = mode === 'my'
        ? this._t('note.list.emptyMy', 'No notes.')
        : this._t('note.list.emptyPublic', 'No notes.');
      return `<id-note-empty-state variant="empty" title="${this._escapeAttribute(this._t('note.list.emptyTitle', 'No notes'))}" message="${this._escapeAttribute(emptyMsg)}"></id-note-empty-state>`;
    }

    var cardsHtml = this._items.map((item) => {
      var json = '';
      try {
        json = JSON.stringify(item || {});
      } catch (_) {
        json = '{}';
      }
      return `<id-note-card note="${this._escapeAttribute(json)}"></id-note-card>`;
    }).join('');

    var pagerHtml = this._renderPager();
    return `<div class="grid">${cardsHtml}</div>${pagerHtml}`;
  }

  _renderPager() {
    if (!this._items || this._items.length === 0) return '';
    var mode = this._normalizeMode(this.getAttribute('mode'));
    var segment = this._segmentFromStore();
    var nextCursor = segment && segment.cursor !== undefined && segment.cursor !== null ? String(segment.cursor).trim() : '';
    var hasResolvedAddress = mode !== 'my' || !!this._resolveOwnerAddress();
    var prevAvailable = Array.isArray(this._cursorHistory) && this._cursorHistory.length > 1 && !this._loading && hasResolvedAddress;
    var nextAvailable = this._hasMore && !this._loading && nextCursor !== '' && hasResolvedAddress;
    var prevLabel = this._t('note.list.pagerPrevious', 'Previous');
    var nextLabel = this._t('note.list.pagerNext', 'Next');
    var pageLabel = String(this._t('note.list.pagerPage', 'Page {page}', { page: this._page }) || '');
    pageLabel = pageLabel.replace(/\{page\}/g, String(this._page));
    var pagerLabel = this._t('note.list.pagerLabel', 'Pagination');
    return `
      <footer class="pager" part="pager" role="group" aria-label="${this._escapeAttribute(pagerLabel)}">
        <button type="button" class="pager-button prev-button" data-action="prev"${prevAvailable ? '' : ' disabled'}>${this._escapeHtml(prevLabel)}</button>
        <span class="pager-page">${this._escapeHtml(pageLabel)}</span>
        <button type="button" class="pager-button next-button" data-action="next"${nextAvailable ? '' : ' disabled'}>${this._escapeHtml(nextLabel)}</button>
      </footer>
    `;
  }

  _wirePager() {
    this._teardownPager();
    if (!this.shadowRoot || typeof this.shadowRoot.querySelector !== 'function') return;
    var prevButton = this.shadowRoot.querySelector('[data-action="prev"]');
    var nextButton = this.shadowRoot.querySelector('[data-action="next"]');
    if (prevButton && typeof prevButton.addEventListener === 'function') {
      prevButton.addEventListener('click', this._onPagerClick);
      this._pagerPrev = prevButton;
    }
    if (nextButton && typeof nextButton.addEventListener === 'function') {
      nextButton.addEventListener('click', this._onPagerClick);
      this._pagerNext = nextButton;
    }
  }

  _teardownPager() {
    if (this._pagerPrev && typeof this._pagerPrev.removeEventListener === 'function') {
      this._pagerPrev.removeEventListener('click', this._onPagerClick);
    }
    if (this._pagerNext && typeof this._pagerNext.removeEventListener === 'function') {
      this._pagerNext.removeEventListener('click', this._onPagerClick);
    }
    this._pagerPrev = null;
    this._pagerNext = null;
  }

  _handlePagerClick(event) {
    var target = event && event.currentTarget ? event.currentTarget : event;
    var action = target && typeof target.getAttribute === 'function' ? String(target.getAttribute('data-action') || '') : '';
    if (!action) return;
    this._changePage(action);
  }

  _changePage(action) {
    return this._handlePagerAction(action);
  }

  async _handlePagerAction(action) {
    if (!action || (action !== 'next' && action !== 'prev')) return null;
    if (this._loading) return null;
    var segment = this._segmentFromStore();
    if (!segment) return null;
    var mode = this._normalizeMode(this.getAttribute('mode'));
    var commandName = mode === 'my' ? 'fetchMyNoteList' : 'fetchNoteList';
    var currentPage = Number(segment.page ?? 1) || 1;
    var pageSize = Number(segment.pageSize ?? 20) || 20;
    var history = Array.isArray(segment.cursorHistory) ? segment.cursorHistory.slice() : ['0'];
    if (!history.length) history = ['0'];
    var nextCursor = String(segment.cursor || '');
    var ownerAddress = mode === 'my' ? this._resolveOwnerAddress() : '';
    if (mode === 'my' && !ownerAddress) return null;
    if (action === 'next') {
      if (!segment.hasMore || !nextCursor) return null;
      var nextHistory = history.concat(nextCursor);
      var payload = {
        replace: true,
        cursor: nextCursor,
        size: pageSize,
        page: currentPage + 1,
        pageSize: pageSize,
        currentCursor: nextCursor,
        cursorHistory: nextHistory,
      };
      if (mode === 'my') payload.address = ownerAddress;
      return this._dispatchPagerCommand(commandName, payload);
    }
    if (action === 'prev') {
      if (history.length <= 1) return null;
      var previousHistory = history.slice(0, -1);
      var previousCursor = String(previousHistory[previousHistory.length - 1] || '0');
      var payloadPrev = {
        replace: true,
        cursor: previousCursor,
        size: pageSize,
        page: Math.max(1, currentPage - 1),
        pageSize: pageSize,
        currentCursor: previousCursor,
        cursorHistory: previousHistory,
      };
      if (mode === 'my') payloadPrev.address = ownerAddress;
      return this._dispatchPagerCommand(commandName, payloadPrev);
    }
    return null;
  }

  _dispatchPagerCommand(commandName, payload) {
    if (typeof window === 'undefined' || !window.IDFramework || typeof window.IDFramework.dispatch !== 'function') {
      return Promise.resolve(null);
    }
    this._loading = true;
    this.render();
    return Promise.resolve(window.IDFramework.dispatch(commandName, payload))
      .finally(() => {
        this._checkContext(true);
      });
  }

  _resolveOwnerAddress() {
    var wallet = this._getStore('wallet') || {};
    var userStore = this._getStore('user') || {};
    var user = userStore && userStore.user ? userStore.user : {};
    return String(wallet.address || user.address || '').trim();
  }

  _handleNoteOpen(event) {
    var detail = event && event.detail ? event.detail : {};
    var pinId = String(detail.pinId || '').trim();
    if (!pinId || typeof window === 'undefined' || !window.location || !window.history) return;
    var nextUrl = buildNoteRouteUrl(window.location, '/note/' + encodeURIComponent(pinId), window);
    if (typeof window.history.pushState === 'function') {
      window.history.pushState({}, '', nextUrl);
    }
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('id:note:navigate', {
        detail: { path: '/note/' + pinId },
      }));
    }
  }

  render() {
    if (!this.shadowRoot) return;
    var stateHtml = this._renderState();

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .wrap { display: block; }
        .grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
        }
        .pager {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid rgba(255,255,255,0.12);
        }
        .pager-page {
          font-weight: 600;
        }
        .pager-button {
          border: 0;
          border-radius: 999px;
          padding: 6px 16px;
          font-size: 13px;
          line-height: 1;
          cursor: pointer;
          background: rgba(255,255,255,0.08);
          color: inherit;
          transition: opacity 120ms ease;
        }
        .pager-button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        @media (min-width: 720px) {
          .grid { grid-template-columns: 1fr 1fr; }
        }
      </style>
      <section class="wrap">
        ${stateHtml}
      </section>
    `;

    this._wirePager();
  }
}

customElements.define('id-note-list', IdNoteList);
