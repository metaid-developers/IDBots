/**
 * id-chat-input-box
 * Chat input component for group/private chat in IDFramework architecture.
 */
class IdChatInputBox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._text = '';
    this._files = [];
    this._isSending = false;
    this._quotePin = '';
    this._uploadMenuOpen = false;
    this._emojiPanelOpen = false;
    this._fileAccept = '*/*';
    this._fileInputId = 'chat-file-' + Math.random().toString(36).slice(2);
    this._onDocPointerDown = this._handleOutsidePointerDown.bind(this);
  }

  static get observedAttributes() {
    return ['group-id', 'to-metaid', 'channel-id', 'mode', 'channel-name', 'quote-pin'];
  }

  connectedCallback() {
    this._quotePin = this.getAttribute('quote-pin') || '';
    document.addEventListener('pointerdown', this._onDocPointerDown);
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._onDocPointerDown);
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'quote-pin') this._quotePin = newValue || '';
    this.render();
  }

  _isMobile() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
  }

  _mode() {
    var mode = this.getAttribute('mode');
    if (mode === 'private') return 'private';
    if (this.getAttribute('to-metaid')) return 'private';
    return 'group';
  }

  _placeholder() {
    var name = this.getAttribute('channel-name') || (this._mode() === 'group' ? '群聊' : '好友');
    var prefix = this._mode() === 'group' ? '#' : '@';
    var base = '發消息到 ' + prefix + name + '...';
    if (this._files.length > 0) return '已选择文件，点击预览卡片右上角发送';
    if (this._isMobile()) return base;
    return base + '（Shift+Space 换行）';
  }

  _showMessage(type, message) {
    if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage(type, message);
      return;
    }
    if (type === 'error') {
      window.alert(message);
      return;
    }
    console.log(message);
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  _extensionIcon(name) {
    var ext = String(name || '').toLowerCase().split('.').pop();
    var map = {
      pdf: '📄',
      zip: '🗜️',
      rar: '🗜️',
      '7z': '🗜️',
      md: '📝',
      txt: '📝',
      mp3: '🎵',
      wav: '🎵',
      flac: '🎵',
      doc: '📘',
      docx: '📘',
      xls: '📗',
      xlsx: '📗',
      ppt: '📙',
      pptx: '📙',
      json: '🧩',
      csv: '📊',
    };
    return map[ext] || '📎';
  }

  _fileKind(file) {
    if (!file || !file.type) return 'file';
    if (file.type.indexOf('image/') === 0) return 'image';
    if (file.type.indexOf('video/') === 0) return 'video';
    if (file.type.indexOf('audio/') === 0) return 'audio';
    return 'file';
  }

  async _generateVideoPoster(file) {
    var url = URL.createObjectURL(file);
    try {
      var dataUrl = await new Promise(function (resolve) {
        var video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.src = url;
        video.currentTime = 0;

        var done = function (value) {
          resolve(value || '');
        };

        video.addEventListener('loadeddata', function () {
          try {
            var canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 320;
            canvas.height = video.videoHeight || 180;
            var ctx = canvas.getContext('2d');
            if (!ctx) return done('');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            done(canvas.toDataURL('image/jpeg', 0.7));
          } catch (e) {
            done('');
          }
        }, { once: true });
        video.addEventListener('error', function () { done(''); }, { once: true });
      });
      return dataUrl;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async _buildPreview(file) {
    var kind = this._fileKind(file);
    var objectUrl = URL.createObjectURL(file);
    var preview = {
      file: file,
      kind: kind,
      url: objectUrl,
      poster: '',
      icon: this._extensionIcon(file.name),
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
    };
    if (kind === 'video') {
      preview.poster = await this._generateVideoPoster(file);
    }
    return preview;
  }

  _acceptByType(type) {
    if (type === 'photos') return 'image/*';
    if (type === 'video') return 'video/*';
    if (type === 'audio') return 'audio/*';
    return '*/*';
  }

  _openPicker(type) {
    if (String(this._text || '').trim()) {
      this._showMessage('error', '文本和文件不能同时发送，请先清空文本');
      return;
    }
    var input = this.shadowRoot.getElementById(this._fileInputId);
    if (!input) return;
    this._fileAccept = this._acceptByType(type);
    input.setAttribute('accept', this._fileAccept);
    this._uploadMenuOpen = false;
    input.click();
  }

  async _handleFileChange(event) {
    var list = event && event.target && event.target.files ? Array.from(event.target.files) : [];
    if (!list.length) return;
    var maxSize = 1024 * 1024 * 1024;
    var valid = [];
    for (var i = 0; i < list.length; i += 1) {
      var f = list[i];
      if (f.size > maxSize) {
        this._showMessage('error', '不支持上传超过1GB的文件');
      } else {
        valid.push(f);
      }
    }
    if (!valid.length) return;

    this._files.forEach(function (item) { if (item.url) URL.revokeObjectURL(item.url); });
    this._files = [];
    this._emojiPanelOpen = false;
    this._uploadMenuOpen = false;
    var preview = await this._buildPreview(valid[valid.length - 1]);
    this._files.push(preview);
    this.render();
  }

  _removeSelectedFile() {
    this._files.forEach(function (item) { if (item.url) URL.revokeObjectURL(item.url); });
    this._files = [];
    this.render();
  }

  _autoGrowTextarea() {
    var textarea = this.shadowRoot.querySelector('[data-role="chat-textarea"]');
    if (!textarea) return;
    var baseHeight = 34;
    textarea.style.height = 'auto';
    var maxHeight = 220;
    var nextHeight = Math.max(baseHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = nextHeight + 'px';
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    textarea.scrollTop = textarea.scrollHeight;
  }

  _insertEmoji(emoji) {
    var textarea = this.shadowRoot.querySelector('[data-role="chat-textarea"]');
    if (!textarea) return;
    var start = textarea.selectionStart || 0;
    var end = textarea.selectionEnd || 0;
    var val = textarea.value || '';
    textarea.value = val.slice(0, start) + emoji + val.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
    this._text = textarea.value;
    this._emojiPanelOpen = false;
    this._autoGrowTextarea();
    textarea.focus();
    this.render();
  }

  _emojiList() {
    return [
      '😀','😃','😄','😁','😆','😅','😂','🤣','😊','🙂','😉','😍','😘','🥰','😋','😎',
      '🥳','🤩','🤔','🤗','😴','😮','😢','😭','😡','🤯','🥹','😇','🤝','👍','👎','👏',
      '🙏','💪','🙌','👀','🎉','✨','🔥','💯','❤️','🧡','💛','💚','💙','💜','🖤','🤍',
      '🤎','💔','💖','💕','💞','💓','💗','💬','✅','❌','⚡','🌟','🎵','🎶','📷','🎬'
    ];
  }

  _syncInlineControls() {
    var hasText = !!String(this._text || '').trim();
    var hasFile = this._files.length > 0;
    var sendBtn = this.shadowRoot.querySelector('[data-action="send-text"]');
    if (sendBtn) {
      var canSend = hasText && !hasFile && !this._isSending;
      sendBtn.disabled = !canSend;
      sendBtn.classList.toggle('is-disabled', !canSend);
    }
    var uploadBtn = this.shadowRoot.querySelector('[data-action="toggle-upload"]');
    if (uploadBtn) {
      uploadBtn.disabled = hasText || hasFile;
    }
  }

  _inPath(node, path) {
    if (!node) return false;
    for (var i = 0; i < path.length; i += 1) {
      var p = path[i];
      if (p === node) return true;
      if (node.contains && p && p.nodeType && node.contains(p)) return true;
    }
    return false;
  }

  _handleOutsidePointerDown(event) {
    if (!this.shadowRoot) return;
    if (!this._uploadMenuOpen && !this._emojiPanelOpen) return;
    var path = event && typeof event.composedPath === 'function' ? event.composedPath() : [];
    var changed = false;

    if (this._uploadMenuOpen) {
      var menu = this.shadowRoot.querySelector('[data-role="upload-menu"]');
      var toggleUpload = this.shadowRoot.querySelector('[data-action="toggle-upload"]');
      if (!this._inPath(menu, path) && !this._inPath(toggleUpload, path)) {
        this._uploadMenuOpen = false;
        changed = true;
      }
    }

    if (this._emojiPanelOpen) {
      var emoji = this.shadowRoot.querySelector('[data-role="emoji-panel"]');
      var toggleEmoji = this.shadowRoot.querySelector('[data-action="toggle-emoji"]');
      if (!this._inPath(emoji, path) && !this._inPath(toggleEmoji, path)) {
        this._emojiPanelOpen = false;
        changed = true;
      }
    }

    if (changed) this.render();
  }

  _getStores() {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return {
      wallet: Alpine.store('wallet'),
      user: Alpine.store('user'),
      app: Alpine.store('app'),
    };
  }

  _ensureLoginReady() {
    var stores = this._getStores();
    var wallet = stores && stores.wallet;
    var user = stores && stores.user;
    var userObj = user && user.user && typeof user.user === 'object' ? user.user : null;
    var ready = !!(wallet && wallet.isConnected && wallet.address && userObj && Object.keys(userObj).length > 0);
    if (!ready) {
      this._showMessage('error', 'Please log in to your wallet before proceeding.');
      return false;
    }
    return true;
  }

  async _sendText() {
    var content = String(this._text || '').trim();
    if (!content) return;
    if (this._files.length > 0) {
      this._showMessage('error', '文件和文本只能二选一发送');
      return;
    }
    return this._dispatchSend({ content: content, file: null });
  }

  async _sendSelectedFile() {
    var file = this._files[0] ? this._files[0].file : null;
    if (!file) return;
    return this._dispatchSend({ content: '', file: file });
  }

  async _dispatchSend(data) {
    if (this._isSending) return;
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') {
      this._showMessage('error', 'IDFramework is not available');
      return;
    }
    if (!this._ensureLoginReady()) return;

    var mode = this._mode();
    var groupId = this.getAttribute('group-id') || '';
    var toMetaId = this.getAttribute('to-metaid') || '';
    var channelId = this.getAttribute('channel-id') || '';
    if (mode === 'group' && !groupId) {
      this._showMessage('error', 'groupId is required for group chat');
      return;
    }
    if (mode === 'private' && !toMetaId) {
      this._showMessage('error', 'to-metaid is required for private chat');
      return;
    }
    if (mode === 'private' && data.file && data.file.size > 1024 * 1024) {
      this._showMessage('error', '私聊文件仅支持不超过1MB');
      return;
    }

    var mentionRaw = this.getAttribute('mention');
    var mention = mentionRaw ? mentionRaw.split(',').map(function (v) { return v.trim(); }).filter(Boolean) : [];

    this._isSending = true;
    this.render();
    try {
      var stores = this._getStores();
      var nickName = stores && stores.user && stores.user.user ? (stores.user.user.name || stores.user.user.nickname || '') : '';
      var res = await window.IDFramework.dispatch('sendChatMessage', {
        mode: mode,
        groupId: groupId,
        to: toMetaId,
        channelId: channelId,
        nickName: nickName,
        content: data.content || '',
        file: data.file || null,
        replyPin: this._quotePin,
        mention: mention,
      });
      this._showMessage('success', '消息发送成功');
      this.dispatchEvent(new CustomEvent('chat-sent', {
        detail: res || {},
        bubbles: true,
        composed: true,
      }));
      this._text = '';
      this._quotePin = '';
      this._removeSelectedFile();
      this._isSending = false;
      this._uploadMenuOpen = false;
      this._emojiPanelOpen = false;
      this.render();
    } catch (error) {
      if (!(error && error._alreadyShown)) {
        this._showMessage('error', error && error.message ? error.message : '发送失败');
      }
      this._isSending = false;
      this.render();
    }
  }

  render() {
    var self = this;
    var hasText = !!String(this._text || '').trim();
    var selected = this._files[0] || null;
    var previewBody = '';
    if (selected) {
      if (selected.kind === 'image') {
        previewBody = '<img class="bubble-image" src="' + selected.url + '" alt="preview">';
      } else if (selected.kind === 'video') {
        if (selected.poster) {
          previewBody = '<img class="bubble-image" src="' + selected.poster + '" alt="preview"><span class="bubble-badge">VIDEO</span>';
        } else {
          previewBody = '<div class="bubble-icon">🎬</div><span class="bubble-badge">VIDEO</span>';
        }
      } else if (selected.kind === 'audio') {
        previewBody = '<div class="bubble-icon">🎵</div>';
      } else {
        previewBody = '<div class="bubble-icon">' + this._escapeHtml(selected.icon) + '</div>';
      }
    }

    var uploadMenu = this._uploadMenuOpen ? (
      '<div class="drawer drawer-upload" data-role="upload-menu">' +
        '<div class="upload-grid">' +
          '<button class="menu-item" data-action="pick-type" data-type="photos"><span class="menu-icon">🖼️</span><span>Photos</span></button>' +
          '<button class="menu-item" data-action="pick-type" data-type="video"><span class="menu-icon">🎬</span><span>Video</span></button>' +
          '<button class="menu-item" data-action="pick-type" data-type="audio"><span class="menu-icon">🎵</span><span>Audio</span></button>' +
          '<button class="menu-item" data-action="pick-type" data-type="file"><span class="menu-icon">📎</span><span>File</span></button>' +
        '</div>' +
      '</div>'
    ) : '';

    var emojis = this._emojiList();
    var emojiPanel = this._emojiPanelOpen ? (
      '<div class="drawer emoji-panel" data-role="emoji-panel">' +
        emojis.map(function (emoji) {
          return '<button class="emoji" data-action="emoji" data-emoji="' + emoji + '">' + emoji + '</button>';
        }).join('') +
      '</div>'
    ) : '';

    this.shadowRoot.innerHTML = '' +
      '<style>' +
      ':host{display:block;font-family:var(--id-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);}' +
      '.wrap{position:relative;background:#f2f3f5;border:1px solid #e5e7eb;border-radius:14px;padding:10px;}' +
      '.quote{font-size:12px;color:#6b7280;border:1px solid #e5e7eb;background:#f8fafc;padding:8px;border-radius:8px;margin-bottom:8px;display:flex;justify-content:space-between;gap:8px;}' +
      '.quote button{border:none;background:transparent;cursor:pointer;color:#9ca3af;font-size:16px;line-height:1;}' +
      '.preview-wrap{border-bottom:1px solid #e5e7eb;padding:2px 0 10px 0;margin-bottom:8px;}' +
      '.bubble{position:relative;width:50px;height:50px;border-radius:8px;border:1px solid #e5e7eb;background:#f9fafb;overflow:hidden;display:flex;align-items:center;justify-content:center;}' +
      '.bubble-actions{position:absolute;right:-20px;top:-4px;display:flex;gap:6px;}' +
      '.mini-btn{width:22px;height:22px;border-radius:6px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;}' +
      '.mini-btn.send{border-color:#2563eb;background:#2563eb;color:#fff;}' +
      '.bubble-image{width:100%;height:100%;object-fit:cover;}' +
      '.bubble-icon{font-size:22px;}' +
      '.bubble-badge{position:absolute;right:2px;bottom:2px;background:rgba(17,24,39,.78);color:#fff;border-radius:4px;padding:1px 3px;font-size:9px;}' +
      '.bubble-meta{margin-top:4px;color:#6b7280;font-size:11px;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.row{display:flex;align-items:flex-end;gap:8px;background:#f2f3f5;}' +
      '.textarea{flex:1;height:34px;min-height:34px;max-height:220px;line-height:1.2;resize:none;overflow-y:hidden;border:1px solid #d1d5db;border-radius:10px;padding:5px 10px;font-size:14px;outline:none;box-sizing:border-box;background:#fff;}' +
      '.textarea:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.14);}' +
      '.textarea:disabled{background:#f9fafb;color:#9ca3af;cursor:not-allowed;}' +
      '.right-icons{position:relative;display:flex;gap:6px;align-items:center;}' +
      '.icon-btn{width:34px;height:34px;border-radius:999px;border:1px solid #d1d5db;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;}' +
      '.icon-btn:hover{background:#f9fafb;}' +
      '.icon-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff;}' +
      '.icon-btn.send-inline{transition:opacity .15s ease;}' +
      '.icon-btn.primary.is-disabled{background:#cbd5e1;border-color:#cbd5e1;color:#f8fafc;}' +
      '.icon-btn:disabled{opacity:.5;cursor:not-allowed;}' +
      '.drawer{margin-top:10px;border-top:1px solid #e5e7eb;background:#f2f3f5;border-radius:10px;padding:10px;}' +
      '.upload-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}' +
      '.menu-item{border:none;background:transparent;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:#4b5563;}' +
      '.menu-icon{width:46px;height:46px;border-radius:12px;background:#fff;border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;font-size:20px;}' +
      '.menu-item:hover .menu-icon{background:#f9fafb;}' +
      '.emoji-panel{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;max-height:180px;overflow:auto;}' +
      '.emoji{border:1px solid #e5e7eb;background:#fff;border-radius:10px;padding:8px;cursor:pointer;font-size:24px;line-height:1;}' +
      '.emoji:hover{background:#f9fafb;}' +
      '@media (max-width: 768px){.upload-grid{grid-template-columns:repeat(4,1fr)}.emoji-panel{grid-template-columns:repeat(6,1fr)}}' +
      '</style>' +
      '<section class="wrap">' +
        (this._quotePin ? '<div class="quote"><span>Reply Pin: ' + this._escapeHtml(this._quotePin) + '</span><button data-action="clear-quote">×</button></div>' : '') +
        (selected ? (
          '<div class="preview-wrap">' +
            '<div class="bubble">' +
              '<div class="bubble-actions">' +
                '<button class="mini-btn" data-action="cancel-file" title="Cancel">✕</button>' +
                '<button class="mini-btn send" data-action="send-file" title="Send" ' + (this._isSending ? 'disabled' : '') + '>➤</button>' +
              '</div>' +
              previewBody +
            '</div>' +
            '<div class="bubble-meta" title="' + this._escapeHtml(selected.file.name) + '">' +
              this._escapeHtml(selected.file.name) + ' · ' + this._escapeHtml(this._formatFileSize(selected.file.size)) +
            '</div>' +
          '</div>'
        ) : '') +
        '<div class="row">' +
          '<textarea class="textarea" data-role="chat-textarea" ' + (selected ? 'disabled' : '') + ' placeholder="' + this._escapeHtml(this._placeholder()) + '">' + this._escapeHtml(this._text) + '</textarea>' +
          '<div class="right-icons">' +
            '<input id="' + this._fileInputId + '" type="file" hidden accept="' + this._escapeHtml(this._fileAccept) + '">' +
            '<button class="icon-btn" data-action="toggle-emoji" title="Emoji">😊</button>' +
            '<button class="icon-btn" data-action="toggle-upload" title="Upload" ' + (hasText ? 'disabled' : '') + '>＋</button>' +
            '<button class="icon-btn primary send-inline" data-action="send-text" ' + (this._isSending ? 'disabled' : '') + ' title="Send">➤</button>' +
          '</div>' +
        '</div>' +
        uploadMenu +
        emojiPanel +
      '</section>';

    var textarea = this.shadowRoot.querySelector('[data-role="chat-textarea"]');
    if (textarea) {
      textarea.addEventListener('input', function (e) {
        self._text = e.target.value || '';
        var shouldRender = false;
        if (self._text.trim() && self._uploadMenuOpen) {
          self._uploadMenuOpen = false;
          shouldRender = true;
        }
        self._autoGrowTextarea();
        if (shouldRender) {
          self.render();
          return;
        }
        self._syncInlineControls();
      });
      textarea.addEventListener('keydown', function (e) {
        if (e.key === ' ' && e.shiftKey) {
          e.preventDefault();
          var start = textarea.selectionStart || 0;
          var end = textarea.selectionEnd || 0;
          var val = textarea.value || '';
          textarea.value = val.slice(0, start) + '\n' + val.slice(end);
          textarea.selectionStart = textarea.selectionEnd = start + 1;
          self._text = textarea.value;
          self._autoGrowTextarea();
          return;
        }
        if (!self._isMobile() && e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          self._sendText();
        }
      });
      setTimeout(function () { self._autoGrowTextarea(); }, 0);
    }

    var input = this.shadowRoot.getElementById(this._fileInputId);
    if (input) {
      input.addEventListener('change', async function (e) {
        await self._handleFileChange(e);
        input.value = '';
      });
    }

    var sendTextBtn = this.shadowRoot.querySelector('[data-action="send-text"]');
    if (sendTextBtn) sendTextBtn.addEventListener('click', function () { self._sendText(); });

    var sendFileBtn = this.shadowRoot.querySelector('[data-action="send-file"]');
    if (sendFileBtn) sendFileBtn.addEventListener('click', function () { self._sendSelectedFile(); });

    var cancelFileBtn = this.shadowRoot.querySelector('[data-action="cancel-file"]');
    if (cancelFileBtn) cancelFileBtn.addEventListener('click', function () { self._removeSelectedFile(); });

    var uploadToggle = this.shadowRoot.querySelector('[data-action="toggle-upload"]');
    if (uploadToggle) {
      uploadToggle.addEventListener('click', function () {
        if (String(self._text || '').trim()) {
          self._showMessage('error', '文本和文件不能同时发送，请先清空文本');
          return;
        }
        self._uploadMenuOpen = !self._uploadMenuOpen;
        self._emojiPanelOpen = false;
        self.render();
      });
    }

    var emojiToggle = this.shadowRoot.querySelector('[data-action="toggle-emoji"]');
    if (emojiToggle) {
      emojiToggle.addEventListener('click', function () {
        self._emojiPanelOpen = !self._emojiPanelOpen;
        self._uploadMenuOpen = false;
        self.render();
      });
    }

    Array.from(this.shadowRoot.querySelectorAll('[data-action="pick-type"]')).forEach(function (el) {
      el.addEventListener('click', function () {
        self._openPicker(el.getAttribute('data-type') || 'file');
      });
    });

    Array.from(this.shadowRoot.querySelectorAll('[data-action="emoji"]')).forEach(function (el) {
      el.addEventListener('click', function () {
        self._insertEmoji(el.getAttribute('data-emoji') || '');
      });
    });

    var clearQuoteBtn = this.shadowRoot.querySelector('[data-action="clear-quote"]');
    if (clearQuoteBtn) {
      clearQuoteBtn.addEventListener('click', function () {
        self._quotePin = '';
        self.removeAttribute('quote-pin');
        self.render();
      });
    }

    this._syncInlineControls();
  }
}

if (!customElements.get('id-chat-input-box')) {
  customElements.define('id-chat-input-box', IdChatInputBox);
}

