import { NoteDraftDB } from '../stores/note/draft-db.js';

function normalizeDraftId(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce(function collect(result, item) {
    var text = String(item || '').trim();
    if (!text) return result;
    result.push(text);
    return result;
  }, []);
}

export default class SaveDraftCommand {
  constructor(options = {}) {
    this._draftDB = options && options.draftDB ? options.draftDB : null;
  }

  async execute({ payload = {}, stores = {} } = {}) {
    var editorStore = stores.note && stores.note.editor ? stores.note.editor : null;
    var draftStore = stores.draft && typeof stores.draft === 'object' ? stores.draft : null;
    var form = payload.form || (editorStore ? editorStore.form : null) || {};

    var draftId = normalizeDraftId(
      payload.draftId ??
      payload.id ??
      (editorStore ? editorStore.currentDraftId : null) ??
      (draftStore ? draftStore.currentDraftId : null)
    );

    if (editorStore) {
      editorStore.isSaving = true;
      editorStore.error = '';
    }
    if (draftStore) {
      draftStore.isLoading = true;
      draftStore.error = '';
    }

    try {
      var db = this._draftDB || new NoteDraftDB();
      var pinId = String(payload.pinId ?? (editorStore ? editorStore.pinId : '') ?? '').trim();

      var savedId = await db.saveDraft({
        id: draftId || undefined,
        title: String(form.title || ''),
        subtitle: String(form.subtitle || ''),
        coverImg: String(form.coverImg || ''),
        content: String(form.content || ''),
        tags: normalizeTags(form.tags),
        pinId: pinId,
      });

      // Replace media rows (autosave behavior).
      var pending = Array.isArray(payload.pendingAttachments)
        ? payload.pendingAttachments
        : (editorStore && Array.isArray(editorStore.pendingAttachments) ? editorStore.pendingAttachments : []);
      await db.replaceMediaFilesByDraftId(savedId, pending.map(function normalizePending(item) {
        var value = item && typeof item === 'object' ? item : {};
        return {
          draftId: savedId,
          blobUrl: String(value.blobUrl || ''),
          file: value.file,
          type: String(value.type || ''),
          name: String(value.name || ''),
          mediaId: String(value.mediaId || ''),
          pinId: pinId,
          createdAt: value.createdAt,
        };
      }));

      if (editorStore) editorStore.currentDraftId = savedId;
      if (draftStore) draftStore.currentDraftId = savedId;

      return { draftId: savedId };
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      if (editorStore) editorStore.error = message;
      if (draftStore) draftStore.error = message;
      throw error;
    } finally {
      if (editorStore) editorStore.isSaving = false;
      if (draftStore) draftStore.isLoading = false;
    }
  }
}
