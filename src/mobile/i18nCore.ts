export type MobileLanguage = 'zh' | 'en';
export type MobileDictionary = Record<string, string>;

export function inferLanguageFromLocale(systemLocale: string): MobileLanguage {
  const normalized = String(systemLocale || '').trim().replace(/_/g, '-').toLowerCase();
  if (!normalized) return 'en';
  const tags = normalized.split('-').filter(Boolean);
  if (tags[0] !== 'zh') return 'en';
  if (tags.includes('hant') || tags[1] === 'tw' || tags[1] === 'hk' || tags[1] === 'mo') return 'en';
  return 'zh';
}

class MobileI18nService {
  private currentLanguage: MobileLanguage = 'en';
  private listeners = new Set<() => void>();

  constructor(private dictionaries: Record<MobileLanguage, MobileDictionary>) {}

  initFromDeviceLocale(locale?: string): MobileLanguage {
    const source = locale ?? (typeof navigator !== 'undefined' && typeof navigator.language === 'string'
      ? navigator.language
      : 'en');
    this.currentLanguage = inferLanguageFromLocale(source);
    return this.currentLanguage;
  }

  t(key: string, params?: Record<string, string | number>): string {
    let translation = this.dictionaries[this.currentLanguage][key];
    if (translation === undefined) {
      console.warn(`[mobile-i18n] missing key: ${key} (${this.currentLanguage})`);
      translation = this.dictionaries.en[key];
      if (translation === undefined) return '';
    }
    if (params) {
      translation = translation.replace(/\{(\w+)\}/g, (match, name: string) =>
        params[name] !== undefined ? String(params[name]) : match,
      );
    }
    return translation;
  }

  setLanguage(language: MobileLanguage): void {
    if (this.currentLanguage === language) return;
    this.currentLanguage = language;
    for (const listener of [...this.listeners]) listener();
  }

  getLanguage(): MobileLanguage {
    return this.currentLanguage;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createMobileI18n(dictionaries: Record<MobileLanguage, MobileDictionary>) {
  return new MobileI18nService(dictionaries);
}
