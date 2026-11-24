/**
 * MetaBot List Card (Studio Linear Style B)
 * Supports two harmonious layouts:
 * - `twinStrip`: Full-width flagship banner for the single Twin Bot with a 3px brand-yellow edge bar.
 * - `tile` (default): Crisp 2-column architectural tile with locked vertical rhythm and hairline footer.
 */

import React from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  CpuChipIcon,
  DocumentDuplicateIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import TwinBadge from './TwinBadge';
import NftAvatarFrame from './NftAvatarFrame';
import {
  buildMetaBotToggleViewModel,
  copyGlobalMetaIdToClipboard,
  formatGlobalMetaIdShort,
} from './metaBotCardPresentation.js';

interface MetaBotListCardProps {
  metabot: Metabot;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  isChainSynced: boolean;
  onSyncToChain: () => void;
  onOpenMetabotInBrowser?: (metabot: Metabot) => void;
  /**
   * Chain-honest sync state merged by main (metabot:list). When present it
   * wins over the legacy isChainSynced pin-id heuristic; 'partial' means the
   * on-chain identity is registered but some info pins are still unpublished.
   */
  chainSyncState?: 'synced' | 'partial';
  variant?: 'twinStrip' | 'tile';
}

const MetaBotListCard: React.FC<MetaBotListCardProps> = ({
  metabot,
  onEdit,
  onToggleEnabled,
  isChainSynced,
  onSyncToChain,
  onOpenMetabotInBrowser,
  chainSyncState,
  variant = 'tile',
}) => {
  const copyGlobalMetaId = (globalMetaId: string) => {
    copyGlobalMetaIdToClipboard(globalMetaId, navigator.clipboard).then((didCopy: boolean) => {
      if (!didCopy) return;
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotGlobalMetaIdCopied') }));
    });
  };

  const globalMetaId = metabot.globalmetaid?.trim() ?? '';
  const shortGlobalMetaId = formatGlobalMetaIdShort(globalMetaId);
  const enabledToggleView = buildMetaBotToggleViewModel({
    enabled: metabot.enabled,
    variant: 'enable',
  });
  const isPartialSync = chainSyncState != null ? chainSyncState === 'partial' : !isChainSynced;
  const brainLabel = metabot.llm_id?.trim() || i18nService.t('metabotPrimaryLlmFollowGlobalEmpty');

  const renderActivityBadges = () => (
    <>
      {metabot.surfing && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-[5px] bg-sky-500/12 px-1.5 py-0.5 text-[10.5px] font-bold leading-3 text-sky-600 dark:text-sky-400"
          title={i18nService.t('surfBadgeLabel')}
          aria-label={i18nService.t('surfBadgeLabel')}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden />
          <span>{i18nService.t('surfBadgeLabel')}</span>
        </span>
      )}
      {metabot.dreaming && (
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded-[5px] bg-amber-500/12 px-1.5 py-0.5 text-[10.5px] font-bold leading-3 text-amber-700 dark:text-amber-400"
          title={i18nService.t('metabotDreaming')}
          aria-label={i18nService.t('metabotDreaming')}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" aria-hidden />
          <span>{i18nService.t('metabotDreamingShort')}</span>
        </span>
      )}
    </>
  );

  const renderSyncBadge = () => {
    if (isPartialSync) {
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSyncToChain();
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-[5px] bg-amber-500/12 px-2 py-0.5 text-[11px] font-bold text-amber-700 dark:text-amber-400 hover:brightness-110 active:scale-[0.96] transition-[filter,transform]"
          title={i18nService.t('metabotChainSyncPartialHint')}
        >
          <span>{i18nService.t('metabotChainSyncPartialShort')} · {i18nService.t('metabotChainSyncResyncShort')}</span>
          <ArrowPathIcon className="h-3 w-3" aria-hidden />
        </button>
      );
    }
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-semibold text-[#0f9d68] dark:text-[#34d399]">
        <CheckIcon className="h-3.5 w-3.5 stroke-[2.2]" aria-hidden />
        <span>{i18nService.t('metabotChainSyncedBadge')}</span>
      </span>
    );
  };

  if (variant === 'twinStrip') {
    const roleAndGoal = [metabot.role?.trim(), metabot.goal?.trim()].filter(Boolean).join(' — ');
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onEdit();
          }
        }}
        className={`relative rounded-[12px] border border-slate-900/[0.095] dark:border-white/[0.085] bg-white dark:bg-[#182538] hover:bg-[#fafbfc] dark:hover:bg-[#1d2c42] hover:border-slate-900/[0.18] dark:hover:border-white/[0.17] px-[18px] py-4 flex items-center justify-between gap-4 cursor-pointer text-left transition-colors ${
          !metabot.enabled ? 'opacity-65' : ''
        }`}
      >
        <span
          aria-hidden
          className="absolute left-[-1px] top-3.5 bottom-3.5 w-[3px] rounded-full bg-claude-accent"
        />

        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMetabotInBrowser?.(metabot);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="rounded-[10px] shrink-0 transition-transform active:scale-[0.96] focus:outline-none focus:ring-2 focus:ring-claude-accent/60"
            title="Open in Bot Browser"
            aria-label="Open in Bot Browser"
          >
            <NftAvatarFrame
              avatar={metabot.avatar}
              fallbackSource={metabot.avatar_fallback}
              frameClassName="w-[52px] h-[52px] rounded-[10px] ring-1 ring-black/[0.08] dark:ring-white/[0.1]"
              alt=""
              fallback={(
                <div className="w-[52px] h-[52px] rounded-[10px] bg-[#eef1f5] dark:bg-white/[0.05] ring-1 ring-black/[0.08] dark:ring-white/[0.1] flex items-center justify-center">
                  <CpuChipIcon className="h-6 w-6 text-[#5a6577] dark:text-[#94a3b8]" />
                </div>
              )}
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="text-[15.5px] font-bold tracking-[-0.01em] text-[#181d25] dark:text-[#f3f5f8] truncate">
                {metabot.name}
              </span>
              {metabot.metabot_type === 'twin' && <TwinBadge />}
              {renderActivityBadges()}
            </div>

            <p className="mt-1 text-[12.5px] text-[#5a6577] dark:text-[#94a3b8] truncate">
              {roleAndGoal || '—'}
            </p>

            <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px] text-[#8c96a6] dark:text-[#64748b]">
              {shortGlobalMetaId && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyGlobalMetaId(globalMetaId);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 font-mono tabular-nums text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8] transition-colors"
                    title={i18nService.t('metabotCopyGlobalMetaId')}
                    aria-label={i18nService.t('metabotCopyGlobalMetaId')}
                  >
                    <span>metaid:{shortGlobalMetaId}</span>
                    <DocumentDuplicateIcon className="h-3 w-3 shrink-0" />
                  </button>
                  <span aria-hidden>·</span>
                </>
              )}
              <span className="truncate max-w-[180px]">{brainLabel}</span>
              <span aria-hidden>·</span>
              {renderSyncBadge()}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {onOpenMetabotInBrowser && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMetabotInBrowser(metabot);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              className="h-8 w-8 rounded-[8px] border border-slate-900/[0.095] dark:border-white/[0.085] inline-flex items-center justify-center text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.05] hover:border-slate-900/[0.18] dark:hover:border-white/[0.17] active:scale-[0.96] transition-[color,background-color,border-color,transform]"
              title={i18nService.t('metabotHomepageView')}
              aria-label={i18nService.t('metabotHomepageView')}
            >
              <ArrowTopRightOnSquareIcon className="h-4 w-4" />
            </button>
          )}
          <div
            className={enabledToggleView.trackClass}
            onClick={(e) => {
              e.stopPropagation();
              onToggleEnabled(!metabot.enabled);
            }}
            role="switch"
            aria-checked={metabot.enabled}
            title={metabot.enabled ? i18nService.t('metabotActive') : i18nService.t('metabotInactive')}
          >
            <div className={enabledToggleView.knobClass} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
      className={`relative rounded-[10px] border border-slate-900/[0.095] dark:border-white/[0.085] bg-white dark:bg-[#182538] hover:bg-[#fafbfc] dark:hover:bg-[#1d2c42] hover:border-slate-900/[0.18] dark:hover:border-white/[0.17] px-4 py-3.5 flex flex-col justify-between gap-3 cursor-pointer text-left transition-colors ${
        !metabot.enabled ? 'opacity-65' : ''
      }`}
    >
      {isPartialSync && (
        <span
          aria-hidden
          className="absolute left-[-1px] top-3 bottom-3 w-[3px] rounded-full bg-amber-500 dark:bg-amber-400"
        />
      )}

      <div className="flex items-start justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenMetabotInBrowser?.(metabot);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="rounded-[9px] shrink-0 transition-transform active:scale-[0.96] focus:outline-none focus:ring-2 focus:ring-claude-accent/60"
            title="Open in Bot Browser"
            aria-label="Open in Bot Browser"
          >
            <NftAvatarFrame
              avatar={metabot.avatar}
              fallbackSource={metabot.avatar_fallback}
              frameClassName="w-[42px] h-[42px] rounded-[9px] ring-1 ring-black/[0.08] dark:ring-white/[0.1]"
              alt=""
              fallback={(
                <div className="w-[42px] h-[42px] rounded-[9px] bg-[#eef1f5] dark:bg-white/[0.05] ring-1 ring-black/[0.08] dark:ring-white/[0.1] flex items-center justify-center">
                  <CpuChipIcon className="h-5 w-5 text-[#5a6577] dark:text-[#94a3b8]" />
                </div>
              )}
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8] truncate">
                {metabot.name}
              </span>
              {metabot.metabot_type === 'twin' && <TwinBadge />}
              {renderActivityBadges()}
            </div>
            <span className="mt-0.5 text-[12px] text-[#5a6577] dark:text-[#94a3b8] truncate block">
              {metabot.role || '—'}
            </span>
          </div>
        </div>

        <div
          className={enabledToggleView.trackClass}
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled(!metabot.enabled);
          }}
          role="switch"
          aria-checked={metabot.enabled}
          title={metabot.enabled ? i18nService.t('metabotActive') : i18nService.t('metabotInactive')}
        >
          <div className={enabledToggleView.knobClass} />
        </div>
      </div>

      <p
        className={`m-0 text-[12px] leading-[1.48] min-h-[35px] line-clamp-2 ${
          metabot.goal?.trim()
            ? 'text-[#5a6577] dark:text-[#94a3b8]'
            : 'text-[#8c96a6] dark:text-[#64748b]'
        }`}
      >
        {metabot.goal?.trim() || i18nService.t('metabotGoalEmptyHint')}
      </p>

      <div className="pt-2.5 border-t border-slate-900/[0.06] dark:border-white/[0.06] flex items-center justify-between gap-2 text-[11.5px] text-[#8c96a6] dark:text-[#64748b]">
        <div className="flex items-center gap-2 min-w-0">
          {shortGlobalMetaId && (
            <>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  copyGlobalMetaId(globalMetaId);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 font-mono tabular-nums text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8] shrink-0 transition-colors"
                title={i18nService.t('metabotCopyGlobalMetaId')}
                aria-label={i18nService.t('metabotCopyGlobalMetaId')}
              >
                <span>{shortGlobalMetaId}</span>
                <DocumentDuplicateIcon className="h-3 w-3 shrink-0" />
              </button>
              <span aria-hidden>·</span>
            </>
          )}
          <span className="truncate">{brainLabel}</span>
        </div>

        <div className="shrink-0">
          {renderSyncBadge()}
        </div>
      </div>
    </div>
  );
};

export default MetaBotListCard;
