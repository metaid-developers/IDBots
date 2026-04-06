import React from 'react';
import type { GigSquareService } from '../../types/gigSquare';
import { formatGigSquarePrice } from '../../utils/gigSquare';
import { DEFAULT_GIG_SQUARE_PROVIDER_AVATAR } from './gigSquareProviderPresentation.js';

interface GigSquareServiceCardProps {
  service: GigSquareService;
  providerName: string;
  providerAvatarSrc: string;
  providerLookupId?: string | null;
  providerIdRow?: React.ReactNode;
  isOnline: boolean;
  hasRefundRisk?: boolean;
  refundRiskLabel?: string | null;
  actionLabel?: string;
  onOpen: () => void;
}

const GigSquareServiceCard: React.FC<GigSquareServiceCardProps> = ({
  service,
  providerName,
  providerAvatarSrc,
  providerLookupId,
  providerIdRow = null,
  isOnline,
  hasRefundRisk = false,
  refundRiskLabel = null,
  actionLabel = 'Open',
  onOpen,
}) => {
  const price = formatGigSquarePrice(service.price, service.currency);
  const iconSrc = service.serviceIcon || service.avatar || null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`cursor-pointer rounded-2xl border px-4 py-4 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${
        hasRefundRisk
          ? 'border-amber-400/60 bg-[var(--bg-panel)] dark:bg-claude-darkSurface'
          : 'border-claude-border bg-[var(--bg-panel)] dark:border-claude-darkBorder dark:bg-claude-darkSurface'
      }`}
    >
      <div className="flex items-start gap-3">
        {iconSrc ? (
          <img
            src={iconSrc}
            alt={service.displayName}
            className="h-14 w-14 flex-shrink-0 rounded-xl border border-claude-border object-cover dark:border-claude-darkBorder"
          />
        ) : (
          <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-claude-accent/20 text-sm font-semibold text-claude-accent">
            {service.displayName.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div
            data-slot="gig-square-card-title"
            className="text-[15px] font-semibold text-claude-text dark:text-claude-darkText"
          >
            {service.displayName}
          </div>
          <div
            data-slot="gig-square-card-meta-row"
            className="mt-1 flex items-center justify-between gap-3"
          >
            <div className="truncate font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {service.serviceName}
            </div>
            <div
              data-slot="gig-square-card-price"
              className="shrink-0 inline-flex items-baseline gap-1.5 text-claude-accent"
            >
              <span className="text-base font-semibold">{price.amount}</span>
              <span className="text-[11px] font-medium uppercase tracking-wide">{price.unit}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {service.providerSkill && (
              <span className="rounded-full bg-claude-surfaceMuted px-2 py-0.5 text-[11px] font-medium text-claude-textSecondary dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
                {service.providerSkill}
              </span>
            )}
            {refundRiskLabel && (
              <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                {refundRiskLabel}
              </span>
            )}
          </div>
          <div className="mt-2 line-clamp-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {service.description}
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-claude-border/70 pt-3 dark:border-claude-darkBorder/70">
        <div className="min-w-0 flex items-center gap-2">
          {isOnline && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-green-400" />
          )}
          <img
            src={providerAvatarSrc}
            alt={providerName}
            className="h-7 w-7 flex-shrink-0 rounded-full border border-claude-border object-cover dark:border-claude-darkBorder"
            onError={(event) => { event.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
          />
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-claude-text dark:text-claude-darkText">
              {providerName}
            </div>
            {providerLookupId && providerIdRow}
          </div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="btn-idchat-primary-filled shrink-0 whitespace-nowrap px-3 py-1.5 text-[11px] font-medium"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
};

export default GigSquareServiceCard;
