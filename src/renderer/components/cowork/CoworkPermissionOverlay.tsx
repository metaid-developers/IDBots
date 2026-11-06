import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkPermissionRequest, CoworkPermissionResult, CoworkSessionSummary } from '../../types/cowork';
import { parseQuestions, parseSafetyContext, summarizeToolInput } from './CoworkPermissionPanel';
import { PermissionCountdownLabel, usePermissionCountdown } from './permissionCountdown';
import { a2aApprovalOf, packPermissionColumns } from './permissionPromptLayout';
import { ArrowRightIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface CoworkPermissionOverlayProps {
  /**
   * Session whose permission prompt is already rendered inline by
   * CoworkSessionDetail (the open chat), or null when no inline seat is
   * mounted. Prompts for any OTHER session surface in this overlay. A2A
   * sensitive owner approvals are seated at the bottom of that conversation,
   * so they leave the overlay while that chat is open. Other A2A prompts keep
   * surfacing here because the A2A view has no composer takeover.
   */
  inlineSessionId: string | null;
}

const OVERLAY_TOP_PX = 56;
const OVERLAY_BOTTOM_PX = 16;

/**
 * Build the allow-answer for one-click approval, mirroring the inline
 * panel's response semantics: safety approvals answer the confirmation
 * question with its first (allow) option; plain question wizards answer
 * every question with its first option.
 */
export const buildAllowResult = (permission: CoworkPermissionRequest): CoworkPermissionResult => {
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

const sessionTypeOf = (
  sessionId: string,
  sessionsById: Map<string, CoworkSessionSummary>,
  currentSession: { id: string; sessionType?: string } | null,
): string | undefined => (
  sessionsById.get(sessionId)?.sessionType
  ?? (currentSession && currentSession.id === sessionId ? currentSession.sessionType : undefined)
);

/**
 * Prompts that already have a seat in the open view stay out of the corner.
 * The open non-A2A chat's composer takes the first prompt for that session.
 * An open A2A chat takes its sensitive owner approvals at the bottom of the
 * transcript. Anything else stays here, including later prompts for the open chat.
 */
export const permissionsForOverlay = (
  pendingPermissions: CoworkPermissionRequest[],
  inlineSessionId: string | null,
  sessionsById: Map<string, CoworkSessionSummary>,
  currentSession: { id: string; sessionType?: string } | null,
): CoworkPermissionRequest[] => {
  const inlineType = inlineSessionId
    ? sessionTypeOf(inlineSessionId, sessionsById, currentSession)
    : undefined;
  let composerTaken = false;
  const visible: CoworkPermissionRequest[] = [];
  for (const entry of pendingPermissions) {
    if (entry.sessionId === inlineSessionId && inlineType === 'a2a' && a2aApprovalOf(entry)) {
      continue;
    }
    // Unknown session type is treated as a normal chat: the composer owns the
    // first prompt. A2A is recognized from the session list or currentSession.
    if (entry.sessionId === inlineSessionId && inlineType !== 'a2a' && !composerTaken) {
      composerTaken = true;
      continue;
    }
    visible.push(entry);
  }
  return visible;
};

const PermissionOverlayCard: React.FC<{
  permission: CoworkPermissionRequest;
  sessionTitle: string | null;
  registerCard: (requestId: string, node: HTMLDivElement | null) => void;
}> = ({ permission, sessionTitle, registerCard }) => {
  const [responding, setResponding] = useState(false);
  const seconds = usePermissionCountdown(permission.expiresAt);
  const summary = useMemo(() => {
    if (permission.toolName !== 'AskUserQuestion') {
      const inputSummary = summarizeToolInput(permission.toolName, permission.toolInput ?? {});
      return inputSummary ? `${permission.toolName}: ${inputSummary}` : permission.toolName;
    }
    const questions = permission.toolInput?.questions;
    if (!Array.isArray(questions)) return permission.toolName;
    const first = questions.find((item) => item && typeof item === 'object' && typeof (item as Record<string, unknown>).question === 'string');
    return first ? String((first as Record<string, unknown>).question) : permission.toolName;
  }, [permission]);
  const isSafetyApproval = useMemo(
    () => parseSafetyContext(permission) !== null && parseQuestions(permission).length > 0,
    [permission],
  );
  const a2aApproval = a2aApprovalOf(permission);
  const friendAction = a2aApproval?.friendAction ?? null;
  const a2aCardTitle = useMemo(() => {
    if (!a2aApproval) return null;
    return parseQuestions(permission)[0]?.header?.trim() || i18nService.t('a2aApprovalRequestTitle');
  }, [a2aApproval, permission]);

  const handleOpenSession = useCallback(() => {
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: permission.sessionId } }));
  }, [permission.sessionId]);

  const handleRespond = useCallback((result: CoworkPermissionResult) => {
    if (responding) return;
    setResponding(true);
    void coworkService.respondToPermission(permission.requestId, result).finally(() => {
      setResponding(false);
    });
  }, [permission.requestId, responding]);

  const countdownFor = (action: 'allow' | 'deny'): number | null => (
    permission.timeoutDefault === action ? seconds : null
  );

  return (
    <div
      ref={(node) => registerCard(permission.requestId, node)}
      className="pointer-events-auto w-[min(24rem,calc(100vw-2rem))] shrink-0 overflow-hidden rounded-xl border border-claude-border bg-claude-surface shadow-elevated animate-slide-up dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      data-cowork-permission-card={permission.requestId}
    >
      <div className="flex items-start gap-3 p-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          <ExclamationTriangleIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-claude-text dark:text-claude-darkText">
            {a2aCardTitle ?? i18nService.t('coworkGlobalPermissionTitle')}
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
        data-a2a-approval-card={a2aApproval?.category}
        data-friend-action-card={friendAction ?? undefined}
      >
        <button
          type="button"
          disabled={responding}
          onClick={() => handleRespond({ behavior: 'deny', message: 'Permission denied' })}
          className={
            a2aApproval
              ? 'rounded-lg border border-red-300 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:border-red-400 hover:bg-red-100 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40 dark:hover:text-red-200'
              : 'rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-red-900/20 dark:hover:text-red-300'
          }
        >
          <PermissionCountdownLabel label={i18nService.t('coworkDeny')} seconds={countdownFor('deny')} />
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => handleRespond(buildAllowResult(permission))}
          className={`rounded-lg ${a2aApproval ? 'px-4 py-1.5 text-xs font-semibold' : 'px-3 py-1.5 text-xs font-medium'} transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            isSafetyApproval
              ? 'border border-red-700 bg-red-600 text-white hover:bg-red-700'
              : 'btn-idchat-primary-filled'
          }`}
        >
          <PermissionCountdownLabel
            label={responding
              ? i18nService.t('processing')
              : isSafetyApproval
                ? i18nService.t('coworkApprovalAllowDelete')
                : i18nService.t('coworkApprovalAllowOnce')}
            seconds={responding ? null : countdownFor('allow')}
          />
        </button>
      </div>
    </div>
  );
};

