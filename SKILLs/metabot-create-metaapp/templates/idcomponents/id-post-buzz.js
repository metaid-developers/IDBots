/**
 * id-post-buzz - New buzz composer panel.
 * Emits:
 * - "buzz-posted": after successful post
 * - "close": when user clicks cancel
 */
class IdPostBuzz extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._content = '';
    this._files = [];
    this._isPosting = false;
    this._quotePin = '';
  }

  static get observedAttributes() {
    return ['quote-pin'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'quote-pin') {
      this._quotePin = newValue || '';
    }
    this.render();
  }

  connectedCallback() {
    this._quotePin = this.getAttribute('quote-pin') || '';
    this.render();
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  _reset() {
    this._content = '';
    this._files = [];
    this._isPosting = false;
    this.render();
  }

  _showMessage(type, message) {
    if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage(type, message);
      return;
    }
    if (type === 'error') {
      alert(message);
    } else {
      console.log(message);
    }
  }

  async _handlePost() {
    if (this._isPosting) return;
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') {
      this._showMessage('error', 'IDFramework is not available');
      return;
    }

    this._isPosting = true;
    this.render();

    try {
      var result = await window.IDFramework.dispatch('postBuzz', {
        content: this._content,
        files: this._files,
        quotePin: this._quotePin,
      });
      
      this._showMessage('success', 'Buzz posted successfully');
      this.dispatchEvent(new CustomEvent('buzz-posted', {
        detail: result || {},
        bubbles: true,
        composed: true,
      }));
      this._reset();
    } catch (error) {
      if (!(error && error._alreadyShown)) {
        this._showMessage('error', (error && error.message) ? error.message : 'Failed to post buzz');
      }
      this._isPosting = false;
      this.render();
    }
  }

  render() {
    var fileCards = this._files.map((file, index) => {
      var safeName = this._escapeHtml(file.name || ('file-' + index));
      var safeType = this._escapeHtml(file.type || 'application/octet-stream');
      var safeSize = this._escapeHtml(this._formatSize(file.size));
      return `
        <div class="file-card">
          <div class="file-main">
            <div class="file-name" title="${safeName}">${safeName}</div>
            <div class="file-meta">${safeType} · ${safeSize}</div>
          </div>
          <button class="file-remove" data-action="remove-file" data-file-index="${index}" aria-label="Remove">×</button>
        </div>
      `;
    }).join('');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
          color: #111827;
        }
        .wrap {
          border: 1px solid #e5e7eb;
          border-radius: 14px;
          background: #ffffff;
          padding: 14px;
        }
        .title {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
        }
        .quote {
          margin-top: 8px;
          font-size: 12px;
          color: #6b7280;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          padding: 8px 10px;
        }
        .input {
          margin-top: 12px;
          width: 100%;
          min-height: 120px;
          border: 1px solid #d1d5db;
          border-radius: 10px;
          padding: 10px 12px;
          font-size: 14px;
          line-height: 1.5;
          resize: vertical;
          box-sizing: border-box;
          outline: none;
        }
        .input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
        }
        .files {
          margin-top: 12px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 8px;
        }
        .file-card {
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          background: #f9fafb;
          padding: 8px 10px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .file-main {
          min-width: 0;
        }
        .file-name {
          font-size: 13px;
          color: #111827;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .file-meta {
          font-size: 11px;
          color: #6b7280;
          margin-top: 2px;
        }
        .file-remove {
          border: none;
          background: transparent;
          color: #9ca3af;
          font-size: 18px;
          cursor: pointer;
          line-height: 1;
          width: 24px;
          height: 24px;
          border-radius: 999px;
        }
        .file-remove:hover {
          background: #eef2ff;
          color: #1f2937;
        }
        .actions {
          margin-top: 14px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          flex-wrap: wrap;
        }
        .left-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .btn {
          border: 1px solid #d1d5db;
          background: #fff;
          color: #111827;
          border-radius: 999px;
          padding: 7px 12px;
          font-size: 13px;
          cursor: pointer;
        }
        .btn:hover {
          background: #f9fafb;
        }
        .btn-primary {
          border-color: #2563eb;
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          color: #fff;
          font-weight: 600;
        }
        .btn-primary:hover {
          filter: brightness(1.03);
        }
        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
      </style>
      <section class="wrap">
        <h3 class="title">New Buzz</h3>
        ${this._quotePin ? `<div class="quote">Quote Pin: ${this._escapeHtml(this._quotePin)}</div>` : ''}
        <textarea class="input" data-action="content-input" placeholder="What's happening?">${this._escapeHtml(this._content)}</textarea>
        ${this._files.length > 0 ? `<div class="files">${fileCards}</div>` : ''}
        <div class="actions">
          <div class="left-actions">
            <input type="file" data-action="file-input" multiple hidden />
            <button class="btn" data-action="pick-file" type="button">Add Attachment</button>
            <button class="btn" data-action="reset" type="button">Reset</button>
          </div>
          <div class="left-actions">
            <button class="btn" data-action="close" type="button">Cancel</button>
            <button class="btn btn-primary" data-action="post" type="button" ${this._isPosting ? 'disabled' : ''}>${this._isPosting ? 'Posting...' : 'Post'}</button>
          </div>
        </div>
      </section>
    `;

    var contentInput = this.shadowRoot.querySelector('[data-action="content-input"]');
    if (contentInput) {
      contentInput.addEventListener('input', (event) => {
        this._content = event.target.value || '';
      });
    }

    var fileInput = this.shadowRoot.querySelector('[data-action="file-input"]');
    var pickFileBtn = this.shadowRoot.querySelector('[data-action="pick-file"]');
    if (pickFileBtn && fileInput) {
      pickFileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (event) => {
        var list = event.target.files ? Array.from(event.target.files) : [];
        if (list.length > 0) {
          this._files = this._files.concat(list);
          this.render();
        }
        event.target.value = '';
      });
    }

    var resetBtn = this.shadowRoot.querySelector('[data-action="reset"]');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this._reset());
    }

    var closeBtn = this.shadowRoot.querySelector('[data-action="close"]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('close', { bubbles: true, composed: true }));
      });
    }

    var postBtn = this.shadowRoot.querySelector('[data-action="post"]');
    if (postBtn) {
      postBtn.addEventListener('click', () => this._handlePost());
    }

    var removeBtns = this.shadowRoot.querySelectorAll('[data-action="remove-file"]');
    removeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        var index = Number(btn.getAttribute('data-file-index'));
        if (Number.isFinite(index) && index >= 0) {
          this._files = this._files.filter(function (_, i) { return i !== index; });
          this.render();
        }
      });
    });
  }
}

if (!customElements.get('id-post-buzz')) {
  customElements.define('id-post-buzz', IdPostBuzz);
}
