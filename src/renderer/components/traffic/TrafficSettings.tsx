/**
 * Traffic Settings panel.
 * Sections in one tab: billing-mode toggle (account quota vs MetaBot
 * self-pay), available quota with the free-grant claim banner, recharge
 * (plan picker → order → PayPal browser checkout or Alipay QR scan → status
 * polling), redeem-code entry, and usage (per-bot daily table, 30-day
 * summary, ledger).
 * UI copy goes through i18nService (zh/en), same as Settings/UserSettings.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  ArrowPathIcon,
  BoltIcon,
  CheckCircleIcon,
  CheckIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  QuestionMarkCircleIcon,
  TicketIcon,
  UserCircleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  DEFAULT_FREE_GRANT_BYTES,
  TRAFFIC_LOW_BALANCE_BYTES,
  splitTrafficAmount,
  type TrafficDisplayUnit,
} from './formatTraffic';

type TrafficSettingsInfo = {
  mode: 'traffic' | 'selfpay';
  fallbackPolicy: 'selfpay' | 'strict';
  /** Configured assist-service base URL override; '' = production default. */
  apiBase: string;
  /** Recharge gateway override; '' = automatic (plan currency decides: CNY → Alipay, other → PayPal). */
  rechargeGateway: '' | 'paypal' | 'mock' | 'alipay';
};
type TrafficAccountInfo = {
  accountId: string;
  identityAddress: string;
  balanceBytes: number;
  reservedBytes: number;
  grantedBytesTotal: number;
  spentBytesTotal: number;
  status: number;
};
type TrafficFreeGrantCampaignInfo = {
  enabled: boolean;
  grantBytes: number;
  claimed: boolean;
  claimable: boolean;
};
type TrafficRedeemResultInfo = {
  codeId: number;
  trafficBytes: number;
  balanceAfter: number;
};
type TrafficBindSummaryInfo = {
  accountId: string;
  results: Array<{ botAddress: string; status: 'bound' | 'conflict' | 'failed'; error?: string }>;
  boundCount: number;
  conflictCount: number;
  failedCount: number;
};
type TrafficDailyUsageRowInfo = { date: string; botAddress: string; bytes: number; txCount: number };
type TrafficLedgerEntryInfo = {
  id: number;
  direction: number;
  amountBytes: number;
  balanceAfter: number;
  sourceType: string;
  sourceId: string;
  remark: string;
  timestamp: number;
  /** Local-journal enrichment (this-device sponsored commits only). */
  txId?: string;
  botAddress?: string;
  kind?: string;
};

const TRAFFIC_UNIT_I18N_KEYS: Record<TrafficDisplayUnit, string> = {
  bytes: 'trafficUnitBytes',
  kb: 'trafficUnitKb',
  mb: 'trafficUnitMb',
};

const TARIFF_ROWS = [
  { type: 'trafficTariffRowText', size: 'trafficTariffRowTextSize', capacity: 'trafficTariffRowTextCapacity' },
  { type: 'trafficTariffRowImage', size: 'trafficTariffRowImageSize', capacity: 'trafficTariffRowImageCapacity' },
  { type: 'trafficTariffRowHd', size: 'trafficTariffRowHdSize', capacity: 'trafficTariffRowHdCapacity' },
  { type: 'trafficTariffRowVideo', size: 'trafficTariffRowVideoSize', capacity: 'trafficTariffRowVideoCapacity' },
  { type: 'trafficTariffRowVector', size: 'trafficTariffRowVectorSize', capacity: 'trafficTariffRowVectorCapacity' },
] as const;

// Ledger direction values delivered by the backend (models/traffic_ledger_model.go).
const LEDGER_DIRECTION_KEYS: Record<number, string> = {
  1: 'trafficLedgerCredit',
  2: 'trafficLedgerSpend',
  3: 'trafficLedgerReserve',
  4: 'trafficLedgerRelease',
};

// Locally journaled pin paths mapped to friendly business names; anything
// else falls back to a shortened raw path (see resolveLedgerKindLabel).
const LEDGER_KIND_KEYS: Record<string, string> = {
  '/protocols/simplemsg': 'trafficKindSimplemsg',
  '/protocols/simplebuzz': 'trafficKindSimplebuzz',
  '/file': 'trafficKindFile',
};

// Ledger credit sourceType values mapped to friendly labels (Phase 3b).
const LEDGER_SOURCE_TYPE_KEYS: Record<string, string> = {
  free_grant: 'trafficSourceFreeGrant',
  recharge_code: 'trafficSourceRechargeCode',
  recharge_order: 'trafficSourceRechargeOrder',
};

// Recharge order status values delivered by the backend (mirrors
// TRAFFIC_RECHARGE_STATUS in main/services/trafficAccountService.ts).
const RECHARGE_STATUS_CREDITED = 3;
const RECHARGE_STATUS_CLOSED = 4;

type RechargeOrderPhase = 'pick' | 'paying' | 'credited' | 'closed';

type TrafficPricingPlanInfo = {
  planId: string;
  chain: string;
  payCurrency: string;
  payAmount: number;
  trafficBytes: number;
  status: number;
  remark: string;
};

type TrafficRechargeOrderStatusInfo = {
  orderId: string;
  status: number;
  paidAt?: number;
  creditedAt?: number;
};

type ActiveRechargeOrder = {
  orderId: string;
  gateway: 'paypal' | 'mock' | 'alipay';
  /** PayPal checkout URL extracted from gatewayParams ('' for mock/alipay orders). */
  approvalUrl: string;
  /** Alipay 当面付 QR content extracted from gatewayParams ('' unless alipay). */
  qrCode: string;
  payAmount: number;
  payCurrency: string;
  trafficBytes: number;
};

const RECHARGE_POLL_INTERVAL_MS = 4_000;
const RECHARGE_POLL_WINDOW_MS = 10 * 60_000;

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€', GBP: '£' };

const formatPlanPrice = (currency: string, amount: number): string => {
  const code = String(currency || '').toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const value = Number.isFinite(amount) ? amount : 0;
  const text = value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return symbol ? `${symbol}${text}` : `${code} ${text}`;
};

