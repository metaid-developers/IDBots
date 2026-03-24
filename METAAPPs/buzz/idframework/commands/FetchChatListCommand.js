const CHAT_LIST_RUN_BY_STORE = new WeakMap();
let CHAT_LIST_RUN_SEQ = 0;
const CHAT_LIST_USER_PREFETCH_AT = new Map();
const CHAT_LIST_USER_PREFETCH_COOLDOWN_MS = 120000;

/**
 * FetchChatListCommand
 * Fetches the latest chat info list from IDChat API
 * Follows IDFramework Command Pattern
 * 
 * API Endpoint: /group-chat/user/latest-chat-info-list
 * Method: GET
 * Headers: Authorization: Bearer {globalMetaId}
 */

export default class FetchChatListCommand {
  constructor() {
    this._sharedSecretCache = new Map();
  }

  _markLatestRun(chatStore) {
    if (!chatStore || (typeof chatStore !== 'object' && typeof chatStore !== 'function')) return 0;
    CHAT_LIST_RUN_SEQ += 1;
    CHAT_LIST_RUN_BY_STORE.set(chatStore, CHAT_LIST_RUN_SEQ);
    return CHAT_LIST_RUN_SEQ;
  }

  _isLatestRun(chatStore, runId) {
    if (!chatStore || !runId) return false;
    return CHAT_LIST_RUN_BY_STORE.get(chatStore) === runId;
  }

  _notifyChatUpdated() {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
    try {
      document.dispatchEvent(new CustomEvent('id:chat:updated'));
    } catch (_) {}
  }

  _toText(value) {
    return String(value || '').trim();
  }

  _extractPinId(text) {
    const raw = this._toText(text);
    if (!raw) return '';
    const match = raw.match(/([a-fA-F0-9]{64}i\d+)/);
    return match ? match[1] : '';
  }

  _looksLikeBase64Ciphertext(text) {
    const raw = this._toText(text);
    if (!raw) return false;
    if (/^U2FsdGVkX1/i.test(raw)) return true;
    if (!/^[A-Za-z0-9+/=]+$/.test(raw)) return false;
    if (raw.length < 64) return false;
    return raw.length % 4 === 0;
  }

  _isHashLikeContent(text) {
    const raw = this._toText(text);
    if (!raw) return false;
    if (/^[a-fA-F0-9]{32,}(?:i\d+)?$/.test(raw)) return true;
    if (/^metafile:\/\/[a-fA-F0-9]{64}i\d+(?:\.[a-zA-Z0-9]{1,10})?$/.test(raw)) return true;
    if (this._looksLikeBase64Ciphertext(raw)) return true;
    return false;
  }

  _toSingleLine(text) {
    const raw = this._toText(text);
    if (!raw) return '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  _formatSenderLabel(sender) {
    const text = this._toSingleLine(sender);
    if (!text) return '';
    if (text.length > 24 && /^[a-zA-Z0-9_-]+$/.test(text)) {
      return text.slice(0, 12) + '...';
    }
    return text;
  }

  _prefixWithSender(sender, previewText) {
    const message = this._toSingleLine(previewText);
    if (!message) return null;
    const senderLabel = this._formatSenderLabel(sender);
    if (!senderLabel) return message;
    if (message.startsWith(senderLabel + ':')) return message;
    return `${senderLabel}: ${message}`;
  }

  _escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _stripSenderPrefix(sender, previewText) {
    const message = this._toSingleLine(previewText);
    if (!message) return '';
    const senderLabel = this._formatSenderLabel(sender);
    if (!senderLabel) return message;
    const pattern = new RegExp(`^${this._escapeRegExp(senderLabel)}\\s*[:：]\\s*`);
    const stripped = message.replace(pattern, '').trim();
    return stripped || message;
  }

  _formatConversationPreview(chatType, previewText, sender) {
    if (previewText == null) return previewText;
    const message = this._toSingleLine(previewText);
    if (!message) return message;
    return String(chatType || '') === '1'
      ? (this._prefixWithSender(sender, message) || message)
      : this._stripSenderPrefix(sender, message);
  }

  _extractPreviewSender(chat) {
    if (!chat || typeof chat !== 'object') return '';
    const lastMessage = chat.lastMessage && typeof chat.lastMessage === 'object' ? chat.lastMessage : {};
    const legacyLastMessage = chat.last_message && typeof chat.last_message === 'object' ? chat.last_message : {};
    const userInfo = chat.userInfo && typeof chat.userInfo === 'object' ? chat.userInfo : {};
    const createUserInfo = chat.createUserInfo && typeof chat.createUserInfo === 'object' ? chat.createUserInfo : {};
    const fromUserInfo = chat.fromUserInfo && typeof chat.fromUserInfo === 'object' ? chat.fromUserInfo : {};

    const candidates = [
      lastMessage.senderName,
      lastMessage.sender,
      lastMessage.nickName,
      lastMessage.username,
      legacyLastMessage.senderName,
      legacyLastMessage.sender,
      legacyLastMessage.nickName,
      legacyLastMessage.username,
      chat.senderName,
      chat.sender,
      chat.fromName,
      chat.nickName,
      chat.userName,
      chat.channelNewestUserName,
      createUserInfo.name,
      fromUserInfo.name,
      userInfo.name,
    ];

    for (let i = 0; i < candidates.length; i += 1) {
      const value = this._toSingleLine(candidates[i]);
      if (value) return value;
    }
    return '';
  }

