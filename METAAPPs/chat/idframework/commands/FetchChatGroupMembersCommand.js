/**
 * FetchChatGroupMembersCommand
 * Fetches group members for chat group info panel.
 *
 * API Endpoints:
 * - /group-member-list
 * - /search-group-members
 */

export default class FetchChatGroupMembersCommand {
  _toText(value) {
    return String(value || '').trim();
  }

  _toNumber(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return n;
  }

  _extractPinId(text) {
    const raw = this._toText(text);
    if (!raw) return '';
    const match = raw.match(/([a-fA-F0-9]{64}i\d+)/);
    return match ? match[1] : '';
  }

  _convertMetafileUrl(metafileUrl) {
    const raw = this._toText(metafileUrl);
    if (!raw) return '';
    if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
    if (!raw.startsWith('metafile://')) return raw;
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

    let pinId = raw.replace('metafile://', '').split('?')[0].split('#')[0];
    if (pinId.startsWith('video/') || pinId.startsWith('audio/') || pinId.startsWith('image/')) {
      pinId = pinId.split('/').slice(1).join('/');
    }
    pinId = pinId.replace(/\.[a-zA-Z0-9]{1,10}$/i, '');
    const metafsBase = window.ServiceLocator?.metafs || 'https://file.metaid.io/metafile-indexer/api/v1';
    return buildAvatarUrl(metafsBase, pinId);
  }

