import { resolveNoteCoverUrl } from '../utils/note-attachments.js';

class IdNoteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._onLocaleChanged = this.render.bind(this);
    this._onCardClick = this._handleCardClick.bind(this);
  }

  static get observedAttributes() {
    return ['note'];
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
    if (this.shadowRoot) {
      var card = this.shadowRoot.querySelector && this.shadowRoot.querySelector('.card');
      if (card && typeof card.removeEventListener === 'function') {
        card.removeEventListener('click', this._onCardClick);
      }
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'note') this.render();
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

  _parseJsonAttribute(name) {
    var raw = this.getAttribute(name);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  _normalizeText(value) {
    if (value === null || value === undefined) return '';
    return String(value);
  }

  _normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return value.reduce(function collect(result, item) {
      var text = String(item || '').trim();
      if (!text) return result;
      result.push(text);
      return result;
    }, []);
  }

  _noteViewModel() {
    var payload = this._parseJsonAttribute('note');
    var source = payload && typeof payload === 'object' ? payload : {};
    var noteData = source.noteData && typeof source.noteData === 'object' ? source.noteData : source;
    var title = this._normalizeText(noteData.title).trim();
    var subtitle = this._normalizeText(noteData.subtitle).trim();
    var content = this._normalizeText(noteData.content).trim();
    var coverImg = resolveNoteCoverUrl(this._normalizeText(noteData.coverImg).trim());
    var encryption = this._normalizeText(noteData.encryption).trim();
    var tags = this._normalizeStringList(noteData.tags);
    var attachments = Array.isArray(noteData.attachments) ? noteData.attachments : [];

    return {
      pinId: String(source.pin && source.pin.id || source.id || '').trim(),
      pin: source.pin || null,
      noteData: noteData,
      title: title || this._t('note.card.untitled', 'Untitled'),
      subtitle,
      content,
      coverImg,
      isEncrypted: !!encryption && encryption !== '0',
      tags,
      attachmentCount: attachments.length,
    };
  }

  _handleCardClick() {
    var payload = this._parseJsonAttribute('note') || {};
    var pinId = String(payload.pin && payload.pin.id || payload.id || '').trim();
    if (!pinId) return;
    var EventCtor = typeof CustomEvent !== 'undefined'
      ? CustomEvent
      : function MockCustomEvent(type, init) {
          return { type: type, detail: init && init.detail, bubbles: !!(init && init.bubbles), composed: !!(init && init.composed) };
        };
    this.dispatchEvent(new EventCtor('note-open', {
      detail: {
        pinId: pinId,
        pin: payload.pin || null,
        noteData: payload.noteData || null,
      },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this.shadowRoot) return;
    var vm = this._noteViewModel();

    var title = this._escapeHtml(vm.title);
    var subtitle = this._escapeHtml(vm.subtitle);
    var content = this._escapeHtml(vm.content);
    var coverAlt = this._escapeHtml(this._t('note.card.coverAlt', 'Note cover'));
    var encryptedLabel = this._escapeHtml(this._t('note.card.encrypted', 'Encrypted'));
    var attachmentsLabel = this._escapeHtml(this._t('note.card.attachments', 'Attachments'));

    var coverHtml = '';
    if (vm.coverImg) {
      var coverSrc = this._escapeHtml(vm.coverImg);
      coverHtml = `<div class="cover"><img src="${coverSrc}" alt="${coverAlt}" loading="lazy" /></div>`;
    }

    var badgeHtml = vm.isEncrypted
      ? `<span class="badge encrypted" title="${encryptedLabel}">${encryptedLabel}</span>`
      : '';

    var tagsHtml = '';
    if (vm.tags.length) {
      tagsHtml = `<div class="tags">${vm.tags.map((tag) => (
        `<span class="tag">${this._escapeHtml(tag)}</span>`
      )).join('')}</div>`;
    }

    var attachmentsHtml = vm.attachmentCount > 0
      ? `<span class="meta attachments">${attachmentsLabel}: ${String(vm.attachmentCount)}</span>`
      : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          display: grid;
          grid-template-columns: 92px 1fr;
          gap: 12px;
          padding: 12px;
          border-radius: 16px;
          background: rgba(8, 10, 16, 0.42);
          border: 1px solid rgba(255,255,255,0.10);
          color: rgba(255,255,255,0.88);
        }
        .cover {
          width: 92px;
          height: 92px;
          border-radius: 12px;
          overflow: hidden;
          background: rgba(255,255,255,0.06);
        }
        .cover img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .content { min-width: 0; }
        .head {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 6px;
        }
        .title {
          font-size: 14px;
          font-weight: 680;
          letter-spacing: 0.2px;
          margin: 0;
          line-height: 1.2;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .badge {
          font-size: 11px;
          padding: 3px 8px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.14);
          color: rgba(255,255,255,0.78);
          background: rgba(255,255,255,0.06);
          white-space: nowrap;
        }
        .badge.encrypted {
          border-color: rgba(255, 203, 92, 0.55);
          background: rgba(255, 203, 92, 0.10);
          color: rgba(255, 231, 160, 0.95);
        }
        .subtitle {
          margin: 0 0 10px 0;
          font-size: 12px;
          color: rgba(255,255,255,0.62);
          line-height: 1.35;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 8px 0; }
        .tag {
          font-size: 11px;
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(120, 160, 255, 0.12);
          border: 1px solid rgba(120, 160, 255, 0.18);
          color: rgba(190, 210, 255, 0.92);
        }
        .metaRow {
          display: flex;
          gap: 10px;
          align-items: center;
          font-size: 11px;
          color: rgba(255,255,255,0.56);
        }
      </style>
      <article class="card" part="card">
        ${coverHtml || '<div></div>'}
        <div class="content">
          <div class="head">
            <h3 class="title">${title}</h3>
            ${badgeHtml}
          </div>
          ${vm.subtitle ? `<p class="subtitle">${subtitle}</p>` : ''}
          ${vm.content ? `<p class="subtitle">${content}</p>` : ''}
          ${tagsHtml}
          <div class="metaRow">
            ${attachmentsHtml}
          </div>
        </div>
      </article>
    `;

    var card = this.shadowRoot.querySelector && this.shadowRoot.querySelector('.card');
    if (card && typeof card.addEventListener === 'function') {
      card.removeEventListener('click', this._onCardClick);
      card.addEventListener('click', this._onCardClick);
    }
  }
}

customElements.define('id-note-card', IdNoteCard);
