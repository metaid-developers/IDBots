/**
 * SelectConversationCommand
 * Handles selecting a conversation in the chat application
 * Follows IDFramework Command Pattern
 */

export default class SelectConversationCommand {
  _toSafeIndex(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  _computeRecentWindowStart(rawIndex, size) {
    const lastIndex = this._toSafeIndex(rawIndex);
    const pageSize = Number.isFinite(Number(size)) && Number(size) > 0 ? Math.floor(Number(size)) : 50;
    if (lastIndex <= 0) return 0;
    return Math.max(1, lastIndex - (pageSize - 1));
  }

  _maxLocalMessageIndex(chatStore, conversationKey) {
    const key = String(conversationKey || '').trim();
    if (!key || !chatStore || !chatStore.messages || typeof chatStore.messages !== 'object') return 0;
    const rows = Array.isArray(chatStore.messages[key]) ? chatStore.messages[key] : [];
    return rows.reduce((max, row) => {
      const idx = this._toSafeIndex(row && row.index);
      return idx > max ? idx : max;
    }, 0);
  }

  _resolveConversationIndexForSelection(rawIndex, chatStore, conversationKey, existingConversation) {
    const payloadIndex = this._toSafeIndex(rawIndex);
    if (payloadIndex > 0) return payloadIndex;

    const row = existingConversation && typeof existingConversation === 'object'
      ? existingConversation
      : (chatStore && chatStore.conversations && typeof chatStore.conversations === 'object'
        ? chatStore.conversations[String(conversationKey || '').trim()]
        : null);
    const existingIndex = this._toSafeIndex(row && row.index);
    if (existingIndex > 0) return existingIndex;

    const localMax = this._maxLocalMessageIndex(chatStore, conversationKey);
    if (localMax > 0) return localMax;

    return 0;
  }

  _recoverMissingIndexAndPrefetch(chatStore, conversationKey, pageSize, fetchFn) {
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;
    window.IDFramework.dispatch('fetchChatList', { background: true })
      .then(() => {
        if (!chatStore || String(chatStore.currentConversation || '') !== String(conversationKey || '')) return;
        const recovered = this._resolveConversationIndexForSelection(0, chatStore, conversationKey);
        if (recovered <= 0) return;
        fetchFn(recovered);
      })
      .catch(() => {});
  }

  /**
   * Generate mock messages for testing
   * @param {string} groupId - Group ID
   * @param {number} count - Number of messages to generate
   * @returns {Array} - Array of mock message objects
   */
  _generateMockMessages(groupId, count) {
    const mockMessages = [];
    const now = Math.floor(Date.now() / 1000); // Current time in seconds
    
    // Sample user names and avatars
    const sampleUsers = [
      { name: 'Alice', metaid: 'alice123', avatar: null },
      { name: 'Bob', metaid: 'bob456', avatar: null },
      { name: 'Charlie', metaid: 'charlie789', avatar: null },
      { name: 'Diana', metaid: 'diana012', avatar: null },
      { name: 'Eve', metaid: 'eve345', avatar: null },
      { name: 'Frank', metaid: 'frank678', avatar: null },
      { name: 'Grace', metaid: 'grace901', avatar: null },
      { name: 'Henry', metaid: 'henry234', avatar: null },
    ];
    
    // Sample message contents
    const sampleMessages = [
      'Hello everyone! 👋',
      'How is everyone doing today?',
      'This is a test message',
      '2026年MetalID必火 🔥🔥🔥',
      'Great to see you all here!',
      'Let\'s discuss the project',
      'I have an idea to share',
      'What do you think about this?',
      'Thanks for the update!',
      'Looking forward to the next meeting',
      'Can someone help me with this?',
      'I agree with that point',
      'Let me check and get back to you',
      'That sounds like a good plan',
      'We should schedule a call',
    ];
    
    for (let i = 0; i < count; i++) {
      const user = sampleUsers[Math.floor(Math.random() * sampleUsers.length)];
      const message = sampleMessages[Math.floor(Math.random() * sampleMessages.length)];
      
      // Generate timestamp (spread over last 7 days, newest first)
      const daysAgo = Math.random() * 7;
      const hoursAgo = Math.random() * 24;
      const timestamp = now - (daysAgo * 24 * 60 * 60) - (hoursAgo * 60 * 60);
      
      mockMessages.push({
        id: `${groupId}_mock_${i}`,
        groupId: groupId,
        content: message,
        timestamp: timestamp,
        userInfo: {
          metaid: user.metaid,
          name: user.name,
          avatarImage: user.avatar,
        },
        index: count - i - 1, // Reverse index (newest has highest index)
        _raw: { mock: true },
      });
    }
    
    // Sort by timestamp (oldest first)
    return mockMessages.sort((a, b) => a.timestamp - b.timestamp);
  }
  /**
   * @param {Object} context
   * @param {Object} context.payload - Event detail { metaid, groupId, type, index }
   * @param {Object} context.stores - Alpine stores object (wallet, chat, user, etc.)
   * @param {Object} context.delegate - IDFramework.Delegate
   */
  async execute({ payload, stores, delegate }) {
    try {
      const { metaid, globalMetaId, groupId, type, index } = payload;
      
      // Get stores
      const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
      if (!chatStore) {
        console.warn('SelectConversationCommand: Chat store not available');
        return;
      }

      // Determine if this is a group chat (type=1) or private chat (type=2)
      const isGroupChat = String(type) === '1';
      const privateTargetId = String(globalMetaId || metaid || '').trim();
      const conversationKey = isGroupChat ? (groupId || metaid) : privateTargetId;

      if (!conversationKey) {
        console.warn('SelectConversationCommand: No conversation key provided');
        return;
      }
      const existingConversation = chatStore.conversations[conversationKey] || null;
      const resolvedGroupId = String(
        groupId ||
        (existingConversation && existingConversation.groupId) ||
        conversationKey
      ).trim();

      // Update current conversation
      const normalizedIndex = this._resolveConversationIndexForSelection(
        index,
        chatStore,
        conversationKey,
        existingConversation
      );
      chatStore.currentConversation = conversationKey;
      chatStore.currentConversationId = conversationKey; // For compatibility
      chatStore.currentConversationType = String(type || '2'); // Store type for later use (ensure it's a string)
      chatStore.currentConversationIndex = normalizedIndex; // Store index for fetching messages
      if (chatStore.useCommandMessageFetch === undefined) {
        chatStore.useCommandMessageFetch = true;
      }
      

      // Ensure conversation exists in conversations list
      if (!chatStore.conversations[conversationKey]) {
        chatStore.conversations[conversationKey] = {
          metaid: conversationKey,
          groupId: isGroupChat ? (resolvedGroupId || null) : null,
          type: type || '2',
          index: normalizedIndex,
          lastMessage: null,
          lastMessageTime: null,
          unreadCount: 0,
        };
      } else if (normalizedIndex > 0) {
        chatStore.conversations[conversationKey].index = normalizedIndex;
      }

      // Reset unread count for selected conversation
      chatStore.conversations[conversationKey].unreadCount = 0;
      const shouldPrefetchMessages = chatStore.useCommandMessageFetch !== false;

      // Ensure messages array exists for this conversation
      if (!chatStore.messages[conversationKey]) {
        chatStore.messages[conversationKey] = [];
      }

      // For group chats, fetch messages from API
      if (shouldPrefetchMessages && isGroupChat && resolvedGroupId) {
        const pageSize = 50;
        const dispatchGroupFetch = (lastIndex) => {
          if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') return;
          window.IDFramework.dispatch('fetchGroupMessages', {
            groupId: resolvedGroupId,
            startIndex: this._computeRecentWindowStart(lastIndex, pageSize),
            size: pageSize,
          }).catch(err => {
            console.warn(`Failed to fetch group messages for ${resolvedGroupId}:`, err);
          });
        };
        if (normalizedIndex > 0) {
          dispatchGroupFetch(normalizedIndex);
        } else {
          this._recoverMissingIndexAndPrefetch(chatStore, conversationKey, pageSize, dispatchGroupFetch);
        }
      }

      // For private chats, fetch private messages by index
      if (shouldPrefetchMessages && !isGroupChat && privateTargetId) {
        const pageSize = 50;
        const walletStore = stores?.wallet || (typeof Alpine !== 'undefined' ? Alpine.store('wallet') : null);
        const selfMetaId = String(
          (walletStore && (walletStore.globalMetaId || walletStore.metaid)) || ''
        ).trim();
        const dispatchPrivateFetch = (lastIndex) => {
          if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function' || !selfMetaId) return;
          window.IDFramework.dispatch('fetchPrivateMessages', {
            metaId: selfMetaId,
            otherMetaId: privateTargetId,
            startIndex: this._computeRecentWindowStart(lastIndex, pageSize),
            size: pageSize,
          }).catch((err) => {
            console.warn(`Failed to fetch private messages for ${privateTargetId}:`, err);
          });
        };
        if (normalizedIndex > 0) {
          dispatchPrivateFetch(normalizedIndex);
        } else if (selfMetaId) {
          this._recoverMissingIndexAndPrefetch(chatStore, conversationKey, pageSize, dispatchPrivateFetch);
        }
      }

      // For private chats, fetch user info if not already loaded
      if (!isGroupChat && privateTargetId) {
        const userStore = stores?.user || (typeof Alpine !== 'undefined' ? Alpine.store('user') : null);
        if (userStore && !userStore.users[privateTargetId]) {
          // Dispatch fetchUser command
          if (window.IDFramework) {
            window.IDFramework.dispatch('fetchUser', {
              ...(globalMetaId ? { globalMetaId: String(globalMetaId).trim() } : {}),
              ...(metaid ? { metaid: String(metaid).trim() } : {}),
            }).catch(err => {
              console.warn(`Failed to fetch user info for ${privateTargetId}:`, err);
            });
          }
        }
      }

      // Scroll to bottom of messages
      if (typeof document !== 'undefined') {
        setTimeout(() => {
          const messagesContainer = document.getElementById('chat-messages');
          if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }
        }, 100);
        try {
          document.dispatchEvent(new CustomEvent('id:chat:updated'));
        } catch (_) {}
      }

    } catch (error) {
      console.error('SelectConversationCommand error:', error);
      const chatStore = stores?.chat || (typeof Alpine !== 'undefined' ? Alpine.store('chat') : null);
      if (chatStore) {
        chatStore.error = error.message || 'Failed to select conversation';
      }
    }
  }
}
