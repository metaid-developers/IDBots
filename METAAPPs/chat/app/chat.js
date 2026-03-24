import { getWsNewStore } from '@idf/stores/chat/ws-new.js';
import { getSimpleTalkStore } from '@idf/stores/chat/simple-talk.js';

window.ServiceLocator = {
  ...(window.ServiceLocator || {}),
  metaid_man: 'https://www.show.now/man',
  metafs: 'https://file.metaid.io/metafile-indexer/api/v1',
  man_api: 'https://man.metaid.io/api',
  idchat: 'https://api.idchat.io/chat-api/group-chat',
  chat_ws: 'https://api.idchat.io',
  chat_ws_path: '/socket',
};

window.IDFrameworkConfig = {
  ...(window.IDFrameworkConfig || {}),
  routeComponentBasePath: '@idf/components/',
};

const CHAT_COMPONENTS = [
  '@idf/components/id-connect-button.js?v=20260322-m4i',
  '@idf/components/id-userinfo-float-panel.js?v=20260322-m4i',
  '@idf/components/id-avatar.js?v=20260322-m4i',
  '@idf/components/id-chat-header.js?v=20260322-m4i',
  '@idf/components/id-chat-chatlist-panel.js?v=20260323-perf2',
  '@idf/components/id-chat-groupmsg-list.js?v=20260324-scrollfix1',
  '@idf/components/id-chat-bubble.js?v=20260323-opt1',
  '@idf/components/id-chat-msg-bubble.js?v=20260322-m4i',
  '@idf/components/id-chain-fee-selector.js?v=20260322-m4i',
  '@idf/components/id-chat-input-box.js?v=20260323-opt1',
];
const DEFERRED_CHAT_COMPONENTS = [
  '@idf/components/id-chat-group-info-panel.js?v=20260322-m4i',
];
const CHAT_COMMAND_VERSION = '20260324-previewformat1';
const GROUP_TEXT_PROTOCOL = '/protocols/simplegroupchat';
const PRIVATE_TEXT_PROTOCOL = '/protocols/simplemsg';
const GROUP_FILE_PROTOCOL = '/protocols/simplefilegroupchat';
const PRIVATE_FILE_PROTOCOL = '/protocols/simplefilemsg';

const CHAT_I18N_CATALOGS = {
  en: {
    chat: {
      page: {
        back: '← Back',
        emptyTitle: 'Select a chat to start messaging',
        emptyHint: 'Choose a conversation from the sidebar',
      },
      runtime: {
        you: 'You',
        fileToken: '[File]',
        newMessage: 'New message',
        encrypted: '[Encrypted]',
        groupChat: 'Group Chat',
      },
      header: {
        userFallback: 'User',
        groupFallback: 'Group Chat',
        privateStatus: 'Private Chat',
        groupStatus: 'Group Chat',
        conversationInfo: 'Conversation info',
        infoButton: 'Info',
      },
      chatlist: {
        loadingConversations: 'Loading conversations...',
        errorPrefix: 'Error:',
        emptyTitle: 'No conversations yet',
        emptyHint: 'Start a new chat to begin messaging',
        unnamedGroup: 'Unnamed Group',
        unknownUser: 'Unknown User',
        noMessagesYet: 'No messages yet',
        updating: 'Updating...',
        title: 'Chat',
        newChat: 'New Chat',
        yesterday: 'Yesterday',
      },
      groupmsg: {
        loadingOlder: 'Loading older messages...',
        syncing: 'Syncing messages...',
        loadingMessages: 'Loading messages...',
        errorPrefix: 'Error:',
        selectConversation: 'Select a conversation to view messages',
        noMessagesYet: 'No messages yet',
        scrollToBottom: 'Scroll to latest messages',
      },
      bubble: {
        copySuccess: 'Copied',
        close: 'Close',
        fileToken: '[File]',
        sending: 'Sending...',
        failedToSend: 'Failed to send',
        retry: 'Retry',
        reply: 'Reply',
        unknown: 'Unknown',
        quotedMessage: '[Quoted Message]',
        fileParseFailed: '[Failed to parse file message]',
        preview: 'Preview',
        filePreviewOrDownload: 'Preview or download',
        download: 'Download',
        copy: 'Copy',
        quote: 'Quote',
        loading: 'Loading...',
        fileTypeArchive: 'Archive',
        fileTypeDocument: 'Document',
        fileTypeFile: 'File',
      },
      input: {
        loadingMentionUsers: 'Loading mention users...',
        noMentionUsers: 'No mention users configured.',
        groupFallback: 'Group',
        friendFallback: 'Friend',
        sendTo: 'Send message to {target}...',
        fileSelectedHint: 'File selected. Click the send button on the preview card.',
        newlineHint: '(Shift+Space for newline)',
        textFileExclusive: 'Text and file cannot be sent together. Please clear text first.',
        fileSizeLimit: 'Currently, only files under 5MB can be sent.',
        loginRequired: 'Please log in to your wallet before proceeding.',
        textFileChooseOne: 'Please send either text or file, not both.',
        frameworkUnavailable: 'IDFramework is not available',
        groupIdRequired: 'groupId is required for group chat',
        privateMetaIdRequired: 'to-metaid is required for private chat',
        sendSuccess: 'Message sent',
        sendFailed: 'Failed to send',
        photos: 'Photos',
        video: 'Video',
        audio: 'Audio',
        file: 'File',
        reply: 'Reply',
        unknown: 'Unknown',
        cancel: 'Cancel',
        sendFile: 'Send file',
        emoji: 'Emoji',
        upload: 'Upload',
        send: 'Send',
      },
      groupInfo: {
        unknown: 'Unknown',
        loadingMembers: 'Loading members...',
        noMatchedMembers: 'No matched members',
        noMembers: 'No members found',
        owner: 'Owner',
        admin: 'Admin',
        startPrivateChat: 'Start private chat',
        chat: 'Chat',
        you: 'You',
        privateChat: 'Private Chat',
        privateConversation: 'Private conversation',
        groupChat: 'Group Chat',
        membersUnit: 'members',
        groupId: 'Group ID',
        copyGroupId: 'Copy Group ID',
        copy: 'Copy',
        announcement: 'Announcement',
        noAnnouncement: 'No announcement',
        members: 'Members',
        searchMembers: 'Search members',
        clear: 'Clear',
        loading: 'Loading...',
        loadMore: 'Load more',
        selectConversation: 'Select a conversation',
        conversationInfo: 'Conversation Info',
        close: 'Close',
        groupIdCopied: 'Group ID copied',
      },
      fee: {
        economy: 'ECO',
        high: 'High',
        normal: 'Normal',
        customize: 'Customize',
        network: 'Network',
        title: 'Chain & Fee',
        refresh: 'Refresh',
        cancel: 'Cancel',
        apply: 'OK',
      },
    },
    connectButton: {
      connect: 'Connect',
      connecting: 'Connecting...',
      editProfile: 'Edit Profile',
      logout: 'Log Out',
    },
  },
  zh: {
    chat: {
      page: {
        back: '← 返回',
        emptyTitle: '选择一个会话开始聊天',
        emptyHint: '从左侧会话列表中选择',
      },
      runtime: {
        you: '你',
        fileToken: '[文件]',
        newMessage: '新消息',
        encrypted: '[加密消息]',
        groupChat: '群聊',
      },
      header: {
        userFallback: '用户',
        groupFallback: '群聊',
        privateStatus: '私聊',
        groupStatus: '群聊',
        conversationInfo: '会话信息',
        infoButton: '信息',
      },
      chatlist: {
        loadingConversations: '正在加载会话...',
        errorPrefix: '错误:',
        emptyTitle: '暂无会话',
        emptyHint: '发起新的聊天开始沟通',
        unnamedGroup: '未命名群聊',
        unknownUser: '未知用户',
        noMessagesYet: '暂无消息',
        updating: '更新中...',
        title: '聊天',
        newChat: '新建会话',
        yesterday: '昨天',
      },
      groupmsg: {
        loadingOlder: '正在加载更早消息...',
        syncing: '同步消息中...',
        loadingMessages: '正在加载消息...',
        errorPrefix: '错误:',
        selectConversation: '请选择一个会话查看消息',
        noMessagesYet: '暂无消息',
        scrollToBottom: '滚动到最新消息',
      },
      bubble: {
        copySuccess: '复制成功',
        close: '关闭',
        fileToken: '[文件]',
        sending: '发送中...',
        failedToSend: '发送失败',
        retry: '重试',
        reply: '回复',
        unknown: '未知',
        quotedMessage: '[引用消息]',
        fileParseFailed: '[文件消息解析失败]',
        preview: '预览',
        filePreviewOrDownload: '点击预览或下载',
        download: '下载',
        copy: '复制',
        quote: '引用',
        loading: '加载中...',
        fileTypeArchive: '压缩包',
        fileTypeDocument: '文档',
        fileTypeFile: '文件',
      },
      input: {
        loadingMentionUsers: '正在加载可@成员...',
        noMentionUsers: '暂无可@成员',
        groupFallback: '群聊',
        friendFallback: '好友',
        sendTo: '发送消息到 {target}...',
        fileSelectedHint: '已选择文件，点击预览卡片上的发送按钮',
        newlineHint: '(Shift+Space 换行)',
        textFileExclusive: '文本和文件不能同时发送，请先清空文本',
        fileSizeLimit: '当前仅支持发送 5MB 以内文件。',
        loginRequired: '请先连接钱包并登录。',
        textFileChooseOne: '文本和文件只能二选一发送',
        frameworkUnavailable: 'IDFramework 不可用',
        groupIdRequired: '群聊缺少 groupId',
        privateMetaIdRequired: '私聊缺少 to-metaid',
        sendSuccess: '消息发送成功',
        sendFailed: '发送失败',
        photos: '相册',
        video: '视频',
        audio: '音频',
        file: '文件',
        reply: '回复',
        unknown: '未知',
        cancel: '取消',
        sendFile: '发送文件',
        emoji: '表情',
        upload: '上传',
        send: '发送',
      },
      groupInfo: {
        unknown: '未知',
        loadingMembers: '正在加载成员...',
        noMatchedMembers: '没有匹配成员',
        noMembers: '暂无成员',
        owner: '群主',
        admin: '管理员',
        startPrivateChat: '发起私聊',
        chat: '私聊',
        you: '你',
        privateChat: '私聊',
        privateConversation: '私密会话',
        groupChat: '群聊',
        membersUnit: '成员',
        groupId: '群 ID',
        copyGroupId: '复制群 ID',
        copy: '复制',
        announcement: '公告',
        noAnnouncement: '暂无公告',
        members: '成员',
        searchMembers: '搜索成员',
        clear: '清空',
        loading: '加载中...',
        loadMore: '加载更多',
        selectConversation: '请选择一个会话',
        conversationInfo: '会话信息',
        close: '关闭',
        groupIdCopied: '群 ID 已复制',
      },
      fee: {
        economy: '经济',
        high: '高速',
        normal: '标准',
        customize: '自定义',
        network: '网络',
        title: '链与费率',
        refresh: '刷新',
        cancel: '取消',
        apply: '确定',
      },
    },
    connectButton: {
      connect: '连接钱包',
      connecting: '连接中...',
      editProfile: '编辑资料',
      logout: '退出登录',
    },
  },
};

