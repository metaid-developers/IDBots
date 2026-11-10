/**
 * Panel bubble reactions — MVP persistence (office-chat purity pass #1, item ③).
 *
 * There is NO backend model for reactions yet (grep across the repo confirms:
 * no reactions table, no IPC channel). The MVP keeps one rating per bubble in
 * localStorage under `twinChatReactions:{sessionId}:{messageId}`, single-choice
 * and toggleable (re-clicking the same thumb clears it — the usual chat-app
 * semantics).
 *
 * FUTURE IPC UPGRADE PATH (do not remove until wired): when a reactions model
 * lands main-side, replace the storage adapter below with an async writer that
 * mirrors the rating through `window.electron.cowork.*` (one IPC call in
 * `writePanelReaction`, one read in `readPanelReactionsForSession`) and keep
 * the localStorage key as the optimistic local cache. The renderer call sites
 * (BotBrowserCoworkPanel) already go through this module's functions only, so
 * the swap should touch this file plus the panel's effect wiring — no other
 * surface, no new key shape. Key format stays stable so persisted MVP votes
 * keep resolving after the upgrade.
 */

export const PANEL_REACTIONS_STORAGE_PREFIX = 'twinChatReactions';

export type PanelReactionRating = 'up' | 'down';

/** Minimal localStorage surface — the real window.localStorage in the app. */
export interface PanelReactionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/**
 * `twinChatReactions:{sessionId}:{messageId}` — one key per bubble, so the
 * session sweep below never has to parse foreign entries.
 */
export const panelReactionStorageKey = (sessionId: string, messageId: string): string => (
  `${PANEL_REACTIONS_STORAGE_PREFIX}:${sessionId}:${messageId}`
);

/**
 * Access the real storage defensively: even *touching* window.localStorage
 * throws in hardened privacy modes, so callers go through this accessor and
 * get a null storage (all module functions no-op) instead of a render crash.
 * Tests pass their own fake PanelReactionsStorage directly.
 */
export const getPanelReactionsStorage = (): PanelReactionsStorage | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Single-choice toggle: re-picking the current rating cancels it (null),
 * picking the other side switches.
 */
export const applyPanelReactionToggle = (
  current: PanelReactionRating | null,
  next: PanelReactionRating,
): PanelReactionRating | null => (current === next ? null : next);

const parseStoredRating = (raw: string | null): PanelReactionRating | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { rating?: unknown };
    if (parsed?.rating === 'up' || parsed?.rating === 'down') return parsed.rating;
  } catch {
    // Malformed stored value: treat as no reaction (never throw into render).
  }
  return null;
};

/** Read one bubble's stored rating. Safe against privacy-mode storage throws. */
export const readPanelReaction = (
  storage: PanelReactionsStorage | null | undefined,
  sessionId: string,
  messageId: string,
): PanelReactionRating | null => {
  if (!storage) return null;
  try {
    return parseStoredRating(storage.getItem(panelReactionStorageKey(sessionId, messageId)));
  } catch {
    return null;
  }
};

/**
 * Write (or clear, with `null`) one bubble's rating. The value is a tiny JSON
 * object, not a bare string, so a future schema (comment, timestamp, synced
 * flag) extends in place without a migration.
 */
export const writePanelReaction = (
  storage: PanelReactionsStorage | null | undefined,
  sessionId: string,
  messageId: string,
  rating: PanelReactionRating | null,
): void => {
  if (!storage) return;
  const key = panelReactionStorageKey(sessionId, messageId);
  try {
    if (rating === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ rating }));
  } catch {
    // Quota / privacy-mode failures degrade to an ephemeral chip; the menu
    // toggle still works for this render. Never throw into React state.
  }
};

/**
 * Sweep one session's stored ratings (panel mounts / session switches). Only
 * keys carrying this module's prefix and the exact session segment are read —
 * other sessions' and foreign keys are skipped without parsing.
 */
export const readPanelReactionsForSession = (
  storage: PanelReactionsStorage | null | undefined,
  sessionId: string,
): Record<string, PanelReactionRating> => {
  const result: Record<string, PanelReactionRating> = {};
  if (!storage) return result;
  const prefix = `${PANEL_REACTIONS_STORAGE_PREFIX}:${sessionId}:`;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const messageId = key.slice(prefix.length);
      if (!messageId) continue;
      const rating = parseStoredRating(storage.getItem(key));
      if (rating) result[messageId] = rating;
    }
  } catch {
    // Storage unavailable (privacy mode): empty map, chips simply absent.
  }
  return result;
};
