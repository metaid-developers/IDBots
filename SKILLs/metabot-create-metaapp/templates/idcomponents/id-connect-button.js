/**
 * id-connect-button - Web Component for connecting Metalet wallet
 * Uses Shadow DOM with CSS Variables for theming
 * Structure (Layout) managed via CSS, Skin (Theme) managed via CSS Variables
 */

class IdConnectButton extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._address = null;
    this._isConnecting = false;
    this._userStoreWatcher = null;
    this._dropdownOpen = false;
    this._profileModalOpen = false;
    this._selectedAvatarFile = null;
    this._previewAvatarUrl = null;
    this._editedName = '';
    this._editedBio = '';
    this._profileSaveLoading = false;

    // Close dropdown when clicking outside
    this._handleClickOutside = (e) => {
      if (!this._dropdownOpen) return;
      
      const path = e.composedPath();
      // Get user-info container and dropdown menu elements
      const userInfoEl = this.shadowRoot?.querySelector('.user-info');
      const dropdownMenuEl = this.shadowRoot?.querySelector('.dropdown-menu');
      
      // Check if click target is inside user-info container or dropdown menu
      // composedPath() includes all nodes from target to document root
      const isInsideUserInfo = userInfoEl && path.includes(userInfoEl);
      const isInsideDropdown = dropdownMenuEl && path.includes(dropdownMenuEl);
      const isInsideComponent = path.includes(this);
      
      // If click is outside user-info and dropdown menu, close the dropdown
      if (!isInsideUserInfo && !isInsideDropdown && !isInsideComponent) {
        this._dropdownOpen = false;
        this.render();
      }
    };
  }

  static get observedAttributes() {
    return ['address', 'connected'];
  }

  async connectedCallback() {
    // Wait for window.metaidwallet to be available before proceeding
    const metaidwalletAvailable = await this.waitForMetaidwallet();
    
    if (metaidwalletAvailable) {
      // Check if already connected on mount
      await this.checkConnection();
        requestAnimationFrame(() => {
      this.render();
      
      
    });
    } else {
      // If metaidwallet is not available, still render the button
      // but it will show as disconnected
      requestAnimationFrame(() => {
      this.render();
      
      
    });
    }
    
    // Setup Alpine store watcher for user info updates
    this._watchUserStore();

    // Register built-in on-chain impl so IDFramework.createOrUpdateUserInfo works when called from elsewhere
    if (typeof window !== 'undefined') {
      window.__createOrUpdateUserInfoImpl = this._createOrUpdateUserInfo.bind(this);
    }

    // Delegate Save profile button click in capture phase so we get it before modal-content's stopPropagation (bubble) blocks it from reaching shadowRoot
    this.shadowRoot.addEventListener('click', (e) => {
      const saveBtn = e.target.closest('[data-action="save-profile"]');
      
      if (saveBtn && !saveBtn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        this.handleSaveProfile();
      }
    }, true);
    
    // Add click outside listener
    document.addEventListener('click', this._handleClickOutside);
  }

  /**
   * Poll for window.metaidwallet availability
   * @returns {Promise<boolean>} Returns true if metaidwallet is available, false if timeout
   */
  async waitForMetaidwallet() {
    // If already available, return immediately
    if (window.metaidwallet !== undefined) {
      return true;
    }

    const maxAttempts = 50; // Maximum number of polling attempts
    const pollInterval = 100; // Poll every 100ms
    let attempts = 0;

    return new Promise((resolve) => {
      const poll = setInterval(() => {
        attempts++;

        if (window.metaidwallet !== undefined) {
          clearInterval(poll);
          resolve(true);
          return;
        }

        if (attempts >= maxAttempts) {
          clearInterval(poll);
          console.error('window.metaidwallet does not exist after', maxAttempts * pollInterval, 'ms');
          resolve(false);
        }
      }, pollInterval);
    });
  }
 
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      if (!this._renderScheduled) {
        this._renderScheduled = true;
        requestAnimationFrame(() => {
          this._renderScheduled = false;
          this.render();
        });
      }
    }
  }

  async checkConnection() {
    
    // Check if Metalet is available and already connected
    if (window.metaidwallet) {
      try {
         // Get wallet info from store
        const walletStore = Alpine.store('wallet');
        //const isConnected = await window.metaidwallet.isConnected();
        // if (!walletStore.isConnected && !walletStore.address) {
        //   // Use framework's connectWallet to sync state
        //   if (window.IDFramework) {
        //     await window.IDFramework.dispatch('connectWallet');
        //   }
        // }
        
        if (walletStore && walletStore.isConnected && walletStore.address) {
          this._address = walletStore.address;
          this.setAttribute('connected', 'true');
          this.setAttribute('address', walletStore.address);
          
          // Re-render to show connected state (will read user info from store)
          requestAnimationFrame(() => {
          this.render();


          });
          
          // Auto-fetch user info by globalMetaId (fallback to address)
          const gmid = walletStore?.globalMetaId;
          const addr = walletStore?.address;
          if (window.IDFramework && (gmid || addr)) {
            window.IDFramework.dispatch('fetchUser', gmid ? { globalMetaId: gmid } : { address: addr }).catch(err => {
              console.warn('Failed to fetch user info:', err);
            });
          }
        }
      } catch (error) {
        console.warn('Failed to check Metalet connection:', error);
      }
    }
  }
  
  /**
   * Default avatar when user has no avatar (empty or "/content/").
   * Uses window.__DEFAULT_AVATAR_DATA_URL (full data URL) if set, else IDConfig.DEFAULT_AVATAR_URL, else /assets/images/default_avatar.png.
   */
  getDefaultAvatarUrl(address) {
    return `data:image/png;base64,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`
    // const dataUrl = (typeof window !== 'undefined' && window.__DEFAULT_AVATAR_DATA_URL) ? window.__DEFAULT_AVATAR_DATA_URL : '';
    // if (dataUrl && typeof dataUrl === 'string' && dataUrl.trim()) return dataUrl.trim();
    // const url = (typeof window !== 'undefined' && window.IDConfig && window.IDConfig.DEFAULT_AVATAR_URL) || '';
    // const trimmed = (url && typeof url === 'string') ? url.trim() : '';
    // return trimmed || '/assets/images/default_avatar.png';
  }

  /**
   * On-chain create/update user info using window.metaidwallet.createPin only.
   * Used when saving profile from this component. Caller should call getMVCRewards before this for new users.
   * @param {Object} opts - { userData, oldUserData, options }
   * @returns {Promise<Object>}
   */
  _createOrUpdateUserInfo(opts) {
    const g = typeof window !== 'undefined' ? window : globalThis;
    if (typeof g.metaidwallet === 'undefined' || typeof g.metaidwallet.createPin !== 'function') {
      return Promise.reject(new Error('Metalet wallet or createPin not available. Please connect the wallet and try again.'));
    }
    var userData = opts.userData || {};
    var oldUserData = opts.oldUserData || {};
    var options = opts.options || {};
    var feeRate = (options.feeRate != null) ? options.feeRate : 1;

    var metaDatas = [];
    if (userData.name) {
      metaDatas.push({
        metaidData: {
          operation: oldUserData.nameId ? 'modify' : 'create',
          body: userData.name,
          path: oldUserData.nameId ? '@' + oldUserData.nameId : '/info/name',
          contentType: 'text/plain'
        }
      });
    }
    if (userData.bio) {
      metaDatas.push({
        metaidData: {
          operation: oldUserData.bioId ? 'modify' : 'create',
          body: userData.bio,
          path: oldUserData.bioId ? '@' + oldUserData.bioId : '/info/bio',
          contentType: 'text/plain'
        }
      });
    }
    if (userData.avatar) {
      var avatarContentType = 'image/jpeg;binary';
      if (userData.avatarContentType) {
        var mime = (userData.avatarContentType + '').split('/').pop();
        if (mime === 'png') avatarContentType = 'image/png;binary';
        else if (mime === 'jpeg' || mime === 'jpg') avatarContentType = 'image/jpeg;binary';
        else avatarContentType = userData.avatarContentType + ';binary';
      }
      metaDatas.push({
        metaidData: {
          operation: oldUserData.avatarId ? 'modify' : 'create',
          body: userData.avatar,
          path: oldUserData.avatarId ? '@' + oldUserData.avatarId : '/info/avatar',
          encoding: 'base64',
          contentType: avatarContentType
        }
      });
    }
    if (userData.chatpubkey != null && userData.chatpubkey !== '' && oldUserData && !oldUserData.chatpubkey) {
      var chatpubkeyPath = oldUserData.chatpubkeyId ? '@' + oldUserData.chatpubkeyId : '/info/chatpubkey';
      metaDatas.push({
        metaidData: {
          operation: oldUserData.chatpubkeyId ? 'modify' : 'create',
          body: userData.chatpubkey,
          path: chatpubkeyPath,
          contentType: 'text/plain'
        }
      });
    }

    if (metaDatas.length === 0) {
      return Promise.reject(new Error('No user data provided to create user info'));
    }

    var params = {
      chain: 'mvc',
      feeRate: feeRate,
      dataList: metaDatas
    };

    return g.metaidwallet.createPin(params).then(function (res) {
      return res || {};
    });
  }

  /**
   * Get user info from Alpine store (data-driven approach)
   * This method reads directly from store, ensuring we always get the latest data
   */
  _getUserInfoFromStore() {
    if (typeof Alpine === 'undefined') return null;

    const walletStore = Alpine.store('wallet');
    const userStore = Alpine.store('user');

    if (!walletStore || !userStore) return null;

    // Priority 1: Get metaid from userStore.user.metaid (if already fetched)
    // Priority 2: Fallback to walletStore.globalMetaId (to trigger fetch)
    const userData = userStore.user || {};
    const metaidFromUser = userData.metaid;
    const metaidFromWallet = walletStore.globalMetaId || walletStore.metaid;
    const metaid = metaidFromUser || metaidFromWallet;
    const address = walletStore.address || this._address || '';

    // If no metaid available, return null
    if (!metaid) return null;

    // Avatar: empty or "/content/" means no avatar, use default
    const avatar = userData.avatar;
    const noAvatar = !avatar || (typeof avatar === 'string' && avatar.trim() === '/content/');
    const avatarUrl = noAvatar
      ? this.getDefaultAvatarUrl(address)
      : (userData.avatarUrl || this.getDefaultAvatarUrl(address));

    return {
      name: userData?.name || '',
      nameId: userData?.nameId || '',
      metaid: metaid,
      globalMetaId: metaidFromWallet,
      avatarUrl: avatarUrl,
      address: address
    };
  }
  
  /**
   * Watch Alpine user store for changes (data-driven reactive updates)
   * When store changes, trigger re-render which will read latest data from store
   */
  _watchUserStore() {
    if (typeof Alpine === 'undefined') {
      // Wait for Alpine to be available
      setTimeout(() => this._watchUserStore(), 100);
      return;
    }
    
    // Use a polling approach since Alpine doesn't work directly in Shadow DOM
    // Check every 300ms for store updates (more responsive than 500ms)
    if (this._userStoreWatcher) {
      clearInterval(this._userStoreWatcher);
    }
    
    let lastUserInfoHash = null;
    
    this._userStoreWatcher = setInterval(() => {
      const walletStore = Alpine.store('wallet');
      const userStore = Alpine.store('user');
      if (!walletStore || !walletStore.isConnected || !this.hasAttribute('connected')) {
        return;
      }

      // If store asks to open profile edit modal (e.g. unregistered user from FetchUserCommand), do it first so we never miss it
      if (userStore && userStore.showProfileEditModal) {
        userStore.showProfileEditModal = false;
        const u = userStore.user || {};
        this._editedName = u.name || '';
        this._editedBio = u.bio || '';
        this._previewAvatarUrl = (u.avatar && u.avatar !== '/content/' ? u.avatarUrl : null) || null;
        this._selectedAvatarFile = null;
        this._profileModalOpen = true;
        requestAnimationFrame(() => { this.render(); });
        return;
      }

      // While profile modal is open, skip all watcher logic (no fetch, no re-render) so inputs stay focusable and no render loop
      if (this._profileModalOpen) {
        return;
      }

      // Get current user info from store
      const currentUserInfo = this._getUserInfoFromStore();

      if (!currentUserInfo) {
        return;
      }

      const userData = userStore?.user || {};
      const address = currentUserInfo.address || walletStore?.address;
      const globalMetaId = walletStore?.globalMetaId || userData?.globalMetaId;

      if ((globalMetaId || address) && (!userData.name || !userData.metaid) && window.IDFramework && !userStore.isLoading) {
        window.IDFramework.dispatch('fetchUser', globalMetaId ? { globalMetaId } : { address }).catch(err => {
          console.warn('Failed to fetch user info:', err);
        });
      }

      // Create a hash to detect changes
      const currentHash = JSON.stringify({
        name: currentUserInfo.name,
        metaid: currentUserInfo.metaid,
        avatarUrl: currentUserInfo.avatarUrl
      });

      // Only re-render if user info actually changed
      if (currentHash !== lastUserInfoHash) {
        lastUserInfoHash = currentHash;
        requestAnimationFrame(() => { this.render(); });
      }
    }, 300);
  }
  
  disconnectedCallback() {
    // Clean up watcher when component is removed
    if (this._userStoreWatcher) {
      clearInterval(this._userStoreWatcher);
      this._userStoreWatcher = null;
    }
    // Remove click outside listener
    document.removeEventListener('click', this._handleClickOutside);
  }

  async handleConnect() {
    
    if (this._isConnecting) return;
    
    this._isConnecting = true;
      requestAnimationFrame(() => {
      this.render();
      
      
    });

    try {
      // Use framework's built-in connectWallet command
      if (window.IDFramework) {
        await window.IDFramework.dispatch('connectWallet');
        
        // Get updated wallet info from store
        const walletStore = Alpine.store('wallet');
      
        if (walletStore && walletStore.isConnected && walletStore.address) {
          this._address = walletStore.address;
          this.setAttribute('connected', 'true');
          this.setAttribute('address', walletStore.address);
          
      
          
          // Dispatch custom event for external listeners
          this.dispatchEvent(new CustomEvent('connected', {
            detail: { 
              address: walletStore.address,
              globalMetaId: walletStore.globalMetaId 
            },
            bubbles: true
          }));
          
          // Auto-fetch user info by globalMetaId (fallback to address)
          const gmid = walletStore.globalMetaId;
          const addr = walletStore.address;
          if (window.IDFramework && (gmid || addr)) {
            await window.IDFramework.dispatch('fetchUser', gmid ? { globalMetaId: gmid } : { address: addr }).catch(err => {
              console.warn('Failed to fetch user info:', err);
            });
          }
              // Re-render to show connected state (will read user info from store)
              
           requestAnimationFrame(() => {
      this.render();
      
      
    });
        }
      } else {
        throw new Error('IDFramework is not available');
      }
    } catch (error) {
      console.error('Failed to connect to Metalet:', error);
      alert(error.message || 'Failed to connect to Metalet wallet. Please try again.');
    } finally {
      this._isConnecting = false;
       requestAnimationFrame(() => {
      this.render();
      
      
    });
    }
  }

  handleDisconnect() {
    this._dropdownOpen = false;
    if (window.metaidwallet) {
      window.metaidwallet.disconnect().then(() => {
        this._address = null;
        this.removeAttribute('connected');
        this.removeAttribute('address');
        
        // Do NOT clear _userStoreWatcher here: after reconnect we need it to see showProfileEditModal.
        // The watcher already returns early when !walletStore.isConnected.

        // Update stores with disconnect status
        if (typeof Alpine !== 'undefined') {
          const walletStore = Alpine.store('wallet');
          const appStore = Alpine.store('app');
          const userStore = Alpine.store('user');
          
          if (walletStore) {
            walletStore.isConnected = false;
            walletStore.address = null;
            walletStore.metaid = null;
          }
          
          if (appStore) {
            appStore.isLogin = false;
            appStore.userAddress = null;
          }
          
          if (userStore) {
            userStore.user = {};
            userStore.isLoading = false;
            userStore.showProfileEditModal = false;
          }
        }
        
        // Clear localStorage data
        try {
          localStorage.removeItem('idframework_app_isLogin');
          localStorage.removeItem('idframework_app_userAddress');
          localStorage.removeItem('idframework_user_users');
          localStorage.removeItem('idframework_wallet');
        } catch (error) {
          console.error('Failed to clear localStorage:', error);
        }
        
        // Dispatch custom event for external listeners
        this.dispatchEvent(new CustomEvent('disconnected', {
          bubbles: true
        }));
        
     requestAnimationFrame(() => {
      this.render();
      
      
    });
      }).catch(error => {
        console.error('Failed to disconnect from Metalet:', error);
      });
    }
  }

  handleUserInfoClick(e) {
    e.stopPropagation();
    this._dropdownOpen = !this._dropdownOpen;
     requestAnimationFrame(() => {
      this.render();
      
      
    });
  }

  handleEditProfile() {
    this._dropdownOpen = false;
    const userInfo = this._getUserInfoFromStore();
    if (userInfo) {
      const userStore = typeof Alpine !== 'undefined' ? Alpine.store('user') : null;
      const u = (userStore && userStore.user) || {};
      this._editedName = u.name || userInfo.name || '';
      this._editedBio = u.bio || '';
      this._previewAvatarUrl = userInfo.avatarUrl || null;
      this._selectedAvatarFile = null;
      this._profileModalOpen = true;
      requestAnimationFrame(() => { this.render(); });
    }
  }

  handleCloseProfileModal() {
    this._profileModalOpen = false;
    this._selectedAvatarFile = null;
    this._previewAvatarUrl = null;
    this._editedName = '';
    this._editedBio = '';
    this._profileSaveLoading = false;
    requestAnimationFrame(() => { this.render(); });
  }

  handleAvatarClick() {
    const fileInput = this.shadowRoot.querySelector('#avatar-file-input');
    if (fileInput) {
      fileInput.click();
    }
  }

  handleAvatarFileChange(e) {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      this._selectedAvatarFile = file;
      // Create preview URL
      const reader = new FileReader();
      reader.onload = (event) => {
        this._previewAvatarUrl = event.target.result;
        this.render();
      };
      reader.readAsDataURL(file);
    }
  }

  _showMessage(type, message) {
    if (typeof window.IDUtils !== 'undefined' && window.IDUtils.showMessage) {
      window.IDUtils.showMessage(type, message);
    } else {
      alert(message);
    }
  }

  _fileToBase64(file, maxSize) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        resolve(null);
        return;
      }
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        var canvas = document.createElement('canvas');
        var w = img.width;
        var h = img.height;
        if (maxSize && (w > maxSize || h > maxSize)) {
          if (w > h) {
            h = (h / w) * maxSize;
            w = maxSize;
          } else {
            w = (w / h) * maxSize;
            h = maxSize;
          }
        }
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(null);
              return;
            }
            var reader = new FileReader();
            reader.onload = () => resolve(reader.result ? reader.result.split(',')[1] : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          },
          'image/png',
          0.8
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      img.src = url;
    });
  }

  async handleSaveProfile() {
    var name = (typeof this._editedName === 'string' ? this._editedName : '').trim();
    if (!name) {
      this._showMessage('error', 'Username is required.');
      return;
    }
    if (this._profileSaveLoading) return;

    var userStore = typeof Alpine !== 'undefined' ? Alpine.store('user') : null;
    if (!userStore || !userStore.user) {
      this._showMessage('error', 'User store not available.');
      return;
    }
    var u = userStore.user;

    this._profileSaveLoading = true;
    requestAnimationFrame(() => { this.render(); });

    try {
      var address = (typeof Alpine !== 'undefined' && Alpine.store('wallet')) ? Alpine.store('wallet').address : (u.address || this.getAttribute('address') || this._address);
      var userData = {
        name: name,
        bio: (typeof this._editedBio === 'string' ? this._editedBio : '').trim() || undefined
      };
      if (this._selectedAvatarFile && this._selectedAvatarFile.type) {
        if (this._selectedAvatarFile.type !== 'image/jpeg' && this._selectedAvatarFile.type !== 'image/png') {
          this._showMessage('error', 'Avatar must be JPG or PNG format.');
          this._profileSaveLoading = false;
          this.render();
          return;
        }
        var b64 = await this._fileToBase64(this._selectedAvatarFile, 500);
        if (b64) {
          userData.avatar = b64;
          userData.avatarContentType = this._selectedAvatarFile.type;
        }
      }

      var isNewUser = !u.nameId;
      if (isNewUser && window.metaidwallet && window.metaidwallet.btc && address) {
        try {
          var publicKey = await window.metaidwallet.btc.getPublicKey();
          if (publicKey) userData.chatpubkey = publicKey;
        } catch (e) {
          console.warn('getPublicKey for chatpubkey failed:', e);
        }
      } else if (u.chatpubkey) {
        userData.chatpubkey = u.chatpubkey;
      }
      
      var oldUserData = {
        nameId: u.nameId || '',
        bioId: u.bioId || '',
        avatarId: u.avatarId || '',
        chatpubkeyId: u.chatpubkeyId || u.chatPublicKeyPinId || '',
        chatpubkey: u.chatpubkey || ''
      };

      var cfg = window.IDConfig || {};
      var options = {
        feeRate: cfg.FEE_RATE ?? 1,
        network: (cfg.NETWORK || 'mainnet'),
        assistDomain: cfg.ASSIST_OPEN_API_BASE || 'https://www.metaso.network/assist-open-api',
        addressHost: cfg.ADDRESS_HOST || ''
      };

      if (isNewUser && window.metaidwallet && window.metaidwallet.btc && address && window.IDUtils) {
        try {
          if (typeof window.IDUtils.getMVCRewardsAddressInit === 'function') {
            await window.IDUtils.getMVCRewardsAddressInit({ address: address, gasChain: 'mvc' });
          }
         
          var publicKey = await window.metaidwallet.btc.getPublicKey();
          var signature = await window.metaidwallet.btc.signMessage('metaso.network');
          if (typeof window.IDUtils.getMVCRewards === 'function') {
            await window.IDUtils.getMVCRewards(
              { address: address, gasChain: 'mvc' },
              { 'X-Public-Key': publicKey, 'X-Signature': signature }
            );
          }
        } catch (rewardErr) {
          console.warn('MVC reward before registration failed:', rewardErr);
        }
      }

      var result = await this._createOrUpdateUserInfo({
        userData: userData,
        oldUserData: oldUserData,
        options: options
      });

      this._showMessage('success', 'Profile updated successfully.');
      this.handleCloseProfileModal();
      if (!(result && result.localOnly) && window.IDFramework && address) {
        await new Promise(function (r) { setTimeout(r, 2000); });
        const walletStore = (typeof Alpine !== 'undefined' && Alpine.store('wallet')) ? Alpine.store('wallet') : null;
        const userStore = (typeof Alpine !== 'undefined' && Alpine.store('user')) ? Alpine.store('user') : null;
        const gmid = (walletStore && walletStore.globalMetaId) || (userStore && userStore.user && userStore.user.globalMetaId) || null;
        const payload = gmid ? { globalMetaId: gmid } : { address: address };
        await window.IDFramework.dispatch('fetchUser', payload).catch(function (err) {
          console.warn('Refetch user after profile save failed:', err);
        });
      }
      requestAnimationFrame(() => { this.render(); });
    } catch (err) {
      console.error('Save profile failed:', err);
      this._showMessage('error', err.message || 'Failed to save profile.');
    } finally {
      this._profileSaveLoading = false;
      requestAnimationFrame(() => { this.render(); });
    }
  }

  render() {
    const isConnected = this.hasAttribute('connected') && this.getAttribute('connected') === 'true';
    const address = this.getAttribute('address') || this._address || '';
    const displayAddress = address ? this.formatAddress(address) : '';
    
    // Data-driven: Read user info directly from Alpine store
    // This ensures we always get the latest data, even if updated asynchronously
    const userInfo = isConnected ? this._getUserInfoFromStore() : null;
    const userName = userInfo?.name || '';
    
    const userMetaId = userInfo?.metaid || '';
    const defaultAvatarUrl = this.getDefaultAvatarUrl(address);
    const userAvatarUrl = (userInfo?.avatarUrl && userInfo.avatarUrl.trim()) ? userInfo.avatarUrl : defaultAvatarUrl;
    const displayName = this.formatName(userName);
    const displayMetaId = userMetaId ? (userMetaId.substring(0, 12) + '...') : '';

    // Only show loading when command is actually loading.
    const userStore = (typeof Alpine !== 'undefined' && Alpine.store('user')) ? Alpine.store('user') : null;
    const userInfoLoading = isConnected && !!(userStore && userStore.isLoading);

    this.shadowRoot.innerHTML = `
      <style>
        /* Host element styling */
        :host {
          display: inline-block;
          font-family: var(--id-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif);
          position: fixed;
          top: 1rem;
          right: 1rem;
          z-index: 1000;
        }

        /* Connect Button - Default State */
        .connect-button {
          /* Structure: Layout */
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--id-spacing-sm, 0.5rem);
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          border: none;
          border-radius: var(--id-radius-button, 0.5rem);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s), transform var(--id-transition-fast, 0.1s);
          
          /* Skin: Theme */
          background-color: var(--id-bg-button, var(--id-color-primary, #3b82f6));
          color: var(--id-text-inverse, #ffffff);
          font-size: var(--id-font-size-base, 1rem);
          font-weight: var(--id-font-weight-semibold, 600);
        }

        .connect-button:hover:not(:disabled) {
          background-color: var(--id-bg-button-hover, var(--id-color-primary-hover, #2563eb));
          transform: translateY(-1px);
        }

        .connect-button:active:not(:disabled) {
          transform: translateY(0);
        }

        .connect-button:disabled {
          background-color: var(--id-bg-button-disabled, #9ca3af);
          cursor: not-allowed;
          opacity: 0.7;
        }

        /* User Info Container - Connected State */
        .user-info {
          /* Structure: Layout */
          display: inline-flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          padding: 5px 10px;
          border-radius: var(--id-radius-button, 0.5rem);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s);
          
          /* Skin: Theme */
          background-color:var(--id-bg-body,#fff);
        }

        .user-info:hover {
          background-color: var(--id-bg-card, rgba(0, 0, 0, 0.05));
        }

        /* Avatar */
        .avatar {
          /* Structure: Layout */
          width: 2rem;
          height: 2rem;
          border-radius: 50%;
          object-fit: cover;
          flex-shrink: 0;
          padding:3px;
          
          /* Skin: Theme */
          border: 2px solid var(--id-border-color, #e5e7eb);
          background-color: var(--id-bg-card, #ffffff);
        }

        /* User Info Text Container */
        .user-info-text {
          /* Structure: Layout */
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
        }

        /* Name Display */
        .name {
          /* Structure: Layout */
          display: inline-flex;
          align-items: center;
          font-size: var(--id-font-size-sm, 0.875rem);
          font-weight: var(--id-font-weight-semibold, 600);
          
          /* Skin: Theme */
          color: var(--id-text-main, #1f2937);
        }

        /* MetaID Display */
        .metaid {
          /* Structure: Layout */
          display: inline-flex;
          align-items: center;
          font-size: var(--id-font-size-xs, 0.75rem);
          font-weight: var(--id-font-weight-normal, 400);
          
          /* Skin: Theme */
          color: var(--id-text-secondary, #6b7280);
        }

        /* User Info Container - Position relative for dropdown */
        .user-info {
          position: relative;
        }

        .user-info.user-info-loading .user-info-text {
          opacity: 0.6;
        }

        .user-info.user-info-loading .user-info-text .name::after,
        .user-info.user-info-loading .user-info-text .metaid::after {
          content: '';
          display: inline-block;
          width: 1em;
          height: 1em;
          margin-left: 0.25rem;
          vertical-align: middle;
          border: 2px solid var(--id-border-color, #e5e7eb);
          border-top-color: var(--id-color-primary, #3b82f6);
          border-radius: 50%;
          animation: user-info-spin 0.7s linear infinite;
        }

        @keyframes user-info-spin {
          to { transform: rotate(360deg); }
        }

        /* Dropdown Menu */
        .dropdown-menu {
          position: absolute;
          top: calc(100% + 0.5rem);
          right: 0;
          background-color: var(--id-bg-card, #ffffff);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: var(--id-radius-card, 0.5rem);
          box-shadow: var(--id-shadow-md, 0 4px 6px -1px rgba(0, 0, 0, 0.1));
          min-width: 160px;
          z-index: 1000;
          display: ${this._dropdownOpen ? 'block' : 'none'};
          overflow: hidden;
        }

        .dropdown-item {
          display: flex;
          align-items: center;
          gap: var(--id-spacing-sm, 0.5rem);
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s);
          font-size: var(--id-font-size-sm, 0.875rem);
          color: var(--id-text-main, #1f2937);
          border: none;
          background: none;
          width: 100%;
          text-align: left;
        }

        .dropdown-item:hover {
          background-color: var(--id-bg-body, rgba(0, 0, 0, 0.05));
        }

        .dropdown-item:disabled,
        .dropdown-item.disabled {
          opacity: 0.5;
          cursor: not-allowed;
          pointer-events: none;
        }

        .dropdown-item:disabled:hover,
        .dropdown-item.disabled:hover {
          background-color: transparent;
        }

        .dropdown-item-icon {
          width: 1rem;
          height: 1rem;
          flex-shrink: 0;
        }

        /* Profile Modal */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.5);
          display: ${this._profileModalOpen ? 'flex' : 'none'};
          align-items: center;
          justify-content: center;
          z-index: 10000;
        }

        .modal-content {
          position: relative;
          box-sizing: border-box;
          background-color: var(--id-bg-card, #ffffff);
          border-radius: 50px;
          padding: var(--id-spacing-xl, 2rem);
          max-width: 500px;
          width: 90%;
          max-height: 80vh;
          overflow-y: auto;
          overflow-x: hidden;
          box-shadow: var(--id-shadow-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1));
          /* Hide scrollbar */
          scrollbar-width: none; /* Firefox */
          -ms-overflow-style: none; /* IE and Edge */
        }

        .modal-content::-webkit-scrollbar {
          display: none; /* Chrome, Safari, Opera */
        }

        .modal-close {
          position: absolute;
          top: 0.75rem;
          right: 1rem;
          width: 2rem;
          height: 2rem;
          padding: 0;
          border: none;
          background: none;
          font-size: 1.5rem;
          line-height: 1;
          color: var(--id-text-secondary, #6b7280);
          cursor: pointer;
        }
        .modal-close:hover {
          color: var(--id-text-main, #1f2937);
        }
        .modal-title {
          font-size: 2rem;
          font-weight: var(--id-font-weight-bold, 700);
          color: var(--id-text-title, #111827);
          margin-bottom: var(--id-spacing-md, 1rem);
          text-align: center;
        }

        .modal-subtitle {
          font-size: var(--id-font-size-sm, 0.875rem);
          color: var(--id-text-secondary, #6b7280);
          margin-bottom: var(--id-spacing-xl, 2rem);
          text-align: center;
        }

        .avatar-upload-container {
          display: flex;
          flex-direction: column;
          align-items: center;
          margin-bottom: var(--id-spacing-xl, 2rem);
        }

        .avatar-upload-wrapper {
          position: relative;
          width: 105px;
          height: 105px;
          margin-bottom: var(--id-spacing-sm, 0.5rem);
        }

        .avatar-upload {
          width: 80px;
          height: 80px;
          border-radius: 30%;
          object-fit: cover;
          padding: 5px;
          border: 2px solid var(--id-border-color, #e5e7eb);
          cursor: pointer;
          transition: opacity var(--id-transition-base, 0.2s);
          pointer-events: auto;
        }

        .avatar-upload:hover {
          opacity: 0.8;
        }

        .avatar-upload-icon {
          position: absolute;
          bottom: 0;
          right: 0;
          width: 28px;
          height: 28px;
          background-color: var(--id-bg-button, var(--id-color-primary, #3b82f6));
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          border: 2px solid var(--id-bg-card, #ffffff);
        }

        .avatar-upload-icon svg {
          width: 18px;
          height: 18px;
          fill: var(--id-text-inverse, #ffffff);
        }

        .avatar-optional {
          font-size: var(--id-font-size-xs, 0.75rem);
          color: var(--id-text-secondary, #6b7280);
        }

        .form-group {
          margin-bottom: var(--id-spacing-lg, 1.5rem);
          min-width: 0;
        }

        .form-label {
          display: block;
          font-size: var(--id-font-size-sm, 0.875rem);
          font-weight: var(--id-font-weight-semibold, 600);
          color: var(--id-text-main, #1f2937);
          margin-bottom: var(--id-spacing-xs, 0.25rem);
        }

        .form-input {
          box-sizing: border-box;
          width: 100%;
          max-width: 100%;
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-md, 1rem);
          border: 1px solid var(--id-border-color, #e5e7eb);
          border-radius: 12px;
          font-size: var(--id-font-size-base, 1rem);
          color: var(--id-text-main, #1f2937);
          background-color: var(--id-bg-card, #ffffff);
          transition: border-color var(--id-transition-base, 0.2s);
        }

        .form-input:focus {
          outline: none;
          border-color: var(--id-color-primary, #3b82f6);
        }

        .file-input {
          display: none;
        }

        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: var(--id-spacing-sm, 0.5rem);
        }

        .modal-button {
          padding: var(--id-spacing-sm, 0.5rem) var(--id-spacing-lg, 1.5rem);
          border: none;
          border-radius: var(--id-radius-button, 0.5rem);
          font-size: var(--id-font-size-base, 1rem);
          font-weight: var(--id-font-weight-semibold, 600);
          cursor: pointer;
          transition: background-color var(--id-transition-base, 0.2s), transform var(--id-transition-fast, 0.1s);
        }

        .modal-button-primary {
          background-color: var(--id-bg-button, var(--id-color-primary, #3b82f6));
          color: var(--id-text-inverse, #ffffff);
        }

        .modal-button-primary:hover {
          background-color: var(--id-bg-button-hover, var(--id-color-primary-hover, #2563eb));
          transform: translateY(-1px);
        }
      </style>
      ${isConnected ? `
        <div part="user-info" class="user-info ${userInfoLoading ? 'user-info-loading' : ''}" title="Click to open menu">
          <img part="avatar" class="avatar" src="${userAvatarUrl}" alt="User Avatar" />
          <div part="user-info-text" class="user-info-text">
            <span part="name" class="name">${userInfoLoading ? 'Loading...' : this.escapeHtml(displayName) || '—'}</span>
            <span part="metaid" class="metaid">MetaID:${userInfoLoading ? '…' : this.escapeHtml(displayMetaId?.slice(0,6)) || '…'}</span>
          </div>
          ${this._dropdownOpen ? `
            <div class="dropdown-menu">
              <button class="dropdown-item" data-action="edit-profile">
                <svg class="dropdown-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
                Edit Profile
              </button>
              <button class="dropdown-item" data-action="logout">
                <svg class="dropdown-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                  <polyline points="16 17 21 12 16 7"></polyline>
                  <line x1="21" y1="12" x2="9" y2="12"></line>
                </svg>
                Log Out
              </button>
            </div>
          ` : ''}
        </div>
      ` : `
        <button 
          part="connect-button" 
          class="connect-button"
          ${this._isConnecting ? 'disabled' : ''}
        >
          ${this._isConnecting ? 'Connecting...' : 'Connect'}
        </button>
      `}
      ${this._profileModalOpen ? `
        <div class="modal-overlay edit-profile-modal" data-action="modal-overlay">
          <div class="modal-content" data-action="modal-content">
            <button class="modal-close" data-action="close-profile-modal" aria-label="Close">&times;</button>
            <h2 class="modal-title">Set up your profile</h2>
            <p class="modal-subtitle">Make your account stand out - add a unique avatar and display name.</p>
            <div class="avatar-upload-container">
              <div class="avatar-upload-wrapper">
                <img class="avatar-upload" src="${(this._previewAvatarUrl || userAvatarUrl) || defaultAvatarUrl}" alt="Avatar" />
                <div class="avatar-upload-icon" data-action="upload-avatar">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                    <circle cx="12" cy="13" r="4"></circle>
                  </svg>
                </div>
              </div>
              <span class="avatar-optional">Optional</span>
              <input type="file" id="avatar-file-input" class="file-input" accept="image/jpeg,image/png" />
            </div>
            <div class="form-group">
              <label class="form-label">Username</label>
              <input type="text" class="form-input" id="username-input" value="${this.escapeHtml(this._editedName)}" placeholder="Enter your username" />
            </div>
          
            <div class="modal-actions">
              <button type="button" class="modal-button modal-button-primary" data-action="save-profile" ${this._profileSaveLoading ? 'disabled' : ''}>
                ${this._profileSaveLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ` : ''}
    `;

    // Attach event listeners after rendering
    if (isConnected) {
      const userInfoEl = this.shadowRoot.querySelector('.user-info');
      if (userInfoEl) {
        userInfoEl.addEventListener('click', (e) => this.handleUserInfoClick(e));
      }

      // Dropdown menu items
      const editProfileBtn = this.shadowRoot.querySelector('[data-action="edit-profile"]');
      if (editProfileBtn && !editProfileBtn.disabled) {
        editProfileBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleEditProfile();
        });
      }

      const logoutBtn = this.shadowRoot.querySelector('[data-action="logout"]');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleDisconnect();
        });
      }
    } else {
      const connectButton = this.shadowRoot.querySelector('.connect-button');
      if (connectButton) {
        connectButton.addEventListener('click', () => this.handleConnect());
      }
    }

    // Profile modal handlers
    if (this._profileModalOpen) {
      const modalOverlay = this.shadowRoot.querySelector('.modal-overlay');
      if (modalOverlay) {
        // Do not close on overlay click; only the close button closes the modal
        modalOverlay.addEventListener('click', (e) => {
          e.stopPropagation();
        });
      }

      const closeBtn = this.shadowRoot.querySelector('[data-action="close-profile-modal"]');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.handleCloseProfileModal();
        });
      }

      const modalContent = this.shadowRoot.querySelector('[data-action="modal-content"]');
      if (modalContent) {
        modalContent.addEventListener('click', (e) => e.stopPropagation());
      }

      const avatarUploadIcon = this.shadowRoot.querySelector('[data-action="upload-avatar"]');
      if (avatarUploadIcon) {
        avatarUploadIcon.addEventListener('click', (e) => { e.stopPropagation(); this.handleAvatarClick(); });
      }
      const avatarUploadImg = this.shadowRoot.querySelector('.avatar-upload');
      if (avatarUploadImg) {
        avatarUploadImg.addEventListener('click', (e) => { e.stopPropagation(); this.handleAvatarClick(); });
        avatarUploadImg.style.cursor = 'pointer';
      }

      const fileInput = this.shadowRoot.querySelector('#avatar-file-input');
      if (fileInput) {
        fileInput.addEventListener('change', (e) => this.handleAvatarFileChange(e));
      }

      const usernameInput = this.shadowRoot.querySelector('#username-input');
      if (usernameInput) {
        usernameInput.addEventListener('input', (e) => {
          this._editedName = e.target.value;
        });
      }

      const profileInput = this.shadowRoot.querySelector('#profile-input');
      if (profileInput) {
        profileInput.addEventListener('input', (e) => {
          this._editedBio = e.target.value;
        });
      }

      // Save button is handled by delegated click on shadowRoot in connectedCallback so it works after any re-render
    }
  }

  formatAddress(address) {
    if (!address) return '';
    if (address.length <= 12) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  formatName(name) {
    if (!name) return '';
    if (name.length <= 20) return name;
    return name.substring(0, 20);
  }

  getInitials(address) {
    if (!address) return '?';
    // Use first character of address as initial
    const initial = address.charAt(0).toUpperCase();
    // Only allow alphanumeric characters for safety
    return /[A-Z0-9]/.test(initial) ? initial : '?';
  }

  generateAvatarSVG(address) {
    const initial = this.getInitials(address);
    // Encode SVG properly for data URI
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#3b82f6"/><text x="16" y="22" font-size="18" font-weight="bold" text-anchor="middle" fill="white">${this.escapeHtml(initial)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Register the custom element
customElements.define('id-connect-button', IdConnectButton);

