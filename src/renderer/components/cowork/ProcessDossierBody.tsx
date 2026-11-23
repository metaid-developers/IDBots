/**
 * 进程详情 · 档案层 (design: process-detail-body-redesign, Friday 2026-11-22,
 * owner ruling 1A / 2A / 3A / 4A).
 *
 * Four blocks in FIXED positions — 目标 / 验收清单 / 执行轮次 / 交付物与证据 —
 * so the answers never drift with the message count. Pure display: the data
 * (and every degradation) arrives through `view` from `useProcessDossier`.
 *
 * Values are copied from the draft's §07 inventory, not invented:
 *   块 p15 · r10 · 1px · mb11.25 / 眉标 11·600·uppercase / 摘要 10·600·tabular
 *   清单行 32 · 勾选框 15×15·r4 / 状态词 11 / 锚计数 10·mono·r3.75·#2A5586
 *   时间列 52 / 脊柱 1px / 圆点 7.5×7.5 / 判定签 11·r3.75
 *   类签 40·9.5·mono / 证据名 12.5·500 / 副行 10.5 / 双键 22×22·r8
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { PROCESS_STATE_DOT_COLOR } from '../../utils/processCenter';
import {
  DOSSIER_ACTOR_LABEL_KEY,
  DOSSIER_CHANNEL_LABEL_KEY,
  DOSSIER_CHECK_LABEL_KEY,
  DOSSIER_ROUND_VERDICT_LABEL_KEY,
  foldRoundProgress,
  formatDossierStamp,
  workerIdOfActor,
  type DossierAnchorRow,
  type DossierCheckRow,
  type DossierCheckState,
  type DossierRound,
  type DossierRoundVerdict,
} from '../../utils/processDossier';
import type { ProcessDossierView, PinLookupState } from './useProcessDossier';

const t = (key: string): string => i18nService.t(key);

// Design §2.1 — six states, zero new colour values (the three dot colours are
// the hub's own; yellow is the 待你拍板 strip's group).
const CHECK_VISUAL: Record<DossierCheckState, {
  box: React.CSSProperties;
  mark: string;
  word: React.CSSProperties;
  strike?: boolean;
}> = {
  passed: {
    box: { backgroundColor: PROCESS_STATE_DOT_COLOR.live, borderColor: PROCESS_STATE_DOT_COLOR.live, color: '#fff' },
    mark: '✓',
    word: { color: PROCESS_STATE_DOT_COLOR.live, fontWeight: 600 },
  },
  awaiting: {
    box: { borderColor: PROCESS_STATE_DOT_COLOR.pending, backgroundColor: '#fffbe8', color: '#7a5f14' },
    mark: '',
    word: { color: '#7a5f14', fontWeight: 600 },
  },
  unverified: {
    box: { borderColor: '#bfc2cc' },
    mark: '',
    word: {},
  },
  rejected: {
    box: { backgroundColor: PROCESS_STATE_DOT_COLOR.error, borderColor: PROCESS_STATE_DOT_COLOR.error, color: '#fff' },
    mark: '×',
    word: { color: PROCESS_STATE_DOT_COLOR.error, fontWeight: 600 },
  },
  skipped: {
    box: { borderColor: PROCESS_STATE_DOT_COLOR.dead, borderStyle: 'dashed' },
    mark: '–',
    word: {},
    strike: true,
  },
  external: {
    box: { borderColor: '#64748b' },
    mark: '',
    word: {},
  },
};

const ROUND_DOT: Record<DossierRoundVerdict, React.CSSProperties> = {
  accepted: { backgroundColor: PROCESS_STATE_DOT_COLOR.live, borderColor: PROCESS_STATE_DOT_COLOR.live },
  rejected: { backgroundColor: PROCESS_STATE_DOT_COLOR.error, borderColor: PROCESS_STATE_DOT_COLOR.error },
  submitted: { backgroundColor: PROCESS_STATE_DOT_COLOR.pending, borderColor: PROCESS_STATE_DOT_COLOR.pending },
  running: { backgroundColor: PROCESS_STATE_DOT_COLOR.live, borderColor: PROCESS_STATE_DOT_COLOR.live, boxShadow: '0 0 0 3px rgba(34,160,107,.15)' },
  skipped: { backgroundColor: PROCESS_STATE_DOT_COLOR.dead, borderColor: PROCESS_STATE_DOT_COLOR.dead },
};

const ROUND_TAG: Record<DossierRoundVerdict, React.CSSProperties> = {
  accepted: { color: '#22a06b', borderColor: 'rgba(34,160,107,.45)', backgroundColor: 'rgba(34,160,107,.08)', fontWeight: 600 },
  rejected: { color: '#e5484d', borderColor: 'rgba(229,72,77,.4)', backgroundColor: 'rgba(229,72,77,.06)', fontWeight: 600 },
  submitted: { color: '#7a5f14', borderColor: '#e6c93e', backgroundColor: '#fffbe8', fontWeight: 600 },
  running: { color: '#22a06b', borderColor: 'rgba(34,160,107,.35)', fontWeight: 600 },
  skipped: {},
};

const ANCHOR_TAG: Record<DossierAnchorRow['cls'], React.CSSProperties> = {
  PIN: { color: '#2a5586', borderColor: '#bbd0e8', backgroundColor: '#f2f7fc' },
  DIR: { color: '#6b5a18', borderColor: '#e6c93e', backgroundColor: '#fffbe8' },
  URL: {},
  APP: { color: '#2a5586', borderColor: '#bbd0e8', backgroundColor: '#f2f7fc' },
  FILE: {},
  OTHER: {},
};

const CARD_CLASS = 'rounded-[var(--shape-radius-md)] border border-claude-border bg-claude-surface p-[15px] mb-[11.25px] dark:border-claude-darkBorder dark:bg-claude-darkSurface';
const EYEBROW_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.06em] text-claude-textSecondary dark:text-claude-darkTextSecondary';
const SUMMARY_CLASS = 'ml-auto text-[10px] font-semibold tabular-nums text-claude-textSecondary dark:text-claude-darkTextSecondary';

const Block: React.FC<{
  testId: string;
  eyebrow: string;
  summary?: React.ReactNode;
  children: React.ReactNode;
}> = ({ testId, eyebrow, summary, children }) => (
  <section data-testid={testId} className={CARD_CLASS}>
    <header className="mb-[9.375px] flex items-baseline gap-[7.5px]">
      <span className={EYEBROW_CLASS}>{eyebrow}</span>
      {summary != null && <span className={SUMMARY_CLASS} data-slot="dossier-block-summary">{summary}</span>}
    </header>
    {children}
  </section>
);

const EmptyLine: React.FC<{ text: string }> = ({ text }) => (
  <p className="text-[11.5px] leading-[1.5] text-claude-textSecondary dark:text-claude-darkTextSecondary">{text}</p>
);

// ── 1. 目标 ────────────────────────────────────────────────────────────────

const GoalBlock: React.FC<{ view: ProcessDossierView }> = ({ view }) => {
  const { task, subtask } = view;
  if (!task) return null;
  const facts: Array<{ label: string; value: string }> = [];
  const channel = subtask?.preferredChannel ?? null;
  if (channel && DOSSIER_CHANNEL_LABEL_KEY[channel]) {
    facts.push({ label: t('processDossierFactChannel'), value: t(DOSSIER_CHANNEL_LABEL_KEY[channel]) });
  }
  if (task.originChannel) {
    facts.push({ label: t('processDossierFactDispatch'), value: String(task.originChannel) });
  }
  if (subtask?.expectedMinutes) {
    facts.push({
      label: t('processDossierFactExpected'),
      value: t('processDossierExpectedMinutes').replace('{count}', String(subtask.expectedMinutes)),
    });
  }
  if (subtask) {
    facts.push({
      label: t('processDossierFactCurrent'),
      value: t(`longTermTask.status.${subtaskStatusKeyOf(subtask.status)}`),
    });
  }
  return (
    <Block
      testId="process-dossier-goal"
      eyebrow={t('processDossierGoal')}
      summary={task.progress ? `${task.progress.accepted}/${task.progress.total}` : undefined}
    >
      <p className="line-clamp-2 text-[13.125px] leading-[1.62] text-claude-text dark:text-claude-darkText" title={task.goal}>
        {task.goal}
      </p>
      {facts.length > 0 && (
        <div className="mt-[9.375px] flex flex-wrap gap-[11.25px] text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {facts.map((fact) => (
            <span key={fact.label}>
              {fact.label} <b className="font-semibold text-claude-text dark:text-claude-darkText">{fact.value}</b>
            </span>
          ))}
        </div>
      )}
    </Block>
  );
};

/** Stored subtask status → the shared `longTermTask.status.*` key suffix. */
const subtaskStatusKeyOf = (status: string): string => {
  switch (status) {
    case 'in_progress': return 'inProgress';
    case 'waiting_owner': return 'waitingOwner';
    case 'waiting_external': return 'waitingExternal';
    case 'accepted': return 'accepted';
    case 'rejected': return 'rejected';
    case 'skipped': return 'skipped';
    default: return 'pending';
  }
};

