import React from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from '../../components/cowork/CoworkSessionItem';

interface CoworkHistoryPanelProps {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onTogglePin: (sessionId: string, pinned: boolean) => void | Promise<void>;
  onRenameSession: (sessionId: string, title: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Session records of the BotHub conversation window, restyled to the ORIGINAL
 * IDBots sidebar grammar (owner spec 2026-11-08 21:31; baseline commit
 * 91e2cfd43 `components/Sidebar.tsx` + `CoworkSessionItem`):
 *
 * - the block opens with the baseline's quiet 12 px section label, not a
 *   dialog title; the count sits beside it as a muted number;
 * - rows use the shared BotWorks session item, including its ellipsis menu,
 *   inline rename, pin toggle, copy action, and reversible archive;
 * - browser page context stays in the second line instead of the task status.
 */
const CoworkHistoryPanel: React.FC<CoworkHistoryPanelProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onClose,
}) => {
  const orderedSessions = [...sessions].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)),
  );

  return (
    <div
      data-slot="cowork-history-panel"
      className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted shadow-lg"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1.5 pt-2.5">
        <span className="min-w-0 truncate text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('botBrowserCoworkHistory')}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {sessions.length > 0 ? (
            <span className="text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {sessions.length}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:dark:text-claude-darkText hover:text-claude-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
        {sessions.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkNoSessions')}
            </p>
          </div>
        ) : (
          orderedSessions.map((session) => (
            <div
              key={session.id}
              data-slot="cowork-history-row"
              data-session-id={session.id}
            >
              <CoworkSessionItem
                session={session}
                hasUnread={false}
                isActive={currentSessionId === session.id}
                assistantMode={Boolean(session.assistantMode)}
                showBrowserContext
                onSelect={onSelectSession}
                onDelete={onDeleteSession}
                onTogglePin={onTogglePin}
                onRename={onRenameSession}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default CoworkHistoryPanel;
