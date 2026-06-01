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

export default class LoadDraftByIdCommand {
  constructor(options = {}) {
    this._draftDB = options && options.draftDB ? options.draftDB : null;
  }

  async execute({ payload = {}, stores = {} } = {}) {
    var draftId = normalizeDraftId(payload.draftId ?? payload.id);
    if (!draftId) throw new Error('draftId is required');

    var editorStore = stores.note && stores.note.editor ? stores.note.editor : null;
    if (editorStore) {
      editorStore.isLoading = true;
      editorStore.error = '';
    }

    try {
      var db = this._draftDB || new NoteDraftDB();
      var draft = await db.getDraft(draftId);
      if (!draft) throw new Error('Draft not found');
      var mediaFiles = await db.getMediaFilesByDraftId(draftId);

      if (editorStore) {
        editorStore.currentDraftId = draftId;
        editorStore.form = {
          ...editorStore.form,
          title: String(draft.title || ''),
          subtitle: String(draft.subtitle || ''),
          coverImg: String(draft.coverImg || ''),
          content: String(draft.content || ''),
          tags: normalizeTags(draft.tags),
        };
        editorStore.pendingAttachments = Array.isArray(mediaFiles) ? mediaFiles : [];
      }

      var draftStore = stores.draft && typeof stores.draft === 'object' ? stores.draft : null;
      if (draftStore) {
        draftStore.currentDraftId = draftId;
      }

      return { draft: draft, mediaFiles: mediaFiles };
    } catch (error) {
      if (editorStore) editorStore.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      if (editorStore) editorStore.isLoading = false;
    }
  }
}