/**
 * Global fallback seat for cowork permission prompts that are not already
 * drawn in the open chat. Cards stack top to bottom in the rightmost column
 * and open a new column to the left when the column is full. Each timed card
 * shows the remaining seconds on the button the watchdog will press.
 */
const CoworkPermissionOverlay: React.FC<CoworkPermissionOverlayProps> = ({ inlineSessionId }) => {
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const cardNodes = useRef(new Map<string, HTMLDivElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [viewportHeight, setViewportHeight] = useState(() => (
    typeof window === 'undefined' ? 900 : window.innerHeight
  ));
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const permissions = useMemo(
    () => permissionsForOverlay(pendingPermissions, inlineSessionId, sessionsById, currentSession),
    [pendingPermissions, inlineSessionId, sessionsById, currentSession],
  );
  const heightMap = useMemo(() => new Map(Object.entries(heights)), [heights]);
  const availableHeight = Math.max(120, viewportHeight - OVERLAY_TOP_PX - OVERLAY_BOTTOM_PX);
  const columns = useMemo(
    () => packPermissionColumns(permissions, heightMap, availableHeight),
    [permissions, heightMap, availableHeight],
  );

  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let changed = false;
    for (const permission of permissions) {
      const node = cardNodes.current.get(permission.requestId);
      const height = node?.offsetHeight ?? 0;
      if (height <= 0) continue;
      next[permission.requestId] = height;
      if (heights[permission.requestId] !== height) changed = true;
    }
    if (changed || Object.keys(heights).length !== Object.keys(next).length) {
      setHeights(next);
    }
  }, [permissions, heights, columns.length]);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  if (permissions.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 top-14 z-[90] flex flex-row-reverse items-start gap-3"
      data-cowork-permission-overlay="true"
    >
      {columns.map((column) => (
        <div key={column[0]?.requestId ?? 'column'} className="flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3">
          {column.map((permission) => (
            <PermissionOverlayCard
              key={permission.requestId}
              permission={permission}
              sessionTitle={sessionsById.get(permission.sessionId)?.title ?? null}
              registerCard={(requestId, node) => {
                if (node) cardNodes.current.set(requestId, node);
                else cardNodes.current.delete(requestId);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
};

export default CoworkPermissionOverlay;
