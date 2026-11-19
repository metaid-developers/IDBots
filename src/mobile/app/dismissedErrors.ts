const DISMISSED_ERRORS_STORAGE_KEY = 'idbots.mobile.chat.dismissedErrors.v1';

/** LRU-ish cap (2026-11-19 review P2): ids are per-transcript message ids,
 *  unique per error row and never pruned — an unbounded Set re-serialized the
 *  whole key on every dismiss and grew the localStorage entry forever. 200
 *  recent dismissals is far more than any chat screen shows; evicted ids only
 *  mean an old error row can surface again, never a crash. */
const DISMISSED_ERROR_IDS_CAP = 200;

type DismissedErrorStorage = Pick<Storage, 'getItem' | 'setItem'>;

const dismissedErrorIds = new Set<string>();

function capDismissedErrorIds(): void {
  while (dismissedErrorIds.size > DISMISSED_ERROR_IDS_CAP) {
    const oldest = dismissedErrorIds.values().next();
    if (oldest.done) break;
    dismissedErrorIds.delete(oldest.value);
  }
}

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
  // Keep only the most recent cap worth of a (possibly polluted) stored list.
  for (const id of restored.slice(-DISMISSED_ERROR_IDS_CAP)) dismissedErrorIds.add(id);
  return [...dismissedErrorIds];
}

export function dismissErrorMessage(id: string, storage?: DismissedErrorStorage | null): void {
  if (!id) return;
  dismissedErrorIds.add(id);
  capDismissedErrorIds();
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
