/**
 * Knowledge Base panel ("知识库" tab) for the MetaBot edit view.
 *
 * Manages this Bot's document corpora entirely through the `knowledgeBase:*`
 * IPC surface (immediate effect, no tab dirty-tracking / on-chain sync): list,
 * create, inline rename, auto-learn toggle, manual/incremental learn,
 * from-scratch relearn, file import, open-directory, and delete. Learn
 * progress arrives over the `knowledgeBase:learnStatus` event channel (also
 * fired by the nightly auto-learn schedule), so card spinners track the
 * service rather than just the click.
 *
 * Class constants replicate the edit-tab chrome (rowClass/labelClass/… in
 * MetaBotEditTabs) so the panel reads like the other tabs.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  BookOpenIcon,
  DocumentArrowUpIcon,
  FolderOpenIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { formatKnowledgeBaseLearnSummary } from '../../services/knowledgeBasePresentation.js';
import type { KnowledgeBaseInfo, KnowledgeBaseLearnSummary } from '../../types/knowledgeBase';
import { buildMetaBotToggleViewModel } from './metaBotCardPresentation.js';
import MetawebStudyJobsPanel from './MetawebStudyJobsPanel';

interface KnowledgeBasePanelProps {
  metabotId: number;
}

// Replicated from MetaBotEditTabs (kept in sync with the other edit tabs).
const rowClass = 'grid grid-cols-1 md:grid-cols-[152px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const inputChromeClass = 'px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
const inputClass = `w-full ${inputChromeClass}`;

const cardClass = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 space-y-3';
const actionBtnClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const dangerBtnClass = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-red-500/50 dark:border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** Keep in sync with SUPPORTED_KB_EXTENSIONS in src/main/libs/knowledgeBaseText.ts. */
const KB_IMPORT_FILE_EXTENSIONS = [
  'md',
  'markdown',
  'txt',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'xml',
  'log',
  'rst',
  'pdf',
  'docx',
  'pptx',
  'xlsx',
  'xls',
  'html',
  'htm',
  'epub',
];
const NOTICE_AUTO_CLEAR_MS = 10_000;

interface KnowledgeBaseNotice {
  kind: 'success' | 'error';
  text: string;
}

const formatLearnSummary = (summary: KnowledgeBaseLearnSummary): KnowledgeBaseNotice =>
  formatKnowledgeBaseLearnSummary(summary, (key: string) => i18nService.t(key));

