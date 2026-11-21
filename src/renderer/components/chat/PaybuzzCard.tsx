import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookOpenIcon,
  CheckBadgeIcon,
  DocumentTextIcon,
  LockClosedIcon,
  LockOpenIcon,
  ShoppingBagIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import {
  formatPaybuzzUnlockBadges,
  type PaybuzzCardData,
} from '../../utils/paybuzzCardSyntax';
import { formatFtAssetBadge } from './ftCardSyntax';
import { ct } from '../commerce/commerceTradeI18n';
import {
  dispatchOpenPaybuzzReader,
  type PaybuzzReaderPayload,
} from '../commerce/PaybuzzReaderView';

export interface PaybuzzCardProps {
  data: PaybuzzCardData;
}

const PaybuzzCard: React.FC<PaybuzzCardProps> = ({ data }) => {
  const [unlockedArticle, setUnlockedArticle] = useState<PaybuzzReaderPayload | null>(null);
  const [vipMatch, setVipMatch] = useState<{
    collectionPinId: string;
    collectionName: string;
    itemCount: number;
  } | null>(null);
  const [loadingState, setLoadingState] = useState<'idle' | 'unlocking' | 'pending_key'>('idle');
  const [showPayConfirm, setShowPayConfirm] = useState(false);
  const [selectedAssetKey, setSelectedAssetKey] = useState<string>(
    data.unlockRules.tokenPrices[0]?.assetKey ?? '',
  );
  const [statusError, setStatusError] = useState('');

  const badges = useMemo(
    () => formatPaybuzzUnlockBadges(data.unlockRules),
    [data.unlockRules],
  );

  const openReader = useCallback(
    (article: PaybuzzReaderPayload) => {
      dispatchOpenPaybuzzReader(article);
    },
    [],
  );

  const syncLocalState = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electron?.paybuzz?.getItem) return;
    try {
      const res = await window.electron.paybuzz.getItem({
        paybuzzPinId: data.paybuzzPinId,
      });
      if (res?.success) {
        if (res.unlocked?.decryptedMarkdown) {
          setUnlockedArticle({
            paybuzzPinId: data.paybuzzPinId,
            title: res.unlocked.title || data.title,
            authorMetaId: res.unlocked.authorMetaId || data.authorMetaId,
            authorName: data.authorName,
            wordCount: data.wordCount,
            grantedVia: res.unlocked.grantedVia,
            decryptedMarkdown: res.unlocked.decryptedMarkdown,
            unlockedAt: res.unlocked.unlockedAt,
          });
        }
        if (res.vipMatch) {
          setVipMatch(res.vipMatch);
        }
      }
    } catch {
      // Keep snapshot card state when offline or in static contexts
    }
  }, [data.authorMetaId, data.authorName, data.paybuzzPinId, data.title, data.wordCount]);

  useEffect(() => {
    void syncLocalState();
    if (typeof window === 'undefined' || !window.electron?.paybuzz) return;

    const unsubUnlocked = window.electron.paybuzz.onUnlocked?.((payload) => {
      if (
        payload?.paybuzzPinId?.toLowerCase() === data.paybuzzPinId.toLowerCase() &&
        payload.decryptedMarkdown
      ) {
        const readerPayload: PaybuzzReaderPayload = {
          paybuzzPinId: data.paybuzzPinId,
          title: payload.title || data.title,
          authorMetaId: payload.authorMetaId || data.authorMetaId,
          authorName: data.authorName,
          wordCount: data.wordCount,
          grantedVia: payload.grantedVia,
          vipCollectionName: vipMatch?.collectionName,
          decryptedMarkdown: payload.decryptedMarkdown,
          unlockedAt: payload.unlockedAt,
        };
        setUnlockedArticle(readerPayload);
        setLoadingState('idle');
        setShowPayConfirm(false);
        setStatusError('');
        openReader(readerPayload);
      }
    });

    const unsubRejected = window.electron.paybuzz.onUnlockRejected?.((payload) => {
      if (payload?.paybuzzPinId?.toLowerCase() === data.paybuzzPinId.toLowerCase()) {
        setLoadingState('idle');
        setStatusError(payload.reason || payload.code || 'Unlock rejected by author');
      }
    });

    return () => {
      unsubUnlocked?.();
      unsubRejected?.();
    };
  }, [
    data.authorMetaId,
    data.authorName,
    data.paybuzzPinId,
    data.title,
    data.wordCount,
    openReader,
    syncLocalState,
    vipMatch?.collectionName,
  ]);

  const handlePrimaryUnlockClick = async () => {
    setStatusError('');
    if (unlockedArticle) {
      openReader(unlockedArticle);
      return;
    }

    if (typeof window === 'undefined' || !window.electron?.paybuzz?.unlock) {
      return;
    }

    // 1. Check local cache immediately first (0s offline read)
    try {
      const cached = await window.electron.paybuzz.getUnlocked?.({
        paybuzzPinId: data.paybuzzPinId,
      });
      if (cached?.success && cached.unlocked?.decryptedMarkdown) {
        const readerPayload: PaybuzzReaderPayload = {
          paybuzzPinId: data.paybuzzPinId,
          title: cached.unlocked.title || data.title,
          authorMetaId: cached.unlocked.authorMetaId || data.authorMetaId,
          authorName: data.authorName,
          wordCount: data.wordCount,
          grantedVia: cached.unlocked.grantedVia,
          decryptedMarkdown: cached.unlocked.decryptedMarkdown,
          unlockedAt: cached.unlocked.unlockedAt,
        };
        setUnlockedArticle(readerPayload);
        openReader(readerPayload);
        return;
      }
    } catch {
      // Proceed to track detection
    }

    // 2. If VIP card matched or auto-detecting, attempt zero-cost VIP unlock first
    setLoadingState('unlocking');
    try {
      const res = await window.electron.paybuzz.unlock({
        paybuzzPinId: data.paybuzzPinId,
        preferredTrack: vipMatch ? 'vip-nft' : 'auto',
        confirmTokenPay: false,
        waitTimeoutMs: 12000,
      });

      if (!res?.success) {
        setLoadingState('idle');
        setStatusError(res?.error || ct('Failed to unlock article', '解锁文章失败'));
        return;
      }

      if (res.status === 'unlocked' && res.decryptedMarkdown) {
        const readerPayload: PaybuzzReaderPayload = {
          paybuzzPinId: data.paybuzzPinId,
          title: res.title || data.title,
          authorMetaId: res.authorMetaId || data.authorMetaId,
          authorName: data.authorName,
          wordCount: data.wordCount,
          grantedVia: res.grantedVia || 'vip-nft',
          vipCollectionName: res.vipMatch?.collectionName ?? vipMatch?.collectionName,
          decryptedMarkdown: res.decryptedMarkdown,
        };
        setUnlockedArticle(readerPayload);
        setLoadingState('idle');
        openReader(readerPayload);
        return;
      }

      if (res.status === 'pending_key') {
        setLoadingState('pending_key');
        return;
      }

      // No VIP card held -> show lightweight token payment confirmation panel
      setLoadingState('idle');
      setShowPayConfirm(true);
    } catch (err) {
      setLoadingState('idle');
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmTokenPay = async () => {
    if (typeof window === 'undefined' || !window.electron?.paybuzz?.unlock) return;
    setStatusError('');
    setLoadingState('unlocking');
    try {
      const res = await window.electron.paybuzz.unlock({
        paybuzzPinId: data.paybuzzPinId,
        preferredTrack: 'token',
        assetKey: selectedAssetKey || data.unlockRules.tokenPrices[0]?.assetKey,
        confirmTokenPay: true,
        waitTimeoutMs: 15000,
      });
      if (!res?.success) {
        setLoadingState('idle');
        setStatusError(res?.error || ct('Token payment failed', '代币支付失败'));
        return;
      }
      if (res.status === 'unlocked' && res.decryptedMarkdown) {
        const readerPayload: PaybuzzReaderPayload = {
          paybuzzPinId: data.paybuzzPinId,
          title: res.title || data.title,
          authorMetaId: res.authorMetaId || data.authorMetaId,
          authorName: data.authorName,
          wordCount: data.wordCount,
          grantedVia: res.grantedVia || 'token',
          decryptedMarkdown: res.decryptedMarkdown,
        };
        setUnlockedArticle(readerPayload);
        setLoadingState('idle');
        setShowPayConfirm(false);
        openReader(readerPayload);
        return;
      }
      setLoadingState('pending_key');
    } catch (err) {
      setLoadingState('idle');
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenAuthorShop = () => {
    if (typeof window === 'undefined') return;
    if (data.shopMetaAppPinId) {
      window.dispatchEvent(
        new CustomEvent('botBrowser:openUri', {
          detail: { uri: `metaapp://${data.shopMetaAppPinId}`, newTab: true },
        }),
      );
      return;
    }
    const vipName = data.unlockRules.vipMrc721Collections[0]?.collectionName ?? 'VIP Member Card';
    const draft = ct(
      `Help me check author ${data.authorMetaId || 'this creator'}'s shop to buy the "${vipName}" MRC-721 VIP pass.`,
      `帮我看看作者 ${data.authorMetaId || ''} 的小店，我想购买「${vipName}」专栏会员权益卡。`,
    );
    window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draft } }));
  };

  const selectedRule =
    data.unlockRules.tokenPrices.find((t) => t.assetKey === selectedAssetKey) ??
    data.unlockRules.tokenPrices[0];

  return (
    <div
      data-paybuzz-card="true"
      data-paybuzz-pin-id={data.paybuzzPinId}
      className="my-2.5 w-full max-w-xl overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-sm dark:border-claude-darkBorder dark:bg-claude-darkSurface"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-claude-border/80 bg-black/[0.02] px-4 py-2.5 dark:border-claude-darkBorder/80 dark:bg-white/[0.02]">
        <div className="flex items-center gap-2">
          {unlockedArticle ? (
            <LockOpenIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <LockClosedIcon className="h-4 w-4 text-claude-accent" />
          )}
          <span className="text-xs font-semibold uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
            PayBuzz Article
          </span>
          {vipMatch && !unlockedArticle && (
            <span
              data-paybuzz-vip-eligible="true"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
            >
              <SparklesIcon className="h-3 w-3" />
              {ct('VIP Card Eligible · Free', '持会员卡免费看')}
            </span>
          )}
          {unlockedArticle && (
            <span
              data-paybuzz-unlocked="true"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
            >
              <CheckBadgeIcon className="h-3 w-3" />
              {ct('Unlocked', '已解锁')}
            </span>
          )}
        </div>
        <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {data.wordCount > 0 ? `${data.wordCount.toLocaleString()} ${ct('words', '字')}` : 'Markdown'}
        </span>
      </div>

      <div className="space-y-3 p-4">
        <div>
          <h3 className="text-sm font-bold leading-snug text-claude-text dark:text-claude-darkText">
            {data.title}
          </h3>
          {(data.authorName || data.authorMetaId) && (
            <div className="mt-0.5 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {ct('Author', '作者')}:{' '}
              <span className="font-medium text-claude-text dark:text-claude-darkText">
                {data.authorName || `${data.authorMetaId.slice(0, 12)}…`}
              </span>
            </div>
          )}
        </div>

        {data.preview && (
          <p className="line-clamp-4 rounded-xl border border-claude-border/60 bg-black/[0.015] p-3 text-xs leading-relaxed text-claude-textSecondary dark:border-claude-darkBorder/60 dark:bg-white/[0.015] dark:text-claude-darkTextSecondary">
            {data.preview}
          </p>
        )}

        <div className="flex flex-wrap gap-1.5">
          {badges.map((badge, idx) => (
            <span
              key={`${badge.kind}-${idx}`}
              title={badge.assetKey}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                badge.kind === 'vip'
                  ? 'border border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border border-claude-border bg-black/[0.03] text-claude-text dark:border-claude-darkBorder dark:bg-white/[0.04] dark:text-claude-darkText'
              }`}
            >
              {badge.kind === 'vip' ? (
                <SparklesIcon className="h-3 w-3" />
              ) : (
                <DocumentTextIcon className="h-3 w-3" />
              )}
              <span>{badge.label}</span>
              {badge.assetBadge && (
                <span className="font-mono text-[10px] opacity-70">({badge.assetBadge})</span>
              )}
            </span>
          ))}
        </div>

        {showPayConfirm && !unlockedArticle && selectedRule && (
          <div
            data-paybuzz-pay-confirm="true"
            className="space-y-2.5 rounded-xl border border-claude-accent/35 bg-claude-accent/[0.04] p-3 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-claude-text dark:text-claude-darkText">
                {ct('Single-Article Micropayment', '单篇微支付解锁确认')}
              </span>
              <span className="font-mono text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {formatFtAssetBadge(selectedRule.assetKey)}
              </span>
            </div>

            {data.unlockRules.tokenPrices.length > 1 && (
              <div className="flex flex-wrap gap-1.5">
                {data.unlockRules.tokenPrices.map((rule) => (
                  <button
                    key={rule.assetKey}
                    type="button"
                    onClick={() => setSelectedAssetKey(rule.assetKey)}
                    className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                      selectedRule.assetKey === rule.assetKey
                        ? 'border-claude-accent bg-claude-accent/15 text-claude-accent'
                        : 'border-claude-border text-claude-textSecondary dark:border-claude-darkBorder'
                    }`}
                  >
                    {rule.amountDisplay} ${rule.symbol}
                  </button>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              {data.unlockRules.vipMrc721Collections.length > 0 ? (
                <button
                  type="button"
                  onClick={handleOpenAuthorShop}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-claude-accent hover:underline"
                >
                  <ShoppingBagIcon className="h-3.5 w-3.5" />
                  {ct("Get VIP Card in Author's Shop", '去作者小店买会员卡享全集免单')}
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowPayConfirm(false)}
                  className="rounded-lg border border-claude-border px-2.5 py-1 text-[11px] text-claude-textSecondary hover:text-claude-text dark:border-claude-darkBorder"
                >
                  {ct('Cancel', '取消')}
                </button>
                <button
                  type="button"
                  disabled={loadingState !== 'idle'}
                  onClick={handleConfirmTokenPay}
                  className="rounded-lg bg-claude-accent px-3 py-1 text-[11px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
                >
                  {loadingState === 'unlocking'
                    ? ct('Paying…', '支付中…')
                    : ct(
                        `Pay ${selectedRule.amountDisplay} $${selectedRule.symbol}`,
                        `支付 ${selectedRule.amountDisplay} $${selectedRule.symbol} 解锁`,
                      )}
                </button>
              </div>
            </div>
          </div>
        )}

        {statusError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-600 dark:text-red-300">
            {statusError}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="font-mono text-[10px] text-claude-textSecondary opacity-75 dark:text-claude-darkTextSecondary">
            {data.paybuzzPinId.slice(0, 12)}…{data.paybuzzPinId.slice(-4)}
          </span>
          <button
            type="button"
            data-paybuzz-action="unlock"
            disabled={loadingState === 'unlocking'}
            onClick={handlePrimaryUnlockClick}
            className="inline-flex items-center gap-1.5 rounded-xl bg-claude-accent px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-60"
          >
            <BookOpenIcon className="h-3.5 w-3.5" />
            {unlockedArticle
              ? ct('Read Full Article', '阅读完整全文')
              : loadingState === 'unlocking'
                ? ct('Unlocking…', '正在验资领钥…')
                : loadingState === 'pending_key'
                  ? ct('Waiting for Author Key…', '等待作者发钥…')
                  : vipMatch
                    ? ct('Unlock Free (VIP Card)', '持会员卡 0 元秒开')
                    : ct('Unlock Full Article', '立即解锁全文')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PaybuzzCard;
