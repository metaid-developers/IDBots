import React, { useState, useRef, useLayoutEffect, useCallback, useEffect, useMemo } from 'react';
import { FaceSmileIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { placePopoverAbove, useAnchorMoveWatcher } from '../../utils/anchoredPopover';
import { i18nService } from '../../services/i18n';
import {
  EMOJI_CATEGORIES,
  searchEmoji,
  type EmojiEntry,
} from './emojiData';
import { TwemojiGlyph } from './TwemojiText';

/**
 * Chat emoji picker: a toolbar trigger + a popover panel with a search box,
 * a "recent emojis" strip, and one flat WeChat-style Unicode emoji grid
 * (single page, no category tabs — owner call 2026-10-29). Catalog emoji
 * render as bundled Twemoji artwork (Twemoji 14.0.2, CC-BY 4.0 — see
 * twemoji.ts / LICENSES/twemoji-NOTICE.md); picks still insert the plain
 * Unicode codepoint, so storage and protocol stay untouched.
 *
 * Placement follows the composer's '+' menu: the panel floats with
 * position:fixed ABOVE the trigger (chat composers sit at the bottom of the
 * window) so it escapes overflow-hidden ancestors, and it re-places when the
 * anchor moves without window events (sidebar drag, textarea auto-grow).
 *
 * The panel intentionally STAYS OPEN after a pick (chat muscle memory:
 * several emoji in a row); Escape, outside click, or the trigger closes it.
 */

const EMOJI_PANEL_WIDTH = 344;
const EMOJI_PANEL_HEIGHT = 288;

/**
 * Recent emojis, persisted to window.localStorage so the Recent row
 * survives app restarts (recents capture user habit). Renderer-local
 * only — nothing goes to disk stores, the chain, or any protocol write.
 * Same LRU order and 16-entry cap as before; malformed storage falls
 * back to an empty list.
 */
const RECENT_LIMIT = 16;
const EMOJI_RECENTS_STORAGE_KEY = 'idbots.chat.emojiRecents.v1';

type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;

const recentChars: string[] = [];

const dedupeRecentChars = (chars: string[]): string[] => [...new Set(chars)];

/**
 * Parse the persisted recents JSON. Defensive against any malformed shape
 * (bad JSON, non-array, non-string entries); keeps first occurrence, which
 * is the most-recent one because the list is stored MRU-first.
 */
export const parsePersistedRecentChars = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return dedupeRecentChars(parsed.filter((c): c is string => typeof c === 'string' && c.length > 0)).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
};

/**
 * Replace the in-memory recents from storage — exactly what module init
 * (= app boot) runs on every launch. Exported so tests can simulate a
 * restart against a storage stub.
 */
export const restoreRecentChars = (storage: RecentStorage | null): string[] => {
  let persisted: string[] = [];
  if (storage) {
    try {
      persisted = parsePersistedRecentChars(storage.getItem(EMOJI_RECENTS_STORAGE_KEY));
    } catch {
      persisted = [];
    }
  }
  recentChars.length = 0;
  recentChars.push(...persisted);
  return recentChars;
};

/** Current recents, most-recently-used first (test/inspection helper). */
export const recentEmojiChars = (): readonly string[] => recentChars;

/** Write the current recents; a failed write keeps session-memory behavior. */
const persistRecentChars = (): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(EMOJI_RECENTS_STORAGE_KEY, JSON.stringify(recentChars));
  } catch {
    // localStorage unavailable (privacy mode/quota): recents stay in memory.
  }
};

/** Record a pick as most-recently-used (dedupe, MRU-first, cap 16) and persist. */
export const rememberRecent = (char: string): void => {
  const next = [char, ...recentChars.filter((c) => c !== char)];
  recentChars.length = 0;
  recentChars.push(...next.slice(0, RECENT_LIMIT));
  persistRecentChars();
};

