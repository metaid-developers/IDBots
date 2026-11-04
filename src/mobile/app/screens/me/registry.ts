import type { ComponentType } from 'react';
import {
  ChartBarIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  InformationCircleIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import { t } from '../../../i18n';

/**
 * Me-page entry registry (A6 settings IA rework, IA-PLAN v1 §2.4).
 *
 * The primary Me page renders its entry list FROM this table. S9 replaced the
 * old traffic page with the merged Usage & credits page (`usage`), which is now a
 * registry row AND the hero card's bottom link.
 *
 * `profile` is NOT a registry row: it is reached through the user card
 * (IA-PLAN §2.1). It still shares the MeRoute stack with the rows below.
 */

export type MeRoute =
  | 'profile'
  | 'usage'
  | 'bots'
  | 'skills'
  | 'memory'
  | 'general'
  | 'account'
  | 'about';

export type MeEntryGroup = 'bots' | 'general' | 'account';

/** Everything a summary renderer may need, gathered by the Me screen. */
export interface MeEntrySummaryInput {
  botCount: number | null;
  skillsEnabledCount: number | null;
  memoryEnabled: boolean | null;
  languageLabel: string | null;
  themeLabel: string | null;
  appVersion: string | null;
  /** Merged ME balance in whole ME, or null while the ledger is unavailable. */
  meTotal: number | null;
}

export interface MeEntry {
  id: MeRoute;
  group: MeEntryGroup;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;
  /** i18n key of the row title (also the secondary page title). */
  titleKey: string;
  testId: string;
  /** Right-side value summary; null (or missing) renders no summary. */
  summary?: (input: MeEntrySummaryInput) => string | null;
  /** Reserved for red rows (IA-PLAN §2.4); no current entry uses it. */
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

/** Group order + titles for the registry renderer (IA-PLAN §4.1). */
export const ME_ENTRY_GROUPS: ReadonlyArray<{ group: MeEntryGroup; titleKey: string | null }> = [
  // The bots group has no visible heading (single "My Bots" row on top).
  { group: 'bots', titleKey: null },
  { group: 'general', titleKey: 'mobile.me.group.general' },
  { group: 'account', titleKey: 'mobile.me.group.account' },
];

export function meEntriesForGroup(group: MeEntryGroup): MeEntry[] {
  return ME_ENTRIES.filter((entry) => entry.group === group);
}
