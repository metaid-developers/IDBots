/**
 * Onboarding Wizard (V2): Connect Brain -> Forge Twin -> Chain Awakening.
 * Reuses system LLM config (config.providers), existing IPC (idbots:addMetaBot, idbots:syncMetaBot),
 * and configService for save. No skip; UI disabled during Step 3 awakening (防误触).
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { CheckCircleIcon, ArrowPathIcon, PhotoIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { defaultConfig } from '../../config';
import { ALL_PROVIDER_KEYS } from '../../config';
import type { AppConfig } from '../../config';
import {
  testProviderConnection,
  getEffectiveApiFormat,
  shouldShowApiFormatSelector,
  getProviderDefaultBaseUrl,
} from '../../services/llmConnection';

const AVATAR_MAX_SIZE_BYTES = 100 * 1024;

type OnboardingStep = 1 | 2 | 3;
type ProviderKey = (typeof ALL_PROVIDER_KEYS)[number];

const STEP_LABELS = [
  { step: 1 as const, key: 'onboardingStep1Title' as const },
  { step: 2 as const, key: 'onboardingStep2Title' as const },
  { step: 3 as const, key: 'onboardingStep3Title' as const },
];

/** Display labels for provider keys (aligned with Settings provider list). */
const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  zhipu: 'Zhipu',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  xiaomi: 'Xiaomi',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

export interface TwinFormData {
  name: string;
  avatar: string;
}

export interface OnboardingProps {
  onComplete: () => void;
}

/** Build providers config from config + defaults (same source as Settings). */
function getProvidersForOnboarding(): NonNullable<AppConfig['providers']> {
  const config = configService.getConfig();
  const defaults = defaultConfig.providers ?? {};
  const fromConfig = config.providers ?? {};
  const keys = [...new Set([...Object.keys(defaults), ...Object.keys(fromConfig)])];
  const result: Record<string, NonNullable<AppConfig['providers']>[string]> = {};
  for (const key of keys) {
    const def = (defaults as Record<string, unknown>)[key];
    const cur = (fromConfig as Record<string, unknown>)[key];
    result[key] = { ...(def as object), ...(cur as object) } as NonNullable<AppConfig['providers']>[string];
  }
  return result as NonNullable<AppConfig['providers']>;
}

const DEFAULT_ONBOARDING_PROVIDER: ProviderKey = 'deepseek';
const DEFAULT_ONBOARDING_API_FORMAT: 'anthropic' | 'openai' = 'openai';

