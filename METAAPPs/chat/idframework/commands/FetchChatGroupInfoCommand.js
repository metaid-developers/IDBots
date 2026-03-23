/**
 * FetchChatGroupInfoCommand
 * Fetches group detail info for chat right-side info panel.
 *
 * API Endpoint: /group-info
 * Method: GET
 * Query: groupId
 */

export default class FetchChatGroupInfoCommand {
  _toText(value) {
    return String(value || '').trim();
  }

  _extractPinId(text) {
    const raw = this._toText(text);
    if (!raw) return '';
    const match = raw.match(/([a-fA-F0-9]{64}i\d+)/);
    return match ? match[1] : '';
  }

  _normalizeAvatarReference(rawAvatar) {
    const avatar = this._toText(rawAvatar);
    if (!avatar) return '';
    if (/\/content\/?$/i.test(avatar)) return '';
    if (avatar.startsWith('metafile://')) return this._convertMetafileUrl(avatar);

    const pinId = this._extractPinId(avatar);
    if (!pinId) return avatar;
    if (/^\/content\//i.test(avatar)) return this._convertMetafileUrl(`metafile://${pinId}`);
    if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/content\//i.test(avatar)) {
      return this._convertMetafileUrl(`metafile://${pinId}`);
    }
    return avatar;
  }

  _convertMetafileUrl(metafileUrl) {
    const raw = this._toText(metafileUrl);
    if (!raw) return '';
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
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (!raw.startsWith('metafile://')) return raw;
    let pinId = raw.replace('metafile://', '').split('?')[0].split('#')[0];
    if (pinId.startsWith('video/') || pinId.startsWith('audio/') || pinId.startsWith('image/')) {
      pinId = pinId.split('/').slice(1).join('/');
    }
    pinId = pinId.replace(/\.[a-zA-Z0-9]{1,10}$/i, '');
    const metafsBase = window.ServiceLocator?.metafs || 'https://file.metaid.io/metafile-indexer/api/v1';
    return buildContentThumbnailUrl(metafsBase, pinId);
  }

  _ensureStoreShape(chatStore) {
    if (!chatStore.groupInfoById || typeof chatStore.groupInfoById !== 'object') {
      chatStore.groupInfoById = {};
    }
  }

  _normalizeGroupInfo(groupId, data) {
    const row = data && typeof data === 'object' ? data : {};
    return {
      groupId: this._toText(row.groupId || groupId),
      roomName: this._toText(row.roomName || row.name) || 'Group Chat',
      roomNote: this._toText(row.roomNote || ''),
      roomType: this._toText(row.roomType || ''),
      roomStatus: this._toText(row.roomStatus || ''),
      roomJoinType: this._toText(row.roomJoinType || ''),
      roomIcon: this._normalizeAvatarReference(row.roomIcon || row.roomAvatarUrl || ''),
      roomAvatarUrl: this._normalizeAvatarReference(row.roomAvatarUrl || row.roomIcon || ''),
      roomNewestProtocol: this._toText(row.roomNewestProtocol || ''),
      roomNewestContent: this._toText(row.roomNewestContent || ''),
      roomNewestUserName: this._toText(row.roomNewestUserName || ''),
      roomNewestGlobalMetaId: this._toText(row.roomNewestGlobalMetaId || ''),
      roomNewestMetaId: this._toText(row.roomNewestMetaId || ''),
      roomNewestTimestamp: Number(row.roomNewestTimestamp || 0),
      userCount: Number(row.userCount || 0),
      createUserGlobalMetaId: this._toText(row.createUserGlobalMetaId || ''),
      createUserMetaId: this._toText(row.createUserMetaId || ''),
      createUserAddress: this._toText(row.createUserAddress || ''),
      createUserInfo: row.createUserInfo && typeof row.createUserInfo === 'object' ? { ...row.createUserInfo } : null,
      timestamp: Number(row.timestamp || 0),
      chain: this._toText(row.chain || ''),
      index: Number(row.index || 0),
      _raw: row,
    };
  }

  async execute({ payload = {}, stores }) {
    const groupId = this._toText(payload.groupId || payload.id || '');
    if (!groupId) throw new Error('groupId is required');

    const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
    if (!chatStore) throw new Error('Chat store not available');
    this._ensureStoreShape(chatStore);

    const existing = chatStore.groupInfoById[groupId] && typeof chatStore.groupInfoById[groupId] === 'object'
      ? chatStore.groupInfoById[groupId]
      : {};
    chatStore.groupInfoById[groupId] = {
      ...existing,
      isLoading: true,
      error: '',
    };

    try {
      const baseURL = (window.ServiceLocator?.idchat || 'https://api.idchat.io/chat-api/group-chat').replace(/\/+$/, '');
      const endpoint = `/group-info?groupId=${encodeURIComponent(groupId)}`;
      const response = await fetch(`${baseURL}${endpoint}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      if (!response.ok) throw new Error(`API request failed: ${response.status} ${response.statusText}`);
      const json = await response.json();
      const data = json && typeof json === 'object' && json.data && typeof json.data === 'object'
        ? json.data
        : {};
      const normalized = this._normalizeGroupInfo(groupId, data);
      chatStore.groupInfoById[groupId] = {
        ...existing,
        ...normalized,
        isLoading: false,
        hasLoaded: true,
        error: '',
        loadedAt: Date.now(),
      };
      return chatStore.groupInfoById[groupId];
    } catch (error) {
      chatStore.groupInfoById[groupId] = {
        ...existing,
        isLoading: false,
        hasLoaded: true,
        error: error && error.message ? error.message : 'Failed to fetch group info',
      };
      throw error;
    }
  }
}
