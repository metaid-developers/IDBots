import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MagnifyingGlassIcon, PlusCircleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { ALL_PROVIDER_KEYS } from '../../config';
import type { Metabot } from '../../types/metabot';
import MetaBotForm, { type MetaBotFormValues, type LlmOption } from './MetaBotForm';
import MetaBotCreateSuccessModal from './MetaBotCreateSuccessModal';
import MetaBotDeleteConfirmModal from './MetaBotDeleteConfirmModal';
import MetaBotListCard from './MetaBotListCard';

type ViewMode = 'list' | 'add' | 'edit';

const providerRequiresApiKey = (provider: string) => provider !== 'ollama';
const providerLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

const MetabotsManager: React.FC<{ onRequestModelSettings?: () => void }> = ({ onRequestModelSettings }) => {
  const [list, setList] = useState<Metabot[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [editId, setEditId] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [createSuccessModal, setCreateSuccessModal] = useState<{
    metabot: Metabot;
    subsidySuccess: boolean;
    subsidyError?: string;
  } | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncError, setSyncError] = useState<string>('');
  const [deleteTarget, setDeleteTarget] = useState<Metabot | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    const result = await window.electron.metabot.list();
    setLoading(false);
    if (result.success && result.list) {
      setList(result.list);
    } else {
      setActionError(result.error || i18nService.t('metabotLoadFailed'));
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const filteredList = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        m.metabot_type.toLowerCase().includes(q)
    );
  }, [list, searchQuery]);

  const handleToggleEnabled = async (id: number, enabled: boolean) => {
    setActionError('');
    const result = await window.electron.metabot.setEnabled(id, enabled);
    if (result.success && result.metabot) {
      setList((prev) => prev.map((m) => (m.id === id ? { ...m, enabled: result.metabot!.enabled } : m)));
    } else {
      setActionError(result.error || i18nService.t('metabotUpdateFailed'));
    }
  };

  const handleAdd = () => {
    setActionError('');
    setEditId(null);
    setViewMode('add');
  };

  const handleEdit = (id: number) => {
    setActionError('');
    setEditId(id);
    setViewMode('edit');
  };

  const handleCancelForm = () => {
    setViewMode('list');
    setEditId(null);
    setActionError('');
  };

  const handleSaveNew = async (values: MetaBotFormValues) => {
    const result = await window.electron.idbots.addMetaBot({
      name: values.name.trim(),
      avatar: values.avatar.trim() || null,
      role: values.role.trim(),
      soul: values.soul.trim(),
      goal: values.goal.trim() || null,
      background: values.background.trim() || null,
      boss_id: values.boss_id.trim() ? parseInt(values.boss_id, 10) : 1,
      llm_id: values.llm_id.trim() || null,
    });
    if (!result.success) {
      throw new Error(result.error || i18nService.t('metabotSaveFailed'));
    }
    if (!result.metabot) {
      throw new Error(i18nService.t('metabotSaveFailed'));
    }
    setList((prev) => [result.metabot!, ...prev]);
    setCreateSuccessModal({
      metabot: result.metabot,
      subsidySuccess: result.subsidy?.success ?? false,
      subsidyError: result.subsidy?.error,
    });
    setViewMode('list');
  };

  const handleCheckNameExists = useCallback(async (name: string, excludeId?: number): Promise<boolean> => {
    const result = await window.electron.metabot.checkNameExists({ name: name.trim(), excludeId });
    return result.success && result.exists === true;
  }, []);

  const handleSaveEdit = async (values: MetaBotFormValues) => {
    if (editId == null) return;
    const result = await window.electron.metabot.update(editId, {
      name: values.name.trim(),
      avatar: values.avatar.trim() || null,
      metabot_type: values.metabot_type,
      role: values.role.trim(),
      soul: values.soul.trim(),
      goal: values.goal.trim() || null,
      background: values.background.trim() || null,
      boss_id: values.boss_id.trim() ? parseInt(values.boss_id, 10) : null,
      llm_id: values.llm_id.trim() || null,
    });
    if (!result.success) {
      throw new Error(result.error || i18nService.t('metabotSaveFailed'));
    }
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotSaveSuccess') }));
    if (result.metabot) {
      setList((prev) => prev.map((m) => (m.id === editId ? result.metabot! : m)));
    }
    setViewMode('list');
    setEditId(null);
  };

  const editMetabot = editId != null ? list.find((m) => m.id === editId) : null;

  const [settingsClosedTrigger, setSettingsClosedTrigger] = useState(0);
  useEffect(() => {
    const handler = () => setSettingsClosedTrigger((n) => n + 1);
    window.addEventListener('app:settingsClosed', handler);
    return () => window.removeEventListener('app:settingsClosed', handler);
  }, []);

  const llmOptions = useMemo((): LlmOption[] => {
    const config = configService.getConfig();
    const providers = (config.providers ?? {}) as Record<string, { enabled?: boolean; apiKey?: string }>;
    const configured: LlmOption[] = [];
    for (const key of ALL_PROVIDER_KEYS) {
      const p = providers[key];
      if (!p?.enabled) continue;
      if (providerRequiresApiKey(key) && !(p.apiKey ?? '').trim()) continue;
      configured.push({ id: key, label: providerLabel(key) });
    }
    return configured;
  }, [settingsClosedTrigger]);

  if (viewMode === 'add') {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('metabotAddTitle')}
        </h2>
        <MetaBotForm
          isEdit={false}
          onCancel={handleCancelForm}
          onSave={handleSaveNew}
          saveLabel={i18nService.t('save')}
          llmOptions={llmOptions}
          onRequestModelSettings={onRequestModelSettings}
          onCheckNameExists={handleCheckNameExists}
          excludeIdForNameCheck={null}
        />
      </div>
    );
  }

  if (viewMode === 'edit' && editMetabot) {
    return (
      <div className="space-y-4">
        <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('metabotEditTitle')}
        </h2>
        <MetaBotForm
          initialValues={{
            name: editMetabot.name,
            avatar: editMetabot.avatar || '',
            metabot_type: editMetabot.metabot_type,
            role: editMetabot.role,
            soul: editMetabot.soul,
            goal: editMetabot.goal || '',
            background: editMetabot.background || '',
            boss_id: editMetabot.boss_id != null ? String(editMetabot.boss_id) : '1',
            llm_id: editMetabot.llm_id || '',
          }}
          isEdit={true}
          onCancel={handleCancelForm}
          onSave={handleSaveEdit}
          llmOptions={llmOptions}
          onRequestModelSettings={onRequestModelSettings}
          onCheckNameExists={handleCheckNameExists}
          excludeIdForNameCheck={editId}
        />
      </div>
    );
  }

  const handleCloseSuccessModal = () => {
    setCreateSuccessModal(null);
    setSyncStatus('idle');
    setSyncError('');
  };
  const handleDeleteRequest = (metabot: Metabot) => setDeleteTarget(metabot);
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    const result = await window.electron.idbots.deleteMetaBot(deleteTarget.id);
    if (result.success) {
      setList((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      setDeleteTarget(null);
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotDeleteSuccess') }));
    } else {
      setActionError(result.error || i18nService.t('metabotUpdateFailed'));
    }
  };
  const handleSyncToChain = async () => {
    if (!createSuccessModal) return;
    setSyncStatus('syncing');
    setSyncError('');
    try {
      const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const SYNC_RETRY_DELAY_MS = 2500;
      let result = await window.electron.idbots.syncMetaBot(createSuccessModal.metabot.id);
      if (!result.success) {
        await delay(SYNC_RETRY_DELAY_MS);
        result = await window.electron.idbots.syncMetaBot(createSuccessModal.metabot.id);
      }
      if (result.success) {
        setSyncStatus('success');
        await loadList();
      } else {
        setSyncStatus('error');
        if (result.canSkip && (result.txids?.length ?? 0) > 0) {
          setSyncError(`${result.error ?? 'Unknown error'} (txids: ${result.txids?.length ?? 0})`);
        } else {
          setSyncError(result.error ?? 'Unknown error');
        }
      }
    } catch (err) {
      setSyncStatus('error');
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('metabotsDescription')}
      </p>

      {actionError && (
        <div
          className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2"
          role="alert"
        >
          {actionError}
          <button
            type="button"
            onClick={() => setActionError('')}
            className="ml-2 underline"
          >
            {i18nService.t('close')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            placeholder={i18nService.t('metabotSearchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="px-3 py-2 text-sm rounded-xl border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center gap-2"
        >
          <PlusCircleIcon className="h-4 w-4" />
          <span>{i18nService.t('metabotAdd')}</span>
        </button>
      </div>

      {loading ? (
        <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary py-8 text-center">
          {i18nService.t('loading')}
        </div>
      ) : filteredList.length === 0 ? (
        <div className="col-span-2 text-center py-8 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metabotNoItems')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {filteredList.map((m) => (
              <MetaBotListCard
                key={m.id}
                metabot={m}
                onEdit={() => handleEdit(m.id)}
                onToggleEnabled={(enabled) => handleToggleEnabled(m.id, enabled)}
                onDelete={() => handleDeleteRequest(m)}
              />
            ))}
          </div>
          {createSuccessModal && (
            <MetaBotCreateSuccessModal
              metabot={createSuccessModal.metabot}
              subsidySuccess={createSuccessModal.subsidySuccess}
              subsidyError={createSuccessModal.subsidyError}
              syncStatus={syncStatus}
              syncError={syncError}
              onClose={handleCloseSuccessModal}
              onSyncToChain={handleSyncToChain}
            />
          )}
          {deleteTarget && (
            <MetaBotDeleteConfirmModal
              metabot={deleteTarget}
              onClose={() => setDeleteTarget(null)}
              onConfirm={handleDeleteConfirm}
            />
          )}
        </>
      )}
    </div>
  );
};

export default MetabotsManager;
