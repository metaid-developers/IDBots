const GROUP_TEXT_PROTOCOL = '/protocols/simplegroupchat';
const PRIVATE_TEXT_PROTOCOL = '/protocols/simplemsg';
const GROUP_FILE_PROTOCOL = '/protocols/simplefilegroupchat';
const PRIVATE_FILE_PROTOCOL = '/protocols/simplefilemsg';

function getCryptoJS() {
  const CryptoJS = typeof window !== 'undefined' ? window.CryptoJS : null;
  if (!CryptoJS) {
    throw new Error('CryptoJS is unavailable. Please load idframework/crypto.js first.');
  }
  return CryptoJS;
}

function normalizeTimestamp(raw) {
  let value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) return Date.now();
  while (value < 1000000000000) value *= 10;
  return Math.floor(value);
}

function buildFileUrl(pinId, useThumbnail) {
  if (!pinId) return '';
  const base = 'https://file.metaid.io/metafile-indexer/api/v1/files';
  if (useThumbnail) {
    return `${base}/accelerate/content/${pinId}?process=thumbnail`;
  }
  return `${base}/content/${pinId}`;
}

function extractPinId(content) {
  const raw = String(content || '').trim();
  if (!raw) return '';
  const withoutScheme = raw.indexOf('metafile://') === 0 ? raw.slice('metafile://'.length) : raw;
  const idPart = withoutScheme.split('?')[0];
  const firstPart = idPart.split('/').pop() || '';
  const pinMatch = firstPart.match(/[a-fA-F0-9]{64}i\d+/);
  if (pinMatch && pinMatch[0]) return pinMatch[0];
  const dotIndex = firstPart.indexOf('.');
  if (dotIndex > 0) return firstPart.slice(0, dotIndex);
  return firstPart;
}

function normalizeMention(rawMention) {
  if (Array.isArray(rawMention)) {
    return rawMention.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof rawMention === 'string') {
    return rawMention.split(',').map((v) => String(v || '').trim()).filter(Boolean);
  }
  return [];
}

class SimpleChatDB {
  constructor(globalMetaId) {
    this.db = null;
    this.globalMetaId = globalMetaId || '';
    this.DB_NAME = 'SimpleChatDB';
    this.DB_VERSION = 1;
    this.MESSAGE_STORE = 'messages';
  }

  _dbName() {
    return this.globalMetaId ? `${this.DB_NAME}_${this.globalMetaId}` : this.DB_NAME;
  }

