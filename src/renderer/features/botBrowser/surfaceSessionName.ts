/**
 * Surface-header session-name slot: pure decision helpers for the Bot Internet
 * face's inline session-name control (owner order 2026-11-11 17:37, item ④ —
 * the current session name sits BETWEEN the 新建会话 and 会话记录 buttons and
 * renames in place).
 *
 * Extracted from the JSX so the commit/fallback contract is testable in plain
 * Node without a DOM, mirroring the panelBubbleSelection pattern. The two
 * existing rename implementations this mirrors (CoworkSessionItem rows and the
 * CoworkSessionDetail header) share one contract:
 *
 *   - empty/whitespace input commits NOTHING — the display falls back to the
 *     default title ('新会话', the same i18n key the session header uses) and
 *     the stored title is never blanked (coworkService.renameSession also
 *     refuses empty titles renderer-side);
 *   - an unchanged title commits NOTHING (no pointless IPC write);
 *   - otherwise the trimmed title is committed through the existing
 *     coworkService.renameSession channel, whose updateSessionTitle dispatch
 *     patches BOTH the shared sessions list and the open session, so the
 *     sidebar list and any session header re-render in sync.
 */

export type SurfaceSessionRenameDecision =
  | { action: 'rename'; nextTitle: string }
  | { action: 'noop' };

/**
 * Grace window (ms) before the studio title preview collapses after the
 * pointer leaves the studio header (owner ruling 2026-11-15 09:17: the
 * title must NOT snap back the instant the pointer leaves — it lingers
 * 2500 ms; re-entering the badge row or the title box inside the window
 * cancels the pending collapse).
 */
export const SESSION_TITLE_HIDE_GRACE_MS = 2000;

/**
 * Decision math for the header-leave event. While the inline rename editor
 * is open the preview NEVER auto-collapses (owner clause ②: editing pins
 * the row; the hover rule resumes only after the edit commits or cancels)
 * — `null` means "do not schedule any collapse timer"; otherwise the grace
 * delay to wait before hiding.
 */
export function resolveTitleHideDelayMs(titleEditing: boolean): number | null {
  return titleEditing ? null : SESSION_TITLE_HIDE_GRACE_MS;
}

/**
 * Display title for the read-only state: a blank stored title falls back to
 * the default title so the slot never renders an empty control.
 */
export function resolveSurfaceSessionDisplayTitle(
  rawTitle: string | null | undefined,
  fallbackTitle: string,
): string {
  const trimmed = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  return trimmed || fallbackTitle;
}

/**
 * Rename-commit decision for the inline editor: Enter and blur both route
 * here. Empty input is a deliberate no-op (the fallback title shows instead —
 * it never blanks the stored title), an unchanged title is a no-op (no
 * redundant write), anything else renames with the trimmed value.
 */
export function decideSurfaceSessionRename(
  currentTitle: string,
  inputValue: string,
): SurfaceSessionRenameDecision {
  const nextTitle = inputValue.trim();
  if (!nextTitle) return { action: 'noop' };
  if (nextTitle === currentTitle) return { action: 'noop' };
  return { action: 'rename', nextTitle };
}
