import { useState } from 'react';
import { t } from '../../../i18n';
import { useMemorySettings } from '../../hooks/useMemorySettings';
import {
  MEMORY_USAGE_CLASS_KEYS,
  useMemoryEntries,
  type MemoryEntryView,
  type MemoryUsageClass,
} from '../../hooks/useMemoryEntries';
import { Switch } from '../../components/Switch';
import { BottomSheet } from '../../components/BottomSheet';
import { SecondaryPageShell } from './SecondaryPageShell';

const MEMORY_ROWS = [
  { field: 'memoryEnabled' as const, labelKey: 'mobile.me.memoryEnabled' },
  { field: 'memoryImplicitUpdateEnabled' as const, labelKey: 'mobile.me.memoryImplicitUpdate' },
  { field: 'memoryLlmJudgeEnabled' as const, labelKey: 'mobile.me.memoryLlmJudge' },
];

const CREATE_USAGE_CLASSES: Exclude<MemoryUsageClass, 'self_identity'>[] = [
  'profile_fact',
  'preference',
  'operational_preference',
  'work_review',
  'value_boundary',
];

function entryDate(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

function usageClassLabel(entry: MemoryEntryView): string {
  if (!entry.usageClass) return '';
  const key = MEMORY_USAGE_CLASS_KEYS[entry.usageClass];
  return t(key);
}

function formatEntry(entry: MemoryEntryView, onTap: () => void): JSX.Element {
  const protectedEntry = entry.usageClass === 'self_identity';
  return (
    <div
      key={entry.id}
      data-testid={`memory-entry-${entry.id}`}
      className="border-b border-[var(--border-color)] py-3 last:border-b-0"
    >
      <button
        type="button"
        onClick={onTap}
        className="min-h-[44px] w-full text-left"
      >
        <p className="line-clamp-3 whitespace-pre-wrap text-sm leading-5 text-[var(--text-primary)]">
          {protectedEntry ? '🔒 ' : ''}
          {entry.text}
        </p>
        <p className="mt-1 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          {entry.status === 'stale' ? (
            <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5">{t('mobile.memory.archivedBadge')}</span>
          ) : null}
          {usageClassLabel(entry)}
          <span>·</span>
          <span>{entryDate(entry.updatedAt)}</span>
          {protectedEntry ? <span>·</span> : null}
          {protectedEntry ? <span>{t('mobile.memory.protected')}</span> : null}
        </p>
      </button>
    </div>
  );
}

/**
 * memory secondary page (IA-PLAN v1 §4.7): the three global switches plus the
 * CM5 entry-management section (list/search/create/edit/archive/delete over
 * the P2 cowork:memory:* channels). `self_identity` entries are dream-written
 * and protected from edit/delete, matching desktop MemorySettings. On P1
 * tenants the channel gate surfaces a dedicated hint instead of a generic
 * failure.
 */