// The PayPal approval link lives in gatewayParams; accept the likely key
// variants until the backend contract (phase4-paypal-backend-requirements.md)
// is delivered and locked.
const extractApprovalUrl = (gatewayParams: unknown): string => {
  if (!gatewayParams || typeof gatewayParams !== 'object') return '';
  const record = gatewayParams as Record<string, unknown>;
  for (const key of ['approvalUrl', 'approval_url', 'approveLink', 'approve_url', 'paymentUrl']) {
    const value = record[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  return '';
};

// The Alipay 当面付 precreate response carries the QR payload string in
// gatewayParams (phase5-alipay-backend-requirements.md); the client renders it
// as a QR image. Accept the likely key variants until the contract locks.
const extractQrCode = (gatewayParams: unknown): string => {
  if (!gatewayParams || typeof gatewayParams !== 'object') return '';
  const record = gatewayParams as Record<string, unknown>;
  for (const key of ['qrCode', 'qr_code', 'qrCodeContent', 'codeUrl', 'code_url']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

// Payment-method tab model: CNY plans are paid via Alipay (当面付 QR),
// everything else via PayPal — mirrors gatewayForPlanCurrency in
// main/services/trafficAccountService.ts (keep the two in sync).
type RechargeMethod = 'paypal' | 'alipay';
const gatewayForPlanCurrency = (payCurrency: string): RechargeMethod =>
  String(payCurrency || '').toUpperCase() === 'CNY' ? 'alipay' : 'paypal';

const hasMockToken = (gatewayParams: unknown): boolean => {
  if (!gatewayParams || typeof gatewayParams !== 'object') return false;
  return typeof (gatewayParams as Record<string, unknown>).mockToken === 'string';
};

// Backend rejects a gateway it doesn't support (e.g. paypal before the Phase 4
// adapter ships) with a plain message — map it to friendly copy.
const GATEWAY_UNSUPPORTED_PATTERN = /gateway.*unsupported|unsupported.*gateway|gateway.*unavailable/i;

const describeRechargeError = (raw: string, fallbackKey: string): string => {
  const text = String(raw || '').trim();
  if (text && GATEWAY_UNSUPPORTED_PATTERN.test(text)) {
    return i18nService.t('trafficRechargeUnavailable');
  }
  return describeTrafficError(raw, fallbackKey);
};

// Backend data.errorCode values mapped to friendly i18n copy (Phase 3b).
const TRAFFIC_ERROR_CODE_KEYS: Record<string, string> = {
  CAMPAIGN_DISABLED: 'trafficErrCampaignDisabled',
  ALREADY_CLAIMED: 'trafficErrAlreadyClaimed',
  CLIENT_NOT_ALLOWED: 'trafficErrClientNotAllowed',
  CODE_NOT_FOUND: 'trafficErrCodeNotFound',
  CODE_USED: 'trafficErrCodeUsed',
  CODE_DISABLED: 'trafficErrCodeDisabled',
  CODE_EXPIRED: 'trafficErrCodeExpired',
};

const resolveLedgerKindLabel = (kind: string): string => {
  const normalized = String(kind || '').trim().toLowerCase();
  if (!normalized) return '';
  const key = LEDGER_KIND_KEYS[normalized];
  if (key) return i18nService.t(key);
  // Unknown kind: shorthand for the raw path ('/protocols/paycomment' -> 'paycomment').
  if (normalized.startsWith('/protocols/')) return normalized.slice('/protocols/'.length);
  return normalized;
};

// Deterministic local-time ledger timestamp (YYYY-MM-DD HH:mm:ss).
const formatLedgerTimestamp = (timestamp: number): string => {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

// Copyable short TXID badge (same interaction as the group-task TxIdBadge):
// click copies the full id, the hover tooltip always shows it in full.
const LedgerTxIdBadge: React.FC<{ txId: string }> = ({ txId }) => {
  const [copied, setCopied] = useState(false);
  const short = txId.length > 16 ? `${txId.slice(0, 8)}…${txId.slice(-6)}` : txId;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(txId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions) — the title tooltip still shows the full id
    }
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" title={txId}>
      <span className="font-mono text-[10px] dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
        {short}
      </span>
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={i18nService.t(copied ? 'trafficLedgerTxidCopied' : 'trafficLedgerCopyTxid')}
        aria-label={i18nService.t(copied ? 'trafficLedgerTxidCopied' : 'trafficLedgerCopyTxid')}
        className="rounded p-0.5 dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
      >
        {copied
          ? <CheckIcon className="h-3 w-3 text-emerald-500" />
          : <ClipboardDocumentIcon className="h-3 w-3" />}
      </button>
    </span>
  );
};

const cardClass = 'rounded-xl dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted px-4 py-3';
const labelClass = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary';
const primaryButtonClass = 'px-3 py-2 text-sm rounded-xl bg-claude-accent text-claude-accentInk hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const ghostButtonClass = 'px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const OverlayPanel: React.FC<{ children: React.ReactNode; onDismiss: () => void; widthClass?: string }> = ({
  children,
  onDismiss,
  widthClass = 'w-[420px]',
}) => (
  <div
    className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
    onClick={onDismiss}
  >
    <div
      className={`${widthClass} max-w-full rounded-2xl dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-5`}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  </div>
);

// Renderer-side network failures (assistant-service unreachable, bad endpoint
// override, ...) surface as raw TypeError text such as "fetch failed"; match
// those so users get the friendly copy instead.
const NETWORK_ERROR_PATTERN = /fetch failed|failed to fetch|networkerror|network request failed|econnrefused|enotfound|etimedout|econnreset|socket hang up/i;

// Adaptive traffic formatter (decimal: 1000 B = 1 KB, 1_000_000 B = 1 MB).
// Single-pin spends are KB-level, so a flat MB view would round them to "0 MB".
const formatTraffic = (bytes: number): string => {
  const { amount, unit } = splitTrafficAmount(bytes);
  return `${amount} ${i18nService.t(TRAFFIC_UNIT_I18N_KEYS[unit])}`;
};

const formatBytesExact = (bytes: number): string =>
  `${bytes.toLocaleString()} ${i18nService.t('trafficUnitBytes')}`;

const shortAddress = (address: string): string => {
  const text = String(address || '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
};

const formatAmountWithSign = (direction: number, amountBytes: number): string => {
  const sign = direction === 1 || direction === 4 ? '+' : '-';
  return `${sign}${formatTraffic(amountBytes)}`;
};

// Single funnel for error text shown in this panel: backend error codes
// (data.errorCode) map to friendly copy first; network-level failures get the
// friendly copy with the raw message appended; everything else (backend error
// strings, translated fallbacks) passes through unchanged.
const describeTrafficError = (raw: string, fallbackKey: string, errorCode?: string): string => {
  const codeKey = errorCode ? TRAFFIC_ERROR_CODE_KEYS[errorCode] : undefined;
  if (codeKey) return i18nService.t(codeKey);
  const text = String(raw || '').trim();
  if (!text) return i18nService.t(fallbackKey);
  if (NETWORK_ERROR_PATTERN.test(text)) {
    return `${i18nService.t('trafficErrFriendly')} (${text})`;
  }
  return text;
};

const TrafficSettings: React.FC = () => {
  const [, setLanguage] = useState(i18nService.getLanguage());
  const [identityChecked, setIdentityChecked] = useState(false);
  const [identityAddress, setIdentityAddress] = useState<string>('');
  const [settings, setSettings] = useState<TrafficSettingsInfo | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [bindState, setBindState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [bindSummary, setBindSummary] = useState<TrafficBindSummaryInfo | null>(null);
  const [bindError, setBindError] = useState('');
  const [balance, setBalance] = useState<TrafficAccountInfo | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [campaign, setCampaign] = useState<TrafficFreeGrantCampaignInfo | null>(null);
  const [campaignReady, setCampaignReady] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [claimNotice, setClaimNotice] = useState('');
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [tariffOpen, setTariffOpen] = useState(false);
  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [rechargeGateway, setRechargeGateway] = useState<'paypal' | 'mock' | 'alipay' | null>(null);
  const [gatewayPackaged, setGatewayPackaged] = useState(false);
  const [pricingPlans, setPricingPlans] = useState<TrafficPricingPlanInfo[] | null>(null);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [pricingError, setPricingError] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [rechargeMethod, setRechargeMethod] = useState<RechargeMethod>('paypal');
  const [activeOrder, setActiveOrder] = useState<ActiveRechargeOrder | null>(null);
  const [orderPhase, setOrderPhase] = useState<RechargeOrderPhase>('pick');
  const [orderError, setOrderError] = useState('');
  const [orderBusy, setOrderBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const orderPollTimerRef = useRef<number | null>(null);
  const orderPollDeadlineRef = useRef(0);
  const [redeemCodeInput, setRedeemCodeInput] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState('');
  const [redeemSuccess, setRedeemSuccess] = useState<TrafficRedeemResultInfo | null>(null);
  const [summary, setSummary] = useState<{ todayBytes: number; weekBytes: number; monthBytes: number } | null>(null);
  const [dailyRows, setDailyRows] = useState<TrafficDailyUsageRowInfo[] | null>(null);
  const [dailyFallbackRows, setDailyFallbackRows] = useState<TrafficDailyUsageRowInfo[] | null>(null);
  const [usageError, setUsageError] = useState('');
  const [ledgerEntries, setLedgerEntries] = useState<TrafficLedgerEntryInfo[]>([]);
  const [ledgerCursor, setLedgerCursor] = useState(0);
  const [ledgerDone, setLedgerDone] = useState(false);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  const [botNames, setBotNames] = useState<Record<string, string>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [apiBaseInput, setApiBaseInput] = useState('');
  const [apiBaseSaving, setApiBaseSaving] = useState(false);
  const [apiBaseError, setApiBaseError] = useState('');
  const [apiBaseNotice, setApiBaseNotice] = useState('');
  const [gatewaySaving, setGatewaySaving] = useState(false);
  const [gatewayError, setGatewayError] = useState('');

  const trafficApi = window.electron.traffic;

  // Re-render on language switches (same pattern as UserSettings/Settings).
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  const stopOrderPolling = useCallback(() => {
    if (orderPollTimerRef.current !== null) {
      window.clearInterval(orderPollTimerRef.current);
      orderPollTimerRef.current = null;
    }
  }, []);

  // Stop an in-flight order poll when the component unmounts.
  useEffect(() => stopOrderPolling, [stopOrderPolling]);

  // Render the Alipay 当面付 QR payload as an image while the active order
  // carries one; cleared when the order resets or carries no QR content.
  useEffect(() => {
    const content = activeOrder?.gateway === 'alipay' ? activeOrder.qrCode : '';
    if (!content) {
      setQrDataUrl('');
      return undefined;
    }
    let cancelled = false;
    QRCode.toDataURL(content, { margin: 1, width: 220 })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(''); });
    return () => { cancelled = true; };
  }, [activeOrder]);

  const closeRecharge = useCallback(() => {
    stopOrderPolling();
    setRechargeOpen(false);
    setActiveOrder(null);
    setOrderPhase('pick');
    setOrderError('');
    setOrderBusy(false);
  }, [stopOrderPolling]);

  useEffect(() => {
    if (!redeemOpen && !tariffOpen && !rechargeOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRedeemOpen(false);
      setTariffOpen(false);
      closeRecharge();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [redeemOpen, tariffOpen, rechargeOpen, closeRecharge]);

  const refreshBalance = useCallback(async (forceRefresh = false) => {
    setBalanceLoading(true);
    setBalanceError('');
    try {
      const res = await trafficApi.getBalance({ forceRefresh });
      if (res.success && res.balance) {
        setBalance(res.balance);
      } else {
        setBalanceError(describeTrafficError(res.error || '', 'trafficErrLoadBalance'));
      }
    } catch (error) {
      setBalanceError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrLoadBalance'));
    } finally {
      setBalanceLoading(false);
    }
  }, [trafficApi]);

  // Campaign status needs the traffic account to exist (backend looks up by
  // identity). Callers should ensure/refresh the account first on a fresh
  // install. A failed status fetch no longer hides the button if we already
  // have a balance — claim itself is the source of truth for eligibility.
  const loadCampaign = useCallback(async () => {
    try {
      const res = await trafficApi.getFreeGrantCampaignStatus();
      if (res.success && res.campaign) {
        setCampaign(res.campaign);
      } else {
        setCampaign(null);
      }
    } catch {
      setCampaign(null);
    } finally {
      setCampaignReady(true);
    }
  }, [trafficApi]);

  const loadUsage = useCallback(async () => {
    const summaryRes = await trafficApi.getUsageSummary().catch(() => null);
    if (summaryRes?.success && summaryRes.summary) {
      setSummary(summaryRes.summary);
    }
    const dailyRes = await trafficApi.getDailyUsage({}).catch(() => null);
    if (dailyRes?.success && dailyRes.rows) {
      setDailyRows(dailyRes.rows);
      setDailyFallbackRows(null);
      setUsageError('');
      return;
    }
    // Backend unreachable: fall back to the local spend journal aggregated by
    // UTC day + bot address so the table stays useful offline.
    setUsageError(describeTrafficError(dailyRes?.error || '', 'trafficUsageUnavailable'));
    const journalRes = await trafficApi.getLocalJournal({ limit: 200 }).catch(() => null);
    if (journalRes?.success && journalRes.entries) {
      const buckets = new Map<string, TrafficDailyUsageRowInfo>();
      for (const entry of journalRes.entries) {
        const date = new Date(entry.createdAt).toISOString().slice(0, 10);
        const key = `${date}|${entry.botAddress}`;
        const bucket = buckets.get(key) ?? { date, botAddress: entry.botAddress, bytes: 0, txCount: 0 };
        bucket.bytes += entry.txSize;
        bucket.txCount += 1;
        buckets.set(key, bucket);
      }
      setDailyRows(null);
      setDailyFallbackRows(Array.from(buckets.values()).sort((a, b) => b.date.localeCompare(a.date)));
    }
  }, [trafficApi]);

  const loadLedger = useCallback(async (cursor: number) => {
    setLedgerLoading(true);
    setLedgerError('');
    try {
      const res = await trafficApi.getLedger({ cursor, limit: 20 });
      if (res.success && res.entries) {
        setLedgerEntries((previous) => (cursor ? [...previous, ...res.entries!] : res.entries!));
        const nextCursor = res.nextCursor ?? 0;
        setLedgerCursor(nextCursor);
        setLedgerDone(!nextCursor || res.entries.length === 0);
      } else {
        setLedgerError(describeTrafficError(res.error || '', 'trafficErrLoadLedger'));
      }
    } catch (error) {
      setLedgerError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrLoadLedger'));
    } finally {
      setLedgerLoading(false);
    }
  }, [trafficApi]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const identityRes = await window.electron.userIdentity.get().catch(() => null);
      if (cancelled) return;
      const identity = identityRes?.success ? identityRes.identity : null;
      setIdentityAddress(identity?.mvc_address ?? '');
      setIdentityChecked(true);
      if (!identity) return;

      const settingsRes = await trafficApi.getSettings().catch(() => null);
      if (!cancelled && settingsRes?.success && settingsRes.settings) {
        setSettings(settingsRes.settings);
        if (settingsRes.settings.mode === 'traffic') {
          trafficApi.ensureAccount()
            .then(() => trafficApi.bindAllBots())
            .catch(() => {});
        }
      }
      trafficApi.getRechargeGateway()
        .then((res) => {
          if (!cancelled && res?.success) setGatewayPackaged(Boolean(res.packaged));
        })
        .catch(() => {});
      window.electron.metabot.list().then((res) => {
        if (cancelled || !res?.success || !res.list) return;
        const names: Record<string, string> = {};
        for (const bot of res.list) {
          if (bot.mvc_address && bot.name) {
            names[bot.mvc_address.toLowerCase()] = bot.name;
          }
        }
        setBotNames(names);
      }).catch(() => {});
      // Create the traffic account (via getBalance → requireAccount) before
      // reading campaign status. Parallel first-run POSTs used to lose the
      // campaign call on a create-conflict, which hid the free-grant button
      // for fresh installs while existing users (local account already
      // persisted) kept seeing it.
      await refreshBalance(true);
      if (cancelled) return;
      await loadCampaign();
      if (cancelled) return;
      loadUsage();
      loadLedger(0);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const resolveBotLabel = useCallback((address: string): string => {
    const normalized = String(address || '').toLowerCase();
    if (!normalized) return '—';
    if (identityAddress && normalized === identityAddress.toLowerCase()) {
      return `${i18nService.t('trafficYouIdentity')} · ${shortAddress(address)}`;
    }
    const name = botNames[normalized];
    return name ? `${name} · ${shortAddress(address)}` : shortAddress(address);
  }, [botNames, identityAddress]);

  // Ledger source column: friendly kind + bot name for locally enriched
  // entries; the raw sourceType/remark pair for everything else.
  const resolveLedgerSourceLabel = useCallback((entry: TrafficLedgerEntryInfo): string => {
    const parts: string[] = [];
    const kindLabel = resolveLedgerKindLabel(entry.kind ?? '');
    if (kindLabel) parts.push(kindLabel);
    const botAddress = String(entry.botAddress || '');
    if (botAddress) {
      const normalized = botAddress.toLowerCase();
      if (identityAddress && normalized === identityAddress.toLowerCase()) {
        parts.push(i18nService.t('trafficYouIdentity'));
      } else {
        parts.push(botNames[normalized] ?? shortAddress(botAddress));
      }
    }
    if (parts.length > 0) return parts.join(' · ');
    const sourceKey = LEDGER_SOURCE_TYPE_KEYS[entry.sourceType];
    const sourceLabel = sourceKey ? i18nService.t(sourceKey) : entry.sourceType;
    return `${sourceLabel}${entry.remark ? ` · ${entry.remark}` : ''}`;
  }, [botNames, identityAddress]);

  const ledgerDirectionLabel = (direction: number): string => {
    const key = LEDGER_DIRECTION_KEYS[direction];
    return key
      ? i18nService.t(key)
      : i18nService.t('trafficLedgerTypeUnknown').replace('{direction}', String(direction));
  };

  const bindLocalBots = useCallback(async (announce: boolean) => {
    if (announce) {
      setBindState('running');
      setBindError('');
      setBindSummary(null);
    }
    const ensureRes = await trafficApi.ensureAccount().catch(() => null);
    if (!ensureRes?.success) {
      setBindState('error');
      setBindError(describeTrafficError(ensureRes?.error || '', 'trafficEnsureAccountFailed'));
      return;
    }
    const bindRes = await trafficApi.bindAllBots().catch(() => null);
    if (!bindRes?.success || !bindRes.summary) {
      setBindState('error');
      setBindError(describeTrafficError(bindRes?.error || '', 'trafficBindBotsFailed'));
      return;
    }
    if (announce) {
      setBindSummary(bindRes.summary);
      setBindState('done');
    } else {
      setBindState('idle');
    }
    refreshBalance(true);
  }, [refreshBalance, trafficApi]);

  const handleSelectMode = async (mode: 'traffic' | 'selfpay') => {
    if (!settings || settingsSaving || settings.mode === mode) return;
    setSettingsSaving(true);
    try {
      const res = await trafficApi.setSettings({ mode, fallbackPolicy: 'selfpay' });
      if (res.success && res.settings) {
        setSettings(res.settings);
      }
    } finally {
      setSettingsSaving(false);
    }
    if (mode !== 'traffic') return;
    await bindLocalBots(true);
  };

  const handleSaveApiBase = async (value: string) => {
    if (apiBaseSaving) return;
    setApiBaseSaving(true);
    setApiBaseError('');
    setApiBaseNotice('');
    try {
      const res = await trafficApi.setSettings({ apiBase: value });
      if (res.success && res.settings) {
        setSettings(res.settings);
        setApiBaseInput('');
        setApiBaseNotice(i18nService.t('trafficApiBaseSaved'));
        refreshBalance(true);
      } else {
        setApiBaseError(describeTrafficError(res.error || '', 'trafficErrSaveApiBase'));
      }
    } catch (error) {
      setApiBaseError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrSaveApiBase'));
    } finally {
      setApiBaseSaving(false);
    }
  };

  const handleSaveGateway = async (value: string) => {
    if (gatewaySaving || !settings) return;
    setGatewaySaving(true);
    setGatewayError('');
    try {
      const res = await trafficApi.setSettings({ rechargeGateway: value });
      if (res.success && res.settings) {
        setSettings(res.settings);
      } else {
        setGatewayError(describeTrafficError(res.error || '', 'trafficErrSaveApiBase'));
      }
    } catch (error) {
      setGatewayError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrSaveApiBase'));
    } finally {
      setGatewaySaving(false);
    }
  };

  const handleClaimFreeGrant = async () => {
    if (claiming) return;
    setClaiming(true);
    setClaimError('');
    setClaimNotice('');
    try {
      const res = await trafficApi.claimFreeGrant();
      if (res.success && res.claim) {
        setClaimNotice(i18nService.t('trafficFreeGrantClaimSuccess')
          .replace('{amount}', formatTraffic(res.claim.grantBytes)));
        setCampaign({
          enabled: true,
          grantBytes: res.claim.grantBytes,
          claimed: true,
          claimable: false,
        });
        loadCampaign();
        refreshBalance(true);
        loadLedger(0);
      } else {
        setClaimError(describeTrafficError(res.error || '', 'trafficErrClaimFailed', res.errorCode));
      }
    } catch (error) {
      setClaimError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrClaimFailed'));
    } finally {
      setClaiming(false);
    }
  };

  const handleRedeemCode = async () => {
    const code = redeemCodeInput.trim();
    if (redeeming || !code) return;
    setRedeeming(true);
    setRedeemError('');
    setRedeemSuccess(null);
    try {
      const res = await trafficApi.redeemCode({ code });
      if (res.success && res.result) {
        setRedeemSuccess(res.result);
        setRedeemCodeInput('');
        refreshBalance(true);
        loadUsage();
        loadLedger(0);
      } else {
        setRedeemError(describeTrafficError(res.error || '', 'trafficRedeemFailed', res.errorCode));
      }
    } catch (error) {
      setRedeemError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficRedeemFailed'));
    } finally {
      setRedeeming(false);
    }
  };

  const openRedeem = () => {
    setRedeemOpen(true);
    setRedeemError('');
    setRedeemSuccess(null);
  };

  const loadPricingPlans = useCallback(async () => {
    setPricingLoading(true);
    setPricingError('');
    try {
      const res = await trafficApi.getPricing();
      if (res.success && res.plans) {
        const active = res.plans.filter((plan) => plan.status === 1);
        setPricingPlans(active);
        // Default the payment method to Alipay when CNY plans exist (China
        // users are the Phase 5 target), otherwise PayPal.
        const defaultMethod: RechargeMethod = active.some((plan) => gatewayForPlanCurrency(plan.payCurrency) === 'alipay')
          ? 'alipay'
          : 'paypal';
        setRechargeMethod(defaultMethod);
        setSelectedPlanId((current) => {
          if (current && active.some((plan) => plan.planId === current)) return current;
          const group = active.filter((plan) => gatewayForPlanCurrency(plan.payCurrency) === defaultMethod);
          return (group[0] ?? active[0])?.planId ?? '';
        });
      } else {
        setPricingPlans(null);
        setPricingError(describeTrafficError(res.error || '', 'trafficErrLoadPricing'));
      }
    } catch (error) {
      setPricingPlans(null);
      setPricingError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrLoadPricing'));
    } finally {
      setPricingLoading(false);
    }
  }, [trafficApi]);

  const handleSelectMethod = useCallback((method: RechargeMethod) => {
    setRechargeMethod(method);
    setSelectedPlanId((current) => {
      const group = (pricingPlans ?? []).filter((plan) => gatewayForPlanCurrency(plan.payCurrency) === method);
      return current && group.some((plan) => plan.planId === current) ? current : (group[0]?.planId ?? '');
    });
  }, [pricingPlans]);

  const openRecharge = () => {
    setRechargeOpen(true);
    setOrderPhase('pick');
    setActiveOrder(null);
    setOrderError('');
    setOrderBusy(false);
    trafficApi.getRechargeGateway()
      .then((res) => {
        if (res?.success && res.gateway) setRechargeGateway(res.gateway);
        if (res?.success) setGatewayPackaged(Boolean(res.packaged));
      })
      .catch(() => {});
    loadPricingPlans();
  };

  const applyOrderStatus = useCallback((status: TrafficRechargeOrderStatusInfo) => {
    if (status.status === RECHARGE_STATUS_CREDITED) {
      stopOrderPolling();
      setOrderPhase('credited');
      refreshBalance(true);
      loadLedger(0);
    } else if (status.status === RECHARGE_STATUS_CLOSED) {
      stopOrderPolling();
      setOrderPhase('closed');
    }
  }, [loadLedger, refreshBalance, stopOrderPolling]);

  const checkOrderOnce = useCallback(async (orderId: string): Promise<TrafficRechargeOrderStatusInfo | null> => {
    try {
      const res = await trafficApi.getRechargeOrder({ orderId });
      if (res.success && res.order) return res.order;
    } catch {
      // transient failure — the next poll tick retries
    }
    return null;
  }, [trafficApi]);

  const startOrderPolling = useCallback((orderId: string) => {
    stopOrderPolling();
    orderPollDeadlineRef.current = Date.now() + RECHARGE_POLL_WINDOW_MS;
    orderPollTimerRef.current = window.setInterval(() => {
      if (Date.now() > orderPollDeadlineRef.current) {
        // Out of the auto-poll window: the waiting UI and manual check stay.
        stopOrderPolling();
        return;
      }
      void checkOrderOnce(orderId).then((status) => {
        if (status) applyOrderStatus(status);
      });
    }, RECHARGE_POLL_INTERVAL_MS);
  }, [applyOrderStatus, checkOrderOnce, stopOrderPolling]);

  const handleCreateOrder = async () => {
    const planId = selectedPlanId;
    if (orderBusy || !planId) return;
    setOrderBusy(true);
    setOrderError('');
    try {
      // Pick the gateway from the plan currency; the main process still lets a
      // non-packaged mock override win, so omit it entirely under mock.
      const plan = (pricingPlans ?? []).find((item) => item.planId === planId);
      const requestedGateway = rechargeGateway === 'mock' || !plan
        ? undefined
        : gatewayForPlanCurrency(plan.payCurrency);
      const res = await trafficApi.createRechargeOrder({ planId, gateway: requestedGateway });
      if (!res.success || !res.order) {
        setOrderError(describeRechargeError(res.error || '', 'trafficErrCreateOrder'));
        return;
      }
      const approvalUrl = extractApprovalUrl(res.order.gatewayParams);
      const qrCode = extractQrCode(res.order.gatewayParams);
      if (!approvalUrl && !qrCode && !hasMockToken(res.order.gatewayParams)) {
        // No checkout link, no QR payload, no mock token: unexpected gateway response.
        setOrderError(i18nService.t('trafficRechargeUnavailable'));
        return;
      }
      const order: ActiveRechargeOrder = {
        orderId: res.order.orderId,
        gateway: qrCode ? 'alipay' : approvalUrl ? 'paypal' : 'mock',
        approvalUrl,
        qrCode,
        payAmount: res.order.payAmount,
        payCurrency: res.order.payCurrency,
        trafficBytes: res.order.trafficBytes,
      };
      setActiveOrder(order);
      setOrderPhase('paying');
      if (order.gateway === 'paypal') {
        window.electron.shell.openExternal(order.approvalUrl).catch(() => {});
      }
      if (order.gateway !== 'mock') {
        startOrderPolling(order.orderId);
      }
    } catch (error) {
      setOrderError(describeRechargeError(error instanceof Error ? error.message : '', 'trafficErrCreateOrder'));
    } finally {
      setOrderBusy(false);
    }
  };

  const handleCheckOrderNow = async () => {
    if (orderBusy || !activeOrder) return;
    setOrderBusy(true);
    setOrderError('');
    const status = await checkOrderOnce(activeOrder.orderId);
    if (status) {
      applyOrderStatus(status);
    } else {
      setOrderError(describeTrafficError('', 'trafficErrCheckOrder'));
    }
    setOrderBusy(false);
  };

  const handleMockConfirm = async () => {
    if (orderBusy || !activeOrder) return;
    setOrderBusy(true);
    setOrderError('');
    try {
      const res = await trafficApi.mockConfirmRechargeOrder({ orderId: activeOrder.orderId });
      if (res.success && res.order) {
        applyOrderStatus(res.order);
      } else {
        setOrderError(describeTrafficError(res.error || '', 'trafficErrCheckOrder'));
      }
    } catch (error) {
      setOrderError(describeTrafficError(error instanceof Error ? error.message : '', 'trafficErrCheckOrder'));
    } finally {
      setOrderBusy(false);
    }
  };

  const backToPlanPicker = () => {
    stopOrderPolling();
    setActiveOrder(null);
    setOrderPhase('pick');
    setOrderError('');
    setOrderBusy(false);
  };

  // Usage table always renders newest-first, regardless of backend row order
  // (the local-journal fallback aggregates ascending; both get sorted here).
  const visibleDailyRows = [...(dailyRows ?? dailyFallbackRows ?? [])]
    .sort((a, b) => b.date.localeCompare(a.date) || a.botAddress.localeCompare(b.botAddress));
  // Payment-method model for the recharge modal: a configured dev override
  // forces one gateway for every plan (single unfiltered list, no tabs);
  // otherwise plans split by currency (CNY → Alipay, other → PayPal) and the
  // user picks the method via tabs when both groups exist.
  const gatewayForced = Boolean(settings?.rechargeGateway);
  const alipayPlans = (pricingPlans ?? []).filter((plan) => gatewayForPlanCurrency(plan.payCurrency) === 'alipay');
  const paypalPlans = (pricingPlans ?? []).filter((plan) => gatewayForPlanCurrency(plan.payCurrency) !== 'alipay');
  const showMethodTabs = !gatewayForced && alipayPlans.length > 0 && paypalPlans.length > 0;
  const visiblePlans = gatewayForced
    ? (pricingPlans ?? [])
    : (rechargeMethod === 'alipay' ? alipayPlans : paypalPlans);
  // Prefer the server claimable flag; also treat enabled && !claimed as
  // claimable (same backend formula) so a missing/false claimable field
  // cannot hide the button. If status failed after the account exists,
  // keep the button so a fresh install can still claim.
  const canClaimFreeGrant = campaign
    ? Boolean(!campaign.claimed && (campaign.claimable || campaign.enabled))
    : Boolean(campaignReady && balance);
  const freeGrantBytes = campaign?.grantBytes || DEFAULT_FREE_GRANT_BYTES;

  if (!identityChecked) {
    return <p className={hintClass}>{i18nService.t('trafficLoading')}</p>;
  }

  if (!identityAddress) {
    return (
      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <UserCircleIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
              {i18nService.t('trafficCreateIdentityFirst')}
            </h4>
            <p className={hintClass}>
              {i18nService.t('trafficCreateIdentityDesc')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* apiBase override banner: the override input lives in the collapsed
          Advanced section, so surface it here while active — billing and
          sponsor writes are leaving production (2026-09 staging-residue incident). */}
      {settings?.apiBase ? (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <ExclamationTriangleIcon className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-semibold text-amber-600 dark:text-amber-400">
              {i18nService.t('trafficApiBaseOverrideTitle')}
            </h4>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5 break-all">
              {i18nService.t('trafficApiBaseOverrideDesc').replace('{value}', settings.apiBase)}
            </p>
          </div>
          <button
            type="button"
            className={`${ghostButtonClass} shrink-0`}
            onClick={() => handleSaveApiBase('')}
            disabled={apiBaseSaving}
          >
            {apiBaseSaving ? i18nService.t('trafficApiBaseSaving') : i18nService.t('trafficApiBaseOverrideReset')}
          </button>
        </div>
      ) : null}

      {/* Mode */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
          {i18nService.t('trafficModeTitle')}
        </h4>
        <p className={`${hintClass} mb-3`}>
          {i18nService.t('trafficModeDesc')}
        </p>
        <div className="inline-flex rounded-lg border dark:border-claude-darkBorder border-claude-border p-0.5">
          {([
            { value: 'traffic' as const, title: i18nService.t('trafficModeTrafficTitle') },
            { value: 'selfpay' as const, title: i18nService.t('trafficModeSelfpayTitle') },
          ]).map((option) => {
            const selected = (settings?.mode ?? 'traffic') === option.value;
            return (
              <button
                key={option.value}
                type="button"
                disabled={settingsSaving || !settings}
                onClick={() => handleSelectMode(option.value)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  selected
                    ? 'bg-claude-accent text-claude-accentInk'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {option.title}
              </button>
            );
          })}
        </div>
        <p className={`${hintClass} mt-2`}>
          {i18nService.t((settings?.mode ?? 'traffic') === 'selfpay'
            ? 'trafficModeSelfpayHint'
            : 'trafficModeTrafficHint')}
        </p>

        {bindState === 'running' && (
          <p className={`${hintClass} mt-2`}>{i18nService.t('trafficBindingRunning')}</p>
        )}
        {bindState === 'done' && bindSummary && (
          <p className="text-xs text-claude-accent mt-2">
            {i18nService.t('trafficBindSummary')
              .replace('{bound}', String(bindSummary.boundCount))
              .replace('{boundPlural}', bindSummary.boundCount === 1 ? '' : 'es')
              .replace('{conflictClause}', bindSummary.conflictCount > 0
                ? i18nService.t('trafficBindSummaryConflict').replace('{count}', String(bindSummary.conflictCount))
                : '')}
          </p>
        )}
        {bindState === 'error' && (
          <p className="text-xs text-red-500 mt-2">{bindError || i18nService.t('trafficBindFailed')}</p>
        )}
      </div>

      {/* Balance */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className={`${labelClass} inline-flex items-center gap-1`}>
              {i18nService.t('trafficBalanceTitle')}
              <button
                type="button"
                className="rounded-full p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
                onClick={() => setTariffOpen(true)}
                title={i18nService.t('trafficTariffAria')}
                aria-label={i18nService.t('trafficTariffAria')}
              >
                <QuestionMarkCircleIcon className="h-4 w-4" />
              </button>
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span
                className="text-2xl font-bold tabular-nums dark:text-claude-darkText text-claude-text"
                title={balance ? formatBytesExact(balance.balanceBytes) : undefined}
              >
                {balance ? formatTraffic(balance.balanceBytes) : '—'}
              </span>
              {balanceLoading && <ArrowPathIcon className="h-4 w-4 animate-spin dark:text-claude-darkTextSecondary text-claude-textSecondary" />}
            </div>
            {balance && (
              <p className={`${hintClass} mt-1`}>
                {i18nService.t('trafficBalanceStats')
                  .replace('{reserved}', formatTraffic(balance.reservedBytes))
                  .replace('{spent}', formatTraffic(balance.spentBytesTotal))}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <div className="flex gap-2">
              <button
                type="button"
                className={ghostButtonClass}
                onClick={() => refreshBalance(true)}
                disabled={balanceLoading}
              >
                {i18nService.t('trafficRefresh')}
              </button>
              <button
                type="button"
                className={ghostButtonClass}
                onClick={openRedeem}
              >
                <span className="inline-flex items-center gap-1">
                  <TicketIcon className="h-4 w-4" />
                  {i18nService.t('trafficRedeemCode')}
                </span>
              </button>
              <button
                type="button"
                className={primaryButtonClass}
                onClick={openRecharge}
              >
                <span className="inline-flex items-center gap-1">
                  <BoltIcon className="h-4 w-4" />
                  {i18nService.t('trafficRecharge')}
                </span>
              </button>
            </div>
          </div>
        </div>
        {(canClaimFreeGrant || claimNotice) && (
          <div className="flex items-center gap-2 mt-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 px-3 py-2">
            <p className="text-xs text-emerald-600 dark:text-emerald-400 flex-1">
              {claimNotice || i18nService.t('trafficFreeGrantHint')}
            </p>
            {canClaimFreeGrant && !claimNotice ? (
              <button
                type="button"
                className={primaryButtonClass}
                onClick={handleClaimFreeGrant}
                disabled={claiming}
              >
                {claiming
                  ? i18nService.t('trafficFreeGrantClaiming')
                  : i18nService.t('trafficFreeGrantClaim')
                      .replace('{amount}', formatTraffic(freeGrantBytes))}
              </button>
            ) : null}
          </div>
        )}
        {claimError && <p className="text-xs text-red-500 mt-2">{claimError}</p>}
        {balanceError && (
          <div className="flex items-center gap-2 mt-3">
            <p className="text-xs text-red-500 flex-1">{balanceError}</p>
            <button type="button" className={ghostButtonClass} onClick={() => refreshBalance(true)}>
              {i18nService.t('trafficRetry')}
            </button>
          </div>
        )}
        {balance && balance.balanceBytes < TRAFFIC_LOW_BALANCE_BYTES && (
          <div className="flex items-center gap-2 mt-3 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2">
            <ExclamationTriangleIcon className="h-4 w-4 text-amber-500 shrink-0" />
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {i18nService.t('trafficLowBalanceWarning')}
            </p>
          </div>
        )}
      </div>

      {/* Usage */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-2">{i18nService.t('trafficUsageTitle')}</h4>
        {summary && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {([
              { label: i18nService.t('trafficSummaryToday'), bytes: summary.todayBytes },
              { label: i18nService.t('trafficSummaryWeek'), bytes: summary.weekBytes },
              { label: i18nService.t('trafficSummaryMonth'), bytes: summary.monthBytes },
            ]).map((item) => (
              <div key={item.label} className={`${cardClass} text-center`}>
                <div className="text-sm font-bold tabular-nums dark:text-claude-darkText text-claude-text">
                  {formatTraffic(item.bytes)}
                </div>
                <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {item.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {usageError && <p className={`${hintClass} mb-2`}>{usageError}</p>}
        {visibleDailyRows.length > 0 ? (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  <th className="py-1 pr-3 font-medium">{i18nService.t('trafficTableDate')}</th>
                  <th className="py-1 pr-3 font-medium">{i18nService.t('trafficTableBot')}</th>
                  <th className="py-1 pr-3 font-medium text-right">{i18nService.t('trafficTableTraffic')}</th>
                  <th className="py-1 font-medium text-right">{i18nService.t('trafficTableWrites')}</th>
                </tr>
              </thead>
              <tbody>
                {visibleDailyRows.map((row) => (
                  <tr key={`${row.date}|${row.botAddress}`} className="dark:text-claude-darkText text-claude-text">
                    <td className="py-1 pr-3 tabular-nums">{row.date}</td>
                    <td className="py-1 pr-3">{resolveBotLabel(row.botAddress)}</td>
                    <td className="py-1 pr-3 text-right tabular-nums" title={formatBytesExact(row.bytes)}>
                      {formatTraffic(row.bytes)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{row.txCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !usageError && <p className={hintClass}>{i18nService.t('trafficUsageEmpty')}</p>
        )}

        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mt-4 mb-2">{i18nService.t('trafficLedgerTitle')}</h4>
        {ledgerEntries.length > 0 ? (
          <div className={`${cardClass} space-y-1.5`}>
            {ledgerEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 text-xs">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary tabular-nums shrink-0">
                  {formatLedgerTimestamp(entry.timestamp)}
                </span>
                <span className="dark:text-claude-darkText text-claude-text shrink-0">
                  {ledgerDirectionLabel(entry.direction)}
                </span>
                <span
                  className="dark:text-claude-darkTextSecondary text-claude-textSecondary truncate flex-1"
                  title={[entry.kind, entry.botAddress].filter(Boolean).join(' · ') || undefined}
                >
                  {resolveLedgerSourceLabel(entry)}
                </span>
                {entry.txId ? <LedgerTxIdBadge txId={entry.txId} /> : null}
                <span className="tabular-nums font-medium dark:text-claude-darkText text-claude-text shrink-0">
                  {formatAmountWithSign(entry.direction, entry.amountBytes)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          !ledgerError && <p className={hintClass}>{i18nService.t('trafficLedgerEmpty')}</p>
        )}
        {ledgerError && (
          <div className="flex items-center gap-2 mt-2">
            <p className="text-xs text-red-500 flex-1">{ledgerError}</p>
            <button type="button" className={ghostButtonClass} onClick={() => loadLedger(0)}>
              {i18nService.t('trafficRetry')}
            </button>
          </div>
        )}
        {!ledgerDone && ledgerEntries.length > 0 && (
          <div className="flex justify-center mt-2">
            <button
              type="button"
              className={ghostButtonClass}
              onClick={() => loadLedger(ledgerCursor)}
              disabled={ledgerLoading}
            >
              {ledgerLoading ? i18nService.t('trafficLedgerLoading') : i18nService.t('trafficLedgerLoadMore')}
            </button>
          </div>
        )}
      </div>

      {/* Advanced: assist-service endpoint + recharge-gateway overrides (integration testing) */}
      <div className={cardClass}>
        <button
          type="button"
          className="flex items-center justify-between w-full text-left"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('trafficAdvanced')}</span>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {advancedOpen ? i18nService.t('trafficAdvancedHide') : i18nService.t('trafficAdvancedShow')}
          </span>
        </button>
        {advancedOpen && (
          <div className="mt-3">
            <span className={labelClass}>{i18nService.t('trafficApiBaseLabel')}</span>
            <p className={`${hintClass} mt-1`}>
              {i18nService.t('trafficApiBaseCurrent').replace('{value}', settings?.apiBase ? settings.apiBase : i18nService.t('trafficApiBaseDefault'))}
            </p>
            <p className={`${hintClass} mt-1`}>
              {i18nService.t('trafficApiBaseDesc')}
            </p>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={apiBaseInput}
                onChange={(event) => {
                  setApiBaseInput(event.target.value);
                  setApiBaseError('');
                  setApiBaseNotice('');
                }}
                placeholder={i18nService.t('trafficApiBasePlaceholder')}
                className="flex-1 min-w-0 rounded-lg dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              />
              <button
                type="button"
                className={primaryButtonClass}
                onClick={() => handleSaveApiBase(apiBaseInput)}
                disabled={apiBaseSaving || !apiBaseInput.trim()}
              >
                {apiBaseSaving ? i18nService.t('trafficApiBaseSaving') : i18nService.t('trafficApiBaseSave')}
              </button>
              {settings?.apiBase ? (
                <button
                  type="button"
                  className={ghostButtonClass}
                  onClick={() => handleSaveApiBase('')}
                  disabled={apiBaseSaving}
                >
                  {i18nService.t('trafficApiBaseReset')}
                </button>
              ) : null}
            </div>
            {apiBaseError && <p className="text-xs text-red-500 mt-2">{apiBaseError}</p>}
            {apiBaseNotice && <p className="text-xs text-claude-accent mt-2">{apiBaseNotice}</p>}

            {!gatewayPackaged && (
              <div className="mt-4">
                <span className={labelClass}>{i18nService.t('trafficGatewayLabel')}</span>
                <p className={`${hintClass} mt-1`}>{i18nService.t('trafficGatewayDesc')}</p>
                <div className="flex items-center gap-2 mt-2">
                  <select
                    value={settings?.rechargeGateway ?? ''}
                    onChange={(event) => handleSaveGateway(event.target.value)}
                    disabled={gatewaySaving || !settings}
                    className="rounded-lg dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors disabled:opacity-50"
                  >
                    <option value="">{i18nService.t('trafficGatewayAuto')}</option>
                    <option value="paypal">PayPal</option>
                    <option value="alipay">Alipay（支付宝）</option>
                    <option value="mock">mock</option>
                  </select>
                </div>
                {gatewayError && <p className="text-xs text-red-500 mt-2">{gatewayError}</p>}
              </div>
            )}
          </div>
        )}
      </div>

      {redeemOpen && (
        <OverlayPanel onDismiss={() => setRedeemOpen(false)}>
          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
            {i18nService.t('trafficRedeemTitle')}
          </h4>
          <p className={`${hintClass} mb-3`}>{i18nService.t('trafficRedeemDesc')}</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={redeemCodeInput}
              onChange={(event) => {
                setRedeemCodeInput(event.target.value.toUpperCase());
                setRedeemError('');
                setRedeemSuccess(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  void handleRedeemCode();
                }
              }}
              placeholder={i18nService.t('trafficRedeemPlaceholder')}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 min-w-0 rounded-lg font-mono dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
            />
            <button
              type="button"
              className={primaryButtonClass}
              onClick={handleRedeemCode}
              disabled={redeeming || !redeemCodeInput.trim()}
            >
              {redeeming ? i18nService.t('trafficRedeeming') : i18nService.t('trafficRedeemButton')}
            </button>
          </div>
          {redeemError && <p className="text-xs text-red-500 mt-2">{redeemError}</p>}
          {redeemSuccess && (
            <div className="flex items-start gap-2 mt-3">
              <CheckCircleIcon className="h-5 w-5 text-claude-accent shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('trafficRedeemSuccess').replace('{traffic}', formatTraffic(redeemSuccess.trafficBytes))}
                </p>
                {balance && (
                  <p className={`${hintClass} mt-1`}>
                    {i18nService.t('trafficNewBalance').replace('{balance}', formatTraffic(balance.balanceBytes))}
                  </p>
                )}
              </div>
            </div>
          )}
        </OverlayPanel>
      )}

      {rechargeOpen && (
        <OverlayPanel onDismiss={closeRecharge} widthClass="w-[480px]">
          {orderPhase === 'pick' && (
            <>
              <div className="flex items-center gap-2 mb-1">
                <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('trafficRechargeTitle')}
                </h4>
                {rechargeGateway === 'mock' && (
                  <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                    {i18nService.t('trafficRechargeMockGatewayBadge')}
                  </span>
                )}
              </div>
              <p className={`${hintClass} mb-3`}>{i18nService.t('trafficRechargeDesc')}</p>
              {pricingLoading && <p className={hintClass}>{i18nService.t('trafficRechargePlansLoading')}</p>}
              {pricingError && (
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs text-red-500 flex-1">{pricingError}</p>
                  <button type="button" className={ghostButtonClass} onClick={loadPricingPlans}>
                    {i18nService.t('trafficRetry')}
                  </button>
                </div>
              )}
              {!pricingLoading && !pricingError && pricingPlans && pricingPlans.length === 0 && (
                <p className={hintClass}>{i18nService.t('trafficRechargePlansEmpty')}</p>
              )}
              {showMethodTabs && (
                <div className="inline-flex rounded-lg border dark:border-claude-darkBorder border-claude-border p-0.5 mb-2">
                  {([
                    { value: 'alipay' as const, title: i18nService.t('trafficRechargeMethodAlipay') },
                    { value: 'paypal' as const, title: i18nService.t('trafficRechargeMethodPaypal') },
                  ]).map((option) => {
                    const selected = rechargeMethod === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => handleSelectMethod(option.value)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                          selected
                            ? 'bg-claude-accent text-claude-accentInk'
                            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'
                        }`}
                      >
                        {option.title}
                      </button>
                    );
                  })}
                </div>
              )}
              {pricingPlans && pricingPlans.length > 0 && visiblePlans.length === 0 && (
                <p className={hintClass}>{i18nService.t('trafficRechargePlansEmpty')}</p>
              )}
              {visiblePlans.length > 0 && (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                  {visiblePlans.map((plan) => {
                    const selected = plan.planId === selectedPlanId;
                    return (
                      <button
                        key={plan.planId}
                        type="button"
                        onClick={() => setSelectedPlanId(plan.planId)}
                        className={`w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
                          selected
                            ? 'border-claude-accent bg-claude-accent/10'
                            : 'dark:border-claude-darkBorder border-claude-border dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                            {formatTraffic(plan.trafficBytes)}
                          </div>
                          {plan.remark ? (
                            <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
                              {plan.remark}
                            </div>
                          ) : null}
                        </div>
                        <div className="text-sm font-semibold tabular-nums dark:text-claude-darkText text-claude-text shrink-0">
                          {formatPlanPrice(plan.payCurrency, plan.payAmount)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
              {orderError && <p className="text-xs text-red-500 mt-2">{orderError}</p>}
              <div className="flex justify-end gap-2 mt-4">
                <button type="button" className={ghostButtonClass} onClick={closeRecharge}>
                  {i18nService.t('trafficRechargeCancelOrder')}
                </button>
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={handleCreateOrder}
                  disabled={orderBusy || !selectedPlanId || pricingLoading}
                >
                  {orderBusy ? i18nService.t('trafficRechargeCreating') : i18nService.t('trafficRechargePay')}
                </button>
              </div>
            </>
          )}

          {orderPhase === 'paying' && activeOrder && (
            <>
              <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
                {i18nService.t('trafficRechargeWaitingTitle')}
              </h4>
              <p className={`${hintClass} mb-3`}>
                {i18nService.t(activeOrder.gateway === 'mock'
                  ? 'trafficRechargeMockWaitingDesc'
                  : activeOrder.gateway === 'alipay'
                    ? 'trafficRechargeAlipayWaitingDesc'
                    : 'trafficRechargeWaitingDesc')}
              </p>
              <div className={`${cardClass} flex items-center justify-between`}>
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {formatTraffic(activeOrder.trafficBytes)}
                </span>
                <span className="text-sm font-semibold tabular-nums dark:text-claude-darkText text-claude-text">
                  {formatPlanPrice(activeOrder.payCurrency, activeOrder.payAmount)}
                </span>
              </div>
              {activeOrder.gateway === 'alipay' && (
                <div className="flex flex-col items-center mt-3">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={i18nService.t('trafficRechargeScanQrHint')}
                      className="h-[220px] w-[220px] rounded-xl border dark:border-claude-darkBorder border-claude-border bg-white p-1"
                    />
                  ) : (
                    <div className="h-[220px] w-[220px] rounded-xl border dark:border-claude-darkBorder border-claude-border flex items-center justify-center">
                      <ArrowPathIcon className="h-5 w-5 animate-spin dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                    </div>
                  )}
                  <p className={`${hintClass} mt-2`}>{i18nService.t('trafficRechargeScanQrHint')}</p>
                </div>
              )}
              {activeOrder.gateway !== 'mock' && (
                <div className="flex items-center gap-2 mt-3">
                  <ArrowPathIcon className="h-4 w-4 animate-spin dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0" />
                  <span className={hintClass}>{i18nService.t('trafficRechargeChecking')}</span>
                </div>
              )}
              {orderError && <p className="text-xs text-red-500 mt-2">{orderError}</p>}
              <div className="flex flex-wrap justify-end gap-2 mt-4">
                {activeOrder.gateway === 'mock' ? (
                  <button
                    type="button"
                    className={primaryButtonClass}
                    onClick={handleMockConfirm}
                    disabled={orderBusy}
                  >
                    {orderBusy ? i18nService.t('trafficRechargeChecking') : i18nService.t('trafficRechargeMockConfirm')}
                  </button>
                ) : (
                  <>
                    {activeOrder.gateway === 'paypal' && (
                      <button
                        type="button"
                        className={ghostButtonClass}
                        onClick={() => window.electron.shell.openExternal(activeOrder.approvalUrl).catch(() => {})}
                      >
                        {i18nService.t('trafficRechargeReopenLink')}
                      </button>
                    )}
                    {activeOrder.gateway === 'alipay' && /^https?:\/\//i.test(activeOrder.qrCode) && (
                      <button
                        type="button"
                        className={ghostButtonClass}
                        onClick={() => window.electron.shell.openExternal(activeOrder.qrCode).catch(() => {})}
                      >
                        {i18nService.t('trafficRechargeOpenCashierPage')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={ghostButtonClass}
                      onClick={handleCheckOrderNow}
                      disabled={orderBusy}
                    >
                      {orderBusy ? i18nService.t('trafficRechargeChecking') : i18nService.t('trafficRechargeCheckNow')}
                    </button>
                  </>
                )}
                <button type="button" className={ghostButtonClass} onClick={backToPlanPicker}>
                  {i18nService.t('trafficRechargeBackToPlans')}
                </button>
              </div>
            </>
          )}

          {orderPhase === 'credited' && activeOrder && (
            <>
              <div className="flex items-start gap-2">
                <CheckCircleIcon className="h-5 w-5 text-claude-accent shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t('trafficRechargeCredited').replace('{traffic}', formatTraffic(activeOrder.trafficBytes))}
                  </p>
                  {balance && (
                    <p className={`${hintClass} mt-1`}>
                      {i18nService.t('trafficNewBalance').replace('{balance}', formatTraffic(balance.balanceBytes))}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex justify-end mt-4">
                <button type="button" className={primaryButtonClass} onClick={closeRecharge}>
                  {i18nService.t('close')}
                </button>
              </div>
            </>
          )}

          {orderPhase === 'closed' && (
            <>
              <div className="flex items-start gap-2">
                <ExclamationTriangleIcon className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-sm dark:text-claude-darkText text-claude-text">
                  {i18nService.t('trafficRechargeClosed')}
                </p>
              </div>
              <div className="flex justify-end gap-2 mt-4">
                <button type="button" className={ghostButtonClass} onClick={closeRecharge}>
                  {i18nService.t('trafficRechargeCancelOrder')}
                </button>
                <button type="button" className={primaryButtonClass} onClick={backToPlanPicker}>
                  {i18nService.t('trafficRechargeBackToPlans')}
                </button>
              </div>
            </>
          )}
        </OverlayPanel>
      )}

      {tariffOpen && (
        <OverlayPanel onDismiss={() => setTariffOpen(false)} widthClass="w-[520px]">
          <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
            {i18nService.t('trafficTariffTitle')}
          </h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <th className="py-1.5 pr-3 font-medium">{i18nService.t('trafficTariffColType')}</th>
                <th className="py-1.5 pr-3 font-medium">{i18nService.t('trafficTariffColSize')}</th>
                <th className="py-1.5 font-medium text-right">{i18nService.t('trafficTariffColCapacity')}</th>
              </tr>
            </thead>
            <tbody>
              {TARIFF_ROWS.map((row) => (
                <tr key={row.type} className="border-t dark:border-claude-darkBorder/60 border-claude-border/60">
                  <td className="py-2 pr-3 font-medium dark:text-claude-darkText text-claude-text">
                    {i18nService.t(row.type)}
                  </td>
                  <td className="py-2 pr-3 dark:text-claude-darkTextSecondary text-claude-textSecondary tabular-nums">
                    {i18nService.t(row.size)}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold text-amber-800 dark:text-amber-400">
                    {i18nService.t(row.capacity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </OverlayPanel>
      )}
    </div>
  );
};

export default TrafficSettings;
