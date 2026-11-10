export type StudioLiveStageSettings = {
  enabled: boolean;
  directorEnabled: boolean;
};

export type StudioLiveStageSettingsStore = {
  get<T = unknown>(key: string): T | undefined;
  set?(key: string, value: unknown): void;
};

export const STUDIO_LIVE_STAGE_KEY = 'studio.liveStage.enabled';
export const STUDIO_LIVE_STAGE_DIRECTOR_KEY = 'studio.liveStage.director.enabled';

/**
 * LEGACY (pre-Studio naming): builds that called this surface BotHub persisted
 * this key. It is data-compatibility only — read once, copied onto the
 * STUDIO_* key, and never written again — so an existing install keeps its
 * live-stage toggle across the rename instead of silently falling back to off.
 * (The legacy director key is not migrated: the Director is now derived from
 * the stage toggle and has no stored state of its own.)
 */
const LEGACY_LIVE_STAGE_KEY = 'botHub.liveStage.enabled';

/** Read a persisted key, migrating a pre-rename value forward on first sight. */
function readPersisted(store: StudioLiveStageSettingsStore | null | undefined, key: string, legacyKey: string): unknown {
  const value = store?.get(key);
  if (value !== undefined) return value;
  const legacy = store?.get(legacyKey);
  if (legacy !== undefined) {
    try {
      store?.set?.(key, legacy);
    } catch {
      // The value is still returned; the migration retries on the next read.
    }
  }
  return legacy;
}

export function readStudioLiveStageSettings(store: StudioLiveStageSettingsStore | null | undefined): StudioLiveStageSettings {
  try {
    const rawEnabled = readPersisted(store, STUDIO_LIVE_STAGE_KEY, LEGACY_LIVE_STAGE_KEY);
    // Default ON (owner ruling 2026-11-10): the stage is on unless the user
    // explicitly turned it off ('0', migrated forward from the legacy key if
    // needed). The Director has no independent switch — it is linked to the
    // stage toggle and shares its state, so a stale director key from before
    // the linkage can never strand the Director off.
    const enabled = rawEnabled === undefined || rawEnabled === null ? true : rawEnabled === true || rawEnabled === '1';
    return { enabled, directorEnabled: enabled };
  } catch {
    return { enabled: true, directorEnabled: true };
  }
}

export function writeStudioLiveStageSettings(
  store: StudioLiveStageSettingsStore | null | undefined,
  updates: Partial<StudioLiveStageSettings>,
): StudioLiveStageSettings {
  const current = readStudioLiveStageSettings(store);
  // The Director follows the stage toggle (owner ruling 2026-11-10): only the
  // stage's enabled state is honored, and both keys are mirrored so older
  // builds reading the director key still see a consistent state.
  const enabled = updates.enabled ?? current.enabled;
  try {
    if (updates.enabled !== undefined) {
      store?.set?.(STUDIO_LIVE_STAGE_KEY, enabled ? '1' : '0');
      store?.set?.(STUDIO_LIVE_STAGE_DIRECTOR_KEY, enabled ? '1' : '0');
    }
  } catch {
    // The in-memory result still reflects the requested setting; the next read
    // safely falls back to the persisted values.
  }
  return { enabled, directorEnabled: enabled };
}
