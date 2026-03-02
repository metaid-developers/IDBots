/**
 * MetaBot List Card
 * Displays MetaBot with async balance loading, copy address, role and goal.
 * Addresses are collapsed by default; delete button triggers safe-delete flow.
 */

import React, { useEffect, useState } from 'react';
import { CpuChipIcon, DocumentDuplicateIcon, TrashIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';

interface MetaBotListCardProps {
  metabot: Metabot;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
}

interface BalanceState {
  btc?: string;
  mvc?: string;
  doge?: string;
  loading: boolean;
}

const MetaBotListCard: React.FC<MetaBotListCardProps> = ({ metabot, onEdit, onToggleEnabled, onDelete }) => {
  const [balance, setBalance] = useState<BalanceState>({ loading: true });
  const [isAddressExpanded, setIsAddressExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBalance((prev) => ({ ...prev, loading: true }));

    window.electron.idbots
      .getAddressBalance({ metabotId: metabot.id })
      .then((res) => {
        if (cancelled || !res.success || !res.balance) return;
        setBalance({
          loading: false,
          btc: res.balance.btc != null ? `${res.balance.btc.value.toFixed(8)} ${res.balance.btc.unit}` : undefined,
          mvc: res.balance.mvc != null ? `${res.balance.mvc.value.toFixed(8)} ${res.balance.mvc.unit}` : undefined,
          doge: res.balance.doge != null ? `${res.balance.doge.value.toFixed(8)} ${res.balance.doge.unit}` : undefined,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setBalance({
            loading: false,
            btc: i18nService.t('metabotBalanceError'),
            mvc: i18nService.t('metabotBalanceError'),
            doge: i18nService.t('metabotBalanceError'),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [metabot.id]);

  const copyAddress = (addr: string) => {
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
    });
  };

  const formatShort = (addr: string) => {
    if (!addr || addr.length < 16) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
  };

  const btcAddr = metabot.btc_address ?? '';
  const mvcAddr = metabot.mvc_address ?? '';
  const dogeAddr = metabot.doge_address ?? '';

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
          {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
            <img
              src={metabot.avatar}
              alt=""
              className="w-12 h-12 rounded-xl object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-12 h-12 rounded-xl dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
              <CpuChipIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <span className="text-base font-medium dark:text-claude-darkText text-claude-text block truncate">
              {metabot.name}
            </span>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate block">
              {metabot.role || '—'}
            </span>
          </div>
        </div>
        <div
          className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
            metabot.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled(!metabot.enabled);
          }}
          role="switch"
          aria-checked={metabot.enabled}
          title={metabot.enabled ? i18nService.t('metabotActive') : i18nService.t('metabotInactive')}
        >
          <div
            className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
              metabot.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`}
          />
        </div>
      </div>

      {metabot.goal && (
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3 line-clamp-2">
          {metabot.goal}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsAddressExpanded((v) => !v);
          }}
          className="text-xs text-claude-accent hover:underline"
        >
          {isAddressExpanded ? i18nService.t('metabotHideAddresses') : i18nService.t('metabotShowAddresses')}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-sm text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors"
          title={i18nService.t('metabotDelete')}
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

      {isAddressExpanded && (
      <div className="space-y-2 mt-2">
        {btcAddr && (
          <div className="flex items-center gap-2 text-xs">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-8 shrink-0">BTC</span>
            <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
              {formatShort(btcAddr)}
            </code>
            <span className="shrink-0 dark:text-claude-darkText text-claude-text">
              {balance.loading ? i18nService.t('metabotBalanceLoading') : balance.btc ?? '0.00'}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copyAddress(btcAddr);
              }}
              className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              title={i18nService.t('metabotCopyAddress')}
            >
              <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            </button>
          </div>
        )}
        {mvcAddr && (
          <div className="flex items-center gap-2 text-xs">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-8 shrink-0">MVC</span>
            <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
              {formatShort(mvcAddr)}
            </code>
            <span className="shrink-0 dark:text-claude-darkText text-claude-text">
              {balance.loading ? i18nService.t('metabotBalanceLoading') : balance.mvc ?? '0.00'}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copyAddress(mvcAddr);
              }}
              className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              title={i18nService.t('metabotCopyAddress')}
            >
              <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            </button>
          </div>
        )}
        {dogeAddr && (
          <div className="flex items-center gap-2 text-xs">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-8 shrink-0">DOGE</span>
            <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
              {formatShort(dogeAddr)}
            </code>
            <span className="shrink-0 dark:text-claude-darkText text-claude-text">
              {balance.loading ? i18nService.t('metabotBalanceLoading') : balance.doge ?? '0.00'}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                copyAddress(dogeAddr);
              }}
              className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              title={i18nService.t('metabotCopyAddress')}
            >
              <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            </button>
          </div>
        )}
      </div>
      )}
    </div>
  );
};

export default MetaBotListCard;
