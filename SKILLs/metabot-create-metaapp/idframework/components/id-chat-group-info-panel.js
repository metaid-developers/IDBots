import './id-avatar.js';

/**
 * id-chat-group-info-panel
 * Group info drawer content for chat demo.
 * Data source: Alpine.store('chat')
 */
class IdChatGroupInfoPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._lastSignature = '';
    this._searchDebounceTimer = null;
    this._scrollRestoreTop = null;
    this._onChatUpdated = this._handleChatUpdated.bind(this);
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  connectedCallback() {
    this.render();
    document.addEventListener('id:chat:updated', this._onChatUpdated);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this._ensureData(this._snapshot());
  }

  disconnectedCallback() {
    document.removeEventListener('id:chat:updated', this._onChatUpdated);
    if (this._searchDebounceTimer) {
      clearTimeout(this._searchDebounceTimer);
      this._searchDebounceTimer = null;
    }
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
  }

  _handleLocaleChanged() {
    this._lastSignature = '';
    this.render(this._snapshot());
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _toText(value) {
    return String(value || '').trim();
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
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

  _truncateIdentity(identity) {
    const raw = this._toText(identity);
    if (!raw) return '';
    if (raw.length <= 22) return raw;
    return `${raw.slice(0, 10)}...${raw.slice(-6)}`;
  }

  _snapshot() {
    const chatStore = this._getStore('chat');
    const userStore = this._getStore('user');
    const walletStore = this._getStore('wallet');

    if (!chatStore) {
      return {
        ready: false,
        type: '2',
        groupId: '',
        conversationId: '',
        conversation: {},
        groupInfo: {},
        memberState: this._defaultMemberState(),
        selfGlobalMetaId: '',
        userMap: {},
      };
    }

    const type = this._toText(chatStore.currentConversationType || '2');
    const conversationId = this._toText(chatStore.currentConversation || '');
    const groupId = type === '1' ? conversationId : '';
    const conversations = chatStore.conversations && typeof chatStore.conversations === 'object'
      ? chatStore.conversations
      : {};
    const groupInfoById = chatStore.groupInfoById && typeof chatStore.groupInfoById === 'object'
      ? chatStore.groupInfoById
      : {};
    const groupMembersById = chatStore.groupMembersById && typeof chatStore.groupMembersById === 'object'
      ? chatStore.groupMembersById
      : {};
    const memberStateRaw = groupId ? (groupMembersById[groupId] || null) : null;

    return {
      ready: true,
      type: type || '2',
      groupId,
      conversationId,
      conversation: conversationId ? (conversations[conversationId] || {}) : {},
      groupInfo: groupId ? (groupInfoById[groupId] || {}) : {},
      memberState: this._normalizeMemberState(memberStateRaw),
      selfGlobalMetaId: this._toText(walletStore && walletStore.globalMetaId),
      userMap: (userStore && userStore.users && typeof userStore.users === 'object') ? userStore.users : {},
    };
  }

  _defaultMemberState() {
    return {
      list: [],
      total: 0,
      cursor: 0,
      size: 30,
      hasMore: false,
      isLoading: false,
      hasLoaded: false,
      error: '',
      query: '',
      mode: 'list',
      creator: null,
      admins: [],
      whiteList: [],
      blockList: [],
      loadedAt: 0,
    };
  }

  _normalizeMemberState(raw) {
    const base = this._defaultMemberState();
    if (!raw || typeof raw !== 'object') return base;
    return {
      ...base,
      ...raw,
      list: Array.isArray(raw.list) ? raw.list : [],
      admins: Array.isArray(raw.admins) ? raw.admins : [],
      whiteList: Array.isArray(raw.whiteList) ? raw.whiteList : [],
      blockList: Array.isArray(raw.blockList) ? raw.blockList : [],
      query: this._toText(raw.query || ''),
      mode: this._toText(raw.mode || 'list') || 'list',
    };
  }

  _signature(snapshot) {
    const info = snapshot.groupInfo && typeof snapshot.groupInfo === 'object' ? snapshot.groupInfo : {};
    const members = snapshot.memberState || this._defaultMemberState();
    const list = Array.isArray(members.list) ? members.list : [];
    const head = list.slice(0, 15).map((item) => {
      const row = item && typeof item === 'object' ? item : {};
      return [
        this._toText(row.globalMetaId || row.metaId || row.address),
        this._toText(row.name),
        String(row.timestamp || 0),
      ].join(':');
    }).join('|');
    return [
      snapshot.ready ? '1' : '0',
      snapshot.type,
      snapshot.groupId,
      snapshot.conversationId,
      this._toText(snapshot.conversation && snapshot.conversation.name),
      this._toText(info.roomName),
      String(info.userCount || 0),
      info.isLoading ? '1' : '0',
      info.hasLoaded ? '1' : '0',
      this._toText(info.error),
      members.mode,
      this._toText(members.query),
      members.isLoading ? '1' : '0',
      members.hasLoaded ? '1' : '0',
      this._toText(members.error),
      String(members.total || 0),
      String(members.cursor || 0),
      members.hasMore ? '1' : '0',
      String(list.length),
      head,
    ].join('||');
  }

  _notifyUpdated() {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
    try {
      document.dispatchEvent(new CustomEvent('id:chat:updated'));
    } catch (_) {}
  }

  _handleChatUpdated() {
    const snapshot = this._snapshot();
    const signature = this._signature(snapshot);
    if (signature === this._lastSignature) return;
    this._lastSignature = signature;
    this.render(snapshot);
    this._restoreScrollTopIfNeeded();
    this._ensureData(snapshot);
  }

  async _ensureData(snapshot) {
    if (!snapshot || snapshot.type !== '1' || !snapshot.groupId) return;
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;

    const groupId = snapshot.groupId;
    const info = snapshot.groupInfo && typeof snapshot.groupInfo === 'object' ? snapshot.groupInfo : {};
    const members = snapshot.memberState || this._defaultMemberState();

    if (!info.hasLoaded && !info.isLoading) {
      window.IDFramework.dispatch('fetchChatGroupInfo', { groupId }).then(() => {
        this._notifyUpdated();
      }).catch(() => {});
    }

    if (!members.hasLoaded && !members.isLoading) {
      window.IDFramework.dispatch('fetchChatGroupMembers', {
        groupId,
        cursor: 0,
        size: members.size || 30,
        append: false,
      }).then(() => {
        this._notifyUpdated();
      }).catch(() => {});
    }
  }

  _resolveMemberLabel(member, userMap) {
    const row = member && typeof member === 'object' ? member : {};
    const key = this._toText(row.globalMetaId || row.metaId || row.address);
    const fromStore = key && userMap && typeof userMap === 'object' ? (userMap[key] || {}) : {};
    return this._toText(
      row.name ||
      (row.userInfo && row.userInfo.name) ||
      fromStore.name ||
      this._truncateIdentity(key)
    ) || this._t('chat.groupInfo.unknown', 'Unknown');
  }

  _resolveMemberAvatar(member, userMap) {
    const row = member && typeof member === 'object' ? member : {};
    const key = this._toText(row.globalMetaId || row.metaId || row.address);
    const fromStore = key && userMap && typeof userMap === 'object' ? (userMap[key] || {}) : {};
    return this._toText(
      row.avatar ||
      (row.userInfo && (row.userInfo.avatarImage || row.userInfo.avatarUrl || row.userInfo.avatar)) ||
      fromStore.avatarUrl ||
      fromStore.avatar ||
      ''
    );
  }

  _renderMemberRows(snapshot) {
    const members = snapshot.memberState || this._defaultMemberState();
    const list = Array.isArray(members.list) ? members.list : [];
    if (!list.length) {
      if (members.isLoading) return '<div class="state">' + this._escapeHtml(this._t('chat.groupInfo.loadingMembers', 'Loading members...')) + '</div>';
      if (members.query) return '<div class="state">' + this._escapeHtml(this._t('chat.groupInfo.noMatchedMembers', 'No matched members')) + '</div>';
      return '<div class="state">' + this._escapeHtml(this._t('chat.groupInfo.noMembers', 'No members found')) + '</div>';
    }

    const creator = members.creator && typeof members.creator === 'object' ? members.creator : null;
    const creatorKey = creator ? this._toText(creator.globalMetaId || creator.metaId || creator.address) : '';
    const adminKeys = new Set((Array.isArray(members.admins) ? members.admins : []).map((item) =>
      this._toText(item && (item.globalMetaId || item.metaId || item.address))
    ).filter(Boolean));

    return list.map((member) => {
      const row = member && typeof member === 'object' ? member : {};
      const key = this._toText(row.globalMetaId || row.metaId || row.address);
      const name = this._resolveMemberLabel(row, snapshot.userMap);
      const avatar = this._resolveMemberAvatar(row, snapshot.userMap);
      const tag = key && key === creatorKey
        ? '<span class="role-tag owner">' + this._escapeHtml(this._t('chat.groupInfo.owner', 'Owner')) + '</span>'
        : (adminKeys.has(key) ? '<span class="role-tag admin">' + this._escapeHtml(this._t('chat.groupInfo.admin', 'Admin')) + '</span>' : '');
      const chatTarget = this._toText(row.globalMetaId || '');
      const chatButton = chatTarget && chatTarget !== snapshot.selfGlobalMetaId
        ? `<button type="button" class="member-chat-btn" data-action="chat-with-member" data-target="${this._escapeHtml(chatTarget)}" title="${this._escapeHtml(this._t('chat.groupInfo.startPrivateChat', 'Start private chat'))}">${this._escapeHtml(this._t('chat.groupInfo.chat', 'Chat'))}</button>`
        : '<span class="member-you">' + this._escapeHtml(this._t('chat.groupInfo.you', 'You')) + '</span>';
      const identity = this._truncateIdentity(this._toText(row.globalMetaId || row.metaId || row.address));
      return `
        <div class="member-item">
          <id-avatar
            class="member-avatar"
            size="38"
            src="${this._escapeHtml(avatar)}"
            name="${this._escapeHtml(name)}"
            metaid="${this._escapeHtml(key)}"
          ></id-avatar>
          <div class="member-main">
            <div class="member-name-row">
              <span class="member-name">${this._escapeHtml(name)}</span>
              ${tag}
            </div>
            <div class="member-id">${this._escapeHtml(identity)}</div>
          </div>
          <div class="member-actions">${chatButton}</div>
        </div>
      `;
    }).join('');
  }

  _renderPrivatePlaceholder(snapshot) {
    const key = this._toText(snapshot.conversationId || '');
    const name = this._toText(snapshot.conversation && snapshot.conversation.name) || this._t('chat.groupInfo.privateChat', 'Private Chat');
    return `
      <div class="private-placeholder">
        <div class="private-title">${this._escapeHtml(name)}</div>
        <div class="private-subtitle">${this._escapeHtml(this._t('chat.groupInfo.privateConversation', 'Private conversation'))}</div>
        <div class="private-id">${this._escapeHtml(this._truncateIdentity(key))}</div>
      </div>
    `;
  }

  _renderGroupContent(snapshot) {
    const info = snapshot.groupInfo && typeof snapshot.groupInfo === 'object' ? snapshot.groupInfo : {};
    const members = snapshot.memberState || this._defaultMemberState();
    const conversation = snapshot.conversation && typeof snapshot.conversation === 'object' ? snapshot.conversation : {};

    const roomName = this._toText(info.roomName || conversation.name || this._t('chat.groupInfo.groupChat', 'Group Chat'));
    const roomAvatar = this._toText(info.roomAvatarUrl || info.roomIcon || conversation.avatar || '');
    const roomNote = this._toText(info.roomNote || '');
    const totalMembers = Number(info.userCount || members.total || (Array.isArray(members.list) ? members.list.length : 0) || 0);
    const groupId = this._toText(snapshot.groupId);
    const memberRows = this._renderMemberRows(snapshot);

    return `
      <section class="group-head">
        <id-avatar
          class="group-avatar"
          size="48"
          src="${this._escapeHtml(roomAvatar)}"
          name="${this._escapeHtml(roomName)}"
          metaid="${this._escapeHtml(groupId)}"
        ></id-avatar>
        <div class="group-main">
          <div class="group-name">${this._escapeHtml(roomName)}</div>
          <div class="group-meta">
            <span class="group-members">${this._escapeHtml(String(totalMembers))} ${this._escapeHtml(this._t('chat.groupInfo.membersUnit', 'members'))}</span>
          </div>
        </div>
      </section>

      <section class="group-id-section">
        <label class="section-label">${this._escapeHtml(this._t('chat.groupInfo.groupId', 'Group ID'))}</label>
        <div class="group-id-row">
          <div class="group-id">${this._escapeHtml(this._truncateIdentity(groupId))}</div>
          <button type="button" class="small-btn" data-action="copy-group-id" title="${this._escapeHtml(this._t('chat.groupInfo.copyGroupId', 'Copy Group ID'))}">${this._escapeHtml(this._t('chat.groupInfo.copy', 'Copy'))}</button>
        </div>
      </section>

      <section class="group-note-section">
        <label class="section-label">${this._escapeHtml(this._t('chat.groupInfo.announcement', 'Announcement'))}</label>
        <div class="group-note">${this._escapeHtml(roomNote || this._t('chat.groupInfo.noAnnouncement', 'No announcement'))}</div>
      </section>

      <section class="members-section">
        <div class="members-top">
          <label class="section-label">${this._escapeHtml(this._t('chat.groupInfo.members', 'Members'))}</label>
          <span class="member-total">${this._escapeHtml(String(totalMembers))}</span>
        </div>
        <div class="member-search">
          <input
            type="text"
            class="member-search-input"
            data-role="member-search"
            value="${this._escapeHtml(this._toText(members.query))}"
            placeholder="${this._escapeHtml(this._t('chat.groupInfo.searchMembers', 'Search members'))}"
          />
          ${members.query ? '<button type="button" class="small-btn" data-action="clear-search">' + this._escapeHtml(this._t('chat.groupInfo.clear', 'Clear')) + '</button>' : ''}
        </div>
        ${members.error ? `<div class="error-text">${this._escapeHtml(members.error)}</div>` : ''}
        <div class="member-list">${memberRows}</div>
        ${(!members.query && members.hasMore) ? `
          <button type="button" class="load-more-btn" data-action="load-more-members" ${members.isLoading ? 'disabled' : ''}>
            ${members.isLoading ? this._escapeHtml(this._t('chat.groupInfo.loading', 'Loading...')) : this._escapeHtml(this._t('chat.groupInfo.loadMore', 'Load more'))}
          </button>
        ` : ''}
      </section>
    `;
  }

  render(forcedSnapshot) {
    const snapshot = forcedSnapshot || this._snapshot();
    this._lastSignature = this._signature(snapshot);

    const bodyHtml = !snapshot.ready || !snapshot.conversationId
      ? '<div class="state">' + this._escapeHtml(this._t('chat.groupInfo.selectConversation', 'Select a conversation')) + '</div>'
      : (snapshot.type === '1' ? this._renderGroupContent(snapshot) : this._renderPrivatePlaceholder(snapshot));

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          box-sizing: border-box;
          color: var(--id-text-main, #1f2937);
        }

        .panel {
          display: flex;
          flex-direction: column;
          width: 100%;
          height: 100%;
          background: var(--id-bg-card, #ffffff);
        }

        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.8rem 0.9rem;
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
        }

        .panel-title {
          margin: 0;
          font-size: 0.98rem;
          font-weight: 700;
          color: var(--id-text-title, #111827);
        }

        .close-btn {
          width: 32px;
          height: 32px;
          border-radius: 999px;
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
          cursor: pointer;
          font-size: 1rem;
          line-height: 1;
        }

        .panel-body {
          flex: 1;
          overflow-y: auto;
          padding: 0.85rem 0.9rem 1rem;
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
        }

        .group-head {
          display: flex;
          align-items: center;
          gap: 0.65rem;
        }

        .group-main {
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        .group-name {
          font-size: 1rem;
          font-weight: 700;
          color: var(--id-text-title, #111827);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .group-meta {
          margin-top: 2px;
          font-size: 0.8rem;
          color: var(--id-text-secondary, #6b7280);
        }

        .section-label {
          display: inline-block;
          margin-bottom: 0.32rem;
          font-size: 0.74rem;
          font-weight: 700;
          color: var(--id-text-secondary, #6b7280);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }

        .group-id-row {
          display: flex;
          align-items: center;
          gap: 0.45rem;
        }

        .group-id {
          flex: 1;
          min-width: 0;
          font-size: 0.82rem;
          color: var(--id-text-main, #1f2937);
          padding: 0.34rem 0.52rem;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 0.5rem;
          background: var(--id-bg-body, #f3f4f6);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .small-btn {
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
          font-size: 0.74rem;
          padding: 0.28rem 0.52rem;
          border-radius: 999px;
          cursor: pointer;
          white-space: nowrap;
        }

        .group-note {
          font-size: 0.83rem;
          line-height: 1.4;
          color: var(--id-text-main, #1f2937);
          background: var(--id-bg-body, #f3f4f6);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 0.55rem;
          padding: 0.6rem;
          word-break: break-word;
          min-height: 2.3rem;
        }

        .members-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .member-total {
          font-size: 0.76rem;
          color: var(--id-text-secondary, #6b7280);
        }

        .member-search {
          display: flex;
          align-items: center;
          gap: 0.45rem;
        }

        .member-search-input {
          flex: 1;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 0.55rem;
          padding: 0.5rem 0.62rem;
          font-size: 0.84rem;
          color: var(--id-text-main, #1f2937);
          background: var(--id-bg-card, #ffffff);
          outline: none;
        }

        .member-search-input:focus {
          border-color: var(--id-color-primary, #3b82f6);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.14);
        }

        .member-list {
          display: flex;
          flex-direction: column;
          gap: 0.42rem;
          margin-top: 0.2rem;
        }

        .member-item {
          display: flex;
          align-items: center;
          gap: 0.52rem;
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 0.62rem;
          padding: 0.44rem;
          background: var(--id-bg-card, #ffffff);
        }

        .member-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }

        .member-name-row {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          min-width: 0;
        }

        .member-name {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--id-text-title, #111827);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .member-id {
          margin-top: 2px;
          font-size: 0.73rem;
          color: var(--id-text-secondary, #6b7280);
        }

        .role-tag {
          font-size: 0.68rem;
          font-weight: 700;
          border-radius: 999px;
          padding: 0.08rem 0.42rem;
          border: 1px solid transparent;
          white-space: nowrap;
        }

        .role-tag.owner {
          color: #7c2d12;
          background: #ffedd5;
          border-color: #fdba74;
        }

        .role-tag.admin {
          color: #1d4ed8;
          background: #dbeafe;
          border-color: #93c5fd;
        }

        .member-actions {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
        }

        .member-chat-btn {
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-body, #f3f4f6);
          color: var(--id-text-main, #1f2937);
          font-size: 0.74rem;
          font-weight: 600;
          border-radius: 999px;
          padding: 0.28rem 0.6rem;
          cursor: pointer;
        }

        .member-you {
          font-size: 0.74rem;
          color: var(--id-text-secondary, #6b7280);
        }

        .load-more-btn {
          margin-top: 0.45rem;
          width: 100%;
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
          font-size: 0.82rem;
          font-weight: 600;
          border-radius: 0.6rem;
          padding: 0.52rem;
          cursor: pointer;
        }

        .load-more-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .state {
          padding: 1rem 0.5rem;
          text-align: center;
          color: var(--id-text-secondary, #6b7280);
          font-size: 0.84rem;
        }

        .error-text {
          margin-top: 0.2rem;
          font-size: 0.78rem;
          color: var(--id-text-error, #b91c1c);
        }

        .private-placeholder {
          padding: 0.8rem;
          border-radius: 0.6rem;
          border: 1px solid var(--id-border-color, #e5e7eb);
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
        }

        .private-title {
          font-size: 0.94rem;
          font-weight: 700;
          color: var(--id-text-title, #111827);
        }

        .private-subtitle {
          margin-top: 0.3rem;
          font-size: 0.8rem;
          color: var(--id-text-secondary, #6b7280);
        }

        .private-id {
          margin-top: 0.35rem;
          font-size: 0.78rem;
          color: var(--id-text-main, #1f2937);
          word-break: break-word;
        }
      </style>

      <div class="panel">
        <header class="panel-header">
          <h3 class="panel-title">${this._escapeHtml(this._t('chat.groupInfo.conversationInfo', 'Conversation Info'))}</h3>
          <button type="button" class="close-btn" data-action="close-panel" aria-label="${this._escapeHtml(this._t('chat.groupInfo.close', 'Close'))}">×</button>
        </header>
        <div class="panel-body">${bodyHtml}</div>
      </div>
    `;

    this._wireInteractions(snapshot);
  }

  _captureScrollTop() {
    const panelBody = this.shadowRoot.querySelector('.panel-body');
    if (!panelBody) return;
    this._scrollRestoreTop = Number(panelBody.scrollTop || 0);
  }

  _restoreScrollTopIfNeeded() {
    if (this._scrollRestoreTop === null || this._scrollRestoreTop === undefined) return;
    const targetTop = Number(this._scrollRestoreTop || 0);
    this._scrollRestoreTop = null;
    requestAnimationFrame(() => {
      const panelBody = this.shadowRoot.querySelector('.panel-body');
      if (!panelBody) return;
      panelBody.scrollTop = targetTop;
    });
  }

  _wireInteractions(snapshot) {
    const closeButton = this.shadowRoot.querySelector('[data-action="close-panel"]');
    if (closeButton) {
      closeButton.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('group-info-close', {
          bubbles: true,
          composed: true,
        }));
      });
    }

    const copyButton = this.shadowRoot.querySelector('[data-action="copy-group-id"]');
    if (copyButton) {
      copyButton.addEventListener('click', async () => {
        const groupId = this._toText(snapshot.groupId || '');
        if (!groupId) return;
        try {
          await navigator.clipboard.writeText(groupId);
          if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
            window.IDUtils.showMessage('success', this._t('chat.groupInfo.groupIdCopied', 'Group ID copied'));
          }
        } catch (_) {}
      });
    }

    const clearSearchButton = this.shadowRoot.querySelector('[data-action="clear-search"]');
    if (clearSearchButton) {
      clearSearchButton.addEventListener('click', () => {
        this._dispatchMemberSearch(snapshot.groupId, '');
      });
    }

    const searchInput = this.shadowRoot.querySelector('[data-role="member-search"]');
    if (searchInput) {
      searchInput.addEventListener('input', (event) => {
        const next = this._toText(event && event.target ? event.target.value : '');
        if (this._searchDebounceTimer) {
          clearTimeout(this._searchDebounceTimer);
          this._searchDebounceTimer = null;
        }
        this._searchDebounceTimer = setTimeout(() => {
          this._dispatchMemberSearch(snapshot.groupId, next);
          this._searchDebounceTimer = null;
        }, 260);
      });
    }

    const loadMoreButton = this.shadowRoot.querySelector('[data-action="load-more-members"]');
    if (loadMoreButton) {
      loadMoreButton.addEventListener('click', () => {
        if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;
        this._captureScrollTop();
        const memberState = snapshot.memberState || this._defaultMemberState();
        window.IDFramework.dispatch('fetchChatGroupMembers', {
          groupId: snapshot.groupId,
          cursor: Number(memberState.cursor || 0),
          size: Number(memberState.size || 30),
          append: true,
          query: '',
        }).then(() => {
          this._notifyUpdated();
        }).catch(() => {});
      });
    }

    const chatButtons = this.shadowRoot.querySelectorAll('[data-action="chat-with-member"]');
    chatButtons.forEach((button) => {
      button.addEventListener('click', async () => {
        if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;
        const target = this._toText(button.getAttribute('data-target') || '');
        if (!target) return;
        try {
          await window.IDFramework.dispatch('selectConversation', {
            type: '2',
            metaid: target,
            globalMetaId: target,
          });
          this._notifyUpdated();
          this.dispatchEvent(new CustomEvent('group-info-close', {
            bubbles: true,
            composed: true,
          }));
        } catch (_) {}
      });
    });
  }

  _dispatchMemberSearch(groupId, query) {
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;
    const gid = this._toText(groupId);
    if (!gid) return;
    window.IDFramework.dispatch('fetchChatGroupMembers', {
      groupId: gid,
      cursor: 0,
      size: 30,
      append: false,
      query: this._toText(query),
    }).then(() => {
      this._notifyUpdated();
    }).catch(() => {});
  }
}

if (!customElements.get('id-chat-group-info-panel')) {
  customElements.define('id-chat-group-info-panel', IdChatGroupInfoPanel);
}

export default IdChatGroupInfoPanel;
