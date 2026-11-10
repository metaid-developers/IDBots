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
    const enabled = store?.get(BOT_HUB_LIVE_STAGE_KEY) === true || store?.get(BOT_HUB_LIVE_STAGE_KEY) === '1';
    const directorEnabled = store?.get(BOT_HUB_LIVE_STAGE_DIRECTOR_KEY) === true || store?.get(BOT_HUB_LIVE_STAGE_DIRECTOR_KEY) === '1';
    return { enabled, directorEnabled: enabled && directorEnabled };
  } catch {
    return { enabled: false, directorEnabled: false };
  }
}

export function writeBotHubLiveStageSettings(
  store: BotHubLiveStageSettingsStore | null | undefined,
  updates: Partial<BotHubLiveStageSettings>,
): BotHubLiveStageSettings {
  const current = readBotHubLiveStageSettings(store);
  const enabled = updates.enabled ?? current.enabled;
  const directorEnabled = enabled && (updates.directorEnabled ?? current.directorEnabled);
  try {
    if (updates.enabled !== undefined) store?.set?.(BOT_HUB_LIVE_STAGE_KEY, enabled ? '1' : '0');
    if (updates.directorEnabled !== undefined || updates.enabled !== undefined) store?.set?.(BOT_HUB_LIVE_STAGE_DIRECTOR_KEY, directorEnabled ? '1' : '0');
  } catch {
    // The in-memory result still reflects the requested setting; the next read
    // safely falls back to the persisted values.
  }
  return { enabled, directorEnabled };
}
