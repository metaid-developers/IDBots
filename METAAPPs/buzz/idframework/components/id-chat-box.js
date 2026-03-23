import './id-chat-bubble.js';
import { getSimpleTalkStore } from '../stores/chat/simple-talk.js';
import { getWsNewStore } from '../stores/chat/ws-new.js';

class IdChatBox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._messages = [];
    this._isLoading = false;
    this._isLoadingOlder = false;
    this._store = getSimpleTalkStore();
    this._ws = getWsNewStore();
    this._pollTimer = null;
    this._onScroll = this._handleScroll.bind(this);
    this._onChatSent = this._handleChatSent.bind(this);
  }

  static get observedAttributes() {
    return ['group-id', 'globalmetaid', 'mode', 'height'];
  }

  connectedCallback() {
    this.render();
    document.addEventListener('chat-sent', this._onChatSent);
    this._start();
  }

  disconnectedCallback() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    const list = this.shadowRoot.querySelector('.list');
    if (list) list.removeEventListener('scroll', this._onScroll);
    document.removeEventListener('chat-sent', this._onChatSent);
  }

  attributeChangedCallback(oldName, oldValue, newValue) {
    if (oldValue === newValue) return;
    this._start();
  }

  _mode() {
    const raw = String(this.getAttribute('mode') || '').trim().toLowerCase();
    return raw === 'private' ? 'private' : 'public';
  }

  _getContextFromAttrs() {
    const mode = this._mode();
    const groupId = String(this.getAttribute('group-id') || '').trim();
    const targetGlobalMetaId = String(this.getAttribute('globalmetaid') || '').trim();
    return { mode, groupId, targetGlobalMetaId };
  }

  _isLoginReady() {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return false;
    const wallet = Alpine.store('wallet');
    const user = Alpine.store('user');
    const userObj = user && user.user ? user.user : null;
    return !!(wallet && wallet.isConnected && wallet.address && wallet.globalMetaId && userObj);
  }

  _showMessage(type, message) {
    if (window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage(type, message);
      return;
    }
    if (type === 'error') {
      window.alert(message);
    } else {
      console.log(message);
    }
  }

  async _start() {
    if (this._isLoading) return;
    this._isLoading = true;
    try {
      if (!this._isLoginReady()) {
        this._messages = [];
        this.render('请先连接钱包并登录后再初始化聊天列表。');
        if (!this._pollTimer) {
          this._pollTimer = setInterval(() => {
            if (this._isLoginReady()) {
              clearInterval(this._pollTimer);
              this._pollTimer = null;
              this._start();
            }
          }, 1000);
        }
        return;
      }

      await this._store.init();
      const context = this._getContextFromAttrs();
      this._store.setContext(context);

      this._messages = await this._store.loadLatestMessages();
      this._sortMessages();
      this.render();
      this._afterRenderKeepBottom();
      this._bindListScroll();
      this._setupSocket();
    } catch (error) {
      this.render(`聊天初始化失败：${error && error.message ? error.message : 'unknown error'}`);
    } finally {
      this._isLoading = false;
    }
  }

  _bindListScroll() {
    const list = this.shadowRoot.querySelector('.list');
    if (!list) return;
    list.removeEventListener('scroll', this._onScroll);
    list.addEventListener('scroll', this._onScroll, { passive: true });
  }

  async _handleScroll() {
    const list = this.shadowRoot.querySelector('.list');
    if (!list || this._isLoadingOlder) return;
    if (list.scrollTop > 60) return;
    this._isLoadingOlder = true;
    const oldHeight = list.scrollHeight;
    try {
      this._messages = await this._store.loadOlderMessages();
      this._sortMessages();
      this.render();
      const nextList = this.shadowRoot.querySelector('.list');
      if (nextList) {
        const delta = nextList.scrollHeight - oldHeight;
        nextList.scrollTop = Math.max(0, delta);
      }
    } catch (_) {
      // ignore
    } finally {
      this._isLoadingOlder = false;
    }
  }

  async _handleChatSent(event) {
    try {
      const detail = event && event.detail ? event.detail : null;
      if (!detail || !detail.protocolPath || !detail.body) return;
      const ctx = this._getContextFromAttrs();
      const mode = this._mode();
      const protocol = String(detail.protocolPath || '');
      if (mode === 'public' && ctx.groupId && String(detail.body.groupId || '') !== ctx.groupId) return;
      if (mode === 'private' && ctx.targetGlobalMetaId && String(detail.body.to || '') !== ctx.targetGlobalMetaId) return;

      const wallet = Alpine.store('wallet');
      const user = Alpine.store('user');
      const latestIndex = this._messages.reduce((max, item) => {
        const idx = Number(item.index || 0);
        return idx > max ? idx : max;
      }, 0);
      const mock = {
        protocol,
        txId: String(detail.txid || ''),
        pinId: String((detail.txid && `${detail.txid}i0`) || ''),
        content: String(
          (detail.body && (detail.body.content || detail.body.attachment)) ||
          ''
        ),
        attachment: String((detail.body && detail.body.attachment) || ''),
        contentType: String((detail.body && detail.body.contentType) || ''),
        fileType: String((detail.body && detail.body.fileType) || ''),
        timestamp: Date.now(),
        index: latestIndex + 1,
        groupId: mode === 'public' ? String(ctx.groupId || '') : '',
        fromGlobalMetaId: String((wallet && wallet.globalMetaId) || ''),
        toGlobalMetaId: mode === 'private'
          ? String((detail.body && detail.body.to) || ctx.targetGlobalMetaId || '')
          : '',
        replyPin: String((detail.body && detail.body.replyPin) || ''),
        replyInfo: detail.body && detail.body.replyInfo ? Object.assign({}, detail.body.replyInfo) : null,
        replyMetaId: String((detail.body && detail.body.replyMetaId) || ''),
        replyGlobalMetaId: String((detail.body && detail.body.replyGlobalMetaId) || ''),
        mention: Array.isArray(detail.body && detail.body.mention)
          ? detail.body.mention.slice()
          : [],
        userInfo: {
          name: String((user && user.user && (user.user.name || user.user.nickname)) || ''),
          avatarImage: String((user && user.user && (user.user.avatarImage || user.user.avatarUrl || user.user.avatar)) || ''),
          globalMetaId: String((wallet && wallet.globalMetaId) || ''),
        },
      };
      await this._store.receiveMessage(mock);
      this._messages = await this._store.getMessages();
      this._sortMessages();
      this.render();
      this._afterRenderKeepBottom();
    } catch (_) {
      // ignore local mock errors
    }
  }

  _setupSocket() {
    const wallet = Alpine.store('wallet');
    const mode = this._mode();
    const type = (Alpine.store('app') && Alpine.store('app').isWebView) ? 'app' : 'pc';
    this._ws.connect({
      metaid: wallet.globalMetaId,
      type,
      onMessage: async (message) => {
        const accepted = await this._store.receiveMessage(message);
        if (!accepted) return;
        this._messages = await this._store.getMessages();
        this._sortMessages();
        this.render();
        this._afterRenderKeepBottom();
      },
      onConnect: () => {
        const text = mode === 'private' ? '私聊 socket 已连接' : '群聊 socket 已连接';
        console.log(text);
      },
    });
  }

  _scrollToBottom() {
    const list = this.shadowRoot.querySelector('.list');
    if (!list) return;
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
      setTimeout(() => {
        list.scrollTop = list.scrollHeight;
      }, 0);
    });
  }

  _sortMessages() {
    if (!Array.isArray(this._messages)) {
      this._messages = [];
      return;
    }
    this._messages.sort((a, b) => {
      const ai = Number((a && a.index) || 0);
      const bi = Number((b && b.index) || 0);
      if (ai !== bi) return ai - bi;
      return Number((a && a.timestamp) || 0) - Number((b && b.timestamp) || 0);
    });
  }

  _afterRenderKeepBottom() {
    this._scrollToBottom();
    setTimeout(() => {
      const nodes = this.shadowRoot.querySelectorAll('id-chat-bubble');
      if (!nodes || !nodes.length) return;
      const last = nodes[nodes.length - 1];
      if (last && typeof last.scrollIntoView === 'function') {
        last.scrollIntoView({ block: 'end' });
      }
    }, 0);
  }

  _height() {
    const h = String(this.getAttribute('height') || '').trim();
    return h || '85vh';
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _renderMessagesIntoBubbles() {
    const nodes = Array.from(this.shadowRoot.querySelectorAll('id-chat-bubble'));
    const wallet = typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null;
    nodes.forEach((node, index) => {
      const message = this._messages[index];
      node.chatStore = this._store;
      node.message = message;
      node.mode = this._mode();
      node.groupId = String(this.getAttribute('group-id') || '');
      node.currentUserGlobalMetaId = String((wallet && wallet.globalMetaId) || '');
    });
  }

  render(errorText) {
    const mode = this._mode();
    const context = this._getContextFromAttrs();
    const target = mode === 'private' ? context.targetGlobalMetaId : context.groupId;
    const rows = this._messages.map(() => '<id-chat-bubble></id-chat-bubble>').join('');
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block;font-family:var(--id-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);}
        .wrap{border:1px solid #e5e7eb;border-radius:14px;background:#f8fafc;overflow:hidden;}
        .head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #e5e7eb;background:#fff;}
        .title{font-size:13px;color:#111827;font-weight:600;}
        .sub{font-size:12px;color:#6b7280;max-width:68%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .list{height:${this._escapeHtml(this._height())};overflow-y:auto;padding:10px 12px;box-sizing:border-box;}
        .empty{padding:18px;text-align:center;color:#6b7280;font-size:13px;}
        .error{padding:14px;color:#dc2626;font-size:13px;background:#fff1f2;border:1px solid #fecdd3;border-radius:10px;}
      </style>
      <section class="wrap">
        <header class="head">
          <div class="title">${mode === 'private' ? '私聊' : '群聊'}消息列表</div>
          <div class="sub">${this._escapeHtml(target || '')}</div>
        </header>
        <div class="list">
          ${errorText ? `<div class="error">${this._escapeHtml(errorText)}</div>` : ''}
          ${!errorText && this._messages.length === 0 ? '<div class="empty">暂无消息，等待新消息推送...</div>' : ''}
          ${!errorText ? rows : ''}
        </div>
      </section>
    `;
    if (!errorText && this._messages.length > 0) {
      this._renderMessagesIntoBubbles();
    }
  }
}

if (!customElements.get('id-chat-box')) {
  customElements.define('id-chat-box', IdChatBox);
}
