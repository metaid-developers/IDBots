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

      const normalizedPinId = this._normalizePinReference(numberOrId);
      if (!normalizedPinId) throw new Error('Invalid pin id');

      const response = await delegate('metaid_man', `/api/pin/${encodeURIComponent(normalizedPinId)}`, {
        method: 'GET',
      });
      if (response && Object.prototype.hasOwnProperty.call(response, 'data')) {
        return response.data;
      }
      return response;
    } catch (error) {
      console.error('GetPinDetailCommand error:', error);
      throw error;
    }
  }

  _normalizePinReference(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    const exact = text.match(/[A-Fa-f0-9]{64}i\d+/);
    if (exact && exact[0]) return exact[0];
    let cleaned = text.split('?')[0].split('#')[0].replace(/\/+$/, '');
    if (cleaned.startsWith('metafile://')) cleaned = cleaned.slice('metafile://'.length);
    if (cleaned.includes('/pin/')) cleaned = cleaned.split('/pin/').pop() || '';
    if (cleaned.includes('/content/')) cleaned = cleaned.split('/content/').pop() || '';
    const matched = cleaned.match(/[A-Fa-f0-9]{64}i\d+/);
    if (matched && matched[0]) return matched[0];
    return cleaned;
  }
}