  async init(globalMetaId) {
    if (globalMetaId) this.globalMetaId = globalMetaId;
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this._dbName(), this.DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.MESSAGE_STORE)) {
          const store = db.createObjectStore(this.MESSAGE_STORE, { keyPath: 'id' });
          store.createIndex('chatKey', 'chatKey', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('chatKeyTimestamp', ['chatKey', 'timestamp'], { unique: false });
          store.createIndex('chatKeyIndex', ['chatKey', 'index'], { unique: false });
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
    });
  }

  async upsertMessages(chatKey, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    await this.init();
    const existing = await this.getMessages(chatKey);
    const canonicalByPinId = new Map();
    const duplicateIds = [];

    // 先把历史数据按 pinId 归一，保留 index 更大的那条
    existing.forEach((item) => {
      const pinId = String(item && item.pinId ? item.pinId : '').trim();
      if (!pinId) return;
      if (!canonicalByPinId.has(pinId)) {
        canonicalByPinId.set(pinId, item);
        return;
      }
      const prev = canonicalByPinId.get(pinId);
      const prevIndex = Number(prev && prev.index ? prev.index : 0);
      const nextIndex = Number(item && item.index ? item.index : 0);
      if (nextIndex > prevIndex) {
        duplicateIds.push(prev.id);
        canonicalByPinId.set(pinId, item);
      } else {
        duplicateIds.push(item.id);
      }
    });

    const prepared = [];
    const seenPinId = new Set();
    messages.forEach((raw) => {
      const message = Object.assign({}, raw, { chatKey });
      const pinId = String(message && message.pinId ? message.pinId : '').trim();
      if (pinId && seenPinId.has(pinId)) return;
      if (pinId) seenPinId.add(pinId);
      if (pinId && canonicalByPinId.has(pinId)) {
        const prev = canonicalByPinId.get(pinId);
        const prevIndex = Number(prev && prev.index ? prev.index : 0);
        const nextIndex = Number(message && message.index ? message.index : 0);
        // pinId 相同视为同一消息：用新消息替换旧消息，但保留可复用 id
        const merged = Object.assign({}, prev, message);
        merged.id = prev && prev.id ? prev.id : message.id;
        // 防止回退 index（mock -> push -> api）
        merged.index = Math.max(prevIndex, nextIndex);
        prepared.push(merged);
      } else {
        prepared.push(message);
      }
    });

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.MESSAGE_STORE], 'readwrite');
      const store = tx.objectStore(this.MESSAGE_STORE);
      duplicateIds.forEach((id) => {
        if (id) store.delete(id);
      });
      prepared.forEach((message) => {
        store.put(Object.assign({}, message, { chatKey }));
      });
      tx.oncomplete = () => resolve(prepared.length);
      tx.onerror = () => reject(tx.error || new Error('Failed to upsert messages'));
    });
  }

  async getMessages(chatKey) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.MESSAGE_STORE], 'readonly');
      const store = tx.objectStore(this.MESSAGE_STORE);
      const index = store.index('chatKey');
      const request = index.getAll(IDBKeyRange.only(chatKey));
      request.onsuccess = () => {
        const rawList = Array.isArray(request.result) ? request.result.slice() : [];
        const list = [];
        const byPinId = new Map();
        rawList.forEach((item) => {
          const pinId = String(item && item.pinId ? item.pinId : '').trim();
          if (!pinId) {
            list.push(item);
            return;
          }
          if (!byPinId.has(pinId)) {
            byPinId.set(pinId, item);
            return;
          }
          const prev = byPinId.get(pinId);
          const prevIndex = Number(prev && prev.index ? prev.index : 0);
          const nextIndex = Number(item && item.index ? item.index : 0);
          if (nextIndex >= prevIndex) {
            byPinId.set(pinId, item);
          }
        });
        byPinId.forEach((item) => list.push(item));
        list.sort((a, b) => {
          const ai = Number(a.index || 0);
          const bi = Number(b.index || 0);
          if (ai && bi && ai !== bi) return ai - bi;
          return Number(a.timestamp || 0) - Number(b.timestamp || 0);
        });
        resolve(list);
      };
      request.onerror = () => reject(request.error || new Error('Failed to read messages'));
    });
  }

  async getOldestTimestamp(chatKey) {
    const messages = await this.getMessages(chatKey);
    if (!messages.length) return 0;
    return Number(messages[0].timestamp || 0);
  }

  async getLatestIndex(chatKey) {
    const messages = await this.getMessages(chatKey);
    if (!messages.length) return 0;
    let latest = 0;
    messages.forEach((item) => {
      const idx = Number(item.index || 0);
      if (idx > latest) latest = idx;
    });
    return latest;
  }

  async getOldestIndex(chatKey) {
    const messages = await this.getMessages(chatKey);
    if (!messages.length) return 0;
    let oldest = Number.MAX_SAFE_INTEGER;
    messages.forEach((item) => {
      const idx = Number(item.index || 0);
      if (idx > 0 && idx < oldest) oldest = idx;
    });
    return oldest === Number.MAX_SAFE_INTEGER ? 0 : oldest;
  }
}

export class SimpleTalkStore {
  constructor() {
    this.pageSize = 30;
    this.selfGlobalMetaId = '';
    this.selfMetaId = '';
    this.context = { mode: 'public', groupId: '', targetGlobalMetaId: '' };
    this.db = new SimpleChatDB('');
    this.sharedSecretCache = new Map();
  }

  async init() {
    const wallet = typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null;
    const user = typeof Alpine !== 'undefined' ? Alpine.store('user') : null;
    this.selfGlobalMetaId = String(
      (wallet && wallet.globalMetaId) ||
      (user && user.user && user.user.globalMetaId) ||
      ''
    ).trim();
    this.selfMetaId = String(
      (user && user.user && (user.user.metaid || user.user.metaId)) ||
      this.selfGlobalMetaId ||
      ''
    ).trim();
    if (!this.selfGlobalMetaId) {
      throw new Error('globalMetaId is required before chat initialization');
    }
    this.db = new SimpleChatDB(this.selfGlobalMetaId);
    await this.db.init(this.selfGlobalMetaId);
  }

