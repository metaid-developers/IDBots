import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlassIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { ChatExperienceMode } from '../../config';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem, { SessionAvatarCircle } from '../../components/cowork/CoworkSessionItem';
import { isAssistantModeOwnerChatSession } from '../../components/cowork/assistantModeSessionGate';
import { bindSeatMenuOutsideDismiss } from '../botBrowser/seatMenuDismiss';
import {
  formatTwinWorkCount,
  formatTwinWorkTwinName,
  getTwinWorkCopy,
  normalizeTwinWorkLanguage,
  type TwinWorkCopy,
} from './i18n';
import {
  buildTwinWorkModel,
  type TwinWorkGroup,
  type TwinWorkMetabot,
} from './twinWorkModel';

/**
 * "Twin's work" — the strip that sits at the top of the Studio conversation
 * column (below the Studio | BotWorks segmented band, above the message list)
 * and carries the conversations of the currently seated Twin(s): title row,
 * search disclosure, new-conversation entry, and one group per Twin.
 *
 * Owner ruling 2026-11-09: the strip is a standalone component. The A line owns
 * the mount points (`Sidebar` / `BotBrowserCoworkPanel`); this file owns the
 * strip and touches no existing file — the local copy deck lives in ./i18n.ts
 * exactly so the global i18n table can merge it later, in one pass.
 *
 * Reuse, not re-implementation:
 *  - rows ARE the product's shared `CoworkSessionItem` (hover menu, rename,
 *    pin, archive, unread/running dot, A2A treatment) with the same four
 *    handlers the sidebar list passes;
 *  - group headers use the shared `SessionAvatarCircle` and the by-Bot list's
 *    header grammar (24 px avatar + name + trailing new-conversation `+`);
 *  - the Twin picker closes on an outside pointer through the same rule as the
 *    Twin seat menu (`bindSeatMenuOutsideDismiss`).
 *
 * The data contract is roster-driven: pass the live metabot list and the raw
 * `coworkSlice.sessions`; the model keeps only `metabot_type === 'twin'` rows.
 * Multiple Twins and seat changes therefore need no special handling.
 */

const ICON_BUTTON_CLASS =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:dark:text-claude-darkText hover:text-claude-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40';

const ICON_BUTTON_ACTIVE_CLASS =
  'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover text-claude-accent dark:text-claude-accent';

/** Rows stamp relative time from a shared clock so a memoized row can refresh. */
const RELATIVE_TIME_TICK_MS = 60_000;

const useMinuteNow = (): number => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return nowMs;
};

const twinDisplayName = (twin: TwinWorkMetabot): string =>
  twin.name?.trim() || `Bot ${twin.id}`;

// ---------------------------------------------------------------------------
// Hook-free sub-components (exported so their click paths are unit-tested
// directly — the repository's react test stack is SSR-only, see
// tests/twinSeatChip.test.tsx for the same pattern).
// ---------------------------------------------------------------------------

export interface TwinWorkSearchFieldProps {
  copy: TwinWorkCopy;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onClose: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  inputRef?: React.RefObject<HTMLInputElement>;
}

/** The strip's search disclosure: one quiet input line under the title row. */
export const TwinWorkSearchField: React.FC<TwinWorkSearchFieldProps> = ({
  copy,
  value,
  onChange,
  onClear,
  onClose,
  onKeyDown,
  inputRef,
}) => (
  <div data-slot="twin-work-search-field" className="flex items-center gap-1 px-2 pb-1.5">
    <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-claude-border bg-claude-bg px-2 py-1 dark:border-claude-darkBorder dark:bg-claude-darkBg">
      <MagnifyingGlassIcon
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary"
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={copy.searchPlaceholder}
        aria-label={copy.search}
        autoFocus
        className="min-w-0 flex-1 bg-transparent text-xs outline-none dark:text-claude-darkText text-claude-text placeholder:text-claude-textSecondary dark:placeholder:text-claude-darkTextSecondary"
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={copy.clearSearch}
          title={copy.clearSearch}
          className="shrink-0 rounded p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        >
          <XMarkIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
    <button
      type="button"
      onClick={onClose}
      aria-label={copy.closeSearch}
      title={copy.closeSearch}
      className={ICON_BUTTON_CLASS}
    >
      <XMarkIcon className="h-4 w-4" />
    </button>
  </div>
);

