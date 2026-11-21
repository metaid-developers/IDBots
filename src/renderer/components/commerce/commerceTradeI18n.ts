import { i18nService } from '../../services/i18n';

export type CommerceLocale = 'zh' | 'en';

export function getCommerceLocale(): CommerceLocale {
  try {
    return i18nService.getLanguage() === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

export function ct(en: string, zh: string, locale: CommerceLocale = getCommerceLocale()): string {
  return locale === 'zh' ? zh : en;
}

export function formatMeDisplay(amountMilli: number | undefined): string {
  if (amountMilli == null || !Number.isFinite(amountMilli)) return '0 ME';
  const num = (amountMilli / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${num} ME`;
}

export function formatCnyDisplay(amountCents: number | undefined): string {
  if (amountCents == null || !Number.isFinite(amountCents)) return '¥0.00';
  return `¥${(amountCents / 100).toFixed(2)}`;
}
