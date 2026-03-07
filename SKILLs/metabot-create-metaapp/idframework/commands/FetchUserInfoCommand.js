/**
 * FetchUserInfoCommand - Business Logic for fetching user information
 * 
 * Command Pattern implementation following IDFramework architecture.
 * 
 * This command:
 * 1. Uses UserDelegate to fetch user data (with IndexedDB caching)
 * 2. Returns user information data object from API response
 * 
 * @class FetchUserInfoCommand
 */
export default class FetchUserInfoCommand {
  /**
   * Execute the command
   * 
   * @param {Object} params - Command parameters
   * @param {Object} params.payload - Event payload
   *   - metaid: {string} - MetaID to fetch user info for
   *   - globalMetaId/globalmetaid: {string} - GlobalMetaId to fetch user info for
   * @param {Object} params.stores - Alpine stores object
   * @param {Function} params.userDelegate - UserDelegate function
   * @returns {Promise<Object>} API "data" object
   */
  async execute({ payload = {}, stores, userDelegate }) {
    try {
      const metaid = payload.metaid ? String(payload.metaid).trim() : '';
      const globalMetaId = payload.globalMetaId
        ? String(payload.globalMetaId).trim()
        : (payload.globalmetaid ? String(payload.globalmetaid).trim() : '');

      if (!metaid && !globalMetaId) {
        throw new Error('metaid or globalMetaId is required');
      }

      // Use UserDelegate to fetch user data (with IndexedDB caching)
      if (!userDelegate) {
        throw new Error('UserDelegate is not available');
      }

      const endpoint = globalMetaId
        ? `/v1/info/globalmetaid/${globalMetaId}`
        : `/info/metaid/${metaid}`;
      const userData = await userDelegate('metafs', endpoint, globalMetaId ? { globalMetaId } : { metaid });
      const data = userData && typeof userData === 'object' && userData.data && typeof userData.data === 'object'
        ? userData.data
        : userData;

      // Return API data payload directly.
      return data && typeof data === 'object' ? data : {};
    } catch (error) {
      console.error('FetchUserInfoCommand error:', error);
      throw error;
    }
  }
}
