/**
 * id-follow-button
 *
 * Reusable follow/unfollow button for user cards and profile modules.
 *
 * Attributes:
 * - target-metaid (required): target user's on-chain metaid
 * - target-address (optional): used for self detection fallback
 * - auto-check (optional): true|false, default true
 * - size (optional): sm|md, default md
 */
class IdFollowButton extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._lastSignature = '';
    this._state = null;
    this._checkDebounce = null;
    this._onLocaleChanged = this._handleLocaleChanged.bind(this);
  }

  static get observedAttributes() {
    return ['target-metaid', 'target-address', 'auto-check', 'size'];
  }

  connectedCallback() {
    this._ensureStoreShape();
    this._bindState();
    window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    this.render();
    this._checkAndRender(true);
    this._watchTimer = setInterval(() => this._checkAndRender(false), 260);
  }

  disconnectedCallback() {
    window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    if (this._watchTimer) {
      clearInterval(this._watchTimer);
      this._watchTimer = null;
    }
    if (this._checkDebounce) {
      clearTimeout(this._checkDebounce);
      this._checkDebounce = null;
    }
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'target-metaid') {
      this._bindState();
    }
    this._checkAndRender(true);
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureStoreShape() {
    var buzz = this._getStore('buzz');
    if (!buzz) return;
    if (!buzz.followRelation || typeof buzz.followRelation !== 'object') {
      buzz.followRelation = {};
    }
    if (!buzz.followRelation.byTarget || typeof buzz.followRelation.byTarget !== 'object') {
      buzz.followRelation.byTarget = {};
    }
  }

  _createRelationState(targetMetaid) {
    return {
      targetMetaid: targetMetaid,
      viewerMetaid: '',
      isFollowing: false,
      followPinId: '',
      isLoading: false,
      hasLoaded: false,
      error: '',
      lastCheckedAt: 0,
      optimisticUntil: 0,
    };
  }

  _ensureRelationState(targetMetaid) {
    this._ensureStoreShape();
    var buzz = this._getStore('buzz');
    if (!buzz || !targetMetaid) return null;
    if (!buzz.followRelation.byTarget[targetMetaid] || typeof buzz.followRelation.byTarget[targetMetaid] !== 'object') {
      buzz.followRelation.byTarget[targetMetaid] = this._createRelationState(targetMetaid);
    }
    return buzz.followRelation.byTarget[targetMetaid];
  }

  _bindState() {
    var targetMetaid = this._normalizeMetaid(this._pickFirstString([this.getAttribute('target-metaid')]));
    if (!targetMetaid) {
      this._state = null;
      return;
    }
    this._state = this._ensureRelationState(targetMetaid);
  }

  _targetMetaid() {
    return this._normalizeMetaid(this._pickFirstString([this.getAttribute('target-metaid')]));
  }

  _targetAddress() {
    return this._pickFirstString([this.getAttribute('target-address')]);
  }

  _isAutoCheck() {
    var raw = this._pickFirstString([this.getAttribute('auto-check')]).toLowerCase();
    if (!raw) return true;
    if (raw === '0' || raw === 'false' || raw === 'no') return false;
    return true;
  }

  _size() {
    var raw = this._pickFirstString([this.getAttribute('size')]).toLowerCase();
    if (raw === 'sm' || raw === 'small') return 'sm';
    return 'md';
  }

  _isWalletConnected() {
    var wallet = this._getStore('wallet');
    return !!(wallet && wallet.isConnected && wallet.address);
  }

  _resolveViewerMetaid() {
    var walletStore = this._getStore('wallet');
    var userStore = this._getStore('user');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    return this._pickFirstMetaid([
      user && user.metaid,
      user && user.metaId,
      walletStore && walletStore.metaid,
    ]);
  }

  _viewerAddress() {
    var walletStore = this._getStore('wallet');
    var userStore = this._getStore('user');
    var user = userStore && userStore.user && typeof userStore.user === 'object' ? userStore.user : null;
    return this._pickFirstString([
      user && user.address,
      walletStore && walletStore.address,
    ]);
  }

  _isSelfTarget() {
    var targetMetaid = this._targetMetaid();
    var targetAddress = this._targetAddress();
    var viewerMetaid = this._resolveViewerMetaid();
    var viewerAddress = this._viewerAddress();
    var byMetaid = !!(targetMetaid && viewerMetaid && targetMetaid === viewerMetaid);
    var byAddress = !!(targetAddress && viewerAddress && targetAddress === viewerAddress);
    return byMetaid || byAddress;
  }

  _signature() {
    var targetMetaid = this._targetMetaid();
    var targetAddress = this._targetAddress();
    var connected = this._isWalletConnected() ? '1' : '0';
    var viewerMetaid = this._resolveViewerMetaid();
    var viewerAddress = this._viewerAddress();
    var autoCheck = this._isAutoCheck() ? '1' : '0';
    var state = this._state;
    var stateSig = '';
    if (state) {
      stateSig = [
        state.isFollowing ? '1' : '0',
        state.followPinId || '',
        state.isLoading ? '1' : '0',
        state.hasLoaded ? '1' : '0',
        state.error || '',
        state.viewerMetaid || '',
        String(state.lastCheckedAt || 0),
        String(state.optimisticUntil || 0),
      ].join('|');
    }
    return [targetMetaid, targetAddress, connected, viewerMetaid, viewerAddress, autoCheck, stateSig].join('||');
  }

  _checkAndRender(force) {
    this._bindState();
    var signature = this._signature();
    if (!force && signature === this._lastSignature) return;
    this._lastSignature = signature;
    this.render();
    this._maybeCheckRelation();
  }

  _handleLocaleChanged() {
    this.render();
  }

  _t(key, fallback, params) {
    if (
      typeof window !== 'undefined' &&
      window.IDFramework &&
      window.IDFramework.I18n &&
      typeof window.IDFramework.I18n.t === 'function'
    ) {
      return window.IDFramework.I18n.t(key, params || {}, fallback || '');
    }
    return fallback || '';
  }

  _isCommandRegistered(commandName) {
    if (!window.IDFramework || !window.IDFramework.IDController) return false;
    var controller = window.IDFramework.IDController;
    var inFileCommands = controller.commands && typeof controller.commands.has === 'function'
      ? controller.commands.has(commandName)
      : false;
    var inBuiltInCommands = controller.builtInCommands && typeof controller.builtInCommands.has === 'function'
      ? controller.builtInCommands.has(commandName)
      : false;
    return inFileCommands || inBuiltInCommands;
  }

  async _dispatch(commandName, payload) {
    if (!window.IDFramework || typeof window.IDFramework.dispatch !== 'function') {
      throw new Error('IDFramework dispatch is not available');
    }
    if (!this._isCommandRegistered(commandName)) {
      throw new Error('Command is not registered: ' + commandName);
    }
    return await window.IDFramework.dispatch(commandName, payload || {});
  }

  _maybeCheckRelation() {
    if (!this._isAutoCheck()) return;
    if (!this._state) return;
    if (!this._isWalletConnected()) return;
    if (this._isSelfTarget()) return;
    if (!this._isCommandRegistered('fetchFollowRelation')) return;

    var now = Date.now();
    var optimisticUntil = Number(this._state.optimisticUntil || 0);
    if (optimisticUntil > now) return;
    if (this._state.isLoading) return;

    var staleMs = 45 * 1000;
    var lastCheckedAt = Number(this._state.lastCheckedAt || 0);
    if (this._state.hasLoaded && now - lastCheckedAt < staleMs) return;

    if (this._checkDebounce) {
      clearTimeout(this._checkDebounce);
      this._checkDebounce = null;
    }
    this._checkDebounce = setTimeout(() => {
      this._checkDebounce = null;
      this._checkRelation();
    }, 10);
  }

  async _checkRelation() {
    if (!this._state) return;
    var targetMetaid = this._targetMetaid();
    if (!targetMetaid) return;

    this._state.isLoading = true;
    this._state.error = '';
    this.render();

    try {
      var result = await this._dispatch('fetchFollowRelation', {
        metaid: targetMetaid,
      });
      var optimisticUntil = Number(this._state.optimisticUntil || 0);
      var inOptimisticWindow = optimisticUntil > Date.now();

      var isFollowingFromServer = !!(result && result.isFollowing);
      var followPinFromServer = this._normalizePinId(this._pickFirstString([
        result && result.followPinId,
      ]));

      if (!inOptimisticWindow) {
        this._state.isFollowing = isFollowingFromServer;
        this._state.followPinId = followPinFromServer;
      } else if (this._state.isFollowing && followPinFromServer) {
        this._state.followPinId = followPinFromServer;
      }

      this._state.viewerMetaid = this._pickFirstMetaid([
        result && result.viewerMetaid,
        this._state.viewerMetaid,
      ]);
      this._state.hasLoaded = true;
      this._state.error = '';
      this._state.lastCheckedAt = Date.now();
    } catch (error) {
      this._state.error = (error && error.message) ? error.message : this._t('buzz.follow.resolveStatusFailed', 'Failed to resolve follow status');
      this._state.hasLoaded = true;
      this._state.lastCheckedAt = Date.now();
    }

    this._state.isLoading = false;
    this.render();
  }

  _showMessage(type, message) {
    if (typeof window !== 'undefined' && window.IDUtils && typeof window.IDUtils.showMessage === 'function') {
      window.IDUtils.showMessage(type, message);
      return;
    }
    if (type === 'error' && typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(message);
    }
  }

  async _toggleFollow() {
    if (!this._state || this._state.isLoading) return;
    if (!this._isWalletConnected()) return;
    if (this._isSelfTarget()) return;

    var targetMetaid = this._targetMetaid();
    if (!targetMetaid) return;

    this._state.isLoading = true;
    this._state.error = '';
    this.render();

    if (this._state.isFollowing) {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        var confirmed = window.confirm(this._t('buzz.follow.unfollowConfirm', 'Unfollow this user?'));
        if (!confirmed) {
          this._state.isLoading = false;
          this.render();
          return;
        }
      }

      try {
        await this._dispatch('unfollowUser', {
          metaid: targetMetaid,
          followerMetaid: this._state.viewerMetaid || this._resolveViewerMetaid(),
          followPinId: this._state.followPinId || '',
        });
        this._state.isFollowing = false;
        this._state.followPinId = '';
        this._state.error = '';
        this._state.optimisticUntil = 0;
        this._state.lastCheckedAt = Date.now();
        this._emitChanged();
        this._showMessage('success', this._t('buzz.follow.unfollowedSuccess', 'Unfollowed successfully'));
      } catch (error) {
        this._state.error = (error && error.message) ? error.message : this._t('buzz.follow.unfollowFailed', 'Failed to unfollow');
        this._showMessage('error', this._state.error);
      }

      this._state.isLoading = false;
      this.render();
      return;
    }

    try {
      var followRes = await this._dispatch('followUser', {
        metaid: targetMetaid,
        followerMetaid: this._state.viewerMetaid || this._resolveViewerMetaid(),
      });
      this._state.isFollowing = true;
      this._state.followPinId = this._normalizePinId(this._pickFirstString([
        followRes && followRes.pinId,
        followRes && followRes.followPinId,
      ]));
      this._state.viewerMetaid = this._pickFirstMetaid([
        followRes && followRes.followerMetaid,
        this._state.viewerMetaid,
        this._resolveViewerMetaid(),
      ]);
      this._state.error = '';
      this._state.optimisticUntil = Date.now() + 120000;
      this._state.lastCheckedAt = Date.now();
      this._emitChanged();
      this._showMessage('success', this._t('buzz.follow.followedSuccess', 'Followed successfully'));
    } catch (error) {
      this._state.error = (error && error.message) ? error.message : this._t('buzz.follow.followFailed', 'Failed to follow');
      this._showMessage('error', this._state.error);
    }

    this._state.isLoading = false;
    this.render();
  }

  _emitChanged() {
    this.dispatchEvent(new CustomEvent('id:follow:changed', {
      detail: {
        targetMetaid: this._targetMetaid(),
        isFollowing: !!(this._state && this._state.isFollowing),
        followPinId: this._state && this._state.followPinId ? this._state.followPinId : '',
      },
      bubbles: true,
      composed: true,
    }));
  }

  _pickFirstString(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var value = candidates[i];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string') {
        var text = value.trim();
        if (text) return text;
        continue;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        var normalized = String(value).trim();
        if (normalized) return normalized;
      }
    }
    return '';
  }

  _pickFirstMetaid(candidates) {
    for (var i = 0; i < candidates.length; i += 1) {
      var metaid = this._normalizeMetaid(candidates[i]);
      if (metaid) return metaid;
    }
    return '';
  }

  _normalizeMetaid(raw) {
    var text = this._pickFirstString([raw]).toLowerCase();
    if (!text) return '';
    if (/^[a-f0-9]{64}$/.test(text)) return text;
    var matched = text.match(/[a-f0-9]{64}/);
    return matched && matched[0] ? matched[0] : '';
  }

  _normalizePinId(raw) {
    var text = this._pickFirstString([raw]);
    if (!text) return '';
    var exact = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (exact && exact[0]) return exact[0];
    var cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.indexOf('metafile://') === 0) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.indexOf('/pin/') >= 0) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.indexOf('/content/') >= 0) cleaned = cleaned.split('/content/').pop() || '';
    var matched = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    if (matched && matched[0]) return matched[0];
    return cleaned.trim();
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  render() {
    var targetMetaid = this._targetMetaid();
    if (!targetMetaid) {
      this.shadowRoot.innerHTML = '<style>:host{display:none;}</style>';
      return;
    }
    if (!this._isWalletConnected()) {
      this.shadowRoot.innerHTML = '<style>:host{display:none;}</style>';
      return;
    }
    if (this._isSelfTarget()) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: inline-flex; align-items: center; }
          .self-tag {
            border-radius: 999px;
            border: 1px solid var(--id-border-color, #d1d5db);
            color: var(--id-text-secondary, #6b7280);
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 600;
            line-height: 1;
            background: var(--id-bg-card, #ffffff);
          }
        </style>
        <span class="self-tag">${this._escapeHtml(this._t('buzz.follow.self', 'You'))}</span>
      `;
      return;
    }

    var size = this._size();
    var state = this._state || this._createRelationState(targetMetaid);
    var loading = !!state.isLoading;
    var isFollowing = !!state.isFollowing;
    var cls = 'btn ' + (isFollowing ? 'is-following' : 'is-not-following') + ' ' + (size === 'sm' ? 'size-sm' : 'size-md');
    var label = loading
      ? this._t('buzz.follow.processing', 'Processing...')
      : (isFollowing ? this._t('buzz.follow.unfollow', 'Unfollow') : this._t('buzz.follow.follow', 'Follow'));
    var disabled = loading ? 'disabled' : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
        }
        .btn {
          border-radius: 999px;
          border: 1px solid #2563eb;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
        }
        .btn.size-sm {
          min-height: 28px;
          padding: 0 10px;
          font-size: 12px;
        }
        .btn.size-md {
          min-height: 32px;
          padding: 0 14px;
          font-size: 13px;
        }
        .btn.is-not-following {
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          color: #ffffff;
          border-color: #2563eb;
        }
        .btn.is-following {
          background: var(--id-bg-card, #ffffff);
          color: var(--id-text-main, #111827);
          border-color: var(--id-border-color, #d1d5db);
        }
        .btn:disabled {
          cursor: not-allowed;
          opacity: 0.72;
        }
      </style>
      <button class="${cls}" ${disabled}>${this._escapeHtml(label)}</button>
    `;

    var btn = this.shadowRoot.querySelector('.btn');
    if (btn && !btn.disabled) {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._toggleFollow();
      });
    }
  }
}

if (!customElements.get('id-follow-button')) {
  customElements.define('id-follow-button', IdFollowButton);
}
