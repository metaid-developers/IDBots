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
    this._quoteData = null;
    this._uploadMenuOpen = false;
    this._emojiPanelOpen = false;
    this._showMentionDropdown = false;
    this._mentionQuery = '';
    this._mentionStartPos = -1;
    this._mentionActiveIndex = 0;
    this._currentMentions = [];
    this._mentionUsers = [];
    this._defaultMembersCache = [];
    this._mentionLoading = false;
    this._mentionReqSeq = 0;
    this._mentionSearchTimer = null;
    this._fileAccept = '*/*';
    this._fileInputId = 'chat-file-' + Math.random().toString(36).slice(2);
    this._onDocPointerDown = this._handleOutsidePointerDown.bind(this);
    this._onBubbleQuote = this._handleBubbleQuote.bind(this);
  }

  static get observedAttributes() {
    return ['group-id', 'to-metaid', 'channel-id', 'mode', 'channel-name', 'quote-pin', 'mention-users'];
  }

  connectedCallback() {
    this._quotePin = this.getAttribute('quote-pin') || '';
    document.addEventListener('pointerdown', this._onDocPointerDown);
    document.addEventListener('bubble-quote', this._onBubbleQuote);
    this.render();
  }

  disconnectedCallback() {
    document.removeEventListener('pointerdown', this._onDocPointerDown);
    document.removeEventListener('bubble-quote', this._onBubbleQuote);
    if (this._mentionSearchTimer) clearTimeout(this._mentionSearchTimer);
    this._mentionSearchTimer = null;
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'quote-pin') {
      this._quotePin = newValue || '';
      if (this._quotePin && !this._quoteData) {
        this._quoteData = { pinId: this._quotePin, quoteName: '', quoteText: '' };
      }
      if (!this._quotePin) this._quoteData = null;
    }
    if (name === 'mention-users') {
      this._mentionActiveIndex = 0;
      this._showMentionDropdown = false;
      this._mentionUsers = [];
      this._defaultMembersCache = [];
    }
    this.render();
  }

  _parseMentionUsers() {
    var raw = this.getAttribute('mention-users') || '';
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map(function (item) {
          if (!item || typeof item !== 'object') return null;
          var globalMetaId = String(item.globalMetaId || item.metaId || '').trim();
          var name = String(item.name || item.nickName || '').trim();
          if (!name) return null;
          return { globalMetaId: globalMetaId, name: name };
        })
        .filter(Boolean);
    } catch (_) {
      // 容错：支持单引号 JSON（常见于手写 HTML 属性）
      try {
        var normalized = raw.replace(/'/g, '"');
        var parsed2 = JSON.parse(normalized);
        if (!Array.isArray(parsed2)) return [];
        return parsed2
          .map(function (item) {
            if (!item || typeof item !== 'object') return null;
            var globalMetaId = String(item.globalMetaId || item.metaId || '').trim();
            var name = String(item.name || item.nickName || '').trim();
            if (!name) return null;
            return { globalMetaId: globalMetaId, name: name };
          })
          .filter(Boolean);
      } catch (_) {
        return [];
      }
    }
  }

  _mentionFilteredUsers() {
    var users = this._mentionUsers.length ? this._mentionUsers : this._parseMentionUsers();
    var query = String(this._mentionQuery || '').trim().toLowerCase();
    if (!query) return users.slice(0, 8);
    return users
      .filter(function (item) { return item.name.toLowerCase().indexOf(query) > -1; })
      .slice(0, 8);
  }

  _normalizeMentionUser(item) {
    if (!item || typeof item !== 'object') return null;
    var userInfo = item.userInfo && typeof item.userInfo === 'object' ? item.userInfo : null;
    var globalMetaId = String(
      item.globalMetaId ||
      item.globalmetaid ||
      item.metaId ||
      (userInfo && (userInfo.globalMetaId || userInfo.globalmetaid || userInfo.metaId)) ||
      ''
    ).trim();
    var name = String(
      item.name ||
      item.nickName ||
      item.nickname ||
      (userInfo && (userInfo.name || userInfo.nickName || userInfo.nickname)) ||
      ''
    ).trim();
    if (!name) return null;
    return { globalMetaId: globalMetaId, name: name };
  }

  _dedupeMentionUsers(list) {
    if (!Array.isArray(list)) return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < list.length; i += 1) {
      var n = this._normalizeMentionUser(list[i]);
      if (!n) continue;
      var key = n.globalMetaId || ('name:' + n.name.toLowerCase());
      if (seen[key]) continue;
      seen[key] = true;
      out.push(n);
    }
    return out;
  }

  _getTalkApiBase() {
    var attr = String(this.getAttribute('chat-api-base') || '').trim();
    var config = (window.IDConfig && (
      window.IDConfig.CHAT_API_BASE ||
      window.IDConfig.CHAT_API_BASE_URL ||
      window.IDConfig.TALK_API_BASE ||
      window.IDConfig.TALK_API
    )) || '';
    var service = (window.ServiceLocator && (
      window.ServiceLocator.chat_api ||
      window.ServiceLocator.chatApi ||
      window.ServiceLocator.talk
    )) || '';
    var base = attr || String(config || '').trim() || String(service || '').trim();
    if (!base) return '';
    base = base.replace(/\/+$/, '');
    if (base.slice(-10) !== '/group-chat') {
      base += '/group-chat';
    }
    return base;
  }

  async _fetchMentionUsers(path, reqSeq) {
    var base = this._getTalkApiBase();
    if (!base) return [];
    var url = base + path;
    var res = await fetch(url, { method: 'GET' });
    if (!res.ok) return [];
    var payload = await res.json();
    if (reqSeq !== this._mentionReqSeq) return [];
    var data = payload && typeof payload === 'object' && payload.data ? payload.data : payload;
    if (Array.isArray(data)) return this._dedupeMentionUsers(data);
    if (data && Array.isArray(data.list)) return this._dedupeMentionUsers(data.list);
    var merged = [];
    if (data && Array.isArray(data.creator)) merged = merged.concat(data.creator);
    if (data && Array.isArray(data.admins)) merged = merged.concat(data.admins);
    if (data && Array.isArray(data.list)) merged = merged.concat(data.list);
    return this._dedupeMentionUsers(merged);
  }

  async loadDefaultMembers() {
    if (this._mode() !== 'group') {
      this._mentionUsers = [];
      return;
    }
    if (this._defaultMembersCache.length > 0) {
      this._mentionUsers = this._defaultMembersCache.slice();
      this._refreshMentionDropdown();
      return;
    }
    var groupId = String(this.getAttribute('group-id') || '').trim();
    if (!groupId) {
      this._mentionUsers = this._parseMentionUsers();
      this._refreshMentionDropdown();
      return;
    }
    var reqSeq = ++this._mentionReqSeq;
    this._mentionLoading = true;
    try {
      var query = '?groupId=' + encodeURIComponent(groupId) + '&size=10&orderBy=timestamp&orderType=desc';
      var users = await this._fetchMentionUsers('/group-member-list' + query, reqSeq);
      if (!users.length) users = this._parseMentionUsers();
      if (reqSeq !== this._mentionReqSeq) return;
      this._defaultMembersCache = users.slice();
      this._mentionUsers = users;
      this._refreshMentionDropdown();
    } catch (_) {
      if (reqSeq !== this._mentionReqSeq) return;
      this._mentionUsers = this._parseMentionUsers();
      this._refreshMentionDropdown();
    } finally {
      if (reqSeq === this._mentionReqSeq) this._mentionLoading = false;
    }
  }

  async searchMentionUsers(query) {
    if (this._mode() !== 'group') {
      this._mentionUsers = [];
      return;
    }
    var q = String(query || '').trim();
    if (!q) {
      this.loadDefaultMembers();
      return;
    }
    var groupId = String(this.getAttribute('group-id') || '').trim();
    if (!groupId) {
      this._mentionUsers = this._parseMentionUsers();
      this._refreshMentionDropdown();
      return;
    }
    var reqSeq = ++this._mentionReqSeq;
    this._mentionLoading = true;
    try {
      var queryString = '?groupId=' + encodeURIComponent(groupId) + '&size=10&query=' + encodeURIComponent(q);
      var users = await this._fetchMentionUsers('/search-group-members' + queryString, reqSeq);
      if (!users.length) users = this._parseMentionUsers();
      if (reqSeq !== this._mentionReqSeq) return;
      this._mentionUsers = users;
      this._refreshMentionDropdown();
    } catch (_) {
      if (reqSeq !== this._mentionReqSeq) return;
      this._mentionUsers = this._parseMentionUsers();
      this._refreshMentionDropdown();
    } finally {
      if (reqSeq === this._mentionReqSeq) this._mentionLoading = false;
    }
  }

  _renderMentionDropdownContent() {
    var self = this;
    if (self._mentionLoading) {
      return '<div class="mention-item"><span>Loading mention users...</span></div>';
    }
    var mentionUsers = self._mentionFilteredUsers();
    if (!mentionUsers.length) {
      return '<div class="mention-item"><span>No mention users configured.</span></div>';
    }
    return mentionUsers.map(function (item, index) {
      return '<div class="mention-item ' + (self._mentionActiveIndex === index ? 'active' : '') + '" data-action="mention-select" data-index="' + index + '">' +
        '<span>@' + self._escapeHtml(item.name) + '</span>' +
        '<span class="mention-meta">' + self._escapeHtml(item.globalMetaId || '') + '</span>' +
      '</div>';
    }).join('');
  }

  _refreshMentionDropdown() {
    if (!this.shadowRoot) return;
    var dropdown = this.shadowRoot.querySelector('[data-role="mention-dropdown"]');
    if (!this._showMentionDropdown) {
      if (dropdown) dropdown.remove();
      return;
    }
    if (!dropdown) {
      var row = this.shadowRoot.querySelector('.row');
      if (!row || !row.parentNode) return;
      dropdown = document.createElement('div');
      dropdown.className = 'mention-dropdown';
      dropdown.setAttribute('data-role', 'mention-dropdown');
      row.insertAdjacentElement('afterend', dropdown);
    }
    dropdown.innerHTML = this._renderMentionDropdownContent();
    var self = this;
    Array.from(dropdown.querySelectorAll('[data-action="mention-select"]')).forEach(function (el) {
      el.addEventListener('click', function () {
        var index = Number(el.getAttribute('data-index') || 0);
        self._selectMentionAtIndex(index);
      });
    });
  }

  _scheduleMentionLookup(query) {
    if (this._mentionSearchTimer) clearTimeout(this._mentionSearchTimer);
    var self = this;
    this._mentionLoading = true;
    this._refreshMentionDropdown();
    this._mentionSearchTimer = setTimeout(function () {
      if (!query) {
        self.loadDefaultMembers();
        return;
      }
      self.searchMentionUsers(query);
    }, 120);
  }

  _syncMentionsWithText() {
    var text = String(this._text || '');
    this._currentMentions = this._currentMentions.filter(function (item) {
      return text.indexOf('@' + item.name) > -1;
    });
  }

  _updateMentionState(textarea) {
    var text = textarea.value || '';
    var cursor = Number(textarea.selectionStart || 0);
    var before = text.slice(0, cursor);
    var lastAt = before.lastIndexOf('@');
    this._syncMentionsWithText();
    if (lastAt < 0) {
      this._showMentionDropdown = false;
      return;
    }
    var mentionChunk = before.slice(lastAt + 1);
    if (mentionChunk.indexOf(' ') > -1 || mentionChunk.indexOf('\n') > -1) {
      this._showMentionDropdown = false;
      return;
    }
    if (this._mode() !== 'group') {
      this._showMentionDropdown = false;
      return;
    }
    this._mentionStartPos = lastAt;
    this._mentionQuery = mentionChunk;
    this._mentionActiveIndex = 0;
    this._showMentionDropdown = true;
    this._scheduleMentionLookup(mentionChunk);
  }

  handleInput(e) {
    var target = e && e.target ? e.target : null;
    if (!target) return;
    this._text = target.value || '';
    this._syncMentionsWithText();
    this._updateMentionState(target);
  }

  _selectMentionAtIndex(idx) {
    var users = this._mentionFilteredUsers();
    var user = users[idx];
    if (!user) return;
    var textarea = this.shadowRoot.querySelector('[data-role="chat-textarea"]');
    if (!textarea) return;
    var val = textarea.value || '';
    var cursor = Number(textarea.selectionStart || 0);
    var beforeMention = val.slice(0, this._mentionStartPos);
    var afterMention = val.slice(cursor);
    var mentionText = '@' + user.name + ' ';
    textarea.value = beforeMention + mentionText + afterMention;
    this._text = textarea.value;
    if (!this._currentMentions.some(function (m) { return m.name === user.name; })) {
      this._currentMentions.push({ globalMetaId: user.globalMetaId || '', name: user.name });
    }
    var newPos = beforeMention.length + mentionText.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    this._showMentionDropdown = false;
    this._mentionQuery = '';
    this._mentionStartPos = -1;
    this._autoGrowTextarea();
    this.render();
  }

  _handleBubbleQuote(event) {
    var detail = event && event.detail && typeof event.detail === 'object' ? event.detail : null;
    if (!detail) return;
    var pinId = String(detail.pinId || (detail.message && detail.message.pinId) || '').trim();
    if (!pinId) return;
    this._quotePin = pinId;
    this.setAttribute('quote-pin', pinId);
    this._quoteData = {
      pinId: pinId,
      quoteName: String(detail.quoteName || ''),
      quoteText: String(detail.quoteText || ''),
    };
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
    var maxSize = 5 * 1024 * 1024;
    var valid = [];
    for (var i = 0; i < list.length; i += 1) {
      var f = list[i];
      if (f.size > maxSize) {
        this._showMessage('error', 'Currently, only files under 5MB can be sent.');
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
    if (!this._uploadMenuOpen && !this._emojiPanelOpen && !this._showMentionDropdown) return;
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

    if (this._showMentionDropdown) {
      var mention = this.shadowRoot.querySelector('[data-role="mention-dropdown"]');
      var textarea = this.shadowRoot.querySelector('[data-role="chat-textarea"]');
      if (!this._inPath(mention, path) && !this._inPath(textarea, path)) {
        this._showMentionDropdown = false;
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
    if (data.file && data.file.size > 5 * 1024 * 1024) {
      this._showMessage('error', 'Currently, only files under 5MB can be sent.');
      return;
    }

    var mention = this._currentMentions.slice();

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
      this._quoteData = null;
      this._currentMentions = [];
      this._showMentionDropdown = false;
      this._mentionQuery = '';
      this._mentionStartPos = -1;
      this.removeAttribute('quote-pin');
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
      '.quote{font-size:12px;color:#4b5563;border:1px solid #e5e7eb;background:#f8fafc;padding:8px;border-radius:10px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px;}' +
      '.quote-main{display:flex;align-items:center;min-width:0;gap:4px;flex:1;}' +
      '.quote-tips{color:#6b7280;flex:0 0 auto;}' +
      '.quote-user{color:#2563eb;cursor:pointer;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.quote-text{color:#374151;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.quote button{border:none;background:transparent;cursor:pointer;color:#9ca3af;font-size:16px;line-height:1;flex:0 0 auto;}' +
      '.preview-wrap{border-bottom:1px solid #e5e7eb;padding:2px 0 10px 0;margin-bottom:8px;display:flex;align-items:flex-start;gap:10px;}' +
      '.bubble{position:relative;width:50px;min-width:50px;height:50px;min-height:50px;border-radius:8px;border:1px solid #e5e7eb;background:#f9fafb;overflow:hidden;display:flex;align-items:center;justify-content:center;}' +
      '.bubble-actions{display:flex;flex-direction:column;gap:6px;}' +
      '.mini-btn{width:24px;height:24px;border-radius:6px;border:1px solid #d1d5db;background:#fff;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;}' +
      '.mini-btn.send{border-color:#2563eb;background:#2563eb;color:#fff;font-size:13px;}' +
      '.bubble-image{width:100%;height:100%;object-fit:cover;}' +
      '.bubble-icon{font-size:22px;}' +
      '.bubble-badge{position:absolute;right:2px;bottom:2px;background:rgba(17,24,39,.78);color:#fff;border-radius:4px;padding:1px 3px;font-size:9px;}' +
      '.bubble-meta{color:#6b7280;font-size:11px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4;}' +
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
      '.mention-dropdown{margin-top:8px;border:1px solid #e5e7eb;background:#fff;border-radius:10px;max-height:180px;overflow:auto;}' +
      '.mention-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;cursor:pointer;font-size:13px;color:#374151;}' +
      '.mention-item:hover{background:#f9fafb;}' +
      '.mention-item.active{background:#eef2ff;color:#1d4ed8;}' +
      '.mention-meta{font-size:11px;color:#9ca3af;margin-left:8px;}' +
      '@media (max-width: 768px){.upload-grid{grid-template-columns:repeat(4,1fr)}.emoji-panel{grid-template-columns:repeat(6,1fr)}}' +
      '</style>' +
      '<section class="wrap">' +
        (this._quotePin ? (
          '<div class="quote">' +
            '<div class="quote-main">' +
              '<span class="quote-tips">Reply</span>' +
              '<span class="quote-user">' + this._escapeHtml((this._quoteData && this._quoteData.quoteName) || 'Unknown') + '</span>' +
              '<span class="quote-text">: ' + this._escapeHtml((this._quoteData && this._quoteData.quoteText) || this._quotePin) + '</span>' +
            '</div>' +
            '<button data-action="clear-quote">✕</button>' +
          '</div>'
        ) : '') +
        (selected ? (
          '<div class="preview-wrap">' +
            '<div class="bubble">' +
              previewBody +
            '</div>' +
            '<div>' +
              '<div class="bubble-actions">' +
                '<button class="mini-btn" data-action="cancel-file" title="Cancel">✕</button>' +
                '<button class="mini-btn send" data-action="send-file" title="Send file" ' + (this._isSending ? 'disabled' : '') + '>📤</button>' +
              '</div>' +
              '<div class="bubble-meta" title="' + this._escapeHtml(selected.file.name) + '">' +
                this._escapeHtml(selected.file.name) + ' · ' + this._escapeHtml(this._formatFileSize(selected.file.size)) +
              '</div>' +
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
        (this._showMentionDropdown ? (
          '<div class="mention-dropdown" data-role="mention-dropdown">' +
            this._renderMentionDropdownContent() +
          '</div>'
        ) : '') +
        uploadMenu +
        emojiPanel +
      '</section>';

    var textarea = this.shadowRoot.querySelector('[data-role="chat-textarea"]');
    if (textarea) {
      textarea.addEventListener('input', function (e) {
        var prevShowMention = self._showMentionDropdown;
        self.handleInput(e);
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
        if (prevShowMention !== self._showMentionDropdown) {
          self.render();
          return;
        }
        if (self._showMentionDropdown) self._refreshMentionDropdown();
      });
      textarea.addEventListener('keydown', function (e) {
        if (self._showMentionDropdown) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            var max = self._mentionFilteredUsers().length - 1;
            self._mentionActiveIndex = Math.min(max, self._mentionActiveIndex + 1);
            self.render();
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            self._mentionActiveIndex = Math.max(0, self._mentionActiveIndex - 1);
            self.render();
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            self._selectMentionAtIndex(self._mentionActiveIndex);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            self._showMentionDropdown = false;
            self.render();
            return;
          }
        }
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
        self._quoteData = null;
        self.removeAttribute('quote-pin');
        self.render();
      });
    }

    Array.from(this.shadowRoot.querySelectorAll('[data-action="mention-select"]')).forEach(function (el) {
      el.addEventListener('click', function () {
        var index = Number(el.getAttribute('data-index') || 0);
        self._selectMentionAtIndex(index);
      });
    });

    this._syncInlineControls();
  }
}

if (!customElements.get('id-chat-input-box')) {
  customElements.define('id-chat-input-box', IdChatInputBox);
}

