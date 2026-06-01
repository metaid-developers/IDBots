import './id-note-markdown-editor.js';
import './id-note-attachment-picker.js';
import './id-note-cover-picker.js';
import './id-chain-fee-selector.js';
import { dataUrlFileName, dataUrlToFile, isDataUrl } from '../utils/file-data-url.js';

export const NOTE_EDITOR_AUTOSAVE_MS = 5000;

function cloneEditorForm(form) {
  return {
    title: String(form && form.title || ''),
    subtitle: String(form && form.subtitle || ''),
    content: String(form && form.content || ''),
    contentType: String(form && form.contentType || 'text/markdown'),
    encryption: String(form && form.encryption || '0'),
    coverImg: String(form && form.coverImg || ''),
    createTime: form && form.createTime ? form.createTime : '',
    tags: Array.isArray(form && form.tags) ? form.tags.slice() : [],
    attachments: Array.isArray(form && form.attachments) ? form.attachments.slice() : [],
  };
}

function normalizePendingAttachment(item) {
  if (typeof item === 'string') return item;
  var value = item && typeof item === 'object' ? { ...item } : {};
  return {
    mediaId: String(value.mediaId || ('media-' + Date.now() + '-' + Math.random().toString(36).slice(2))),
    name: String(value.name || ''),
    type: String(value.type || ''),
    blobUrl: String(value.blobUrl || ''),
    uploadedUri: String(value.uploadedUri || ''),
    file: value.file,
  };
}

function slugifyFileStem(value) {
  var text = String(value || '').trim().toLowerCase();
  text = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return text || 'note';
}

class IdNoteEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._watchTimer = null;
    this._autosaveTimer = null;
    this._lastContextKey = '';
    this._savedSnapshot = '';
    this._autosaveFailed = false;
    this._onBeforeUnload = this._handleBeforeUnload.bind(this);
    this._onLocaleChanged = this.render.bind(this);
  }

  connectedCallback() {
    this._ensureStoreShape();
    this._savedSnapshot = this._currentSnapshot();
    if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', this._onBeforeUnload);
      window.addEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    this.render();
    this._watchTimer = setInterval(() => this._checkContext(false), 260);
    if (this._watchTimer && typeof this._watchTimer.unref === 'function') this._watchTimer.unref();
    this._autosaveTimer = setInterval(() => this._runAutosave(), NOTE_EDITOR_AUTOSAVE_MS);
    if (this._autosaveTimer && typeof this._autosaveTimer.unref === 'function') this._autosaveTimer.unref();
  }

  disconnectedCallback() {
    if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
      window.removeEventListener('beforeunload', this._onBeforeUnload);
      window.removeEventListener('id:i18n:changed', this._onLocaleChanged);
    }
    if (this._watchTimer) clearInterval(this._watchTimer);
    if (this._autosaveTimer) clearInterval(this._autosaveTimer);
    this._revokePendingPreviewUrls();
  }

  _t(key, fallback, params) {
    if (
      typeof window !== 'undefined' &&
      window.IDFramework &&
      window.IDFramework.I18n &&
      typeof window.IDFramework.I18n.t === 'function'
    ) {
      return window.IDFramework.I18n.t(key, params || {}, fallback || '');
    }
    return fallback || '';
  }

  _escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text == null ? '' : String(text);
    return div.innerHTML;
  }

  _escapeAttr(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _getStore(name) {
    if (typeof Alpine === 'undefined' || typeof Alpine.store !== 'function') return null;
    return Alpine.store(name) || null;
  }

  _ensureStoreShape() {
    var note = this._getStore('note');
    if (!note || !note.editor || typeof note.editor !== 'object') return;
    var editor = note.editor;
    if (!editor.form || typeof editor.form !== 'object') {
      editor.form = cloneEditorForm({});
    }
    if (!Array.isArray(editor.existingAttachments)) editor.existingAttachments = [];
    if (!Array.isArray(editor.pendingAttachments)) editor.pendingAttachments = [];
    if (!editor.mode) editor.mode = 'create';
    if (!editor.error) editor.error = '';
  }

  _editorState() {
    this._ensureStoreShape();
    var note = this._getStore('note') || {};
    return note.editor || {
      mode: 'create',
      pinId: '',
      form: cloneEditorForm({}),
      existingAttachments: [],
      pendingAttachments: [],
      currentDraftId: null,
      error: '',
      isSaving: false,
      isLoading: false,
    };
  }

  _currentSnapshot() {
    var editor = this._editorState();
    return JSON.stringify({
      mode: editor.mode,
      pinId: editor.pinId || '',
      form: cloneEditorForm(editor.form),
      existingAttachments: Array.isArray(editor.existingAttachments) ? editor.existingAttachments.slice() : [],
      pendingAttachments: Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments.map(normalizePendingAttachment) : [],
    });
  }

  _isDirty() {
    return this._currentSnapshot() !== this._savedSnapshot;
  }

  _contextKey() {
    var editor = this._editorState();
    return JSON.stringify({
      mode: editor.mode,
      pinId: editor.pinId,
      form: editor.form,
      pendingCount: Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments.length : 0,
      error: editor.error || '',
      isSaving: !!editor.isSaving,
      isLoading: !!editor.isLoading,
      dirty: this._isDirty(),
    });
  }

  _checkContext(force) {
    var nextKey = this._contextKey();
    if (!force && nextKey === this._lastContextKey) return;
    this._lastContextKey = nextKey;
    if (!this.shadowRoot || !this.shadowRoot.innerHTML) {
      this.render();
      return;
    }
    this._syncUi();
  }

  _updateField(field, value) {
    var editor = this._editorState();
    editor.form = {
      ...cloneEditorForm(editor.form),
      [field]: value,
    };
    this._autosaveFailed = false;
    this._lastContextKey = this._contextKey();
    this._syncUi();
  }

  _updateTags(raw) {
    var tags = String(raw || '').split(',').map(function normalize(tag) {
      return String(tag || '').trim();
    }).filter(Boolean);
    this._updateField('tags', tags);
  }

  _togglePrivate(nextPrivate) {
    this._updateField('encryption', nextPrivate ? '1' : '0');
  }

  _addPendingFiles(files) {
    var editor = this._editorState();
    var nextItems = Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments.slice() : [];
    Array.from(files || []).forEach((file, index) => {
      var blobUrl = '';
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        try {
          blobUrl = URL.createObjectURL(file);
        } catch (_) {}
      }
      nextItems.push(normalizePendingAttachment({
        mediaId: 'pending-' + Date.now() + '-' + index,
        name: file && file.name ? file.name : 'attachment',
        type: file && file.type ? file.type : '',
        blobUrl: blobUrl,
        file: file,
      }));
    });
    editor.pendingAttachments = nextItems;
    this._lastContextKey = this._contextKey();
    this._syncUi();
  }

  _revokePreviewUrl(item) {
    var blobUrl = item && typeof item === 'object' ? String(item.blobUrl || '') : '';
    if (!blobUrl) return;
    if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (_) {}
  }

  _revokePendingPreviewUrls() {
    var editor = this._editorState();
    var pending = Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments : [];
    for (var i = 0; i < pending.length; i += 1) {
      this._revokePreviewUrl(pending[i]);
    }
  }

  _removePendingAt(index) {
    var editor = this._editorState();
    if (Array.isArray(editor.pendingAttachments) && index >= 0 && index < editor.pendingAttachments.length) {
      this._revokePreviewUrl(editor.pendingAttachments[index]);
    }
    editor.pendingAttachments = Array.isArray(editor.pendingAttachments)
      ? editor.pendingAttachments.filter(function keep(_item, currentIndex) {
          return currentIndex !== index;
        })
      : [];
    this._lastContextKey = this._contextKey();
    this._syncUi();
  }

  async _runAutosave() {
    if (!this._isDirty()) return null;
    if (!(typeof window !== 'undefined' && window.IDFramework && typeof window.IDFramework.dispatch === 'function')) {
      return null;
    }

    var editor = this._editorState();
    try {
      var result = await window.IDFramework.dispatch('saveDraft', {
        draftId: editor.currentDraftId,
        pinId: editor.pinId,
        form: cloneEditorForm(editor.form),
        pendingAttachments: Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments.slice() : [],
      });
      if (result && result.draftId) {
        editor.currentDraftId = result.draftId;
        var draftStore = this._getStore('draft');
        if (draftStore) draftStore.currentDraftId = result.draftId;
      }
      editor.error = '';
      this._autosaveFailed = false;
      this._savedSnapshot = this._currentSnapshot();
      this._checkContext(true);
      return result;
    } catch (error) {
      editor.error = error && error.message ? error.message : String(error);
      this._autosaveFailed = true;
      this._checkContext(true);
      return null;
    }
  }

  async _uploadPendingAttachments() {
    var editor = this._editorState();
    var pending = Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments.slice() : [];
    var uploaded = [];
    for (var i = 0; i < pending.length; i += 1) {
      var item = pending[i];
      if (typeof item === 'string') {
        uploaded.push(item);
        continue;
      }
      if (item && item.uploadedUri) {
        uploaded.push(item.uploadedUri);
        continue;
      }
      if (!(typeof window !== 'undefined' && window.IDFramework && typeof window.IDFramework.dispatch === 'function')) continue;
      var result = await window.IDFramework.dispatch('uploadNoteAttachment', {
        file: item.file,
        options: { fileName: item.name },
      });
      if (typeof result === 'string') uploaded.push(result);
      else if (result && typeof result.uri === 'string') uploaded.push(result.uri);
    }
    return uploaded;
  }

  _buildCoverFileName(dataUrl) {
    var editor = this._editorState();
    var stem = slugifyFileStem(editor && editor.form ? editor.form.title : '') + '-cover';
    return dataUrlFileName(dataUrl, stem);
  }

  async _resolveCoverImg(value) {
    var coverValue = String(value || '').trim();
    if (!coverValue || !isDataUrl(coverValue)) return coverValue;
    if (!(typeof window !== 'undefined' && window.IDFramework && typeof window.IDFramework.dispatch === 'function')) {
      return coverValue;
    }

    var fileName = this._buildCoverFileName(coverValue);
    var file = dataUrlToFile(coverValue, fileName);
    var result = await window.IDFramework.dispatch('uploadNoteAttachment', {
      file: file,
      options: { fileName: fileName },
    });

    if (typeof result === 'string') return result;
    if (result && typeof result.uri === 'string') return result.uri;
    throw new Error('Cover upload did not return a URI');
  }

  async _publish() {
    if (!(typeof window !== 'undefined' && window.IDFramework && typeof window.IDFramework.dispatch === 'function')) return;
    var editor = this._editorState();
    var uploaded = await this._uploadPendingAttachments();
    var publishForm = cloneEditorForm(editor.form);
    publishForm.coverImg = await this._resolveCoverImg(publishForm.coverImg);
    var commandName = editor.mode === 'edit' ? 'updateNote' : 'createNote';
    var result = await window.IDFramework.dispatch(commandName, {
      pinId: editor.pinId,
      draftId: editor.currentDraftId,
      isPrivate: String(editor.form.encryption || '0') !== '0',
      form: publishForm,
      existingAttachments: Array.isArray(editor.existingAttachments) ? editor.existingAttachments.slice() : [],
      pendingAttachments: uploaded,
    });
    this._savedSnapshot = this._currentSnapshot();
    this._autosaveFailed = false;

    var nextPinId = editor.pinId ||
      (result && result.pinRes && result.pinRes.data && result.pinRes.data.pinId) ||
      '';
    if (nextPinId && typeof window !== 'undefined' && window.location && window.history && typeof window.history.pushState === 'function') {
      var hashUrl = window.location.pathname + window.location.search + '#/note/' + encodeURIComponent(nextPinId);
      window.history.pushState({}, '', hashUrl);
      if (typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('id:note:navigate', {
          detail: { path: '/note/' + nextPinId },
        }));
      }
    }
  }

  _handleBeforeUnload(event) {
    if (!this._isDirty() && !this._autosaveFailed) return;
    this._runAutosave();
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (event) event.returnValue = this._t('note.editor.unsaved', 'You have unsaved changes.');
  }

  _statusText(editor) {
    if (editor.error) return editor.error;
    return this._isDirty()
      ? this._t('note.editor.dirty', 'Unsaved changes')
      : this._t('note.editor.saved', 'All changes saved');
  }

  _syncUi() {
    if (!this.shadowRoot) return;
    var editor = this._editorState();
    var form = cloneEditorForm(editor.form);
    var inputs = this.shadowRoot.querySelectorAll ? this.shadowRoot.querySelectorAll('input[data-field]') : [];

    for (var i = 0; i < inputs.length; i += 1) {
      var input = inputs[i];
      if (!input || typeof input.getAttribute !== 'function') continue;
      var field = String(input.getAttribute('data-field') || '');
      if (field === 'private') {
        input.checked = String(form.encryption || '0') !== '0';
        continue;
      }
      if (field === 'tags') {
        var nextTags = Array.isArray(form.tags) ? form.tags.join(', ') : '';
        if (input.value !== nextTags) input.value = nextTags;
        continue;
      }
      if (field && field in form) {
        var nextValue = form[field] == null ? '' : String(form[field]);
        if (input.value !== nextValue) input.value = nextValue;
      }
    }

    var markdownEditor = this.shadowRoot.querySelector ? this.shadowRoot.querySelector('id-note-markdown-editor') : null;
    if (markdownEditor) {
      if ('value' in markdownEditor) {
        if (markdownEditor.value !== form.content) markdownEditor.value = form.content;
      } else if (typeof markdownEditor.setAttribute === 'function' && markdownEditor.getAttribute && markdownEditor.getAttribute('value') !== form.content) {
        markdownEditor.setAttribute('value', form.content);
      }
    }

    var coverPicker = this.shadowRoot.querySelector ? this.shadowRoot.querySelector('id-note-cover-picker') : null;
    if (coverPicker && typeof coverPicker.setAttribute === 'function') {
      var coverAlt = this._t('note.card.coverAlt', 'Note cover');
      var coverUpload = this._t('note.editor.coverUpload', 'Upload cover image');
      var coverRemove = this._t('note.editor.coverRemove', 'Remove cover');
      if (!coverPicker.getAttribute || coverPicker.getAttribute('value') !== form.coverImg) coverPicker.setAttribute('value', form.coverImg);
      if (!coverPicker.getAttribute || coverPicker.getAttribute('alt') !== coverAlt) coverPicker.setAttribute('alt', coverAlt);
      if (!coverPicker.getAttribute || coverPicker.getAttribute('upload-label') !== coverUpload) coverPicker.setAttribute('upload-label', coverUpload);
      if (!coverPicker.getAttribute || coverPicker.getAttribute('remove-label') !== coverRemove) coverPicker.setAttribute('remove-label', coverRemove);
    }

    var picker = this.shadowRoot.querySelector ? this.shadowRoot.querySelector('id-note-attachment-picker') : null;
    if (picker) picker.items = Array.isArray(editor.pendingAttachments) ? editor.pendingAttachments.slice() : [];

    var status = this.shadowRoot.querySelector ? this.shadowRoot.querySelector('[data-role="status"]') : null;
    if (status) {
      status.textContent = this._statusText(editor);
      status.className = 'status' + (editor.error ? ' error' : '');
    }

    var publishButton = this.shadowRoot.querySelector ? this.shadowRoot.querySelector('[data-role="publish"]') : null;
    if (publishButton) {
      publishButton.textContent = this._t(
        editor.mode === 'edit' ? 'note.editor.update' : 'note.editor.publish',
        editor.mode === 'edit' ? 'Update' : 'Publish'
      );
    }
  }

  render() {
    if (!this.shadowRoot) return;
    var editor = this._editorState();
    var form = cloneEditorForm(editor.form);
    var tagsText = Array.isArray(form.tags) ? form.tags.join(', ') : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .editor {
          display: grid;
          gap: 14px;
          padding: 18px;
          border-radius: 18px;
          background: rgba(7, 10, 18, 0.54);
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(255,255,255,0.88);
        }
        .grid { display: grid; gap: 12px; }
        .field-input {
          width: 100%;
          box-sizing: border-box;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.04);
          color: inherit;
        }
        .row { display: grid; gap: 12px; }
        .toggle {
          display: grid;
          grid-template-columns: auto 1fr;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          justify-content: start;
        }
        .toggle-input {
          width: auto;
          margin: 0;
          padding: 0;
          border: 0;
          background: transparent;
          accent-color: rgba(120, 160, 255, 0.92);
        }
        .toggle-copy {
          line-height: 1.4;
        }
        .actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .status { font-size: 12px; color: rgba(255,255,255,0.62); }
        .error { color: rgba(255, 205, 205, 0.92); }
        .primary {
          border: 0;
          border-radius: 999px;
          padding: 10px 16px;
          cursor: pointer;
          background: rgba(120, 160, 255, 0.22);
          color: rgba(235, 241, 255, 0.96);
        }
      </style>
      <section class="editor">
        <div class="grid">
          <input class="field-input" data-field="title" type="text" placeholder="${this._escapeAttr(this._t('note.editor.title', 'Title'))}" value="${this._escapeAttr(form.title)}" />
          <input class="field-input" data-field="subtitle" type="text" placeholder="${this._escapeAttr(this._t('note.editor.subtitle', 'Subtitle'))}" value="${this._escapeAttr(form.subtitle)}" />
          <id-note-cover-picker
            value="${this._escapeAttr(form.coverImg)}"
            alt="${this._escapeAttr(this._t('note.card.coverAlt', 'Note cover'))}"
            upload-label="${this._escapeAttr(this._t('note.editor.coverUpload', 'Upload cover image'))}"
            remove-label="${this._escapeAttr(this._t('note.editor.coverRemove', 'Remove cover'))}"
          ></id-note-cover-picker>
          <input class="field-input" data-field="tags" type="text" placeholder="${this._escapeAttr(this._t('note.editor.tags', 'Tags, comma separated'))}" value="${this._escapeAttr(tagsText)}" />
          <label class="toggle"><input class="toggle-input" data-field="private" type="checkbox" ${String(form.encryption || '0') !== '0' ? 'checked' : ''} /><span class="toggle-copy">${this._escapeHtml(this._t('note.editor.private', 'Encrypt note content'))}</span></label>
        </div>
        <id-note-markdown-editor value="${this._escapeAttr(form.content)}" placeholder="${this._escapeAttr(this._t('note.editor.content', 'Write your markdown note...'))}"></id-note-markdown-editor>
        <id-note-attachment-picker></id-note-attachment-picker>
        <id-chain-fee-selector></id-chain-fee-selector>
        <div class="actions">
          <p class="status ${editor.error ? 'error' : ''}" data-role="status">${this._escapeHtml(this._statusText(editor))}</p>
          <button type="button" class="primary" data-role="publish">${this._escapeHtml(this._t(editor.mode === 'edit' ? 'note.editor.update' : 'note.editor.publish', editor.mode === 'edit' ? 'Update' : 'Publish'))}</button>
        </div>
      </section>
    `;

    if (!this.shadowRoot.querySelectorAll) return;
    var inputs = this.shadowRoot.querySelectorAll('input[data-field]');
    for (var i = 0; i < inputs.length; i += 1) {
      var input = inputs[i];
      if (!input || typeof input.addEventListener !== 'function') continue;
      input.addEventListener('input', (event) => {
        var target = event && event.currentTarget ? event.currentTarget : input;
        var field = String(target && target.getAttribute ? target.getAttribute('data-field') || '' : '');
        if (field === 'tags') return this._updateTags(target.value);
        if (field === 'private') return this._togglePrivate(!!target.checked);
        return this._updateField(field, target.value);
      });
      input.addEventListener('change', (event) => {
        var target = event && event.currentTarget ? event.currentTarget : input;
        var field = String(target && target.getAttribute ? target.getAttribute('data-field') || '' : '');
        if (field === 'private') this._togglePrivate(!!target.checked);
      });
    }

    var markdownEditor = this.shadowRoot.querySelector('id-note-markdown-editor');
    if (markdownEditor && typeof markdownEditor.addEventListener === 'function') {
      markdownEditor.addEventListener('input', (event) => {
        this._updateField('content', event && event.detail ? event.detail.value || '' : '');
      });
    }

    var coverPicker = this.shadowRoot.querySelector('id-note-cover-picker');
    if (coverPicker && typeof coverPicker.addEventListener === 'function') {
      coverPicker.addEventListener('cover-change', (event) => {
        this._updateField('coverImg', event && event.detail ? event.detail.value || '' : '');
      });
    }

    var picker = this.shadowRoot.querySelector('id-note-attachment-picker');
    if (picker && typeof picker.addEventListener === 'function') {
      picker.addEventListener('attachment-add', (event) => {
        this._addPendingFiles(event && event.detail ? event.detail.files : []);
      });
      picker.addEventListener('attachment-remove', (event) => {
        var index = Number(event && event.detail ? event.detail.index : -1);
        this._removePendingAt(index);
      });
    }

    var publishButton = this.shadowRoot.querySelector('[data-role="publish"]');
    if (publishButton && typeof publishButton.addEventListener === 'function') {
      publishButton.addEventListener('click', () => {
        this._publish().catch((error) => {
          editor.error = error && error.message ? error.message : String(error);
          this._checkContext(true);
        });
      });
    }

    this._syncUi();
  }
}

customElements.define('id-note-editor', IdNoteEditor);
