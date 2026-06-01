import { NoteDraftDB } from '../stores/note/draft-db.js';

function normalizeDraftId(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export default class DeleteDraftCommand {
  constructor(options = {}) {
    this._draftDB = options && options.draftDB ? options.draftDB : null;
  }

  async execute({ payload = {}, stores = {} } = {}) {
    var draftId = normalizeDraftId(payload.draftId ?? payload.id);
    if (!draftId) return null;

    var draftStore = stores.draft && typeof stores.draft === 'object' ? stores.draft : null;
    if (draftStore) {
      draftStore.isLoading = true;
      draftStore.error = '';
    }

    try {
      var db = this._draftDB || new NoteDraftDB();
      await db.deleteDraft(draftId);

      if (draftStore) {
        draftStore.items = Array.isArray(draftStore.items)
          ? draftStore.items.filter(function keep(item) {
              return Number(item && item.id) !== draftId;
            })
          : [];
        if (normalizeDraftId(draftStore.currentDraftId) === draftId) {
          draftStore.currentDraftId = null;
        }
      }

      var editorStore = stores.note && stores.note.editor ? stores.note.editor : null;
      if (editorStore && normalizeDraftId(editorStore.currentDraftId) === draftId) {
        editorStore.currentDraftId = null;
      }

      return { draftId: draftId };
    } catch (error) {
      if (draftStore) draftStore.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      if (draftStore) draftStore.isLoading = false;
    }
  }
}

