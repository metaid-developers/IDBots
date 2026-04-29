import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Skill } from '../../types/skill';
import {
  GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
  formatGigSquareMrc20OptionLabel,
  getGigSquareMrc20SelectPlaceholder,
  getNextGigSquareSelectedMrc20Id,
  getGigSquarePublishPriceLimit,
  getGigSquarePublishPriceLimitText,
  getGigSquareSettlementGridClassName,
  getSelectableGigSquareMrc20Assets,
} from './gigSquarePublishPresentation.js';
import { getEnabledGigSquareSkills } from './gigSquareSkillOptions.js';

type MetabotOption = { id: number; name: string; avatar: string | null; metabot_type: string };
type PublishCurrency = 'BTC' | 'SPACE' | 'DOGE' | 'MRC20';
type SelectableMrc20Asset = {
  symbol: string;
  mrc20Id: string;
  balance: {
    display: string;
  };
};

interface GigSquarePublishModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPublished?: () => void;
}

type PublishStatus = 'idle' | 'submitting' | 'success';
type StatusPanelState = 'submitting' | 'success' | 'error' | 'partial';

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const ICON_ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/svg+xml';

const OUTPUT_OPTIONS = [
  { label: 'text', value: 'text' },
  { label: 'image', value: 'image' },
  { label: 'video', value: 'video' },
  { label: 'audio', value: 'audio' },
  { label: 'other', value: 'other' },
];

const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