  _extractMessagePreview(chat) {
    if (!chat || typeof chat !== 'object') return null;

    const fromStructured = (message) => {
      if (!message) return '';
      if (typeof message === 'string') return message;
      if (typeof message !== 'object') return '';
      return String(
        message.content ||
        message.text ||
        message.message ||
        message.attachment ||
        ''
      );
    };

    const attachment = this._toText(
      chat.attachment ||
      (chat.lastMessage && chat.lastMessage.attachment) ||
      (chat.last_message && chat.last_message.attachment) ||
      ''
    );

    let preview = fromStructured(chat.lastMessage);
    if (!preview) preview = fromStructured(chat.last_message);
    if (!preview) preview = String(chat.content || '');
    preview = this._toSingleLine(preview);
    if (!preview) {
      if (attachment) return '[File]';
      return null;
    }
    if (this._isHashLikeContent(preview)) {
      if (attachment) return '[File]';
      // Avoid showing noisy placeholders like "[Encrypted]" before reliable decryption is ready.
      return null;
    }
    return preview;
  }

  _truncateIdentity(identity) {
    const raw = this._toText(identity);
    if (!raw) return '';
    if (raw.length <= 16) return raw;
    return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
  }

  _getCryptoJS() {
    if (typeof window !== 'undefined' && window.CryptoJS) return window.CryptoJS;
    if (typeof globalThis !== 'undefined' && globalThis.CryptoJS) return globalThis.CryptoJS;
    return null;
  }

