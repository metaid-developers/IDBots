import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircleIcon, EyeIcon, EyeSlashIcon, KeyIcon } from '@heroicons/react/24/outline';
import { mobileI18n, t } from '../../../i18n';
import type { ProviderTemplateModel } from '../../../../renderer/services/providerTemplates';
import { getMobileElectron } from '../../appBridge';
import {
  MOBILE_PROVIDER_PRESETS,
  MobileModelValidationError,
  configuredProviderKeys,
  customProviderKey,
  defaultModelSummary,
  hasSavedProviderKey,
  isOfficialProvider,
  officialProviderKey,
  providerKeyForPreset,
  saveMobileModelSelection,
  validateMobileModelSelection,
  type MobileApiFormat,
  type MobileModelConfig,
  type MobileModelSelection,
} from '../../services/modelSettings';
import { SecondaryPageShell } from './SecondaryPageShell';

interface ModelFormState {
  providerKey: string;
  providerName: string;
  apiKey: string;
  hasStoredKey: boolean;
  baseUrl: string;
  apiFormat: MobileApiFormat;
  modelId: string;
  models: ProviderTemplateModel[];
  customModel: boolean;
  advancedOpen: boolean;
  apiKeyManagementUrl?: string;
  logoKey?: string;
}

const EMPTY_FORM: ModelFormState = {
  providerKey: '',
  providerName: '',
  apiKey: '',
  hasStoredKey: false,
  baseUrl: '',
  apiFormat: 'openai',
  modelId: '',
  models: [],
  customModel: true,
  advancedOpen: true,
};

function choiceForExisting(providerKey: string): string {
  return `existing:${providerKey}`;
}

function formForChoice(choice: string, config: MobileModelConfig): ModelFormState {
  const currentDefault = config.model?.defaultProvider;
  const currentModel = config.model?.defaultModel;
  if (choice === 'official') {
    const providerKey = officialProviderKey(config) ?? '';
    const provider = config.providers?.[providerKey];
    const models = (provider?.models ?? []).map((model) => ({ ...model }));
    const modelId = currentDefault === providerKey && currentModel
      ? currentModel
      : models[0]?.id ?? '';
    return {
      ...EMPTY_FORM,
      providerKey,
      providerName: 'ID.Bots',
      modelId,
      models,
      customModel: !models.some((model) => model.id === modelId),
      advancedOpen: false,
    };
  }
  if (choice.startsWith('existing:')) {
    const providerKey = choice.slice('existing:'.length);
    const provider = config.providers?.[providerKey];
    const models = (provider?.models ?? []).map((model) => ({ ...model }));
    const modelId = currentDefault === providerKey && currentModel
      ? currentModel
      : models[0]?.id ?? '';
    return {
      ...EMPTY_FORM,
      providerKey,
      providerName: provider?.name ?? providerKey,
      hasStoredKey: hasSavedProviderKey(provider),
      baseUrl: provider?.baseUrl ?? '',
      apiFormat: provider?.apiFormat ?? 'openai',
      modelId,
      models,
      customModel: !models.some((model) => model.id === modelId),
      advancedOpen: providerKey.startsWith('custom-'),
      apiKeyManagementUrl: provider?.apiKeyManagementUrl,
      logoKey: provider?.logoKey,
    };
  }
  if (choice.startsWith('preset:')) {
    const templateId = choice.slice('preset:'.length);
    const template = MOBILE_PROVIDER_PRESETS.find((entry) => entry.templateId === templateId);
    if (template) {
      const providerKey = providerKeyForPreset(template.templateId);
      const existing = config.providers?.[providerKey];
      const language = mobileI18n.getLanguage();
      return {
        ...EMPTY_FORM,
        providerKey,
        providerName: language === 'zh' ? template.nameZh : template.nameEn,
        hasStoredKey: hasSavedProviderKey(existing),
        baseUrl: template.baseUrl,
        apiFormat: template.apiFormat,
        modelId: template.models[0]?.id ?? '',
        models: template.models.map((model) => ({ ...model })),
        customModel: false,
        advancedOpen: false,
        apiKeyManagementUrl: template.apiKeyManagementUrl,
        logoKey: template.logo,
      };
    }
  }
  return { ...EMPTY_FORM };
}

function initialChoice(config: MobileModelConfig): string {
  const defaultProvider = config.model?.defaultProvider;
  if (defaultProvider && !isOfficialProvider(defaultProvider) && config.providers?.[defaultProvider]) {
    return choiceForExisting(defaultProvider);
  }
  return officialProviderKey(config) ? 'official' : 'custom';
}

