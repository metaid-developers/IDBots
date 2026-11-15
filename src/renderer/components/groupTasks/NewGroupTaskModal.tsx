import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { groupTaskService } from '../../services/groupTaskService';
import type { GroupTaskDetail } from '../../types/groupTask';
import type { Metabot } from '../../types/metabot';

interface NewGroupTaskModalProps {
  onClose: () => void;
  onCreated: (task: GroupTaskDetail) => void;
}

const inputClass = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50';
const labelClass = 'block text-sm font-medium dark:text-claude-darkText text-claude-text mb-1';
const errorClass = 'text-xs text-red-500 mt-1';

const NewGroupTaskModal: React.FC<NewGroupTaskModalProps> = ({ onClose, onCreated }) => {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState('');
  const [workerBots, setWorkerBots] = useState<Metabot[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<number[]>([]);
  // R1: task (classic pipeline) vs chat (free-form conversation) group.
  const [groupMode, setGroupMode] = useState<'task' | 'chat'>('task');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default to the chat-first guide; the manual form is a fallback entry.
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadBots = async () => {
      try {
        const result = await window.electron?.metabot?.list?.();
        if (cancelled || !result?.success || !Array.isArray(result.list)) return;
        // The twin bot chairs automatically; only workers are selectable members.
        setWorkerBots(result.list.filter((bot: Metabot) => bot.enabled && bot.metabot_type === 'worker'));
      } catch {
        // Member list stays empty; chair-only creation remains possible.
      }
    };
    void loadBots();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleMember = (botId: number) => {
    setSelectedMemberIds((current) =>
      current.includes(botId) ? current.filter((id) => id !== botId) : [...current, botId]
    );
  };

  const canSubmit = title.trim().length > 0 && goal.trim().length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) {
      setError(i18nService.t('groupTasksFormValidationRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const task = await groupTaskService.createTask({
        title: title.trim(),
        goal: goal.trim(),
        acceptanceCriteria: groupMode === 'chat' ? undefined : acceptanceCriteria.trim() || undefined,
        memberMetabotIds: selectedMemberIds,
        mode: groupMode,
      });
      onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className="relative w-[480px] max-h-[85vh] overflow-y-auto rounded-xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text mb-4">
          {i18nService.t('groupTasksCreateTitle')}
        </h3>

        {showForm ? (
          <>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              disabled={submitting}
              className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:underline mb-4 disabled:opacity-50"
            >
              {i18nService.t('groupTasksBackToGuide')}
            </button>

        <div className="space-y-4">
          <div>
            <label className={labelClass}>{i18nService.t('groupTasksFormMode')}</label>
            <div className="grid grid-cols-2 gap-2">
              {(['task', 'chat'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => setGroupMode(candidate)}
                  aria-pressed={groupMode === candidate}
                  className={`px-3 py-2 text-sm rounded-lg border text-left transition-colors ${
                    groupMode === candidate
                      ? 'border-claude-accent bg-claude-accent/10 text-claude-accent font-medium'
                      : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50'
                  }`}
                >
                  {i18nService.t(candidate === 'task' ? 'groupTasksFormModeTask' : 'groupTasksFormModeChat')}
                </button>
              ))}
            </div>
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 mt-1.5 leading-relaxed">
              {i18nService.t(groupMode === 'chat' ? 'groupTasksFormModeChatHint' : 'groupTasksFormModeTaskHint')}
            </p>
          </div>

          <div>
            <label className={labelClass}>{i18nService.t('groupTasksFormTitle')}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
              placeholder={i18nService.t('groupTasksFormTitlePlaceholder')}
              autoFocus
            />
          </div>

          <div>
            <label className={labelClass}>{i18nService.t('groupTasksFormGoal')}</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className={`${inputClass} h-24 resize-none`}
              placeholder={i18nService.t('groupTasksFormGoalPlaceholder')}
            />
          </div>

          {groupMode === 'task' && (
            <div>
              <label className={labelClass}>{i18nService.t('groupTasksFormAcceptance')}</label>
              <textarea
                value={acceptanceCriteria}
                onChange={(e) => setAcceptanceCriteria(e.target.value)}
                className={`${inputClass} h-16 resize-none`}
                placeholder={i18nService.t('groupTasksFormAcceptancePlaceholder')}
              />
            </div>
          )}

          <div>
            <label className={labelClass}>{i18nService.t('groupTasksFormMembers')}</label>
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
              {i18nService.t('groupTasksFormMembersChairHint')}
            </p>
            {workerBots.length === 0 ? (
              <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                {i18nService.t('groupTasksFormNoWorkers')}
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-lg border dark:border-claude-darkBorder border-claude-border divide-y dark:divide-claude-darkBorder/50 divide-claude-border/50">
                {workerBots.map((bot) => (
                  <label
                    key={bot.id}
                    className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedMemberIds.includes(bot.id)}
                      onChange={() => toggleMember(bot.id)}
                      className="rounded border-claude-border dark:border-claude-darkBorder text-claude-accent focus:ring-claude-accent/50"
                    />
                    <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
                      {bot.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {error && <p className={errorClass}>{error}</p>}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 px-4 py-2 text-sm rounded-[var(--rounded)] dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex-1 btn-idchat-primary-filled px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {submitting ? i18nService.t('groupTasksCreating') : i18nService.t('groupTasksCreateSubmit')}
            </button>
          </div>
        </div>
          </>
        ) : (
          <div className="space-y-5">
            <p className="text-sm dark:text-claude-darkText text-claude-text leading-relaxed">
              {i18nService.t('groupTasksChatGuideTitle')}
            </p>

            <blockquote className="rounded-lg border-l-2 border-claude-accent bg-claude-surfaceHover/40 dark:bg-claude-darkSurfaceHover/40 px-4 py-3">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary leading-relaxed">
                {i18nService.t('groupTasksChatGuideExample')}
              </p>
            </blockquote>

            {/* When-to-use note: deliberately quiet (small, faded) — it only
                tells the user what kind of work deserves a group task. */}
            <div className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 leading-relaxed">
              <p className="font-medium mb-1">{i18nService.t('groupTasksWhenToUseTitle')}</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>{i18nService.t('groupTasksWhenToUseHint1')}</li>
                <li>{i18nService.t('groupTasksWhenToUseHint2')}</li>
              </ol>
            </div>

            <div className="pt-2 space-y-3">
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="block text-sm font-medium text-claude-accent hover:underline"
              >
                {i18nService.t('groupTasksManualEntry')}
              </button>

              <button
                type="button"
                onClick={onClose}
                className="w-full px-4 py-2 text-sm rounded-lg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default NewGroupTaskModal;
