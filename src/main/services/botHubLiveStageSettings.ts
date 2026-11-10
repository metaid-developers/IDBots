export type BotHubLiveStageSettings = {
  enabled: boolean;
  directorEnabled: boolean;
};

export type BotHubLiveStageSettingsStore = {
  get<T = unknown>(key: string): T | undefined;
  set?(key: string, value: unknown): void;
};

export const BOT_HUB_LIVE_STAGE_KEY = 'botHub.liveStage.enabled';
export const BOT_HUB_LIVE_STAGE_DIRECTOR_KEY = 'botHub.liveStage.director.enabled';

export function readBotHubLiveStageSettings(store: BotHubLiveStageSettingsStore | null | undefined): BotHubLiveStageSettings {
  try {
    // Default ON (owner ruling 2026-11-10): the stage is on unless the user
    // explicitly turned it off ('0'). The Director has no independent switch —
    // it is linked to the stage toggle and shares its state, so a stale
    // director key from before the linkage can never strand the Director off.
    const raw = store?.get(BOT_HUB_LIVE_STAGE_KEY);
    const enabled = raw === undefined || raw === null ? true : raw === true || raw === '1';
    return { enabled, directorEnabled: enabled };
  } catch {
    return { enabled: true, directorEnabled: true };
  }
}

export function writeBotHubLiveStageSettings(
  store: BotHubLiveStageSettingsStore | null | undefined,
  updates: Partial<BotHubLiveStageSettings>,
): BotHubLiveStageSettings {
  const current = readBotHubLiveStageSettings(store);
  // The Director follows the stage toggle (owner ruling 2026-11-10): only the
  // stage's enabled state is honored, and both keys are mirrored so older
  // builds reading the director key still see a consistent state.
  const enabled = updates.enabled ?? current.enabled;
  try {
    if (updates.enabled !== undefined) {
      store?.set?.(BOT_HUB_LIVE_STAGE_KEY, enabled ? '1' : '0');
      store?.set?.(BOT_HUB_LIVE_STAGE_DIRECTOR_KEY, enabled ? '1' : '0');
    }
  } catch {
    // The in-memory result still reflects the requested setting; the next read
    // safely falls back to the persisted values.
  }
  return { enabled, directorEnabled: enabled };
}
