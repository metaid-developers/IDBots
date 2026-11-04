/**
 * IM Settings Component
 * Configuration UI for DingTalk, Feishu and Telegram IM bots
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { SignalIcon, XMarkIcon, CheckCircleIcon, XCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RootState, store } from '../../store';
import { imService } from '../../services/im';
import { coworkService } from '../../services/cowork';
import { setDingTalkConfig, setFeishuConfig, setTelegramConfig, setDiscordConfig, setQQConfig, setIMSettings, clearError } from '../../store/slices/imSlice';
import { getPlatformConfigAction } from './platformConfigActions';
import { i18nService } from '../../services/i18n';
import type { IMPlatform, IMConnectivityCheck, IMConnectivityTestResult, IMGatewayConfig, IMChannelPermissionMode } from '../../types/im';
import type { QQGroupCandidateView } from '../../types/im';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';
import MetaBotSelector, { type MetaBotForSelector } from '../cowork/MetaBotSelector';
import {
  QQ_DAILY_REPLY_LIMIT_DEFAULT,
  QQ_DAILY_REPLY_LIMIT_MAX,
  QQ_DAILY_REPLY_LIMIT_MIN,
  QQ_RATE_GROUP_PER_MINUTE,
  QQ_RATE_SENDER_PER_MINUTE,
} from '../../../main/shared/qqRateLimit';
import QRCode from 'qrcode';

interface IMMetabotOption extends MetaBotForSelector {}

interface ChainListenerConfig {
  enabled: boolean;
  groupChats: boolean;
  privateChats: boolean;
  serviceRequests?: boolean;
  respondToStrangerPrivateChats: boolean;
}

type ChainListenerToggleType = 'enabled' | 'groupChats' | 'privateChats' | 'respondToStrangerPrivateChats';

type SettingsPlatform = IMPlatform | 'chainListener';

// Platform metadata
const platformMeta: Record<IMPlatform, { label: string; logo: string }> = {
  dingtalk: { label: 'DingTalk', logo: 'dingding.png' },
  feishu: { label: 'Feishu', logo: 'feishu.png' },
  telegram: { label: 'Telegram', logo: 'telegram.svg' },
  discord: { label: 'Discord', logo: 'discord.svg' },
  weixin: { label: 'WeChat', logo: 'weixin.svg' },
  qq: { label: 'QQ', logo: 'qq.svg' },
};

const verdictColorClass: Record<IMConnectivityTestResult['verdict'], string> = {
  pass: 'bg-green-500/15 text-green-600 dark:text-green-400',
  warn: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

const checkLevelColorClass: Record<IMConnectivityCheck['level'], string> = {
  pass: 'text-green-600 dark:text-green-400',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-yellow-700 dark:text-yellow-300',
  fail: 'text-red-600 dark:text-red-400',
};

const IMSettings: React.FC = () => {
  const dispatch = useDispatch();
  const { config, status, isLoading } = useSelector((state: RootState) => state.im);
  const [activePlatform, setActivePlatform] = useState<SettingsPlatform>('dingtalk');
  const [testingPlatform, setTestingPlatform] = useState<IMPlatform | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<Partial<Record<IMPlatform, IMConnectivityTestResult>>>({});
  const [connectivityModalPlatform, setConnectivityModalPlatform] = useState<IMPlatform | null>(null);
  const [language, setLanguage] = useState<'zh' | 'en'>(i18nService.getLanguage());
  const [metabotOptions, setMetabotOptions] = useState<IMMetabotOption[]>([]);
  const [metabotLoading, setMetabotLoading] = useState(false);
  const [metabotLoadError, setMetabotLoadError] = useState('');
  const [chainListenerConfig, setChainListenerConfig] = useState<ChainListenerConfig>({
    enabled: true,
    groupChats: false,
    privateChats: true,
    serviceRequests: false,
    respondToStrangerPrivateChats: true,
  });
  const [chainListenerRunning, setChainListenerRunning] = useState(false);
  const [chainListenerLoading, setChainListenerLoading] = useState(false);
  // Weixin QR authorization state (client-side only; the token never reaches the renderer)
  const [weixinQrImage, setWeixinQrImage] = useState<string | null>(null);
  const [weixinLoginLoading, setWeixinLoginLoading] = useState(false);
  const [weixinLoginError, setWeixinLoginError] = useState('');
  const [weixinHasCredentials, setWeixinHasCredentials] = useState(false);
  // QQ QR authorization + manual credentials (the AppSecret never comes back).
  const [qqQrImage, setQqQrImage] = useState<string | null>(null);
  const [qqLoginLoading, setQqLoginLoading] = useState(false);
  const [qqLoginError, setQqLoginError] = useState('');
  const [qqHasCredentials, setQqHasCredentials] = useState(false);
  const [qqAppId, setQqAppId] = useState('');
  const [qqAppSecret, setQqAppSecret] = useState('');
  const [qqSaving, setQqSaving] = useState(false);
  const [qqSaveMessage, setQqSaveMessage] = useState('');
  // QQ security surface (group policy + layer-3 switch). Enforced in the main
  // process; this UI only edits the config.
  //
  // Groups are NOT typed in any more: the owner cannot know the platform's
  // 32-hex group OpenID, so the gateway records the id of every group that
  // messaged the bot while unauthorized and this page lists them.
  const [qqGroupCandidates, setQqGroupCandidates] = useState<QQGroupCandidateView[]>([]);
  /** Every recorded group (pending + allowed + ignored) — used for name display. */
  const [qqGroupCandidatesAll, setQqGroupCandidatesAll] = useState<QQGroupCandidateView[]>([]);
  const [qqGroupCandidatesLoading, setQqGroupCandidatesLoading] = useState(false);
  const [qqGroupCandidateError, setQqGroupCandidateError] = useState('');
  const [qqGroupIdCopied, setQqGroupIdCopied] = useState<string | null>(null);
  const [qqGroupNameNotice, setQqGroupNameNotice] = useState<string | null>(null);
  const [qqLocalAllowFromText, setQqLocalAllowFromText] = useState('');
  /** Draft text for the configurable daily cap; committed on blur/save. */
  const [qqDailyLimitText, setQqDailyLimitText] = useState(String(QQ_DAILY_REPLY_LIMIT_DEFAULT));

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Initialize IM service and subscribe status updates
  useEffect(() => {
    void imService.init();
    return () => {
      imService.destroy();
    };
  }, []);

  useEffect(() => {
    const loadMetabots = async () => {
      setMetabotLoading(true);
      setMetabotLoadError('');
      try {
        const result = await window.electron.idbots.getMetaBots();
        if (result.success && Array.isArray(result.list)) {
          setMetabotOptions(result.list as IMMetabotOption[]);
        } else {
          setMetabotLoadError(result.error || i18nService.t('metabotLoadFailed'));
        }
      } catch (error: any) {
        setMetabotLoadError(error?.message || i18nService.t('metabotLoadFailed'));
      } finally {
        setMetabotLoading(false);
      }
    };
    void loadMetabots();
  }, []);

  useEffect(() => {
    const loadChainListener = async () => {
      setChainListenerLoading(true);
      try {
        const [configResult, statusResult] = await Promise.all([
          window.electron.metaWebListener.getListenerConfig(),
          window.electron.metaWebListener.getListenerStatus(),
        ]);
        if (configResult?.config) {
          setChainListenerConfig(configResult.config as ChainListenerConfig);
        }
        if (typeof statusResult?.running === 'boolean') {
          setChainListenerRunning(statusResult.running);
        }
      } catch {
        // ignore
      } finally {
        setChainListenerLoading(false);
      }
    };
    void loadChainListener();
  }, []);

  // Handle DingTalk config change
  const handleDingTalkChange = (field: 'clientId' | 'clientSecret', value: string) => {
    dispatch(setDingTalkConfig({ [field]: value }));
  };

  // Handle Feishu config change
  const handleFeishuChange = (field: 'appId' | 'appSecret', value: string) => {
    dispatch(setFeishuConfig({ [field]: value }));
  };

  // Handle Telegram config change
  const handleTelegramChange = (field: 'botToken' | 'proxyUrl', value: string) => {
    dispatch(setTelegramConfig({ [field]: value }));
  };

  // Handle Discord config change
  const handleDiscordChange = (field: 'botToken', value: string) => {
    dispatch(setDiscordConfig({ [field]: value }));
  };

  // ==================== QQ authorization ====================

  const refreshQQCredentials = async () => {
    try {
      const result = await window.electron.im.qqCheckCredentials();
      const has = Boolean(result?.success && result.hasCredentials);
      setQqHasCredentials(has);
      if (has && result?.appId && !qqAppId) {
        setQqAppId(result.appId);
      }
    } catch {
      setQqHasCredentials(false);
    }
  };

  const renderQQQr = async (content: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(content, { width: 320, margin: 1 });
      setQqQrImage(dataUrl);
    } catch {
      setQqQrImage(null);
      setQqLoginError(i18nService.t('qqScanExpired'));
    }
  };

  const handleQQScan = async () => {
    setQqLoginLoading(true);
    setQqLoginError('');
    setQqSaveMessage('');
    try {
      const result = await window.electron.im.qqLoginStart();
      if (result?.success && result.content) {
        await renderQQQr(result.content);
        await refreshQQCredentials();
      } else {
        setQqLoginError(result?.error || i18nService.t('qqScanExpired'));
      }
    } catch (error: any) {
      setQqLoginError(error?.message || 'Failed to start the QQ QR login');
    } finally {
      setQqLoginLoading(false);
    }
  };

  const handleQQCancelScan = async () => {
    try {
      await window.electron.im.qqLoginCancel();
    } catch {
      // ignore: the pending login times out on its own
    }
    setQqQrImage(null);
  };

  const handleQQFillCredentials = async () => {
    const appId = qqAppId.trim();
    const appSecret = qqAppSecret.trim();
    if (!appId || !appSecret) {
      setQqLoginError(i18nService.t('qqCredentialsRequired'));
      return;
    }
    setQqSaving(true);
    setQqLoginError('');
    setQqSaveMessage('');
    try {
      const saved = await window.electron.im.qqSetCredentials({ appId, appSecret });
      if (!saved?.success) {
        setQqLoginError(saved?.error || 'Failed to save QQ credentials');
        return;
      }
      // The secret is now in the 0600 store and the main process already
      // mirrored appId / botId / ownerUserOpenid into `im_config`. Only the
      // switch is a renderer concern — never send the identifier fields back.
      setQqAppSecret('');
      dispatch(setQQConfig({ appId }));
      await imService.updateConfig({ qq: { enabled: true } } as Partial<IMGatewayConfig>);
      const started = await imService.startGateway('qq');
      await imService.loadConfig();
      setQqHasCredentials(true);
      setQqSaveMessage(started ? i18nService.t('qqConnected') : i18nService.t('qqSavedNotConnected'));
    } catch (error: any) {
      setQqLoginError(error?.message || 'Failed to save QQ credentials');
    } finally {
      setQqSaving(false);
    }
  };

  useEffect(() => {
    void refreshQQCredentials();
  }, []);

  useEffect(() => {
    if (status.qq.loginPending && status.qq.qrContent) {
      setQqLoginError('');
      void renderQQQr(status.qq.qrContent);
    }
    if (!status.qq.loginPending) {
      setQqQrImage(null);
    }
    if (status.qq.connected) {
      setQqHasCredentials(true);
      if (status.qq.appId) setQqAppId(status.qq.appId);
      // The scan writes appId / ownerUserOpenid in the MAIN process; this
      // component still holds the pre-scan row. Pull it once so the local
      // snapshot never disagrees with the authoritative config again. Only a
      // still-blank local appId triggers the reload — comparing "different"
      // would loop if the main row cannot be read back.
      if (status.qq.appId && !config.qq.appId) {
        void imService.loadConfig();
      }
    }
  }, [status.qq.loginPending, status.qq.qrContent, status.qq.connected, status.qq.appId, config.qq.appId]);

  const handleChainListenerToggle = async (type: ChainListenerToggleType, enabled: boolean) => {
    setChainListenerLoading(true);
    try {
      await window.electron.metaWebListener.toggleListener({ type, enabled });
      const configResult = await window.electron.metaWebListener.getListenerConfig();
      if (configResult?.config) {
        setChainListenerConfig(configResult.config as ChainListenerConfig);
      } else {
        setChainListenerConfig((prev) => ({ ...prev, [type]: enabled }));
      }
      const statusResult = await window.electron.metaWebListener.getListenerStatus();
      if (typeof statusResult?.running === 'boolean') {
        setChainListenerRunning(statusResult.running);
      }
    } catch {
      // ignore
    } finally {
      setChainListenerLoading(false);
    }
  };

  // Save config on blur
  const handleSaveConfig = async () => {
    await imService.updateConfig(config);
  };

  const getDefaultMetabotId = (): number | null => {
    if (metabotOptions.length === 0) return null;
    const twin = metabotOptions.find((item) => item.metabot_type === 'twin');
    return twin?.id ?? metabotOptions[0].id;
  };

  const getResolvedPlatformMetabotId = (platform: IMPlatform): number | null => {
    const configuredId = config[platform].metabotId ?? null;
    if (configuredId != null && metabotOptions.some((item) => item.id === configuredId)) {
      return configuredId;
    }
    return getDefaultMetabotId();
  };

  const handlePlatformMetabotChange = async (platform: IMPlatform, rawValue: string) => {
    const trimmed = rawValue.trim();
    const parsed = trimmed ? Number(trimmed) : NaN;
    const metabotId = Number.isFinite(parsed) ? parsed : null;
    const setMetabotIdAction = getPlatformConfigAction(platform);
    dispatch(setMetabotIdAction({ metabotId }));
    const stateAfterDispatch = store.getState();
    await imService.updateConfig(stateAfterDispatch.im.config);
  };

  const renderMetabotSelector = (platform: IMPlatform) => {
    const selectedMetabotId = getResolvedPlatformMetabotId(platform);
    const empty = metabotOptions.length === 0;
    return (
      <div className="space-y-1.5">
        <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('imMatchedMetabot')}
        </label>
        <MetaBotSelector
          label={i18nService.t('imMatchedMetabot')}
          metabots={metabotOptions}
          selectedId={selectedMetabotId ?? null}
          onSelect={(id) => { void handlePlatformMetabotChange(platform, String(id)); }}
          placeholder={metabotLoading ? i18nService.t('loading') : i18nService.t('imMatchedMetabotEmpty')}
          disabled={metabotLoading || empty}
        />
        <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {i18nService.t('imMatchedMetabotHint')}
        </p>
        {metabotLoadError && (
          <p className="text-xs text-red-500 dark:text-red-400">{metabotLoadError}</p>
        )}
      </div>
    );
  };

  const getCheckTitle = (code: IMConnectivityCheck['code']): string => {
    return i18nService.t(`imConnectivityCheckTitle_${code}`);
  };

  const getCheckSuggestion = (check: IMConnectivityCheck): string | undefined => {
    if (check.suggestion) {
      return check.suggestion;
    }
    if (check.code === 'gateway_running' && check.level === 'pass') {
      return undefined;
    }
    const suggestion = i18nService.t(`imConnectivityCheckSuggestion_${check.code}`);
    if (suggestion.startsWith('imConnectivityCheckSuggestion_')) {
      return undefined;
    }
    return suggestion;
  };

  const formatTestTime = (timestamp: number): string => {
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return String(timestamp);
    }
  };

  const runConnectivityTest = async (
    platform: IMPlatform,
    configOverride?: Partial<IMGatewayConfig>
  ) => {
    setTestingPlatform(platform);
    const result = await imService.testGateway(platform, configOverride);
    if (result) {
      setConnectivityResults((prev) => ({ ...prev, [platform]: result }));
    }
    setTestingPlatform(null);
  };

  // Toggle gateway on/off and persist enabled state
  const toggleGateway = async (platform: IMPlatform) => {
    const isEnabled = config[platform].enabled;
    const newEnabled = !isEnabled;

    // Map platform to its Redux action. The registry is exhaustive over
    // IMPlatform, so this can no longer resolve to undefined for a platform
    // whose key was forgotten (that shipped once as `setConfigAction is not a
    // function` on the QQ enable switch).
    const setEnabledAction = getPlatformConfigAction(platform);

    // Update Redux state
    dispatch(setEnabledAction({ enabled: newEnabled }));

    // Send ONLY the switch. This component holds a snapshot of `im_config`
    // from mount time; after a QR scan the main process mirrored appId /
    // ownerUserOpenid into the row while this snapshot still said
    // `appId: ''`. Spreading it back here wiped the row and the channel then
    // failed to resolve its 0600 credential — the "toggle flips it to
    // disconnected" bug. Identifier fields belong to the main process.
    await imService.updateConfig({ [platform]: { enabled: newEnabled } } as Partial<IMGatewayConfig>);

    if (newEnabled) {
      dispatch(clearError());
      const success = await imService.startGateway(platform);
      if (!success) {
        // Rollback enabled state on failure
        dispatch(setEnabledAction({ enabled: false }));
        await imService.updateConfig({ [platform]: { enabled: false } } as Partial<IMGatewayConfig>);
      } else {
        // Read the authoritative row back (the main process may have rebuilt
        // appId / ownerUserOpenid from the credential file on the way up).
        await imService.loadConfig();
        const refreshed = imService.getConfig();
        await runConnectivityTest(platform, {
          [platform]: { ...refreshed[platform], enabled: true },
        } as Partial<IMGatewayConfig>);
      }
    } else {
      await imService.stopGateway(platform);
    }
  };

  const dingtalkConnected = status.dingtalk.connected;
  const feishuConnected = status.feishu.connected;
  const telegramConnected = status.telegram.connected;
  const discordConnected = status.discord.connected;
  const weixinConnected = status.weixin.connected;
  const qqLocalAllowFromSignature = (config.qq.localToolsAllowFrom ?? []).join('\n');
  useEffect(() => {
    setQqLocalAllowFromText(qqLocalAllowFromSignature);
  }, [qqLocalAllowFromSignature]);

  // The daily cap is editable, so the input holds a draft string while the
  // committed value lives in the config. Re-sync whenever the config changes
  // (including a rollback after a failed save).
  const qqDailyLimitSignature = String(
    config.qq.dailyReplyLimit ?? QQ_DAILY_REPLY_LIMIT_DEFAULT
  );
  useEffect(() => {
    setQqDailyLimitText(qqDailyLimitSignature);
  }, [qqDailyLimitSignature]);

  const parseQQIdList = (text: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of text.split(/[\n,]/)) {
      const id = raw.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  const saveQQSecurity = async (patch: Partial<typeof config.qq>) => {
    try {
      dispatch(setQQConfig(patch));
      // Send the patch, not the whole slice: the snapshot can be older than
      // the main process's identifier mirror.
      await imService.updateConfig({ qq: patch } as Partial<IMGatewayConfig>);
      setQqSaveMessage(i18nService.t('qqConnected'));
    } catch (error: any) {
      setQqLoginError(error?.message ?? String(error));
    }
  };

  /**
   * Commit the daily cap. Invalid input (empty, NaN, 0, negative, above the
   * guard rail) reverts to the stored value instead of persisting garbage —
   * the main process would fall back to 500 anyway, and silently disagreeing
   * with the input is worse than refusing the edit.
   */
  const saveQQDailyLimit = async () => {
    const parsed = Number(qqDailyLimitText.trim());
    const limit = Number.isFinite(parsed) ? Math.floor(parsed) : Number.NaN;
    if (
      !Number.isFinite(limit)
      || limit < QQ_DAILY_REPLY_LIMIT_MIN
      || limit > QQ_DAILY_REPLY_LIMIT_MAX
    ) {
      setQqDailyLimitText(qqDailyLimitSignature);
      return;
    }
    setQqDailyLimitText(String(limit));
    if (limit === Number(qqDailyLimitSignature)) return;
    await saveQQSecurity({ dailyReplyLimit: limit });
  };

  // ---- QQ pending groups -------------------------------------------------
  //
  // The main process remembers the group OpenID of every group that messaged
  // the bot while it was NOT allowlisted (silently: no reply, no model, no
  // tool, no memory). This page is the only place that list is shown, and the
  // only way a group ever gets authorized — by clicking 允许, never by typing.

  const applyQQGroupCandidateReport = (
    pending?: QQGroupCandidateView[] | null,
    all?: QQGroupCandidateView[] | null
  ) => {
    if (Array.isArray(pending)) setQqGroupCandidates(pending);
    if (Array.isArray(all)) setQqGroupCandidatesAll(all);
  };

  const refreshQQGroupCandidates = async (options: { silent?: boolean } = {}) => {
    // `silent` is for the background poll: it must not flash the button label
    // every 8 seconds while the owner is reading the list.
    if (!options.silent) setQqGroupCandidatesLoading(true);
    try {
      const result = await window.electron.im.qqListGroupCandidates();
      if (result?.success) {
        applyQQGroupCandidateReport(result.pending, result.all);
        setQqGroupCandidateError('');
      } else {
        setQqGroupCandidateError(result?.error || 'Failed to read pending QQ groups');
      }
    } catch (error: any) {
      setQqGroupCandidateError(error?.message || 'Failed to read pending QQ groups');
    } finally {
      if (!options.silent) setQqGroupCandidatesLoading(false);
    }
  };

  const allowQQGroup = async (groupId: string) => {
    const current = config.qq.groupAllowlist ?? [];
    if (!current.includes(groupId)) {
      await saveQQSecurity({ groupAllowlist: [...current, groupId] });
    }
    await refreshQQGroupCandidates();
  };

  const removeQQGroup = async (groupId: string) => {
    const current = config.qq.groupAllowlist ?? [];
    await saveQQSecurity({ groupAllowlist: current.filter((id) => id !== groupId) });
    await refreshQQGroupCandidates();
  };

  const ignoreQQGroup = async (groupId: string) => {
    try {
      const result = await window.electron.im.qqDismissGroupCandidate(groupId);
      if (result?.success) {
        applyQQGroupCandidateReport(result.pending, result.all);
        setQqGroupCandidateError('');
      } else {
        setQqGroupCandidateError(result?.error || 'Failed to ignore the group');
      }
    } catch (error: any) {
      setQqGroupCandidateError(error?.message || 'Failed to ignore the group');
    }
  };

  const copyQQGroupId = async (groupId: string) => {
    try {
      await navigator.clipboard.writeText(groupId);
      setQqGroupIdCopied(groupId);
      setTimeout(() => setQqGroupIdCopied((current) => (current === groupId ? null : current)), 1500);
    } catch {
      // Clipboard permission can be denied; the id is still selectable on screen.
      setQqGroupIdCopied(null);
    }
  };

  const resolveQQGroupName = async (groupId: string) => {
    setQqGroupNameNotice(null);
    try {
      const result = await window.electron.im.qqResolveGroupName(groupId);
      if (!result?.success) {
        setQqGroupCandidateError(result?.error || 'Failed to resolve the group name');
        return;
      }
      // `nameStatus` is the honest answer: only 'ok' carries a name. Saying so
      // out loud is the point — we never dress an id up as a name.
      if (result.nameStatus === 'forbidden') {
        setQqGroupNameNotice(i18nService.t('qqGroupNameForbidden'));
      } else if (result.nameStatus === 'ok') {
        setQqGroupNameNotice(null);
      } else {
        setQqGroupNameNotice(i18nService.t('qqGroupNameUnavailable'));
      }
      await refreshQQGroupCandidates();
    } catch (error: any) {
      setQqGroupCandidateError(error?.message || 'Failed to resolve the group name');
    }
  };

  useEffect(() => {
    if (activePlatform !== 'qq') return;
    void refreshQQGroupCandidates();
    // Light poll while the QQ card is open: the owner @-mentions the bot in a
    // new group, then wants the row to appear without reloading the app.
    const timer = setInterval(() => {
      void refreshQQGroupCandidates({ silent: true });
    }, 8000);
    return () => clearInterval(timer);
  }, [activePlatform]);

  /** Recorded name for an already-allowed group, if the platform gave us one. */
  const qqKnownGroupName = (groupId: string): string | null => {
    const match = qqGroupCandidatesAll.find((candidate) => candidate.groupId === groupId);
    return match?.name ?? null;
  };

  const qqConnected = status.qq.connected;

  // Compute visible platforms based on language
  const platforms = useMemo<IMPlatform[]>(() => {
    return getVisibleIMPlatforms(language) as IMPlatform[];
  }, [language]);

  // Ensure activePlatform is always in visible platforms when language changes
  useEffect(() => {
    if (activePlatform === 'chainListener') {
      return;
    }
    if (platforms.length > 0 && !platforms.includes(activePlatform)) {
      // If current activePlatform is not visible, switch to first visible platform
      setActivePlatform(platforms[0]);
    }
  }, [platforms, activePlatform]);

  // Check if platform can be started
  const canStart = (platform: IMPlatform): boolean => {
    if (platform === 'dingtalk') {
      return !!(config.dingtalk.clientId && config.dingtalk.clientSecret);
    }
    if (platform === 'telegram') {
      return !!config.telegram.botToken;
    }
    if (platform === 'discord') {
      return !!config.discord.botToken;
    }
    if (platform === 'weixin') {
      return weixinHasCredentials;
    }
    if (platform === 'qq') {
      return qqHasCredentials;
    }
    return !!(config.feishu.appId && config.feishu.appSecret);
  };

  // Get platform enabled state (persisted toggle state)
  const isPlatformEnabled = (platform: IMPlatform): boolean => {
    return config[platform].enabled;
  };

  // Get platform connection status (runtime state)
  const getPlatformConnected = (platform: IMPlatform): boolean => {
    if (platform === 'dingtalk') return dingtalkConnected;
    if (platform === 'telegram') return telegramConnected;
    if (platform === 'discord') return discordConnected;
    if (platform === 'weixin') return weixinConnected;
    if (platform === 'qq') return qqConnected;
    return feishuConnected;
  };

  // Get platform transient starting status
  const getPlatformStarting = (platform: IMPlatform): boolean => {
    if (platform === 'discord') return status.discord.starting;
    return false;
  };

  const chainListenerActive = chainListenerConfig.enabled
    && (chainListenerConfig.groupChats || chainListenerConfig.privateChats);

  const handleConnectivityTest = async (platform: IMPlatform) => {
    setConnectivityModalPlatform(platform);
    await runConnectivityTest(platform, {
      [platform]: config[platform],
    } as Partial<IMGatewayConfig>);
  };

  // Handle platform toggle
  const handlePlatformToggle = (platform: IMPlatform) => {
    const isEnabled = isPlatformEnabled(platform);
    // Can toggle ON if credentials are present, can always toggle OFF
    const canToggle = isEnabled || canStart(platform);
    if (canToggle && !isLoading) {
      setActivePlatform(platform);
      // toggleGateway handles its own errors (startGateway returns false, never
      // throws); mark the promise void so a rejection can't escape as an
      // unhandledrejection the way the pre-fix TypeError did.
      void toggleGateway(platform);
    }
  };

  // ==================== Weixin QR authorization ====================

  const refreshWeixinCredentials = async () => {
    try {
      const result = await window.electron.im.weixinCheckCredentials();
      setWeixinHasCredentials(Boolean(result?.success && result.hasCredentials));
    } catch {
      setWeixinHasCredentials(false);
    }
  };

  const renderWeixinQr = async (content: string) => {
    try {
      const dataUrl = await QRCode.toDataURL(content, { width: 320, margin: 1 });
      setWeixinQrImage(dataUrl);
    } catch {
      setWeixinQrImage(null);
      setWeixinLoginError(i18nService.t('weixinScanExpired'));
    }
  };

  const handleWeixinScan = async () => {
    setWeixinLoginLoading(true);
    setWeixinLoginError('');
    try {
      const result = await window.electron.im.weixinLoginStart();
      if (result?.success && result.content) {
        await renderWeixinQr(result.content);
        await refreshWeixinCredentials();
      } else {
        setWeixinLoginError(result?.error || i18nService.t('weixinScanExpired'));
      }
    } catch (error: any) {
      setWeixinLoginError(error?.message || 'Failed to start the WeChat QR login');
    } finally {
      setWeixinLoginLoading(false);
    }
  };

  const handleWeixinCancelScan = async () => {
    try {
      await window.electron.im.weixinLoginCancel();
    } catch {
      // ignore: the pending login will time out on its own
    }
    setWeixinQrImage(null);
  };

  useEffect(() => {
    void refreshWeixinCredentials();
  }, []);

  useEffect(() => {
    if (status.weixin.loginPending && status.weixin.qrContent) {
      setWeixinLoginError('');
      void renderWeixinQr(status.weixin.qrContent);
    }
    if (!status.weixin.loginPending) {
      setWeixinQrImage(null);
    }
    if (status.weixin.connected) {
      setWeixinHasCredentials(true);
    }
  }, [status.weixin.loginPending, status.weixin.qrContent, status.weixin.connected]);

  const renderConnectivityTestButton = (platform: IMPlatform) => (
    <button
      type="button"
      onClick={() => handleConnectivityTest(platform)}
      disabled={isLoading || testingPlatform === platform}
      className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
    >
      <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
      {testingPlatform === platform
        ? i18nService.t('imConnectivityTesting')
        : connectivityResults[platform]
          ? i18nService.t('imConnectivityRetest')
          : i18nService.t('imConnectivityTest')}
    </button>
  );

  useEffect(() => {
    if (!connectivityModalPlatform) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setConnectivityModalPlatform(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [connectivityModalPlatform]);

  return (
    <div className="flex h-full gap-4">
      {/* Platform List - Left Side */}
      <div className="w-48 flex-shrink-0 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-2 overflow-y-auto">
        {platforms.map((platform) => {
          const meta = platformMeta[platform];
          const isEnabled = isPlatformEnabled(platform);
          const isConnected = getPlatformConnected(platform) || getPlatformStarting(platform);
          const canToggle = isEnabled || canStart(platform);
          return (
            <div
              key={platform}
              onClick={() => setActivePlatform(platform)}
              className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                activePlatform === platform
                  ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30'
                  : 'bg-claude-surfaceHover/80 dark:bg-claude-darkSurface/55 dark:bg-gradient-to-br dark:from-claude-darkSurface/70 dark:to-claude-darkSurfaceHover/70 hover:bg-claude-surface dark:hover:from-claude-darkSurface/80 dark:hover:to-claude-darkSurfaceHover/80 dark:border-claude-darkBorder/70 border-claude-border/80 border'
              }`}
            >
              <div className="flex flex-1 items-center">
                <div className="mr-2 flex h-7 w-7 items-center justify-center">
                  <img
                    src={meta.logo}
                    alt={i18nService.t(platform)}
                    className="w-6 h-6 object-contain"
                  />
                </div>
                <span className={`text-sm font-medium truncate ${
                  activePlatform === platform
                    ? 'text-claude-accent'
                    : 'dark:text-claude-darkText text-claude-text'
                }`}>
                  {i18nService.t(platform)}
                </span>
              </div>
              <div className="flex items-center ml-2">
                <div
                  className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                    isEnabled
                      ? (isConnected ? 'bg-green-500' : 'bg-yellow-500')
                      : 'dark:bg-claude-darkBorder bg-claude-border'
                  } ${!canToggle ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePlatformToggle(platform);
                  }}
                >
                  <div
                    className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                      isEnabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </div>
            </div>
          );
        })}
        <div
          onClick={() => setActivePlatform('chainListener')}
          className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
            activePlatform === 'chainListener'
              ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30'
              : 'bg-claude-surfaceHover/80 dark:bg-claude-darkSurface/55 dark:bg-gradient-to-br dark:from-claude-darkSurface/70 dark:to-claude-darkSurfaceHover/70 hover:bg-claude-surface dark:hover:from-claude-darkSurface/80 dark:hover:to-claude-darkSurfaceHover/80 dark:border-claude-darkBorder/70 border-claude-border/80 border'
          }`}
        >
          <div className="flex flex-1 items-center">
            <div className="mr-2 flex h-7 w-7 items-center justify-center rounded-md bg-white border border-claude-border/40 dark:border-claude-darkBorder/50">
              <SignalIcon className="h-4 w-4 shrink-0 text-gray-900" />
            </div>
            <span className={`text-sm font-medium truncate ${
              activePlatform === 'chainListener'
                ? 'text-claude-accent'
                : 'dark:text-claude-darkText text-claude-text'
            }`}>
              {i18nService.t('chainListener')}
            </span>
          </div>
          <div className="flex items-center ml-2">
            <div
              className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                chainListenerConfig.enabled
                  ? (chainListenerRunning ? 'bg-green-500' : 'bg-yellow-500')
                  : 'dark:bg-claude-darkBorder bg-claude-border'
              } ${chainListenerLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              onClick={(e) => {
                e.stopPropagation();
                if (chainListenerLoading) return;
                void handleChainListenerToggle('enabled', !chainListenerConfig.enabled);
              }}
            >
              <div
                className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                  chainListenerConfig.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                }`}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Platform Settings - Right Side */}
      <div className="flex-1 min-w-0 space-y-4 overflow-y-auto">
        {/* Header with status */}
        <div className="flex items-center gap-3 pb-3 border-b dark:border-claude-darkBorder/60 border-claude-border/60">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white border border-claude-border/40 dark:border-claude-darkBorder/50 p-1">
              {activePlatform === 'chainListener' ? (
                <SignalIcon className="h-4 w-4 shrink-0 text-gray-900" />
              ) : (
                <img
                  src={platformMeta[activePlatform].logo}
                  alt={i18nService.t(activePlatform)}
                  className="w-4 h-4 object-contain"
                />
              )}
            </div>
            <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {activePlatform === 'chainListener'
                ? i18nService.t('chainListener')
                : `${i18nService.t(activePlatform)}${i18nService.t('settings')}`}
            </h3>
          </div>
          {activePlatform !== 'chainListener' ? (
            <div className={`px-2 py-0.5 rounded-full text-xs font-medium ${
              getPlatformConnected(activePlatform) || getPlatformStarting(activePlatform)
                ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                : 'bg-gray-500/15 text-gray-500 dark:text-gray-400'
            }`}>
              {getPlatformConnected(activePlatform)
                ? i18nService.t('connected')
                : getPlatformStarting(activePlatform)
                  ? i18nService.t('starting')
                  : i18nService.t('disconnected')}
            </div>
          ) : chainListenerActive ? (
            <div
              className={chainListenerRunning
                ? 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                : 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-500/20 text-amber-600 dark:text-amber-400'}
            >
              <span
                className={chainListenerRunning
                  ? 'h-2 w-2 rounded-full bg-emerald-500'
                  : 'h-2 w-2 rounded-full bg-amber-500'}
              />
              {chainListenerRunning
                ? i18nService.t('chainListenerStatusConnected')
                : i18nService.t('chainListenerStatusConnecting')}
            </div>
          ) : null}
        </div>

        {/* DingTalk Settings */}
        {activePlatform === 'dingtalk' && (
          <div className="space-y-3">
            {/* Client ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Client ID (AppKey)
              </label>
              <input
                type="text"
                value={config.dingtalk.clientId}
                onChange={(e) => handleDingTalkChange('clientId', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="dingxxxxxx"
              />
            </div>

            {/* Client Secret */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Client Secret (AppSecret)
              </label>
              <input
                type="password"
                value={config.dingtalk.clientSecret}
                onChange={(e) => handleDingTalkChange('clientSecret', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="••••••••••••"
              />
            </div>

            {renderMetabotSelector('dingtalk')}

            <div className="pt-1">
              {renderConnectivityTestButton('dingtalk')}
            </div>

            {/* Error display */}
            {status.dingtalk.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.dingtalk.lastError}
              </div>
            )}
          </div>
        )}

        {/* Feishu Settings */}
        {activePlatform === 'feishu' && (
          <div className="space-y-3">
            {/* App ID */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                App ID
              </label>
              <input
                type="text"
                value={config.feishu.appId}
                onChange={(e) => handleFeishuChange('appId', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="cli_xxxxx"
              />
            </div>

            {/* App Secret */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                App Secret
              </label>
              <input
                type="password"
                value={config.feishu.appSecret}
                onChange={(e) => handleFeishuChange('appSecret', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="••••••••••••"
              />
            </div>

            {renderMetabotSelector('feishu')}

            <div className="pt-1">
              {renderConnectivityTestButton('feishu')}
            </div>

            {/* Error display */}
            {status.feishu.error && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.feishu.error}
              </div>
            )}
          </div>
        )}

        {/* Telegram Settings */}
        {activePlatform === 'telegram' && (
          <div className="space-y-3">
            {/* Bot Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Bot Token
              </label>
              <input
                type="password"
                value={config.telegram.botToken}
                onChange={(e) => handleTelegramChange('botToken', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
              />
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('telegramTokenHint')}
              </p>
            </div>

            {/* Proxy URL (optional, for restricted networks) */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('telegramProxyUrlLabel')}
              </label>
              <input
                type="text"
                value={config.telegram.proxyUrl ?? ''}
                onChange={(e) => handleTelegramChange('proxyUrl', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="http://127.0.0.1:7890"
              />
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('telegramProxyUrlHint')}
              </p>
            </div>

            {renderMetabotSelector('telegram')}

            <div className="pt-1">
              {renderConnectivityTestButton('telegram')}
            </div>

            {/* Bot username display */}
            {status.telegram.botUsername && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Bot: @{status.telegram.botUsername}
              </div>
            )}

            {/* Error display */}
            {status.telegram.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.telegram.lastError}
              </div>
            )}
          </div>
        )}

        {/* Weixin Settings */}
        {activePlatform === 'weixin' && (
          <div className="space-y-3">
            <div className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
              {i18nService.t('weixinChannelNotice')}
            </div>

            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {weixinConnected
                ? i18nService.t('weixinAuthorized')
                : weixinHasCredentials
                  ? i18nService.t('weixinScanHint')
                  : i18nService.t('weixinNoCredentials')}
            </div>

            {weixinQrImage && (
              <div className="flex flex-col items-center gap-2 rounded-xl border dark:border-claude-darkBorder border-claude-border p-3">
                <img src={weixinQrImage} alt="WeChat QR code" className="h-40 w-40" />
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {status.weixin.loginState === 'scanned'
                    ? i18nService.t('weixinScanScanned')
                    : i18nService.t('weixinScanWaiting')}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {!status.weixin.loginPending ? (
                <button
                  type="button"
                  onClick={() => { void handleWeixinScan(); }}
                  disabled={weixinLoginLoading}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {weixinLoginLoading ? i18nService.t('loading') : i18nService.t('weixinScanConnect')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { void handleWeixinCancelScan(); }}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                >
                  <XMarkIcon className="h-3.5 w-3.5 mr-1.5" />
                  {i18nService.t('weixinScanCancel')}
                </button>
              )}
              {weixinConnected && (
                <button
                  type="button"
                  onClick={() => { void imService.stopGateway('weixin'); }}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('weixinDisconnect')}
                </button>
              )}
              {renderConnectivityTestButton('weixin')}
            </div>

            <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('weixinScanHint')}
            </p>
            <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('weixinTokenHint')}
            </p>

            {renderMetabotSelector('weixin')}

            {/* Channel permission mode. DEFAULT = inherit the same persisted
                global mode the desktop uses, so 完全信任 chosen there is also in
                force in chat. An override exists for the rare per-channel case. */}
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-2.5 space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('weixinPermissionModeLabel')}
              </label>
              <select
                value={config.settings.channelPermissions?.weixinPermissionMode ?? 'inherit'}
                onChange={(e) => {
                  dispatch(setIMSettings({
                    channelPermissions: {
                      ...config.settings.channelPermissions,
                      weixinPermissionMode: e.target.value as IMChannelPermissionMode,
                    },
                  }));
                  void imService.updateConfig(store.getState().im.config).then((saved) => {
                    // The open WeChat session's permission label is resolved
                    // from this setting on read; refresh it so the window never
                    // shows the stale row value.
                    if (saved) void coworkService.refreshImSessionPermissionMode();
                  });
                }}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
              >
                <option value="inherit">{i18nService.t('imPermissionModeInherit')}</option>
                <option value="default">{i18nService.t('imPermissionModeDefault')}</option>
                <option value="plan">{i18nService.t('imPermissionModePlan')}</option>
                <option value="acceptEdits">{i18nService.t('imPermissionModeAcceptEdits')}</option>
                <option value="bypassPermissions">{i18nService.t('imPermissionModeBypass')}</option>
              </select>
              <p className="text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('weixinPermissionModeHint')}
              </p>
            </div>

            {weixinLoginError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {weixinLoginError}
              </div>
            )}

            {status.weixin.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.weixin.lastError}
              </div>
            )}
          </div>
        )}

        {/* QQ Settings (official QQ Open Platform bot) */}
        {activePlatform === 'qq' && (
          <div className="space-y-3">
            <div className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-700 dark:text-sky-300">
              {i18nService.t('qqChannelNotice')}
            </div>

            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {qqConnected
                ? i18nService.t('qqConnected')
                : qqHasCredentials
                  ? i18nService.t('qqReady')
                  : i18nService.t('qqNoCredentials')}
            </div>

            {qqQrImage && (
              <div className="flex flex-col items-center gap-2 rounded-xl border dark:border-claude-darkBorder border-claude-border p-3">
                <img src={qqQrImage} alt="QQ QR code" className="h-40 w-40" />
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {status.qq.loginState === 'scanned' || status.qq.loginState === 'confirmed'
                    ? i18nService.t('qqScanScanned')
                    : i18nService.t('qqScanWaiting')}
                </p>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              {!status.qq.loginPending ? (
                <button
                  type="button"
                  onClick={() => { void handleQQScan(); }}
                  disabled={qqLoginLoading}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
                  {qqLoginLoading ? i18nService.t('loading') : i18nService.t('qqScanConnect')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { void handleQQCancelScan(); }}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                >
                  <XMarkIcon className="h-3.5 w-3.5 mr-1.5" />
                  {i18nService.t('qqScanCancel')}
                </button>
              )}
              {qqConnected && (
                <button
                  type="button"
                  onClick={() => { void imService.stopGateway('qq'); }}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                >
                  {i18nService.t('qqDisconnect')}
                </button>
              )}
              {renderConnectivityTestButton('qq')}
            </div>

            <div className="space-y-1.5 rounded-xl border dark:border-claude-darkBorder border-claude-border p-3">
              <p className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('qqManualTitle')}
              </p>
              <label className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                AppID
              </label>
              <input
                type="text"
                value={qqAppId}
                onChange={(e) => setQqAppId(e.target.value)}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="1020xxxxxx"
                autoComplete="off"
              />
              <label className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                AppSecret
              </label>
              <input
                type="password"
                value={qqAppSecret}
                onChange={(e) => setQqAppSecret(e.target.value)}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder={qqHasCredentials ? '••••••••••••••••' : ''}
                autoComplete="new-password"
              />
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { void handleQQFillCredentials(); }}
                  disabled={qqSaving}
                  className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                >
                  {qqSaving ? i18nService.t('loading') : i18nService.t('qqSaveConnect')}
                </button>
                {qqSaveMessage && (
                  <span className="text-xs text-green-600 dark:text-green-400">{qqSaveMessage}</span>
                )}
              </div>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('qqSecretHint')}
              </p>
            </div>

            <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('qqScanHint')}
            </p>
            <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('qqGroupHint')}
            </p>

            <div className="space-y-2 rounded-xl border dark:border-claude-darkBorder border-claude-border p-3">
              <p className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('qqSecurityTitle')}
              </p>

              <label className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('qqGroupPolicyLabel')}
              </label>
              <select
                value={config.qq.groupPolicy ?? 'allowlist'}
                onChange={(e) => {
                  const value = e.target.value as 'open' | 'allowlist' | 'disabled';
                  void saveQQSecurity({ groupPolicy: value });
                }}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm"
              >
                <option value="allowlist">{i18nService.t('qqGroupPolicyAllowlist')}</option>
                <option value="open">{i18nService.t('qqGroupPolicyOpen')}</option>
                <option value="disabled">{i18nService.t('qqGroupPolicyDisabled')}</option>
              </select>

              {(config.qq.groupPolicy ?? 'allowlist') === 'allowlist' && (
                <>
                  {/* Pending groups. No paste box anywhere: the id comes from
                      the platform, the owner only decides. */}
                  <div className="space-y-2 rounded-lg border dark:border-claude-darkBorder/70 border-claude-border/70 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                        {i18nService.t('qqPendingGroupsTitle')}
                      </span>
                      <button
                        type="button"
                        onClick={() => { void refreshQQGroupCandidates(); }}
                        disabled={qqGroupCandidatesLoading}
                        className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {qqGroupCandidatesLoading ? i18nService.t('loading') : i18nService.t('qqPendingGroupsRefresh')}
                      </button>
                    </div>
                    <p className="text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('qqPendingGroupsHint')}
                    </p>

                    {qqGroupCandidates.length === 0 ? (
                      <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('qqPendingGroupsEmpty')}
                      </p>
                    ) : (
                      <ul className="space-y-1.5">
                        {qqGroupCandidates.map((candidate) => (
                          <li
                            key={candidate.groupId}
                            className="rounded-lg dark:bg-claude-darkSurface/60 bg-claude-surface/60 p-2 space-y-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="text-xs font-medium truncate dark:text-claude-darkText text-claude-text"
                                title={candidate.name ?? candidate.groupId}
                              >
                                {candidate.name ?? i18nService.t('qqPendingGroupUnnamed')}
                              </span>
                              <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary shrink-0">
                                {i18nService.t('qqPendingGroupMessageCount').replace('{count}', String(candidate.messageCount))}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5">
                              <code
                                className="flex-1 min-w-0 truncate rounded dark:bg-claude-darkSurface bg-claude-surface px-1.5 py-1 text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary select-all"
                                title={candidate.groupId}
                              >
                                {candidate.groupId}
                              </code>
                              <button
                                type="button"
                                onClick={() => { void copyQQGroupId(candidate.groupId); }}
                                className="shrink-0 px-2 py-1 text-[11px] rounded border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                              >
                                {qqGroupIdCopied === candidate.groupId
                                  ? i18nService.t('qqGroupIdCopied')
                                  : i18nService.t('qqGroupIdCopy')}
                              </button>
                            </div>

                            {candidate.nameStatus === 'forbidden' && (
                              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                                {i18nService.t('qqGroupNameForbidden')}
                              </p>
                            )}

                            <div className="flex flex-wrap items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => { void allowQQGroup(candidate.groupId); }}
                                className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-claude-accent text-claude-accentInk hover:opacity-90 transition-opacity"
                              >
                                {i18nService.t('qqPendingGroupAllow')}
                              </button>
                              <button
                                type="button"
                                onClick={() => { void ignoreQQGroup(candidate.groupId); }}
                                className="px-2.5 py-1 text-[11px] rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                              >
                                {i18nService.t('qqPendingGroupIgnore')}
                              </button>
                              <button
                                type="button"
                                onClick={() => { void resolveQQGroupName(candidate.groupId); }}
                                className="px-2.5 py-1 text-[11px] rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                                title={i18nService.t('qqGroupNameLookupHint')}
                              >
                                {i18nService.t('qqGroupNameLookup')}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {qqGroupNameNotice && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400">{qqGroupNameNotice}</p>
                    )}
                    {qqGroupCandidateError && (
                      <p className="text-[11px] text-red-500">{qqGroupCandidateError}</p>
                    )}
                  </div>

                  {/* Allowed groups. Removal lives here, not in a textarea. */}
                  <div className="space-y-1.5">
                    <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('qqGroupAllowlistLabel')}
                    </span>
                    {(config.qq.groupAllowlist ?? []).length === 0 ? (
                      <p className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                        {i18nService.t('qqGroupAllowlistEmpty')}
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {(config.qq.groupAllowlist ?? []).map((groupId) => (
                          <li
                            key={groupId}
                            className="flex items-center gap-1.5 rounded-lg dark:bg-claude-darkSurface/60 bg-claude-surface/60 px-2 py-1.5"
                          >
                            <div className="flex-1 min-w-0">
                              {qqKnownGroupName(groupId) && (
                                <p className="text-[11px] font-medium truncate dark:text-claude-darkText text-claude-text">
                                  {qqKnownGroupName(groupId)}
                                </p>
                              )}
                              <code
                                className="block truncate text-[11px] font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary select-all"
                                title={groupId}
                              >
                                {groupId}
                              </code>
                            </div>
                            <button
                              type="button"
                              onClick={() => { void copyQQGroupId(groupId); }}
                              className="shrink-0 px-2 py-1 text-[11px] rounded border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                            >
                              {qqGroupIdCopied === groupId
                                ? i18nService.t('qqGroupIdCopied')
                                : i18nService.t('qqGroupIdCopy')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void removeQQGroup(groupId); }}
                              className="shrink-0 px-2 py-1 text-[11px] rounded border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors"
                            >
                              {i18nService.t('qqAllowedGroupRemove')}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('qqGroupAllowlistHint')}
                  </p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {i18nService.t('qqGroupNamePolicyHint')}
                  </p>
                </>
              )}

              {/* Group rate limiting. The two per-minute numbers are
                  hard-coded (they are flood guards, not preferences); only the
                  daily cap is editable. Every limit is silent by design. */}
              <div className="space-y-2 rounded-lg border dark:border-claude-darkBorder/70 border-claude-border/70 p-2.5">
                <p className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('qqRateLimitTitle')}
                </p>
                <p className="text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('qqRateLimitPerMinuteHint')
                    .replace('{sender}', String(QQ_RATE_SENDER_PER_MINUTE))
                    .replace('{group}', String(QQ_RATE_GROUP_PER_MINUTE))}
                </p>
                <label className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('qqDailyLimitLabel')}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={QQ_DAILY_REPLY_LIMIT_MIN}
                    max={QQ_DAILY_REPLY_LIMIT_MAX}
                    step={1}
                    value={qqDailyLimitText}
                    onChange={(e) => setQqDailyLimitText(e.target.value)}
                    onBlur={() => { void saveQQDailyLimit(); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    className="block w-32 rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => { void saveQQDailyLimit(); }}
                    className="inline-flex items-center px-3 py-2 text-xs font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                  >
                    {i18nService.t('save')}
                  </button>
                </div>
                <p className="text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t('qqDailyLimitHint').replace(
                    '{default}',
                    String(QQ_DAILY_REPLY_LIMIT_DEFAULT)
                  )}
                </p>
                <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
                  {i18nService.t('qqRateLimitSilentHint')}
                </p>
              </div>

              <label className="flex items-start gap-2 text-xs dark:text-claude-darkText text-claude-text">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={config.qq.localToolsEnabled === true}
                  onChange={(e) => {
                    void saveQQSecurity({
                      localToolsEnabled: e.target.checked,
                      localToolsAllowFrom: parseQQIdList(qqLocalAllowFromText),
                    });
                  }}
                />
                <span>{i18nService.t('qqLocalToolsEnable')}</span>
              </label>

              {config.qq.localToolsEnabled === true && (
                <>
                  <label className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('qqLocalToolsAllowFromLabel')}
                  </label>
                  <textarea
                    value={qqLocalAllowFromText}
                    onChange={(e) => setQqLocalAllowFromText(e.target.value)}
                    onBlur={() => {
                      void saveQQSecurity({ localToolsAllowFrom: parseQQIdList(qqLocalAllowFromText) });
                    }}
                    rows={2}
                    spellCheck={false}
                    className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs font-mono"
                  />
                </>
              )}

              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('qqLocalToolsHint')}
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {i18nService.t('qqGroupInviteWarning')}
              </p>
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('qqGroupIsolationHint')}
              </p>
            </div>

            {renderMetabotSelector('qq')}

            {qqLoginError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {qqLoginError}
              </div>
            )}

            {status.qq.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.qq.lastError}
              </div>
            )}
          </div>
        )}

        {/* Discord Settings */}
        {activePlatform === 'discord' && (
          <div className="space-y-3">
            {/* Bot Token */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                Bot Token
              </label>
              <input
                type="password"
                value={config.discord.botToken}
                onChange={(e) => handleDiscordChange('botToken', e.target.value)}
                onBlur={handleSaveConfig}
                className="block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors"
                placeholder="MTIzNDU2Nzg5MDEyMzQ1Njc4OQ..."
              />
              <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('discordTokenHint')}
              </p>
            </div>

            {renderMetabotSelector('discord')}

            <div className="pt-1">
              {renderConnectivityTestButton('discord')}
            </div>

            {/* Bot username display */}
            {status.discord.botUsername && (
              <div className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                Bot: {status.discord.botUsername}
              </div>
            )}

            {/* Error display */}
            {status.discord.lastError && (
              <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">
                {status.discord.lastError}
              </div>
            )}
          </div>
        )}

        {activePlatform === 'chainListener' && (
          <div className="space-y-3">
            <label className="flex flex-col gap-1.5 rounded-xl p-4 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('chainListenerToggleGroup')}
                </span>
                <input
                  type="checkbox"
                  checked={chainListenerConfig.groupChats}
                  onChange={(e) => { void handleChainListenerToggle('groupChats', e.target.checked); }}
                  disabled={!chainListenerConfig.enabled || chainListenerLoading}
                  className="rounded border-claude-border dark:border-claude-darkBorder disabled:opacity-60"
                />
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('chainListenerToggleGroupDesc')}
              </p>
            </label>
            <label className="flex flex-col gap-1.5 rounded-xl p-4 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('chainListenerTogglePrivate')}
                </span>
                <input
                  type="checkbox"
                  checked={chainListenerConfig.privateChats}
                  onChange={(e) => { void handleChainListenerToggle('privateChats', e.target.checked); }}
                  disabled={!chainListenerConfig.enabled || chainListenerLoading}
                  className="rounded border-claude-border dark:border-claude-darkBorder disabled:opacity-60"
                />
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('chainListenerTogglePrivateDesc')}
              </p>
            </label>
            <label className="flex flex-col gap-1.5 rounded-xl p-4 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('chainListenerToggleRespondToStrangers')}
                </span>
                <input
                  type="checkbox"
                  checked={chainListenerConfig.respondToStrangerPrivateChats}
                  onChange={(e) => { void handleChainListenerToggle('respondToStrangerPrivateChats', e.target.checked); }}
                  disabled={!chainListenerConfig.enabled || !chainListenerConfig.privateChats || chainListenerLoading}
                  className="rounded border-claude-border dark:border-claude-darkBorder disabled:opacity-60"
                />
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('chainListenerToggleRespondToStrangersDesc')}
              </p>
            </label>
          </div>
        )}

        {connectivityModalPlatform && (
          <div
            className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
            onClick={() => setConnectivityModalPlatform(null)}
          >
            <div
              className="w-full max-w-2xl dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal border dark:border-claude-darkBorder border-claude-border overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border flex items-center justify-between">
                <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                  {`${i18nService.t(connectivityModalPlatform)} ${i18nService.t('imConnectivitySectionTitle')}`}
                </div>
                <button
                  type="button"
                  aria-label={i18nService.t('close')}
                  onClick={() => setConnectivityModalPlatform(null)}
                  className="p-1 rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </div>

              <div className="p-4 max-h-[65vh] overflow-y-auto">
                {testingPlatform === connectivityModalPlatform ? (
                  <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('imConnectivityTesting')}
                  </div>
                ) : connectivityResults[connectivityModalPlatform] ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${verdictColorClass[connectivityResults[connectivityModalPlatform]!.verdict]}`}>
                        {connectivityResults[connectivityModalPlatform]!.verdict === 'pass' ? (
                          <CheckCircleIcon className="h-3.5 w-3.5" />
                        ) : connectivityResults[connectivityModalPlatform]!.verdict === 'warn' ? (
                          <ExclamationTriangleIcon className="h-3.5 w-3.5" />
                        ) : (
                          <XCircleIcon className="h-3.5 w-3.5" />
                        )}
                        {i18nService.t(`imConnectivityVerdict_${connectivityResults[connectivityModalPlatform]!.verdict}`)}
                      </div>
                      <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {`${i18nService.t('imConnectivityLastChecked')}: ${formatTestTime(connectivityResults[connectivityModalPlatform]!.testedAt)}`}
                      </div>
                    </div>

                    <div className="space-y-2">
                      {connectivityResults[connectivityModalPlatform]!.checks.map((check, index) => (
                        <div
                          key={`${check.code}-${index}`}
                          className="rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-2 dark:bg-claude-darkSurface/25 bg-white/70"
                        >
                          <div className={`text-xs font-medium ${checkLevelColorClass[check.level]}`}>
                            {getCheckTitle(check.code)}
                          </div>
                          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {check.message}
                          </div>
                          {getCheckSuggestion(check) && (
                            <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              {`${i18nService.t('imConnectivitySuggestion')}: ${getCheckSuggestion(check)}`}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('imConnectivityNoResult')}
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t dark:border-claude-darkBorder border-claude-border flex items-center justify-end">
                {renderConnectivityTestButton(connectivityModalPlatform)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default IMSettings;
