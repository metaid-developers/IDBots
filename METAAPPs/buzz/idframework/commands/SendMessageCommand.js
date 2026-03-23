/**
 * SendMessageCommand
 * Handles sending a message in the chat application
 * Follows IDFramework Command Pattern
 * Currently mocks message sending (in production, this would broadcast to blockchain)
 */

export default class SendMessageCommand {
  /**
   * @param {Object} context
   * @param {Object} context.payload - Event detail { to, content }
   * @param {Object} context.store - Alpine.store access
   * @param {Object} context.delegate - IDFramework.Delegate
   */
  async execute({ payload, store, delegate }) {
    try {
      const { to, content } = payload;
      
      if (!to || !content || !content.trim()) {
        console.warn('SendMessageCommand: Missing to or content');
        return;
      }

      const chatStore = store('chat');
      const walletStore = store('wallet');
      
      if (!chatStore) {
        console.warn('SendMessageCommand: Chat store not available');
        return;
      }

      if (!walletStore || !walletStore.metaid) {
        console.warn('SendMessageCommand: Wallet not connected');
        alert('Please connect your wallet first');
        return;
      }

      // Create message object
      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        from: walletStore.metaid,
        to: to,
        content: content.trim(),
        timestamp: Date.now(),
        type: 'text',
      };

      // Initialize messages array if needed
      if (!chatStore.messages[to]) {
        chatStore.messages[to] = [];
      }

      // Add message to store
      chatStore.messages[to].push(message);

      // Update conversation
      if (!chatStore.conversations[to]) {
        chatStore.conversations[to] = {
          metaid: to,
          lastMessage: content.trim(),
          lastMessageTime: Date.now(),
          unreadCount: 0,
        };
      } else {
        chatStore.conversations[to].lastMessage = content.trim();
        chatStore.conversations[to].lastMessageTime = Date.now();
      }

      // Scroll to bottom of messages
      setTimeout(() => {
        const messagesContainer = document.getElementById('chat-messages');
        if (messagesContainer) {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      }, 100);

      // TODO: In production, this would:
      // 1. Use CreatePINCommand to broadcast message to blockchain
      // 2. Wait for confirmation
      // 3. Update UI with confirmed message

    } catch (error) {
      console.error('SendMessageCommand error:', error);
      const chatStore = store('chat');
      if (chatStore) {
        chatStore.error = error.message || 'Failed to send message';
      }
    }
  }
}

