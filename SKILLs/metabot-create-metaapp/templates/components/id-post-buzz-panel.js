/**
 * id-post-buzz-panel - Web Component for posting new Buzz
 * Uses Shadow DOM with CSS Variables for theming
 * Structure (Layout) managed via CSS, Skin (Theme) managed via CSS Variables
 */

class IdPostBuzzPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._content = '';
    this._isOpen = false;
    this._userAddress = null;
  }

  static get observedAttributes() {
    return ['open', 'user-address'];
  }

  connectedCallback() {
    this.render();
    this.attachEventListeners();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'open') {
      this._isOpen = this.hasAttribute('open') && this.getAttribute('open') !== 'false';
      if (this._isOpen) {
        this.loadUserInfo();
      }
      this.render();
      this.attachEventListeners();
    } else if (name === 'user-address') {
      this._userAddress = newValue || null;
      this.render();
      this.attachEventListeners();
    }
  }

  attachEventListeners() {
    // Remove old event listeners to prevent duplicates
    const closeButton = this.shadowRoot.querySelector('.close-button');
    if (closeButton) {
      // Clone and replace to remove old listeners
      const newCloseButton = closeButton.cloneNode(true);
      closeButton.parentNode.replaceChild(newCloseButton, closeButton);
      newCloseButton.addEventListener('click', () => this.close());
    }

    // Overlay click to close
    const overlay = this.shadowRoot.querySelector('.overlay');
    if (overlay) {
      const newOverlay = overlay.cloneNode(true);
      overlay.parentNode.replaceChild(newOverlay, overlay);
      newOverlay.addEventListener('click', (e) => {
        if (e.target === newOverlay) {
          this.close();
        }
      });
    }

    // Post button
    const postButton = this.shadowRoot.querySelector('.post-button');
    if (postButton) {
      const newPostButton = postButton.cloneNode(true);
      postButton.parentNode.replaceChild(newPostButton, postButton);
      newPostButton.addEventListener('click', () => this.handlePost());
    }

    // Close panel button
    const closePanelButton = this.shadowRoot.querySelector('.close-panel-button');
    if (closePanelButton) {
      const newClosePanelButton = closePanelButton.cloneNode(true);
      closePanelButton.parentNode.replaceChild(newClosePanelButton, closePanelButton);
      newClosePanelButton.addEventListener('click', () => this.close());
    }

    // Textarea - preserve content on close
    const textarea = this.shadowRoot.querySelector('.buzz-textarea');
    if (textarea) {
      textarea.addEventListener('input', (e) => {
        this._content = e.target.value;
      });
      
      // Restore content if exists
      if (this._content) {
        textarea.value = this._content;
      }
    }
  }

  async loadUserInfo() {
    // Load user info when panel opens
    if (window.metaidwallet) {
      try {
        const isConnected = await window.metaidwallet.isConnected();
        if (isConnected) {
          const address = await window.metaidwallet.getAddress();
          this._userAddress = address;
          this.setAttribute('user-address', address || '');
          return address;
        } else {
          this._userAddress = null;
          this.removeAttribute('user-address');
          return null;
        }
      } catch (error) {
        console.warn('Failed to load user info:', error);
        this._userAddress = null;
        this.removeAttribute('user-address');
        return null;
      }
    }
    return null;
  }

  async open() {
    this.setAttribute('open', 'true');
    this._isOpen = true;
    
    // Load user info first
    await this.loadUserInfo();
    
    // Then render
    this.render();
    this.attachEventListeners();
    
    // Focus textarea when opened
    requestAnimationFrame(() => {
      const textarea = this.shadowRoot.querySelector('.buzz-textarea');
      if (textarea) {
        textarea.focus();
      }
    });
  }

  close() {
    this._isOpen = false;
    this.removeAttribute('open');
    
    // Dispatch close event
    this.dispatchEvent(new CustomEvent('panel-closed', {
      bubbles: true
    }));
    
    // Render after a short delay to ensure attribute change is processed
    requestAnimationFrame(() => {
      this.render();
      this.attachEventListeners();
    });
  }

  async handlePost() {
    const textarea = this.shadowRoot.querySelector('.buzz-textarea');
    const content = textarea ? textarea.value.trim() : this._content.trim();

    if (!content) {
      alert('Please enter some content for your buzz.');
      return;
    }

    // Ensure we have user address
    if (!this._userAddress) {
      await this.loadUserInfo();
      if (!this._userAddress) {
        alert('User address not available. Please reconnect your wallet.');
        return;
      }
    }

    // Directly dispatch command through IDFramework (component is self-contained)
    if (window.IDFramework) {
      try {
        await window.IDFramework.dispatch('postBuzz', {
          content,
          author: this._userAddress
        });
        
        // Close panel after successful post
        this.close();
      } catch (error) {
        console.error('Failed to post buzz:', error);
        alert('Failed to post buzz. Please try again.');
      }
    } else {
      console.error('IDFramework is not available');
      alert('Framework error. Please refresh the page.');
    }
  }

  formatAddress(address) {
    if (!address) return '';
    if (address.length <= 12) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        /* Host element styling */
        :host {
          display: ${this._isOpen ? 'block' : 'none'};
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 2000;
        }

        /* Overlay */
        .overlay {
          /* Structure: Layout */
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          
          /* Skin: Theme */
          background-color: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
        }

        /* Panel Container */
        .panel-container {
          /* Structure: Layout */
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 90%;
          max-width: 600px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          border-radius: var(--id-radius-card, 0.5rem);
          overflow: hidden;
          box-sizing: border-box;
          
          /* Skin: Theme */
          background-color: var(--id-bg-card, #ffffff);
          box-shadow: var(--id-shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05));
        }

        /* Panel Header */
        .panel-header {
          /* Structure: Layout */
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: var(--id-spacing-md, 1rem) var(--id-spacing-lg, 1.5rem);
          border-bottom: 1px solid var(--id-border-color, #e5e7eb);
          
          /* Skin: Theme */
          background-color: var(--id-bg-card, #ffffff);
        }

        .panel-title {
          /* Structure: Layout */
          margin: 0;
          font-size: var(--id-font-size-lg, 1.125rem);
          font-weight: var(--id-font-weight-bold, 700);
          
          /* Skin: Theme */
          color: var(--id-text-title, #111827);
        }

        .close-button {
          /* Structure: Layout */
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2rem;
          height: 2rem;
          border: none;
          border-radius: var(--id-radius-small, 0.25rem);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s);
          
          /* Skin: Theme */
          background-color: transparent;
          color: var(--id-text-secondary, #6b7280);
          font-size: var(--id-font-size-lg, 1.125rem);
        }

        .close-button:hover {
          background-color: var(--id-bg-body, rgba(0, 0, 0, 0.05));
          color: var(--id-text-main, #1f2937);
        }

        /* Panel Body */
        .panel-body {
          /* Structure: Layout */
          flex: 1;
          padding: var(--id-spacing-lg, 1.5rem);
          overflow-y: auto;
          overflow-x: hidden;
          box-sizing: border-box;
        }

        .buzz-textarea {
          /* Structure: Layout */
          width: 100%;
          min-height: 200px;
          padding: var(--id-spacing-md, 1rem);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: var(--id-radius-card, 0.5rem);
          resize: vertical;
          font-family: var(--id-font-family, inherit);
          font-size: var(--id-font-size-base, 1rem);
          line-height: var(--id-line-height-tight, 1.5);
          box-sizing: border-box;
          
          /* Skin: Theme */
          background-color: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #1f2937);
        }

        .buzz-textarea:focus {
          outline: none;
          border-color: var(--id-color-primary, #3b82f6);
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .buzz-textarea::placeholder {
          color: var(--id-text-tertiary, #9ca3af);
        }

        /* Panel Footer */
        .panel-footer {
          /* Structure: Layout */
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: var(--id-spacing-md, 1rem);
          padding: var(--id-spacing-md, 1rem) var(--id-spacing-lg, 1.5rem);
          border-top: 1px solid var(--id-border-color, #e5e7eb);
          
          /* Skin: Theme */
          background-color: var(--id-bg-body, #f9fafb);
        }

        .panel-button {
          /* Structure: Layout */
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          border: none;
          border-radius: var(--id-radius-button, 0.5rem);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s), transform var(--id-transition-fast, 0.1s);
          font-size: var(--id-font-size-base, 1rem);
          font-weight: var(--id-font-weight-semibold, 600);
        }

        .close-panel-button {
          /* Skin: Theme */
          background-color: transparent;
          color: var(--id-text-secondary, #6b7280);
        }

        .close-panel-button:hover {
          background-color: var(--id-bg-body, rgba(0, 0, 0, 0.05));
          color: var(--id-text-main, #1f2937);
        }

        .post-button {
          /* Skin: Theme */
          background-color: var(--id-bg-button, var(--id-color-primary, #3b82f6));
          color: var(--id-text-inverse, #ffffff);
        }

        .post-button:hover:not(:disabled) {
          background-color: var(--id-bg-button-hover, var(--id-color-primary-hover, #2563eb));
          transform: translateY(-1px);
        }

        .post-button:active:not(:disabled) {
          transform: translateY(0);
        }

        .post-button:disabled {
          background-color: var(--id-bg-button-disabled, #9ca3af);
          cursor: not-allowed;
          opacity: 0.7;
        }

        /* User Info Display */
        .user-info-display {
          /* Structure: Layout */
          display: flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          margin-bottom: var(--id-spacing-md, 1rem);
          border-radius: var(--id-radius-card, 0.5rem);
          
          /* Skin: Theme */
          background-color: var(--id-bg-body, #f9fafb);
          border: 1px solid var(--id-border-color, #e5e7eb);
        }

        .user-info-label {
          /* Structure: Layout */
          font-size: var(--id-font-size-sm, 0.875rem);
          font-weight: var(--id-font-weight-semibold, 600);
          
          /* Skin: Theme */
          color: var(--id-text-secondary, #6b7280);
        }

        .user-info-value {
          /* Structure: Layout */
          font-size: var(--id-font-size-sm, 0.875rem);
          font-family: monospace;
          
          /* Skin: Theme */
          color: var(--id-text-main, #1f2937);
        }
      </style>
      <div part="overlay" class="overlay"></div>
      <div part="panel-container" class="panel-container">
        <div part="panel-header" class="panel-header">
          <h2 part="panel-title" class="panel-title">Post Your New Buzz</h2>
          <button part="close-button" class="close-button" aria-label="Close">×</button>
        </div>
        <div part="panel-body" class="panel-body">
          ${this._userAddress ? `
            <div part="user-info-display" class="user-info-display">
              <span part="user-info-label" class="user-info-label">Posting as:</span>
              <span part="user-info-value" class="user-info-value">${this.escapeHtml(this.formatAddress(this._userAddress))}</span>
            </div>
          ` : ''}
          <textarea 
            part="buzz-textarea"
            class="buzz-textarea"
            placeholder="What's on your mind?"
            rows="8"
          ></textarea>
        </div>
        <div part="panel-footer" class="panel-footer">
          <button part="close-panel-button" class="panel-button close-panel-button">Close</button>
          <button part="post-button" class="panel-button post-button">Post</button>
        </div>
      </div>
    `;
  }
}

// Register the custom element
customElements.define('id-post-buzz-panel', IdPostBuzzPanel);

