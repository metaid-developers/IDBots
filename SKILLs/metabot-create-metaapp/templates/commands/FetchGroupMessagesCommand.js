/**
 * FetchGroupMessagesCommand
 * Fetches group chat messages from IDChat API by index and normalizes them.
 *
 * API Endpoint: /group-chat-list-by-index
 * Method: GET
 * Parameters: groupId, startIndex, size
 */

const GROUP_TEXT_PROTOCOL = '/protocols/simplegroupchat';
const GROUP_FILE_PROTOCOL = '/protocols/simplefilegroupchat';

export default class FetchGroupMessagesCommand {
  _extractList(rawData) {
    if (Array.isArray(rawData)) return rawData;
    if (!rawData || typeof rawData !== 'object') return [];
    if (Array.isArray(rawData.data)) return rawData.data;
    if (rawData.data && Array.isArray(rawData.data.list)) return rawData.data.list;
    if (rawData.data && Array.isArray(rawData.data.items)) return rawData.data.items;
    if (Array.isArray(rawData.list)) return rawData.list;
    if (Array.isArray(rawData.items)) return rawData.items;
    return [];
  }

  _normalizeTimestampSeconds(raw) {
    const num = Number(raw || 0);
    if (!Number.isFinite(num) || num <= 0) return Math.floor(Date.now() / 1000);
    if (num > 1000000000000) return Math.floor(num / 1000);
    return Math.floor(num);
  }

  _normalizeChain(rawChain) {
    const raw = String(rawChain || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'bsv' || raw === 'btc') return 'btc';
    if (raw === 'dogecoin' || raw === 'doge') return 'doge';
    if (raw === 'microvisionchain' || raw === 'mvc') return 'mvc';
    return raw;
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

  async _decryptGroupText(content, groupId) {
    const raw = String(content || '').trim();
    if (!raw) return '';

    const isHex = /^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0;
    const isBase64 = !isHex && /^[A-Za-z0-9+/=]+$/.test(raw) && raw.length % 4 === 0;
    if (!isHex && !isBase64) return raw;

    const encryptedBytes = isHex ? this._hexToBytes(raw) : this._base64ToBytes(raw);
    if (!encryptedBytes.length) return raw;

    const keyText = String(groupId || '').slice(0, 16).padEnd(16, '0');
    const subtle = this._getWebCryptoSubtle();
    if (subtle) {
      try {
        const keyBytes = new TextEncoder().encode(keyText);
        const iv = new TextEncoder().encode('0000000000000000');
        const cryptoKey = await subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const decrypted = await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encryptedBytes);
        const plain = new TextDecoder().decode(decrypted).replace(/\0+$/, '').trim();
        return plain || raw;
      } catch (_) {}
    }

    const CryptoJS = (typeof window !== 'undefined' && window.CryptoJS)
      ? window.CryptoJS
      : (typeof globalThis !== 'undefined' ? globalThis.CryptoJS : null);
    if (CryptoJS) {
      try {
        const Utf8 = CryptoJS.enc.Utf8;
        const iv = Utf8.parse('0000000000000000');
        const messageBase64 = isHex
          ? (typeof Buffer !== 'undefined'
            ? Buffer.from(raw, 'hex').toString('base64')
            : btoa(String.fromCharCode.apply(null, encryptedBytes)))
          : raw;
        const bytes = CryptoJS.AES.decrypt(messageBase64, Utf8.parse(keyText), {
          iv: iv,
          mode: CryptoJS.mode.CBC,
          padding: CryptoJS.pad.Pkcs7,
        });
        const plain = bytes.toString(Utf8).trim();
        return plain || raw;
      } catch (_) {}
    }

    return raw;
  }

