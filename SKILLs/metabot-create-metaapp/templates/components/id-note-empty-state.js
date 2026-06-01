class IdNoteEmptyState extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._onLocaleChanged = this.render.bind(this);
  }

  static get observedAttributes() {
    return ['variant', 'title', 'message'];
  }

  connectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this.render();
  }

  disconnectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  attributeChangedCallback(_name, _oldValue, _newValue) {
    if (!this.shadowRoot) return;
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

  _variant() {
    var raw = String(this.getAttribute('variant') || '').trim().toLowerCase();
    if (raw === 'error' || raw === 'loading') return raw;
    return 'empty';
  }

  _resolvedTitle(variant) {
    var attr = String(this.getAttribute('title') || '').trim();
    if (attr) return attr;
    if (variant === 'loading') return this._t('note.state.loadingTitle', 'Loading');
    if (variant === 'error') return this._t('note.state.errorTitle', 'Something went wrong');
    return this._t('note.state.emptyTitle', 'Nothing here yet');
  }

  _resolvedMessage(variant) {
    var attr = String(this.getAttribute('message') || '').trim();
    if (attr) return attr;
    if (variant === 'loading') return this._t('note.state.loadingMessage', 'Loading...');
    if (variant === 'error') return this._t('note.state.errorMessage', 'Please try again later.');
    return this._t('note.state.emptyMessage', 'No notes.');
  }

  render() {
    if (!this.shadowRoot) return;
    var variant = this._variant();
    var title = this._escapeHtml(this._resolvedTitle(variant));
    var message = this._escapeHtml(this._resolvedMessage(variant));

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .wrap {
          border: 1px dashed rgba(255,255,255,0.16);
          border-radius: 14px;
          padding: 18px 16px;
          background: rgba(8, 10, 16, 0.35);
          color: rgba(255,255,255,0.86);
        }
        .title { font-size: 14px; font-weight: 650; margin: 0 0 6px 0; letter-spacing: 0.2px; }
        .msg { font-size: 12px; margin: 0; color: rgba(255,255,255,0.64); line-height: 1.5; }
        .wrap[data-variant="error"] { border-style: solid; border-color: rgba(220, 80, 80, 0.45); }
        .wrap[data-variant="loading"] { border-style: solid; border-color: rgba(120, 160, 255, 0.35); }
      </style>
      <div class="wrap" data-variant="${variant}">
        <p class="title">${title}</p>
        <p class="msg">${message}</p>
      </div>
    `;
  }
}

customElements.define('id-note-empty-state', IdNoteEmptyState);
