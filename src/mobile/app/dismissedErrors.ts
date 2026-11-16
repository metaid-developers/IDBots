const DISMISSED_ERRORS_STORAGE_KEY = 'idbots.mobile.chat.dismissedErrors.v1';

type DismissedErrorStorage = Pick<Storage, 'getItem' | 'setItem'>;

const dismissedErrorIds = new Set<string>();

export function parseDismissedErrorIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  } catch {
    return [];
  }
}

export function restoreDismissedErrorsFromStorage(storage: DismissedErrorStorage | null): readonly string[] {
  let restored: string[] = [];
  if (storage) {
    try {
      restored = parseDismissedErrorIds(storage.getItem(DISMISSED_ERRORS_STORAGE_KEY));
    } catch {
      restored = [];
    }
  }
  dismissedErrorIds.clear();
  for (const id of restored) dismissedErrorIds.add(id);
  return [...dismissedErrorIds];
}

export function dismissErrorMessage(id: string, storage?: DismissedErrorStorage | null): void {
  if (!id) return;
  dismissedErrorIds.add(id);
  try {
    const target = storage === undefined
      ? (typeof window === 'undefined' ? null : window.localStorage)
      : storage;
    if (!target) return;
    target.setItem(DISMISSED_ERRORS_STORAGE_KEY, JSON.stringify([...dismissedErrorIds]));
  } catch {
    // Storage failures keep the dismissal active for this app session.
  }
}

export function filterDismissedErrorMessages<T extends { id: string; role: string }>(messages: readonly T[]): T[] {
  return messages.filter((message) => message.role !== 'error' || !dismissedErrorIds.has(message.id));
}

restoreDismissedErrorsFromStorage(
  typeof window === 'undefined' ? null : window.localStorage,
);
