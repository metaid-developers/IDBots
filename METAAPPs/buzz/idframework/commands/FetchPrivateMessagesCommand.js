/**
 * FetchPrivateMessagesCommand
 * Fetches private chat messages from IDChat API by index.
 *
 * API Endpoint: /group-chat/private-chat-list-by-index
 * Method: GET
 * Parameters: metaId, otherMetaId, startIndex, size
 */

export default class FetchPrivateMessagesCommand {
  _notifyChatUpdated() {
    if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
    try {
      document.dispatchEvent(new CustomEvent('id:chat:updated'));
    } catch (_) {}
  }

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

  _normalizeTimestamp(raw) {
    const n = Number(raw || 0);
    if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
    if (n > 1000000000000) return Math.floor(n / 1000);
    return Math.floor(n);
  }

  _normalizeChain(rawChain) {
    const raw = String(rawChain || '').trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'bsv' || raw === 'btc') return 'btc';
    if (raw === 'dogecoin' || raw === 'doge') return 'doge';
    if (raw === 'microvisionchain' || raw === 'mvc') return 'mvc';
    return raw;
  }

  _normalizeMessage(raw, fallbackConversationKey) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const pinId = String(item.pinId || item.pin_id || '').trim();
    const txId = String(item.txId || item.tx_id || '').trim();
    const fromUserInfo = item.fromUserInfo && typeof item.fromUserInfo === 'object' ? item.fromUserInfo : null;
    const userInfo = item.userInfo && typeof item.userInfo === 'object' ? item.userInfo : null;
    const normalizedChain = this._normalizeChain(item.chain || item.chainName || item.network || item.blockchain);
    const fromGlobalMetaId = String(
      item.fromGlobalMetaId ||
      item.from_meta_id ||
      item.createGlobalMetaId ||
      item.createUserMetaId ||
      (fromUserInfo && (fromUserInfo.globalMetaId || fromUserInfo.globalmetaid)) ||
      (userInfo && (userInfo.globalMetaId || userInfo.globalmetaid)) ||
      ''
    ).trim();
    const toGlobalMetaId = String(
      item.toGlobalMetaId ||
      item.to_meta_id ||
      item.receiveGlobalMetaId ||
      item.targetGlobalMetaId ||
      ''
    ).trim();
    const index = Number(item.index || 0);
    const attachment = String(item.attachment || '').trim();
    const protocol = String(item.protocol || item.path || '').trim();
    const resolvedProtocol = protocol || (attachment ? '/protocols/simplefilemsg' : '/protocols/simplemsg');

    return {
      id: pinId || txId || `private_${fallbackConversationKey}_${index}_${Date.now()}`,
      pinId: pinId || '',
      txId: txId || '',
      protocol: resolvedProtocol,
      type: '2',
      content: String(item.content || item.message || ''),
      attachment: attachment,
      contentType: String(item.contentType || item.content_type || ''),
      fileType: String(item.fileType || item.file_type || ''),
      timestamp: this._normalizeTimestamp(item.timestamp || item.time),
      index: Number.isFinite(index) ? index : 0,
      fromGlobalMetaId: fromGlobalMetaId,
      toGlobalMetaId: toGlobalMetaId,
      channelId: String(item.channelId || ''),
      createGlobalMetaId: String(item.createGlobalMetaId || ''),
      createMetaId: String(item.createMetaId || item.createUserMetaId || ''),
      fromMetaId: String(
        item.fromMetaId ||
        (fromUserInfo && (fromUserInfo.metaid || fromUserInfo.metaId)) ||
        (userInfo && (userInfo.metaid || userInfo.metaId)) ||
        item.createMetaId ||
        item.createUserMetaId ||
        ''
      ),
      chain: normalizedChain,
      userInfo: item.userInfo || item.fromUserInfo || item.user_info || null,
      fromUserInfo: item.fromUserInfo || null,
      toUserInfo: item.toUserInfo || null,
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
      String(row.fromGlobalMetaId || row.createGlobalMetaId || ''),
      String(row.toGlobalMetaId || ''),
      String(row.index || ''),
      String(row.timestamp || ''),
      String(row.protocol || ''),
      String(row.channelId || ''),
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
      const next = { ...prev, ...message };
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

  async execute({ payload = {}, stores }) {
    const metaId = String(payload.metaId || payload.metaid || '').trim();
    const otherMetaId = String(payload.otherMetaId || payload.metaId2 || payload.otherMetaid || '').trim();
    const startIndex = Number(payload.startIndex || 0);
    const size = Number(payload.size || 50);
    const mergeMode = String(payload.mergeMode || 'replace').trim().toLowerCase();
    const shouldReplace = mergeMode !== 'prepend';

    if (!metaId || !otherMetaId) {
      throw new Error('metaId and otherMetaId are required');
    }

    const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
    if (!chatStore) {
      throw new Error('Chat store not available');
    }

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
        metaId: metaId,
        otherMetaId: otherMetaId,
        startIndex: String(Number.isFinite(startIndex) ? startIndex : 0),
        size: String(Number.isFinite(size) && size > 0 ? size : 50),
      }).toString();

      const response = await fetch(`${baseURL}/private-chat-list-by-index?${query}`, {
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
      const conversationKey = otherMetaId;

      const normalized = list
        .map((item) => this._normalizeMessage(item, conversationKey))
        .sort((a, b) => {
          const ai = Number(a.index || 0);
          const bi = Number(b.index || 0);
          if (ai !== bi) return ai - bi;
          return Number(a.timestamp || 0) - Number(b.timestamp || 0);
        });

      const existingRows = Array.isArray(chatStore.messages[conversationKey]) ? chatStore.messages[conversationKey] : [];
      const finalRows = shouldReplace ? normalized : this._mergeMessages(existingRows, normalized);

      Object.assign(chatStore.messages, {
        [conversationKey]: finalRows,
      });
      if (shouldReplace) {
        chatStore.isLoading = false;
        chatStore.error = null;
      }
      this._notifyChatUpdated();
      return finalRows;
    } catch (error) {
      if (shouldReplace) {
        chatStore.isLoading = false;
        chatStore.error = error.message || 'Failed to fetch private messages';
      }
      throw error;
    }
  }
}
