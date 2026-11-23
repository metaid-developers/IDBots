/**
 * Knowledge Base panel ("知识库" tab) in Studio Linear Style B.
 *
 * Manages this Bot's document corpora through the `knowledgeBase:*` IPC surface
 * (immediate effect, no tab dirty-tracking / on-chain sync).
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
import {
  buildMetaBotToggleViewModel,
  METABOT_BTN_DANGER_CLASS,
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_CLEAN_INPUT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_NOTE_CLASS,
  METABOT_GROUP_ROW_CLASS,
  METABOT_GROUP_ROW_TOP_CLASS,
  METABOT_MICRO_BADGE_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';
import MetawebStudyJobsPanel from './MetawebStudyJobsPanel';

interface KnowledgeBasePanelProps {
  metabotId: number;
}

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

  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

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
    <div className="text-xs text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-[7px] px-3 py-2">
      {message}
    </div>
  );

  const renderCreateForm = () => (
    <div className={METABOT_GROUP_BOX_CLASS} data-slot="knowledge-base-create-form">
      <div className={METABOT_GROUP_ROW_CLASS}>
        <label htmlFor="kb-create-name" className={`${METABOT_ROW_TITLE_CLASS} min-w-[140px]`}>
          {i18nService.t('knowledgeBaseNameLabel')}
        </label>
        <div className="w-full sm:max-w-[440px]">
          <input
            id="kb-create-name"
            type="text"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={i18nService.t('knowledgeBaseNamePlaceholder')}
            className={METABOT_CLEAN_INPUT_CLASS}
          />
        </div>
      </div>

      <div className={METABOT_GROUP_ROW_TOP_CLASS}>
        <label htmlFor="kb-create-description" className={`${METABOT_ROW_TITLE_CLASS} min-w-[140px]`}>
          {i18nService.t('knowledgeBaseDescriptionLabel')}
        </label>
        <div className="w-full sm:max-w-[440px]">
          <textarea
            id="kb-create-description"
            value={createDescription}
            onChange={(e) => setCreateDescription(e.target.value)}
            placeholder={i18nService.t('knowledgeBaseDescriptionPlaceholder')}
            rows={2}
            className={`${METABOT_CLEAN_INPUT_CLASS} resize-y`}
          />
        </div>
      </div>

      <div className={METABOT_GROUP_ROW_TOP_CLASS}>
        <div className="min-w-[140px]">
          <label htmlFor="kb-create-raw-dir" className={METABOT_ROW_TITLE_CLASS}>
            {i18nService.t('knowledgeBaseRawDirLabel')}
          </label>
          <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('knowledgeBaseRawDirHint')}</p>
        </div>
        <div className="w-full sm:max-w-[440px] flex items-center gap-2">
          <input
            id="kb-create-raw-dir"
            type="text"
            readOnly
            value={createRawDir}
            placeholder={i18nService.t('knowledgeBaseRawDirPlaceholder')}
            className={`${METABOT_CLEAN_INPUT_CLASS} font-mono !text-[12px] flex-1 min-w-0`}
          />
          <button
            type="button"
            onClick={() => void handleBrowseCreateRawDir()}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {i18nService.t('knowledgeBaseBrowse')}
          </button>
          {createRawDir && (
            <button
              type="button"
              onClick={() => setCreateRawDir('')}
              className="text-xs font-semibold text-red-600 dark:text-rose-400 hover:underline px-1 shrink-0"
            >
              {i18nService.t('knowledgeBaseClear')}
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div>{createError ? renderError(createError) : null}</div>
        <div className="flex items-center gap-2 ml-auto">
          <button
            type="button"
            onClick={() => { setCreateOpen(false); resetCreateForm(); }}
            disabled={createSaving}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            data-slot="knowledge-base-create-submit"
            onClick={() => void handleCreate()}
            disabled={createSaving}
            className={`${METABOT_BTN_PRIMARY_CLASS} !h-8 !px-3 !rounded-[7px] !text-[12px]`}
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
      <div key={kb.id} className="px-4 py-3.5 space-y-2.5" data-slot={`knowledge-base-card-${kb.id}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <BookOpenIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className={METABOT_ROW_TITLE_CLASS}>
                <span className="truncate" title={kb.name}>{kb.name}</span>
                {kb.isDefault && (
                  <span className={METABOT_MICRO_BADGE_CLASS}>
                    {i18nService.t('knowledgeBaseDefaultBadge')}
                  </span>
                )}
              </div>
              {!editing && kb.description && (
                <p className={METABOT_ROW_HINT_CLASS}>{kb.description}</p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[#8c96a6] dark:text-[#64748b] tabular-nums">
                <span>{i18nService.t('knowledgeBaseStatsDocs').replace('{count}', String(kb.docCount))}</span>
                <span aria-hidden>·</span>
                <span>{i18nService.t('knowledgeBaseStatsChunks').replace('{count}', String(kb.chunkCount))}</span>
                <span aria-hidden>·</span>
                <span>{formatLastLearnedAt(kb.lastLearnedAt)}</span>
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-[#8c96a6] dark:text-[#64748b] truncate" title={kb.rawDir}>
                {kb.rawDir}
              </p>
            </div>
          </div>

          <div className="shrink-0 flex items-center gap-2 pt-0.5">
            <span className="text-[11.5px] font-medium text-[#5a6577] dark:text-[#94a3b8] whitespace-nowrap">
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

        {notice && (
          <div
            className={`sm:ml-[28px] text-xs rounded-[7px] px-3 py-1.5 ${
              notice.kind === 'success'
                ? 'text-[#0f9d68] dark:text-[#34d399] bg-emerald-500/10'
                : 'text-red-500 dark:text-red-400 bg-red-500/10'
            }`}
          >
            {notice.text}
          </div>
        )}

        {editing ? (
          <div className="sm:pl-[28px] space-y-2.5" data-slot="knowledge-base-edit-form">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder={i18nService.t('knowledgeBaseNamePlaceholder')}
              className={METABOT_CLEAN_INPUT_CLASS}
            />
            <textarea
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder={i18nService.t('knowledgeBaseDescriptionPlaceholder')}
              rows={2}
              className={`${METABOT_CLEAN_INPUT_CLASS} resize-y`}
            />
            {editError ? renderError(editError) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingKbId(null)}
                disabled={editSaving}
                className={METABOT_BTN_FLAT_CLASS}
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                data-slot={`knowledge-base-edit-save-${kb.id}`}
                onClick={() => void handleSaveEdit(kb)}
                disabled={editSaving}
                className={`${METABOT_BTN_PRIMARY_CLASS} !h-8 !px-3 !rounded-[7px] !text-[12px]`}
              >
                {editSaving ? i18nService.t('saving') : i18nService.t('save')}
              </button>
            </div>
          </div>
        ) : (
          <div className="sm:pl-[28px] flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-slot={`knowledge-base-learn-${kb.id}`}
                onClick={() => void handleLearn(kb, false)}
                disabled={learning}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <ArrowPathIcon className={`h-3.5 w-3.5 ${learning ? 'animate-spin' : ''}`} aria-hidden />
                <span>{learning ? i18nService.t('knowledgeBaseLearning') : i18nService.t('knowledgeBaseLearnNow')}</span>
              </button>
              <button
                type="button"
                data-slot={`knowledge-base-import-${kb.id}`}
                onClick={() => void handleImportFiles(kb)}
                disabled={importing || learning}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <DocumentArrowUpIcon className="h-3.5 w-3.5" aria-hidden />
                <span>{i18nService.t('knowledgeBaseImportFiles')}</span>
              </button>
              <button
                type="button"
                data-slot={`knowledge-base-open-dir-${kb.id}`}
                onClick={() => void handleOpenDir(kb)}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <FolderOpenIcon className="h-3.5 w-3.5" aria-hidden />
                <span>{i18nService.t('knowledgeBaseOpenDir')}</span>
              </button>
              <button
                type="button"
                data-slot={`knowledge-base-edit-${kb.id}`}
                onClick={() => handleStartEdit(kb)}
                disabled={learning}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <PencilSquareIcon className="h-3.5 w-3.5" aria-hidden />
                <span>{i18nService.t('edit')}</span>
              </button>
              {!kb.isDefault && (
                <button
                  type="button"
                  data-slot={`knowledge-base-delete-${kb.id}`}
                  onClick={() => void handleRemove(kb)}
                  disabled={learning}
                  className={METABOT_BTN_DANGER_CLASS}
                >
                  <TrashIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('delete')}</span>
                </button>
              )}
            </div>

            <details className="group" data-slot={`knowledge-base-advanced-${kb.id}`}>
              <summary className="cursor-pointer list-none select-none text-[11.5px] font-medium text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] transition-colors">
                {i18nService.t('knowledgeBaseAdvancedToggle')} ▾
              </summary>
              <div className="mt-2 rounded-[7px] border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                  {i18nService.t('knowledgeBaseFullRelearnHint')}
                </span>
                <button
                  type="button"
                  data-slot={`knowledge-base-full-relearn-${kb.id}`}
                  onClick={() => void handleLearn(kb, true)}
                  disabled={learning}
                  className={METABOT_BTN_DANGER_CLASS}
                >
                  <ArrowPathIcon className={`h-3.5 w-3.5 ${learning ? 'animate-spin' : ''}`} aria-hidden />
                  <span>{i18nService.t('knowledgeBaseFullRelearn')}</span>
                </button>
              </div>
            </details>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
          <div className="min-w-0">
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('knowledgeBasePanelTitle')}</span>
            <span className={`ml-2 ${METABOT_GROUP_NOTE_CLASS}`}>{i18nService.t('knowledgeBasePanelHint')}</span>
          </div>
          <button
            type="button"
            data-slot="knowledge-base-create-toggle"
            onClick={() => { setCreateOpen((prev) => !prev); setCreateError(''); }}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {createOpen ? <XMarkIcon className="h-3.5 w-3.5" aria-hidden /> : <PlusIcon className="h-3.5 w-3.5" aria-hidden />}
            <span>{i18nService.t('knowledgeBaseCreateButton')}</span>
          </button>
        </div>

        {panelError ? renderError(panelError) : null}
        {createOpen ? renderCreateForm() : null}

        <div className={METABOT_GROUP_BOX_CLASS}>
          {loaded && !panelError && knowledgeBases.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12.5px] text-[#8c96a6] dark:text-[#64748b]">
              {i18nService.t('knowledgeBaseEmpty')}
            </div>
          ) : (
            knowledgeBases.map(renderCard)
          )}
        </div>

        <p className="px-0.5 text-[11px] text-[#8c96a6] dark:text-[#64748b]">
          {i18nService
            .t('knowledgeBaseSupportedFormats')
            .replace('{formats}', KB_IMPORT_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(' '))}
        </p>
      </div>

      <MetawebStudyJobsPanel metabotId={metabotId} />
    </div>
  );
};

export default KnowledgeBasePanel;