const wsStore = getWsNewStore();
let currentSocketMetaId = '';
let previewChatStore = null;
let previewChatStorePromise = null;
let chatListRefreshTimer = null;
let chatListRefreshQueuedAt = 0;
let chatListRefreshInFlight = false;
let socketHealthTimer = null;
let socketReconnectTimer = null;
let lastSocketBindAt = 0;
let lastSocketConnectAt = 0;
let lastSocketDisconnectAt = 0;
let lastSocketMessageAt = 0;
let lastChatListRefreshAt = 0;
let lastOutboundSendAt = 0;
let lastHardSocketRebindAt = 0;
let localeUiBound = false;
const pendingSendContextByTempId = new Map();
const pendingTempIdByTxId = new Map();

const CHAT_PAGE_SIZE = 50;
const CHAT_LIST_IDLE_REFRESH_MS = 120000;
const CHAT_LIST_REFRESH_MIN_INTERVAL_MS = 3000;
const SOCKET_STALE_RECONNECT_MS = 120000;
const SOCKET_HARD_REBIND_IDLE_MS = 300000;
const SOCKET_HARD_REBIND_COOLDOWN_MS = 180000;
const SOCKET_HEALTH_TICK_MS = 15000;
const SOCKET_RECONNECT_DELAY_MS = 1500;
const PENDING_ACK_REPAIR_AFTER_MS = 12000;
const PENDING_ACK_REPAIR_INTERVAL_MS = 15000;

function getStore(name) {
  if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
  return Alpine.store(name) || null;
}

function getI18n() {
  if (typeof window === 'undefined' || !window.IDFramework || !window.IDFramework.I18n) return null;
  return window.IDFramework.I18n;
}

function t(key, fallback, params) {
  const i18n = getI18n();
  if (!i18n || typeof i18n.t !== 'function') return fallback || key;
  return i18n.t(key, params || {}, fallback || '');
}

function getLocale() {
  const i18n = getI18n();
  if (!i18n || typeof i18n.getLocale !== 'function') return 'en';
  const locale = String(i18n.getLocale() || '').trim().toLowerCase();
  return locale === 'zh' ? 'zh' : 'en';
}

function setLocale(nextLocale) {
  const i18n = getI18n();
  if (!i18n || typeof i18n.setLocale !== 'function') return;
  i18n.setLocale(nextLocale);
}

function applyPageI18n() {
  if (typeof document === 'undefined') return;
  const locale = getLocale();
  if (document.documentElement) {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }
  const nodes = document.querySelectorAll('[data-i18n]');
  nodes.forEach((node) => {
    const key = String(node.getAttribute('data-i18n') || '').trim();
    if (!key) return;
    const fallback = String(node.getAttribute('data-i18n-fallback') || node.textContent || '');
    node.textContent = t(key, fallback);
  });
}

function refreshLocaleButtons() {
  if (typeof document === 'undefined') return;
  const locale = getLocale();
  const buttons = document.querySelectorAll('[data-action="set-locale"]');
  buttons.forEach((button) => {
    const value = String(button.getAttribute('data-locale-value') || '').trim().toLowerCase();
    const active = value === locale;
    if (button.classList && typeof button.classList.toggle === 'function') {
      button.classList.toggle('is-active', active);
    }
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function bindLocaleSwitcher() {
  if (localeUiBound || typeof document === 'undefined') return;
  localeUiBound = true;

  document.querySelectorAll('[data-action="set-locale"]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = String(button.getAttribute('data-locale-value') || '').trim().toLowerCase();
      if (!next) return;
      setLocale(next);
    });
  });

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('id:i18n:changed', () => {
      applyPageI18n();
      refreshLocaleButtons();
      notifyChatUpdated();
    });
  }
}

function initChatI18n() {
  const i18n = getI18n();
  if (!i18n) return;
  if (typeof i18n.registerMessages === 'function') {
    i18n.registerMessages(CHAT_I18N_CATALOGS);
  }
  if (typeof i18n.init === 'function') {
    i18n.init();
  }
  bindLocaleSwitcher();
  applyPageI18n();
  refreshLocaleButtons();
}

function notifyChatUpdated() {
  document.dispatchEvent(new CustomEvent('id:chat:updated'));
}

function isSocketDebugEnabled() {
  return typeof window !== 'undefined' && !!window.__IDCHAT_SOCKET_DEBUG__;
}

function pushSocketTrace(eventName, payload) {
  if (!isSocketDebugEnabled()) return;
  const trace = {
    ts: Date.now(),
    event: String(eventName || 'unknown'),
    ...((payload && typeof payload === 'object') ? payload : {}),
  };
  if (!Array.isArray(window.__IDCHAT_SOCKET_TRACE__)) {
    window.__IDCHAT_SOCKET_TRACE__ = [];
  }
  window.__IDCHAT_SOCKET_TRACE__.push(trace);
  if (window.__IDCHAT_SOCKET_TRACE__.length > 1500) {
    window.__IDCHAT_SOCKET_TRACE__.splice(0, window.__IDCHAT_SOCKET_TRACE__.length - 1500);
  }
  if (window.__IDCHAT_SOCKET_DEBUG_CONSOLE__ && typeof console !== 'undefined' && typeof console.debug === 'function') {
    console.debug('[demos/chat/socket]', trace);
  }
}

function scheduleChatListRefresh(delay = 900, options = {}) {
  const refreshOptions = options && typeof options === 'object' ? options : {};
  const force = !!refreshOptions.force;
  const minIntervalMs = Number(refreshOptions.minIntervalMs || CHAT_LIST_REFRESH_MIN_INTERVAL_MS);
  const now = Date.now();
  const latestRefreshSignalAt = Math.max(
    Number(lastChatListRefreshAt || 0),
    Number(chatListRefreshQueuedAt || 0)
  );
  if (!force && minIntervalMs > 0 && latestRefreshSignalAt > 0 && (now - latestRefreshSignalAt) < minIntervalMs) {
    return;
  }

  if (chatListRefreshTimer) {
    clearTimeout(chatListRefreshTimer);
    chatListRefreshTimer = null;
  }
  const normalizedDelay = Number.isFinite(Number(delay)) ? Math.max(0, Number(delay)) : 0;
  chatListRefreshQueuedAt = now + normalizedDelay;
  chatListRefreshTimer = setTimeout(async () => {
    chatListRefreshTimer = null;
    if (chatListRefreshInFlight) return;
    chatListRefreshInFlight = true;
    try {
      await refreshChatList(refreshOptions);
    } catch (_) {
    } finally {
      chatListRefreshInFlight = false;
      chatListRefreshQueuedAt = 0;
    }
  }, normalizedDelay);
}

function clearSocketReconnectTimer() {
  if (!socketReconnectTimer) return;
  clearTimeout(socketReconnectTimer);
  socketReconnectTimer = null;
}

function scheduleSocketReconnect(reason = 'auto') {
  clearSocketReconnectTimer();
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    bindSocketForCurrentWallet({ force: true, reason });
  }, SOCKET_RECONNECT_DELAY_MS);
}

function startSocketHealthMonitor() {
  if (socketHealthTimer) return;
  socketHealthTimer = setInterval(() => {
    runSocketHealthCheck('interval');
  }, SOCKET_HEALTH_TICK_MS);
}

function stopSocketHealthMonitor() {
  if (socketHealthTimer) {
    clearInterval(socketHealthTimer);
    socketHealthTimer = null;
  }
  clearSocketReconnectTimer();
}

function normalizeConversationType(type) {
  const raw = String(type || '').trim();
  return raw === '1' ? '1' : '2';
}

function getLocalLatestMessageIndex(chatStore, conversationKey, includeOptimistic = false) {
  const key = String(conversationKey || '').trim();
  if (!key || !chatStore || !chatStore.messages || typeof chatStore.messages !== 'object') return 0;
  const rows = Array.isArray(chatStore.messages[key]) ? chatStore.messages[key] : [];
  return rows.reduce((max, row) => {
    if (!includeOptimistic && isOptimisticMessage(row)) return max;
    const idx = Number(row && row.index ? row.index : 0);
    if (!Number.isFinite(idx) || idx <= 0) return max;
    return idx > max ? idx : max;
  }, 0);
}

function resolveConversationTypeForKey(chatStore, conversationKey) {
  const key = String(conversationKey || '').trim();
  if (!key || !chatStore) return '2';
  const row = chatStore.conversations && typeof chatStore.conversations === 'object'
    ? (chatStore.conversations[key] || null)
    : null;
  return normalizeConversationType(
    (row && row.type) ||
    (key === String(chatStore.currentConversation || '') ? chatStore.currentConversationType : '') ||
    '2'
  );
}

function computeRecentWindowStart(rawLastIndex, size = CHAT_PAGE_SIZE) {
  const lastIndex = Number(rawLastIndex || 0);
  const pageSize = Number.isFinite(Number(size)) && Number(size) > 0 ? Math.floor(Number(size)) : CHAT_PAGE_SIZE;
  if (!Number.isFinite(lastIndex) || lastIndex <= 0) return 0;
  return Math.max(1, Math.floor(lastIndex) - (pageSize - 1));
}