const KnowledgeBasePanel: React.FC<KnowledgeBasePanelProps> = ({ metabotId }) => {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createRawDir, setCreateRawDir] = useState('');
  const [createSaving, setCreateSaving] = useState(false);
  const [createError, setCreateError] = useState('');
  const [learningKbIds, setLearningKbIds] = useState<ReadonlySet<string>>(new Set());
  const [notices, setNotices] = useState<Record<string, KnowledgeBaseNotice>>({});
  const [autoLearnSavingKbIds, setAutoLearnSavingKbIds] = useState<ReadonlySet<string>>(new Set());
  const [importingKbIds, setImportingKbIds] = useState<ReadonlySet<string>>(new Set());
  const [editingKbId, setEditingKbId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const noticeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const loadKnowledgeBases = useCallback(async () => {
    try {
      const result = await window.electron.knowledgeBase.list(metabotId);
      if (result.success && result.knowledgeBases) {
        setKnowledgeBases(result.knowledgeBases);
        setPanelError('');
      } else {
        setPanelError(result.error || i18nService.t('knowledgeBaseLoadFailed'));
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : i18nService.t('knowledgeBaseLoadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [metabotId]);

  // (Re)load when a different bot is loaded into the same mounted editor.
  useEffect(() => {
    setKnowledgeBases([]);
    setLoaded(false);
    setPanelError('');
    setCreateOpen(false);
    setCreateError('');
    setEditingKbId(null);
    setNotices({});
    setLearningKbIds(new Set());
    void loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  const showNotice = useCallback((kbId: string, notice: KnowledgeBaseNotice) => {
    setNotices((prev) => ({ ...prev, [kbId]: notice }));
    const timers = noticeTimersRef.current;
    const existing = timers.get(kbId);
    if (existing) clearTimeout(existing);
    timers.set(kbId, setTimeout(() => {
      timers.delete(kbId);
      setNotices((prev) => {
        const next = { ...prev };
        delete next[kbId];
        return next;
      });
    }, NOTICE_AUTO_CLEAR_MS));
  }, []);

  // Clear pending notice timers on unmount.
  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  // Track learn runs service-side (manual clicks AND nightly auto-learn) so
  // card spinners/notices stay correct even when this panel did not start them.
  useEffect(() => {
    const unsubscribe = window.electron.knowledgeBase.onLearnStatus((payload) => {
      if (payload.metabotId !== metabotId) return;
      if (payload.state === 'running') {
        setLearningKbIds((prev) => new Set(prev).add(payload.kbId));
        return;
      }
      setLearningKbIds((prev) => {
        const next = new Set(prev);
        next.delete(payload.kbId);
        return next;
      });
      if (payload.state === 'done' && payload.summary) {
        showNotice(payload.kbId, formatLearnSummary(payload.summary));
        void loadKnowledgeBases();
      } else if (payload.state === 'error') {
        showNotice(payload.kbId, { kind: 'error', text: payload.error || i18nService.t('knowledgeBaseLearnFailed') });
      }
    });
    return unsubscribe;
  }, [metabotId, loadKnowledgeBases, showNotice]);

  const resetCreateForm = () => {
    setCreateName('');
    setCreateDescription('');
    setCreateRawDir('');
    setCreateError('');
  };

  const handleBrowseCreateRawDir = async () => {
    const result = await window.electron.dialog.selectDirectory();
    if (result.success && result.path) {
      setCreateRawDir(result.path);
    }
  };

  const handleCreate = async () => {
    const name = createName.trim();
    const description = createDescription.trim();
    if (!name) {
      setCreateError(i18nService.t('knowledgeBaseNameRequired'));
      return;
    }
    if (!description) {
      setCreateError(i18nService.t('knowledgeBaseDescriptionRequired'));
      return;
    }
    setCreateSaving(true);
    setCreateError('');
    try {
      const result = await window.electron.knowledgeBase.create(metabotId, {
        name,
        description,
        rawDir: createRawDir.trim() || undefined,
      });
      if (result.success) {
        setCreateOpen(false);
        resetCreateForm();
        await loadKnowledgeBases();
      } else {
        setCreateError(result.error || i18nService.t('knowledgeBaseCreateFailed'));
      }
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : i18nService.t('knowledgeBaseCreateFailed'));
    } finally {
      setCreateSaving(false);
    }
  };

  const handleToggleAutoLearn = async (kb: KnowledgeBaseInfo) => {
    if (autoLearnSavingKbIds.has(kb.id)) return;
    setAutoLearnSavingKbIds((prev) => new Set(prev).add(kb.id));
    try {
      const result = await window.electron.knowledgeBase.update(metabotId, kb.id, { autoLearn: !kb.autoLearn });
      if (result.success && result.knowledgeBase) {
        setKnowledgeBases((prev) => prev.map((entry) => (entry.id === kb.id ? result.knowledgeBase! : entry)));
      } else {
        showNotice(kb.id, { kind: 'error', text: result.error || i18nService.t('knowledgeBaseUpdateFailed') });
      }
    } catch (error) {
      showNotice(kb.id, { kind: 'error', text: error instanceof Error ? error.message : i18nService.t('knowledgeBaseUpdateFailed') });
    } finally {
      setAutoLearnSavingKbIds((prev) => {
        const next = new Set(prev);
        next.delete(kb.id);
        return next;
      });
    }
  };

  const handleLearn = async (kb: KnowledgeBaseInfo, full: boolean) => {
    if (learningKbIds.has(kb.id)) return;
    if (full && !window.confirm(i18nService.t('knowledgeBaseFullRelearnConfirm').replace('{name}', kb.name))) {
      return;
    }
    setLearningKbIds((prev) => new Set(prev).add(kb.id));
    try {
      const result = await window.electron.knowledgeBase.learn(metabotId, kb.id, { full });
      // The 'done'/'error' learn-status event normally lands first and already
      // posted the notice; the awaited result is the fallback path.
      if (!result.success) {
        showNotice(kb.id, { kind: 'error', text: result.error || i18nService.t('knowledgeBaseLearnFailed') });
      }
      await loadKnowledgeBases();
    } catch (error) {
      showNotice(kb.id, { kind: 'error', text: error instanceof Error ? error.message : i18nService.t('knowledgeBaseLearnFailed') });
    } finally {
      setLearningKbIds((prev) => {
        const next = new Set(prev);
        next.delete(kb.id);
        return next;
      });
    }
  };

  const handleOpenDir = async (kb: KnowledgeBaseInfo) => {
    try {
      const result = await window.electron.knowledgeBase.openDir(metabotId, kb.id);
      if (!result.success) {
        showNotice(kb.id, { kind: 'error', text: result.error || i18nService.t('knowledgeBaseOpenDirFailed') });
      }
    } catch (error) {
      showNotice(kb.id, { kind: 'error', text: error instanceof Error ? error.message : i18nService.t('knowledgeBaseOpenDirFailed') });
    }
  };

  const handleImportFiles = async (kb: KnowledgeBaseInfo) => {
    if (importingKbIds.has(kb.id)) return;
    const picked = await window.electron.dialog.selectFile({
      title: i18nService.t('knowledgeBaseImportFiles'),
      filters: [{ name: 'Documents', extensions: [...KB_IMPORT_FILE_EXTENSIONS] }],
      multi: true,
    });
    if (!picked.success) return;
    const paths = picked.paths?.length ? picked.paths : (picked.path ? [picked.path] : []);
    if (!paths.length) return;
    setImportingKbIds((prev) => new Set(prev).add(kb.id));
    try {
      const result = await window.electron.knowledgeBase.importFiles(metabotId, kb.id, paths);
      if (result.success) {
        showNotice(kb.id, {
          kind: 'success',
          text: i18nService.t('knowledgeBaseImportResult')
            .replace('{imported}', String(result.imported?.length ?? 0))
            .replace('{skipped}', String(result.skipped?.length ?? 0)),
        });
      } else {
        showNotice(kb.id, { kind: 'error', text: result.error || i18nService.t('knowledgeBaseImportFailed') });
      }
    } catch (error) {
      showNotice(kb.id, { kind: 'error', text: error instanceof Error ? error.message : i18nService.t('knowledgeBaseImportFailed') });
    } finally {
      setImportingKbIds((prev) => {
        const next = new Set(prev);
        next.delete(kb.id);
        return next;
      });
    }
  };

  const handleStartEdit = (kb: KnowledgeBaseInfo) => {
    setEditingKbId(kb.id);
    setEditName(kb.name);
    setEditDescription(kb.description);
    setEditError('');
  };

  const handleSaveEdit = async (kb: KnowledgeBaseInfo) => {
    const name = editName.trim();
    const description = editDescription.trim();
    if (!name) {
      setEditError(i18nService.t('knowledgeBaseNameRequired'));
      return;
    }
    if (!description) {
      setEditError(i18nService.t('knowledgeBaseDescriptionRequired'));
      return;
    }
    setEditSaving(true);
    setEditError('');
    try {
      const result = await window.electron.knowledgeBase.update(metabotId, kb.id, { name, description });
      if (result.success) {
        setEditingKbId(null);
        await loadKnowledgeBases();
      } else {
        setEditError(result.error || i18nService.t('knowledgeBaseUpdateFailed'));
      }
    } catch (error) {
      setEditError(error instanceof Error ? error.message : i18nService.t('knowledgeBaseUpdateFailed'));
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemove = async (kb: KnowledgeBaseInfo) => {
    if (kb.isDefault) return;
    if (!window.confirm(i18nService.t('knowledgeBaseDeleteConfirm').replace('{name}', kb.name))) {
      return;
    }
    try {
      const result = await window.electron.knowledgeBase.remove(metabotId, kb.id);
      if (result.success) {
        await loadKnowledgeBases();
      } else {
        showNotice(kb.id, { kind: 'error', text: result.error || i18nService.t('knowledgeBaseDeleteFailed') });
      }
    } catch (error) {
      showNotice(kb.id, { kind: 'error', text: error instanceof Error ? error.message : i18nService.t('knowledgeBaseDeleteFailed') });
    }
  };

  const formatLastLearnedAt = (value: string | null): string => {
    if (!value) return i18nService.t('knowledgeBaseNeverLearned');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return i18nService.t('knowledgeBaseNeverLearned');
    return i18nService.t('knowledgeBaseLastLearned').replace('{time}', date.toLocaleString());
  };

  const renderError = (message: string) => (
    <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2">
      {message}
    </div>
  );

  const renderCreateForm = () => (
    <div className={cardClass} data-slot="knowledge-base-create-form">
      <div className={rowClass}>
        <label htmlFor="kb-create-name" className={labelClass}>
          {i18nService.t('knowledgeBaseNameLabel')}
        </label>
        <div className="min-w-0">
          <input
            id="kb-create-name"
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={i18nService.t('knowledgeBaseNamePlaceholder')}
            className={inputClass}
          />
        </div>
      </div>
      <div className={rowClass}>
        <label htmlFor="kb-create-description" className={labelClass}>
          {i18nService.t('knowledgeBaseDescriptionLabel')}
        </label>
        <div className="min-w-0">
          <textarea
            id="kb-create-description"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
            placeholder={i18nService.t('knowledgeBaseDescriptionPlaceholder')}
            rows={2}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>
      <div className={rowClass}>
        <label htmlFor="kb-create-raw-dir" className={labelClass}>
          {i18nService.t('knowledgeBaseRawDirLabel')}
        </label>
        <div className="min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input
              id="kb-create-raw-dir"
              type="text"
              readOnly
              value={createRawDir}
              placeholder={i18nService.t('knowledgeBaseRawDirPlaceholder')}
              className={`${inputClass} font-mono text-xs`}
            />
            <button
              type="button"
              onClick={() => void handleBrowseCreateRawDir()}
              className="shrink-0 px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors whitespace-nowrap"
            >
              {i18nService.t('knowledgeBaseBrowse')}
            </button>
            {createRawDir && (
              <button
                type="button"
                onClick={() => setCreateRawDir('')}
                className="shrink-0 px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border text-red-500 dark:text-red-400 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors whitespace-nowrap"
              >
                {i18nService.t('knowledgeBaseClear')}
              </button>
            )}
          </div>
          <p className={hintClass}>{i18nService.t('knowledgeBaseRawDirHint')}</p>
        </div>
      </div>
      {createError ? renderError(createError) : null}
      <div className={rowClass}>
        <div className="hidden md:block" />
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={() => { setCreateOpen(false); resetCreateForm(); }}
            disabled={createSaving}
            className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            data-slot="knowledge-base-create-submit"
            onClick={() => void handleCreate()}
            disabled={createSaving}
            className="border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9] transition-[filter] rounded-[var(--rounded)] px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {createSaving ? i18nService.t('saving') : i18nService.t('create')}
          </button>
        </div>
      </div>
    </div>
  );

  const renderCard = (kb: KnowledgeBaseInfo) => {
    const learning = learningKbIds.has(kb.id);
    const importing = importingKbIds.has(kb.id);
    const notice = notices[kb.id];
    const editing = editingKbId === kb.id;
    const autoLearnToggleView = buildMetaBotToggleViewModel({
      enabled: kb.autoLearn,
      disabled: autoLearnSavingKbIds.has(kb.id),
    });
    return (
      <div key={kb.id} className={cardClass} data-slot={`knowledge-base-card-${kb.id}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate" title={kb.name}>
                {kb.name}
              </span>
              {kb.isDefault && (
                <span className="shrink-0 rounded-full border dark:border-claude-darkBorder border-claude-border px-2 py-0.5 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('knowledgeBaseDefaultBadge')}
                </span>
              )}
            </div>
            {!editing && kb.description && (
              <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">
                {kb.description}
              </p>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-2 pt-0.5">
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-nowrap">
              {i18nService.t('knowledgeBaseAutoLearn')}
            </span>
            <div
              role="switch"
              aria-checked={kb.autoLearn}
              data-slot={`knowledge-base-auto-learn-${kb.id}`}
              title={i18nService.t('knowledgeBaseAutoLearnHint')}
              className={autoLearnToggleView.trackClass}
              onClick={() => void handleToggleAutoLearn(kb)}
            >
              <div className={autoLearnToggleView.knobClass} />
            </div>
          </div>
        </div>

        <p className="font-mono text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate" title={kb.rawDir}>
          {kb.rawDir}
        </p>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('knowledgeBaseStatsDocs').replace('{count}', String(kb.docCount))}
          {' · '}
          {i18nService.t('knowledgeBaseStatsChunks').replace('{count}', String(kb.chunkCount))}
          {' · '}
          {formatLastLearnedAt(kb.lastLearnedAt)}
        </p>

        {notice && (
          <div
            className={`text-xs rounded-lg px-3 py-2 ${
              notice.kind === 'success'
                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 dark:bg-emerald-500/10'
                : 'text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10'
            }`}
          >
            {notice.text}
          </div>
        )}

        {editing ? (
          <div className="space-y-3" data-slot="knowledge-base-edit-form">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={i18nService.t('knowledgeBaseNamePlaceholder')}
              className={inputClass}
            />
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder={i18nService.t('knowledgeBaseDescriptionPlaceholder')}
              rows={2}
              className={`${inputClass} resize-y`}
            />
            {editError ? renderError(editError) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingKbId(null)}
                disabled={editSaving}
                className="px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                data-slot={`knowledge-base-edit-save-${kb.id}`}
                onClick={() => void handleSaveEdit(kb)}
                disabled={editSaving}
                className="border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9] transition-[filter] rounded-lg px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-slot={`knowledge-base-learn-${kb.id}`}
              onClick={() => void handleLearn(kb, false)}
              disabled={learning}
              className={actionBtnClass}
            >
              <ArrowPathIcon className={`h-4 w-4 ${learning ? 'animate-spin' : ''}`} aria-hidden />
              {learning ? i18nService.t('knowledgeBaseLearning') : i18nService.t('knowledgeBaseLearnNow')}
            </button>
            <button
              type="button"
              data-slot={`knowledge-base-open-dir-${kb.id}`}
              onClick={() => void handleOpenDir(kb)}
              className={actionBtnClass}
            >
              <FolderOpenIcon className="h-4 w-4" aria-hidden />
              {i18nService.t('knowledgeBaseOpenDir')}
            </button>
            <button
              type="button"
              data-slot={`knowledge-base-import-${kb.id}`}
              onClick={() => void handleImportFiles(kb)}
              disabled={importing || learning}
              className={actionBtnClass}
            >
              <DocumentArrowUpIcon className="h-4 w-4" aria-hidden />
              {i18nService.t('knowledgeBaseImportFiles')}
            </button>
            <button
              type="button"
              data-slot={`knowledge-base-edit-${kb.id}`}
              onClick={() => handleStartEdit(kb)}
              disabled={learning}
              className={actionBtnClass}
            >
              <PencilSquareIcon className="h-4 w-4" aria-hidden />
              {i18nService.t('edit')}
            </button>
            {!kb.isDefault && (
              <button
                type="button"
                data-slot={`knowledge-base-delete-${kb.id}`}
                onClick={() => void handleRemove(kb)}
                disabled={learning}
                className={dangerBtnClass}
              >
                <TrashIcon className="h-4 w-4" aria-hidden />
                {i18nService.t('delete')}
              </button>
            )}
          </div>
        )}

        {/* Advanced: destructive from-scratch rebuild, de-emphasized. */}
        <details className="group" data-slot={`knowledge-base-advanced-${kb.id}`}>
          <summary className="cursor-pointer select-none text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText transition-colors">
            {i18nService.t('knowledgeBaseAdvancedToggle')}
          </summary>
          <div className="mt-2 rounded-lg border border-red-500/30 dark:border-red-500/30 bg-red-500/5 dark:bg-red-500/5 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1 min-w-[200px]">
              {i18nService.t('knowledgeBaseFullRelearnHint')}
            </p>
            <button
              type="button"
              data-slot={`knowledge-base-full-relearn-${kb.id}`}
              onClick={() => void handleLearn(kb, true)}
              disabled={learning}
              className={dangerBtnClass}
            >
              <ArrowPathIcon className={`h-4 w-4 ${learning ? 'animate-spin' : ''}`} aria-hidden />
              {i18nService.t('knowledgeBaseFullRelearn')}
            </button>
          </div>
        </details>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <BookOpenIcon className="h-3.5 w-3.5" aria-hidden />
          <span>{i18nService.t('knowledgeBasePanelTitle')}</span>
        </div>
        <button
          type="button"
          data-slot="knowledge-base-create-toggle"
          onClick={() => { setCreateOpen((prev) => !prev); setCreateError(''); }}
          className={actionBtnClass}
        >
          {createOpen ? <XMarkIcon className="h-4 w-4" aria-hidden /> : <PlusIcon className="h-4 w-4" aria-hidden />}
          {i18nService.t('knowledgeBaseCreateButton')}
        </button>
      </div>
      <p className={hintClass}>{i18nService.t('knowledgeBasePanelHint')}</p>
      <p className={hintClass}>
        {i18nService
          .t('knowledgeBaseSupportedFormats')
          .replace('{formats}', KB_IMPORT_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(' '))}
      </p>

      {panelError ? renderError(panelError) : null}
      {createOpen ? renderCreateForm() : null}

      {loaded && !panelError && knowledgeBases.length === 0 ? (
        <p className={hintClass}>{i18nService.t('knowledgeBaseEmpty')}</p>
      ) : (
        knowledgeBases.map(renderCard)
      )}

      {/* M4 autonomous study jobs ("自主学习"): read-only status view. */}
      <MetawebStudyJobsPanel metabotId={metabotId} />
    </div>
  );
};

export default KnowledgeBasePanel;
