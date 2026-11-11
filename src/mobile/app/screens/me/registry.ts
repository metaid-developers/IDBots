import type { ComponentType } from 'react';
import {
  ChartBarIcon,
  ChatBubbleLeftEllipsisIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  InformationCircleIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { t } from '../../../i18n';

export type MeRoute =
  | 'profile'
  | 'usage'
  | 'bots'
  | 'nfts'
  | 'weixinBind'
  | 'skills'
  | 'memory'
  | 'general'
  | 'account'
  | 'about';

export type MeEntryGroup = 'bots' | 'general' | 'account';

export interface MeEntrySummaryInput {
  botCount: number | null;
  skillsEnabledCount: number | null;
  memoryEnabled: boolean | null;
  languageLabel: string | null;
  themeLabel: string | null;
  appVersion: string | null;
  meTotal: number | null;
}

export interface MeEntry {
  id: MeRoute;
  group: MeEntryGroup;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  titleKey: string;
  testId: string;
  summary?: (input: MeEntrySummaryInput) => string | null;
  danger?: boolean;
}

export const ME_ENTRIES: readonly MeEntry[] = [
  {
    id: 'bots',
    group: 'bots',
    icon: CpuChipIcon,
    titleKey: 'mobile.me.entry.bots',
    testId: 'me-entry-bots',
    summary: (input) =>
      input.botCount === null ? null : t('mobile.me.summary.botsCount', { count: input.botCount }),
  },
  {
    id: 'nfts',
    group: 'bots',
    icon: Squares2X2Icon,
    titleKey: 'mobile.nfts.title',
    testId: 'me-entry-nfts',
  },
  {
    id: 'weixinBind',
    group: 'bots',
    icon: ChatBubbleLeftEllipsisIcon,
    titleKey: 'mobile.me.entry.weixinBind',
    testId: 'me-entry-weixin-bind',
  },
  {
    id: 'usage',
    group: 'general',
    icon: ChartBarIcon,
    titleKey: 'mobile.me.entry.usage',
    testId: 'me-entry-usage',
    summary: (input) =>
      input.meTotal === null
        ? null
        : t('mobile.me.summary.meTotal', { me: new Intl.NumberFormat().format(input.meTotal) }),
  },
  {
    id: 'skills',
    group: 'general',
    icon: PuzzlePieceIcon,
    titleKey: 'mobile.me.entry.skills',
    testId: 'me-entry-skills',
    summary: (input) =>
      input.skillsEnabledCount === null
        ? null
        : t('mobile.me.summary.skillsEnabled', { count: input.skillsEnabledCount }),
  },
  {
    id: 'memory',
    group: 'general',
    icon: ChatBubbleLeftRightIcon,
    titleKey: 'mobile.me.entry.memory',
    testId: 'me-entry-memory',
    summary: (input) =>
      input.memoryEnabled === null
        ? null
        : t(input.memoryEnabled ? 'mobile.me.summary.memoryOn' : 'mobile.me.summary.memoryOff'),
  },
  {
    id: 'general',
    group: 'general',
    icon: Cog6ToothIcon,
    titleKey: 'mobile.me.entry.general',
    testId: 'me-entry-general',
    summary: (input) =>
      input.languageLabel && input.themeLabel
        ? t('mobile.me.summary.generalCombo', { language: input.languageLabel, theme: input.themeLabel })
        : null,
  },
  {
    id: 'account',
    group: 'account',
    icon: ShieldCheckIcon,
    titleKey: 'mobile.me.entry.account',
    testId: 'me-entry-account',
  },
  {
    id: 'about',
    group: 'account',
    icon: InformationCircleIcon,
    titleKey: 'mobile.me.entry.about',
    testId: 'me-entry-about',
    summary: (input) => input.appVersion,
  },
];

export const ME_ENTRY_GROUPS: ReadonlyArray<{ group: MeEntryGroup; titleKey: string | null }> = [
  { group: 'bots', titleKey: null },
  { group: 'general', titleKey: 'mobile.me.group.general' },
  { group: 'account', titleKey: 'mobile.me.group.account' },
];

export function meEntriesForGroup(group: MeEntryGroup): MeEntry[] {
  return ME_ENTRIES.filter((entry) => entry.group === group);
}
