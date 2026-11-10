import type { ChatExperienceMode } from '../config';

/**
 * The chat experience mode is decided by the FACE the user is on
 * (总裁办公室裁定 2026-11-09, superseding the retired Settings toggle):
 *
 *   - Studio face (surfaceMode 'browser') -> 'assistant'. Assistant mode is
 *     embedded in the Studio layer itself: sessions started there carry the
 *     persisted per-session assistantMode marker (owner ruling 2026-11-07),
 *     so the assistant treatment and the professional prompt never disagree.
 *   - BotWorks face (surfaceMode 'home') -> 'professional'. Every bot on the
 *     face — twin included — chats with the professional presentation and the
 *     professional prompt (no assistant-mode shell).
 *
 * This module is deliberately React-free and window-safe (guarded reads) so
 * both the hook (useChatExperienceMode) and Node tests can use it.
 */

/**
 * localStorage key of the active face. MIRROR of
 * SURFACE_MODE_STORAGE_KEY in features/botBrowser/useBotBrowserShell.ts —
 * kept as a literal so Node tests of this module need no React import chain;
 * tests/chatExperienceModeFaceSource.test.ts drift-guards the two literals.
 */
export const SURFACE_MODE_STORAGE_KEY_MIRROR = 'idbots.botBrowser.surfaceMode';

/**
 * Fired on `window` whenever the shell writes the active face
 * (useBotBrowserShell.setSurfaceMode). Same-window consumers re-derive the
 * mode from it; cross-window consumers get the same signal via the native
 * `storage` event (same origin, same partition).
 */
export const SURFACE_MODE_CHANGE_EVENT = 'idbots:surface-mode-changed';

export type ChatSurfaceMode = 'browser' | 'home';

/**
 * The face -> chat experience mode mapping. Missing/unknown faces fall back
 * to 'assistant': that is the shell's own landing default (Bot Internet is
 * the app's default surface), so an unreadable face must not flip Studio
 * onto the professional presentation.
 */
export function chatExperienceModeForSurface(
  surface: ChatSurfaceMode | null | undefined,
): ChatExperienceMode {
  return surface === 'home' ? 'professional' : 'assistant';
}

/**
 * The active face, read straight from the same localStorage slot the shell
 * persists to. Guarded like useBotBrowserShell.readStoredSurfaceMode (static
 * tests and Node have no window; storage failures degrade to the default).
 */
export function readActiveSurfaceMode(): ChatSurfaceMode {
  try {
    const stored = window.localStorage.getItem(SURFACE_MODE_STORAGE_KEY_MIRROR);
    return stored === 'home' || stored === 'browser' ? stored : 'browser';
  } catch {
    return 'browser';
  }
}
