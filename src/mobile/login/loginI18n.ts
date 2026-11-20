import { createMobileI18n } from '../i18nCore';
import {
  loginCommonTranslations,
  loginEnTranslations,
  loginZhTranslations,
} from './loginCopy';

export const mobileI18n = createMobileI18n({
  zh: { ...loginCommonTranslations.zh, ...loginZhTranslations },
  en: { ...loginCommonTranslations.en, ...loginEnTranslations },
});

export const t = (key: string, params?: Record<string, string | number>): string =>
  mobileI18n.t(key, params);
