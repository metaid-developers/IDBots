import './id-note-empty-state.js';
import './id-note-markdown-view.js';
import { buildNoteRouteUrl } from '../utils/note-route.js';
import { resolveAttachmentUrl, resolveNoteCoverUrl } from '../utils/note-attachments.js';

function normalizeAddress(value) {
  return String(value || '').trim().toLowerCase();
}

class IdNoteDetail extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastKey = '';
    this._state = {
      pinId: '',
      pin: null,
      noteData: null,
      author: null,
      error: '',
      isLoading: false,
      walletAddress: '',
    };
    this._onLocaleChanged = this.render.bind(this);
  }

  static get observedAttributes() {
    return ['pin-id'];
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
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'pin-id' && oldValue !== newValue) this._checkContext(true);
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

  _snapshotFromStores() {
    var detail = this._getStore('note') && this._getStore('note').detail ? this._getStore('note').detail : {};
    var wallet = this._getStore('wallet') || {};
    var user = this._getStore('user') && this._getStore('user').user ? this._getStore('user').user : {};
    return {
      pinId: String((detail && detail.pinId) || this.getAttribute('pin-id') || ''),
      pin: detail && detail.pin ? detail.pin : null,
      noteData: detail && detail.noteData ? detail.noteData : null,
      author: detail && detail.author ? detail.author : null,
      error: String(detail && detail.error || ''),
      isLoading: !!(detail && detail.isLoading),
      walletAddress: String(wallet.address || user.address || ''),
    };
  }

  _contextKey() {
    var state = this._snapshotFromStores();
    return JSON.stringify({
      pinId: state.pinId,
      noteData: state.noteData,
      author: state.author,
      error: state.error,
      isLoading: state.isLoading,
      walletAddress: state.walletAddress,
    });
  }

  _checkContext(force) {
    var nextKey = this._contextKey();
    if (!force && nextKey === this._lastKey) return;
    this._lastKey = nextKey;
    this._state = this._snapshotFromStores();
    this.render();
  }

  _isOwner() {
    var pinAddress = this._state.pin && this._state.pin.address ? this._state.pin.address : '';
    return !!pinAddress && normalizeAddress(pinAddress) === normalizeAddress(this._state.walletAddress);
  }

  _openEditRoute() {
    if (!this._state.pinId || typeof window === 'undefined' || !window.location || !window.history) return;
    var nextUrl = buildNoteRouteUrl(window.location, '/note/' + encodeURIComponent(this._state.pinId) + '/edit', window);
    if (typeof window.history.pushState === 'function') {
      window.history.pushState({}, '', nextUrl);
    }
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('id:note:navigate', {
        detail: { path: '/note/' + this._state.pinId + '/edit' },
      }));
    }
  }

  render() {
    if (!this.shadowRoot) return;
    var state = this._state;
    var noteData = state.noteData || null;

    var bodyHtml = '';
    if (state.error) {
      bodyHtml = `<id-note-empty-state variant="error" title="${this._escapeHtml(this._t('note.detail.errorTitle', 'Failed to load note'))}" message="${this._escapeHtml(state.error)}"></id-note-empty-state>`;
    } else if (state.isLoading && !noteData) {
      bodyHtml = `<id-note-empty-state variant="loading" title="${this._escapeHtml(this._t('note.detail.loadingTitle', 'Loading note'))}" message="${this._escapeHtml(this._t('note.detail.loadingMessage', 'Loading...'))}"></id-note-empty-state>`;
    } else if (!noteData) {
      bodyHtml = `<id-note-empty-state variant="empty" title="${this._escapeHtml(this._t('note.detail.emptyTitle', 'No note selected'))}" message="${this._escapeHtml(this._t('note.detail.emptyMessage', 'Choose a note to read.'))}"></id-note-empty-state>`;
    } else {
      var tags = Array.isArray(noteData.tags) ? noteData.tags : [];
      var attachments = Array.isArray(noteData.attachments) ? noteData.attachments : [];
      var attachmentItems = attachments.map((attachment, index) => {
        var href = this._escapeHtml(resolveAttachmentUrl(attachment));
        var label = this._escapeHtml(this._t('note.detail.attachmentItem', 'Attachment {index}', { index: index + 1 }) || ('Attachment ' + (index + 1)));
        return `<a class="attachment" href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
      }).join('');
      var attachmentsSection = attachments.length
        ? `<section class="attachments"><h2>${this._escapeHtml(this._t('note.detail.attachments', 'Attachments'))}</h2><div class="attachmentGrid">${attachmentItems}</div></section>`
        : '';
      var coverUrl = resolveNoteCoverUrl(noteData.coverImg || '');
      bodyHtml = `
        <article class="detail">
          <header class="header">
            <div class="meta">
              <p class="eyebrow">${this._escapeHtml((state.author && state.author.name) || (state.pin && state.pin.address) || this._t('note.detail.unknownAuthor', 'Unknown'))}</p>
              <h1 class="title">${this._escapeHtml(noteData.title || this._t('note.card.untitled', 'Untitled'))}</h1>
              ${noteData.subtitle ? `<p class="subtitle">${this._escapeHtml(noteData.subtitle)}</p>` : ''}
            </div>
            ${this._isOwner() ? `<button type="button" class="edit" data-role="edit">${this._escapeHtml(this._t('note.detail.edit', 'Edit'))}</button>` : ''}
          </header>
          ${coverUrl ? `<img class="cover" src="${this._escapeHtml(coverUrl)}" alt="${this._escapeHtml(noteData.title || 'Note cover')}" loading="lazy" />` : ''}
          ${tags.length ? `<div class="tags">${tags.map((tag) => `<span class="tag">${this._escapeHtml(tag)}</span>`).join('')}</div>` : ''}
          <div class="body-shell">
            <id-note-markdown-view content="${this._escapeHtml(noteData.content || '')}" attachments="${this._escapeHtml(JSON.stringify(attachments))}"></id-note-markdown-view>
            ${attachmentsSection}
          </div>
        </article>
      `;
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .detail {
          display: grid;
          gap: 16px;
          padding: 18px;
          border-radius: 18px;
          background: rgba(7, 10, 18, 0.54);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.9);
        }
        .body-shell {
          background: var(--note-detail-body-bg, #f8fafc);
          color: var(--note-detail-body-text, #0f172a);
          border-radius: 16px;
          padding: 24px;
          border: 1px solid rgba(15, 23, 42, 0.12);
          box-shadow: 0 16px 42px rgba(15, 23, 42, 0.4);
          display: grid;
          gap: 18px;
          --note-markdown-text: var(--note-detail-body-text, #0f172a);
          --note-markdown-link: var(--note-detail-body-link, #1d4ed8);
          --note-markdown-code-bg: var(--note-detail-body-code-bg, #f3f4f6);
          --note-markdown-code-border: var(--note-detail-body-code-border, #d1d5db);
          --note-markdown-bg: var(--note-detail-body-bg, #f8fafc);
        }
        .header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
        }
        .eyebrow {
          margin: 0 0 8px 0;
          font-size: 12px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255,255,255,0.55);
        }
        .title { margin: 0; font-size: 28px; line-height: 1.08; }
        .subtitle { margin: 8px 0 0 0; color: rgba(255,255,255,0.72); }
        .edit {
          border: 0;
          padding: 9px 14px;
          border-radius: 999px;
          background: rgba(120, 160, 255, 0.18);
          color: rgba(226, 236, 255, 0.96);
          cursor: pointer;
        }
        .cover {
          width: 100%;
          border-radius: 16px;
          max-height: 320px;
          object-fit: cover;
        }
        .tags { display: flex; gap: 8px; flex-wrap: wrap; }
        .tag {
          border-radius: 999px;
          padding: 4px 10px;
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.76);
          font-size: 12px;
        }
        .attachments { display: grid; gap: 10px; margin: 0; }
        .attachments h2 { margin: 0; font-size: 16px; }
        .attachmentGrid { display: grid; gap: 8px; }
        .attachment {
          display: inline-flex;
          padding: 10px 12px;
          border-radius: 12px;
          background: var(--note-detail-body-bg, #f8fafc);
          border: 1px solid rgba(15, 23, 42, 0.12);
          color: var(--note-detail-body-text, #0f172a);
          text-decoration: none;
          word-break: break-all;
        }
      </style>
      ${bodyHtml}
    `;

    if (!this.shadowRoot.querySelector) return;
    var editButton = this.shadowRoot.querySelector('[data-role="edit"]');
    if (editButton && typeof editButton.addEventListener === 'function') {
      editButton.addEventListener('click', () => this._openEditRoute());
    }
  }
}

customElements.define('id-note-detail', IdNoteDetail);
