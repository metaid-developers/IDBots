/**
 * id-note-markdown-editor
 * Stable markdown input built on a native textarea.
 *
 * Attributes:
 * - value: markdown string
 * - placeholder: placeholder text
 *
 * Events:
 * - input: { value }
 */
class IdNoteMarkdownEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._value = '';
    this._placeholder = '';
    this._vditor = null;
    this._textareaId = 'md-' + Math.random().toString(36).slice(2);
  }

  static get observedAttributes() {
    return ['value', 'placeholder'];
  }

  connectedCallback() {
    this._value = this.getAttribute('value') || '';
    this._placeholder = this.getAttribute('placeholder') || '';
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'value') {
      this._value = newValue || '';
      this._syncTextareaValue();
    }
    if (name === 'placeholder') {
      this._placeholder = newValue || '';
      this._syncTextareaPlaceholder();
    }
  }

  set value(next) {
    this._value = next == null ? '' : String(next);
    this.setAttribute('value', this._value);
  }

  get value() {
    return this._value;
  }

  set placeholder(next) {
    this._placeholder = next == null ? '' : String(next);
    this.setAttribute('placeholder', this._placeholder);
  }

  get placeholder() {
    return this._placeholder;
  }

  _syncTextareaValue() {
    if (!this.shadowRoot) return;
    var textarea = this.shadowRoot.querySelector('textarea');
    if (textarea) textarea.value = this._value;
  }

  _syncTextareaPlaceholder() {
    if (!this.shadowRoot) return;
    var textarea = this.shadowRoot.querySelector('textarea');
    if (textarea) textarea.placeholder = this._placeholder;
  }

  _emitInput() {
    var EventCtor = (typeof CustomEvent !== 'undefined')
      ? CustomEvent
      : function MockCustomEvent(type, init) {
        return { type: type, detail: init && init.detail, bubbles: !!(init && init.bubbles), composed: !!(init && init.composed) };
      };
    this.dispatchEvent(new EventCtor('input', {
      detail: { value: this._value },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .wrap {
          display: grid;
          gap: 8px;
        }
        .helper {
          margin: 0;
          font-size: 12px;
          line-height: 1.5;
          color: rgba(255,255,255,0.58);
        }
        .editor {
          width: 100%;
          min-height: 320px;
          resize: vertical;
          box-sizing: border-box;
          padding: 14px 16px;
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 14px;
          background: rgba(12, 18, 30, 0.88);
          color: rgba(241, 245, 249, 0.96);
          font: 14px/1.7 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          outline: none;
        }
        .editor:focus {
          border-color: rgba(120, 160, 255, 0.56);
          box-shadow: 0 0 0 3px rgba(120, 160, 255, 0.14);
        }
        .editor::placeholder {
          color: rgba(148, 163, 184, 0.72);
        }
      </style>
      <div class="wrap">
        <p class="helper">Markdown</p>
        <textarea id="${this._textareaId}" class="editor" placeholder="${this._escapeAttr(this._placeholder)}"></textarea>
      </div>
    `;

    var textarea = this.shadowRoot.querySelector('textarea');
    if (textarea) {
      textarea.value = this._value;
      textarea.oninput = (event) => {
        this._value = event && event.target ? String(event.target.value || '') : '';
        this._emitInput();
      };
    }
  }

  _escapeAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

customElements.define('id-note-markdown-editor', IdNoteMarkdownEditor);
