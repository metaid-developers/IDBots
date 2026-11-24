/**
 * Minimal MetaBot creation form (Studio Linear Style B).
 * Collects essentials at creation time: name, primary LLM, optional archetype preseed,
 * and optional fallback LLM.
 */

import React, { useState } from 'react';
import { CpuChipIcon, ShieldCheckIcon, SparklesIcon, UserIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { isLlmEffortLevel, type LlmEffortLevel } from '../../services/modelCatalog';
import ModelEffortPicker from '../ModelEffortPicker';
import type { LlmOption } from './MetaBotEditTabs';
import {
  METABOT_ARCHETYPES,
  DEFAULT_METABOT_ARCHETYPE_ID,
  resolveMetabotArchetype,
} from './metabotArchetypes';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_CLEAN_INPUT_CLASS,
  METABOT_COMPACT_SELECT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_NOTE_CLASS,
  METABOT_GROUP_ROW_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';

export interface MetaBotCreateFormValues {
  name: string;
  llm_id: string;
  llm_provider: string;
  llm_effort: string;
  fallback_llm_id: string;
  fallback_llm_provider: string;
  fallback_llm_effort: string;
  /** Persona preseeded from the archetype picker ('custom' = none, minimal creation). */
  role: string;
  soul: string;
  goal: string;
}

interface MetaBotCreateFormProps {
  onCancel: () => void;
  onSave: (values: MetaBotCreateFormValues) => Promise<void>;
  saveLabel?: string;
  /** Available LLM providers for selection. Empty = none available. */
  llmOptions: LlmOption[];
  /** Called when user clicks "Go to Model Settings" (e.g. to open Settings tab). */
  onRequestModelSettings?: () => void;
  /** Check if name already exists (for uniqueness). Returns true if duplicate. */
  onCheckNameExists?: (name: string, excludeId?: number) => Promise<boolean>;
}

const MetaBotCreateForm: React.FC<MetaBotCreateFormProps> = ({
  onCancel,
  onSave,
  saveLabel,
  llmOptions,
  onRequestModelSettings,
  onCheckNameExists,
}) => {
  const [values, setValues] = useState<MetaBotCreateFormValues>({
    name: '',
    llm_id: '',
    llm_provider: '',
    llm_effort: '',
    fallback_llm_id: '',
    fallback_llm_provider: '',
    fallback_llm_effort: '',
    role: '',
    soul: '',
    goal: '',
  });
  const [archetypeId, setArchetypeId] = useState<string>(DEFAULT_METABOT_ARCHETYPE_ID);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [nameDuplicate, setNameDuplicate] = useState(false);

  const handleChange = <K extends keyof MetaBotCreateFormValues>(field: K, value: MetaBotCreateFormValues[K]) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setError('');
    if (field === 'name') setNameDuplicate(false);
  };

  const handleArchetypeChange = (nextId: string) => {
    setArchetypeId(nextId);
    const archetype = resolveMetabotArchetype(nextId);
    setValues((prev) => ({ ...prev, role: archetype.role, soul: archetype.soul, goal: archetype.goal }));
    setError('');
  };

  const handleNameBlur = async () => {
    const name = values.name.trim();
    if (!name || !onCheckNameExists) return;
    const exists = await onCheckNameExists(name);
    setNameDuplicate(exists);
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
      const exists = await onCheckNameExists(values.name.trim());
      if (exists) {
        setError(i18nService.t('metabotNameDuplicate'));
        setNameDuplicate(true);
        return;
      }
    }
    if (!values.llm_id.trim()) {
      setError(i18nService.t('metabotLlmRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({
        name: values.name.trim(),
        llm_id: values.llm_id.trim(),
        llm_provider: values.llm_provider.trim(),
        llm_effort: values.llm_effort.trim(),
        fallback_llm_id: values.fallback_llm_id.trim(),
        fallback_llm_provider: values.fallback_llm_provider.trim(),
        fallback_llm_effort: values.fallback_llm_effort.trim(),
        role: values.role.trim(),
        soul: values.soul.trim(),
        goal: values.goal.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const saveButtonLabel = saveLabel ?? i18nService.t('metabotCreate');
  const hasNoAvailableLlm = llmOptions.length === 0;
  const canSave = !hasNoAvailableLlm;

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-500/10 rounded-[8px] px-3.5 py-2.5">
          {error}
        </div>
      )}

      <div>
        <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
          <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupPublicProfile')}</span>
        </div>
        <div className={METABOT_GROUP_BOX_CLASS}>
          <div className={METABOT_GROUP_ROW_CLASS}>
            <div className="flex items-start gap-2.5 min-w-[180px]">
              <UserIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label htmlFor="metabot-name" className={METABOT_ROW_TITLE_CLASS}>
                  <span>{i18nService.t('metabotName')}</span>
                  <span className="text-red-500">*</span>
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotNameHint')}</p>
              </div>
            </div>
            <div className="w-full sm:max-w-[380px]">
              <input
                id="metabot-name"
                type="text"
                value={values.name}
                onChange={(e) => handleChange('name', e.target.value)}
                onBlur={handleNameBlur}
                placeholder={i18nService.t('metabotNamePlaceholder')}
                className={`${METABOT_CLEAN_INPUT_CLASS} ${nameDuplicate ? '!border-red-500' : ''}`}
              />
              {nameDuplicate && (
                <p className="text-xs text-red-500 mt-1">
                  {i18nService.t('metabotNameDuplicate')}
                </p>
              )}
            </div>
          </div>

          <div className={METABOT_GROUP_ROW_CLASS}>
            <div className="flex items-start gap-2.5 min-w-[180px]">
              <SparklesIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label htmlFor="metabot-archetype" className={METABOT_ROW_TITLE_CLASS}>
                  {i18nService.t('metabotArchetypeLabel')}
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotArchetypeHint')}</p>
              </div>
            </div>
            <div className="w-full sm:max-w-[380px] flex sm:justify-end">
              <select
                id="metabot-archetype"
                value={archetypeId}
                onChange={(e) => handleArchetypeChange(e.target.value)}
                className={`${METABOT_COMPACT_SELECT_CLASS} w-full`}
                data-slot="metabot-archetype-select"
              >
                {METABOT_ARCHETYPES.map((archetype) => (
                  <option key={archetype.id} value={archetype.id}>
                    {i18nService.t(archetype.labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
          <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotGroupBrain')}</span>
          <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupBrainNote')}</span>
        </div>
        <div className={METABOT_GROUP_BOX_CLASS}>
          <div className={METABOT_GROUP_ROW_CLASS}>
            <div className="flex items-start gap-2.5 min-w-[180px]">
              <CpuChipIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label htmlFor="metabot-llm" className={METABOT_ROW_TITLE_CLASS}>
                  <span>{i18nService.t('metabotLlmProvider')}</span>
                  <span className="text-red-500">*</span>
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotPrimaryLlmHint')}</p>
              </div>
            </div>
            <div className="w-full sm:max-w-[380px]">
              {hasNoAvailableLlm ? (
                <div
                  data-slot="metabot-no-llm-guidance"
                  className="rounded-[8px] border border-slate-900/[0.095] dark:border-white/[0.09] px-3 py-2.5 bg-[#f8fafc] dark:bg-[#131d2c]"
                >
                  <p className="text-xs text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('metabotNoAvailableLlm')}
                  </p>
                  {onRequestModelSettings && (
                    <button
                      type="button"
                      onClick={onRequestModelSettings}
                      className="mt-1.5 text-xs font-semibold text-claude-accent hover:underline"
                    >
                      {i18nService.t('metabotGoToModelSettings')}
                    </button>
                  )}
                </div>
              ) : (
                <ModelEffortPicker
                  id="metabot-llm"
                  variant="field"
                  value={{
                    modelId: values.llm_id || null,
                    providerKey: values.llm_provider || null,
                    effort: isLlmEffortLevel(values.llm_effort) ? values.llm_effort : null,
                  }}
                  onChange={(selection) => {
                    handleChange('llm_id', selection.modelId ?? '');
                    handleChange('llm_provider', selection.providerKey ?? '');
                    handleChange('llm_effort', selection.effort ?? '');
                  }}
                  placeholder={i18nService.t('metabotLlmIdPlaceholder')}
                  globalDefaultModel={configService.getConfig().model?.defaultModel ?? null}
                />
              )}
            </div>
          </div>

          {!hasNoAvailableLlm && (
            <div className={METABOT_GROUP_ROW_CLASS}>
              <div className="flex items-start gap-2.5 min-w-[180px]">
                <ShieldCheckIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
                <div>
                  <label htmlFor="metabot-fallback-llm" className={METABOT_ROW_TITLE_CLASS}>
                    {i18nService.t('metabotFallbackLlmLabel')}
                  </label>
                  <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotFallbackLlmHint')}</p>
                </div>
              </div>
              <div className="w-full sm:max-w-[380px] flex items-center sm:justify-end gap-2">
                {values.fallback_llm_id.trim() ? (
                  <>
                    <div className="flex-1 min-w-0">
                      <ModelEffortPicker
                        id="metabot-fallback-llm"
                        variant="field"
                        value={{
                          modelId: values.fallback_llm_id || null,
                          providerKey: values.fallback_llm_provider || null,
                          effort: (isLlmEffortLevel(values.fallback_llm_effort) ? values.fallback_llm_effort : null) as LlmEffortLevel | null,
                        }}
                        onChange={(selection) => {
                          handleChange('fallback_llm_id', selection.modelId ?? '');
                          handleChange('fallback_llm_provider', selection.providerKey ?? '');
                          handleChange('fallback_llm_effort', selection.effort ?? '');
                        }}
                        globalDefaultModel={configService.getConfig().model?.defaultModel ?? null}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        handleChange('fallback_llm_id', '');
                        handleChange('fallback_llm_provider', '');
                        handleChange('fallback_llm_effort', '');
                      }}
                      className="text-xs font-semibold text-red-600 dark:text-rose-400 hover:underline px-1 shrink-0"
                    >
                      {i18nService.t('metabotClearOwner')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    id="metabot-fallback-llm"
                    onClick={() => {
                      handleChange('fallback_llm_id', values.llm_id);
                      handleChange('fallback_llm_provider', values.llm_provider);
                      handleChange('fallback_llm_effort', values.llm_effort);
                    }}
                    disabled={!values.llm_id.trim()}
                    className={METABOT_BTN_FLAT_CLASS}
                  >
                    {i18nService.t('metabotFallbackLlmSetup')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className={`${METABOT_BTN_FLAT_CLASS} !h-[34px] !px-3.5 !rounded-[8px]`}
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="submit"
          disabled={saving || !canSave}
          className={METABOT_BTN_PRIMARY_CLASS}
        >
          {saving ? i18nService.t('saving') : saveButtonLabel}
        </button>
      </div>
    </form>
  );
};

export default MetaBotCreateForm;
