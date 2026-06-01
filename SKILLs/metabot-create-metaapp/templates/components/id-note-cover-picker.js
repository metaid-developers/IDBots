import { resolveNoteCoverUrl } from '../utils/note-attachments.js';
import { fileToDataUrl } from '../utils/file-data-url.js';

class IdNoteCoverPicker extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._value = '';
  }

  static get observedAttributes() {
    return ['value', 'alt', 'upload-label', 'remove-label'];
  }

  connectedCallback() {
    this._value = String(this.getAttribute('value') || '');
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'value') this._value = String(newValue || '');
    this.render();
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _uploadLabel() {
    return String(this.getAttribute('upload-label') || 'Upload cover image');
  }

  _removeLabel() {
    return String(this.getAttribute('remove-label') || 'Remove cover');
  }

  _alt() {
    return String(this.getAttribute('alt') || 'Note cover');
  }

  _previewUrl() {
    return resolveNoteCoverUrl(this._value || '');
  }

  _emitChange(value) {
    var EventCtor = typeof CustomEvent !== 'undefined'
      ? CustomEvent
      : function MockCustomEvent(name, init) {
          return { type: name, detail: init && init.detail, bubbles: !!(init && init.bubbles), composed: !!(init && init.composed) };
        };
    this.dispatchEvent(new EventCtor('cover-change', {
      detail: { value: String(value || '') },
      bubbles: true,
      composed: true,
    }));
  }

  async _handleInputChange(event) {
    var target = event && event.currentTarget ? event.currentTarget : null;
    var file = target && target.files && target.files[0] ? target.files[0] : null;
    if (!file) return;

    try {
      var dataUrl = await fileToDataUrl(file);
      this._emitChange(dataUrl);
    } finally {
      if (target) target.value = '';
    }
  }

  render() {
    if (!this.shadowRoot) return;
    var previewUrl = this._previewUrl();
    var previewHtml = previewUrl
      ? `
        <div class="preview">
          <img class="preview-image" src="${this._escapeHtml(previewUrl)}" alt="${this._escapeHtml(this._alt())}" />
          <button type="button" class="secondary" data-action="remove">${this._escapeHtml(this._removeLabel())}</button>
        </div>
      `
      : `
        <label class="upload">
          <span>${this._escapeHtml(this._uploadLabel())}</span>
          <input type="file" accept="image/*" data-role="input" />
        </label>
      `;

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .preview,
        .upload {
          display: grid;
          gap: 10px;
        }
        .preview-image {
          width: min(100%, 320px);
          max-height: 220px;
          object-fit: cover;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.03);
        }
        .upload,
        .secondary {
          width: fit-content;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.05);
          color: rgba(255,255,255,0.92);
          cursor: pointer;
        }
        .secondary {
          background: rgba(220, 80, 80, 0.14);
          color: rgba(255, 220, 220, 0.94);
        }
        input[type="file"] { display: none; }
      </style>
      ${previewHtml}
    `;

    var input = this.shadowRoot.querySelector('[data-role="input"]');
    if (input && typeof input.addEventListener === 'function') {
      input.addEventListener('change', (event) => {
        this._handleInputChange(event).catch((error) => {
          console.error('Failed to read cover file', error);
        });
      });
    }

    var removeButton = this.shadowRoot.querySelector('[data-action="remove"]');
    if (removeButton && typeof removeButton.addEventListener === 'function') {
      removeButton.addEventListener('click', () => {
        this._emitChange('');
      });
    }
  }
}

customElements.define('id-note-cover-picker', IdNoteCoverPicker);
