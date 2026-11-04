/**
 * TradeActivityBadge — the S4 chat trade marker shared by the session list
 * and the message surfaces (CoWork bubbles, A2A private chat, group-task
 * transcripts).
 *
 * Two kinds, visually distinct, same pill family as the NftCard action badges
 * (NftCard.tsx ACTION_BADGE_CLASS):
 *   'p2p'    — sky, crossed arrows: contract sale/listing and direct
 *              transfers (peer-to-peer trade activity).
 *   'escrow' — amber, shield: three-party escrow activity.
 *
 * Variants:
 *   'icon' — session-list row: icon-only pill with a title tooltip (the row
 *           has no room for text).
 *   'chip' — message meta rows: icon + short label with the same tooltip.
 *
 * Display-only; the kind is computed once upstream (store column for
 * sessions, detectTradeActivity for messages) and never re-derived here.
 */

import React from 'react';
import { ArrowsRightLeftIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { TradeBadgeKind } from './tradeActivity';

const TRADE_BADGE_LABEL_KEY: Record<TradeBadgeKind, string> = {
  p2p: 'tradeBadgeP2PLabel',
  escrow: 'tradeBadgeEscrowLabel',
};

const TRADE_BADGE_TOOLTIP_KEY: Record<TradeBadgeKind, string> = {
  p2p: 'tradeBadgeP2PTooltip',
  escrow: 'tradeBadgeEscrowTooltip',
};

/** Same pill palette family as the NftCard action badges. */
const TRADE_BADGE_PILL_CLASS: Record<TradeBadgeKind, string> = {
  p2p: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  escrow: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

const TradeBadgeIcon: React.FC<{ kind: TradeBadgeKind }> = ({ kind }) => (
  kind === 'escrow'
    ? <ShieldCheckIcon className="h-3 w-3 shrink-0" aria-hidden />
    : <ArrowsRightLeftIcon className="h-3 w-3 shrink-0" aria-hidden />
);

export interface TradeActivityBadgeProps {
  kind: TradeBadgeKind;
  /** 'icon' = session row (icon-only + tooltip); 'chip' = message meta row (icon + label). */
  variant?: 'icon' | 'chip';
  className?: string;
}

const TradeActivityBadge: React.FC<TradeActivityBadgeProps> = ({
  kind,
  variant = 'chip',
  className = '',
}) => {
  const tooltip = i18nService.t(TRADE_BADGE_TOOLTIP_KEY[kind]);
  const pill = `inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-medium leading-none ${TRADE_BADGE_PILL_CLASS[kind]}`;
  const title = variant === 'icon' ? tooltip : `${i18nService.t(TRADE_BADGE_LABEL_KEY[kind])} · ${tooltip}`;
  if (variant === 'icon') {
    return (
      <span className={`${pill} ${className}`} title={tooltip}>
        <TradeBadgeIcon kind={kind} />
      </span>
    );
  }
  return (
    <span className={`${pill} ${className}`} title={title}>
      <TradeBadgeIcon kind={kind} />
      <span>{i18nService.t(TRADE_BADGE_LABEL_KEY[kind])}</span>
    </span>
  );
};

export default TradeActivityBadge;
