/**
 * id-chat-chatlist-panel - Web Component for displaying chat list
 * Uses Shadow DOM with CSS Variables for theming
 * Structure (Layout) managed via CSS, Skin (Theme) managed via CSS Variables
 * Follows IDFramework MVC pattern - View layer only, no business logic
 */

class IdChatChatlistPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._storeSignature = '';
    this._onChatUpdated = this._handleChatUpdated.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
    this._renderScheduled = false;
  }

  static get observedAttributes() {
    return ['current-conversation'];
  }

  connectedCallback() {
    requestAnimationFrame(() => {
      this.render();
      this._watchStores();
    });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      if (!this._renderScheduled) {
        this._renderScheduled = true;
        requestAnimationFrame(() => {
          this._renderScheduled = false;
          this.render();
        });
      }
    }
  }

  /**
   * Watch Alpine stores for changes
   */
  _watchStores() {
    if (typeof Alpine === 'undefined') return;
    this._storeSignature = this._buildStoreSignature();
    document.addEventListener('id:chat:updated', this._onChatUpdated);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  _handleChatUpdated() {
    const signature = this._buildStoreSignature();
    if (signature !== this._storeSignature) {
      this._storeSignature = signature;
      this.render();
    }
  }

  _buildStoreSignature() {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return '';
    const chatStore = Alpine.store('chat');
    if (!chatStore) return '';
    const conversations = chatStore.conversations || {};
    const keys = Object.keys(conversations).sort();
    const head = keys.slice(0, 32).map((key) => {
      const item = conversations[key] || {};
      return [
        key,
        String(item.type || ''),
        String(item.lastMessageTime || ''),
        String(item.index || ''),
        String(item.lastMessage || ''),
        String(item.name || ''),
        String(item.avatar || ''),
        String(item.unreadCount || 0),
        String(item.unreadMentionCount || item.mentionUnreadCount || 0),
      ].join(':');
    }).join('|');
    return [
      String(chatStore.currentConversation || ''),
      String(chatStore.currentConversationType || ''),
      String(chatStore.isLoading ? 1 : 0),
      String(chatStore.error || ''),
      String(keys.length),
      head,
    ].join('||');
  }

  disconnectedCallback() {
    document.removeEventListener('id:chat:updated', this._onChatUpdated);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  _handleLocaleChanged() {
    this._storeSignature = '';
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

  _localeTag() {
    if (
      typeof window !== 'undefined' &&
      window.IDFramework &&
      window.IDFramework.I18n &&
      typeof window.IDFramework.I18n.getLocale === 'function'
    ) {
      const locale = String(window.IDFramework.I18n.getLocale() || '').trim();
      return locale === 'zh' ? 'zh-CN' : 'en-US';
    }
    return 'en-US';
  }

  /**
   * Render the component
   */
  render() {
    const currentConversationAttr = this.getAttribute('current-conversation') || '';

    // Get data from Alpine stores
    let conversations = {};
    let isLoading = false;
    let error = null;
    let userStore = {};

    if (typeof Alpine !== 'undefined') {
      const chatStore = Alpine.store('chat');
      if (chatStore) {
        conversations = chatStore.conversations || {};
        isLoading = chatStore.isLoading || false;
        error = chatStore.error || null;
      }

      const userStoreObj = Alpine.store('user');
      if (userStoreObj) {
        userStore = userStoreObj.users || {};
      }
    }

    const currentConversation = currentConversationAttr || (this._getStore('chat')?.currentConversation || null);

    // Sort conversations by last message time (most recent first)
    const sortedConversations = Object.entries(conversations).sort((a, b) => {
      const timeA = Number(a[1].lastMessageTime || 0);
      const timeB = Number(b[1].lastMessageTime || 0);
      if (timeB !== timeA) return timeB - timeA;
      const indexA = Number(a[1].index || 0);
      const indexB = Number(b[1].index || 0);
      if (indexB !== indexA) return indexB - indexA;
      return String(a[0]).localeCompare(String(b[0]));
    });

    const hasConversations = sortedConversations.length > 0;
    const showInitialLoading = isLoading && !hasConversations;
    const showInlineLoading = isLoading && hasConversations;

    const listBodyHtml = showInitialLoading ? `
      <div class="loading-state">${this.escapeHtml(this._t('chat.chatlist.loadingConversations', 'Loading conversations...'))}</div>
    ` : error ? `
      <div class="error-state">${this.escapeHtml(this._t('chat.chatlist.errorPrefix', 'Error:'))} ${this.escapeHtml(error)}</div>
    ` : !hasConversations ? `
      <div class="empty-state">
        <p>${this.escapeHtml(this._t('chat.chatlist.emptyTitle', 'No conversations yet'))}</p>
        <p class="empty-state-hint">${this.escapeHtml(this._t('chat.chatlist.emptyHint', 'Start a new chat to begin messaging'))}</p>
      </div>
    ` : sortedConversations.map(([metaid, conversation]) => {
      const isGroupChat = String(conversation.type || '') === '1';
      const isPrivateChat = String(conversation.type || '') === '2';
      const participantMetaId = String(conversation.participantMetaId || metaid || '');
      const userInfo = userStore[participantMetaId] || userStore[metaid] || {};
      let userName = '';
      let userAvatar = '';
      if (isGroupChat) {
        userName = String(conversation.name || userInfo.name || this._t('chat.chatlist.unnamedGroup', 'Unnamed Group'));
        userAvatar = String(conversation.avatar || userInfo.avatarUrl || userInfo.avatar || '');
      } else if (isPrivateChat) {
        userName = String(userInfo.name || conversation.name || this.truncateMetaId(metaid) || this._t('chat.chatlist.unknownUser', 'Unknown User'));
        userAvatar = String(userInfo.avatarUrl || userInfo.avatar || conversation.avatar || '');
      } else {
        userName = String(userInfo.name || conversation.name || this.truncateMetaId(metaid) || this._t('chat.chatlist.unknownUser', 'Unknown User'));
        userAvatar = String(userInfo.avatarUrl || userInfo.avatar || conversation.avatar || '');
      }

      const isActive = currentConversation === metaid;
      const previewText = String(conversation.lastMessage || '').trim();
      const hasPreviewText = previewText !== '';
      const hasRecentActivity = Number(conversation.lastMessageTime || 0) > 0;
      const lastMessage = hasPreviewText
        ? previewText
        : (hasRecentActivity ? '' : this._t('chat.chatlist.noMessagesYet', 'No messages yet'));
      const lastMessageTime = conversation.lastMessageTime ? this.formatTime(conversation.lastMessageTime) : '';
      const unreadCount = this._toSafeInteger(conversation.unreadCount);
      const unreadMentionCount = this._toSafeInteger(conversation.unreadMentionCount || conversation.mentionUnreadCount);
      const index = conversation.index !== undefined && conversation.index !== null
        ? this.escapeHtml(String(conversation.index))
        : '';

      return `
        <div
          class="chatlist-item ${isActive ? 'active' : ''}"
          data-metaid="${this.escapeHtml(metaid)}"
          data-groupid="${conversation.groupId ? this.escapeHtml(conversation.groupId) : ''}"
          data-type="${conversation.type ? this.escapeHtml(conversation.type) : '2'}"
          data-index="${index}"
          part="chat-item"
          role="button"
          tabindex="0"
          aria-selected="${isActive ? 'true' : 'false'}"
          aria-current="${isActive ? 'true' : 'false'}"
          aria-label="${this.escapeHtml(userName)}"
        >
          <id-avatar
            class="chatlist-item-avatar"
            size="48"
            src="${this.escapeHtml(userAvatar)}"
            name="${this.escapeHtml(userName)}"
            metaid="${this.escapeHtml(metaid)}"
          ></id-avatar>
          <div class="chatlist-item-info">
            <div class="chatlist-item-name">${this.escapeHtml(userName)}</div>
            <div class="chatlist-item-preview">${this.escapeHtml(lastMessage)}</div>
          </div>
          <div class="chatlist-item-meta">
            ${lastMessageTime ? `<div class="chatlist-item-time">${this.escapeHtml(lastMessageTime)}</div>` : ''}
            ${(unreadMentionCount > 0 || unreadCount > 0) ? `
              <div class="chatlist-item-badges">
                ${unreadMentionCount > 0 ? `<div class="chatlist-item-mention">@${unreadMentionCount}</div>` : ''}
                ${unreadCount > 0 ? `<div class="chatlist-item-badge">${unreadCount}</div>` : ''}
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    const listHtml = `
      ${showInlineLoading ? `<div class="loading-inline">${this.escapeHtml(this._t('chat.chatlist.updating', 'Updating...'))}</div>` : ''}
      ${listBodyHtml}
    `;

    // Create panel HTML with CSS Variables for theming
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          min-height: 0;
        }

        /* Theme Mapping - Using Global CSS Variables */
        .chatlist-panel {
          /* Structure: Layout */
          display: flex;
          flex-direction: column;
          height: 100%;
          min-height: 0;
          width: 100%;
          overflow: hidden;
        }

        .chatlist-header {
          /* Structure: Layout */
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--id-spacing-md, 1rem);
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
          
          /* Skin: Theme */
          background-color: var(--id-bg-card, #ffffff);
        }

        .chatlist-title {
          /* Structure: Layout */
          font-size: 1.5rem;
          font-weight: bold;
          margin: 0;
          
          /* Skin: Theme */
          color: var(--id-text-title, #111827);
        }

        .new-chat-button {
          /* Structure: Layout */
          width: 36px;
          height: 36px;
          border-radius: 50%;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.5rem;
          cursor: pointer;
          transition: background-color 0.2s;
          
          /* Skin: Theme */
          background-color: var(--id-color-primary, #3b82f6);
          color: var(--id-text-inverse, #ffffff);
        }

        .new-chat-button:hover {
          background-color: var(--id-color-primary-hover, #2563eb);
        }

        .chatlist-content {
          /* Structure: Layout */
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          padding: var(--id-spacing-xs, 0.25rem);
        }

        .chatlist-item {
          /* Structure: Layout */
          display: flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          padding: var(--id-spacing-sm, 0.5rem);
          border-radius: var(--id-radius-card, 0.5rem);
          cursor: pointer;
          transition: background-color 0.2s;
          margin-bottom: var(--id-spacing-xs, 0.25rem);
          position: relative;
        }

        .chatlist-item:hover {
          background-color: var(--id-bg-body, #f3f4f6);
        }

        .chatlist-item.active {
          background-color: var(--id-color-primary, #3b82f6);
          color: var(--id-text-inverse, #ffffff);
        }

        .chatlist-item:focus-visible {
          outline: 2px solid var(--id-color-primary, #3b82f6);
          outline-offset: 2px;
        }

        .chatlist-item-avatar {
          flex-shrink: 0;
        }

        .chatlist-item-info {
          /* Structure: Layout */
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .chatlist-item-name {
          /* Structure: Layout */
          font-size: 0.9375rem;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          
          /* Skin: Theme */
          color: var(--id-text-title, #111827);
        }

        .chatlist-item.active .chatlist-item-name {
          color: var(--id-text-inverse, #ffffff);
        }

        .chatlist-item-preview {
          /* Structure: Layout */
          font-size: 0.8125rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          
          /* Skin: Theme */
          color: var(--id-text-secondary, #6b7280);
        }

        .chatlist-item.active .chatlist-item-preview {
          color: var(--id-text-inverse, #ffffff);
          opacity: 0.9;
        }

        .chatlist-item-meta {
          /* Structure: Layout */
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.25rem;
          flex-shrink: 0;
        }

        .chatlist-item-badges {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
        }

        .chatlist-item-time {
          /* Structure: Layout */
          font-size: 0.75rem;
          
          /* Skin: Theme */
          color: var(--id-text-tertiary, #9ca3af);
        }

        .chatlist-item.active .chatlist-item-time {
          color: var(--id-text-inverse, #ffffff);
          opacity: 0.9;
        }

        .chatlist-item-badge {
          /* Structure: Layout */
          background-color: var(--id-color-primary, #3b82f6);
          color: var(--id-text-inverse, #ffffff);
          border-radius: 12px;
          padding: 2px 8px;
          font-size: 0.75rem;
          font-weight: bold;
          min-width: 20px;
          text-align: center;
        }

        .chatlist-item-mention {
          background-color: #ef4444;
          color: #ffffff;
          border-radius: 12px;
          padding: 2px 8px;
          font-size: 0.75rem;
          font-weight: 700;
          min-width: 28px;
          text-align: center;
        }

        .chatlist-item.active .chatlist-item-badge {
          background-color: var(--id-text-inverse, #ffffff);
          color: var(--id-color-primary, #3b82f6);
        }

        .chatlist-item.active .chatlist-item-mention {
          background-color: #ffffff;
          color: #b91c1c;
        }

        .empty-state {
          /* Structure: Layout */
          padding: var(--id-spacing-md, 1rem);
          text-align: center;
          
          /* Skin: Theme */
          color: var(--id-text-secondary, #6b7280);
        }

        .empty-state-hint {
          font-size: 0.875rem;
          margin-top: 0.5rem;
        }

        .loading-state {
          /* Structure: Layout */
          padding: var(--id-spacing-md, 1rem);
          text-align: center;
          
          /* Skin: Theme */
          color: var(--id-text-secondary, #6b7280);
        }

        .loading-inline {
          position: sticky;
          top: 0;
          z-index: 2;
          margin: 0 var(--id-spacing-xs, 0.25rem) var(--id-spacing-sm, 0.5rem);
          padding: 0.35rem 0.55rem;
          border-radius: 999px;
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--id-text-secondary, #6b7280);
          background: var(--id-bg-body, #f3f4f6);
          border: 1px solid var(--id-border-color, #e5e7eb);
          width: fit-content;
        }

        .error-state {
          /* Structure: Layout */
          padding: var(--id-spacing-md, 1rem);
          text-align: center;
          
          /* Skin: Theme */
          color: var(--id-text-error, #991b1b);
        }
      </style>
      
      <div part="panel-container" class="chatlist-panel">
        <header class="chatlist-header">
          <h2 class="chatlist-title">${this.escapeHtml(this._t('chat.chatlist.title', 'Chat'))}</h2>
          <button class="new-chat-button" title="${this.escapeHtml(this._t('chat.chatlist.newChat', 'New Chat'))}">+</button>
        </header>
        
        <div class="chatlist-content">
          ${listHtml}
        </div>
      </div>
    `;

    // Attach click event listeners
    this._attachEventListeners();
  }

  /**
   * Attach click event listeners to chat items
   */
  _attachEventListeners() {
    const items = this.shadowRoot.querySelectorAll('.chatlist-item');
    items.forEach(item => {
      const activate = async () => {
        const metaid = item.getAttribute('data-metaid');
        if (!metaid || !window.IDFramework) return;
        const groupId = item.getAttribute('data-groupid');
        const type = item.getAttribute('data-type');
        const index = item.getAttribute('data-index');
        const chatStore = this._getStore('chat');
        const conversation = chatStore?.conversations?.[metaid];
        const parsedIndex = this._parseIndex(index, conversation?.index);
        const payload = {
          metaid,
          groupId: groupId || conversation?.groupId || null,
          type: type || conversation?.type || '2',
          index: parsedIndex,
        };
        try {
          await window.IDFramework.dispatch('selectConversation', payload);
        } catch (_) {}
        this.setAttribute('current-conversation', metaid);
        this.dispatchEvent(new CustomEvent('conversation-selected', {
          detail: { metaid, ...payload },
          bubbles: true,
          composed: true,
        }));
      };

      item.addEventListener('click', activate);
      item.addEventListener('keydown', (event) => {
        const key = event.key || '';
        if (key !== 'Enter' && key !== ' ') return;
        event.preventDefault();
        activate();
      });
    });
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _toSafeInteger(value) {
    const num = Number(value || 0);
    if (!Number.isFinite(num) || num <= 0) return 0;
    return Math.floor(num);
  }

  _parseIndex(indexValue, fallbackValue) {
    const parsed = Number.parseInt(String(indexValue == null ? '' : indexValue), 10);
    if (Number.isFinite(parsed)) return parsed;
    const fallback = Number(fallbackValue);
    if (Number.isFinite(fallback)) return Math.floor(fallback);
    return null;
  }

  escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  truncateMetaId(metaid) {
    if (!metaid || metaid.length <= 16) return metaid;
    return `${metaid.substring(0, 8)}...${metaid.substring(metaid.length - 8)}`;
  }

  formatTime(timestamp) {
    if (!timestamp) return '';
    let ts = Number(timestamp || 0);
    if (!Number.isFinite(ts) || ts <= 0) return '';
    if (ts < 1000000000000) ts *= 1000;
    if (ts > 1000000000000000) ts = Math.floor(ts / 1000);
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days === 0) {
      return date.toLocaleTimeString(this._localeTag(), { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return this._t('chat.chatlist.yesterday', 'Yesterday');
    } else if (days < 7) {
      return date.toLocaleDateString(this._localeTag(), { weekday: 'short' });
    } else {
      return date.toLocaleDateString(this._localeTag(), { month: 'short', day: 'numeric' });
    }
  }
}

// Auto-register
if (!customElements.get('id-chat-chatlist-panel')) {
  customElements.define('id-chat-chatlist-panel', IdChatChatlistPanel);
}
