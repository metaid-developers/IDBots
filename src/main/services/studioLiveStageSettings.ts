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
 * these keys. They are data-compatibility only — read once, copied onto the
 * STUDIO_* keys, and never written again — so an existing install keeps its
 * live-stage toggles across the rename instead of silently falling back to off.
 */
const LEGACY_LIVE_STAGE_KEY = 'botHub.liveStage.enabled';
const LEGACY_LIVE_STAGE_DIRECTOR_KEY = 'botHub.liveStage.director.enabled';

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
    const rawDirector = readPersisted(store, STUDIO_LIVE_STAGE_DIRECTOR_KEY, LEGACY_LIVE_STAGE_DIRECTOR_KEY);
    const enabled = rawEnabled === true || rawEnabled === '1';
    const directorEnabled = rawDirector === true || rawDirector === '1';
    return { enabled, directorEnabled: enabled && directorEnabled };
  } catch {
    return { enabled: false, directorEnabled: false };
  }
}

export function writeStudioLiveStageSettings(
  store: StudioLiveStageSettingsStore | null | undefined,
  updates: Partial<StudioLiveStageSettings>,
): StudioLiveStageSettings {
  const current = readStudioLiveStageSettings(store);
  const enabled = updates.enabled ?? current.enabled;
  const directorEnabled = enabled && (updates.directorEnabled ?? current.directorEnabled);
  try {
    if (updates.enabled !== undefined) store?.set?.(STUDIO_LIVE_STAGE_KEY, enabled ? '1' : '0');
    if (updates.directorEnabled !== undefined || updates.enabled !== undefined) store?.set?.(STUDIO_LIVE_STAGE_DIRECTOR_KEY, directorEnabled ? '1' : '0');
  } catch {
    // The in-memory result still reflects the requested setting; the next read
    // safely falls back to the persisted values.
  }
  return { enabled, directorEnabled };
}