async function dispatchConversationRecentFetch(conversationKey, conversationType, options = {}) {
  const key = String(conversationKey || '').trim();
  if (!key || !window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;

  const chatStore = ensureChatStoreShape();
  const walletStore = getStore('wallet');
  if (!chatStore || !walletStore || !walletStore.isConnected || !walletStore.globalMetaId) return;

  const runOptions = options && typeof options === 'object' ? options : {};
  const type = normalizeConversationType(conversationType);
  const row = chatStore.conversations && typeof chatStore.conversations === 'object'
    ? (chatStore.conversations[key] || null)
    : null;
  const localLatest = getLocalLatestMessageIndex(chatStore, key, false);
  let latestHint = Math.max(
    Number(row && row.index ? row.index : 0),
    Number(localLatest || 0),
    Number(runOptions.latestHint || 0)
  );

  if (!latestHint) {
    try {
      await window.IDFramework.dispatch('fetchChatList', { background: true });
      notifyChatUpdated();
      const refreshedRow = chatStore.conversations && typeof chatStore.conversations === 'object'
        ? (chatStore.conversations[key] || null)
        : null;
      latestHint = Math.max(
        Number(refreshedRow && refreshedRow.index ? refreshedRow.index : 0),
        Number(getLocalLatestMessageIndex(chatStore, key, false) || 0),
        Number(runOptions.latestHint || 0)
      );
    } catch (_) {}
  }

  // Never backfill "recent messages" from index 0; that path can jump UI to earliest page.
  if (!Number.isFinite(latestHint) || Number(latestHint) <= 0) return;
  const startIndex = computeRecentWindowStart(latestHint, CHAT_PAGE_SIZE);
  if (!Number.isFinite(startIndex) || Number(startIndex) <= 0) return;
  if (type === '1') {
    const groupId = String((row && row.groupId) || key).trim();
    if (!groupId) return;
    await window.IDFramework.dispatch('fetchGroupMessages', {
      groupId,
      startIndex,
      size: CHAT_PAGE_SIZE,
      mergeMode: 'prepend',
    });
    return;
  }

  const selfMetaId = String(walletStore.globalMetaId || '').trim();
  if (!selfMetaId) return;
  await window.IDFramework.dispatch('fetchPrivateMessages', {
    metaId: selfMetaId,
    otherMetaId: key,
    startIndex,
    size: CHAT_PAGE_SIZE,
    mergeMode: 'prepend',
  });
}

async function maybeSyncCurrentConversationAfterListRefresh(reason = 'refresh') {
  const chatStore = ensureChatStoreShape();
  const currentKey = String((chatStore && chatStore.currentConversation) || '').trim();
  if (!chatStore || !currentKey) return;

  const row = chatStore.conversations && typeof chatStore.conversations === 'object'
    ? (chatStore.conversations[currentKey] || null)
    : null;
  if (!row || typeof row !== 'object') return;

  const remoteIndex = Number(row.index || 0);
  const localIndex = getLocalLatestMessageIndex(chatStore, currentKey, false);
  if (!Number.isFinite(remoteIndex) || remoteIndex <= localIndex) return;

  pushSocketTrace('active-conversation-backfill', {
    reason: String(reason || ''),
    conversation: currentKey,
    remoteIndex: Number(remoteIndex || 0),
    localIndex: Number(localIndex || 0),
  });

  await dispatchConversationRecentFetch(
    currentKey,
    String(row.type || chatStore.currentConversationType || '2'),
    { latestHint: remoteIndex }
  );

  const refreshedLocalIndex = getLocalLatestMessageIndex(chatStore, currentKey, false);
  if (refreshedLocalIndex >= remoteIndex) return;

  pushSocketTrace('active-conversation-backfill-still-behind', {
    reason: String(reason || ''),
    conversation: currentKey,
    remoteIndex: Number(remoteIndex || 0),
    localIndex: Number(refreshedLocalIndex || 0),
  });
  bindSocketForCurrentWallet({ force: true, reason: `backfill-behind-${String(reason || 'unknown')}` });
}

async function reconcilePendingAckMessages(reason = 'health') {
  const chatStore = ensureChatStoreShape();
  if (!chatStore || pendingSendContextByTempId.size === 0) return;

  const now = Date.now();
  const pendingRoutes = new Map();

  for (const [tempIdRaw, contextRaw] of pendingSendContextByTempId.entries()) {
    const clientTempId = normalizeClientTempId(tempIdRaw);
    if (!clientTempId) continue;

    const context = contextRaw && typeof contextRaw === 'object' ? contextRaw : {};
    const located = findRouteByClientTempId(chatStore, clientTempId);
    const routeKey = String((located && located.key) || context.routeKey || '').trim();
    if (!routeKey) {
      pendingSendContextByTempId.delete(clientTempId);
      clearPendingTxMappingByTempId(clientTempId);
      continue;
    }

    const rows = Array.isArray(chatStore.messages[routeKey]) ? chatStore.messages[routeKey] : [];
    const row = located && rows[located.index] ? rows[located.index] : null;
    if (!row || !isOptimisticMessage(row)) {
      pendingSendContextByTempId.delete(clientTempId);
      clearPendingTxMappingByTempId(clientTempId);
      continue;
    }

    const sendStatus = String(row._sendStatus || '').trim();
    if (sendStatus !== 'pending_ack') continue;

    const createdAt = Number(context.createdAt || 0);
    const ageMs = createdAt > 0 ? (now - createdAt) : Number.MAX_SAFE_INTEGER;
    if (ageMs < PENDING_ACK_REPAIR_AFTER_MS) continue;

    const lastRepairAt = Number(context.lastRepairAt || 0);
    if (now - lastRepairAt < PENDING_ACK_REPAIR_INTERVAL_MS) continue;

    pendingSendContextByTempId.set(clientTempId, {
      ...context,
      routeKey,
      routeType: String(context.routeType || row.type || ''),
      lastRepairAt: now,
    });

    const routeType = normalizeConversationType(context.routeType || row.type || resolveConversationTypeForKey(chatStore, routeKey));
    const routeMapKey = `${routeType}:${routeKey}`;
    if (!pendingRoutes.has(routeMapKey)) {
      pendingRoutes.set(routeMapKey, { key: routeKey, type: routeType });
    }
  }

  if (pendingRoutes.size === 0) return;

  for (const route of pendingRoutes.values()) {
    pushSocketTrace('pending-ack-repair', {
      reason: String(reason || ''),
      routeKey: String(route.key || ''),
      routeType: String(route.type || ''),
    });
    try {
      await dispatchConversationRecentFetch(route.key, route.type, { reason });
      notifyChatUpdated();
    } catch (_) {}
  }
}

function runSocketHealthCheck(reason = 'health') {
  const walletStore = getStore('wallet');
  if (!walletStore || !walletStore.isConnected || !walletStore.globalMetaId) return;
  const chatStore = ensureChatStoreShape();

  const now = Date.now();
  const connected = wsStore.isConnected();
  const baseline = Math.max(
    Number(lastSocketMessageAt || 0),
    Number(lastSocketConnectAt || 0),
    Number(lastSocketBindAt || 0)
  );
  const idleMs = baseline > 0 ? (now - baseline) : Number.MAX_SAFE_INTEGER;

  if (!connected || String(currentSocketMetaId || '').trim() !== String(walletStore.globalMetaId || '').trim()) {
    pushSocketTrace('socket-health-rebind', {
      reason: String(reason || ''),
      connected: connected ? 1 : 0,
      currentSocketMetaId: String(currentSocketMetaId || ''),
      walletMetaId: String(walletStore.globalMetaId || ''),
      idleMs: Number(idleMs || 0),
      sinceDisconnect: Number(lastSocketDisconnectAt ? (now - lastSocketDisconnectAt) : 0),
    });
    bindSocketForCurrentWallet({ force: true, reason: `health-${String(reason || 'unknown')}` });
    scheduleChatListRefresh(260, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
    return;
  }

  if (idleMs > CHAT_LIST_IDLE_REFRESH_MS && (now - Number(lastChatListRefreshAt || 0) > CHAT_LIST_IDLE_REFRESH_MS)) {
    scheduleChatListRefresh(240, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
  }

  const hasPendingAck = (() => {
    if (!chatStore || pendingSendContextByTempId.size === 0) return false;
    for (const [tempIdRaw] of pendingSendContextByTempId.entries()) {
      const clientTempId = normalizeClientTempId(tempIdRaw);
      if (!clientTempId) continue;
      const located = findRouteByClientTempId(chatStore, clientTempId);
      if (!located) continue;
      const rows = Array.isArray(chatStore.messages[located.key]) ? chatStore.messages[located.key] : [];
      const row = rows[located.index];
      if (!row || !isOptimisticMessage(row)) continue;
      if (String(row._sendStatus || '').trim() === 'pending_ack') return true;
    }
    return false;
  })();
  const hasRecentOutbound = lastOutboundSendAt > 0 && (now - lastOutboundSendAt) < SOCKET_STALE_RECONNECT_MS;

  if (idleMs > SOCKET_STALE_RECONNECT_MS && (hasPendingAck || hasRecentOutbound)) {
    pushSocketTrace('socket-health-reconnect', {
      reason: String(reason || ''),
      idleMs: Number(idleMs || 0),
      hasPendingAck: hasPendingAck ? 1 : 0,
      hasRecentOutbound: hasRecentOutbound ? 1 : 0,
      sinceConnect: Number(lastSocketConnectAt ? (now - lastSocketConnectAt) : 0),
      sinceMessage: Number(lastSocketMessageAt ? (now - lastSocketMessageAt) : 0),
    });
    bindSocketForCurrentWallet({ force: true, reason: `stale-${String(reason || 'unknown')}` });
    scheduleChatListRefresh(220, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
    return;
  }

  const isVisible = typeof document === 'undefined' || document.visibilityState === 'visible';
  const canHardRebind =
    isVisible &&
    idleMs > SOCKET_HARD_REBIND_IDLE_MS &&
    (now - Number(lastHardSocketRebindAt || 0) > SOCKET_HARD_REBIND_COOLDOWN_MS);
  if (canHardRebind) {
    const prevHardRebindAt = Number(lastHardSocketRebindAt || 0);
    lastHardSocketRebindAt = now;
    pushSocketTrace('socket-health-hard-rebind', {
      reason: String(reason || ''),
      idleMs: Number(idleMs || 0),
      sinceConnect: Number(lastSocketConnectAt ? (now - lastSocketConnectAt) : 0),
      sinceMessage: Number(lastSocketMessageAt ? (now - lastSocketMessageAt) : 0),
      sinceLastHardRebind: Number(prevHardRebindAt ? (now - prevHardRebindAt) : 0),
    });
    bindSocketForCurrentWallet({ force: true, reason: `hard-stale-${String(reason || 'unknown')}` });
    scheduleChatListRefresh(220, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
    return;
  }

  reconcilePendingAckMessages(`health-${String(reason || 'unknown')}`).catch(() => {});
}

function normalizeTimestampSeconds(raw) {
  const num = Number(raw || 0);
  if (!Number.isFinite(num) || num <= 0) return Math.floor(Date.now() / 1000);
  if (num > 1000000000000) return Math.floor(num / 1000);
  return Math.floor(num);
}

function normalizeChain(rawChain) {
  const raw = toSingleLine(rawChain).toLowerCase();
  if (!raw) return '';
  if (raw === 'bsv' || raw === 'btc') return 'btc';
  if (raw === 'dogecoin' || raw === 'doge') return 'doge';
  if (raw === 'microvisionchain' || raw === 'mvc') return 'mvc';
  return raw;
}

function toConversationMillis(rawSeconds) {
  const sec = normalizeTimestampSeconds(rawSeconds);
  return sec * 1000;
}

function toSingleLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function identityMatchesSenderIdentity(candidate, senderGlobalMetaId, senderMetaId) {
  const row = candidate && typeof candidate === 'object' ? candidate : null;
  if (!row) return false;
  const candidateGlobal = toSingleLine(row.globalMetaId || row.globalmetaid || '');
  const candidateMeta = toSingleLine(row.metaid || row.metaId || '');
  if (senderGlobalMetaId && candidateGlobal && senderGlobalMetaId === candidateGlobal) return true;
  if (senderMetaId && candidateMeta && senderMetaId === candidateMeta) return true;
  if (senderGlobalMetaId && candidateMeta && senderGlobalMetaId === candidateMeta) return true;
  if (senderMetaId && candidateGlobal && senderMetaId === candidateGlobal) return true;
  return false;
}

function formatSenderLabel(raw) {
  const text = toSingleLine(raw);
  if (!text) return '';
  if (text.length > 24 && /^[a-zA-Z0-9_-]+$/.test(text)) return text.slice(0, 12) + '...';
  return text;
}

function truncateIdentity(text) {
  const raw = toSingleLine(text);
  if (!raw) return '';
  if (raw.length <= 16) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
}

function resolveRealtimeSenderLabel(message, selfGlobalMetaId) {
  const fromUser = message && message.userInfo && typeof message.userInfo === 'object' ? message.userInfo : {};
  const fromSource = message && message.fromUserInfo && typeof message.fromUserInfo === 'object' ? message.fromUserInfo : {};
  const senderGlobalMetaId = toSingleLine(
    message.fromGlobalMetaId ||
    message.createGlobalMetaId ||
    fromSource.globalMetaId ||
    fromUser.globalMetaId ||
    ''
  );
  const senderMetaId = toSingleLine(
    message.fromMetaId ||
    message.createMetaId ||
    fromSource.metaid ||
    fromSource.metaId ||
    fromUser.metaid ||
    fromUser.metaId ||
    ''
  );

  if (selfGlobalMetaId && senderGlobalMetaId && selfGlobalMetaId === senderGlobalMetaId) {
    return t('chat.runtime.you', 'You');
  }

  const userStore = ensureUserStoreShape();
  const users = userStore && userStore.users && typeof userStore.users === 'object' ? userStore.users : {};
  const senderFromStore = senderGlobalMetaId
    ? (users[senderGlobalMetaId] || {})
    : (senderMetaId ? (users[senderMetaId] || {}) : {});

  const candidates = [
    senderFromStore.name,
    identityMatchesSenderIdentity(fromSource, senderGlobalMetaId, senderMetaId) ? fromSource.name : '',
    identityMatchesSenderIdentity(fromUser, senderGlobalMetaId, senderMetaId) ? fromUser.name : '',
    message.senderName,
    message.sender,
    message.nickName,
    senderGlobalMetaId ? truncateIdentity(senderGlobalMetaId) : '',
    senderMetaId ? truncateIdentity(senderMetaId) : '',
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const resolved = formatSenderLabel(candidates[i]);
    if (resolved) return resolved;
  }
  return '';
}

function looksEncryptedContent(text) {
  const raw = toSingleLine(text);
  if (!raw) return false;
  if (/^[a-fA-F0-9]{32,}(?:i\d+)?$/.test(raw)) return true;
  if (/^U2FsdGVkX1/i.test(raw)) return true;
  if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 64 && raw.length % 4 === 0) return true;
  return false;
}

function resolveMessageProtocol(message) {
  const explicit = String(
    message && (message.protocol || message.protocolPath || message.path)
      ? (message.protocol || message.protocolPath || message.path)
      : ''
  ).trim();
  if (explicit) return explicit;
  const hasAttachment = String(message && message.attachment ? message.attachment : '').trim() !== '';
  const isGroup = String(message && (message.groupId || message.channelId) ? (message.groupId || message.channelId) : '').trim() !== '';
  if (hasAttachment) return isGroup ? GROUP_FILE_PROTOCOL : PRIVATE_FILE_PROTOCOL;
  return isGroup ? GROUP_TEXT_PROTOCOL : PRIVATE_TEXT_PROTOCOL;
}

async function ensurePreviewChatStoreReady() {
  if (previewChatStore) return previewChatStore;
  if (!previewChatStorePromise) {
    previewChatStorePromise = (async () => {
      const store = getSimpleTalkStore();
      await store.init();
      previewChatStore = store;
      return store;
    })().catch((error) => {
      previewChatStore = null;
      previewChatStorePromise = null;
      throw error;
    });
  }
  try {
    return await previewChatStorePromise;
  } catch (_) {
    return null;
  }
}

async function normalizeMessagePreview(message, selfGlobalMetaId) {
  const toText = (value) => String(value == null ? '' : value).trim();
  const sender = resolveRealtimeSenderLabel(message, selfGlobalMetaId);
  const prefix = (text) => sender ? `${sender}: ${text}` : text;

  let content = toSingleLine(message.content || '');
  const hasAttachment = !!toText(message.attachment || '');
  if (!content && hasAttachment) return prefix(t('chat.runtime.fileToken', '[File]'));
  if (!content) return prefix(t('chat.runtime.newMessage', 'New message'));

  const protocol = resolveMessageProtocol(message);
  if (looksEncryptedContent(content)) {
    const decryptable = protocol === GROUP_TEXT_PROTOCOL || protocol === PRIVATE_TEXT_PROTOCOL;
    if (decryptable) {
      const cryptoStore = await ensurePreviewChatStoreReady();
      if (cryptoStore && typeof cryptoStore.decryptText === 'function') {
        try {
          const decrypted = await cryptoStore.decryptText({
            ...message,
            protocol: protocol,
            content: content,
          });
          const singleLine = toSingleLine(decrypted || '');
          if (singleLine && !looksEncryptedContent(singleLine)) {
            content = singleLine;
          }
        } catch (_) {}
      }
    }
  }
  if (looksEncryptedContent(content)) return prefix(t('chat.runtime.encrypted', '[Encrypted]'));
  const clipped = content.length > 80 ? (content.slice(0, 80) + '...') : content;
  return prefix(clipped);
}

function ensureChatStoreShape() {
  const chatStore = getStore('chat');
  if (!chatStore) return null;

  if (!chatStore.conversations || typeof chatStore.conversations !== 'object') chatStore.conversations = {};
  if (!chatStore.messages || typeof chatStore.messages !== 'object') chatStore.messages = {};
  if (!chatStore.groupInfoById || typeof chatStore.groupInfoById !== 'object') chatStore.groupInfoById = {};
  if (!chatStore.groupMembersById || typeof chatStore.groupMembersById !== 'object') chatStore.groupMembersById = {};
  if (!Array.isArray(chatStore.conversationOrder)) chatStore.conversationOrder = [];
  if (chatStore.currentConversationId === undefined) chatStore.currentConversationId = null;
  if (chatStore.currentConversationType === undefined) chatStore.currentConversationType = null;
  if (chatStore.currentConversationIndex === undefined) chatStore.currentConversationIndex = null;
  if (chatStore.isLoading === undefined) chatStore.isLoading = false;
  if (chatStore.error === undefined) chatStore.error = null;
  if (chatStore.useCommandMessageFetch === undefined) chatStore.useCommandMessageFetch = true;
  return chatStore;
}

function ensureUserStoreShape() {
  const userStore = getStore('user');
  if (!userStore) return null;
  if (!userStore.user || typeof userStore.user !== 'object') userStore.user = {};
  if (!userStore.users || typeof userStore.users !== 'object') userStore.users = {};
  return userStore;
}

function enforceChatChainFeeDefaults() {
  const chainFeeStore = getStore('chainFee');
  if (!chainFeeStore || typeof chainFeeStore !== 'object') return;

  // Chat keeps deterministic startup defaults: MVC + ECO.
  if (typeof chainFeeStore.setCurrentChain === 'function') {
    chainFeeStore.setCurrentChain('mvc');
  } else {
    chainFeeStore.currentChain = 'mvc';
  }

  if (typeof chainFeeStore.setFeeType === 'function') {
    chainFeeStore.setFeeType('mvc', 'economyFee');
  } else if (chainFeeStore.mvc && typeof chainFeeStore.mvc === 'object') {
    chainFeeStore.mvc.selectedFeeType = 'economyFee';
  }
}

function inferMessageRoute(message, selfGlobalMetaId, chatStore) {
  const groupId = String(message.groupId || message.groupID || message.metanetId || '').trim();
  const channelId = String(message.channelId || message.channelID || '').trim();
  if (groupId || channelId) {
    const conversations = chatStore && chatStore.conversations && typeof chatStore.conversations === 'object'
      ? chatStore.conversations
      : {};
    const currentConversation = String((chatStore && chatStore.currentConversation) || '').trim();
    const currentConversationRow = currentConversation ? (conversations[currentConversation] || null) : null;
    const matchConversationByRoute = (row, key) => {
      const candidate = row && typeof row === 'object' ? row : null;
      if (!candidate) return false;
      const rowKey = String(key || '').trim();
      const rowGroupId = String(candidate.groupId || candidate.conversationId || candidate.metaid || '').trim();
      const rowChannelId = String(candidate.channelId || '').trim();
      if (groupId && (rowKey === groupId || rowGroupId === groupId)) return true;
      if (channelId && (rowKey === channelId || rowChannelId === channelId)) return true;
      if (groupId && channelId && rowGroupId === groupId && rowChannelId === channelId) return true;
      return false;
    };
    let key = '';

    if (currentConversation && currentConversationRow && matchConversationByRoute(currentConversationRow, currentConversation)) {
      key = currentConversation;
    } else if (channelId && conversations[channelId]) key = channelId;
    else if (groupId && conversations[groupId]) key = groupId;
    else if (channelId && currentConversation === channelId) key = channelId;
    else if (groupId && currentConversation === groupId) key = groupId;
    else {
      const conversationKeys = Object.keys(conversations);
      for (let i = 0; i < conversationKeys.length; i += 1) {
        const candidateKey = conversationKeys[i];
        if (matchConversationByRoute(conversations[candidateKey], candidateKey)) {
          key = candidateKey;
          break;
        }
      }
    }
    if (!key) {
      key = channelId || groupId;
    }

    return {
      key,
      type: '1',
      groupId: groupId || key,
      channelId: channelId,
    };
  }

  const from = String(message.fromGlobalMetaId || message.createGlobalMetaId || '').trim();
  const to = String(message.toGlobalMetaId || '').trim();
  let peer = '';
  if (selfGlobalMetaId && from === selfGlobalMetaId) peer = to;
  else if (selfGlobalMetaId && to === selfGlobalMetaId) peer = from;
  else peer = from || to;

  if (!peer) return null;
  return { key: peer, type: '2', groupId: '' };
}

function ensureStrictGroupRoute(route, message, chatStore) {
  const candidate = route && typeof route === 'object' ? { ...route } : null;
  if (!candidate || String(candidate.type || '') !== '1') return candidate;
  const explicitGroupId = String(message && (message.groupId || message.groupID || message.metanetId) ? (message.groupId || message.groupID || message.metanetId) : '').trim();
  const explicitChannelId = String(message && (message.channelId || message.channelID) ? (message.channelId || message.channelID) : '').trim();
  if (!explicitGroupId && !explicitChannelId) return candidate;

  const routeKey = String(candidate.key || '').trim();
  const routeGroupId = String(candidate.groupId || '').trim();
  const conversations = chatStore && chatStore.conversations && typeof chatStore.conversations === 'object'
    ? chatStore.conversations
    : {};
  const row = routeKey ? (conversations[routeKey] || null) : null;
  const rowGroupId = String(row && (row.groupId || row.conversationId || row.metaid) ? (row.groupId || row.conversationId || row.metaid) : '').trim();
  const rowChannelId = String(row && row.channelId ? row.channelId : '').trim();

  const matchesExplicit = () => {
    if (explicitChannelId && (routeKey === explicitChannelId || rowChannelId === explicitChannelId)) return true;
    if (explicitGroupId && (routeKey === explicitGroupId || routeGroupId === explicitGroupId || rowGroupId === explicitGroupId)) return true;
    return false;
  };
  if (matchesExplicit()) return candidate;

  const strictKey = explicitChannelId || explicitGroupId;
  if (!strictKey) return candidate;
  return {
    ...candidate,
    key: strictKey,
    groupId: explicitGroupId || strictKey,
    channelId: explicitChannelId,
  };
}

function extractTxIdFromPinLike(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(.+)i\d+$/);
  return match && match[1] ? String(match[1]).trim() : '';
}

function extractTxIdFromUnknown(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const pinBased = extractTxIdFromPinLike(raw);
    if (pinBased) return pinBased;
    const txMatch = raw.match(/([a-fA-F0-9]{64})/);
    return txMatch && txMatch[1] ? txMatch[1] : '';
  }
  if (typeof value === 'object') {
    const direct = extractTxIdFromUnknown(
      value.txid ||
      value.txId ||
      value.hash ||
      value.id ||
      value.pinId ||
      value.revealTxId ||
      value.revealTxid
    );
    if (direct) return direct;
    const listKeys = ['txids', 'txIDs', 'revealTxIds', 'res'];
    for (let i = 0; i < listKeys.length; i += 1) {
      const list = value[listKeys[i]];
      if (!Array.isArray(list)) continue;
      for (let j = 0; j < list.length; j += 1) {
        const candidate = extractTxIdFromUnknown(list[j]);
        if (candidate) return candidate;
      }
    }
  }
  return '';
}

function normalizeClientTempId(value) {
  return String(value || '').trim();
}

function getMessageClientTempId(message) {
  const row = message && typeof message === 'object' ? message : {};
  return normalizeClientTempId(row._clientTempId || row.clientTempId || '');
}

function isOptimisticMessage(message) {
  const row = message && typeof message === 'object' ? message : {};
  return !!row._optimistic;
}

function revokeOptimisticPreviewUrl(message) {
  const row = message && typeof message === 'object' ? message : {};
  const preview = row._optimisticFilePreview && typeof row._optimisticFilePreview === 'object'
    ? row._optimisticFilePreview
    : null;
  const previewUrl = preview ? String(preview.url || '') : '';
  if (!previewUrl || !/^blob:/i.test(previewUrl)) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  try {
    URL.revokeObjectURL(previewUrl);
  } catch (_) {}
}

function findRouteByClientTempId(chatStore, clientTempId) {
  const normalized = normalizeClientTempId(clientTempId);
  if (!normalized || !chatStore || !chatStore.messages || typeof chatStore.messages !== 'object') return null;
  const routeKeys = Object.keys(chatStore.messages || {});
  for (let i = 0; i < routeKeys.length; i += 1) {
    const routeKey = routeKeys[i];
    const rows = Array.isArray(chatStore.messages[routeKey]) ? chatStore.messages[routeKey] : [];
    const index = rows.findIndex((row) => getMessageClientTempId(row) === normalized);
    if (index > -1) return { key: routeKey, index };
  }
  return null;
}

function patchOptimisticMessage(chatStore, clientTempId, patch) {
  const normalized = normalizeClientTempId(clientTempId);
  if (!normalized || !chatStore) return null;
  const located = findRouteByClientTempId(chatStore, normalized);
  if (!located) return null;
  const rows = Array.isArray(chatStore.messages[located.key]) ? chatStore.messages[located.key] : [];
  const current = rows[located.index];
  if (!current) return null;
  const next = rows.slice();
  next[located.index] = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) };
  Object.assign(chatStore.messages, { [located.key]: next });
  return { routeKey: located.key, message: next[located.index] };
}

