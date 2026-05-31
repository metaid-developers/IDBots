import React, { useEffect, useMemo, useState } from 'react';
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Skill } from '../../types/skill';

type GigSquareSkillOption = Skill & {
  readOnly?: boolean;
};

interface GigSquareSkillPickerProps {
  id: string;
  options: GigSquareSkillOption[];
  selectedSkillIds: string[];
  onSelectedSkillIdsChange: (skillIds: string[]) => void;
  disabled?: boolean;
  emptyText?: string;
}

export const GigSquareSkillPicker: React.FC<GigSquareSkillPickerProps> = ({
  id,
  options,
  selectedSkillIds,
  onSelectedSkillIdsChange,
  disabled = false,
  emptyText = i18nService.t('gigSquarePublishSkillRequired'),
}) => {
  const [candidateSkillId, setCandidateSkillId] = useState('');

  const selectedSkillIdSet = useMemo(
    () => new Set(selectedSkillIds),
    [selectedSkillIds],
  );

  const optionById = useMemo(
    () => new Map(options.map((skill) => [skill.id, skill])),
    [options],
  );

  const addableOptions = useMemo(
    () => options.filter((skill) => !skill.readOnly && !selectedSkillIdSet.has(skill.id)),
    [options, selectedSkillIdSet],
  );

  const selectedOptions = useMemo(
    () => selectedSkillIds
      .map((skillId) => optionById.get(skillId))
      .filter((skill): skill is GigSquareSkillOption => Boolean(skill)),
    [optionById, selectedSkillIds],
  );

  useEffect(() => {
    if (!candidateSkillId) return;
    if (!addableOptions.some((skill) => skill.id === candidateSkillId)) {
      setCandidateSkillId('');
    }
  }, [addableOptions, candidateSkillId]);

  const canAddCandidate = Boolean(candidateSkillId)
    && !disabled
    && addableOptions.some((skill) => skill.id === candidateSkillId);

  const handleAddSkill = () => {
    if (!canAddCandidate) return;
    onSelectedSkillIdsChange([...selectedSkillIds, candidateSkillId]);
    setCandidateSkillId('');
  };

  const handleRemoveSkill = (skillId: string) => {
    const selectedOption = optionById.get(skillId);
    if (disabled || selectedOption?.readOnly) return;
    onSelectedSkillIdsChange(selectedSkillIds.filter((selectedSkillId) => selectedSkillId !== skillId));
  };

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          id={id}
          value={candidateSkillId}
          onChange={(event) => setCandidateSkillId(event.target.value)}
          disabled={disabled || addableOptions.length === 0}
          className="w-full rounded-xl border border-claude-border bg-claude-bg px-3 py-2 text-sm text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:text-claude-darkText"
        >
          <option value="">{i18nService.t('metabotAllowChatSkillsPlaceholder')}</option>
          {addableOptions.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleAddSkill}
          disabled={!canAddCandidate}
          className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl border border-claude-border px-3 py-2 text-sm text-claude-text transition-colors hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-50 dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-claude-darkSurfaceHover"
        >
          <PlusIcon className="h-4 w-4" />
          <span>{i18nService.t('metabotAdd')}</span>
        </button>
      </div>

      <div data-slot="gig-square-selected-skill-chips" className="flex flex-wrap gap-2">
        {selectedOptions.length > 0 ? (
          selectedOptions.map((skill) => (
            <span
              key={skill.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-claude-border bg-claude-surface px-2 py-1 text-xs text-claude-text dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkText"
            >
              <span className="max-w-[11rem] truncate" title={skill.name}>
                {skill.name}
              </span>
              {skill.readOnly ? (
                <span className="rounded-full bg-claude-surfaceMuted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-claude-textSecondary dark:bg-claude-darkSurfaceMuted dark:text-claude-darkTextSecondary">
                  {i18nService.t('gigSquarePublishLegacySkill')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleRemoveSkill(skill.id)}
                  disabled={disabled}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full text-claude-textSecondary hover:bg-black/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
                  aria-label={i18nService.t('metabotDelete')}
                  title={i18nService.t('metabotDelete')}
                >
                  <XMarkIcon className="h-3 w-3" />
                </button>
              )}
            </span>
          ))
        ) : (
          <p className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {emptyText}
          </p>
        )}
      </div>
    </div>
  );
};

export default GigSquareSkillPicker;
