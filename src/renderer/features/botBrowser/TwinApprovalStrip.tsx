import React, { useCallback, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  ArrowRightIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import type { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import type { CoworkPermissionRequest } from '../../types/cowork';
import { buildAllowResult } from '../../components/cowork/CoworkPermissionOverlay';
import {
  parseQuestions,
  parseSafetyContext,
  summarizeToolInput,
} from '../../components/cowork/CoworkPermissionPanel';
import {
  PermissionCountdownLabel,
  usePermissionCountdown,
} from '../../components/cowork/permissionCountdown';

type TwinApprovalRiskKind = 'delete' | 'money' | 'publish' | 'normal';

/**
 * Advisory risk bucket for the strip's tag. Heuristic over the tool name and
 * its payload text — the authoritative safety gate is (and stays) the host's
 * own confirmation watchdog; the tag only helps the owner triage at a glance.
 */
const RISK_PATTERNS: Array<{ kind: TwinApprovalRiskKind; pattern: RegExp }> = [
  { kind: 'delete', pattern: /\brm\s|\brm\b|\bunlink\b|\brimraf\b|\bdelete\b/i },
  { kind: 'money', pattern: /\bwallet\b|\btransfer\b|\bpay(ment)?\b|\bescrow\b|\bbuy\b|\bsell\b|\bspace\b/i },
  { kind: 'publish', pattern: /\bbuzz\b|\bpublish\b|\bsimplenote\b|\bsimplebuzz\b/i },
];

const riskKindOf = (permission: CoworkPermissionRequest): TwinApprovalRiskKind => {
  const haystack = `${permission.toolName} ${JSON.stringify(permission.toolInput ?? {})}`;
  for (const entry of RISK_PATTERNS) {
    if (entry.pattern.test(haystack)) return entry.kind;
  }
  return 'normal';
};

const riskLabelOf = (kind: TwinApprovalRiskKind): string => {
  const key = kind === 'delete'
    ? 'twinApprovalRiskDelete'
    : kind === 'money'
      ? 'twinApprovalRiskMoney'
      : kind === 'publish'
        ? 'twinApprovalRiskPublish'
        : 'twinApprovalRiskNormal';
  return i18nService.t(key);
};

const TwinApprovalCard: React.FC<{
  permission: CoworkPermissionRequest;
  sessionTitle: string | null;
}> = ({ permission, sessionTitle }) => {
  const [expanded, setExpanded] = useState(false);
  const [responding, setResponding] = useState(false);
  const seconds = usePermissionCountdown(permission.expiresAt);
  const riskKind = useMemo(() => riskKindOf(permission), [permission]);
  const isSafetyApproval = useMemo(
    () => parseSafetyContext(permission) !== null && parseQuestions(permission).length > 0,
    [permission],
  );
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
  const detail = useMemo(() => {
    const full = JSON.stringify(permission.toolInput ?? {}, null, 2);
    return full.length > 800 ? `${full.slice(0, 800)}\n…` : full;
  }, [permission]);

  const handleRespond = useCallback((result: Parameters<typeof coworkService.respondToPermission>[1]) => {
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
      className="overflow-hidden rounded-xl border border-claude-border bg-claude-surface dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      data-twin-approval-card={permission.requestId}
      data-twin-approval-risk={riskKind}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
          <ExclamationTriangleIcon className="h-4 w-4" />
        </div>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-claude-text dark:text-claude-darkText">
            {sessionTitle ?? i18nService.t('coworkGlobalPermissionTitle')}
          </span>
          <span className="mt-0.5 block truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {summary}
          </span>
        </span>
        <span className="shrink-0 rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] font-semibold text-red-600 dark:text-red-400">
          {riskLabelOf(riskKind)}
        </span>
        {expanded
          ? <ChevronDownIcon className="h-4 w-4 shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
          : <ChevronRightIcon className="h-4 w-4 shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary" />}
      </button>
      {expanded && (
        <div className="border-t border-claude-border/70 px-3 pb-2 pt-2 dark:border-claude-darkBorder/70">
          <p className="text-[11px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('twinApprovalDetails')}
          </p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-claude-bg px-2.5 py-2 font-mono text-[11px] leading-relaxed text-claude-text dark:bg-claude-darkBg dark:text-claude-darkText">
            {detail}
          </pre>
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-claude-border/70 px-3 py-2 dark:border-claude-darkBorder/70">
        <button
          type="button"
          disabled={responding}
          onClick={() => handleRespond({ behavior: 'deny', message: 'Permission denied' })}
          className="rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-textSecondary transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-red-900/20 dark:hover:text-red-300"
        >
          <PermissionCountdownLabel label={i18nService.t('coworkDeny')} seconds={countdownFor('deny')} />
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => handleRespond(buildAllowResult(permission))}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
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
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: permission.sessionId } }))}
          className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-claude-accent transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
        >
          {i18nService.t('twinApprovalOpenSite')}
          <ArrowRightIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

/**
 * The office-face seat for cowork permission prompts (owner ruling
 * 2026-11-10: anything that needs the owner's ruling is brought INTO the
 * office — BotWorks stays the workshop one visits proactively, never the
 * place a problem drags the owner to). Rendered at the top of the Bot
 * Browser pane; while it is mounted the global corner overlay stands down
 * (App suppresses it by pane visibility) so each prompt has exactly ONE
 * visible seat.
 *
 * Read-only over the SAME global pendingPermissions the corner overlay
 * seats; the respond path is the overlay's own (buildAllowResult +
 * coworkService.respondToPermission) and the countdown is the overlay's
 * hook — this strip runs no watchdog timer of its own.
 */
const TwinApprovalStrip: React.FC = () => {
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );

  if (pendingPermissions.length === 0) return null;

  return (
    <div
      className="shrink-0 border-b border-claude-border/70 bg-claude-surfaceMuted px-3 py-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkSurfaceMuted"
      data-twin-approval-strip="true"
    >
      <p className="mb-1.5 flex items-center gap-1.5 px-0.5 text-xs font-semibold text-claude-textSecondary dark:text-claude-darkTextSecondary">
        <ExclamationTriangleIcon className="h-3.5 w-3.5 text-yellow-600 dark:text-yellow-400" />
        {i18nService.t('twinApprovalStripTitle')}
        <span className="rounded-full bg-yellow-500/15 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-yellow-700 dark:text-yellow-400">
          {i18nService.t('twinApprovalStripCount').replace('{count}', String(pendingPermissions.length))}
        </span>
      </p>
      <div className="flex flex-col gap-2">
        {pendingPermissions.map((permission) => (
          <TwinApprovalCard
            key={permission.requestId}
            permission={permission}
            sessionTitle={sessionsById.get(permission.sessionId)?.title ?? null}
          />
        ))}
      </div>
    </div>
  );
};

export default TwinApprovalStrip;