export interface TwinWorkNewSessionMenuRowProps {
  twin: TwinWorkMetabot;
  copy: TwinWorkCopy;
  onCreateSession: (twinMetabotId: number) => void;
}

/** One Twin row of the multiple-Twin new-conversation picker. */
export const TwinWorkNewSessionMenuRow: React.FC<TwinWorkNewSessionMenuRowProps> = ({
  twin,
  copy,
  onCreateSession,
}) => {
  const name = twinDisplayName(twin);
  const label = formatTwinWorkTwinName(copy, name);
  return (
    <button
      type="button"
      role="menuitem"
      data-slot="twin-work-new-menu-row"
      data-twin-id={twin.id}
      aria-label={label}
      title={label}
      onClick={() => onCreateSession(twin.id)}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:dark:text-claude-darkText hover:text-claude-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
    >
      <SessionAvatarCircle src={twin.avatar} name={name} sizeClass="h-5 w-5" />
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      {twin.role ? (
        <span className="max-w-[45%] min-w-0 truncate text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {twin.role}
        </span>
      ) : null}
    </button>
  );
};

export interface TwinWorkNewSessionControlProps {
  twins: readonly TwinWorkMetabot[];
  copy: TwinWorkCopy;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCreateSession: (twinMetabotId: number) => void;
}

/**
 * The strip's new-conversation entry. One Twin → one click, no menu. Several
 * Twins → the `+` opens a picker so the target Twin is explicit (the same
 * "appoint, don't guess" rule the Twin seat chip follows). No Twins → nothing.
 */
