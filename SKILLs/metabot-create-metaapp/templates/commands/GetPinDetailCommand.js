/**
 * GetPinDetailCommand - Business Logic for fetching Pin detail
 */
export default class GetPinDetailCommand {
  async execute({ payload = {}, delegate }) {
    const { numberOrId } = payload;
    if (!numberOrId) {
      throw new Error('numberOrId is required');
    }

    const response = await delegate('metaid_man', `/pin/${numberOrId}`, {
      method: 'GET',
    });
    return response.data || response;
  }
}