function removeOptimisticMessage(chatStore, clientTempId) {
  const normalized = normalizeClientTempId(clientTempId);
  if (!normalized || !chatStore) return null;
  const located = findRouteByClientTempId(chatStore, normalized);
  if (!located) return null;
  const rows = Array.isArray(chatStore.messages[located.key]) ? chatStore.messages[located.key] : [];
  const removed = rows[located.index];
  if (!removed) return null;
  revokeOptimisticPreviewUrl(removed);
  const next = rows.filter((_, idx) => idx !== located.index);
  Object.assign(chatStore.messages, { [located.key]: next });
  return { routeKey: located.key, message: removed };
}

function hasMessageByTxId(chatStore, routeKey, txId) {
  const normalizedTxId = String(txId || '').trim();
  if (!normalizedTxId || !chatStore) return false;
  const rows = Array.isArray(chatStore.messages && chatStore.messages[routeKey]) ? chatStore.messages[routeKey] : [];
  return rows.some((row) => extractTxIdFromUnknown(row && (row.txId || row.pinId || row.id || '')) === normalizedTxId && !isOptimisticMessage(row));
}

function resolveMessageIdentityKey(message) {
  const row = message && typeof message === 'object' ? message : {};
  const pinId = String(row.pinId || '').trim();
  const txId = extractTxIdFromUnknown(row.txId || row.txid || '');
  const id = String(row.id || '').trim();
  const txFromPin = extractTxIdFromPinLike(pinId);
  const txFromId = extractTxIdFromUnknown(id);
  const canonicalTxId = txId || txFromPin || txFromId;
  if (canonicalTxId) return `tx:${canonicalTxId}`;
  const clientTempId = getMessageClientTempId(row);
  if (clientTempId) return `local:${clientTempId}`;
  if (pinId) return `pin:${pinId}`;
  if (id) return `id:${id}`;
  return '';
}

function dedupeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const byIdentity = new Map();

  list.forEach((msg) => {
    const identity = resolveMessageIdentityKey(msg);
    const fallback = `${msg.type || ''}|${msg.fromGlobalMetaId || ''}|${msg.toGlobalMetaId || ''}|${msg.groupId || ''}|${msg.index || ''}|${msg.timestamp || ''}`;
    const key = identity || fallback;
    if (!byIdentity.has(key)) {
      byIdentity.set(key, msg);
      return;
    }
    const prev = byIdentity.get(key);
    const prevIndex = Number(prev.index || 0);
    const nextIndex = Number(msg.index || 0);
    if (nextIndex >= prevIndex) {
      byIdentity.set(key, { ...prev, ...msg });
    }
  });

  return Array.from(byIdentity.values()).sort((a, b) => {
    const ai = Number(a.index || 0);
    const bi = Number(b.index || 0);
    if (ai !== bi) return ai - bi;
    return Number(a.timestamp || 0) - Number(b.timestamp || 0);
  });
}

function resolveRealtimeIndex(currentMessages, existingConversation, incomingMessage) {
  const rows = Array.isArray(currentMessages) ? currentMessages : [];
  const fromRows = rows.reduce((max, item) => {
    const index = Number(item && item.index ? item.index : 0);
    return index > max ? index : max;
  }, 0);
  const fromConversation = Number(existingConversation && existingConversation.index ? existingConversation.index : 0);
  const base = Math.max(0, fromRows, Number.isFinite(fromConversation) ? fromConversation : 0);
  const item = incomingMessage && typeof incomingMessage === 'object' ? incomingMessage : {};
  const normalizedIncoming = Number(item.index || 0);
  const identity = resolveMessageIdentityKey(item);
  const hasDuplicate = !!identity && rows.some((row) => {
    const rowIdentity = resolveMessageIdentityKey(row);
    return !!rowIdentity && rowIdentity === identity;
  });

  if (Number.isFinite(normalizedIncoming) && normalizedIncoming > 0) {
    const flooredIncoming = Math.floor(normalizedIncoming);
    if (hasDuplicate) return flooredIncoming;
    if (flooredIncoming > base) return flooredIncoming;
    return base + 1;
  }

  return base + 1;
}

async function appendMessageToStore(chatStore, route, message, selfGlobalMetaId) {
  const key = route.key;
  const existing = chatStore.conversations[key] || {};
  const current = Array.isArray(chatStore.messages[key]) ? chatStore.messages[key] : [];
  const resolvedIndex = resolveRealtimeIndex(current, existing, message);
  const normalizedMessage = {
    ...message,
    index: resolvedIndex,
    timestamp: normalizeTimestampSeconds(message.timestamp || message.time || Date.now()),
  };
  const merged = dedupeMessages(current.concat([normalizedMessage]));
  Object.assign(chatStore.messages, { [key]: merged });

  const userStore = ensureUserStoreShape();
  const peerProfile = userStore && userStore.users ? (userStore.users[key] || {}) : {};

  const fallbackName = route.type === '1'
    ? t('chat.runtime.groupChat', 'Group Chat')
    : (key.slice(0, 12) + '...');
  const preview = await normalizeMessagePreview(normalizedMessage, selfGlobalMetaId);
  const conversation = {
    ...existing,
    metaid: key,
    conversationId: key,
    groupId: route.type === '1' ? route.groupId : null,
    participantMetaId: route.type === '2' ? key : (existing.participantMetaId || null),
    type: route.type,
    index: Number(normalizedMessage.index || existing.index || 0),
    lastMessage: preview,
    lastMessageTime: toConversationMillis(normalizedMessage.timestamp),
    unreadCount: key === chatStore.currentConversation
      ? 0
      : Number(existing.unreadCount || 0) + 1,
    name: existing.name || peerProfile.name || fallbackName,
    avatar: existing.avatar || peerProfile.avatarUrl || peerProfile.avatar || '',
  };

  Object.assign(chatStore.conversations, { [key]: conversation });

  const orderSet = new Set([...(Array.isArray(chatStore.conversationOrder) ? chatStore.conversationOrder : []), key]);
  chatStore.conversationOrder = Array.from(orderSet).sort((a, b) => {
    const ta = Number((chatStore.conversations[a] && chatStore.conversations[a].lastMessageTime) || 0);
    const tb = Number((chatStore.conversations[b] && chatStore.conversations[b].lastMessageTime) || 0);
    return tb - ta;
  });

  if (key === chatStore.currentConversation) {
    const selected = chatStore.conversations[key] || {};
    chatStore.currentConversationType = String(selected.type || route.type || chatStore.currentConversationType || '2');
    chatStore.currentConversationIndex = Number(
      normalizedMessage.index || selected.index || chatStore.currentConversationIndex || 0
    );
  }

  pushSocketTrace('append-message', {
    routeKey: key,
    routeType: String(route.type || ''),
    groupId: String(route.groupId || ''),
    channelId: String(route.channelId || ''),
    messageId: String(normalizedMessage.pinId || normalizedMessage.txId || normalizedMessage.id || ''),
    incomingIndex: Number(message && message.index ? message.index : 0),
    resolvedIndex: Number(resolvedIndex || 0),
    currentConversation: String(chatStore.currentConversation || ''),
    conversationMessageCount: Number(merged.length || 0),
    currentConversationIndex: Number(chatStore.currentConversationIndex || 0),
  });
}

