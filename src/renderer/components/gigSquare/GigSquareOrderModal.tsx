import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { GigSquareService } from '../../types/gigSquare';
import { formatGigSquarePrice, getGigSquarePaymentAmount } from '../../utils/gigSquare';
import { fetchMetaidInfoByGlobalId } from '../../services/metabotInfoService';
import { apiService } from '../../services/api';

type MetabotOption = { id: number; name: string; avatar: string | null; metabot_type: string };

interface GigSquareOrderModalProps {
  service: GigSquareService | null;
  isOpen: boolean;
  onClose: () => void;
  /** Default selected MetaBot (e.g. twin); modal fetches full list and uses this as initial selection. */
  buyerMetabotId: number | null;
}

type OrderStatus = 'idle' | 'paying' | 'sending' | 'success';
type HandshakeStatus = 'idle' | 'checking' | 'online' | 'offline';

function currencyToChain(currency: string): 'mvc' | 'btc' | 'doge' {
  const u = (currency || '').toUpperCase();
  if (u === 'BTC') return 'btc';
  if (u === 'DOGE') return 'doge';
  return 'mvc';
}

function formatBalance(
  balance: { value: number; unit: string } | undefined,
  loading?: boolean
): string {
  if (loading) return '…';
  if (!balance) return '—';
  return `${balance.value.toFixed(8)} ${balance.unit}`;
}

