import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { ChatMessagePayload } from '../../types/chat';
import type { GigSquareService } from '../../types/gigSquare';
import {
  formatGigSquarePrice,
  getGigSquarePaymentAmount,
  normalizeGigSquareDisplayCurrency,
} from '../../utils/gigSquare';
import { fetchMetaidInfoByGlobalId } from '../../services/metabotInfoService';
import { apiService } from '../../services/api';
import {
  DEFAULT_GIG_SQUARE_PROVIDER_AVATAR,
  getGigSquareProviderAvatarSrc,
  getGigSquareProviderDisplayName,
} from './gigSquareProviderPresentation.js';
import {
  findGigSquareMrc20PaymentAsset,
  formatGigSquareMrc20PaymentBalance,
  getGigSquareOrderErrorMessageKey,
  getGigSquareMrc20PaymentReadiness,
  getGigSquarePayActionBlockedMessageKey,
  getGigSquarePayActionClassName,
  isGigSquarePayActionEnabled,
} from './gigSquareOrderPresentation.js';
import {
  buildBuyerOrderNaturalFallback,
  generateBuyerOrderNaturalText,
} from './gigSquareOrderMessageBuilder.mjs';
import {
  buildGigSquareOrderPayload,
  validateGigSquareOrderPrompt,
} from './gigSquareOrderPayloadBuilder.mjs';

type MetabotOption = { id: number; name: string; avatar: string | null; metabot_type: string };
type Mrc20PaymentAsset = {
  kind: 'mrc20';
  chain: 'btc';
  symbol: string;
  tokenName: string;
  mrc20Id: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    pendingIn: string;
    pendingOut: string;
    display: string;
  };
};

interface GigSquareOrderModalProps {
  service: GigSquareService | null;
  isOpen: boolean;
  onClose: () => void;
  /** Default selected MetaBot (e.g. twin); modal fetches full list and uses this as initial selection. */
  buyerMetabotId: number | null;
}

type OrderStatus = 'idle' | 'paying' | 'sending' | 'success';
type HandshakeStatus = 'idle' | 'checking' | 'online' | 'offline';
type SettlementKind = 'native' | 'mrc20';

interface ResolvedGigSquareSettlement {
  kind: SettlementKind;
  paymentChain: 'mvc' | 'btc' | 'doge';
  currency: string;
  mrc20Ticker: string | null;
  mrc20Id: string | null;
}

function currencyToChain(currency: string): 'mvc' | 'btc' | 'doge' {
  const u = (currency || '').toUpperCase();
  if (u === 'BTC') return 'btc';
  if (u === 'DOGE') return 'doge';
  return 'mvc';
}

function parsePaymentChain(chain: string | null | undefined): 'mvc' | 'btc' | 'doge' | null {
  const normalized = String(chain || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'btc') return 'btc';
  if (normalized === 'doge') return 'doge';
  if (normalized === 'mvc') return 'mvc';
  return null;
}