export function ModelPage(props: { onBack: () => void; onSaved?: () => void }): JSX.Element {
  const [config, setConfig] = useState<MobileModelConfig | null>(null);
  const [choice, setChoice] = useState('custom');
  const [form, setForm] = useState<ModelFormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedModel, setSavedModel] = useState('');
  const [error, setError] = useState('');
  const [showKey, setShowKey] = useState(false);

  const applyChoice = useCallback((nextChoice: string, nextConfig: MobileModelConfig) => {
    setChoice(nextChoice);
    setForm(formForChoice(nextChoice, nextConfig));
    setShowKey(false);
    setSavedModel('');
    setError('');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const stored = (await getMobileElectron().store.get('app_config')) as MobileModelConfig | null;
      const nextConfig = stored ?? {};
      setConfig(nextConfig);
      applyChoice(initialChoice(nextConfig), nextConfig);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [applyChoice]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateForm = (patch: Partial<ModelFormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setSavedModel('');
    setError('');
  };

  const selection = (): MobileModelSelection | null => {
    if (!config) return null;
    return {
      providerKey: choice === 'custom' ? customProviderKey(form.providerName, config) : form.providerKey,
      providerName: form.providerName,
      apiKey: form.apiKey,
      baseUrl: form.baseUrl,
      apiFormat: form.apiFormat,
      modelId: form.modelId,
      models: form.models,
      apiKeyManagementUrl: form.apiKeyManagementUrl,
      logoKey: form.logoKey,
    };
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!config || saving) return;
    const nextSelection = selection();
    if (!nextSelection) return;
    const validation = validateMobileModelSelection(config, nextSelection);
    if (validation) {
      setError(t(`mobile.me.model.error.${validation}`));
      return;
    }
    setSaving(true);
    setSavedModel('');
    setError('');
    try {
      const saved = await saveMobileModelSelection(nextSelection);
      setConfig(saved.config);
      const nextChoice = isOfficialProvider(saved.providerKey) ? 'official' : choiceForExisting(saved.providerKey);
      applyChoice(nextChoice, saved.config);
      setSavedModel(saved.modelId);
      props.onSaved?.();
    } catch (caught) {
      setError(t(caught instanceof MobileModelValidationError
        ? `mobile.me.model.error.${caught.reason}`
        : 'mobile.me.model.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const summary = config ? defaultModelSummary(config, mobileI18n.getLanguage()) : null;
  const configuredKeys = config ? configuredProviderKeys(config) : [];
  const officialKey = config ? officialProviderKey(config) : null;
  const isOfficial = choice === 'official';

  return (
    <SecondaryPageShell title={t('mobile.me.entry.model')} onBack={props.onBack} testId="me-page-model">
      {loading ? (
        <div className="twin-panel twin-panel-padded text-sm text-[var(--text-secondary)]" data-testid="model-loading">
          {t('mobile.common.loading')}
        </div>
      ) : loadFailed ? (
        <div className="twin-notice twin-notice-error" role="alert" data-testid="model-load-error">
          <p className="mb-3 text-sm">{t('mobile.me.model.loadFailed')}</p>
          <button type="button" className="twin-button twin-button-secondary" onClick={() => void load()}>
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : (
        <>
          {summary ? (
            <div className="twin-panel twin-panel-padded" data-testid="model-current">
              <p className="twin-section-label">{t('mobile.me.model.current')}</p>
              <p className="text-base font-semibold text-[var(--text-primary)]">{summary.modelName}</p>
              <p className="mt-1 text-sm text-[var(--text-secondary)]">{summary.providerName}</p>
            </div>
          ) : null}
          <form className="twin-panel twin-panel-padded" onSubmit={(event) => void submit(event)} data-testid="model-form">
            <p className="mb-4 text-sm leading-relaxed text-[var(--text-secondary)]">{t('mobile.me.model.intro')}</p>
            <div className="twin-field">
              <label className="twin-label" htmlFor="model-provider">{t('mobile.me.model.provider')}</label>
              <select
                id="model-provider"
                className="twin-input"
                value={choice}
                disabled={saving}
                onChange={(event) => config && applyChoice(event.target.value, config)}
                data-testid="model-provider"
              >
                {officialKey ? <option value="official">{t('mobile.me.model.official')}</option> : null}
                {configuredKeys.length > 0 ? (
                  <optgroup label={t('mobile.me.model.configured')}>
                    {configuredKeys.map((key) => {
                      const provider = config?.providers?.[key];
                      return <option key={key} value={choiceForExisting(key)}>{provider?.name || key}</option>;
                    })}
                  </optgroup>
                ) : null}
                <optgroup label={t('mobile.me.model.presets')}>
                  {MOBILE_PROVIDER_PRESETS.filter((template) => !configuredKeys.includes(providerKeyForPreset(template.templateId))).map((template) => (
                    <option key={template.templateId} value={`preset:${template.templateId}`}>
                      {mobileI18n.getLanguage() === 'zh' ? template.nameZh : template.nameEn}
                    </option>
                  ))}
                </optgroup>
                <option value="custom">{t('mobile.me.model.custom')}</option>
              </select>
            </div>

            {choice === 'custom' ? (
              <div className="twin-field">
                <label className="twin-label" htmlFor="model-provider-name">{t('mobile.me.model.name')}</label>
                <input
                  id="model-provider-name"
                  className="twin-input"
                  value={form.providerName}
                  onChange={(event) => updateForm({ providerName: event.target.value })}
                  placeholder={t('mobile.me.model.namePlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  disabled={saving}
                  data-testid="model-provider-name"
                />
              </div>
            ) : null}

            {!isOfficial ? (
              <div className="twin-field">
                <label className="twin-label" htmlFor="model-api-key">{t('mobile.me.model.apiKey')}</label>
                <div className="relative">
                  <input
                    id="model-api-key"
                    type={showKey ? 'text' : 'password'}
                    className="twin-input pr-12"
                    value={form.apiKey}
                    onChange={(event) => updateForm({ apiKey: event.target.value })}
                    placeholder={t(form.hasStoredKey ? 'mobile.me.model.apiKeyReplace' : 'mobile.me.model.apiKeyPlaceholder')}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    disabled={saving}
                    data-testid="model-api-key"
                  />
                  <button
                    type="button"
                    className="twin-icon-button absolute right-1 top-1/2 -translate-y-1/2"
                    aria-label={t(showKey ? 'mobile.me.model.hideKey' : 'mobile.me.model.showKey')}
                    aria-pressed={showKey}
                    onClick={() => setShowKey((visible) => !visible)}
                  >
                    {showKey ? <EyeSlashIcon className="h-5 w-5" aria-hidden /> : <EyeIcon className="h-5 w-5" aria-hidden />}
                  </button>
                </div>
                <p className="twin-help">{t(form.hasStoredKey ? 'mobile.me.model.keyKeepHint' : 'mobile.me.model.keySecurityHint')}</p>
                {form.apiKeyManagementUrl ? (
                  <a className="twin-inline-link mt-2 inline-flex min-h-[40px] items-center gap-1.5 text-sm" href={form.apiKeyManagementUrl} target="_blank" rel="noopener noreferrer">
                    <KeyIcon className="h-4 w-4" aria-hidden />
                    {t('mobile.me.model.getKey')}
                  </a>
                ) : null}
              </div>
            ) : null}

            <div className="twin-field">
              <label className="twin-label" htmlFor="model-id">{t('mobile.me.model.model')}</label>
              {!form.customModel && form.models.length > 0 ? (
                <select
                  id="model-id"
                  className="twin-input"
                  value={form.modelId}
                  disabled={saving}
                  onChange={(event) => {
                    if (event.target.value === '__custom__') updateForm({ modelId: '', customModel: true });
                    else updateForm({ modelId: event.target.value });
                  }}
                  data-testid="model-id"
                >
                  {form.models.map((model) => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
                  {!isOfficial ? <option value="__custom__">{t('mobile.me.model.customModel')}</option> : null}
                </select>
              ) : (
                <input
                  id="model-id"
                  className="twin-input"
                  value={form.modelId}
                  onChange={(event) => updateForm({ modelId: event.target.value })}
                  placeholder={t('mobile.me.model.modelPlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={saving}
                  data-testid="model-id"
                />
              )}
            </div>

            {!isOfficial ? (
              <details
                className="twin-model-advanced mt-4"
                open={form.advancedOpen}
                onToggle={(event) => updateForm({ advancedOpen: event.currentTarget.open })}
              >
                <summary>{t('mobile.me.model.advanced')}</summary>
                <div className="pt-1">
                  <div className="twin-field">
                    <label className="twin-label" htmlFor="model-base-url">{t('mobile.me.model.baseUrl')}</label>
                    <input
                      id="model-base-url"
                      type="url"
                      className="twin-input"
                      value={form.baseUrl}
                      onChange={(event) => updateForm({ baseUrl: event.target.value })}
                      placeholder={t('mobile.me.model.baseUrlPlaceholder')}
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={saving}
                      data-testid="model-base-url"
                    />
                  </div>
                  <div className="twin-field">
                    <label className="twin-label" htmlFor="model-api-format">{t('mobile.me.model.apiFormat')}</label>
                    <select
                      id="model-api-format"
                      className="twin-input"
                      value={form.apiFormat}
                      disabled={saving}
                      onChange={(event) => updateForm({ apiFormat: event.target.value as MobileApiFormat })}
                      data-testid="model-api-format"
                    >
                      <option value="openai">{t('mobile.me.model.formatOpenai')}</option>
                      <option value="responses">{t('mobile.me.model.formatResponses')}</option>
                      <option value="anthropic">{t('mobile.me.model.formatAnthropic')}</option>
                    </select>
                  </div>
                </div>
              </details>
            ) : null}

            {error ? <p className="mt-4 text-sm text-red-600" role="alert" data-testid="model-error">{error}</p> : null}
            {savedModel ? (
              <p className="mt-4 flex items-start gap-2 text-sm text-[var(--twin-success)]" role="status" data-testid="model-saved">
                <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {t('mobile.me.model.saved', { model: savedModel })}
              </p>
            ) : null}
            <button type="submit" className="twin-button twin-button-primary twin-button-full mt-5" disabled={saving} data-testid="model-save">
              {t(saving ? 'mobile.me.model.saving' : 'mobile.me.model.save')}
            </button>
            <p className="twin-help mt-3">{t('mobile.me.model.defaultHint')}</p>
          </form>
        </>
      )}
    </SecondaryPageShell>
  );
}