const GigSquareOrderModal: React.FC<GigSquareOrderModalProps> = ({
  service,
  isOpen,
  onClose,
  buyerMetabotId,
}) => {
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<OrderStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [metabots, setMetabots] = useState<MetabotOption[]>([]);
  const [selectedMetabotId, setSelectedMetabotId] = useState<number | null>(null);
  const [providerInfo, setProviderInfo] = useState<{
    name?: string;
    avatarUrl?: string | null;
    chatpubkey?: string | null;
  }>({});
  const [showDescriptionModal, setShowDescriptionModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [balance, setBalance] = useState<{
    mvc?: { value: number; unit: string };
    btc?: { value: number; unit: string };
    doge?: { value: number; unit: string };
  }>({});
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [handshake, setHandshake] = useState<HandshakeStatus>('idle');

  const loadMetabots = useCallback(async () => {
    try {
      const res = await window.electron.idbots.getMetaBots();
      if (res?.success && res.list?.length) {
        setMetabots(res.list);
        setSelectedMetabotId((prev) => {
          const current = prev ?? buyerMetabotId;
          if (current && res.list.some((m) => m.id === current)) return current;
          const twin = res.list.find((m) => m.metabot_type === 'twin');
          return buyerMetabotId ?? twin?.id ?? res.list[0].id;
        });
      } else {
        setMetabots([]);
      }
    } catch {
      setMetabots([]);
    }
  }, [buyerMetabotId]);

  const runHandshake = useCallback(async (metabotId: number, chatpubkey: string, toGlobalMetaId: string) => {
    setHandshake('checking');
    try {
      const res = await window.electron.gigSquare.pingProvider({
        metabotId,
        toGlobalMetaId,
        toChatPubkey: chatpubkey,
        timeoutMs: 15000,
      });
      setHandshake(res.success ? 'online' : 'offline');
    } catch {
      setHandshake('offline');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setPrompt('');
    setStatus('idle');
    setError(null);
    setShowDescriptionModal(false);
    setShowConfirmModal(false);
    setProviderInfo({});
    setHandshake('idle');
    loadMetabots();
  }, [isOpen, loadMetabots]);

  useEffect(() => {
    if (!isOpen || !service?.providerGlobalMetaId) return;
    let cancelled = false;
    fetchMetaidInfoByGlobalId(service.providerGlobalMetaId)
      .then((info) => {
        if (!cancelled) {
          setProviderInfo({
            name: info.name,
            avatarUrl: info.avatarUrl ?? null,
            chatpubkey: info.chatpubkey ?? null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setProviderInfo({});
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, service?.providerGlobalMetaId]);

  useEffect(() => {
    if (!isOpen || !selectedMetabotId) {
      setBalanceLoading(false);
      return;
    }
    setBalanceLoading(true);
    window.electron.idbots
      .getAddressBalance({ metabotId: selectedMetabotId })
      .then((res) => {
        if (res?.success && res.balance) setBalance(res.balance);
        setBalanceLoading(false);
      })
      .catch(() => {
        setBalance({});
        setBalanceLoading(false);
      });
  }, [isOpen, selectedMetabotId]);

  useEffect(() => {
    if (isOpen && buyerMetabotId && metabots.length && selectedMetabotId === null) {
      const twin = metabots.find((m) => m.metabot_type === 'twin');
      setSelectedMetabotId(buyerMetabotId ?? twin?.id ?? metabots[0].id);
    }
  }, [isOpen, buyerMetabotId, metabots, selectedMetabotId]);

  // Trigger handshake once we have both chatpubkey and a selected metabot
  useEffect(() => {
    if (!isOpen || !service?.providerGlobalMetaId) return;
    if (!providerInfo.chatpubkey || !selectedMetabotId) return;
    if (handshake !== 'idle') return;
    runHandshake(selectedMetabotId, providerInfo.chatpubkey, service.providerGlobalMetaId);
  }, [isOpen, providerInfo.chatpubkey, selectedMetabotId, service?.providerGlobalMetaId, handshake, runHandshake]);

  const priceDisplay = useMemo(() => {
    if (!service) return null;
    return formatGigSquarePrice(service.price, service.currency);
  }, [service]);

  const paymentAmount = useMemo(() => {
    if (!service) return '0';
    return getGigSquarePaymentAmount(service.price);
  }, [service]);

  const chain = useMemo(
    () => (service ? currencyToChain(service.currency) : 'mvc'),
    [service]
  );

  const balanceForChain = useMemo(() => {
    if (chain === 'btc') return balance.btc;
    if (chain === 'doge') return balance.doge;
    return balance.mvc;
  }, [chain, balance]);

  const statusText =
    status === 'paying'
      ? i18nService.t('gigSquarePaying')
      : status === 'sending'
        ? i18nService.t('gigSquareSending')
        : status === 'success'
          ? i18nService.t('gigSquareOrderSent')
          : '';

  const handleOpenConfirm = () => {
    if (!selectedMetabotId) {
      setError(i18nService.t('gigSquareNoTwin'));
      return;
    }
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError(i18nService.t('gigSquarePromptRequired'));
      return;
    }
    if (!service?.providerAddress) {
      setError(i18nService.t('gigSquareOrderFailed'));
      return;
    }
    setError(null);
    setShowConfirmModal(true);
  };

  const handleConfirmPayment = useCallback(async () => {
    if (!service || !selectedMetabotId) return;
    setShowConfirmModal(false);
    setStatus('paying');
    setError(null);
    const trimmedPrompt = prompt.trim();
    const amount = paymentAmount;

    try {
      const payment = await window.electron.idbots.executeTransfer({
        metabotId: selectedMetabotId,
        chain,
        toAddress: service.providerAddress,
        amountSpaceOrDoge: amount,
        feeRate: 1,
      });

      if (!payment?.success) {
        throw new Error(payment?.error || i18nService.t('gigSquarePaymentFailed'));
      }

      const txId = typeof payment.txId === 'string' ? payment.txId : '';
      if (!txId) {
        throw new Error(i18nService.t('gigSquarePaymentFailed'));
      }

      setStatus('sending');

      let chatPubkey = providerInfo.chatpubkey ?? null;
      if (!chatPubkey) {
        const providerRes = await window.electron.gigSquare.fetchProviderInfo({
          providerMetaId: service.providerMetaId,
          providerGlobalMetaId: service.providerGlobalMetaId,
          providerAddress: service.providerAddress,
        });
        if (providerRes?.success && providerRes.chatPubkey) {
          chatPubkey = providerRes.chatPubkey;
        }
      }

      if (!chatPubkey) {
        throw new Error(i18nService.t('gigSquareOrderFailed'));
      }

      const toGlobalMetaId =
        service.providerGlobalMetaId || service.providerMetaId;
      if (!toGlobalMetaId) {
        throw new Error(i18nService.t('gigSquareOrderFailed'));
      }

      // Build order message: let A's LLM express it in A's own voice,
      // but the message must contain the four required fields.
      // Fall back to a plain template if LLM is unavailable.
      let naturalOrderText: string;
      try {
        const buyerMetabot = selectedMetabotId
          ? (await window.electron.metabot.get(selectedMetabotId))?.metabot
          : null;
        const personaLines = buyerMetabot ? [
          buyerMetabot.name ? `Your name is ${buyerMetabot.name}.` : '',
          buyerMetabot.role ? `Your role: ${buyerMetabot.role}.` : '',
          buyerMetabot.soul ? `Your personality: ${buyerMetabot.soul}.` : '',
          buyerMetabot.background ? `Background: ${buyerMetabot.background}.` : '',
        ].filter(Boolean).join(' ') : '';

        const systemMsg = [
          personaLines,
          'You are sending a paid service order to another MetaBot. Write a natural, conversational message in your own voice.',
          'The message MUST include all four of these facts (you may phrase them naturally):',
          `1. Payment amount: ${service.price} ${service.currency}`,
          `2. Transaction ID (txid): ${txId}`,
          `3. Skill name requested: ${service.serviceName}`,
          `4. The user's specific request: "${trimmedPrompt}"`,
          'Keep it concise (2-4 sentences). Do not add greetings like "Hello" unless it fits your persona.',
        ].filter(Boolean).join('\n');

        const result = await apiService.chat(
          'Write the order message now.',
          undefined,
          [{ role: 'system', content: systemMsg }]
        );
        naturalOrderText = result.content.trim();
      } catch {
        // LLM unavailable — fall back to plain template
        naturalOrderText = `已支付 ${service.price} ${service.currency}，txid: ${txId}，请求技能 ${service.serviceName}。需求："${trimmedPrompt}"`;
      }

      const orderPayload = `[ORDER] ${naturalOrderText}`;

      const sendResult = await window.electron.gigSquare.sendOrder({
        metabotId: selectedMetabotId,
        toGlobalMetaId,
        toChatPubkey: chatPubkey,
        orderPayload,
        peerName: providerInfo.name || null,
        peerAvatar: providerInfo.avatarUrl || null,
      });

      if (!sendResult?.success) {
        throw new Error(sendResult?.error || i18nService.t('gigSquareOrderFailed'));
      }

      setStatus('success');
      window.setTimeout(() => onClose(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('gigSquareOrderFailed'));
      setStatus('idle');
    }
  }, [
    service,
    selectedMetabotId,
    prompt,
    paymentAmount,
    chain,
    providerInfo.chatpubkey,
    onClose,
  ]);

  if (!isOpen || !service) return null;

  const selectedMetabot = metabots.find((m) => m.id === selectedMetabotId);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="absolute inset-0 bg-black/50 dark:bg-black/60"
          onClick={status === 'idle' ? onClose : undefined}
          aria-hidden
        />
        <div
          className="relative w-full max-w-lg rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('gigSquareOrderTitle')}
              </h3>
              <p className="text-sm font-medium dark:text-claude-darkText text-claude-text mt-1">
                {service.displayName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-2 py-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              disabled={status !== 'idle'}
            >
              {i18nService.t('close')}
            </button>
          </div>

          <div className="mt-4 space-y-4">
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border p-3 bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted">
              <div className="flex items-center justify-between text-sm dark:text-claude-darkText text-claude-text">
                <span>{i18nService.t('gigSquareOrderService')}</span>
                <span className="font-medium">{service.serviceName}</span>
              </div>
              {priceDisplay && (
                <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {priceDisplay.amount} {priceDisplay.unit}
                </div>
              )}
              {service.description && (
                <div className="mt-2">
                  <p
                    className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-3"
                    style={{ WebkitLineClamp: 3 }}
                  >
                    {service.description}
                  </p>
                  {service.description.length > 100 && (
                    <button
                      type="button"
                      onClick={() => setShowDescriptionModal(true)}
                      className="mt-1 text-xs text-claude-accent hover:underline"
                    >
                      {i18nService.t('gigSquareDescriptionMore')}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Provider MetaBot info: avatar from API or fallback to serviceIcon (same URL as list) */}
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border p-3 bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted">
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
                {i18nService.t('gigSquareProvider')}
              </div>
              <div className="flex items-center gap-3">
                {providerInfo.avatarUrl ? (
                  <img
                    src={providerInfo.avatarUrl}
                    alt=""
                    className="h-10 w-10 rounded-lg object-cover border border-claude-border dark:border-claude-darkBorder"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-lg bg-claude-accent/20 flex items-center justify-center text-xs font-semibold text-claude-accent">
                    {(providerInfo.name || service.providerGlobalMetaId || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="text-sm dark:text-claude-darkText text-claude-text">
                  {providerInfo.name || service.providerGlobalMetaId || '—'}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePromptLabel')}
              </label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={i18nService.t('gigSquarePromptPlaceholder')}
                rows={4}
                className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text placeholder-claude-textSecondary dark:placeholder-claude-darkTextSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={status !== 'idle'}
              />
            </div>

            {statusText && (
              <div className="text-xs font-medium text-claude-accent">
                {statusText}
              </div>
            )}

            {error && (
              <div className="text-xs text-red-500">
                {error}
              </div>
            )}

            {/* Handshake status */}
            <div className="flex items-center gap-2 rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-2 bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted">
              <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 ${
                handshake === 'idle' ? 'bg-gray-400' :
                handshake === 'checking' ? 'bg-blue-500 animate-pulse' :
                handshake === 'online' ? 'bg-green-500' :
                'bg-red-500'
              }`} />
              <span className={`text-xs flex-1 ${
                handshake === 'online' ? 'text-green-600 dark:text-green-400' :
                handshake === 'offline' ? 'text-red-500' :
                handshake === 'checking' ? 'text-blue-500' :
                'dark:text-claude-darkTextSecondary text-claude-textSecondary'
              }`}>
                {handshake === 'checking' && i18nService.t('gigSquareHandshaking')}
                {handshake === 'online' && i18nService.t('gigSquareHandshakeOnline')}
                {handshake === 'offline' && i18nService.t('gigSquareHandshakeOffline')}
                {handshake === 'idle' && '—'}
              </span>
              {handshake === 'offline' && selectedMetabotId && providerInfo.chatpubkey && service?.providerGlobalMetaId && (
                <button
                  type="button"
                  onClick={() => runHandshake(selectedMetabotId, providerInfo.chatpubkey!, service!.providerGlobalMetaId)}
                  className="text-xs px-2 py-0.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover flex-shrink-0"
                >
                  {i18nService.t('gigSquareHandshakeRetry')}
                </button>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 flex-wrap">
              <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('gigSquareUseMetabot')}
              </span>
              <select
                value={selectedMetabotId ?? ''}
                onChange={(e) => { setSelectedMetabotId(Number(e.target.value) || null); setHandshake('idle'); }}
                className="rounded-lg border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={status !== 'idle'}
              >
                {metabots.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleOpenConfirm}
                className="btn-idchat-primary px-4 py-2 text-sm font-medium"
                disabled={status !== 'idle' || handshake !== 'online'}
              >
                {i18nService.t('gigSquarePayAndRequest')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Description full view modal */}
      {showDescriptionModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 dark:bg-black/60"
            onClick={() => setShowDescriptionModal(false)}
            aria-hidden
          />
          <div
            className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                {service.displayName}
              </h4>
              <button
                type="button"
                onClick={() => setShowDescriptionModal(false)}
                className="text-xs px-2 py-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('close')}
              </button>
            </div>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap">
              {service.description}
            </p>
          </div>
        </div>
      )}

      {/* Confirm payment modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/50 dark:bg-black/60"
            onClick={() => setShowConfirmModal(false)}
            aria-hidden
          />
          <div
            className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('gigSquareConfirmTitle')}
              </h4>
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="text-xs px-2 py-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('close')}
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('gigSquareConfirmAmount')}
                </span>
                <span className="dark:text-claude-darkText text-claude-text font-medium">
                  {service.price} {service.currency}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('gigSquareConfirmBalance')}
                </span>
                <span className="dark:text-claude-darkText text-claude-text">
                  {formatBalance(balanceForChain, balanceLoading)}
                </span>
              </div>
              <div>
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary block mb-1">
                  {i18nService.t('gigSquareConfirmRequest')}
                </span>
                <p className="text-xs dark:text-claude-darkText text-claude-text bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted rounded-lg p-2 max-h-24 overflow-y-auto">
                  {prompt.trim()}
                </p>
              </div>
              <div>
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary block mb-1">
                  {i18nService.t('gigSquareConfirmProviderAddress')}
                </span>
                <p className="text-xs dark:text-claude-darkText text-claude-text break-all">
                  {service.providerAddress}
                </p>
              </div>
              <div className="flex justify-between">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('gigSquareConfirmMetabot')}
                </span>
                <span className="dark:text-claude-darkText text-claude-text">
                  {selectedMetabot?.name ?? selectedMetabotId ?? '—'}
                </span>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="px-3 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('close')}
              </button>
              <button
                type="button"
                onClick={handleConfirmPayment}
                className="btn-idchat-primary px-4 py-2 text-sm font-medium"
              >
                {i18nService.t('gigSquareConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default GigSquareOrderModal;