const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [step, setStep] = useState<OnboardingStep>(1);
  const [provider, setProvider] = useState<ProviderKey>(DEFAULT_ONBOARDING_PROVIDER);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiFormat, setApiFormat] = useState<'anthropic' | 'openai'>(DEFAULT_ONBOARDING_API_FORMAT);
  const [llmError, setLlmError] = useState('');
  const [validating, setValidating] = useState(false);
  const [selectedLlmId, setSelectedLlmId] = useState<string | null>(null);
  const [twinName, setTwinName] = useState('');
  const [twinAvatar, setTwinAvatar] = useState('');
  const [twinError, setTwinError] = useState('');
  const [addBotError, setAddBotError] = useState('');
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<{ success: boolean; error?: string; canSkip?: boolean } | null>(null);
  const [walletDone, setWalletDone] = useState(false);
  const [syncDone, setSyncDone] = useState(false);
  const [awakeningComplete, setAwakeningComplete] = useState(false);
  const [newBotId, setNewBotId] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const awakeningStartedRef = useRef(false);

  const providers = getProvidersForOnboarding();
  const providerConfig = providers[provider];
  const defaultBaseUrl = providerConfig?.baseUrl ?? '';
  const models = providerConfig?.models ?? [];
  const initialProviderSyncedRef = useRef(false);
  useEffect(() => {
    if (step !== 1 || !providerConfig || initialProviderSyncedRef.current) return;
    initialProviderSyncedRef.current = true;
    setApiKey(providerConfig.apiKey ?? '');
    setBaseUrl(providerConfig.baseUrl ?? '');
    const formatFromConfig = providerConfig.apiFormat;
    const defaultOpenAi =
      provider === 'deepseek' && (formatFromConfig === undefined || formatFromConfig === null);
    setApiFormat(defaultOpenAi ? 'openai' : getEffectiveApiFormat(provider, formatFromConfig));
  }, [step, providerConfig, provider]);
  useEffect(() => {
    if (step !== 1) initialProviderSyncedRef.current = false;
  }, [step]);

  // Step 1: Validate (reuse same logic as Settings) and save via existing configService
  const handleValidateAndNext = useCallback(async () => {
    const key = apiKey.trim();
    const effectiveBaseUrl = (baseUrl || defaultBaseUrl || (getProviderDefaultBaseUrl(provider, apiFormat) ?? '')).trim().replace(/\/+$/, '');
    if (provider !== 'ollama' && !key) {
      setLlmError(i18nService.t('apiKeyRequired'));
      return;
    }
    setValidating(true);
    setLlmError('');
    try {
      const testConfig = {
        apiKey: key,
        baseUrl: effectiveBaseUrl,
        apiFormat,
        models,
      };
      const result = await testProviderConnection(provider, testConfig, i18nService);
      if (!result.success) {
        setLlmError(result.message);
        setValidating(false);
        return;
      }

      const nextProviders = { ...providers } as NonNullable<AppConfig['providers']>;
      const existing = nextProviders[provider];
      nextProviders[provider] = {
        ...existing,
        enabled: true,
        apiKey: key,
        baseUrl: effectiveBaseUrl,
        apiFormat,
        models: existing?.models ?? models,
      };
      await configService.updateConfig({
        api: { key, baseUrl: effectiveBaseUrl },
        providers: nextProviders,
      });
      setSelectedLlmId(provider);
      setStep(2);
    } catch (err) {
      setLlmError(err instanceof Error ? err.message : i18nService.t('connectionFailed'));
    } finally {
      setValidating(false);
    }
  }, [apiKey, baseUrl, defaultBaseUrl, provider, providerConfig, providers, models, apiFormat]);

  const handleAwakenTwin = useCallback(() => {
    const name = twinName.trim();
    if (!name) {
      setTwinError(i18nService.t('metabotNameRequired'));
      return;
    }
    setTwinError('');
    setStep(3);
  }, [twinName]);

  const runAwakening = useCallback(async () => {
    const name = twinName.trim();
    const role = i18nService.t('onboardingTwinDefaultRole');
    setRunning(true);
    setAddBotError('');
    setSyncError(null);
    setWalletDone(false);
    setSyncDone(false);
    try {
      const result = await window.electron.idbots.addMetaBot({
        name,
        avatar: twinAvatar || null,
        role,
        soul: '',
        metabot_type: 'twin',
        boss_id: 0,
        llm_id: selectedLlmId ?? null,
      });
      if (!result.success || !result.metabot) {
        setAddBotError(result.error || 'Failed to create MetaBot');
        setRunning(false);
        return;
      }
      setWalletDone(true);
      const id = result.metabot.id;
      setNewBotId(id);

      const delayMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const SYNC_DELAY_MS = 2500;
      await delayMs(SYNC_DELAY_MS);

      let syncResult = await window.electron.idbots.syncMetaBot(id);
      if (!syncResult.success) {
        await delayMs(SYNC_DELAY_MS);
        syncResult = await window.electron.idbots.syncMetaBot(id);
      }
      if (!syncResult.success) {
        setLastSyncResult(syncResult);
        setSyncError(syncResult.error ?? i18nService.t('onboardingSyncError'));
        setRunning(false);
        return;
      }
      setLastSyncResult(syncResult);
      setSyncDone(true);
      setAwakeningComplete(true);
    } catch (err) {
      setAddBotError(err instanceof Error ? err.message : 'Failed to create MetaBot');
    } finally {
      setRunning(false);
    }
  }, [twinName, twinAvatar, selectedLlmId]);

  useEffect(() => {
    if (step === 3 && !awakeningStartedRef.current) {
      awakeningStartedRef.current = true;
      runAwakening();
    }
  }, [step, runAwakening]);

  const handleRetrySync = useCallback(() => {
    setSyncError(null);
    if (newBotId != null) {
      setRunning(true);
      window.electron.idbots.syncMetaBot(newBotId).then((syncResult) => {
        setLastSyncResult(syncResult);
        setRunning(false);
        if (syncResult.success) {
          setSyncDone(true);
          setAwakeningComplete(true);
        } else {
          setSyncError(syncResult.error ?? i18nService.t('onboardingSyncError'));
        }
      });
    }
  }, [newBotId]);

  const handleSkipAndEnter = useCallback(() => {
    setSyncError(null);
    setAwakeningComplete(true);
    onComplete();
  }, [onComplete]);

  const handleAvatarFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX_SIZE_BYTES) {
      setTwinError(i18nService.t('metabotAvatarSizeError'));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setTwinAvatar((reader.result as string) ?? '');
    reader.readAsDataURL(file);
    setTwinError('');
    e.target.value = '';
  };

  const isAwakeningRunning = step === 3 && running && !awakeningComplete;
  const visibleProviderKeys = ALL_PROVIDER_KEYS.filter((k) => providers[k] != null);

  return (
    <div className="h-screen flex flex-col dark:bg-[#0a0e17] bg-[#0f172a]" style={{ background: 'var(--bg-main, #0f172a)' }}>
      {isAwakeningRunning && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center"
          aria-hidden
          style={{ pointerEvents: 'auto' }}
        />
      )}
      <div className={`flex-1 flex flex-col items-center justify-center p-6 min-h-0 ${isAwakeningRunning ? 'pointer-events-none' : ''}`}>
        <div className="w-full max-w-lg rounded-2xl border border-white/10 dark:border-white/10 bg-white/5 dark:bg-white/5 shadow-2xl overflow-hidden">
          <div className="flex border-b border-white/10 px-6 py-4 gap-2">
            {STEP_LABELS.map(({ step: s, key }) => (
              <div
                key={s}
                className={`flex-1 text-center text-sm font-medium py-1 rounded-lg ${
                  step === s
                    ? 'bg-claude-accent/20 text-claude-accent'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary'
                }`}
              >
                {i18nService.t(key)}
              </div>
            ))}
          </div>

          <div className="p-6">
            {step === 1 && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                    {i18nService.t('onboardingConnectBrainTitle')}
                  </h2>
                  <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                    {i18nService.t('onboardingConnectBrainSubtitle')}
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                    {i18nService.t('modelProviders')}
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => {
                      const p = e.target.value as ProviderKey;
                      setProvider(p);
                      const cfg = providers[p];
                      setApiKey(cfg?.apiKey ?? '');
                      setBaseUrl(cfg?.baseUrl ?? '');
                      const fmt = cfg?.apiFormat;
                      const defaultOpenAi = p === 'deepseek' && (fmt === undefined || fmt === null);
                      setApiFormat(defaultOpenAi ? 'openai' : getEffectiveApiFormat(p, fmt));
                      setLlmError('');
                    }}
                    className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:ring-2 focus:ring-claude-accent"
                  >
                    {visibleProviderKeys.map((key) => (
                      <option key={key} value={key}>
                        {PROVIDER_LABELS[key] ?? key}
                      </option>
                    ))}
                  </select>
                </div>
                {shouldShowApiFormatSelector(provider) && (
                  <div>
                    <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                      {i18nService.t('apiFormat')}
                    </label>
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="onboarding-apiFormat"
                          checked={apiFormat === 'anthropic'}
                          onChange={() => {
                            setApiFormat('anthropic');
                            const def = getProviderDefaultBaseUrl(provider, 'anthropic');
                            if (def) setBaseUrl(def);
                            setLlmError('');
                          }}
                          className="text-claude-accent focus:ring-claude-accent"
                        />
                        <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('apiFormatNative')}</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="onboarding-apiFormat"
                          checked={apiFormat === 'openai'}
                          onChange={() => {
                            setApiFormat('openai');
                            const def = getProviderDefaultBaseUrl(provider, 'openai');
                            if (def) setBaseUrl(def);
                            setLlmError('');
                          }}
                          className="text-claude-accent focus:ring-claude-accent"
                        />
                        <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('apiFormatOpenAI')}</span>
                      </label>
                    </div>
                    <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
                      {i18nService.t('apiFormatHint')}
                    </p>
                  </div>
                )}
                {provider !== 'ollama' && (
                  <>
                    <div>
                      <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                        {i18nService.t('apiKey')}
                      </label>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={i18nService.t('apiKeyPlaceholder')}
                        className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:ring-2 focus:ring-claude-accent"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                        {i18nService.t('baseUrl')}
                      </label>
                      <input
                        type="url"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={getProviderDefaultBaseUrl(provider, apiFormat) ?? defaultBaseUrl}
                        className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:ring-2 focus:ring-claude-accent"
                      />
                    </div>
                  </>
                )}
                {llmError && (
                  <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                    {llmError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleValidateAndNext}
                  disabled={validating}
                  className="btn-idchat-primary-filled w-full py-2.5 font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {validating ? (
                    <>
                      <ArrowPathIcon className="h-4 w-4 animate-spin" />
                      {i18nService.t('testing')}
                    </>
                  ) : (
                    i18nService.t('onboardingValidateAndNext')
                  )}
                </button>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                    {i18nService.t('onboardingForgeTwinTitle')}
                  </h2>
                  <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                    {i18nService.t('onboardingForgeTwinSubtitle')}
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                    {i18nService.t('metabotName')}
                  </label>
                  <input
                    type="text"
                    value={twinName}
                    onChange={(e) => setTwinName(e.target.value)}
                    placeholder={i18nService.t('metabotNamePlaceholder')}
                    className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:ring-2 focus:ring-claude-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                    {i18nService.t('metabotAvatar')}
                  </label>
                  <div className="flex items-center gap-3">
                    <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
                      {twinAvatar && (twinAvatar.startsWith('data:') || twinAvatar.startsWith('http')) ? (
                        <img src={twinAvatar} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <input type="file" accept="image/png,image/jpeg,image/jpg,image/webp,image/gif" className="hidden" id="onboarding-avatar" onChange={handleAvatarFile} />
                      <label
                        htmlFor="onboarding-avatar"
                        className="inline-block px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer"
                      >
                        {i18nService.t('metabotAvatarUpload')}
                      </label>
                      <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                        {i18nService.t('metabotAvatarPlaceholder')}
                      </p>
                    </div>
                  </div>
                </div>
                {twinError && (
                  <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                    {twinError}
                  </div>
                )}
                <button
                  type="button"
                  onClick={handleAwakenTwin}
                  className="btn-idchat-primary-filled w-full py-2.5 font-medium"
                >
                  {i18nService.t('onboardingAwakenTwin')}
                </button>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                {!awakeningComplete ? (
                  <>
                    <div className="flex items-center gap-2 text-sm dark:text-claude-darkText text-claude-text">
                      {walletDone ? (
                        <CheckCircleIcon className="h-5 w-5 text-emerald-500 shrink-0" />
                      ) : (
                        <ArrowPathIcon className="h-5 w-5 animate-spin shrink-0" />
                      )}
                      <span>{i18nService.t('onboardingStepWalletSubsidy')}</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm dark:text-claude-darkText text-claude-text">
                      {syncDone ? (
                        <CheckCircleIcon className="h-5 w-5 text-emerald-500 shrink-0" />
                      ) : syncError ? (
                        <span className="shrink-0 w-5 h-5 rounded-full border-2 border-red-500" />
                      ) : (
                        <ArrowPathIcon className="h-5 w-5 animate-spin shrink-0" />
                      )}
                      <span>{i18nService.t('onboardingStepSyncMetaWeb')}</span>
                    </div>
                    {addBotError && (
                      <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                        {addBotError}
                      </div>
                    )}
                    {syncError && (
                      <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 rounded-lg px-3 py-2">
                        {syncError}
                      </div>
                    )}
                    {syncError && (
                      <div className="space-y-2">
                        {walletDone && lastSyncResult?.canSkip && (
                          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {i18nService.t('onboardingSkipHint')}
                          </p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={handleRetrySync}
                            disabled={running}
                            className="flex-1 py-2.5 rounded-xl border border-red-500/50 text-red-500 dark:text-red-400 font-medium hover:bg-red-500/10 disabled:opacity-50 flex items-center justify-center gap-2"
                          >
                            {running ? <ArrowPathIcon className="h-4 w-4 animate-spin" /> : null}
                            {i18nService.t('onboardingRetry')}
                          </button>
                          {walletDone && lastSyncResult?.canSkip && (
                            <button
                              type="button"
                              onClick={handleSkipAndEnter}
                              disabled={running}
                              className="flex-1 py-2.5 rounded-xl border border-white/20 dark:border-white/20 font-medium hover:bg-white/10 disabled:opacity-50"
                            >
                              {i18nService.t('onboardingSkip')}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-center py-2">
                      <div className="text-4xl mb-2 animate-bounce" role="img" aria-hidden>
                        🎉 🤖 ✨
                      </div>
                      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                        {i18nService.t('onboardingCelebration')}
                      </h2>
                    </div>
                    <button
                      type="button"
                      onClick={onComplete}
                      className="btn-idchat-primary-filled w-full py-3 font-semibold text-lg"
                    >
                      {i18nService.t('onboardingEnterIdBots')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