// ── 2. 验收清单 ────────────────────────────────────────────────────────────

const ChecklistRow: React.FC<{ row: DossierCheckRow; showInferenceMark: boolean }> = ({ row, showInferenceMark }) => {
  const visual = CHECK_VISUAL[row.state];
  return (
    <div
      data-testid="process-dossier-check-row"
      data-check-state={row.state}
      className="flex min-h-[32px] items-center gap-[7.5px] border-t border-claude-border/60 py-[5.625px] first:border-t-0 dark:border-claude-darkBorder/60"
      style={row.state === 'awaiting' ? { backgroundColor: '#fffdf6' } : undefined}
    >
      {row.state === 'awaiting' && (
        <span aria-hidden className="w-[3px] shrink-0 self-stretch rounded-[2px]" style={{ backgroundColor: '#e6c93e' }} />
      )}
      <span
        aria-hidden
        className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border text-[10px] leading-none"
        style={{ ...visual.box, borderWidth: 1 }}
      >
        {visual.mark}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-[12px] leading-[1.45] ${visual.strike ? 'line-through' : ''} dark:text-claude-darkText text-claude-text`}
        title={row.text}
      >
        {row.text}
      </span>
      {row.anchors > 0 && (
        <span
          className="shrink-0 rounded-[3.75px] border px-1 py-0.5 font-mono text-[10px] font-semibold leading-none"
          style={{ color: '#2a5586', backgroundColor: '#f2f7fc', borderColor: '#bbd0e8' }}
          title={t('processDossierAnchorCountTitle').replace('{count}', String(row.anchors))}
        >
          {row.anchors}
        </span>
      )}
      {showInferenceMark && row.inferred && (
        <span
          data-testid="process-dossier-inferred"
          className="shrink-0 rounded-[3.75px] border border-dashed px-1 py-0.5 font-mono text-[10px] font-semibold leading-none"
          style={{ color: '#c2872a', borderColor: 'rgba(194,135,42,.55)' }}
          title={t('processDossierInferredTitle')}
        >
          ≈
        </span>
      )}
      <span className="shrink-0 text-[11px]" style={visual.word}>
        {t(DOSSIER_CHECK_LABEL_KEY[row.state])}
      </span>
    </div>
  );
};

const ChecklistBlock: React.FC<{ view: ProcessDossierView }> = ({ view }) => {
  const { checks, subtask } = view;
  return (
    <Block
      testId="process-dossier-checklist"
      eyebrow={t('processDossierChecklist')}
      summary={checks.total > 0 ? `${checks.passed}/${checks.total} ${t('processDossierPassedShort')}` : undefined}
    >
      {!subtask ? (
        <EmptyLine text={t('processDossierNoSubtask')} />
      ) : checks.rows.length === 0 ? (
        <EmptyLine text={t('processDossierNoChecklist')} />
      ) : (
        <div>
          {checks.rows.map((row) => (
            <ChecklistRow key={row.index} row={row} showInferenceMark={checks.inferred} />
          ))}
        </div>
      )}
    </Block>
  );
};

// ── 3. 执行轮次 ────────────────────────────────────────────────────────────

const ActorName: React.FC<{ actor: string; participantNames: ReadonlyMap<number, string> }> = ({ actor, participantNames }) => {
  const workerId = workerIdOfActor(actor);
  // `shrink-0`: the name must never be squeezed by a long `what`. Without it the
  // flex algorithm hands the shrinkage to the small item and a 4-char name
  // wraps into 4 lines (measured: a 69.6px l1 instead of 17.4px).
  if (workerId != null) {
    return <span className="shrink-0 font-semibold">{participantNames.get(workerId) ?? `#${workerId}`}</span>;
  }
  const key = DOSSIER_ACTOR_LABEL_KEY[actor];
  return <span className="shrink-0 font-semibold">{key ? t(key) : actor}</span>;
};

