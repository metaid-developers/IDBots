import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChatBubbleLeftRightIcon,
  CheckIcon,
  ChevronRightIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline';
import type { LongTermSubtask } from '@/types/longTermTask';
import { t } from '../../../i18n';
import type { UnifiedTaskScreen } from '../../hooks/useUnifiedTasks';
import {
  canReorderSubtask,
  formatUnifiedTaskTime,
  linkedSubtaskIds,
} from '../../unifiedTaskPresentation';
import { artifactBrowserUri } from '../../artifacts';
import { useNativeBackHandler } from '../../hooks/useNativeBackHandler';
import { BottomSheet } from '../BottomSheet';
import MobileArtifactPreview from '../MobileArtifactPreview';
import { Switch } from '../Switch';

export function UnifiedTaskDetail({
  screen,
  onOpenDraft,
  onOpenUri,
}: {
  screen: UnifiedTaskScreen;
  onOpenDraft: (draft: string) => void;
  onOpenUri: (uri: string) => void;
}): JSX.Element {
  const detail = screen.detail;
  const [selectedSubtaskId, setSelectedSubtaskId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'complete' | 'cancel' | 'acceptAll' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [rejectText, setRejectText] = useState('');
  const [skipReason, setSkipReason] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  useNativeBackHandler(() => {
    screen.closeDetail();
    return true;
  }, true, 20);

  useEffect(() => {
    setSelectedSubtaskId(detail?.currentSubtaskId ?? null);
    setConfirming(null);
    setRejecting(false);
    setSkipping(false);
    setPreviewPath(null);
  }, [detail?.id, detail?.currentSubtaskId]);

  const selectedSubtask = useMemo(() => {
    if (!detail) return null;
    return detail.subtasks.find((subtask) => subtask.id === selectedSubtaskId)
      ?? detail.subtasks.find((subtask) => subtask.id === detail.currentSubtaskId)
      ?? detail.subtasks[0]
      ?? null;
  }, [detail, selectedSubtaskId]);
  const waitingOwnerIds = useMemo(() => (
    detail?.subtasks.filter((subtask) => subtask.status === 'waiting_owner').map((subtask) => subtask.id) ?? []
  ), [detail]);
  const linkedIds = useMemo(() => detail ? linkedSubtaskIds(detail) : new Set<string>(), [detail]);

  if (!detail) {
    return (
      <div className="twin-page">
        <div className="twin-topbar">
          <button type="button" className="twin-icon-button" onClick={screen.closeDetail} aria-label={t('mobile.taskCenter.back')}>
            <ArrowLeftIcon aria-hidden />
          </button>
          <h1 className="twin-title twin-title-small">{t('mobile.taskCenter.detailTitle')}</h1>
          <span />
        </div>
        <div className="twin-empty">
          <p className="twin-empty-copy">{screen.detailLoading ? t('mobile.common.loading') : screen.actionError ?? t('mobile.taskCenter.detailFailed')}</p>
        </div>
      </div>
    );
  }

  const busy = screen.pending;
  const openArtifact = (uri: string) => {
    if (/^(pin|metaapp|metafile|https?):\/\//.test(uri)) {
      onOpenUri(uri);
      return;
    }
    const browserUri = artifactBrowserUri(uri);
    if (browserUri) onOpenUri(browserUri);
    else setPreviewPath(uri);
  };
  const editInChat = (subtask: LongTermSubtask | null) => {
    onOpenDraft(t('mobile.taskCenter.editDraft', {
      title: detail.title,
      subtask: subtask?.title ?? '',
      taskId: detail.id,
      subtaskId: subtask?.id ?? '',
    }));
  };
  const selectedIndex = selectedSubtask ? detail.subtasks.findIndex((subtask) => subtask.id === selectedSubtask.id) : -1;
  const canMove = selectedSubtask ? canReorderSubtask(detail, selectedSubtask) : false;

  return (
    <div className="twin-page twin-unified-detail" data-testid={`task-detail-${detail.id}`}>
      <div className="twin-unified-detail-nav">
        <button type="button" className="twin-icon-button" onClick={screen.closeDetail} aria-label={t('mobile.taskCenter.back')}>
          <ArrowLeftIcon aria-hidden />
        </button>
        <h1 className="twin-title twin-title-small">{t('mobile.taskCenter.detailTitle')}</h1>
        <span className="flex-1" />
        {detail.stage === 'active' ? (
          <button type="button" className="twin-button twin-button-secondary twin-button-small" disabled={busy} onClick={() => void screen.setStage(detail.id, 'pause')}>
            {t('mobile.taskCenter.pause')}
          </button>
        ) : null}
        {detail.stage === 'paused' ? (
          <button type="button" className="twin-button twin-button-primary twin-button-small" disabled={busy} onClick={() => void screen.setStage(detail.id, 'resume')}>
            {t('mobile.taskCenter.resume')}
          </button>
        ) : null}
        {detail.stage === 'active' || detail.stage === 'paused' ? (
          <button type="button" className="twin-button twin-button-secondary twin-button-small" disabled={busy} onClick={() => setConfirming('complete')}>
            {t('mobile.taskCenter.complete')}
          </button>
        ) : null}
      </div>
      <div className="twin-scroll px-4 py-4">
        {screen.actionError ? <p className="twin-notice twin-notice-error mb-3" role="alert">{screen.actionError}</p> : null}
        <section className="twin-unified-detail-hero">
          <span className={`twin-task-status twin-task-status-${detail.column}`}>
            <span className="twin-task-status-dot" aria-hidden />
            {t(`mobile.taskCenter.status.${detail.column}`)}
          </span>
          {detail.parentTaskId && detail.parentTaskTitle ? (
            <button type="button" className="twin-unified-parent mt-2" onClick={() => screen.openDetail(detail.parentTaskId!)}>
              {t('mobile.taskCenter.parent', { title: detail.parentTaskTitle })}
            </button>
          ) : null}
          <h2 className="twin-unified-detail-title">{detail.title}</h2>
          <p className="twin-unified-detail-goal">{detail.goal}</p>
          <p className="twin-unified-task-id">{detail.id}</p>
          <div className="twin-unified-progress-row">
            <progress className="twin-unified-progress" max={100} value={detail.progress.percent} aria-label={t('mobile.taskCenter.progressLabel')} />
            <span>{detail.progress.accepted}/{detail.progress.total} · {detail.progress.percent}%</span>
          </div>
          <div className="twin-unified-detail-delegate">
            <span>{t('mobile.taskCenter.delegateAcceptance')}</span>
            <Switch
              checked={detail.acceptanceDelegate}
              disabled={busy}
              onChange={(checked) => void screen.updateTask({ taskId: detail.id, acceptanceDelegate: checked })}
              label={t('mobile.taskCenter.delegateAcceptance')}
            />
          </div>
        </section>
        {detail.planArtifactUri ? (
          <section className="twin-unified-detail-section">
            <h3>{t('mobile.taskCenter.planPage')}</h3>
            <button type="button" className="twin-unified-plan-link" onClick={() => openArtifact(detail.planArtifactUri!)}>
              <span>{detail.planArtifactUri}</span>
              <ChevronRightIcon className="h-4 w-4" aria-hidden />
            </button>
          </section>
        ) : null}
        <section className="twin-unified-detail-section">
          <div className="twin-unified-detail-section-heading">
            <h3>{t('mobile.taskCenter.subtasks')}</h3>
            {waitingOwnerIds.length >= 2 ? (
              <button type="button" className="twin-button twin-button-primary twin-button-small" disabled={busy} onClick={() => setConfirming('acceptAll')}>
                {t('mobile.taskCenter.acceptAll', { count: waitingOwnerIds.length })}
              </button>
            ) : null}
          </div>
          <div className="twin-unified-subtask-list">
            {detail.subtasks.map((subtask) => {
              const selected = selectedSubtask?.id === subtask.id;
              const linked = linkedIds.has(subtask.id);
              return (
                <button
                  type="button"
                  key={subtask.id}
                  className="twin-unified-subtask-row"
                  aria-pressed={selected}
                  onClick={() => setSelectedSubtaskId(subtask.id)}
                  data-testid={`subtask-${subtask.id}`}
                >
                  <span className={`twin-unified-subtask-index ${subtask.status === 'accepted' ? 'accepted' : subtask.id === detail.currentSubtaskId ? 'current' : ''}`}>
                    {subtask.status === 'accepted' ? <CheckIcon className="h-4 w-4" aria-hidden /> : subtask.ordinal}
                  </span>
                  <span className="twin-unified-subtask-copy">
                    <strong>{subtask.title}</strong>
                    <span>
                      {t(`mobile.taskCenter.subtaskStatus.${subtask.status}`)}
                      {subtask.dependsOn.length > 0 ? ` · ${t('mobile.taskCenter.dependencies', { count: subtask.dependsOn.length })}` : ''}
                      {subtask.evidence.length > 0 ? ` · ${t('mobile.taskCenter.evidenceCount', { count: subtask.evidence.length })}` : ''}
                    </span>
                  </span>
                  {linked && subtask.status !== 'accepted' && subtask.status !== 'skipped' ? (
                    <LockClosedIcon className="h-4 w-4 text-[var(--twin-text-tertiary)]" aria-label={t('mobile.taskCenter.reorderLocked')} />
                  ) : null}
                  {subtask.id === detail.currentSubtaskId ? <span className="twin-unified-current-chip">{t('mobile.taskCenter.current')}</span> : null}
                  {selected ? <ChevronRightIcon className="h-4 w-4" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        </section>
        {selectedSubtask ? (
          <section className="twin-unified-detail-section">
            <h3>{t('mobile.taskCenter.selectedSubtask')}</h3>
            <div className="twin-unified-subtask-detail">
              <div className="flex items-start justify-between gap-3">
                <h4>{selectedSubtask.title}</h4>
                <span className={`twin-task-status twin-task-status-${selectedSubtask.status}`}>
                  {t(`mobile.taskCenter.subtaskStatus.${selectedSubtask.status}`)}
                </span>
              </div>
              {selectedSubtask.description ? <p className="twin-unified-subtask-description">{selectedSubtask.description}</p> : null}
              <h5>{t('mobile.taskCenter.acceptanceCriteria')}</h5>
              {selectedSubtask.acceptanceCriteria.length > 0 ? (
                <ul className="twin-unified-criteria">
                  {selectedSubtask.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}
                </ul>
              ) : <p className="twin-help">—</p>}
              {selectedSubtask.waitNote ? <p className="twin-unified-wait-note">{t('mobile.taskCenter.waitingOn', { note: selectedSubtask.waitNote })}</p> : null}
              {selectedSubtask.expectedMinutes !== null ? (
                <p className="twin-help">{t('mobile.taskCenter.expectedMinutes', { count: selectedSubtask.expectedMinutes })}</p>
              ) : null}
              {selectedSubtask.metataskRoot ? <p className="twin-help">{t('mobile.taskCenter.metataskLinked', { id: selectedSubtask.metataskRoot })}</p> : null}
              <div className="twin-unified-evidence-grid">
                <div>
                  <h5>{t('mobile.taskCenter.evidence')}</h5>
                  {selectedSubtask.evidence.length > 0 ? selectedSubtask.evidence.map((entry, index) => (
                    <button type="button" key={index} className="twin-unified-evidence-link" onClick={() => openArtifact(entry.uri)} title={entry.uri}>
                      {entry.note || entry.uri}
                    </button>
                  )) : <p className="twin-help">{t('mobile.taskCenter.evidenceEmpty')}</p>}
                </div>
                <div>
                  <h5>{t('mobile.taskCenter.session')}</h5>
                  <button type="button" className="twin-unified-evidence-link" disabled={busy} onClick={() => void screen.openTaskChat(detail.id, selectedSubtask.id)}>
                    {t('mobile.taskCenter.openBoundSession')}
                  </button>
                </div>
              </div>
              {selectedSubtask.notes ? <p className="twin-unified-subtask-description">{t('mobile.taskCenter.notes', { notes: selectedSubtask.notes })}</p> : null}
              <div className="twin-unified-subtask-actions">
                <button type="button" className="twin-button twin-button-primary" disabled={busy} onClick={() => void screen.openTaskChat(detail.id, selectedSubtask.id)}>
                  {t('mobile.taskCenter.openChat')}
                </button>
                <button type="button" className="twin-button twin-button-secondary" disabled={busy} onClick={() => editInChat(selectedSubtask)}>
                  {t('mobile.taskCenter.editViaChat')}
                </button>
                {selectedSubtask.status === 'pending' && detail.stage === 'active' ? (
                  <button type="button" className="twin-button twin-button-secondary" disabled={busy} onClick={() => void screen.beginSubtask(detail.id, selectedSubtask.id)}>
                    {t('mobile.taskCenter.begin')}
                  </button>
                ) : null}
                {selectedSubtask.status === 'waiting_owner' || selectedSubtask.status === 'waiting_external' ? (
                  <button type="button" className="twin-button twin-button-secondary" disabled={busy} onClick={() => void screen.unblockSubtask(detail.id, selectedSubtask.id)}>
                    {t('mobile.taskCenter.unblock')}
                  </button>
                ) : null}
                {selectedSubtask.status === 'waiting_owner' ? (
                  <>
                    <button type="button" className="twin-button twin-button-primary" disabled={busy} onClick={() => void screen.acceptSubtask(detail.id, selectedSubtask.id)}>
                      {t('mobile.taskCenter.accept')}
                    </button>
                    <button type="button" className="twin-button twin-button-danger-secondary" disabled={busy} onClick={() => { setRejectText(''); setRejecting(true); }}>
                      {t('mobile.taskCenter.reject')}
                    </button>
                  </>
                ) : null}
                {selectedSubtask.status !== 'accepted' && selectedSubtask.status !== 'skipped' ? (
                  <button type="button" className="twin-button twin-button-secondary" disabled={busy} onClick={() => { setSkipReason(''); setSkipping(true); }}>
                    {t('mobile.taskCenter.skip')}
                  </button>
                ) : null}
              </div>
              {canMove ? (
                <div className="twin-unified-subtask-actions">
                  <button type="button" className="twin-button twin-button-secondary" disabled={busy || selectedIndex <= 0} onClick={() => void screen.moveSubtask(detail.id, selectedSubtask.id, 'up')}>
                    <ArrowUpIcon className="h-4 w-4" aria-hidden />{t('mobile.taskCenter.moveUp')}
                  </button>
                  <button type="button" className="twin-button twin-button-secondary" disabled={busy || selectedIndex >= detail.subtasks.length - 1} onClick={() => void screen.moveSubtask(detail.id, selectedSubtask.id, 'down')}>
                    <ArrowDownIcon className="h-4 w-4" aria-hidden />{t('mobile.taskCenter.moveDown')}
                  </button>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
        <section className="twin-unified-detail-section">
          <h3>{t('mobile.taskCenter.events')}</h3>
          <div className="twin-unified-events">
            {detail.events.length === 0 ? <p className="twin-help">—</p> : detail.events.slice(0, 30).map((event) => (
              <div className="twin-unified-event" key={event.id}>
                <time>{formatUnifiedTaskTime(event.createdAt)}</time>
                <span className="twin-unified-event-marker" aria-hidden />
                <p><strong>{event.actor} · {event.kind}</strong><br />{event.detail}</p>
              </div>
            ))}
          </div>
        </section>
        {detail.stage !== 'done' && detail.stage !== 'cancelled' ? (
          <button type="button" className="twin-button twin-button-danger-secondary twin-button-full" disabled={busy} onClick={() => setConfirming('cancel')}>
            {t('mobile.taskCenter.cancelTask')}
          </button>
        ) : null}
      </div>
      <footer className="twin-unified-detail-footer">
        <button type="button" className="twin-button twin-button-primary" disabled={busy} onClick={() => void screen.openTaskChat(detail.id, selectedSubtask?.id)}>
          <ChatBubbleLeftRightIcon className="h-[18px] w-[18px]" aria-hidden />{t('mobile.taskCenter.openChat')}
        </button>
        <button type="button" className="twin-button twin-button-secondary" disabled={busy} onClick={() => editInChat(selectedSubtask)}>
          {t('mobile.taskCenter.editViaChat')}
        </button>
      </footer>
      {confirming ? (
        <BottomSheet
          title={t(confirming === 'complete' ? 'mobile.taskCenter.completeConfirmTitle' : confirming === 'cancel' ? 'mobile.taskCenter.cancelConfirmTitle' : 'mobile.taskCenter.acceptAllConfirmTitle')}
          onClose={() => setConfirming(null)}
        >
          <p className="text-sm leading-6 text-[var(--text-primary)]">
            {confirming === 'complete'
              ? t('mobile.taskCenter.completeConfirmBody', { count: detail.subtasks.filter((subtask) => subtask.status !== 'accepted' && subtask.status !== 'skipped').length })
              : confirming === 'cancel'
                ? t('mobile.taskCenter.cancelConfirmBody')
                : t('mobile.taskCenter.acceptAllConfirmBody', { count: waitingOwnerIds.length })}
          </p>
          <div className="mt-4 flex gap-3">
            <button type="button" className="twin-button twin-button-secondary flex-1" onClick={() => setConfirming(null)}>{t('mobile.tasks.cancel')}</button>
            <button
              type="button"
              className={`twin-button flex-1 ${confirming === 'cancel' ? 'twin-button-danger' : 'twin-button-primary'}`}
              disabled={busy}
              onClick={() => {
                const action = confirming;
                setConfirming(null);
                if (action === 'complete') void screen.completeTask(detail.id);
                else if (action === 'cancel') void screen.setStage(detail.id, 'cancel');
                else void screen.acceptAll(detail.id, waitingOwnerIds);
              }}
            >
              {t(confirming === 'complete' ? 'mobile.taskCenter.complete' : confirming === 'cancel' ? 'mobile.taskCenter.cancelConfirm' : 'mobile.taskCenter.acceptAllConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {rejecting && selectedSubtask ? (
        <BottomSheet title={t('mobile.taskCenter.rejectTitle')} onClose={() => setRejecting(false)}>
          <p className="mb-2 text-sm text-[var(--text-secondary)]">{t('mobile.taskCenter.rejectBody')}</p>
          <textarea className="twin-input" rows={3} value={rejectText} onChange={(event) => setRejectText(event.target.value)} placeholder={t('mobile.taskCenter.rejectPlaceholder')} aria-label={t('mobile.taskCenter.rejectPlaceholder')} />
          <div className="mt-4 flex gap-3">
            <button type="button" className="twin-button twin-button-secondary flex-1" onClick={() => setRejecting(false)}>{t('mobile.tasks.cancel')}</button>
            <button
              type="button"
              className="twin-button twin-button-danger flex-1"
              disabled={busy || !rejectText.trim()}
              onClick={() => {
                const feedback = rejectText.trim();
                setRejecting(false);
                void screen.rejectSubtask(detail.id, selectedSubtask.id, feedback);
              }}
            >
              {t('mobile.taskCenter.rejectConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {skipping && selectedSubtask ? (
        <BottomSheet title={t('mobile.taskCenter.skipTitle')} onClose={() => setSkipping(false)}>
          <p className="mb-2 text-sm text-[var(--text-secondary)]">{t('mobile.taskCenter.skipBody')}</p>
          <textarea className="twin-input" rows={3} value={skipReason} onChange={(event) => setSkipReason(event.target.value)} placeholder={t('mobile.taskCenter.skipPlaceholder')} aria-label={t('mobile.taskCenter.skipPlaceholder')} />
          <div className="mt-4 flex gap-3">
            <button type="button" className="twin-button twin-button-secondary flex-1" onClick={() => setSkipping(false)}>{t('mobile.tasks.cancel')}</button>
            <button
              type="button"
              className="twin-button twin-button-primary flex-1"
              disabled={busy}
              onClick={() => {
                const reason = skipReason.trim();
                setSkipping(false);
                void screen.skipSubtask(detail.id, selectedSubtask.id, reason);
              }}
            >
              {t('mobile.taskCenter.skipConfirm')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
      {previewPath ? <MobileArtifactPreview key={previewPath} path={previewPath} onClose={() => setPreviewPath(null)} /> : null}
    </div>
  );
}