function normalizeIncomingMessage(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const nestedData =
    source.data && typeof source.data === 'object'
      ? source.data
      : (source.D && typeof source.D === 'object' ? source.D : null);
  const item = nestedData || source;
  const fromUserInfo = item.fromUserInfo && typeof item.fromUserInfo === 'object' ? item.fromUserInfo : null;
  const userInfo = item.userInfo && typeof item.userInfo === 'object' ? item.userInfo : null;
  const fromGlobalMetaId = String(
    item.fromGlobalMetaId ||
    item.fromGlobalMetaID ||
    item.createGlobalMetaId ||
    item.createGlobalMetaID ||
    item.from_meta_id ||
    (fromUserInfo && (fromUserInfo.globalMetaId || fromUserInfo.globalmetaid)) ||
    (userInfo && (userInfo.globalMetaId || userInfo.globalmetaid)) ||
    item.createUserMetaId ||
    ''
  );
  const toGlobalMetaId = String(
    item.toGlobalMetaId ||
    item.toGlobalMetaID ||
    item.to_meta_id ||
    item.receiveGlobalMetaId ||
    item.receiveGlobalMetaID ||
    item.targetGlobalMetaId ||
    ''
  );

  const groupId = String(item.groupId || item.groupID || item.group_id || item.channelId || item.channelID || item.metanetId || '');
  const channelId = String(item.channelId || item.channelID || item.channel_id || '');
  const attachment = String(item.attachment || '');
  const explicitProtocol = String(item.protocol || item.protocolPath || item.path || '').trim();
  const inferredIsGroup =
    !!String(groupId || channelId || '').trim() ||
    String(item.chatType || item.type || '').trim() === '1';
  const protocol = explicitProtocol || (
    attachment.trim()
      ? (inferredIsGroup ? GROUP_FILE_PROTOCOL : PRIVATE_FILE_PROTOCOL)
      : (inferredIsGroup ? GROUP_TEXT_PROTOCOL : PRIVATE_TEXT_PROTOCOL)
  );

  const normalizedTxId = extractTxIdFromUnknown(
    item.txId ||
    item.txid ||
    item.revealTxId ||
    item.revealTxid ||
    item.revealTxIds ||
    item.txids ||
    item.txIDs ||
    item.pinId ||
    item.id
  );
  const normalizedPinId = String(item.pinId || item.pinID || item.id || '').trim();
  return {
    id: String(normalizedPinId || normalizedTxId || `${Date.now()}_${Math.random()}`),
    pinId: normalizedPinId,
    txId: normalizedTxId,
    type: String(item.chatType || item.type || item.messageType || ''),
    protocol: protocol,
    content: String(item.content || item.message || ''),
    attachment: attachment,
    contentType: String(item.contentType || item.content_type || ''),
    fileType: String(item.fileType || ''),
    timestamp: normalizeTimestampSeconds(item.timestamp || item.time || item.createTime),
    index: Number(item.index || item.messageIndex || item.msgIndex || 0),
    groupId: groupId,
    channelId: channelId,
    fromGlobalMetaId: fromGlobalMetaId,
    toGlobalMetaId: toGlobalMetaId,
    createGlobalMetaId: String(item.createGlobalMetaId || item.createGlobalMetaID || ''),
    createMetaId: String(item.createMetaId || item.createUserMetaId || ''),
    fromMetaId: String(
      item.fromMetaId ||
      (fromUserInfo && (fromUserInfo.metaid || fromUserInfo.metaId)) ||
      (userInfo && (userInfo.metaid || userInfo.metaId)) ||
      item.createMetaId ||
      item.createUserMetaId ||
      ''
    ),
    chain: normalizeChain(item.chain || item.chainName || item.network || item.blockchain),
    userInfo: item.userInfo || item.fromUserInfo || null,
    fromUserInfo: item.fromUserInfo || null,
    toUserInfo: item.toUserInfo || null,
    replyPin: String(item.replyPin || ''),
    replyInfo: item.replyInfo && typeof item.replyInfo === 'object' ? { ...item.replyInfo } : null,
    mention: Array.isArray(item.mention) ? item.mention.slice() : [],
    _raw: item,
  };
}

function resolveSendRouteFromDetail(detail) {
  const row = detail && typeof detail === 'object' ? detail : {};
  const mode = row.mode === 'private' ? 'private' : 'group';
  const payloadBody = row.body && typeof row.body === 'object' ? row.body : {};
  const groupRouteKey = String(
    row.channelId ||
    payloadBody.channelId ||
    row.groupId ||
    payloadBody.groupId ||
    ''
  ).trim();
  const groupRouteId = String(
    row.groupId ||
    payloadBody.groupId ||
    row.channelId ||
    payloadBody.channelId ||
    ''
  ).trim();
  if (mode === 'group') {
    return {
      key: groupRouteKey,
      groupId: groupRouteId || groupRouteKey,
      type: '1',
      channelId: String(row.channelId || payloadBody.channelId || '').trim(),
    };
  }
  return {
    key: String(row.toMetaId || row.to || payloadBody.to || '').trim(),
    groupId: '',
    type: '2',
    channelId: '',
  };
}

function resolveSendProtocol(detail, mode) {
  const row = detail && typeof detail === 'object' ? detail : {};
  const payloadBody = row.body && typeof row.body === 'object' ? row.body : {};
  const explicit = String(row.protocolPath || payloadBody.protocol || payloadBody.path || '').trim();
  if (explicit) return explicit;
  const hasFile = !!(row.clientFile && typeof row.clientFile === 'object');
  if (hasFile) return mode === 'group' ? GROUP_FILE_PROTOCOL : PRIVATE_FILE_PROTOCOL;
  return mode === 'group' ? GROUP_TEXT_PROTOCOL : PRIVATE_TEXT_PROTOCOL;
}

function inferFileTypeFromClientFile(clientFile) {
  const file = clientFile && typeof clientFile === 'object' ? clientFile : {};
  const kind = String(file.kind || '').trim().toLowerCase();
  if (kind) return kind;
  const type = String(file.type || '').trim().toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return '';
}

function resolveOptimisticRetryPayload(detail, route, chain, feeRate) {
  const row = detail && typeof detail === 'object' ? detail : {};
  const mention = Array.isArray(row.mention) ? row.mention.slice() : [];
  const mode = row.mode === 'private' ? 'private' : 'group';
  const groupId = mode === 'group' ? String(row.groupId || route.groupId || route.key || '') : '';
  const to = mode === 'private' ? String(row.toMetaId || row.to || route.key || '') : '';
  const channelId = mode === 'group' ? String(row.channelId || route.channelId || '') : '';
  const content = String(row.content || row.clientContent || '').trim();
  const file = row.clientFile && typeof row.clientFile === 'object' ? row.clientFile.file || null : null;
  return {
    mode,
    groupId,
    to,
    channelId,
    nickName: String(row.nickName || ''),
    content,
    file,
    replyPin: String(row.replyPin || ''),
    mention,
    chain,
    feeRate,
  };
}

function buildOptimisticMessage(detail, route, walletStore, userStore) {
  const row = detail && typeof detail === 'object' ? detail : {};
  const mode = row.mode === 'private' ? 'private' : 'group';
  const clientTempId = normalizeClientTempId(row.clientTempId);
  const chain = normalizeChain(row.chain || '');
  const feeRate = Number(row.feeRate || 0) > 0 ? Number(row.feeRate || 0) : 1;
  const protocol = resolveSendProtocol(row, mode);
  const clientContent = String(row.content || row.clientContent || '');
  const clientFile = row.clientFile && typeof row.clientFile === 'object' ? row.clientFile : null;
  const fileMarker = clientFile
    ? `localfile://${clientTempId}/${encodeURIComponent(String(clientFile.name || 'file'))}`
    : '';
  return {
    id: `local:${clientTempId || `${Date.now()}_${Math.random()}`}`,
    pinId: '',
    txId: '',
    type: route.type,
    protocol,
    content: clientContent,
    attachment: fileMarker,
    contentType: String((clientFile && clientFile.type) || ''),
    fileType: inferFileTypeFromClientFile(clientFile),
    timestamp: normalizeTimestampSeconds(row.clientTimestamp || Date.now()),
    index: 0,
    groupId: route.groupId,
    channelId: String(route.channelId || ''),
    fromGlobalMetaId: String((walletStore && walletStore.globalMetaId) || ''),
    toGlobalMetaId: mode === 'private' ? route.key : '',
    chain,
    userInfo: {
      name: String((userStore && userStore.user && (userStore.user.name || userStore.user.nickname)) || ''),
      avatarImage: String((userStore && userStore.user && (userStore.user.avatarImage || userStore.user.avatarUrl || userStore.user.avatar)) || ''),
      metaid: String((userStore && userStore.user && (userStore.user.metaid || userStore.user.metaId)) || ''),
      globalMetaId: String((walletStore && walletStore.globalMetaId) || ''),
    },
    mention: Array.isArray(row.mention) ? row.mention.slice() : [],
    replyPin: String(row.replyPin || ''),
    _clientTempId: clientTempId,
    _optimistic: true,
    _sendStatus: 'pending',
    _sendError: '',
    _retryPayload: resolveOptimisticRetryPayload(row, route, chain, feeRate),
    _optimisticFilePreview: clientFile ? {
      url: String(clientFile.previewUrl || ''),
      poster: String(clientFile.poster || ''),
      kind: inferFileTypeFromClientFile(clientFile),
      name: String(clientFile.name || ''),
      size: Number(clientFile.size || 0),
      type: String(clientFile.type || ''),
    } : null,
  };
}

function isIncomingSelfMessage(message, selfGlobalMetaId) {
  const selfGlobal = toSingleLine(selfGlobalMetaId).toLowerCase();
  if (!selfGlobal) return false;
  const senderGlobal = toSingleLine(message.fromGlobalMetaId || message.createGlobalMetaId || '').toLowerCase();
  if (senderGlobal && senderGlobal === selfGlobal) return true;
  const fromUser = message.fromUserInfo && typeof message.fromUserInfo === 'object' ? message.fromUserInfo : {};
  const userInfo = message.userInfo && typeof message.userInfo === 'object' ? message.userInfo : {};
  const nested = toSingleLine(
    fromUser.globalMetaId ||
    fromUser.globalmetaid ||
    userInfo.globalMetaId ||
    userInfo.globalmetaid ||
    ''
  ).toLowerCase();
  return !!nested && nested === selfGlobal;
}

