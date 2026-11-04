import { useMemo, useState } from 'react';
import { MagnifyingGlassIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import { EMOJI_CATEGORIES, searchEmoji } from '../chat/emojiData';
import { TwemojiGlyph } from '@/components/chat/TwemojiText';

/**
 * Chat emoji picker panel (mobile). A touch-first, WeChat-style inline
 * panel that renders ABOVE the composer inside its container (no backdrop,
 * the message list stays visible/scrollable while picking). The catalog
 * lives in app/chat/emojiData.ts (standard Unicode codepoints — picks
 * still insert the plain char); catalog cells render as bundled Twemoji
 * artwork (Twemoji 14.0.2, CC-BY 4.0 — see renderer chat/twemoji.ts and
 * LICENSES/twemoji-NOTICE.md), with a raw-glyph fallback for any char
 * without a bundled asset.
 *
 * Interaction contract (mobile-native, zero hover assumptions):
 * - every touch target is at least 36px tall (grid cells 44px);
 * - the panel STAYS OPEN after a pick (chat muscle memory: several emoji
 *   in a row); the ✕ button, or tapping the composer's textarea (handled
 *   by ChatScreen), closes it;
 * - ONE flat emoji page (owner call 2026-10-29: no category tabs): a
 *   "recent emojis" strip embedded ABOVE the main grid, like WeChat's own
 *   first panel, then the whole 85-entry catalog in one grid;
 * - search swaps the grid for results and shows a t()-localized empty
 *   state.
 *
 * Recents persist to window.localStorage (local-only user habit; same
 * policy as the desktop picker — this mobile app is a Vite/React-DOM web
 * build, so localStorage IS the platform persistence API) — nothing goes
 * to the chain or any protocol write, and malformed storage falls back to
 * an empty list.
 */

const RECENT_LIMIT = 16;
const EMOJI_RECENTS_STORAGE_KEY = 'idbots.mobile.chat.emojiRecents.v1';

type RecentStorage = Pick<Storage, 'getItem' | 'setItem'>;

const recentChars: string[] = [];

const dedupeRecentChars = (chars: string[]): string[] => [...new Set(chars)];

/**
 * Parse the persisted recents JSON. Defensive against malformed shapes
 * (bad JSON, non-array, non-string entries); keeps first occurrence =
 * most-recent one because the list is stored MRU-first.
 */
export const parsePersistedRecentEmoji = (raw: string | null): string[] => {
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
 * Replace in-memory recents from storage. Runs at module init (= app
 * boot); exported so tests can simulate a restart with a storage stub.
 */
export const restoreRecentEmojiFromStorage = (storage: RecentStorage | null): string[] => {
  let persisted: string[] = [];
  if (storage) {
    try {
      persisted = parsePersistedRecentEmoji(storage.getItem(EMOJI_RECENTS_STORAGE_KEY));
    } catch {
      persisted = [];
    }
  }
  recentChars.length = 0;
  recentChars.push(...persisted);
  return recentChars;
};

/** Write the current recents; a failed write keeps session-memory behavior. */
const persistRecentEmoji = (): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(EMOJI_RECENTS_STORAGE_KEY, JSON.stringify(recentChars));
  } catch {
    // localStorage unavailable: recents stay in memory for this session.
  }
};

/** Record a pick as most-recently-used (dedupe, MRU-first, cap 16) and persist. */
export const rememberRecentEmoji = (char: string): void => {
  const next = [char, ...recentChars.filter((c) => c !== char)];
  recentChars.length = 0;
  recentChars.push(...next.slice(0, RECENT_LIMIT));
  persistRecentEmoji();
};

/** Current recents, oldest last (test/inspection helper). */
export const recentEmojiChars = (): readonly string[] => recentChars;

// App-boot hydration: a fresh app restores the persisted list (LRU order
// intact). Without a window (SSR tests) this is a no-op.
restoreRecentEmojiFromStorage(
  typeof window === 'undefined' ? null : window.localStorage,
);

export function EmojiPickerPanel(props: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const searching = query.trim().length > 0;
  const searchResults = useMemo(() => {
    return searching ? searchEmoji(query, 96) : null;
  }, [query, searching]);

  // One flat page (single category): the whole catalog in WeChat code-table
  // order. flatMap keeps this correct even if categories are ever re-added.
  const catalogEmojis = useMemo(() => {
    return EMOJI_CATEGORIES.flatMap((category) => category.emojis);
  }, []);

  // Recents: read per render (picks surface immediately - ChatScreen
  // re-renders this panel on every insert). Empty while searching and on a
  // fresh install (nothing used yet).
  const recents = recentEmojiChars();

  const activeEntries = searchResults ?? catalogEmojis;

  return (
    <div
      id="mobile-chat-emoji-panel"
      data-testid="emoji-panel"
      role="dialog"
      aria-label={t('mobile.chat.emojiPicker')}
      className="twin-panel m-2 shrink-0 overflow-hidden"
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        <div className="twin-input flex min-h-[40px] flex-1 items-center gap-2">
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mobile.chat.emojiSearch')}
            aria-label={t('mobile.chat.emojiSearch')}
            className="min-h-[40px] w-full bg-transparent text-sm text-[var(--text-primary)] outline-none"
          />
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={t('mobile.common.close')}
          className="twin-icon-button shrink-0"
        >
          <XMarkIcon className="h-5 w-5" aria-hidden />
        </button>
      </div>

      {/* Recent strip - WeChat style, embedded ABOVE the main grid inside
          the single emoji panel (no Recent tab). Hidden while searching and
          when empty. Touch targets keep the 36px minimum. */}
      {!searching && recents.length > 0 && (
        <div className="px-3 pt-2" aria-label={t('mobile.chat.emojiCategoryRecent')}>
          <div className="px-0.5 pb-1 text-[11px] text-[var(--text-secondary)]">
            {t('mobile.chat.emojiCategoryRecent')}
          </div>
          <div
            role="listbox"
            aria-label={t('mobile.chat.emojiCategoryRecent')}
            className="flex flex-wrap gap-0.5"
          >
            {recents.map((char) => (
              <button
                key={char}
                type="button"
                role="option"
                aria-label={char}
                aria-selected={false}
                onClick={() => props.onSelect(char)}
                className="flex h-[36px] w-[36px] items-center justify-center text-[20px] leading-none active:bg-[var(--bg-hover)]"
              >
                {/* Twemoji <img> (alt = codepoint); non-catalog recents fall back to the font glyph. */}
                <TwemojiGlyph char={char} px={20} />
              </button>
            ))}
          </div>
        </div>
      )}

      {activeEntries.length === 0 ? (
        <p
          data-testid="emoji-no-results"
          className="px-4 pb-4 pt-2 text-center text-sm text-[var(--text-secondary)]"
        >
          {t('mobile.chat.emojiPickerNoResults')}
        </p>
      ) : (
        <div
          role="listbox"
          aria-label={t('mobile.chat.emojiPicker')}
          className="grid grid-cols-8 gap-0.5 overflow-y-auto px-2 pb-2"
          style={{ maxHeight: '34dvh' }}
        >
          {activeEntries.map((entry) => (
            <button
              key={entry.char}
              type="button"
              role="option"
              aria-label={entry.char}
              aria-selected={false}
              onClick={() => props.onSelect(entry.char)}
              className="flex h-[44px] w-full items-center justify-center text-[22px] leading-none active:bg-[var(--bg-hover)]"
            >
              <TwemojiGlyph char={entry.char} px={22} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
