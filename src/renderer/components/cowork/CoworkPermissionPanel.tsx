import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { pickRecommendedOptionLabel } from '../../../main/shared/pickRecommendedOption';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { PermissionCountdownLabel, usePermissionCountdown } from './permissionCountdown';

interface CoworkPermissionPanelProps {
  permission: CoworkPermissionRequest;
  onRespond: (result: CoworkPermissionResult) => void;
  responding?: boolean;
}

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionItem = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
  /** Long-form body shown between the question and the options (plan review). */
  detail?: string;
};

export type SafetyContext = {
  requestedToolName: string;
  requestedToolInput: Record<string, unknown>;
};

/**
 * The gateway/IPC sanitizer replaces over-deep values with this exact
 * sentinel string; a payload carrying it as option labels has lost its
 * structure and must not render as selectable choices (F-17a).
 */
const isTruncatedDepthSentinel = (value: string): boolean => value === '[truncated-depth]';

const toRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

export const parseQuestions = (permission: CoworkPermissionRequest): QuestionItem[] => {
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
              // Ask-payload tolerance (F-17a): older/brokered relays may pass
              // option entries as bare strings or payload labels as
              // non-strings; degrade to {label} instead of dropping the whole
              // question into the malformed fallback card. The IPC sanitizer's
              // '[truncated-depth]' sentinel is NOT readable content — treat a
              // payload whose options are only sentinels as unusable so it
              // takes the plain-text fallback (raw payload + Allow/Deny)
              // instead of offering bogus clickable choices.
              if (typeof option === 'string' && option.trim() && !isTruncatedDepthSentinel(option)) {
                return { label: option } as QuestionOption;
              }
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
      // Option-less questions are kept on purpose: the ask schema makes
      // options optional per question, and the wizard's free-text input below
      // is the answer path for them (wire: non-option-label text → custom).
      return {
        question: record.question,
        header: typeof record.header === 'string' ? record.header : undefined,
        options,
        multiSelect: record.multiSelect === true || record.multi_select === true,
        detail: typeof record.detail === 'string' && record.detail.trim() ? record.detail : undefined,
      } as QuestionItem;
    })
    .filter(Boolean) as QuestionItem[];
};

