import React, { useState } from 'react';
import { i18nService } from '../../../services/i18n';
import type { OwnerMetaAppRecord } from '../../../types/metaAppOwner';
import { resolveImageUrl, formatRuntime } from './myAppsPresentation.js';

interface MetaAppDetailModalProps {
  record: OwnerMetaAppRecord;
  onRun?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  onClose?: () => void;
}

const MetaAppDetailModal: React.FC<MetaAppDetailModalProps> = ({ record, onRun, onEdit, onDelete, onShare, onClose }) => {
  const t = (k: string) => i18nService.t(k);
  const [showRaw, setShowRaw] = useState(false);
  const iconSrc = resolveImageUrl(record.icon);
  const shots = [record.coverImg, ...record.introImgs].map(resolveImageUrl).filter(Boolean);
  const paddedShots = shots.length >= 3 ? shots : [...shots, ...Array(3 - shots.length).fill(null)];

  const fields: Array<[string, string]> = [
    ['title', record.title], ['appName', record.appName],
    ['prompt', record.prompt || ''], ['intro', record.intro || ''],
    ['icon', record.icon || ''], ['coverImg', record.coverImg || ''],
    ['runtime', formatRuntime(record.runtime)], ['version', record.version],
    ['contentType', record.contentType], ['indexFile', record.indexFile || ''],
    ['content', record.content || ''], ['code', record.code || ''],
    ['contentHash', record.contentHash || ''], ['codeType', record.codeType || ''],
    ['disabled', String(record.disabled)], ['tags', record.tags.join(', ')],
    ['pinId', record.pinId], ['firstPinId', record.firstPinId],
    ['operation', record.operation], ['ownerAddress', record.ownerAddress],
    ['txid', record.txid || ''], ['txids', record.txids.join(', ')],
    ['updatedAt', record.timestamp ? new Date(record.timestamp).toISOString() : ''],
  ];

  const btnBase = 'px-2.5 py-1 text-xs rounded-[var(--shape-radius-md)] border transition-colors';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl mx-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-start gap-3 px-5 py-4 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="h-16 w-16 shrink-0 rounded-xl overflow-hidden border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg flex items-center justify-center">
            {iconSrc ? (
              <img src={iconSrc} alt="" className="h-full w-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
            ) : (
              <span className="text-lg font-semibold text-claude-accent">{(record.appName || 'MA').slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">{record.title || record.appName}</h3>
            <p className="mt-0.5 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2">{record.prompt || record.intro}</p>
            {record.tags.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {record.tags.slice(0, 8).map((tag) => (
                  <span key={tag} className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent text-[10px] font-medium">{tag}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={onRun} disabled={record.disabled}
              className="px-2.5 py-1 text-xs rounded-[var(--shape-radius-md)] border border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9] disabled:opacity-40">
              {t('run') || 'Run'}
            </button>
            <button type="button" onClick={onShare} className={`${btnBase} dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text`}>
              {t('share') || 'Share'}
            </button>
            <button type="button" onClick={onEdit} className={`${btnBase} dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text`}>
              {t('edit') || 'Edit'}
            </button>
            <button type="button" onClick={onDelete} className={`${btnBase} border-red-300 text-red-600 hover:bg-red-50 dark:border-red-900/50`}>
              {t('delete') || 'Delete'}
            </button>
            <button type="button" onClick={onClose} className="ml-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent">✕</button>
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          {shots.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 mb-4">
              {paddedShots.map((src, i) => (
                <div key={i} className="aspect-video rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg">
                  {src ? <img src={src} alt="" className="h-full w-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} /> : null}
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {fields.filter(([, v]) => v).map(([label, value]) => (
              <div key={label} className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">{label}</div>
                <div className="text-xs dark:text-claude-darkText text-claude-text break-all">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <button type="button" onClick={() => setShowRaw((v) => !v)} className="text-xs text-claude-accent hover:underline">
              {showRaw ? (t('hideRaw') || 'Hide raw') : (t('showRaw') || 'Show raw')}
            </button>
            {showRaw ? (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg p-2 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {JSON.stringify(record.raw ?? record, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaAppDetailModal;
