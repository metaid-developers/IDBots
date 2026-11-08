import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, store } from '../../store';
import { selectTask } from '../../store/slices/longTermTaskSlice';
import { longTermTaskService } from '../../services/longTermTask';
import { i18nService } from '../../services/i18n';
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon, LockClosedIcon } from '@heroicons/react/24/outline';
import {
  LONG_TERM_COLUMN_LABEL_KEYS,
  LONG_TERM_SUBTASK_STATUS_LABEL_KEYS,
  type LongTermSubtask,
  type LongTermSubtaskStatus,
} from '../../types/longTermTask';
import { formatRelativeTime } from './LongTermTaskCard';
import CopyIdChip from './CopyIdChip';
import ParticipantAvatars from './ParticipantAvatars';
import LocalFileLink from '../ui/LocalFileLink';

/**
 * Long-term task detail page (frozen prototype screen 2): goal + progress on
 * top, ordered sub-project checklist on the left, the selected sub-project's
 * acceptance criteria / evidence / session on the right, event stream below.
 *
 * Interaction ruling (owner 2026-09-22): decisions happen in prose, in chat.
 * "Discuss" / "edit definition" buttons only deep-link into a cowork session
 * with a prefilled draft — they never write a decision themselves. The only
 * writing buttons here are the owner's own verdicts (accept / reject / skip /
 * complete-task / cancel-task) and the pause/resume/delegate switches.
 */

const SUBTASK_ICON: Record<LongTermSubtaskStatus, { glyph: string; className: string }> = {
  accepted: { glyph: '✓', className: 'text-emerald-600 dark:text-emerald-400' },
  in_progress: { glyph: '●', className: 'text-sky-600 dark:text-sky-400' },
  waiting_owner: { glyph: '⏳', className: 'text-amber-600 dark:text-amber-400' },
  waiting_external: { glyph: '☁', className: 'text-violet-600 dark:text-violet-400' },
  pending: { glyph: '○', className: 'dark:text-claude-darkTextSecondary text-claude-textSecondary' },
  rejected: { glyph: '✗', className: 'text-red-500' },
  skipped: { glyph: '—', className: 'dark:text-claude-darkTextSecondary text-claude-textSecondary' },
};

/**
 * Linked MetaTask progress for a sub-project chip: "verified/total" from the
 * metatask projection when loaded, "—" otherwise (referenced, not mixed in —
 * the chip is informational; the MetaTask tab owns the live view).
 */
const metataskProgressLabel = (rootPinId: string): string => {
  const summary = store.getState().metatask.board?.tasks.find((task) => task.rootPinId === rootPinId);
  if (!summary) return '—';
  return `${summary.progress.verified}/${summary.progress.total}`;
};

const SUBTASK_CHIP_CLASS: Record<LongTermSubtaskStatus, string> = {
  accepted: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  in_progress: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  waiting_owner: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  waiting_external: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  pending: 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary',
  rejected: 'bg-red-500/10 text-red-500',
  skipped: 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary line-through',
};

/** Evidence links open in the Bot Browser (same mechanism as openGroupTaskUri). */
const openEvidence = (uri: string): void => {
  if (/^(pin|metaapp|metafile):\/\//.test(uri)) {
    window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
  }
};