export const TwinWorkNewSessionControl: React.FC<TwinWorkNewSessionControlProps> = ({
  twins,
  copy,
  menuOpen,
  onToggleMenu,
  onCreateSession,
}) => {
  if (twins.length === 0) return null;

  if (twins.length === 1) {
    const twin = twins[0];
    const label = formatTwinWorkTwinName(copy, twinDisplayName(twin));
    return (
      <button
        type="button"
        data-slot="twin-work-new"
        data-twin-id={twin.id}
        aria-label={label}
        title={label}
        onClick={() => onCreateSession(twin.id)}
        className={ICON_BUTTON_CLASS}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        data-slot="twin-work-new"
        aria-label={copy.newSession}
        title={copy.newSession}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onToggleMenu}
        className={`${ICON_BUTTON_CLASS} ${menuOpen ? ICON_BUTTON_ACTIVE_CLASS : ''}`}
      >
        <PlusIcon className="h-4 w-4" />
      </button>
      {menuOpen ? (
        <div
          role="menu"
          data-slot="twin-work-new-menu"
          aria-label={copy.chooseTwin}
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-claude-border bg-claude-surface p-1 shadow-lg dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        >
          <p className="px-2 pb-1 pt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {copy.chooseTwin}
          </p>
          {twins.map((twin) => (
            <TwinWorkNewSessionMenuRow
              key={twin.id}
              twin={twin}
              copy={copy}
              onCreateSession={onCreateSession}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

export interface TwinWorkGroupHeaderProps {
  group: TwinWorkGroup;
  copy: TwinWorkCopy;
  onCreateSession: (twinMetabotId: number) => void;
}

/**
 * One Twin's group header. Same grammar as the by-Bot session list header
 * (24 px avatar + name, muted count, trailing `+` revealed on hover/focus),
 * minus the collapse control: a strip at the top of a conversation must not
 * hide the work it exists to show.
 */
export const TwinWorkGroupHeader: React.FC<TwinWorkGroupHeaderProps> = ({
  group,
  copy,
  onCreateSession,
}) => {
  const name = twinDisplayName(group.twin);
  const newLabel = formatTwinWorkTwinName(copy, name);
  return (
    <div
      data-slot="twin-work-group-header"
      data-twin-id={group.twin.id}
      className="group flex items-center gap-2 px-2.5 py-1.5"
    >
      <SessionAvatarCircle src={group.twin.avatar} name={name} sizeClass="h-6 w-6" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium dark:text-claude-darkText text-claude-text">
        {name}
      </span>
      <span
        data-slot="twin-work-group-count"
        className="shrink-0 text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={formatTwinWorkCount(copy, group.sessions.length)}
      >
        {group.sessions.length}
      </span>
      <button
        type="button"
        data-slot="twin-work-group-new"
        aria-label={newLabel}
        title={newLabel}
        onClick={() => onCreateSession(group.twin.id)}
        className="shrink-0 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 hover:bg-claude-accent/10"
      >
        <PlusIcon className="h-3.5 w-3.5 text-claude-accent dark:text-claude-accent" />
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The strip.
// ---------------------------------------------------------------------------

export interface TwinWorkPanelProps {
  /** Live metabot roster (any types; only `metabot_type === 'twin'` is used). */
  metabots: readonly TwinWorkMetabot[];
  /** Raw `coworkSlice.sessions` — the strip filters it by the Twin id set. */
  sessions: readonly CoworkSessionSummary[];
  currentSessionId?: string | null;
  /** Unread / approval session ids, forwarded to the shared rows. */
  unreadSessionIds?: readonly string[];
  approvalSessionIds?: readonly string[];
  /** The same four handlers the sidebar list passes to every session row. */
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /** Start a conversation with the Twin the owner picked. */
  onCreateSession: (twinMetabotId: number) => void;
  /** Global chat-experience mode; mirrors the shared row's title gate. */
  assistantMode?: boolean;
  /** Copy language; defaults to the app's current language. */
  language?: string;
  /** Initial state of the strip's own search disclosure (uncontrolled). */
  defaultSearchOpen?: boolean;
  defaultSearchQuery?: string;
  className?: string;
}

const TwinWorkPanelRow: React.FC<TwinWorkPanelProps> = ({
  metabots,
  sessions,
  currentSessionId = null,
  unreadSessionIds,
  approvalSessionIds,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  onCreateSession,
  assistantMode = false,
  language,
  defaultSearchOpen = false,
  defaultSearchQuery = '',
  className = '',
}) => {
  const resolvedLanguage = normalizeTwinWorkLanguage(language ?? i18nService.getLanguage());
  const copy = getTwinWorkCopy(resolvedLanguage);
  const nowMs = useMinuteNow();

  const [searchOpen, setSearchOpen] = useState(Boolean(defaultSearchOpen));
  const [query, setQuery] = useState(defaultSearchQuery);
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false);
  const newSessionControlRef = useRef<HTMLDivElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const model = useMemo(
    () => buildTwinWorkModel({ sessions, metabots, query }),
    [sessions, metabots, query],
  );

  const unreadSet = useMemo(() => new Set(unreadSessionIds ?? []), [unreadSessionIds]);
  const approvalSet = useMemo(() => new Set(approvalSessionIds ?? []), [approvalSessionIds]);
  const experienceMode: ChatExperienceMode = assistantMode ? 'assistant' : 'professional';

  // Same outside-pointer rule as the Twin seat chip: the menu closes when the
  // pointer lands anywhere outside the control container, but a click on a
  // Twin row is inside and still runs its own action.
  useEffect(() => {
    if (!newSessionMenuOpen) return undefined;
    return bindSeatMenuOutsideDismiss({
      container: () => newSessionControlRef.current,
      onDismiss: () => setNewSessionMenuOpen(false),
    });
  }, [newSessionMenuOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    // Closing the field must not leave an invisible filter running.
    setQuery('');
    // The input is about to unmount; hand focus back to its toggle so a
    // keyboard user does not land on <body>.
    searchToggleRef.current?.focus();
  };

  const handleSearchKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  };

  const countLabel = model.query
    ? `${model.matchedSessions}/${model.totalTwinSessions}`
    : String(model.totalTwinSessions);

  return (
    <section
      data-slot="twin-work-panel"
      aria-label={copy.title}
      className={`shrink-0 rounded-xl border border-claude-border/60 bg-claude-surface/50 dark:border-claude-darkBorder/60 dark:bg-claude-darkSurface/50 ${className}`.trim()}
    >
      {/* Title row: product name + count, then search and new-conversation. */}
      <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5">
        <h2
          data-slot="twin-work-title"
          className="min-w-0 truncate text-xs font-semibold dark:text-claude-darkText text-claude-text"
        >
          {copy.title}
        </h2>
        {model.totalTwinSessions > 0 ? (
          <span
            data-slot="twin-work-count"
            data-total={model.totalTwinSessions}
            data-matched={model.matchedSessions}
            className="shrink-0 text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
            title={formatTwinWorkCount(copy, model.totalTwinSessions)}
          >
            {countLabel}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            ref={searchToggleRef}
            type="button"
            data-slot="twin-work-search-toggle"
            aria-label={copy.search}
            title={copy.search}
            aria-expanded={searchOpen}
            onClick={() => {
              if (searchOpen) {
                closeSearch();
                return;
              }
              // The field mounts focused (`autoFocus`), so the disclosure is
              // ready to type into without a second click.
              setSearchOpen(true);
            }}
            className={`${ICON_BUTTON_CLASS} ${searchOpen ? ICON_BUTTON_ACTIVE_CLASS : ''}`}
          >
            <MagnifyingGlassIcon className="h-4 w-4" />
          </button>
          <div
            ref={newSessionControlRef}
            onKeyDown={(event) => {
              // Escape closes the Twin picker, same as the seat menu's family.
              if (event.key === 'Escape' && newSessionMenuOpen) {
                event.stopPropagation();
                setNewSessionMenuOpen(false);
              }
            }}
          >
            <TwinWorkNewSessionControl
              twins={model.twins}
              copy={copy}
              menuOpen={newSessionMenuOpen}
              onToggleMenu={() => setNewSessionMenuOpen((value) => !value)}
              onCreateSession={(twinMetabotId) => {
                setNewSessionMenuOpen(false);
                onCreateSession(twinMetabotId);
              }}
            />
          </div>
        </div>
      </div>

      {searchOpen ? (
        <TwinWorkSearchField
          copy={copy}
          value={query}
          onChange={setQuery}
          onClear={() => {
            setQuery('');
            searchInputRef.current?.focus();
          }}
          onClose={closeSearch}
          onKeyDown={handleSearchKeyDown}
          inputRef={searchInputRef}
        />
      ) : null}

      {model.totalTwinSessions === 0 ? (
        // Exact one-line empty state fixed by the hand-off (zh wording).
        <p
          data-slot="twin-work-empty"
          className="px-2.5 pb-2 pt-0.5 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary"
        >
          {copy.empty}
        </p>
      ) : model.groups.length === 0 ? (
        <p
          data-slot="twin-work-no-results"
          className="px-2.5 pb-2 pt-0.5 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary"
        >
          {copy.noResults}
        </p>
      ) : (
        <div
          data-slot="twin-work-list"
          className="max-h-64 overflow-y-auto overflow-x-hidden px-1.5 pb-1.5"
        >
          {model.groups.map((group) => (
            <section
              key={group.twin.id}
              data-slot="twin-work-group"
              data-twin-id={group.twin.id}
            >
              <TwinWorkGroupHeader
                group={group}
                copy={copy}
                onCreateSession={onCreateSession}
              />
              {group.sessions.map((session) => (
                <div
                  key={session.id}
                  data-slot="twin-work-row"
                  data-session-id={session.id}
                >
                  <CoworkSessionItem
                    session={session}
                    hasUnread={unreadSet.has(session.id)}
                    approvalPending={approvalSet.has(session.id)}
                    isActive={currentSessionId === session.id}
                    nowMs={nowMs}
                    language={resolvedLanguage}
                    assistantMode={isAssistantModeOwnerChatSession(experienceMode, session)}
                    onSelect={onSelectSession}
                    onDelete={onDeleteSession}
                    onTogglePin={onTogglePin}
                    onRename={onRenameSession}
                  />
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  );
};

/**
 * Memoized like the sidebar list: Studio re-renders on stream deltas, and the
 * strip only has to repaint when its own inputs (roster, sessions, selection,
 * language) change.
 */
const TwinWorkPanel = React.memo(TwinWorkPanelRow);

export default TwinWorkPanel;
