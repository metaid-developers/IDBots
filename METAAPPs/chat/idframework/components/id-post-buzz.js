/**
 * id-post-buzz - New buzz composer panel.
 * Emits:
 * - "buzz-posted": after successful post
 * - "close": when user clicks cancel
 */
import './id-avatar.js';

class IdPostBuzz extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._content = '';
    this._files = [];
    this._imageItems = [];
    this._isPosting = false;
    this._quotePin = '';
    this._quotePreviewLoading = false;
    this._quotePreviewError = '';
    this._quotePreview = null;
    this._quoteLoadToken = 0;
    this._quoteCache = new Map();
    this._userInfoCache = new Map();
    this._emojiPanelOpen = false;
    this._maxImages = 9;
    this._maxImageBytes = 10 * 1024 * 1024;
    this._fileInputId = 'post-buzz-file-' + Math.random().toString(36).slice(2);
    this._onDocPointerDown = this._handleOutsidePointerDown.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  static get observedAttributes() {
    return ['quote-pin'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'quote-pin') {
      this._setQuotePin(newValue || '');
      return;
    }
    this.render();
  }

  connectedCallback() {
    document.addEventListener('pointerdown', this._onDocPointerDown);
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    this._setQuotePin(this.getAttribute('quote-pin') || '');
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._onDocPointerDown);
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    this._clearImageItems();
  }

  _normalizePinId(value) {
    var text = String(value || '').trim();
    if (!text) return '';

    var match = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (match && match[0]) return match[0];

    var cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.indexOf('metafile://') === 0) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.indexOf('/pin/') >= 0) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.indexOf('/content/') >= 0) cleaned = cleaned.split('/content/').pop() || '';

    match = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    return match && match[0] ? match[0] : String(cleaned || '').trim();
  }

  _setQuotePin(nextValue) {
    var normalized = this._normalizePinId(nextValue || '');
    if (normalized === this._quotePin) return;

    this._quotePin = normalized;
    this._quotePreview = null;
    this._quotePreviewError = '';
    this._quotePreviewLoading = false;
    this.render();
    this._loadQuotePreview();
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _handleLocaleChanged() {
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

  _formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  _pickFirstString(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') {
        var text = value.trim();
        if (text) return text;
        continue;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        var converted = String(value).trim();
        if (converted) return converted;
      }
    }
    return '';
  }

  _looksLikeJson(text) {
    if (!text) return false;
    var first = text[0];
    var last = text[text.length - 1];
    return (first === '{' && last === '}') || (first === '[' && last === ']');
  }

  _tryParseJsonObject(rawValue) {
    if (!rawValue) return null;
    if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue !== 'string') return null;
    var text = rawValue.trim();
    if (!text || !this._looksLikeJson(text)) return null;
    try {
      var parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      return null;
    } catch (_) {
      return null;
    }
  }

  _pickBuzzPayload(pin) {
    var candidates = [
      this._tryParseJsonObject(pin && pin.content),
      this._tryParseJsonObject(pin && pin.contentSummary),
      this._tryParseJsonObject(pin && pin.contentBody),
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var payload = candidates[i];
      if (!payload || typeof payload !== 'object') continue;
      if (payload.content !== undefined ||
        payload.publicContent !== undefined ||
        payload.text !== undefined ||
        payload.message !== undefined) {
        return payload;
      }
    }
    for (var j = 0; j < candidates.length; j += 1) {
      if (candidates[j] && typeof candidates[j] === 'object') return candidates[j];
    }
    return {};
  }

  _extractBuzzContent(pin, payload) {
    var fromPayload = this._pickFirstString([
      payload && payload.content,
      payload && payload.publicContent,
      payload && payload.text,
      payload && payload.message,
    ]);
    if (fromPayload) return fromPayload;

    var direct = this._pickFirstString([
      pin && pin.content,
      pin && pin.contentSummary,
      pin && pin.contentBody,
    ]);
    if (!direct) return '';
    if (this._looksLikeJson(direct)) return '';
    return direct;
  }

  _normalizeTimestamp(raw) {
    var value = Number(raw || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value < 1000000000000) value *= 1000;
    return Math.floor(value);
  }

  _formatTime(timestamp) {
    var value = Number(timestamp || 0);
    if (!Number.isFinite(value) || value <= 0) return '--';
    try {
      return new Date(value).toLocaleString();
    } catch (_) {
      return '--';
    }
  }

  _formatMetaId(metaId) {
    var text = String(metaId || '').trim();
    if (!text) return '';
    return text.slice(0, 8);
  }

  _resolveAvatarUrl(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    if (/^https?:\/\//i.test(text)) return text;
    if (text.indexOf('//') === 0) {
      var protocol = (typeof window !== 'undefined' && window.location && window.location.protocol)
        ? window.location.protocol
        : 'https:';
      return protocol + text;
    }
    if (text[0] === '/') {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var manBase = String(serviceLocator.metaid_man || 'https://www.show.now/man').replace(/\/+$/, '');
      return manBase + text;
    }
    return text;
  }

  async _fetchUserInfoByAddress(address) {
    var normalizedAddress = String(address || '').trim();
    if (!normalizedAddress) {
      return { name: '', metaId: '', avatar: '', address: '' };
    }

    if (this._userInfoCache.has(normalizedAddress)) {
      return this._userInfoCache.get(normalizedAddress);
    }

    try {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var base = String(
        serviceLocator.metafs ||
        (window.IDConfig && window.IDConfig.METAFS_BASE_URL) ||
        'https://file.metaid.io/metafile-indexer/api/v1'
      ).replace(/\/+$/, '');
      var prefix = base.toLowerCase().slice(-3) === '/v1' ? '' : '/v1';

      var response = await fetch(base + prefix + '/users/address/' + encodeURIComponent(normalizedAddress), {
        method: 'GET',
      });
      if (!response.ok) throw new Error('fetch user info failed');
      var json = await response.json();

      var payload = json;
      if (json && typeof json.code === 'number') payload = json.data || {};
      if (json && json.data && typeof json.data === 'object' && !json.code) payload = json.data;

      var normalized = {
        name: this._pickFirstString([payload && payload.name, payload && payload.nickName, payload && payload.nickname]),
        metaId: this._pickFirstString([
          payload && payload.metaId,
          payload && payload.metaid,
          payload && payload.globalMetaId,
          payload && payload.globalmetaid,
        ]),
        avatar: this._resolveAvatarUrl(this._pickFirstString([payload && payload.avatar, payload && payload.avatarUrl])),
        address: this._pickFirstString([payload && payload.address, normalizedAddress]) || normalizedAddress,
      };

      this._userInfoCache.set(normalizedAddress, normalized);
      return normalized;
    } catch (_) {
      var fallback = { name: '', metaId: '', avatar: '', address: normalizedAddress };
      this._userInfoCache.set(normalizedAddress, fallback);
      return fallback;
    }
  }

  async _loadQuotePreview() {
    var pinId = String(this._quotePin || '').trim();
    if (!pinId) {
      this._quotePreviewLoading = false;
      this._quotePreviewError = '';
      this._quotePreview = null;
      this.render();
      return;
    }

    if (this._quoteCache.has(pinId)) {
      this._quotePreviewLoading = false;
      this._quotePreviewError = '';
      this._quotePreview = this._quoteCache.get(pinId);
      this.render();
      return;
    }

    var token = this._quoteLoadToken + 1;
    this._quoteLoadToken = token;
    this._quotePreviewLoading = true;
    this._quotePreviewError = '';
    this.render();

    try {
      var serviceLocator = (typeof window !== 'undefined' && window.ServiceLocator) ? window.ServiceLocator : {};
      var base = String(serviceLocator.metaid_man || 'https://www.show.now/man').replace(/\/+$/, '');
      var response = await fetch(base + '/social/buzz/info?pinId=' + encodeURIComponent(pinId), { method: 'GET' });
      if (!response.ok) throw new Error('fetch quote detail failed');
      var json = await response.json();
      if (!json) throw new Error('fetch quote detail failed');

      var data = (json && typeof json.code === 'number') ? (json.data || {}) : (json.data || json || {});
      var pin = data && data.tweet ? data.tweet : data;
      if (!pin || typeof pin !== 'object') throw new Error('empty quote detail');

      var payload = this._pickBuzzPayload(pin);
      var content = this._extractBuzzContent(pin, payload);
      var address = this._pickFirstString([pin.address, pin.creator, pin.createAddress, pin.pinAddress]);
      var metaId = this._pickFirstString([pin.metaid, pin.metaId, pin.CreateMetaid, pin.globalMetaId]);
      var userInfo = address
        ? await this._fetchUserInfoByAddress(address)
        : { name: '', metaId: '', avatar: '', address: '' };

      var normalized = {
        pinId: this._normalizePinId(pin.id || pin.pinId || pinId) || pinId,
        content: content,
        timestamp: this._normalizeTimestamp(pin.timestamp || pin.createTime || pin.time || pin.createdAt),
        chainName: this._pickFirstString([pin.chainName, pin.chain]),
        userInfo: {
          name: userInfo.name || (metaId
            ? this._t('buzz.profile.displayNamePrefix', 'MetaID {metaid}', { metaid: metaId.slice(0, 6) })
            : this._t('buzz.composer.unknown', 'Unknown')),
          metaId: userInfo.metaId || metaId,
          avatar: userInfo.avatar || '',
          address: userInfo.address || address,
        },
      };

      if (token !== this._quoteLoadToken || pinId !== this._quotePin) return;
      this._quotePreview = normalized;
      this._quotePreviewError = '';
      this._quoteCache.set(pinId, normalized);
    } catch (error) {
      if (token !== this._quoteLoadToken || pinId !== this._quotePin) return;
      this._quotePreview = null;
      this._quotePreviewError = (error && error.message) ? error.message : this._t('buzz.composer.loadQuoteFailed', 'Failed to load quoted buzz');
    } finally {
      if (token !== this._quoteLoadToken || pinId !== this._quotePin) return;
      this._quotePreviewLoading = false;
      this.render();
    }
  }

  _renderQuotePreview() {
    if (!this._quotePin) return '';

    if (this._quotePreviewLoading) {
      return '<div class="quote quote-loading"><span class="spinner"></span>' + this._escapeHtml(this._t('buzz.composer.loadingQuotedBuzz', 'Loading quoted buzz...')) + '</div>';
    }

    if (this._quotePreviewError) {
      return `
        <div class="quote quote-error">
          <div>${this._escapeHtml(this._t('buzz.composer.quotePin', 'Quote Pin: {pin}', { pin: this._quotePin }))}</div>
          <div>${this._escapeHtml(this._quotePreviewError)}</div>
          <button class="quote-retry" data-action="retry-quote" type="button">${this._escapeHtml(this._t('buzz.composer.retry', 'Retry'))}</button>
        </div>
      `;
    }

    if (!this._quotePreview) {
      return `<div class="quote">${this._escapeHtml(this._t('buzz.composer.quotePin', 'Quote Pin: {pin}', { pin: this._quotePin }))}</div>`;
    }

    var quote = this._quotePreview;
    var user = quote.userInfo || {};
    var name = this._escapeHtml(user.name || this._t('buzz.composer.unknown', 'Unknown'));
    var shortMetaId = this._escapeHtml(this._formatMetaId(user.metaId) || '--');
    var avatar = this._escapeHtml(user.avatar || '');
    var content = this._escapeHtml(String(quote.content || '').trim());
    var time = this._escapeHtml(this._formatTime(quote.timestamp));

    return `
      <div class="quote quote-card">
        <div class="quote-user">
          <id-avatar class="quote-avatar-host" size="26" src="${avatar}" name="${name}" metaid="${this._escapeHtml(user.metaId || '')}"></id-avatar>
          <div class="quote-user-meta">
            <div class="quote-name">${name}</div>
            <div class="quote-meta">${this._escapeHtml(this._t('buzz.composer.metaidPrefix', 'MetaID: {metaid}', { metaid: shortMetaId }))}</div>
          </div>
          <div class="quote-time">${time}</div>
        </div>
        ${content ? `<div class="quote-content">${content}</div>` : `<div class="quote-content quote-content-empty">${this._escapeHtml(this._t('buzz.composer.noText', 'This buzz has no text content.'))}</div>`}
      </div>
    `;
  }

  _reset() {
    this._content = '';
    this._clearImageItems();
    this._files = [];
    this._isPosting = false;
    this._emojiPanelOpen = false;
    this.render();
  }

  _clearImageItems() {
    var list = Array.isArray(this._imageItems) ? this._imageItems : [];
    list.forEach((item) => {
      if (!item || !item.previewUrl) return;
      this._safeRevokeObjectUrl(item.previewUrl);
    });
    this._imageItems = [];
  }

  _safeCreateObjectUrl(file) {
    if (!file || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return '';
    try {
      return URL.createObjectURL(file);
    } catch (_) {
      return '';
    }
  }

  _safeRevokeObjectUrl(url) {
    if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    try {
      URL.revokeObjectURL(url);
    } catch (_) {
      // Ignore revoke failures.
    }
  }

  _isImageFile(file) {
    if (!(file instanceof File)) return false;
    if (String(file.type || '').toLowerCase().indexOf('image/') === 0) return true;
    var name = String(file.name || '').toLowerCase();
    return /\.(jpg|jpeg|png|gif|webp|avif|bmp|svg|ico)$/i.test(name);
  }

  async _appendPickedImages(fileList) {
    var source = Array.isArray(fileList) ? fileList : [];
    if (!source.length) return;

    var remain = Math.max(0, this._maxImages - this._files.length);
    if (remain <= 0) {
      this._showMessage('error', this._t('buzz.composer.uploadLimit', 'You can upload up to {max} images.', { max: this._maxImages }));
      return;
    }

    var valid = [];
    var invalidTypeCount = 0;
    var invalidSizeCount = 0;

    for (var i = 0; i < source.length; i += 1) {
      var file = source[i];
      if (!(file instanceof File) || !this._isImageFile(file)) {
        invalidTypeCount += 1;
        continue;
      }
      if (this._maxImageBytes > 0 && Number(file.size || 0) > this._maxImageBytes) {
        invalidSizeCount += 1;
        continue;
      }
      valid.push(file);
    }

    if (invalidTypeCount > 0) {
      this._showMessage('error', this._t('buzz.composer.onlyImages', 'Only image files are supported.'));
    }
    if (invalidSizeCount > 0) {
      this._showMessage('error', this._t('buzz.composer.eachImageLimit', 'Each image must be smaller than 10MB.'));
    }
    if (!valid.length) return;

    if (valid.length > remain) {
      valid = valid.slice(0, remain);
      this._showMessage('error', this._t('buzz.composer.uploadLimit', 'You can upload up to {max} images.', { max: this._maxImages }));
    }

    for (var j = 0; j < valid.length; j += 1) {
      var img = valid[j];
      var previewUrl = this._safeCreateObjectUrl(img);
      this._files.push(img);
      this._imageItems.push({
        file: img,
        previewUrl: previewUrl,
        name: String(img.name || ''),
        type: String(img.type || ''),
        size: Number(img.size || 0),
      });
    }

    this.render();
  }

  _removeImageAt(index) {
    var i = Number(index);
    if (!Number.isFinite(i) || i < 0 || i >= this._imageItems.length) return;
    var removed = this._imageItems[i];
    if (removed && removed.previewUrl) this._safeRevokeObjectUrl(removed.previewUrl);
    this._imageItems = this._imageItems.filter(function (_, idx) { return idx !== i; });
    this._files = this._imageItems.map(function (item) { return item.file; });
    this.render();
  }

  _insertEmojiAtCursor(emoji, textarea) {
    var text = String(emoji || '');
    if (!text) return;
    var target = textarea || this.shadowRoot.querySelector('[data-action="content-input"]');
    if (!target) {
      this._content += text;
      this._emojiPanelOpen = false;
      this.render();
      return;
    }
    var value = String(target.value || '');
    var start = Number(target.selectionStart || 0);
    var end = Number(target.selectionEnd || 0);
    var nextPos = start + text.length;
    target.value = value.slice(0, start) + text + value.slice(end);
    target.selectionStart = target.selectionEnd = nextPos;
    this._content = target.value;
    this._emojiPanelOpen = false;
    this.render();
    var nextTextarea = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('[data-action="content-input"]')
      : null;
    if (nextTextarea) {
      nextTextarea.focus();
      nextTextarea.selectionStart = nextTextarea.selectionEnd = nextPos;
    } else if (target && typeof target.focus === 'function') {
      target.focus();
    }
  }

  _emojiList() {
    return [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '🙂', '😉', '😍', '😘', '🥰', '😋', '😎',
      '🥳', '🤩', '🤔', '🤗', '😴', '😮', '😢', '😭', '😡', '🤯', '🥹', '😇', '🤝', '👍', '👎', '👏',
      '🙏', '💪', '🙌', '👀', '🎉', '✨', '🔥', '💯', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
      '🤎', '💔', '💖', '💕', '💞', '💓', '💗', '💬', '✅', '❌', '⚡', '🌟', '🎵', '🎶', '📷', '🎬',
    ];
  }

  _inPath(node, path) {
    if (!node) return false;
    for (var i = 0; i < path.length; i += 1) {
      var current = path[i];
      if (current === node) return true;
      if (node.contains && current && current.nodeType && node.contains(current)) return true;
    }
    return false;
  }

  _handleOutsidePointerDown(event) {
    if (!this._emojiPanelOpen || !this.shadowRoot) return;
    var path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
    var emojiPanel = this.shadowRoot.querySelector('[data-role="emoji-panel"]');
    var toggleBtn = this.shadowRoot.querySelector('[data-action="toggle-emoji"]');
    if (!this._inPath(emojiPanel, path) && !this._inPath(toggleBtn, path)) {
      this._emojiPanelOpen = false;
      this.render();
    }
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

  _canPostNow() {
    return !!String(this._content || '').trim() || this._files.length > 0 || !!String(this._quotePin || '').trim();
  }

  _updateComposerLiveState() {
    if (!this.shadowRoot || typeof this.shadowRoot.querySelector !== 'function') return;
    var postBtn = this.shadowRoot.querySelector('[data-action="post"]');
    if (postBtn) {
      postBtn.disabled = !!this._isPosting || !this._canPostNow();
    }
    var charsCounter = this.shadowRoot.querySelector('[data-role="chars-counter"]');
    if (charsCounter) {
      charsCounter.textContent = this._t('buzz.composer.charsCounter', '{count} chars', {
        count: String(this._content || '').length,
      });
    }
  }

  async _handlePost() {
    if (this._isPosting) return;
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') {
      this._showMessage('error', this._t('buzz.composer.frameworkUnavailable', 'IDFramework is not available'));
      return;
    }
    if (this._files.length > this._maxImages) {
      this._showMessage('error', this._t('buzz.composer.uploadLimit', 'You can upload up to {max} images.', { max: this._maxImages }));
      return;
    }
    if (!String(this._content || '').trim() && this._files.length === 0 && !String(this._quotePin || '').trim()) {
      this._showMessage('error', this._t('buzz.composer.emptySubmit', 'Please enter content, add image, or keep quote pin.'));
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

      this._showMessage('success', this._t('buzz.composer.postedSuccess', 'Buzz posted successfully'));
      this.dispatchEvent(new CustomEvent('buzz-posted', {
        detail: result || {},
        bubbles: true,
        composed: true,
      }));
      this._reset();
    } catch (error) {
      if (!(error && error._alreadyShown)) {
        this._showMessage('error', (error && error.message) ? error.message : this._t('buzz.composer.postFailed', 'Failed to post buzz'));
      }
      this._isPosting = false;
      this.render();
    }
  }

  render() {
    var imageCards = this._imageItems.map((item, index) => {
      var safeName = this._escapeHtml(item && item.name ? item.name : ('image-' + index));
      var safeSize = this._escapeHtml(this._formatSize(item && item.size ? item.size : 0));
      var safePreview = this._escapeHtml(item && item.previewUrl ? item.previewUrl : '');
      return `
        <div class="image-card">
          <button class="image-remove" data-action="remove-image" data-image-index="${index}" aria-label="${this._escapeHtml(this._t('buzz.composer.removeImageAria', 'Remove image'))}">×</button>
          <img class="image-preview" src="${safePreview}" alt="${safeName}" loading="lazy" decoding="async" />
          <div class="image-meta" title="${safeName}">
            <span class="image-name">${safeName}</span>
            <span class="image-size">${safeSize}</span>
          </div>
        </div>
      `;
    }).join('');
    var canPost = this._canPostNow();
    var remainCount = Math.max(0, this._maxImages - this._files.length);
    var emojiPanel = this._emojiPanelOpen
      ? `<div class="emoji-panel" data-role="emoji-panel">
          ${this._emojiList().map((emoji) => `<button class="emoji-btn" data-action="emoji" data-emoji="${this._escapeHtml(emoji)}" type="button">${this._escapeHtml(emoji)}</button>`).join('')}
        </div>`
      : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
          color: var(--id-text-main, #111827);
        }
        .wrap {
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 14px;
          background: var(--id-bg-card, #ffffff);
          padding: 14px;
        }
        .title {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
          color: var(--id-text-title, var(--id-text-main, #111827));
        }
        .quote {
          margin-top: 8px;
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
          background: var(--id-quote-bg, rgba(148, 163, 184, 0.12));
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 10px;
          padding: 8px 10px;
        }
        .quote-loading {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .quote-error {
          color: var(--id-text-error, #b91c1c);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .quote-retry {
          align-self: flex-start;
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          border-radius: 999px;
          padding: 4px 10px;
          font-size: 12px;
          cursor: pointer;
        }
        .quote-retry:hover {
          background: var(--id-border-color-light, #f3f4f6);
        }
        .quote-card {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .quote-user {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .quote-avatar-host {
          width: 26px;
          height: 26px;
          min-width: 26px;
          min-height: 26px;
          flex-shrink: 0;
        }
        .quote-user-meta {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .quote-name {
          font-size: 12px;
          font-weight: 700;
          color: var(--id-text-main, #111827);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .quote-meta {
          font-size: 11px;
          color: var(--id-text-secondary, #6b7280);
          white-space: nowrap;
        }
        .quote-time {
          margin-left: auto;
          white-space: nowrap;
          font-size: 11px;
          color: var(--id-text-tertiary, #9ca3af);
        }
        .quote-content {
          font-size: 13px;
          line-height: 1.45;
          color: var(--id-text-main, #111827);
          white-space: pre-wrap;
          word-break: break-word;
        }
        .quote-content-empty {
          color: var(--id-text-secondary, #6b7280);
        }
        .input {
          margin-top: 12px;
          width: 100%;
          min-height: 120px;
          border: 1px solid var(--id-border-color, #d1d5db);
          border-radius: 10px;
          padding: 10px 12px;
          font-size: 14px;
          line-height: 1.5;
          resize: vertical;
          box-sizing: border-box;
          outline: none;
          background: var(--id-input-bg, var(--id-bg-card, #ffffff));
          color: var(--id-text-main, #111827);
        }
        .input:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
        }
        .composer-meta {
          margin-top: 8px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          font-size: 12px;
          color: var(--id-text-secondary, #6b7280);
        }
        .images {
          margin-top: 12px;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
          gap: 8px;
        }
        .image-card {
          position: relative;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 10px;
          background: var(--id-bg-body, #f9fafb);
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .image-preview {
          width: 100%;
          aspect-ratio: 1 / 1;
          object-fit: cover;
          display: block;
          background: #f3f4f6;
        }
        .image-meta {
          width: 100%;
          box-sizing: border-box;
          padding: 6px 8px;
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .image-name {
          font-size: 11px;
          color: var(--id-text-main, #111827);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .image-size {
          font-size: 11px;
          color: var(--id-text-secondary, #6b7280);
        }
        .image-remove {
          position: absolute;
          top: 6px;
          right: 6px;
          width: 24px;
          height: 24px;
          border: none;
          border-radius: 999px;
          background: rgba(15, 23, 42, 0.7);
          color: #fff;
          font-size: 15px;
          line-height: 1;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          z-index: 1;
        }
        .image-remove:hover {
          background: rgba(185, 28, 28, 0.85);
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
          border: 1px solid var(--id-border-color, #d1d5db);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          border-radius: 999px;
          padding: 7px 12px;
          font-size: 13px;
          cursor: pointer;
        }
        .btn:hover {
          background: var(--id-border-color-light, #f9fafb);
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
        .emoji-panel {
          margin-top: 10px;
          border-top: 1px solid var(--id-border-color, #e5e7eb);
          padding-top: 10px;
          display: grid;
          grid-template-columns: repeat(8, minmax(0, 1fr));
          gap: 8px;
          max-height: 190px;
          overflow: auto;
        }
        .emoji-btn {
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          border-radius: 10px;
          padding: 6px;
          min-height: 34px;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
        }
        .emoji-btn:hover {
          background: var(--id-border-color-light, #f9fafb);
        }
        .spinner {
          width: 14px;
          height: 14px;
          border: 2px solid var(--id-border-color, #e5e7eb);
          border-top-color: #2563eb;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          flex-shrink: 0;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @media (max-width: 680px) {
          .emoji-panel {
            grid-template-columns: repeat(6, minmax(0, 1fr));
          }
        }
      </style>
      <section class="wrap">
        <h3 class="title">${this._escapeHtml(this._t('buzz.composer.title', 'New Buzz'))}</h3>
        ${this._renderQuotePreview()}
        <textarea class="input" data-action="content-input" placeholder="${this._escapeHtml(this._t('buzz.composer.placeholder', "What's happening?"))}">${this._escapeHtml(this._content)}</textarea>
        <div class="composer-meta">
          <span>${this._escapeHtml(this._t('buzz.composer.imagesCounter', 'Images: {count}/{max}', { count: this._files.length, max: this._maxImages }))}</span>
          <span data-role="chars-counter">${this._escapeHtml(this._t('buzz.composer.charsCounter', '{count} chars', { count: String(this._content || '').length }))}</span>
        </div>
        ${this._imageItems.length > 0 ? `<div class="images">${imageCards}</div>` : ''}
        <div class="actions">
          <div class="left-actions">
            <input id="${this._fileInputId}" type="file" data-action="file-input" accept="image/*" multiple hidden />
            <button class="btn" data-action="pick-file" type="button">${this._escapeHtml(this._t('buzz.composer.addImages', 'Add Images ({remain})', { remain: remainCount }))}</button>
            <button class="btn" data-action="toggle-emoji" type="button">${this._escapeHtml(this._t('buzz.composer.emoji', 'Emoji'))}</button>
            <button class="btn" data-action="reset" type="button">${this._escapeHtml(this._t('buzz.composer.reset', 'Reset'))}</button>
          </div>
          <div class="left-actions">
            <button class="btn" data-action="close" type="button">${this._escapeHtml(this._t('buzz.composer.cancel', 'Cancel'))}</button>
            <button class="btn btn-primary" data-action="post" type="button" ${this._isPosting || !canPost ? 'disabled' : ''}>${this._escapeHtml(this._isPosting ? this._t('buzz.composer.posting', 'Posting...') : this._t('buzz.composer.post', 'Post'))}</button>
          </div>
        </div>
        ${emojiPanel}
      </section>
    `;

    var contentInput = this.shadowRoot.querySelector('[data-action="content-input"]');
    if (contentInput) {
      contentInput.addEventListener('input', (event) => {
        this._content = event.target.value || '';
        this._updateComposerLiveState();
      });
    }

    var retryQuoteBtn = this.shadowRoot.querySelector('[data-action="retry-quote"]');
    if (retryQuoteBtn) {
      retryQuoteBtn.addEventListener('click', () => this._loadQuotePreview());
    }

    var fileInput = this.shadowRoot.querySelector('[data-action="file-input"]');
    var pickFileBtn = this.shadowRoot.querySelector('[data-action="pick-file"]');
    if (pickFileBtn && fileInput) {
      pickFileBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async (event) => {
        var list = event.target.files ? Array.from(event.target.files) : [];
        await this._appendPickedImages(list);
        event.target.value = '';
      });
    }

    var toggleEmojiBtn = this.shadowRoot.querySelector('[data-action="toggle-emoji"]');
    if (toggleEmojiBtn) {
      toggleEmojiBtn.addEventListener('click', () => {
        this._emojiPanelOpen = !this._emojiPanelOpen;
        this.render();
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

    var removeBtns = this.shadowRoot.querySelectorAll('[data-action="remove-image"]');
    removeBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        var index = Number(btn.getAttribute('data-image-index'));
        this._removeImageAt(index);
      });
    });

    var emojiBtns = this.shadowRoot.querySelectorAll('[data-action="emoji"]');
    emojiBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        var emoji = btn.getAttribute('data-emoji') || '';
        var textarea = this.shadowRoot.querySelector('[data-action="content-input"]');
        this._insertEmojiAtCursor(emoji, textarea);
      });
    });
  }
}

if (!customElements.get('id-post-buzz')) {
  customElements.define('id-post-buzz', IdPostBuzz);
}