const LongTermTaskDetail: React.FC<{ taskId: string }> = ({ taskId }) => {
  const dispatch = useDispatch();
  const detail = useSelector((state: RootState) => state.longTermTask.details[taskId]);
  const [selectedSubtaskId, setSelectedSubtaskId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectText, setRejectText] = useState('');
  const [skippingId, setSkippingId] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState('');
  const [confirming, setConfirming] = useState<'complete' | 'cancelTask' | 'acceptAll' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void longTermTaskService.loadTask(taskId);
  }, [taskId]);

  const selectedSubtask: LongTermSubtask | null = useMemo(() => {
    if (!detail) return null;
    const wanted = selectedSubtaskId ?? detail.currentSubtaskId;
    return detail.subtasks.find((sub) => sub.id === wanted) ?? null;
  }, [detail, selectedSubtaskId]);

  /** Dependency-linked sub-projects (has deps OR is depended on) are not manually reorderable. */
  const linkedIds = useMemo(() => {
    const linked = new Set<string>();
    for (const sub of detail?.subtasks ?? []) {
      if (sub.dependsOn.length > 0) linked.add(sub.id);
      for (const dep of sub.dependsOn) linked.add(dep);
    }
    return linked;
  }, [detail?.subtasks]);

  /** Sub-projects parked on an acceptance proposal — the batch-verdict crowd. */
  const waitingOwnerIds = useMemo(
    () => (detail?.subtasks ?? []).filter((sub) => sub.status === 'waiting_owner').map((sub) => sub.id),
    [detail?.subtasks],
  );

  if (!detail) {
    return (
      <div className="p-6 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('longTermTask.loading')}
      </div>
    );
  }

  const backToBoard = () => dispatch(selectTask(null));

  const openSessionWithDraft = (subtask: LongTermSubtask | null, edit: boolean) => {
    const key = edit ? 'longTermTask.editDraft' : 'longTermTask.openSessionDraft';
    const text = i18nService
      .t(key)
      .replace('{title}', detail.title)
      .replace('{subtask}', subtask?.title ?? '')
      .replace('{taskId}', detail.id)
      .replace('{subtaskId}', subtask?.id ?? '');
    window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text } }));
  };

  const runAction = async (action: () => Promise<{ error: string | null }>) => {
    setActionError(null);
    const { error } = await action();
    if (error) setActionError(error);
  };

  const delegateToggle = (
    <label
      className="flex cursor-pointer items-center gap-1.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
      title={i18nService.t('longTermTask.delegateAcceptanceHint')}
    >
      <input
        type="checkbox"
        className="accent-[#FFDC51]"
        checked={detail.acceptanceDelegate}
        onChange={(event) =>
          void runAction(() => longTermTaskService.updateTask({ taskId: detail.id, acceptanceDelegate: event.target.checked }))
        }
      />
      {i18nService.t('longTermTask.delegateAcceptance')}
    </label>
  );

  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={backToBoard}
          className="rounded-lg p-1.5 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
          aria-label={i18nService.t('longTermTask.back')}
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold leading-snug dark:text-claude-darkText text-claude-text">{detail.title}</h1>
        <CopyIdChip id={detail.id} />
        <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t(LONG_TERM_COLUMN_LABEL_KEYS[detail.column])}
        </span>
        <span className="flex-1" />
        {delegateToggle}
        {detail.stage === 'active' && (
          <button
            type="button"
            onClick={() => void runAction(() => longTermTaskService.setStage({ taskId: detail.id, action: 'pause' }))}
            className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
          >
            {i18nService.t('longTermTask.action.pause')}
          </button>
        )}
        {detail.stage === 'paused' && (
          <button
            type="button"
            onClick={() => void runAction(() => longTermTaskService.setStage({ taskId: detail.id, action: 'resume' }))}
            className="btn-idchat-primary-filled rounded-lg px-3 py-1 text-xs font-medium"
          >
            {i18nService.t('longTermTask.action.resume')}
          </button>
        )}
        {(detail.stage === 'active' || detail.stage === 'paused') && (
          <button
            type="button"
            onClick={() => setConfirming('complete')}
            className="rounded-lg bg-emerald-600/90 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600"
            title={i18nService.t('longTermTask.action.completeHint')}
          >
            {i18nService.t('longTermTask.action.complete')}
          </button>
        )}
        {detail.stage !== 'done' && detail.stage !== 'cancelled' && (
          <button
            type="button"
            onClick={() => setConfirming('cancelTask')}
            className="rounded-lg border border-red-500/30 px-3 py-1 text-xs text-red-500 hover:bg-red-500/10"
          >
            {i18nService.t('longTermTask.action.cancelTask')}
          </button>
        )}
      </div>

      {actionError && (
        <div className="mt-2 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-500">{actionError}</div>
      )}

      {/* Task-level closure confirmation — one goal-level verdict instead of
          clicking the remaining sub-projects one by one (each accept would
          re-ignite the heartbeat onto the next sub-project). */}
      {confirming && (
        <div
          className={`mt-2 rounded-lg border p-3 ${
            confirming === 'cancelTask' ? 'border-red-500/30 bg-red-500/5' : 'border-emerald-500/40 bg-emerald-500/5'
          }`}
        >
          <div className="text-xs leading-5 dark:text-claude-darkText text-claude-text">
            {confirming === 'complete'
              ? i18nService
                  .t('longTermTask.completeConfirmBody')
                  .replace('{count}', String(detail.subtasks.filter((sub) => sub.status !== 'accepted' && sub.status !== 'skipped').length))
              : confirming === 'acceptAll'
                ? i18nService.t('longTermTask.acceptAllConfirmBody').replace('{count}', String(waitingOwnerIds.length))
                : i18nService.t('longTermTask.cancelConfirmBody')}
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                const kind = confirming;
                setConfirming(null);
                void runAction(() =>
                  kind === 'complete'
                    ? longTermTaskService.completeTask(detail.id)
                    : kind === 'acceptAll'
                      ? longTermTaskService.acceptAllProposals(detail.id, waitingOwnerIds)
                      : longTermTaskService.setStage({ taskId: detail.id, action: 'cancel' }),
                );
              }}
              className={
                confirming === 'cancelTask'
                  ? 'rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500'
                  : 'rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600'
              }
            >
              {i18nService.t(
                confirming === 'complete'
                  ? 'longTermTask.completeConfirmOk'
                  : confirming === 'acceptAll'
                    ? 'longTermTask.acceptAllConfirmOk'
                    : 'longTermTask.cancelConfirmOk',
              )}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              {i18nService.t('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* Goal + progress */}
      <div className="mt-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('longTermTask.goal')}
        </div>
        <p className="mt-1 text-sm leading-6 dark:text-claude-darkText text-claude-text">{detail.goal}</p>
        {detail.planArtifactUri && (
          <div className="mt-3 flex min-w-0 items-center gap-2 border-t dark:border-claude-darkBorder/30 border-claude-border/30 pt-2.5">
            <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('longTermTask.planPage')}
            </span>
            {/^([A-Za-z]:[\\/]|\/|file:\/\/)/.test(detail.planArtifactUri) ? (
              <LocalFileLink
                filePath={detail.planArtifactUri}
                showTypeIcon={false}
                className="min-w-0 text-xs text-brand hover:underline"
              >
                <span className="truncate">{detail.planArtifactUri}</span>
              </LocalFileLink>
            ) : (
              <span className="min-w-0 truncate text-xs dark:text-claude-darkText text-claude-text">
                {detail.planArtifactUri}
              </span>
            )}
          </div>
        )}
        <div className="mt-3 flex items-center gap-3">
          <div className="h-1.5 flex-1 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
            <div className="h-1.5 rounded-full bg-brand" style={{ width: `${detail.progress.percent}%` }} />
          </div>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {detail.progress.accepted}/{detail.progress.total} · {detail.progress.percent}%
          </span>
        </div>
        {detail.participants.length > 0 && (
          <div className="mt-3 flex items-center gap-2 border-t dark:border-claude-darkBorder/30 border-claude-border/30 pt-2.5">
            <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('longTermTask.participants')}
            </span>
            <ParticipantAvatars participants={detail.participants} size="md" showNames maxVisible={6} />
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Sub-project checklist */}
        <div className="min-w-0 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-3 lg:col-span-2">
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('longTermTask.subtasks')}
            </div>
            {waitingOwnerIds.length >= 2 && (
              <button
                type="button"
                onClick={() => setConfirming('acceptAll')}
                className="rounded-lg bg-emerald-600/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
                title={i18nService.t('longTermTask.acceptAllHint')}
              >
                {i18nService.t('longTermTask.action.acceptAll').replace('{count}', String(waitingOwnerIds.length))}
              </button>
            )}
          </div>
          <div className="space-y-1">
            {detail.subtasks.map((subtask, index) => {
              const icon = SUBTASK_ICON[subtask.status];
              const isSelected = selectedSubtask?.id === subtask.id;
              const isCurrent = detail.currentSubtaskId === subtask.id;
              const linked = linkedIds.has(subtask.id);
              const movable =
                !linked &&
                subtask.status !== 'accepted' &&
                subtask.status !== 'skipped' &&
                (detail.stage === 'active' || detail.stage === 'defining');
              return (
                <div key={subtask.id} className="flex items-stretch gap-1">
                  {linked && subtask.status !== 'accepted' && subtask.status !== 'skipped' && (
                    <span
                      className="flex w-4 shrink-0 items-center justify-center dark:text-claude-darkTextSecondary text-claude-textSecondary"
                      title={i18nService.t('longTermTask.reorderLocked')}
                    >
                      <LockClosedIcon className="h-3 w-3" />
                    </span>
                  )}
                  {movable && (
                    <span className="flex w-4 shrink-0 flex-col items-center justify-center">
                      <button
                        type="button"
                        disabled={index === 0}
                        title={i18nService.t('longTermTask.moveUp')}
                        onClick={() => void runAction(() => longTermTaskService.moveSubtask(detail.id, subtask.id, 'up'))}
                        className="p-0 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text disabled:opacity-25"
                      >
                        <ChevronUpIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={index === detail.subtasks.length - 1}
                        title={i18nService.t('longTermTask.moveDown')}
                        onClick={() => void runAction(() => longTermTaskService.moveSubtask(detail.id, subtask.id, 'down'))}
                        className="p-0 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text disabled:opacity-25"
                      >
                        <ChevronDownIcon className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => setSelectedSubtaskId(subtask.id)}
                    className={`min-w-0 flex-1 rounded-lg border px-3 py-2 text-left transition ${
                      isSelected
                        ? 'border-brand/60 dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                        : 'border-transparent dark:hover:bg-claude-darkSurfaceHover/60 hover:bg-claude-surfaceHover/60'
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className={`w-5 shrink-0 text-center text-xs ${icon.className}`}>{icon.glyph}</span>
                      <span
                        className={`min-w-0 flex-1 break-words text-xs font-medium dark:text-claude-darkText text-claude-text ${
                          subtask.status === 'accepted' ? 'line-through opacity-70' : ''
                        }`}
                      >
                        {subtask.ordinal}. {subtask.title}
                      </span>
                      {isCurrent && (
                        <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
                          {i18nService.t('longTermTask.subtask.current')}
                        </span>
                      )}
                      <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${SUBTASK_CHIP_CLASS[subtask.status]}`}>
                        {i18nService.t(LONG_TERM_SUBTASK_STATUS_LABEL_KEYS[subtask.status])}
                      </span>
                    </div>
                    <div className="ml-7 mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {subtask.dependsOn.length > 0 && (
                        <span>{i18nService.t('longTermTask.dependsOn').replace('{ids}', String(subtask.dependsOn.length))}</span>
                      )}
                      {subtask.metataskRoot && (
                        <span
                          className="text-brand"
                          title={subtask.metataskRoot}
                        >
                          {i18nService.t('longTermTask.subtask.metataskChip').replace(
                            '{progress}',
                            metataskProgressLabel(subtask.metataskRoot),
                          )}
                        </span>
                      )}
                      {subtask.evidence.length > 0 && <span className="text-sky-600 dark:text-sky-400">{i18nService.t('longTermTask.subtask.evidence')} {subtask.evidence.length}</span>}
                      {subtask.sessionId && <span>●</span>}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Selected sub-project detail + events */}
        <div className="space-y-4 lg:col-span-3">
          {selectedSubtask && (
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-4">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {selectedSubtask.ordinal}. {selectedSubtask.title}
                </span>
                <CopyIdChip id={selectedSubtask.id} />
                <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] ${SUBTASK_CHIP_CLASS[selectedSubtask.status]}`}>
                  {i18nService.t(LONG_TERM_SUBTASK_STATUS_LABEL_KEYS[selectedSubtask.status])}
                </span>
              </div>

              {selectedSubtask.description && (
                <p className="mt-2 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {selectedSubtask.description}
                </p>
              )}

              <div className="mt-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('longTermTask.subtask.acceptance')}
                </div>
                {selectedSubtask.acceptanceCriteria.length > 0 ? (
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs leading-5 dark:text-claude-darkText text-claude-text">
                    {selectedSubtask.acceptanceCriteria.map((criterion, index) => (
                      <li key={index}>{criterion}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">—</div>
                )}
              </div>

              {selectedSubtask.waitNote && (
                // whitespace-pre-line: the wait note is the owner's decision
                // brief (background / situation / decision / options /
                // recommendation / next step), so its line structure is content,
                // not formatting — collapsing it into one paragraph would bury
                // the sections the owner has to read.
                <div className="mt-3 whitespace-pre-line rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-200/90">
                  {i18nService.t('longTermTask.subtask.waitingOn').replace('{note}', selectedSubtask.waitNote)}
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('longTermTask.subtask.evidence')}
                  </div>
                  <div className="mt-1 space-y-0.5">
                    {selectedSubtask.evidence.length > 0 ? (
                      selectedSubtask.evidence.map((entry, index) => (
                        <button
                          key={index}
                          type="button"
                          onClick={() => openEvidence(entry.uri)}
                          className="block max-w-full truncate font-mono text-[11px] text-sky-600 hover:underline dark:text-sky-400"
                          title={entry.uri}
                        >
                          {entry.uri}
                        </button>
                      ))
                    ) : (
                      <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('longTermTask.subtask.evidenceEmpty')}
                      </div>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('longTermTask.subtask.session')}
                  </div>
                  <div className="mt-1 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {selectedSubtask.sessionId ? (
                      <button
                        type="button"
                        title={i18nService.t('longTermTask.viewSession')}
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent('cowork:viewSession', { detail: { sessionId: selectedSubtask.sessionId } }),
                          )
                        }
                        className="text-sky-600 hover:underline dark:text-sky-400"
                      >
                        {i18nService.t('longTermTask.openBoundSession')}
                      </button>
                    ) : (
                      i18nService.t('longTermTask.subtask.noSession')
                    )}
                  </div>
                </div>
              </div>

              {selectedSubtask.notes && (
                <div className="mt-3 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <span className="font-semibold">{i18nService.t('longTermTask.subtask.notes')}: </span>
                  {selectedSubtask.notes}
                </div>
              )}

              {/* Owner actions */}
              <div className="mt-4 flex flex-wrap gap-2 border-t dark:border-claude-darkBorder/30 border-claude-border/30 pt-3">
                <button
                  type="button"
                  onClick={() => openSessionWithDraft(selectedSubtask, false)}
                  className="btn-idchat-primary-filled rounded-lg px-3 py-1.5 text-xs font-medium"
                >
                  {i18nService.t('longTermTask.action.openSession')}
                </button>
                <button
                  type="button"
                  onClick={() => openSessionWithDraft(selectedSubtask, true)}
                  className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                >
                  {i18nService.t('longTermTask.action.editViaChat')}
                </button>
                {selectedSubtask.status === 'pending' && detail.stage === 'active' && (
                  <button
                    type="button"
                    onClick={() => void runAction(() => longTermTaskService.beginSubtask(detail.id, selectedSubtask.id))}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    {i18nService.t('longTermTask.action.begin')}
                  </button>
                )}
                {(selectedSubtask.status === 'waiting_owner' || selectedSubtask.status === 'waiting_external') && (
                  <button
                    type="button"
                    onClick={() => void runAction(() => longTermTaskService.unblockSubtask(detail.id, selectedSubtask.id))}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                  >
                    {i18nService.t('longTermTask.action.unblock')}
                  </button>
                )}
                {selectedSubtask.status === 'waiting_owner' && (
                  <>
                    <button
                      type="button"
                      onClick={() => void runAction(() => longTermTaskService.acceptSubtask(detail.id, selectedSubtask.id))}
                      className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
                    >
                      {i18nService.t('longTermTask.action.accept')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRejectingId(selectedSubtask.id);
                        setRejectText('');
                      }}
                      className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10"
                    >
                      {i18nService.t('longTermTask.action.reject')}
                    </button>
                  </>
                )}
                {selectedSubtask.status !== 'accepted' && selectedSubtask.status !== 'skipped' && (
                  <button
                    type="button"
                    onClick={() => {
                      setSkippingId(selectedSubtask.id);
                      setSkipReason('');
                    }}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                    title={i18nService.t('longTermTask.action.skipHint')}
                  >
                    {i18nService.t('longTermTask.action.skip')}
                  </button>
                )}
              </div>

              {skippingId === selectedSubtask.id && (
                <div className="mt-3 rounded-lg border dark:border-claude-darkBorder border-claude-border p-3">
                  <div className="text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('longTermTask.skipConfirmBody')}
                  </div>
                  <textarea
                    value={skipReason}
                    onChange={(event) => setSkipReason(event.target.value)}
                    placeholder={i18nService.t('longTermTask.skipPlaceholder')}
                    className="mt-2 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2.5 py-2 text-xs dark:text-claude-darkText text-claude-text"
                    rows={2}
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        void runAction(() => longTermTaskService.skipSubtask(detail.id, selectedSubtask.id, skipReason.trim())).then(() => setSkippingId(null))
                      }
                      className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs font-medium dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                    >
                      {i18nService.t('longTermTask.skipConfirm')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSkippingId(null)}
                      className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {i18nService.t('cancel')}
                    </button>
                  </div>
                </div>
              )}

              {rejectingId === selectedSubtask.id && (
                <div className="mt-3 rounded-lg border border-red-500/30 p-3">
                  <textarea
                    value={rejectText}
                    onChange={(event) => setRejectText(event.target.value)}
                    placeholder={i18nService.t('longTermTask.rejectPlaceholder')}
                    className="w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2.5 py-2 text-xs dark:text-claude-darkText text-claude-text"
                    rows={3}
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={!rejectText.trim()}
                      onClick={() =>
                        void runAction(() => longTermTaskService.rejectSubtask(detail.id, selectedSubtask.id, rejectText.trim())).then(() => setRejectingId(null))
                      }
                      className="rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {i18nService.t('longTermTask.rejectConfirm')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejectingId(null)}
                      className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                    >
                      {i18nService.t('cancel')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Event stream */}
          <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('longTermTask.events')}
            </div>
            <div className="mt-2 space-y-1.5 text-xs leading-5">
              {detail.events.length === 0 && (
                <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">—</div>
              )}
              {detail.events.slice(0, 30).map((event) => (
                <div key={event.id} className="flex gap-2">
                  <span className="w-20 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {formatRelativeTime(event.createdAt)}
                  </span>
                  <span className="dark:text-claude-darkText text-claude-text">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      [{event.actor}/{event.kind}]
                    </span>{' '}
                    {event.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LongTermTaskDetail;