  setContext(context) {
    const mode = context && context.mode === 'private' ? 'private' : 'public';
    this.context = {
      mode,
      groupId: String((context && context.groupId) || '').trim(),
      targetGlobalMetaId: String((context && context.targetGlobalMetaId) || '').trim(),
    };
    if (mode === 'public' && !this.context.groupId) {
      throw new Error('groupId is required for public chat');
    }
    if (mode === 'private' && !this.context.targetGlobalMetaId) {
      throw new Error('targetGlobalMetaId is required for private chat');
    }
  }

  getChatKey() {
    if (this.context.mode === 'public') return `public:${this.context.groupId}`;
    const pair = [this.selfGlobalMetaId, this.context.targetGlobalMetaId].sort().join(':');
    return `private:${pair}`;
  }

  async loadLatestMessages() {
    const chatKey = this.getChatKey();
    const latestIndex = await this.db.getLatestIndex(chatKey);
    const startIndex = latestIndex > 0 ? latestIndex : 0;
    const remote = await this._fetchByIndexFromServer({ startIndex, size: this.pageSize });
    const normalized = (remote || []).map((item) => this._normalizeMessage(item)).filter(Boolean);
    if (normalized.length) {
      await this.db.upsertMessages(chatKey, normalized);
    }
    return this.db.getMessages(chatKey);
  }

  async loadOlderMessages() {
    const chatKey = this.getChatKey();
    const oldestIndex = await this.db.getOldestIndex(chatKey);
    if (!oldestIndex || oldestIndex <= 1) return this.db.getMessages(chatKey);
    const startIndex = Math.max(1, oldestIndex - this.pageSize);
    const remote = await this._fetchByIndexFromServer({ startIndex, size: this.pageSize });
    const normalized = (remote || []).map((item) => this._normalizeMessage(item)).filter(Boolean);
    if (normalized.length) {
      await this.db.upsertMessages(chatKey, normalized);
    }
    return this.db.getMessages(chatKey);
  }

  async getMessages() {
    return this.db.getMessages(this.getChatKey());
  }

  async receiveMessage(message) {
    const normalized = await this._normalizeIncomingMessage(message);
    if (!normalized) return false;
    if (!this._isMessageInCurrentContext(normalized)) return false;
    await this.db.upsertMessages(this.getChatKey(), [normalized]);
    return true;
  }

  async decryptText(message) {
    const protocol = String(message.protocol || '');
    const content = String(message.content || '');
    if (!content) return '';
    if (protocol === GROUP_TEXT_PROTOCOL) {
      return this._groupDecrypt(content, String(message.groupId || '').slice(0, 16));
    }
    if (protocol === PRIVATE_TEXT_PROTOCOL) {
      const peer = this._resolvePeerGlobalMetaId(message);
      const secret = await this.getSharedSecret(peer);
      if (!secret) return content;
      return this._privateDecrypt(content, secret);
    }
    return content;
  }

  async decryptPrivateFileToObjectUrl(message) {
    const pinId = extractPinId(message.content || message.attachment);
    if (!pinId) return '';
    const peer = this._resolvePeerGlobalMetaId(message);
    const secret = await this.getSharedSecret(peer);
    if (!secret) return '';
    const fileUrl = buildFileUrl(pinId, false);
    const response = await fetch(fileUrl);
    const buf = await response.arrayBuffer();
    const blob = this._decryptToBlob(buf, secret, message.contentType || 'application/octet-stream');
    if (!blob) return '';
    return URL.createObjectURL(blob);
  }

