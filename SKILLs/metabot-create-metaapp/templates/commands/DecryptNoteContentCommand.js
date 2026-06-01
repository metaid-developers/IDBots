import { decryptNoteContent } from '../utils/note-crypto.js';

export default class DecryptNoteContentCommand {
  async execute({ payload = {}, stores = {} }) {
    const detailStore = stores.note && stores.note.detail ? stores.note.detail : null;
    const noteData = payload.noteData || (detailStore ? detailStore.noteData : null);
    const noteAddress = String(
      payload.noteAddress ||
      (payload.pin && payload.pin.address) ||
      (detailStore && detailStore.pin && detailStore.pin.address) ||
      ''
    ).trim();
    const walletAddress = String(
      payload.walletAddress ||
      (stores.wallet && stores.wallet.address) ||
      (stores.user && stores.user.user && stores.user.user.address) ||
      ''
    ).trim();

    const result = await decryptNoteContent({
      noteData,
      walletAddress,
      noteAddress,
      legacyKey: payload.legacyKey,
      getLegacyKey: payload.getLegacyKey,
      cryptoObject: payload.cryptoObject,
    });

    if (detailStore && detailStore.noteData === noteData) {
      detailStore.noteData = result;
    }

    return result;
  }
}
