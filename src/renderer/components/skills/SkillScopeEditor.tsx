import React, { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { SkillWithAssignment } from '../../types/skill';

export type AssignableMetabot = { id: number; name: string; metabotType: string };

type EditorMode = 'all' | 'bots' | 'library';

interface SkillScopeEditorProps {
  skill: SkillWithAssignment;
  metabots: AssignableMetabot[];
  onSaved: () => void;
}

/**
 * Per-skill scope editor for the Skills Library.
 *
 * Three states (assignment model):
 * - all:     scope=global, every bot sees the skill
 * - bots:    scope=library + assignment rows for exactly the checked bots
 * - library: scope=library + no assignments (nobody sees it)
 *
 * Narrowing away from "all bots" asks for an explicit confirmation: unchecked
 * bots lose the skill on the next turn.
 */
const SkillScopeEditor: React.FC<SkillScopeEditorProps> = ({ skill, metabots, onSaved }) => {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<EditorMode>('library');
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const currentScope = skill.scope ?? (skill.isBuiltIn ? 'bundled' : 'library');
  const assignedIds = skill.assignedMetabotIds ?? [];

  const openEditor = () => {
    setMode(currentScope === 'global' ? 'all' : assignedIds.length > 0 ? 'bots' : 'library');
    setChecked(new Set(assignedIds));
    setConfirming(false);
    setError('');
    setOpen(true);
  };

  const toggleBot = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setConfirming(false);
  };

  const handleSave = async () => {
    // Leaving "all bots" (or dropping ANY currently-assigned bot — including
    // same-count swaps) takes effect immediately for the dropped bots —
    // require one extra explicit confirmation click.
    const assigned = new Set(assignedIds);
    const narrowing =
      (currentScope === 'global' && mode !== 'all')
      || (mode === 'bots' && Array.from(assigned).some((id) => !checked.has(id)))
      || mode === 'library';
    if (narrowing && !confirming) {
      setConfirming(true);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await window.electron.skills.setScope({
        id: skill.id,
        scope: mode === 'all' ? 'global' : mode === 'bots' ? 'bots' : 'library',
        metabotIds: mode === 'bots' ? Array.from(checked) : [],
      });
      if (!result.success) {
        setError(result.error || i18nService.t('skillScopeSaveFailed'));
        return;
      }
      setOpen(false);
      onSaved();
    } catch {
      setError(i18nService.t('skillScopeSaveFailed'));
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  if (skill.isBuiltIn || currentScope === 'bundled') {
    return (
      <span
        className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium text-[10px] flex-shrink-0"
        title={i18nService.t('skillScopeBundled')}
      >
        {i18nService.t('skillScopeBundled')}
      </span>
    );
  }

  const label =
    currentScope === 'global'
      ? i18nService.t('skillScopeAllBots')
      : assignedIds.length > 0
        ? `${i18nService.t('skillScopeAssignedBots')} · ${assignedIds.length}`
        : i18nService.t('skillScopeLibraryOnly');

  return (
    <div className="relative flex-shrink-0" ref={rootRef}>
      <button
        type="button"
        onClick={openEditor}
        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:border-claude-accent/60 hover:text-claude-accent transition-colors"
        title={i18nService.t('skillScopeEditorTitle')}
      >
        <span
          className={
            currentScope === 'library' && assignedIds.length === 0
              ? 'text-amber-500 dark:text-amber-400'
              : ''
          }
        >
          {label}
        </span>
        <ChevronDownIcon className="h-3 w-3" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-2xl p-3">
          <div className="text-xs font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('skillScopeEditorTitle')}
          </div>

          <div className="space-y-1">
            {([
              ['all', i18nService.t('skillScopeAllBotsOption')],
              ['bots', i18nService.t('skillScopeBotsOption')],
              ['library', i18nService.t('skillScopeLibraryOption')],
            ] as Array<[EditorMode, string]>).map(([value, text]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setConfirming(false);
                }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-left transition-colors ${
                  mode === value
                    ? 'bg-claude-accent/10 text-claude-accent'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span
                  className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                    mode === value ? 'border-claude-accent' : 'dark:border-claude-darkBorder border-claude-border'
                  }`}
                >
                  {mode === value && <span className="w-1.5 h-1.5 rounded-full bg-claude-accent" />}
                </span>
                {text}
              </button>
            ))}
          </div>

          {mode === 'bots' && (
            <div className="mt-2 max-h-40 overflow-y-auto">
              <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                {i18nService.t('skillScopeSelectBots')}
              </div>
              {metabots.length === 0 ? (
                <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  —
                </div>
              ) : (
                metabots.map((bot) => (
                  <button
                    key={bot.id}
                    type="button"
                    onClick={() => toggleBot(bot.id)}
                    className="w-full flex items-center gap-2 px-2 py-1 rounded-lg text-xs text-left dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded border flex items-center justify-center flex-shrink-0 ${
                        checked.has(bot.id)
                          ? 'bg-claude-accent border-claude-accent'
                          : 'dark:border-claude-darkBorder border-claude-border'
                      }`}
                    >
                      {checked.has(bot.id) && <CheckIcon className="w-2.5 h-2.5 text-claude-accentInk" />}
                    </span>
                    <span className="truncate">{bot.name}</span>
                  </button>
                ))
              )}
            </div>
          )}

          {confirming && (
            <p className="mt-2 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
              {i18nService.t('skillScopeNarrowWarning')}
            </p>
          )}
          {error && <p className="mt-2 text-[10px] text-red-500">{error}</p>}

          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={saving}
              className="px-2.5 py-1 text-[11px] rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || (mode === 'bots' && checked.size === 0)}
              className={`px-2.5 py-1 text-[11px] rounded-lg border transition-colors ${
                confirming
                  ? 'border-amber-600 bg-amber-500 text-white hover:brightness-[0.96]'
                  : 'border-[var(--btn-primary-edge)] bg-claude-accent text-claude-accentInk hover:brightness-[0.96] active:brightness-[0.9]'
              } disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              {confirming ? i18nService.t('communitySkillConfirm') : i18nService.t('skillScopeConfirm')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SkillScopeEditor;
