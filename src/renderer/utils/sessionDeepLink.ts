/**
 * In-app session deep links jump straight to the referenced CoWork
 * conversation via the app-wide 'cowork:viewSession' DOM event (handler in
 * App.tsx). Two shapes are recognised (the scheme is case-insensitive):
 *
 *   idbots://session/<sessionId> — the daily report's deep-link form;
 *   idbots://<sessionId>         — the bare IDBots://<id> form the app itself
 *                                  emits everywhere: the copy-session-link
 *                                  menu, cross-session refs, and the bot-side
 *                                  instructions that tell bots to link a
 *                                  related conversation to the owner this way.
 *
 * Anything else under idbots:// is not recognised and stays a no-op.
 *
 * Consumed by MarkdownContent link rendering and by the inline HTML report
 * block's in-frame link bridge, so both surfaces behave identically.
 */

export const IDBOTS_SESSION_URI_RE =
  /^idbots:\/\/(?:session\/)?([A-Za-z0-9][A-Za-z0-9._~-]*)$/i;

/** Extract the session id from an idbots:// session URI, or null. */
export const parseIdbotsSessionUri = (href: string): string | null => {
  const match = href.trim().match(IDBOTS_SESSION_URI_RE);
  if (!match) return null;
  const sessionId = match[1];
  // Without the /session/ path, a bare "session" authority is the path
  // keyword rather than an id — refuse instead of dispatching a bogus lookup.
  if (sessionId.toLowerCase() === 'session') return null;
  return sessionId;
};

/** Jump to a CoWork conversation (App.tsx listens and switches view/session). */
export const dispatchViewSession = (sessionId: string): void => {
  window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId } }));
};
