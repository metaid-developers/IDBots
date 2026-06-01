class IdNoteAttachmentPicker extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._items = [];
  }

  static get observedAttributes() {
    return ['items'];
  }

  connectedCallback() {
    if (this.getAttribute('items') !== null) {
      this._items = this._parseItems(this.getAttribute('items'));
    }
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'items') {
      this._items = this._parseItems(newValue);
      this.render();
    }
  }

  set items(value) {
    this._items = Array.isArray(value) ? value.slice() : [];
    this.render();
  }

  get items() {
    return this._items.slice();
  }

  _parseItems(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.slice();
    try {
      var parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _previewUrl(item) {
    if (!item || typeof item !== 'object') return '';
    return String(item.blobUrl || item.uploadedUri || item.uri || item.url || '').trim();
  }

  _label(item) {
    if (!item || typeof item !== 'object') return 'Attachment';
    return String(item.name || item.mediaId || item.uri || item.url || 'Attachment').trim() || 'Attachment';
  }

  _kind(item) {
    var type = String(item && item.type || '').toLowerCase();
    if (type.indexOf('image/') === 0) return 'image';
    if (type.indexOf('video/') === 0) return 'video';
    if (type.indexOf('audio/') === 0) return 'audio';
    return 'file';
  }

  _emit(type, detail) {
    var EventCtor = typeof CustomEvent !== 'undefined'
      ? CustomEvent
      : function MockCustomEvent(name, init) {
          return { type: name, detail: init && init.detail, bubbles: !!(init && init.bubbles), composed: !!(init && init.composed) };
        };
    this.dispatchEvent(new EventCtor(type, { detail: detail, bubbles: true, composed: true }));
  }

  _emitRemove(index) {
    var item = this._items[index] || null;
    this._emit('attachment-remove', { index: index, item: item });
  }

  _emitPreview(index) {
    var item = this._items[index] || null;
    this._emit('attachment-preview', { index: index, item: item });
  }

  _emitAdd(files) {
    this._emit('attachment-add', {
      files: Array.isArray(files) ? files : Array.from(files || []),
    });
  }

  render() {
    if (!this.shadowRoot) return;
    var rowsHtml = this._items.map((item, index) => {
      var label = this._escapeHtml(this._label(item));
      var preview = this._escapeHtml(this._previewUrl(item));
      var kind = this._kind(item);
      var mediaHtml = preview
        ? kind === 'image'
          ? `<img class="thumb" src="${preview}" alt="${label}" loading="lazy" />`
          : `<span class="meta">${preview}</span>`
        : `<span class="meta">${label}</span>`;
      return `
        <div class="row" data-index="${String(index)}">
          <button type="button" class="preview" data-action="preview" data-index="${String(index)}">${mediaHtml}</button>
          <div class="info">
            <p class="name">${label}</p>
          </div>
          <button type="button" class="remove" data-action="remove" data-index="${String(index)}">Remove</button>
        </div>
      `;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .wrap { display: grid; gap: 10px; }
        .toolbar { display: flex; gap: 8px; align-items: center; }
        .add {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          color: inherit;
          cursor: pointer;
        }
        .rows { display: grid; gap: 10px; }
        .row {
          display: grid;
          grid-template-columns: minmax(88px, 120px) 1fr auto;
          gap: 10px;
          align-items: center;
          padding: 10px;
          border-radius: 12px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.08);
        }
        .preview {
          border: 0;
          padding: 0;
          background: transparent;
          cursor: pointer;
          text-align: left;
        }
        .thumb {
          width: 100%;
          max-width: 110px;
          height: 72px;
          object-fit: cover;
          border-radius: 10px;
          display: block;
        }
        .name { margin: 0; font-size: 13px; color: rgba(255,255,255,0.86); word-break: break-word; }
        .meta { font-size: 11px; color: rgba(255,255,255,0.56); word-break: break-all; }
        .remove {
          border: 0;
          padding: 7px 10px;
          border-radius: 999px;
          background: rgba(220, 80, 80, 0.14);
          color: rgba(255, 220, 220, 0.94);
          cursor: pointer;
        }
        input[type="file"] { display: none; }
      </style>
      <div class="wrap">
        <div class="toolbar">
          <label class="add">
            <span>Add attachments</span>
            <input type="file" multiple data-role="input" />
          </label>
        </div>
        <div class="rows">${rowsHtml}</div>
      </div>
    `;

    if (!this.shadowRoot.querySelectorAll) return;

    var input = this.shadowRoot.querySelector('[data-role="input"]');
    if (input && typeof input.addEventListener === 'function') {
      input.addEventListener('change', (event) => {
        var files = event && event.target && event.target.files ? Array.from(event.target.files) : [];
        this._emitAdd(files);
      });
    }

    var buttons = this.shadowRoot.querySelectorAll('[data-action]');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      if (!button || typeof button.addEventListener !== 'function') continue;
      button.addEventListener('click', (event) => {
        var target = event && event.currentTarget ? event.currentTarget : button;
        var action = String(target && target.getAttribute ? target.getAttribute('data-action') || '' : '');
        var index = Number(target && target.getAttribute ? target.getAttribute('data-index') || -1 : -1);
        if (action === 'remove') {
          this._emitRemove(index);
          return;
        }
        if (action === 'preview') this._emitPreview(index);
      });
    }
  }
}

customElements.define('id-note-attachment-picker', IdNoteAttachmentPicker);
