/**
 * id-userinfo-float-panel - Web Component for displaying user info in a floating panel
 * Triggered on hover over user avatar or name
 * Uses Shadow DOM with CSS Variables for theming
 * Follows IDFramework MVC pattern - View layer only, no business logic
 */

class IdUserinfoFloatPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._metaid = null;
    this._position = { top: 0, left: 0 };
    this._visible = false;
  }

  static get observedAttributes() {
    return ['metaid', 'visible', 'top', 'left'];
  }

  connectedCallback() {
    requestAnimationFrame(() => {
      this.render();
      this._watchUserStore();
    });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      if (name === 'metaid') {
        this._metaid = newValue;
        this._watchUserStore();
      } else if (name === 'visible') {
        this._visible = newValue === 'true';
      } else if (name === 'top' || name === 'left') {
        this._position[name] = parseFloat(newValue) || 0;
      }
      
      if (!this._renderScheduled) {
        this._renderScheduled = true;
        requestAnimationFrame(() => {
          this._renderScheduled = false;
          this.render();
        });
      }
    }
  }

  /**
   * Watch Alpine store for user data changes
   */
  _watchUserStore() {
    if (!this._metaid) return;

    if (typeof Alpine !== 'undefined' && Alpine.store('user')) {
      const userStore = Alpine.store('user');
      const currentUserData = userStore.users[this._metaid];

      if (currentUserData) {
        this.render();
      }
    }
  }

  /**
   * Render the component
   */
  render() {
    const metaid = this.getAttribute('metaid') || this._metaid;
    const visible = this.getAttribute('visible') === 'true' || this._visible;
    const top = this.getAttribute('top') || this._position.top || 0;
    const left = this.getAttribute('left') || this._position.left || 0;

    // Get user info from Alpine store
    let userInfo = null;
    if (typeof Alpine !== 'undefined' && Alpine.store('user') && metaid) {
      const userStore = Alpine.store('user');
      userInfo = userStore.users[metaid] || null;
    }

    // Extract user display data
    const userName = userInfo?.name || '';
    const userAvatar = userInfo?.avatarUrl || null;
    const displayMetaId = metaid || '';
    const address = userInfo?.address || '';
    
    // Mock data for missing fields (following X profile layout)
    const bio = userInfo?.bio || 'MetaID Protocol User'; // Mock bio
    const following = userInfo?.following || 0; // Mock following count
    const followers = userInfo?.followers || 0; // Mock followers count
    const isVerified = userInfo?.isVerified || false; // Mock verification status

    // Create panel HTML with CSS Variables for theming
    this.shadowRoot.innerHTML = `
      <style>
        /* Theme Mapping - Using Global CSS Variables */
        .float-panel {
          position: fixed;
          top: ${top}px;
          left: ${left}px;
          z-index: 1000;
          display: ${visible ? 'block' : 'none'};
          
          /* Structure: Layout */
          width: 320px;
          padding: var(--id-spacing-md, 1rem);
          border-radius: var(--id-radius-card, 0.5rem);
          
          /* Skin: Theme */
          background-color: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
          box-shadow: var(--id-shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05));
          border: 1px solid var(--id-border-color, #e5e7eb);
        }

        .user-header {
          display: flex;
          align-items: flex-start;
          gap: var(--id-spacing-sm, 0.5rem);
          margin-bottom: var(--id-spacing-md, 1rem);
        }

        .avatar-container {
          flex-shrink: 0;
        }

        .avatar,
        .avatar-placeholder {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          object-fit: cover;
        }

        .avatar-placeholder {
          display: flex;
          align-items: center;
          justify-content: center;
          background-color: var(--id-bg-button-disabled, #9ca3af);
          color: var(--id-text-inverse, #ffffff);
          font-size: 1.5rem;
          font-weight: bold;
        }

        .user-info {
          flex: 1;
          min-width: 0;
        }

        .user-name-row {
          display: flex;
          align-items: center;
          gap: var(--id-spacing-xs, 0.25rem);
          margin-bottom: 0.25rem;
        }

        .user-name {
          font-size: 1.125rem;
          font-weight: bold;
          color: var(--id-text-title, #111827);
        }

        .verified-badge {
          width: 18px;
          height: 18px;
          display: inline-block;
          background-color: var(--id-color-primary, #3b82f6);
          border-radius: 50%;
          position: relative;
        }

        .verified-badge::after {
          content: '✓';
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          color: white;
          font-size: 12px;
          font-weight: bold;
        }

        .user-handle {
          font-size: 0.875rem;
          color: var(--id-text-secondary, #6b7280);
          margin-bottom: var(--id-spacing-sm, 0.5rem);
        }

        .user-bio {
          font-size: 0.875rem;
          color: var(--id-text-main, #1f2937);
          margin-bottom: var(--id-spacing-md, 1rem);
          line-height: 1.4;
        }

        .user-stats {
          display: flex;
          gap: var(--id-spacing-md, 1rem);
          font-size: 0.875rem;
          color: var(--id-text-secondary, #6b7280);
          margin-bottom: var(--id-spacing-md, 1rem);
        }

        .stat-item {
          display: flex;
          align-items: center;
          gap: 0.25rem;
        }

        .stat-value {
          font-weight: bold;
          color: var(--id-text-main, #1f2937);
        }

        .user-metaid {
          font-size: 0.75rem;
          color: var(--id-text-tertiary, #9ca3af);
          font-family: monospace;
          word-break: break-all;
        }
      </style>
      
      <div part="panel-container" class="float-panel">
        <div class="user-header">
          <div class="avatar-container">
            ${userAvatar ? `
              <img class="avatar" src="${this.escapeHtml(userAvatar)}" alt="${this.escapeHtml(userName || 'User')}" 
                   onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
              <div class="avatar-placeholder" style="display: none;">
                ${userName ? userName.charAt(0).toUpperCase() : (displayMetaId ? displayMetaId.charAt(0).toUpperCase() : '?')}
              </div>
            ` : `
              <div class="avatar-placeholder">
                ${userName ? userName.charAt(0).toUpperCase() : (displayMetaId ? displayMetaId.charAt(0).toUpperCase() : '?')}
              </div>
            `}
          </div>
          
          <div class="user-info">
            <div class="user-name-row">
              <span class="user-name">${this.escapeHtml(userName || 'Unknown User')}</span>
              ${isVerified ? '<span class="verified-badge"></span>' : ''}
            </div>
            <div class="user-handle">@${this.truncateMetaId(displayMetaId)}</div>
          </div>
        </div>
        
        <div class="user-bio">${this.escapeHtml(bio)}</div>
        
        <div class="user-stats">
          <div class="stat-item">
            <span class="stat-value">${following}</span>
            <span>Following</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">${followers}</span>
            <span>Followers</span>
          </div>
        </div>
        
        <div class="user-metaid" title="${this.escapeHtml(displayMetaId)}">
          ${this.truncateMetaId(displayMetaId)}
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

  truncateMetaId(metaid) {
    if (!metaid || metaid.length <= 16) return metaid;
    return `${metaid.substring(0, 8)}...${metaid.substring(metaid.length - 8)}`;
  }
}

// Auto-register
if (!customElements.get('id-userinfo-float-panel')) {
  customElements.define('id-userinfo-float-panel', IdUserinfoFloatPanel);
}

