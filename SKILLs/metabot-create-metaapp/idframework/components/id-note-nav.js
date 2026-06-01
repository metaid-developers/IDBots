import { buildNoteRouteUrl, getCurrentNoteRouteUrl } from '../utils/note-route.js';

class IdNoteNav extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastKey = '';
    this._activeView = 'list';
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    this._syncFromStore();
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this.render();
    this._watchTimer = setInterval(() => this._checkContext(), 280);
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

  _handleLocaleChanged() {
    this.render();
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

  _routeViewFromStores() {
    var note = this._getStore('note');
    var app = this._getStore('app');
    var view = note && note.route && note.route.view ? String(note.route.view) : '';
    if (!view && app && app.route && app.route.view) view = String(app.route.view);
    view = view.trim().toLowerCase();
    if (view === 'mynote' || view === 'draft' || view === 'detail' || view === 'editor') return view;
    return 'list';
  }

  _syncFromStore() {
    this._activeView = this._routeViewFromStores();
  }

  _contextKey() {
    return this._routeViewFromStores();
  }

  _checkContext() {
    var next = this._contextKey();
    if (next === this._lastKey) return;
    this._lastKey = next;
    this._syncFromStore();
    this.render();
  }

  _setBrowserPath(path) {
    if (typeof window === 'undefined' || !window.location || !window.history) return;
    var nextUrl = buildNoteRouteUrl(window.location, path, window);
    if (getCurrentNoteRouteUrl(window.location, window) === nextUrl) return;
    window.history.pushState({}, '', nextUrl);
    window.dispatchEvent(new CustomEvent('id:note:navigate', { detail: { path }, bubbles: true, composed: true }));
  }

  _handleClick(event, path) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    this._setBrowserPath(path);
  }

  render() {
    if (!this.shadowRoot) return;
    var labelPublic = this._escapeHtml(this._t('note.nav.public', 'Public'));
    var labelMy = this._escapeHtml(this._t('note.nav.my', 'My Notes'));
    var labelDraft = this._escapeHtml(this._t('note.nav.draft', 'Drafts'));
    var labelNew = this._escapeHtml(this._t('note.nav.new', 'New Note'));

    var active = this._activeView;
    var isPublic = active === 'list';
    var isMy = active === 'mynote';
    var isDraft = active === 'draft';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 4px 14px 4px;
        }
        .tabs { display: flex; gap: 8px; flex-wrap: wrap; }
        a {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          text-decoration: none;
          font-size: 12px;
          padding: 7px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.10);
          color: rgba(255,255,255,0.72);
          background: rgba(255,255,255,0.04);
        }
        a[data-active="true"] {
          border-color: rgba(120, 160, 255, 0.38);
          background: rgba(120, 160, 255, 0.14);
          color: rgba(220, 232, 255, 0.96);
        }
        .cta {
          border-color: rgba(255, 203, 92, 0.38);
          background: rgba(255, 203, 92, 0.12);
          color: rgba(255, 240, 200, 0.96);
        }
      </style>
      <nav part="nav" aria-label="${this._escapeHtml(this._t('note.nav.aria', 'Note navigation'))}">
        <div class="tabs">
          <a href="#/" data-role="public" data-active="${isPublic ? 'true' : 'false'}">${labelPublic}</a>
          <a href="#/mynote" data-role="my" data-active="${isMy ? 'true' : 'false'}">${labelMy}</a>
          <a href="#/draft" data-role="draft" data-active="${isDraft ? 'true' : 'false'}">${labelDraft}</a>
        </div>
        <a href="#/note/new" class="cta" data-role="new">${labelNew}</a>
      </nav>
    `;

    var links = this.shadowRoot.querySelectorAll ? this.shadowRoot.querySelectorAll('a') : [];
    var self = this;
    for (var i = 0; i < links.length; i += 1) {
      var link = links[i];
      if (!link || typeof link.addEventListener !== 'function') continue;
      (function attach(current) {
        current.addEventListener('click', function handle(event) {
          var role = current.getAttribute('data-role');
          if (role === 'my') return self._handleClick(event, '/mynote');
          if (role === 'draft') return self._handleClick(event, '/draft');
          if (role === 'new') return self._handleClick(event, '/note/new');
          return self._handleClick(event, '/');
        });
      })(link);
    }
  }
}

customElements.define('id-note-nav', IdNoteNav);
