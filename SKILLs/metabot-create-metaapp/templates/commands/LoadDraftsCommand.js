import { NoteDraftDB } from '../stores/note/draft-db.js';

export default class LoadDraftsCommand {
  constructor(options = {}) {
    this._draftDB = options && options.draftDB ? options.draftDB : null;
  }

  async execute({ stores = {} } = {}) {
    var draftStore = stores.draft && typeof stores.draft === 'object' ? stores.draft : null;
    if (draftStore) {
      draftStore.isLoading = true;
      draftStore.error = '';
    }

    try {
      var db = this._draftDB || new NoteDraftDB();
      var items = await db.getAllDrafts();

      if (draftStore) {
        draftStore.items = items;
      }

      return items;
    } catch (error) {
      if (draftStore) draftStore.error = error && error.message ? error.message : String(error);
      throw error;
    } finally {
      if (draftStore) draftStore.isLoading = false;
    }
  }
}