// App-boot hydration: a fresh renderer restores the persisted list (LRU
// order intact) before the first render. Without a window (SSR tests)
// this is a no-op and recents start empty.
restoreRecentChars(
  typeof window === 'undefined' ? null : window.localStorage,
);

export interface EmojiPickerPanelProps {
  /** Rendered inside the popover shell; shared by the recents-strip and search views. */
  onSelect: (emoji: string) => void;
}

const EmojiGrid: React.FC<{
  emojis: EmojiEntry[];
  'aria-label'?: string;
  onSelect: (emoji: string) => void;
}> = ({ emojis, 'aria-label': ariaLabel, onSelect }) => (
  <div
    role="listbox"
    aria-label={ariaLabel}
    className="grid grid-cols-7 gap-0.5 p-1 overflow-y-auto flex-1 min-h-0"
  >
    {emojis.map((emoji) => (
      <button
        key={emoji.char}
        type="button"
        role="option"
        aria-label={emoji.char}
        title={emoji.keywords}
        onClick={() => onSelect(emoji.char)}
        className="h-[38px] w-[38px] flex items-center justify-center rounded-lg text-[26px] leading-none transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover focus:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
      >
        {/* Twemoji <img> (alt = codepoint); non-catalog chars fall back to the font glyph. */}
        <TwemojiGlyph char={emoji.char} px={26} />
      </button>
    ))}
  </div>
);

