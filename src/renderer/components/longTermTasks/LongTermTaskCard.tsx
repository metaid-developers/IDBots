import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { longTermTaskService } from '../../services/longTermTask';
import type { LongTermColumn, LongTermTaskSummary } from '../../types/longTermTask';
import ParticipantAvatars from './ParticipantAvatars';

/**
 * One long-term task card on the status-column kanban. Content follows the
 * frozen prototype (docs/design/long-term-task-board-prototype.html): title,
 * sub-project progress bar (x/n), current stage, next action, timestamps.
 *
 * The root is a div with role="button" (not a <button>) so the waiting-owner
 * verdict row can hold real buttons. The "next step" text clamps to 3 lines
 * with an expand toggle (owner feedback: a long wait-note made the card
 * unreadably tall).
 */

const COLUMN_BAR_CLASS: Record<LongTermColumn, string> = {
  waiting_owner: 'bg-amber-400',
  in_progress: 'bg-sky-400',
  waiting_external: 'bg-violet-400',
  defining: 'bg-claude-textSecondary dark:bg-claude-darkTextSecondary',
  paused: 'bg-zinc-500',
  done: 'bg-emerald-400',
};

export function formatRelativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Date.now() - ms;
  if (diff < 60_000) return i18nService.t('longTermTask.justNow');
  if (diff < 3_600_000) return i18nService.t('longTermTask.minutesAgo').replace('{n}', String(Math.floor(diff / 60_000)));
  if (diff < 86_400_000) return i18nService.t('longTermTask.hoursAgo').replace('{n}', String(Math.floor(diff / 3_600_000)));
  return i18nService.t('longTermTask.daysAgo').replace('{n}', String(Math.floor(diff / 86_400_000)));
}

export function formatAbsDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  } catch {
    return iso;
  }
}

