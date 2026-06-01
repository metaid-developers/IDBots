import { parseNoteSummary } from '../utils/note-adapter.js';

function extractPayload(response) {
  if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
    return response.data;
  }
  return response && typeof response === 'object' ? response : {};
}

export default class FetchNoteDetailCommand {
  async execute({ payload = {}, stores = {}, delegate }) {
    if (typeof delegate !== 'function') {
      throw new Error('FetchNoteDetailCommand: delegate is required');
    }

    const numberOrId = String(payload.numberOrId || '').trim();
    if (!numberOrId) throw new Error('numberOrId is required');

    const detailStore = stores.note && stores.note.detail ? stores.note.detail : null;
    const previousPinId = detailStore ? String(detailStore.pinId || '') : '';
    const previousAddress = detailStore && detailStore.pin
      ? String(detailStore.pin.address || '').trim()
      : '';
    if (detailStore) {
      detailStore.isLoading = true;
      detailStore.error = '';
    }

    try {
      const pin = extractPayload(await delegate('metaid_man', `/pin/${encodeURIComponent(numberOrId)}`, {
        method: 'GET',
      }));
      const noteData = parseNoteSummary(pin);
      const nextPinId = String(pin.id || numberOrId);
      const nextAddress = String(pin.address || '').trim();
      const result = { pin, noteData };

      if (detailStore) {
        detailStore.pinId = nextPinId;
        detailStore.pin = pin;
        detailStore.noteData = noteData;
        if (previousPinId !== nextPinId || previousAddress !== nextAddress) {
          detailStore.author = null;
        }
      }

      return result;
    } catch (error) {
      if (detailStore) detailStore.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      if (detailStore) detailStore.isLoading = false;
    }
  }
}
