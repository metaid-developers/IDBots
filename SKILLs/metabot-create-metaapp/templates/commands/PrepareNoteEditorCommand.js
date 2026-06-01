import { createEmptyNoteForm, parseNoteSummary } from '../utils/note-adapter.js';
import { decryptNoteContent } from '../utils/note-crypto.js';
import { NoteDraftDB } from '../stores/note/draft-db.js';

function normalizeDraftId(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function cloneEmptyForm(currentForm) {
  return {
    ...createEmptyNoteForm(),
    ...(currentForm && typeof currentForm === 'object' ? currentForm : {}),
  };
}

function applyDraftToForm(currentForm, draft) {
  return {
    ...cloneEmptyForm(currentForm),
    title: String(draft && draft.title || ''),
    subtitle: String(draft && draft.subtitle || ''),
    coverImg: String(draft && draft.coverImg || ''),
    content: String(draft && draft.content || ''),
    tags: Array.isArray(draft && draft.tags) ? draft.tags.map(function toText(tag) {
      return String(tag || '').trim();
    }).filter(Boolean) : [],
  };
}

function applyNoteToForm(currentForm, noteData) {
  return {
    ...cloneEmptyForm(currentForm),
    ...noteData,
    attachments: Array.isArray(noteData && noteData.attachments) ? noteData.attachments.slice() : [],
    tags: Array.isArray(noteData && noteData.tags) ? noteData.tags.slice() : [],
  };
}

function extractPayload(response) {
  if (response && typeof response === 'object' && response.data && typeof response.data === 'object') {
    return response.data;
  }
  return response && typeof response === 'object' ? response : {};
}

async function resolvePreferredDraft(db, explicitDraftId, pinId) {
  var draftId = normalizeDraftId(explicitDraftId);
  if (draftId) {
    return await db.getDraft(draftId);
  }

  var drafts = await db.getAllDrafts();
  var matchPinId = String(pinId || '').trim();
  if (matchPinId) {
    for (var i = 0; i < drafts.length; i += 1) {
      if (String(drafts[i] && drafts[i].pinId || '').trim() === matchPinId) return drafts[i];
    }
    return null;
  }

  for (var j = 0; j < drafts.length; j += 1) {
    if (!String(drafts[j] && drafts[j].pinId || '').trim()) return drafts[j];
  }
  return null;
}

function getWalletAddress(stores, payload) {
  var explicit = String(payload && payload.walletAddress || '').trim();
  if (explicit) return explicit;
  if (stores && stores.wallet && stores.wallet.address) return String(stores.wallet.address).trim();
  if (stores && stores.user && stores.user.user && stores.user.user.address) return String(stores.user.user.address).trim();
  return '';
}

export default class PrepareNoteEditorCommand {
  constructor(options = {}) {
    this._draftDB = options && options.draftDB ? options.draftDB : null;
  }

  async execute({ payload = {}, stores = {}, delegate } = {}) {
    var editorStore = stores.note && stores.note.editor ? stores.note.editor : null;
    var draftStore = stores.draft && typeof stores.draft === 'object' ? stores.draft : null;
    var route = payload.route || (stores.note && stores.note.route) || (stores.app && stores.app.route) || {};
    var routeParams = route && route.params && typeof route.params === 'object' ? route.params : {};
    var routeQuery = route && route.query && typeof route.query === 'object' ? route.query : {};
    var pinId = String(payload.pinId || routeParams.id || '').trim();
    var mode = pinId ? 'edit' : 'create';

    if (editorStore) {
      editorStore.isLoading = true;
      editorStore.error = '';
      editorStore.mode = mode;
      editorStore.pinId = pinId;
      editorStore.form = cloneEmptyForm(editorStore.form);
      editorStore.existingAttachments = [];
      editorStore.pendingAttachments = [];
      editorStore.currentDraftId = null;
    }

    try {
      var db = this._draftDB || new NoteDraftDB();
      var draft = await resolvePreferredDraft(db, payload.draftId ?? routeQuery.draftId, pinId);
      var mediaFiles = draft && draft.id ? await db.getMediaFilesByDraftId(draft.id) : [];
      var draftId = draft && draft.id ? Number(draft.id) : null;

      if (mode === 'create') {
        if (editorStore && draft) {
          editorStore.form = applyDraftToForm(editorStore.form, draft);
          editorStore.pendingAttachments = Array.isArray(mediaFiles) ? mediaFiles : [];
          editorStore.currentDraftId = draftId;
        }
        if (draftStore) draftStore.currentDraftId = draftId;
        return {
          mode: mode,
          draft: draft,
          mediaFiles: mediaFiles,
          pin: null,
          noteData: null,
        };
      }

      if (typeof delegate !== 'function') {
        throw new Error('PrepareNoteEditorCommand: delegate is required in edit mode');
      }

      var pin = extractPayload(await delegate('metaid_man', '/pin/' + encodeURIComponent(pinId), {
        method: 'GET',
      }));
      var noteData = parseNoteSummary(pin);
      var decryptError = '';
      if (String(noteData.encryption || '0') !== '0') {
        try {
          noteData = await decryptNoteContent({
            noteData: noteData,
            walletAddress: getWalletAddress(stores, payload),
            noteAddress: pin && pin.address,
            legacyKey: payload.legacyKey,
            getLegacyKey: payload.getLegacyKey,
            cryptoObject: payload.cryptoObject,
          });
        } catch (error) {
          decryptError = error && error.message ? error.message : String(error);
          if (editorStore) {
            editorStore.error = decryptError;
          }
        }
      }

      var blocked = !draft && !!decryptError;

      if (editorStore) {
        editorStore.existingAttachments = blocked
          ? []
          : (Array.isArray(noteData.attachments) ? noteData.attachments.slice() : []);
        editorStore.form = draft
          ? applyDraftToForm(editorStore.form, draft)
          : (blocked ? cloneEmptyForm(editorStore.form) : applyNoteToForm(editorStore.form, noteData));
        editorStore.pendingAttachments = Array.isArray(mediaFiles) ? mediaFiles : [];
        editorStore.currentDraftId = draftId;
      }
      if (draftStore) draftStore.currentDraftId = draftId;

      return {
        mode: mode,
        pin: pin,
        noteData: noteData,
        draft: draft,
        mediaFiles: mediaFiles,
        blocked: blocked,
        redirectPath: blocked ? '/note/' + pinId : '',
        error: decryptError,
      };
    } catch (error) {
      var message = error && error.message ? error.message : String(error);
      if (editorStore) editorStore.error = message;
      throw error;
    } finally {
      if (editorStore) editorStore.isLoading = false;
    }
  }
}