  _hexToBytes(hexText) {
    const clean = String(hexText || '').replace(/[^0-9a-f]/gi, '');
    if (!clean || clean.length % 2 !== 0) return new Uint8Array(0);
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
    }
    return out;
  }

  _base64ToBytes(base64Text) {
    const raw = String(base64Text || '').trim();
    if (!raw) return new Uint8Array(0);
    try {
      if (typeof atob === 'function') {
        const binary = atob(raw);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
        return out;
      }
      if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(raw, 'base64'));
      }
    } catch (_) {}
    return new Uint8Array(0);
  }

  _getWebCryptoSubtle() {
    if (typeof crypto !== 'undefined' && crypto && crypto.subtle) return crypto.subtle;
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    return null;
  }

  async _decryptGroupText(rawContent, groupId) {
    const cipherText = this._toText(rawContent);
    if (!cipherText) return '';
    const isHex = /^[0-9a-fA-F]+$/.test(cipherText) && cipherText.length % 2 === 0;
    const isBase64 = !isHex && /^[A-Za-z0-9+/=]+$/.test(cipherText) && cipherText.length % 4 === 0;
    if (!isHex && !isBase64) return cipherText;

    const encryptedBytes = isHex ? this._hexToBytes(cipherText) : this._base64ToBytes(cipherText);
    if (!encryptedBytes.length) return cipherText;

    const keyText = String(groupId || '').slice(0, 16).padEnd(16, '0');
    const subtle = this._getWebCryptoSubtle();
    if (subtle) {
      try {
        const keyBytes = new TextEncoder().encode(keyText);
        const iv = new TextEncoder().encode('0000000000000000');
        const cryptoKey = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const decrypted = await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encryptedBytes);
        const plain = new TextDecoder().decode(decrypted).replace(/\0+$/, '').trim();
        if (plain) return plain;
      } catch (_) {}
    }

    const CryptoJS = this._getCryptoJS();
    if (CryptoJS) {
      try {
        const Utf8 = CryptoJS.enc.Utf8;
        const iv = Utf8.parse('0000000000000000');
        const messageBase64 = isHex
          ? (typeof Buffer !== 'undefined'
            ? Buffer.from(cipherText, 'hex').toString('base64')
            : btoa(String.fromCharCode.apply(null, encryptedBytes)))
          : cipherText;
        const bytes = CryptoJS.AES.decrypt(messageBase64, Utf8.parse(keyText), {
          iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7,
        });
        const plain = bytes.toString(Utf8).trim();
        if (plain) return plain;
      } catch (_) {}
    }

    return cipherText;
  }

  _privateDecrypt(cipherText, sharedSecret) {
    const raw = this._toText(cipherText);
    if (!raw) return '';
    const secret = this._toText(sharedSecret);
    if (!secret) return raw;
    const CryptoJS = this._getCryptoJS();
    if (!CryptoJS) return raw;
    try {
      const bytes = CryptoJS.AES.decrypt(raw, secret);
      const out = bytes.toString(CryptoJS.enc.Utf8);
      return out ? out : raw;
    } catch (_) {
      return raw;
    }
  }

  _chatPubKeyFromSources(raw, peerGlobalMetaId, userStore) {
    const localPeer = this._toText(peerGlobalMetaId);
    const fromRawUser = raw && raw.userInfo && typeof raw.userInfo === 'object' ? raw.userInfo : {};
    const fromRawCreate = raw && raw.createUserInfo && typeof raw.createUserInfo === 'object' ? raw.createUserInfo : {};
    const users = userStore && userStore.users && typeof userStore.users === 'object' ? userStore.users : {};
    const fromStore = localPeer ? (users[localPeer] || {}) : {};
    const candidates = [
      fromRawUser.chatPublicKey,
      fromRawUser.chatPubkey,
      fromRawCreate.chatPublicKey,
      fromRawCreate.chatPubkey,
      fromStore.chatPublicKey,
      fromStore.chatPubkey,
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const pub = this._toText(candidates[i]);
      if (pub) return pub;
    }
    return '';
  }

  async _resolveSharedSecret(peerGlobalMetaId, raw, userStore) {
    const peer = this._toText(peerGlobalMetaId);
    if (!peer) return '';
    if (this._sharedSecretCache.has(peer)) return this._sharedSecretCache.get(peer) || '';
    if (!window.metaidwallet || !window.metaidwallet.common || typeof window.metaidwallet.common.ecdh !== 'function') {
      return '';
    }

    let pubkey = this._chatPubKeyFromSources(raw, peer, userStore);
    if (!pubkey && window.IDFramework && typeof window.IDFramework.dispatch === 'function') {
      try {
        const info = await window.IDFramework.dispatch('fetchUserInfo', { globalMetaId: peer });
        pubkey = this._toText(info && (info.chatpubkey || info.chatPubkey || info.chatPublicKey));
      } catch (_) {}
    }
    if (!pubkey) return '';

    try {
      const ecdh = await window.metaidwallet.common.ecdh({ externalPubKey: pubkey });
      const secret = this._toText(ecdh && ecdh.sharedSecret);
      if (secret) this._sharedSecretCache.set(peer, secret);
      return secret;
    } catch (_) {
      return '';
    }
  }

  _resolveSenderLabel(raw, conversation, walletStore, userStore) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const viewerGlobalMetaId = this._toText(walletStore && walletStore.globalMetaId);
    const senderGlobalMetaId = this._toText(
      row.createGlobalMetaId ||
      row.fromGlobalMetaId ||
      row.senderGlobalMetaId ||
      ''
    );
    const senderMetaId = this._toText(
      row.createMetaId ||
      row.fromMetaId ||
      row.senderMetaId ||
      ''
    );
    if (viewerGlobalMetaId && senderGlobalMetaId && senderGlobalMetaId === viewerGlobalMetaId) {
      return 'You';
    }

    const users = userStore && userStore.users && typeof userStore.users === 'object' ? userStore.users : {};
    const senderFromStore = senderGlobalMetaId ? (users[senderGlobalMetaId] || {}) : {};
    const userInfo = row.userInfo && typeof row.userInfo === 'object' ? row.userInfo : {};
    const createUserInfo = row.createUserInfo && typeof row.createUserInfo === 'object' ? row.createUserInfo : {};
    const fromUserInfo = row.fromUserInfo && typeof row.fromUserInfo === 'object' ? row.fromUserInfo : {};
    const identityMatchesSender = (candidate) => {
      if (!candidate || typeof candidate !== 'object') return false;
      const globalMetaId = this._toText(candidate.globalMetaId || candidate.globalmetaid || '');
      const metaId = this._toText(candidate.metaid || candidate.metaId || '');
      if (senderGlobalMetaId && globalMetaId && senderGlobalMetaId === globalMetaId) return true;
      if (senderMetaId && metaId && senderMetaId === metaId) return true;
      if (senderGlobalMetaId && metaId && senderGlobalMetaId === metaId) return true;
      if (senderMetaId && globalMetaId && senderMetaId === globalMetaId) return true;
      return false;
    };

    const candidates = [
      senderFromStore.name,
      identityMatchesSender(createUserInfo) ? createUserInfo.name : '',
      identityMatchesSender(fromUserInfo) ? fromUserInfo.name : '',
      identityMatchesSender(userInfo) ? userInfo.name : '',
      row.senderName,
      row.fromName,
      row.channelNewestUserName,
      senderGlobalMetaId ? this._truncateIdentity(senderGlobalMetaId) : '',
      senderMetaId ? this._truncateIdentity(senderMetaId) : '',
    ];
    for (let i = 0; i < candidates.length; i += 1) {
      const text = this._toSingleLine(candidates[i]);
      if (text) return this._formatSenderLabel(text);
    }
    return '';
  }

  _extractRuntimePayload(raw) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const protocol = this._toText(row.protocol || row.roomNewestProtocol || row.path || '');
    const content = this._toText(row.content || row.roomNewestContent || '');
    const attachment = this._toText(row.attachment || '');
    const fileLike = !!attachment || /simplefile/i.test(protocol) || /^metafile:\/\//i.test(content);
    return { protocol, content, attachment, fileLike };
  }

  async _resolveRuntimePreviewForConversation(conversation, walletStore, userStore) {
    if (!conversation || typeof conversation !== 'object') return '';
    const row = conversation._raw && typeof conversation._raw === 'object' ? conversation._raw : {};
    const conversationType = String(conversation.type || '');
    const payload = this._extractRuntimePayload(row);
    const previewSender = (conversationType === '1' || conversationType === '2')
      ? (this._resolveSenderLabel(row, conversation, walletStore, userStore) || this._extractPreviewSender(row))
      : '';
    if (payload.fileLike) {
      return this._formatConversationPreview(conversationType, '[File]', previewSender);
    }

    let preview = this._toSingleLine(payload.content);
    if (!preview) return '';

    if (conversationType === '1') {
      if (this._isHashLikeContent(preview)) {
        const groupId = this._toText(conversation.groupId || row.groupId || conversation.metaid);
        preview = await this._decryptGroupText(preview, groupId);
      }
    } else if (conversationType === '2') {
      if (this._isHashLikeContent(preview)) {
        const peerGlobalMetaId = this._toText(
          row.globalMetaId ||
          (row.userInfo && row.userInfo.globalMetaId) ||
          conversation.metaid ||
          ''
        );
        const secret = await this._resolveSharedSecret(peerGlobalMetaId, row, userStore);
        preview = secret ? this._privateDecrypt(preview, secret) : preview;
      }
    }

    preview = this._toSingleLine(preview);
    if (!preview) return '';
    if (this._isHashLikeContent(preview)) return '';
    return this._formatConversationPreview(conversationType, preview, previewSender);
  }

  _sortedPreviewKeys(conversations, limit = 120) {
    if (!conversations || typeof conversations !== 'object') return [];
    return Object.keys(conversations)
      .sort((a, b) => Number(conversations[b]?.lastMessageTime || 0) - Number(conversations[a]?.lastMessageTime || 0))
      .slice(0, Math.max(0, Number(limit || 0) || 0));
  }

  async _enrichConversationPreviews(conversations, walletStore, userStore, targetKeys = null, workerCount = 10) {
    if (!conversations || typeof conversations !== 'object') return 0;
    const keys = Array.isArray(targetKeys) && targetKeys.length
      ? targetKeys.filter((key) => !!conversations[key])
      : this._sortedPreviewKeys(conversations, 120);
    if (!keys.length) return 0;

    const concurrency = Math.min(Math.max(1, Number(workerCount || 1)), keys.length);
    let cursor = 0;
    let updatedCount = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (true) {
        const position = cursor;
        cursor += 1;
        if (position >= keys.length) return;
        const key = keys[position];
        const conversation = conversations[key];
        if (!conversation || typeof conversation !== 'object') continue;
        const currentPreview = this._toSingleLine(conversation.lastMessage || '');
        if (conversation._skipRuntimePreviewHydration && currentPreview) continue;
        try {
          const preview = await this._resolveRuntimePreviewForConversation(conversation, walletStore, userStore);
          if (!preview) continue;
          const livePreview = this._toSingleLine(conversation.lastMessage || '');
          if (preview === livePreview) continue;
          conversation.lastMessage = preview;
          updatedCount += 1;
        } catch (_) {}
      }
    });
    await Promise.all(workers);
    return updatedCount;
  }

  _hydrateConversationPreviewsInBackground(conversations, walletStore, userStore, chatStore, runId) {
    if (!conversations || typeof conversations !== 'object') return;
    const keys = this._sortedPreviewKeys(conversations, 120);
    if (!keys.length) return;
    const eagerKeys = keys.slice(0, 20);
    const lazyKeys = keys.slice(20);

    Promise.resolve()
      .then(async () => {
        const eagerUpdated = await this._enrichConversationPreviews(
          conversations,
          walletStore,
          userStore,
          eagerKeys,
          8
        );
        if (!this._isLatestRun(chatStore, runId)) return;
        if (eagerUpdated > 0) this._notifyChatUpdated();
        if (!lazyKeys.length) return;

        setTimeout(() => {
          (async () => {
            for (let offset = 0; offset < lazyKeys.length; offset += 20) {
              if (!this._isLatestRun(chatStore, runId)) return;
              const batch = lazyKeys.slice(offset, offset + 20);
              const lazyUpdated = await this._enrichConversationPreviews(
                conversations,
                walletStore,
                userStore,
                batch,
                6
              );
              if (!this._isLatestRun(chatStore, runId)) return;
              if (lazyUpdated > 0) this._notifyChatUpdated();
              if (offset + 20 < lazyKeys.length) {
                await new Promise((resolve) => setTimeout(resolve, 32));
              }
            }
          })().catch((error) => {
            console.warn('FetchChatListCommand: lazy preview hydration failed:', error);
          });
        }, 16);
      })
      .catch((error) => {
        console.warn('FetchChatListCommand: preview hydration failed:', error);
      });
  }

  _normalizeTimestampMillis(raw) {
    const num = Number(raw || 0);
    if (!Number.isFinite(num) || num <= 0) return Date.now();
    if (num < 1000000000000) return Math.floor(num * 1000);
    if (num > 1000000000000000) return Math.floor(num / 1000);
    return Math.floor(num);
  }

  _normalizeConversationIndex(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  _resolveConversationIndex(chat) {
    const row = chat && typeof chat === 'object' ? chat : {};
    const lastMessage = row.lastMessage && typeof row.lastMessage === 'object' ? row.lastMessage : {};
    const legacyLastMessage = row.last_message && typeof row.last_message === 'object' ? row.last_message : {};

    const candidates = [
      row.index,
      row.latestIndex,
      row.lastIndex,
      row.messageIndex,
      row.lastMessageIndex,
      row.latestMessageIndex,
      row.roomNewestIndex,
      row.room_newest_index,
      row.channelNewestIndex,
      lastMessage.index,
      legacyLastMessage.index,
    ];

    for (let i = 0; i < candidates.length; i += 1) {
      const normalized = this._normalizeConversationIndex(candidates[i]);
      if (normalized > 0) return normalized;
    }
    return 0;
  }

  _maxMessageIndexFromRows(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return list.reduce((max, row) => {
      const index = this._normalizeConversationIndex(row && row.index);
      return index > max ? index : max;
    }, 0);
  }

  _preserveConversationIndexHints(nextConversations, previousConversations, previousMessages) {
    const next = nextConversations && typeof nextConversations === 'object' ? nextConversations : {};
    const prev = previousConversations && typeof previousConversations === 'object' ? previousConversations : {};
    const prevMessages = previousMessages && typeof previousMessages === 'object' ? previousMessages : {};
    Object.keys(next).forEach((key) => {
      const row = next[key];
      if (!row || typeof row !== 'object') return;
      const prevRow = prev[key] && typeof prev[key] === 'object' ? prev[key] : null;
      const apiIndex = this._normalizeConversationIndex(row.index);
      const prevIndex = this._normalizeConversationIndex(prevRow && prevRow.index);
      const localMax = this._maxMessageIndexFromRows(prevMessages[key]);
      const resolved = Math.max(apiIndex, prevIndex, localMax);
      row.index = resolved;

      const apiPreview = this._toSingleLine(row.lastMessage || '');
      const prevPreview = this._toSingleLine(prevRow && prevRow.lastMessage ? prevRow.lastMessage : '');
      const apiTimeRaw = Number(row.lastMessageTime || 0);
      const prevTimeRaw = Number(prevRow && prevRow.lastMessageTime ? prevRow.lastMessageTime : 0);
      const apiTime = Number.isFinite(apiTimeRaw) && apiTimeRaw > 0 ? Math.floor(apiTimeRaw) : 0;
      const prevTime = Number.isFinite(prevTimeRaw) && prevTimeRaw > 0 ? Math.floor(prevTimeRaw) : 0;
      const hasLocalMessageAtResolvedIndex = resolved > 0 && localMax >= resolved;

      // If local state is newer than API row, keep local preview/time to avoid stale "previous message" in sidebar.
      if (prevRow && resolved > apiIndex) {
        if (prevPreview) {
          row.lastMessage = prevRow.lastMessage;
          row._skipRuntimePreviewHydration = true;
        }
        if (prevTime > apiTime) row.lastMessageTime = prevTime;
        return;
      }

      // Some latest-chat-info responses catch index/time up first but still ship the previous preview text.
      // When local messages already contain that same index, prefer the local preview and keep the freshest time.
      const shouldKeepLocalPreviewForSameIndex =
        !!prevRow &&
        hasLocalMessageAtResolvedIndex &&
        resolved === apiIndex &&
        !!prevPreview &&
        !!apiPreview &&
        prevPreview !== apiPreview;
      if (shouldKeepLocalPreviewForSameIndex) {
        row.lastMessage = prevRow.lastMessage;
        row.lastMessageTime = Math.max(prevTime, apiTime) || row.lastMessageTime;
        row._skipRuntimePreviewHydration = true;
        return;
      }

      // Edge case: API index catches up but preview payload is still stale for that same index.
      // If local row has at least same index and a newer timestamp, trust local preview/time.
      const shouldKeepLocalForSameOrNewerIndex =
        !!prevRow &&
        prevIndex >= apiIndex &&
        prevPreview &&
        prevTime > apiTime;
      if (shouldKeepLocalForSameOrNewerIndex) {
        row.lastMessage = prevRow.lastMessage;
        row.lastMessageTime = prevTime;
        row._skipRuntimePreviewHydration = true;
        return;
      }

      // If API preview is temporarily empty/noisy, prefer previous non-empty preview.
      if (prevRow && !apiPreview && prevPreview) {
        row.lastMessage = prevRow.lastMessage;
        if (prevTime > apiTime) row.lastMessageTime = prevTime;
      }
    });
  }

  _normalizeAvatarReference(rawAvatar, mode = 'content') {
    const avatar = this._toText(rawAvatar);
    if (!avatar) return '';
    if (/\/content\/?$/i.test(avatar)) return '';
    if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/content\/?$/i.test(avatar)) return '';
    if (avatar.startsWith('metafile://')) {
      return this._convertMetafileUrl(avatar, mode);
    }

    const pinId = this._extractPinId(avatar);
    if (!pinId) return avatar;

    if (/^\/content\//i.test(avatar)) {
      return this._convertMetafileUrl(`metafile://${pinId}`, mode);
    }
    if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/(?:api\/v1\/users\/avatar\/accelerate\/|content\/)/i.test(avatar)) {
      return this._convertMetafileUrl(`metafile://${pinId}`, mode);
    }

    return avatar;
  }

  /**
   * Convert metafile:// protocol URL to actual file URL
   * @param {string} metafileUrl - URL in format metafile://{pinid}
   * @returns {string} - Full URL to access the file
   */
  _convertMetafileUrl(metafileUrl, mode = 'content') {
    if (!metafileUrl || typeof metafileUrl !== 'string') {
      return null;
    }

    const buildContentUrl = (base, pinId) => {
      let baseText = String(base || '').replace(/\/+$/, '');
      if (!baseText) return '';
      if (!/\/api\/v1$/i.test(baseText)) {
        baseText = baseText
          .replace(/\/api$/i, '/api/v1')
          .replace(/\/+$/, '');
      }
      return `${baseText}/files/content/${pinId}`;
    };
    const buildContentThumbnailUrl = (base, pinId) => {
      let baseText = String(base || '').replace(/\/+$/, '');
      if (!baseText) return '';
      if (!/\/api\/v1$/i.test(baseText)) {
        baseText = baseText
          .replace(/\/api$/i, '/api/v1')
          .replace(/\/+$/, '');
      }
      return `${baseText}/files/accelerate/content/${pinId}?process=thumbnail`;
    };
    const buildAvatarUrl = (base, pinId) => {
      let baseText = String(base || '').replace(/\/+$/, '');
      if (!baseText) return '';
      if (!/\/api\/v1$/i.test(baseText)) {
        baseText = baseText
          .replace(/\/api$/i, '/api/v1')
          .replace(/\/+$/, '');
      }
      return `${baseText}/users/avatar/accelerate/${pinId}?process=thumbnail`;
    };
    
    if (metafileUrl.startsWith('metafile://')) {
      // Extract pinid from metafile://{pinid}
      let pinid = metafileUrl.replace('metafile://', '');
      pinid = pinid.split('?')[0].split('#')[0];
      if (pinid.startsWith('video/') || pinid.startsWith('audio/') || pinid.startsWith('image/')) {
        pinid = pinid.split('/').slice(1).join('/');
      }
      pinid = pinid.replace(/\.[a-zA-Z0-9]{1,10}$/i, '');
      if (!pinid) return '';
      
      // Get metafs base URL from ServiceLocator
      const metafsBase = window.ServiceLocator?.metafs || 'https://file.metaid.io/metafile-indexer/api/v1';

      if (String(mode || 'content') === 'avatar') {
        return buildAvatarUrl(metafsBase, pinid);
      }
      if (String(mode || 'content') === 'group-avatar' || String(mode || 'content') === 'content-thumbnail') {
        return buildContentThumbnailUrl(metafsBase, pinid);
      }
      return buildContentUrl(metafsBase, pinid);
    }
    
    // If already a full URL, return as is
    if (metafileUrl.startsWith('http://') || metafileUrl.startsWith('https://')) {
      return metafileUrl;
    }
    
    // Return as is for other cases
    return metafileUrl;
  }

  /**
   * @param {Object} context
   * @param {Object} context.payload - Event detail (optional)
   * @param {Object} context.stores - Alpine stores object (wallet, chat, user, etc.)
   * @param {Object} context.delegate - IDFramework.Delegate
   */
  async execute({ payload, stores, delegate }) {
    const options = payload && typeof payload === 'object' ? payload : {};
    const runInBackground = !!options.background;
    let shouldFlipLoading = true;
    let runId = 0;
    try {
      // Get stores - handle both cases where stores might not be passed correctly
      const walletStore = stores?.wallet || (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
      const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
      
      if (!walletStore || !walletStore.isConnected) {
        console.warn('FetchChatListCommand: Wallet not connected');
        return;
      }

      if (!walletStore.globalMetaId) {
        console.warn('FetchChatListCommand: GlobalMetaID not available. Please connect wallet first.');
        return;
      }

      if (!chatStore) {
        console.warn('FetchChatListCommand: Chat store not available');
        // Try to get it directly from Alpine
        if (typeof Alpine !== 'undefined') {
          const directChatStore = Alpine.store('chat');
          if (directChatStore) {
            directChatStore.isLoading = true;
            directChatStore.error = null;
          }
        }
        return;
      }

      runId = this._markLatestRun(chatStore);

      const hasConversations = !!(
        chatStore.conversations &&
        typeof chatStore.conversations === 'object' &&
        Object.keys(chatStore.conversations).length > 0
      );
      shouldFlipLoading = !runInBackground || !hasConversations || !!options.forceLoading;

      if (shouldFlipLoading) {
        chatStore.isLoading = true;
        chatStore.error = null;
      }

      // Fetch chat list from IDChat API
      // API endpoint: /user/latest-chat-info-list?metaid={globalMetaId}
      const baseURL = window.ServiceLocator?.idchat || 'https://api.idchat.io/chat-api/group-chat';
      const endpoint = `/user/latest-chat-info-list?metaid=${encodeURIComponent(walletStore.globalMetaId)}`;
      
      // Use fetch directly
      const response = await fetch(`${baseURL}${endpoint}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const rawData = await response.json();
      if (!this._isLatestRun(chatStore, runId)) return;

      const userStore = stores?.user || (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);

      // Parse and update chat store
      const conversations = this._parseChatList(rawData);
      this._preserveConversationIndexHints(
        conversations,
        chatStore.conversations,
        chatStore.messages
      );
      
      // Update chat store - use Object.assign to ensure Alpine reactivity
      const nextState = {
        conversations: conversations,
        error: null,
      };
      if (shouldFlipLoading) {
        nextState.isLoading = false;
      }
      Object.assign(chatStore, nextState);
      this._notifyChatUpdated();
      this._hydrateConversationPreviewsInBackground(conversations, walletStore, userStore, chatStore, runId);

      // Fetch user info for each conversation participant
      if (userStore) {
        const now = Date.now();
        // Extract unique metaids from conversations
        const metaids = new Set();
        Object.values(conversations).forEach(conv => {
          if (conv && conv.type === '2') {
            const directMetaId = String(conv.participantMetaId || conv.metaid || '').trim();
            if (directMetaId && directMetaId !== walletStore.globalMetaId) {
              metaids.add(directMetaId);
            }
          }
          if (conv.participants) {
            conv.participants.forEach(p => {
              if (p.metaid && p.metaid !== walletStore.globalMetaId) {
                metaids.add(p.metaid);
              }
            });
          }
        });

        // Fetch user info for each metaid
        for (const metaid of metaids) {
          const cachedUser = userStore.users && typeof userStore.users === 'object'
            ? (userStore.users[metaid] || null)
            : null;
          const hasEnoughProfile = !!(
            cachedUser &&
            typeof cachedUser === 'object' &&
            (
              this._toText(cachedUser.name) ||
              this._toText(cachedUser.metaid || cachedUser.metaId) ||
              this._toText(cachedUser.globalMetaId || cachedUser.globalmetaid)
            )
          );
          const lastPrefetchAt = Number(CHAT_LIST_USER_PREFETCH_AT.get(metaid) || 0);
          const isInCooldown = lastPrefetchAt > 0 && (now - lastPrefetchAt) < CHAT_LIST_USER_PREFETCH_COOLDOWN_MS;
          if (!hasEnoughProfile && !isInCooldown) {
            CHAT_LIST_USER_PREFETCH_AT.set(metaid, now);
            if (window.IDFramework) {
              window.IDFramework.dispatch('fetchUser', { metaid }).catch(err => {
                console.warn(`Failed to fetch user info for ${metaid}:`, err);
              });
            }
          }
        }
      }

    } catch (error) {
      console.error('FetchChatListCommand error:', error);
      const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
      if (chatStore && this._isLatestRun(chatStore, runId)) {
        if (shouldFlipLoading) {
          chatStore.isLoading = false;
          chatStore.error = error.message || 'Failed to fetch chat list';
        }
      } else if (!chatStore) {
        console.error('FetchChatListCommand: Cannot update chat store - store not available');
      }
    }
  }

  /**
   * Parse raw API response into conversation format
   * @param {Object} rawData - Raw API response
   * @returns {Object} Parsed conversations object
   */
  _parseChatList(rawData) {
    const conversations = {};


    // Handle different API response structures
    let chatList = [];
    if (Array.isArray(rawData)) {
      chatList = rawData;
    } else if (rawData.data) {
      // data might be an object with a list property, or it might be an array
      if (Array.isArray(rawData.data)) {
        chatList = rawData.data;
      } else if (rawData.data.list && Array.isArray(rawData.data.list)) {
        chatList = rawData.data.list;
      } else if (rawData.data.items && Array.isArray(rawData.data.items)) {
        chatList = rawData.data.items;
      } else if (rawData.data.data && Array.isArray(rawData.data.data)) {
        chatList = rawData.data.data;
      } else if (rawData.data.chats && Array.isArray(rawData.data.chats)) {
        chatList = rawData.data.chats;
      } else if (rawData.data.conversations && Array.isArray(rawData.data.conversations)) {
        chatList = rawData.data.conversations;
      } else {
        // If data is an object, try to find any array property
        for (const key in rawData.data) {
          if (Array.isArray(rawData.data[key])) {
            chatList = rawData.data[key];
            break;
          }
        }
      }
    } else if (rawData.list && Array.isArray(rawData.list)) {
      chatList = rawData.list;
    } else if (rawData.result && Array.isArray(rawData.result)) {
      chatList = rawData.result;
    } else if (rawData.items && Array.isArray(rawData.items)) {
      chatList = rawData.items;
    }

    // Parse chat list based on type (1=group, 2=private)

    chatList.forEach((chat, index) => {
      
      // Determine chat type: type=1 is group chat, type=2 is private chat
      const chatType = String(chat.type || chat.chatType || chat.chat_type || '2');
      const isGroupChat = chatType === '1';
      const isPrivateChat = chatType === '2';
      
      // Extract conversation ID based on chat type
      let conversationId;
      let conversationKey;
      let conversationName;
      let conversationAvatar;
      let participantMetaId = null;
      
      if (isGroupChat) {
        // Group chat: use groupId as conversationId
        conversationId = chat.groupId || chat.group_id || `group_${index}`;
        conversationKey = conversationId;
        conversationName = chat.roomName || chat.room_name || 'Unnamed Group';
        
        // Handle roomIcon (may be in metafile:// format)
        if (chat.roomIcon) {
          conversationAvatar = this._normalizeAvatarReference(chat.roomIcon, 'group-avatar');
        }
      } else if (isPrivateChat) {
        // Private chat: prefer userInfo.globalMetaId as stable conversation id.
        const userInfo = chat && typeof chat.userInfo === 'object' ? chat.userInfo : {};
        const privateGlobalMetaId = String(
          userInfo.globalMetaId ||
          userInfo.globalmetaid ||
          chat.globalMetaId ||
          chat.global_meta_id ||
          ''
        ).trim();
        const privateMetaId = String(
          userInfo.metaid ||
          userInfo.metaId ||
          chat.metaId ||
          chat.meta_id ||
          ''
        ).trim();

        conversationId = privateGlobalMetaId || privateMetaId || `private_${index}`;
        conversationKey = conversationId;
        participantMetaId = privateMetaId || null;
        
        // For private chats, name and avatar come from userInfo
        if (chat.userInfo) {
          conversationName = chat.userInfo.name || chat.userInfo.nickname || null;
          conversationAvatar = this._normalizeAvatarReference(
            chat.userInfo.avatarImage || chat.userInfo.avatarUrl || chat.userInfo.avatar || null,
            'avatar'
          );
        }
      } else {
        // Fallback: use generic ID
        conversationId = chat.conversationId || chat.conversation_id || chat.id || `chat_${index}`;
        conversationKey = conversationId;
        conversationName = chat.name || chat.title || null;
      }
      
      const lastMessage = this._formatConversationPreview(
        chatType,
        this._extractMessagePreview(chat),
        this._extractPreviewSender(chat)
      );
      
      // Last message time - use timestamp field
      let lastMessageTime = null;
      if (chat.timestamp) {
        lastMessageTime = this._normalizeTimestampMillis(chat.timestamp);
      } else if (chat.lastMessageTime) {
        lastMessageTime = this._normalizeTimestampMillis(chat.lastMessageTime);
      } else if (chat.last_message_time) {
        lastMessageTime = this._normalizeTimestampMillis(chat.last_message_time);
      }
      
      // Unread count - not directly available in this API response, default to 0
      const unreadCount = chat.unreadCount || chat.unread_count || chat.unread || 0;
      const normalizedConversationIndex = this._resolveConversationIndex(chat);
      
      // Get participants (for group chats, this might be in userCount)
      const participants = chat.participants || chat.members || chat.users || [];

      conversations[conversationKey] = {
        conversationId: conversationId,
        metaid: conversationKey,
        groupId: isGroupChat ? conversationId : null, // For group chats, store groupId
        type: chatType, // Store the type for component rendering
        index: normalizedConversationIndex, // Store index for fetching messages
        participants: participants,
        lastMessage: lastMessage,
        lastMessageTime: lastMessageTime || Date.now(),
        unreadCount: unreadCount,
        // Chat-specific fields
        name: conversationName, // Group name or user name
        avatar: conversationAvatar, // Group icon or user avatar
        participantMetaId: participantMetaId, // For private chats, the other user's metaid
        // Additional fields
        chatType: chat.chatType || chat.chat_type || chatType,
        // Store raw chat data for reference
        _raw: chat,
      };
      
    });

    return conversations;
  }
}
