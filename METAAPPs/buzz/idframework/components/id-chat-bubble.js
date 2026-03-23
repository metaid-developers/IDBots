import { ChatProtocols } from '../stores/chat/simple-talk.js';

class IdChatBubble extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._message = null;
    this._selfGlobalMetaId = '';
    this._selfMetaId = '';
    this._mode = 'public';
    this._groupId = '';
    this._chatStore = null;
    this._decryptedText = '';
    this._objectUrl = '';
    this._renderToken = 0;
    this._preview = { open: false, type: '', src: '', downloadSrc: '' };
    this._hasDelegatedPreviewListener = false;
    this._toastTimer = null;
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  set message(value) {
    this._message = value || null;
    this.render();
  }

  set currentUserGlobalMetaId(value) {
    this._selfGlobalMetaId = String(value || '');
    this.render();
  }

  set currentUserMetaId(value) {
    this._selfMetaId = String(value || '');
    this.render();
  }

  set mode(value) {
    this._mode = value === 'private' ? 'private' : 'public';
    this.render();
  }

  set groupId(value) {
    this._groupId = String(value || '');
    this.render();
  }

  set chatStore(value) {
    this._chatStore = value || null;
    this.render();
  }

  disconnectedCallback() {
    this._cleanupObjectUrl();
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
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
    return fallback || key;
  }

  _cleanupObjectUrl() {
    if (this._objectUrl) {
      URL.revokeObjectURL(this._objectUrl);
      this._objectUrl = '';
    }
  }

  _normalizeIdentity(value) {
    return String(value || '').trim().toLowerCase();
  }

  _isCurrentUserIdentity(candidate) {
    const id = this._normalizeIdentity(candidate);
    if (!id) return false;
    const selfGlobal = this._normalizeIdentity(this._selfGlobalMetaId);
    const selfMeta = this._normalizeIdentity(this._selfMetaId);
    if (selfGlobal && id === selfGlobal) return true;
    if (selfMeta && id === selfMeta) return true;
    return false;
  }

  _collectSenderIdentities(message) {
    const msg = message && typeof message === 'object' ? message : {};
    const fromUserInfo = msg.fromUserInfo && typeof msg.fromUserInfo === 'object' ? msg.fromUserInfo : {};
    const userInfo = msg.userInfo && typeof msg.userInfo === 'object' ? msg.userInfo : {};
    return [
      msg.fromGlobalMetaId,
      msg.createGlobalMetaId,
      msg.fromMetaId,
      msg.createMetaId,
      msg.createUserMetaId,
      fromUserInfo.globalMetaId,
      fromUserInfo.globalmetaid,
      fromUserInfo.metaid,
      fromUserInfo.metaId,
      userInfo.globalMetaId,
      userInfo.globalmetaid,
      userInfo.metaid,
      userInfo.metaId,
    ]
      .map((value) => this._normalizeIdentity(value))
      .filter((value) => !!value);
  }

  _isSelfMessage(message) {
    const from = this._normalizeIdentity(message.fromGlobalMetaId || '');
    const to = this._normalizeIdentity(message.toGlobalMetaId || '');
    const selfGlobal = this._normalizeIdentity(this._selfGlobalMetaId);
    if (selfGlobal && from && to && from === selfGlobal && to === selfGlobal) return true;
    const senderIdentities = this._collectSenderIdentities(message);
    return senderIdentities.some((value) => this._isCurrentUserIdentity(value));
  }

  _isOptimisticMessage(message) {
    return !!(message && message._optimistic);
  }

  _messageSendStatus(message) {
    var row = message && typeof message === 'object' ? message : {};
    return String(row._sendStatus || '').trim();
  }

  _notifyCopySuccess() {
    if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage('success', this._t('chat.bubble.copySuccess', 'Copied'));
      return;
    }
    const toast = this.shadowRoot && this.shadowRoot.querySelector
      ? this.shadowRoot.querySelector('[data-role="inline-toast"]')
      : null;
    if (!toast) return;
    toast.textContent = this._t('chat.bubble.copySuccess', 'Copied');
    toast.classList.add('show');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (toast && toast.classList) toast.classList.remove('show');
      this._toastTimer = null;
    }, 1200);
  }

  async _copyText(text) {
    const value = String(text == null ? '' : text);
    if (!value) return true;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch (_) {}

    try {
      const input = document.createElement('textarea');
      input.value = value;
      input.setAttribute('readonly', 'readonly');
      input.style.position = 'fixed';
      input.style.top = '-9999px';
      document.body.appendChild(input);
      input.focus();
      input.select();
      const copied = document.execCommand && document.execCommand('copy');
      document.body.removeChild(input);
      return !!copied;
    } catch (_) {
      return false;
    }
  }

  _formatTime(raw) {
    let timestamp = Number(raw || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) timestamp = Date.now();
    if (timestamp < 1000000000000) timestamp *= 1000;
    if (timestamp > 1000000000000000) timestamp = Math.floor(timestamp / 1000);
    const date = new Date(timestamp);
    const now = new Date();
    const sameYear = now.getFullYear() === date.getFullYear();
    const sameDay = sameYear &&
      now.getMonth() === date.getMonth() &&
      now.getDate() === date.getDate();
    const pad = (n) => String(n).padStart(2, '0');
    const MM = pad(date.getMonth() + 1);
    const DD = pad(date.getDate());
    const hh = pad(date.getHours());
    const mm = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    if (sameDay) return `${hh}:${mm}:${ss}`;
    if (sameYear) return `${MM}-${DD} ${hh}:${mm}:${ss}`;
    return `${date.getFullYear()}-${MM}-${DD} ${hh}:${mm}:${ss}`;
  }

  _escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  _extractPinId(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const match = raw.match(/([a-fA-F0-9]{64}i\d+)/);
    return match ? match[1] : '';
  }

  _extractTxid(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    const pinMatch = raw.match(/([a-fA-F0-9]{64})i\d+$/);
    if (pinMatch && pinMatch[1]) return pinMatch[1];
    const txMatch = raw.match(/([a-fA-F0-9]{64})/);
    return txMatch && txMatch[1] ? txMatch[1] : '';
  }

  _resolveTxidFromMessage(message) {
    const msg = message && typeof message === 'object' ? message : {};
    const direct = this._extractTxid(msg.txId || msg.txid || '');
    if (direct) return direct;
    const fromPin = this._extractTxid(msg.pinId || '');
    if (fromPin) return fromPin;
    const fromId = this._extractTxid(msg.id || '');
    if (fromId) return fromId;
    return '';
  }

  _resolveMetafsBase() {
    const locator = (typeof window !== 'undefined' && window.ServiceLocator)
      ? window.ServiceLocator
      : (typeof globalThis !== 'undefined' ? globalThis.ServiceLocator : null);
    let base = String((locator && locator.metafs) || 'https://file.metaid.io/metafile-indexer/api/v1').trim();
    base = base.replace(/\/+$/, '');
    if (!/\/api\/v1$/i.test(base)) {
      base = base
        .replace(/\/api$/i, '/api/v1')
        .replace(/\/+$/, '');
    }
    return base;
  }

  _fallbackAvatar(seed) {
    return `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(String(seed || 'metaid'))}`;
  }

  _resolveAvatarUrl(rawAvatar, seed) {
    const raw = String(rawAvatar || '').trim();
    const fallback = this._fallbackAvatar(seed || 'metaid');
    if (!raw || raw === '/content/' || raw === 'null' || raw === 'undefined') return fallback;

    const normalized = raw.startsWith('metafile://') ? raw.slice('metafile://'.length) : raw;
    const pinId = this._extractPinId(normalized);
    if (pinId) {
      return `${this._resolveMetafsBase()}/users/avatar/accelerate/${pinId}?process=thumbnail`;
    }

    if (/\/content\/?$/i.test(raw)) return fallback;
    return raw;
  }

  _pickUserInfo(message) {
    if (this._mode === 'private') {
      if (this._isSelfMessage(message)) {
        return message.fromUserInfo || message.userInfo || message.toUserInfo || {};
      }
      return message.fromUserInfo || message.userInfo || message.toUserInfo || {};
    }
    return message.userInfo || message.fromUserInfo || {};
  }

  _guessFileType(contentType, pinId, fileType) {
    const ct = String(contentType || '').toLowerCase();
    const ft = String(fileType || '').toLowerCase();
    const token = ft || ct;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(token)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v'].includes(token)) return 'video';
    if (['mp3', 'wav', 'ogg', 'flac'].includes(token)) return 'audio';
    if (token === 'pdf') return 'pdf';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(token)) return 'archive';
    if (ct.indexOf('image/') === 0) return 'image';
    if (ct.indexOf('video/') === 0) return 'video';
    if (ct.indexOf('audio/') === 0) return 'audio';
    if (ct.indexOf('pdf') > -1) return 'pdf';
    if (ct.indexOf('zip') > -1 || ct.indexOf('compressed') > -1) return 'archive';
    const suffix = String(pinId || '').split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(suffix)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v'].includes(suffix)) return 'video';
    if (['mp3', 'wav', 'ogg', 'flac'].includes(suffix)) return 'audio';
    if (['pdf'].includes(suffix)) return 'pdf';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(suffix)) return 'archive';
    if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv'].includes(suffix)) return 'document';
    return 'file';
  }

  _fileTypeMeta(fileType) {
    const map = {
      pdf: { icon: '📕', label: 'PDF' },
      archive: { icon: '🗜️', label: this._t('chat.bubble.fileTypeArchive', 'Archive') },
      document: { icon: '📄', label: this._t('chat.bubble.fileTypeDocument', 'Document') },
      file: { icon: '📎', label: this._t('chat.bubble.fileTypeFile', 'File') },
    };
    return map[fileType] || map.file;
  }

  _formatFileSize(bytes) {
    var size = Number(bytes || 0);
    if (!Number.isFinite(size) || size <= 0) return '';
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / (1024 * 1024)).toFixed(1) + ' MB';
  }

  _renderTextWithMentions(text, message) {
    var escaped = this._escapeHtml(String(text || ''));
    var mentionMetaIds = Array.isArray(message && message.mention) ? message.mention.slice() : [];
    var mentionIndex = 0;
    return escaped
      .replace(/@([^\s<]+)/g, (match) => {
        var meta = String(mentionMetaIds[mentionIndex] || '');
        mentionIndex += 1;
        return '<span class="mention" data-action="mention-click" data-metaid="' + this._escapeHtml(meta) + '">' + match + '</span>';
      })
      .replace(/\n/g, '<br>');
  }

  _openPreview(type, src, downloadSrc) {
    this._preview = {
      open: true,
      type: String(type || ''),
      src: String(src || ''),
      downloadSrc: String(downloadSrc || src || ''),
    };
    this.render();
  }

  _closePreview() {
    this._preview = { open: false, type: '', src: '', downloadSrc: '' };
    this.render();
  }

  _renderPreviewModal() {
    if (!this._preview.open || !this._preview.src) return '';
    const isVideo = this._preview.type === 'video';
    const media = isVideo
      ? `<video class="preview-media" controls src="${this._escapeHtml(this._preview.src)}"></video>`
      : `<img class="preview-media" src="${this._escapeHtml(this._preview.src)}" alt="preview" />`;
    return `
      <div class="preview-overlay" data-role="preview-overlay">
        <div class="preview-dialog">
          <button class="preview-close" data-action="close-preview" title="${this._escapeHtml(this._t('chat.bubble.close', 'Close'))}">✕</button>
          <div class="preview-body">${media}</div>
        </div>
      </div>
    `;
  }

  _formatReplyTime(raw) {
    const ts = Number(raw || 0);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    return this._formatTime(ts);
  }

  async _resolveReplyText(message) {
    const reply = message && message.replyInfo ? message.replyInfo : null;
    if (!reply) return '';
    const protocol = String(reply.protocol || '');
    const isFileReply = protocol === ChatProtocols.GROUP_FILE_PROTOCOL || protocol === ChatProtocols.PRIVATE_FILE_PROTOCOL;
    if (isFileReply) return this._t('chat.bubble.fileToken', '[File]');

    let text = String(reply.content || '');
    if (!text) return '';

    try {
      const isGroupText = protocol === ChatProtocols.GROUP_TEXT_PROTOCOL;
      const isPrivateText = protocol === ChatProtocols.PRIVATE_TEXT_PROTOCOL;
      if ((isGroupText || isPrivateText) && this._chatStore) {
        const fakeReplyMsg = {
          protocol: protocol,
          content: text,
          groupId: String((reply.channelId || message.groupId || this._groupId || '')),
          fromGlobalMetaId: String(message.fromGlobalMetaId || ''),
          toGlobalMetaId: String(message.toGlobalMetaId || ''),
        };
        text = await this._chatStore.decryptText(fakeReplyMsg);
      }
    } catch (_) {
      // ignore decrypt failure and fallback to raw content
    }
    return String(text || '');
  }

  async _renderReplyInfo(message, token) {
    const host = this.shadowRoot.querySelector('[data-role="reply-content"]');
    if (!host || token !== this._renderToken) return;
    const reply = message && message.replyInfo ? message.replyInfo : null;
    if (!reply) {
      const replyPin = String(message && message.replyPin ? message.replyPin : '');
      if (!replyPin) {
        host.innerHTML = '';
        return;
      }
      host.innerHTML = `
        <div class="reply-box">
          <img class="reply-avatar" src="https://api.dicebear.com/7.x/identicon/svg?seed=reply-pin" alt="reply-avatar" />
          <div class="reply-main">
            <div class="reply-head">
              <span class="reply-name">${this._escapeHtml(this._t('chat.bubble.reply', 'Reply'))}</span>
            </div>
            <div class="reply-text">Pin: ${this._escapeHtml(replyPin)}</div>
          </div>
        </div>
      `;
      return;
    }
    const userInfo = reply.userInfo || {};
    const nick = String(userInfo.name || reply.nickName || reply.metaId || '');
    const avatar = this._resolveAvatarUrl(
      userInfo.avatarImage || userInfo.avatar || userInfo.avatarUrl || '',
      nick || 'reply'
    );
    const text = await this._resolveReplyText(message);
    if (token !== this._renderToken) return;
    host.innerHTML = `
      <div class="reply-box" data-action="reply-jump" data-index="${this._escapeHtml(String(reply.index || ''))}">
        <img class="reply-avatar" src="${this._escapeHtml(avatar)}" alt="reply-avatar" />
        <div class="reply-main">
          <div class="reply-head">
            <span class="reply-name">${this._escapeHtml(nick || this._t('chat.bubble.unknown', 'Unknown'))}</span>
          </div>
          <div class="reply-text">${this._escapeHtml(text || this._t('chat.bubble.quotedMessage', '[Quoted Message]')).replace(/\n/g, ' ')}</div>
        </div>
      </div>
    `;
  }

  _bindContentActions() {
    const previewImage = this.shadowRoot.querySelector('[data-action="preview-image"]');
    if (previewImage) {
      previewImage.addEventListener('click', () => {
        const src = previewImage.getAttribute('data-src') || '';
        this._openPreview('image', src, src);
      });
    }

    const previewVideo = this.shadowRoot.querySelector('[data-action="preview-video"]');
    if (previewVideo) {
      previewVideo.addEventListener('click', () => {
        const src = previewVideo.getAttribute('data-src') || '';
        this._openPreview('video', src, src);
      });
    }
  }

  async _renderContent(message, token) {
    const contentNode = this.shadowRoot.querySelector('[data-role="content"]');
    if (!contentNode || token !== this._renderToken) return;
    await this._renderReplyInfo(message, token);
    if (token !== this._renderToken) return;

    const optimisticPreview = message && message._optimisticFilePreview && typeof message._optimisticFilePreview === 'object'
      ? message._optimisticFilePreview
      : null;
    if (this._isOptimisticMessage(message) && optimisticPreview && optimisticPreview.url) {
      const fileKind = String(optimisticPreview.kind || '').toLowerCase();
      const src = String(optimisticPreview.url || '');
      if (fileKind === 'image') {
        contentNode.innerHTML = `
          <div class="media-wrap">
            <img class="img" data-action="preview-image" data-src="${this._escapeHtml(src)}" src="${this._escapeHtml(src)}" alt="image" />
          </div>
        `;
        this._bindContentActions();
        return;
      }
      if (fileKind === 'video') {
        contentNode.innerHTML = `
          <div class="media-wrap">
            <video class="video" controls src="${this._escapeHtml(src)}"></video>
            <button class="zoom-btn" data-action="preview-video" data-src="${this._escapeHtml(src)}" title="${this._escapeHtml(this._t('chat.bubble.preview', 'Preview'))}">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 3a1 1 0 0 1 0 2H6a1 1 0 0 0-1 1v3a1 1 0 1 1-2 0V6a3 3 0 0 1 3-3h3Zm9 0a3 3 0 0 1 3 3v3a1 1 0 1 1-2 0V6a1 1 0 0 0-1-1h-3a1 1 0 1 1 0-2h3ZM3 15a1 1 0 0 1 2 0v3a1 1 0 0 0 1 1h3a1 1 0 1 1 0 2H6a3 3 0 0 1-3-3v-3Zm18 0a1 1 0 1 1-2 0v3a3 3 0 0 1-3 3h-3a1 1 0 1 1 0-2h3a1 1 0 0 0 1-1v-3Z"/>
              </svg>
            </button>
          </div>
        `;
        this._bindContentActions();
        return;
      }
      if (fileKind === 'audio') {
        contentNode.innerHTML = `<audio class="audio" controls src="${this._escapeHtml(src)}"></audio>`;
        return;
      }
      const fileName = String(optimisticPreview.name || this._t('chat.bubble.fileTypeFile', 'File'));
      const fileSize = this._formatFileSize(optimisticPreview.size || 0);
      contentNode.innerHTML = `
        <div class="file-card">
          <div class="file-icon">📎</div>
          <div class="file-body">
            <div class="file-title">${this._escapeHtml(fileName)}</div>
            <div class="file-sub">${this._escapeHtml(fileSize || this._t('chat.bubble.fileTypeFile', 'File'))}</div>
          </div>
        </div>
      `;
      return;
    }

    const protocol = String(message.protocol || '');
    const isText = protocol === ChatProtocols.GROUP_TEXT_PROTOCOL || protocol === ChatProtocols.PRIVATE_TEXT_PROTOCOL;
    const isFile = protocol === ChatProtocols.GROUP_FILE_PROTOCOL || protocol === ChatProtocols.PRIVATE_FILE_PROTOCOL;

    if (isText) {
      let text = String(message.content || '');
      if (this._chatStore && typeof this._chatStore.decryptText === 'function') {
        try {
          text = await this._chatStore.decryptText(message);
        } catch (_) {}
      }
      if (token !== this._renderToken) return;
      this._decryptedText = text;
      contentNode.innerHTML = `<div class="text">${this._renderTextWithMentions(text, message)}</div>`;
      return;
    }

    if (isFile) {
      const pinId = ChatProtocols.extractPinId(message.content || message.attachment || '');
      if (!pinId) {
        contentNode.innerHTML = `<div class="text">${this._escapeHtml(this._t('chat.bubble.fileParseFailed', '[Failed to parse file message]'))}</div>`;
        return;
      }
      const isPrivateFile = protocol === ChatProtocols.PRIVATE_FILE_PROTOCOL;
      const fileType = this._guessFileType(message.contentType, pinId, message.fileType);
      if (isPrivateFile && this._chatStore && typeof this._chatStore.decryptPrivateFileToObjectUrl === 'function') {
        try {
          this._cleanupObjectUrl();
          this._objectUrl = await this._chatStore.decryptPrivateFileToObjectUrl(message);
        } catch (_) {
          this._objectUrl = '';
        }
      }
      if (token !== this._renderToken) return;
      const src = this._objectUrl || ChatProtocols.buildFileUrl(pinId, fileType === 'image');
      if (fileType === 'image') {
        const full = this._objectUrl || ChatProtocols.buildFileUrl(pinId, false);
        contentNode.innerHTML = `
          <div class="media-wrap">
            <img class="img" data-action="preview-image" data-src="${this._escapeHtml(full)}" src="${this._escapeHtml(src)}" alt="image" />
          </div>
        `;
        this._bindContentActions();
      } else if (fileType === 'video') {
        const full = this._objectUrl || ChatProtocols.buildFileUrl(pinId, false);
        contentNode.innerHTML = `
          <div class="media-wrap">
            <video class="video" controls src="${this._escapeHtml(src)}"></video>
            <button class="zoom-btn" data-action="preview-video" data-src="${this._escapeHtml(full)}" title="${this._escapeHtml(this._t('chat.bubble.preview', 'Preview'))}">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 3a1 1 0 0 1 0 2H6a1 1 0 0 0-1 1v3a1 1 0 1 1-2 0V6a3 3 0 0 1 3-3h3Zm9 0a3 3 0 0 1 3 3v3a1 1 0 1 1-2 0V6a1 1 0 0 0-1-1h-3a1 1 0 1 1 0-2h3ZM3 15a1 1 0 0 1 2 0v3a1 1 0 0 0 1 1h3a1 1 0 1 1 0 2H6a3 3 0 0 1-3-3v-3Zm18 0a1 1 0 1 1-2 0v3a3 3 0 0 1-3 3h-3a1 1 0 1 1 0-2h3a1 1 0 0 0 1-1v-3Z"/>
              </svg>
            </button>
          </div>
        `;
        this._bindContentActions();
      } else if (fileType === 'audio') {
        contentNode.innerHTML = `<audio class="audio" controls src="${this._escapeHtml(src)}"></audio>`;
      } else {
        const full = this._objectUrl || ChatProtocols.buildFileUrl(pinId, false);
        const meta = this._fileTypeMeta(fileType);
        contentNode.innerHTML = `
          <div class="file-card">
            <div class="file-icon">${meta.icon}</div>
            <div class="file-body">
              <div class="file-title">${meta.label}</div>
              <div class="file-sub">${this._escapeHtml(this._t('chat.bubble.filePreviewOrDownload', 'Preview or download'))}</div>
            </div>
          </div>
          <div class="actions">
            <a href="${this._escapeHtml(full)}" target="_blank" rel="noreferrer" title="${this._escapeHtml(this._t('chat.bubble.preview', 'Preview'))}">👁️</a>
            <a href="${this._escapeHtml(full)}" data-action="download-file" data-src="${this._escapeHtml(full)}" title="${this._escapeHtml(this._t('chat.bubble.download', 'Download'))}">⬇️</a>
          </div>
        `;
      }
      return;
    }

    contentNode.innerHTML = `<div class="text">${this._escapeHtml(String(message.content || ''))}</div>`;
  }

  _wireMenu(message) {
    const copyBtn = this.shadowRoot.querySelector('[data-action="copy"]');
    const quoteBtn = this.shadowRoot.querySelector('[data-action="quote"]');
    const txBtn = this.shadowRoot.querySelector('[data-action="tx"]');
    const retryBtn = this.shadowRoot.querySelector('[data-action="retry-send"]');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const text = this._decryptedText || String(message.content || '');
        try {
          const copied = await this._copyText(text);
          if (copied) this._notifyCopySuccess();
        } catch (_) {}
      });
    }
    if (quoteBtn) {
      quoteBtn.addEventListener('click', () => {
        var quoteText = this._decryptedText || String(message.content || '');
        var protocol = String(message.protocol || '');
        if (protocol === ChatProtocols.GROUP_FILE_PROTOCOL || protocol === ChatProtocols.PRIVATE_FILE_PROTOCOL) {
          quoteText = this._t('chat.bubble.fileToken', '[File]');
        }
        var quoteName = '';
        if (message.userInfo && message.userInfo.name) quoteName = String(message.userInfo.name);
        if (!quoteName && message.fromUserInfo && message.fromUserInfo.name) quoteName = String(message.fromUserInfo.name);
        this.dispatchEvent(new CustomEvent('bubble-quote', {
          detail: {
            pinId: String(message.pinId || ''),
            quoteName: quoteName,
            quoteText: quoteText,
            message: message,
          },
          bubbles: true,
          composed: true,
        }));
      });
    }
    if (txBtn) {
      txBtn.addEventListener('click', () => {
        const txid = this._resolveTxidFromMessage(message);
        if (!txid) return;
        const chain = this._normalizeIdentity(message.chain || '');
        if (chain === 'btc') {
          window.open(`https://mempool.space/tx/${txid}`, '_blank');
          return;
        }
        if (chain === 'doge') {
          window.open(`https://dogechain.info/tx/${txid}`, '_blank');
          return;
        }
        window.open(`https://mvcscan.com/tx/${txid}`, '_blank');
      });
    }
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        const clientTempId = String(message && message._clientTempId ? message._clientTempId : '').trim();
        if (!clientTempId) return;
        this.dispatchEvent(new CustomEvent('bubble-retry-send', {
          detail: { clientTempId: clientTempId },
          bubbles: true,
          composed: true,
        }));
      });
    }

    // 媒体预览/下载在内容异步渲染后绑定，这里使用事件委托做兜底（只注册一次）。
    if (!this._hasDelegatedPreviewListener) {
      this.shadowRoot.addEventListener('click', (event) => {
        const target = event && event.target && event.target.closest
          ? event.target.closest('[data-action="preview-image"],[data-action="preview-video"],[data-action="download-file"],[data-action="reply-jump"],[data-action="mention-click"]')
          : null;
        if (!target) return;
        const action = target.getAttribute('data-action') || '';
        if (action === 'mention-click') {
          const globalMetaId = String(target.getAttribute('data-metaid') || '');
          this.dispatchEvent(new CustomEvent('bubble-mention-click', {
            detail: { globalMetaId: globalMetaId },
            bubbles: true,
            composed: true,
          }));
          return;
        }
        if (action === 'reply-jump') {
          const indexValue = Number(target.getAttribute('data-index') || 0);
          if (Number.isFinite(indexValue) && indexValue > 0) {
            this.dispatchEvent(new CustomEvent('bubble-to-timestamp', {
              detail: { index: indexValue, replyInfo: this._message && this._message.replyInfo ? this._message.replyInfo : null },
              bubbles: true,
              composed: true,
            }));
          }
          return;
        }
        const src = target.getAttribute('data-src') || '';
        if (!src) return;
        if (action === 'preview-image') {
          this._openPreview('image', src, src);
          return;
        }
        if (action === 'preview-video') {
          this._openPreview('video', src, src);
          return;
        }
        if (action === 'download-file') {
          event.preventDefault();
          event.stopPropagation();
          this._downloadByAnchor(src);
        }
      });
      this._hasDelegatedPreviewListener = true;
    }

    const closePreview = this.shadowRoot.querySelector('[data-action="close-preview"]');
    if (closePreview) {
      closePreview.addEventListener('click', () => this._closePreview());
    }

    const overlay = this.shadowRoot.querySelector('[data-role="preview-overlay"]');
    if (overlay) {
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) this._closePreview();
      });
    }
  }

  _downloadByAnchor(url) {
    const src = String(url || '').trim();
    if (!src) return;
    const a = document.createElement('a');
    a.href = src;
    a.download = '';
    a.rel = 'noreferrer';
    a.style.display = 'none';
    this.shadowRoot.appendChild(a);
    a.click();
    a.remove();
  }

  render() {
    const message = this._message;
    if (!message) return;
    const self = this._isSelfMessage(message);
    const userInfo = this._pickUserInfo(message);
    const name = String(
      userInfo.name ||
      userInfo.nickname ||
      message.fromGlobalMetaId ||
      message.createGlobalMetaId ||
      message.fromMetaId ||
      message.createMetaId ||
      ''
    );
    const avatar = this._resolveAvatarUrl(
      userInfo.avatarImage || userInfo.avatarUrl || userInfo.avatar || '',
      name || message.fromGlobalMetaId || message.createGlobalMetaId || 'metaid'
    );
    const time = this._formatTime(message.timestamp);
    const messageChain = this._normalizeIdentity(message.chain || '');
    const chainClass = (messageChain === 'btc' || messageChain === 'doge') ? `${messageChain}-item` : '';
    const isOptimistic = this._isOptimisticMessage(message);
    const sendStatus = this._messageSendStatus(message);
    const isFailed = isOptimistic && sendStatus === 'failed';
    const bubbleClass = ['bubble', chainClass, isOptimistic ? 'optimistic-item' : '', isFailed ? 'failed-item' : '']
      .filter(Boolean)
      .join(' ');
    const sendStateHtml = (self && isOptimistic)
      ? `<div class="send-state ${isFailed ? 'failed' : 'pending'}">
          <span>${this._escapeHtml(isFailed ? this._t('chat.bubble.failedToSend', 'Failed to send') : this._t('chat.bubble.sending', 'Sending...'))}</span>
          ${isFailed ? `<button type="button" data-action="retry-send">${this._escapeHtml(this._t('chat.bubble.retry', 'Retry'))}</button>` : ''}
        </div>`
      : '';
    this._renderToken += 1;
    const token = this._renderToken;

    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;font-family:var(--id-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);}
        .row{display:flex;gap:8px;margin:10px 0;align-items:flex-start;}
        .row.self{justify-content:flex-end;}
        .row.other{justify-content:flex-start;}
        .avatar{width:34px;height:34px;border-radius:50%;border:1px solid var(--id-border-color,#e5e7eb);object-fit:cover;background:var(--id-bg-body,#f3f4f6);flex:0 0 34px;}
        .card-wrap{max-width:min(76%,680px);position:relative;width:fit-content;}
        .row.self .card-wrap{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;}
        .meta{font-size:12px;color:var(--id-text-secondary,#6b7280);display:flex;gap:8px;margin-bottom:4px;align-items:center;}
        .row.self .meta{justify-content:flex-end;}
        .bubble{display:inline-block;max-width:min(76vw,560px);background:var(--id-bg-card,#ffffff);border:1px solid var(--id-border-color,#e5e7eb);border-radius:12px;padding:10px 12px;word-break:break-word;box-shadow:0 1px 3px rgba(15,23,42,0.06);}
        .row.self .bubble{background:var(--id-chat-self-bubble-bg,#dbeafe);}
        .row.self .bubble{margin-left:auto;}
        .bubble.optimistic-item{box-shadow:none;}
        .row .bubble.btc-item{background:linear-gradient(113deg,#fff6e6 -12%,#e5bc77 103%);color:#5a4015;border-color:#d6b171;}
        .row .bubble.doge-item{background:linear-gradient(113deg,#fff9e6 -12%,#d4b84a 103%);color:#5a4a15;border-color:#c9b24f;}
        .bubble.failed-item,
        .row .bubble.btc-item.failed-item,
        .row .bubble.doge-item.failed-item{background:var(--id-bg-disabled,#e5e7eb);border-color:var(--id-border-color,#d1d5db);opacity:.82;color:var(--id-text-secondary,#4b5563);}
        .menu{position:absolute;top:-30px;display:none;gap:6px;background:var(--id-bg-card,#ffffff);border:1px solid var(--id-border-color,#e5e7eb);border-radius:999px;padding:4px 8px;box-shadow:0 3px 10px rgba(15,23,42,.12);}
        .row.self .menu{right:0;}
        .row.other .menu{left:0;}
        .card-wrap:hover .menu{display:flex;}
        .menu button{width:24px;height:24px;border:none;background:transparent;cursor:pointer;color:var(--id-text-main,#1f2937);padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;}
        .menu button:hover{background:var(--id-bg-body,#f3f4f6);}
        .menu button svg{width:16px;height:16px;fill:currentColor;}
        .send-state{margin-top:6px;font-size:12px;display:flex;align-items:center;gap:8px;color:var(--id-text-secondary,#6b7280);}
        .row.self .send-state{justify-content:flex-end;}
        .send-state.failed{color:var(--id-text-error,#dc2626);}
        .send-state button{border:1px solid currentColor;background:transparent;color:inherit;border-radius:999px;padding:1px 8px;font-size:11px;cursor:pointer;line-height:1.6;}
        .send-state button:hover{background:rgba(220,38,38,.08);}
        .text{font-size:14px;line-height:1.5;color:var(--id-text-main,#111827);white-space:normal;}
        .row .bubble.btc-item .text,
        .row .bubble.doge-item .text{color:inherit;}
        .mention{color:#fc457b;font-weight:600;cursor:pointer;}
        .reply-box{display:flex;align-items:flex-start;gap:8px;padding:6px;border-radius:8px;background:var(--id-bg-body,#f3f4f6);border:1px solid var(--id-border-color,#e5e7eb);margin-top:10px;cursor:pointer;}
        .reply-avatar{width:22px;height:22px;border-radius:999px;object-fit:cover;background:var(--id-bg-body,#e5e7eb);flex:0 0 22px;}
        .reply-main{min-width:0;flex:1;}
        .reply-head{display:flex;align-items:center;gap:8px;}
        .reply-name{font-size:11px;font-weight:600;color:var(--id-text-main,#1f2937);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .reply-text{font-size:12px;color:var(--id-text-secondary,#374151);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .media-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;}
        .img{max-width:280px;max-height:320px;border-radius:10px;display:block;cursor:zoom-in;}
        .video{max-width:320px;max-height:280px;border-radius:10px;display:block;}
        .zoom-btn{position:absolute;right:8px;top:8px;width:30px;height:30px;border-radius:999px;border:none;background:rgba(17,24,39,.72);color:#fff;cursor:pointer;display:none;align-items:center;justify-content:center;padding:0;}
        .zoom-btn svg{width:16px;height:16px;fill:#fff;}
        .media-wrap:hover .zoom-btn{display:flex;}
        .audio{width:min(320px,70vw);}
        .file-card{display:flex;align-items:center;gap:10px;min-width:220px;padding:8px 10px;border:1px solid var(--id-border-color,#e5e7eb);border-radius:10px;background:var(--id-bg-body,#f3f4f6);}
        .file-icon{font-size:24px;line-height:1;}
        .file-title{font-size:13px;font-weight:600;color:var(--id-text-title,#111827);}
        .file-sub{font-size:12px;color:var(--id-text-secondary,#6b7280);}
        .actions{margin-top:8px;display:flex;gap:10px;}
        .actions a{font-size:16px;color:var(--id-color-primary,#2563eb);text-decoration:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;}
        .preview-overlay{position:fixed;inset:0;background:var(--id-chat-overlay-bg,rgba(15,23,42,.55));display:flex;align-items:center;justify-content:center;z-index:9999;}
        .preview-dialog{position:relative;width:70vw;height:70vh;background:var(--id-bg-card,#ffffff);border-radius:12px;overflow:hidden;display:flex;align-items:center;justify-content:center;}
        .preview-body{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--id-bg-body,#f3f4f6);}
        .preview-media{max-width:100%;max-height:100%;object-fit:contain;}
        .preview-close{position:absolute;top:10px;right:10px;z-index:2;width:30px;height:30px;border-radius:999px;border:none;background:rgba(17,24,39,.8);color:#fff;cursor:pointer;}
        .inline-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(10px);opacity:0;pointer-events:none;background:rgba(17,24,39,.9);color:#fff;font-size:12px;padding:6px 10px;border-radius:999px;transition:opacity .18s ease,transform .18s ease;z-index:10000;}
        .inline-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
      </style>
      <div class="row ${self ? 'self' : 'other'}">
        ${self ? '' : `<img class="avatar" src="${this._escapeHtml(avatar)}" alt="avatar" />`}
        <div class="card-wrap">
          ${isOptimistic ? '' : `<div class="menu">
            <button data-action="copy" title="${this._escapeHtml(this._t('chat.bubble.copy', 'Copy'))}">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M16 1a2 2 0 0 1 2 2v2h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3v-1H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3h11Zm3 6H9a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1ZM16 3H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h1V8a3 3 0 0 1 3-3h7V3Z"/>
              </svg>
            </button>
            <button data-action="quote" title="${this._escapeHtml(this._t('chat.bubble.quote', 'Quote'))}">
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9.5 4A4.5 4.5 0 0 1 14 8.5v7A4.5 4.5 0 0 1 9.5 20h-5A4.5 4.5 0 0 1 0 15.5v-7A4.5 4.5 0 0 1 4.5 4h5Zm10 0A4.5 4.5 0 0 1 24 8.5v7a4.5 4.5 0 0 1-4.5 4.5h-5A4.5 4.5 0 0 1 10 15.5v-7A4.5 4.5 0 0 1 14.5 4h5ZM9.5 6h-5A2.5 2.5 0 0 0 2 8.5v7A2.5 2.5 0 0 0 4.5 18h5a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 9.5 6Zm10 0h-5A2.5 2.5 0 0 0 12 8.5v7a2.5 2.5 0 0 0 2.5 2.5h5a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 19.5 6Z"/>
              </svg>
            </button>
            <button data-action="tx">TX</button>
          </div>`}
          <div class="meta">
            <span>${this._escapeHtml(name)}</span>
            <span>${this._escapeHtml(time)}</span>
          </div>
          <div class="${this._escapeHtml(bubbleClass)}">
            <div data-role="content" class="text">${this._escapeHtml(this._t('chat.bubble.loading', 'Loading...'))}</div>
            <div data-role="reply-content"></div>
          </div>
          ${sendStateHtml}
        </div>
        ${self ? `<img class="avatar" src="${this._escapeHtml(avatar)}" alt="avatar" />` : ''}
      </div>
      ${this._renderPreviewModal()}
      <div class="inline-toast" data-role="inline-toast" aria-live="polite"></div>
    `;

    this._wireMenu(message);
    this._renderContent(message, token);
  }
}

if (!customElements.get('id-chat-bubble')) {
  customElements.define('id-chat-bubble', IdChatBubble);
}
