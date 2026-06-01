function extractPayload(response) {
  if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
    return response.data;
  }
  return response && typeof response === 'object' ? response : {};
}

export default class ResolveNoteAuthorCommand {
  async execute({ payload = {}, stores = {}, delegate }) {
    if (typeof delegate !== 'function') {
      throw new Error('ResolveNoteAuthorCommand: delegate is required');
    }

    const address = String(
      payload.address ||
      (stores.note && stores.note.detail && stores.note.detail.pin && stores.note.detail.pin.address) ||
      ''
    ).trim();
    if (!address) throw new Error('address is required');

    const author = extractPayload(await delegate('metaid_man', `/info/address/${encodeURIComponent(address)}`, {
      method: 'GET',
    }));

    const detailStore = stores.note && stores.note.detail ? stores.note.detail : null;
    if (detailStore && detailStore.pin && String(detailStore.pin.address || '').trim() === address) {
      detailStore.author = author;
    }

    return author;
  }
}
