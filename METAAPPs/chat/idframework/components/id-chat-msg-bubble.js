/**
 * id-chat-msg-bubble
 * Message bubble component for chat messages
 * Displays user avatar, name, timestamp, and message content
 * 
 * Attributes:
 * - content: Message content text
 * - user-name: User display name
 * - user-avatar: User avatar URL
 * - timestamp: Message timestamp (Unix timestamp in seconds)
 * - is-own: Whether this is the current user's message (optional)
 */

class IdChatMsgBubble extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['content', 'user-name', 'user-avatar', 'timestamp', 'is-own'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    this.render();
  }

  /**
   * Format timestamp to "年/月/日 时:分" format
   * @param {number} timestamp - Unix timestamp in seconds
   * @returns {string} - Formatted date string
   */
  formatTimestamp(timestamp) {
    if (!timestamp) return '';
    
    const date = new Date(timestamp * 1000); // Convert seconds to milliseconds
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${year}/${month}/${day} ${hours}:${minutes}`;
  }

  render() {
    const content = this.getAttribute('content') || '';
    const userName = this.getAttribute('user-name') || 'Unknown';
    const userAvatar = this.getAttribute('user-avatar') || null;
    const timestamp = this.getAttribute('timestamp');
    const isOwn = this.getAttribute('is-own') === 'true';
    
    const formattedTime = this.formatTimestamp(parseInt(timestamp));
    const iconLetter = userName.charAt(0).toUpperCase();

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
        }

        .message-bubble {
          display: flex;
          gap: 0.5rem;
          padding: 0.25rem 0.5rem;
          margin-bottom: 0;
        }

        .message-bubble.own {
          flex-direction: row-reverse;
        }

        .message-avatar {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          flex-shrink: 0;
          overflow: hidden;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.875rem;
          font-weight: 600;
          color: #ffffff;
        }

        .message-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .message-content-wrapper {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          max-width: calc(100% - 60px);
        }

        .message-header {
          display: flex;
          align-items: center;
          gap: var(--id-spacing-xs, 0.25rem);
          font-size: 0.875rem;
        }

        .message-bubble.own .message-header {
          flex-direction: row-reverse;
        }

        .message-user-name {
          font-weight: 500;
          color: #6ab7ff; /* Telegram username color */
          font-size: 0.875rem;
        }

        .message-bubble.own .message-user-name {
          color: #ffffff;
        }

        .message-timestamp {
          color: #708499; /* Telegram timestamp color */
          font-size: 0.75rem;
          margin-left: 0.5rem;
        }

        .message-bubble.own .message-timestamp {
          color: rgba(255, 255, 255, 0.7);
        }

        .message-bubble-content {
          background-color: #182533; /* Telegram message background */
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          color: #e4edfd; /* Telegram text color */
          word-wrap: break-word;
          word-break: break-word;
          line-height: 1.4;
          max-width: 70%;
          position: relative;
        }

        .message-bubble.own .message-bubble-content {
          background-color: #2b5278; /* Telegram own message background */
          color: #ffffff;
          margin-left: auto;
        }

        @media (prefers-color-scheme: dark) {
          .message-bubble-content {
            background-color: var(--id-bg-card-dark, #1f2937);
            color: var(--id-text-main-dark, #f9fafb);
          }

          .message-user-name {
            color: var(--id-text-main-dark, #f9fafb);
          }
        }
      </style>
      
      <div part="message-container" class="message-bubble ${isOwn ? 'own' : ''}">
        <div class="message-avatar">
          ${userAvatar ? `
            <img src="${this.escapeHtml(userAvatar)}" alt="${this.escapeHtml(userName)}" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <span style="display: none;">${iconLetter}</span>
          ` : `
            <span>${iconLetter}</span>
          `}
        </div>
        <div class="message-content-wrapper">
          <div class="message-header">
            <span class="message-user-name">${this.escapeHtml(userName)}</span>
            ${formattedTime ? `<span class="message-timestamp">${this.escapeHtml(formattedTime)}</span>` : ''}
          </div>
          <div class="message-bubble-content">
            ${this.escapeHtml(content)}
          </div>
        </div>
      </div>
    `;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Auto-register
if (!customElements.get('id-chat-msg-bubble')) {
  customElements.define('id-chat-msg-bubble', IdChatMsgBubble);
}

export default IdChatMsgBubble;