const GigSquarePublishModal: React.FC<GigSquarePublishModalProps> = ({
  isOpen,
  onClose,
  onPublished,
}) => {
  const [metabots, setMetabots] = useState<MetabotOption[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState('');
  const [selectedMetabotId, setSelectedMetabotId] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [serviceName, setServiceName] = useState('');
  const [serviceNameDirty, setServiceNameDirty] = useState(false);
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<PublishCurrency>('BTC');
  const [mrc20Assets, setMrc20Assets] = useState<SelectableMrc20Asset[]>([]);
  const [selectedMrc20Id, setSelectedMrc20Id] = useState('');
  const [outputType, setOutputType] = useState<'text' | 'image' | 'video' | 'audio' | 'other'>('text');
  const [serviceIconDataUrl, setServiceIconDataUrl] = useState('');
  const [status, setStatus] = useState<PublishStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [statusPanelState, setStatusPanelState] = useState<StatusPanelState>('submitting');
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const selectedMrc20IdRef = useRef('');

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) || null,
    [skills, selectedSkillId]
  );
  const selectedMrc20Asset = useMemo(
    () => mrc20Assets.find((asset) => asset.mrc20Id === selectedMrc20Id) || null,
    [mrc20Assets, selectedMrc20Id]
  );

  const priceLimit = getGigSquarePublishPriceLimit(currency);
  const priceLimitText = getGigSquarePublishPriceLimitText(currency);
  const isFormDisabled = status === 'submitting' || statusPanelOpen;

  const loadMetabots = useCallback(async () => {
    try {
      const [selectorResult, fullListResult] = await Promise.all([
        window.electron.idbots.getMetaBots(),
        window.electron.metabot.list(),
      ]);
      if (selectorResult?.success && selectorResult.list?.length) {
        const llmConfiguredIds = fullListResult?.success && fullListResult.list
          ? new Set(
              fullListResult.list
                .filter((metabot) => metabot.enabled && typeof metabot.llm_id === 'string' && metabot.llm_id.trim())
                .map((metabot) => metabot.id)
            )
          : null;
        const filteredList = llmConfiguredIds
          ? selectorResult.list.filter((metabot) => llmConfiguredIds.has(metabot.id))
          : selectorResult.list;
        setMetabots(filteredList);
        setSelectedMetabotId((prev) => {
          if (prev && filteredList.some((m) => m.id === prev)) return prev;
          const twin = filteredList.find((m) => m.metabot_type === 'twin');
          return twin?.id || filteredList[0]?.id || null;
        });
      } else {
        setMetabots([]);
        setSelectedMetabotId(null);
      }
    } catch {
      setMetabots([]);
      setSelectedMetabotId(null);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const res = await window.electron.skills.list();
      const enabledSkills = getEnabledGigSquareSkills(res?.success ? res.skills : []);
      if (enabledSkills.length) {
        setSkills(enabledSkills);
        setSelectedSkillId((prev) => {
          if (prev && enabledSkills.some((skill) => skill.id === prev)) return prev;
          return enabledSkills[0].id;
        });
      } else {
        setSkills([]);
        setSelectedSkillId('');
      }
    } catch {
      setSkills([]);
      setSelectedSkillId('');
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setStatus('idle');
    setError(null);
    setWarning(null);
    setStatusPanelOpen(false);
    setStatusPanelState('submitting');
    setServiceNameDirty(false);
    setServiceIconDataUrl('');
    setMrc20Assets([]);
    setSelectedMrc20Id('');
    loadMetabots();
    loadSkills();
  }, [isOpen, loadMetabots, loadSkills]);

  useEffect(() => {
    if (!selectedSkill || serviceNameDirty) return;
    setServiceName(selectedSkill.name + '-service');
  }, [selectedSkill, serviceNameDirty]);

  useEffect(() => {
    selectedMrc20IdRef.current = selectedMrc20Id;
  }, [selectedMrc20Id]);

  useEffect(() => {
    if (currency === 'MRC20') return;
    setMrc20Assets([]);
    setSelectedMrc20Id('');
  }, [currency]);

  useEffect(() => {
    if (!isOpen || !selectedMetabotId || currency !== 'MRC20') return;
    let isCancelled = false;
    const previousSelectedMrc20Id = selectedMrc20IdRef.current;
    setMrc20Assets([]);
    setSelectedMrc20Id('');
    const loadMrc20Assets = async () => {
      try {
        const result = await window.electron.idbots.getMetabotWalletAssets({ metabotId: selectedMetabotId });
        if (isCancelled) return;
        const options = getSelectableGigSquareMrc20Assets(result?.assets?.mrc20Assets || []);
        setMrc20Assets(options);
        setSelectedMrc20Id(getNextGigSquareSelectedMrc20Id(options, previousSelectedMrc20Id));
      } catch {
        if (isCancelled) return;
        setMrc20Assets([]);
        setSelectedMrc20Id('');
      }
    };
    void loadMrc20Assets();
    return () => {
      isCancelled = true;
    };
  }, [isOpen, selectedMetabotId, currency]);

  if (!isOpen) return null;

  const handleIconChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_ICON_BYTES) {
      setError(i18nService.t('gigSquarePublishIconTooLarge'));
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      setServiceIconDataUrl(dataUrl);
      setError(null);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  };

  const validate = (): boolean => {
    if (!selectedSkill) {
      setError(i18nService.t('gigSquarePublishSkillRequired'));
      return false;
    }
    if (!selectedMetabotId) {
      setError(i18nService.t('gigSquarePublishMetabotRequired'));
      return false;
    }
    if (!displayName.trim()) {
      setError(i18nService.t('gigSquarePublishDisplayNameRequired'));
      return false;
    }
    if (!serviceName.trim()) {
      setError(i18nService.t('gigSquarePublishServiceNameRequired'));
      return false;
    }
    if (!description.trim()) {
      setError(i18nService.t('gigSquarePublishDescriptionRequired'));
      return false;
    }
    if (!price.trim()) {
      setError(i18nService.t('gigSquarePublishPriceRequired'));
      return false;
    }
    if (!NUMBER_PATTERN.test(price.trim())) {
      setError(i18nService.t('gigSquarePublishPriceInvalid'));
      return false;
    }
    const numericPrice = Number(price.trim());
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      setError(i18nService.t('gigSquarePublishPriceInvalid'));
      return false;
    }
    if (priceLimit !== null && numericPrice > priceLimit) {
      setError(i18nService.t('gigSquarePublishPriceExceed'));
      return false;
    }
    if (currency === 'MRC20' && !selectedMrc20Id) {
      setError('Please select an MRC20 token');
      return false;
    }
    if (!outputType) {
      setError(i18nService.t('gigSquarePublishOutputRequired'));
      return false;
    }
    setError(null);
    return true;
  };

  const handleSubmit = async () => {
    if (status === 'submitting') return;
    if (!validate()) return;
    setStatus('submitting');
    setWarning(null);
    setError(null);
    setStatusPanelOpen(true);
    setStatusPanelState('submitting');

    const result = await window.electron.gigSquare.publishService({
      metabotId: selectedMetabotId || 0,
      serviceName: serviceName.trim(),
      displayName: displayName.trim(),
      description: description.trim(),
      providerSkill: selectedSkill?.name || '',
      price: price.trim(),
      currency,
      mrc20Ticker: currency === 'MRC20' ? selectedMrc20Asset?.symbol || '' : undefined,
      mrc20Id: currency === 'MRC20' ? selectedMrc20Asset?.mrc20Id || '' : undefined,
      outputType,
      serviceIconDataUrl: serviceIconDataUrl || null,
    });

    if (!result?.success) {
      setError(result?.error || i18nService.t('gigSquarePublishFailed'));
      setStatus('idle');
      setStatusPanelState('error');
      return;
    }

    if (result.warning) {
      setWarning(result.warning);
      setStatusPanelState('partial');
    } else {
      setStatusPanelState('success');
    }

    setStatus('success');
    onPublished?.();
  };

  const submitLabel = status === 'submitting'
    ? i18nService.t('gigSquarePublishSubmitting')
    : error
      ? i18nService.t('gigSquarePublishRetry')
      : i18nService.t('gigSquarePublishSubmit');

  const statusPanelMessage = statusPanelState === 'submitting'
    ? i18nService.t('gigSquarePublishStatusSubmitting')
    : statusPanelState === 'success'
      ? i18nService.t('gigSquarePublishStatusSuccess')
      : statusPanelState === 'partial'
        ? i18nService.t('gigSquarePublishStatusPartial')
        : i18nService.t('gigSquarePublishStatusFailed');

  const statusPanelButtonLabel = statusPanelState === 'error'
    ? i18nService.t('gigSquarePublishStatusClose')
    : i18nService.t('gigSquarePublishStatusConfirm');

  const handleStatusPanelClose = () => {
    if (statusPanelState === 'success' || statusPanelState === 'partial') {
      setStatusPanelOpen(false);
      onClose();
      return;
    }
    setStatusPanelOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60"
        onClick={status === 'submitting' || statusPanelOpen ? undefined : onClose}
        aria-hidden
      />
      <div
        className="relative w-full max-w-2xl rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('gigSquarePublishTitle')}
            </h3>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
              {i18nService.t('gigSquarePublishSubtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-1 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            disabled={isFormDisabled}
          >
            {i18nService.t('close')}
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishSkillLabel')}
              </label>
              <select
                value={selectedSkillId}
                onChange={(e) => setSelectedSkillId(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              >
                <option value="">
                  {i18nService.t('gigSquarePublishSkillLabel')}
                </option>
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishMetabotLabel')}
              </label>
              <select
                value={selectedMetabotId || ''}
                onChange={(e) => setSelectedMetabotId(Number(e.target.value) || null)}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              >
                {metabots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishDisplayNameLabel')}
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={i18nService.t('gigSquarePublishDisplayNamePlaceholder')}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              />
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                {i18nService.t('gigSquarePublishDisplayNameHint')}
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishServiceNameLabel')}
              </label>
              <input
                type="text"
                value={serviceName}
                onChange={(e) => {
                  setServiceName(e.target.value);
                  setServiceNameDirty(true);
                }}
                placeholder={selectedSkill ? selectedSkill.name + '-service' : ''}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              />
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                {i18nService.t('gigSquarePublishServiceNameHint')}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
              {i18nService.t('gigSquarePublishDescriptionLabel')}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={i18nService.t('gigSquarePublishDescriptionPlaceholder')}
              rows={3}
              className="w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text placeholder-claude-textSecondary dark:placeholder-claude-darkTextSecondary focus:outline-none focus:ring-2 focus:ring-claude-accent"
              disabled={isFormDisabled}
            />
          </div>

          <div className={getGigSquareSettlementGridClassName(currency)}>
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishPriceLabel')}
              </label>
              <input
                type="text"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder={i18nService.t('gigSquarePublishPricePlaceholder')}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              />
              {priceLimitText && (
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                  {i18nService.t('gigSquarePublishPriceLimitPrefix')}{priceLimitText}
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishCurrencyLabel')}
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as PublishCurrency)}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              >
                {GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              {currency === 'MRC20' && (
                <>
                  <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                    MRC20 Token
                  </label>
                  <select
                    value={selectedMrc20Id}
                    onChange={(e) => setSelectedMrc20Id(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                    disabled={isFormDisabled}
                  >
                    <option value="">
                      {getGigSquareMrc20SelectPlaceholder(mrc20Assets)}
                    </option>
                    {mrc20Assets.map((asset) => (
                      <option key={asset.mrc20Id} value={asset.mrc20Id}>
                        {formatGigSquareMrc20OptionLabel(asset)}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishInputTypeLabel')}
              </label>
              <div className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border">
                text
              </div>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                {i18nService.t('gigSquarePublishInputTypeNote')}
              </p>
            </div>
            <div>
              <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('gigSquarePublishOutputTypeLabel')}
              </label>
              <select
                value={outputType}
                onChange={(e) => setOutputType(e.target.value as 'text' | 'image' | 'video' | 'audio' | 'other')}
                className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
                disabled={isFormDisabled}
              >
                {OUTPUT_OPTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                {i18nService.t('gigSquarePublishOutputTypeNote')}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              {i18nService.t('gigSquarePublishIconLabel')}
            </label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex items-center justify-center">
                {serviceIconDataUrl ? (
                  <img src={serviceIconDataUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                )}
              </div>
              <div>
                <input
                  ref={iconInputRef}
                  type="file"
                  accept={ICON_ACCEPT}
                  className="hidden"
                  onChange={handleIconChange}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => iconInputRef.current?.click()}
                    className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
                    disabled={isFormDisabled}
                  >
                    {i18nService.t('gigSquarePublishUploadIcon')}
                  </button>
                  {serviceIconDataUrl && (
                    <button
                      type="button"
                      onClick={() => setServiceIconDataUrl('')}
                      className="text-xs text-red-500 dark:text-red-400 hover:underline"
                      disabled={isFormDisabled}
                    >
                      {i18nService.t('gigSquarePublishRemoveIcon')}
                    </button>
                  )}
                </div>
                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                  {i18nService.t('gigSquarePublishIconOptional')}
                </p>
              </div>
            </div>
          </div>

          {!statusPanelOpen && error && (
            <div className="text-xs text-red-500">
              {error}
            </div>
          )}
          {!statusPanelOpen && warning && (
            <div className="text-xs text-amber-500">
              {warning}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              disabled={isFormDisabled}
            >
              {i18nService.t('cancel')}
            </button>
            {status === 'success' ? (
              <button
                type="button"
                onClick={onClose}
                className="btn-idchat-primary px-4 py-2 text-sm font-medium"
              >
                {i18nService.t('gigSquarePublishSuccess')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                className="btn-idchat-primary px-4 py-2 text-sm font-medium"
                disabled={isFormDisabled}
              >
                {submitLabel}
              </button>
            )}
          </div>
        </div>

        {statusPanelOpen && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-black/40 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface p-5 shadow-xl">
              <div className="flex items-center gap-3">
                {statusPanelState === 'submitting' ? (
                  <div className="h-8 w-8 rounded-full border-2 border-claude-accent/40 border-t-claude-accent animate-spin" />
                ) : (
                  <div
                    className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold ${
                      statusPanelState === 'success'
                        ? 'bg-emerald-500/15 text-emerald-500'
                        : statusPanelState === 'partial'
                          ? 'bg-amber-500/15 text-amber-500'
                          : 'bg-red-500/15 text-red-500'
                    }`}
                  >
                    {statusPanelState === 'success' ? 'OK' : '!'}
                  </div>
                )}
                <div>
                  <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                    {statusPanelMessage}
                  </div>
                  {statusPanelState === 'error' && (
                    <div className="text-xs text-red-500 mt-1">
                      {error || i18nService.t('gigSquarePublishFailed')}
                    </div>
                  )}
                  {statusPanelState === 'error' && (
                    <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
                      {i18nService.t('gigSquarePublishStatusRetryHint')}
                    </div>
                  )}
                  {statusPanelState === 'partial' && (
                    <div className="text-xs text-amber-500 mt-1">
                      {warning || i18nService.t('gigSquarePublishStatusPartial')}
                    </div>
                  )}
                </div>
              </div>
              {statusPanelState !== 'submitting' && (
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={handleStatusPanelClose}
                    className="btn-idchat-primary px-4 py-2 text-sm font-medium"
                  >
                    {statusPanelButtonLabel}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default GigSquarePublishModal;
