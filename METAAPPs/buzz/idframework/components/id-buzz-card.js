/**
 * id-buzz-card - Web Component for displaying a Buzz card
 * Uses Shadow DOM with CSS Variables for theming
 * Structure (Layout) managed via CSS, Skin (Theme) managed via CSS Variables
 */

class IdBuzzCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['content', 'author', 'txid', 'metaid'];
  }

  connectedCallback() {
    // Use requestAnimationFrame to ensure attributes are set
    requestAnimationFrame(() => {
      this.render();
      
      // Listen to Alpine store changes for user data
      if (typeof Alpine !== 'undefined' && Alpine.store('user')) {
        const metaid = this.getAttribute('metaid') || this.getAttribute('author');
        if (metaid) {
          this._watchUserStore(metaid);
        }
      }
    });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    // Always render when any observed attribute changes
    if (oldValue !== newValue) {
      // Use requestAnimationFrame to batch updates
      if (!this._renderScheduled) {
        this._renderScheduled = true;
        requestAnimationFrame(() => {
          this._renderScheduled = false;
          this.render();
        });
      }
      
      // If metaid or author changed, update user store watcher
      if ((name === 'metaid' || name === 'author') && typeof Alpine !== 'undefined' && Alpine.store('user')) {
        const metaid = this.getAttribute('metaid') || this.getAttribute('author');
        if (metaid && this._checkInterval) {
          // Restart watcher with new metaid
          clearInterval(this._checkInterval);
          this._watchUserStore(metaid);
        }
      }
    }
  }

  render() {
    const content = this.getAttribute('content') || '';
    const author = this.getAttribute('author') || 'unknown';
    const txid = this.getAttribute('txid') || '';
    const metaid = this.getAttribute('metaid') || author; // Use author as fallback for metaid

    // Get user info from Alpine store
    let userInfo = null;
    if (typeof Alpine !== 'undefined' && Alpine.store('user')) {
      const userStore = Alpine.store('user');
      userInfo = userStore.users[metaid] || null;
      
      if (!userInfo && metaid && metaid !== 'unknown') {
        // User info not loaded yet - trigger fetch
        // This ensures user info is fetched even if FetchBuzzCommand didn't trigger it
        if (window.IDFramework) {
          window.IDFramework.dispatch('fetchUser', { metaid }).catch(err => {
            console.warn(`[id-buzz-card] Failed to fetch user info for ${metaid}:`, err);
          });
        }
      }
    } else {
      console.warn(`[id-buzz-card] Alpine or user store not available`);
    }

    // Extract user display data
    const userName = userInfo?.name || '';
    const userAvatar = userInfo?.avatarUrl || null; // Use avatarUrl instead of avatarImg
    const displayMetaId = metaid;

    // Create card HTML with CSS Variables for theming
    // Structure (Layout) via CSS, Skin (Theme) via CSS Variables
    this.shadowRoot.innerHTML = `
      <style>
        /* Host element styling */
        :host {
          display: block;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif);
        }

        /* Card Container - Main wrapper with part attribute for external styling */
        .card-container {
          /* Structure: Layout */
          display: flex;
          flex-direction: column;
          padding: var(--id-card-padding, 1rem);
          margin-bottom: var(--id-card-margin-bottom, 1rem);
          
          /* Skin: Theme via CSS Variables with fallbacks */
          background-color: var(--id-bg-card, #ffffff);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: var(--id-radius-card, 0.5rem);
          box-shadow: var(--id-shadow-sm, 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06));
          
          /* Transitions */
          transition: box-shadow var(--id-transition-base, 0.2s);
        }

        .card-container:hover {
          box-shadow: var(--id-shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06));
        }

        /* User Info Section - Top of card */
        .user-info {
          /* Structure: Layout */
          display: flex;
          align-items: center;
          gap: var(--id-spacing-md, 0.75rem);
          margin-bottom: var(--id-spacing-md, 0.75rem);
          padding-bottom: var(--id-spacing-md, 0.75rem);
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
        }

        /* Avatar */
        .avatar {
          /* Structure: Layout */
          width: 48px;
          height: 48px;
          border-radius: 50%;
          flex-shrink: 0;
          object-fit: cover;
          background-color: var(--id-bg-body, #f9fafb);
          border: 2px solid var(--id-border-color, #e5e7eb);
        }

        .avatar-placeholder {
          /* Structure: Layout */
          width: 48px;
          height: 48px;
          border-radius: 50%;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: var(--id-font-size-lg, 1.125rem);
          font-weight: var(--id-font-weight-bold, 700);
          
          /* Skin: Theme */
          background-color: var(--id-bg-body, #f9fafb);
          border: 2px solid var(--id-border-color, #e5e7eb);
          color: var(--id-text-secondary, #6b7280);
        }

        /* User Details */
        .user-details {
          /* Structure: Layout */
          display: flex;
          flex-direction: column;
          flex: 1;
          min-width: 0;
          gap: var(--id-spacing-xs, 0.25rem);
        }

        .user-name {
          /* Structure: Layout */
          font-size: var(--id-font-size-base, 1rem);
          font-weight: var(--id-font-weight-bold, 700);
          line-height: var(--id-line-height-tight, 1.5);
          
          /* Skin: Theme */
          color: var(--id-text-main, #1f2937);
          cursor: pointer;
        }

        .avatar,
        .avatar-placeholder {
          cursor: pointer;
        }

        .user-metaid {
          /* Structure: Layout */
          font-size: var(--id-font-size-sm, 0.875rem);
          font-family: monospace;
          line-height: var(--id-line-height-tight, 1.5);
          word-break: break-all;
          
          /* Skin: Theme */
          color: var(--id-text-secondary, #6b7280);
        }

        /* Content Section */
        .content {
          /* Structure: Layout */
          display: block;
          margin-bottom: var(--id-spacing-md, 0.75rem);
          line-height: var(--id-line-height-tight, 1.5);
          word-wrap: break-word;
          
          /* Skin: Theme */
          color: var(--id-text-main, #1f2937);
          font-size: var(--id-font-size-base, 1rem);
        }

        /* Meta Section - TXID */
        .meta {
          /* Structure: Layout */
          display: flex;
          justify-content: flex-end;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          
          /* Skin: Theme */
          font-size: var(--id-font-size-sm, 0.875rem);
          color: var(--id-text-secondary, #6b7280);
        }

        /* Transaction ID */
        .txid {
          /* Structure: Layout */
          font-family: monospace;
          font-size: var(--id-font-size-xs, 0.75rem);
          word-break: break-all;
          flex-shrink: 1;
          min-width: 0;
          
          /* Skin: Theme */
          color: var(--id-text-tertiary, #9ca3af);
        }
      </style>
      <div part="card-container" class="card-container">
        <!-- User Info Section -->
        <div class="user-info">
          ${userAvatar ? `
            <img class="avatar hoverable-user" data-metaid="${this.escapeHtml(displayMetaId)}" src="${this.escapeHtml(userAvatar)}" alt="${this.escapeHtml(userName || 'User')}" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
            <div class="avatar-placeholder hoverable-user" data-metaid="${this.escapeHtml(displayMetaId)}" style="display: none;">
              ${userName ? userName.charAt(0).toUpperCase() : (displayMetaId ? displayMetaId.charAt(0).toUpperCase() : '?')}
            </div>
          ` : `
            <div class="avatar-placeholder hoverable-user" data-metaid="${this.escapeHtml(displayMetaId)}">
              ${userName ? userName.charAt(0).toUpperCase() : (displayMetaId ? displayMetaId.charAt(0).toUpperCase() : '?')}
            </div>
          `}
          <div class="user-details">
            <div class="user-name hoverable-user" data-metaid="${this.escapeHtml(displayMetaId)}">${this.escapeHtml(userName || 'Unknown User')}</div>
            <div class="user-metaid" title="${this.escapeHtml(displayMetaId)}">${this.truncateMetaId(displayMetaId)}</div>
          </div>
        </div>
        
        <!-- Content Section -->
        <div class="content">${this.escapeHtml(content)}</div>
        
        <!-- Meta Section - TXID -->
        <div class="meta">
          <span class="txid" title="${this.escapeHtml(txid)}">${this.truncateTxid(txid)}</span>
        </div>
      </div>
    `;

    // Attach hover event listeners after rendering
    this._attachHoverListeners();
  }

  /**
   * Attach hover event listeners to avatar and user name
   */
  _attachHoverListeners() {
    const hoverableElements = this.shadowRoot.querySelectorAll('.hoverable-user');
    const floatPanel = document.querySelector('id-userinfo-float-panel');
    
    if (!floatPanel) {
      // Panel might not be loaded yet, try again later
      setTimeout(() => this._attachHoverListeners(), 100);
      return;
    }

    let hideTimeout = null;

    hoverableElements.forEach(element => {
      const metaid = element.getAttribute('data-metaid');
      if (!metaid) return;

      // Mouse enter - show panel
      element.addEventListener('mouseenter', (e) => {
        // Clear any pending hide timeout
        if (hideTimeout) {
          clearTimeout(hideTimeout);
          hideTimeout = null;
        }

        const rect = element.getBoundingClientRect();
        const panelTop = rect.bottom + 10; // 10px gap below element
        let panelLeft = rect.left;
        
        // Adjust position if panel would go off-screen
        const panelWidth = 320; // Panel width from CSS
        if (panelLeft + panelWidth > window.innerWidth) {
          panelLeft = window.innerWidth - panelWidth - 10;
        }
        if (panelLeft < 10) {
          panelLeft = 10;
        }

        floatPanel.setAttribute('metaid', metaid);
        floatPanel.setAttribute('visible', 'true');
        floatPanel.setAttribute('top', panelTop.toString());
        floatPanel.setAttribute('left', panelLeft.toString());
      });

      // Mouse leave - hide panel with delay to allow moving to panel
      element.addEventListener('mouseleave', () => {
        // Delay hiding to allow user to move mouse to panel
        hideTimeout = setTimeout(() => {
          floatPanel.setAttribute('visible', 'false');
          hideTimeout = null;
        }, 200);
      });
    });

    // Also handle mouse enter/leave on the float panel itself
    if (floatPanel.shadowRoot) {
      const panelElement = floatPanel.shadowRoot.querySelector('.float-panel');
      if (panelElement) {
        panelElement.addEventListener('mouseenter', () => {
          // Clear hide timeout when mouse enters panel
          if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
          }
        });

        panelElement.addEventListener('mouseleave', () => {
          floatPanel.setAttribute('visible', 'false');
        });
      }
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  truncateTxid(txid) {
    if (!txid || txid.length <= 12) return txid;
    return `${txid.substring(0, 6)}...${txid.substring(txid.length - 6)}`;
  }

  truncateMetaId(metaid) {
    if (!metaid || metaid.length <= 12) return metaid;
    return `${metaid.substring(0, 6)}...${metaid.substring(metaid.length - 4)}`;
  }

  _watchUserStore(metaid) {
    // Watch for user data updates in the store
    // Since we can't directly observe Alpine stores from Web Components,
    // we'll use a periodic check to detect when user data becomes available
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
    }
    
    const checkInterval = setInterval(() => {
      if (typeof Alpine !== 'undefined' && Alpine.store('user')) {
        const userStore = Alpine.store('user');
        const currentUserData = userStore.users[metaid];
        
        if (currentUserData) {
          // Check if this is new data or updated data
          const dataChanged = !this._lastUserData || 
                             JSON.stringify(this._lastUserData) !== JSON.stringify(currentUserData);
          
          if (dataChanged) {
            this._lastUserData = currentUserData;
            this.render();
          }
        }
      }
    }, 300); // Check every 300ms for faster updates

    // Clean up interval when component is disconnected
    this._checkInterval = checkInterval;
  }

  disconnectedCallback() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }
}

// Register the custom element
customElements.define('id-buzz-card', IdBuzzCard);
