import React, { useEffect, useMemo, useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface CoworkPermissionPanelProps {
  permission: CoworkPermissionRequest;
  onRespond: (result: CoworkPermissionResult) => void;
  responding?: boolean;
}

type QuestionOption = {
  label: string;
  description?: string;
};

type QuestionItem = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};

type SafetyContext = {
  requestedToolName: string;
  requestedToolInput: Record<string, unknown>;
};

const toRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

const parseQuestions = (permission: CoworkPermissionRequest): QuestionItem[] => {
  if (permission.toolName !== 'AskUserQuestion') return [];
  const rawQuestions = permission.toolInput.questions;
  if (!Array.isArray(rawQuestions)) return [];

  return rawQuestions
    .map((question) => {
      const record = toRecord(question);
      if (!record || typeof record.question !== 'string' || !record.question.trim()) return null;
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              const optionRecord = toRecord(option);
              if (!optionRecord || typeof optionRecord.label !== 'string' || !optionRecord.label.trim()) return null;
              return {
                label: optionRecord.label,
                description: typeof optionRecord.description === 'string'
                  ? optionRecord.description
                  : undefined,
              } as QuestionOption;
            })
            .filter(Boolean) as QuestionOption[]
        : [];
      if (options.length === 0) return null;
      return {
        question: record.question,
        header: typeof record.header === 'string' ? record.header : undefined,
        options,
        multiSelect: record.multiSelect === true,
      } as QuestionItem;
    })
    .filter(Boolean) as QuestionItem[];
};

const parseSafetyContext = (permission: CoworkPermissionRequest): SafetyContext | null => {
  if (permission.toolName !== 'AskUserQuestion') return null;
  const context = toRecord(permission.toolInput.context);
  if (!context || typeof context.requestedToolName !== 'string') return null;
  const requestedToolInput = toRecord(context.requestedToolInput);
  if (!requestedToolInput) return null;
  return {
    requestedToolName: context.requestedToolName,
    requestedToolInput,
  };
};

const stringifyInput = (input: Record<string, unknown>): string => {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
};

const summarizeToolInput = (toolName: string, input: Record<string, unknown>): string => {
  const raw = toolName.toLowerCase() === 'bash'
    ? input.command
    : input.file_path ?? input.notebook_path ?? input.path ?? input.description ?? input.reason;
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) return '';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};

/**
 * DSH-style composer takeover for a pending human interaction. It deliberately
 * has no fixed positioning: the owner renders it in the same layout slot as
 * CoworkPromptInput, so an approval replaces the composer without covering the
 * conversation. Safety approvals and ordinary agent questions share the seat,
 * but never share controls or response semantics.
 */
