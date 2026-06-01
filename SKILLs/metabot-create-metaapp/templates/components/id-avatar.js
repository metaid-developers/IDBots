/**
 * id-avatar - Reusable avatar renderer with robust fallback.
 *
 * Attributes:
 * - src: avatar URL
 * - name: display name
 * - metaid: metaid text for fallback/title
 * - size: number(px), default 40
 * - shape: circle | rounded | square, default circle
 * - alt: image alt text override
 */
class IdAvatar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._imageErrored = false;
  }

  static get observedAttributes() {
    return ['src', 'name', 'metaid', 'size', 'shape', 'alt'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'src') this._imageErrored = false;
    this.render();
  }

  _pickFirstString(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === null || value === undefined) continue;
      var text = String(value).trim();
      if (text) return text;
    }
    return '';
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _normalizeSize(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 40;
    return Math.max(16, Math.min(256, Math.round(n)));
  }

  _normalizeShape(value) {
    var shape = String(value || '').trim().toLowerCase();
    if (shape === 'square' || shape === 'rounded') return shape;
    return 'circle';
  }

  _shortMetaid(metaid) {
    var text = String(metaid || '').trim();
    if (!text) return '';
    return text.length > 8 ? text.slice(0, 8) : text;
  }

  _resolveInitial(name, metaid) {
    var source = this._pickFirstString([name, metaid]);
    if (!source) return '?';
    var normalized = source.replace(/^metaid\s*/i, '').trim();
    var match = normalized.match(/[A-Za-z0-9\u4e00-\u9fa5]/);
    return (match && match[0] ? match[0] : '?').toUpperCase();
  }

  _resolveTitle(name, metaid) {
    var n = this._pickFirstString([name]);
    var m = this._shortMetaid(metaid);
    if (n && m) return n + ' · MetaID ' + m;
    if (n) return n;
    if (m) return 'MetaID ' + m;
    return 'Unknown User';
  }

  _isUsableImage(src) {
    var text = String(src || '').trim();
    if (!text) return false;
    if (text === '/content/' || text === 'null' || text === 'undefined') return false;
    if (/\/content\/?$/i.test(text)) return false;
    if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/content\/?$/i.test(text)) return false;
    return true;
  }

  render() {
    var src = this._pickFirstString([this.getAttribute('src')]);
    var name = this._pickFirstString([this.getAttribute('name')]);
    var metaid = this._pickFirstString([this.getAttribute('metaid')]);
    var size = this._normalizeSize(this.getAttribute('size'));
    var shape = this._normalizeShape(this.getAttribute('shape'));
    var alt = this._pickFirstString([this.getAttribute('alt'), name, this._shortMetaid(metaid), 'avatar']);
    var title = this._resolveTitle(name, metaid);

    var showImage = this._isUsableImage(src) && !this._imageErrored;
    var initial = this._resolveInitial(name, metaid);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          width: ${size}px;
          height: ${size}px;
          min-width: ${size}px;
          min-height: ${size}px;
          box-sizing: border-box;
          vertical-align: middle;
        }
        .avatar {
          width: 100%;
          height: 100%;
          overflow: hidden;
          border: 1px solid var(--id-avatar-border, var(--id-border-color, #d1d5db));
          background: var(--id-avatar-bg, #e5e7eb);
          color: var(--id-avatar-text, #111827);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-sizing: border-box;
          user-select: none;
          position: relative;
        }
        .avatar.is-circle {
          border-radius: 999px;
        }
        .avatar.is-rounded {
          border-radius: 10px;
        }
        .avatar.is-square {
          border-radius: 0;
        }
        .image {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          background: transparent;
        }
        .fallback {
          font-size: ${Math.max(10, Math.floor(size * 0.44))}px;
          line-height: 1;
          font-weight: 700;
          letter-spacing: 0.02em;
          text-transform: uppercase;
          color: var(--id-avatar-fallback-text, #ffffff);
          background: var(--id-avatar-fallback-bg, #64748b);
          width: 100%;
          height: 100%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
      </style>
      <span class="avatar is-${shape}" title="${this._escapeHtml(title)}">
        ${showImage
    ? `<img class="image" src="${this._escapeHtml(src)}" alt="${this._escapeHtml(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
    : `<span class="fallback">${this._escapeHtml(initial)}</span>`
}
      </span>
    `;

    if (showImage) {
      var img = this.shadowRoot.querySelector('.image');
      if (img) {
        img.addEventListener('error', () => {
          if (this._imageErrored) return;
          this._imageErrored = true;
          this.render();
        });
      }
    }
  }
}

if (!customElements.get('id-avatar')) {
  customElements.define('id-avatar', IdAvatar);
}
