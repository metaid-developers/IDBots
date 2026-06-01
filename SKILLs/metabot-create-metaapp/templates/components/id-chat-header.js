/**
 * id-chat-header
 * Chat conversation header driven by Alpine.store('chat') / Alpine.store('user').
 * Single source of truth: Alpine store only.
 */

class IdChatHeader extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._lastSignature = '';
    this._onChatUpdated = this._handleChatUpdated.bind(this);
    this._onToggleDrawerClick = this._handleToggleDrawerClick.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    this.render();
    document.addEventListener('id:chat:updated', this._onChatUpdated);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  disconnectedCallback() {
    document.removeEventListener('id:chat:updated', this._onChatUpdated);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _truncateMetaId(metaid) {
    const text = String(metaid || '').trim();
    if (!text) return '';
    return text.length > 16 ? (text.slice(0, 16) + '...') : text;
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

  _snapshot() {
    const chatStore = this._getStore('chat');
    const userStore = this._getStore('user');
    if (!chatStore) {
      return {
        currentConversation: '',
        currentConversationType: '1',
        name: '',
        avatar: '',
        status: '',
      };
    }

    const currentConversation = String(chatStore.currentConversation || '');
    if (!currentConversation) {
      return {
        currentConversation: '',
        currentConversationType: '1',
        name: '',
        avatar: '',
        status: '',
      };
    }

    const conversationType = String(chatStore.currentConversationType || '1');
    const conversation = (chatStore.conversations && chatStore.conversations[currentConversation]) || {};
    const userMap = (userStore && userStore.users && typeof userStore.users === 'object') ? userStore.users : {};
    const peer = userMap[currentConversation] || {};

    const isPrivate = conversationType === '2';
    const name = isPrivate
      ? String(peer.name || conversation.name || this._truncateMetaId(currentConversation) || this._t('chat.header.userFallback', 'User'))
      : String(conversation.name || this._t('chat.header.groupFallback', 'Group Chat'));
    const avatar = isPrivate
      ? String(peer.avatarUrl || peer.avatar || conversation.avatar || '')
      : String(conversation.avatar || '');
    const status = isPrivate
      ? this._t('chat.header.privateStatus', 'Private Chat')
      : this._t('chat.header.groupStatus', 'Group Chat');

    return {
      currentConversation: currentConversation,
      currentConversationType: conversationType,
      name: name,
      avatar: avatar,
      status: status,
    };
  }

  _signature(snapshot) {
    return [
      snapshot.currentConversation,
      snapshot.currentConversationType,
      snapshot.name,
      snapshot.avatar,
      snapshot.status,
    ].join('|');
  }

  _handleChatUpdated() {
    const snapshot = this._snapshot();
    const signature = this._signature(snapshot);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;
    this.render(snapshot);
  }

  _handleToggleDrawerClick(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    this.dispatchEvent(new CustomEvent('conversation-drawer-toggle', {
      bubbles: true,
      composed: true,
    }));
  }

  _handleLocaleChanged() {
    this._lastSignature = '';
    this.render();
  }

  render(forcedSnapshot) {
    const snapshot = forcedSnapshot || this._snapshot();
    this._lastSignature = this._signature(snapshot);

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }

        .chat-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          min-height: 64px;
          box-sizing: border-box;
        }

        .chat-header.idle {
          min-height: 56px;
        }

        .chat-header-user {
          display: flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          min-width: 0;
        }

        .chat-header-avatar {
          flex: 0 0 auto;
        }

        .chat-header-info {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .chat-header-name {
          font-size: 1rem;
          font-weight: 600;
          color: var(--id-text-title, #111827);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: min(58vw, 420px);
        }

        .chat-header-status {
          margin-top: 2px;
          font-size: 0.8125rem;
          color: var(--id-text-secondary, #6b7280);
        }

        .chat-header-actions {
          display: inline-flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          flex: 0 0 auto;
        }

        .chat-header-actions slot[name="leading-action"] {
          display: inline-flex;
          align-items: center;
        }

        .chat-header-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 38px;
          height: 38px;
          border-radius: 999px;
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
          font-size: 0.8125rem;
          font-weight: 600;
          line-height: 1;
          cursor: pointer;
          flex: 0 0 auto;
        }

        .chat-header-action:hover {
          background: var(--id-bg-body, #f3f4f6);
        }
      </style>

      <header class="chat-header${snapshot.currentConversation ? '' : ' idle'}">
        ${
          snapshot.currentConversation
            ? `
              <div class="chat-header-user">
                <id-avatar
                  class="chat-header-avatar"
                  size="40"
                  src="${this._escapeHtml(snapshot.avatar)}"
                  name="${this._escapeHtml(snapshot.name)}"
                  metaid="${this._escapeHtml(snapshot.currentConversation)}"
                ></id-avatar>
                <div class="chat-header-info">
                  <div class="chat-header-name">${this._escapeHtml(snapshot.name)}</div>
                  <div class="chat-header-status">${this._escapeHtml(snapshot.status)}</div>
                </div>
              </div>
            `
            : '<div></div>'
        }
        <div class="chat-header-actions">
          <slot name="leading-action"></slot>
          ${
            snapshot.currentConversation
              ? `
                <button
                  type="button"
                  class="chat-header-action"
                  data-action="toggle-conversation-drawer"
                  aria-label="${this._escapeHtml(this._t('chat.header.conversationInfo', 'Conversation info'))}"
                  title="${this._escapeHtml(this._t('chat.header.conversationInfo', 'Conversation info'))}"
                >${this._escapeHtml(this._t('chat.header.infoButton', 'Info'))}</button>
              `
              : ''
          }
        </div>
      </header>
    `;

    const toggleButton = this.shadowRoot.querySelector('[data-action="toggle-conversation-drawer"]');
    if (toggleButton) {
      toggleButton.addEventListener('click', this._onToggleDrawerClick);
    }
  }
}

if (!customElements.get('id-chat-header')) {
  customElements.define('id-chat-header', IdChatHeader);
}

export default IdChatHeader;