const CoworkPermissionPanel: React.FC<CoworkPermissionPanelProps> = ({
  permission,
  onRespond,
  responding = false,
}) => {
  const questions = useMemo(() => parseQuestions(permission), [permission]);
  const safetyContext = useMemo(() => parseSafetyContext(permission), [permission]);
  const isAskRequest = permission.toolName === 'AskUserQuestion';
  const isSafetyApproval = safetyContext !== null && questions.length > 0;
  const isQuestionRequest = isAskRequest && !isSafetyApproval && questions.length > 0;
  const isMalformedQuestion = isAskRequest && !isSafetyApproval && questions.length === 0;

  const [expanded, setExpanded] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<number, string>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setExpanded(false);
    setCurrentStep(0);
    setOtherInputs({});
    setSkippedQuestions({});
    const rawAnswers = toRecord(permission.toolInput.answers);
    if (!rawAnswers) {
      setAnswers({});
      return;
    }
    const initial: Record<string, string> = {};
    Object.entries(rawAnswers).forEach(([key, value]) => {
      if (typeof value === 'string') initial[key] = value;
    });
    setAnswers(initial);
  }, [permission.requestId, permission.toolInput]);

  const currentQuestion = questions[currentStep];
  const totalSteps = questions.length;
  const isFirstStep = currentStep === 0;
  const isLastStep = currentStep === totalSteps - 1;

  const requestedToolName = safetyContext?.requestedToolName ?? permission.toolName;
  const requestedToolInput = safetyContext?.requestedToolInput ?? permission.toolInput;
  const inputSummary = summarizeToolInput(requestedToolName, requestedToolInput);
  const nativeReason = typeof permission.toolInput.reason === 'string'
    ? permission.toolInput.reason.trim()
    : '';

  const getSelectedValues = (question: QuestionItem): string[] => {
    const rawValue = answers[question.question] ?? '';
    if (!rawValue) return [];
    return question.multiSelect
      ? rawValue.split('|||').map((value) => value.trim()).filter(Boolean)
      : [rawValue];
  };

  const handleSelectOption = (question: QuestionItem, optionLabel: string) => {
    setSkippedQuestions((previous) => ({ ...previous, [question.question]: false }));
    if (!question.multiSelect) {
      setOtherInputs((previous) => {
        const next = { ...previous };
        delete next[currentStep];
        return next;
      });
    }
    setAnswers((previous) => {
      if (!question.multiSelect) return { ...previous, [question.question]: optionLabel };
      const selected = new Set(
        (previous[question.question] ?? '')
          .split('|||')
          .map((value) => value.trim())
          .filter(Boolean)
      );
      if (selected.has(optionLabel)) selected.delete(optionLabel);
      else selected.add(optionLabel);
      const next = { ...previous };
      if (selected.size === 0) delete next[question.question];
      else next[question.question] = Array.from(selected).join('|||');
      return next;
    });

    if (!question.multiSelect && !isLastStep) {
      window.setTimeout(() => setCurrentStep((step) => Math.min(step + 1, totalSteps - 1)), 140);
    }
  };

  const handleOtherInputChange = (value: string) => {
    setOtherInputs((previous) => ({ ...previous, [currentStep]: value }));
    if (currentQuestion) {
      setSkippedQuestions((previous) => ({ ...previous, [currentQuestion.question]: false }));
      if (!currentQuestion.multiSelect && value.trim()) {
        setAnswers((previous) => {
          const next = { ...previous };
          delete next[currentQuestion.question];
          return next;
        });
      }
    }
  };

  const handleSkip = () => {
    if (!currentQuestion) return;
    setAnswers((previous) => {
      const next = { ...previous };
      delete next[currentQuestion.question];
      return next;
    });
    setOtherInputs((previous) => {
      const next = { ...previous };
      delete next[currentStep];
      return next;
    });
    setSkippedQuestions((previous) => ({ ...previous, [currentQuestion.question]: true }));
    if (!isLastStep) setCurrentStep((step) => step + 1);
  };

  const isQuestionComplete = isQuestionRequest && questions.every((question, index) => (
    Boolean(answers[question.question]?.trim())
    || Boolean(otherInputs[index]?.trim())
    || skippedQuestions[question.question] === true
  ));
  const isCurrentQuestionComplete = Boolean(currentQuestion && (
    answers[currentQuestion.question]?.trim()
    || otherInputs[currentStep]?.trim()
    || skippedQuestions[currentQuestion.question] === true
  ));

  const handleApprove = () => {
    if (responding) return;
    if (isSafetyApproval) {
      const safetyQuestion = questions[0];
      const allowOption = safetyQuestion.options[0];
      onRespond({
        behavior: 'allow',
        updatedInput: {
          ...permission.toolInput,
          answers: { [safetyQuestion.question]: allowOption.label },
        },
      });
      return;
    }
    if (isQuestionRequest) {
      if (!isQuestionComplete) return;
      const finalAnswers = { ...answers };
      Object.entries(otherInputs).forEach(([stepIndex, customValue]) => {
        const question = questions[Number(stepIndex)];
        if (!question || !customValue.trim()) return;
        if (question.multiSelect) {
          const selected = (finalAnswers[question.question] ?? '')
            .split('|||')
            .map((value) => value.trim())
            .filter(Boolean);
          finalAnswers[question.question] = [...selected, customValue.trim()].join('|||');
        } else {
          finalAnswers[question.question] = customValue.trim();
        }
      });
      onRespond({
        behavior: 'allow',
        updatedInput: { ...permission.toolInput, answers: finalAnswers },
      });
      return;
    }
    onRespond({ behavior: 'allow', updatedInput: permission.toolInput });
  };

  const handleDeny = () => {
    if (responding) return;
    onRespond({ behavior: 'deny', message: 'Permission denied' });
  };

  const handleNextQuestion = () => {
    if (responding || isLastStep || !isCurrentQuestionComplete) return;
    setCurrentStep((step) => Math.min(step + 1, totalSteps - 1));
  };

  const handleQuestionPrimaryAction = () => {
    if (responding) return;
    if (!isLastStep) {
      handleNextQuestion();
      return;
    }
    handleApprove();
  };

  if (isQuestionRequest && currentQuestion) {
    const selectedValues = getSelectedValues(currentQuestion);
    return (
      <section
        className="w-full overflow-hidden rounded-[20px] border border-claude-accent/70 dark:border-claude-accent/50 bg-claude-surface dark:bg-claude-darkSurface shadow-elevated animate-slide-up"
        aria-labelledby={`cowork-question-${permission.requestId}`}
        data-cowork-composer-takeover="question"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent/20 dark:bg-claude-accent/15 text-[#7a5b00] dark:text-[#ffe47a] text-xs font-medium">
          <span className="h-2 w-2 rounded-full bg-[#c48f00] dark:bg-claude-accent shadow-[0_0_0_4px_rgba(196,143,0,0.12)]" />
          <span>{i18nService.t('coworkQuestionWaiting')}</span>
          <span className="ml-auto tabular-nums text-[11px] opacity-75">{currentStep + 1} / {totalSteps}</span>
        </div>

        <div className="max-h-[min(300px,36vh)] overflow-y-auto px-4 py-3.5">
          {currentQuestion.header && (
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {currentQuestion.header}
            </div>
          )}
          <h2 id={`cowork-question-${permission.requestId}`} className="m-0 text-[15px] leading-6 font-semibold text-claude-text dark:text-claude-darkText">
            {currentQuestion.question}
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3" role={currentQuestion.multiSelect ? 'group' : 'radiogroup'}>
            {currentQuestion.options.map((option) => {
              const selected = selectedValues.includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  role={currentQuestion.multiSelect ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  disabled={responding}
                  onClick={() => handleSelectOption(currentQuestion, option.label)}
                  className={`min-w-0 flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'border-[#c69a0b] bg-claude-accent/15 text-claude-text dark:text-claude-darkText shadow-[inset_0_0_0_1px_rgba(198,154,11,0.14)]'
                      : 'border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface text-claude-text dark:text-claude-darkText hover:border-claude-accent'
                  }`}
                >
                  <span className={`mt-0.5 h-4 w-4 flex-shrink-0 grid place-items-center border ${currentQuestion.multiSelect ? 'rounded-[5px]' : 'rounded-full'} ${selected ? 'border-[#bd9000]' : 'border-claude-textSecondary/60 dark:border-claude-darkTextSecondary/60'}`}>
                    {selected && <span className={`${currentQuestion.multiSelect ? 'h-2 w-2 rounded-[2px]' : 'h-2 w-2 rounded-full'} bg-[#bd9000]`} />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] leading-5 font-medium">{option.label}</span>
                    {option.description && <span className="block mt-0.5 text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">{option.description}</span>}
                  </span>
                </button>
              );
            })}
          </div>

          <input
            type="text"
            value={otherInputs[currentStep] ?? ''}
            onChange={(event) => handleOtherInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              handleQuestionPrimaryAction();
            }}
            placeholder={i18nService.t('coworkQuestionWizardOtherPlaceholder')}
            disabled={responding}
            className="mt-2.5 w-full rounded-xl border border-claude-border dark:border-claude-darkBorder bg-claude-bg/60 dark:bg-claude-darkBg/60 px-3 py-2 text-xs text-claude-text dark:text-claude-darkText placeholder:text-claude-textSecondary/60 dark:placeholder:text-claude-darkTextSecondary/60 focus:outline-none focus:ring-2 focus:ring-claude-accent/40 focus:border-claude-accent disabled:opacity-60"
          />
        </div>

        <div className="flex items-center gap-2 border-t border-claude-border/70 dark:border-claude-darkBorder/70 px-4 py-3">
          <button type="button" onClick={handleSkip} disabled={responding} className="text-xs font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText disabled:opacity-60">
            {i18nService.t('coworkQuestionSkipThis')}
          </button>
          {totalSteps > 1 && (
            <div className="ml-auto flex items-center gap-1">
              <button type="button" onClick={() => setCurrentStep((step) => Math.max(step - 1, 0))} disabled={isFirstStep || responding} className="p-1.5 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30" aria-label={i18nService.t('coworkQuestionWizardPrevious')}>
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <button type="button" onClick={handleNextQuestion} disabled={isLastStep || responding || !isCurrentQuestionComplete} className="p-1.5 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30" aria-label={i18nService.t('coworkQuestionWizardNext')}>
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>
          )}
          <button type="button" onClick={handleDeny} disabled={responding} className={`${totalSteps === 1 ? 'ml-auto' : ''} px-3 py-2 rounded-lg border border-claude-border dark:border-claude-darkBorder text-xs font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-900/20 dark:hover:text-red-300 disabled:opacity-60`}>
            {i18nService.t('coworkDeny')}
          </button>
          <button
            type="button"
            onClick={handleQuestionPrimaryAction}
            disabled={responding || (isLastStep ? !isQuestionComplete : !isCurrentQuestionComplete)}
            className="btn-idchat-primary-filled px-3 py-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {responding
              ? i18nService.t('processing')
              : i18nService.t(isLastStep ? 'coworkQuestionWizardSubmit' : 'coworkQuestionWizardNext')}
          </button>
        </div>
      </section>
    );
  }

  const approvalTitle = isSafetyApproval
    ? i18nService.t('coworkApprovalDestructiveTitle')
    : isMalformedQuestion
      ? i18nService.t('coworkApprovalUnavailableTitle')
      : nativeReason || i18nService.t('coworkApprovalActionTitle');
  const isDestructive = isSafetyApproval;

  return (
    <section
      className={`w-full overflow-hidden rounded-[20px] border bg-claude-surface dark:bg-claude-darkSurface shadow-elevated animate-slide-up ${
        isDestructive
          ? 'border-amber-400/90 dark:border-amber-500/60'
          : 'border-claude-accent/70 dark:border-claude-accent/50'
      }`}
      aria-labelledby={`cowork-approval-${permission.requestId}`}
      data-cowork-composer-takeover={isMalformedQuestion ? 'unavailable' : 'approval'}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 bg-claude-accent/20 dark:bg-claude-accent/15 text-[#7a5b00] dark:text-[#ffe47a] text-xs font-medium">
        <span className="h-2 w-2 rounded-full bg-[#c48f00] dark:bg-claude-accent shadow-[0_0_0_4px_rgba(196,143,0,0.12)]" />
        <span>{isMalformedQuestion ? i18nService.t('coworkQuestionWaiting') : i18nService.t('coworkApprovalWaiting')}</span>
        <span className="ml-auto text-[11px] opacity-75">{isMalformedQuestion ? '' : `${requestedToolName} · ${i18nService.t('coworkApprovalOneShot')}`}</span>
      </div>

      <div className="flex items-center gap-4 px-4 py-3.5">
        <span className={`h-9 w-9 flex-shrink-0 grid place-items-center rounded-xl ${isDestructive || isMalformedQuestion ? 'bg-red-50 text-red-600 dark:bg-red-900/25 dark:text-red-300' : 'bg-claude-accent/15 text-[#a47700] dark:text-claude-accent'}`}>
          <ExclamationTriangleIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={`cowork-approval-${permission.requestId}`} className="m-0 text-[15px] leading-6 font-semibold text-claude-text dark:text-claude-darkText">
            {approvalTitle}
          </h2>
          {isMalformedQuestion ? (
            <p className="mt-1 mb-0 text-xs leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('coworkApprovalUnavailableBody')}
            </p>
          ) : inputSummary ? (
            <code className="block mt-1 truncate text-xs leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary font-mono" title={inputSummary}>{inputSummary}</code>
          ) : !isSafetyApproval && nativeReason ? null : (
            <p className="mt-1 mb-0 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('coworkApprovalReviewHint')}
            </p>
          )}
          {!isMalformedQuestion && (
            <button type="button" onClick={() => setExpanded((value) => !value)} disabled={responding} aria-expanded={expanded} className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-text dark:hover:text-claude-darkText disabled:opacity-60">
              {expanded ? i18nService.t('coworkPermissionCollapse') : i18nService.t('coworkPermissionDetails')}
              {expanded ? <ChevronUpIcon className="h-3.5 w-3.5" /> : <ChevronDownIcon className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
      </div>

      {expanded && !isMalformedQuestion && (
        <div className="mx-4 mb-3 max-h-40 overflow-y-auto rounded-xl border border-claude-border/70 dark:border-claude-darkBorder/70 bg-claude-bg/65 dark:bg-claude-darkBg/65 px-3 py-2.5" tabIndex={0} aria-label={i18nService.t('coworkPermissionDetails')}>
          <pre className="m-0 whitespace-pre-wrap break-words text-[11px] leading-5 font-mono text-claude-textSecondary dark:text-claude-darkTextSecondary">{stringifyInput(requestedToolInput)}</pre>
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-claude-border/70 dark:border-claude-darkBorder/70 px-4 py-3">
        <button type="button" onClick={handleDeny} disabled={responding} className="px-3 py-2 rounded-lg border border-claude-border dark:border-claude-darkBorder text-xs font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary hover:bg-red-50 hover:text-red-600 hover:border-red-200 dark:hover:bg-red-900/20 dark:hover:text-red-300 disabled:opacity-60">
          {i18nService.t('coworkDeny')}
        </button>
        {!isMalformedQuestion && (
          <button type="button" onClick={handleApprove} disabled={responding} className={isDestructive
            ? 'px-3 py-2 rounded-lg border-2 border-red-700 bg-red-600 text-white text-xs font-medium shadow-[2px_2px_0_#991b1b] hover:bg-red-700 active:translate-x-[1px] active:translate-y-[1px] active:shadow-none disabled:opacity-50 disabled:cursor-not-allowed'
            : 'btn-idchat-primary-filled px-3 py-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed'}>
            {responding
              ? i18nService.t('processing')
              : isDestructive
                ? i18nService.t('coworkApprovalAllowDelete')
                : i18nService.t('coworkApprovalAllowOnce')}
          </button>
        )}
      </div>
    </section>
  );
};

export default CoworkPermissionPanel;
