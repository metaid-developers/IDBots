import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { Squares2X2Icon } from '@heroicons/react/24/outline';

interface LongTermTaskOriginHit {
  taskId: string;
  taskTitle: string;
  subtaskId: string | null;
  subtaskTitle: string | null;
}

/**
 * Session-side "part of long-term task" chip (redesign): a session bound to a
 * sub-project (or a task's definition session, or one a sub-project was bound
 * to before a rotation/rebind) shows where it belongs.
 * Data: `longtermTask:forSession` (read-only). No hit → renders nothing —
 * belonging is a fact, never a guess. Click dispatches `longtermTask:viewTask`
 * which App.tsx routes to the tracking page with the task open.
 */
const LongTermTaskOriginChip: React.FC<{
  sessionId: string | null | undefined;
  /**
   * 'chip' (default) = the session header's badge.
   * 'text' = the process detail header's plain pointer (design: 纯文本指针,
   * no fill, no border, ≤220, underline only on hover). Same fetch, one look
   * per surface — no second IPC path.
   */
  variant?: 'chip' | 'text';
}> = ({ sessionId, variant = 'chip' }) => {
  const [hit, setHit] = useState<LongTermTaskOriginHit | null>(null);

  useEffect(() => {
    let cancelled = false;
    const api = window.electron?.longtermTask;
    if (!sessionId || !api?.forSession) {
      setHit(null);
      return () => {
        cancelled = true;
      };
    }
    void api
      .forSession({ sessionId })
      .then((result) => {
        if (cancelled) return;
        setHit(result?.success && result.hit ? result.hit : null);
      })
      .catch(() => {
        if (!cancelled) setHit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!hit) return null;

  if (variant === 'text') {
    return (
      <button
        type="button"
        data-testid="process-detail-task"
        onClick={() => window.dispatchEvent(new CustomEvent('longtermTask:viewTask', { detail: { taskId: hit.taskId } }))}
        title={i18nService.t('longTermTask.origin.open')}
        className="non-draggable inline-flex min-w-0 max-w-[220px] items-center gap-1 text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:underline"
      >
        <Squares2X2Icon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">
          {i18nService.t('longTermTask.origin.label')} · {hit.taskTitle}
          {hit.subtaskTitle ? ` · ${hit.subtaskTitle}` : ''}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('longtermTask:viewTask', { detail: { taskId: hit.taskId } }))}
      title={i18nService.t('longTermTask.origin.open')}
      className="non-draggable inline-flex shrink-0 items-center gap-1 rounded-[var(--shape-radius-md)] border border-claude-accent/40 bg-claude-accent/10 px-2 py-0.5 text-[10px] font-semibold transition-colors hover:border-claude-accent/70 dark:text-claude-darkText text-claude-text"
    >
      <Squares2X2Icon className="h-3 w-3" />
      {i18nService.t('longTermTask.origin.label')}
      <span className="max-w-[180px] truncate opacity-80">{hit.taskTitle}</span>
      {hit.subtaskTitle && <span className="max-w-[140px] truncate font-mono opacity-60">· {hit.subtaskTitle}</span>}
    </button>
  );
};

export default LongTermTaskOriginChip;