  async getSharedSecret(otherGlobalMetaId) {
    const peer = String(otherGlobalMetaId || '').trim();
    if (!peer || peer === this.selfGlobalMetaId) return '';
    if (this.sharedSecretCache.has(peer)) return this.sharedSecretCache.get(peer);
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return '';
    const userInfo = await window.IDFramework.dispatch('fetchUserInfo', { globalMetaId: peer });
    const pubkey = String(
      (userInfo && (userInfo.chatpubkey || userInfo.chatPubkey || userInfo.chatPublicKey)) || ''
    ).trim();
    if (!pubkey) return '';
    if (!window.metaidwallet || !window.metaidwallet.common || typeof window.metaidwallet.common.ecdh !== 'function') return '';
    const ecdh = await window.metaidwallet.common.ecdh({ externalPubKey: pubkey });
    const secret = ecdh && ecdh.sharedSecret ? String(ecdh.sharedSecret) : '';
    if (secret) this.sharedSecretCache.set(peer, secret);
    return secret;
  }

  _groupDecrypt(messageHex, secretKeyStr) {
    if (!secretKeyStr) return messageHex;
    try {
      const CryptoJS = getCryptoJS();
      const Utf8 = CryptoJS.enc.Utf8;
      const iv = Utf8.parse('0000000000000000');
      const messageBuffer = typeof Buffer !== 'undefined'
        ? Buffer.from(messageHex, 'hex')
        : this._hexToBytes(messageHex);
      const messageBase64 = typeof Buffer !== 'undefined'
        ? messageBuffer.toString('base64')
        : btoa(String.fromCharCode.apply(null, messageBuffer));
      const bytes = CryptoJS.AES.decrypt(messageBase64, Utf8.parse(secretKeyStr), {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
      });
      const out = bytes.toString(Utf8);
      return out || messageHex;
    } catch (_) {
      return messageHex;
    }
  }

  _privateDecrypt(message, secretKey) {
    try {
      const CryptoJS = getCryptoJS();
      const bytes = CryptoJS.AES.decrypt(String(message || ''), String(secretKey || ''));
      const out = bytes.toString(CryptoJS.enc.Utf8);
      return out || String(message || '');
    } catch (_) {
      return String(message || '');
    }
  }

  _decryptToBlob(encryptedData, secretKey, mimeType) {
    try {
      const CryptoJS = getCryptoJS();
      const iv = CryptoJS.enc.Utf8.parse('0000000000000000');
      const uint8 = encryptedData instanceof Uint8Array ? encryptedData : new Uint8Array(encryptedData);
      const hex = Array.from(uint8).map((n) => n.toString(16).padStart(2, '0')).join('');
      const cipherParams = { ciphertext: CryptoJS.enc.Hex.parse(hex) };
      const bytes = CryptoJS.AES.decrypt(cipherParams, CryptoJS.enc.Hex.parse(secretKey), {
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
        iv,
      });
      const plainHex = bytes.toString(CryptoJS.enc.Hex);
      if (!plainHex) return null;
      const out = new Uint8Array(plainHex.length / 2);
      for (let i = 0; i < plainHex.length; i += 2) {
        out[i / 2] = parseInt(plainHex.slice(i, i + 2), 16);
      }
      return new Blob([out], { type: mimeType || 'application/octet-stream' });
    } catch (_) {
      return null;
    }
  }

