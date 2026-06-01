const DRAFT_STORE = 'drafts';
const MEDIA_STORE = 'mediaFiles';

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce(function collect(result, item) {
    var text = String(item || '').trim();
    if (!text) return result;
    result.push(text);
    return result;
  }, []);
}

function safeRevokeBlobUrl(blobUrl) {
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  var text = String(blobUrl || '');
  if (text.indexOf('blob:') !== 0) return;
  URL.revokeObjectURL(text);
}

function normalizeInlineId(value) {
  var numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function withOptionalId(record, value) {
  var id = normalizeInlineId(value);
  if (!id) return record;
  return {
    id: id,
    ...record,
  };
}

class NativeDraftStorage {
  constructor(options = {}) {
    this._indexedDB = options.indexedDB || globalThis.indexedDB || null;
    this._dbName = String(options.dbName || 'idframework-note-drafts');
    this._dbPromise = null;
  }

  async _db() {
    if (this._dbPromise) return this._dbPromise;

    if (!this._indexedDB || typeof this._indexedDB.open !== 'function') {
      throw new Error('IndexedDB is unavailable');
    }

    this._dbPromise = new Promise((resolve, reject) => {
      var request = this._indexedDB.open(this._dbName, 1);

      request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
      request.onsuccess = () => resolve(request.result);
      request.onupgradeneeded = (event) => {
        var db = event.target.result;

        if (!db.objectStoreNames.contains(DRAFT_STORE)) {
          var drafts = db.createObjectStore(DRAFT_STORE, { keyPath: 'id', autoIncrement: true });
          drafts.createIndex('updatedAt', 'updatedAt', { unique: false });
          drafts.createIndex('pinId', 'pinId', { unique: false });
        }

        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          var mediaFiles = db.createObjectStore(MEDIA_STORE, { keyPath: 'id', autoIncrement: true });
          mediaFiles.createIndex('draftId', 'draftId', { unique: false });
          mediaFiles.createIndex('blobUrl', 'blobUrl', { unique: false });
          mediaFiles.createIndex('pinId', 'pinId', { unique: false });
        }
      };
    });

    return this._dbPromise;
  }

  async put(storeName, value) {
    var db = await this._db();
    return new Promise((resolve, reject) => {
      var transaction = db.transaction([storeName], 'readwrite');
      var request = transaction.objectStore(storeName).put(value);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Failed to save record'));
    });
  }

  async get(storeName, id) {
    var db = await this._db();
    return new Promise((resolve, reject) => {
      var transaction = db.transaction([storeName], 'readonly');
      var request = transaction.objectStore(storeName).get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('Failed to read record'));
    });
  }

  async getAll(storeName) {
    var db = await this._db();
    return new Promise((resolve, reject) => {
      var transaction = db.transaction([storeName], 'readonly');
      var store = transaction.objectStore(storeName);
      var request = typeof store.getAll === 'function' ? store.getAll() : store.openCursor();

      if (typeof store.getAll === 'function') {
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      } else {
        var rows = [];
        request.onsuccess = () => {
          var cursor = request.result;
          if (!cursor) {
            resolve(rows);
            return;
          }
          rows.push(cursor.value);
          cursor.continue();
        };
      }

      request.onerror = () => reject(request.error || new Error('Failed to read records'));
    });
  }

  async getAllByIndex(storeName, indexName, value) {
    var db = await this._db();
    return new Promise((resolve, reject) => {
      var transaction = db.transaction([storeName], 'readonly');
      var index = transaction.objectStore(storeName).index(indexName);
      var request = typeof index.getAll === 'function' ? index.getAll(value) : index.openCursor(value);

      if (typeof index.getAll === 'function') {
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      } else {
        var rows = [];
        request.onsuccess = () => {
          var cursor = request.result;
          if (!cursor) {
            resolve(rows);
            return;
          }
          rows.push(cursor.value);
          cursor.continue();
        };
      }

      request.onerror = () => reject(request.error || new Error('Failed to read indexed records'));
    });
  }

  async delete(storeName, id) {
    var db = await this._db();
    return new Promise((resolve, reject) => {
      var transaction = db.transaction([storeName], 'readwrite');
      var request = transaction.objectStore(storeName).delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error('Failed to delete record'));
    });
  }

  async deleteByIndex(storeName, indexName, value) {
    var rows = await this.getAllByIndex(storeName, indexName, value);
    for (var i = 0; i < rows.length; i += 1) {
      if (!rows[i] || !rows[i].id) continue;
      await this.delete(storeName, rows[i].id);
    }
  }
}

export class NoteDraftDB {
  constructor(options = {}) {
    this._storage = options.storage || new NativeDraftStorage(options);
  }

  async saveDraft(draft) {
    var current = draft && draft.id ? await this.getDraft(draft.id) : null;
    var now = Date.now();
    var nextDraft = withOptionalId({
      title: String(draft && draft.title || ''),
      subtitle: String(draft && draft.subtitle || ''),
      coverImg: String(draft && draft.coverImg || ''),
      content: String(draft && draft.content || ''),
      tags: normalizeTags(draft && draft.tags),
      pinId: String(draft && draft.pinId || ''),
      updatedAt: now,
      createdAt: current && current.createdAt ? current.createdAt : now,
    }, current && current.id ? current.id : draft && draft.id);

    var id = await this._storage.put(DRAFT_STORE, nextDraft);
    return Number(id);
  }

  async getAllDrafts() {
    var drafts = await this._storage.getAll(DRAFT_STORE);
    return drafts.sort(function sortByUpdatedAtDesc(left, right) {
      return Number(right && right.updatedAt || 0) - Number(left && left.updatedAt || 0);
    });
  }

  async getDraft(id) {
    return await this._storage.get(DRAFT_STORE, Number(id));
  }

  async saveMediaFile(media) {
    var now = Date.now();
    return await this._storage.put(MEDIA_STORE, withOptionalId({
      draftId: Number(media && media.draftId || 0),
      blobUrl: String(media && media.blobUrl || ''),
      file: media ? media.file : undefined,
      type: String(media && media.type || ''),
      name: String(media && media.name || ''),
      mediaId: String(media && media.mediaId || ''),
      pinId: String(media && media.pinId || ''),
      createdAt: media && media.createdAt ? Number(media.createdAt) : now,
    }, media && media.id));
  }

  async getMediaFilesByDraftId(id) {
    var rows = await this._storage.getAllByIndex(MEDIA_STORE, 'draftId', Number(id));
    return rows.sort(function sortByCreatedAtAsc(left, right) {
      return Number(left && left.createdAt || 0) - Number(right && right.createdAt || 0);
    });
  }

  async replaceMediaFilesByDraftId(id, mediaFiles) {
    var draftId = Number(id);
    await this._storage.deleteByIndex(MEDIA_STORE, 'draftId', draftId);
    var rows = Array.isArray(mediaFiles) ? mediaFiles : [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
      await this.saveMediaFile({
        draftId: draftId,
        blobUrl: String(row.blobUrl || ''),
        file: row.file,
        type: String(row.type || ''),
        name: String(row.name || ''),
        mediaId: String(row.mediaId || ''),
        pinId: String(row.pinId || ''),
        createdAt: row.createdAt,
      });
    }
  }

  async deleteDraft(id) {
    var mediaFiles = await this.getMediaFilesByDraftId(id);
    mediaFiles.forEach(function revoke(mediaFile) {
      safeRevokeBlobUrl(mediaFile && mediaFile.blobUrl);
    });
    await this._storage.deleteByIndex(MEDIA_STORE, 'draftId', Number(id));
    await this._storage.delete(DRAFT_STORE, Number(id));
  }
}
