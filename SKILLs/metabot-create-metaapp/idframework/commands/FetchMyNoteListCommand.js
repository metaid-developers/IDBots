import { adaptNoteSummary } from '../utils/note-adapter.js';

const NOTE_PROTOCOL = '/protocols/simplenote';

function shouldAppendPage(cursor) {
  if (cursor === undefined || cursor === null) return false;
  var text = String(cursor).trim();
  return text !== '' && text !== '0';
}

function normalizePinListResponse(response) {
  const payload = response && typeof response === 'object' && response.data && typeof response.data === 'object'
    ? response.data
    : (response && typeof response === 'object' ? response : {});
  const list = Array.isArray(payload.list) ? payload.list : [];
  const total = Number(payload.total);
  const nextCursor = payload.nextCursor !== undefined && payload.nextCursor !== null ? payload.nextCursor : '';

  return {
    list,
    total: Number.isFinite(total) ? total : list.length,
    nextCursor,
  };
}

function normalizePositive(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function resolveCurrentCursor(payloadCursor, requestCursor, listStore) {
  if (payloadCursor !== undefined && payloadCursor !== null) return String(payloadCursor);
  if (requestCursor !== undefined && requestCursor !== null) return String(requestCursor);
  if (listStore && listStore.currentCursor !== undefined && listStore.currentCursor !== null) {
    return String(listStore.currentCursor);
  }
  return '0';
}

function resolveCursorHistory(payloadHistory, listStore) {
  if (Array.isArray(payloadHistory)) return payloadHistory.slice();
  if (listStore && Array.isArray(listStore.cursorHistory)) return listStore.cursorHistory.slice();
  return ['0'];
}

export default class FetchMyNoteListCommand {
  async execute({ payload = {}, stores = {}, delegate }) {
    if (typeof delegate !== 'function') {
      throw new Error('FetchMyNoteListCommand: delegate is required');
    }

    const address = String(payload.address || '').trim();
    if (!address) throw new Error('address is required');

    const listStore = stores.note && stores.note.myList ? stores.note.myList : null;
    const requestCursor = payload.cursor ?? 0;
    const sizeValue = normalizePositive(payload.size ?? payload.pageSize ?? 20, 20);
    const replaceMode = !!payload.replace;
    const pageValue = normalizePositive(payload.page ?? (listStore && listStore.page) ?? 1, 1);
    const pageSizeValue = normalizePositive(payload.pageSize ?? sizeValue, sizeValue);
    const currentCursor = resolveCurrentCursor(payload.currentCursor, requestCursor, listStore);
    const cursorHistory = resolveCursorHistory(payload.cursorHistory, listStore);
    const query = new URLSearchParams({
      path: NOTE_PROTOCOL,
      cursor: String(requestCursor),
      size: String(sizeValue),
    });

    if (listStore) {
      listStore.isLoading = true;
      listStore.error = '';
    }

    try {
      const response = await delegate('metaid_man', `/address/pin/list/${encodeURIComponent(address)}?${query.toString()}`, {
        method: 'GET',
      });
      const normalized = normalizePinListResponse(response);
      const pageItems = normalized.list.map((pin) => ({
        pin,
        noteData: adaptNoteSummary(pin).noteData,
      }));
      const existingItems = listStore && Array.isArray(listStore.items) ? listStore.items : [];
      const shouldAppend = !replaceMode && shouldAppendPage(payload.cursor);
      const items = shouldAppend ? existingItems.concat(pageItems) : pageItems;
      const hasMore = normalized.nextCursor !== '' && normalized.nextCursor !== null && normalized.nextCursor !== undefined;
      const historySnapshot = Array.isArray(cursorHistory) ? cursorHistory.slice() : [];
      const result = {
        items,
        total: normalized.total,
        cursor: normalized.nextCursor,
        hasMore: hasMore,
        page: pageValue,
        pageSize: pageSizeValue,
        currentCursor: currentCursor,
        cursorHistory: historySnapshot,
      };

      if (listStore) {
        listStore.items = items;
        listStore.cursor = result.cursor;
        listStore.hasMore = result.hasMore;
        listStore.page = pageValue;
        listStore.pageSize = pageSizeValue;
        listStore.currentCursor = currentCursor;
        listStore.cursorHistory = historySnapshot;
      }

      return result;
    } catch (error) {
      if (listStore) listStore.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      if (listStore) listStore.isLoading = false;
    }
  }
}
