/**
 * FetchUserCommand - Business Logic for fetching user information
 *
 * Command Pattern implementation following IDFramework architecture.
 *
 * This command:
 * 1. Uses UserDelegate to fetch user data (with IndexedDB caching)
 * 2. Updates the Model (user store) with user information
 *
 * Payload: prefer globalMetaId; fallback to address.
 *
 * @class FetchUserCommand
 */
export default class FetchUserCommand {
  _toText(value) {
    return String(value || '').trim();
  }

  _isSelfIdentity(target, wallet) {
    const tgt = {
      globalMetaId: this._toText(target.globalMetaId || target.globalmetaid),
      metaid: this._toText(target.metaid || target.metaId),
      address: this._toText(target.address),
    };
    const self = {
      globalMetaId: this._toText(wallet && wallet.globalMetaId),
      metaid: this._toText(wallet && wallet.metaid),
      address: this._toText(wallet && wallet.address),
    };

    if (self.globalMetaId && (tgt.globalMetaId === self.globalMetaId || tgt.metaid === self.globalMetaId || tgt.address === self.globalMetaId)) return true;
    if (self.metaid && (tgt.globalMetaId === self.metaid || tgt.metaid === self.metaid || tgt.address === self.metaid)) return true;
    if (self.address && (tgt.globalMetaId === self.address || tgt.metaid === self.address || tgt.address === self.address)) return true;
    return false;
  }

  /**
   * Execute the command
   *
   * @param {Object} params - Command parameters
   * @param {Object} params.payload - Event payload
   *   - globalMetaId: {string} - GlobalMetaId to fetch user info (preferred)
   *   - address: {string} - Address to fetch user info (fallback)
   * @param {Object} params.stores - Alpine stores object
   * @param {Function} params.userDelegate - UserDelegate function
   * @returns {Promise<void>}
   */
  async execute({ payload = {}, stores, userDelegate }) {
    const userStore = stores.user;
    const walletStore = stores.wallet || null;
    
    if (!userStore) {
      console.error('FetchUserCommand: User store not found');
      return;
    }

    const globalMetaId = payload.globalMetaId || payload.globalmetaid || '';
    const metaid = payload.metaid || payload.metaId || '';
    const { address } = payload;
    const useGlobalMetaId = globalMetaId && typeof globalMetaId === 'string' && globalMetaId.trim() !== '';
    const useAddress = !useGlobalMetaId && address && typeof address === 'string' && address.trim() !== '';
    const useMetaid = !useGlobalMetaId && !useAddress && metaid && typeof metaid === 'string' && metaid.trim() !== '';

    if (!useGlobalMetaId && !useAddress && !useMetaid) {
      console.error('FetchUserCommand: globalMetaId, metaid, or address is required');
      userStore.error = 'globalMetaId, metaid, or address is required';
      return;
    }

    // if (useGlobalMetaId && userStore.user && userStore.user.globalMetaId === globalMetaId && userStore.user.name && userStore.user.name.trim()) {
    //   return;
    // }
    // if (useAddress && userStore.user && userStore.user.address === address && userStore.user.name && userStore.user.name.trim()) {
    //   return;
    // }

    userStore.isLoading = true;
    userStore.error = null;

    try {
      if (!userDelegate) {
        throw new Error('UserDelegate is not available');
      }

      const endpoint = useGlobalMetaId
        ? `/info/globalmetaid/${globalMetaId}`
        : (useAddress ? `/users/address/${address}` : `/info/metaid/${metaid}`);
      const delegatePayload = useGlobalMetaId ? { globalMetaId } : (useAddress ? { address } : { metaid });
      const userData = await userDelegate('metafs', endpoint, delegatePayload);
      const normalizedUserData = (userData && typeof userData === 'object') ? userData : {};

      if (useAddress) {
        normalizedUserData.address = address;
      }
      if (useMetaid && !normalizedUserData.metaid && !normalizedUserData.metaId) {
        normalizedUserData.metaid = metaid;
      }

      const isSelfByRequest = this._isSelfIdentity(
        { globalMetaId, metaid, address },
        walletStore
      );
      const isSelfByResponse = this._isSelfIdentity(normalizedUserData, walletStore);
      const isSelfFetch = isSelfByRequest || isSelfByResponse;

      if (userStore.users && typeof userStore.users === 'object') {
        const keys = new Set();
        const gm = String(normalizedUserData.globalMetaId || normalizedUserData.globalmetaid || '').trim();
        const mi = String(normalizedUserData.metaId || normalizedUserData.metaid || metaid || '').trim();
        const addr = String(normalizedUserData.address || address || '').trim();
        if (gm) keys.add(gm);
        if (mi) keys.add(mi);
        if (addr) keys.add(addr);
        keys.forEach((k) => {
          userStore.users[k] = normalizedUserData;
        });
      }

      if (!normalizedUserData.name || (typeof normalizedUserData.name === 'string' && !normalizedUserData.name.trim())) {
        if (isSelfFetch) {
          userStore.user = normalizedUserData;
          userStore.showProfileEditModal = true;
        }
        userStore.error = null;
        return normalizedUserData;
      }

      if (isSelfFetch) {
        userStore.user = normalizedUserData;
        userStore.showProfileEditModal = false;
      }
      userStore.error = null;
      return normalizedUserData;
    } catch (error) {
      console.error('FetchUserCommand error:', error);
      const isSelfFetch = this._isSelfIdentity(
        { globalMetaId, metaid, address },
        walletStore
      );
      if (isSelfFetch) {
        userStore.error = error.message || 'Failed to fetch user information';
        userStore.user = {
          ...(userStore.user || {}),
          address: address || (userStore.user && userStore.user.address) || '',
          globalMetaId: globalMetaId || (userStore.user && userStore.user.globalMetaId) || '',
          metaid: metaid || (userStore.user && (userStore.user.metaid || userStore.user.metaId)) || '',
        };
        userStore.showProfileEditModal = false;
      }
      return null;
    } finally {
      userStore.isLoading = false;
    }
  }
}
