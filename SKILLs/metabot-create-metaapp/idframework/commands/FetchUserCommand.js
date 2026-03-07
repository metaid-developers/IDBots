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
    
    if (!userStore) {
      console.error('FetchUserCommand: User store not found');
      return;
    }

    const globalMetaId = payload.globalMetaId || payload.globalmetaid || '';
    const { address } = payload;
    const useGlobalMetaId = globalMetaId && typeof globalMetaId === 'string' && globalMetaId.trim() !== '';
    const useAddress = !useGlobalMetaId && address && typeof address === 'string' && address.trim() !== '';

    if (!useGlobalMetaId && !useAddress) {
      console.error('FetchUserCommand: globalMetaId or address is required');
      userStore.error = 'globalMetaId or address is required';
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

      const endpoint = useGlobalMetaId ? `/v1/info/globalmetaid/${globalMetaId}` : `/v1/users/address/${address}`;
      const userData = await userDelegate('metafs', endpoint, useGlobalMetaId ? { globalMetaId } : { address });
      const normalizedUserData = (userData && typeof userData === 'object') ? userData : {};

      if (useAddress) {
        normalizedUserData.address = address;
      }

      if (!normalizedUserData.name || (typeof normalizedUserData.name === 'string' && !normalizedUserData.name.trim())) {
        userStore.user = normalizedUserData;
        userStore.error = null;
        userStore.showProfileEditModal = true;
        return normalizedUserData;
      }

      userStore.user = normalizedUserData;
      userStore.showProfileEditModal = false;
      userStore.error = null;
      return normalizedUserData;
    } catch (error) {
      console.error('FetchUserCommand error:', error);
      userStore.error = error.message || 'Failed to fetch user information';
      userStore.user = {
        ...(userStore.user || {}),
        address: address || (userStore.user && userStore.user.address) || '',
        globalMetaId: globalMetaId || (userStore.user && userStore.user.globalMetaId) || '',
      };
      userStore.showProfileEditModal = false;
      return null;
    } finally {
      userStore.isLoading = false;
    }
  }
}