export const parseSafetyContext = (permission: CoworkPermissionRequest): SafetyContext | null => {
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

export const summarizeToolInput = (toolName: string, input: Record<string, unknown>): string => {
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
  // A safety approval requires its fixed allow/deny options (host-built asks
  // always carry both). parseQuestions now also keeps option-less questions,
  // so an ask with safety context but no usable options must fall through to
  // the question wizard — handleApprove's safety branch dereferences
  // questions[0].options[0] and must never see an empty options list.
  const isSafetyApproval = safetyContext !== null
    && questions.length > 0
    && questions[0].options.length > 0;
  const isQuestionRequest = isAskRequest && !isSafetyApproval && questions.length > 0;
  const isMalformedQuestion = isAskRequest && !isSafetyApproval && questions.length === 0;

  const [expanded, setExpanded] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherInputs, setOtherInputs] = useState<Record<number, string>>({});
  const [skippedQuestions, setSkippedQuestions] = useState<Record<string, boolean>>({});
  // Question texts the per-question timer picked on its own; forwarded as
  // updatedInput.autoAnswered so main can tag those wire answers with the
  // "auto-selected" note the model sees.
  const autoAnsweredRef = useRef<Set<string>>(new Set());
  // Latest-state snapshot for the timer callback (it outlives the render
  // that armed it).
  const latestRef = useRef({ answers, otherInputs, skippedQuestions, questions });
  latestRef.current = { answers, otherInputs, skippedQuestions, questions };

  useEffect(() => {
    setExpanded(false);
    setCurrentStep(0);
    setOtherInputs({});
    setSkippedQuestions({});
    autoAnsweredRef.current = new Set();
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

  // Per-question timeout: each wizard step gets its own window, armed when
  // the step becomes visible (main sends perQuestionTimeoutMs; null means
  // exempt — plan reviews, long-term-task defining sessions). If the current
  // step lapses still unanswered, the recommended option is auto-picked and
  // the wizard advances; lapsing on the last step submits everything. An
  // already-answered step never fires (the user's pick stands and the wizard
  // waits for their click). The main-process watchdog is only a backstop
  // scaled by question count for asks that never reach this panel.
  useEffect(() => {
    const timeoutMs = permission.perQuestionTimeoutMs;
    if (!isQuestionRequest || responding || !timeoutMs) return;
    const step = currentStep;
    const timer = window.setTimeout(() => {
      const { questions: qs, answers: ans, otherInputs: others, skippedQuestions: skipped } = latestRef.current;
      const question = qs[step];
      if (!question) return;
      const alreadyAnswered = Boolean(ans[question.question]?.trim())
        || Boolean(others[step]?.trim())
        || skipped[question.question] === true;
      if (alreadyAnswered) return;
      const recommended = pickRecommendedOptionLabel(question.options);
      if (recommended) {
        autoAnsweredRef.current.add(question.question);
        setAnswers((previous) => ({ ...previous, [question.question]: recommended }));
        if (!question.multiSelect) {
          setOtherInputs((previous) => {
            const next = { ...previous };
            delete next[step];
            return next;
          });
        }
      } else {
        setSkippedQuestions((previous) => ({ ...previous, [question.question]: true }));
      }
      if (step < qs.length - 1) {
        setCurrentStep((value) => Math.min(value + 1, qs.length - 1));
        return;
      }
      // Last step lapsed: submit, auto-filling any still-unanswered
      // questions with their recommended option (user skips stay skipped).
      const finalAnswers: Record<string, string> = { ...latestRef.current.answers };
      if (recommended) finalAnswers[question.question] = recommended;
      else delete finalAnswers[question.question];
      Object.entries(others).forEach(([stepIndex, customValue]) => {
        const entry = qs[Number(stepIndex)];
        if (!entry || !customValue.trim()) return;
        if (entry.multiSelect) {
          const selected = (finalAnswers[entry.question] ?? '')
            .split('|||')
            .map((value) => value.trim())
            .filter(Boolean);
          finalAnswers[entry.question] = [...selected, customValue.trim()].join('|||');
        } else {
          finalAnswers[entry.question] = customValue.trim();
        }
      });
      qs.forEach((entry) => {
        const done = Boolean(finalAnswers[entry.question]?.trim())
          || Boolean(latestRef.current.skippedQuestions[entry.question])
          || entry.question === question.question;
        if (done) return;
        const pick = pickRecommendedOptionLabel(entry.options);
        if (pick) {
          finalAnswers[entry.question] = pick;
          autoAnsweredRef.current.add(entry.question);
        } else {
          setSkippedQuestions((previous) => ({ ...previous, [entry.question]: true }));
        }
      });
      onRespond({
        behavior: 'allow',
        updatedInput: {
          ...permission.toolInput,
          answers: finalAnswers,
          autoAnswered: Array.from(autoAnsweredRef.current),
        },
      });
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [permission.requestId, currentStep, isQuestionRequest, responding, permission.perQuestionTimeoutMs]);

  const countdownSeconds = usePermissionCountdown(permission.expiresAt);
  const countdownFor = (action: 'allow' | 'deny'): number | null => (
    permission.timeoutDefault === action ? countdownSeconds : null
  );

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
        updatedInput: {
          ...permission.toolInput,
          answers: finalAnswers,
          autoAnswered: Array.from(autoAnsweredRef.current),
        },
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

          {currentQuestion.detail && (
            <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-claude-border/70 dark:border-claude-darkBorder/70 bg-claude-bg/60 dark:bg-claude-darkBg/60 px-3 py-2 text-xs leading-5 text-claude-text dark:text-claude-darkText">
              {currentQuestion.detail}
            </div>
          )}

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
            <>
              <p className="mt-1 mb-0 text-xs leading-5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('coworkApprovalUnavailableBody')}
              </p>
              {/* Plain-text fallback (F-17a): the payload is still the agent's
                  question — render its raw content and keep both Allow/Deny
                  available so the user is never boxed into a deny-only card. */}
              <pre className="mt-2 mb-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-claude-border/70 dark:border-claude-darkBorder/70 bg-claude-bg/65 dark:bg-claude-darkBg/65 px-3 py-2 text-[11px] leading-5 font-mono text-claude-textSecondary dark:text-claude-darkTextSecondary">{stringifyInput(permission.toolInput)}</pre>
            </>
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
          <PermissionCountdownLabel label={i18nService.t('coworkDeny')} seconds={responding ? null : countdownFor('deny')} />
        </button>
        <button type="button" onClick={handleApprove} disabled={responding} className={isDestructive
          ? 'px-3 py-2 rounded-lg border-2 border-red-700 bg-red-600 text-white text-xs font-medium shadow-[2px_2px_0_#991b1b] hover:bg-red-700 active:translate-x-[1px] active:translate-y-[1px] active:shadow-none disabled:opacity-50 disabled:cursor-not-allowed'
          : 'btn-idchat-primary-filled px-3 py-2 text-xs disabled:opacity-50 disabled:cursor-not-allowed'}>
          <PermissionCountdownLabel
            label={responding
              ? i18nService.t('processing')
              : isDestructive
                ? i18nService.t('coworkApprovalAllowDelete')
                : i18nService.t('coworkApprovalAllowOnce')}
            seconds={responding ? null : countdownFor('allow')}
          />
        </button>
      </div>
    </section>
  );
};

export default CoworkPermissionPanel;
