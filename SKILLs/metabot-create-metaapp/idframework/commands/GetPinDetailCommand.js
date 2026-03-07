/**
 * GetPinDetailCommand - Business Logic for fetching Pin detail
 * 
 * Command Pattern implementation following IDFramework architecture.
 * 
 * This command:
 * 1. Fetches Pin detail by number or ID using BusinessDelegate
 * 
 * @class GetPinDetailCommand
 */
export default class GetPinDetailCommand {
  /**
   * Execute the command
   * 
   * @param {Object} params - Command parameters
   * @param {Object} params.payload - Event payload
   *   - numberOrId: {string} - Pin number or ID
   * @param {Object} params.stores - Alpine stores object
   * @param {Function} params.delegate - BusinessDelegate function
   * @returns {Promise<Object>} Pin detail
   */
  async execute({ payload = {}, stores, delegate }) {
    try {
      const { numberOrId } = payload;

      if (!numberOrId) {
        throw new Error('numberOrId is required');
      }

      // Call BusinessDelegate to fetch Pin detail
      const response = await delegate('metaid_man', `/pin/${numberOrId}`, {
        method: 'GET'
      });

      return response.data;
    } catch (error) {
      console.error('GetPinDetailCommand error:', error);
      throw error;
    }
  }
}
