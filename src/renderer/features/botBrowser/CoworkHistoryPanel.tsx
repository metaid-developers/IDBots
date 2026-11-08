import React from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import {
  SessionAvatarCircle,
  formatRelativeTime,
} from '../../components/cowork/CoworkSessionItem';
import {
  getAssistantSessionDisplayTitle,
  getCoworkSessionTitleClassName,
} from '../../components/cowork/coworkSessionPresentation.js';

interface CoworkHistoryPanelProps {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Session records of the BotHub conversation window, restyled to the ORIGINAL
 * IDBots sidebar grammar (owner spec 2026-11-08 21:31; baseline commit
 * 91e2cfd43 `components/Sidebar.tsx` + `CoworkSessionItem`):
 *
 * - the block opens with the baseline's quiet 12 px section label, not a
 *   dialog title; the count sits beside it as a muted number;
 * - rows keep the baseline row density (`px-2.5 py-1.5 rounded-lg`), the
 *   24 px session avatar, the title class from `coworkSessionPresentation`,
 *   and the two-line reading (title / time · type · page context);
 * - the row's action is revealed on hover AND keyboard focus (the same
 *   third state the main list uses), never a permanently lit control.
 *
 * Behaviour is the panel's existing one: select a row to load that session,
 * the trash icon archives it. No new palette, no new spacing system.
 */
const CoworkHistoryPanel: React.FC<CoworkHistoryPanelProps> = ({
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onClose,
}) => {
  return (
    <div
      data-slot="cowork-history-panel"
      className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted shadow-lg"
    >
      {/* Baseline section header: label left, count + close right. */}
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
          // Same empty-state grammar as the baseline list: centred, one quiet
          // sentence at the list's own text size.
          <div className="py-8 text-center">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkNoSessions')}
            </p>
          </div>
        ) : (
          sessions.map((session) => {
            const active = currentSessionId === session.id;
            const relativeTime = formatRelativeTime(session.updatedAt);
            const displayTitle = getAssistantSessionDisplayTitle(
              session.title,
              Boolean(session.assistantMode),
            ) || i18nService.t('coworkNewSession');
            const context = session.browserTitle || session.browserUri || '';
            return (
              <div
                key={session.id}
                data-slot="cowork-history-row"
                data-session-id={session.id}
                onClick={() => void onSelectSession(session.id)}
                className={`group relative cursor-pointer rounded-lg px-2.5 py-1.5 transition-colors duration-150 ${
                  active
                    ? 'bg-black/[0.06] dark:bg-white/[0.08]'
                    : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                }`}
              >
                <div className="flex items-start leading-tight">
                  <SessionAvatarCircle
                    src={session.metabotAvatar}
                    name={session.metabotName || displayTitle}
                    className="mr-2"
                  />
                  <div className="min-w-0 flex-1">
                    <h3
                      className={getCoworkSessionTitleClassName({
                        sessionType: session.sessionType,
                        serviceOrderStatus: session.serviceOrderSummary?.status,
                      })}
                    >
                      {displayTitle}
                    </h3>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs leading-tight dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      <span className="whitespace-nowrap" title={relativeTime.full}>
                        {relativeTime.compact}
                      </span>
                      <span
                        className="shrink-0 rounded bg-claude-accent/10 px-1 py-px text-[9px] font-medium uppercase leading-none tracking-wider text-claude-accent"
                        title={i18nService.t('coworkSessionTypeBrowser')}
                      >
                        {i18nService.t('coworkSessionTypeBrowser')}
                      </span>
                      {context ? (
                        <span className="min-w-0 truncate" title={context}>
                          {context}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onDeleteSession(session.id);
                  }}
                  className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-claude-surfaceMuted text-claude-textSecondary opacity-0 transition-opacity hover:bg-claude-surfaceHover hover:text-red-500 group-focus-within:opacity-100 group-hover:opacity-100 dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('delete')}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="h-3.5 w-3.5"
                  >
                    <path d="M4 7h16" />
                    <path d="M10 4h4" />
                    <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default CoworkHistoryPanel;