const RoundRow: React.FC<{
  round: DossierRound;
  participantNames: ReadonlyMap<number, string>;
}> = ({ round, participantNames }) => {
  const stamp = formatDossierStamp(round.startedAt);
  const folded = foldRoundProgress(round.progress);
  const channelLabel = round.channel && DOSSIER_CHANNEL_LABEL_KEY[round.channel]
    ? t(DOSSIER_CHANNEL_LABEL_KEY[round.channel])
    : round.channel;
  // Two lines, exactly like the draft (design §04): l1 = who + what, l2 = ONE
  // line of chips (channel · event kind · folded-progress note · sub-project).
  // Progress never stacks into a paragraph — that is what made the old event
  // list unreadable, and it would break the 32/48 row-height equation.
  return (
    <div
      data-testid="process-dossier-round"
      data-round-verdict={round.verdict}
      className="grid min-h-[32px] grid-cols-[52px_11.25px_1fr_auto] items-start gap-x-[7.5px] py-[5.625px]"
    >
      <div className="pt-px text-right tabular-nums">
        <b className="block text-[11px] font-semibold leading-[1.35] text-claude-text dark:text-claude-darkText">{stamp?.date ?? ''}</b>
        <span className="block text-[10px] leading-[1.35] text-claude-textSecondary dark:text-claude-darkTextSecondary">{stamp?.time ?? ''}</span>
      </div>
      <div className="relative flex justify-center self-stretch">
        <span aria-hidden className="absolute bottom-0 top-0 w-px bg-claude-border dark:bg-claude-darkBorder" />
        <span
          aria-hidden
          className="relative z-[1] mt-1 h-[7.5px] w-[7.5px] rounded-full border-[1.5px]"
          style={ROUND_DOT[round.verdict]}
        />
      </div>
      <div className="min-w-0 pt-px">
        <div className="flex min-w-0 items-center gap-[5px] text-[12px] leading-[1.45]">
          <ActorName actor={round.actor} participantNames={participantNames} />
          <span className="min-w-0 truncate text-claude-text dark:text-claude-darkText" title={round.what}>{round.what}</span>
        </div>
        <div className="mt-[1.875px] flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap text-[11.25px] leading-[1.45] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {channelLabel && <span className="shrink-0">{channelLabel}</span>}
          <span
            className="shrink-0 rounded-[3.75px] border px-1 py-0.5 font-mono text-[10px] font-semibold leading-none"
            style={{ color: '#2a5586', backgroundColor: '#f2f7fc', borderColor: '#bbd0e8' }}
          >
            {round.kind}
          </span>
          {folded.folded > 0 && (
            <span className="shrink-0 border-b border-dashed border-claude-border text-[10px] dark:border-claude-darkBorder">
              {t('processDossierFoldProgress').replace('{count}', String(folded.folded))}
            </span>
          )}
          {round.subtaskTitle && <span className="min-w-0 truncate">{round.subtaskTitle}</span>}
        </div>
      </div>
      <span
        className="shrink-0 self-center whitespace-nowrap rounded-[3.75px] border px-[5.625px] py-[1.875px] text-[11px] leading-[1.35] text-claude-textSecondary dark:text-claude-darkTextSecondary"
        style={ROUND_TAG[round.verdict]}
      >
        {t(DOSSIER_ROUND_VERDICT_LABEL_KEY[round.verdict])}
      </span>
    </div>
  );
};