  async _fetchByIndexFromServer(params) {
    const isPrivate = this.context.mode === 'private';
    const base = String(
      (window.ServiceLocator && window.ServiceLocator.idchat) ||
      'https://api.idchat.io/chat-api/group-chat'
    ).replace(/\/$/, '');
    const query = new URLSearchParams({
      size: String(params.size || this.pageSize),
      startIndex: String(params.startIndex || 0),
      ...(isPrivate
        ? {
            metaId: this.selfGlobalMetaId,
            otherMetaId: this.context.targetGlobalMetaId,
          }
        : {
            groupId: this.context.groupId,
            metaId: this.selfGlobalMetaId,
          }),
    });
    const path = isPrivate ? '/private-chat-list-by-index' : '/group-chat-list-by-index';
    const response = await fetch(`${base}${path}?${query.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch chat messages: ${response.status}`);
    }
    const json = await response.json();
    const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
    return list;
  }

  _normalizeMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const protocol = String(raw.protocol || '');
    const content = raw.content != null ? String(raw.content) : String(raw.attachment || '');
    const timestamp = normalizeTimestamp(raw.timestamp);
    const index = Number(raw.index || 0);
    const groupId = String(raw.groupId || raw.channelId || '');
    const fromGlobalMetaId = String(raw.fromGlobalMetaId || raw.globalMetaId || (raw.fromUserInfo && raw.fromUserInfo.globalMetaId) || '');
    const toGlobalMetaId = String(raw.toGlobalMetaId || (raw.toUserInfo && raw.toUserInfo.globalMetaId) || '');
    const replyPin = String(raw.replyPin || '');
    const replyMetaId = String(raw.replyMetaId || (raw.replyInfo && raw.replyInfo.metaId) || '');
    const replyGlobalMetaId = String(raw.replyGlobalMetaId || (raw.replyInfo && raw.replyInfo.globalMetaId) || '');
    const mention = normalizeMention(raw.mention);
    const stablePinId = String(raw.pinId || '').trim();
    const stableTxId = String(raw.txId || '').trim();
    const idSeed = String(stablePinId || stableTxId || `${protocol}_${timestamp}_${index}_${content.slice(0, 24)}`);
    const id = `${this.getChatKey()}_${idSeed}`;
    return {
      id,
      txId: String(raw.txId || ''),
      pinId: String(raw.pinId || ''),
      protocol,
      content,
      attachment: String(raw.attachment || ''),
      contentType: String(raw.contentType || ''),
      fileType: String(raw.fileType || (raw.data && raw.data.fileType) || ''),
      timestamp,
      index,
      groupId,
      fromGlobalMetaId,
      toGlobalMetaId,
      userInfo: raw.userInfo || raw.fromUserInfo || {},
      fromUserInfo: raw.fromUserInfo || null,
      toUserInfo: raw.toUserInfo || null,
      replyPin: replyPin,
      replyInfo: raw.replyInfo && typeof raw.replyInfo === 'object' ? Object.assign({}, raw.replyInfo) : null,
      replyMetaId: replyMetaId,
      replyGlobalMetaId: replyGlobalMetaId,
      mention: mention,
      raw,
    };
  }

  async _normalizeIncomingMessage(raw) {
    const normalized = this._normalizeMessage(raw);
    if (!normalized) return null;
    // WS 推送有时缺 index，这里强制补成最新 index + 1，确保消息渲染在最下方。
    if (!Number.isFinite(Number(normalized.index)) || Number(normalized.index) <= 0) {
      const latestIndex = await this.db.getLatestIndex(this.getChatKey());
      normalized.index = Number(latestIndex || 0) + 1;
      const fallbackId = normalized.txId || normalized.pinId || `${normalized.timestamp}_${normalized.index}`;
      normalized.id = `${this.getChatKey()}_${fallbackId}`;
    }
    return normalized;
  }

  _isMessageInCurrentContext(message) {
    if (this.context.mode === 'public') {
      return String(message.groupId || '') === this.context.groupId;
    }
    const a = String(message.fromGlobalMetaId || '');
    const b = String(message.toGlobalMetaId || '');
    return (
      (a === this.selfGlobalMetaId && b === this.context.targetGlobalMetaId) ||
      (b === this.selfGlobalMetaId && a === this.context.targetGlobalMetaId) ||
      (a === this.selfGlobalMetaId && b === this.selfGlobalMetaId)
    );
  }

  _resolvePeerGlobalMetaId(message) {
    const from = String(message.fromGlobalMetaId || '');
    const to = String(message.toGlobalMetaId || '');
    if (from && from !== this.selfGlobalMetaId) return from;
    if (to && to !== this.selfGlobalMetaId) return to;
    return this.context.targetGlobalMetaId || '';
  }

  _hexToBytes(hex) {
    const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
    const out = [];
    for (let i = 0; i < clean.length; i += 2) {
      out.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return new Uint8Array(out);
  }
}

let singleton = null;
export function getSimpleTalkStore() {
  if (!singleton) singleton = new SimpleTalkStore();
  return singleton;
}

export const ChatProtocols = {
  GROUP_TEXT_PROTOCOL,
  PRIVATE_TEXT_PROTOCOL,
  GROUP_FILE_PROTOCOL,
  PRIVATE_FILE_PROTOCOL,
  extractPinId,
  buildFileUrl,
};
