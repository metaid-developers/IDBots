import React, { useState } from 'react';
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../../services/i18n';
import { useOwnerMetaApps } from './useOwnerMetaApps';
import { getCardVisual, getStatePill, buildShareUrl, getOwnerEmptyState, formatRuntime, stripImageProcessParam } from './myAppsPresentation.js';
import ChainStatusModal from './ChainStatusModal';
import MetaAppPublishForm from './MetaAppPublishForm';
import MetaAppDetailModal from './MetaAppDetailModal';
import MetaAppDeleteModal from './MetaAppDeleteModal';
import type { OwnerMetaAppRecord } from '../../../types/metaAppOwner';

interface MyAppsTabProps {
  onRunByPin?: (pin: string) => Promise<boolean> | boolean;
}

const MyAppsTab: React.FC<MyAppsTabProps> = ({ onRunByPin }) => {
  const t = (k: string) => i18nService.t(k);
  const [botMenuOpen, setBotMenuOpen] = useState(false);
  const [toast, setToast] = useState('');
  const owner = useOwnerMetaApps();
  const modal = owner.modal;
  const empty = getOwnerEmptyState(t);

  const selectedBot = owner.bots.find((b) => b.id === owner.selectedBotId) || null;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  };

  // Copy arbitrary text to the clipboard with a toast confirmation (used by the copy-icon buttons).
  const copyValue = (value: string, confirmMsg: string) => {
    navigator.clipboard?.writeText(value).then(
      () => showToast(confirmMsg),
      () => showToast(value),
    );
  };

  // Share now opens a modal panel (set below) instead of copying a single URL immediately.
  const handleShare = (record: OwnerMetaAppRecord) => {
    owner.setShareRecord(record);
  };

  const handleRun = (record: OwnerMetaAppRecord) => {
    if (record.disabled) return;
    void onRunByPin?.(record.pinId);
  };

  const cardCls = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 overflow-hidden transition-colors hover:border-claude-accent/50 focus:outline-none focus:ring-2 focus:ring-claude-accent';

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">{t('myAppsHeading') || 'My Apps'}</h2>
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('myAppsDescription') || 'Manage the MetaApps published by your local Bots.'}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={owner.refresh} disabled={owner.loading || !selectedBot || !selectedBot?.mvcAddress}
            className="px-2.5 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50">
            {t('refresh') || 'Refresh'}
          </button>
          <button type="button" onClick={() => owner.setModal({ kind: 'publish' })} disabled={!selectedBot || !selectedBot.mvcAddress}
            className="btn-idchat-primary-filled px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60">
            {t('myAppsPublish') || 'Publish MetaApp'}
          </button>
        </div>
      </div>

      {/* bot filter */}
      {owner.bots.length > 0 ? (
        <div className="flex justify-center">
          <div className="relative w-full max-w-xs">
            <button type="button" onClick={() => setBotMenuOpen((v) => !v)}
              className="w-full flex items-center gap-2 rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border px-4 py-2 text-sm focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/40 cursor-pointer">
              {selectedBot?.avatar && (selectedBot.avatar.startsWith('data:') || selectedBot.avatar.startsWith('http')) ? (
                <img src={selectedBot.avatar} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
              ) : (
                <div className="w-6 h-6 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
                  <span className="text-[10px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
                    {(selectedBot?.name || '?').slice(0, 2)}
                  </span>
                </div>
              )}
              <span className="truncate flex-1 text-left dark:text-claude-darkText text-claude-text">{selectedBot?.name || (t('myAppsLocalBot') || 'Local Bot')}</span>
              <svg className={`h-4 w-4 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${botMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06z" clipRule="evenodd" />
              </svg>
            </button>
            {botMenuOpen ? (
              <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover z-50 overflow-hidden max-h-56 overflow-y-auto">
                {owner.bots.map((b) => (
                  <button key={b.id} type="button"
                    onClick={() => { owner.setSelectedBotId(b.id); setBotMenuOpen(false); }}
                    className={`w-full flex items-center gap-2 px-4 py-2 text-left text-sm hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${b.id === owner.selectedBotId ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50 text-claude-accent font-medium' : 'dark:text-claude-darkText text-claude-text'}`}>
                    {b.avatar && (b.avatar.startsWith('data:') || b.avatar.startsWith('http')) ? (
                      <img src={b.avatar} alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
                    ) : (
                      <div className="w-6 h-6 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-semibold dark:text-claude-darkText text-claude-text uppercase">{(b.name || '?').slice(0, 2)}</span>
                      </div>
                    )}
                    <span className="truncate flex-1">{b.name}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* notice */}
      {owner.notice ? (
        <div className="rounded-lg border border-amber-300 dark:border-amber-700/50 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {owner.notice}
        </div>
      ) : null}

      {/* empty states */}
      {!selectedBot && owner.bots.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{empty.noBot.title}</div>
          <div className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{empty.noBot.description}</div>
        </div>
      ) : selectedBot && !selectedBot.mvcAddress ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{empty.noMvc.title}</div>
          <div className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{empty.noMvc.description}</div>
        </div>
      ) : !owner.loading && owner.records.length === 0 ? (
        <div className="py-12 text-center">
          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{empty.noApps.title}</div>
          <div className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{empty.noApps.description}</div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {t('myAppsPublished') || 'Published MetaApps'} <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">({owner.records.length})</span>
            </h3>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(248px, 1fr))' }}>
            {owner.records.map((record) => {
              const visual = getCardVisual(record);
              const pill = getStatePill(record);
              return (
                <article key={record.pinId} tabIndex={0}
                  onClick={() => owner.setModal({ kind: 'detail', record })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); owner.setModal({ kind: 'detail', record }); } }}
                  className={cardCls}>
                  <div className="relative h-[126px] overflow-hidden">
                    {visual.cover ? (
                      <img src={visual.cover} alt="" loading="lazy" decoding="async"
                        className="absolute inset-0 h-full w-full object-cover"
                        onError={(e) => {
                          const el = e.currentTarget as HTMLImageElement;
                          // Processed variants can fail for pins the processor
                          // rejects; retry once against the original.
                          const original = stripImageProcessParam(el.src);
                          if (original && !el.dataset.retriedOriginal) {
                            el.dataset.retriedOriginal = '1';
                            el.src = original;
                            return;
                          }
                          // Swap to the placeholder if the cover fails to load.
                          el.style.display = 'none';
                          const ph = el.parentElement?.querySelector('[data-cover-placeholder]') as HTMLElement | null;
                          if (ph) ph.style.display = 'flex';
                        }} />
                    ) : null}
                    {/* Default cover placeholder — shown when there is no cover or the cover fails to load. */}
                    <div data-cover-placeholder style={{ display: visual.cover ? 'none' : 'flex' }}
                      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 dark:bg-claude-darkSurfaceHover bg-claude-surfaceMuted">
                      <svg className="h-9 w-9 text-claude-accent/55" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="3" y="3" width="18" height="18" rx="3" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="m21 15-5-5L5 21" />
                      </svg>
                      <span className="text-sm font-bold text-claude-accent/70">
                        {(record.appName || record.title || 'MA').slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div className="absolute left-2 bottom-2 h-10 w-10 rounded-lg overflow-hidden border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center shadow-sm">
                      {visual.icon ? (
                        <img src={visual.icon} alt="" loading="lazy" decoding="async"
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            const el = e.currentTarget as HTMLImageElement;
                            const original = stripImageProcessParam(el.src);
                            if (original && !el.dataset.retriedOriginal) {
                              el.dataset.retriedOriginal = '1';
                              el.src = original;
                              return;
                            }
                            el.style.visibility = 'hidden';
                          }} />
                      ) : (
                        <span className="text-xs font-semibold text-claude-accent">
                          {(record.appName || 'MA').slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    <span className={`absolute right-2 top-2 px-1.5 py-0.5 rounded text-[10px] font-medium ${pill.tone === 'warn' ? 'bg-amber-500/20 text-amber-600' : 'bg-emerald-500/20 text-emerald-600'}`}>
                      {t(pill.labelKey) || pill.label}
                    </span>
                  </div>
                  <div className="p-3 space-y-1.5">
                    <div>
                      <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate">{record.title || record.appName}</h3>
                      <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                        {[record.version, formatRuntime(record.runtime)].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </div>
                    {/* Pin id line with a copy-icon button (matches OAC apps-pin-line). */}
                    <div className="flex items-center gap-1">
                      <code className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary truncate" title={record.pinId}>{record.pinId}</code>
                      <button type="button"
                        onClick={(e) => { e.stopPropagation(); copyValue(record.pinId, t('myAppsPinCopied') || 'Pin ID copied'); }}
                        title={t('myAppsCopyPin') || 'Copy pin ID'}
                        aria-label={t('myAppsCopyPin') || 'Copy pin ID'}
                        className="shrink-0 p-0.5 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors">
                        <DocumentDuplicateIcon className="h-3 w-3" />
                      </button>
                    </div>
                    <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2">{record.intro || record.prompt}</p>
                    {record.tags && record.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {record.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent text-[10px] font-medium">{tag}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="flex items-center gap-1.5 pt-1">
                      <button type="button" onClick={(e) => { e.stopPropagation(); handleRun(record); }} disabled={record.disabled}
                        className="btn-idchat-primary-filled px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-60">
                        {t('run') || 'Run'}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); owner.setModal({ kind: 'edit', record }); }}
                        className="px-2 py-1 text-[11px] rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text">
                        {t('edit') || 'Edit'}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); handleShare(record); }}
                        className="px-2 py-1 text-[11px] rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text">
                        {t('share') || 'Share'}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {/* pagination — only render when there is actually more than one page to navigate.
              Hide it entirely when the current page is empty or there is no next page and we
              are on the first page (matches OAC: prev/next hidden unless navigable). */}
          {owner.records.length > 0 && (owner.cursorStack.length > 1 || owner.nextCursor) ? (
            <div className="flex items-center justify-center gap-3 pt-1">
              {owner.cursorStack.length > 1 ? (
                <button type="button" onClick={owner.goPrev}
                  className="px-2.5 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text">
                  ‹ {t('prev') || 'Prev'}
                </button>
              ) : null}
              <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {t('page') || 'Page'} {owner.cursorStack.length}
              </span>
              {owner.nextCursor ? (
                <button type="button" onClick={owner.goNext}
                  className="px-2.5 py-1 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text">
                  {t('next') || 'Next'} ›
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {/* toast */}
      {toast ? (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-lg dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border px-3 py-2 text-xs shadow-elevated dark:text-claude-darkText text-claude-text">
          {toast}
        </div>
      ) : null}

      {/* modals */}
      {modal.kind === 'publish' ? (
        <MetaAppPublishForm mode="publish" metabotId={owner.selectedBotId!} metabotName={selectedBot?.name}
          submitting={owner.submitting}
          onUploadError={(m) => owner.setNotice(m)}
          onSubmit={(manifest) => void owner.submitPublish(manifest)}
          onCancel={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'edit' ? (
        <MetaAppPublishForm mode="edit" metabotId={owner.selectedBotId!} metabotName={selectedBot?.name}
          record={modal.record} submitting={owner.submitting}
          onUploadError={(m) => owner.setNotice(m)}
          onSubmit={(manifest) => void owner.submitEdit(modal.record, manifest)}
          onCancel={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'detail' ? (
        <MetaAppDetailModal record={modal.record}
          onRun={() => handleRun(modal.record)}
          onEdit={() => owner.setModal({ kind: 'edit', record: modal.record })}
          onDelete={() => owner.setModal({ kind: 'delete', record: modal.record })}
          onShare={() => handleShare(modal.record)}
          onClose={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {modal.kind === 'delete' ? (
        <MetaAppDeleteModal record={modal.record} busy={owner.submitting}
          onConfirm={() => void owner.submitDelete(modal.record)}
          onCancel={() => owner.setModal({ kind: 'none' })} />
      ) : null}
      {owner.chainStatus ? (
        <ChainStatusModal status={owner.chainStatus.status} txids={owner.chainStatus.txids} error={owner.chainStatus.error}
          onClose={() => owner.setChainStatus(null)} />
      ) : null}
      {/* OAC-style share panel: two copyable URIs (MetaApp URI + Web URL). */}
      {owner.shareRecord ? (() => {
        const rec = owner.shareRecord;
        const metaappUri = rec.metaappUri || `metaapp://${rec.pinId}`;
        const webUrl = rec.shareWebUrl || buildShareUrl(rec.pinId);
        const shareRows: Array<[string, string]> = [
          [t('myAppsShareMetaappUri') || 'MetaApp URI', metaappUri],
          [t('myAppsShareWebUrl') || 'Web URL', webUrl],
        ];
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="w-full max-w-md mx-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl">
              <div className="px-5 py-3 border-b dark:border-claude-darkBorder border-claude-border flex items-center justify-between">
                <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">{t('myAppsShareTitle') || 'Share MetaApp'}</h3>
                <button type="button" onClick={() => owner.setShareRecord(null)} className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent">✕</button>
              </div>
              <div className="px-5 py-4 space-y-3">
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {t('myAppsShareDesc') || 'Copy either link to share this MetaApp.'}
                </p>
                {shareRows.map(([label, value]) => (
                  <div key={label}>
                    <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">{label}</div>
                    <div className="flex items-center gap-1.5">
                      <code className="flex-1 min-w-0 truncate text-[11px] dark:text-claude-darkText text-claude-text dark:bg-claude-darkBg bg-claude-bg border dark:border-claude-darkBorder border-claude-border rounded-lg px-2 py-1.5" title={value}>{value}</code>
                      <button type="button"
                        onClick={() => copyValue(value, t('myAppsShareCopied') || 'Copied')}
                        title={t('copy') || 'Copy'}
                        aria-label={t('copy') || 'Copy'}
                        className="shrink-0 p-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-accent dark:hover:text-claude-accent transition-colors">
                        <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t dark:border-claude-darkBorder border-claude-border flex justify-end">
                <button type="button" onClick={() => owner.setShareRecord(null)}
                  className="px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                  {t('close') || 'Close'}
                </button>
              </div>
            </div>
          </div>
        );
      })() : null}
    </div>
  );
};

export default MyAppsTab;
