type CoworkSessionVisibilityStore = {
  isSessionHiddenFromList?: (sessionId: string) => boolean;
  getSession?: (sessionId: string) => { hiddenFromSessionList?: boolean } | null;
};

export function shouldForwardCoworkStreamEvent(
  store: CoworkSessionVisibilityStore | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!store || !sessionId) return true;

  try {
    if (typeof store.isSessionHiddenFromList === 'function') {
      return !store.isSessionHiddenFromList(sessionId);
    }

    if (typeof store.getSession === 'function') {
      return store.getSession(sessionId)?.hiddenFromSessionList !== true;
    }
  } catch {
    return true;
  }

  return true;
}