  _normalizeMessage(raw, groupId, fallbackIndex) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const pinId = String(item.pinId || item.pin_id || '').trim();
    const txId = String(item.txId || item.tx_id || '').trim();
    const index = Number(item.index || 0);
    const attachment = String(item.attachment || '').trim();
    const protocol = String(item.protocol || item.path || '').trim();
    const resolvedProtocol = protocol || (attachment ? GROUP_FILE_PROTOCOL : GROUP_TEXT_PROTOCOL);
    const content = String(item.content || '');
    const userInfo = item.userInfo || item.user_info || item.createUserInfo || item.fromUserInfo || null;
    const normalizedChain = this._normalizeChain(item.chain || item.chainName || item.network || item.blockchain);
    const fromGlobalMetaId = String(
      item.fromGlobalMetaId ||
      item.createGlobalMetaId ||
      (userInfo && (userInfo.globalMetaId || userInfo.globalmetaid)) ||
      item.createUserMetaId ||
      ''
    ).trim();
    const toGlobalMetaId = String(
      item.toGlobalMetaId ||
      item.receiveGlobalMetaId ||
      item.targetGlobalMetaId ||
      ''
    ).trim();

    return {
      id: pinId || txId || `group_${groupId}_${index || fallbackIndex}_${Date.now()}`,
      pinId: pinId || '',
      txId: txId || '',
      protocol: resolvedProtocol,
      type: '1',
      groupId: String(item.groupId || item.channelId || groupId || ''),
      channelId: String(item.channelId || ''),
      content: content,
      attachment: attachment,
      contentType: String(item.contentType || item.content_type || ''),
      fileType: String(item.fileType || item.file_type || ''),
      timestamp: this._normalizeTimestampSeconds(item.timestamp || item.time || item.createTime),
      index: Number.isFinite(index) ? index : 0,
      userInfo: userInfo,
      fromUserInfo: item.fromUserInfo || null,
      toUserInfo: item.toUserInfo || null,
      fromGlobalMetaId: fromGlobalMetaId,
      toGlobalMetaId: toGlobalMetaId,
      createGlobalMetaId: String(item.createGlobalMetaId || ''),
      createMetaId: String(item.createMetaId || item.createUserMetaId || ''),
      chain: normalizedChain,
      replyPin: String(item.replyPin || ''),
      replyInfo: item.replyInfo && typeof item.replyInfo === 'object' ? { ...item.replyInfo } : null,
      mention: Array.isArray(item.mention) ? item.mention.slice() : [],
      _raw: item,
    };
  }

  _buildMessageMergeKey(message) {
    const row = message && typeof message === 'object' ? message : {};
    const pinId = String(row.pinId || '').trim();
    if (pinId) return `pin:${pinId}`;
    const txId = String(row.txId || '').trim();
    if (txId) return `tx:${txId}`;
    return [
      'fallback',
      String(row.groupId || ''),
      String(row.index || ''),
      String(row.timestamp || ''),
      String(row.fromGlobalMetaId || row.createGlobalMetaId || ''),
      String(row.toGlobalMetaId || ''),
      String(row.protocol || ''),
    ].join('|');
  }

  _mergeMessages(existing, incoming) {
    const merged = [];
    const byKey = new Map();
    const visit = (message) => {
      const key = this._buildMessageMergeKey(message);
      if (!byKey.has(key)) {
        byKey.set(key, message);
        merged.push(message);
        return;
      }
      const prev = byKey.get(key);
      const next = {
        ...prev,
        ...message,
      };
      const incomingIsOptimistic = !!(message && message._optimistic);
      const hasStableId = !!String(next && (next.pinId || next.txId || '')).trim();
      if (!incomingIsOptimistic && hasStableId) {
        delete next._optimistic;
        delete next._sendStatus;
        delete next._sendError;
        delete next._retryPayload;
        delete next._optimisticFilePreview;
        delete next._clientTempId;
      }
      if (Number(prev && prev.index ? prev.index : 0) > Number(next && next.index ? next.index : 0)) {
        next.index = Number(prev.index || 0);
      }
      byKey.set(key, next);
      const idx = merged.findIndex((item) => this._buildMessageMergeKey(item) === key);
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

  _sortMessages(rows) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    list.sort((a, b) => {
      const ai = Number(a && a.index ? a.index : 0);
      const bi = Number(b && b.index ? b.index : 0);
      if (ai !== bi) return ai - bi;
      return Number(a && a.timestamp ? a.timestamp : 0) - Number(b && b.timestamp ? b.timestamp : 0);
    });
    return list;
  }

  _notifyChatUpdated() {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
    try {
      document.dispatchEvent(new CustomEvent('id:chat:updated'));
    } catch (_) {}
  }

  /**
   * @param {Object} context
   * @param {Object} context.payload - { groupId, startIndex, size }
   * @param {Object} context.stores - Alpine stores object
   */
  async execute({ payload = {}, stores }) {
    const groupId = String(payload.groupId || '').trim();
    const startIndex = Number(payload.startIndex || 0);
    const size = Number(payload.size || 50);
    const mergeMode = String(payload.mergeMode || 'replace').trim().toLowerCase();
    const shouldReplace = mergeMode !== 'prepend';

    if (!groupId) throw new Error('groupId is required');

    const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
    if (!chatStore) throw new Error('Chat store not available');

    if (shouldReplace) {
      chatStore.isLoading = true;
      chatStore.error = null;
    }

    try {
      const locator = (typeof window !== 'undefined' && window.ServiceLocator)
        ? window.ServiceLocator
        : (globalThis.ServiceLocator || null);
      const baseURL = (locator?.idchat || 'https://api.idchat.io/chat-api/group-chat').replace(/\/+$/, '');
      const query = new URLSearchParams({
        groupId: groupId,
        startIndex: String(Number.isFinite(startIndex) ? startIndex : 0),
        size: String(Number.isFinite(size) && size > 0 ? size : 50),
      }).toString();

      const response = await fetch(`${baseURL}/group-chat-list-by-index?${query}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      }

      const rawData = await response.json();
      const list = this._extractList(rawData);

      const normalized = [];
      for (let i = 0; i < list.length; i += 1) {
        const item = this._normalizeMessage(list[i], groupId, i);
        if (item.protocol === GROUP_TEXT_PROTOCOL && item.content) {
          item.content = await this._decryptGroupText(item.content, groupId);
        }
        normalized.push(item);
      }

      const sortedNormalized = this._sortMessages(normalized);
      const existingRows = Array.isArray(chatStore.messages[groupId]) ? chatStore.messages[groupId] : [];
      const finalRows = shouldReplace ? sortedNormalized : this._mergeMessages(existingRows, sortedNormalized);

      Object.assign(chatStore.messages, {
        [groupId]: finalRows,
      });
      if (shouldReplace) {
        chatStore.isLoading = false;
        chatStore.error = null;
      }

      const userStore = stores?.user || (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
      const idf = (typeof window !== 'undefined' && window.IDFramework) ? window.IDFramework : null;
      if (userStore && idf && typeof idf.dispatch === 'function') {
        const knownUsers = userStore.users && typeof userStore.users === 'object' ? userStore.users : {};
        const sourceRows = shouldReplace ? finalRows : sortedNormalized;
        const unique = new Set();
        sourceRows.forEach((msg) => {
          const user = msg.userInfo && typeof msg.userInfo === 'object' ? msg.userInfo : null;
          const globalMetaId = String(
            (user && (user.globalMetaId || user.globalmetaid)) ||
            msg.fromGlobalMetaId ||
            ''
          ).trim();
          const metaid = String((user && (user.metaid || user.metaId)) || '').trim();
          if (globalMetaId && !knownUsers[globalMetaId]) unique.add(`g:${globalMetaId}`);
          if (metaid && !knownUsers[metaid]) unique.add(`m:${metaid}`);
        });
        unique.forEach((id) => {
          const [kind, value] = id.split(':');
          if (kind === 'g') {
            idf.dispatch('fetchUser', { globalMetaId: value }).catch(() => {});
            return;
          }
          idf.dispatch('fetchUser', { metaid: value }).catch(() => {});
        });
      }

      this._notifyChatUpdated();
      return finalRows;
    } catch (error) {
      if (shouldReplace) {
        chatStore.isLoading = false;
        chatStore.error = error.message || 'Failed to fetch group messages';
      }
      throw error;
    }
  }
}