/** Compact budget rendering for the card line: 240 → 4h, 90 → 1.5h, 45 → 45min. */
function formatBudget(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

/** The "next step" line under the current stage (renderer composes, main supplies facts). */
export function nextActionText(card: LongTermTaskSummary): string {
  const note = card.currentWaitNote ?? '';
  switch (card.currentSubtaskStatus) {
    case 'waiting_owner':
      return i18nService.t('longTermTask.next.waitingOwner').replace('{note}', note);
    case 'waiting_external':
      return i18nService.t('longTermTask.next.waitingExternal').replace('{note}', note);
    case 'in_progress': {
      const base = i18nService.t('longTermTask.next.inProgress');
      return card.currentExpectedMinutes !== null
        ? `${base} · ${i18nService.t('longTermTask.next.budget').replace('{minutes}', formatBudget(card.currentExpectedMinutes))}`
        : base;
    }
    default:
      return card.stage === 'defining'
        ? i18nService.t('longTermTask.next.defining')
        : i18nService.t('longTermTask.next.inProgress');
  }
}

/** Rough "does this next-step text need clamping" check (~3 lines at card width). */
const CLAMP_THRESHOLD = 90;

const LongTermTaskCard: React.FC<{ card: LongTermTaskSummary; onOpen: (taskId: string) => void }> = ({ card, onOpen }) => {
  const isWaitingOwner = card.column === 'waiting_owner';
  const dimmed = card.column === 'paused' || card.column === 'done';
  const [expanded, setExpanded] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectText, setRejectText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const nextText = nextActionText(card);
  const needsClamp = nextText.length > CLAMP_THRESHOLD;
  const subtaskId = card.currentSubtaskId;

  const stop = (event: React.MouseEvent | React.KeyboardEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };

  const runVerdict = async (action: () => Promise<{ error: string | null }>) => {
    setActionError(null);
    const { error } = await action();
    if (error) setActionError(error);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen(card.id);
      }}
      className={`w-full cursor-pointer rounded-lg border p-3 text-left transition dark:bg-claude-darkSurface bg-claude-surface ${
        isWaitingOwner
          ? 'border-amber-500/40 hover:border-amber-400/70'
          : 'dark:border-claude-darkBorder border-claude-border hover:border-brand/60'
      } ${dimmed ? 'opacity-75 hover:opacity-100' : ''} ${card.column === 'defining' ? 'border-dashed' : ''}`}
    >
      <h3 className="text-[13px] font-semibold leading-snug dark:text-claude-darkText text-claude-text">{card.title}</h3>
      {card.participants.length > 0 && (
        <div className="mt-1.5">
          <ParticipantAvatars participants={card.participants} size="sm" />
        </div>
      )}
      <div className="mt-2 h-1.5 w-full rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
        <div className={`h-1.5 rounded-full ${COLUMN_BAR_CLASS[card.column]}`} style={{ width: `${card.progress.percent}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <span>
          {i18nService.t('longTermTask.progressCounts')
            .replace('{accepted}', String(card.progress.accepted))
            .replace('{active}', String(card.counts.in_progress + card.counts.waiting_owner + card.counts.waiting_external))
            .replace('{pending}', String(card.counts.pending))}
        </span>
        <span>{i18nService.t('longTermTask.progress').replace('{accepted}', String(card.progress.accepted)).replace('{total}', String(card.progress.total))}</span>
      </div>
      {card.currentSubtaskTitle && (
        <div className="mt-2 rounded-md px-2.5 py-1.5 dark:bg-claude-darkSurfaceHover/70 bg-claude-surfaceHover/70">
          <div className="text-xs dark:text-claude-darkText text-claude-text">
            {i18nService.t('longTermTask.currentPrefix').replace('{title}', card.currentSubtaskTitle)}
          </div>
          <div
            className={`mt-0.5 text-[11px] ${isWaitingOwner ? 'text-amber-600 dark:text-amber-400' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'} ${
              needsClamp && !expanded ? 'line-clamp-3' : ''
            }`}
          >
            {i18nService.t('longTermTask.nextPrefix').replace('{action}', nextText)}
          </div>
          {needsClamp && (
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                setExpanded((value) => !value);
              }}
              className="mt-0.5 text-[10px] text-sky-600 hover:underline dark:text-sky-400"
            >
              {expanded ? i18nService.t('longTermTask.collapse') : i18nService.t('longTermTask.expand')}
            </button>
          )}
        </div>
      )}
      {isWaitingOwner && subtaskId && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={(event) => {
              stop(event);
              void runVerdict(() => longTermTaskService.acceptSubtask(card.id, subtaskId));
            }}
            className="border border-emerald-600 rounded-md bg-emerald-600/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
          >
            {i18nService.t('longTermTask.action.accept')}
          </button>
          <button
            type="button"
            onClick={(event) => {
              stop(event);
              setRejectText('');
              setRejecting((value) => !value);
            }}
            className="rounded-md border border-red-500/40 px-2 py-1 text-[11px] text-red-500 hover:bg-red-500/10"
          >
            {i18nService.t('longTermTask.action.reject')}
          </button>
        </div>
      )}
      {rejecting && subtaskId && (
        <div className="mt-2 rounded-lg border border-red-500/30 p-2">
          <textarea
            value={rejectText}
            onChange={(event) => setRejectText(event.target.value)}
            onClick={stop}
            placeholder={i18nService.t('longTermTask.rejectPlaceholder')}
            className="w-full rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2 py-1.5 text-[11px] dark:text-claude-darkText text-claude-text"
            rows={2}
          />
          <div className="mt-1.5 flex gap-2">
            <button
              type="button"
              disabled={!rejectText.trim()}
              onClick={(event) => {
                stop(event);
                void runVerdict(() => longTermTaskService.rejectSubtask(card.id, subtaskId, rejectText.trim())).then(() => setRejecting(false));
              }}
              className="border border-red-600 rounded-md bg-red-500/90 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {i18nService.t('longTermTask.rejectConfirm')}
            </button>
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                setRejecting(false);
              }}
              className="rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              {i18nService.t('cancel')}
            </button>
          </div>
        </div>
      )}
      {actionError && <div className="mt-1 text-[10px] text-red-500">{actionError}</div>}
      <div className="mt-2 flex items-center justify-between text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        <span>{i18nService.t('longTermTask.updatedAt').replace('{time}', formatRelativeTime(card.updatedAt))}</span>
        <span>{i18nService.t('longTermTask.createdAt').replace('{time}', formatAbsDate(card.createdAt))}</span>
      </div>
    </div>
  );
};

export default LongTermTaskCard;
