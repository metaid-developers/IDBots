import React, { useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { parseQuestions, parseSafetyContext, summarizeToolInput } from './CoworkPermissionPanel';
import { ArrowRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface CoworkPermissionOverlayProps {
  /**
   * Session whose permission prompt is already rendered inline by
   * CoworkSessionDetail (the open chat), or null when no inline seat is
   * mounted. Prompts for any OTHER session surface in this overlay. A2A
   * conversations are the exception: their input area renders guidance
   * controls instead of the composer takeover, so their prompts keep
   * surfacing here even when the A2A session is the open one.
   */
  inlineSessionId: string | null;
}

/**
 * Build the allow-answer for one-click approval, mirroring the inline
 * panel's response semantics: safety approvals answer the confirmation
 * question with its first (allow) option; plain question wizards answer
 * every question with its first option — the same fallback the runner's
 * ask-timeout backstop applies.
 */
const buildAllowResult = (permission: CoworkPermissionRequest): CoworkPermissionResult => {
  const questions = parseQuestions(permission);
  const safetyContext = parseSafetyContext(permission);
  if (safetyContext && questions.length > 0) {
    const first = questions[0];
    const allowOption = first.options[0];
    return {
      behavior: 'allow',
      updatedInput: {
        ...permission.toolInput,
        answers: allowOption ? { [first.question]: allowOption.label } : {},
      },
    };
  }
  if (questions.length > 0) {
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const firstOption = question.options[0];
      if (firstOption) answers[question.question] = firstOption.label;
    }
    return {
      behavior: 'allow',
      updatedInput: { ...permission.toolInput, answers },
    };
  }
  return { behavior: 'allow', updatedInput: permission.toolInput };
};

/**
 * Global fallback seat for cowork permission prompts. CoworkSessionDetail only
 * renders prompts for the currently open chat (and never for A2A
 * conversations), so prompts raised by background, IM-automation, A2A or
 * hidden sessions would otherwise queue with nowhere to render and burn the
 * runner's ask-timeout backstop into an automatic answer. This overlay floats above
 * every view, answers prompts in place with allow/deny, and links back to the
 * owning session.
 */
const CoworkPermissionOverlay: React.FC<CoworkPermissionOverlayProps> = ({ inlineSessionId }) => {
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null);
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const permission = useMemo(
    () => pendingPermissions.find((entry) => {
      if (entry.sessionId !== inlineSessionId) return true;
      // The open session is assumed to answer inline — but A2A conversations
      // have no inline permission seat, so the overlay must keep covering
      // their prompts instead of hiding them. The A2A check reads the
      // sessions list first and falls back to the loaded currentSession:
      // during list-reload gaps the open A2A chat can be missing from
      // `sessions`, and skipping its prompt then would leave it with NO
      // render seat anywhere (invisible-dialog defect class).
      const entrySessionType = sessionsById.get(entry.sessionId)?.sessionType
        ?? (currentSession && currentSession.id === entry.sessionId
          ? currentSession.sessionType
          : undefined);
      return entrySessionType === 'a2a';
    }) ?? null,
    [pendingPermissions, inlineSessionId, sessionsById, currentSession],
  );
  const sessionTitle = useMemo(() => {
    if (!permission) return null;
    return sessionsById.get(permission.sessionId)?.title ?? null;
  }, [permission, sessionsById]);

  const summary = useMemo(() => {
    if (!permission) return '';
    if (permission.toolName !== 'AskUserQuestion') {
      // "Bash" alone tells the owner nothing — show what actually runs.
      const inputSummary = summarizeToolInput(permission.toolName, permission.toolInput ?? {});
      return inputSummary ? `${permission.toolName}: ${inputSummary}` : permission.toolName;
    }
    const questions = permission.toolInput?.questions;
    if (!Array.isArray(questions)) return permission.toolName;
    const first = questions.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).question === 'string');
    return first ? String((first as Record<string, unknown>).question) : permission.toolName;
  }, [permission]);

  const isSafetyApproval = useMemo(
    () => (permission ? parseSafetyContext(permission) !== null && parseQuestions(permission).length > 0 : false),
    [permission],
  );

  /**
   * Owner-gated friend action card (S5 invite/remove via
   * requestSuspendedApproval): the S6 final verification found no CLEARLY
   * visible deny entry on this card, leaving the reject branch untestable on
   * the real device. These cards render the question's own header
   * (「好友确认」/「Friend confirmation」) as the title and an unmistakable
   * side-by-side 允许/拒绝 pair — the deny arm carries explicit red styling
   * instead of the subtle secondary outline used by generic prompts.
   */
  const friendActionContext = useMemo(() => {
    if (!permission || permission.toolName !== 'AskUserQuestion') return null;
    const context = permission.toolInput?.context as Record<string, unknown> | undefined;
    const action = context?.action;
    return action === 'invite' || action === 'remove' ? action : null;
  }, [permission]);

  const friendCardTitle = useMemo(() => {
    if (!friendActionContext || !permission) return null;
    const questions = parseQuestions(permission);
    return questions[0]?.header?.trim() || null;
  }, [friendActionContext, permission]);

  const handleOpenSession = useCallback(() => {
    if (!permission) return;
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: permission.sessionId } }));
  }, [permission]);

  const handleRespond = useCallback((result: CoworkPermissionResult) => {
    if (!permission || respondingRequestId) return;
    setRespondingRequestId(permission.requestId);
    void coworkService.respondToPermission(permission.requestId, result).finally(() => {
      setRespondingRequestId((current) => (current === permission.requestId ? null : current));
    });
  }, [permission, respondingRequestId]);

  if (!permission) return null;
  const responding = respondingRequestId === permission.requestId;

  return (
    <div
      className="fixed right-4 top-14 z-[90] w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-claude-border bg-claude-surface shadow-elevated animate-slide-up dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      data-cowork-permission-overlay="true"
    >
      <div className="flex items-start gap-3 p-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          <ExclamationTriangleIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-claude-text dark:text-claude-darkText">
            {friendCardTitle ?? i18nService.t('coworkGlobalPermissionTitle')}
          </p>
          {sessionTitle && <p className="mt-0.5 truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">{sessionTitle}</p>}
          <p className="mt-1 line-clamp-2 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">{summary}</p>
        </div>
        <button
          type="button"
          onClick={handleOpenSession}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-claude-accent transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
        >
          {i18nService.t('coworkGlobalPermissionOpenSession')}
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div
        className="flex items-center justify-end gap-2 border-t border-claude-border/70 px-3 py-2.5 dark:border-claude-darkBorder/70"
        data-friend-action-card={friendActionContext ?? undefined}
      >
        <button
          type="button"
          disabled={responding}
          onClick={() => handleRespond({ behavior: 'deny', message: 'Permission denied' })}
          className={
            friendActionContext
              ? 'rounded-lg border border-red-300 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:border-red-400 hover:bg-red-100 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40 dark:hover:text-red-200'
              : 'rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-red-900/20 dark:hover:text-red-300'
          }
        >
          {i18nService.t('coworkDeny')}
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => handleRespond(buildAllowResult(permission))}
          className={`rounded-lg ${friendActionContext ? 'px-4 py-1.5 text-xs font-semibold' : 'px-3 py-1.5 text-xs font-medium'} transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            isSafetyApproval
              ? 'border border-red-700 bg-red-600 text-white hover:bg-red-700'
              : 'btn-idchat-primary-filled'
          }`}
        >
          {responding
            ? i18nService.t('processing')
            : isSafetyApproval
              ? i18nService.t('coworkApprovalAllowDelete')
              : i18nService.t('coworkApprovalAllowOnce')}
        </button>
      </div>
    </div>
  );
};

export default CoworkPermissionOverlay;
