import { getWsNewStore } from '@idf/stores/chat/ws-new.js';

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

const GROUP_COMPONENTS = [
  '@idf/components/id-connect-button.js?v=20260322-m4i',
  '@idf/components/id-avatar.js?v=20260322-m4i',
  '@idf/components/id-chat-groupmsg-list.js?v=20260324-scrollfix1',
  '@idf/components/id-chat-bubble.js?v=20260323-opt1',
  '@idf/components/id-chat-msg-bubble.js?v=20260322-m4i',
  '@idf/components/id-chain-fee-selector.js?v=20260322-m4i',
  '@idf/components/id-chat-input-box.js?v=20260323-opt1',
];

const GROUP_COMMAND_VERSION = '20260324-g1';
const GROUP_PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 15000;
const SOCKET_RECONNECT_DELAY_MS = 1500;
const PROBE_CACHE_TTL_MS = 60000;

const wsStore = getWsNewStore();
let currentSocketMetaId = '';
let socketReconnectTimer = null;
let pollTimer = null;
let incrementalInFlight = false;
let initialLoadDone = false;
let latestIndexHint = 0;
let latestIndexHintAt = 0;

function getStore(name) {
  if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
  return Alpine.store(name) || null;
}

function notifyChatUpdated() {
  if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
  document.dispatchEvent(new CustomEvent('id:chat:updated'));
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

function ensureGroupChatStoreShape() {
  const groupStore = getStore('groupchat');
  if (!groupStore) return null;
  if (groupStore.groupId === undefined) groupStore.groupId = '';
  if (groupStore.title === undefined) groupStore.title = '';
  if (groupStore.error === undefined) groupStore.error = '';
  if (groupStore.isLoading === undefined) groupStore.isLoading = true;
  if (groupStore.isReady === undefined) groupStore.isReady = false;
  if (groupStore.isReadonly === undefined) groupStore.isReadonly = true;
  return groupStore;
}

function normalizeChain(rawChain) {
  const raw = String(rawChain || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'bsv' || raw === 'btc') return 'btc';
  if (raw === 'dogecoin' || raw === 'doge') return 'doge';
  if (raw === 'microvisionchain' || raw === 'mvc') return 'mvc';
  return raw;
}

function normalizeTimestampSeconds(raw) {
  const num = Number(raw || 0);
  if (!Number.isFinite(num) || num <= 0) return Math.floor(Date.now() / 1000);
  if (num > 1000000000000) return Math.floor(num / 1000);
  return Math.floor(num);
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

function buildConversationTitle(groupId, preferred) {
  const name = String(preferred || '').trim();
  if (name) return name;
  const raw = String(groupId || '').trim();
  if (!raw) return 'Group Chat';
  if (raw.length <= 20) return raw;
  return `${raw.slice(0, 12)}...${raw.slice(-6)}`;
}

function enforceChatChainFeeDefaults() {
  const chainFeeStore = getStore('chainFee');
  if (!chainFeeStore || typeof chainFeeStore !== 'object') return;

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

function withVersion(path) {
  return `${path}?v=${GROUP_COMMAND_VERSION}`;
}

function registerCommands() {
  IDFramework.IDController.register('fetchGroupMessages', withVersion('@idf/commands/FetchGroupMessagesCommand.js'));
  IDFramework.IDController.register('fetchChatGroupInfo', withVersion('@idf/commands/FetchChatGroupInfoCommand.js'));
  IDFramework.IDController.register('sendChatMessage', withVersion('@idf/commands/SendChatMessageCommand.js'));
  IDFramework.IDController.register('fetchUser', withVersion('@idf/commands/FetchUserCommand.js'));
}

async function loadComponent(path) {
  try {
    await IDFramework.loadComponent(path);
  } catch (error) {
    console.error(`Failed to load component: ${path}`, error);
  }
}

async function registerComponents() {
  await Promise.all(GROUP_COMPONENTS.map((path) => loadComponent(path)));
}

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 12000) {
    if (typeof Alpine !== 'undefined' && typeof IDFramework !== 'undefined') return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function readGroupIdFromQuery() {
  if (typeof window === 'undefined' || !window.location) return '';
  const query = new URLSearchParams(window.location.search || '');
  return String(query.get('groupId') || '').trim();
}

function isValidGroupId(groupId) {
  const raw = String(groupId || '').trim();
  return /^[a-fA-F0-9]{64}i\d+$/.test(raw);
}

function setGroupError(message) {
  const groupStore = ensureGroupChatStoreShape();
  if (!groupStore) return;
  groupStore.error = String(message || 'Unknown error');
  groupStore.isLoading = false;
  groupStore.isReady = false;
}

function setGroupLoading(loading) {
  const groupStore = ensureGroupChatStoreShape();
  if (!groupStore) return;
  groupStore.isLoading = !!loading;
}

function getCurrentGroupId() {
  const groupStore = ensureGroupChatStoreShape();
  return String((groupStore && groupStore.groupId) || '').trim();
}

function getLocalMaxMessageIndex(groupId) {
  const chatStore = ensureChatStoreShape();
  if (!chatStore) return 0;
  const rows = Array.isArray(chatStore.messages[groupId]) ? chatStore.messages[groupId] : [];
  return rows.reduce((max, row) => {
    const idx = Number(row && row.index ? row.index : 0);
    return idx > max ? idx : max;
  }, 0);
}

function resolveMessageIdentityKey(message) {
  const row = message && typeof message === 'object' ? message : {};
  const pinId = String(row.pinId || '').trim();
  const txId = extractTxIdFromUnknown(row.txId || row.txid || '');
  const id = String(row.id || '').trim();
  if (pinId) return `pin:${pinId}`;
  if (txId) return `tx:${txId}`;
  if (id) return `id:${id}`;
  return [
    'fallback',
    String(row.groupId || ''),
    String(row.fromGlobalMetaId || ''),
    String(row.index || ''),
    String(row.timestamp || ''),
    String(row.protocol || ''),
  ].join('|');
}

function mergeMessages(existing, incoming) {
  const merged = [];
  const byKey = new Map();
  const visit = (message) => {
    const key = resolveMessageIdentityKey(message);
    if (!byKey.has(key)) {
      byKey.set(key, message);
      merged.push(message);
      return;
    }
    const prev = byKey.get(key);
    const next = { ...prev, ...message };
    byKey.set(key, next);
    const idx = merged.findIndex((item) => resolveMessageIdentityKey(item) === key);
    if (idx >= 0) merged[idx] = next;
  };
  (Array.isArray(existing) ? existing : []).forEach(visit);
  (Array.isArray(incoming) ? incoming : []).forEach(visit);
  merged.sort((a, b) => {
    const ai = Number(a.index || 0);
    const bi = Number(b.index || 0);
    if (ai !== bi) return ai - bi;
    return Number(a.timestamp || 0) - Number(b.timestamp || 0);
  });
  return merged;
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

  const groupId = String(item.groupId || item.groupID || item.metanetId || item.channelId || item.channelID || '').trim();
  const channelId = String(item.channelId || item.channelID || '').trim();
  const attachment = String(item.attachment || '').trim();
  const explicitProtocol = String(item.protocol || item.protocolPath || item.path || '').trim();
  const protocol = explicitProtocol || (
    attachment ? '/protocols/simplefilegroupchat' : '/protocols/simplegroupchat'
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
    type: '1',
    protocol: protocol,
    content: String(item.content || item.message || ''),
    attachment: attachment,
    contentType: String(item.contentType || item.content_type || ''),
    fileType: String(item.fileType || ''),
    timestamp: normalizeTimestampSeconds(item.timestamp || item.time || item.createTime),
    index: Number(item.index || item.messageIndex || item.msgIndex || 0),
    groupId: groupId,
    channelId: channelId,
    fromGlobalMetaId: String(
      item.fromGlobalMetaId ||
      item.fromGlobalMetaID ||
      item.createGlobalMetaId ||
      item.createGlobalMetaID ||
      (fromUserInfo && (fromUserInfo.globalMetaId || fromUserInfo.globalmetaid)) ||
      (userInfo && (userInfo.globalMetaId || userInfo.globalmetaid)) ||
      ''
    ),
    toGlobalMetaId: String(
      item.toGlobalMetaId ||
      item.toGlobalMetaID ||
      item.receiveGlobalMetaId ||
      item.receiveGlobalMetaID ||
      item.targetGlobalMetaId ||
      ''
    ),
    createGlobalMetaId: String(item.createGlobalMetaId || item.createGlobalMetaID || ''),
    createMetaId: String(item.createMetaId || item.createUserMetaId || ''),
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

function messageBelongsToGroup(message, groupId) {
  const target = String(groupId || '').trim();
  if (!target) return false;
  const row = message && typeof message === 'object' ? message : {};
  const msgGroup = String(row.groupId || '').trim();
  const msgChannel = String(row.channelId || '').trim();
  if (msgGroup && msgGroup === target) return true;
  if (msgChannel && msgChannel === target) return true;
  return false;
}

function resolvePreviewText(message) {
  const row = message && typeof message === 'object' ? message : {};
  const attachment = String(row.attachment || '').trim();
  const content = String(row.content || '').trim();
  if (content) return content.length > 80 ? `${content.slice(0, 80)}...` : content;
  if (attachment) return '[File]';
  return 'New message';
}

function updateConversationFromMessages(groupId) {
  const chatStore = ensureChatStoreShape();
  if (!chatStore) return;
  const rows = Array.isArray(chatStore.messages[groupId]) ? chatStore.messages[groupId] : [];
  const maxIndex = getLocalMaxMessageIndex(groupId);
  const lastMessage = rows.length ? rows[rows.length - 1] : null;
  const previous = chatStore.conversations[groupId] || {};
  const timestampSeconds = Number(lastMessage && lastMessage.timestamp ? lastMessage.timestamp : 0);
  const millis = timestampSeconds > 0
    ? (timestampSeconds > 1000000000000 ? timestampSeconds : timestampSeconds * 1000)
    : Number(previous.lastMessageTime || 0);
  chatStore.conversations[groupId] = {
    ...previous,
    metaid: groupId,
    conversationId: groupId,
    groupId: groupId,
    type: '1',
    index: maxIndex || Number(previous.index || 0),
    lastMessage: lastMessage ? resolvePreviewText(lastMessage) : String(previous.lastMessage || ''),
    lastMessageTime: millis,
  };
  chatStore.currentConversationIndex = Number(chatStore.conversations[groupId].index || 0);
  chatStore.conversationOrder = [groupId];
}

function appendRealtimeMessageToStore(groupId, rawMessage) {
  const chatStore = ensureChatStoreShape();
  if (!chatStore) return;
  const normalized = normalizeIncomingMessage(rawMessage);
  if (!messageBelongsToGroup(normalized, groupId)) return;
  const current = Array.isArray(chatStore.messages[groupId]) ? chatStore.messages[groupId] : [];
  if (!normalized.index || normalized.index <= 0) {
    normalized.index = getLocalMaxMessageIndex(groupId) + 1;
  }
  const merged = mergeMessages(current, [normalized]);
  chatStore.messages[groupId] = merged;
  updateConversationFromMessages(groupId);
  latestIndexHint = Math.max(latestIndexHint, getLocalMaxMessageIndex(groupId));
  latestIndexHintAt = Date.now();
  notifyChatUpdated();
}

function resolveApiBase() {
  const locator = (typeof window !== 'undefined' && window.ServiceLocator)
    ? window.ServiceLocator
    : {};
  return String(locator.idchat || 'https://api.idchat.io/chat-api/group-chat').replace(/\/+$/, '');
}

async function fetchGroupMessagesRaw(groupId, startIndex, size) {
  const query = new URLSearchParams({
    groupId: String(groupId || ''),
    startIndex: String(Math.max(0, Number(startIndex || 0))),
    size: String(Math.max(1, Number(size || 1))),
  }).toString();
  const response = await fetch(`${resolveApiBase()}/group-chat-list-by-index?${query}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error(`group-chat-list-by-index failed: ${response.status}`);
  const raw = await response.json();
  const data = raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object'
    ? raw.data
    : {};
  return {
    list: Array.isArray(data.list) ? data.list : [],
    total: Number(data.total || 0),
    lastIndex: Number(data.lastIndex || 0),
  };
}

async function hasMessagesFromIndex(groupId, startIndex) {
  const result = await fetchGroupMessagesRaw(groupId, startIndex, 1);
  return Array.isArray(result.list) && result.list.length > 0;
}

async function probeLatestMessageIndex(groupId) {
  const now = Date.now();
  if (latestIndexHint > 0 && (now - latestIndexHintAt) < PROBE_CACHE_TTL_MS) {
    return latestIndexHint;
  }
  const hasFirst = await hasMessagesFromIndex(groupId, 1);
  if (!hasFirst) {
    latestIndexHint = 0;
    latestIndexHintAt = now;
    return 0;
  }

  let low = 1;
  let high = 1;
  const maxBound = 1 << 24;
  while (high < maxBound) {
    const exists = await hasMessagesFromIndex(groupId, high);
    if (!exists) break;
    low = high;
    high *= 2;
  }

  if (high >= maxBound) {
    latestIndexHint = low;
    latestIndexHintAt = Date.now();
    return low;
  }

  let left = low + 1;
  let right = high - 1;
  let best = low;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const exists = await hasMessagesFromIndex(groupId, mid);
    if (exists) {
      best = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  latestIndexHint = best;
  latestIndexHintAt = Date.now();
  return best;
}

function initializeSingleConversation(groupId) {
  const chatStore = ensureChatStoreShape();
  const groupStore = ensureGroupChatStoreShape();
  if (!chatStore || !groupStore) return;

  const existing = chatStore.conversations[groupId] || {};
  chatStore.currentConversation = groupId;
  chatStore.currentConversationId = groupId;
  chatStore.currentConversationType = '1';
  chatStore.currentConversationIndex = Number(existing.index || 0);
  chatStore.useCommandMessageFetch = true;
  chatStore.error = null;
  chatStore.conversations = {
    [groupId]: {
      ...existing,
      metaid: groupId,
      conversationId: groupId,
      groupId: groupId,
      type: '1',
      index: Number(existing.index || 0),
      unreadCount: 0,
      name: buildConversationTitle(groupId, existing.name),
      avatar: String(existing.avatar || ''),
      lastMessage: String(existing.lastMessage || ''),
      lastMessageTime: Number(existing.lastMessageTime || 0),
    },
  };
  if (!Array.isArray(chatStore.messages[groupId])) {
    chatStore.messages[groupId] = [];
  }
  chatStore.conversationOrder = [groupId];
  groupStore.groupId = groupId;
  groupStore.title = buildConversationTitle(groupId, existing.name);
  groupStore.error = '';
  groupStore.isLoading = true;
  groupStore.isReady = false;
  notifyChatUpdated();
}

async function fetchGroupInfoAndApply(groupId) {
  try {
    await IDFramework.dispatch('fetchChatGroupInfo', { groupId });
    const chatStore = ensureChatStoreShape();
    const groupStore = ensureGroupChatStoreShape();
    if (!chatStore || !groupStore) return;
    const info = chatStore.groupInfoById && chatStore.groupInfoById[groupId]
      ? chatStore.groupInfoById[groupId]
      : null;
    if (!info || typeof info !== 'object') return;
    const nextName = buildConversationTitle(groupId, info.roomName || info.name);
    const avatar = String(info.roomAvatarUrl || info.roomIcon || '');
    const existing = chatStore.conversations[groupId] || {};
    chatStore.conversations[groupId] = {
      ...existing,
      name: nextName,
      avatar: avatar || existing.avatar || '',
      groupId: groupId,
      type: '1',
    };
    groupStore.title = nextName;
    notifyChatUpdated();
  } catch (_) {}
}

async function loadInitialMessages(groupId) {
  const chatStore = ensureChatStoreShape();
  const groupStore = ensureGroupChatStoreShape();
  if (!chatStore || !groupStore) return;
  setGroupLoading(true);
  chatStore.isLoading = true;
  chatStore.error = null;
  notifyChatUpdated();
  try {
    const latest = await probeLatestMessageIndex(groupId);
    latestIndexHint = Math.max(0, Number(latest || 0));
    latestIndexHintAt = Date.now();
    const startIndex = latestIndexHint > 0
      ? Math.max(1, latestIndexHint - (GROUP_PAGE_SIZE - 1))
      : 1;
    await IDFramework.dispatch('fetchGroupMessages', {
      groupId,
      startIndex,
      size: GROUP_PAGE_SIZE,
    });
    chatStore.isLoading = false;
    chatStore.error = null;
    groupStore.isLoading = false;
    groupStore.isReady = true;
    initialLoadDone = true;
    updateConversationFromMessages(groupId);
    latestIndexHint = Math.max(latestIndexHint, getLocalMaxMessageIndex(groupId));
    latestIndexHintAt = Date.now();
    notifyChatUpdated();
  } catch (error) {
    chatStore.isLoading = false;
    chatStore.error = error && error.message ? String(error.message) : 'Failed to load group messages';
    setGroupError(chatStore.error);
    notifyChatUpdated();
  }
}

async function fetchIncrementalMessages(reason = 'poll') {
  if (incrementalInFlight || !initialLoadDone) return;
  const groupId = getCurrentGroupId();
  if (!groupId) return;
  const groupStore = ensureGroupChatStoreShape();
  if (groupStore && groupStore.error) return;
  incrementalInFlight = true;
  try {
    const localMax = getLocalMaxMessageIndex(groupId);
    const startIndex = localMax > 0 ? (localMax + 1) : 1;
    await IDFramework.dispatch('fetchGroupMessages', {
      groupId,
      startIndex,
      size: GROUP_PAGE_SIZE,
      mergeMode: 'prepend',
    });
    updateConversationFromMessages(groupId);
    latestIndexHint = Math.max(latestIndexHint, getLocalMaxMessageIndex(groupId));
    latestIndexHintAt = Date.now();
    notifyChatUpdated();
  } catch (error) {
    console.warn(`groupchat incremental fetch failed (${reason}):`, error);
  } finally {
    incrementalInFlight = false;
  }
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    fetchIncrementalMessages('poll').catch(() => {});
  }, POLL_INTERVAL_MS);
}

function clearSocketReconnectTimer() {
  if (!socketReconnectTimer) return;
  clearTimeout(socketReconnectTimer);
  socketReconnectTimer = null;
}

function disconnectSocket() {
  clearSocketReconnectTimer();
  currentSocketMetaId = '';
  wsStore.disconnect();
}

function scheduleSocketReconnect() {
  clearSocketReconnectTimer();
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    bindSocketForCurrentWallet({ force: true });
  }, SOCKET_RECONNECT_DELAY_MS);
}

function bindSocketForCurrentWallet(options = {}) {
  const walletStore = getStore('wallet');
  const appStore = getStore('app');
  if (!walletStore || !walletStore.isConnected || !walletStore.globalMetaId) return;

  const targetMetaId = String(walletStore.globalMetaId || '').trim();
  if (!targetMetaId) return;
  const force = !!(options && options.force);
  if (!force && targetMetaId === currentSocketMetaId && wsStore.isConnected()) return;

  currentSocketMetaId = targetMetaId;
  clearSocketReconnectTimer();
  wsStore.connect({
    metaid: targetMetaId,
    type: appStore && appStore.isWebView ? 'app' : 'pc',
    onConnect: () => {},
    onDisconnect: () => {
      const activeWallet = getStore('wallet');
      const activeMetaId = String((activeWallet && activeWallet.globalMetaId) || '').trim();
      const stillConnected = !!(activeWallet && activeWallet.isConnected && activeMetaId && activeMetaId === targetMetaId);
      if (stillConnected) scheduleSocketReconnect();
    },
    onMessage: (message) => {
      const groupId = getCurrentGroupId();
      if (!groupId) return;
      appendRealtimeMessageToStore(groupId, message);
    },
  });
}

function syncReadOnlyState() {
  const groupStore = ensureGroupChatStoreShape();
  const walletStore = getStore('wallet');
  if (!groupStore) return;
  groupStore.isReadonly = !(walletStore && walletStore.isConnected && walletStore.globalMetaId);
}

function handleSessionChange() {
  syncReadOnlyState();
  const walletStore = getStore('wallet');
  if (walletStore && walletStore.isConnected && walletStore.globalMetaId) {
    bindSocketForCurrentWallet({ force: true });
    return;
  }
  disconnectSocket();
}

function bindWindowEvents() {
  document.addEventListener('connected', () => {
    setTimeout(() => {
      handleSessionChange();
      fetchIncrementalMessages('connected').catch(() => {});
    }, 300);
  });

  document.addEventListener('account-changed', () => {
    setTimeout(() => {
      handleSessionChange();
      fetchIncrementalMessages('account-changed').catch(() => {});
    }, 300);
  });

  document.addEventListener('disconnected', () => {
    handleSessionChange();
  });

  document.addEventListener('chat-send-success', () => {
    fetchIncrementalMessages('send-success').catch(() => {});
    setTimeout(() => {
      fetchIncrementalMessages('send-success-delay').catch(() => {});
    }, 1200);
  });

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      fetchIncrementalMessages('visibility').catch(() => {});
    });
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => {
      fetchIncrementalMessages('focus').catch(() => {});
    });
    window.addEventListener('beforeunload', () => {
      stopPolling();
      disconnectSocket();
    });
  }
}

function applyMissingGroupIdError() {
  setGroupError('缺少 groupId 参数，请使用 ?groupId=<群聊ID>');
  const groupStore = ensureGroupChatStoreShape();
  if (groupStore) {
    groupStore.title = 'Group Chat';
    groupStore.groupId = '';
  }
}

function applyInvalidGroupIdError(groupId) {
  setGroupError(`groupId 格式无效: ${String(groupId || '')}`);
  const groupStore = ensureGroupChatStoreShape();
  if (groupStore) {
    groupStore.title = 'Group Chat';
    groupStore.groupId = '';
  }
}

async function bootstrap() {
  const ready = await waitForReady();
  if (!ready) {
    console.error('Alpine/IDFramework is not ready for groupchat bootstrap');
    return;
  }

  IDFramework.init();
  ensureUserStoreShape();
  ensureChatStoreShape();
  ensureGroupChatStoreShape();
  enforceChatChainFeeDefaults();

  registerCommands();
  await registerComponents();

  const groupId = readGroupIdFromQuery();
  if (!groupId) {
    applyMissingGroupIdError();
    return;
  }
  if (!isValidGroupId(groupId)) {
    applyInvalidGroupIdError(groupId);
    return;
  }

  initializeSingleConversation(groupId);
  bindWindowEvents();
  handleSessionChange();
  await Promise.all([
    fetchGroupInfoAndApply(groupId),
    loadInitialMessages(groupId),
  ]);
  startPolling();
}

bootstrap().catch((error) => {
  console.error('Failed to bootstrap group chat page:', error);
  setGroupError(error && error.message ? String(error.message) : 'Group chat bootstrap failed');
});
