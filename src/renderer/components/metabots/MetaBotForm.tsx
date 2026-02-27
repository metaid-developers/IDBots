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
  boss_id: '',
  llm_id: '',
};

interface MetaBotFormProps {
  initialValues?: Partial<MetaBotFormValues> | null;
  isEdit: boolean;
  onCancel: () => void;
  onSave: (values: MetaBotFormValues) => Promise<void>;
  saveLabel?: string;
  /** Available LLM providers for exclusive selection. Empty = none available. */
  llmOptions: LlmOption[];
  /** Called when user clicks "Go to Model Settings" (e.g. to open Settings tab). */
  onRequestModelSettings?: () => void;
}

const MetaBotForm: React.FC<MetaBotFormProps> = ({
  initialValues,
  isEdit,
  onCancel,
  onSave,
  saveLabel,
  llmOptions,
  onRequestModelSettings,
}) => {
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<MetaBotFormValues>({
    ...defaultValues,
    ...(initialValues || {}),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (initialValues) {
      setValues((prev) => ({ ...defaultValues, ...prev, ...initialValues }));
    }
  }, [initialValues]);

  const handleChange = (field: keyof MetaBotFormValues, value: string | 'twin' | 'worker') => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setError('');
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
    if (!values.role.trim()) {
      setError(i18nService.t('metabotRoleRequired'));
      return;
    }
    if (!values.soul.trim()) {
      setError(i18nService.t('metabotSoulRequired'));
      return;
    }
    if (llmOptions.length > 0 && !values.llm_id.trim()) {
      setError(i18nService.t('metabotLlmIdPlaceholder'));
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
  const canSave = !hasNoAvailableLlm;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotName')}
        </label>
        <input
          type="text"
          value={values.name}
          onChange={(e) => handleChange('name', e.target.value)}
          placeholder={i18nService.t('metabotNamePlaceholder')}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotAvatar')}
        </label>
        <div className="flex items-center gap-3">
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
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
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

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotType')}
        </label>
        <select
          value={values.metabot_type}
          onChange={(e) => handleChange('metabot_type', e.target.value as 'twin' | 'worker')}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
        >
          <option value="worker">{i18nService.t('metabotTypeWorker')}</option>
          <option value="twin" disabled>{i18nService.t('metabotTypeTwin')}</option>
        </select>
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotRole')}
        </label>
        <input
          type="text"
          value={values.role}
          onChange={(e) => handleChange('role', e.target.value)}
          placeholder={i18nService.t('metabotRolePlaceholder')}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotSoul')}
        </label>
        <textarea
          value={values.soul}
          onChange={(e) => handleChange('soul', e.target.value)}
          placeholder={i18nService.t('metabotSoulPlaceholder')}
          rows={4}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent resize-y"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotGoal')}
        </label>
        <textarea
          value={values.goal}
          onChange={(e) => handleChange('goal', e.target.value)}
          placeholder={i18nService.t('metabotGoalPlaceholder')}
          rows={2}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent resize-y"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotBackground')}
        </label>
        <textarea
          value={values.background}
          onChange={(e) => handleChange('background', e.target.value)}
          placeholder={i18nService.t('metabotBackgroundPlaceholder')}
          rows={2}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent resize-y"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotBossId')}
        </label>
        <input
          type="text"
          value={values.boss_id}
          onChange={(e) => handleChange('boss_id', e.target.value)}
          placeholder={i18nService.t('metabotBossIdPlaceholder')}
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotLlmProvider')}
        </label>
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
          <select
            value={values.llm_id}
            onChange={(e) => handleChange('llm_id', e.target.value)}
            className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          >
            <option value="">{i18nService.t('metabotLlmIdPlaceholder')}</option>
            {llmOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotTools')}
        </label>
        <input
          type="text"
          value={i18nService.t('metabotToolsDefault')}
          disabled
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder border-claude-border cursor-not-allowed"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
          {i18nService.t('metabotSkills')}
        </label>
        <input
          type="text"
          value={i18nService.t('metabotSkillsDefault')}
          disabled
          className="w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted dark:text-claude-darkTextSecondary text-claude-textSecondary border dark:border-claude-darkBorder border-claude-border cursor-not-allowed"
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-4">
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
          className="px-3 py-2 text-sm rounded-xl bg-claude-accent text-white hover:bg-claude-accentHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? i18nService.t('saving') : saveButtonLabel}
        </button>
      </div>
    </form>
  );
};

export default MetaBotForm;