  _normalizeAvatarReference(rawAvatar) {
    const avatar = this._toText(rawAvatar);
    if (!avatar) return '';
    if (/\/content\/?$/i.test(avatar)) return '';
    if (avatar.startsWith('metafile://')) return this._convertMetafileUrl(avatar);

    const pinId = this._extractPinId(avatar);
    if (!pinId) return avatar;
    if (/^\/content\//i.test(avatar)) return this._convertMetafileUrl(`metafile://${pinId}`);
    if (/^https?:\/\/file\.metaid\.io\/metafile-indexer\/(?:api\/v1\/files\/)?content\//i.test(avatar)) {
      return this._convertMetafileUrl(`metafile://${pinId}`);
    }
    return avatar;
  }

  _memberKey(member) {
    const row = member && typeof member === 'object' ? member : {};
    return this._toText(row.globalMetaId || row.metaId || row.address || '');
  }

  _createDefaultState() {
    return {
      list: [],
      total: 0,
      cursor: 0,
      size: 20,
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

  _ensureStoreShape(chatStore) {
    if (!chatStore.groupMembersById || typeof chatStore.groupMembersById !== 'object') {
      chatStore.groupMembersById = {};
    }
  }

  _normalizeMemberRow(raw) {
    const row = raw && typeof raw === 'object' ? raw : {};
    const userInfo = row.userInfo && typeof row.userInfo === 'object' ? row.userInfo : {};
    const globalMetaId = this._toText(
      row.globalMetaId ||
      userInfo.globalMetaId ||
      userInfo.globalmetaid ||
      ''
    );
    const metaId = this._toText(row.metaId || row.metaid || userInfo.metaid || userInfo.metaId || '');
    const address = this._toText(row.address || userInfo.address || '');
    const name = this._toText(row.name || userInfo.name || row.nickName || this._truncateIdentity(globalMetaId || metaId || address));
    const avatar = this._normalizeAvatarReference(
      row.avatarImage ||
      row.avatarUrl ||
      row.avatar ||
      userInfo.avatarImage ||
      userInfo.avatarUrl ||
      userInfo.avatar ||
      ''
    );

    return {
      globalMetaId: globalMetaId,
      metaId: metaId,
      address: address,
      name: name || 'Unknown User',
      avatar: avatar,
      timestamp: this._toNumber(row.timestamp, 0),
      timeStr: this._toText(row.timeStr || ''),
      userInfo: {
        ...userInfo,
        globalMetaId: this._toText(userInfo.globalMetaId || userInfo.globalmetaid || globalMetaId),
        metaid: this._toText(userInfo.metaid || userInfo.metaId || metaId),
        address: this._toText(userInfo.address || address),
        name: this._toText(userInfo.name || name),
        avatarImage: this._normalizeAvatarReference(userInfo.avatarImage || avatar),
        avatarUrl: this._normalizeAvatarReference(userInfo.avatarUrl || avatar),
        avatar: this._normalizeAvatarReference(userInfo.avatar || avatar),
      },
      _raw: row,
    };
  }

  _truncateIdentity(identity) {
    const raw = this._toText(identity);
    if (!raw) return '';
    if (raw.length <= 16) return raw;
    return `${raw.slice(0, 8)}...${raw.slice(-4)}`;
  }

  _mergeUniqueMembers(existingList, incomingList) {
    const merged = [];
    const byKey = new Map();

    const visit = (member) => {
      const key = this._memberKey(member);
      if (!key) return;
      if (!byKey.has(key)) {
        byKey.set(key, member);
        merged.push(member);
        return;
      }
      const prev = byKey.get(key);
      const next = { ...prev, ...member };
      byKey.set(key, next);
      const idx = merged.findIndex((item) => this._memberKey(item) === key);
      if (idx >= 0) merged[idx] = next;
    };

    (Array.isArray(existingList) ? existingList : []).forEach(visit);
    (Array.isArray(incomingList) ? incomingList : []).forEach(visit);
    return merged;
  }

  async _warmUserStoreMembers(list) {
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;
    const rows = Array.isArray(list) ? list : [];
    rows.forEach((member) => {
      const row = member && typeof member === 'object' ? member : {};
      const globalMetaId = this._toText(row.globalMetaId);
      const metaId = this._toText(row.metaId);
      if (globalMetaId) {
        window.IDFramework.dispatch('fetchUser', { globalMetaId }).catch(() => {});
        return;
      }
      if (metaId) {
        window.IDFramework.dispatch('fetchUser', { metaid: metaId }).catch(() => {});
      }
    });
  }

  async execute({ payload = {}, stores }) {
    const groupId = this._toText(payload.groupId || payload.id || '');
    if (!groupId) throw new Error('groupId is required');

    const query = this._toText(payload.query || '');
    const append = payload.append === true;
    const cursor = Math.max(0, Math.floor(this._toNumber(payload.cursor, 0)));
    const size = Math.max(1, Math.min(100, Math.floor(this._toNumber(payload.size, 30))));
    const orderBy = this._toText(payload.orderBy || 'timestamp') || 'timestamp';
    const orderType = this._toText(payload.orderType || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';

    const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
    if (!chatStore) throw new Error('Chat store not available');
    this._ensureStoreShape(chatStore);

    const existingState = chatStore.groupMembersById[groupId] && typeof chatStore.groupMembersById[groupId] === 'object'
      ? chatStore.groupMembersById[groupId]
      : this._createDefaultState();

    chatStore.groupMembersById[groupId] = {
      ...existingState,
      isLoading: true,
      error: '',
      query: query,
      mode: query ? 'search' : 'list',
      size: size,
    };

    try {
      const baseURL = (window.ServiceLocator?.idchat || 'https://api.idchat.io/chat-api/group-chat').replace(/\/+$/, '');
      let endpoint = '';
      let members = [];
      let total = 0;
      let nextCursor = 0;
      let hasMore = false;
      let creator = existingState.creator || null;
      let admins = Array.isArray(existingState.admins) ? existingState.admins.slice() : [];
      let whiteList = Array.isArray(existingState.whiteList) ? existingState.whiteList.slice() : [];
      let blockList = Array.isArray(existingState.blockList) ? existingState.blockList.slice() : [];

      if (query) {
        const searchQuery = new URLSearchParams({
          groupId: groupId,
          size: String(size),
          query: query,
        }).toString();
        endpoint = `/search-group-members?${searchQuery}`;
        const response = await fetch(`${baseURL}${endpoint}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        const json = await response.json();
        const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
        members = list.map((item) => this._normalizeMemberRow(item));
        total = this._toNumber((json && json.data && json.data.total) || list.length || 0, 0);
        if (total <= 0) total = members.length;
        nextCursor = members.length;
        hasMore = false;
      } else {
        const listQuery = new URLSearchParams({
          groupId: groupId,
          cursor: String(cursor),
          size: String(size),
          timestamp: '0',
          orderBy: orderBy,
          orderType: orderType,
        }).toString();
        endpoint = `/group-member-list?${listQuery}`;
        const response = await fetch(`${baseURL}${endpoint}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) throw new Error(`API request failed: ${response.status} ${response.statusText}`);
        const json = await response.json();
        const data = json && json.data && typeof json.data === 'object' ? json.data : {};
        const list = Array.isArray(data.list) ? data.list : [];
        members = list.map((item) => this._normalizeMemberRow(item));
        total = this._toNumber(data.total, 0);
        if (total <= 0) total = members.length;
        nextCursor = cursor + members.length;
        hasMore = nextCursor < total;
        creator = data.creator ? this._normalizeMemberRow(data.creator) : null;
        admins = Array.isArray(data.admins) ? data.admins.map((item) => this._normalizeMemberRow(item)) : [];
        whiteList = Array.isArray(data.whiteList) ? data.whiteList.map((item) => this._normalizeMemberRow(item)) : [];
        blockList = Array.isArray(data.blockList) ? data.blockList.map((item) => this._normalizeMemberRow(item)) : [];
      }

      const finalList = append && !query
        ? this._mergeUniqueMembers(existingState.list, members)
        : members;

      chatStore.groupMembersById[groupId] = {
        ...existingState,
        list: finalList,
        total: total,
        cursor: nextCursor,
        hasMore: hasMore,
        isLoading: false,
        hasLoaded: true,
        error: '',
        query: query,
        mode: query ? 'search' : 'list',
        size: size,
        creator: creator,
        admins: admins,
        whiteList: whiteList,
        blockList: blockList,
        loadedAt: Date.now(),
      };

      await this._warmUserStoreMembers(finalList);
      return chatStore.groupMembersById[groupId];
    } catch (error) {
      chatStore.groupMembersById[groupId] = {
        ...existingState,
        isLoading: false,
        hasLoaded: true,
        error: error && error.message ? error.message : 'Failed to fetch group members',
        query: query,
        mode: query ? 'search' : 'list',
      };
      throw error;
    }
  }
}
