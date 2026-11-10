/**
 * Local copy deck for the "Twin's work" strip (`features/twinWork`).
 *
 * WHY THIS FILE EXISTS — and why the keys are not in `services/i18n.ts`:
 * the A line is actively editing the global i18n table for the Studio/BotWorks
 * surface work. Two independent key blocks landing in that one file is a
 * guaranteed merge collision, so this feature carries its own bilingual deck
 * and reads it directly. When the A line settles, Twin folds these keys into
 * the global table in one pass and this file becomes a thin re-export.
 *
 * Contract (owner hand-off 2026-11-09):
 *  - the product name "Twin's work" is a temporary name and is NOT translated
 *    (identical in both decks, kept as a constant so nobody "fixes" it);
 *  - every other line has a zh and an en form;
 *  - existing global keys are never edited here.
 */

export type TwinWorkLanguage = 'zh' | 'en';

export interface TwinWorkCopy {
  /** Product name — deliberately identical in both languages (owner's temp name). */
  title: string;
  /** The header's new-conversation action (single-Twin case) / menu trigger. */
  newSession: string;
  /** Per-Twin creation affordance; `{name}` is replaced with the Twin's name. */
  newSessionForTwin: string;
  /** Intro line above the multiple-Twin picker. */
  chooseTwin: string;
  /** Search entry (button label + input aria-label). */
  search: string;
  searchPlaceholder: string;
  clearSearch: string;
  closeSearch: string;
  /** Empty state — one line, exact wording fixed by the hand-off. */
  empty: string;
  /** Search/filter matched nothing. */
  noResults: string;
  /** Count tooltip, `{count}` replaced with the number. */
  sessionCount: string;
}

const ZH: TwinWorkCopy = {
  title: "Twin's work",
  newSession: '新建会话',
  newSessionForTwin: '与 {name} 新建会话',
  chooseTwin: '选择要新建会话的 Twin',
  search: '搜索会话',
  searchPlaceholder: '搜索 Twin 会话…',
  clearSearch: '清除搜索',
  closeSearch: '收起搜索',
  empty: '暂未与 Twin 开过会话',
  noResults: '没有匹配的会话',
  sessionCount: '{count} 个会话',
};

const EN: TwinWorkCopy = {
  title: "Twin's work",
  newSession: 'New conversation',
  newSessionForTwin: 'New conversation with {name}',
  chooseTwin: 'Choose a Twin for the new conversation',
  search: 'Search conversations',
  searchPlaceholder: 'Search Twin conversations…',
  clearSearch: 'Clear search',
  closeSearch: 'Close search',
  empty: 'No conversations with your Twin yet',
  noResults: 'No conversations match your search',
  sessionCount: '{count} conversations',
};

/** Everything except the product name (kept bilingual by contract). */
export const TWIN_WORK_TITLE = "Twin's work";

const DECKS: Record<TwinWorkLanguage, TwinWorkCopy> = { zh: ZH, en: EN };

/** Normalizes the i18n service's language value (or anything else) to a deck key. */
export const normalizeTwinWorkLanguage = (language?: string | null): TwinWorkLanguage =>
  (language === 'en' ? 'en' : 'zh');

export const getTwinWorkCopy = (language?: string | null): TwinWorkCopy =>
  DECKS[normalizeTwinWorkLanguage(language)];

/** `{count}` interpolation for the count tooltip. */
export const formatTwinWorkCount = (copy: TwinWorkCopy, count: number): string =>
  copy.sessionCount.replace('{count}', String(count));

/** `{name}` interpolation for per-Twin labels. */
export const formatTwinWorkTwinName = (copy: TwinWorkCopy, name: string): string =>
  copy.newSessionForTwin.replace('{name}', name);
