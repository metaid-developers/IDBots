import React, { useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { calendarCells, initialMonthView, monthOptionLabel, weekdayHeaderKeys, yearOptions } from '../../features/botBrowser/panelHistoryDateFilter';

/**
 * OWNER 03:40: shared mini month calendar (the Studio CoworkHistoryPanel
 * pattern) — Monday-first grid, year/month selects, days carrying records
 * show an accent dot, the picked day fills accent. Reused by the dream
 * diary index and the force-dream date chip so every calendar in Settings
 * speaks one design language.
 */
export interface MiniMonthCalendarProps {
  markedDayKeys: Set<string>;
  selectedDayKey: string | null;
  onPick: (dayKey: string) => void;
}

const MiniMonthCalendar: React.FC<MiniMonthCalendarProps> = ({ markedDayKeys, selectedDayKey, onPick }) => {
  // The helpers read {updatedAt} stamps — feed the marked days as pseudo
  // sessions so the initial view lands on the most recent marked night.
  const pseudoSessions = useMemo(
    () => Array.from(markedDayKeys).map((key) => ({ updatedAt: new Date(`${key}T23:59:59`).getTime() })),
    [markedDayKeys],
  );
  const [monthView, setMonthView] = useState(() => initialMonthView(pseudoSessions));
  const cells = useMemo(() => calendarCells(monthView.year, monthView.month), [monthView]);
  const years = useMemo(() => yearOptions(pseudoSessions, monthView), [pseudoSessions, monthView]);
  const language = i18nService.getLanguage();
  const selectClass = 'rounded-[var(--shape-radius-sm)] border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text px-1.5 py-0.5 text-[11px]';
  return (
    <div className="w-56">
      <div className="flex items-center gap-1.5 px-1">
        <select
          className={selectClass}
          value={monthView.year}
          onChange={(event) => setMonthView((view) => ({ ...view, year: Number(event.target.value) }))}
          aria-label="year"
        >
          {years.map((year) => (
            <option key={year} value={year}>{year}</option>
          ))}
        </select>
        <select
          className={selectClass}
          value={monthView.month}
          onChange={(event) => setMonthView((view) => ({ ...view, month: Number(event.target.value) }))}
          aria-label="month"
        >
          {Array.from({ length: 12 }, (_, month) => (
            <option key={month} value={month}>{monthOptionLabel(month, language)}</option>
          ))}
        </select>
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
          const hasMark = markedDayKeys.has(cell.key);
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onPick(cell.key)}
              className={`flex h-7 flex-col items-center justify-center gap-0.5 rounded-md text-[10px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                isSelected
                  ? 'bg-claude-accent text-claude-accentInk'
                  : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              <span>{cell.day}</span>
              <span
                aria-hidden
                className={`h-1 w-1 rounded-full ${isSelected ? 'bg-claude-accentInk' : hasMark ? 'bg-claude-accent' : 'bg-transparent'}`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default MiniMonthCalendar;