function normalizeMrc20Ticker(ticker: string | null | undefined): string {
  return String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function resolveGigSquareSettlement(service: GigSquareService | null): ResolvedGigSquareSettlement {
  if (!service) {
    return {
      kind: 'native',
      paymentChain: 'mvc',
      currency: 'SPACE',
      mrc20Ticker: null,
      mrc20Id: null,
    };
  }

  const currency = String(service.currency || '').trim().toUpperCase();
  const settlementKind = String(service.settlementKind || '').trim().toLowerCase();
  const mrc20Id = String(service.mrc20Id || '').trim() || null;
  const explicitTicker = normalizeMrc20Ticker(service.mrc20Ticker);
  const tickerFromCurrency = (currency.match(/^([A-Z0-9]+)-MRC20$/) || [])[1] || '';
  const isMrc20 = settlementKind === 'mrc20'
    || Boolean(tickerFromCurrency)
    || Boolean(explicitTicker)
    || Boolean(mrc20Id);

  if (!isMrc20) {
    const paymentChain = parsePaymentChain(service.paymentChain) || currencyToChain(currency);
    const normalizedCurrency = normalizeGigSquareDisplayCurrency(
      currency
      || (paymentChain === 'btc' ? 'BTC' : paymentChain === 'doge' ? 'DOGE' : 'SPACE')
    );
    return {
      kind: 'native',
      paymentChain,
      currency: normalizedCurrency,
      mrc20Ticker: null,
      mrc20Id: null,
    };
  }

  const mrc20Ticker = explicitTicker || normalizeMrc20Ticker(tickerFromCurrency) || null;
  const normalizedCurrency = mrc20Ticker ? `${mrc20Ticker}-MRC20` : (currency || 'MRC20');
  return {
    kind: 'mrc20',
    paymentChain: 'btc',
    currency: normalizedCurrency,
    mrc20Ticker,
    mrc20Id,
  };
}

function formatBalance(
  balance: { value: number; unit: string } | undefined,
  loading?: boolean
): string {
  if (loading) return '…';
  if (!balance) return '—';
  return `${balance.value.toFixed(8)} ${balance.unit}`;
}

function isFreeServicePrice(value: string): boolean {
  const numeric = Number(String(value || '').trim());
  return Number.isFinite(numeric) && numeric === 0;
}

function generateSyntheticOrderTxid(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function resolveGigSquarePaymentAddress(
  service: GigSquareService | null,
  settlement: ResolvedGigSquareSettlement
): string {
  if (!service) return '';
  if (settlement.kind === 'mrc20') {
    return String(service.paymentAddress || '').trim();
  }
  return String(service.paymentAddress || service.providerAddress || '').trim();
}

function getMrc20PaymentReadinessError(reason: string | null | undefined): string {
  if (reason === 'missing_token') {
    return i18nService.t('gigSquareMrc20TokenMissing');
  }
  if (reason === 'insufficient_token_balance') {
    return i18nService.t('gigSquareMrc20TokenInsufficient');
  }
  if (reason === 'missing_payment_address' || reason === 'missing_token_id' || reason === 'invalid_amount') {
    return i18nService.t('gigSquareMrc20InvalidPayment');
  }
  return i18nService.t('gigSquarePaymentFailed');
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
  const [mrc20PaymentAsset, setMrc20PaymentAsset] = useState<Mrc20PaymentAsset | null>(null);
  const [mrc20PaymentAssetLoading, setMrc20PaymentAssetLoading] = useState(false);
  const [handshake, setHandshake] = useState<HandshakeStatus>('idle');
  const [feeRate, setFeeRate] = useState<number>(1);

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

  const priceDisplay = useMemo(() => {
    if (!service) return null;
    return formatGigSquarePrice(service.price, service.currency);
  }, [service]);

  const paymentAmount = useMemo(() => {
    if (!service) return '0';
    return getGigSquarePaymentAmount(service.price);
  }, [service]);
  const isFreeService = useMemo(() => isFreeServicePrice(paymentAmount), [paymentAmount]);

  const settlement = useMemo(
    () => resolveGigSquareSettlement(service),
    [service]
  );
  const chain = settlement.paymentChain;

  useEffect(() => {
    setMrc20PaymentAsset(null);
    setMrc20PaymentAssetLoading(false);
  }, [selectedMetabotId, service?.id, settlement.mrc20Id]);

  // Fetch live fee rate for the payment chain
  useEffect(() => {
    if (!isOpen) return;
    if (settlement.kind === 'mrc20') {
      window.electron.idbots
        .getTokenTransferFeeSummary({ kind: 'mrc20' })
        .then((res) => {
          if (res.success && res.defaultFeeRate != null) {
            setFeeRate(res.defaultFeeRate);
          }
        })
        .catch(() => setFeeRate(2));
      return;
    }
    if (chain !== 'btc') {
      setFeeRate(chain === 'doge' ? 200_000 : 1);
      return;
    }
    window.electron.idbots
      .getTransferFeeSummary('btc')
      .then((res) => {
        if (res.success && res.defaultFeeRate != null) setFeeRate(res.defaultFeeRate);
      })
      .catch(() => setFeeRate(2));
  }, [isOpen, chain, settlement.kind]);

  // Trigger handshake once we have both chatpubkey and a selected metabot
  useEffect(() => {
    if (!isOpen || !service?.providerGlobalMetaId) return;
    if (!providerInfo.chatpubkey || !selectedMetabotId) return;
    if (handshake !== 'idle') return;
    runHandshake(selectedMetabotId, providerInfo.chatpubkey, service.providerGlobalMetaId);
  }, [isOpen, providerInfo.chatpubkey, selectedMetabotId, service?.providerGlobalMetaId, handshake, runHandshake]);

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

  const getOrderErrorMessage = useCallback((errorCode?: string, fallback?: string | null) => {
    const messageKey = getGigSquareOrderErrorMessageKey(errorCode);
    if (messageKey) {
      return i18nService.t(messageKey);
    }
    return fallback || i18nService.t('gigSquareOrderFailed');
  }, []);

  const runOrderPreflight = useCallback(async () => {
    if (!selectedMetabotId || !service) {
      return {
        success: false,
        error: selectedMetabotId ? i18nService.t('gigSquareOrderFailed') : i18nService.t('gigSquareNoTwin'),
      };
    }

    const toGlobalMetaId = service.providerGlobalMetaId || service.providerMetaId;
    if (!toGlobalMetaId) {
      return {
        success: false,
        error: i18nService.t('gigSquareOrderFailed'),
      };
    }

    const result = await window.electron.gigSquare.preflightOrder({
      metabotId: selectedMetabotId,
      toGlobalMetaId,
    });

    if (result?.success) {
      return { success: true, toGlobalMetaId };
    }

    return {
      success: false,
      error: getOrderErrorMessage(result?.errorCode, result?.error || null),
      errorCode: result?.errorCode,
    };
  }, [getOrderErrorMessage, selectedMetabotId, service]);

  const loadMrc20PaymentAsset = useCallback(async (): Promise<{
    success: true;
    asset: Mrc20PaymentAsset | null;
  } | {
    success: false;
    error: string;
  }> => {
    if (!selectedMetabotId || !service || settlement.kind !== 'mrc20' || isFreeService) {
      return { success: true, asset: null };
    }

    const paymentAddress = resolveGigSquarePaymentAddress(service, settlement);
    const targetMrc20Id = String(settlement.mrc20Id || '').trim();
    if (!paymentAddress || !targetMrc20Id) {
      return {
        success: false,
        error: getMrc20PaymentReadinessError(!paymentAddress ? 'missing_payment_address' : 'missing_token_id'),
      };
    }

    setMrc20PaymentAssetLoading(true);
    try {
      const walletAssetsResult = await window.electron.idbots.getMetabotWalletAssets({
        metabotId: selectedMetabotId,
      });
      if (!walletAssetsResult?.success || !walletAssetsResult.assets) {
        return {
          success: false,
          error: walletAssetsResult?.error || i18nService.t('gigSquareMrc20AssetsLoadFailed'),
        };
      }

      const asset = findGigSquareMrc20PaymentAsset(
        walletAssetsResult.assets.mrc20Assets,
        targetMrc20Id,
      ) as Mrc20PaymentAsset | null;
      setMrc20PaymentAsset(asset);

      const readiness = getGigSquareMrc20PaymentReadiness({
        asset,
        amount: paymentAmount,
        mrc20Id: targetMrc20Id,
        paymentAddress,
      });
      if (!readiness.ok) {
        return {
          success: false,
          error: getMrc20PaymentReadinessError(readiness.reason),
        };
      }
      if (!asset) {
        return {
          success: false,
          error: i18nService.t('gigSquareMrc20TokenMissing'),
        };
      }

      const preview = await window.electron.idbots.buildTokenTransferPreview({
        kind: 'mrc20',
        metabotId: selectedMetabotId,
        asset,
        toAddress: paymentAddress,
        amount: paymentAmount,
        feeRate,
      });
      if (!preview?.success || !preview.preview) {
        return {
          success: false,
          error: preview?.error || i18nService.t('gigSquareMrc20FeeInsufficient'),
        };
      }

      return { success: true, asset };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : i18nService.t('gigSquareMrc20AssetsLoadFailed'),
      };
    } finally {
      setMrc20PaymentAssetLoading(false);
    }
  }, [feeRate, isFreeService, paymentAmount, selectedMetabotId, service, settlement]);

  const handleOpenConfirm = async () => {
    if (!isGigSquarePayActionEnabled(status, handshake)) {
      const blockedMessageKey = getGigSquarePayActionBlockedMessageKey(handshake);
      setError(blockedMessageKey ? i18nService.t(blockedMessageKey) : i18nService.t('gigSquareOrderFailed'));
      return;
    }
    if (!selectedMetabotId) {
      setError(i18nService.t('gigSquareNoTwin'));
      return;
    }
    const promptValidation = validateGigSquareOrderPrompt(prompt);
    if (!promptValidation.ok) {
      setError(
        promptValidation.reason === 'too_long'
          ? i18nService.t('gigSquarePromptTooLong')
          : i18nService.t('gigSquarePromptRequired')
      );
      return;
    }
    const paymentAddress = resolveGigSquarePaymentAddress(service, settlement);
    if (!paymentAddress) {
      setError(i18nService.t('gigSquareOrderFailed'));
      return;
    }
    if (settlement.kind === 'mrc20' && !settlement.mrc20Id) {
      setError(i18nService.t('gigSquareOrderFailed'));
      return;
    }

    const mrc20PaymentAssetResult = await loadMrc20PaymentAsset();
    if (mrc20PaymentAssetResult.success === false) {
      setError(mrc20PaymentAssetResult.error);
      return;
    }

    const preflight = await runOrderPreflight();
    if (!preflight.success) {
      setError(preflight.error);
      return;
    }

    setError(null);
    setShowConfirmModal(true);
  };

  const handleConfirmPayment = useCallback(async () => {
    if (!service || !selectedMetabotId) return;
    setError(null);
    const promptValidation = validateGigSquareOrderPrompt(prompt);
    if (!promptValidation.ok) {
      setShowConfirmModal(false);
      setError(
        promptValidation.reason === 'too_long'
          ? i18nService.t('gigSquarePromptTooLong')
          : i18nService.t('gigSquarePromptRequired')
      );
      setStatus('idle');
      return;
    }
    const preflight = await runOrderPreflight();
    if (!preflight.success) {
      setShowConfirmModal(false);
      setError(preflight.error);
      return;
    }

    setShowConfirmModal(false);
      const trimmedPrompt = promptValidation.rawRequest;
    const amount = paymentAmount;
    const paymentAddress = resolveGigSquarePaymentAddress(service, settlement);
    if (!paymentAddress || (settlement.kind === 'mrc20' && !settlement.mrc20Id)) {
      throw new Error(i18nService.t('gigSquareOrderFailed'));
    }

    try {
      let txId = '';
      let paymentCommitTxid = '';
      if (isFreeService) {
        txId = generateSyntheticOrderTxid();
        setStatus('sending');
      } else if (settlement.kind === 'mrc20') {
        setStatus('paying');
        const assetResult = await loadMrc20PaymentAsset();
        if (assetResult.success === false) {
          throw new Error(assetResult.error);
        }
        const asset = assetResult.asset;
        if (!asset) {
          throw new Error(i18nService.t('gigSquareMrc20TokenMissing'));
        }

        const payment = await window.electron.idbots.executeTokenTransfer({
          kind: 'mrc20',
          metabotId: selectedMetabotId,
          asset,
          toAddress: paymentAddress,
          amount,
          feeRate,
        });
        if (!payment?.success || !payment.result) {
          throw new Error(payment?.error || i18nService.t('gigSquarePaymentFailed'));
        }

        paymentCommitTxid = typeof payment.result.commitTxId === 'string'
          ? payment.result.commitTxId
          : '';
        txId = typeof payment.result.revealTxId === 'string' && payment.result.revealTxId.trim()
          ? payment.result.revealTxId.trim()
          : (typeof payment.result.txId === 'string' ? payment.result.txId.trim() : '');
        if (!txId) {
          throw new Error(i18nService.t('gigSquarePaymentFailed'));
        }
        setStatus('sending');
      } else {
        setStatus('paying');
        const payment = await window.electron.idbots.executeTransfer({
          metabotId: selectedMetabotId,
          chain,
          toAddress: paymentAddress,
          amountSpaceOrDoge: amount,
          feeRate,
        });

        if (!payment?.success) {
          throw new Error(payment?.error || i18nService.t('gigSquarePaymentFailed'));
        }

        txId = typeof payment.txId === 'string' ? payment.txId : '';
        if (!txId) {
          throw new Error(i18nService.t('gigSquarePaymentFailed'));
        }

        setStatus('sending');
      }

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

      const toGlobalMetaId = preflight.toGlobalMetaId;
      if (!toGlobalMetaId) {
        throw new Error(i18nService.t('gigSquareOrderFailed'));
      }

      // Generate only the buyer-side natural request sentence here.
      // Payment/txid/service metadata stays in the structured block below.
      let naturalOrderText: string;
      try {
        const buyerMetabot = selectedMetabotId
          ? (await window.electron.metabot.get(selectedMetabotId))?.metabot
          : null;
        const orderMessageTxid = isFreeService ? '' : txId;
        naturalOrderText = await generateBuyerOrderNaturalText({
          buyerPersona: buyerMetabot ? {
            name: buyerMetabot.name,
            role: buyerMetabot.role,
            soul: buyerMetabot.soul,
            background: buyerMetabot.background,
          } : null,
          price: service.price,
          currency: settlement.currency,
          txid: orderMessageTxid,
          orderReference: isFreeService ? txId : '',
          serviceId: service.id,
          skillName: service.providerSkill || service.serviceName,
          requestText: trimmedPrompt,
        }, {
          timeoutMs: 8000,
          chat: (message: string, onProgress: undefined, history: ChatMessagePayload[]) =>
            apiService.chat(message, onProgress, history),
          cancel: () => {
            apiService.cancelOngoingRequest();
          },
        });
      } catch {
        naturalOrderText = buildBuyerOrderNaturalFallback(trimmedPrompt);
      }

      // Always append structured fields so B-side regex can reliably parse payment metadata.
      const orderMessageTxid = isFreeService ? '' : txId;
      const orderPayload = buildGigSquareOrderPayload({
        naturalOrderText,
        rawRequest: trimmedPrompt,
        price: service.price,
        currency: settlement.currency,
        txid: orderMessageTxid,
        paymentCommitTxid: isFreeService ? '' : paymentCommitTxid,
        orderReference: isFreeService ? txId : '',
        paymentChain: settlement.paymentChain,
        settlementKind: settlement.kind,
        mrc20Ticker: settlement.mrc20Ticker || '',
        mrc20Id: settlement.mrc20Id || '',
        serviceId: service.id,
        skillName: service.providerSkill || service.serviceName,
        serviceName: service.serviceName,
        outputType: service.outputType || 'text',
      });

      const sendResult = await window.electron.gigSquare.sendOrder({
        metabotId: selectedMetabotId,
        toGlobalMetaId,
        toChatPubkey: chatPubkey,
        orderPayload,
        peerName: providerInfo.name || null,
        peerAvatar: providerInfo.avatarUrl || null,
        serviceId: service.id,
        servicePrice: service.price,
        serviceCurrency: settlement.currency,
        servicePaymentChain: settlement.paymentChain,
        serviceSettlementKind: settlement.kind,
        serviceMrc20Ticker: settlement.mrc20Ticker,
        serviceMrc20Id: settlement.mrc20Id,
        servicePaymentCommitTxid: isFreeService ? null : (paymentCommitTxid || null),
        serviceSkill: service.providerSkill || service.serviceName,
        serviceOutputType: service.outputType || 'text',
        serverBotGlobalMetaId: service.providerGlobalMetaId || null,
        servicePaidTx: txId,
      });

      if (!sendResult?.success) {
        throw new Error(
          getOrderErrorMessage(sendResult?.errorCode, sendResult?.error || null)
        );
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
    isFreeService,
    settlement,
    chain,
    feeRate,
    providerInfo.chatpubkey,
    onClose,
    runOrderPreflight,
    loadMrc20PaymentAsset,
    getOrderErrorMessage,
  ]);

  if (!isOpen || !service) return null;

  const selectedMetabot = metabots.find((m) => m.id === selectedMetabotId);
  const confirmPaymentAddress = resolveGigSquarePaymentAddress(service, settlement);

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
                <img
                  src={getGigSquareProviderAvatarSrc(providerInfo)}
                  alt={getGigSquareProviderDisplayName(providerInfo, service.providerGlobalMetaId || service.providerMetaId)}
                  className="h-10 w-10 rounded-lg object-cover border border-claude-border dark:border-claude-darkBorder"
                  onError={(e) => { e.currentTarget.src = DEFAULT_GIG_SQUARE_PROVIDER_AVATAR; }}
                />
                <span className="text-sm dark:text-claude-darkText text-claude-text">
                  {getGigSquareProviderDisplayName(providerInfo, service.providerGlobalMetaId || service.providerMetaId)}
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
                className={getGigSquarePayActionClassName(status, handshake)}
                disabled={!isGigSquarePayActionEnabled(status, handshake)}
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
                  {priceDisplay?.amount ?? service.price} {priceDisplay?.unit ?? normalizeGigSquareDisplayCurrency(service.currency)}
                </span>
              </div>
              {settlement.kind === 'mrc20' ? (
                <>
                  <div className="flex justify-between gap-3">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('gigSquareConfirmTokenBalance')}
                    </span>
                    <span className="dark:text-claude-darkText text-claude-text text-right">
                      {formatGigSquareMrc20PaymentBalance(mrc20PaymentAsset, mrc20PaymentAssetLoading)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('gigSquareConfirmFeeBalance')}
                    </span>
                    <span className="dark:text-claude-darkText text-claude-text text-right">
                      {formatBalance(balance.btc, balanceLoading)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex justify-between">
                  <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('gigSquareConfirmBalance')}
                  </span>
                  <span className="dark:text-claude-darkText text-claude-text">
                    {formatBalance(balanceForChain, balanceLoading)}
                  </span>
                </div>
              )}
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
                  {confirmPaymentAddress}
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
