import './id-note-empty-state.js';
import { buildNoteRouteUrl } from '../utils/note-route.js';

class IdNoteDraftList extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastKey = '';
    this._state = { items: [], isLoading: false, error: '' };
    this._onLocaleChanged = this.render.bind(this);
  }

  connectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this._checkContext(true);
    this._watchTimer = setInterval(() => this._checkContext(false), 260);
    if (this._watchTimer && typeof this._watchTimer.unref === 'function') this._watchTimer.unref();
  }

  disconnectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    if (this._watchTimer) clearInterval(this._watchTimer);
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

  _snapshot() {
    var draft = this._getStore('draft') || {};
    return {
      items: Array.isArray(draft.items) ? draft.items.slice() : [],
      isLoading: !!draft.isLoading,
      error: String(draft.error || ''),
    };
  }

  _checkContext(force) {
    var nextState = this._snapshot();
    var nextKey = JSON.stringify(nextState);
    if (!force && nextKey === this._lastKey) return;
    this._lastKey = nextKey;
    this._state = nextState;
    this.render();
  }

  _navigateToDraft(draftId) {
    if (typeof window !== 'undefined' && window && window.location && window.history && typeof window.history.pushState === 'function') {
      var nextUrl = buildNoteRouteUrl(window.location, '/note/new?draftId=' + encodeURIComponent(String(draftId || '')), window);
      window.history.pushState({}, '', nextUrl);
    }
    if (typeof this.dispatchEvent === 'function') {
      this.dispatchEvent(new CustomEvent('draft-open', {
        detail: { draftId: draftId },
        bubbles: true,
        composed: true,
      }));
    }
  }

  _deleteDraft(draftId) {
    if (typeof window !== 'undefined' && window.IDFramework && typeof window.IDFramework.dispatch === 'function') {
      window.IDFramework.dispatch('deleteDraft', { draftId: draftId }).catch(function ignore() {});
    }
    this.dispatchEvent(new CustomEvent('draft-delete', {
      detail: { draftId: draftId },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this.shadowRoot) return;
    var state = this._state;
    var bodyHtml = '';
    if (state.error) {
      bodyHtml = `<id-note-empty-state variant="error" title="${this._escapeHtml(this._t('note.draft.errorTitle', 'Failed to load drafts'))}" message="${this._escapeHtml(state.error)}"></id-note-empty-state>`;
    } else if (state.isLoading && state.items.length === 0) {
      bodyHtml = `<id-note-empty-state variant="loading" title="${this._escapeHtml(this._t('note.draft.loadingTitle', 'Loading drafts'))}" message="${this._escapeHtml(this._t('note.draft.loadingMessage', 'Loading...'))}"></id-note-empty-state>`;
    } else if (state.items.length === 0) {
      bodyHtml = `<id-note-empty-state variant="empty" title="${this._escapeHtml(this._t('note.draft.emptyTitle', 'No drafts'))}" message="${this._escapeHtml(this._t('note.draft.emptyMessage', 'Autosaved drafts will appear here.'))}"></id-note-empty-state>`;
    } else {
      bodyHtml = state.items.map((item) => `
        <article class="card" data-id="${String(item.id)}">
          <div class="copy">
            <h3>${this._escapeHtml(item.title || this._t('note.card.untitled', 'Untitled'))}</h3>
            <p>${this._escapeHtml(item.subtitle || item.content || '')}</p>
          </div>
          <div class="actions">
            <button type="button" data-action="open" data-id="${String(item.id)}">${this._escapeHtml(this._t('note.draft.open', 'Open'))}</button>
            <button type="button" data-action="delete" data-id="${String(item.id)}">${this._escapeHtml(this._t('note.draft.delete', 'Delete'))}</button>
          </div>
        </article>
      `).join('');
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 12px;
          align-items: center;
          padding: 14px;
          border-radius: 14px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
          margin-bottom: 10px;
          color: rgba(255,255,255,0.88);
        }
        .copy h3 { margin: 0 0 6px 0; font-size: 16px; }
        .copy p { margin: 0; font-size: 12px; color: rgba(255,255,255,0.62); }
        .actions { display: flex; gap: 8px; }
        .actions button {
          border: 0;
          border-radius: 999px;
          padding: 8px 12px;
          cursor: pointer;
          background: rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.9);
        }
      </style>
      <div class="list">${bodyHtml}</div>
    `;

    if (!this.shadowRoot.querySelectorAll) return;
    var buttons = this.shadowRoot.querySelectorAll('[data-action]');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      if (!button || typeof button.addEventListener !== 'function') continue;
      button.addEventListener('click', (event) => {
        var target = event && event.currentTarget ? event.currentTarget : button;
        var action = String(target && target.getAttribute ? target.getAttribute('data-action') || '' : '');
        var draftId = Number(target && target.getAttribute ? target.getAttribute('data-id') || 0 : 0);
        if (action === 'delete') return this._deleteDraft(draftId);
        return this._navigateToDraft(draftId);
      });
    }
  }
}

customElements.define('id-note-draft-list', IdNoteDraftList);
