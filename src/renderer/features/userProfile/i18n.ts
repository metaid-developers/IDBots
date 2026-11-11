/**
 * Local bilingual copy deck for the user profile page (`features/userProfile`).
 *
 * WHY IT LIVES HERE — same reason as `features/twinWork/i18n.ts`: the C line is
 * actively editing the global table in `services/i18n.ts` for the Studio /
 * BotWorks work, and two independent key blocks landing in that one file is a
 * guaranteed merge collision. This feature therefore carries its own zh + en
 * deck (both complete — no key exists in one language only) and reads it
 * directly. When the shared table settles, these keys fold into it in one pass
 * and this file becomes a thin re-export.
 *
 * Contract:
 *  - every line has a zh AND an en form;
 *  - existing global keys are never edited or shadowed here;
 *  - `{name}` / `{me}` / `{n}` are the only placeholders, and each is
 *    interpolated by a helper below (never string-concatenated at call sites).
 */

import React from 'react';
import { i18nService } from '../../services/i18n';

export type UserProfileLanguage = 'zh' | 'en';

export interface UserProfileCopy {
  /** Page title. */
  title: string;
  /** Back / close control on the page. */
  close: string;
  /** Accessible name of the top-left avatar entry. */
  avatarEntryLabel: string;
  /**
   * Tooltip/aria of the rail-top slot while the identity carries NO avatar:
   * the slot is an EXPLICIT reserved seat for the human user's NFT avatar
   * (总裁办侧栏微调批单 2026-11-09 12:23), not a plain button.
   */
  avatarSlotEmptyHint: string;
  /**
   * The VISIBLE label of the top-left entry pill — the literal 「User」 word
   * from the owner's 10:17 sketch, NOT the user's name (the name lives in the
   * tooltip; the pill reads the same for every identity).
   */
  entryLabel: string;
  /** Placeholder initial when the identity has no name yet. */
  unnamed: string;
  /** Identity is still loading. */
  loading: string;
  /** The identity IPC failed. */
  identityLoadFailed: string;
  /** No local identity has been created yet. */
  noIdentity: string;
  /**
   * Label of the identity card's daily-note slot (the retired wallet-address
   * line's place): twin 每日寄语 — today's twin note, or the local fallback.
   */
  dailyMessageLabel: string;

  /** Section heading: the account block extracted from Settings. */
  accountSectionTitle: string;
  accountSectionHint: string;

  /** Section heading: ME credits. */
  meSectionTitle: string;
  meTotal: string;
  meFrozen: string;
  meWeekly: string;
  meResetSoon: string;
  meResetInHours: string;
  meResetInDays: string;
  mePack: string;
  meUpgrade: string;
  meRecharge: string;
  meUsage: string;
  meRefresh: string;
  meLoadFailed: string;

  /** Settings placeholder card: the block moved to this page. */
  settingsMovedTitle: string;
  settingsMovedBody: string;
  settingsMovedOpen: string;
}

const ZH: UserProfileCopy = {
  title: '我的',
  close: '返回',
  avatarEntryLabel: '打开「我的」页',
  avatarSlotEmptyHint: '预留头像槽 · 放置你的 NFT 头像',
  entryLabel: '用户',
  unnamed: '未命名',
  loading: '读取中…',
  identityLoadFailed: '身份读取失败，稍后可重试',
  noIdentity: '尚未创建本地身份',
  dailyMessageLabel: 'twin 每日寄语',

  accountSectionTitle: '账户',
  accountSectionHint: '身份、助记词与链上资料都由本机持有；这里的每一条操作与设置里完全一致。',

  meSectionTitle: 'ME 积分',
  meTotal: '本周可用',
  meFrozen: '另冻结 {me} ME',
  meWeekly: '本周额度',
  meResetSoon: '即将重置',
  meResetInHours: '{n} 小时后重置',
  meResetInDays: '{n} 天后重置',
  mePack: '积分增量包',
  meUpgrade: '开通 / 升级套餐',
  meRecharge: '充值',
  meUsage: '用量明细',
  meRefresh: '刷新余额',
  meLoadFailed: '余额暂时取不到，稍后再试',

  settingsMovedTitle: '用户资料已迁到「我的」页',
  settingsMovedBody:
    '左上角头像现在直接打开「我的」页：本地身份、头像与 ME 积分都在那一页，数据和操作一条不少。这里保留的只是一个入口。',
  settingsMovedOpen: '打开「我的」页',
};

const EN: UserProfileCopy = {
  title: 'My profile',
  close: 'Back',
  avatarEntryLabel: 'Open my profile',
  avatarSlotEmptyHint: 'Reserved avatar slot · place your NFT avatar',
  entryLabel: 'User',
  unnamed: 'Unnamed',
  loading: 'Loading…',
  identityLoadFailed: 'Could not read the identity — try again shortly',
  noIdentity: 'No local identity yet',
  dailyMessageLabel: "Twin's daily note",

  accountSectionTitle: 'Account',
  accountSectionHint: 'The identity, its mnemonic and the on-chain profile stay on this machine; every action here is the same one Settings offered.',
  meSectionTitle: 'ME credits',
  meTotal: 'Available this week',
  meFrozen: '{me} ME frozen',
  meWeekly: 'This week',
  meResetSoon: 'Resets soon',
  meResetInHours: 'Resets in {n}h',
  meResetInDays: 'Resets in {n}d',
  mePack: 'Credit Pack',
  meUpgrade: 'Plans & upgrades',
  meRecharge: 'Top up',
  meUsage: 'Usage & credits',
  meRefresh: 'Refresh balance',
  meLoadFailed: 'The balance is unavailable right now — try again shortly',

  settingsMovedTitle: 'The profile moved to My profile',
  settingsMovedBody:
    'The avatar in the top-left corner now opens My profile: the local identity, its avatar and the ME credits live there, with every data point and action intact. What remains here is only the entry.',
  settingsMovedOpen: 'Open My profile',
};

const DECKS: Record<UserProfileLanguage, UserProfileCopy> = { zh: ZH, en: EN };

/** Normalizes anything to a deck key (English only when explicitly `en`). */
export const normalizeUserProfileLanguage = (language?: string | null): UserProfileLanguage =>
  (language === 'en' ? 'en' : 'zh');

/** The deck for a language; defaults to the app's current language. */
export const getUserProfileCopy = (language?: string | null): UserProfileCopy =>
  DECKS[normalizeUserProfileLanguage(language)];

/** `{me}` interpolation (frozen balance line). */
export const formatUserProfileFrozen = (copy: UserProfileCopy, me: string): string =>
  copy.meFrozen.replace('{me}', me);

/** `{n}` interpolation (weekly reset countdown). */
export const formatUserProfileCount = (template: string, n: number): string =>
  template.replace('{n}', String(n));

/**
 * Copy that re-renders on a language switch. The page is mounted outside the
 * Settings tree, so it cannot rely on a parent re-render to pick the new deck.
 */
export function useUserProfileCopy(): UserProfileCopy {
  const language = React.useSyncExternalStore(
    (listener) => i18nService.subscribe(listener),
    () => i18nService.getLanguage(),
    () => i18nService.getLanguage(),
  );
  return getUserProfileCopy(language);
}