export function MemoryPage(props: { onBack: () => void }): JSX.Element {
  const memory = useMemorySettings();
  const entries = useMemoryEntries();
  const [createOpen, setCreateOpen] = useState(false);
  const [createText, setCreateText] = useState('');
  const [createUsage, setCreateUsage] = useState<Exclude<MemoryUsageClass, 'self_identity'>>('profile_fact');
  const [editing, setEditing] = useState<MemoryEntryView | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleting, setDeleting] = useState<MemoryEntryView | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<MemoryEntryView | null>(null);

  const submitCreate = async (): Promise<void> => {
    if (createText.trim() === '') return;
    const ok = await entries.create({ text: createText, usageClass: createUsage });
    if (ok) {
      setCreateText('');
      setCreateUsage('profile_fact');
      setCreateOpen(false);
    }
  };

  const submitEdit = async (): Promise<void> => {
    if (!editing || editDraft.trim() === '') return;
    const ok = await entries.updateText(editing.id, editDraft);
    if (ok) setEditing(null);
  };

  return (
    <SecondaryPageShell title={t('mobile.me.entry.memory')} onBack={props.onBack} testId="me-page-memory">
      <p className="px-1 text-xs leading-5 text-[var(--text-secondary)]">{t('mobile.me.memoryIntro')}</p>
      <div className="twin-panel twin-panel-padded">
        {memory.loading ? <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
        {MEMORY_ROWS.map((row) => (
          <div
            key={row.field}
            data-testid={`memory-row-${row.field}`}
            className="twin-list-row"
          >
            <span className="text-sm text-[var(--text-primary)]">{t(row.labelKey)}</span>
            <Switch
              checked={memory.config?.[row.field] ?? false}
              disabled={memory.loading || !memory.config || memory.saving !== null}
              onChange={(checked) => void memory.setEnabled(row.field, checked)}
              label={t(row.labelKey)}
            />
          </div>
        ))}
        {memory.error ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-red-600">{memory.error}</p>
            <button
              type="button"
              onClick={() => void memory.reload()}
              className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]"
            >
              {t('mobile.common.retry')}
            </button>
          </div>
        ) : null}
        {memory.saved ? (
          <p aria-live="polite" className="mt-2 text-xs text-emerald-600">{t('mobile.me.settingsSaved')}</p>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between px-1">
        <h3 className="twin-title-small">{t('mobile.memory.entriesTitle')}</h3>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          data-testid="memory-entry-create"
          className="twin-button twin-button-ghost min-h-[44px]"
        >
          {t('mobile.memory.create')}
        </button>
      </div>
      <div className="twin-panel twin-panel-padded">
        {entries.error ? (
          <p className="py-2 text-xs text-red-600" data-testid="memory-entries-error">{entries.error}</p>
        ) : null}
        <div className="twin-input mb-2 flex items-center gap-2">
          <input
            type="search"
            value={entries.query}
            onChange={(event) => entries.setQuery(event.target.value)}
            placeholder={t('mobile.memory.searchPlaceholder')}
            aria-label={t('mobile.memory.searchPlaceholder')}
            data-testid="memory-search-input"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
          />
        </div>
        {entries.loading ? (
          <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p>
        ) : entries.entries.length === 0 ? (
          <p className="py-2 text-sm text-[var(--text-secondary)]" data-testid="memory-entries-empty">
            {t('mobile.memory.empty')}
          </p>
        ) : (
          <div data-testid="memory-entries-list">
            {entries.entries.map((entry) => formatEntry(entry, () => setActionsFor(entry)))}
          </div>
        )}
        {entries.archivedEntries.length > 0 ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => setArchivedOpen((open) => !open)}
              aria-expanded={archivedOpen}
              data-testid="memory-archived-toggle"
              className="flex min-h-[44px] w-full items-center justify-between text-sm text-[var(--text-secondary)]"
            >
              {t('mobile.memory.archivedToggle')}
              <span className="text-xs">{archivedOpen ? '' : String(entries.archivedEntries.length)}</span>
            </button>
            {archivedOpen ? (
              <div data-testid="memory-archived-list">
                {entries.archivedEntries.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 border-b border-[var(--border-color)] py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-secondary)]">{entry.text}</span>
                    <button
                      type="button"
                      data-testid={`memory-unarchive-${entry.id}`}
                      onClick={() => void entries.unarchive(entry.id)}
                      className="min-h-[36px] shrink-0 rounded-lg border border-[var(--border-color)] px-3 text-xs text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
                    >
                      {t('mobile.memory.restore')}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {!entries.loading && !entries.error && entries.entries.length > 0 ? (
          <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.memory.entryHint')}</p>
        ) : null}
      </div>

      {actionsFor ? (
        <MemoryEntryActions
          entry={actionsFor}
          onClose={() => setActionsFor(null)}
          onEdit={() => {
            setEditing(actionsFor);
            setEditDraft(actionsFor.text);
            setActionsFor(null);
          }}
          onArchive={() => {
            void entries.archive(actionsFor.id);
            setActionsFor(null);
          }}
          onDelete={() => {
            setDeleting(actionsFor);
            setActionsFor(null);
          }}
        />
      ) : null}
      {createOpen ? (
        <BottomSheet title={t('mobile.memory.createTitle')} onClose={() => setCreateOpen(false)}>
          <textarea
            value={createText}
            onChange={(event) => setCreateText(event.target.value)}
            rows={4}
            placeholder={t('mobile.memory.textPlaceholder')}
            aria-label={t('mobile.memory.textPlaceholder')}
            data-testid="memory-create-text"
            className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
          />
          <div className="mt-3 flex flex-wrap gap-2" data-testid="memory-create-usage">
            {CREATE_USAGE_CLASSES.map((usage) => (
              <button
                key={usage}
                type="button"
                onClick={() => setCreateUsage(usage)}
                aria-pressed={createUsage === usage}
                className={`min-h-[36px] rounded-full border px-3 text-xs ${
                  createUsage === usage
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-black'
                    : 'border-[var(--border-color)] text-[var(--text-secondary)]'
                }`}
              >
                {t(MEMORY_USAGE_CLASS_KEYS[usage])}
              </button>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-testid="memory-create-cancel"
              onClick={() => setCreateOpen(false)}
              className="flex min-h-[44px] items-center rounded-xl border border-[var(--border-color)] px-4 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.common.cancel')}
            </button>
            <button
              type="button"
              data-testid="memory-create-confirm"
              disabled={createText.trim() === ''}
              onClick={() => {
                void submitCreate();
              }}
              className="flex min-h-[44px] items-center rounded-xl bg-[var(--color-primary)] px-4 text-sm text-black active:opacity-80 disabled:opacity-40"
            >
              {t('mobile.common.save')}
            </button>
          </div>
        </BottomSheet>
      ) : null}

      {editing ? (
        <BottomSheet title={t('mobile.memory.editTitle')} onClose={() => setEditing(null)}>
          <textarea
            value={editDraft}
            onChange={(event) => setEditDraft(event.target.value)}
            rows={4}
            aria-label={t('mobile.memory.editTitle')}
            data-testid="memory-edit-text"
            className="w-full rounded-xl border border-[var(--border-color)] bg-[var(--bg-main)] px-3 py-2.5 text-[15px] leading-5 text-[var(--text-primary)] outline-none"
          />
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-testid="memory-edit-cancel"
              onClick={() => setEditing(null)}
              className="flex min-h-[44px] items-center rounded-xl border border-[var(--border-color)] px-4 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.common.cancel')}
            </button>
            <button
              type="button"
              data-testid="memory-edit-confirm"
              disabled={editDraft.trim() === ''}
              onClick={() => {
                void submitEdit();
              }}
              className="flex min-h-[44px] items-center rounded-xl bg-[var(--color-primary)] px-4 text-sm text-black active:opacity-80 disabled:opacity-40"
            >
              {t('mobile.common.save')}
            </button>
          </div>
        </BottomSheet>
      ) : null}

      {deleting ? (
        <BottomSheet title={t('mobile.memory.deleteTitle')} onClose={() => setDeleting(null)}>
          <p data-testid="memory-delete-body" className="text-sm leading-relaxed text-[var(--text-secondary)]">
            {t('mobile.memory.deleteBody')}
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              data-testid="memory-delete-cancel"
              onClick={() => setDeleting(null)}
              className="flex min-h-[44px] items-center rounded-xl border border-[var(--border-color)] px-4 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
            >
              {t('mobile.common.cancel')}
            </button>
            <button
              type="button"
              data-testid="memory-delete-confirm"
              onClick={() => {
                void entries.remove(deleting.id);
                setDeleting(null);
              }}
              className="flex min-h-[44px] items-center rounded-xl bg-red-100 px-4 text-sm text-red-700 active:bg-red-200"
            >
              {t('mobile.memory.deleteConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </SecondaryPageShell>
  );
}

// Entry rows open the shared action sheet through a wrapper so the tap target
// keeps a 44px min height (see formatEntry). The actions sheet itself:
export function MemoryEntryActions(props: {
  entry: MemoryEntryView;
  onEdit: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onClose: () => void;
}): JSX.Element {
  const protectedEntry = props.entry.usageClass === 'self_identity';
  return (
    <BottomSheet title={t('mobile.memory.actionsTitle')} onClose={props.onClose}>
      <div className="flex flex-col" data-testid="memory-entry-actions">
        {!protectedEntry ? (
          <button
            type="button"
            data-testid="memory-action-edit"
            onClick={props.onEdit}
            className="flex min-h-[52px] items-center border-b border-[var(--border-color)] px-1 py-2 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            {t('mobile.memory.editAction')}
          </button>
        ) : null}
        {!protectedEntry ? (
          <button
            type="button"
            data-testid="memory-action-archive"
            onClick={props.onArchive}
            className="flex min-h-[52px] items-center border-b border-[var(--border-color)] px-1 py-2 text-left text-[15px] text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
          >
            {t('mobile.memory.archiveAction')}
          </button>
        ) : null}
        {!protectedEntry ? (
          <button
            type="button"
            data-testid="memory-action-delete"
            onClick={props.onDelete}
            className="flex min-h-[52px] items-center px-1 py-2 text-left text-[15px] text-red-600 active:bg-[var(--bg-hover)]"
          >
            {t('mobile.memory.deleteAction')}
          </button>
        ) : null}
        {protectedEntry ? (
          <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.memory.protectedBody')}</p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
