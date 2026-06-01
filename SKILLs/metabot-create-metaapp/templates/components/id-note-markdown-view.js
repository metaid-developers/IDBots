import { normalizeNoteMarkdown } from '../utils/note-markdown.js';

function escapeHtml(value) {
  if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  var div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function tryParseJson(value) {
  var text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    // best-effort for hand-written single-quote JSON in HTML attributes
    try {
      return JSON.parse(text.replace(/'/g, '"'));
    } catch (_) {
      return null;
    }
  }
}

function sanitizeHtml(html) {
  var cleaned = String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, function sanitizeUrl(match, attr, dquoted, squoted, unquoted) {
      var value = dquoted;
      if (value === undefined) value = squoted;
      if (value === undefined) value = unquoted;
      value = String(value || '');

      // Detect javascript: even when obfuscated with whitespace/control chars.
      var normalized = value
        .replace(/[\u0000-\u001F\u007F\s]+/g, '')
        .trim()
        .toLowerCase();
      if (normalized.indexOf('javascript:') === 0) {
        var lowerAttr = String(attr || '').toLowerCase();
        return lowerAttr === 'href' ? ' href="#"' : ' src=""';
      }
      return match;
    });

  return cleaned;
}

class IdNoteMarkdownView extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._content = '';
    this._attachments = [];
  }

  static get observedAttributes() {
    return ['content', 'attachments'];
  }

  connectedCallback() {
    this._content = this.getAttribute('content') || '';
    this._attachments = this._parseAttachments(this.getAttribute('attachments'));
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'content') {
      this._content = newValue || '';
    }
    if (name === 'attachments') {
      this._attachments = this._parseAttachments(newValue);
    }
    this.render();
  }

  set content(value) {
    this._content = value == null ? '' : String(value);
    this.render();
  }

  get content() {
    return this._content;
  }

  set attachments(value) {
    this._attachments = Array.isArray(value) ? value : [];
    this.render();
  }

  get attachments() {
    return this._attachments;
  }

  _parseAttachments(value) {
    if (!value) return [];
    var parsed = tryParseJson(value);
    return Array.isArray(parsed) ? parsed : [];
  }

  _getMarked() {
    if (typeof window !== 'undefined' && window && window.marked) return window.marked;
    if (typeof globalThis !== 'undefined' && globalThis.marked) return globalThis.marked;
    return null;
  }

  _renderMarkdown(markdown) {
    var marked = this._getMarked();
    if (marked && typeof marked.parse === 'function') {
      try {
        return marked.parse(markdown);
      } catch (_) {
        return '<pre class="md-fallback">' + escapeHtml(markdown) + '</pre>';
      }
    }
    return '<pre class="md-fallback">' + escapeHtml(markdown) + '</pre>';
  }

  render() {
    if (!this.shadowRoot) return;
    var normalized = normalizeNoteMarkdown(this._content, {
      attachments: this._attachments,
    });
    var html = sanitizeHtml(this._renderMarkdown(normalized));

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .content {
          font-size: 15px;
          line-height: 1.65;
          color: var(--note-markdown-text, #111827);
          background: var(--note-markdown-bg, transparent);
        }
        .md-fallback { white-space: pre-wrap; word-break: break-word; }
        .content :where(img, video) { max-width: 100%; height: auto; }
        .content :where(a) { color: var(--note-markdown-link, #2563eb); }
        .content :where(pre) {
          overflow: auto;
          padding: 12px;
          background: var(--note-markdown-code-bg, #f3f4f6);
          border-radius: 10px;
          border: 1px solid var(--note-markdown-code-border, #e5e7eb);
        }
        .content :where(code) {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          color: var(--note-markdown-code-text, inherit);
        }
      </style>
      <div class="content">${html}</div>
    `;
  }
}

customElements.define('id-note-markdown-view', IdNoteMarkdownView);
