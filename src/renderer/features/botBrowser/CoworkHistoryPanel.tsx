import React, { useMemo, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem from '../../components/cowork/CoworkSessionItem';
import BotPickerChip, { type BotPickerChipBot } from './BotPickerChip';
import {
  activeDayKeysOfMonth,
  calendarCells,
  filterSessionsByDay,
  initialMonthView,
  monthOptionLabel,
  weekdayHeaderKeys,
  yearOptions,
} from './panelHistoryDateFilter';

interface CoworkHistoryPanelProps {
  sessions: CoworkSessionSummary[];
  bot: BotPickerChipBot | null;
  bots: readonly BotPickerChipBot[];
  onSelectBot: (bot: BotPickerChipBot) => void;
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void | Promise<void>;
  onDeleteSession: (sessionId: string) => void | Promise<void>;
  onTogglePin: (sessionId: string, pinned: boolean) => void | Promise<void>;
  onRenameSession: (sessionId: string, title: string) => void | Promise<void>;
  onClose: () => void;
}

/** Studio session records with independent bot and date filters. */
const CoworkHistoryPanel: React.FC<CoworkHistoryPanelProps> = ({
  sessions,
  bot,
  bots,
  onSelectBot,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onClose,
}) => {
  const [showBotMenu, setShowBotMenu] = useState(false);
  const botId = bot?.id ?? null;
  const botSessions = useMemo(
    () => (botId != null ? sessions.filter((session) => session.metabotId === botId) : []),
    [sessions, botId],
  );

  // Inline date filter (item ③). The view opens on the scoped list's newest
  // month (today when the bot has no sessions yet); picking days is
  // user-driven afterwards. The overlay covers the bot picker while open, so
  // this state never has to survive a bot switch — remount handles it.
  const [monthView, setMonthView] = useState(() => initialMonthView(botSessions));
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  const language = i18nService.getLanguage();
  const cells = useMemo(() => calendarCells(monthView.year, monthView.month), [monthView]);
  const years = useMemo(
    () => yearOptions(botSessions, monthView),
    [botSessions, monthView],
  );
  const activeDayKeys = useMemo(
    () => activeDayKeysOfMonth(botSessions, monthView.year, monthView.month),
    [botSessions, monthView],
  );

  // Picking a day filters immediately (no confirm step — the reference form's
  // 取消/确定 live in popups; this block is inline). The clear affordance
  // releases the filter; year/month alone never narrow the list.
  const visibleSessions = useMemo(
    () => filterSessionsByDay(botSessions, selectedDayKey),
    [botSessions, selectedDayKey],
  );
  const orderedSessions = [...visibleSessions].sort(
    (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)),
  );

  const selectClass =
    'rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-1.5 py-0.5 text-[11px] dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/40';

  return (
    <div
      data-slot="cowork-history-panel"
      className="absolute inset-0 z-10 flex flex-col overflow-hidden rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted shadow-lg"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 pt-2.5">
        <span className="shrink-0 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('botBrowserCoworkHistory')}
        </span>
        {bot ? (
          <div data-slot="cowork-history-bot-filter" className="min-w-0 flex-1">
            <BotPickerChip
              chipMetabot={bot}
              roster={bots}
              menuOpen={showBotMenu}
              onToggleMenu={() => setShowBotMenu((open) => !open)}
              onDismissMenu={() => setShowBotMenu(false)}
              onSelect={(nextBot) => {
                onSelectBot(nextBot);
                setShowBotMenu(false);
              }}
              menuDirection="down"
              size="compact"
              ariaLabel={i18nService.t('botBrowserHistoryBotFilter')}
              menuHint={i18nService.t('botBrowserHistoryBotFilterHint')}
            />
          </div>
        ) : <div className="min-w-0 flex-1" />}
        <div className="flex shrink-0 items-center gap-1.5">
          {visibleSessions.length > 0 ? (
            <span className="text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {visibleSessions.length}
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
      {/* Inline "browse by date" (item ③): one caption row with the two
          dropdowns and the clear affordance, then the Monday-first grid.
          Days holding scoped sessions carry a light accent dot; the picked
          day fills with the accent. Out-of-month slots are muted and inert. */}
      <div data-slot="cowork-history-date-filter" className="shrink-0 px-3 pb-2">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('botBrowserHistoryDateFilter')}
          </span>
          <select
            className={selectClass}
            value={monthView.year}
            onChange={(event) => setMonthView((view) => ({ ...view, year: Number(event.target.value) }))}
            aria-label={`${i18nService.t('botBrowserHistoryDateFilter')} · ${monthView.year}`}
          >
            {years.map((year) => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
          <select
            className={selectClass}
            value={monthView.month}
            onChange={(event) => setMonthView((view) => ({ ...view, month: Number(event.target.value) }))}
            aria-label={`${i18nService.t('botBrowserHistoryDateFilter')} · ${monthOptionLabel(monthView.month, language)}`}
          >
            {Array.from({ length: 12 }, (_, month) => (
              <option key={month} value={month}>{monthOptionLabel(month, language)}</option>
            ))}
          </select>
          {selectedDayKey ? (
            <button
              type="button"
              onClick={() => setSelectedDayKey(null)}
              className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
            >
              {i18nService.t('clear')}
            </button>
          ) : null}
        </div>
        <div className="mt-1.5 grid grid-cols-7 gap-y-0.5">
          {weekdayHeaderKeys.map((key) => (
            <span
              key={key}
              className="text-center text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              {i18nService.t(key)}
            </span>
          ))}
          {cells.map((cell) => {
            if (!cell.inMonth) {
              return (
                <span
                  key={cell.key}
                  className="flex h-7 flex-col items-center justify-center text-[10px] leading-none opacity-30 dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  {cell.day}
                </span>
              );
            }
            const isSelected = cell.key === selectedDayKey;
            const hasSessions = activeDayKeys.has(cell.key);
            return (
              <button
                key={cell.key}
                type="button"
                data-slot="cowork-history-day-cell"
                data-day-key={cell.key}
                aria-pressed={isSelected}
                onClick={() => setSelectedDayKey((current) => (current === cell.key ? null : cell.key))}
                className={`flex h-7 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                  isSelected
                    ? 'bg-claude-accent text-claude-accentInk'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span>{cell.day}</span>
                <span
                  aria-hidden
                  className={`h-1 w-1 rounded-full ${isSelected ? 'bg-claude-accentInk' : hasSessions ? 'bg-claude-accent' : 'bg-transparent'}`}
                />
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2">
        {visibleSessions.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t(botSessions.length === 0 ? 'coworkNoSessions' : 'botBrowserHistoryDateEmpty')}
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
