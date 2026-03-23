/**
 * GetPinListByPathCommand - Business Logic for fetching Pin list by path
 * 
 * Command Pattern implementation following IDFramework architecture.
 * 
 * This command:
 * 1. Fetches Pin list from specified path using BusinessDelegate
 * 2. Returns paginated results with cursor support
 * 
 * @class GetPinListByPathCommand
 */
export default class GetPinListByPathCommand {
  /**
   * Execute the command
   * 
   * @param {Object} params - Command parameters
   * @param {Object} params.payload - Event payload
   *   - path: {string} - Path to query (e.g., '/protocols/gamescorerecording')
   *   - cursor: {number} - Cursor for pagination (default: 0)
   *   - size: {number} - Page size (default: 100)
   * @param {Object} params.stores - Alpine stores object
   * @param {Function} params.delegate - BusinessDelegate function
   * @returns {Promise<Object>} Pin list response with data and nextCursor
   */
  async execute({ payload = {}, stores, delegate }) {
    try {
      const { path, cursor = 0, size = 100 } = payload;

      if (!path) {
        throw new Error('path is required');
      }

      // Build query parameters
      const queryParams = new URLSearchParams({
        cursor: cursor.toString(),
        size: size.toString(),
        path: path
      });
      
      // Call BusinessDelegate to fetch Pin list
      const response = await delegate('metaid_man', `/pin/path/list?${queryParams.toString()}`, {
        method: 'GET'
      });
      
      return response.data;
    } catch (error) {
      console.error('GetPinListByPathCommand error:', error);
      throw error;
    }
  }
}
