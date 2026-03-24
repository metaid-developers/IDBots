import React, { useEffect, useRef, useState } from 'react';
import { PhotoIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

const AVATAR_MAX_SIZE_BYTES = 200 * 1024; // 200KB

export interface MetaBotFormValues {
  name: string;
  avatar: string;
  metabot_type: 'twin' | 'worker';
  role: string;
  soul: string;
  goal: string;
  background: string;
  boss_global_metaid: string;
  boss_id: string;
  llm_id: string;
}

export interface LlmOption {
  id: string;
  label: string;
}

const defaultValues: MetaBotFormValues = {
  name: '',
  avatar: '',
  metabot_type: 'worker',
  role: '',
  soul: '',
  goal: '',
  background: '',
  boss_global_metaid: '',
  boss_id: '1',
  llm_id: '',
};

interface MetaBotFormProps {
  initialValues?: Partial<MetaBotFormValues> | null;
  isEdit: boolean;
  onCancel: () => void;
  onSave: (values: MetaBotFormValues) => Promise<void>;
  saveLabel?: string;
  /** Available LLM providers for selection. Multiple MetaBots may share the same LLM. Empty = none available. */
  llmOptions: LlmOption[];
  /** Called when user clicks "Go to Model Settings" (e.g. to open Settings tab). */
  onRequestModelSettings?: () => void;
  /** Check if name already exists (for uniqueness). Returns true if duplicate. */
  onCheckNameExists?: (name: string, excludeId?: number) => Promise<boolean>;
  /** Exclude this metabot ID when checking name (for edit mode). */
  excludeIdForNameCheck?: number | null;
}

const MetaBotForm: React.FC<MetaBotFormProps> = ({
  initialValues,
  isEdit,
  onCancel,
  onSave,
  saveLabel,
  llmOptions,
  onRequestModelSettings,
  onCheckNameExists,
  excludeIdForNameCheck,
}) => {
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<MetaBotFormValues>({
    ...defaultValues,
    ...(initialValues || {}),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [nameDuplicate, setNameDuplicate] = useState(false);

  useEffect(() => {
    if (initialValues) {
      setValues((prev) => ({ ...defaultValues, ...prev, ...initialValues }));
    }
  }, [initialValues]);

  const handleChange = (field: keyof MetaBotFormValues, value: string | 'twin' | 'worker') => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setError('');
    if (field === 'name') setNameDuplicate(false);
  };

  const handleNameBlur = async () => {
    const name = values.name.trim();
    if (!name || !onCheckNameExists) return;
    const exists = await onCheckNameExists(name, excludeIdForNameCheck ?? undefined);
    setNameDuplicate(exists);
  };

  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX_SIZE_BYTES) {
      setError(i18nService.t('metabotAvatarSizeError'));
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAvatarSizeError') }));
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = reader.result as string;
      setValues((prev) => ({ ...prev, avatar: dataUri }));
      setError('');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.name.trim()) {
      setError(i18nService.t('metabotNameRequired'));
      return;
    }
    if (nameDuplicate) {
      setError(i18nService.t('metabotNameDuplicate'));
      return;
    }
    if (onCheckNameExists) {
      const exists = await onCheckNameExists(values.name.trim(), excludeIdForNameCheck ?? undefined);
      if (exists) {
        setError(i18nService.t('metabotNameDuplicate'));
        setNameDuplicate(true);
        return;
      }
    }
    if (!values.role.trim()) {
      setError(i18nService.t('metabotRoleRequired'));
      return;
    }
    if (!values.soul.trim()) {
      setError(i18nService.t('metabotSoulRequired'));
      return;
    }
    if (!isEdit && !values.llm_id.trim()) {
      setError(i18nService.t('metabotLlmRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const saveButtonLabel = saveLabel ?? (isEdit ? i18nService.t('save') : i18nService.t('metabotCreate'));
  const hasNoAvailableLlm = llmOptions.length === 0;
  const canSave = isEdit || !hasNoAvailableLlm;
  const rowClass = 'grid grid-cols-1 md:grid-cols-[132px_minmax(0,1fr)] gap-2 md:gap-4 items-start';
  const labelClass = 'pt-2 text-sm font-medium dark:text-claude-darkText text-claude-text';
  const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
  const inputClass = 'w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className={rowClass}>
        <label htmlFor="metabot-name" className={labelClass}>
          {i18nService.t('metabotName')}
        </label>
        <div className="min-w-0">
          <input
            id="metabot-name"
            type="text"
            value={values.name}
            onChange={(e) => handleChange('name', e.target.value)}
            onBlur={handleNameBlur}
            placeholder={i18nService.t('metabotNamePlaceholder')}
            className={`${inputClass} ${nameDuplicate ? 'border-red-500 dark:border-red-500' : ''}`}
          />
          {nameDuplicate && (
            <p className="text-xs text-red-500 mt-1">
              {i18nService.t('metabotNameDuplicate')}
            </p>
          )}
        </div>
      </div>

      <div className={rowClass}>
        <label className={labelClass}>
          {i18nService.t('metabotAvatar')}
        </label>
        <div className="min-w-0 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border overflow-hidden flex-shrink-0 flex items-center justify-center">
            {values.avatar && (values.avatar.startsWith('data:') || values.avatar.startsWith('http')) ? (
              <img src={values.avatar} alt="" className="w-full h-full object-cover" />
            ) : (
              <PhotoIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
              className="hidden"
              onChange={handleAvatarFileChange}
            />
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            >
              {i18nService.t('metabotAvatarUpload')}
            </button>
            <p className={hintClass}>
              {i18nService.t('metabotAvatarPlaceholder')}
            </p>
            {values.avatar && (
              <button
                type="button"
                onClick={() => handleChange('avatar', '')}
                className="mt-1 text-xs text-red-500 dark:text-red-400 hover:underline"
              >
                {i18nService.t('metabotAvatarClear')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hidden: Type, Parent MetaBot ID, Tools, Skills - default values injected silently */}

      <div className={rowClass}>
        <label htmlFor="metabot-role" className={labelClass}>
          {i18nService.t('metabotRole')}
        </label>
        <div className="min-w-0">
          <input
            id="metabot-role"
            type="text"
            value={values.role}
            onChange={(e) => handleChange('role', e.target.value)}
            placeholder={i18nService.t('metabotRolePlaceholder')}
            className={inputClass}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-soul" className={labelClass}>
          {i18nService.t('metabotSoul')}
        </label>
        <div className="min-w-0">
          <textarea
            id="metabot-soul"
            value={values.soul}
            onChange={(e) => handleChange('soul', e.target.value)}
            placeholder={i18nService.t('metabotSoulPlaceholder')}
            rows={4}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-goal" className={labelClass}>
          {i18nService.t('metabotGoal')}
        </label>
        <div className="min-w-0">
          <textarea
            id="metabot-goal"
            value={values.goal}
            onChange={(e) => handleChange('goal', e.target.value)}
            placeholder={i18nService.t('metabotGoalPlaceholder')}
            rows={2}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-background" className={labelClass}>
          {i18nService.t('metabotBackground')}
        </label>
        <div className="min-w-0">
          <textarea
            id="metabot-background"
            value={values.background}
            onChange={(e) => handleChange('background', e.target.value)}
            placeholder={i18nService.t('metabotBackgroundPlaceholder')}
            rows={2}
            className={`${inputClass} resize-y`}
          />
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-boss-metaid" className={labelClass}>
          {i18nService.t('metabotBossMetaId')}
          <span className="ml-1 font-normal opacity-60">{i18nService.t('metabotBossMetaIdOptional')}</span>
        </label>
        <div className="min-w-0">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <input
              id="metabot-boss-metaid"
              type="text"
              value={values.boss_global_metaid}
              onChange={(e) => handleChange('boss_global_metaid', e.target.value)}
              placeholder={i18nService.t('metabotBossMetaIdPlaceholder')}
              className={`${inputClass} flex-1 min-w-0 font-mono`}
            />
            <button
              type="button"
              onClick={() => {/* TODO: fetch my MetaID */}}
              className="shrink-0 px-3 py-2 text-xs rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors whitespace-nowrap"
            >
              {i18nService.t('metabotGetMyMetaId')}
            </button>
          </div>
          <p className={`${hintClass} opacity-70`}>
            {i18nService.t('metabotBossMetaIdHint')}
          </p>
        </div>
      </div>

      <div className={rowClass}>
        <label htmlFor="metabot-llm" className={labelClass}>
          {i18nService.t('metabotLlmProvider')}
          {!isEdit && <span className="ml-1 text-red-500">*</span>}
        </label>
        <div className="min-w-0">
          {hasNoAvailableLlm ? (
            <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-3 dark:bg-claude-darkSurface/50 bg-claude-surface/50">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metabotNoAvailableLlm')}
              </p>
              {onRequestModelSettings && (
                <button
                  type="button"
                  onClick={onRequestModelSettings}
                  className="mt-2 text-sm text-claude-accent hover:underline"
                >
                  {i18nService.t('metabotGoToModelSettings')}
                </button>
              )}
            </div>
          ) : (
            <>
              <select
                id="metabot-llm"
                value={values.llm_id}
                onChange={(e) => handleChange('llm_id', e.target.value)}
                className={inputClass}
              >
                <option value="">{i18nService.t('metabotLlmIdPlaceholder')}</option>
                {llmOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {!isEdit && (
                <p className={hintClass}>
                  {i18nService.t('metabotLlmRequired')}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className={rowClass}>
        <div className="hidden md:block" />
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="submit"
            disabled={saving || !canSave}
            className="btn-idchat-primary-filled px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? i18nService.t('saving') : saveButtonLabel}
          </button>
        </div>
      </div>
    </form>
  );
};

export default MetaBotForm;
