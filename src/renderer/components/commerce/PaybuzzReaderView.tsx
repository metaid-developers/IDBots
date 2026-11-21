import React, { useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import remarkGfm from 'remark-gfm';
import {
  BookOpenIcon,
  CheckBadgeIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { ct } from './commerceTradeI18n';

export const IDBOTS_PAYBUZZ_OPEN_READER_EVENT = 'idbots:paybuzz:openReader';

export interface PaybuzzReaderPayload {
  paybuzzPinId: string;
  title: string;
  authorMetaId?: string;
  authorName?: string;
  wordCount?: number;
  grantedVia: 'vip-nft' | 'token' | 'author';
  vipCollectionName?: string;
  decryptedMarkdown: string;
  unlockedAt?: number;
}

export interface PaybuzzReaderViewProps {
  open: boolean;
  article: PaybuzzReaderPayload | null;
  onClose: () => void;
}

export function dispatchOpenPaybuzzReader(payload: PaybuzzReaderPayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<PaybuzzReaderPayload>(IDBOTS_PAYBUZZ_OPEN_READER_EVENT, {
      detail: payload,
    }),
  );
}

const PaybuzzReaderView: React.FC<PaybuzzReaderViewProps> = ({ open, article, onClose }) => {
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open || !article) return null;

  const isVip = article.grantedVia === 'vip-nft';
  const isAuthor = article.grantedVia === 'author';

  const bannerText = isVip
    ? ct(
        article.vipCollectionName
          ? `Unlocked free with your VIP Member Card (${article.vipCollectionName})`
          : 'Unlocked free with your VIP Member Card',
        article.vipCollectionName
          ? `已凭你的会员权益卡（${article.vipCollectionName}）免费解锁`
          : '已凭你的会员权益卡免费解锁',
      )
    : isAuthor
      ? ct('Author preview (decrypted locally)', '作者本地密钥直接解密预览')
      : ct('Unlocked via Token Micropayment · Saved for offline reading', '已通过代币微支付解锁 · 已缓存支持离线重读');

  const shortPin =
    article.paybuzzPinId.length > 18
      ? `${article.paybuzzPinId.slice(0, 8)}…${article.paybuzzPinId.slice(-6)}`
      : article.paybuzzPinId;

  return (
    <div
      data-paybuzz-reader="open"
      data-paybuzz-pin-id={article.paybuzzPinId}
      data-granted-via={article.grantedVia}
      className="fixed inset-0 z-[90] flex justify-end bg-black/45 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label={article.title}
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-2xl flex-col border-l border-claude-border bg-claude-bg shadow-2xl dark:border-claude-darkBorder dark:bg-claude-darkBg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-claude-border bg-claude-surface px-5 py-4 dark:border-claude-darkBorder dark:bg-claude-darkSurface">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              <span className="inline-flex items-center gap-1 rounded-full bg-claude-accent/10 px-2 py-0.5 font-medium text-claude-accent">
                <BookOpenIcon className="h-3.5 w-3.5" />
                PayBuzz Reader
              </span>
              {article.authorName && (
                <span className="font-medium text-claude-text dark:text-claude-darkText">
                  {article.authorName}
                </span>
              )}
              {article.wordCount != null && article.wordCount > 0 && (
                <span>
                  {article.wordCount.toLocaleString()} {ct('words', '字')}
                </span>
              )}
              <span className="font-mono opacity-75">pin:{shortPin}</span>
            </div>
            <h2 className="mt-1.5 text-lg font-bold leading-snug text-claude-text dark:text-claude-darkText">
              {article.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={ct('Close reader', '关闭阅读器')}
            className="rounded-lg p-1.5 text-claude-textSecondary transition hover:bg-black/5 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-white/10 dark:hover:text-claude-darkText"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </header>

        <div
          data-paybuzz-unlock-banner={article.grantedVia}
          className={`flex items-center gap-2 border-b px-5 py-2.5 text-xs font-medium ${
            isVip
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          }`}
        >
          {isVip ? (
            <SparklesIcon className="h-4 w-4 shrink-0" />
          ) : (
            <CheckBadgeIcon className="h-4 w-4 shrink-0" />
          )}
          <span>{bannerText}</span>
        </div>

        <article className="flex-1 overflow-y-auto px-6 py-6 text-sm leading-relaxed text-claude-text dark:text-claude-darkText">
          <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-claude-accent prose-pre:rounded-xl prose-pre:bg-[#282c34]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {article.decryptedMarkdown}
            </ReactMarkdown>
          </div>
        </article>
      </aside>
    </div>
  );
};

export default PaybuzzReaderView;
