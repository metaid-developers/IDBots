import './id-note-nav.js';
import './id-note-list.js';
import './id-note-empty-state.js';

class IdNoteShell extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastKey = '';
    this._view = 'list';
    this._params = {};
    this._onLocaleChanged = this.render.bind(this);
  }

  connectedCallback() {
    this._ensureStoreShape();
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this._checkContext(true);
    this._watchTimer = setInterval(() => this._checkContext(false), 240);
    if (this._watchTimer && typeof this._watchTimer.unref === 'function') this._watchTimer.unref();
  }

  disconnectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
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

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureStoreShape() {
    var app = this._getStore('app');
    if (app && (!app.route || typeof app.route !== 'object')) {
      app.route = { path: '/', view: 'list', params: {}, query: {} };
    }
    var note = this._getStore('note');
    if (note && (!note.route || typeof note.route !== 'object')) {
      note.route = { path: '/', view: 'list', params: {}, query: {} };
    }
  }

  _routeFromStores() {
    this._ensureStoreShape();
    var note = this._getStore('note');
    var app = this._getStore('app');
    var route = (note && note.route && typeof note.route === 'object') ? note.route
      : (app && app.route && typeof app.route === 'object') ? app.route
        : { path: '/', view: 'list', params: {}, query: {} };
    var view = String(route.view || '').trim().toLowerCase();
    if (view !== 'mynote' && view !== 'draft' && view !== 'detail' && view !== 'editor') view = 'list';
    var params = route.params && typeof route.params === 'object' ? route.params : {};
    return { view, params };
  }

  _contextKey() {
    var route = this._routeFromStores();
    return [route.view, String(route.params && route.params.id || '')].join('|');
  }

  _checkContext(force) {
    var next = this._contextKey();
    if (!force && next === this._lastKey) return;
    this._lastKey = next;
    var route = this._routeFromStores();
    this._view = route.view;
    this._params = route.params;
    this.render();
  }

  _renderMain() {
    var view = this._view;
    var id = this._params && this._params.id ? String(this._params.id) : '';
    var safeId = this._escapeHtml(id);

    if (view === 'list') {
      return `<id-note-list mode="public"></id-note-list>`;
    }
    if (view === 'mynote') {
      return `<id-note-list mode="my"></id-note-list>`;
    }
    if (view === 'draft') {
      return `<id-note-draft-list></id-note-draft-list>`;
    }
    if (view === 'detail') {
      return `<id-note-detail pin-id="${safeId}"></id-note-detail>`;
    }
    if (view === 'editor') {
      return `<id-note-editor pin-id="${safeId}"></id-note-editor>`;
    }

    return `<id-note-empty-state variant="empty" title="${this._escapeHtml(this._t('note.shell.unknownTitle', 'Unknown view'))}" message="${this._escapeHtml(this._t('note.shell.unknownMessage', 'No matching view.'))}"></id-note-empty-state>`;
  }

  render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .shell {
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 8px;
          padding: 8px 10px 18px 10px;
        }
        .main { min-height: 42vh; }
      </style>
      <div class="shell" part="shell">
        <id-note-nav></id-note-nav>
        <main class="main" part="main">
          ${this._renderMain()}
        </main>
      </div>
    `;
  }
}

customElements.define('id-note-shell', IdNoteShell);
