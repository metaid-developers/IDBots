/**
 * ME points client-side settings (global, persisted in the SQLite kvStore,
 * following the trafficSettings.ts pattern).
 *
 * - me.persistentAutoDeduct: when true (the default), spending continues
 *   automatically from the persistent credit buckets (top-up / earned /
 *   bonus) after the weekly subscription grant runs out.
 *
 * Authority: the server-side per-identity switch (assist-base-service
 * GET/POST /v1/me/settings, 727182a) is authoritative — its OFF state gates
 * every ME consumption path (pay/freeze/burn/metering) to grant-only. The
 * kvStore holds a local MIRROR of the last server-confirmed value, used as
 * a degraded read when the server is unreachable or no local identity is
 * signed in. Never write the mirror without a server confirmation: a local
 * write the server never saw would silently drift from the enforced truth.
 */

export const ME_PERSISTENT_AUTO_DEDUCT_KEY = 'me.persistentAutoDeduct';

/** Settings snapshot surfaced to the renderer toggle. */
export interface MePointSettingsSnapshot {
  autoDeductFromPersistent: boolean;
}

/** Minimal kv reader shape shared by SqliteStore and test doubles. */
export type MePointSettingsReader = Pick<{ get<T = unknown>(key: string): T | undefined }, 'get'>;

/** Minimal kv writer shape shared by SqliteStore and test doubles. */
export type MePointSettingsStore = MePointSettingsReader & { set(key: string, value: unknown): void };

/**
 * Default ON: only an explicitly stored `false` turns the auto-deduct off.
 * Unset / null / malformed values all read as the default.
 */
export function normalizeAutoDeductFromPersistent(value: unknown): boolean {
  return value !== false;
}

/** Read the settings snapshot; never throws, defaults when unset or unreadable. */
export function getMePointSettings(reader: MePointSettingsReader | null | undefined): MePointSettingsSnapshot {
  let stored: unknown;
  if (reader) {
    try {
      stored = reader.get(ME_PERSISTENT_AUTO_DEDUCT_KEY);
    } catch {
      stored = undefined;
    }
  }
  return { autoDeductFromPersistent: normalizeAutoDeductFromPersistent(stored) };
}

/**
 * Persist settings (partial update). Values are normalized on write;
 * omitted fields keep their current value. Persistence loss is non-fatal:
 * the returned snapshot still reflects the user's intent.
 */
export function setMePointSettings(
  store: MePointSettingsStore | null | undefined,
  input: { autoDeductFromPersistent?: unknown },
): MePointSettingsSnapshot {
  const current = getMePointSettings(store);
  const nextAutoDeduct = input.autoDeductFromPersistent === undefined
    ? current.autoDeductFromPersistent
    : normalizeAutoDeductFromPersistent(input.autoDeductFromPersistent);
  if (store) {
    try {
      store.set(ME_PERSISTENT_AUTO_DEDUCT_KEY, nextAutoDeduct);
    } catch {
      // persistence loss is non-fatal; the returned snapshot still reflects intent
    }
  }
  return { autoDeductFromPersistent: nextAutoDeduct };
}

/**
 * Mirror a SERVER-CONFIRMED value into the local kv. Only the IPC layer calls
 * this after a successful /v1/me/settings read or write — see the header note:
 * the mirror must never record an intent the server did not acknowledge.
 */
export function mirrorMePointSettings(
  store: MePointSettingsStore | null | undefined,
  autoDeductFromPersistent: boolean,
): void {
  if (!store) return;
  try {
    store.set(ME_PERSISTENT_AUTO_DEDUCT_KEY, autoDeductFromPersistent === true);
  } catch {
    // mirror loss is non-fatal: the next successful server read re-seeds it
  }
}