const EmojiPickerPanel: React.FC<EmojiPickerPanelProps> = ({ onSelect }) => {
  const [query, setQuery] = useState('');
  // Recents live in module state; a pick must surface in the strip on the
  // same render, so handleSelect bumps this counter after rememberRecent.
  const [recentsTick, setRecentsTick] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSelect = useCallback((emoji: string) => {
    rememberRecent(emoji);
    setRecentsTick((tick) => tick + 1);
    onSelect(emoji);
  }, [onSelect]);

  // Autofocus the search box when the panel opens.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const results = useMemo(() => searchEmoji(query), [query]);
  const searching = query.trim().length > 0;

  const recents = useMemo<EmojiEntry[]>(
    () => recentEmojiChars().map((char) => ({ char, keywords: '' })),
    [recentsTick],
  );

  // One flat page (single category): the whole catalog in WeChat code-table
  // order. flatMap keeps this correct even if categories are ever re-added.
  const catalogEmojis = useMemo(
    () => EMOJI_CATEGORIES.flatMap((category) => category.emojis),
    [],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Search row */}
      <div className="px-2 pt-2 pb-1">
        <div className="flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2 py-1">
          <MagnifyingGlassIcon className="h-3.5 w-3.5 flex-shrink-0 opacity-60" />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                // Clear the query first; a second Escape closes the panel
                // (the panel-level handler only fires when not swallowed).
                if (query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }
            }}
            placeholder={i18nService.t('emojiPickerSearchPlaceholder')}
            className="w-full bg-transparent text-xs dark:text-claude-darkText text-claude-text placeholder:opacity-50 focus:outline-none"
            aria-label={i18nService.t('emojiPickerSearchPlaceholder')}
          />
        </div>
      </div>
      {/* Recent strip — WeChat style, embedded ABOVE the main grid inside the
          single emoji panel (no Recent tab). Hidden while searching and when
          empty (fresh install: nothing used yet). */}
      {!searching && recents.length > 0 && (
        <div className="px-2 pb-1 flex-shrink-0">
          <div
            className="px-1 pb-0.5 text-[10px] font-medium tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary"
          >
            {i18nService.t('emojiCategoryRecent')}
          </div>
          <div className="flex flex-wrap gap-0.5" role="listbox" aria-label={i18nService.t('emojiCategoryRecent')}>
            {recents.map((emoji) => (
              <button
                key={emoji.char}
                type="button"
                role="option"
                aria-label={emoji.char}
                onClick={() => handleSelect(emoji.char)}
                className="h-[33px] w-[33px] flex items-center justify-center rounded-lg text-[22px] leading-none transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover focus:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
              >
                <TwemojiGlyph char={emoji.char} px={22} />
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Main grid — the single emoji page */}
      {searching ? (
        results.length > 0 ? (
          <EmojiGrid emojis={results} onSelect={handleSelect} aria-label={i18nService.t('composerEmojiTitle')} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4 pb-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('emojiPickerNoResults')}
          </div>
        )
      ) : (
        <EmojiGrid emojis={catalogEmojis} onSelect={handleSelect} aria-label={i18nService.t('composerEmojiTitle')} />
      )}
    </div>
  );
};

export interface EmojiMenuButtonProps {
  open: boolean;
  buttonRef: React.RefObject<HTMLButtonElement>;
  /** Follows the textarea's own gate (disabled composer = disabled picker). */
  disabled?: boolean;
  /**
   * false = panel-only mount: no trigger button. The panel is opened by a
   * sibling control (the Cowork composer's '+' menu) and still anchors to
   * `buttonRef` (that '+' button). With no trigger left, `onToggle` is
   * reached only through the dismissal paths (outside click / Escape), so
   * such callers pass a close callback. Default true keeps the standalone
   * trigger + panel contract.
   */
  showTrigger?: boolean;
  onToggle: () => void;
  /** Insert the picked emoji at the composer caret. */
  onPick: (emoji: string) => void;
}

/**
 * The emoji trigger + popover. Self-contained (no redux, no store) so any
 * composer can mount it next to its other toolbar buttons, and so tests can
 * render it standalone. `showTrigger={false}` renders only the popover, for
 * composers that open it from another control.
 */
const EmojiMenuButton: React.FC<EmojiMenuButtonProps> = ({
  open,
  buttonRef,
  disabled = false,
  showTrigger = true,
  onToggle,
  onPick,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | null>(null);

  const updatePanelPlacement = useCallback(() => {
    const anchorRect = buttonRef.current?.getBoundingClientRect() ?? null;
    const placement = placePopoverAbove(anchorRect, { width: EMOJI_PANEL_WIDTH, height: EMOJI_PANEL_HEIGHT }, EMOJI_PANEL_WIDTH);
    setPanelStyle({ position: 'fixed', top: placement.top, left: placement.left, width: placement.width, height: EMOJI_PANEL_HEIGHT });
  }, [buttonRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }
    updatePanelPlacement();
    window.addEventListener('resize', updatePanelPlacement);
    window.addEventListener('scroll', updatePanelPlacement, true);
    return () => {
      window.removeEventListener('resize', updatePanelPlacement);
      window.removeEventListener('scroll', updatePanelPlacement, true);
    };
  }, [open, updatePanelPlacement]);

  useAnchorMoveWatcher(buttonRef, open, updatePanelPlacement);

  // Outside click / Escape close (same dismissal pattern as the skills and
  // folder popovers).
  useEffect(() => {
    if (!open) return;
    const handleMouseDownOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !panelRef.current?.contains(target)
        && !buttonRef.current?.contains(target)
      ) {
        onToggle();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle();
    };
    document.addEventListener('mousedown', handleMouseDownOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDownOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onToggle, buttonRef]);

  const panel = open ? (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={i18nService.t('composerEmojiTitle')}
      className="fixed z-50 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-lg overflow-hidden flex flex-col"
      style={panelStyle ?? { visibility: 'hidden' }}
    >
      <EmojiPickerPanel onSelect={onPick} />
    </div>
  ) : null;

  // Panel-only mount: the opening control lives elsewhere, so there is no
  // trigger to render (and no trigger DOM to steal toolbar width).
  if (!showTrigger) return panel;

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center justify-center p-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:dark:hover:bg-transparent"
        title={i18nService.t('composerEmojiTitle')}
        aria-label={i18nService.t('composerEmojiTitle')}
      >
        <FaceSmileIcon className="h-4 w-4" />
      </button>
      {panel}
    </div>
  );
};

export default EmojiMenuButton;
