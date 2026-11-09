/**
 * Per-face memory for the two session lists (owner ruling 2026-11-08).
 *
 * Bot Home's records body has two faces — 本地对话 (owner ↔ MetaBot) and
 * 线上对话 (MetaBot ↔ MetaBot). Both render the SAME grouped list component
 * (CoworkSessionList) over different data sources, so every piece of per-face
 * view state needs its own key; sharing one key would make collapsing a bot
 * group on one face silently collapse the same bot on the other.
 *
 * Storage semantics mirror `utils/sidebarWidth.ts` (the owner's explicit
 * reference for "same family"): one `idbots.*` key per face, plus one legacy
 * unprefixed key that seeds the local face only. The helpers are pure
 * (getItem/setItem are injected) so they can be unit-tested with tsx.
 *
 * Two independent memories live here:
 *
 *  - VIEW MODE (按 Bot / 按时间线). The default is 按 Bot on BOTH faces: the
 *    owner's grouping ruling makes the per-bot groups the primary reading, and
 *    the timeline is the secondary one. A stored choice always wins.
 *  - COLLAPSED BOT GROUPS. Only the collapsed keys are persisted; everything
 *    else is expanded. The preference is per face and fail-open: an unreadable
 *    value means "nothing collapsed", never "hide everything".
 */

import type { SessionViewMode } from './sessionViewGrouping';

/** The two session-list faces of the Bot Home records body. */
export type SessionGroupFace = 'local' | 'a2a';

/** Legacy single-key view mode (pre per-face); seeds the local face only. */
export const LEGACY_SESSION_VIEW_MODE_STORAGE_KEY = 'sessionViewMode';

const VIEW_MODE_STORAGE_KEYS: Record<SessionGroupFace, string> = {
  local: 'idbots.sessionViewMode.local',
  a2a: 'idbots.sessionViewMode.a2a',
};

const COLLAPSED_GROUPS_STORAGE_KEYS: Record<SessionGroupFace, string> = {
  local: 'idbots.sessionGroups.local',
  a2a: 'idbots.sessionGroups.a2a',
};

/** localStorage key for one face's view mode. */
export function sessionViewModeStorageKey(face: SessionGroupFace): string {
  return VIEW_MODE_STORAGE_KEYS[face];
}

/** localStorage key for one face's collapsed bot groups. */
export function sessionGroupCollapseStorageKey(face: SessionGroupFace): string {
  return COLLAPSED_GROUPS_STORAGE_KEYS[face];
}

/** Only the two live modes; 'project' is the retired directory view whose
 * closest successor is the by-Bot view, so it carries over instead of
 * snapping to the default. */
const normalizeViewMode = (stored: string | null): SessionViewMode | null => {
  if (stored === 'bot' || stored === 'project') return 'bot';
  if (stored === 'timeline') return 'timeline';
  return null;
};

/**
 * Load one face's view mode. Default: 按 Bot (both faces). A legacy
 * unprefixed value seeds the local face; a corrupt value falls back to the
 * default rather than throwing.
 */
export function loadSessionViewMode(
  getItem: (key: string) => string | null,
  face: SessionGroupFace,
): SessionViewMode {
  const stored = normalizeViewMode(getItem(VIEW_MODE_STORAGE_KEYS[face]));
  if (stored) return stored;
  if (face === 'local') {
    const legacy = normalizeViewMode(getItem(LEGACY_SESSION_VIEW_MODE_STORAGE_KEY));
    if (legacy) return legacy;
  }
  return 'bot';
}

/** Persist one face's view mode (best effort — storage may be unavailable). */
export function saveSessionViewMode(
  setItem: (key: string, value: string) => void,
  face: SessionGroupFace,
  mode: SessionViewMode,
): void {
  setItem(VIEW_MODE_STORAGE_KEYS[face], mode);
}

/**
 * Stable serialization of the collapsed group keys: a sorted JSON array.
 * Sorting keeps two toggles that end in the same set writing the same bytes
 * (and keeps the persisted value diffable in a bug report).
 */
export function serializeCollapsedSessionGroups(keys: Iterable<string>): string {
  const unique = [...new Set([...keys].filter((key) => typeof key === 'string' && key.length > 0))];
  unique.sort();
  return JSON.stringify(unique);
}

/**
 * Parse a persisted collapsed-group value. Anything that is not a JSON array
 * of strings (or a present-but-corrupt value) yields an empty set: a broken
 * preference must never hide groups the owner did not collapse.
 */
export function parseCollapsedSessionGroups(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === 'string' && key.length > 0));
  } catch {
    return new Set();
  }
}

/** Load one face's collapsed bot groups. */
export function loadCollapsedSessionGroups(
  getItem: (key: string) => string | null,
  face: SessionGroupFace,
): Set<string> {
  return parseCollapsedSessionGroups(getItem(COLLAPSED_GROUPS_STORAGE_KEYS[face]));
}

/** Persist one face's collapsed bot groups (best effort). */
export function saveCollapsedSessionGroups(
  setItem: (key: string, value: string) => void,
  face: SessionGroupFace,
  keys: Iterable<string>,
): void {
  setItem(COLLAPSED_GROUPS_STORAGE_KEYS[face], serializeCollapsedSessionGroups(keys));
}