function findOptimisticMatchIndex(rows, incomingMessage, selfGlobalMetaId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length || !isIncomingSelfMessage(incomingMessage, selfGlobalMetaId)) return -1;
  const incomingProtocol = resolveMessageProtocol(incomingMessage);
  const incomingContent = String(incomingMessage.content || '').trim();
  const incomingAttachment = String(incomingMessage.attachment || '').trim();
  const incomingTs = normalizeTimestampSeconds(incomingMessage.timestamp || incomingMessage.time || Date.now());
  let bestIndex = -1;
  let bestDelta = Number.MAX_SAFE_INTEGER;
  list.forEach((row, index) => {
    if (!isOptimisticMessage(row)) return;
    if (String(row._sendStatus || '') === 'failed') return;
    if (resolveMessageProtocol(row) !== incomingProtocol) return;
    if (String(row.content || '').trim() !== incomingContent) return;
    const rowAttachment = String(row.attachment || '').trim();
    if (rowAttachment && !/^localfile:\/\//i.test(rowAttachment) && rowAttachment !== incomingAttachment) return;
    const rowTs = normalizeTimestampSeconds(row.timestamp || 0);
    const delta = Math.abs(incomingTs - rowTs);
    if (delta > 180) return;
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function removeOptimisticByIndex(chatStore, routeKey, index) {
  const rows = Array.isArray(chatStore.messages && chatStore.messages[routeKey]) ? chatStore.messages[routeKey] : [];
  if (!rows[index]) return null;
  const removed = rows[index];
  revokeOptimisticPreviewUrl(removed);
  const next = rows.filter((_, idx) => idx !== index);
  Object.assign(chatStore.messages, { [routeKey]: next });
  return removed;
}

function reconcileIncomingWithOptimistic(chatStore, route, message, selfGlobalMetaId) {
  if (!chatStore || !route || !route.key) return;
  const txId = extractTxIdFromUnknown(message.txId || message.pinId || message.id || '');
  if (txId) {
    const tempId = normalizeClientTempId(pendingTempIdByTxId.get(txId));
    if (tempId) {
      removeOptimisticMessage(chatStore, tempId);
      pendingSendContextByTempId.delete(tempId);
      pendingTempIdByTxId.delete(txId);
      return;
    }
  }
  const rows = Array.isArray(chatStore.messages[route.key]) ? chatStore.messages[route.key] : [];
  const matchedIndex = findOptimisticMatchIndex(rows, message, selfGlobalMetaId);
  if (matchedIndex < 0) return;
  const removed = removeOptimisticByIndex(chatStore, route.key, matchedIndex);
  const tempId = getMessageClientTempId(removed);
  if (tempId) pendingSendContextByTempId.delete(tempId);
}

async function handleSocketMessage(raw) {
  const chatStore = ensureChatStoreShape();
  const walletStore = getStore('wallet');
  if (!chatStore || !walletStore) return;
  const selfGlobalMetaId = String(walletStore.globalMetaId || '');

  const message = normalizeIncomingMessage(raw);
  pushSocketTrace('message-normalized', {
    rawType: typeof raw,
    messageId: String(message.pinId || message.txId || message.id || ''),
    groupId: String(message.groupId || ''),
    channelId: String(message.channelId || ''),
    fromGlobalMetaId: String(message.fromGlobalMetaId || ''),
    toGlobalMetaId: String(message.toGlobalMetaId || ''),
    index: Number(message.index || 0),
    currentConversation: String(chatStore.currentConversation || ''),
    currentConversationType: String(chatStore.currentConversationType || ''),
  });
  const inferredRoute = inferMessageRoute(message, String(walletStore.globalMetaId || ''), chatStore);
  const route = ensureStrictGroupRoute(inferredRoute, message, chatStore);
  if (!route) {
    pushSocketTrace('message-drop-no-route', {
      messageId: String(message.pinId || message.txId || message.id || ''),
      groupId: String(message.groupId || ''),
      channelId: String(message.channelId || ''),
      fromGlobalMetaId: String(message.fromGlobalMetaId || ''),
      toGlobalMetaId: String(message.toGlobalMetaId || ''),
    });
    return;
  }

  reconcileIncomingWithOptimistic(chatStore, route, message, selfGlobalMetaId);
  await appendMessageToStore(chatStore, route, message, selfGlobalMetaId);
  const txId = extractTxIdFromUnknown(message.txId || message.pinId || message.id || '');
  if (txId) {
    const tempId = normalizeClientTempId(pendingTempIdByTxId.get(txId));
    if (tempId) {
      pendingTempIdByTxId.delete(txId);
      pendingSendContextByTempId.delete(tempId);
    }
  }
  notifyChatUpdated();
  // Keep left list metadata timely without forcing active-thread backfill each packet.
  scheduleChatListRefresh(420, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
}

function pickFirstConversation(chatStore) {
  const entries = Object.entries(chatStore.conversations || {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => {
    const ta = Number(a[1].lastMessageTime || 0);
    const tb = Number(b[1].lastMessageTime || 0);
    return tb - ta;
  });
  const [key, conv] = entries[0];
  return {
    metaid: key,
    groupId: conv.groupId || null,
    type: String(conv.type || '2'),
    index: Number(conv.index || 0),
  };
}

async function refreshChatList(options = {}) {
  const walletStore = getStore('wallet');
  const chatStore = ensureChatStoreShape();
  if (!walletStore || !chatStore) return;
  if (!walletStore.isConnected || !walletStore.globalMetaId) return;
  const refreshOptions = options && typeof options === 'object' ? options : {};

  await IDFramework.dispatch('fetchChatList', refreshOptions);
  lastChatListRefreshAt = Date.now();
  notifyChatUpdated();
  if (!refreshOptions.skipConversationSync) {
    await maybeSyncCurrentConversationAfterListRefresh(refreshOptions.background ? 'background' : 'foreground');
  }

  if (!chatStore.currentConversation) {
    const first = pickFirstConversation(chatStore);
    if (first) {
      await IDFramework.dispatch('selectConversation', first);
      notifyChatUpdated();
    }
  }
}

function bindSocketForCurrentWallet(options = {}) {
  const walletStore = getStore('wallet');
  const appStore = getStore('app');
  if (!walletStore || !walletStore.isConnected || !walletStore.globalMetaId) return;

  const targetMetaId = String(walletStore.globalMetaId || '').trim();
  const bindOptions = options && typeof options === 'object' ? options : {};
  const force = !!bindOptions.force;
  if (!targetMetaId) return;
  if (!force && targetMetaId === currentSocketMetaId && wsStore.isConnected()) return;

  lastSocketBindAt = Date.now();
  clearSocketReconnectTimer();
  currentSocketMetaId = targetMetaId;
  pushSocketTrace('socket-bind', {
    reason: String(bindOptions.reason || ''),
    force: force ? 1 : 0,
    metaid: targetMetaId,
    connectedBefore: wsStore.isConnected() ? 1 : 0,
  });
  wsStore.connect({
    metaid: targetMetaId,
    type: appStore && appStore.isWebView ? 'app' : 'pc',
    onConnect: () => {
      lastSocketConnectAt = Date.now();
      // New connection epoch: avoid treating a long-lived quiet session as stale immediately.
      if (lastSocketMessageAt < lastSocketConnectAt) {
        lastSocketMessageAt = lastSocketConnectAt;
      }
      pushSocketTrace('socket-connect', {
        metaid: targetMetaId,
        reason: String(bindOptions.reason || ''),
      });
      scheduleChatListRefresh(240, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
    },
    onDisconnect: () => {
      lastSocketDisconnectAt = Date.now();
      pushSocketTrace('socket-disconnect', {
        metaid: targetMetaId,
      });
      const activeWallet = getStore('wallet');
      const activeMetaId = String((activeWallet && activeWallet.globalMetaId) || '').trim();
      const stillConnected = !!(activeWallet && activeWallet.isConnected && activeMetaId && activeMetaId === targetMetaId);
      if (stillConnected) {
        scheduleSocketReconnect('disconnect');
      }
    },
    onMessage: (message) => {
      lastSocketMessageAt = Date.now();
      handleSocketMessage(message).catch((error) => {
        console.warn('Failed to handle incoming socket message:', error);
      });
    },
  });
}

function clearChatStateOnDisconnect() {
  const chatStore = ensureChatStoreShape();
  if (!chatStore) return;
  Object.keys(chatStore.messages || {}).forEach((key) => {
    const rows = Array.isArray(chatStore.messages[key]) ? chatStore.messages[key] : [];
    rows.forEach((row) => {
      if (isOptimisticMessage(row)) revokeOptimisticPreviewUrl(row);
    });
  });
  chatStore.conversations = {};
  chatStore.conversationOrder = [];
  chatStore.messages = {};
  chatStore.groupInfoById = {};
  chatStore.groupMembersById = {};
  chatStore.currentConversation = null;
  chatStore.currentConversationId = null;
  chatStore.currentConversationType = null;
  chatStore.currentConversationIndex = null;
  chatStore.error = null;
  notifyChatUpdated();
}

async function onConnected() {
  ensurePreviewChatStoreReady().catch(() => null);
  await refreshChatList();
  bindSocketForCurrentWallet({ reason: 'connected' });
  startSocketHealthMonitor();
  runSocketHealthCheck('connected');
}

function clearPendingTxMappingByTempId(clientTempId) {
  const normalized = normalizeClientTempId(clientTempId);
  if (!normalized) return;
  for (const [txId, tempId] of pendingTempIdByTxId.entries()) {
    if (normalizeClientTempId(tempId) === normalized) {
      pendingTempIdByTxId.delete(txId);
    }
  }
}

function resolveRetryPayloadFromStore(chatStore, clientTempId) {
  const normalized = normalizeClientTempId(clientTempId);
  if (!normalized || !chatStore) return null;
  const located = findRouteByClientTempId(chatStore, normalized);
  if (!located) return null;
  const rows = Array.isArray(chatStore.messages[located.key]) ? chatStore.messages[located.key] : [];
  const row = rows[located.index] || null;
  const payload = row && row._retryPayload && typeof row._retryPayload === 'object' ? row._retryPayload : null;
  return {
    routeKey: located.key,
    routeType: row && row.type ? String(row.type) : '',
    payload,
    row,
  };
}

async function onChatSendStart(event) {
  const detail = event && event.detail ? event.detail : {};
  const clientTempId = normalizeClientTempId(detail.clientTempId);
  const walletStore = getStore('wallet');
  const userStore = ensureUserStoreShape();
  const chatStore = ensureChatStoreShape();
  if (!clientTempId || !walletStore || !chatStore) return;
  lastOutboundSendAt = Date.now();
  runSocketHealthCheck('send-start');

  const route = resolveSendRouteFromDetail(detail);
  if (!route || !route.key) return;

  const optimisticMessage = buildOptimisticMessage(detail, route, walletStore, userStore);
  pendingSendContextByTempId.set(clientTempId, {
    routeKey: route.key,
    routeType: String(route.type || ''),
    retryPayload: optimisticMessage._retryPayload || null,
    createdAt: Date.now(),
  });

  await appendMessageToStore(chatStore, route, optimisticMessage, String(walletStore.globalMetaId || ''));
  notifyChatUpdated();
}

async function onChatSendSuccess(event) {
  const detail = event && event.detail ? event.detail : {};
  const clientTempId = normalizeClientTempId(detail.clientTempId);
  const chatStore = ensureChatStoreShape();
  if (!chatStore || !clientTempId) return;
  lastOutboundSendAt = Date.now();

  const txId = extractTxIdFromUnknown(
    detail.txid ||
    detail.txId ||
    detail.revealTxId ||
    detail.revealTxIds ||
    detail.pinRes ||
    detail.pinId
  );
  if (txId) pendingTempIdByTxId.set(txId, clientTempId);

  const normalizedChain = normalizeChain(detail.chain || '');
  const patch = {
    _sendStatus: 'pending_ack',
    _sendError: '',
  };
  if (normalizedChain) patch.chain = normalizedChain;
  if (txId) {
    patch.txId = txId;
    patch.pinId = `${txId}i0`;
    patch.id = `${txId}i0`;
  }
  const detailAttachment = String(
    detail.attachment ||
    (detail.body && detail.body.attachment) ||
    ''
  ).trim();
  if (detailAttachment) patch.attachment = detailAttachment;

  const patched = patchOptimisticMessage(chatStore, clientTempId, patch);
  if (!patched) return;

  if (txId && hasMessageByTxId(chatStore, patched.routeKey, txId)) {
    removeOptimisticMessage(chatStore, clientTempId);
    pendingSendContextByTempId.delete(clientTempId);
    pendingTempIdByTxId.delete(txId);
  } else {
    const existingCtx = pendingSendContextByTempId.get(clientTempId) || {};
    pendingSendContextByTempId.set(clientTempId, {
      ...existingCtx,
      routeKey: patched.routeKey,
      routeType: String((existingCtx && existingCtx.routeType) || ''),
      syncedAt: Date.now(),
    });
  }
  notifyChatUpdated();
  scheduleChatListRefresh(400, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
  setTimeout(() => {
    reconcilePendingAckMessages('post-send-success').catch(() => {});
    runSocketHealthCheck('post-send-success');
  }, PENDING_ACK_REPAIR_AFTER_MS + 200);
}

async function onChatSendFailed(event) {
  const detail = event && event.detail ? event.detail : {};
  const clientTempId = normalizeClientTempId(detail.clientTempId);
  const chatStore = ensureChatStoreShape();
  if (!chatStore || !clientTempId) return;

  const failedMessage = String(detail.errorMessage || '').trim() || t('chat.input.sendFailed', 'Failed to send');
  const patched = patchOptimisticMessage(chatStore, clientTempId, {
    _sendStatus: 'failed',
    _sendError: failedMessage,
  });

  const existing = pendingSendContextByTempId.get(clientTempId) || {};
  if (!existing.retryPayload) {
    const fallbackRoute = resolveSendRouteFromDetail(detail);
    existing.retryPayload = resolveOptimisticRetryPayload(
      detail,
      fallbackRoute || { key: '', groupId: '', type: detail.mode === 'private' ? '2' : '1', channelId: '' },
      normalizeChain(detail.chain || ''),
      Number(detail.feeRate || 1)
    );
  }
  pendingSendContextByTempId.set(clientTempId, {
    ...existing,
    failedAt: Date.now(),
  });
  clearPendingTxMappingByTempId(clientTempId);
  if (patched) notifyChatUpdated();
}

async function onBubbleRetrySend(event) {
  const detail = event && event.detail ? event.detail : {};
  const clientTempId = normalizeClientTempId(detail.clientTempId);
  const chatStore = ensureChatStoreShape();
  if (!clientTempId || !chatStore || !window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;

  const fromStore = resolveRetryPayloadFromStore(chatStore, clientTempId);
  const fromContext = pendingSendContextByTempId.get(clientTempId) || {};
  const retryPayload = fromStore && fromStore.payload ? fromStore.payload : (fromContext.retryPayload || null);
  if (!retryPayload) return;

  patchOptimisticMessage(chatStore, clientTempId, {
    _sendStatus: 'pending',
    _sendError: '',
  });
  notifyChatUpdated();

  try {
    const res = await window.IDFramework.dispatch('sendChatMessage', retryPayload);
    await onChatSendSuccess({
      detail: {
        ...(res || {}),
        clientTempId: clientTempId,
        mode: retryPayload.mode || 'group',
        groupId: retryPayload.groupId || '',
        toMetaId: retryPayload.to || '',
        channelId: retryPayload.channelId || '',
        mention: Array.isArray(retryPayload.mention) ? retryPayload.mention.slice() : [],
        replyPin: String(retryPayload.replyPin || ''),
        chain: String((res && res.chain) || retryPayload.chain || 'mvc'),
        feeRate: Number((res && res.feeRate) || retryPayload.feeRate || 1),
      },
    });
  } catch (error) {
    await onChatSendFailed({
      detail: {
        clientTempId,
        errorMessage: error && error.message ? String(error.message) : t('chat.input.sendFailed', 'Failed to send'),
      },
    });
    if (!(error && error._alreadyShown) && window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage('error', error && error.message ? error.message : t('chat.input.sendFailed', 'Failed to send'));
    }
  }
}

async function onChatSentLegacy(event) {
  const detail = event && event.detail ? event.detail : {};
  const walletStore = getStore('wallet');
  const userStore = ensureUserStoreShape();
  const chatStore = ensureChatStoreShape();
  if (!chatStore || !walletStore) return;

  const mode = detail.mode === 'private' ? 'private' : 'group';
  const payloadBody = detail.body && typeof detail.body === 'object' ? detail.body : {};
  const groupRouteKey = String(payloadBody.channelId || payloadBody.groupId || '');
  const groupRouteId = String(payloadBody.groupId || payloadBody.channelId || '');
  const route = mode === 'group'
    ? { key: groupRouteKey, groupId: groupRouteId, type: '1' }
    : { key: String(payloadBody.to || ''), groupId: '', type: '2' };

  if (!route.key) return;

  const currentMessages = Array.isArray(chatStore.messages[route.key]) ? chatStore.messages[route.key] : [];
  const maxIndex = currentMessages.reduce((max, item) => {
    const idx = Number(item && item.index ? item.index : 0);
    return idx > max ? idx : max;
  }, 0);

  const resolvedTxId = extractTxIdFromUnknown(
    detail.txid ||
    detail.txId ||
    detail.revealTxId ||
    detail.revealTxIds ||
    detail.pinRes ||
    detail.pinId
  );
  const localMessage = {
    id: String(resolvedTxId || `${Date.now()}_${Math.random()}`),
    pinId: String(resolvedTxId ? `${resolvedTxId}i0` : ''),
    txId: String(resolvedTxId || ''),
    type: route.type,
    protocol: String(detail.protocolPath || payloadBody.protocol || payloadBody.path || '').trim() || (
      (String(detail.attachment || payloadBody.attachment || '').trim() !== '')
        ? (mode === 'group' ? GROUP_FILE_PROTOCOL : PRIVATE_FILE_PROTOCOL)
        : (mode === 'group' ? GROUP_TEXT_PROTOCOL : PRIVATE_TEXT_PROTOCOL)
    ),
    content: String(detail.clientContent || ''),
    attachment: String(detail.attachment || payloadBody.attachment || ''),
    contentType: String(payloadBody.contentType || ''),
    fileType: String(payloadBody.fileType || ''),
    timestamp: normalizeTimestampSeconds(detail.clientTimestamp || payloadBody.timestamp || Date.now()),
    index: maxIndex + 1,
    groupId: route.groupId,
    channelId: String(payloadBody.channelId || ''),
    fromGlobalMetaId: String(walletStore.globalMetaId || ''),
    toGlobalMetaId: mode === 'private' ? route.key : '',
    chain: normalizeChain(detail.chain || payloadBody.chain || ''),
    userInfo: {
      name: String((userStore && userStore.user && (userStore.user.name || userStore.user.nickname)) || ''),
      avatarImage: String((userStore && userStore.user && (userStore.user.avatarImage || userStore.user.avatarUrl || userStore.user.avatar)) || ''),
      metaid: String((userStore && userStore.user && (userStore.user.metaid || userStore.user.metaId)) || ''),
      globalMetaId: String(walletStore.globalMetaId || ''),
    },
    mention: Array.isArray(payloadBody.mention) ? payloadBody.mention.slice() : [],
    replyPin: String(payloadBody.replyPin || ''),
  };

  await appendMessageToStore(chatStore, route, localMessage, String(walletStore.globalMetaId || ''));
  notifyChatUpdated();
  scheduleChatListRefresh(700, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
}

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (typeof Alpine !== 'undefined' && typeof IDFramework !== 'undefined') return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function loadChatComponent(path) {
  try {
    await IDFramework.loadComponent(path);
  } catch (error) {
    console.error(`Failed to load component: ${path}`, error);
  }
}

async function registerComponents() {
  await Promise.all(CHAT_COMPONENTS.map((path) => loadChatComponent(path)));
  setTimeout(() => {
    Promise.all(DEFERRED_CHAT_COMPONENTS.map((path) => loadChatComponent(path))).catch(() => {});
  }, 0);
}

function registerCommands() {
  const withVersion = (path) => `${path}?v=${CHAT_COMMAND_VERSION}`;
  IDFramework.IDController.register('selectConversation', withVersion('@idf/commands/SelectConversationCommand.js'));
  IDFramework.IDController.register('fetchChatList', withVersion('@idf/commands/FetchChatListCommand.js'));
  IDFramework.IDController.register('fetchGroupMessages', withVersion('@idf/commands/FetchGroupMessagesCommand.js'));
  IDFramework.IDController.register('fetchPrivateMessages', withVersion('@idf/commands/FetchPrivateMessagesCommand.js'));
  IDFramework.IDController.register('fetchChatGroupInfo', withVersion('@idf/commands/FetchChatGroupInfoCommand.js'));
  IDFramework.IDController.register('fetchChatGroupMembers', withVersion('@idf/commands/FetchChatGroupMembersCommand.js'));
  IDFramework.IDController.register('fetchConversations', withVersion('@idf/commands/FetchConversationsCommand.js'));
  IDFramework.IDController.register('fetchUser', withVersion('@idf/commands/FetchUserCommand.js'));
  IDFramework.IDController.register('fetchUserInfo', withVersion('@idf/commands/FetchUserInfoCommand.js'));
  IDFramework.IDController.register('sendChatMessage', withVersion('@idf/commands/SendChatMessageCommand.js'));
}

async function bootstrap() {
  const ready = await waitForReady();
  if (!ready) {
    console.error('Alpine/IDFramework is not ready for chat bootstrap');
    return;
  }

  IDFramework.init();
  initChatI18n();
  ensureUserStoreShape();
  ensureChatStoreShape();
  enforceChatChainFeeDefaults();

  registerCommands();
  registerComponents().catch((error) => {
    console.error('Failed to register chat components:', error);
  });

  document.addEventListener('connected', () => {
    setTimeout(() => {
      onConnected().catch((error) => {
        console.error('Failed to initialize chat after connection:', error);
      });
    }, 500);
  });

  document.addEventListener('account-changed', () => {
    previewChatStore = null;
    previewChatStorePromise = null;
    setTimeout(() => {
      onConnected().catch((error) => {
        console.error('Failed to refresh chat after account change:', error);
      });
    }, 300);
  });

  document.addEventListener('disconnected', () => {
    currentSocketMetaId = '';
    wsStore.disconnect();
    stopSocketHealthMonitor();
    previewChatStore = null;
    previewChatStorePromise = null;
    pendingSendContextByTempId.clear();
    pendingTempIdByTxId.clear();
    lastSocketBindAt = 0;
    lastSocketConnectAt = 0;
    lastSocketDisconnectAt = 0;
    lastSocketMessageAt = 0;
    lastOutboundSendAt = 0;
    lastChatListRefreshAt = 0;
    lastHardSocketRebindAt = 0;
    clearChatStateOnDisconnect();
  });

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      runSocketHealthCheck('visibility');
      scheduleChatListRefresh(260, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
    });
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      runSocketHealthCheck('focus');
      scheduleChatListRefresh(220, { background: true, skipConversationSync: true, minIntervalMs: 2500 });
    });
  }

  document.addEventListener('chat-send-start', (event) => {
    onChatSendStart(event).catch((error) => {
      console.warn('Failed to process chat-send-start event:', error);
    });
  });

  document.addEventListener('chat-send-success', (event) => {
    onChatSendSuccess(event).catch((error) => {
      console.warn('Failed to process chat-send-success event:', error);
    });
  });

  document.addEventListener('chat-send-failed', (event) => {
    onChatSendFailed(event).catch((error) => {
      console.warn('Failed to process chat-send-failed event:', error);
    });
  });

  document.addEventListener('bubble-retry-send', (event) => {
    onBubbleRetrySend(event).catch((error) => {
      console.warn('Failed to process bubble-retry-send event:', error);
    });
  });

  document.addEventListener('chat-sent', (event) => {
    onChatSentLegacy(event).catch((error) => {
      console.warn('Failed to process chat-sent event:', error);
    });
  });

  if (getStore('wallet') && getStore('wallet').isConnected && getStore('wallet').globalMetaId) {
    await onConnected();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  bootstrap().catch((error) => {
    console.error('Chat bootstrap failed:', error);
  });
});