const RoundsBlock: React.FC<{ view: ProcessDossierView }> = ({ view }) => {
  const participantNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const participant of view.task?.participants ?? []) map.set(participant.id, participant.name);
    return map;
  }, [view.task]);
  return (
    <Block
      testId="process-dossier-rounds"
      eyebrow={t('processDossierRounds')}
      summary={view.rounds.length > 0 ? String(view.rounds.length) : undefined}
    >
      {view.rounds.length === 0 ? (
        <EmptyLine text={t('processDossierNoRounds')} />
      ) : (
        <div>
          {view.rounds.map((round) => (
            <RoundRow key={round.key} round={round} participantNames={participantNames} />
          ))}
        </div>
      )}
      {view.eventsCapped && (
        <p className="mt-[7.5px] text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {t('processDossierEventsCapped')}
        </p>
      )}
    </Block>
  );
};

// ── 4. 交付物与证据锚 ──────────────────────────────────────────────────────

const openAnchor = (uri: string): void => {
  if (/^(pin|metaapp|metafile):\/\//.test(uri) || /^https?:\/\//.test(uri)) {
    window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri } }));
  }
};

const AnchorRow: React.FC<{
  row: DossierAnchorRow;
  lookup: PinLookupState | undefined;
  copied: boolean;
  onCopy: (row: DossierAnchorRow) => void;
}> = ({ row, lookup, copied, onCopy }) => {
  const named = lookup?.status === 'named' ? lookup.info : null;
  const unreachable = lookup?.status === 'unreachable';
  // A named pin speaks its own title (design §2.3 已点名 = 标题＋作者＋时间＋协议);
  // the id/basename fallback only stands when the pin cannot be named.
  const displayLabel = !row.hasLabel && named?.title ? named.title : row.label;
  // The clipboard gets the FULL id — the visible label may truncate, the copy
  // may not (design §2.3 复制纪律). onCopy recomputes the value from the row.
  const openable = Boolean(row.pinId) || /^https?:\/\//.test(row.uri);
  const stamp = named ? formatDossierStamp(new Date(named.createdAt * 1000).toISOString()) : null;
  return (
    <div
      data-testid="process-dossier-anchor"
      data-anchor-class={row.cls}
      data-anchor-named={named ? 'named' : unreachable ? 'unreachable' : 'unnamed'}
      className={`flex min-h-[32px] items-center gap-[7.5px] border-t border-claude-border/60 py-[5.625px] first:border-t-0 dark:border-claude-darkBorder/60 ${unreachable ? 'opacity-60' : ''}`}
    >
      <span
        aria-hidden
        className="w-[40px] shrink-0 rounded-[3.75px] border py-[3px] text-center font-mono text-[9.5px] font-semibold tracking-[0.04em] text-claude-textSecondary dark:text-claude-darkTextSecondary"
        style={ANCHOR_TAG[row.cls]}
      >
        {row.cls}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium leading-[1.45] text-claude-text dark:text-claude-darkText" title={displayLabel}>
          {displayLabel}
          {!named && row.pinId && (
            <span className="ml-1 text-[11px] font-normal text-claude-textSecondary dark:text-claude-darkTextSecondary">
              · {t(unreachable ? 'processDossierUnreachable' : 'processDossierUnnamed')}
            </span>
          )}
        </div>
        <div className="mt-[1.875px] flex min-w-0 items-center gap-[6px] overflow-hidden whitespace-nowrap text-[10.5px] leading-[1.45] text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {row.pinId && (
            <span className="shrink-0 rounded-[3px] border border-claude-border bg-claude-surfaceMuted px-1 font-mono text-[10px] leading-none dark:border-claude-darkBorder dark:bg-claude-darkSurfaceMuted" title={row.pinId}>
              {row.pinId.slice(0, 8)}…{row.pinId.slice(-4)}
            </span>
          )}
          {named && (
            <span>
              {named.creatorName || '—'} · {stamp ? `${stamp.date} ${stamp.time}` : '—'} · {named.protocol}
            </span>
          )}
          {row.note && <span className="min-w-0 truncate" title={row.note}>{row.note}</span>}
          {row.sha256 && (
            <span className="shrink-0 font-mono text-[10px] leading-none" title={`${t('processDossierShaRegistered')}: ${row.sha256}`}>
              sha256 {row.sha256.slice(0, 8)}…
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-[3.75px]">
        <button
          type="button"
          data-testid="process-dossier-anchor-copy"
          onClick={() => onCopy(row)}
          title={copied ? t('processDossierCopied') : t('processDossierCopy')}
          aria-label={copied ? t('processDossierCopied') : t('processDossierCopy')}
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[8px] border border-claude-border bg-claude-surface text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
        >
          {copied ? <span className="text-[10px] font-semibold">✓</span> : <DocumentDuplicateIcon className="h-3 w-3" />}
        </button>
        <button
          type="button"
          data-testid="process-dossier-anchor-open"
          disabled={!openable}
          onClick={() => openAnchor(row.uri)}
          title={t('processDossierOpen')}
          aria-label={t('processDossierOpen')}
          className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-[8px] border border-claude-border bg-claude-surface text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover disabled:cursor-not-allowed disabled:opacity-40 dark:border-claude-darkBorder dark:bg-claude-darkSurface dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
        >
          <ArrowTopRightOnSquareIcon className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
};

const EvidenceBlock: React.FC<{ view: ProcessDossierView; onRetryPins: () => void }> = ({ view, onRetryPins }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const handleCopy = useCallback((row: DossierAnchorRow) => {
    const value = (row.pinId ?? row.uri).trim();
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(value)
      .then(() => {
        setCopiedKey(row.key);
        window.setTimeout(() => setCopiedKey((current) => (current === row.key ? null : current)), 1200);
      })
      .catch(() => undefined);
  }, []);
  const hasUnreachable = view.anchors.some((row) => row.pinId && view.pinLookup.get(row.pinId)?.status === 'unreachable');
  return (
    <Block
      testId="process-dossier-evidence"
      eyebrow={t('processDossierEvidence')}
      summary={view.anchors.length > 0 ? String(view.anchors.length) : undefined}
    >
      {view.anchors.length === 0 ? (
        <EmptyLine text={t('processDossierNoEvidence')} />
      ) : (
        <div>
          {view.anchors.map((row) => (
            <AnchorRow
              key={row.key}
              row={row}
              lookup={row.pinId ? view.pinLookup.get(row.pinId) : undefined}
              copied={copiedKey === row.key}
              onCopy={handleCopy}
            />
          ))}
        </div>
      )}
      {hasUnreachable && (
        <button
          type="button"
          onClick={onRetryPins}
          className="mt-[7.5px] inline-flex items-center gap-1 text-[10px] text-claude-textSecondary transition-colors hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText"
        >
          <ArrowPathIcon className="h-3 w-3" />
          {t('processDossierRetry')}
        </button>
      )}
    </Block>
  );
};

// ── T2/T3/T4: no long-term task → run facts, never an empty checklist ──────

const RunFactsBlock: React.FC<{ view: ProcessDossierView }> = ({ view }) => {
  const { attempts, runs, tier } = view;
  const emptyText = tier === 'orchestration'
    ? t('processDossierNoTaskOrchestration')
    : tier === 'schedule'
      ? t('processDossierNoTaskSchedule')
      : t('processDossierNoTask');
  return (
    <Block
      testId="process-dossier-runfacts"
      eyebrow={t('processDossierRunFacts')}
      summary={attempts.length + runs.length > 0 ? String(attempts.length + runs.length) : undefined}
    >
      <EmptyLine text={emptyText} />
      {attempts.length > 0 && (
        <div className="mt-[9.375px]">
          {attempts.map((attempt) => {
            const stamp = formatDossierStamp(attempt.startedAt ?? attempt.queuedAt);
            return (
              <div key={attempt.id} className="flex min-h-[32px] items-center gap-[7.5px] border-t border-claude-border/60 py-[5.625px] first:border-t-0 dark:border-claude-darkBorder/60">
                <span className="w-[52px] shrink-0 text-right tabular-nums">
                  <b className="block text-[11px] font-semibold leading-[1.35] text-claude-text dark:text-claude-darkText">{stamp?.date ?? ''}</b>
                  <span className="block text-[10px] leading-[1.35] text-claude-textSecondary dark:text-claude-darkTextSecondary">{stamp?.time ?? ''}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-claude-text dark:text-claude-darkText" title={attempt.stepTitle ?? attempt.id}>
                  {attempt.workerName ?? `#${attempt.workerMetabotId}`}
                  {attempt.taskTitle ? ` · ${attempt.taskTitle}` : ''}
                  {attempt.stepTitle ? ` · ${attempt.stepTitle}` : ''}
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.04em] text-claude-textSecondary dark:text-claude-darkTextSecondary" title={attempt.error ?? undefined}>
                  {attempt.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {runs.length > 0 && (
        <div className="mt-[9.375px]">
          {runs.map((run) => {
            const stamp = formatDossierStamp(run.startedAt);
            return (
              <div key={run.id} className="flex min-h-[32px] items-center gap-[7.5px] border-t border-claude-border/60 py-[5.625px] first:border-t-0 dark:border-claude-darkBorder/60">
                <span className="w-[52px] shrink-0 text-right tabular-nums">
                  <b className="block text-[11px] font-semibold leading-[1.35] text-claude-text dark:text-claude-darkText">{stamp?.date ?? ''}</b>
                  <span className="block text-[10px] leading-[1.35] text-claude-textSecondary dark:text-claude-darkTextSecondary">{stamp?.time ?? ''}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-claude-text dark:text-claude-darkText" title={run.taskName ?? run.taskId}>
                  {run.taskName ?? run.taskId}
                  <span className="ml-1 text-[10.5px] text-claude-textSecondary dark:text-claude-darkTextSecondary">· {run.trigger}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.04em] text-claude-textSecondary dark:text-claude-darkTextSecondary" title={run.error ?? undefined}>
                  {run.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Block>
  );
};

// ── root ───────────────────────────────────────────────────────────────────

const Notice: React.FC<{ text: string; tone?: 'error' | 'muted' }> = ({ text, tone = 'muted' }) => (
  <div className="flex h-full items-center justify-center px-6 py-10">
    <p
      className={`text-center text-[11.5px] leading-[1.6] ${tone === 'error' ? 'text-red-500' : 'text-claude-textSecondary dark:text-claude-darkTextSecondary'}`}
    >
      {text}
    </p>
  </div>
);

const ProcessDossierBody: React.FC<{
  view: ProcessDossierView;
  onRetry?: () => void;
}> = ({ view, onRetry }) => {
  if (view.status === 'idle' || view.status === 'loading') {
    return (
      <div data-testid="process-dossier-body" data-dossier-state={view.status} className="flex-1 overflow-y-auto min-h-0 pt-[11.25px]">
        <div className="mx-auto w-full max-w-[clamp(680px,64%,920px)] px-4">
          <div className="flex items-center gap-2 py-6 text-[11.5px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
            {t('processDossierLoading')}
          </div>
        </div>
      </div>
    );
  }
  if (view.status === 'unsupported') {
    return (
      <div data-testid="process-dossier-body" data-dossier-state="unsupported" className="flex-1 overflow-y-auto min-h-0">
        <Notice text={t('processDossierChannelOffline')} />
      </div>
    );
  }
  if (view.status === 'error') {
    return (
      <div data-testid="process-dossier-body" data-dossier-state="error" className="flex-1 overflow-y-auto min-h-0">
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10">
          <p className="text-center text-[11.5px] leading-[1.6] text-red-500">
            {t('processDossierLoadFailed')}{view.error ? ` · ${view.error}` : ''}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 text-[10.5px] text-claude-textSecondary transition-colors hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText"
            >
              <ArrowPathIcon className="h-3 w-3" />
              {t('processDossierRetry')}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid="process-dossier-body"
      data-dossier-state="ready"
      data-dossier-tier={view.tier}
      className="flex-1 overflow-y-auto min-h-0 pt-[11.25px]"
    >
      <div className="mx-auto w-full max-w-[clamp(680px,64%,920px)] px-4 pb-4">
        {view.task ? (
          <>
            <GoalBlock view={view} />
            <ChecklistBlock view={view} />
            <RoundsBlock view={view} />
            <EvidenceBlock view={view} onRetryPins={() => onRetry?.()} />
          </>
        ) : (
          <RunFactsBlock view={view} />
        )}
      </div>
    </div>
  );
};

export default ProcessDossierBody;
