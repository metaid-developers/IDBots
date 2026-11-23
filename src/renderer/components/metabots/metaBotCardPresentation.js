function compact(parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Twin identity is scarce and sticky. Show the Twin switch when:
 * - this bot already is the Twin (so the user can turn that identity off), or
 * - this bot is a Worker and no other Twin exists yet.
 * The Welcome Bot never shows the switch and can never become Twin.
 */
export function canShowMetabotTwinSwitch({ metabotType, hasOtherTwin }) {
  if (metabotType === 'welcome') return false;
  if (metabotType === 'twin') return true;
  return !hasOtherTwin;
}

export function buildMetaBotToggleViewModel({ enabled, variant = 'enable', disabled = false }) {
  void variant;
  const trackClass = compact([
    'w-[34px] h-[19px] p-[2px]',
    'rounded-full inline-flex items-center transition-colors flex-shrink-0',
    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
    enabled
      ? 'bg-claude-accent'
      : 'bg-slate-300 dark:bg-white/[0.16]',
  ]);

  const knobClass = compact([
    'w-[15px] h-[15px]',
    'rounded-full shadow-sm transform transition-transform duration-150',
    enabled
      ? 'translate-x-[15px] bg-[#24210c]'
      : 'translate-x-0 bg-white',
  ]);

  return {
    trackClass,
    knobClass,
  };
}

export function formatGlobalMetaIdShort(globalMetaId) {
  const value = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!value) return '';
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export async function copyGlobalMetaIdToClipboard(globalMetaId, clipboard) {
  const value = typeof globalMetaId === 'string' ? globalMetaId.trim() : '';
  if (!value || !clipboard?.writeText) return false;
  await clipboard.writeText(value);
  return true;
}

/**
 * Shared Studio Linear (Style B) grouped settings tokens across My Bots & Edit MetaBot tabs.
 */
export const METABOT_GROUP_LABEL_ROW_CLASS =
  'flex items-center justify-between gap-3 px-0.5 mb-1.5';

export const METABOT_GROUP_LABEL_CLASS =
  'text-[11.5px] font-bold tracking-[0.03em] text-[#5a6577] dark:text-[#94a3b8]';

export const METABOT_GROUP_NOTE_CLASS =
  'text-[11px] text-[#8c96a6] dark:text-[#64748b]';

export const METABOT_GROUP_BOX_CLASS =
  'rounded-[10px] border border-slate-900/[0.095] dark:border-white/[0.085] bg-white dark:bg-[#182538] divide-y divide-slate-900/[0.065] dark:divide-white/[0.065]';

export const METABOT_GROUP_ROW_CLASS =
  'px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4';

export const METABOT_GROUP_ROW_TOP_CLASS =
  'px-4 py-3.5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4';

export const METABOT_ROW_TITLE_CLASS =
  'text-[13.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8] flex flex-wrap items-center gap-1.5';

export const METABOT_ROW_HINT_CLASS =
  'text-[12px] leading-[1.42] text-[#5a6577] dark:text-[#94a3b8] mt-0.5';

export const METABOT_ROW_ICON_CLASS =
  'h-[18px] w-[18px] text-[#5a6577] dark:text-[#94a3b8] mt-0.5 shrink-0';

export const METABOT_MICRO_BADGE_CLASS =
  'inline-flex items-center rounded-[4px] bg-[#eef1f5] dark:bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[#5a6577] dark:text-[#94a3b8]';

export const METABOT_CLEAN_INPUT_CLASS =
  'w-full px-2.5 py-1.5 text-[13px] rounded-[7px] border border-slate-900/[0.095] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#131d2c] text-[#181d25] dark:text-[#f3f5f8] placeholder-[#8c96a6] dark:placeholder-[#64748b] focus:outline-none focus:border-claude-accent focus:ring-1 focus:ring-claude-accent disabled:opacity-50 disabled:cursor-not-allowed';

export const METABOT_COMPACT_SELECT_CLASS =
  'h-8 pl-2.5 pr-6 text-[12.5px] font-semibold rounded-[7px] border border-slate-900/[0.095] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#131d2c] text-[#181d25] dark:text-[#f3f5f8] focus:outline-none focus:border-claude-accent disabled:opacity-45 disabled:cursor-not-allowed';

export const METABOT_BTN_FLAT_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[12px] font-semibold rounded-[7px] border border-slate-900/[0.095] dark:border-white/[0.09] bg-transparent text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.06] hover:border-slate-900/[0.18] dark:hover:border-white/[0.17] active:scale-[0.96] transition-[background-color,border-color,transform] duration-150 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap';

export const METABOT_BTN_PRIMARY_CLASS =
  'inline-flex h-[34px] shrink-0 items-center justify-center gap-1.5 px-3.5 text-[12.5px] font-bold rounded-[8px] border border-black/[0.12] bg-[#FFDC51] hover:bg-[#ffe474] text-[#24210c] active:scale-[0.96] transition-[background-color,transform] duration-150 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap';

export const METABOT_BTN_DANGER_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 px-3 text-[12px] font-semibold rounded-[7px] border border-rose-500/35 text-red-600 dark:text-rose-400 hover:bg-rose-500/10 active:scale-[0.96] transition-[background-color,transform] duration-150 disabled:opacity-45 disabled:cursor-not-allowed whitespace-nowrap';
