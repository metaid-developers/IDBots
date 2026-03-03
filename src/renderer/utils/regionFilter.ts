// IM 平台分类
export const CHINA_IM_PLATFORMS = ['dingtalk', 'feishu'] as const;
export const GLOBAL_IM_PLATFORMS = ['telegram', 'discord'] as const;

/** All IM platforms shown in settings regardless of app language. */
const ALL_IM_PLATFORMS = [...CHINA_IM_PLATFORMS, ...GLOBAL_IM_PLATFORMS] as const;

/**
 * Returns all IM platforms (DingTalk, Feishu, Telegram, Discord). No language filtering.
 */
export const getVisibleIMPlatforms = (_language?: 'zh' | 'en'): readonly string[] => {
  return ALL_IM_PLATFORMS;
};
