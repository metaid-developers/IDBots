import { mergeNoteAttachments } from '../utils/note-attachments.js';
import { encryptNoteContent } from '../utils/note-crypto.js';
import DeleteDraftCommand from './DeleteDraftCommand.js';

function getEditorStore(stores) {
  return stores && stores.note && stores.note.editor ? stores.note.editor : null;
}

function normalizeWalletAddress(stores, payload) {
  var explicit = String(payload && payload.walletAddress || '').trim();
  if (explicit) return explicit;
  var wallet = stores && stores.wallet ? stores.wallet : null;
  if (wallet && wallet.address) return String(wallet.address).trim();
  var user = stores && stores.user && stores.user.user ? stores.user.user : null;
  if (user && user.address) return String(user.address).trim();
  return '';
}

function normalizeDraftId(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

export default class UpdateNoteCommand {
  constructor(options = {}) {
    this._draftDB = options && options.draftDB ? options.draftDB : null;
  }

  async execute({ payload = {}, stores = {} } = {}) {
    if (!window.IDFramework || !window.IDFramework.BuiltInCommands || !window.IDFramework.BuiltInCommands.createPin) {
      throw new Error('IDFramework.BuiltInCommands.createPin is not available');
    }

    var editorStore = getEditorStore(stores);
    if (editorStore) {
      editorStore.isSaving = true;
      editorStore.error = '';
    }

    try {
      var pinId = String(payload.pinId || (editorStore ? editorStore.pinId : '') || '').trim();
      if (!pinId) throw new Error('pinId is required');

      var form = payload.form || (editorStore ? editorStore.form : null) || {};
      var processedContent = payload.processedContent !== undefined ? payload.processedContent : form.content;

      var baseExisting = Array.isArray(payload.existingAttachments)
        ? payload.existingAttachments
        : (editorStore && Array.isArray(editorStore.existingAttachments) ? editorStore.existingAttachments : null);
      if (!baseExisting) baseExisting = Array.isArray(form.attachments) ? form.attachments : [];

      var incoming = Array.isArray(payload.pendingAttachments)
        ? payload.pendingAttachments
        : (editorStore && Array.isArray(editorStore.pendingAttachments) ? editorStore.pendingAttachments : []);
      var mergedAttachments = mergeNoteAttachments(baseExisting, incoming);

      var finalNoteData = {
        ...form,
        content: String(processedContent || ''),
        coverImg: String(payload.coverImg ?? form.coverImg ?? ''),
        attachments: mergedAttachments,
      };

      var walletAddress = normalizeWalletAddress(stores, payload);
      var isPrivate = !!payload.isPrivate || String(form.encryption || '0') !== '0';
      finalNoteData = await encryptNoteContent({
        noteData: finalNoteData,
        isPrivate: isPrivate,
        walletAddress: walletAddress,
      });

      var pinRes = await window.IDFramework.BuiltInCommands.createPin({
        payload: {
          operation: 'modify',
          path: '@' + pinId,
          body: JSON.stringify(finalNoteData),
          contentType: 'application/json',
        },
        stores: stores,
      });

      var draftId = normalizeDraftId(
        payload.draftId ??
        (editorStore ? editorStore.currentDraftId : null) ??
        (stores.draft ? stores.draft.currentDraftId : null)
      );
      if (draftId) {
        var deleteDraft = new DeleteDraftCommand({ draftDB: this._draftDB });
        await deleteDraft.execute({ payload: { draftId: draftId }, stores: stores });
      }

      return { pinRes: pinRes, noteData: finalNoteData, pinId: pinId };
    } catch (error) {
      if (editorStore) editorStore.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      if (editorStore) editorStore.isSaving = false;
    }
  }
}

