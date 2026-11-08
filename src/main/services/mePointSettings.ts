/**
 * ME points client-side settings (global, persisted in the SQLite kvStore,
 * following the trafficSettings.ts pattern).
 *
 * - me.persistentAutoDeduct: when true (the default), spending continues
 *   automatically from the persistent credit buckets (top-up / earned /
 *   bonus) after the weekly subscription grant runs out. The server's fixed
 *   deduction order (grant → bonus → topup → earned) already behaves this
 *   way unconditionally; this flag stores the user's preference for the
 *   「积分增量包」 toggle. Enforcing the OFF state server-side (a
 *   per-identity switch respected by the deduction/metering burn path) is a
 *   pending assist-base-service feature — until then the stored preference
 *   is authoritative for the UI and future client-side gating only.
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
