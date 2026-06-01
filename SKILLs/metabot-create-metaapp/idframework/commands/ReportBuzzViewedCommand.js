export default class ReportBuzzViewedCommand {
  async execute({ payload = {}, delegate }) {
    if (!delegate) {
      throw new Error('ReportBuzzViewedCommand: delegate is required');
    }

    var address = String(payload.address || '').trim();
    var pinIdList = Array.isArray(payload.pinIdList)
      ? payload.pinIdList.map(function (id) { return String(id || '').trim(); }).filter(Boolean)
      : [];

    if (!address || pinIdList.length === 0) {
      return { code: 0, data: { skipped: true } };
    }

    return await delegate('metaid_man', '/social/buzz/viewed/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({
        address: address,
        pinIdList: pinIdList,
      }),
    });
  }
}
