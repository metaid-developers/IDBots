/**
 * MetaBot List Card
 * Displays MetaBot with role and goal. Wallet, backup and delete actions live
 * deeper — in the Advanced tab of the edit view (see MetaBotAdvancedActionsSection).
 */

import React from 'react';
import { ArrowPathIcon, CpuChipIcon, DocumentDuplicateIcon, GlobeAltIcon, MoonIcon } from '@heroicons/react/24/outline';
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
}

const MetaBotListCard: React.FC<MetaBotListCardProps> = ({
  metabot,
  onEdit,
  onToggleEnabled,
  isChainSynced,
  onSyncToChain,
  onOpenMetabotInBrowser,
  chainSyncState,
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
  // Main's merged state wins; the pin-id heuristic stays as the fallback for
  // lists that predate it. Never report synced without a confirmed pin.
  const isPartialSync = chainSyncState != null ? chainSyncState === 'partial' : !isChainSynced;

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
      className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 transition-colors hover:border-claude-accent/50 cursor-pointer text-left"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMetabotInBrowser?.(metabot);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
              }}
              className="rounded-xl transition hover:ring-2 hover:ring-claude-accent/40 focus:outline-none focus:ring-2 focus:ring-claude-accent/60"
              title="Open in Bot Browser"
              aria-label="Open in Bot Browser"
            >
              <NftAvatarFrame
                avatar={metabot.avatar}
                frameClassName="w-12 h-12 rounded-xl"
                alt=""
                fallback={(
                  <div className="w-12 h-12 rounded-xl dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center">
                    <CpuChipIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                  </div>
                )}
              />
            </button>
            {shortGlobalMetaId && (
              <div className="flex items-center gap-1 max-w-[136px] text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <span className="truncate">metaid:{shortGlobalMetaId}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyGlobalMetaId(globalMetaId);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                  }}
                  className="shrink-0 p-0.5 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  title={i18nService.t('metabotCopyGlobalMetaId')}
                  aria-label={i18nService.t('metabotCopyGlobalMetaId')}
                >
                  <DocumentDuplicateIcon className="h-3 w-3 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </button>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-base font-medium dark:text-claude-darkText text-claude-text truncate">
                {metabot.name}
              </span>
              {metabot.metabot_type === 'twin' && <TwinBadge />}
            </div>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate block">
              {metabot.role || '—'}
            </span>
          </div>
        </div>
        {metabot.dreaming && (
          <span
            className="inline-flex items-center justify-center text-claude-accent dark:text-claude-darkAccent shrink-0"
            title={i18nService.t('metabotDreaming')}
            aria-label={i18nService.t('metabotDreaming')}
          >
            <MoonIcon className="h-5 w-5 animate-pulse" aria-hidden />
          </span>
        )}
        {metabot.surfing && (
          <span
            className="inline-flex items-center justify-center text-sky-600 dark:text-sky-400 shrink-0"
            title={i18nService.t('surfBadgeLabel')}
            aria-label={i18nService.t('surfBadgeLabel')}
          >
            <GlobeAltIcon className="h-5 w-5 animate-pulse" aria-hidden />
          </span>
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
          <div
            className={enabledToggleView.knobClass}
          />
        </div>
      </div>

      {metabot.goal && (
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3 line-clamp-2">
          {metabot.goal}
        </p>
      )}

      {isPartialSync && (
        <div className="flex items-center justify-between gap-2">
          <span
            className="inline-flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400"
            title={i18nService.t('metabotChainSyncPartialHint')}
          >
            <span className="inline-block h-2 w-2 rounded-full bg-amber-500 shrink-0" aria-hidden />
            <span>{i18nService.t('metabotChainSyncPartialBadge')}</span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSyncToChain();
            }}
            className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 hover:underline shrink-0"
            title={i18nService.t('metabotChainSyncResyncNow')}
          >
            <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden />
            <span>{i18nService.t('metabotChainSyncResyncNow')}</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default MetaBotListCard;
