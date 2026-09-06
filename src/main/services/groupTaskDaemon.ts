/**
 * Group Task daemon: watches group_chat_messages for every non-terminal group_tasks
 * row and triggers bot replies under the strict chair-controlled protocol.
 *
 * Modeled on privateChatDaemon's structure (5s tick, single-tick re-entry guard,
 * module-level start/stop singleton) but deliberately separate from the cognitive
 * orchestrator ("chat mode"): Group Task has its own cursor
 * (group_tasks.last_processed_msg_id), its own session channel
 * (metaweb_group_task), and its own gating rules. Chunk A implements the
 * plain-LLM reply path only (no skill turns).
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { CoworkStore, CoworkSession } from '../coworkStore';
import type {
  GroupTaskStore,
  GroupTask,
  GroupTaskMember,
  GroupTaskDeliverable,
  GroupTaskCheckpoint,
} from '../groupTaskStore';
import type {
  OpenTeamInvite,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import { MetaIDExperienceStore } from '../metaidExperienceStore';
import { metabotBrainOptions, normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import {
  GROUP_LOG_PROTOCOL_MAX_CHARS,
  isCeremonyAckLine,
  isProtocolCarryingLine,
  parseGroupTaskEntropyP0Config,
  renderGroupLogLines,
  truncateGroupLogLine,
  type GroupTaskEntropyP0Config,
} from '../libs/groupTaskEntropy';
import { isNonAnswerAssistantReply } from '../libs/coworkAssistantReply';
import { truncateUtf16Units } from '../libs/llmSafeText';
import {
  formatWorkerEmptyHandoffError,
  hasSubstantiveActivity,
  summarizeSessionActivity,
  WORKER_EMPTY_HANDOFF,
  type CoworkSessionActivityMessage,
} from '../libs/coworkSessionActivity';
import { buildGroupTaskSystemPrompt } from './groupTaskPrompts';
import {
  buildMemberJoinWelcomeText,
  buildSourceSessionAnomalyNotice,
  buildSourceSessionCheckpointNotice,
  buildSourceSessionCreatedNotice,
  buildSourceSessionDispatchNotice,
  copyCorrectionApplied,
  copyLocalDeliverableNoPin,
  copyLocalDeliverableOnChain,
  copyLocalDeliverableUploadFailed,
  copyPinidNotSynced,
  copyConclusionTagInstruction,
  GROUP_TASK_NOTICE,
  hasGroupTaskNotice,
  isRollCallPresenceCheck,
} from '../libs/groupTaskCopy';
import {
  ensureGroupTaskMemberReady,
  ensureGroupTaskSession,
  GROUP_TASK_CONVERSATION_CHANNEL,
  corruptSessionLogSignature,
  isCorruptSessionLogError,
  rebuildGroupTaskSession,
} from './groupTaskSession';
import type { GroupTaskOrchestrationBridge } from './groupTaskOrchestrationBridge';
import { SkillTurnTimeoutError } from './orchestratorCoworkBridge';
import { recordMetaIDGroupTaskExperience } from './metaidExperienceRecorder';
import {
  buildAcceptanceSummary,
  buildGroupTaskTimeBreakdown,
  extractChairConclusion,
  extractCriteriaVerdicts,
} from './groupTaskAcceptanceSummary';
import {
  buildExperiencePromptBlocksXml,
  RECENT_SUMMARIES_PROMPT_DAYS,
} from '../libs/experiencePromptBlocks';
import {
  parseDeliverableLines,
  parseDeliverableSegments,
  extractPinidToken,
  hasDeliverableTagLine,
  extractLocalFilePaths,
  parseWorkingAck,
  hasStandbyMarker,
  isIntegrityDeclaration,
  isCorrectionText,
  type ParsedDeliverable,
} from './groupTaskDeliverableParser';
import { buildMetafileUri } from './serviceDeliveryArtifacts.js';
import metaFileUploadShared from './metaFileUploadShared.js';
import { isTextDocumentDeliverable } from './deliverableTextNote';
import { downloadMetafileBytes } from '../libs/metafileDownload';

const { inferContentTypeFromFilePath } = metaFileUploadShared;

/** Alias kept for readability; the canonical value lives in groupTaskSession. */
const CONVERSATION_CHANNEL = GROUP_TASK_CONVERSATION_CHANNEL;
const DELIVERABLE_TAG = /\[DELIVERABLE\]/i;
/**
 * Task #51: workers address the chair by the literal role alias "@chair"
 * (the chair's display name varies by deployment); treat it as a chair
 * mention. Negative lookahead keeps "@chairman"-style tokens out.
 */
const CHAIR_ALIAS_RE = /@chair(?![\w-])/i;
const STATUS_TAG = /\[STATUS:\s*(EXECUTING|REVIEW)\s*\]/i;
/**
 * GT#47 R1: global variant that collects EVERY [STATUS:*] tag in one message.
 * A chair plan message routinely quotes *descriptive* tags in its body (the
 * goal/acceptance-criteria text says things like "通过后发 [STATUS:REVIEW]")
 * before the instruction tag the protocol template requires at the message
 * end. GT-04 (task #56) replaced the old "last end-line tag wins" rule with
 * legality-aware adjudication — see adjudicateStatusDirectives below.
 */
const STATUS_TAG_ALL = /\[STATUS:\s*(EXECUTING|REVIEW)\s*\]/gi;

/**
 * GT-04 (task #56): quote stripping — [STATUS:*] tags inside fenced code
 * blocks or inline `code` spans are CITATIONS, never instructions. This is the
 * escape mechanism the protocol previously lacked (and what host notices use
 * when they must talk ABOUT tag syntax). Applies to status-directive parsing
 * only; other tag families keep their own rules.
 */
function stripStatusQuotedCode(content: string): string {
  return stripGroupTaskQuotedCode(content);
}

/**
 * Speedup hardening (group-task-speedup REQ 防坑提示): the same quote stripping
 * generalized for every lifecycle-token parser. Tokens quoted inside fenced
 * code blocks or inline `code` spans are descriptive references, never real
 * protocol input. Exported for unit tests.
 */
export function stripGroupTaskQuotedCode(content: string): string {
  return String(content ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Fence-only variant for PAYLOAD-bearing tags ([DELIVERABLE]): real deliveries
 * routinely wrap the delivered URI / local file path in inline backticks
 * (`metafile://…i0`, `/path/to/spec.md`), so inline code spans must stay
 * intact here; only multi-line fenced blocks are citations.
 */
export function stripFencedCodeBlocks(content: string): string {
  return String(content ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, '');
}

/** Chair-movable transitions (LEGAL_TRANSITIONS minus the owner-only terminal moves). */
const CHAIR_STATUS_MOVES: Record<string, Array<'executing' | 'review'>> = {
  planning: ['executing'],
  executing: ['review'],
  review: ['executing'],
};

export interface StatusDirectiveVerdict {
  /** The instruction to apply: the highest-priority candidate that is legal
   * from the current status (null when none qualifies). */
  instruction: 'executing' | 'review' | null;
  /** Candidate tags rejected as illegal from the current status (deduped). */
  rejected: Array<'executing' | 'review'>;
  /** Candidate tags re-asserting the live status — benign no-ops, neither
   * instructions nor rejections (deduped). The chair prompt tells a partially
   * confused chair to "re-issue the review message"; the duplicate lands on a
   * task already in that status and must not read as an anomaly. */
  noOp: Array<'executing' | 'review'>;
  /** Tags treated as descriptive prose, never instructions (deduped). */
  descriptive: Array<'executing' | 'review'>;
  /** Total [STATUS:*] occurrences found after code-quote stripping. */
  tagCount: number;
}

/**
 * Task #63: markdown emphasis around a standalone tag line — the chair's
 * wrap-up verdict `**[STATUS:REVIEW]**` on its own line — still reads as an
 * instruction field: emphasis markers (*, _) and whitespace never carry
 * sentence meaning. Anything else around the tag (words, `>` quote markers,
 * strikethrough `~~`, punctuation) keeps the line prose/descriptive.
 */
const MD_EMPHASIS_RESIDUE = /^[\s*_]*$/;

/**
 * GT-04 (task #56): legality-aware status-directive adjudication.
 *
 * Candidate tags, in priority order:
 *  a) the LAST tag on the last non-empty line (the protocol instruction field —
 *     G-03/task #52 semantics unchanged, mid-line on that line still counts);
 *  b) STANDALONE tag lines elsewhere in the body (a tag alone on its own line
 *     is unambiguous protocol formatting — this is what saved task #56, whose
 *     real [STATUS:EXECUTING] instruction sat on its own line mid-message while
 *     the final line merely mentioned `[STATUS:REVIEW]` in prose). Task #63:
 *     emphasis-wrapped own-line tags (`**[STATUS:REVIEW]**`) count too — a
 *     chair's wrap-up routinely bolds the verdict line.
 *
 * Everything else — prose-embedded tags on earlier lines, non-final tags on the
 * last line, and anything inside code quotes — is descriptive text.
 *
 * The FIRST candidate whose transition is legal from the current status is the
 * instruction; remaining candidates are rejected (illegal). Previously the
 * end-line tag always won and an illegal one sank the WHOLE message's intent
 * (task #56: planning pinned forever because the descriptive end-line REVIEW
 * was rejected while the legitimate body EXECUTING was ignored).
 *
 * Pure + exported for unit tests.
 */
export function adjudicateStatusDirectives(
  content: string,
  currentStatus: string,
): StatusDirectiveVerdict {
  const text = stripStatusQuotedCode(content);
  const lines = text.split(/\r?\n/);
  let endLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) {
      endLineIndex = i;
      break;
    }
  }
  type Occurrence = { tag: 'executing' | 'review'; lineIndex: number; standalone: boolean };
  const occurrences: Occurrence[] = [];
  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (!line) return;
    for (const match of line.matchAll(STATUS_TAG_ALL)) {
      const tag = match[1].toLowerCase() as 'executing' | 'review';
      const prefix = line.slice(0, match.index).trim();
      const suffix = line.slice(match.index + match[0].length).trim();
      // Task #63: `**[STATUS:REVIEW]**` on its own line counts as standalone —
      // emphasis residue never carries sentence meaning (see MD_EMPHASIS_RESIDUE).
      const standalone = MD_EMPHASIS_RESIDUE.test(prefix) && MD_EMPHASIS_RESIDUE.test(suffix);
      occurrences.push({ tag, lineIndex, standalone });
    }
  });
  // (a) the end-line instruction field: the LAST tag on the last non-empty
  // line (any position on that line — the task #52 verdict shape).
  const endLineOccurrences = occurrences.filter((occ) => occ.lineIndex === endLineIndex);
  const candidates: Occurrence[] = [];
  if (endLineOccurrences.length > 0) candidates.push(endLineOccurrences[endLineOccurrences.length - 1]);
  // (b) standalone tag lines elsewhere, in message order.
  for (const occ of occurrences) {
    if (occ.standalone && occ.lineIndex !== endLineIndex) candidates.push(occ);
  }
  const candidateSet = new Set(candidates);
  const legal = CHAIR_STATUS_MOVES[currentStatus] ?? [];
  const instructionOcc = candidates.find((occ) => legal.includes(occ.tag)) ?? null;
  // A candidate equal to the live status is a re-assert, not an illegal move:
  // CHAIR_STATUS_MOVES has no self-transitions, so without this bucket the
  // tag would land in `rejected` and mint an "illegal_transition" audit row
  // for a benign duplicate (the old parser treated it as a silent no-op).
  const rejected = [...new Set(
    candidates.filter((occ) => occ !== instructionOcc && !legal.includes(occ.tag) && occ.tag !== currentStatus).map((occ) => occ.tag),
  )];
  const noOp = [...new Set(
    candidates.filter((occ) => occ !== instructionOcc && occ.tag === currentStatus).map((occ) => occ.tag),
  )];
  const descriptive = [...new Set(
    occurrences.filter((occ) => !candidateSet.has(occ)).map((occ) => occ.tag),
  )];
  return {
    instruction: instructionOcc?.tag ?? null,
    rejected,
    noOp,
    descriptive,
    tagCount: occurrences.length,
  };
}
/**
 * HITL checkpoint tags (chair-only, same trust rule as STATUS tags):
 * `[CHECKPOINT: <topic>]` pauses the task for the owner's decision;
 * `[CHECKPOINT_RESOLVED: <decision>]` resumes work. While a checkpoint is
 * open the daemon gates responders exactly like the review phase — workers
 * stay silent and only the owner's messages reach the chair.
 */
const CHECKPOINT_OPEN_TAG = /\[CHECKPOINT:\s*([^\]\n]+?)\s*\]/i;
const CHECKPOINT_RESOLVED_TAG = /\[CHECKPOINT_RESOLVED(?::\s*([^\]\n]+?)\s*)?\]/i;
/**
 * HITL: any checkpoint tag form, used to strip the tag(s) out of the chair's
 * message body when deriving the "what the owner must decide" summary.
 * Matches `[CHECKPOINT]`, `[CHECKPOINT: topic]`, `[CHECKPOINT_RESOLVED]` and
 * `[CHECKPOINT_RESOLVED: decision]`.
 */
const CHECKPOINT_ANY_TAG = /\[CHECKPOINT(?:_[A-Z]+)?(?::[^\]]*)?\]/gi;
/**
 * Improvement #4 (v1.3): chair plan-change disclosure tag, e.g.
 * `[PLAN_CHANGE: seedream 生图 → 网络/无 ARK_API_KEY 受阻 → 改用本机 Pillow 生成 PNG]`.
 * Chair-only (same trust rule as STATUS tags); each occurrence is one line of
 * first-hand resolution fact recorded into group_task_plan_changes and
 * snapshotted into the acceptance summary at review entry.
 */
const PLAN_CHANGE_TAG = /\[PLAN_CHANGE:\s*([^\]\n]+?)\s*\]/gi;
/** Improvement #4 (v1.3): cap for one recorded plan-change line (mirrors the render cap). */
const PLAN_CHANGE_LINE_MAX_RECORD_CHARS = 240;

/**
 * Improvement #4 (v1.3): extract the plan-change disclosure lines from a
 * message body (all `[PLAN_CHANGE: ...]` occurrences, order preserved).
 * Pure + exported for unit tests.
 */
export function extractPlanChangeLines(content: string | null | undefined): string[] {
  const lines: string[] = [];
  const text = String(content ?? '');
  PLAN_CHANGE_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLAN_CHANGE_TAG.exec(text)) !== null) {
    const line = match[1].trim();
    if (line) lines.push(line);
  }
  return lines;
}
/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;
/**
 * P0-2: worker ACK/progress status tag, e.g.
 * `[WORKING] 已接单，正在做X，预计N分钟` — the worker-to-group "I am alive and
 * working" signal. The tag also feeds the member workStatus readout (P1-4).
 * P2-2: the tag may carry in-tag qualifiers (`[WORKING long-task, ETA 45 min]`)
 * — a long-task heartbeat; matching is prefix-based so both forms count.
 */
const WORKING_TAG = /\[WORKING(?:\s[^\]]*)?\]/i;
/**
 * P2-2: kv heartbeat lease per (task, member): a `[WORKING ... ETA N min]`
 * message extends the member's liveness lease to now + N min + grace. While
 * the lease is valid the host watchdogs must not flag the member unreachable
 * (a running long task is not silence).
 */
export const WORKING_HEARTBEAT_PREFIX = 'group_task_working_heartbeat:';
/** P2-2: grace period appended to a heartbeat ETA before the lease expires. */
export const WORKING_HEARTBEAT_GRACE_MS = 5 * 60_000;
/**
 * P2-2: heartbeat lease expiry for an ETA in minutes. Pure + exported for
 * unit tests.
 */
export function computeWorkingHeartbeatUntil(
  estimatedMinutes: number,
  nowMs: number,
  graceMs: number = WORKING_HEARTBEAT_GRACE_MS,
): number {
  const minutes = Math.max(0, Math.trunc(estimatedMinutes));
  return nowMs + minutes * 60_000 + Math.max(0, graceMs);
}

/**
 * Extract a chair-stated step deadline (in minutes) from an assignment
 * message, e.g. `[DEADLINE: 30m]`, `deadline: 45 minutes`, `deadline 15 min`.
 * Conservative on purpose: the number must carry an explicit unit and sit in
 * a sane range, and when one message states two DIFFERENT deadlines the
 * mention is ambiguous and returns null (the caller falls back to
 * DEFAULT_STEP_DEADLINE_MS). Pure + exported for unit tests.
 */
export function parseChairDeadlineMinutes(content: string | null | undefined): number | null {
  const text = String(content ?? '');
  if (!text) return null;
  const patterns = [
    /\[DEADLINE:\s*(\d{1,4})\s*(?:minutes?|mins?|m|分钟)\s*\]/gi,
    /\bdeadline\b\s*[:：]?\s*(?:of\s+)?(\d{1,4})\s*(?:minutes?|mins?|m(?![a-z])|分钟)/gi,
  ];
  const values = new Set<number>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const minutes = Number(match[1]);
      if (Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60) values.add(minutes);
    }
  }
  if (values.size !== 1) return null;
  return [...values][0];
}

/**
 * P1-2/P2-1: member liveness classification shared by the silence watchdogs.
 * The watchdogs used to look at group-chat speech only, so a worker mid
 * long-task (tool calls streaming into its cowork session, or a valid
 * [WORKING long-task] heartbeat lease) was mislabeled unreachable. A member
 * is alive when ANY of: a valid heartbeat lease, group speech within the
 * threshold, or cowork-session activity within the threshold. Pure +
 * exported for unit tests.
 */
export interface MemberLivenessSignals {
  lastSpeakMs: number | null;
  lastSessionActivityMs: number | null;
  heartbeatUntilMs: number | null;
  nowMs: number;
  thresholdMs: number;
}
export type MemberLiveness = 'alive' | 'stale';
export function classifyMemberLiveness(signals: MemberLivenessSignals): MemberLiveness {
  if (
    signals.heartbeatUntilMs != null
    && Number.isFinite(signals.heartbeatUntilMs)
    && signals.nowMs < signals.heartbeatUntilMs
  ) {
    return 'alive';
  }
  const fresh = (ts: number | null): boolean =>
    ts != null && Number.isFinite(ts) && signals.nowMs - ts <= signals.thresholdMs;
  if (fresh(signals.lastSpeakMs)) return 'alive';
  if (fresh(signals.lastSessionActivityMs)) return 'alive';
  return 'stale';
}
/** P0-2: kv guard so one dispatch produces at most ONE host ACK. */
/**
 * Speedup R-03: kv flag per (task, message) — every [DELIVERABLE] candidate
 * of the message folded into an earlier ledger row (same author + same uri),
 * so the responder gate must not wake the chair for a fresh verdict.
 */
const DELIVERABLE_FOLDED_PREFIX = 'group_task_deliverable_folded:';
/**
 * P2-6: dependency annotation on a dispatch message, e.g.
 * `[DEPENDS_ON: <64hex pinid>]` — the host holds the worker dispatch until the
 * referenced upstream deliverable lands (bounded wait, then proceeds).
 */
const DEPENDS_ON_TAG = /\[DEPENDS_ON:\s*([^\]]+)\]/i;
const DEPENDS_ON_TAG_GLOBAL = new RegExp(DEPENDS_ON_TAG.source, 'gi');
/**
 * fix/group-task-dep-wait: all [DEPENDS_ON: <token>] tokens of a message. The
 * P2-6 dispatch gate enforces the FIRST tag (DEPENDS_ON_TAG); watchers such as
 * the stale-[WORKING] dependency-wait exemption audit every tag instead.
 */
function extractDependsOnTokens(content: string | null | undefined): string[] {
  const text = (content ?? '').trim();
  if (!text) return [];
  return [...text.matchAll(DEPENDS_ON_TAG_GLOBAL)]
    .map((match) => match[1].trim())
    .filter((token) => token.length > 0);
}
const DEP_WAIT_KV_PREFIX = 'group_task_dep_wait:';
/**
 * fix/group-task-duration (task #57): kv stamp for the corrupt-session-log
 * rebuild — one rebuild per (task, bot) per interval so a genuinely broken
 * runtime cannot loop session rebuilds forever.
 */
const CORRUPT_SESSION_REBUILD_PREFIX = 'group_task_corrupt_session_rebuild:';
const CORRUPT_SESSION_REBUILD_MIN_INTERVAL_MS = 60 * 60_000;
/**
 * release-review P2: bounded hold timestamp for a trigger whose (task, bot)
 * session is still running a prior turn (the post-hard-cap window where the
 * guard is gone but the dangling job's runner turn is still active). Same
 * startedAt-cap pattern as DEP_WAIT; deleted once the session idles or the
 * hold expires. Not carried in DeferredReplyEntry so the hold survives queue
 * rewrites without touching the durable schema.
 */
const SESSION_BUSY_HOLD_PREFIX = 'group_task_session_busy_hold:';

/**
 * fix/group-task-fix-v2 (B2): stuck-verdict reclaim mode. The default is
 * 'alert_only' — a stuck verdict raises an alert for the chair to verify but
 * never stops the member's session: tasks #54/#55 showed the automatic
 * reclaim repeatedly killing sessions of members who were correctly waiting
 * on upstream deliverables (3 false reclaims across the two tasks, all
 * mislabeled "no upstream dependency"). kv `groupTaskStuckReclaim` accepts
 * JSON `{"mode":"auto"}` to restore the reclaim behavior once the dependency
 * graph is trustworthy.
 */
export type GroupTaskStuckReclaimMode = 'alert_only' | 'auto';
export function parseGroupTaskStuckReclaimMode(raw: string | null | undefined): GroupTaskStuckReclaimMode {
  const text = (raw ?? '').trim();
  if (!text) return 'alert_only';
  try {
    const parsed = JSON.parse(text) as { mode?: unknown };
    return parsed.mode === 'auto' ? 'auto' : 'alert_only';
  } catch {
    return text === 'auto' ? 'auto' : 'alert_only';
  }
}

/**
 * fix/group-task-fix-v2 (B2): prose-form dependency declarations in a chair
 * dispatch. The structured form is `[DEPENDS_ON: <pinid>]`, but chairs
 * routinely write dependencies in prose ("S5 依赖 S4", "S4 待 S2、S3 交付后
 * 开始", "S5 depends on S4"). For the stuck verdict those prose declarations
 * count as a real upstream wait — reading only the structured tag (and then
 * annotating "no upstream dependency" when it is absent) was wrong three
 * times in a row in tasks #54/#55.
 *
 * Release-review P1 hardening: this regex is only a CANDIDATE detector, not a
 * semantic parser — negated statements ("不依赖任何人", "无依赖，独立完成",
 * "does not depend on", "independent of") must not read as declarations, so
 * every branch carries a negation lookbehind. The exemption a prose hit
 * grants is additionally time-capped (PROSE_DEPENDENCY_EXEMPTION_MAX_MS)
 * because prose declarations, unlike ledger-verified [DEPENDS_ON] tokens,
 * can never self-lift.
 */
const PROSE_NEGATION_LOOKBEHIND = '(?<!(?:不|无|未|勿|莫|别|没|休|免|非|何|没有|无需|不必|不用|不存在))';
const PROSE_NEGATION_LOOKBEHIND_EN = '(?<!(?:\\bno\\s+|\\bnot\\s+|\\bwithout\\s+|\\bnever\\s+|\\bindependen(?:t|tly)\\s+(?:of\\s+)?))';
const PROSE_DEPENDENCY_RE = new RegExp(
  '(?:'
  + `${PROSE_NEGATION_LOOKBEHIND}依赖|${PROSE_NEGATION_LOOKBEHIND}前置|${PROSE_NEGATION_LOOKBEHIND}上游|`
  + `${PROSE_NEGATION_LOOKBEHIND}在[^，。；\\n]{1,24}之后|`
  + `${PROSE_NEGATION_LOOKBEHIND}等[^，。；\\n]{1,24}(?:交付|完成|产出|落地)|`
  + `${PROSE_NEGATION_LOOKBEHIND}待[^，。；\\n]{1,24}(?:交付|完成|产出|落地)|`
  + `${PROSE_NEGATION_LOOKBEHIND_EN}(?:depends?\\s+on|dependent\\s+on|blocked\\s+by|waiting\\s+(?:for|on))|`
  + `${PROSE_NEGATION_LOOKBEHIND_EN}after\\s+[^,.;\\n]{1,32}(?:delivers|lands|completes|is\\s+done)`
  + ')',
  'i',
);
export function hasProseDependencyDeclaration(content: string | null | undefined): boolean {
  return PROSE_DEPENDENCY_RE.test(content ?? '');
}

/**
 * fix-v2 P0-1: a worker's OWN upstream-wait declaration inside its [WORKING]
 * message ("待 Builder 上链交付后接单", "等 S3 交付后开始", "waiting on the S3
 * delivery"). A conditional ETA ("…后…预计 2 分钟") is not a delivery
 * commitment — the clock starts at the upstream's arrival, which the host
 * cannot derive from text. Arming a deadline from a conditional ETA produced
 * the task #62 false alert: the member's readiness note ("待 Builder 上链
 * 交付后接单，回填→发布预计 2 分钟") armed a 2-minute deadline and alerted
 * two minutes later while the upstream S3 was still undelivered.
 *
 * Deliberately narrower than {@link hasProseDependencyDeclaration}: bare
 * 依赖/前置/上游 words ("依赖已就绪，开工") do NOT count — only an explicit
 * wait marker (待…/等…/waiting on/after…) does.
 */
const WORKER_UPSTREAM_WAIT_RE = new RegExp(
  '(?:'
  + `${PROSE_NEGATION_LOOKBEHIND}待[^，。；\\n]{1,32}(?:交付|完成|产出|落地|就绪)|`
  + `${PROSE_NEGATION_LOOKBEHIND}等[^，。；\\n]{1,32}(?:交付|完成|产出|落地|就绪)|`
  + '\\bwaiting\\s+(?:for|on)\\s+[^,.;\\n]{1,48}(?:deliver|land|complet|ready|done)|'
  + '\\bafter\\s+[^,.;\\n]{1,48}(?:delivers|lands|completes|is\\s+done|is\\s+ready)'
  + ')',
  'i',
);
export function hasWorkerUpstreamWait(content: string | null | undefined): boolean {
  return WORKER_UPSTREAM_WAIT_RE.test(content ?? '');
}

/**
 * fix-v2 P0-1: the member-scoped clause of a multi-member dispatch. Chairs
 * routinely dispatch several steps in one message ("@A … [DEPENDS_ON: …]
 * 直接开工。@B 你的发布等 C 落地后派单。"); message-scoped dependency parsing
 * lets one member's clause mask another's prose wait (the foreign tag's
 * free-text token reads as satisfied, skipping the prose branch) or taint a
 * member with a wait that governs someone else's step. The clause runs from
 * the member's @mention to the next @mention, blank line, or thematic break.
 * Returns null when the mention is not literal text (mention-array-only
 * dispatches) — callers then keep whole-message semantics.
 */
export function extractMemberDispatchClause(
  content: string | null | undefined,
  botName: string | null | undefined,
): string | null {
  const text = String(content ?? '');
  const name = String(botName ?? '').trim();
  if (!text || !name) return null;
  const at = text.toLowerCase().indexOf(`@${name.toLowerCase()}`);
  if (at < 0) return null;
  const rest = text.slice(at);
  const tail = rest.slice(1);
  const end = /(?:\r?\n[ \t]*\r?\n)|(?:\r?\n[ \t]*-{3,}[ \t]*$)|(?:\s@)/m.exec(tail);
  return end ? rest.slice(0, 1 + end.index) : rest;
}
/**
 * P2-8: multi-driver mutex — kv heartbeat claim per task
 * (`group_task_driver:<taskId>` = `<instanceId>|<epochMs>`). Only the most
 * recently claiming daemon instance drives a task; others yield. Exported so
 * the service can surface the current driver in the task detail.
 */
export const GROUP_TASK_DRIVER_KV_PREFIX = 'group_task_driver:';
/** Default grace: a driver claim this old (or older) is stale — claimable. */
export const DEFAULT_DRIVER_GRACE_MS = 20_000;
/**
/**
 * Tick watchdog (fix/group-member-status): a tick that makes NO observable
 * progress (group send / cursor advance) for longer than this is presumed hung
 * on a never-settling await — the loop logs and resumes instead of staying
 * silently dead forever. Progress-based, not duration-based: a healthy tick
 * may legitimately chain several worker turns and run long. The window must
 * exceed the longest single indivisible await inside a tick — one worker skill
 * turn, budgeted at skillTurnTimeoutMs (30 min in main.ts) — because an
 * in-flight turn produces no progress signals; 45 min gives a 15-min margin.
 */
export const DEFAULT_TICK_WATCHDOG_MS = 45 * 60_000;
/** Default bounded wait for an upstream deliverable referenced by [DEPENDS_ON]. */
const DEFAULT_DEPENDENCY_WAIT_MAX_MS = 15 * 60_000;

/**
 * 清单 #10 P-A: read a task session's messages for substantive-activity
 * detection. Tolerant — store errors yield [] so the EMPTY_HANDOFF judgment
 * degrades to the old behavior.
 */
function readTaskSessionActivityMessages(
  coworkStore: CoworkStore,
  sessionId: string,
): CoworkSessionActivityMessage[] {
  try {
    const page = coworkStore.getSessionMessagesPage(sessionId, { limit: 100 });
    return (page?.messages ?? []).map((message) => ({
      type: message.type,
      content: String(message.content ?? ''),
      metadata: (message.metadata ?? null) as Record<string, unknown> | null,
    }));
  } catch {
    return [];
  }
}

/**
 * P1-4 / round-4: lines carrying the [DELIVERABLE] protocol tag — the ONLY
 * source for deliverable URIs and kinds. Parsing is delegated to
 * groupTaskDeliverableParser (one row per tag occurrence, strict
 * placeholder/truncation filtering, 64-hex+i0 or ^https?:// validation);
 * URIs anywhere else in the message body never influence the outcome.
 */
const deliverableTagLines = (content: string): string[] =>
  content
    .split('\n')
    // Task #63: only lines LED BY the tag (emphasis prefix tolerated, same as
    // the parser's TAG_LED_LINE_RE) are protocol deliveries — mid-line mentions
    // are prose citations ("上条 [DELIVERABLE] 即为回应") and must never satisfy
    // a dependency gate.
    .filter((line) => /^[\s*_]*\[deliverable\]/i.test(line.trimStart()));

/**
 * True when two strings carry hex runs (pinids/txids, ignoring protocol
 * prefixes and the `i0` suffix) that share a prefix of at least 32 hex chars
 * in EITHER direction. LLM participants routinely truncate 64-hex pinids when
 * quoting them in prose (task #58: a 60-hex `metafile://` prefix); an exact or
 * contains-only comparison then reads "not delivered" and dispatches stall on
 * the bounded dependency wait. 32 shared leading hex chars cannot happen by
 * chance between unrelated hashes.
 */
export function hexTokensSharePrefix(a: string, b: string): boolean {
  const HEX_RUN_RE = /[0-9a-f]{32,}/g;
  const runsOf = (value: string): string[] => (value.match(HEX_RUN_RE) ?? []);
  const aRuns = runsOf(String(a ?? '').toLowerCase());
  const bRuns = runsOf(String(b ?? '').toLowerCase());
  if (aRuns.length === 0 || bRuns.length === 0) return false;
  return aRuns.some((aRun) => bRuns.some((bRun) =>
    (aRun.length >= 32 && bRun.startsWith(aRun))
    || (bRun.length >= 32 && aRun.startsWith(bRun)),
  ));
}

/**
 * HITL: derive the "what the owner must decide" summary from the chair's
 * [CHECKPOINT] message body — the body minus any checkpoint tags themselves.
 * The chair typically posts the draft/decision content in the same message
 * (e.g. "意见稿已整理好，见链接。 [CHECKPOINT: 意见稿确认]"), so the tag-free
 * remainder IS the decision summary; document links inside it survive
 * untouched. Returns null when only tags (or nothing) remain so callers can
 * fall back to the checkpoint topic.
 */
export function extractCheckpointDecisionSummary(content: string | null | undefined): string | null {
  const text = (content ?? '')
    .replace(CHECKPOINT_ANY_TAG, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * HITL: one-line truncation of a decision summary for the pause ceremony line
 * and the detail banner. Cuts on a whitespace boundary when possible; the
 * full body always stays available in the group transcript.
 */
export function truncateCheckpointSummary(summary: string, maxLength = 120): string {
  const text = summary.trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const end = lastSpace > maxLength * 0.6 ? lastSpace : maxLength;
  return `${cut.slice(0, end).trimEnd()}…`;
}

const CHAIR_PLANNED_KV_PREFIX = 'group_task_chair_planned:';
const CHAIR_PLAN_ATTEMPTS_KV_PREFIX = 'group_task_chair_plan_attempts:';
const MAX_CHAIR_PLAN_ATTEMPTS = 3;
/** F1 (GT#11): settle-gate kv — last observed roster signature for a task. */
const CHAIR_PLAN_ROSTER_KV_PREFIX = 'group_task_chair_plan_roster:';
/**
 * F1 (GT#11): the chair planning turn must not fire while the roster is still
 * forming (createGroupTask persists the task row + chair member first, then
 * joins each worker with network-bound calls; a 5s daemon tick can otherwise
 * plan against a truncated roster and permanently misplan the task). Default:
 * wait until the roster is unchanged for this long.
 */
const DEFAULT_CHAIR_PLAN_ROSTER_SETTLE_MS = 20_000;
/**
 * F1 (GT#11): absolute cap — planning proceeds once the task is older than
 * this, even if the roster keeps changing (join failures/retries), so a task
 * can never sit in 'planning' forever behind the settle gate.
 */
const DEFAULT_CHAIR_PLAN_ROSTER_CAP_MS = 10 * 60_000;

/**
 * Owner-report guard: one private A2A report per task per review-entry. The
 * rework hatch (review -> executing) clears it so the NEXT review re-reports.
 * Exported so the reopen service path clears the same guard.
 */
export const GROUP_TASK_OWNER_REPORTED_KV_PREFIX = 'group_task_owner_reported:';
/**
 * P4 (v1.2): one [GROUP_TASK_REVIEW] report injection into the origin CoWork
 * session per review-entry. Cleared by the rework hatch (like the A2A owner
 * report) so the next review re-reports. Exported for the service-side
 * notifySourceSessionReview guard.
 */
export const GROUP_TASK_REVIEW_NOTIFIED_KV_PREFIX = 'group_task_review_notified:';
/**
 * HITL checkpoint-report guard: one private A2A checkpoint request per
 * checkpoint (`group_task_checkpoint_reported:<taskId>:<checkpointId>`).
 */
const GROUP_TASK_CHECKPOINT_REPORTED_KV_PREFIX = 'group_task_checkpoint_reported:';
const ACK_PENDING_PREFIX = 'group_task_ack_pending:';
const ACK_REMINDED_PREFIX = 'group_task_ack_reminded:';
/**
 * P1-4: ack-seen marker — the worker ACKed (or implicitly engaged on) an
 * assignment message, recorded as `group_task_ack_seen:<taskId>:<messageId>`.
 * Derived [DEPENDS_ON] assignments inherit the upstream ack-seen so the ACK
 * watchdog never starts a fresh 3-min watch on an already-engaged chain, and
 * a re-processed assignment message (cursor retry) never re-arms the watch.
 */
const ACK_SEEN_PREFIX = 'group_task_ack_seen:';
const EXPECTED_DELIVERY_PREFIX = 'group_task_expected_delivery:';
const DELIVERY_REMINDED_PREFIX = 'group_task_delivery_reminded:';
/**
 * Default delivery deadline armed when a worker ACKs [WORKING] without an ETA
 * and the chair's assignment states no explicit deadline (task #60: a
 * numberless ACK left the step unwatched for 71+ minutes with no escalation
 * path). The armed record feeds the SAME P0-4 reminder / P1-3 escalation path
 * as an ETA-armed deadline, which re-checks deliverables and only reclaims a
 * genuinely inert member (heartbeat/session-activity gated) — so a worker
 * legitimately mid-turn is nudged, never reclaimed.
 */
const DEFAULT_STEP_DEADLINE_MS = 30 * 60_000;
/**
 * Task #51: the chair owes a response to the latest chair-triggering message.
 * Armed when the gating produces any chair decision; cleared when the chair
 * speaks or a chair turn completes. If neither lands within the redrive
 * window, the trigger is re-driven ONCE through the durable defer queue —
 * covers chair triggers silently dropped by the per-tick chair auto-reply
 * cap, the Twin-suppression window, or a spent reply budget.
 */
const CHAIR_RESPONSE_PENDING_PREFIX = 'group_task_chair_response_pending:';
/**
 * Task #51: how long the chair may stay silent on a trigger before one
 * re-drive. fix-v2 P0-2: raised 4 min → 10 min — a chair quality-gate turn
 * legitimately runs ~7 minutes (task #62 fired twice inside one), and the
 * countdown now also slides while the chair is provably responsive (turn in
 * flight / session writes), so the window measures CONTINUOUS silence only.
 */
const DEFAULT_CHAIR_RESPONSE_REDRIVE_MS = 10 * 60_000;
const MSG_RETRY_PREFIX = 'group_task_msg_retry:';
/**
 * P1-2/P1-3: one stuck-session reclaim per (task, member) streak — the host
 * stops the inert session and hands the chair an actionable directive at most
 * once per silence streak. Cleared when the member ACKs/speaks again so a
 * future stuck spell reclaims afresh.
 */
const GROUP_TASK_STUCK_RECLAIM_PREFIX = 'group_task_stuck_reclaim:';
/**
 * fix/group-task-fix-v2 (B2): one stuck ALERT per (task, member) streak —
 * the alert-only reclaim mode raises this instead of stopping the session.
 * Same streak lifecycle as GROUP_TASK_STUCK_RECLAIM_PREFIX (cleared when the
 * member speaks/ACKs again).
 */
const GROUP_TASK_STUCK_ALERT_PREFIX = 'group_task_stuck_alert:';
/**
 * R6 L2: one re-assign hint per (task, member) timeout streak — mirrors the
 * ACK_REMINDED kv guard so the chair isn't spammed every tick while a member
 * stays silent. Cleared when the member speaks again (see handleMemberProtocolMarkers).
 */
const GROUP_TASK_TIMEOUT_HINT_PREFIX = 'group_task_timeout_hint:';
/** R6 L3: one owner brief per (task, member) timeout streak (distinct from the L2 chair hint). */
const GROUP_TASK_TIMEOUT_OWNER_PREFIX = 'group_task_timeout_owner:';
/**
 * fix/group-task-dep-wait: audit note kept while the stale-[WORKING] monitor
 * exempts a member whose latest chair assignment waits on an undelivered
 * [DEPENDS_ON] upstream (`group_task_dep_wait_exempt:<taskId>:<metabotId>`;
 * deleted once the wait lifts). Distinct from DEP_WAIT_KV_PREFIX, which tracks
 * the P2-6 dispatch gate's bounded wait per assignment message.
 * GT-09: exported — the service reads this same note to project the panel's
 * 'waiting' work status (single source of truth, no duplicated parsing).
 */
export const GROUP_TASK_DEP_WAIT_EXEMPT_PREFIX = 'group_task_dep_wait_exempt:';
/**
 * Release-review P1: a prose dependency declaration carries no structured
 * [DEPENDS_ON] token to verify against the ledger, so the exemption it grants
 * can never self-lift — it is time-capped. After this long with the SAME
 * latest chair assignment still declaring the wait, the monitors stop
 * honoring the prose and fall through to the normal unreachable/stuck/
 * deadline verdicts: a genuinely dead member cannot hide behind a stale prose
 * sentence forever. A NEW chair assignment (different message id) re-arms
 * the window.
 */
export const PROSE_DEPENDENCY_EXEMPTION_MAX_MS = 180 * 60_000;
/**
 * G-04 retry budget: failed chair-answer attempts per supervisor signal
 * (`group_task_sup_sig_attempts:<signalId>` = count). At 3 attempts the signal
 * is closed out with a null pin + one anomaly milestone; the counter is
 * cleared on a successful chair answer.
 */
const GROUP_TASK_SUP_SIG_ATTEMPTS_PREFIX = 'group_task_sup_sig_attempts:';
/** Single-commander: failed chair-delivery attempts per host environment note. */
const GROUP_TASK_HOST_NOTE_ATTEMPTS_PREFIX = 'group_task_host_note_attempts:';
/**
 * #14 follow-up: when a worker turn already in flight lands AFTER the chair's
 * closing ceremony (so the last group message is a worker's, not the host's),
 * the chair re-posts the closing line. This kv stores the straggler message id
 * the re-assert already covered, so each straggler triggers exactly one re-post
 * (and a second tick with no new straggler stays quiet).
 */
const GROUP_TASK_REVIEW_REASSERT_KV_PREFIX = 'group_task_review_reassert:';
/**
 * Improvement #2 (v1.3): every review -> executing rework hatch (on-chain
 * [STATUS:EXECUTING] tag, RPC rework, UI Back-to-work) stamps
 * `group_task_rework_at:<taskId>` = <epochMs>. A chair [STATUS:REVIEW] tag
 * arriving within REVIEW_REENTRY_DEBOUNCE_MS of that stamp is treated as the
 * verdict of a turn already in flight when the rework landed (task #24: the
 * chair's "S4 核验通过" landed 3s after the boss's rework) and is NOT applied —
 * the task keeps the rework's executing state so the group sees exactly one
 * authoritative state directive. The chair's NEXT review verdict (after the
 * rework work actually happens) enters review cleanly. Exported so the service
 * rework paths stamp the same marker.
 */
export const GROUP_TASK_REWORK_AT_KV_PREFIX = 'group_task_rework_at:';
/**
 * Task #63: message pins whose REVIEW verdict was deliberately swallowed by
 * the rework debounce (StaleReviewReentry). JSON array, newest-last, capped.
 * The reconcile self-heal must never resurrect these — the debounce exists to
 * keep a rework's executing state authoritative (Improvement #2), and a
 * reconciler that re-applies them would reintroduce the review<->executing
 * flip. Cleared when a real review entry lands (same place the rework stamp
 * is deleted).
 */
export const GROUP_TASK_DEBOUNCED_REVIEW_PINS_KV_PREFIX = 'group_task_debounced_review_pins:';
/** Improvement #2 (v1.3): see GROUP_TASK_REWORK_AT_KV_PREFIX. In-flight chair turns finish well within this bound. */
export const REVIEW_REENTRY_DEBOUNCE_MS = 30_000;
/**
 * Improvement #2 (v1.3): clear EVERY review-delivery guard a rework hatch must
 * reset (A2A owner report, origin-session review report, closing re-assert) so
 * the next review entry re-reports on all channels. Shared by the daemon's
 * on-chain rework path and the service-side reworkGroupTask / reopenGroupTask
 * paths — previously the service paths cleared a subset (or nothing), leaving
 * the source-session report stuck at the FIRST review while the Tasks UI had
 * already moved on (task #24's review-report / executing contradiction).
 */
export function clearGroupTaskReviewDeliveryGuards(kv: GroupTaskDriverKv, taskId: number): void {
  kv.delete(`${GROUP_TASK_OWNER_REPORTED_KV_PREFIX}${taskId}`);
  kv.delete(`${GROUP_TASK_REVIEW_NOTIFIED_KV_PREFIX}${taskId}`);
  kv.delete(`${GROUP_TASK_REVIEW_REASSERT_KV_PREFIX}${taskId}`);
  // G-01: a rework hatch starts a NEW dispatch round — re-arm the
  // origin-session dispatch report so the owner hears about the re-assignments.
  kv.delete(`group_task_milestone_notified:dispatch:${taskId}`);
  // G-01: a rework IS progress — re-arm the stall anomaly for the new round.
  kv.delete(`${NO_PROGRESS_STALL_STAMP_PREFIX}${taskId}`);
  kv.delete(`group_task_milestone_notified:anomaly:${taskId}:stall`);
}

/**
 * Improvement #2 (v1.3): thrown by the STATUS-tag handler when a chair
 * [STATUS:REVIEW] tag is the stale verdict of a turn already in flight when a
 * rework hatch landed (task #24) — see GROUP_TASK_REWORK_AT_KV_PREFIX. Caught
 * by the handler's existing catch so the tag is skipped without aborting the
 * rest of the message processing.
 */
class StaleReviewReentryError extends Error {}
/** Round-4: a message failing this many consecutive ticks is dropped (cursor advances). */
const MSG_RETRY_MAX_FAILURES = 5;
/**
 * #13 join-welcome bookkeeping (handshake protocol): the first tick snapshots
 * the initially-joined member keys (create-time roster) under
 * `group_task_welcome_initial_joined:<taskId>`; any member whose joined_pin_id
 * appears LATER (esp. a remote OpenTeam member whose join just confirmed) and
 * is not yet welcomed under `group_task_welcome_done:<taskId>:<memberKey>`
 * gets ONE welcome broadcast as the chair.
 */
const WELCOME_INITIAL_JOINED_PREFIX = 'group_task_welcome_initial_joined:';
const WELCOME_DONE_PREFIX = 'group_task_welcome_done:';

/** Deliverable verification: strict formats (lowercase hex only). */
const PINID_FORMAT = /^[0-9a-f]{64}i0$/;
const TXID_FORMAT = /^[0-9a-f]{64}$/;
/** Plausible pinid/txid candidates in a [DELIVERABLE] line (incl. 0x-prefixed fakes). */
const DELIVERABLE_ID_CANDIDATE = /\b(?:0[xX][0-9a-fA-F]{2,66}|[0-9a-fA-F]{16,66}(?:i0)?)\b/g;
const MAX_VERIFICATION_CANDIDATES = 3;

/** Hard cap for the appended A2A experience/memory block. */
const EXPERIENCE_BLOCK_MAX_CHARS = 1500;
const GROUP_COGNITION_BLOCK_MAX_CHARS = 3000;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WORKER_COOLDOWN_MS = 20_000;
const DEFAULT_CHAIR_COOLDOWN_MS = 10_000;

/** Entropy P1 knobs (cognition TTL cache / worker chair-only cognition). */
interface GroupTaskEntropyP1Config {
  cognitionCache: boolean;
  workerChairOnly: boolean;
}

function parseGroupTaskEntropyP1Config(raw: string | null | undefined): GroupTaskEntropyP1Config {
  if (!raw) return { cognitionCache: true, workerChairOnly: true };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof GroupTaskEntropyP1Config, unknown>>;
    return {
      cognitionCache: typeof parsed.cognitionCache === 'boolean' ? parsed.cognitionCache : true,
      workerChairOnly: typeof parsed.workerChairOnly === 'boolean' ? parsed.workerChairOnly : true,
    };
  } catch {
    return { cognitionCache: true, workerChairOnly: true };
  }
}

const COGNITION_BLOCK_CACHE_TTL_MS = 5 * 60_000;
const COGNITION_BLOCK_CACHE_MAX_ENTRIES = 200;

/**
 * OpenTeam M2: an offline remote teammate (metabotId == null) whose latest
 * group message is older than this window counts as "unreachable" — injected
 * into the chair's turn context and reported to the owner once per streak.
 */
const DEFAULT_REMOTE_UNREACHABLE_AFTER_MS = 10 * 60_000;
/**
 * OpenTeam M2: presence probes cost an API call — at most one probe per task
 * per this interval (in-memory throttle; failed probes also throttle).
 */
const DEFAULT_REMOTE_PRESENCE_THROTTLE_MS = 60_000;
/**
 * G-01: no-progress stall window (ms). An executing task whose latest group
 * message AND latest deliverable are both older than this window reports one
 * anomaly notice to the origin session; the guard re-arms when progress
 * resumes or the task reworks.
 */
const DEFAULT_NO_PROGRESS_STALL_MS = 60 * 60_000;
/** G-01: kv stamp for the no-progress anomaly (set on report, cleared on progress). */
const NO_PROGRESS_STALL_STAMP_PREFIX = 'group_task_no_progress_stall:';
/** Task #51: kv stamp for the smaller no-progress chair nudge (one per idle episode). */
const NO_PROGRESS_NUDGE_STAMP_PREFIX = 'group_task_no_progress_nudge:';
/**
 * Task #51: idle window before the chair is nudged (via a supervisor signal)
 * to post a status update when no progress AND no in-flight turn exists —
 * the task must never sit silent for the full stall window.
 */
const DEFAULT_NO_PROGRESS_NUDGE_MS = 20 * 60_000;
/**
 * P2-7 (round 2): window (ms) in which ANY chair-bot message posted by the
 * Twin side suppresses daemon-driven chair AUTO replies (deliverable /
 * floor-control / owner-message). Covers scenarios the exact reply-pin match
 * cannot: Twin replies without a reply_pin, or Twin speech on a related but
 * different message. 0 disables the window check.
 */
const DEFAULT_CHAIR_TWIN_SUPPRESS_WINDOW_MS = 60_000;
const DEFAULT_REPLY_BUDGET = 40;
const DEFAULT_MAX_REPLIES_PER_TASK_PER_TICK = 3;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;
/** P0-2: minutes of silence before an assigned/working member is auto-marked unreachable. */
const DEFAULT_MEMBER_UNREACHABLE_AFTER_MINUTES = 30;
/** R6 L2: minutes a [WORKING] signal may be stale before the timeout re-assign hint. */
const DEFAULT_MEMBER_TIMEOUT_AFTER_MINUTES = 20;
/** R6 L3: extra minutes past the L2 timeout window before the owner is briefed. */
const DEFAULT_MEMBER_ESCALATE_AFTER_MINUTES = 10;
/** P0-3: minutes before a missing [WORKING] ACK triggers the chair reminder. */
const DEFAULT_ACK_TIMEOUT_MS = 3 * 60_000;
/** P5 (v1.2): activity window within which a worker counts as ENGAGED. */
const DEFAULT_ACK_ENGAGED_RECENT_MS = 10 * 60_000;
/** P0-4: minutes between retries of an unverified deliverable (indexer lag). */
const DEFAULT_VERIFICATION_RETRY_MS = 10 * 60_000;
/**
 * fix/group-task-flow: hard cap for a plain-LLM group-task turn (no tool
 * loop). A wedged provider request aborts into the retry path instead of
 * hanging the turn forever.
 */
const DEFAULT_PLAIN_TURN_TIMEOUT_MS = 10 * 60_000;
/**
 * fix/group-task-flow (task #51 feedback): host-side liveness reporting for
 * long turns. Speedup R-01 rework: an executing member must NOT post
 * check-in messages — in the EP28 sample 46 of 96 group messages were these
 * host-posted heartbeat lines, and they were the single largest time cost
 * (each post also fed back through the protocol parsers). The liveness
 * lease the watchdogs honor is now renewed INTERNALLY (no group message);
 * the only visible emission is ONE reminder addressed to the chair when a
 * turn exceeds DEFAULT_LONG_TURN_CHAIR_REMINDER_MS (the member is not
 * expected to reply). Setting longTurnPlaceholderMs / longTurnHeartbeatMax
 * above 0 restores the legacy visible posts (kept for tests and rollout
 * debugging). Real timers (not the daemon clock): the fake test clock must
 * not fire them.
 */
const DEFAULT_LONG_TURN_PLACEHOLDER_MS = 0;
const DEFAULT_LONG_TURN_HEARTBEAT_MS = 10 * 60_000;
const DEFAULT_LONG_TURN_HEARTBEAT_MAX = 0;
/**
 * Speedup R-01: turn-runtime threshold for the single @chair reminder
 * (default 18 min, inside the requirement's 15-20 min band). 0 disables.
 */
const DEFAULT_LONG_TURN_CHAIR_REMINDER_MS = 18 * 60_000;
/**
 * The internal liveness lease first kicks in once a turn has run this long
 * (the legacy placeholder threshold) — arming it at dispatch would mask a
 * genuinely unresponsive member from the no-ACK watch.
 */
const LONG_TURN_LEASE_ARM_MS = 90_000;

// ---------------------------------------------------------------------------
// Pure gating (exported for tests)
// ---------------------------------------------------------------------------

export interface GroupTaskDaemonMessage {
  id: number;
  pinId: string | null;
  txId?: string | null;
  senderMetaId: string;
  senderGlobalMetaId: string | null;
  senderName: string;
  content: string;
  chainTimestamp?: number | null;
  replyPin?: string | null;
  /** Raw mention column (JSON array string). */
  mention: string | null;
  /**
   * Round-4 attribution: true when the chain-signature GlobalMetaID is missing
   * or is neither a task member nor the owner. Such messages must never be
   * attributed by senderName, never trigger replies, and never contribute
   * deliverables.
   */
  senderSuspect?: boolean;
}

export interface GroupTaskDaemonTask {
  id: number;
  status: string;
  /**
   * HITL: true while the task has an open human checkpoint. Responder gating
   * treats this exactly like the review phase (workers silent, chair talks to
   * the owner only). Populated by the daemon loop per message.
   */
  hasOpenCheckpoint?: boolean;
  /**
   * G-04: true while a supervisor pause holds dispatch (dispatch_paused_at
   * set). The chair stops auto-replying except to the owner — no new
   * assignments leave the group until an owner-confirmed resume. Workers keep
   * answering already-posted mentions (in-flight work), which cannot create
   * new dispatches because only the chair dispatches.
   */
  dispatchPaused?: boolean;
}

export interface GroupTaskDaemonMember {
  metabotId: number | null;
  globalmetaid: string | null;
  role: 'chair' | 'worker';
  name: string | null;
}

export interface GroupTaskDaemonBot {
  id: number;
  name: string;
  metaid: string;
  globalmetaid: string | null;
  boss_global_metaid?: string | null;
}

export interface GroupTaskResponderDecision {
  metabotId: number;
  reason:
    | 'worker_mentioned'
    | 'chair_mentioned'
    | 'chair_owner_message'
    | 'chair_deliverable'
    | 'chair_floor_control';
}

/** Full bot shape used inside the daemon (gating + prompts + llm config). */
interface GroupTaskDaemonBotFull extends GroupTaskDaemonBot {
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  background?: string | null;
  llm_id?: string | null;
  fallback_llm_id?: string | null;
  allow_chat_skills?: string[] | null;
}

/** Prompt roster entry (structurally matches GroupTaskPromptMember). */
type DaemonPromptMember = {
  name: string;
  role: 'chair' | 'worker';
  globalMetaId?: string | null;
  bio?: string | null;
  roleProfile?: string | null;
  goal?: string | null;
  /** OpenTeam remote teammate: no local bot row; replies come from its own machine. */
  remote?: boolean;
};

// Mention gating (contentMentionsBotName / mentionContainsMetaId / isMentioned)
// lives in groupChatMentionUtils.ts, shared with the OpenTeam guest daemon.

/**
 * Decide which local member bots respond to one group message.
 * - Never: the author itself (by sender_global_metaid), empty content, terminal tasks.
 * - Human-gate phases (status === 'review' OR an open HITL checkpoint): workers
 *   NEVER respond (even when mentioned); the chair responds ONLY to owner
 *   messages. No floor-control, deliverable, or mention triggers in a human-gate
 *   phase (hard silence against gratitude loops).
 * - Worker: only when @-mentioned (mention array hit or display name in content).
 * - Chair: when (a) @-mentioned, (b) the message is from the owner (sender matches the
 *   chair bot's boss_global_metaid), (c) a [DELIVERABLE] tag appears, or (d) the
 *   message is not addressed to any specific member (floor-control duty). A message
 *   addressed only to another member (exactly one worker hit, chair not hit) keeps
 *   the chair silent unless (b)/(c) apply.
 */
export function decideGroupTaskResponders(
  message: GroupTaskDaemonMessage,
  task: GroupTaskDaemonTask,
  members: GroupTaskDaemonMember[],
  botsById: Map<number, GroupTaskDaemonBot>,
  options: { entropyFloorGate?: boolean } = {},
): GroupTaskResponderDecision[] {
  const decisions: GroupTaskResponderDecision[] = [];
  const content = (message.content ?? '').trim();
  if (!content) return decisions;
  if (task.status === 'done' || task.status === 'cancelled') return decisions;
  // Round-4 attribution: a SUSPECT sender (chain GlobalMetaID neither a task
  // member nor the owner) never triggers replies. The owner is exempt from the
  // suspect flag, so owner messages still reach the chair.
  if (message.senderSuspect) return decisions;
  // HITL: an open human checkpoint pauses the task exactly like the review
  // phase — the group waits for the owner's decision, not for more work.
  const isHumanGatePhase = task.status === 'review' || task.hasOpenCheckpoint === true;

  const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
  const isSelf = (bot: GroupTaskDaemonBot): boolean =>
    Boolean(senderGlobalMetaId)
    && Boolean(bot.globalmetaid?.trim())
    && senderGlobalMetaId === bot.globalmetaid!.trim();

  // Resolve mention/name hits once per member.
  const hits = new Map<number, boolean>();
  for (const member of members) {
    if (member.metabotId == null) continue;
    const bot = botsById.get(member.metabotId);
    if (!bot) continue;
    hits.set(member.metabotId, isMentioned(message, bot));
  }

  const chairMember = members.find((member) => member.role === 'chair');
  const chairHit = chairMember?.metabotId != null ? hits.get(chairMember.metabotId) === true : false;
  const workerHitCount = members.filter(
    (member) => member.role === 'worker'
      && member.metabotId != null
      && hits.get(member.metabotId) === true,
  ).length;
  const addressedToSpecificMember = workerHitCount > 0 || chairHit;
  const hasDeliverable = hasDeliverableTagLine(content);

  for (const member of members) {
    if (member.metabotId == null) continue;
    const bot = botsById.get(member.metabotId);
    if (!bot) continue;
    if (isSelf(bot)) continue;

    const mentioned = hits.get(member.metabotId) === true;

    if (member.role === 'worker') {
      // Human-gate phases (review / open HITL checkpoint): workers never
      // respond, even when @-mentioned.
      if (!isHumanGatePhase && mentioned) {
        decisions.push({ metabotId: member.metabotId, reason: 'worker_mentioned' });
      }
      continue;
    }

    // chair
    const bossGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
    const isOwnerMessage = Boolean(
      senderGlobalMetaId && bossGlobalMetaId && senderGlobalMetaId === bossGlobalMetaId,
    );
    // G-04: supervisor pause holds dispatch — the chair auto-replies only to
    // the owner (resume dialogue) while paused; floor-control, mentions, and
    // deliverable turns resume after the owner-confirmed resume.
    if (task.dispatchPaused === true) {
      if (isOwnerMessage) {
        decisions.push({ metabotId: member.metabotId, reason: 'chair_owner_message' });
      }
      continue;
    }
    if (isHumanGatePhase) {
      // Human-gate phases: the chair responds only to the owner (acceptance /
      // checkpoint dialogue).
      if (isOwnerMessage) {
        decisions.push({ metabotId: member.metabotId, reason: 'chair_owner_message' });
      }
      continue;
    }
    if (mentioned) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_mentioned' });
      continue;
    }
    if (isOwnerMessage) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_owner_message' });
      continue;
    }
    // Task #51: the literal "@chair" role alias from a non-owner member (the
    // self-send guard above already filtered the chair's own notices, which
    // carry the alias in their body).
    if (CHAIR_ALIAS_RE.test(content)) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_mentioned' });
      continue;
    }
    if (hasDeliverable) {
      decisions.push({ metabotId: member.metabotId, reason: 'chair_deliverable' });
      continue;
    }
    if (!addressedToSpecificMember) {
      // Entropy P0 floor gate: a ceremony-shaped ACK from a worker
      // ([WORKING]/[STANDBY], no question) never warrants a chair LLM turn —
      // the missing-ACK/timeout monitors track those tags deterministically.
      // A real question inside the line still reaches the chair (guard in
      // isCeremonyAckLine), and @-mention/owner/deliverable paths above are
      // untouched.
      if (options.entropyFloorGate !== false) {
        const senderIsWorker = members.some((candidate) =>
          candidate.role === 'worker'
          && Boolean(senderGlobalMetaId)
          && (candidate.globalmetaid ?? '').trim() === senderGlobalMetaId,
        );
        if (senderIsWorker && isCeremonyAckLine(content)) {
          continue;
        }
      }
      decisions.push({ metabotId: member.metabotId, reason: 'chair_floor_control' });
    }
  }

  return decisions;
}

export interface PlanningCoverage {
  ok: boolean;
  /** Worker names mentioned/assigned in the plan text. */
  mentionedWorkers: string[];
  /** Worker names NOT mentioned at all. */
  unmentionedWorkers: string[];
}

/**
 * Advisory mention scan for the chair auto-plan. Unmentioned seats are idle
 * on purpose (one bot per coarse seat). Never blocks posting. Pure + exported.
 */
export function checkPlanningCoverage(reply: string, workerNames: string[]): PlanningCoverage {
  const text = String(reply ?? '');
  const mentioned = workerNames.filter((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return text.includes(trimmed) || text.includes(`@${trimmed}`);
  });
  const unmentioned = workerNames.filter((name) => !mentioned.includes(name));
  return { ok: true, mentionedWorkers: mentioned, unmentionedWorkers: unmentioned };
}

/**
 * Map worker names that the chair's dispatch text addresses to their
 * globalMetaIds, for the mention array on the outgoing group pin. The daemon
 * wake-up gate (`isMentioned`) honors the mention array, so an auto-generated
 * dispatch wakes the assigned workers even when the LLM wrote bare names
 * instead of explicit `@Name` tokens. Pure + exported for unit tests.
 */
export function resolveMentionIdsForWorkers(
  members: Array<{ role: string; name?: string | null; globalmetaid?: string | null }>,
  mentionedNames: string[],
): string[] {
  const wanted = new Set(
    mentionedNames.map((name) => name.trim().toLowerCase()).filter(Boolean),
  );
  if (wanted.size === 0) return [];
  const ids: string[] = [];
  for (const member of members) {
    if (member.role !== 'worker') continue;
    const name = (member.name ?? '').trim().toLowerCase();
    const gmid = (member.globalmetaid ?? '').trim();
    if (!name || !gmid || !wanted.has(name)) continue;
    if (!ids.includes(gmid)) ids.push(gmid);
  }
  return ids;
}

/**
 * F1 (GT#11): deterministic signature of the ACTIVE member roster as seen by
 * the chair planning turn. Any member add / remove / role change produces a
 * new signature, so the planning-turn settle gate can detect a roster that is
 * still forming mid-create (the task row + chair member are persisted first,
 * then each worker joins with network-bound calls). Pure + exported for unit
 * tests.
 */
export function buildRosterSignature(members: Array<{
  role: string;
  name?: string | null;
  displayName?: string | null;
  globalmetaid?: string | null;
  metabotId?: number | null;
}>): string {
  return members
    .map((member) => {
      const name = (member.name ?? member.displayName ?? '').trim();
      const gmid = (member.globalmetaid ?? '').trim();
      const id = member.metabotId ?? '';
      return `${member.role}|${name}|${gmid}|${id}`;
    })
    .sort()
    .join(';');
}

/** Minimal kv surface needed by the driver-claim helpers. */
export interface GroupTaskDriverKv {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

/** Outcome of tryAcquireGroupTaskDriver. */
export interface AcquireGroupTaskDriverResult {
  ok: boolean;
  /** Claim holder identity when rejected (null when acquired). */
  driverId: string | null;
  /** Claim age in ms when rejected. */
  claimAgeMs: number;
  /** ms to wait before retrying (grace minus claim age). */
  retryAfterMs: number;
}

/**
 * F2 (GT#11): shared driver-claim acquisition used by BOTH the daemon tick
 * (claimDriverOrYield) and the manual RPC send path. Semantics (heartbeat
 * claim, kv `group_task_driver:<taskId>` = `<claimId>|<epochMs>`):
 * - no claim -> acquire;
 * - own claim -> ok (refreshOwn=false keeps the claim age-based so the daemon
 *   holds it only while it actually drives; refreshOwn=true extends it);
 * - foreign claim younger than the grace window -> rejected (mutual exclusion);
 * - stale foreign claim -> take over.
 * Pure + exported for unit tests.
 */
export function tryAcquireGroupTaskDriver(
  kv: GroupTaskDriverKv,
  taskId: number,
  claimId: string,
  graceMs: number,
  nowMs: number,
  refreshOwn = true,
): AcquireGroupTaskDriverResult {
  const key = `${GROUP_TASK_DRIVER_KV_PREFIX}${taskId}`;
  const raw = kv.get<string>(key);
  if (!raw) {
    kv.set(key, `${claimId}|${nowMs}`);
    return { ok: true, driverId: null, claimAgeMs: 0, retryAfterMs: 0 };
  }
  const [ownerId, atText] = raw.split('|');
  const atMs = Number(atText) || 0;
  if (ownerId === claimId) {
    if (refreshOwn) {
      kv.set(key, `${claimId}|${nowMs}`); // refresh our own lease
    }
    return { ok: true, driverId: null, claimAgeMs: 0, retryAfterMs: 0 };
  }
  const ageMs = nowMs - atMs;
  if (ageMs < graceMs) {
    return { ok: false, driverId: ownerId, claimAgeMs: Math.max(0, ageMs), retryAfterMs: Math.max(0, graceMs - ageMs) };
  }
  kv.set(key, `${claimId}|${nowMs}`); // stale claim -> take over
  return { ok: true, driverId: null, claimAgeMs: 0, retryAfterMs: 0 };
}

/** Input of gateChairDrivingSend. */
export interface GateChairDrivingSendInput {
  kv: GroupTaskDriverKv;
  taskId: number;
  /** Resolved sender metabot id of the outgoing message. */
  senderMetabotId: number;
  /** Chair metabot id of the task (driving sends are chair-identity sends). */
  chairMetabotId: number;
  /**
   * Optional per-session driver identity supplied by the caller (e.g. the
   * Twin session id). Sessions that pass the same id refresh each other's
   * claim; sessions with DIFFERENT ids are mutually exclusive. Defaults to
   * `rpc:<chairMetabotId>` when omitted.
   */
  driverId?: string;
  graceMs: number;
  nowMs: number;
}

/**
 * F2 (GT#11): session-level driving mutex for the manual send path. Worker /
 * owner messages are never driving and always pass. A CHAIR-identity message
 * (plan / dispatch / status switch) participates in the driver claim: it is
 * rejected with a readable error while another session holds a fresh claim
 * (e.g. the daemon auto-driver is mid-turn), and it takes the claim otherwise
 * (the daemon then yields its ticks while the manual claim stays fresh).
 * Pure + exported for unit tests.
 */
export function gateChairDrivingSend(input: GateChairDrivingSendInput):
  { ok: true } | { ok: false; error: string; retryAfterMs: number; driverId: string } {
  if (input.senderMetabotId !== input.chairMetabotId) {
    return { ok: true };
  }
  const claimId = (input.driverId ?? '').trim() || `rpc:${input.chairMetabotId}`;
  const result = tryAcquireGroupTaskDriver(input.kv, input.taskId, claimId, input.graceMs, input.nowMs);
  if (!result.ok) {
    const holder = result.driverId ?? 'unknown';
    return {
      ok: false,
      driverId: holder,
      retryAfterMs: result.retryAfterMs,
      error:
        `Task ${input.taskId} is being driven by another session (${holder.slice(0, 12)}…) — ` +
        `the driver claim is ${Math.round(result.claimAgeMs / 1000)}s old; retry in ` +
        `${Math.ceil(result.retryAfterMs / 1000)}s or wait for the active driver to yield ` +
        `(same-session sends pass driver_id to keep driving) ` +
        `(grace window ${Math.round(input.graceMs / 1000)}s)`,
    };
  }
  return { ok: true };
}

/** Input of gateExternalChairSend. */
export interface GateExternalChairSendInput {
  taskId: number;
  /** Resolved sender metabot id of the outgoing RPC message. */
  senderMetabotId: number;
  /** Chair metabot id of the task. */
  chairMetabotId: number;
  /** The caller explicitly passed confirm_chair: true. */
  confirmChair: boolean;
}

/**
 * P2 (v1.1): impersonation guard for EXTERNAL (RPC) chair-identity sends.
 *
 * Task #21 evidence: the Twin's source CoWork session watched the running
 * task via `show`, disagreed with the daemon-driven chair session's ruling,
 * and posted an "authoritative clarification" INTO the group through this RPC
 * as the chair (pin 33484c72; the skill script even retried around the F2
 * driver mutex until the daemon's claim went stale mid-long-turn). The chair
 * task session then saw a message in its own name it never wrote and posted a
 * counter-ruling — two AI_Sunny voices fighting, the human's baseline lost.
 *
 * The chain signature cannot distinguish host-daemon posts from external
 * RPC posts (same bot wallet), so the guard lives at the RPC boundary: a
 * chair-identity send on a runnable task (all of them — terminal tasks
 * reject earlier) requires an EXPLICIT confirm_chair:true escape hatch.
 * Worker sends and daemon-internal posts (postGroupTaskMessage called
 * in-process by the daemon) are unaffected. Pure + exported for unit tests.
 */
export function gateExternalChairSend(input: GateExternalChairSendInput):
  { ok: true } | { ok: false; code: 'CHAIR_IDENTITY_CONFIRM_REQUIRED'; error: string } {
  if (input.senderMetabotId !== input.chairMetabotId || input.confirmChair) {
    return { ok: true };
  }
  return {
    ok: false,
    code: 'CHAIR_IDENTITY_CONFIRM_REQUIRED',
    error:
      `Refusing to post as the chair of task ${input.taskId}: ` +
      'an external chair-identity message contradicts the daemon-driven chair session and reads ' +
      'as impersonation to the whole group (task #21 incident). ' +
      'Steer the task as the OWNER in the task UI, or pass "confirm_chair": true when the human ' +
      'EXPLICITLY asked you to take the chair floor manually.',
  };
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

export interface GroupTaskDaemonSqliteStoreLike {
  getDatabase(): Database;
  getSaveFunction(): () => void;
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

export type GroupTaskDaemonPerformChatFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    llmProvider?: string | null;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: 'off' | 'low' | 'high' | 'max' | null;
    fallbackEffort?: 'off' | 'low' | 'high' | 'max' | null;
    thinking?: 'enabled' | 'disabled';
    /** fix/group-task-flow: abort the request when a plain-LLM turn wedges. */
    signal?: AbortSignal;
    /** Per-attempt timeout: primary and fallback each get a fresh window. */
    attemptTimeoutMs?: number;
  },
) => Promise<string>;

export type GroupTaskDaemonSendFn = (
  taskId: number,
  metabotId: number,
  content: string,
  opts?: { replyPin?: string; mention?: string[] },
) => Promise<{ pinId: string }>;

/** Narrow skill-routing seam (mirrors how privateChatDaemon calls skillManager). */
export type GroupTaskDaemonSkillRoutingFn = (input: {
  metabotId?: number | null;
  widened?: boolean;
}) =>
  | { prompt: string | null; activeSkillIds: string[] }
  | Promise<{ prompt: string | null; activeSkillIds: string[] }>;

/** Narrow skill-turn seam: runs one skill turn inside an existing session. */
export type GroupTaskDaemonRunSkillTurnFn = (params: {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  activeSkillIds: string[];
}) => Promise<{ replyText: string; assistantMessageId?: string | null }>;

export type GroupTaskDaemonTaskEvent =
  | {
    type: 'groupTask:statusChanged';
    taskId: number;
    status: string;
    at: number;
  }
  | {
    type: 'groupTask:ownerReportDelivery';
    taskId: number;
    outcome: 'sent' | 'failed';
    pinId?: string | null;
    sessionId?: string | null;
    displayError?: string | null;
    error?: string | null;
    /** 'review' (default) = the acceptance report; 'checkpoint' = a HITL checkpoint request. */
    kind?: 'review' | 'checkpoint';
    checkpointId?: number | null;
    at: number;
  }
  | {
    /** HITL: a checkpoint was opened/resolved so the UI can refresh the detail view. */
    type: 'groupTask:checkpointChanged';
    taskId: number;
    checkpointId: number;
    status: 'open' | 'resolved';
    at: number;
  }
  | {
    /**
     * Snapshot of the daemon's in-flight turns (one MetaBot background turn
     * per entry) after any change; drives the sidebar background-task badge so
     * the owner can see bots working instead of wondering about silence.
     */
    type: 'groupTask:turnActivityChanged';
    turns: GroupTaskTurnActivityEntry[];
    at: number;
  };

/** One in-flight MetaBot group-task background turn (a detached reply/chair job). */
export interface GroupTaskTurnActivityEntry {
  taskId: number;
  metabotId: number;
  startedAt: number;
}

/** On-chain existence check for deliverable verification (main.ts wires getPinData). */
export type GroupTaskDaemonReadPinFn = (
  pinId: string,
) => Promise<'found' | 'not_found' | 'unavailable'>;

/** Private A2A report from the chair bot to the owner (encrypted simplemsg in main.ts). */
export interface GroupTaskOwnerReportDeliveryResult {
  pinId?: string | null;
  sessionId?: string | null;
  displayError?: string | null;
}

export type GroupTaskDaemonSendOwnerReportFn = (params: {
  taskId: number;
  metabotId: number;
  ownerGlobalMetaId: string;
  text: string;
  /** 'review' (default) = acceptance report; 'checkpoint' = HITL checkpoint request. */
  kind?: 'review' | 'checkpoint';
  checkpointId?: number;
}) => Promise<GroupTaskOwnerReportDeliveryResult>;

/** Narrow memory read (owner scope, created status) for the A2A experience block. */
export type GroupTaskDaemonListUserMemoriesFn = (
  metabotId: number,
  input: { usageClass: 'self_identity' | 'value_boundary' | 'work_review'; limit: number },
) => Array<{ text: string }>;

/** Recent dream summaries for the A2A experience block. */
export type GroupTaskDaemonListDailySummariesFn = (
  metabotId: number,
  limit: number,
) => Array<{ summaryDate: string; summaryText: string }>;

/**
 * Round-4 attribution: resolve a chain-signature LEGACY metaid to its
 * GlobalMetaID (wired to manapi /api/info/metaid/{metaid} in main.ts). The
 * chain signature is the ONLY identity source for group-task attribution;
 * null when the signature cannot be resolved (message becomes SUSPECT).
 */
export type GroupTaskDaemonResolveGlobalMetaIdFn = (
  legacyMetaId: string,
) => Promise<string | null>;

/**
 * Round-4 deliverable link probe: returns the HTTP status of a key https://
 * deliverable link (HEAD with GET fallback, ~8s bound). null = unavailable.
 * Tests inject a fake; production uses the built-in fetch probe.
 */
export type GroupTaskDaemonProbeUrlFn = (url: string) => Promise<number | null>;

/**
 * OpenTeam M2: online-presence probe for remote teammates (wired to
 * IdchatPresenceService.fetchOnlineStatus in main.ts). One entry per queried
 * GlobalMetaID; a peer with no entry (or isOnline=false) counts as offline.
 */
export interface GroupTaskRemotePresenceEntry {
  globalMetaId: string;
  isOnline: boolean;
  /** Seconds since the peer was last seen online (0/negative = unknown). */
  lastSeenAgoSeconds: number;
}

export type GroupTaskDaemonFetchRemotePresenceFn = (
  globalMetaIds: string[],
) => Promise<GroupTaskRemotePresenceEntry[]>;

export interface GroupTaskDaemonDeps {
  getStore: () => GroupTaskDaemonSqliteStoreLike;
  getGroupTaskStore: () => GroupTaskStore;
  getMetabotStore: () => MetabotStore;
  getCoworkStore: () => CoworkStore;
  /**
   * P1-3: OpenTeam invite store. When wired, the chair planning directive
   * carries the task's pending invites / unconfirmed remote placeholders so
   * the plan never re-decomposes "search + invite" as a subtask after the
   * chair already invited someone. Unwired = the directive stays as before.
   */
  getOpenTeamMembershipStore?: () => OpenTeamMembershipStore;
  orchestrationBridge?: GroupTaskOrchestrationBridge;
  performChat: GroupTaskDaemonPerformChatFn;
  postGroupTaskMessage: GroupTaskDaemonSendFn;
  getChatSkillsRoutingPrompt?: GroupTaskDaemonSkillRoutingFn;
  runSkillTurn?: GroupTaskDaemonRunSkillTurnFn;
  emitTaskEvent?: (payload: GroupTaskDaemonTaskEvent) => void;
  readPinForVerification?: GroupTaskDaemonReadPinFn;
  /** P0-4: secondary indexer (metafile-indexer) for multi-source pin verification. */
  readPinSecondaryForVerification?: GroupTaskDaemonReadPinFn;
  resolveGlobalMetaId?: GroupTaskDaemonResolveGlobalMetaIdFn;
  probeUrl?: GroupTaskDaemonProbeUrlFn;
  /**
   * OpenTeam M2: presence probe for remote-teammate unreachable detection.
   * Unwired = the feature stays off (no prompt injection, no owner alert).
   */
  fetchRemotePresence?: GroupTaskDaemonFetchRemotePresenceFn;
  /** Silence window (ms) after which an offline remote teammate is unreachable. */
  remoteUnreachableAfterMs?: number;
  /** Per-task minimum interval (ms) between presence probes. */
  remotePresenceThrottleMs?: number;
  sendOwnerPrivateReport?: GroupTaskDaemonSendOwnerReportFn;
  /**
   * P1-2: stop a stuck LOCAL worker cowork session (abort the in-flight turn;
   * the working directory and on-disk artifacts are preserved). Wired to
   * CoworkRunner.stopSession in production. Unwired = the stuck-session
   * reclaim only marks state and briefs the chair.
   */
  stopWorkerSession?: (sessionId: string) => void;
  /**
   * Task #60: true while the cowork runner still holds a live turn handle for
   * the session (wired to CoworkRunner.isSessionActive in main.ts). The
   * skill-turn watchdog latch uses it to distinguish a genuinely terminated
   * turn from a transient 'error' status read (the bridge stamps 'error' at
   * the watchdog fire while the runner keeps executing the turn). Unwired =
   * the latch falls back to status-only release.
   */
  isCoworkSessionActive?: (sessionId: string) => boolean;
  /**
   * P4 (v1.2): inject the review-stage owner report (same body the A2A
   * private chat receives) into the task's origin CoWork session under the
   * [GROUP_TASK_REVIEW] prefix. Best-effort; kv-guarded per review-entry.
   * Improvement #1: `conclusion` is the extracted 【结论】 verdict — when
   * present the notice collapses to verdict + pointer to the acceptance card.
   */
  sendReviewReportToSourceSession?: (input: {
    taskId: number;
    report: string;
    conclusion: string | null;
  }) => void;
  /**
   * G-01: deliver a milestone notice (created / first dispatch / HITL
   * checkpoint / anomaly) into the task's origin CoWork session. Best-effort;
   * kv-guarded per node on the service side, so a delivery failure simply
   * retries on the next trigger.
   */
  sendMilestoneToSourceSession?: (input: {
    taskId: number;
    kind: 'created' | 'dispatch' | 'checkpoint' | 'anomaly';
    message: string;
    subject?: string | null;
  }) => boolean;
  /** G-01: no-progress stall window before the anomaly notice (default 60 min). */
  noProgressStallMs?: number;
  /** Task #51: idle window before the chair is nudged for a status update (default 20 min). */
  noProgressNudgeMs?: number;
  /** Task #51: chair-response redrive window (default 4 min). */
  chairResponseRedriveMs?: number;
  listUserMemories?: GroupTaskDaemonListUserMemoriesFn;
  listDailySummaries?: GroupTaskDaemonListDailySummariesFn;
  getMetaIDGroupCognitionPromptBlock?: (input: {
    observerGlobalMetaID: string;
    roster: Array<{ globalMetaID: string | null; name: string; role: 'chair' | 'worker' }>;
  }) => string | Promise<string>;
  experienceStore?: MetaIDExperienceStore;
  /** Fleet-shared culture block (glossary/conventions/lessons) injected into
   * the volatile turn tail and the planning directive; null when empty. */
  buildTeamCultureBlock?: () => string | null;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  /** Tick watchdog window (ms) — see DEFAULT_TICK_WATCHDOG_MS. */
  tickWatchdogMs?: number;
  /** GT-01: absolute wall-clock cap (ms) for one in-flight turn guard — the
   * last-resort force-settle for an await that never rejects (default: the
   * 45-min latch cap). */
  turnHardCapMs?: number;
  workerCooldownMs?: number;
  chairCooldownMs?: number;
  replyBudget?: number;
  maxRepliesPerTaskPerTick?: number;
  contextMessageCount?: number;
  /**
   * P2-7 (round 2): window (ms) during which any Twin-side chair message
   * suppresses daemon chair AUTO replies. Defaults to
   * DEFAULT_CHAIR_TWIN_SUPPRESS_WINDOW_MS.
   */
  chairTwinSuppressWindowMs?: number;
  /**
   * P1-5 (round 2): opt-out — the Twin chair leads the group via its own
   * kickoff; the daemon never runs the auto planning turn for new tasks.
   */
  disableChairPlanningTurn?: boolean;
  /**
   * F1 (GT#11): how long (ms) the member roster must stay unchanged before the
   * chair planning turn may fire for a new task. Guards against planning
   * mid-create with a half-formed roster. 0 disables the settle gate.
   * Default DEFAULT_CHAIR_PLAN_ROSTER_SETTLE_MS.
   */
  chairPlanRosterSettleMs?: number;
  /**
   * F1 (GT#11): absolute cap (ms from task creation) — planning proceeds even
   * if the roster never settles. Default DEFAULT_CHAIR_PLAN_ROSTER_CAP_MS.
   */
  chairPlanRosterCapMs?: number;
  /**
   * P0-2 (round 5): host auto-ACK for worker dispatches that will run a skill
   * turn — posts `[WORKING] 已接单…` BEFORE the (potentially long) turn so the
   * group never sees a silent worker (Eleven-style 11-min silence). Default ON.
   */
  /**
   * P2-6 (round 5): bounded wait for a `[DEPENDS_ON: <pinid>]` upstream
   * deliverable before dispatching the worker (default 15 min).
   */
  dependencyWaitMaxMs?: number;
  /**
   * P2-8 (round 5): multi-driver mutex grace. A driver claim younger than this
   * window belongs to another daemon instance; this instance yields. Default
   * DEFAULT_DRIVER_GRACE_MS. 0 disables the mutex entirely.
   */
  driverGraceMs?: number;
  /**
   * P0-2: minutes of silence before an assigned/working member is auto-marked
   * unreachable (default 30).
   */
  memberUnreachableAfterMinutes?: number;
  /** R6 L2: minutes a [WORKING] signal may be stale before the timeout re-assign hint (default 20). */
  memberTimeoutAfterMinutes?: number;
  /** R6 L3: extra minutes past the L2 window before the owner is briefed (default 10). */
  memberEscalateAfterMinutes?: number;
  /** P0-3: ms before a missing [WORKING] ACK triggers the chair reminder (default 3 min). */
  ackTimeoutMs?: number;
  /** P5 (v1.2): engaged-activity window override (default 10 min). */
  ackEngagedRecentMs?: number;
  /** P0-4: ms between retries of an unverified deliverable (default 10 min). */
  verificationRetryMs?: number;
  /**
   * fix/group-task-flow: hard timeout (ms) for plain-LLM group-task turns
   * (default 10 min). The abort rejects into the bounded retry path.
   */
  plainTurnTimeoutMs?: number;
  /**
   * fix/group-task-flow: long-turn liveness reporting cadence — placeholder
   * delay (ms), heartbeat interval (ms) and max heartbeat count per turn.
   * Speedup R-01: ALL THREE default to off (0) — an executing member no longer
   * posts check-in messages; the liveness lease is renewed internally instead.
   * Set them above 0 to restore the legacy visible posts (tests do this).
   * `longTurnChairReminderMs` (default 18 min, 0 disables) is the threshold
   * for the single @chair reminder post per long turn.
   */
  longTurnPlaceholderMs?: number;
  longTurnHeartbeatMs?: number;
  longTurnHeartbeatMax?: number;
  longTurnChairReminderMs?: number;
  /**
   * Turn-runtime (ms) after which the INTERNAL liveness lease starts renewing
   * (default 90s — the legacy placeholder threshold). Arming earlier would
   * mask a genuinely unresponsive member from the no-ACK watch. Tests shrink
   * this to observe the internal renewal without waiting.
   */
  longTurnLeaseArmMs?: number;
  /**
   * Ledger fix (#14→#16): upload a LOCAL file deliverable on-chain as a
   * metafile paid by the author bot's wallet, so a worker's local file path
   * becomes verifiable chain evidence. Same seam the OpenTeam guest daemon
   * uses (metaFileUploadService.uploadMetaFile). Unwired = text deliverables
   * are recorded as-is (no on-chain upgrade). The result carries the uploaded
   * bytes' sha256 as `contentHash` (P2 same-bytes dedupe) when the direct
   * upload path computed it.
   */
  uploadDeliverableFile?: (input: {
    metabotId: number;
    filePath: string;
    contentType?: string;
  }) => Promise<Record<string, unknown>>;
  /**
   * MetaWeb URI convention: a local deliverable that is a readable text
   * document (Markdown / plain text) is published as a simplenote pin
   * (/protocols/simplenote) instead of a /file metafile, so the ledger
   * records pin://<pinId> — metafile:// is reserved for binary payloads.
   * Wired to deliverableTextNote.publishTextFileAsNote in main.ts.
   * Unwired (or returning null) = text documents fall back to the metafile
   * upload path above.
   */
  publishTextDeliverable?: (input: {
    metabotId: number;
    filePath: string;
    contentType?: string;
  }) => Promise<{ pinId?: string } | null | undefined>;
}

export interface GroupTaskDaemonLoop {
  runTick(): Promise<void>;
  /** Resolves when every turn job dispatched so far has settled (tests / shutdown). */
  whenIdle(): Promise<void>;
  /** Snapshot of the in-flight background turns (for the sidebar badge IPC). */
  getTurnActivity(): GroupTaskTurnActivityEntry[];
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

interface GroupChatMessageRow {
  id: number;
  pin_id: string | null;
  tx_id: string | null;
  sender_metaid: string | null;
  sender_global_metaid: string | null;
  sender_name: string | null;
  content: string | null;
  mention: string | null;
  chain_timestamp: number | null;
  reply_pin: string | null;
  sender_suspect?: number | null;
}

function mapMessageRows(result: ReturnType<Database['exec']>): GroupChatMessageRow[] {
  if (!result[0]?.values?.length) return [];
  const columns = result[0].columns as string[];
  return result[0].values.map((values) => {
    const row: Record<string, unknown> = {};
    columns.forEach((col, index) => {
      row[col] = values[index];
    });
    return row as unknown as GroupChatMessageRow;
  });
}

/** sqlite datetime('now') strings are UTC 'YYYY-MM-DD HH:MM:SS'. */
function parseSqliteUtcMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
}

function toDaemonMessage(row: GroupChatMessageRow): GroupTaskDaemonMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    txId: row.tx_id ?? null,
    senderMetaId: (row.sender_metaid ?? '').trim(),
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderName: (row.sender_name ?? '').trim() || 'Unknown',
    content: (row.content ?? '').trim(),
    mention: row.mention ?? null,
    chainTimestamp: row.chain_timestamp ?? null,
    replyPin: row.reply_pin ?? null,
    senderSuspect: Number(row.sender_suspect ?? 0) === 1,
  };
}

/**
 * P1-4: resolve a chair message's [DEPENDS_ON] reference to the upstream
 * assignment the worker ACKed. Returns:
 * - null: the message is NOT a derived assignment (no [DEPENDS_ON] tag);
 * - '' (falsy): derived assignment whose upstream cannot be verified as ACKed
 *   (descriptive reference, pinid not found in this group's messages, or the
 *   upstream message has no ack-seen) → the caller starts a normal watch;
 * - a pinid: derived assignment whose upstream message IS ack-seen → the
 *   caller inherits the upstream ACK and starts no new watch.
 */
export function resolveDerivedAssignmentUpstream(
  task: GroupTask,
  message: { content: string | null },
  sqlite: GroupTaskDaemonSqliteStoreLike,
): string | null {
  const content = (message.content ?? '').trim();
  const match = DEPENDS_ON_TAG.exec(content);
  if (!match) return null;
  const token = match[1].trim();
  const tokenPin = token.match(/^[0-9a-f]{64}i0$/i)?.[0]?.toLowerCase() ?? null;
  if (!tokenPin || !task.groupId) return '';
  let upstreamMessageId: number | null = null;
  try {
    const db = sqlite.getDatabase();
    const result = db.exec(
      'SELECT id FROM group_chat_messages WHERE group_id = ? AND pin_id = ? LIMIT 1',
      [task.groupId, tokenPin],
    );
    const rawId = result[0]?.values?.[0]?.[0];
    upstreamMessageId = typeof rawId === 'number' ? rawId : Number(rawId);
    if (!Number.isInteger(upstreamMessageId) || (upstreamMessageId as number) <= 0) {
      upstreamMessageId = null;
    }
  } catch {
    return '';
  }
  if (upstreamMessageId == null) return '';
  const seen = sqlite.get<string>(`${ACK_SEEN_PREFIX}${task.id}:${upstreamMessageId}`);
  return seen === '1' ? tokenPin : '';
}

/**
 * P1-3: build the OpenTeam status block for the chair planning directive.
 * Collects the task's LIVE pending invites (openteam_invites.status='pending')
 * plus remote placeholder members whose join never confirmed (member row with
 * joined_pin_id NULL, no invite pending — the invite expired or the join
 * watcher gave up). The block tells the chair NOT to decompose
 * "search + invite a remote bot" as a subtask: the invitation is already out
 * (or already failed), and re-inviting would hit the server's duplicate guard.
 * Empty string when there is nothing to report (or the store is unwired).
 */
export function buildOpenTeamPlanningStatusBlock(
  membershipStore: OpenTeamMembershipStore | undefined,
  task: GroupTask,
  groupTaskStore: GroupTaskStore,
): string {
  if (!membershipStore || !task.groupId) return '';
  const pending = membershipStore
    .listPendingInvites()
    .filter((invite) => invite.taskId === task.id);
  const inviteeGmids = new Set(
    pending.map((invite) => invite.inviteeGlobalmetaid.trim().toLowerCase()),
  );
  const placeholders = groupTaskStore
    .listMembers(task.id)
    .filter(
      (member) =>
        member.metabotId == null
        && !member.joinedPinId
        && !inviteeGmids.has((member.globalmetaid ?? '').trim().toLowerCase()),
    );
  if (pending.length === 0 && placeholders.length === 0) return '';

  const lines: string[] = [
    '[OpenTeam invites already sent — host facts, NOT suggestions]',
  ];
  if (pending.length > 0) {
    lines.push(
      'The chair has already invited remote bot(s) below; they have NOT joined yet ' +
      '(invites are pending, waiting for the guest machine to accept and join on-chain).',
    );
    for (const invite of pending) {
      const label = invite.inviteeName?.trim() || invite.inviteeGlobalmetaid;
      lines.push(
        `- ${label} (${invite.inviteeGlobalmetaid}): pending since ${invite.createdAt ?? 'unknown'}`,
      );
    }
    lines.push(
      'Do NOT plan a "search for a remote bot / invite a remote bot" subtask for these ' +
      '— the invite is already out and a duplicate invite is rejected by the server. ' +
      'Plan their work as post-join assignments (only if they join), or proceed with ' +
      'the current roster without them.',
    );
  }
  for (const member of placeholders) {
    const label = member.displayName?.trim() || member.globalmetaid;
    lines.push(
      `- ${label} (${member.globalmetaid}): remote member placeholder, join never confirmed ` +
      '(previous invite expired or timed out) — do not plan work for it as if joined; ' +
      're-invite it yourself if you want it, else drop it from the plan.',
    );
  }
  return lines.join('\n');
}

/**
 * #13 handshake: the welcome text for a member joining a task AFTER the
 * initial roster (especially a remote OpenTeam member). It states who joined
 * and why (invite required-skills), tells the joiner to greet the group and
 * confirm presence BEFORE starting work, and asks the existing members for a
 * ONE-round online confirmation. The existing members' mention-gated replies
 * ARE the handshake round; their confirmations carry no mentions, so nothing
 * replies to them and the ritual stops after one round ([NO_REPLY] discipline
 * stays intact — only explicitly @-addressed members speak).
 */
export { buildMemberJoinWelcomeText };

export function createGroupTaskDaemonLoop(deps: GroupTaskDaemonDeps): GroupTaskDaemonLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const workerCooldownMs = Math.max(0, Math.trunc(deps.workerCooldownMs ?? DEFAULT_WORKER_COOLDOWN_MS));
  const chairCooldownMs = Math.max(0, Math.trunc(deps.chairCooldownMs ?? DEFAULT_CHAIR_COOLDOWN_MS));
  const replyBudget = Math.max(1, Math.trunc(deps.replyBudget ?? DEFAULT_REPLY_BUDGET));
  const maxRepliesPerTaskPerTick = Math.max(
    1,
    Math.trunc(deps.maxRepliesPerTaskPerTick ?? DEFAULT_MAX_REPLIES_PER_TASK_PER_TICK),
  );
  const contextMessageCount = Math.max(1, Math.trunc(deps.contextMessageCount ?? DEFAULT_CONTEXT_MESSAGE_COUNT));
  const chairTwinSuppressWindowMs = Math.max(
    0,
    Math.trunc(deps.chairTwinSuppressWindowMs ?? DEFAULT_CHAIR_TWIN_SUPPRESS_WINDOW_MS),
  );
  const dependencyWaitMaxMs = Math.max(
    1_000,
    Math.trunc(deps.dependencyWaitMaxMs ?? DEFAULT_DEPENDENCY_WAIT_MAX_MS),
  );
  const driverGraceMs = Math.max(0, Math.trunc(deps.driverGraceMs ?? DEFAULT_DRIVER_GRACE_MS));
  const driverInstanceId = randomUUID();
  const memberUnreachableAfterMinutes = Math.max(
    1,
    Math.trunc(deps.memberUnreachableAfterMinutes ?? DEFAULT_MEMBER_UNREACHABLE_AFTER_MINUTES),
  );
  const memberTimeoutAfterMinutes = Math.max(
    1,
    Math.trunc(deps.memberTimeoutAfterMinutes ?? DEFAULT_MEMBER_TIMEOUT_AFTER_MINUTES),
  );
  const memberEscalateAfterMinutes = Math.max(
    1,
    Math.trunc(deps.memberEscalateAfterMinutes ?? DEFAULT_MEMBER_ESCALATE_AFTER_MINUTES),
  );
  const ackTimeoutMs = Math.max(
    30_000,
    Math.trunc(deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS),
  );
  /**
   * P5 (v1.2): a worker with speech or a recorded deliverable within this
   * window is ENGAGED, even if the activity predates the assignment — a
   * mid-skill-turn worker only sees the new assignment when the turn ends, so
   * the 3-min no-ACK clock on a fresh assignment must not fire underneath it
   * (task #23: eleven was mid-delivery and Lucy mid-copy when the false
   * "@chair ⚠ … has not sent a [WORKING] ACK" warnings fired).
   */
  const ackEngagedRecentMs = Math.max(
    ackTimeoutMs,
    Math.trunc(deps.ackEngagedRecentMs ?? DEFAULT_ACK_ENGAGED_RECENT_MS),
  );
  const verificationRetryMs = Math.max(
    60_000,
    Math.trunc(deps.verificationRetryMs ?? DEFAULT_VERIFICATION_RETRY_MS),
  );
  const remoteUnreachableAfterMs = Math.max(
    1_000,
    Math.trunc(deps.remoteUnreachableAfterMs ?? DEFAULT_REMOTE_UNREACHABLE_AFTER_MS),
  );
  const remotePresenceThrottleMs = Math.max(
    1_000,
    Math.trunc(deps.remotePresenceThrottleMs ?? DEFAULT_REMOTE_PRESENCE_THROTTLE_MS),
  );
  /**
   * G-01: no-progress stall window — an executing task with no new group
   * message AND no new deliverable for this long reads as "流程长时间无进展"
   * and reports one anomaly notice to the origin session (re-armed when
   * progress resumes or the task reworks).
   */
  const noProgressStallMs = Math.max(
    5 * 60_000,
    Math.trunc(deps.noProgressStallMs ?? DEFAULT_NO_PROGRESS_STALL_MS),
  );
  const noProgressNudgeMs = Math.max(
    60_000,
    Math.min(noProgressStallMs, Math.trunc(deps.noProgressNudgeMs ?? DEFAULT_NO_PROGRESS_NUDGE_MS)),
  );
  const chairResponseRedriveMs = Math.max(
    30_000,
    Math.trunc(deps.chairResponseRedriveMs ?? DEFAULT_CHAIR_RESPONSE_REDRIVE_MS),
  );
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const tickWatchdogMs = Math.max(1_000, Math.trunc(deps.tickWatchdogMs ?? DEFAULT_TICK_WATCHDOG_MS));
  // Entropy P1: per-(task, bot) TTL cache for the group cognition block.
  const cognitionBlockCache = new Map<string, { rosterKey: string; block: string; expiresAt: number }>();

  /**
   * Round-4 default link probe: HEAD with a GET fallback (some hosts reject
   * HEAD), redirects followed, ~8s bound. null when the network is
   * unavailable. Production default; tests inject a fake via deps.probeUrl.
   */
  const defaultProbeUrl: GroupTaskDaemonProbeUrlFn = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      let response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (response.status >= 400 || response.status === 405) {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: controller.signal,
          headers: { Range: 'bytes=0-0' },
        });
      }
      return response.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const probeUrl = deps.probeUrl ?? defaultProbeUrl;
  const experienceStore = deps.experienceStore ?? new MetaIDExperienceStore(
    deps.getStore().getDatabase(),
    deps.getStore().getSaveFunction(),
  );

  /**
   * fix/group-task-flow: plain-LLM turns (chair planning, replies without a
   * skill route, owner reports) used to run with NO timeout — a wedged HTTP
   * request held the turn (and, before async dispatch, the whole tick)
   * hostage for as long as the provider stayed silent (task #51's 41-min
   * gap). Every daemon plain-LLM call now carries an AbortSignal; the abort
   * rejects into the normal retry path. Skill turns keep their own watchdog.
   */
  const plainTurnTimeoutMs = Math.max(
    5_000,
    Math.trunc(deps.plainTurnTimeoutMs ?? DEFAULT_PLAIN_TURN_TIMEOUT_MS),
  );
  const longTurnPlaceholderMs = Math.max(
    0, // Speedup R-01: 0 (the default) disables the visible placeholder post.
    Math.trunc(deps.longTurnPlaceholderMs ?? DEFAULT_LONG_TURN_PLACEHOLDER_MS),
  );
  const longTurnHeartbeatMs = Math.max(
    50,
    Math.trunc(deps.longTurnHeartbeatMs ?? DEFAULT_LONG_TURN_HEARTBEAT_MS),
  );
  const longTurnHeartbeatMax = Math.max(
    0,
    Math.trunc(deps.longTurnHeartbeatMax ?? DEFAULT_LONG_TURN_HEARTBEAT_MAX),
  );
  const longTurnChairReminderMs = Math.max(
    0,
    Math.trunc(deps.longTurnChairReminderMs ?? DEFAULT_LONG_TURN_CHAIR_REMINDER_MS),
  );
  const longTurnLeaseArmMs = Math.max(
    50,
    Math.trunc(deps.longTurnLeaseArmMs ?? LONG_TURN_LEASE_ARM_MS),
  );
  const performChatWithTimeout: GroupTaskDaemonPerformChatFn = (systemPrompt, userMessage, llmId, options) => {
    // Per-attempt window (attemptTimeoutMs): the primary and the fallback
    // brain each get their own fresh timeout — a wedged primary no longer
    // leaves the fallback retry a dead shared signal.
    const merged = { ...(options ?? {}), attemptTimeoutMs: plainTurnTimeoutMs };
    return deps.performChat(systemPrompt, userMessage, llmId, merged);
  };

  // Loop prevention state (in-memory, per loop instance; no new DB columns).
  const lastReplyAtByKey = new Map<string, number>();
  const replyCountByKey = new Map<string, number>();
  const keyOf = (taskId: number, metabotId: number): string => `${taskId}:${metabotId}`;

  // P2-7 (round 2): pin_ids of messages THIS daemon posted as the chair
  // (planning kickoff + auto replies). They must never count as "Twin
  // activity" for the suppression window — otherwise the daemon's own cadence
  // would self-throttle in fully autonomous groups. Bounded per task.
  const daemonChairSentPins = new Map<number, string[]>();
  const rememberDaemonChairPin = (taskId: number, pinId: string): void => {
    // fix/group-task-duration: an empty pinId means the send was QUEUED behind
    // a sponsor reconciliation — it is not a real on-chain pin and must never
    // enter the Twin-suppression set.
    if (!pinId) return;
    const pins = daemonChairSentPins.get(taskId) ?? [];
    pins.push(pinId);
    if (pins.length > 8) pins.shift();
    daemonChairSentPins.set(taskId, pins);
  };

  // ---------------------------------------------------------------------
  // OpenTeam M2: remote-teammate unreachable detection (in-memory only).
  // ---------------------------------------------------------------------

  interface RemoteUnreachableInfo {
    globalMetaId: string;
    name: string;
    /** Seconds since the peer was last seen online; null = unknown. */
    offlineSeconds: number | null;
    /** Seconds since its latest group message; null = never posted here. */
    silentSeconds: number | null;
  }

  interface RemotePresenceSnapshot {
    queriedAt: number;
    unreachable: RemoteUnreachableInfo[];
  }

  /** Latest presence evaluation per task; refreshed at most once per throttle window. */
  const remotePresenceByTask = new Map<number, RemotePresenceSnapshot>();
  /** `${taskId}:${globalMetaId}` keys already owner-notified for the CURRENT unreachable streak. */
  const remoteUnreachableNotified = new Set<string>();

  /**
   * P2-8: multi-driver mutex — kv heartbeat claim. Returns true when THIS
   * daemon instance may drive the task this tick: no claim exists, the claim
   * is stale (older than the grace window), or the claim is ours. Returns
   * false when ANOTHER instance claimed within the grace window — the tick
   * yields entirely (no heartbeat, no planning, no message processing), so
   * two chair sessions never double-drive the same task.
   *
   * F2 (GT#11): the daemon does NOT refresh its own claim at tick top anymore
   * — the claim stays fresh only while the daemon ACTUALLY drives (see
   * refreshDriverClaim after each post). A fresh foreign claim therefore means
   * "another session is driving RIGHT NOW", which is exactly what the manual
   * RPC send gate needs to reject duplicate driving.
   */
  const claimDriverOrYield = (taskId: number): boolean => {
    if (driverGraceMs <= 0) return true;
    // GT-01 observability: a stale-claim TAKEOVER (previous holder wedged or
    // its app restarted) used to be silent — the only claim log was the yield
    // branch below. Log it once here so a driver swap is always diagnosable.
    const priorRaw = deps.getStore().get<string>(`${GROUP_TASK_DRIVER_KV_PREFIX}${taskId}`);
    const result = tryAcquireGroupTaskDriver(deps.getStore(), taskId, driverInstanceId, driverGraceMs, now(), false);
    if (result.ok) {
      if (priorRaw) {
        const [priorOwner, priorAtText] = priorRaw.split('|');
        const priorAgeMs = now() - (Number(priorAtText) || 0);
        if (priorOwner && priorOwner !== driverInstanceId && priorAgeMs >= driverGraceMs) {
          emitLog(
            `[GroupTaskDaemon] Task ${taskId}: took over the stale driver claim from ` +
            `${priorOwner.slice(0, 8)}… (silent for ${Math.round(priorAgeMs / 1000)}s)`,
          );
        }
      }
      return true;
    }
    emitLog(
      `[GroupTaskDaemon] Task ${taskId}: another chair session (${(result.driverId ?? 'unknown').slice(0, 8)}…) ` +
      `holds the driver claim (${Math.round(result.claimAgeMs / 1000)}s old); this instance yields this tick`,
    );
    return false;
  };

  /**
   * F2 (GT#11): refresh our driver claim AFTER an actual drive (a group
   * message post). The claim then ages out during idle ticks, letting a
   * manual chair session take the floor the moment the auto driver goes
   * quiet — and vice versa the daemon yields while a manual claim is fresh.
   */
  const refreshDriverClaim = (taskId: number): void => {
    if (driverGraceMs <= 0) return;
    deps.getStore().set(`${GROUP_TASK_DRIVER_KV_PREFIX}${taskId}`, `${driverInstanceId}|${now()}`);
  };

  /**
   * GT-01 (task #56): lastDrivenAt is the show/stall signal's primary input —
   * it must mirror REAL drive work (a dispatched turn, a posted message, a
   * processed message), not the tick loop's liveness. The old per-tick
   * heartbeat kept it fresh through hours of zero dispatch ("fake heartbeat"),
   * so a wedged task read stall=False forever. This is the single writer; every
   * call site below is a place the daemon observably MOVED the task forward.
   */
  const noteDriveActivity = (taskId: number): void => {
    try {
      deps.getGroupTaskStore().updateLastDrivenAt(taskId, Math.floor(now() / 1000));
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${taskId}: lastDrivenAt update failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * F2 (GT#11): single choke point for every daemon group-message post —
   * refreshes the driver claim on success so the claim freshness mirrors
   * actual driving activity.
   *
   * fix/group-task-duration: a sponsor broadcast-reconciliation rejection is
   * NOT a delivery failure — the order was refused, nothing went on-chain, and
   * the outage can last tens of minutes. The message is parked in the pending
   * queue and `{ pinId: '' }` is returned; callers must treat an empty pinId
   * as "queued, delivered later by the drainer" and skip persisting it.
   */
  /**
   * Task #66 (optimization ①): task-level chain-backend health facts. The
   * host is the FIRST to know on-chain sends are failing — during the
   * observed backend outage the bots each spent minutes discovering it
   * independently. Two consecutive send failures record ONE chain_health
   * environment note for the chair (work can continue; publishing will keep
   * failing); the first success afterwards records the recovery note. The
   * state is per task and in-memory — an app restart mid-outage re-arms it
   * after two fresh failures, which is the same information anyway.
   */
  const CHAIN_HEALTH_FAILURE_THRESHOLD = 2;
  const chainHealthState = new Map<number, { consecutiveFailures: number; downSince: number; notifiedAt: number }>();
  const noteChainHealthDegraded = async (taskId: number, error: unknown): Promise<void> => {
    try {
      const state = chainHealthState.get(taskId) ?? { consecutiveFailures: 0, downSince: 0, notifiedAt: 0 };
      state.consecutiveFailures += 1;
      if (state.downSince === 0) state.downSince = now();
      const shouldNotify = state.consecutiveFailures >= CHAIN_HEALTH_FAILURE_THRESHOLD
        && now() - state.notifiedAt >= 10 * 60_000;
      chainHealthState.set(taskId, state);
      if (!shouldNotify) return;
      state.notifiedAt = now();
      const reason = error instanceof Error ? error.message : String(error);
      deps.getGroupTaskStore().recordHostNote({
        taskId,
        kind: 'chain_health',
        target: 'on-chain backend',
        dedupeKey: `chain_health_down:${taskId}:${Math.floor(now() / (10 * 60_000))}`,
        body:
          `On-chain group sends have failed ${state.consecutiveFailures} consecutive times ` +
          `(last error: ${reason.slice(0, 160)}). This is usually the chain backend being unreachable — ` +
          'every on-chain post (group messages, file uploads, publishes) will keep failing and retrying until ' +
          'it recovers. Local work can continue; a recovery note will follow when sends succeed again. ' +
          'Avoid stacking extra retries on top of the automatic ones.',
      });
      emitLog(
        `[GroupTaskDaemon] Task ${taskId}: chain_health environment note recorded ` +
        `(${state.consecutiveFailures} consecutive send failures)`,
      );
    } catch {
      // health facts are best-effort — never shadow the original send error
    }
  };
  const noteChainHealthRecovered = async (taskId: number): Promise<void> => {
    try {
      const state = chainHealthState.get(taskId);
      if (!state || state.consecutiveFailures < CHAIN_HEALTH_FAILURE_THRESHOLD) {
        if (state) chainHealthState.delete(taskId);
        return;
      }
      chainHealthState.delete(taskId);
      const outageMin = Math.max(1, Math.round((now() - state.downSince) / 60_000));
      deps.getGroupTaskStore().recordHostNote({
        taskId,
        kind: 'chain_health',
        target: 'on-chain backend',
        dedupeKey: `chain_health_recovered:${taskId}:${now()}`,
        body:
          `On-chain sends have RECOVERED (the failure window lasted ~${outageMin} min). ` +
          'Pending retries and queued publications can proceed now.',
      });
      emitLog(`[GroupTaskDaemon] Task ${taskId}: chain_health recovery note recorded (~${outageMin} min outage)`);
    } catch {
      // best-effort
    }
  };

  const postGroupMessage = async (
    taskId: number,
    metabotId: number,
    content: string,
    opts?: { replyPin?: string; mention?: string[] },
  ): Promise<{ pinId: string }> => {
    try {
      const result = await deps.postGroupTaskMessage(taskId, metabotId, content, opts);
      refreshDriverClaim(taskId);
      noteDriveActivity(taskId); // a posted message is real drive work
      noteTickProgress(); // a completed send proves the in-flight tick is alive
      await noteChainHealthRecovered(taskId);
      return result;
    } catch (sendError) {
      if (isSponsorBroadcastPendingError(sendError)) {
        enqueuePendingGroupSend(taskId, metabotId, content, opts);
        await notifySenderOfQueuedDelivery(taskId, metabotId, content);
        return { pinId: '' };
      }
      await noteChainHealthDegraded(taskId, sendError);
      // R7: the sender's reply was already written to its own task session
      // BEFORE the on-chain send (the daemon adds the assistant message first),
      // so on failure the bot would wrongly believe it had spoken and the group
      // never received it (the real-world "chair misjudged worker didn't accept"
      // case). Inject an explicit delivery-failure notice into the sender's task
      // session so its NEXT turn knows the message did not land and can retry.
      // Best-effort: never masks the original error — it is re-thrown so every
      // caller's existing error handling still runs unchanged.
      await notifySenderOfDeliveryFailure(taskId, metabotId, content, sendError);
      throw sendError;
    }
  };

  /**
   * R7: inject a deterministic delivery-failure notice into the sender bot's task
   * session. The notice is a host-generated user turn (never a participant
   * message) so the bot's next dispatch reads "your last group message was not
   * delivered" in context and can retry/rephrase. Failures here only log — they
   * must never shadow the original send error.
   */
  const notifySenderOfDeliveryFailure = async (
    taskId: number,
    metabotId: number,
    content: string,
    error: unknown,
  ): Promise<void> => {
    try {
      const task = deps.getGroupTaskStore().getTaskById(taskId);
      if (!task) return;
      const botName = deps.getMetabotStore().getMetabotById(metabotId)?.name?.trim() || `bot-${metabotId}`;
      const reason = error instanceof Error ? error.message : String(error);
      const preview = content.length > 120 ? `${content.slice(0, 120)}…` : content;
      const coworkStore = deps.getCoworkStore();
      const session = ensureTaskSession(coworkStore, task, metabotId, botName);
      coworkStore.addMessage(session.id, {
        type: 'user',
        content: [
          '[SYSTEM delivery-failure notice — generated by the host, not a group participant]',
          `⚠ Your last group message FAILED to post on-chain and was NOT delivered to the group: ${reason}`,
          'Before re-posting: re-read the group log — the send may have landed on-chain despite the reported failure (responses can be lost while the pin succeeds). Re-post ONLY if the message is genuinely missing, exactly ONCE (rephrase if the failure looks content-related), and do not also schedule an extra retry alongside your next-turn re-post — duplicates read as double rulings to the group.',
          `Your intended message was:\n${preview}`,
        ].join('\n'),
      });
      emitLog(
        `[GroupTaskDaemon] Task ${taskId}: delivery-failure notice injected into bot ${metabotId} session (${reason})`,
      );
    } catch (noticeError) {
      emitLog(
        `[GroupTaskDaemon] Task ${taskId}: failed to inject delivery-failure notice for bot ${metabotId}: ` +
        `${noticeError instanceof Error ? noticeError.message : String(noticeError)}`,
      );
    }
  };

  // -------------------------------------------------------------------------
  // fix/group-task-duration: sponsor-broadcast-pending send queue (RC-2).
  //
  // The MVC fee-sponsor backend rejects a new sponsored order while a previous
  // order for the same address is still reconciling ("SPONSOR_BROADCAST_PENDING:
  // orderId=…: broadcast reconciliation in progress"). Observed outages ran
  // 25–90 MINUTES (task #58: eleven's on-time delivery never landed 19:39→20:04;
  // task #59: three consecutive send failures at 00:03–00:05 left the worker
  // with finished work and no trigger — the 9-hour stall). Burning a full LLM
  // turn retry (and the R7 failure notice, which teaches the bot to re-send)
  // on every attempt amplified the outage. Instead: park the composed message
  // in this queue, tell the sender it is QUEUED (not failed), and let the tick
  // drainer deliver it once reconciliation clears.
  // -------------------------------------------------------------------------
  const isSponsorBroadcastPendingError = (error: unknown): boolean =>
    /SPONSOR_BROADCAST_PENDING|broadcast reconciliation/i
      .test(error instanceof Error ? error.message : String(error));

  interface PendingGroupSendEntry {
    taskId: number;
    metabotId: number;
    content: string;
    opts?: { replyPin?: string; mention?: string[] };
    dedupeKey: string;
    firstTriedAt: number;
    lastTriedAt: number;
    attempts: number;
  }

  const pendingGroupSends: PendingGroupSendEntry[] = [];
  const PENDING_SEND_RETRY_MS = 2 * 60_000;
  const PENDING_SEND_MAX_AGE_MS = 90 * 60_000;

  const notifySenderOfQueuedDelivery = async (
    taskId: number,
    metabotId: number,
    content: string,
  ): Promise<void> => {
    try {
      const task = deps.getGroupTaskStore().getTaskById(taskId);
      if (!task) return;
      const botName = deps.getMetabotStore().getMetabotById(metabotId)?.name?.trim() || `bot-${metabotId}`;
      const preview = content.length > 120 ? `${content.slice(0, 120)}…` : content;
      const coworkStore = deps.getCoworkStore();
      const session = ensureTaskSession(coworkStore, task, metabotId, botName);
      coworkStore.addMessage(session.id, {
        type: 'user',
        content: [
          '[SYSTEM delivery-queued notice — generated by the host, not a group participant]',
          '⏳ Your last group message could not be posted yet: the fee-sponsor service is still reconciling a previous broadcast (SPONSOR_BROADCAST_PENDING).',
          'The host has QUEUED your message and will deliver it automatically. DO NOT re-send it yourself and do not treat the work as lost — continue only when you see the message appear in the group transcript.',
          `Your queued message was:\n${preview}`,
        ].join('\n'),
      });
    } catch (noticeError) {
      emitLog(
        `[GroupTaskDaemon] Task ${taskId}: failed to inject delivery-queued notice for bot ${metabotId}: ` +
        `${noticeError instanceof Error ? noticeError.message : String(noticeError)}`,
      );
    }
  };

  const enqueuePendingGroupSend = (
    taskId: number,
    metabotId: number,
    content: string,
    opts?: { replyPin?: string; mention?: string[] },
  ): void => {
    const dedupeKey = `${taskId}|${metabotId}|${(opts?.replyPin ?? '').length}|${content.length}|${content.slice(0, 64)}`;
    if (pendingGroupSends.some((entry) => entry.dedupeKey === dedupeKey)) return;
    const t = now();
    pendingGroupSends.push({
      taskId, metabotId, content, opts, dedupeKey,
      firstTriedAt: t, lastTriedAt: t, attempts: 1,
    });
    emitLog(
      `[GroupTaskDaemon] Task ${taskId}: group send for bot ${metabotId} queued ` +
      `(sponsor broadcast reconciliation pending; ${pendingGroupSends.length} queued)`,
    );
  };

  /**
   * Deliver queued group messages whose sponsor reconciliation may have
   * cleared. Runs at the top of every tick; entries retry at most once per
   * PENDING_SEND_RETRY_MS and fall back to the ordinary failure notice when
   * the error changes, the entry ages out, or the task went terminal.
   */
  const drainPendingGroupSends = async (): Promise<void> => {
    for (const entry of [...pendingGroupSends]) {
      const t = now();
      if (t - entry.lastTriedAt < PENDING_SEND_RETRY_MS) continue;
      entry.lastTriedAt = t;
      entry.attempts += 1;
      const drop = async () => {
        pendingGroupSends.splice(pendingGroupSends.indexOf(entry), 1);
      };
      try {
        const task = deps.getGroupTaskStore().getTaskById(entry.taskId);
        if (!task || task.status === 'done' || task.status === 'cancelled') {
          await drop();
          emitLog(
            `[GroupTaskDaemon] Task ${entry.taskId}: dropped a queued send for bot ${entry.metabotId} — task is no longer active`,
          );
          continue;
        }
        await deps.postGroupTaskMessage(entry.taskId, entry.metabotId, entry.content, entry.opts);
        await drop();
        refreshDriverClaim(entry.taskId);
        noteDriveActivity(entry.taskId);
        emitLog(
          `[GroupTaskDaemon] Task ${entry.taskId}: queued group send for bot ${entry.metabotId} delivered ` +
          `after ${Math.round((t - entry.firstTriedAt) / 1000)}s (${entry.attempts} attempts)`,
        );
      } catch (error) {
        if (!isSponsorBroadcastPendingError(error)) {
          await drop();
          await notifySenderOfDeliveryFailure(entry.taskId, entry.metabotId, entry.content, error);
          emitLog(
            `[GroupTaskDaemon] Task ${entry.taskId}: queued send for bot ${entry.metabotId} failed with a ` +
            `different error — failure notice injected: ${error instanceof Error ? error.message : String(error)}`,
          );
        } else if (t - entry.firstTriedAt > PENDING_SEND_MAX_AGE_MS) {
          await drop();
          await notifySenderOfDeliveryFailure(entry.taskId, entry.metabotId, entry.content, error);
          emitLog(
            `[GroupTaskDaemon] Task ${entry.taskId}: queued send for bot ${entry.metabotId} aged out after ` +
            `${Math.round(PENDING_SEND_MAX_AGE_MS / 60_000)} min of sponsor reconciliation — failure notice injected`,
          );
        }
      }
    }
  };

  /**
   * P2-6 ledger check for one [DEPENDS_ON] token: pinid/txid-shaped tokens are
   * enforced against the task's recorded deliverables; free-text descriptions
   * are advisory only (always satisfied). Used by the stale-[WORKING] dependency-wait exemption
   * in the monitors (single-commander: dispatch is no longer gated).
   */
  const dependencyTokenSatisfied = (task: GroupTask, token: string): boolean => {
    const pinish = PINID_FORMAT.test(token) || TXID_FORMAT.test(token);
    if (!pinish) return true;
    const lower = token.toLowerCase();
    const deliverables = deps.getGroupTaskStore().listDeliverables(task.id);
    if (deliverables.some((deliverable) =>
      (deliverable.msgPinId ?? '').toLowerCase() === lower
      || (deliverable.uri ?? '').toLowerCase().includes(lower)
      || hexTokensSharePrefix((deliverable.uri ?? '').toLowerCase(), lower)
      || hexTokensSharePrefix((deliverable.msgPinId ?? '').toLowerCase(), lower),
    )) {
      return true;
    }
    // Task #58 regression: the worker's [DELIVERABLE] line carried a TRUNCATED
    // metafile pin (60 hex of the 64-hex+i0 pinid), so the parser rejected the
    // candidate and the ledger row stayed kind=text/uri=NULL — while the chair
    // dispatched with the FULL pin it had verified via the indexer. Exact-match
    // then failed and the dispatch sat out the whole 15-min bounded wait.
    // Fallback: scan the task's deliverable tag lines for a long hex-prefix
    // overlap with the token (LLMs truncate hashes; a ≥32-char shared prefix
    // is not a coincidence).
    if (!task.groupId) return false;
    try {
      const messages = deps.getGroupTaskStore()
        .listGroupChatMessages(task.groupId, { limit: 200 });
      return messages.some((message) =>
        deliverableTagLines(message.content ?? '')
          .some((line) => hexTokensSharePrefix(line.toLowerCase(), lower)),
      );
    } catch {
      return false;
    }
  };

  /**
   * P14 (v1.1) chair-assignment predicate, shared by the deferred-queue
   * coalescer: a trigger counts as a worker assignment only when it is plain
   * chair prose. Worker chatter that merely mentions this bot and chair
   * protocol/status messages are not assignments, and roll-call presence
   * checks @mention every member but are NOT work assignments.
   *
   * Single-commander (task #64 follow-up): the P0-2 host auto-ACK that used
   * this gate is GONE — the host never posts as a worker. The ACK protocol
   * is the worker's own duty (see the worker playbook); a missing ACK is an
   * environment fact delivered to the chair instead.
   */
  const isChairDispatchContent = (
    content: string,
    senderGmid: string,
    chairGlobalMetaId: string,
  ): boolean => {
    if (!chairGlobalMetaId || !senderGmid || senderGmid !== chairGlobalMetaId) return false;
    return Boolean(
      content
      && !DELIVERABLE_TAG.test(content)
      && !STATUS_TAG.test(content)
      && !CHECKPOINT_OPEN_TAG.test(content)
      && !CHECKPOINT_RESOLVED_TAG.test(content)
      && !hasGroupTaskNotice(content)
      && !isRollCallPresenceCheck(content),
    );
  };

  /**
   * Re-trigger window (P0-3c): a decision skipped because of the per-tick reply
   * cap or a cooldown is NOT dropped. The (task, bot, message) is queued here and
   * retried at the start of a later tick, so the skipped worker still gets its
   * chance (the message cursor has already advanced past it by then).
   *
   * fix/group-task-flow: the queue is DURABLE (kv per task). The async turn
   * dispatch below defers to it whenever a bot is busy, so an app restart must
   * not strand those triggers the way the old in-memory array did.
   */
  interface DeferredReplyEntry {
    taskId: number;
    metabotId: number;
    messageId: number;
    reason: GroupTaskResponderDecision['reason'];
    verificationNotes: string[];
    /** Bounded async-turn retry counter (see MSG_RETRY_MAX_FAILURES). */
    failures?: number;
  }
  const DEFERRED_QUEUE_KV_PREFIX = 'group_task_deferred:';
  const loadDeferredQueue = (taskId: number): DeferredReplyEntry[] => {
    const raw = deps.getStore().get<string>(`${DEFERRED_QUEUE_KV_PREFIX}${taskId}`);
    if (raw == null) return [];
    try {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is DeferredReplyEntry =>
        Boolean(entry)
        && typeof (entry as DeferredReplyEntry).taskId === 'number'
        && typeof (entry as DeferredReplyEntry).metabotId === 'number'
        && typeof (entry as DeferredReplyEntry).messageId === 'number');
    } catch {
      return [];
    }
  };
  const saveDeferredQueue = (taskId: number, entries: DeferredReplyEntry[]): void => {
    const sqlite = deps.getStore();
    const key = `${DEFERRED_QUEUE_KV_PREFIX}${taskId}`;
    if (entries.length === 0) {
      sqlite.delete(key);
    } else {
      sqlite.set(key, JSON.stringify(entries));
    }
  };
  const deferReply = (entry: DeferredReplyEntry): void => {
    const entries = loadDeferredQueue(entry.taskId);
    // Entries are per (task, bot, message) and drain FIFO by message id: every
    // distinct trigger gets its own turn (coalescing same-bot messages to the
    // newest would silently drop real assignments). Re-deferring the SAME
    // trigger replaces it in place, preserving position and failure count.
    const index = entries.findIndex(
      (existing) => existing.metabotId === entry.metabotId && existing.messageId === entry.messageId,
    );
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }
    entries.sort((a, b) => a.messageId - b.messageId);
    saveDeferredQueue(entry.taskId, entries);
  };

  /**
   * fix/group-task-flow: async turn execution state. Turns run as detached
   * jobs (see dispatchReplyTurn) so one multi-minute turn never freezes the
   * tick for every other task/monitor. turnInFlight enforces the
   * one-turn-per-(task,bot)-session invariant; pendingTurnJobs lets tests and
   * shutdown observe completion via whenIdle().
   */
  // Each in-flight entry carries an ownership token (unique per dispatch): a
  // hard-cap force-settle releases the guard while the original job's await
  // still dangles, so a NEWER dispatch may already own the key by the time the
  // old job's finally (or a late hard-cap fire) runs — deletes must confirm
  // ownership or they would break the one-turn-per-session invariant for the
  // replacement turn.
  const turnInFlight = new Map<string, { startedAt: number; token: object }>();
  const pendingTurnJobs = new Set<Promise<void>>();
  const latchWatchers = new Set<ReturnType<typeof setInterval>>();
  /**
   * GT-01 (task #56): keys whose turn outlived the skill-turn watchdog and are
   * latched until the session idles. A latched turn is NOT a legitimate
   * in-flight attempt — it already failed from the daemon's perspective — so
   * it must not refresh lastDrivenAt nor suppress the no-progress nudge.
   */
  const latchedTurnKeys = new Set<string>();

  /**
   * Sidebar background-task badge: every turnInFlight mutation broadcasts a
   * full snapshot (turns are few and changes are rare, so replace semantics
   * beat delta bookkeeping) and the renderer can also pull the same snapshot
   * via the groupTask:getTurnActivity IPC on mount.
   */
  const currentTurnActivity = (): GroupTaskTurnActivityEntry[] =>
    [...turnInFlight.entries()].map(([key, value]) => {
      const [taskId, metabotId] = key.split(':').map(Number);
      return { taskId, metabotId, startedAt: value.startedAt };
    });
  const emitTurnActivity = (): void => {
    deps.emitTaskEvent?.({ type: 'groupTask:turnActivityChanged', turns: currentTurnActivity(), at: now() });
  };
  /**
   * Task #52 self-heal: tasks whose stuck status directive reconciliation was
   * already attempted this daemon run (success or skip — the parse fix keeps
   * new directives landing on the normal path, so one attempt per run is the
   * whole repair budget for legacy stuck tasks).
   */
  /**
   * Task #63: the #52 self-heal used to run ONCE per daemon process lifetime —
   * a botched verdict that arrived while the app was already running (task
   * #63: the bolded `**[STATUS:REVIEW]**` wrap-up) never got reconciled until
   * an app restart. Re-arm the scan whenever the message cursor advances past
   * the previously reconciled point so mid-run misses heal on the next tick.
   */
  const statusDirectiveReconciledCursor = new Map<number, number>();
  /**
   * GT-05 (task #56): tasks whose exhausted chair-plan attempts were already
   * re-armed once this daemon run. One attempt per restart — GT-03's per-episode
   * re-arm is the steady-state ladder; this only skips the 20-minute wait right
   * after a restart.
   */
  const planningRearmedThisRun = new Set<number>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  /**
   * Tick watchdog (fix/group-member-status): see runGuardedTick. Tracks the
   * last OBSERVABLE progress of the in-flight tick (a group send completed or
   * the message cursor advanced), not the tick's start — a healthy long tick
   * keeps refreshing it, only a truly hung one lets it go stale.
   */
  let tickLastProgressAtMs = 0;
  let tickEpoch = 0;
  const noteTickProgress = (): void => {
    tickLastProgressAtMs = now();
  };

  const queryNewMessages = (db: Database, groupId: string, afterId: number): GroupChatMessageRow[] =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ? AND id > ?
       ORDER BY id ASC`,
      [groupId, afterId],
    ));

  const queryMessageById = (db: Database, groupId: string, id: number): GroupChatMessageRow | null =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ? AND id = ?
       LIMIT 1`,
      [groupId, id],
    ))[0] ?? null;

  /**
   * Task #64 deferred-drain coalescer (see the call site for the why). Input
   * entries are message-id ascending (deferReply keeps the queue sorted), so
   * per bot the first resolvable chair assignment is the OLDEST one. An
   * assignment already marked ACK-seen no longer carries an open obligation
   * and is skipped for the preference. Purged/unreadable message rows drop
   * out (the drain loop would drop them anyway).
   */
  const coalesceDeferredBacklogPerBot = (
    db: Database,
    task: GroupTask,
    members: GroupTaskMember[],
    entries: DeferredReplyEntry[],
  ): DeferredReplyEntry[] => {
    if (entries.length <= 1 || !task.groupId) return entries;
    const chair = members.find((member) => member.role === 'chair');
    const chairGmid = (chair?.globalmetaid ?? '').trim();
    const sqlite = deps.getStore();
    const byBot = new Map<number, Array<{ entry: DeferredReplyEntry; row: GroupChatMessageRow | null }>>();
    for (const entry of entries) {
      const list = byBot.get(entry.metabotId) ?? [];
      list.push({ entry, row: queryMessageById(db, task.groupId!, entry.messageId) });
      byBot.set(entry.metabotId, list);
    }
    const picked: DeferredReplyEntry[] = [];
    for (const [metabotId, list] of byBot) {
      const member = members.find((candidate) => candidate.metabotId === metabotId);
      const coalescable = Boolean(member && member.role === 'worker') && list.length > 1;
      if (!coalescable) {
        for (const item of list) picked.push(item.entry);
        continue;
      }
      const preferred = list.find((item) => {
        if (!item.row) return false;
        if (sqlite.get<string>(`${ACK_SEEN_PREFIX}${task.id}:${item.entry.messageId}`) === '1') return false;
        return isChairDispatchContent(
          String(item.row.content ?? '').trim(),
          String(item.row.sender_global_metaid ?? '').trim(),
          chairGmid,
        );
      }) ?? null;
      const resolvable = list.filter((item) => item.row != null);
      const keep = preferred?.entry ?? resolvable[resolvable.length - 1]?.entry ?? list[list.length - 1]!.entry;
      const dropped = list.filter((item) => item.entry !== keep).map((item) => `#${item.entry.messageId}`);
      if (dropped.length > 0) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: coalesced bot ${metabotId}'s queued backlog into ` +
          `message #${keep.messageId}` +
          (preferred ? ' (oldest still-open chair assignment)' : ' (newest trigger)') +
          `; superseded: ${dropped.join(', ')}`,
        );
      }
      picked.push(keep);
    }
    return picked;
  };

  /**
   * Task #66 (fix A): count group messages the bot sent MID-TURN via the
   * group_chat tool. With the ONE VOICE PER TURN protocol a bot legitimately
   * delivers its content with send_group_message and closes the turn with
   * [NO_REPLY] or nothing — an empty final reply is then a DELIVERED turn,
   * not a failure.
   */
  const countMidTurnGroupSends = (
    coworkStore: CoworkStore,
    sessionId: string,
    afterMessageId: string,
  ): number => {
    try {
      const messages = coworkStore.getSession(sessionId)?.messages ?? [];
      const startIndex = messages.findIndex((message) => message.id === afterMessageId);
      if (startIndex < 0) return 0;
      let count = 0;
      for (let i = startIndex + 1; i < messages.length; i += 1) {
        const message = messages[i];
        if (message.type !== 'tool_use') continue;
        const meta = (message.metadata ?? {}) as { toolName?: unknown; toolInput?: { action?: unknown } };
        if (meta.toolName === 'group_chat' && meta.toolInput?.action === 'send_group_message') count += 1;
      }
      return count;
    } catch {
      return 0;
    }
  };

  /**
   * Task #66 (fix A): true when the chair has already dispatched work in its
   * own voice — any chair-authored group message beyond the auto-kickoff
   * ([GROUP TASK] prefix) that @-mentions a seated worker. The bootstrap
   * planning turn exists to start a silent chair; a chair that is actively
   * dispatching (mid-turn tool sends or posted dispatches) needs no bootstrap.
   */
  const chairAlreadyDispatched = (
    db: Database,
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
  ): boolean => {
    if (!task.groupId) return false;
    const chairMember = members.find((member) => member.role === 'chair');
    const chairGmid = (chairMember?.globalmetaid ?? '').trim().toLowerCase();
    if (!chairGmid) return false;
    const workerBots = members
      .filter((member) => member.role === 'worker' && member.metabotId != null)
      .map((member) => botsById.get(member.metabotId!))
      .filter((bot): bot is GroupTaskDaemonBotFull => bot != null);
    if (workerBots.length === 0) return false;
    const rows = mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid = ?
       ORDER BY id ASC`,
      [task.groupId, chairGmid],
    ));
    return rows.some((row) => {
      const message = toDaemonMessage(row);
      if ((message.content ?? '').trimStart().startsWith('[GROUP TASK]')) return false;
      return workerBots.some((bot) => isMentioned(message, bot));
    });
  };

  /** True when the chair bot already replied to the given message pin (P2-7). */
  const chairAlreadyRepliedTo = (
    db: Database,
    groupId: string,
    messagePinId: string | null,
    chairGlobalMetaId: string,
  ): boolean => {
    if (!messagePinId || !chairGlobalMetaId) return false;
    const result = db.exec(
      `SELECT COUNT(*) AS n FROM group_chat_messages
       WHERE group_id = ? AND reply_pin = ? AND sender_global_metaid = ?`,
      [groupId, messagePinId, chairGlobalMetaId],
    );
    const value = result[0]?.values?.[0]?.[0];
    return Number(value) > 0;
  };

  /**
   * P2-7 (round 2): true when the chair bot posted ANY message within the
   * suppression window (chain seconds). Pins the daemon itself posted
   * (planning kickoff, auto replies) are excluded — only Twin-side speech
   * counts. Rows without a chain timestamp or pin_id are unattributable and
   * never counted.
   */
  const chairSpokeInWindow = (
    db: Database,
    groupId: string,
    chairGlobalMetaId: string,
    sinceChainSec: number,
    excludePins: ReadonlySet<string>,
  ): boolean => {
    if (!chairGlobalMetaId) return false;
    const result = db.exec(
      `SELECT pin_id FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid = ? AND pin_id IS NOT NULL AND pin_id != ''
         AND chain_timestamp IS NOT NULL AND chain_timestamp >= ?`,
      [groupId, chairGlobalMetaId, sinceChainSec],
    );
    const pins = result[0]?.values ?? [];
    return pins.some((values) => {
      const pin = String(values[0] ?? '');
      return Boolean(pin) && !excludePins.has(pin);
    });
  };

  /**
   * P2-7 (round 2): combined "the Twin is already speaking" gate for daemon
   * chair AUTO replies — the exact reply-pin match (Twin replied to THIS
   * message) OR Twin speech anywhere in the recent window (covers replies
   * without a reply_pin and speech on related messages). `chair_mentioned`
   * stays exempt: a direct @ of the chair is the reliable path and must be
   * answered even while the Twin is active.
   */
  const twinChairActive = (
    db: Database,
    taskId: number,
    groupId: string,
    messagePinId: string | null,
    chairGlobalMetaId: string,
  ): boolean => {
    if (chairAlreadyRepliedTo(db, groupId, messagePinId, chairGlobalMetaId)) return true;
    if (chairTwinSuppressWindowMs <= 0) return false;
    const sinceChainSec = Math.floor((now() - chairTwinSuppressWindowMs) / 1000);
    const excludePins = new Set(daemonChairSentPins.get(taskId) ?? []);
    return chairSpokeInWindow(db, groupId, chairGlobalMetaId, sinceChainSec, excludePins);
  };

  const queryRecentMessages = (db: Database, groupId: string, limit: number): GroupChatMessageRow[] => {
    const rows = mapMessageRows(db.exec(
      `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin, sender_suspect
       FROM group_chat_messages
       WHERE group_id = ?
       ORDER BY id DESC LIMIT ?`,
      [groupId, limit],
    ));
    return rows.reverse();
  };

  /**
   * OpenTeam M2: chain timestamp (seconds) of the sender's latest message in
   * this group; null when the peer never posted (or rows lack timestamps).
   */
  const queryLastSenderMessageChainSec = (
    db: Database,
    groupId: string,
    senderGlobalMetaId: string,
  ): number | null => {
    const result = db.exec(
      `SELECT MAX(chain_timestamp) FROM group_chat_messages
       WHERE group_id = ? AND sender_global_metaid = ?`,
      [groupId, senderGlobalMetaId],
    );
    const value = result[0]?.values?.[0]?.[0];
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const toMinutesText = (seconds: number): string => `${Math.max(1, Math.round(seconds / 60))} min`;

  const formatRemoteUnreachableFacts = (info: RemoteUnreachableInfo): string => {
    const offlineText = info.offlineSeconds != null
      ? `offline for ~${toMinutesText(info.offlineSeconds)}`
      : 'offline (last-seen unknown)';
    const silentText = info.silentSeconds != null
      ? `no message for ${toMinutesText(info.silentSeconds)}`
      : 'no message in this task yet';
    return `${offlineText}, ${silentText}`;
  };

  /**
   * OpenTeam M2: neutral fact block for the chair turn (roster-adjacent). The
   * wording states host-observed facts only — the playbook rules on remote
   * no-shows already tell the chair how to react, so the block just points
   * back at them. Purely real-time: when the teammate is reachable again the
   * next evaluation returns an empty list and the hint disappears.
   */
  const buildRemoteStatusBlock = (infos: RemoteUnreachableInfo[]): string => {
    if (infos.length === 0) return '';
    return [
      '[Remote teammate status — host-observed facts]',
      ...infos.map(
        (info) => `- ${info.name} (remote teammate) is currently unreachable: ${formatRemoteUnreachableFacts(info)}.`,
      ),
      'Apply your playbook rules for unresponsive remote teammates (re-assign the work and/or explain the change to the owner) as you judge fit.',
    ].join('\n');
  };

  /**
   * OpenTeam M2: evaluate remote teammates (metabotId == null, globalmetaid
   * set) of one ACTIVE task and return the currently-unreachable ones.
   * "Unreachable" = presence says offline AND no group message within
   * remoteUnreachableAfterMs. Probes are throttled to one per task per
   * remotePresenceThrottleMs; between probes the cached snapshot is reused so
   * the chair hint stays stable. A failed probe silently keeps the previous
   * snapshot (first failure => empty). Side effect: the FIRST evaluation that
   * finds a teammate unreachable sends one private owner brief via
   * sendOwnerPrivateReport; the flag resets when the teammate is reachable
   * again or the task leaves the active set (pruned in runTick).
   */
  const evaluateRemoteTeammates = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    ownerGlobalMetaId: string,
  ): Promise<RemoteUnreachableInfo[]> => {
    if (!task.groupId) return [];
    const remoteMembers = members.filter(
      (member) => member.metabotId == null && Boolean(member.globalmetaid?.trim()),
    );
    // A kicked member leaves the active remote set while the task itself stays
    // active: its owner-notified key would otherwise linger forever and
    // suppress a fresh notification when a re-invited teammate goes silent
    // again. Prune stale keys for this task on every evaluation round.
    const activeRemoteGmids = new Set(
      remoteMembers.map((member) => member.globalmetaid!.trim().toLowerCase()),
    );
    for (const key of [...remoteUnreachableNotified]) {
      const separator = key.indexOf(':');
      if (Number(key.slice(0, separator)) !== task.id) continue;
      if (!activeRemoteGmids.has(key.slice(separator + 1))) {
        remoteUnreachableNotified.delete(key);
      }
    }
    if (remoteMembers.length === 0) {
      remotePresenceByTask.delete(task.id);
      return [];
    }
    if (!deps.fetchRemotePresence) return [];

    const cached = remotePresenceByTask.get(task.id);
    if (cached && now() - cached.queriedAt < remotePresenceThrottleMs) {
      return cached.unreachable;
    }

    let entries: GroupTaskRemotePresenceEntry[];
    try {
      entries = await deps.fetchRemotePresence(
        remoteMembers.map((member) => member.globalmetaid!.trim()),
      );
    } catch (error) {
      // Silent skip: keep the previous snapshot, throttle the next attempt.
      remotePresenceByTask.set(task.id, {
        queriedAt: now(),
        unreachable: cached?.unreachable ?? [],
      });
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: remote presence probe failed; keeping previous snapshot: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return cached?.unreachable ?? [];
    }

    const db = deps.getStore().getDatabase();
    const nowSec = Math.floor(now() / 1000);
    const unreachable: RemoteUnreachableInfo[] = [];
    for (const member of remoteMembers) {
      const globalMetaId = member.globalmetaid!.trim();
      // Join grace: a teammate whose membership row is younger than the
      // unreachable window has not had a fair chance to speak yet — never
      // flag them unreachable (and never notify the owner) this early.
      const joinedMs = parseSqliteUtcMs(member.createdAt);
      if (Number.isFinite(joinedMs) && now() - joinedMs < remoteUnreachableAfterMs) {
        continue;
      }
      const entry = entries.find(
        (candidate) => candidate.globalMetaId.trim().toLowerCase() === globalMetaId.toLowerCase(),
      );
      if (entry?.isOnline) continue; // reachable — no hint, notification flag resets below
      const lastMessageSec = queryLastSenderMessageChainSec(db, task.groupId, globalMetaId);
      const silentSeconds = lastMessageSec != null ? Math.max(0, nowSec - lastMessageSec) : null;
      if (silentSeconds != null && silentSeconds * 1000 < remoteUnreachableAfterMs) {
        continue; // offline but recently active in the group — not unreachable
      }
      const lastSeenAgoSeconds = Number(entry?.lastSeenAgoSeconds);
      unreachable.push({
        globalMetaId,
        name: member.name ?? `remote-${globalMetaId.slice(0, 10) || 'unknown'}`,
        offlineSeconds: Number.isFinite(lastSeenAgoSeconds) && lastSeenAgoSeconds > 0
          ? lastSeenAgoSeconds
          : null,
        silentSeconds,
      });
    }
    remotePresenceByTask.set(task.id, { queriedAt: now(), unreachable });

    // Owner brief: exactly once per (task, member) unreachable streak.
    const reachableAgain = remoteMembers.filter(
      (member) => !unreachable.some(
        (info) => info.globalMetaId.toLowerCase() === member.globalmetaid!.trim().toLowerCase(),
      ),
    );
    for (const member of reachableAgain) {
      remoteUnreachableNotified.delete(`${task.id}:${member.globalmetaid!.trim().toLowerCase()}`);
    }
    if (unreachable.length > 0 && deps.sendOwnerPrivateReport) {
      const chairMember = members.find((member) => member.role === 'chair');
      const chairBot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
      for (const info of unreachable) {
        const notifyKey = `${task.id}:${info.globalMetaId.toLowerCase()}`;
        if (remoteUnreachableNotified.has(notifyKey)) continue;
        if (!chairBot || !ownerGlobalMetaId) break; // cannot address the owner; retry next probe
        try {
          await deps.sendOwnerPrivateReport({
            taskId: task.id,
            metabotId: chairBot.id,
            ownerGlobalMetaId,
            text:
              `[OpenTeam] Group task "${task.title}": remote teammate "${info.name}" ` +
              `appears unreachable (${formatRemoteUnreachableFacts(info)}). I have this fact in my ` +
              'context and will re-assign their part if the silence continues.',
          });
          remoteUnreachableNotified.add(notifyKey);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: owner notified that remote teammate ${info.name} is unreachable`,
          );
          // G-01: the origin session hears the same anomaly (member unreachable
          // after retry window) — never silent.
          notifySourceSessionMilestone(
            task,
            'anomaly',
            buildSourceSessionAnomalyNotice({
              title: task.title,
              status: task.status,
              summary:
                `Remote teammate "${info.name}" appears unreachable ` +
                `(${formatRemoteUnreachableFacts(info)}). The chair will re-assign their part if the silence continues.`,
            }),
            `remote_unreachable:${info.globalMetaId.toLowerCase()}`,
          );
        } catch (error) {
          // Not marked as notified — the next probe retries (throttled).
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: unreachable-owner-brief failed for ${info.name}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return unreachable;
  };

  const recordGroupTaskMessageForLocalMembers = (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
  ): void => {
    const participants = members.map((member) => {
      const bot = member.metabotId == null ? null : botsById.get(member.metabotId);
      const globalMetaID = (member.globalmetaid ?? bot?.globalmetaid ?? '').trim();
      return globalMetaID
        ? { globalMetaID, role: member.role }
        : { unresolvedActorKey: `group-task-member:${member.id}`, role: member.role };
    });
    const coworkStore = deps.getCoworkStore();
    for (const member of members) {
      if (member.metabotId == null) continue;
      const bot = botsById.get(member.metabotId);
      if (!bot?.globalmetaid?.trim()) continue;
      const mapping = coworkStore.getConversationMapping(
        CONVERSATION_CHANNEL,
        `group-task:${task.id}`,
        bot.id,
      );
      try {
        recordMetaIDGroupTaskExperience({
          store: experienceStore,
          ownerGlobalMetaID: bot.globalmetaid,
          taskId: task.id,
          groupId: task.groupId,
          sessionId: mapping?.coworkSessionId ?? null,
          message: {
            id: message.id,
            pinId: message.pinId,
            txId: message.txId,
            senderGlobalMetaID: message.senderGlobalMetaId,
            senderMetaID: message.senderMetaId,
            content: message.content,
            occurredAt: message.chainTimestamp,
            replyPin: message.replyPin,
          },
          participants,
        });
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: experience capture failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * fix-v2 (B6): one authoritative host-state line on EVERY turn — the task's
   * live status, the ledger size, and the review gate. A rebuilt or long-lived
   * session must never narrate "awaiting owner acceptance" from memory while
   * the host DB says the task never entered review (task #55's chair amnesia
   * misreport). The line states facts for every role; the chair playbook rules
   * make the review gate explicit.
   */
  const buildAuthoritativeStateLine = (task: GroupTask): string => {
    let ledgerNote = '';
    try {
      const deliverables = deps.getGroupTaskStore().listDeliverables(task.id);
      const confirmed = deliverables.filter((deliverable) => deliverable.confirmation === 'confirmed').length;
      ledgerNote = `deliverables on ledger: ${deliverables.length} (${confirmed} on-chain confirmed); `;
    } catch {
      // best-effort ledger read
    }
    const reviewGate = task.status === 'review'
      ? 'the task IS in review — owner acceptance is pending'
      : 'the task is NOT in review — never announce that it is finished or awaiting owner acceptance until [STATUS:REVIEW] has been applied';
    return `[Authoritative task state (host DB): status=${task.status}; ${ledgerNote}${reviewGate}]`;
  };

  const buildGroupLogUserMessage = (
    db: Database,
    task: GroupTask,
    triggering: GroupTaskDaemonMessage,
  ): string => {
    const recent = queryRecentMessages(db, task.groupId!, contextMessageCount);
    // Entropy P0: every message is head+tail truncated and runs of ceremony
    // ACK lines fold into one counter line, so the same token stops being
    // re-paid as recurring input heat every turn (knob: logFold).
    const logEntropyP0 = parseGroupTaskEntropyP0Config(
      deps.getStore().get<string>('groupTaskEntropyP0'),
    );
    const entries = recent.map((row) => {
      const message = toDaemonMessage(row);
      return {
        // Round-4: SUSPECT senders are flagged in context — the bot must never
        // mistake a non-member's display name for a member's identity.
        senderName: message.senderName,
        suspect: Boolean(message.senderSuspect),
        content: message.content ?? '',
        isTrigger: row.id === triggering.id,
      };
    });
    const lines = renderGroupLogLines(entries, { fold: logEntropyP0.logFold });
    return [
      buildAuthoritativeStateLine(task),
      `[Group Task "${task.title}" (#${task.id}) — recent group log (last ${contextMessageCount} messages; protocol lines ([DELIVERABLE]/[FREEZE]/[STATUS:]/[PLAN_CHANGE]/[CHECKPOINT]) and the triggering message are shown in full, other long messages are head+tail truncated, acknowledgment lines folded; to read any message in full use the group-task show action with view=full / before_id paging)]`,
      ...lines,
    ].join('\n');
  };

  /**
   * Per-turn session lookup, delegated to the shared helper (groupTaskSession)
   * so the eager pre-creation path (invite/join) and the daemon always agree
   * on the SAME mapping (P1-3: one session-creation code path).
   *
   * fix-v2 (B6): creation goes through ensureGroupTaskMemberReady so a session
   * (re)created MID-task — a lost mapping or a rebuilt chair session — gets the
   * full context snapshot INCLUDING the authoritative task ledger (status,
   * status trail, deliverables). Rebuilding from the truncated recent-message
   * window alone is exactly how task #55's chair lost its acceptance memory
   * and misreported "waiting for owner acceptance" while still executing.
   */
  const ensureTaskSession = (
    coworkStore: CoworkStore,
    task: GroupTask,
    botId: number,
    botName: string,
  ): CoworkSession => {
    const { sessionId } = ensureGroupTaskMemberReady({
      coworkStore,
      groupTaskStore: deps.getGroupTaskStore(),
      task,
      botId,
      botName,
    });
    const session = coworkStore.getSession(sessionId);
    if (session) return session;
    // Unreachable in practice (the session was just created); fall back to the
    // bare find-or-create so the turn never crashes on a store hiccup.
    return ensureGroupTaskSession(coworkStore, task, botId, botName).session;
  };

  /**
   * Unambiguous per-turn local time line (mirrors coworkRunner's Local Time
   * Context intent): local datetime, UTC offset, host timezone, and the long date.
   */
  const formatTurnTimeText = (): string => {
    const date = new Date(now());
    const pad = (value: number): string => String(value).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const utcOffset = `${sign}${Math.floor(Math.abs(offsetMinutes) / 60)}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
    const longDate = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    return `Current time: ${local} (UTC${utcOffset}, ${timezone}); today is ${weekday}, ${longDate}.`;
  };

  /**
   * A2A experience/memory block for the responding bot, built with the SAME
   * exported builder the private-chat path uses (buildExperiencePromptBlocksXml)
   * fed through narrow injected memory/dream getters. '' when unwired or empty.
   */
  const buildExperienceBlockFor = (bot: GroupTaskDaemonBotFull): string => {
    if (!deps.listUserMemories && !deps.listDailySummaries) return '';
    try {
      const identityEntry = deps.listUserMemories?.(bot.id, { usageClass: 'self_identity', limit: 1 })?.[0];
      const valueBoundaries = deps.listUserMemories?.(bot.id, { usageClass: 'value_boundary', limit: 5 }) ?? [];
      // Past work reviews (dream-written, aligned with the owner's acceptance
      // ratings) — the recall path that keeps prior group-task feedback in play.
      const workReviews = deps.listUserMemories?.(bot.id, { usageClass: 'work_review', limit: 5 }) ?? [];
      const summaries = deps.listDailySummaries?.(bot.id, RECENT_SUMMARIES_PROMPT_DAYS) ?? [];
      const block = buildExperiencePromptBlocksXml({
        identityText: identityEntry?.text ?? null,
        valueBoundaries,
        workReviews,
        summaries,
      }).trim();
      if (!block) return '';
      return block.length > EXPERIENCE_BLOCK_MAX_CHARS
        ? `${truncateUtf16Units(block, EXPERIENCE_BLOCK_MAX_CHARS)}…`
        : block;
    } catch {
      return '';
    }
  };

  /**
   * Observer-relative MetaID impression summaries for the group roster, built
   * by the shared cognition service and capped defensively. Failure omits the
   * block without blocking the group turn.
   */
  const buildGroupCognitionBlockFor = async (
    bot: GroupTaskDaemonBotFull,
    promptMembers: DaemonPromptMember[],
    task: GroupTask,
  ): Promise<string> => {
    if (!deps.getMetaIDGroupCognitionPromptBlock || !bot.globalmetaid?.trim()) return '';
    const roster = promptMembers
      .map((member) => ({
        globalMetaID: member.globalMetaId?.trim() ?? null,
        name: member.name,
        role: member.role,
      }))
      .filter((member): member is { globalMetaID: string; name: string; role: 'chair' | 'worker' } =>
        Boolean(member.globalMetaID));
    // Entropy P1: the cognition block is rebuilt per turn per responder but
    // its impression snapshots change on dream / task-close cadence — a short
    // TTL cache keyed by (task, bot, observer GlobalMetaID) with a roster
    // fingerprint (id+role+name, so joins/leaves/renames invalidate) removes
    // the per-tick rebuild. Staleness is bounded by the TTL: contact-state
    // lines (episode counts, first/last contact) can lag up to 5 minutes;
    // snapshot-derived content only changes when the dream/close writers run.
    const entropyP1 = parseGroupTaskEntropyP1Config(
      deps.getStore().get<string>('groupTaskEntropyP1'),
    );
    const rosterKey = roster.map((member) => `${member.globalMetaID}:${member.role}:${member.name}`).join('|');
    const cacheKey = `${task.id}:${bot.id}:${bot.globalmetaid}`;
    const currentTimeMs = now();
    const cached = entropyP1.cognitionCache ? cognitionBlockCache.get(cacheKey) : undefined;
    if (cached && cached.rosterKey === rosterKey && cached.expiresAt > currentTimeMs) {
      return cached.block;
    }
    try {
      const block = (await deps.getMetaIDGroupCognitionPromptBlock({
        observerGlobalMetaID: bot.globalmetaid,
        roster,
      })).trim();
      const bounded = block.length > GROUP_COGNITION_BLOCK_MAX_CHARS
        ? `${block.slice(0, GROUP_COGNITION_BLOCK_MAX_CHARS)}…`
        : block;
      if (entropyP1.cognitionCache) {
        while (cognitionBlockCache.size >= COGNITION_BLOCK_CACHE_MAX_ENTRIES) {
          // Evict the soonest-expiring entry: freshest knowledge keeps its slot.
          let oldestKey: string | null = null;
          let oldestExpiry = Number.POSITIVE_INFINITY;
          for (const [key, entry] of cognitionBlockCache) {
            if (entry.expiresAt < oldestExpiry) {
              oldestExpiry = entry.expiresAt;
              oldestKey = key;
            }
          }
          if (oldestKey == null) break;
          cognitionBlockCache.delete(oldestKey);
        }
        cognitionBlockCache.set(cacheKey, {
          rosterKey,
          block: bounded,
          expiresAt: currentTimeMs + COGNITION_BLOCK_CACHE_TTL_MS,
        });
      }
      return bounded;
    } catch (error) {
      deps.emitLog?.(
        `[GroupTaskDaemon] MetaID group cognition projection unavailable for bot ${bot.id}; continuing without impression context: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  };

  /**
   * Per-turn prompt split into a STABLE system prompt (base only — no time, no
   * experience/cognition blocks) and a volatile tail for the user message.
   * The system prompt leads DeepSeek's cacheable prefix and is also compared
   * against the cowork session's stored prompt: any byte change resets the
   * underlying SDK session (full cold start). Minute-precision time and
   * nightly-rewritten dream summaries used to live in the system prompt, so
   * every group turn reset the session and missed the entire cache. They now
   * ride the user message instead (Reasonix: volatile state in the turn tail).
   */
  const buildTurnSystemPrompt = async (
    bot: GroupTaskDaemonBotFull,
    task: GroupTask,
    promptMembers: DaemonPromptMember[],
    botRole: 'chair' | 'worker',
    ownerGlobalMetaId: string,
  ): Promise<{ systemPrompt: string; volatileContext: string }> => {
    const experienceBlock = buildExperienceBlockFor(bot);
    // Entropy P1 (narrow specific heat): a worker's collaboration partner is
    // the chair — dispatch, verification and arbitration all flow through it —
    // so peer impressions are loaded history the worker never acts on. Workers
    // get a chair-only cognition roster; the chair keeps the full roster
    // because arbitration needs every member's temperature.
    const turnEntropyP1 = parseGroupTaskEntropyP1Config(
      deps.getStore().get<string>('groupTaskEntropyP1'),
    );
    const chairMembers = promptMembers.filter((member) =>
      member.role === 'chair' && member.globalMetaId?.trim());
    const useChairOnly = botRole === 'worker' && turnEntropyP1.workerChairOnly && chairMembers.length > 0;
    const cognitionMembers = useChairOnly ? chairMembers : promptMembers;
    const cognitionBlock = await buildGroupCognitionBlockFor(bot, cognitionMembers, task);
    const cultureBlock = deps.buildTeamCultureBlock?.() ?? null;
    const systemPrompt = buildGroupTaskSystemPrompt({
      metabot: bot,
      task: {
        title: task.title,
        goal: task.goal,
        acceptanceCriteria: task.acceptanceCriteria,
        groupId: task.groupId ?? null,
      },
      members: promptMembers,
      botRole,
      ownerGlobalMetaId: ownerGlobalMetaId || null,
    });
    const volatileContext = [formatTurnTimeText(), cultureBlock, experienceBlock, cognitionBlock]
      .filter((section) => section?.trim())
      .join('\n\n');
    return { systemPrompt, volatileContext };
  };

  /** Plausible pinid/txid candidates in a [DELIVERABLE] line (deduped, capped). */
  const extractIdCandidates = (content: string): string[] => {
    const matches = content.match(DELIVERABLE_ID_CANDIDATE) ?? [];
    return [...new Set(matches)].slice(0, MAX_VERIFICATION_CANDIDATES);
  };

  /**
   * Deliverable verification hints: format-check any pinid/txid-looking token
   * ON THE [DELIVERABLE] TAG LINES ONLY (P1-4 r2 — body prose is not scanned),
   * then (when wired) an on-chain existence check via getPinData. Round-4 also
   * HTTP-probes key https:// links on the tag lines (HEAD, GET fallback) so the
   * chair's acceptance is auto-informed — a link that returns 4xx/5xx is
   * flagged for clarification instead of being copied verbatim (the #7
   * /browser/buzz/ vs /browser/pin/ correction case). The notes are appended
   * to the chair's context so it verifies before accepting.
   */
  const verifyDeliverableCandidates = async (deliverableTagText: string): Promise<string[]> => {
    const notes: string[] = [];
    for (const token of extractIdCandidates(deliverableTagText)) {
      const display = token.length > 16 ? `${token.slice(0, 12)}…` : token;
      const isPinid = PINID_FORMAT.test(token);
      const isTxid = TXID_FORMAT.test(token);
      if (!isPinid && !isTxid) {
        notes.push(
          `⚠ Host verification: reported pinid "${display}" FAILS format validation ` +
          '(expected 64 lowercase hex + i0).',
        );
        continue;
      }
      const label = isPinid ? 'pinid' : 'txid';
      if (!deps.readPinForVerification) {
        notes.push(`… Host verification: ${label} format valid; on-chain check unavailable.`);
        continue;
      }
      try {
        const outcome = await deps.readPinForVerification(isPinid ? token : `${token}i0`);
        if (outcome === 'found') {
          notes.push(`✓ Host verification: ${label} format valid; pin found on-chain (via getPinData/manapi).`);
        } else if (outcome === 'not_found') {
          notes.push(`⚠ Host verification: ${label} format valid but pin NOT found on-chain (via getPinData/manapi).`);
        } else {
          notes.push(`… Host verification: ${label} format valid; on-chain check unavailable.`);
        }
      } catch {
        notes.push(`… Host verification: ${label} format valid; on-chain check unavailable.`);
      }
    }
    // Round-4: HTTP probe on key https:// links from the [DELIVERABLE] tag
    // lines (only). Probe results ride the chair's verification notes.
    const urlCandidates = extractUrlCandidates(deliverableTagText);
    for (const url of urlCandidates) {
      const status = await probeUrl(url);
      const short = url.length > 48 ? `${url.slice(0, 44)}…` : url;
      if (status == null) {
        notes.push(`… Host verification: HTTP probe ${short} unavailable (timeout/network).`);
      } else if (status >= 200 && status < 400) {
        notes.push(`✓ Host verification: HTTP probe ${short} → ${status} (link reachable).`);
      } else {
        notes.push(
          `⚠ Host verification: HTTP probe ${short} → ${status} — link may be invalid; verify before accepting.`,
        );
      }
    }
    return notes;
  };

  /**
   * Round-4: https?:// URLs on the [DELIVERABLE] tag lines only (deduped,
   * capped). Body prose is never scanned (P1-4 r2 heritage).
   */
  const extractUrlCandidates = (content: string): string[] => {
    const matches = content.match(/https?:\/\/[^\s()（）<>\[\]`*_]+/gi) ?? [];
    const cleaned = matches.map((url) => url.replace(/[，。；、！？!?.,;:)+]+$/g, ''));
    return [...new Set(cleaned)].slice(0, MAX_VERIFICATION_CANDIDATES);
  };

  /**
   * System-generated owner-report directive for the review transition. R1: the
   * directive no longer re-assembles the deliverable list itself — it reads the
   * host's deterministic acceptance summary (already published as the group's
   * last message) as the single source of truth and asks the chair only to
   * narrate it into a concise private report. The three channels (group summary
   * message, this private report, R2 source-session notification) thus render
   * from one record and cannot drift. Falls back to re-stating goal/criteria
   * inline when no summary has been persisted yet.
   *
   * Improvement #5 (task #25): an accept/rework recommendation is only
   * requested when EVERY deliverable is on-chain confirmed. Otherwise the
   * ledger is incomplete by construction (local-path deliveries render as
   * "(no uri) (pending, unconfirmed)" while the artifacts may well exist on
   * disk/chain), so the report must state facts and defer the verdict to the
   * chair's in-group first-hand verification and the owner's Tasks-UI decision
   * — never self-invent a "request rework" from `pending` alone.
   */
  const buildOwnerReportDirective = (store: GroupTaskStore, task: GroupTask): string => {
    const summary = store.getLatestAcceptanceSummary(task.id);
    const deliverables = summary?.deliverables ?? [];
    const deliverableLines = deliverables.map(
      (deliverable) =>
        `- [${deliverable.kind ?? 'text'}] ${deliverable.uri ?? '(no uri)'} (${deliverable.status}, ${deliverable.confirmation}) — ${deliverable.authorName ?? 'unknown'}`,
    );
    // Improvement #4 (v1.3): the plan-change disclosure block — one line per
    // change the chair itself posted in-group (original plan -> blocker ->
    // fallback). Rendered from the acceptance-summary snapshot so the private
    // report, the source-session report and the Tasks UI can never drift.
    // Omitted entirely when nothing changed (no noise).
    const planChangeLines = (summary?.planChanges ?? []).map((change) => `- ${change}`);
    const planChangeBlock = planChangeLines.length > 0
      ? [
        '',
        'Plan changes (the plan-change decisions you announced in-group — restate each as ONE short line "original plan -> what blocked it -> what was switched to"; do not expand them into paragraphs):',
        ...planChangeLines,
      ]
      : [];
    // G-04: the owner report narrates the supervision trail too — every
    // nudge/flag/pause/resume the Twin channel injected during the run.
    const supervisorLines = (() => {
      try {
        return store.listSupervisorSignalLines(task.id);
      } catch {
        return [];
      }
    })();
    const supervisorBlock = supervisorLines.length > 0
      ? [
        '',
        'Supervisor interventions recorded during the run (Twin supervisor channel; restate each as ONE line, do not expand):',
        ...supervisorLines.map((line) => `- ${line}`),
      ]
      : [];
    const allOnChainConfirmed =
      deliverables.length > 0 && deliverables.every((deliverable) => deliverable.confirmation === 'confirmed');
    const verdictInstruction = allOnChainConfirmed
      ? [
          '- Lead with your conclusion.',
          '- Recommend an action (accept & close, or request rework — of what). The owner only needs to confirm acceptance in the Tasks UI or send the task back for rework; never end with an open-ended "what would you like to do next?".',
        ]
      : [
          '- Report FACTS ONLY: what each member did, and which deliverables are on-chain confirmed vs. only locally present / pending (recorded but not uploaded as on-chain metafiles).',
          '- Do NOT recommend accepting or reworking, and do NOT invent a verdict: not every deliverable is on-chain confirmed, and this ledger alone cannot tell whether the artifacts actually exist. Never treat "pending", "unconfirmed", or "(no uri)" as grounds for requesting rework.',
          '- Explicitly defer the decision: state that the chair\'s first-hand verification verdict in the group is authoritative, and that the owner decides in the Tasks UI. Never end with an open-ended "what would you like to do next?".',
        ];
    // G-05: the report must answer the CREATE-TIME acceptance criteria
    // one-by-one on ASCII protocol lines the host parses, and park everything
    // the criteria never asked for under [OBSERVATION] — extra findings are
    // explicitly NON-blocking (task #48: "archive not on-chain" was listed as
    // a gap although the criteria only said "archive one item, dedupe first").
    const hasCriteria = Boolean((summary?.acceptanceCriteria ?? task.acceptanceCriteria ?? '').trim());
    const criteriaCheckInstruction = hasCriteria
      ? [
          '- CRITERIA CHECK (machine-parsed — exact line format required): after the conclusion line, output ONE line per acceptance criterion declared at creation, in order, each formatted exactly as:',
          '  `[CRITERION:PASS] <criterion> — <one-line evidence>` / `[CRITERION:FAIL] <criterion> — <what is missing>` / `[CRITERION:UNCLEAR] <criterion> — <why it cannot be verified>`.',
          '  Judge each criterion strictly AS WRITTEN at create time. On-chain confirmation state is EVIDENCE, not itself a criterion — never fail a criterion for "not on-chain" unless the criterion explicitly demands on-chain publication.',
          '- Findings OUTSIDE the declared criteria (quality opinions, extras you wish had been required, on-chain-state notes) go on separate `[OBSERVATION] <one line>` lines — they are informational for the owner and must NEVER count against a criterion verdict or the accept/rework recommendation.',
        ]
      : [];
    return [
      '[SYSTEM owner-report directive — generated by the host, not by a group participant]',
      `The group task "${task.title}" just moved to REVIEW. The host has generated a deterministic acceptance summary for the group (goal, deliverable list, verification, guidance) — it is reproduced verbatim below as the single source of truth. Compose a concise PRIVATE report to the owner that NARRATES it:`,
      // Improvement #1 (single-card acceptance): the machine-parsable 【结论】
      // first line feeds the acceptance-card headline, the group summary lead
      // and the origin-session notice — one authoritative string per review
      // entry. Under the facts-only gate below, the line is a factual deferral,
      // never an invented verdict (Improvement #5).
      `- FORMAT REQUIREMENT: ${copyConclusionTagInstruction()} The host extracts that line verbatim as the single conclusion string reused by the Tasks acceptance-card headline, the group summary, and the origin-session notice. When the verdict rules below allow a recommendation, make it the verdict (accept & close, or rework and of what); under the facts-only rules make it a one-line factual deferral. Never a question.`,
      '- Restate the goal briefly.',
      '- Say what each member did (by name) and whether the deliverables are on-chain confirmed.',
      ...criteriaCheckInstruction,
      // Reputation temperature arbitration: the roster cognition block carries
      // a recency-weighted cooperation score per member; disputes resolve
      // toward the higher temperature instead of burning communication rounds.
      '- If members disagree on the verdict or on credit, weigh the cooperation temperature shown in the roster cognition block: higher temperature (more recent accepted collaboration) earns the benefit of the doubt, lower temperature gets specific verifiable asks instead of bare trust.',
      ...verdictInstruction,
      ...(planChangeBlock.length > 0
        ? [
          '- Include the plan-change lines below in one short "plan changed" passage so the owner understands why the artifact looks the way it does. If the list below is empty, do NOT mention plan changes at all.',
        ]
        : []),
      ...(supervisorBlock.length > 0
        ? [
          '- Include the supervisor-intervention lines below in one short passage (what the supervisor asked/flagged and how it was handled). If the list below is empty, do NOT mention supervisor interventions at all.',
        ]
        : []),
      '',
      `Goal: ${summary?.goal ?? task.goal}`,
      `Acceptance criteria: ${(summary?.acceptanceCriteria ?? task.acceptanceCriteria)?.trim() || '(none specified)'}`,
      'Deliverables recorded (from the host acceptance summary):',
      ...(deliverableLines.length > 0 ? deliverableLines : ['(none recorded)']),
      ...planChangeBlock,
      ...supervisorBlock,
    ].join('\n');
  };

  /**
   * Improvement #2 (v1.3): age in ms of the most recent rework-hatch stamp
   * (`group_task_rework_at:<taskId>`), or Infinity when no fresh stamp exists.
   * See GROUP_TASK_REWORK_AT_KV_PREFIX for why the STATUS-tag handler debounces
   * review re-entries against it.
   */
  const freshReworkAgeMs = (taskId: number): number => {
    const reworkAt = Number(deps.getStore().get<string>(`${GROUP_TASK_REWORK_AT_KV_PREFIX}${taskId}`)) || 0;
    if (reworkAt <= 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, now() - reworkAt);
  };

  /**
   * Owner report on review: one private A2A report from the chair to the owner
   * per task per review-entry (kv guard group_task_owner_reported:<taskId>;
   * cleared when the task re-enters executing via the rework hatch). The report
   * is never posted to the group; failures only log, never block the tick.
   */
  /**
   * G-01: best-effort milestone notice into the origin CoWork session.
   * Guarded once per (kind, task, subject) HERE on the daemon side using the
   * SAME kv key the service-side notifySourceSessionMilestone uses
   * (`group_task_milestone_notified:<kind>:<taskId>[:subject]`) — the daemon
   * never re-fires a node in one pass, the service re-checks under its own
   * seam, and the rework hatch clears the shared key to re-arm dispatch. A
   * missing dep or a failed delivery never blocks the tick.
   */
  const notifySourceSessionMilestone = (
    task: GroupTask,
    kind: 'created' | 'dispatch' | 'checkpoint' | 'anomaly',
    message: string,
    subject?: string | null,
  ): void => {
    if (!task.sourceSessionId?.trim()) return; // panel-created / pre-R2 task
    if (!deps.sendMilestoneToSourceSession) return; // seam not wired (tests)
    const sqlite = deps.getStore();
    const subjectKey = subject?.trim() ? `:${subject.trim()}` : '';
    const guardKey = `group_task_milestone_notified:${kind}:${task.id}${subjectKey}`;
    if (sqlite.get<string>(guardKey) === '1') return;
    try {
      const sent = deps.sendMilestoneToSourceSession({
        taskId: task.id,
        kind,
        message,
        subject: subject ?? null,
      });
      if (sent) {
        sqlite.set(guardKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${kind} milestone reported to origin session ` +
          `${task.sourceSessionId}${subjectKey}`,
        );
      }
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: ${kind} milestone report failed (tick continues): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const maybeSendOwnerReport = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<void> => {
    if (!deps.sendOwnerPrivateReport) {
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: 'owner report transport unavailable',
        at: now(),
      });
      return;
    }
    const sqlite = deps.getStore();
    const guardKey = `${GROUP_TASK_OWNER_REPORTED_KV_PREFIX}${task.id}`;
    if (sqlite.get<string>(guardKey) === '1') return;
    // Improvement #2 (v1.3): status re-validation — a rework hatch (RPC/UI
    // path) can land between the review transition and this point without any
    // group message; never compose a report for a task that already left
    // review (task #24's review-report / executing contradiction).
    if (deps.getGroupTaskStore().getTaskById(task.id)?.status !== 'review') {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: owner report skipped — task is no longer in review`);
      return;
    }

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    const ownerGlobalMetaId = (bot?.boss_global_metaid ?? '').trim();
    if (!chairMember || !bot || !ownerGlobalMetaId) {
      const error = 'chair bot or owner GlobalMetaID unavailable';
      emitLog(`[GroupTaskDaemon] Task ${task.id}: owner report skipped (${error})`);
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error,
        at: now(),
      });
      return;
    }

    try {
      const store = deps.getGroupTaskStore();
      const coworkStore = deps.getCoworkStore();
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const systemPrompt = systemPromptParts.systemPrompt;
      // Volatile context (time + experience/cognition) rides the user turn.
      const directive = [systemPromptParts.volatileContext, buildOwnerReportDirective(store, task)]
        .filter(Boolean)
        .join('\n\n');
      const brain = metabotBrainOptions(bot);
      const llmId = brain.llmId ?? undefined;
      const fallbackLlmId = brain.fallbackLlmId;
      const report = (await performChatWithTimeout(systemPrompt, directive, llmId, {
        llmProvider: brain.llmProvider,
        fallbackLlmId,
        fallbackLlmProvider: brain.fallbackLlmProvider,
        effort: brain.effort,
        fallbackEffort: brain.fallbackEffort,
        thinking: 'enabled',
      })).trim();
      if (!report || NO_REPLY_PATTERN.test(report)) {
        throw new Error('owner report turn produced no report');
      }
      // Improvement #2 (v1.3): the report turn above is slow (LLM); a rework
      // may have moved the task back to executing while it ran (the task #24
      // 27-second race). Delivering now would show the origin session a
      // [GROUP_TASK_REVIEW] report while the Tasks UI says executing — abort.
      // The rework hatch already cleared the delivery guards, so the next
      // review entry re-reports cleanly on every channel.
      if (deps.getGroupTaskStore().getTaskById(task.id)?.status !== 'review') {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: owner report aborted — the task left review while the report was being composed`,
        );
        return;
      }
      // Improvement #1 (single-card acceptance): extract the chair's one-line
      // 【结论】 verdict and stamp it onto the latest acceptance-summary record
      // BEFORE any downstream surface renders — the stored string then heads the
      // group summary message (posted right after this step by the review-entry
      // ceremony) and the origin-session notice, so every surface carries the
      // same authoritative copy. Best-effort: a store failure never blocks the
      // report delivery.
      const conclusion = extractChairConclusion(report);
      if (conclusion) {
        try {
          store.updateAcceptanceSummaryConclusion(task.id, conclusion);
        } catch (conclusionError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: acceptance conclusion record failed: ` +
            `${conclusionError instanceof Error ? conclusionError.message : String(conclusionError)}`,
          );
        }
      }
      // G-05: stamp the per-criterion verdicts + non-blocking observations
      // onto the same record BEFORE any downstream surface renders — the group
      // summary message (re-rendered below), the Tasks acceptance card, and
      // the origin-session notice then all show the SAME criteria check.
      // Best-effort: a store failure never blocks the report delivery.
      const criteriaCheck = extractCriteriaVerdicts(report);
      if (criteriaCheck.verdicts.length > 0 || criteriaCheck.observations.length > 0) {
        try {
          store.updateAcceptanceSummaryCriteriaVerdicts(
            task.id,
            criteriaCheck.verdicts,
            criteriaCheck.observations,
          );
        } catch (criteriaError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: acceptance criteria-verdict record failed: ` +
            `${criteriaError instanceof Error ? criteriaError.message : String(criteriaError)}`,
          );
        }
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: criteria check captured — ` +
          `${criteriaCheck.verdicts.filter((entry) => entry.verdict === 'pass').length} pass, ` +
          `${criteriaCheck.verdicts.filter((entry) => entry.verdict === 'fail').length} fail, ` +
          `${criteriaCheck.verdicts.filter((entry) => entry.verdict === 'unclear').length} unclear, ` +
          `${criteriaCheck.observations.length} observation(s)`,
        );
      }
      // P4 (v1.2): the origin CoWork session receives the SAME report body the
      // A2A private chat gets — the owner's repeated ask ("我在 co-work 对话中
      // 应该也要收到跟线上 A2A 对话相同内容或差不多内容的验收报告").
      // Improvement #1: with a captured conclusion the notice collapses to a
      // short verdict + pointer to the acceptance card instead of a parallel
      // full report. Best-effort and kv-guarded per review-entry (service
      // side), so an A2A delivery failure below does not lose the
      // source-session copy and a rework cycle re-reports on the next review.
      if (deps.sendReviewReportToSourceSession) {
        try {
          deps.sendReviewReportToSourceSession({ taskId: task.id, report, conclusion });
        } catch (sourceError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: review report to source session failed (A2A continues): ` +
            `${sourceError instanceof Error ? sourceError.message : String(sourceError)}`,
          );
        }
      }
      const delivery = await deps.sendOwnerPrivateReport({
        taskId: task.id,
        metabotId: bot.id,
        ownerGlobalMetaId,
        text: report,
      });
      sqlite.set(guardKey, '1');
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: delivery.pinId ?? null,
        sessionId: delivery.sessionId ?? null,
        displayError: delivery.displayError ?? null,
        at: now(),
      });
      // Record the private report in the chair's own group-task session (context
      // continuity), clearly marked as private — never posted to the group.
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, {
        type: 'assistant',
        content: `[Private report sent to the owner — not posted to the group]\n${report}`,
      });
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: owner report sent privately to the owner` +
        `${conclusion ? ` (conclusion captured: ${conclusion})` : ' (no 【结论】 tag captured)'}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: owner report failed (tick continues): ` +
        errorMessage,
      );
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: errorMessage,
        at: now(),
      });
    }
  };

  /**
   * System-generated checkpoint-report directive: the chair composes a PRIVATE
   * message to the owner presenting the draft/decision the checkpoint is about
   * and asking for the owner's call (confirm, or request changes).
   */
  const buildCheckpointReportDirective = (
    store: GroupTaskStore,
    task: GroupTask,
    checkpoint: GroupTaskCheckpoint,
  ): string => {
    const deliverables = store.listDeliverables(task.id);
    const deliverableLines = deliverables.map(
      (deliverable) =>
        `- [${deliverable.kind ?? 'text'}] ${deliverable.uri ?? '(no uri)'} (status: ${deliverable.status})`,
    );
    return [
      '[SYSTEM checkpoint directive — generated by the host, not by a group participant]',
      `The group task "${task.title}" is PAUSED at a human checkpoint you opened${checkpoint.topic ? ` ("${checkpoint.topic}")` : ''}. Compose a concise PRIVATE message to the owner covering:`,
      '- What is ready for the owner to review NOW (the draft, plan, or decision point — include the actual content or a clear summary, not just a mention of it).',
      '- The specific decision you need from the owner before work continues.',
      '- How the owner can answer: reply in the task group, or tell you privately in this chat (you then relay the decision into the group).',
      '',
      `Task goal: ${task.goal}`,
      ...(deliverableLines.length > 0
        ? ['Deliverables recorded so far:', ...deliverableLines]
        : []),
    ].join('\n');
  };

  /**
   * Checkpoint owner notification: one private A2A message from the chair to
   * the owner per checkpoint (kv guard group_task_checkpoint_reported:<taskId>:
   * <checkpointId>). Mirrors maybeSendOwnerReport; the message is never posted
   * to the group and failures only log, never block the tick.
   */
  const maybeSendCheckpointReport = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
    checkpoint: GroupTaskCheckpoint,
  ): Promise<void> => {
    if (!deps.sendOwnerPrivateReport) {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint report skipped (transport unavailable)`);
      return;
    }
    const sqlite = deps.getStore();
    const guardKey = `${GROUP_TASK_CHECKPOINT_REPORTED_KV_PREFIX}${task.id}:${checkpoint.id}`;
    if (sqlite.get<string>(guardKey) === '1') return;

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    const ownerGlobalMetaId = (bot?.boss_global_metaid ?? '').trim();
    if (!chairMember || !bot || !ownerGlobalMetaId) {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint report skipped (chair bot or owner GlobalMetaID unavailable)`);
      return;
    }

    try {
      const store = deps.getGroupTaskStore();
      const coworkStore = deps.getCoworkStore();
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const systemPrompt = systemPromptParts.systemPrompt;
      // Volatile context (time + experience/cognition) rides the user turn.
      const directive = [systemPromptParts.volatileContext, buildCheckpointReportDirective(store, task, checkpoint)]
        .filter(Boolean)
        .join('\n\n');
      const brain = metabotBrainOptions(bot);
      const llmId = brain.llmId ?? undefined;
      const fallbackLlmId = brain.fallbackLlmId;
      const report = (await performChatWithTimeout(systemPrompt, directive, llmId, {
        llmProvider: brain.llmProvider,
        fallbackLlmId,
        fallbackLlmProvider: brain.fallbackLlmProvider,
        effort: brain.effort,
        fallbackEffort: brain.fallbackEffort,
        thinking: 'enabled',
      })).trim();
      if (!report || NO_REPLY_PATTERN.test(report)) {
        throw new Error('checkpoint report turn produced no message');
      }
      const delivery = await deps.sendOwnerPrivateReport({
        taskId: task.id,
        metabotId: bot.id,
        ownerGlobalMetaId,
        text: report,
        kind: 'checkpoint',
        checkpointId: checkpoint.id,
      });
      // G-01: the origin session hears about the HITL checkpoint too (the
      // A2A private chat is not the only place the owner lives). Best-effort;
      // the report text is reused verbatim as the decision summary.
      notifySourceSessionMilestone(
        task,
        'checkpoint',
        buildSourceSessionCheckpointNotice({
          title: task.title,
          topic: checkpoint.topic,
          summary: report,
        }),
        `checkpoint:${checkpoint.id}`,
      );
      sqlite.set(guardKey, '1');
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: delivery.pinId ?? null,
        sessionId: delivery.sessionId ?? null,
        displayError: delivery.displayError ?? null,
        kind: 'checkpoint',
        checkpointId: checkpoint.id,
        at: now(),
      });
      // Record the private checkpoint message in the chair's own group-task
      // session (context continuity), clearly marked as private.
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, {
        type: 'assistant',
        content: `[Private checkpoint request sent to the owner — not posted to the group]\n${report}`,
      });
      emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint #${checkpoint.id} reported privately to the owner`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: checkpoint report failed (tick continues): ` +
        errorMessage,
      );
      deps.emitTaskEvent?.({
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: errorMessage,
        kind: 'checkpoint',
        checkpointId: checkpoint.id,
        at: now(),
      });
    }
  };

  /**
   * Round-4 correction-first matching: find the deliverable row a correction
   * message supersedes. The correction must come from the same author as the
   * original and reference the same object — matched by a shared 64-hex+i0
   * pinid token inside both URIs (the strongest signal: msg97's buzz URL and
   * msg99's corrected preview URL share the same buzz pinid). When the
   * candidate has no pinid token, fall back to the newest pending row of the
   * same kind by the same author. Rows already carrying the exact same URI
   * are never "superseded".
   */
  const findSupersededDeliverable = (
    taskId: number,
    senderGlobalMetaId: string | null,
    candidate: ParsedDeliverable,
  ): GroupTaskDeliverable | undefined => {
    const author = (senderGlobalMetaId ?? '').trim().toLowerCase();
    if (!author || !candidate.uri) return undefined;
    const candidatePinids = new Set(
      candidate.uri.match(/[0-9a-f]{64}i0/gi)?.map((token) => token.toLowerCase()) ?? [],
    );
    // Ledger fix (#14→#16): a REJECTED row is also supersedeable — the same
    // object re-delivered after the chair's reject is a new version of the
    // same ledger row, re-opened to pending, not a duplicate row.
    const candidatesByAuthor = deps.getGroupTaskStore().listDeliverables(taskId)
      .filter((deliverable) =>
        (deliverable.status === 'pending' || deliverable.status === 'rejected')
        && Boolean(deliverable.authorGlobalmetaid)
        && deliverable.authorGlobalmetaid!.trim().toLowerCase() === author,
      )
      .slice()
      .reverse(); // newest rows first
    for (const deliverable of candidatesByAuthor) {
      if (deliverable.uri === candidate.uri && deliverable.kind === candidate.kind) {
        // A REJECTED row re-delivered with the SAME uri is a re-submission of
        // the same object — it re-opens to pending instead of duplicating
        // (the caller flips the status). Identical pending rows stay deduped.
        if (deliverable.status === 'rejected') return deliverable;
        continue;
      }
      const oldPinids = new Set(
        (deliverable.uri ?? '').match(/[0-9a-f]{64}i0/gi)?.map((token) => token.toLowerCase()) ?? [],
      );
      if (candidatePinids.size > 0 && [...candidatePinids].some((pinid) => oldPinids.has(pinid))) {
        return deliverable;
      }
    }
    // Fallback: same kind, no shared pinid — a correction that rewrites the
    // deliverable's uri (e.g. a link that changed host) supersedes the newest
    // same-kind row by the same author.
    if (candidate.kind !== 'text') {
      return candidatesByAuthor.find(
        (deliverable) => deliverable.kind === candidate.kind && deliverable.uri !== candidate.uri,
      );
    }
    return undefined;
  };

  /**
   * GT-04 (task #56): post the status-parser explanation INTO the group as a
   * host notice (never protocol input — hasGroupTaskNotice exempts it from
   * re-parsing, and the notice's own tag citations are backtick-wrapped).
   * Posted as the chair and reply-chained to the offending message so the
   * chair's next turn reads the correction in context. Failures only log —
   * a notice must never block message processing.
   */
  const postStatusDirectiveNote = async (
    task: GroupTask,
    chairMember: GroupTaskMember | undefined,
    message: GroupTaskDaemonMessage,
    verdict: StatusDirectiveVerdict,
    appliedTag: 'executing' | 'review' | null,
    parseStatus: string,
  ): Promise<void> => {
    if (!chairMember?.metabotId) return;
    // Single-commander: the parse verdict is an environment FACT for the
    // chair (the host never posts the correction as the chair). The chair
    // re-issues the directive itself if the state move was really intended.
    try {
      const liveStatus = deps.getGroupTaskStore().getTaskById(task.id)?.status ?? task.status;
      const parts: string[] = [];
      if (appliedTag) parts.push(`applied [STATUS:${appliedTag.toUpperCase()}]`);
      const rejectedList = verdict.rejected.map((verdictTag) => `-> ${verdictTag.toUpperCase()}`).join(', ');
      if (rejectedList) parts.push(`rejected as illegal from ${parseStatus}: ${rejectedList}`);
      deps.getGroupTaskStore().recordHostNote({
        taskId: task.id,
        kind: 'parse',
        target: 'status directive',
        dedupeKey: `parse_status:${task.id}:${message.id}`,
        body:
          `A [STATUS:*] directive in message #${message.id} was parsed with outcome: ${parts.join('; ')}. ` +
          `Current task status: ${liveStatus}. Legal next moves from it: ` +
          `${(CHAIR_STATUS_MOVES[liveStatus] ?? []).map((tag) => tag.toUpperCase()).join(', ') || '(none)'}. ` +
          'If a rejected move was genuinely intended, re-issue it from the correct current status.',
      });
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: status-parser note record failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Task #63: post the descriptive-citation corrective note as the chair.
   * Rate-limited to one per task per DESCRIPTIVE_NOTE_RATE_LIMIT_MS so a chatty
   * chair quoting protocol in prose cannot spam the group.
   */
  const DESCRIPTIVE_NOTE_RATE_LIMIT_MS = 10 * 60_000;
  const postDescriptiveStatusNote = async (
    task: GroupTask,
    chairMember: GroupTaskMember | undefined,
    message: GroupTaskDaemonMessage,
    verdict: StatusDirectiveVerdict,
    parseStatus: string,
  ): Promise<void> => {
    if (!chairMember?.metabotId) return;
    const sqlite = deps.getStore();
    const stampKey = `group_task_descriptive_note:${task.id}`;
    try {
      const lastMs = Number(sqlite.get<number>(stampKey) ?? 0) || 0;
      if (lastMs > 0 && now() - lastMs < DESCRIPTIVE_NOTE_RATE_LIMIT_MS) return;
      sqlite.set(stampKey, now());
    } catch {
      // kv unavailable — record unrate-limited rather than silently skip
    }
    // Single-commander: descriptive citations are an environment fact for the
    // chair, not a host correction posted in the group.
    try {
      const descriptiveList = verdict.descriptive
        .filter((tag) => (CHAIR_STATUS_MOVES[parseStatus] ?? []).includes(tag))
        .map((tag) => tag.toUpperCase())
        .join(', ');
      if (!descriptiveList) return;
      deps.getGroupTaskStore().recordHostNote({
        taskId: task.id,
        kind: 'parse',
        target: 'status citation',
        dedupeKey: `parse_descriptive:${task.id}:${message.id}`,
        body:
          `Message #${message.id} cites [STATUS:*] tag(s) ${descriptiveList} as prose (descriptive only, ` +
          `not applied; task stays ${parseStatus}). Nothing is required unless a real state move was intended.`,
      });
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: descriptive-status note record failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Protocol tags on EVERY ingested message (before/independent of reply gating):
   * - [DELIVERABLE]: record one pending deliverable row per valid tag
   *   candidate (deduped by msg_pin_id + uri + kind; corrections supersede in
   *   place) and compute host verification notes for the chair.
   * - [STATUS:EXECUTING|REVIEW]: honored only from the task chair bot, through
   *   GT-04 legality-aware adjudication (the first candidate legal from the
   *   live status wins; illegal candidates produce a transition audit row, an
   *   origin-session anomaly, and an in-group status-parser note — never a
   *   silent drop); a real transition fires emitTaskEvent, entering review
   *   triggers the owner report, re-entering executing clears it.
   * Returns the verification notes for this message (empty when none).
   */
  const processMessageTags = async (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<string[]> => {
    const store = deps.getGroupTaskStore();
    const content = message.content;
    let verificationNotes: string[] = [];

    // Host-authored notices ([GROUP_TASK_NOTICE:…]) are documentation for the
    // group, never protocol input: their bodies may legitimately cite tag
    // syntax (e.g. a dispatch-held notice explaining how to post
    // [CHECKPOINT_RESOLVED: …]) and must not be re-interpreted as that tag
    // when the notice round-trips through the daemon.
    if (hasGroupTaskNotice(content)) return verificationNotes;

    // Deliverable collection is worker-only: a chair message that merely quotes
    // an example (`metaapp://<pinId>`) or recap must never become a deliverable.
    const chairGlobalMetaId = (
      members.find((member) => member.role === 'chair')?.globalmetaid ?? ''
    ).trim();
    const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
    const isChairMessage = Boolean(
      chairGlobalMetaId && senderGlobalMetaId && senderGlobalMetaId === chairGlobalMetaId,
    );

    // Round-4 attribution: deliverables are only collected from messages whose
    // chain-signature GlobalMetaID is a task member. SUSPECT senders (neither
    // member nor owner) are marked on the row but never contribute deliverables.
    //
    // Speedup hardening: parsing runs on fence-stripped content — a
    // [DELIVERABLE] tag inside a fenced code block is a citation (docs,
    // examples), never a real delivery. Inline backticks survive: real
    // deliveries wrap URIs / local file paths in them.
    const parseContent = stripFencedCodeBlocks(content);
    if (message.senderSuspect) {
      // no deliverable collection for non-member speakers
    } else if (hasDeliverableTagLine(parseContent) && !isChairMessage) {
      // Round-4: per-candidate ingestion. Every [DELIVERABLE] tag occurrence
      // (its own line or inline) produces one candidate; valid candidates each
      // get their own row — a message with two tag lines records TWO rows.
      // Placeholder/truncated candidates are dropped individually so a junk
      // line can never hide a real URI on a sibling line.
      const msgPinId = message.pinId;
      const tagLines = deliverableTagLines(parseContent);
      const candidates = parseDeliverableLines(parseContent);
      // Index-aligned raw segment text per candidate (ledger fix: text
      // candidates may carry a local file path worth uploading on-chain).
      const candidateSegments = parseDeliverableSegments(parseContent);
      const recordedDeliverables: ParsedDeliverable[] = [];
      // Speedup R-03 fold accounting: when EVERY valid candidate of this
      // message folded into an earlier ledger row, the message must not wake
      // the chair for a fresh verdict (flag consumed in the responder gate).
      let foldedDuplicateCount = 0;
      let recordedNewCount = 0;
      const rejected = candidates.filter((candidate) => !candidate.valid);
      if (rejected.length > 0) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${rejected.length} [DELIVERABLE] candidate(s) rejected ` +
          `(${rejected.map((candidate) => candidate.note ?? 'invalid').join('; ')})`,
        );
      }
      const isCorrection = isCorrectionText(parseContent);
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        if (!candidate.valid) continue; // placeholder/truncated/example → never recorded
        if (!msgPinId) continue;
        // Round-4 correction-first aggregation: a later message declaring
        // 「更正/修正/以…为准」 for the same object (matched by a shared
        // 64-hex pinid token, same author) supersedes the earlier row in place
        // instead of recording a duplicate.
        if (isCorrection && candidate.uri) {
          const superseded = findSupersededDeliverable(task.id, message.senderGlobalMetaId, candidate);
          if (superseded) {
            store.updateDeliverableUri(superseded.id, candidate.uri, candidate.kind);
            // Ledger fix (#14→#16): a corrected object is a NEW version — a
            // previously rejected verdict no longer applies, re-open it.
            if (superseded.status === 'rejected') {
              store.updateDeliverableStatus(superseded.id, 'pending');
            }
            // P0-4: corrected deliverable is re-verified on the next monitor pass.
            store.updateDeliverableVerification(superseded.id, '{}');
            verificationNotes.push(
              copyCorrectionApplied(superseded.id, superseded.kind ?? 'text', candidate.uri),
            );
            if (deps.orchestrationBridge) {
              try {
                deps.orchestrationBridge.recordDeliverable({
                  groupTaskId: task.id,
                  deliverable: store.listDeliverables(task.id)
                    .find((deliverable) => deliverable.id === superseded.id)!,
                  verificationNotes,
                });
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: canonical correction projection failed: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            continue;
          }
        }
        // Speedup R-03: cross-message idempotency — the same author
        // re-delivering the SAME uri under a NEW message pin (EP28: the same
        // video delivered twice 3 minutes apart → two ledger rows + a
        // correction event) folds into the earliest non-rejected row: an
        // append-only duplicates[] annotation on the survivor, no new row,
        // and (when nothing else in the message is new) no chair wake.
        if (candidate.uri) {
          const prior = store.findDeliverableByAuthorAndUri(
            task.id,
            message.senderGlobalMetaId,
            candidate.uri,
          );
          if (prior) {
            appendDeliverableDuplicateNote(prior, msgPinId, candidate.uri);
            foldedDuplicateCount += 1;
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: duplicate [DELIVERABLE] ${candidate.uri.slice(0, 48)}… ` +
              `by the same author folded into ledger row #${prior.id} (no new record)`,
            );
            continue;
          }
          // Task #63: artifact-identity fold — a deliverable URI names ONE
          // on-chain product with ONE author (the publisher that first
          // recorded it). Another member tagging the same pinid (a promo
          // citing the finished MetaApp, copy referencing the package pin) is
          // a citation, never a second deliverable row with a second author.
          const priorByPinid = store.findDeliverableByPinid(task.id, extractPinidToken(candidate.uri));
          if (priorByPinid) {
            appendDeliverableDuplicateNote(priorByPinid, msgPinId, candidate.uri);
            foldedDuplicateCount += 1;
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: [DELIVERABLE] ${candidate.uri.slice(0, 48)}… cites ` +
              `ledger row #${priorByPinid.id}'s artifact (pinid already delivered) — folded, no new record`,
            );
            continue;
          }
        }
        const existing = store.findDeliverableByMsgPinAndUri(
          task.id,
          msgPinId,
          candidate.uri,
          candidate.kind,
        );
        if (existing) {
          recordedDeliverables.push(candidate);
          continue;
        }
        const deliverable = store.addDeliverable({
          taskId: task.id,
          msgPinId,
          authorGlobalmetaid: message.senderGlobalMetaId,
          kind: candidate.kind,
          uri: candidate.uri,
        });
        recordedDeliverables.push(candidate);
        recordedNewCount += 1;
        // Review fix (delivery-deadline hygiene): the deliverable ARRIVED —
        // retire this member's deadline watch immediately. Leaving the kv
        // armed after a late delivery is exactly what fed the reclaim ladder
        // a healthy, already-delivered worker.
        {
          const delivererMember = members.find(
            (candidateMember) =>
              (candidateMember.globalmetaid ?? '').trim().toLowerCase()
                === (message.senderGlobalMetaId ?? '').trim().toLowerCase(),
          );
          if (delivererMember?.metabotId != null) {
            deps.getStore().delete(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${delivererMember.metabotId}`);
            deps.getStore().delete(`${DELIVERY_REMINDED_PREFIX}${task.id}:${delivererMember.metabotId}`);
          }
        }
        // P0-4: persist multi-source on-chain verification for pinid deliverables.
        if (candidate.kind === 'metaapp' || candidate.kind === 'metafile' || candidate.kind === 'pinid') {
          const pinid = pinidFromDeliverable(candidate.uri);
          if (pinid) {
            try {
              const report = await verifyPinSources(pinid);
              store.updateDeliverableVerification(deliverable.id, JSON.stringify(report));
              // Issue #8: drive the ledger's on-chain confirmation state from
              // the multi-source verification result (orthogonal to owner
              // acceptance in `status`).
              store.updateDeliverableConfirmation(
                deliverable.id,
                report.verified ? 'confirmed' : 'unconfirmed',
              );
              // P3 (v1.1): a verified deliverable leaves 'pending' — the
              // ledger must not read "awaiting" once the pin is verifiably
              // on-chain. The owner's later verdict ('accepted'/'rejected')
              // is never overwritten (fresh rows are 'pending' here).
              if (report.verified && deliverable.status === 'pending') {
                store.updateDeliverableStatus(deliverable.id, 'delivered');
              }
              const lagging = report.sources.some((entry) => entry.outcome === 'not_found')
                && report.sources.some((entry) => entry.outcome === 'found');
              if (!report.verified) {
                verificationNotes.push(
                  lagging
                    ? copyPinidNotSynced(pinid.slice(0, 10))
                    : `⚠ Host verification: pinid ${pinid.slice(0, 10)}… not found on-chain`,
                );
              }
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} verification failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
        // Ledger fix (#14→#16): a text deliverable whose segment names a LOCAL
        // file is upgraded to on-chain evidence — the host uploads the file as
        // a metafile (paid by the author bot) and rewrites the row in place.
        // MetaWeb URI convention: a readable text document (Markdown / plain
        // text) is instead published as a simplenote note and recorded as
        // pin://<pinId> — metafile:// is reserved for binary payloads.
        // Upload failure degrades to the plain text record + a visible note;
        // it never drops the deliverable row.
        if (candidate.kind === 'text' && (deps.uploadDeliverableFile || deps.publishTextDeliverable)) {
          const segment = candidateSegments[candidateIndex] ?? '';
          const filePath = extractLocalFilePaths(segment)[0];
          // Only files that actually exist are upload candidates — a path
          // mentioned in prose must never trigger an on-chain upload.
          if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const authorBotId = members.find((member) =>
              Boolean(member.globalmetaid)
              && member.globalmetaid!.toLowerCase() === String(message.senderGlobalMetaId ?? '').toLowerCase(),
            )?.metabotId ?? null;
            try {
              const contentType = inferContentTypeFromFilePath(filePath);
              // MetaWeb URI convention: readable text documents publish as
              // simplenote notes (pin://); metafile:// is reserved for binary
              // payloads. A note publish yielding no pinId (oversized or
              // unreadable document) falls through to the metafile upload so
              // the file still becomes on-chain evidence.
              const preferTextNote = deps.publishTextDeliverable != null
                && isTextDocumentDeliverable(filePath, contentType);
              let notePinId = '';
              if (preferTextNote) {
                const published = await deps.publishTextDeliverable!({
                  metabotId: authorBotId ?? 0,
                  filePath,
                  contentType,
                });
                notePinId = typeof published?.pinId === 'string' ? published.pinId.trim() : '';
              }
              if (notePinId) {
                const uri = `pin://${notePinId}`;
                store.updateDeliverableUri(deliverable.id, uri, 'pinid');
                // Same on-chain confirmation semantics as a native pinid
                // deliverable.
                const report = await verifyPinSources(notePinId);
                store.updateDeliverableVerification(deliverable.id, JSON.stringify(report));
                store.updateDeliverableConfirmation(
                  deliverable.id,
                  report.verified ? 'confirmed' : 'unconfirmed',
                );
                verificationNotes.push(copyLocalDeliverableOnChain(uri));
              } else if (deps.uploadDeliverableFile) {
                const upload = await deps.uploadDeliverableFile({
                  metabotId: authorBotId ?? 0,
                  filePath,
                  contentType,
                });
                const pinId = typeof upload?.pinId === 'string' ? upload.pinId.trim() : '';
                if (pinId) {
                  const uri = buildMetafileUri(pinId, {
                    fileName: path.basename(filePath),
                    contentType,
                  });
                  // P2: same-bytes dedupe BEFORE the row is rewritten — an
                  // identical earlier deliverable (same sha256) absorbs this
                  // one; the duplicate row is deleted and never upgraded.
                  const uploadContentHash = typeof upload?.contentHash === 'string'
                    ? upload.contentHash.trim()
                    : '';
                  const dedupe: {
                    outcome: 'current-deleted' | 'other-deleted' | 'none';
                    survivorVerification?: string;
                  } = uploadContentHash
                    ? dedupeDeliverableByContentHash(task, deliverable, uploadContentHash)
                    : { outcome: 'none' };
                  if (dedupe.outcome === 'current-deleted') {
                    continue;
                  }
                  store.updateDeliverableUri(deliverable.id, uri, 'metafile', uploadContentHash || null);
                  // Reuse the pinid verification path so the upgraded row gets
                  // the same on-chain confirmation semantics as a native one.
                  // When this row absorbed a later duplicate, merge onto the
                  // annotation the dedupe just wrote (never clobber it).
                  const report = await verifyPinSources(pinId);
                  const mergedReport = dedupe.survivorVerification != null
                    ? { ...JSON.parse(dedupe.survivorVerification), ...report }
                    : report;
                  store.updateDeliverableVerification(deliverable.id, JSON.stringify(mergedReport));
                  store.updateDeliverableConfirmation(
                    deliverable.id,
                    report.verified ? 'confirmed' : 'unconfirmed',
                  );
                  verificationNotes.push(copyLocalDeliverableOnChain(uri));
                } else {
                  verificationNotes.push(copyLocalDeliverableNoPin(filePath));
                }
              } else if (preferTextNote) {
                verificationNotes.push(copyLocalDeliverableNoPin(filePath));
              }
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: local deliverable upload failed for ${filePath}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
              verificationNotes.push(copyLocalDeliverableUploadFailed(filePath));
            }
          }
        }
        if (deps.orchestrationBridge) {
          try {
            deps.orchestrationBridge.recordDeliverable({
              groupTaskId: task.id,
              deliverable,
              verificationNotes,
            });
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: canonical deliverable projection failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      // Speedup R-03: every valid candidate folded into an earlier ledger row
      // → flag the message so the responder gate skips the chair_deliverable
      // wake (a duplicate needs no fresh verdict).
      if (foldedDuplicateCount > 0 && recordedNewCount === 0) {
        deps.getStore().set(`${DELIVERABLE_FOLDED_PREFIX}${task.id}:${message.id}`, '1');
      }
      try {
        const notes = await verifyDeliverableCandidates(tagLines.join('\n'));
        if (notes.length > 0) {
          verificationNotes = [...verificationNotes, ...notes];
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable verification failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // P0-8: public integrity declarations (honest correction/report) are
    // recorded into the acceptance record. Dedupe by message pin.
    if (!message.senderSuspect && message.pinId && isIntegrityDeclaration(content)) {
      try {
        if (!store.hasIntegrityEventWithMsgPin(task.id, message.pinId)) {
          const isCorrection = isCorrectionText(content);
          store.addIntegrityEvent({
            taskId: task.id,
            msgPinId: message.pinId,
            authorGlobalmetaid: message.senderGlobalMetaId,
            eventType: isCorrection ? 'correction' : 'honest_report',
            detail: content.slice(0, 500),
          });
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: recorded integrity ${isCorrection ? 'correction' : 'report'} from ${message.senderName}`,
          );
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: integrity event record failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Improvement #4 (v1.3): chair plan-change disclosures
    // (`[PLAN_CHANGE: 原计划 → 受阻原因 → 改用方案]`) are first-hand resolution
    // facts. Record them (dedupe by message pin + line) so the review-entry
    // acceptance summary can disclose "why the artifact looks the way it does"
    // without the owner digging through the transcript. Chair-only, same trust
    // rule as STATUS tags; failures only log.
    {
      const planChairMember = members.find((member) => member.role === 'chair');
      const planChairGmid = (planChairMember?.globalmetaid ?? '').trim();
      const planSenderGmid = (message.senderGlobalMetaId ?? '').trim();
      if (planChairGmid && planSenderGmid === planChairGmid && !message.senderSuspect) {
        for (const line of extractPlanChangeLines(content)) {
          const capped = line.length > PLAN_CHANGE_LINE_MAX_RECORD_CHARS
            ? `${line.slice(0, PLAN_CHANGE_LINE_MAX_RECORD_CHARS).trimEnd()}…`
            : line;
          try {
            if (message.pinId && !store.hasPlanChange(task.id, message.pinId, capped)) {
              store.addPlanChange({
                taskId: task.id,
                msgPinId: message.pinId,
                authorGlobalmetaid: planSenderGmid,
                summary: capped,
              });
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: plan change recorded from ${message.senderName}`,
              );
            }
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: plan-change record failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    // GT-04 (task #56): legality-aware adjudication replaces the old
    // "last end-line tag wins, everything else ignored" rule. The verdict is
    // computed against the LIVE task status so a descriptive end-line tag can
    // no longer sink a legitimate standalone instruction line mid-message.
    const statusAtParse = deps.getGroupTaskStore().getTaskById(task.id)?.status ?? task.status;
    const statusVerdict = adjudicateStatusDirectives(content, statusAtParse);
    if (statusVerdict.tagCount > 0) {
      const chairMember = members.find((member) => member.role === 'chair');
      const chairGlobalMetaId = (chairMember?.globalmetaid ?? '').trim();
      const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
      const isChairSender = Boolean(
        chairGlobalMetaId && senderGlobalMetaId && senderGlobalMetaId === chairGlobalMetaId,
      );
      if (isChairSender && statusVerdict.instruction != null) {
        // G-03/GT-04: the instruction is the first candidate legal from the
        // live status (message-end field first, then standalone body lines).
        // Any remaining candidate is an illegal sibling the group must hear
        // about (below); pure prose citations stay descriptive text.
        const nextStatus = statusVerdict.instruction;
        if (statusVerdict.tagCount > 1) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: chair message carries ${statusVerdict.tagCount} [STATUS:*] tags — ` +
            `applying [STATUS:${nextStatus.toUpperCase()}] as the instruction` +
            `${statusVerdict.rejected.length > 0 ? `, rejected illegal sibling(s): ${statusVerdict.rejected.map((tag) => `[STATUS:${tag.toUpperCase()}]`).join(', ')}` : ''}` +
            `${statusVerdict.descriptive.length > 0 ? ', remaining tags treated as descriptive text' : ''}`,
          );
        }
        let appliedStatusDirective = false;
        try {
          const beforeStatus = store.getTaskById(task.id)?.status;
          // Improvement #2 (v1.3): review re-entry debounce — a [STATUS:REVIEW]
          // verdict landing within the window after a rework hatch is the
          // output of a chair turn that was ALREADY in flight when the rework
          // landed (task #24: "S4 核验通过" 3s after the boss's rework).
          // Applying it would flip the task straight back to review and expose
          // the driver race as two contradictory directives; skip the tag and
          // let the chair's next (post-rework) verdict enter review cleanly.
          if (
            nextStatus === 'review'
            && beforeStatus === 'executing'
            && freshReworkAgeMs(task.id) < REVIEW_REENTRY_DEBOUNCE_MS
          ) {
            throw new StaleReviewReentryError(
              `[STATUS:REVIEW] landed ${Math.round(freshReworkAgeMs(task.id) / 1000)}s after the rework hatch`,
            );
          }
          // P1-5: the on-chain status tag is a chair action — record the actor
          // on the transition event (who moved the task where and when).
          // P0-5: status tags also write the transition audit log (reason =
          // the STATUS tag) via addTaskTransition below.
          const chairName = (chairMember?.name ?? members.find((m) => m.role === 'chair')?.name ?? 'chair').trim();
          const updated = store.updateTaskStatus(task.id, nextStatus, {
            actor: {
              kind: 'chair',
              globalMetaId: senderGlobalMetaId,
              name: chairName || null,
            },
          });
          if (beforeStatus && updated.status !== beforeStatus) {
            try {
              // P0-5: transition audit log (actor = chair name, reason = the STATUS tag).
              store.addTaskTransition({
                taskId: task.id,
                fromStatus: beforeStatus,
                toStatus: updated.status,
                actor: chairName || `metabot:${chairMember?.metabotId ?? 'chair'}`,
                reason: `[STATUS:${nextStatus.toUpperCase()}] tag`,
              });
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: transition log write failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
            try {
              deps.orchestrationBridge?.syncStatus(task.id);
            } catch (error) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: canonical status projection failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
              );
            }
            deps.emitTaskEvent?.({
              type: 'groupTask:statusChanged',
              taskId: task.id,
              status: updated.status,
              at: now(),
            });
            if (updated.status === 'executing' && beforeStatus === 'planning') {
              // G-01: planning → executing means the chair's plan message (the
              // one carrying this trailing tag) is the first dispatch — report
              // its seat assignments to the origin session, once per round.
              notifySourceSessionMilestone(
                task,
                'dispatch',
                buildSourceSessionDispatchNotice({
                  title: task.title,
                  status: updated.status,
                  planText: message.content,
                }),
              );
            }
            if (updated.status === 'executing' && beforeStatus === 'review') {
              // Rework hatch: every review-delivery guard resets (shared with
              // the RPC/UI rework paths via clearGroupTaskReviewDeliveryGuards)
              // so the next review re-reports on all channels, and the
              // re-assert straggler guard resets so the fresh review entry can
              // re-assert cleanly.
              clearGroupTaskReviewDeliveryGuards(deps.getStore(), task.id);
              // Improvement #2 (v1.3): stamp the rework instant so a chair
              // [STATUS:REVIEW] verdict arriving within the debounce window is
              // recognized as a stale in-flight turn (task #24).
              deps.getStore().set(`${GROUP_TASK_REWORK_AT_KV_PREFIX}${task.id}`, now());
            }
            if (updated.status === 'review') {
              // Improvement #2 (v1.3): the rework stamp's job is done — this
              // review re-entry passed the debounce, so later review tags are
              // never compared against a stale stamp.
              deps.getStore().delete(`${GROUP_TASK_REWORK_AT_KV_PREFIX}${task.id}`);
              // Task #63: same for the debounced-pin markers — this entry is
              // the authoritative verdict, older swallowed pins are moot.
              deps.getStore().delete(`${GROUP_TASK_DEBOUNCED_REVIEW_PINS_KV_PREFIX}${task.id}`);
              // HITL: review entry is itself the final human gate — an open
              // checkpoint still pending at this point is superseded by it.
              try {
                const superseded = store.closeOpenCheckpoints(
                  task.id,
                  'resolved',
                  'superseded by review entry',
                );
                if (superseded > 0) {
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: ${superseded} open checkpoint(s) superseded by review entry`,
                  );
                }
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: failed to supersede open checkpoints: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
              }
              // P0-1: failed noise steps (mistaken mentions whose skill routing
              // failed) are auto-ignored on review entry so they never block the
              // owner's acceptance, and the acceptance UI sees them as ignored.
              try {
                const ignored = deps.orchestrationBridge?.ignoreFailedSteps(task.id) ?? 0;
                if (ignored > 0) {
                  emitLog(`[GroupTaskDaemon] Task ${task.id}: auto-ignored ${ignored} noise step(s) on review entry`);
                }
              } catch (error) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: failed to auto-ignore noise steps: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
                );
              }
              // Improvement #2 (v1.3): re-validate freshness before the
              // ceremony's visible emissions — a rework hatch (RPC/UI path,
              // which posts no group message) can land between the transition
              // above and this point; the ceremony must then not post a review
              // summary over the fresh rework directive (task #24).
              if (deps.getGroupTaskStore().getTaskById(task.id)?.status !== 'review') {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: review ceremony aborted — the task left review before the summary was posted`,
                );
              } else {
                // R1 closing ceremony: the group must never rest on a worker's
                // [WORKING] when it enters acceptance. Instead of the old fixed
                // string, the host now deterministically aggregates a structured
                // acceptance summary (goal/acceptance criteria/deliverable list/
                // verification/guidance) and posts it as the LAST group message —
                // "把菜端上桌". The same record is the single source of truth for
                // the owner private report (below) and the R2 source-session
                // notification. Publish failure only logs (the existing ceremony
                // contract): review never blocks on a chain write.
                try {
                  const deliverables = store.listDeliverables(task.id);
                  // Improvement #4 (v1.3): snapshot the chair's recorded
                  // [PLAN_CHANGE] resolutions into the summary so every
                  // owner-facing surface renders the same disclosure.
                  const planChanges = store
                    .listPlanChanges(task.id)
                    .map((change) => change.summary);
                  const summaryInput = buildAcceptanceSummary({ task, deliverables, members, planChanges });
                  const saved = store.saveAcceptanceSummary({
                    taskId: task.id,
                    goal: summaryInput.goal,
                    acceptanceCriteria: summaryInput.acceptanceCriteria,
                    deliverables: summaryInput.deliverables,
                    members: summaryInput.members,
                    guidance: summaryInput.guidance,
                    planChanges: summaryInput.planChanges,
                  });
                  // G-04: snapshot the supervision trail onto the same record
                  // so the review record carries every nudge/flag/pause/resume.
                  try {
                    store.updateAcceptanceSummarySupervisorSignals(
                      task.id,
                      store.listSupervisorSignalLines(task.id),
                    );
                  } catch (signalError) {
                    emitLog(
                      `[GroupTaskDaemon] Task ${task.id}: supervisor-signal snapshot record failed: ` +
                      `${signalError instanceof Error ? signalError.message : String(signalError)}`,
                    );
                  }
                  // Speedup R-06: attach the deterministic per-phase time
                  // breakdown to the same record — the closing message then
                  // carries the numbers and the chair never hand-reconstructs
                  // them. Computed only from host-owned rows; failure logs and
                  // never blocks the ceremony.
                  try {
                    const timeBreakdown = buildGroupTaskTimeBreakdown({
                      task,
                      statusEvents: store.listStatusEvents(task.id),
                      deliverables,
                      messages: task.groupId
                        ? store.listGroupChatMessages(task.groupId, { limit: 200 })
                        : [],
                      messageTotal: task.groupId
                        ? store.countGroupChatMessages(task.groupId)
                        : 0,
                      members,
                      nowMs: now(),
                    });
                    store.updateAcceptanceSummaryTimeBreakdown(task.id, timeBreakdown);
                  } catch (breakdownError) {
                    emitLog(
                      `[GroupTaskDaemon] Task ${task.id}: time-breakdown record failed: ` +
                      `${breakdownError instanceof Error ? breakdownError.message : String(breakdownError)}`,
                    );
                  }
                  // Improvement #1 (single-card acceptance): the owner report
                  // captures the chair's one-line 【结论】 verdict onto the
                  // just-saved record (version N), so the Tasks acceptance
                  // card and the origin-session notice render the SAME
                  // authoritative string. maybeSendOwnerReport contains its
                  // own failures; recording proceeds regardless (without a
                  // conclusion line when none was captured).
                  await maybeSendOwnerReport(task, members, botsById, promptMembers);
                  // Single-commander: the host no longer posts the acceptance
                  // summary or a closing line into the group — the chair's own
                  // [STATUS:REVIEW] message IS the group-facing wrap-up, and
                  // the recorded summary feeds the Tasks acceptance card. The
                  // published-pin stays null (no host group post exists).
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: acceptance summary v${saved.version} recorded on review entry ` +
                    `(${deliverables.length} deliverable(s)${(store.getLatestAcceptanceSummary(task.id) ?? saved).conclusion ? ', conclusion captured' : ''}; no host group post — chair's review message closes the thread)`,
                  );
                } catch (error) {
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: acceptance summary recording failed: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
            }
          }
          appliedStatusDirective = true;
        } catch (error) {
          if (error instanceof StaleReviewReentryError) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: ${error.message} — stale in-flight verdict ignored; task stays executing`,
            );
            // Task #63: mark the swallowed pin so the reconcile self-heal
            // (now re-armed on cursor advances) never resurrects a verdict
            // the debounce deliberately killed.
            if (message.pinId) {
              try {
                const key = `${GROUP_TASK_DEBOUNCED_REVIEW_PINS_KV_PREFIX}${task.id}`;
                const raw = deps.getStore().get<string>(key);
                let pins: string[] = [];
                try {
                  const parsed = JSON.parse(String(raw ?? '[]'));
                  if (Array.isArray(parsed)) pins = parsed.map((pin) => String(pin));
                } catch {
                  pins = [];
                }
                if (!pins.includes(message.pinId)) {
                  pins.push(message.pinId);
                  deps.getStore().set(key, JSON.stringify(pins.slice(-8)));
                }
              } catch {
                // best-effort marker — the freshness guard still bounds reconcile
              }
            }
          } else if (error instanceof Error && error.message.startsWith('Illegal group task status transition')) {
            // GT#47 R2: an illegal transition is a chair directive the host
            // REJECTED, not a protocol verdict to swallow whole. Task #47
            // showed what silence costs: zero transitions, zero status
            // events, zero logs — "stuck but everything looks fine". Leave a
            // durable audit row (reason marks it rejected, so the UI history
            // never reads as an applied move) and a log line. The message
            // itself was processed successfully, so the GT#26 bounded-retry /
            // tag-only reprocess paths do not apply here.
            const rejectedFrom = store.getTaskById(task.id)?.status ?? null;
            const chairActor = chairMember?.name?.trim() || `metabot:${chairMember?.metabotId ?? 'chair'}`;
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: [STATUS:${nextStatus.toUpperCase()}] directive rejected — illegal transition ${rejectedFrom ?? '?'} -> ${nextStatus}`,
            );
            try {
              store.addTaskTransition({
                taskId: task.id,
                fromStatus: rejectedFrom,
                toStatus: nextStatus,
                actor: chairActor,
                reason: `illegal_transition: [STATUS:${nextStatus.toUpperCase()}] rejected (${rejectedFrom ?? '?'} -> ${nextStatus} is not legal)`,
              });
            } catch (auditError) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: illegal-transition audit row write failed: ` +
                `${auditError instanceof Error ? auditError.message : String(auditError)}`,
              );
            }
            // G-01: an illegal transition is exactly the "state-machine
            // anomaly" the origin session must hear about — never silent.
            notifySourceSessionMilestone(
              task,
              'anomaly',
              buildSourceSessionAnomalyNotice({
                title: task.title,
                status: rejectedFrom ?? 'unknown',
                summary: `The chair's [STATUS:${nextStatus.toUpperCase()}] directive was rejected ` +
                  `(${rejectedFrom ?? '?'} -> ${nextStatus} is not a legal transition) and was NOT applied. ` +
                  'The task stays in its current state; check the task history for the rejected directive.',
              }),
              `illegal_transition:${nextStatus}`,
            );
          } else {
            // GT#26: not a protocol verdict — the durable write itself failed
            // (e.g. a busy DB during the DSH stall storm). Swallowing it here
            // used to mark the message processed and silently lose the chair's
            // status directive, pinning the task in 'planning' while workers
            // already executed. Propagate instead: the message rides the
            // bounded MSG_RETRY path, and the drop-time tag-only reprocess is
            // the final chance for the transition to land.
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: [STATUS:${nextStatus.toUpperCase()}] tag application failed — ` +
              `retrying: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        }
        // GT-04: when the applied instruction had illegal siblings, tell the
        // GROUP — the rejected part of the chair's intent must be visible
        // where the chair can read and correct it, not silently dropped
        // (task #56: the group watched a dispatch land while the end-line
        // REVIEW mention silently died). Gate on appliedStatusDirective: when
        // the StaleReviewReentry debounce skipped the verdict above, the note
        // would announce "Status update applied" for a transition that was
        // deliberately NOT applied.
        if (appliedStatusDirective && statusVerdict.rejected.length > 0) {
          await postStatusDirectiveNote(task, chairMember, message, statusVerdict, nextStatus, statusAtParse);
        }
      } else if (isChairSender && statusVerdict.rejected.length > 0) {
        // GT-04: EVERY candidate was illegal from the live status — the old
        // code swallowed this entirely (task #56 pinned in planning forever
        // with zero transitions, zero group feedback). Keep the GT#47 R2
        // audit row + origin-session anomaly, and add the missing piece: an
        // in-group explanation the chair (and every participant) can act on.
        const rejectedTag = statusVerdict.rejected[0];
        const rejectedFrom = store.getTaskById(task.id)?.status ?? null;
        const chairActor = chairMember?.name?.trim() || `metabot:${chairMember?.metabotId ?? 'chair'}`;
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: [STATUS:${rejectedTag.toUpperCase()}] directive rejected — illegal transition ${rejectedFrom ?? '?'} -> ${rejectedTag}`,
        );
        try {
          store.addTaskTransition({
            taskId: task.id,
            fromStatus: rejectedFrom,
            toStatus: rejectedTag,
            actor: chairActor,
            reason: `illegal_transition: [STATUS:${rejectedTag.toUpperCase()}] rejected (${rejectedFrom ?? '?'} -> ${rejectedTag} is not legal)`,
          });
        } catch (auditError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: illegal-transition audit row write failed: ` +
            `${auditError instanceof Error ? auditError.message : String(auditError)}`,
          );
        }
        // G-01: an illegal transition is exactly the "state-machine anomaly"
        // the origin session must hear about — never silent.
        notifySourceSessionMilestone(
          task,
          'anomaly',
          buildSourceSessionAnomalyNotice({
            title: task.title,
            status: rejectedFrom ?? 'unknown',
            summary: `The chair's [STATUS:${rejectedTag.toUpperCase()}] directive was rejected ` +
              `(${rejectedFrom ?? '?'} -> ${rejectedTag} is not a legal transition) and was NOT applied. ` +
              'The task stays in its current state; check the task history for the rejected directive.',
          }),
          `illegal_transition:${rejectedTag}`,
        );
        await postStatusDirectiveNote(task, chairMember, message, statusVerdict, null, statusAtParse);
      } else if (isChairSender && statusVerdict.descriptive.length > 0) {
        // G-03 observability: a chair message whose BODY cites [STATUS:*] tags
        // without an instruction tag must not transition silently — leave a
        // log line so a stuck task is always diagnosable (task #47's
        // "zero transitions, zero logs" failure mode).
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair message cites ${statusVerdict.descriptive.length} descriptive [STATUS:*] tag(s) ` +
          `(${statusVerdict.descriptive.map((tag) => tag.toUpperCase()).join(' -> ')}) with no instruction tag — ` +
          'descriptive tags ignored, no transition applied',
        );
        // Task #63: reaching here means NOTHING applied, yet the chair cited a
        // tag. When one of the cited tags is a legal move from the live status,
        // the task is parked on exactly this formatting miss — the chair's own
        // memory says the verdict was announced, so it will answer later
        // nudges with "false alarm" unless the miss is visible in the group.
        // Post the corrective note NOW (rate-limited) so the chair re-sends a
        // bare tag on its next turn instead of waiting out the 20-min cycle.
        const legalFromParse = CHAIR_STATUS_MOVES[statusAtParse] ?? [];
        if (statusVerdict.descriptive.some((tag) => legalFromParse.includes(tag))) {
          await postDescriptiveStatusNote(
            task,
            members.find((member) => member.role === 'chair'),
            message,
            statusVerdict,
            statusAtParse,
          );
        }
      } else if (isChairSender && statusVerdict.noOp.length > 0) {
        // A chair tag re-asserting the live status (e.g. a re-issued verdict
        // duplicating one already applied) is a benign no-op — the old
        // grouping filed it under `rejected`, minting an illegal-transition
        // audit row and an anomaly notice that goaded the chair into
        // "correcting" a state that was already correct. Log-only.
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair [STATUS:*] tag(s) re-assert the live status ` +
          `(${statusVerdict.noOp.map((tag) => tag.toUpperCase()).join(', ')}) — treated as a no-op`,
        );
      }
    }

    // HITL checkpoint tags — chair-only authority, same trust rule as STATUS
    // tags: tags from any other sender are ignored. Opening pauses the task
    // (responder gating treats it like the review phase), posts a pause line,
    // and notifies the owner privately; resolving resumes the work.
    const checkpointOpenMatch = CHECKPOINT_OPEN_TAG.exec(content);
    const checkpointResolvedMatch = CHECKPOINT_RESOLVED_TAG.exec(content);
    if (checkpointOpenMatch || checkpointResolvedMatch) {
      const chairMember = members.find((member) => member.role === 'chair');
      const chairGlobalMetaId = (chairMember?.globalmetaid ?? '').trim();
      const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
      if (!chairGlobalMetaId || !senderGlobalMetaId || senderGlobalMetaId !== chairGlobalMetaId) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: checkpoint tag from non-chair sender ` +
          `${message.senderName ?? 'unknown'} ignored`,
        );
      } else if (checkpointOpenMatch) {
        try {
          const freshTask = store.getTaskById(task.id);
          const openAlready = store.getOpenCheckpoint(task.id);
          const canOpen = Boolean(freshTask)
            && freshTask!.status !== 'review'
            && !store.isTerminalStatus(freshTask!.status)
            && !openAlready;
          if (!canOpen) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: checkpoint open tag ignored ` +
              `(status=${freshTask?.status ?? 'unknown'}, openCheckpoint=${openAlready?.id ?? 'none'})`,
            );
          } else {
            const checkpoint = store.openCheckpoint({
              taskId: task.id,
              topic: checkpointOpenMatch[1],
              msgPinId: message.pinId,
            });
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: HITL checkpoint #${checkpoint.id} opened ` +
              `(${checkpoint.topic ?? 'no topic'})`,
            );
            // Single-commander: no host pause line in the group — the chair's
            // own [CHECKPOINT:] message already carries the question/draft,
            // the owner is notified privately below, and the pause gate
            // itself is host-enforced environment state.
            deps.emitTaskEvent?.({
              type: 'groupTask:checkpointChanged',
              taskId: task.id,
              checkpointId: checkpoint.id,
              status: 'open',
              at: now(),
            });
            await maybeSendCheckpointReport(task, members, botsById, promptMembers, checkpoint);
          }
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: checkpoint open handling failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else if (checkpointResolvedMatch) {
        try {
          const open = store.getOpenCheckpoint(task.id);
          if (!open) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: checkpoint resolved tag ignored (no open checkpoint)`);
          } else {
            const resolved = store.resolveCheckpoint(open.id, {
              resolution: checkpointResolvedMatch[1] ?? null,
              msgPinId: message.pinId,
            });
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: HITL checkpoint #${resolved.id} resolved ` +
              `(${resolved.resolution ?? 'no summary'})`,
            );
            // Single-commander: no host resume line — the chair's own
            // [CHECKPOINT_RESOLVED:] message announces the continuation.
            deps.emitTaskEvent?.({
              type: 'groupTask:checkpointChanged',
              taskId: task.id,
              checkpointId: resolved.id,
              status: 'resolved',
              at: now(),
            });
          }
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: checkpoint resolve handling failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return verificationNotes;
  };

  /**
   * System-generated planning directive for the chair planning turn. The full
   * member roster (name, role, bio/role profile, goal) is embedded so the chair
   * LLM assigns work to the right specialist instead of guessing from an empty
   * group log (P1-5: the planning turn fired before any member message existed).
   */
  const buildPlanningDirective = (db: Database, task: GroupTask, promptMembers: DaemonPromptMember[]): string => {
    // P1-3: the chair's own manual `invite_remote` calls create pending invites
    // and/or unconfirmed remote placeholder members BEFORE the planning turn
    // fires. The plan must know: re-decomposing "search + invite a remote bot"
    // as a subtask would make the assigned worker re-invite someone who is
    // already being invited (server rejects duplicates) — useless work. The
    // directive states the pending invites and tells the chair to plan around
    // them (wait for the join, or continue with the current roster).
    const openTeamStatusBlock = buildOpenTeamPlanningStatusBlock(
      deps.getOpenTeamMembershipStore?.(),
      task,
      deps.getGroupTaskStore(),
    );
    const recent = queryRecentMessages(db, task.groupId!, contextMessageCount);
    const logLines = recent.map((row) => {
      const message = toDaemonMessage(row);
      return `${message.senderName}${message.senderSuspect ? ' [SUSPECT]' : ''}: ${truncateGroupLogLine(message.content ?? '')}`;
    });
    const rosterLines = promptMembers.map((member) => {
      const profile = [member.bio, member.roleProfile].filter(Boolean).join(' — ');
      const goal = member.goal?.trim() ? ` (goal: ${member.goal.trim()})` : '';
      const skillsHint = member.role === 'chair' ? ' (chair, do not assign work to the chair)' : '';
      const remoteHint = member.remote ? ' (remote teammate via OpenTeam — replies come from their own machine, may be delayed)' : '';
      return `- ${member.name} [${member.role}]${goal}${skillsHint}${remoteHint}${profile ? ` — ${profile}` : ''}`;
    });
    const workerCount = promptMembers.filter((member) => member.role === 'worker').length;
    const distributionRule = workerCount >= 2
      ? ' Assign each seated specialist their own coarse seat (content / design / engineering / promotion / domain). One bot per seat is enough — do not split a seat and do not invent extra work to occupy unused names.'
      : ' (single worker on the roster — assign that seat\'s work to that one member).';
    return [
      '[SYSTEM planning directive — generated by the host, not by a group participant]',
      'The group task has just been created. As the chair, post the task plan to the group NOW, in one message:',
      '(a) Decompose the goal into concrete subtasks that match the seats already hired. Research is a basic capability of every seat, not its own assignment.',
      `(b) Assign each subtask to the SINGLE most suitable member BY NAME based on the roster profiles (never assign the same work to everyone).${distributionRule}`,
      '(c) State the sequence/dependencies and @-mention ONLY the members who should act NOW (later steps get assigned when their inputs arrive, e.g. after a [DELIVERABLE]).',
      '(c2) For a DEPENDENT subtask, tag its assignment with `[DEPENDS_ON: <upstream pinid>]` (or describe the upstream requirement) and explicitly tell the member to wait for the upstream [DELIVERABLE] before starting.',
      '(d) End the message with [STATUS:EXECUTING].',
      '(e) The chair NEVER executes task work — no assembly, no publishing, no writing deliverables; assign execution subtasks to WORKERS and keep the chair to coordination, verification and reporting.',
      '(f) Match each subtask to capability: use the roster profiles (bio/role/goal). NEVER assign a step to a member whose profile obviously mismatches it (e.g. do not assign assembly or publishing to a designer-only profile). If no roster member fits a step, state the gap in the plan instead of misassigning it.',
      '(g) HUMAN CHECKPOINTS: if (and only if) the goal or acceptance criteria explicitly ask the owner to review/confirm an intermediate result (e.g. "show me the draft and wait for my OK"), plan that step as a checkpoint — when the draft is ready, post it with a `[CHECKPOINT: <topic>]` tag and wait for the owner. Do NOT invent checkpoints the owner did not ask for.',
      '',
      'Full member roster (assign only to these members, by exact name):',
      ...(rosterLines.length > 0 ? rosterLines : ['(no members yet besides the chair)']),
      ...(openTeamStatusBlock ? ['', openTeamStatusBlock] : []),
      '',
      `[Group Task "${task.title}" (#${task.id}) — recent group log (last ${contextMessageCount} messages)]`,
      ...(logLines.length > 0 ? logLines : ['(no messages yet)']),
    ].join('\n');
  };

  /**
   * Chair planning turn: exactly one per task, attempted while the task is in
   * 'planning'. The chair decomposes the goal into sequenced sub-assignments and
   * posts the plan (ending with [STATUS:EXECUTING], which the tag parser picks up
   * when the message round-trips through the listener). kv keys:
   * group_task_chair_planned:<taskId> = '1' once posted;
   * group_task_chair_plan_attempts:<taskId> = failure counter (gives up after 3).
   * Does NOT consume the chair's reply budget/cooldown.
   */
  const maybeRunChairPlanningTurn = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
    remoteStatusBlock: string,
  ): Promise<void> => {
    const sqlite = deps.getStore();
    const plannedKey = `${CHAIR_PLANNED_KV_PREFIX}${task.id}`;
    if (sqlite.get<string>(plannedKey) === '1') return;
    if (deps.disableChairPlanningTurn) {
      // Host opt-out (P1-5 r2): the Twin chair leads the kickoff itself, so
      // the daemon never runs the auto planning turn. Mark the task as
      // "planned" so the guard stays quiet on later ticks.
      sqlite.set(plannedKey, '1');
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: chair planning turn disabled (disableChairPlanningTurn); Twin leads the kickoff`,
      );
      return;
    }
    // F1 (GT#11): never plan against a roster that is still forming. The task
    // row + chair member are persisted first, then each worker joins with
    // network-bound calls — a 5s tick can otherwise fire the planning turn
    // MID-create and permanently misplan the task with a truncated roster
    // ("single worker" misjudgement, wrong role assignments, planned-key set
    // so the task never re-plans). Wait until the member roster is unchanged
    // for settleMs; an absolute cap from creation guarantees the task can
    // never sit in 'planning' behind the gate (e.g. a join that never lands).
    const settleMs = Math.max(0, Math.trunc(deps.chairPlanRosterSettleMs ?? DEFAULT_CHAIR_PLAN_ROSTER_SETTLE_MS));
    const capMs = Math.max(0, Math.trunc(deps.chairPlanRosterCapMs ?? DEFAULT_CHAIR_PLAN_ROSTER_CAP_MS));
    if (settleMs > 0 || capMs > 0) {
      const rosterKey = `${CHAIR_PLAN_ROSTER_KV_PREFIX}${task.id}`;
      const sig = buildRosterSignature(members);
      let entry: { sig: string; since: number } | null = null;
      try {
        const raw = sqlite.get<string>(rosterKey);
        if (raw) entry = JSON.parse(raw) as { sig: string; since: number };
      } catch {
        entry = null;
      }
      if (!entry || entry.sig !== sig) {
        sqlite.set(rosterKey, JSON.stringify({ sig, since: now() }));
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning deferred — roster still forming ` +
          `(${members.filter((member) => member.role === 'worker').length} worker(s) of ${members.length} member(s))`,
        );
        return;
      }
      const sinceMs = now() - entry.since;
      const createdMs = parseSqliteUtcMs(task.createdAt);
      const ageMs = createdMs != null ? now() - createdMs : Number.POSITIVE_INFINITY;
      if (sinceMs < settleMs && ageMs < capMs) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning deferred — waiting for the roster to settle ` +
          `(${Math.max(0, Math.ceil((settleMs - sinceMs) / 1000))}s left)`,
        );
        return;
      }
      sqlite.delete(rosterKey);
    }
    const attemptsKey = `${CHAIR_PLAN_ATTEMPTS_KV_PREFIX}${task.id}`;
    const attempts = Number(sqlite.get<number>(attemptsKey) ?? 0) || 0;
    if (attempts >= MAX_CHAIR_PLAN_ATTEMPTS) return;

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    if (!chairMember || !bot) {
      emitLog(`[GroupTaskDaemon] Task ${task.id}: planning turn skipped (no chair bot found)`);
      return;
    }

    try {
      const db = sqlite.getDatabase();
      const coworkStore = deps.getCoworkStore();
      const ownerGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const systemPrompt = systemPromptParts.systemPrompt;
      // Volatile context (time + experience/cognition + remote-teammate facts)
      // rides the user turn.
      const directive = [systemPromptParts.volatileContext, remoteStatusBlock, buildPlanningDirective(db, task, promptMembers)]
        .filter(Boolean)
        .join('\n\n');
      const brain = metabotBrainOptions(bot);
      const llmId = brain.llmId ?? undefined;
      const fallbackLlmId = brain.fallbackLlmId;
      // Plain LLM path: the chair is planning here, not executing skills.
      const reply = (await performChatWithTimeout(systemPrompt, directive, llmId, {
        llmProvider: brain.llmProvider,
        fallbackLlmId,
        fallbackLlmProvider: brain.fallbackLlmProvider,
        effort: brain.effort,
        fallbackEffort: brain.fallbackEffort,
        thinking: 'enabled',
      })).trim();
      if (!reply || NO_REPLY_PATTERN.test(reply)) {
        // Task #66 (fix A): the chair may have already dispatched in its own
        // voice (mid-turn group_chat sends / posted dispatches) — the
        // bootstrap planning turn is then redundant, not failed.
        if (chairAlreadyDispatched(sqlite.getDatabase(), task, members, botsById)) {
          sqlite.set(plannedKey, '1');
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: planning turn — the chair already dispatched in its own voice; ` +
            'bootstrap marked complete (no attempt burned)',
          );
          return;
        }
        throw new Error('planning turn produced no usable plan');
      }
      // G-03 hardening: the planning dispatch is a HOST-owned protocol message
      // (the directive requires ending it with [STATUS:EXECUTING]) and the
      // state machine parses instruction tags ONLY at the message end. If
      // the LLM omitted the trailing tag — or buried it mid-body where the
      // parser deliberately ignores it — append the deterministic protocol
      // footer so a posted plan can never leave the task pinned in planning
      // (task #47's failure mode, now impossible from this path).
      // GT-04: judge via adjudication — a standalone mid-body EXECUTING line
      // is a legal instruction too and must not earn a redundant footer.
      let postedReply = reply;
      if (adjudicateStatusDirectives(reply, 'planning').instruction == null) {
        const bodyTags = [...reply.matchAll(STATUS_TAG_ALL)].length;
        postedReply = `${reply.replace(/[ \t]+$/, '')}\n[STATUS:EXECUTING]`;
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: planning reply carried no legal [STATUS:*] instruction` +
          `${bodyTags > 0 ? ` (${bodyTags} descriptive tag(s) ignored by the parser)` : ''} — ` +
          'appended the deterministic [STATUS:EXECUTING] footer',
        );
      }
      const workerNames = promptMembers
        .filter((member) => member.role === 'worker')
        .map((member) => member.name);
      // Coverage is computed unconditionally: mentionedWorkers also drives the
      // mention array on the outgoing dispatch so assigned workers are woken
      // even when the plan text uses bare names instead of `@Name` tokens.
      const coverage = checkPlanningCoverage(postedReply, workerNames);
      if (workerNames.length > 1 && coverage.unmentionedWorkers.length > 0) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: planning mentions ` +
          `${coverage.mentionedWorkers.join(', ') || 'nobody'}; ` +
          `unmentioned seats stay idle on purpose: ${coverage.unmentionedWorkers.join(', ')}`,
        );
      }

      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      coworkStore.addMessage(session.id, { type: 'user', content: directive });
      coworkStore.addMessage(session.id, { type: 'assistant', content: postedReply });
      const dispatchMention = resolveMentionIdsForWorkers(members, coverage.mentionedWorkers);
      const posted = await postGroupMessage(
        task.id,
        bot.id,
        postedReply,
        dispatchMention.length > 0 ? { mention: dispatchMention } : undefined,
      );
      if (dispatchMention.length > 0) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: planning dispatch carries mention array for ` +
          `${coverage.mentionedWorkers.join(', ')}`,
        );
      }
      // P2-7 r2: the daemon's own kickoff must not count as "Twin activity".
      rememberDaemonChairPin(task.id, posted.pinId);
      sqlite.set(plannedKey, '1');
      emitLog(`[GroupTaskDaemon] Task ${task.id}: chair planning turn posted`);
    } catch (error) {
      const nextAttempts = attempts + 1;
      sqlite.set(attemptsKey, nextAttempts);
      if (nextAttempts >= MAX_CHAIR_PLAN_ATTEMPTS) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning turn failed ${nextAttempts} time(s), giving up: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: chair planning turn failed (attempt ${nextAttempts}/${MAX_CHAIR_PLAN_ATTEMPTS}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * G-04: drive the chair's response to pending supervisor signals (nudge /
   * flag). One chair turn per pending batch: the directive restates every
   * unprocessed signal, the chair answers in the group (its judgment stays
   * authoritative — supervision inputs, not overrides), and the rows are
   * stamped with the response pin. Pause/resume rows arrive already processed
   * (host-applied gates). While a human gate is active (review / open
   * checkpoint) the turn is deferred; terminal tasks just close the rows.
   * Signals the chair can never answer (no local chair bot, or 3 failed
   * attempts) are closed with a null pin + one anomaly milestone instead of
   * retrying forever.
   */
  const processSupervisorSignals = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<void> => {
    const store = deps.getGroupTaskStore();
    const sqlite = deps.getStore();
    const pending = store.listPendingSupervisorSignals(task.id)
      .filter((signal) => signal.kind === 'nudge' || signal.kind === 'flag');
    if (pending.length === 0) return;
    const pendingIds = pending.map((signal) => signal.id);
    if (task.status === 'done' || task.status === 'cancelled') {
      store.markSupervisorSignalsProcessed(pendingIds, null);
      return;
    }
    if (task.status === 'review' || store.getOpenCheckpoint(task.id) != null) {
      return; // human gate active — defer the chair turn until it clears
    }

    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    if (!chairMember || !bot) {
      // No local chair can ever answer — close the rows (null pin = no chair
      // receipt, same convention as the done/cancelled close-out above)
      // instead of skipping them every tick, and alert the origin session once.
      store.markSupervisorSignalsProcessed(pendingIds, null);
      emitLog(`[GroupTaskDaemon] Task ${task.id}: supervisor signal turn skipped (no chair bot found)`);
      notifySourceSessionMilestone(
        task,
        'anomaly',
        buildSourceSessionAnomalyNotice({
          title: task.title,
          status: task.status,
          summary:
            `Supervisor signal(s) #${pendingIds.join(', #')} were closed WITHOUT a chair answer: ` +
            'this task has no local chair bot to respond. Review the signals in the task detail ' +
            'and apply the supervision manually.',
        }),
        `supervisor_signals_no_chair:${pendingIds.join('-')}`,
      );
      return;
    }

    const signalLines = pending.map((signal) => {
      const target = signal.target?.trim();
      return `- [${signal.kind.toUpperCase()}${target ? ` → ${target}` : ''}] ${signal.note}`;
    });
    const directive = [
      '[SYSTEM supervisor directive — generated by the host, not by a group participant]',
      'The owner\'s supervisor channel (the Twin acting as the owner\'s representative) recorded the following signal(s) for this task:',
      ...signalLines,
      '',
      'Reply ONCE in the group addressing every signal above:',
      '- For each NUDGE: state what you checked and what you found (facts first).',
      '- For each FLAG: state your judgment — agree or disagree, with the reason.',
      'These are supervision inputs, NOT orders that override your chair authority: your coordination and verdicts remain the authoritative ones.',
      'Do NOT emit any [STATUS:*] tag in this reply — this is a supervision answer, not a lifecycle move.',
    ].join('\n');

    try {
      const coworkStore = deps.getCoworkStore();
      const ownerGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const brain = metabotBrainOptions(bot);
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      const userTurn = [systemPromptParts.volatileContext, directive].filter(Boolean).join('\n\n');
      // GT-06 (task #56): the supervisor-signal answer used to be a TOOL-LESS
      // plain completion. During the outage that plain path kept "working"
      // (it has its own LLM fallback) while every tool-driven turn stalled —
      // so the chair answered nudges without any ability to actually CHECK
      // the group, the ledger, or the chain. Route this turn like a
      // message-driven one: a routing hit runs ONE skill turn in the chair's
      // task session (tools available); a miss keeps the plain path below.
      // The supervisor acts on the owner's behalf — widened routing, same as
      // an owner message.
      let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
      if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn) {
        try {
          routing = await deps.getChatSkillsRoutingPrompt({ metabotId: bot.id, widened: true });
        } catch (routingError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: skill routing failed for supervisor turn (bot ${bot.id}): ` +
            `${routingError instanceof Error ? routingError.message : String(routingError)}`,
          );
        }
      }
      const canRunSkillTurn = Boolean(
        routing.prompt && routing.activeSkillIds.length > 0 && deps.runSkillTurn,
      );
      coworkStore.addMessage(session.id, { type: 'user', content: userTurn });
      let reply = '';
      if (canRunSkillTurn) {
        const skillSystemPrompt = [
          systemPromptParts.systemPrompt,
          '',
          routing.prompt!,
          '',
          'After using Read/Bash to run a skill, reply concisely in the group. Do not paste full skill logs.',
        ].join('\n');
        const skillTurnResult = await deps.runSkillTurn!({
          sessionId: session.id,
          systemPrompt: skillSystemPrompt,
          userMessage: userTurn,
          activeSkillIds: routing.activeSkillIds,
        });
        reply = (skillTurnResult.replyText ?? '').trim();
        // The runner appends the assistant message to the session itself.
      } else {
        reply = (await performChatWithTimeout(
          systemPromptParts.systemPrompt,
          userTurn,
          brain.llmId ?? undefined,
          {
            llmProvider: brain.llmProvider,
            fallbackLlmId: brain.fallbackLlmId,
            fallbackLlmProvider: brain.fallbackLlmProvider,
            effort: brain.effort,
            fallbackEffort: brain.fallbackEffort,
            thinking: 'enabled',
          },
        )).trim();
        if (reply) {
          coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
        }
      }
      if (!reply || NO_REPLY_PATTERN.test(reply)) {
        throw new Error('supervisor signal turn produced no usable reply');
      }
      const posted = await postGroupMessage(task.id, bot.id, reply);
      // P2-7 r2: the daemon's own reply must not count as "Twin activity".
      rememberDaemonChairPin(task.id, posted.pinId);
      // An empty pinId means the answer is queued behind sponsor broadcast
      // reconciliation, not on-chain yet — record it with a null pin (the same
      // shape as a host-applied answer) instead of a fake empty pin.
      store.markSupervisorSignalsProcessed(pendingIds, posted.pinId || null);
      // Answered — the per-signal failed-attempt counters are obsolete.
      for (const id of pendingIds) {
        sqlite.delete(`${GROUP_TASK_SUP_SIG_ATTEMPTS_PREFIX}${id}`);
      }
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: chair answered ${pending.length} supervisor signal(s) ` +
        `(pin ${posted.pinId || 'queued'})`,
      );
    } catch (error) {
      // fix/group-task-duration (task #57): a corrupt chair session log fails
      // every supervisor-signal answer forever — the recovery channel itself
      // dies. Rebuild the chair's task session from the host ledger and leave
      // the signals pending; the next tick answers them on the fresh session.
      {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isCorruptSessionLogError(error)) {
          const rebuildKey = `${CORRUPT_SESSION_REBUILD_PREFIX}${task.id}:${bot.id}`;
          const lastRebuildAt = Number(deps.getStore().get<number>(rebuildKey) ?? 0) || 0;
          if (now() - lastRebuildAt > CORRUPT_SESSION_REBUILD_MIN_INTERVAL_MS) {
            try {
              deps.getStore().set(rebuildKey, now());
              const rebuilt = rebuildGroupTaskSession({
                coworkStore: deps.getCoworkStore(),
                groupTaskStore: deps.getGroupTaskStore(),
                task,
                botId: bot.id,
                botName: bot.name,
              });
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: corrupt chair session log — session rebuilt from the ` +
                `host ledger (${rebuilt.sessionId.slice(0, 8)}…); supervisor signals stay pending for the next tick. ` +
                `Log signature: ${corruptSessionLogSignature(error)}`,
              );
              // fix-v2 P1-5: parity with the member-turn path — the origin
              // session hears about the rebuild immediately, not via a later
              // stall signal.
              notifySourceSessionMilestone(
                task,
                'anomaly',
                buildSourceSessionAnomalyNotice({
                  title: task.title,
                  status: task.status,
                  summary:
                    'The chair hit a corrupt session log while answering supervisor signals — every turn on ' +
                    `it would fail forever. Log signature: ${corruptSessionLogSignature(error)}. The host rebuilt ` +
                    'the chair\'s task session from the task ledger (goal, status trail, deliverables, recent ' +
                    'transcript); the pending supervisor signals will be answered on the fresh session next tick.',
                }),
                `corrupt_session_rebuild:${task.id}:${bot.id}`,
              );
              return;
            } catch (rebuildError) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: corrupt-session rebuild failed for the chair: ` +
                `${rebuildError instanceof Error ? rebuildError.message : String(rebuildError)}`,
              );
            }
          } else {
            // fix-v2 P1-5: recurrence within the rebuild cooldown = the
            // dual-writer race is likely still live — escalate immediately
            // with self-heal guidance instead of silently burning attempts.
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: corrupt chair session log recurred within the rebuild ` +
              'cooldown — escalating immediately instead of only counting attempts. ' +
              `Log signature: ${corruptSessionLogSignature(error)}`,
            );
            notifySourceSessionMilestone(
              task,
              'anomaly',
              buildSourceSessionAnomalyNotice({
                title: task.title,
                status: task.status,
                summary:
                  'The chair hit a corrupt session log AGAIN within an hour of the automatic rebuild — the ' +
                  'driver-handoff race that corrupts the log is likely still live (two runtime processes ' +
                  'writing one session log). ' +
                  `Log signature: ${corruptSessionLogSignature(error)}. ` +
                  'Self-heal guidance: restart the app so every runtime subprocess ' +
                  'is reaped and the session resumes under a single writer; if it still recurs, investigate ' +
                  'the provider re-pin / config-change handoff for the chair bot.',
              }),
              `corrupt_session_rebuild_capped:${task.id}:${bot.id}`,
            );
          }
        }
      }
      // Retry budget: a failed turn leaves the rows pending for the next tick,
      // but a signal the chair fails to answer 3 times is closed out (null
      // pin) with one anomaly milestone — a broken chair LLM must not wedge
      // the supervisor channel open forever.
      const exhaustedIds: number[] = [];
      for (const id of pendingIds) {
        const attemptsKey = `${GROUP_TASK_SUP_SIG_ATTEMPTS_PREFIX}${id}`;
        const prev = Number(sqlite.get<string>(attemptsKey));
        const attempts = (Number.isFinite(prev) ? prev : 0) + 1;
        if (attempts >= 3) {
          exhaustedIds.push(id);
          sqlite.delete(attemptsKey);
        } else {
          sqlite.set(attemptsKey, String(attempts));
        }
      }
      if (exhaustedIds.length > 0) {
        store.markSupervisorSignalsProcessed(exhaustedIds, null);
        notifySourceSessionMilestone(
          task,
          'anomaly',
          buildSourceSessionAnomalyNotice({
            title: task.title,
            status: task.status,
            summary:
              `The chair did not answer supervisor signal(s) #${exhaustedIds.join(', #')} after 3 attempts; ` +
              'the signals were closed without a chair response. Check the chair bot and its LLM configuration.',
          }),
          `supervisor_signals_unanswered:${exhaustedIds.join('-')}`,
        );
      }
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: supervisor signal turn failed (` +
        (exhaustedIds.length > 0
          ? `signals #${exhaustedIds.join(', #')} closed after 3 failed attempts; the rest stay pending`
          : 'signals stay pending') +
        `): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  /**
   * Single-commander architecture (task #64 follow-up): deliver pending
   * HOST ENVIRONMENT NOTES to the chair as ONE local system-context turn.
   * The host is the meeting room, never a speaker — no-ACK watches, deadline
   * bells, long-turn facts, joins and parser verdicts land here instead of
   * being posted into the group under some bot's identity. The chair reads
   * the facts and speaks for itself (or stays silent — [NO_REPLY] consumes
   * the notes too: seeing the clock and deciding "no action" is a decision).
   */
  const processHostNotes = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
  ): Promise<void> => {
    const store = deps.getGroupTaskStore();
    const sqlite = deps.getStore();
    const pending = store.listPendingHostNotes(task.id);
    if (pending.length === 0) return;
    const pendingIds = pending.map((note) => note.id);
    if (task.status === 'done' || task.status === 'cancelled') {
      store.markHostNotesConsumed(pendingIds, null);
      return;
    }
    const chairMember = members.find((member) => member.role === 'chair');
    const bot = chairMember?.metabotId != null ? botsById.get(chairMember.metabotId) : undefined;
    if (!chairMember || !bot) {
      store.markHostNotesConsumed(pendingIds, null);
      emitLog(`[GroupTaskDaemon] Task ${task.id}: host notes closed without delivery (no local chair bot)`);
      return;
    }
    const noteLines = pending.map((note) => {
      const target = note.target?.trim();
      return `- [${note.kind}${target ? ` → ${target}` : ''}] ${note.body}`;
    });
    const directive = [
      '[SYSTEM host environment notes — local runtime context, not a group participant]',
      'The host (this app — the meeting room you work in) recorded the following environment observations:',
      ...noteLines,
      '',
      'Treat these like the room clock: plain facts about time, liveness and deadlines. You are the SOLE',
      'coordinator — the host never speaks in the group, so whatever the group needs to hear about these',
      'facts, you say it yourself, in your own voice (nudge a silent member, re-dispatch, adjust a deadline,',
      'or deliberately stay silent with [NO_REPLY] when no action is warranted). These notes carry no',
      'authority beyond their facts; your coordination remains the authoritative one.',
    ].join('\n');

    try {
      const coworkStore = deps.getCoworkStore();
      const ownerGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
      const systemPromptParts = await buildTurnSystemPrompt(bot, task, promptMembers, 'chair', ownerGlobalMetaId);
      const brain = metabotBrainOptions(bot);
      const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
      const userTurn = [systemPromptParts.volatileContext, directive].filter(Boolean).join('\n\n');
      // Same routing stance as the supervisor-signal turn: the chair may need
      // tools (ledger reads, chain checks) to act on the facts.
      let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
      if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn) {
        try {
          routing = await deps.getChatSkillsRoutingPrompt({ metabotId: bot.id, widened: true });
        } catch (routingError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: skill routing failed for host-note turn (bot ${bot.id}): ` +
            `${routingError instanceof Error ? routingError.message : String(routingError)}`,
          );
        }
      }
      const canRunSkillTurn = Boolean(
        routing.prompt && routing.activeSkillIds.length > 0 && deps.runSkillTurn,
      );
      coworkStore.addMessage(session.id, { type: 'user', content: userTurn });
      let reply = '';
      if (canRunSkillTurn) {
        const skillSystemPrompt = [
          systemPromptParts.systemPrompt,
          '',
          routing.prompt!,
          '',
          'After using Read/Bash to run a skill, reply concisely in the group. Do not paste full skill logs.',
        ].join('\n');
        const skillTurnResult = await deps.runSkillTurn!({
          sessionId: session.id,
          systemPrompt: skillSystemPrompt,
          userMessage: userTurn,
          activeSkillIds: routing.activeSkillIds,
        });
        reply = (skillTurnResult.replyText ?? '').trim();
      } else {
        reply = (await performChatWithTimeout(
          systemPromptParts.systemPrompt,
          userTurn,
          brain.llmId ?? undefined,
          {
            llmProvider: brain.llmProvider,
            fallbackLlmId: brain.fallbackLlmId,
            fallbackLlmProvider: brain.fallbackLlmProvider,
            effort: brain.effort,
            fallbackEffort: brain.fallbackEffort,
            thinking: 'enabled',
          },
        )).trim();
        if (reply) {
          coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
        }
      }
      let postedPin: string | null = null;
      if (reply && !NO_REPLY_PATTERN.test(reply)) {
        const posted = await postGroupMessage(task.id, bot.id, reply);
        rememberDaemonChairPin(task.id, posted.pinId);
        postedPin = posted.pinId || null;
      }
      store.markHostNotesConsumed(pendingIds, postedPin);
      for (const id of pendingIds) {
        sqlite.delete(`${GROUP_TASK_HOST_NOTE_ATTEMPTS_PREFIX}${id}`);
      }
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: chair handled ${pending.length} host environment note(s) ` +
        `(${postedPin ? `replied, pin ${postedPin}` : 'stayed silent by choice'})`,
      );
    } catch (error) {
      // Retry budget, supervisor-signal style: 3 failed deliveries close the
      // notes with an origin-session anomaly instead of wedging the channel.
      const exhaustedIds: number[] = [];
      for (const id of pendingIds) {
        const attemptsKey = `${GROUP_TASK_HOST_NOTE_ATTEMPTS_PREFIX}${id}`;
        const prev = Number(sqlite.get<string>(attemptsKey));
        const attempts = (Number.isFinite(prev) ? prev : 0) + 1;
        if (attempts >= 3) {
          exhaustedIds.push(id);
          sqlite.delete(attemptsKey);
        } else {
          sqlite.set(attemptsKey, String(attempts));
        }
      }
      if (exhaustedIds.length > 0) {
        store.markHostNotesConsumed(exhaustedIds, null);
        notifySourceSessionMilestone(
          task,
          'anomaly',
          buildSourceSessionAnomalyNotice({
            title: task.title,
            status: task.status,
            summary:
              `The chair could not be delivered host environment note(s) #${exhaustedIds.join(', #')} ` +
              'after 3 attempts; they were closed undelivered. Check the chair bot and its LLM configuration.',
          }),
          `host_notes_undelivered:${exhaustedIds.join('-')}`,
        );
      }
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: host note turn failed (` +
        (exhaustedIds.length > 0
          ? `notes #${exhaustedIds.join(', #')} closed after 3 failed attempts; the rest stay pending`
          : 'notes stay pending') +
        `): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const generateAndSendReply = async (
    task: GroupTask,
    member: GroupTaskMember,
    bot: GroupTaskDaemonBotFull,
    message: GroupTaskDaemonMessage,
    promptMembers: DaemonPromptMember[],
    chairGlobalMetaId: string,
    ownerGlobalMetaId: string,
    verificationNotes: string[],
    remoteStatusBlock: string,
  ): Promise<void> => {
    const db = deps.getStore().getDatabase();
    const coworkStore = deps.getCoworkStore();

    const { systemPrompt: baseSystemPrompt, volatileContext } = await buildTurnSystemPrompt(bot, task, promptMembers, member.role, ownerGlobalMetaId);
    // Volatile context (time + experience/cognition) rides the user turn so
    // the system prompt stays byte-stable across group turns.
    let userMessage = [volatileContext, buildGroupLogUserMessage(db, task, message)]
      .filter(Boolean)
      .join('\n\n');
    if (verificationNotes.length > 0) {
      // Host deliverable-verification facts accompany the chair's context.
      userMessage = `${userMessage}\n${verificationNotes.join('\n')}`;
    }
    if (member.role === 'chair' && remoteStatusBlock) {
      // OpenTeam M2: host-observed unreachable facts accompany the chair only.
      userMessage = `${userMessage}\n\n${remoteStatusBlock}`;
    }

    // Skill routing (mirrors privateChatDaemon): when the bot has chat skills enabled
    // and routing hits, run one skill turn in the existing metaweb_group_task session;
    // otherwise fall back to the plain completion path.
    let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
    if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn) {
      try {
        const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
        const bossGlobalMetaId = (bot.boss_global_metaid ?? '').trim();
        // Trust the owner AND the chair: the twin chairs on the owner's behalf.
        // Baseline (any sender): bundled + the worker's assigned skills;
        // widened (boss/chair) additionally unlocks global external skills.
        // Routing still decides WHICH skills; no routing hit -> plain path
        // remains.
        const senderIsBoss = Boolean(
          senderGlobalMetaId && bossGlobalMetaId && senderGlobalMetaId === bossGlobalMetaId,
        );
        const senderIsChair = Boolean(
          senderGlobalMetaId && chairGlobalMetaId && senderGlobalMetaId === chairGlobalMetaId,
        );
        routing = await deps.getChatSkillsRoutingPrompt({
          metabotId: bot.id,
          widened: senderIsBoss || senderIsChair,
        });
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: skill routing failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Task #64: presence confirmations (legacy host welcome notices and the
    // chair's roll-call greetings) ask the bot for one fast LLM line, not tool
    // work. Routing them into a skill turn let a diligent worker burn its
    // whole 30-min budget doing the task inside the greeting turn (no
    // greeting, no visible output — the group saw 30 min of silence while the
    // bot quietly worked). Plain path: the greeting lands in seconds; the
    // real work runs on the chair-assignment turn.
    const triggerContent = (message.content ?? '').trim();
    const triggerIsPresenceCheck = hasGroupTaskNotice(triggerContent, GROUP_TASK_NOTICE.welcome)
      || isRollCallPresenceCheck(triggerContent);
    if (triggerIsPresenceCheck && routing.prompt) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: presence confirmation for bot ${bot.id} runs the plain path ` +
        '(no skill turn — greetings must not become work turns)',
      );
    }
    const canRunSkillTurn = Boolean(
      !triggerIsPresenceCheck
      && routing.prompt
      && routing.activeSkillIds.length > 0
      && deps.runSkillTurn,
    );

    const brain = metabotBrainOptions(bot);
    const llmId = brain.llmId ?? undefined;
    const fallbackLlmId = brain.fallbackLlmId;
    const session = ensureTaskSession(coworkStore, task, bot.id, bot.name);
    let orchestrationAttemptId: string | null = null;
    if (member.role === 'worker' && deps.orchestrationBridge) {
      try {
        const context = deps.orchestrationBridge.beginWorkerAttempt({
          groupTaskId: task.id,
          workerMetabotId: bot.id,
          objective: message.content,
          sourceMessageKey: message.pinId ?? String(message.id),
        });
        orchestrationAttemptId = context.attempt.id;
        deps.orchestrationBridge.markWorkerAttemptRunning(context.attempt.id, session.id);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: canonical Worker attempt start failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const failCanonicalAttempt = (error: unknown): void => {
      if (!orchestrationAttemptId || !deps.orchestrationBridge) return;
      deps.orchestrationBridge.failWorkerAttempt(
        orchestrationAttemptId,
        error instanceof Error ? error.message : String(error),
      );
    };
    const turnUserMessage = coworkStore.addMessage(session.id, { type: 'user', content: userMessage });

    let reply = '';
    if (canRunSkillTurn) {
      const skillSystemPrompt = [
        baseSystemPrompt,
        '',
        routing.prompt!,
        '',
        'After using Read/Bash to run a skill, reply concisely in the group. Do not paste full skill logs.',
      ].join('\n');
      let skillTurnResult;
      try {
        skillTurnResult = await deps.runSkillTurn!({
          sessionId: session.id,
          systemPrompt: skillSystemPrompt,
          userMessage,
          activeSkillIds: routing.activeSkillIds,
        });
      } catch (error) {
        failCanonicalAttempt(error);
        throw error;
      }
      reply = (skillTurnResult.replyText ?? '').trim();
      // The runner appends the assistant message to the session itself.
    } else {
      try {
        reply = (await performChatWithTimeout(baseSystemPrompt, userMessage, llmId, {
          llmProvider: brain.llmProvider,
          fallbackLlmId,
          fallbackLlmProvider: brain.fallbackLlmProvider,
          effort: brain.effort,
          fallbackEffort: brain.fallbackEffort,
          thinking: 'enabled',
        })).trim();
      } catch (error) {
        failCanonicalAttempt(error);
        throw error;
      }
      if (reply) {
        coworkStore.addMessage(session.id, { type: 'assistant', content: reply });
      }
    }
    if (!reply || isNonAnswerAssistantReply(reply)) {
      // Task #66 (fix A): with mid-turn speech, an empty final reply after
      // group_chat send_group_message calls in THIS turn is a DELIVERED turn
      // (the ONE VOICE PER TURN closer) — settle it as completed instead of
      // failing the attempt and forcing a duplicate re-run.
      const midTurnSends = countMidTurnGroupSends(coworkStore, session.id, turnUserMessage.id);
      if (midTurnSends > 0) {
        if (orchestrationAttemptId && deps.orchestrationBridge) {
          deps.orchestrationBridge.completeWorkerAttemptNoReply(orchestrationAttemptId);
        }
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} delivered ${midTurnSends} group message(s) ` +
          `mid-turn via group_chat; the empty final reply is the ONE VOICE closer — turn counts as delivered`,
        );
        return;
      }
      // 清单 #10 P-A (groupTaskDaemon canonical path): an empty reply is only
      // a bare EMPTY_HANDOFF when the session shows no substantive activity;
      // otherwise fail the attempt with the WORKER_EMPTY_HANDOFF_WITH_ACTIVITY
      // summary (commit/tests/files/toolCalls/errors/lastError) so the chair
      // can recognize a false failure and reuse the produced work.
      const activity = summarizeSessionActivity(
        readTaskSessionActivityMessages(coworkStore, session.id),
      );
      failCanonicalAttempt(
        hasSubstantiveActivity(activity)
          ? formatWorkerEmptyHandoffError(activity)
          : WORKER_EMPTY_HANDOFF,
      );
      return;
    }

    // [NO_REPLY] escape hatch: the model opted to stay silent. The assistant
    // message is already in the session (context continuity) and cooldown/budget
    // is still recorded by the caller; only the on-chain send is suppressed.
    // fix/group-member-status: deliberate silence settles the canonical attempt
    // as a no-reply COMPLETION instead of a failure — a WORKER_NO_REPLY failure
    // painted the member-rail "出错" badge for the whole error window even
    // though the bot answered correctly.
    if (NO_REPLY_PATTERN.test(reply)) {
      if (orchestrationAttemptId && deps.orchestrationBridge) {
        deps.orchestrationBridge.completeWorkerAttemptNoReply(orchestrationAttemptId);
      }
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} answered [NO_REPLY]; ` +
        'on-chain send suppressed (debug)',
      );
      return;
    }

    let sent: { pinId: string };
    try {
      // R5: thread this reply under the message that triggered it (the chair's
      // dispatch for a worker, or the worker's message for a chair response).
      // The host decides who is being replied to from the gating context — the
      // LLM never writes pinids itself.
      sent = await postGroupMessage(task.id, bot.id, reply, {
        replyPin: message.pinId ?? undefined,
      });
    } catch (error) {
      failCanonicalAttempt(error);
      emitLog(
        `[GroupTaskDaemon] Send failed (task ${task.id}, bot ${bot.id}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (member.role === 'chair') {
      // P2-7 r2: the daemon's own auto reply must not count as "Twin activity"
      // for the suppression window when it round-trips into the DB.
      rememberDaemonChairPin(task.id, sent.pinId);
    }
    if (orchestrationAttemptId && deps.orchestrationBridge) {
      try {
        deps.orchestrationBridge.completeWorkerAttempt({
          attemptId: orchestrationAttemptId,
          replyText: reply,
          groupMessagePinId: sent.pinId,
        });
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: Worker reply was sent but canonical completion failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * fix/group-task-flow: upper bound for the post-timeout in-flight latch. A
   * skill-turn watchdog fire means the turn keeps running inside the session;
   * the guard stays latched until the session leaves 'running' (or this cap).
   * GT-01 (task #56): the latched key is tracked in latchedTurnKeys for the
   * whole latch so it stops counting as live drive activity; the retry
   * obligation was already re-queued durably at latch time (dispatchReplyTurn),
   * so the deferred-queue drain picks the message up on the first tick after
   * the release — including after an app restart (the durable queue survives
   * even though this in-memory latch does not).
   */
  const TURN_LATCH_MAX_MS = 45 * 60_000;
  /** GT-01: resolved hard cap for one in-flight turn guard (see deps). */
  const turnHardCapMs = Math.max(1_000, Math.trunc(deps.turnHardCapMs ?? TURN_LATCH_MAX_MS));
  const latchInFlightUntilSessionIdle = (key: string, sessionId: string | null, taskId: number, botId: number): void => {
    if (!sessionId) {
      latchedTurnKeys.delete(key);
      turnInFlight.delete(key);
      emitTurnActivity();
      return;
    }
    const startedAt = now();
    // Task #60: throttle the "still running" suppression log — the watcher
    // fires every 15s and a long turn can hold the latch for tens of minutes.
    let lastSuppressLogAt = 0;
    const watcher = setInterval(() => {
      let status: string | null = null;
      try {
        status = deps.getCoworkStore().getSession(sessionId)?.status ?? null;
      } catch {
        status = null;
      }
      const capReached = now() - startedAt >= TURN_LATCH_MAX_MS;
      if (status === 'running' && !capReached) return;
      // Task #60: a non-'running' status read is NOT proof the turn ended. The
      // skill-turn bridge stamps the session 'error' at the watchdog fire
      // while the runner keeps executing the original turn; releasing the
      // latch on that transient read re-dispatched the SAME trigger into a
      // session that was still busy (message #3247 re-driven at 06:29 and
      // 06:59 while Lucy's first turn ran on). Verify termination through the
      // runner: only release when no live turn handle remains for the session
      // (or the latch cap forces it). Unwired probe = status-only fallback.
      let sessionActive = false;
      try {
        sessionActive = deps.isCoworkSessionActive?.(sessionId) === true;
      } catch {
        sessionActive = false;
      }
      if (sessionActive && !capReached) {
        if (now() - lastSuppressLogAt >= 5 * 60_000) {
          lastSuppressLogAt = now();
          emitLog(
            `[GroupTaskDaemon] Task ${taskId}: in-flight latch for bot ${botId} held — session status reads ` +
            `'${status ?? 'unknown'}' but the original turn is still running in the session; ` +
            'the deferred re-drive of its trigger stays suppressed',
          );
        }
        return;
      }
      clearInterval(watcher);
      latchWatchers.delete(watcher);
      latchedTurnKeys.delete(key);
      turnInFlight.delete(key);
      emitTurnActivity();
      emitLog(
        `[GroupTaskDaemon] Task ${taskId}: in-flight latch for bot ${botId} released ` +
        `(session status ${status ?? 'unknown'}${sessionActive ? ', runner turn still active' : ''}${capReached ? ', latch cap reached' : ''}); ` +
        'the deferred queue re-drives the unanswered trigger on the next tick',
      );
    }, 15_000);
    watcher.unref?.();
    latchWatchers.add(watcher);
  };

  /**
   * fix/group-task-flow: dispatch one responder's turn as a DETACHED async job.
   * The old inline `await generateAndSendReply(...)` let a single 10-40 min
   * turn freeze the whole daemon tick — every other task's messages and every
   * watchdog stalled behind it (task #51: a 41-min chair turn batched late
   * false-positive warnings and left the pipeline looking dead). Now the tick
   * only dispatches; the job posts the reply when the turn completes.
   *
   * Invariants preserved:
   * - one turn per (task, bot) session: callers check turnInFlight first and
   *   defer into the durable queue when busy;
   * - cooldown/reply budget are charged at dispatch (committed work), so a
   *   failing turn cannot retry for free;
   * - failures requeue into the durable defer queue with the same bounded
   *   retry budget the synchronous path had (MSG_RETRY_MAX_FAILURES);
   * - a skill-turn watchdog fire is not retried (the turn keeps running in the
   *   session) and keeps the guard latched until the session goes idle.
   */
  /**
   * fix/group-task-flow (task #51 feedback): arm the long-turn liveness
   * timers for one detached turn job; the returned timers must be cleared in
   * the job's finally.
   *
   * Speedup R-01 rework: liveness is now INTERNAL by default. While the turn
   * runs past LONG_TURN_LEASE_ARM_MS, the worker's [WORKING long-task] lease
   * is renewed straight into kv (no group message) so the silence watchdogs
   * keep treating the member as alive for the turn's duration. The single
   * visible emission is one @chair reminder at longTurnChairReminderMs — the
   * member is not expected to reply. The legacy visible posts (numberless
   * ceremony-shaped [WORKING] lines as the working bot) only happen when
   * longTurnPlaceholderMs / longTurnHeartbeatMax are explicitly set above 0.
   * Real timers on purpose: the test clock must not fire them.
   */
  const armLongTurnLiveness = (args: {
    taskId: number;
    metabotId: number;
    isChair: boolean;
    job: Promise<void>;
  }): Array<ReturnType<typeof setTimeout>> => {
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    // unref: a never-settling turn (the skill-turn watchdog latch path) must
    // not keep the process event loop alive through these timers.
    const armTimer = (fn: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return timer;
    };
    const renewLease = (): void => {
      if (args.isChair) return;
      // Re-check inside the timer hop: the job may have settled (its finally
      // clears these timers) after this timer already fired.
      if (!pendingTurnJobs.has(args.job)) return;
      try {
        deps.getStore().set(
          `${WORKING_HEARTBEAT_PREFIX}${args.taskId}:${args.metabotId}`,
          String(computeWorkingHeartbeatUntil(Math.ceil(longTurnHeartbeatMs / 60_000) + 1, now())),
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${args.taskId}: internal liveness lease renewal failed for bot ${args.metabotId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    if (!args.isChair) {
      timers.push(armTimer(renewLease, longTurnLeaseArmMs));
      const renewalInterval = setInterval(
        renewLease,
        Math.max(50, Math.floor(longTurnHeartbeatMs / 2)),
      );
      renewalInterval.unref?.();
      timers.push(renewalInterval);
      if (longTurnChairReminderMs > 0) {
        timers.push(armTimer(() => {
          // Single-commander: the long-turn fact goes to the CHAIR as an
          // environment note (the host never speaks as the member). The
          // timer fires once per turn, so the note needs no extra one-shot
          // guard; it is consumed by the next host-note chair turn.
          if (!pendingTurnJobs.has(args.job)) return;
          try {
            const memberName =
              deps.getGroupTaskStore().listMembers(args.taskId)
                .find((member) => member.metabotId === args.metabotId)?.name?.trim()
              || deps.getMetabotStore().getMetabotById(args.metabotId)?.name?.trim()
              || `bot-${args.metabotId}`;
            const minutes = Math.max(1, Math.round(longTurnChairReminderMs / 60_000));
            const ackPending = deps.getStore()
              .get<string>(`${ACK_PENDING_PREFIX}${args.taskId}:${args.metabotId}`) != null;
            deps.getGroupTaskStore().recordHostNote({
              taskId: args.taskId,
              kind: 'long_turn',
              target: memberName,
              dedupeKey: `long_turn:${args.taskId}:${args.metabotId}:${Math.floor(now() / longTurnChairReminderMs)}`,
              body:
                `${memberName}'s turn has been running for over ${minutes} min with no group output; ` +
                'the worker session is still active (liveness lease renewed internally).'
                + (ackPending
                  ? ` NOTE: no [WORKING] ACK from ${memberName} is on record for the current assignment yet.`
                  : ''),
            });
            emitLog(
              `[GroupTaskDaemon] Task ${args.taskId}: recorded the one-shot long-turn environment note for bot ${args.metabotId}`,
            );
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Task ${args.taskId}: long-turn environment note record failed for bot ${args.metabotId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, longTurnChairReminderMs));
      }
    }
    return timers;
  };

  const dispatchReplyTurn = (args: {
    task: GroupTask;
    member: GroupTaskMember;
    bot: GroupTaskDaemonBotFull;
    message: GroupTaskDaemonMessage;
    reason: GroupTaskResponderDecision['reason'];
    promptMembers: DaemonPromptMember[];
    chairGlobalMetaId: string;
    ownerGlobalMetaId: string;
    verificationNotes: string[];
    remoteStatusBlock: string;
    /** The durable-queue entry being drained, when this dispatch is a retry. */
    entry: DeferredReplyEntry | null;
  }): void => {
    const { task, member, bot, message } = args;
    const key = keyOf(task.id, bot.id);
    const sessionId = ensureTaskSession(deps.getCoworkStore(), task, bot.id, bot.name).id;
    // GT-01 follow-up: a hard-cap force-settle releases this guard while the
    // ORIGINAL runner turn may still be active on the session (its await never
    // settled — that is what tripped the cap). Dispatching now would start a
    // second concurrent turn on the same session, and runner events are keyed
    // by sessionId — the stale turn's late completion could resolve ours with
    // its reply. Hold the trigger in the durable queue (budget uncharged)
    // until the session reports idle, bounded by one hard-cap window; past
    // the bound we dispatch anyway and the ordinary retry budget governs.
    {
      let sessionStatus: string | null = null;
      try {
        sessionStatus = deps.getCoworkStore().getSession(sessionId)?.status ?? null;
      } catch {
        sessionStatus = null;
      }
      // Task #60: the runner's live turn handle is the ground truth — a
      // transient 'error' status stamp (the skill-turn bridge marks the
      // session 'error' at the watchdog fire while the turn keeps running)
      // must not let the same trigger start a second concurrent turn here.
      let sessionActive = false;
      try {
        sessionActive = deps.isCoworkSessionActive?.(sessionId) === true;
      } catch {
        sessionActive = false;
      }
      if (sessionStatus === 'running' || sessionActive) {
        const holdKey = `${SESSION_BUSY_HOLD_PREFIX}${task.id}:${bot.id}:${message.id}`;
        const priorHeldSince = Number(deps.getStore().get<number>(holdKey) ?? 0);
        const heldSince = priorHeldSince || now();
        deps.getStore().set(holdKey, heldSince);
        if (now() - heldSince < turnHardCapMs) {
          deferReply({
            taskId: task.id,
            metabotId: bot.id,
            messageId: message.id,
            reason: args.reason,
            verificationNotes: args.verificationNotes,
            failures: args.entry?.failures,
          });
          if (!priorHeldSince) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: holding the trigger for message #${message.id} — ` +
              `bot ${bot.id}'s session is still running a prior turn (bounded wait of ` +
              `${Math.round(turnHardCapMs / 60_000)} min, then the retry budget governs)`,
            );
          }
          return;
        }
        deps.getStore().delete(holdKey);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: session-busy hold for message #${message.id} expired — ` +
          'dispatching anyway (the retry budget now governs)',
        );
      } else {
        deps.getStore().delete(`${SESSION_BUSY_HOLD_PREFIX}${task.id}:${bot.id}:${message.id}`);
      }
    }
    const turnToken: object = {};
    turnInFlight.set(key, { startedAt: now(), token: turnToken });
    emitTurnActivity();
    noteDriveActivity(task.id); // a dispatched turn is real drive work
    // GT-01 (task #56): absolute wall-clock cap on the in-flight guard. Every
    // production turn is already bounded from inside (10-min plain / 30-min
    // skill-turn watchdogs, then the 45-min latch), but those all require the
    // hung await to REJECT — an await that never settles at all (observed in
    // the wild as a hung on-chain send, task #45) used to leak the guard
    // forever: the wedged member never took another turn, and the leaked entry
    // kept lastDrivenAt fresh (a second fake-heartbeat channel). On fire the
    // trigger re-enters the durable defer queue (bounded by the same failure
    // budget), the guard releases, and the dangling job is left to rot — the
    // same contract as the tick watchdog. A job that settles in time clears
    // this timer in its finally block below.
    const hardCapTimer = setTimeout(() => {
      // The latch path (SkillTurnTimeoutError) already owns latched keys — its
      // watcher re-queues and releases on its own schedule. Ownership: a newer
      // dispatch's entry must survive this late fire of the OLD timer.
      const current = turnInFlight.get(key);
      if (!current || current.token !== turnToken || latchedTurnKeys.has(key)) return;
      turnInFlight.delete(key);
      emitTurnActivity();
      const failures = (args.entry?.failures ?? 0) + 1;
      if (failures >= MSG_RETRY_MAX_FAILURES) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} turn for message #${message.id} dropped ` +
          `after ${failures} failed attempts (this one a wedged-turn force-settle) — giving up`,
        );
        notifySourceSessionMilestone(
          task,
          'anomaly',
          buildSourceSessionAnomalyNotice({
            title: task.title,
            status: task.status,
            summary:
              `${member.role === 'chair' ? 'The chair' : (member.name ?? `Bot ${bot.id}`)} did not answer ` +
              `message #${message.id}: ${failures} consecutive failed turn attempts — the latest was a ` +
              'wedged in-flight call that never settled (earlier attempts may have failed fast instead). ' +
              'The trigger was dropped — investigate the member bot and re-drive it manually.',
          }),
          `wedged_turn_drop:${task.id}:${bot.id}:${message.id}`,
        );
        return;
      }
      deferReply({
        taskId: task.id,
        metabotId: bot.id,
        messageId: message.id,
        reason: args.reason,
        verificationNotes: args.verificationNotes,
        failures,
      });
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} turn exceeded the hard in-flight cap ` +
        `(message #${message.id}, attempt ${failures}/${MSG_RETRY_MAX_FAILURES}) — guard force-settled, ` +
        'trigger re-queued; the dangling job is left to rot',
      );
      notifySourceSessionMilestone(
        task,
        'anomaly',
        buildSourceSessionAnomalyNotice({
          title: task.title,
          status: task.status,
          summary:
            `${member.role === 'chair' ? 'The chair' : (member.name ?? `Bot ${bot.id}`)} had a turn wedged ` +
            `past the hard in-flight cap while answering message #${message.id} (an in-flight call never ` +
            'settled). The guard was force-settled and the trigger re-queued — if this repeats, check the ' +
            'member bot\'s LLM/chain connectivity.',
        }),
        `wedged_turn:${task.id}:${bot.id}:${message.id}:${failures}`,
      );
    }, turnHardCapMs);
    hardCapTimer.unref?.();
    // The reply budget is charged at dispatch (committed work — a retry storm
    // must not be free); the cooldown timestamp only moves on SUCCESS (a failed
    // turn posted nothing, so its durable-queue retry must not sit out a
    // cooldown it never earned).
    replyCountByKey.set(key, (replyCountByKey.get(key) ?? 0) + 1);
    emitLog(
      `[GroupTaskDaemon] Task ${task.id}: dispatched async ${member.role} turn for bot ${bot.id} ` +
      `(message #${message.id}, reason ${args.reason}${args.entry ? ', from deferred queue' : ''})`,
    );
    // fix/group-task-flow (task #51 feedback): long turns report liveness
    // instead of going silent — see armLongTurnLiveness.
    const livenessTimers: Array<ReturnType<typeof setTimeout>> = [];
    const job: Promise<void> = (async () => {
      let keepLatched = false;
      try {
        await generateAndSendReply(
          task,
          member,
          bot,
          message,
          args.promptMembers,
          args.chairGlobalMetaId,
          args.ownerGlobalMetaId,
          args.verificationNotes,
          args.remoteStatusBlock,
        );
        lastReplyAtByKey.set(key, now());
        // Task #51 safety net: a completed chair turn answers every pending
        // trigger up to this message; a NEWER trigger survives.
        if (member.role === 'chair') {
          const pendingKey = `${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`;
          const pendingRaw = deps.getStore().get<string>(pendingKey);
          if (pendingRaw) {
            let pendingId: number | null = null;
            try {
              pendingId = (JSON.parse(pendingRaw) as { messageId?: number }).messageId ?? null;
            } catch {
              pendingId = null;
            }
            if (pendingId == null || pendingId <= message.id) deps.getStore().delete(pendingKey);
          }
        }
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${member.role} turn for bot ${bot.id} completed ` +
          `(message #${message.id})`,
        );
      } catch (error) {
        if (error instanceof SkillTurnTimeoutError) {
          // GT-01 (task #56): the old path latched the guard and queued NO
          // retry — during a provider outage every member turn burned the
          // watchdog, latched, and the unanswered trigger was silently lost
          // (the cursor had already advanced past it), so the task never
          // recovered on its own after the provider came back. Now the
          // obligation re-enters the DURABLE defer queue at latch time: the
          // drain holds it while the latch is up and re-drives it once the
          // session idles — and it survives an app restart, which the
          // in-memory latch does not. Bounded by the same MSG_RETRY_MAX_FAILURES
          // budget as ordinary failures so a multi-hour outage cannot loop
          // forever; on exhaustion the trigger drops with an anomaly alert
          // instead of another latch.
          const failures = (args.entry?.failures ?? 0) + 1;
          if (failures >= MSG_RETRY_MAX_FAILURES) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} turn for message #${message.id} ` +
              `dropped after ${failures} skill-turn watchdog timeouts: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
            notifySourceSessionMilestone(
              task,
              'anomaly',
              buildSourceSessionAnomalyNotice({
                title: task.title,
                status: task.status,
                summary:
                  `${member.role === 'chair' ? 'The chair' : (member.name ?? `Bot ${bot.id}`)} did not answer ` +
                  `message #${message.id}: ${failures} turns in a row exceeded the skill-turn time budget ` +
                  '(typically a provider outage). The trigger was dropped — re-drive the member manually ' +
                  '(a supervisor nudge) once the provider is healthy again.',
              }),
              `skill_turn_timeout_drop:${task.id}:${bot.id}:${message.id}`,
            );
          } else {
            keepLatched = true;
            latchedTurnKeys.add(key);
            deferReply({
              taskId: task.id,
              metabotId: bot.id,
              messageId: message.id,
              reason: args.reason,
              verificationNotes: args.verificationNotes,
              failures,
            });
            latchInFlightUntilSessionIdle(key, sessionId, task.id, bot.id);
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} turn hit the skill-turn watchdog ` +
              `(message #${message.id}, attempt ${failures}/${MSG_RETRY_MAX_FAILURES}); the turn keeps ` +
              'running in the session — trigger re-queued durably, guard latched until the session goes idle',
            );
          }
        } else {
          // fix/group-task-duration (task #57): a corrupt DSH session log
          // ("seq gap in committed region") fails EVERY turn on that session
          // fast and forever — 5 blind retries against the same corrupt log
          // all die, the trigger drops, and every later recovery mechanism
          // (supervisor signals, stall nudges) hits the same wall: the task
          // becomes a permanent zombie. Rebuild the member's task session
          // from the host ledger and requeue the trigger UNCHARGED (the
          // failure is environmental, not the member's). Bounded to one
          // rebuild per (task, bot) per hour so a genuinely broken runtime
          // cannot loop rebuilds.
          const errorMessage = error instanceof Error ? error.message : String(error);
          // fix-v2 P1-5: the shared detector also covers the append-side
          // cursor mismatch and the unparsable-committed-event signatures —
          // every corruption variant routes to rebuild, not the blind ladder.
          if (isCorruptSessionLogError(error)) {
            const rebuildKey = `${CORRUPT_SESSION_REBUILD_PREFIX}${task.id}:${bot.id}`;
            const lastRebuildAt = Number(deps.getStore().get<number>(rebuildKey) ?? 0) || 0;
            if (now() - lastRebuildAt > CORRUPT_SESSION_REBUILD_MIN_INTERVAL_MS) {
              try {
                deps.getStore().set(rebuildKey, now());
                const rebuilt = rebuildGroupTaskSession({
                  coworkStore: deps.getCoworkStore(),
                  groupTaskStore: deps.getGroupTaskStore(),
                  task,
                  botId: bot.id,
                  botName: bot.name,
                });
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: corrupt session log for bot ${bot.id} — task session ` +
                  `rebuilt from the host ledger (${rebuilt.sessionId.slice(0, 8)}…); trigger requeued. ` +
                  `Log signature: ${corruptSessionLogSignature(error)}`,
                );
                notifySourceSessionMilestone(
                  task,
                  'anomaly',
                  buildSourceSessionAnomalyNotice({
                    title: task.title,
                    status: task.status,
                    summary:
                      `${member.role === 'chair' ? 'The chair' : (member.name ?? `Bot ${bot.id}`)} hit a corrupt ` +
                      'session log — every turn on it would fail forever. ' +
                      `Log signature: ${corruptSessionLogSignature(error)}. ` +
                      'The host rebuilt the member\'s task session from the task ledger (goal, status trail, ' +
                      'deliverables, recent transcript); the member lost its private chat memory of this task only.',
                  }),
                  `corrupt_session_rebuild:${task.id}:${bot.id}`,
                );
                deferReply({
                  taskId: task.id,
                  metabotId: bot.id,
                  messageId: message.id,
                  reason: args.reason,
                  verificationNotes: args.verificationNotes,
                  failures: args.entry?.failures ?? 0,
                });
                return;
              } catch (rebuildError) {
                emitLog(
                  `[GroupTaskDaemon] Task ${task.id}: corrupt-session rebuild failed for bot ${bot.id}: ` +
                  `${rebuildError instanceof Error ? rebuildError.message : String(rebuildError)}`,
                );
              }
            } else {
              // fix-v2 P1-5: corruption RECURRED within the rebuild cooldown —
              // the dual-writer race that produced it is likely still live, so
              // the fresh log is being re-corrupted. Do not burn the 5-turn
              // retry ladder in silence first: alert the origin session
              // immediately with the self-heal guidance, then fall through.
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: corrupt session log for bot ${bot.id} recurred ` +
                'within the rebuild cooldown — escalating immediately instead of only counting retries. ' +
                `Log signature: ${corruptSessionLogSignature(error)}`,
              );
              notifySourceSessionMilestone(
                task,
                'anomaly',
                buildSourceSessionAnomalyNotice({
                  title: task.title,
                  status: task.status,
                  summary:
                    `${member.role === 'chair' ? 'The chair' : (member.name ?? `Bot ${bot.id}`)} hit a corrupt ` +
                    'session log AGAIN within an hour of the automatic rebuild — the driver-handoff race that ' +
                    'corrupts the log is likely still live (two runtime processes writing one session log). ' +
                    `Log signature: ${corruptSessionLogSignature(error)}. ` +
                    'Self-heal guidance: restart the app so every runtime subprocess is reaped and the session ' +
                    'resumes under a single writer; if it still recurs, investigate the provider re-pin / ' +
                    'config-change handoff for this bot.',
                }),
                `corrupt_session_rebuild_capped:${task.id}:${bot.id}`,
              );
            }
          }
          const failures = (args.entry?.failures ?? 0) + 1;
          if (failures >= MSG_RETRY_MAX_FAILURES) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} turn for message #${message.id} ` +
              `dropped after ${failures} failures: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
            // GT-10: exhausting the retry budget is an anomaly the origin
            // session must hear about — the trigger is lost for good here.
            notifySourceSessionMilestone(
              task,
              'anomaly',
              buildSourceSessionAnomalyNotice({
                title: task.title,
                status: task.status,
                summary:
                  `${member.role === 'chair' ? 'The chair' : (member.name ?? `Bot ${bot.id}`)} did not answer ` +
                  `message #${message.id}: ${failures} turns failed in a row ` +
                  `(${error instanceof Error ? error.message : String(error)}). ` +
                  'The trigger was dropped — check the member bot and re-drive it manually.',
              }),
              `turn_failed_drop:${task.id}:${bot.id}:${message.id}`,
            );
          } else {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: bot ${bot.id} turn for message #${message.id} ` +
              `failed (attempt ${failures}/${MSG_RETRY_MAX_FAILURES}); requeued: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
            deferReply({
              taskId: task.id,
              metabotId: bot.id,
              messageId: message.id,
              reason: args.reason,
              verificationNotes: args.verificationNotes,
              failures,
            });
          }
        }
      } finally {
        clearTimeout(hardCapTimer);
        for (const timer of livenessTimers) clearTimeout(timer);
        livenessTimers.length = 0;
        if (!keepLatched) {
          // Ownership: a hard-cap fire may have already released this key and a
          // REPLACEMENT dispatch may own it now — deleting unconditionally
          // would break the replacement's one-turn-per-session guard.
          if (turnInFlight.get(key)?.token === turnToken) {
            turnInFlight.delete(key);
            emitTurnActivity();
          }
        }
        pendingTurnJobs.delete(job);
        noteTickProgress();
      }
    })();
    pendingTurnJobs.add(job);
    livenessTimers.push(
      ...armLongTurnLiveness({ taskId: task.id, metabotId: bot.id, isChair: member.role === 'chair', job }),
    );
  };

  /**
   * fix/group-task-flow: run a task-level chair turn (planning / supervisor
   * signals) as a detached job under the same per-(task,bot) in-flight guard —
   * a busy chair session defers the work to a later tick instead of blocking
   * this one. The wrapped function keeps its own retry/pending semantics.
   */
  const runTurnAsync = (
    guardKey: string,
    label: string,
    fn: () => Promise<void>,
    liveness?: { taskId: number; metabotId: number; isChair: boolean },
  ): boolean => {
    if (turnInFlight.has(guardKey)) {
      emitLog(`[GroupTaskDaemon] ${label}: skipped — a turn is already in flight for ${guardKey}`);
      return false;
    }
    const turnToken: object = {};
    turnInFlight.set(guardKey, { startedAt: now(), token: turnToken });
    emitTurnActivity();
    if (liveness) noteDriveActivity(liveness.taskId); // a dispatched turn is real drive work
    // GT-01: same hard cap as dispatchReplyTurn — a task-level chair turn whose
    // await never settles must not leak the guard (and with it the chair's
    // whole turn budget) forever. On fire the guard releases so later ticks
    // re-drive the work; the dangling job is left to rot. Ownership: a newer
    // re-drive's entry must survive this late fire of the OLD timer.
    const hardCapTimer = setTimeout(() => {
      const current = turnInFlight.get(guardKey);
      if (!current || current.token !== turnToken) return;
      turnInFlight.delete(guardKey);
      emitTurnActivity();
      emitLog(
        `[GroupTaskDaemon] ${label}: exceeded the hard in-flight cap — guard force-settled; ` +
        'the dangling job is left to rot',
      );
    }, turnHardCapMs);
    hardCapTimer.unref?.();
    const livenessTimers: Array<ReturnType<typeof setTimeout>> = [];
    const job: Promise<void> = (async () => {
      try {
        await fn();
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] ${label} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(hardCapTimer);
        for (const timer of livenessTimers) clearTimeout(timer);
        livenessTimers.length = 0;
        if (turnInFlight.get(guardKey)?.token === turnToken) {
          turnInFlight.delete(guardKey);
          emitTurnActivity();
        }
        pendingTurnJobs.delete(job);
        noteTickProgress();
      }
    })();
    pendingTurnJobs.add(job);
    // A task-level chair turn (planning / supervisor) reports liveness too —
    // the task #51 planning turn sat silent for 41 min and read as a stuck
    // chair to everyone watching the group.
    if (liveness) livenessTimers.push(...armLongTurnLiveness({ ...liveness, job }));
    return true;
  };

  /** Resolves once every turn job dispatched so far has settled. */
  const whenIdle = async (): Promise<void> => {
    while (pendingTurnJobs.size > 0) {
      await Promise.allSettled([...pendingTurnJobs]);
    }
  };

  /**
   * Round-4 attribution enrichment. The chain-signature GlobalMetaID is the
   * ONLY identity source for group-task attribution:
   * - a row whose sender_global_metaid is empty is resolved from its legacy
   *   sender_metaid via the injected manapi resolver and the row is updated
   *   once (so every consumer — daemon, experience ledger, show — agrees);
   * - a message whose GlobalMetaID is neither a task member nor the owner is
   *   marked SUSPECT (persisted); senderName is NEVER used for attribution.
   * R2P1-4: a resolver THROW is transient and propagates into the caller's
   * bounded retry path — only a definitive null/empty resolution marks SUSPECT.
   */
  const memberGlobalMetaIdSet = (members: GroupTaskMember[]): Set<string> => {
    const set = new Set<string>();
    for (const member of members) {
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      if (gmid) set.add(gmid);
    }
    return set;
  };

  const enrichMessageAttribution = async (
    message: GroupTaskDaemonMessage,
    memberGmids: Set<string>,
    ownerGlobalMetaId: string,
  ): Promise<GroupTaskDaemonMessage> => {
    let globalMetaId = (message.senderGlobalMetaId ?? '').trim();
    const legacy = (message.senderMetaId ?? '').trim();
    if (!globalMetaId && legacy && deps.resolveGlobalMetaId) {
      // A resolver THROW (network/indexer outage) is transient, not a
      // definitive "unresolvable": it propagates so the message rides the
      // bounded MSG_RETRY path instead of being permanently stamped SUSPECT
      // with the cursor advanced past it. Only a clean null/empty resolution
      // below marks SUSPECT.
      const resolved = (await deps.resolveGlobalMetaId(legacy))?.trim();
      if (resolved) {
        globalMetaId = resolved;
        try {
          deps.getGroupTaskStore().updateMessageSenderGlobalMetaId(message.id, resolved);
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Message ${message.id}: resolved GlobalMetaID persist failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const normalized = globalMetaId.toLowerCase();
    const suspect = !globalMetaId
      || (!memberGmids.has(normalized) && normalized !== ownerGlobalMetaId.toLowerCase());
    if (suspect !== Boolean(message.senderSuspect)) {
      try {
        deps.getGroupTaskStore().setMessageSenderSuspect(message.id, suspect);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Message ${message.id}: suspect flag persist failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { ...message, senderGlobalMetaId: globalMetaId || null, senderSuspect: suspect };
  };

  /**
   * P1-2/P2-1: resolve a LOCAL member's cowork session binding (channel
   * 'metaweb_group_task', conversation 'group-task:<taskId>') and its last
   * activity time — the "is the worker actually doing something" signal the
   * speech-only watchdogs used to lack. Best-effort: any store error reads as
   * "no session info", never breaks the tick.
   */
  const getLocalMemberSessionInfo = (
    taskId: number,
    metabotId: number,
  ): { sessionId: string; lastActivityMs: number | null; cwd: string | null } | null => {
    try {
      const coworkStore = deps.getCoworkStore();
      const mapping = coworkStore.getConversationMapping(
        GROUP_TASK_CONVERSATION_CHANNEL,
        `group-task:${taskId}`,
        metabotId,
      );
      if (!mapping) return null;
      const session = coworkStore.getSessionWithoutMessages(mapping.coworkSessionId);
      if (!session) return null;
      const updatedAt = Number(session.updatedAt);
      return {
        sessionId: session.id,
        lastActivityMs: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : null,
        cwd: session.cwd ?? null,
      };
    } catch {
      return null;
    }
  };

  /** P2-2: valid-until (epoch ms) of the member's [WORKING long-task] lease. */
  const getMemberHeartbeatUntil = (taskId: number, metabotId: number): number | null => {
    const raw = deps.getStore().get<string>(`${WORKING_HEARTBEAT_PREFIX}${taskId}:${metabotId}`);
    const parsed = raw == null ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  /**
   * P1-2/P1-3: reclaim a genuinely stuck LOCAL worker session, once per
   * silence streak. Stops the session (working directory and on-disk
   * artifacts are preserved), fails the canonical orchestration attempt, and
   * returns an actionable directive for the chair's context channel. Returns
   * null when the reclaim already fired for this streak.
   */
  const reclaimStuckWorkerSession = (
    task: GroupTask,
    member: GroupTaskMember,
    reason: string,
  ): string | null => {
    if (member.metabotId == null) return null;
    const sqlite = deps.getStore();
    const reclaimKey = `${GROUP_TASK_STUCK_RECLAIM_PREFIX}${task.id}:${member.metabotId}`;
    if (sqlite.get<string>(reclaimKey) === '1') return null;
    sqlite.set(reclaimKey, '1');
    const name = member.name ?? `bot-${member.metabotId}`;
    const sessionInfo = getLocalMemberSessionInfo(task.id, member.metabotId);
    let stopped = false;
    if (sessionInfo && deps.stopWorkerSession) {
      try {
        deps.stopWorkerSession(sessionInfo.sessionId);
        stopped = true;
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: stuck-session stop failed for ${name}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (deps.orchestrationBridge) {
      try {
        deps.orchestrationBridge.failActiveWorkerAttempt(
          task.id,
          member.metabotId,
          `STUCK_SESSION_RECLAIMED: ${reason}`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: stuck-session attempt fail failed for ${name}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    emitLog(
      `[GroupTaskDaemon] Task ${task.id}: reclaimed stuck session for ${name} ` +
      `(${reason}; session ${sessionInfo?.sessionId ?? 'none'} ${stopped ? 'stopped' : 'not stopped'})`,
    );
    // G-01: a reclaimed member session is the "member lost after retries"
    // anomaly the origin session must hear about — never silent.
    notifySourceSessionMilestone(
      task,
      'anomaly',
      buildSourceSessionAnomalyNotice({
        title: task.title,
        status: task.status,
        summary:
          `Member "${name}" was judged stuck (${reason}); their session was reclaimed ` +
          `${stopped ? 'and stopped' : '(stop unavailable)'}. The chair will re-dispatch or re-assign the subtask; ` +
          'any partial work on disk is preserved.',
      }),
      `worker_reclaimed:${member.metabotId}`,
    );
    return [
      `Host auto-recovery: ${name} was judged stuck (${reason}).`,
      sessionInfo
        ? `Session ${sessionInfo.sessionId} ${stopped ? 'was stopped' : 'could not be stopped'}; ` +
          `the working directory is preserved at ${sessionInfo.cwd ?? '(unknown)'} — downloaded ` +
          'artifacts and partial outputs are still on disk.'
        : 'No local cowork session was found for the member.',
      `Re-dispatch the subtask with an explicit @${name} (the member wakes on the mention and ` +
        'continues in the preserved directory), or re-assign to a standby member.',
    ].join(' ');
  };

  /**
   * fix/group-task-fix-v2 (B2): alert-only counterpart of
   * reclaimStuckWorkerSession — one alert per silence streak, but the
   * member's session is NEVER stopped and the orchestration attempt is not
   * failed. The chair gets a verify-before-acting directive (the member may
   * legitimately be waiting on an upstream deliverable or a long local
   * step), and the origin session gets one anomaly notice so a human can
   * look too. Returns null when the alert already fired for this streak.
   */
  const alertStuckWorkerSession = (
    task: GroupTask,
    member: GroupTaskMember,
    reason: string,
  ): string | null => {
    if (member.metabotId == null) return null;
    const sqlite = deps.getStore();
    const alertKey = `${GROUP_TASK_STUCK_ALERT_PREFIX}${task.id}:${member.metabotId}`;
    if (sqlite.get<string>(alertKey) === '1') return null;
    sqlite.set(alertKey, '1');
    const name = member.name ?? `bot-${member.metabotId}`;
    const sessionInfo = getLocalMemberSessionInfo(task.id, member.metabotId);
    emitLog(
      `[GroupTaskDaemon] Task ${task.id}: stuck alert (no reclaim) for ${name} (${reason}; ` +
      `session ${sessionInfo?.sessionId ?? 'none'} left running)`,
    );
    notifySourceSessionMilestone(
      task,
      'anomaly',
      buildSourceSessionAnomalyNotice({
        title: task.title,
        status: task.status,
        summary:
          `Member "${name}" looks stuck (${reason}); the host raised an alert but did NOT stop the session ` +
          '(alert-only mode). The chair will verify — the member may be waiting on an upstream deliverable — ' +
          'and re-dispatch or re-assign if it is genuinely stuck.',
      }),
      `worker_stuck_alert:${member.metabotId}`,
    );
    return [
      `Host stuck alert (alert-only — no automatic reclaim): ${name} looks stuck (${reason}).`,
      sessionInfo
        ? `Session ${sessionInfo.sessionId} was left running; its working directory is ${sessionInfo.cwd ?? '(unknown)'}.`
        : 'No local cowork session was found for the member.',
      `Verify before acting: ${name} may legitimately be waiting on an upstream deliverable or a long local step. ` +
      `If it is genuinely stuck, re-dispatch the subtask with an explicit @${name} or re-assign it to a standby member.`,
    ].join(' ');
  };

  /**
   * fix-v2 P1-3: every stuck verdict must cite verifiable pointers — the
   * member's latest ledger deliverable (pin/uri + time + status), its last
   * group speech, the session log's last write, and the last [WORKING] signal,
   * each with a minutes-ago figure. The chair verifies against the ledger and
   * the session instead of rebutting a bare inference (task #57: 4/4 false
   * stuck alerts cited nothing and cost clarification rounds).
   */
  const buildStuckEvidence = (
    deliverable: Pick<GroupTaskDeliverable, 'msgPinId' | 'uri' | 'createdAt' | 'status'> | null,
    signals: {
      lastWorkingMs: number | null;
      lastSpeakMs: number | null;
      lastSessionActivityMs: number | null;
    },
  ): string => {
    const fmtHhMm = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
    const agoMin = (ms: number): number => Math.max(0, Math.round((now() - ms) / 60_000));
    const parts: string[] = [];
    if (deliverable) {
      const ref = deliverable.msgPinId
        ? `pin://${deliverable.msgPinId}`
        : (deliverable.uri ?? '(no uri)');
      const atMs = parseSqliteUtcMs(deliverable.createdAt);
      parts.push(
        atMs != null
          ? `latest ledger deliverable ${ref} (${deliverable.status}) at ${fmtHhMm(atMs)}, ${agoMin(atMs)} min ago`
          : `latest ledger deliverable ${ref} (${deliverable.status})`,
      );
    } else {
      parts.push('no deliverable on the ledger');
    }
    parts.push(
      signals.lastSpeakMs != null
        ? `last group speech at ${fmtHhMm(signals.lastSpeakMs)}, ${agoMin(signals.lastSpeakMs)} min ago`
        : 'no group speech on record',
    );
    parts.push(
      signals.lastSessionActivityMs != null
        ? `session log last write at ${fmtHhMm(signals.lastSessionActivityMs)}, ${agoMin(signals.lastSessionActivityMs)} min ago`
        : 'no cowork-session writes on record',
    );
    if (signals.lastWorkingMs != null) {
      parts.push(
        `last [WORKING] signal at ${fmtHhMm(signals.lastWorkingMs)}, ${agoMin(signals.lastWorkingMs)} min ago`,
      );
    }
    return parts.join('; ');
  };

  /**
   * P0-2: auto-mark silent assigned/working members as unreachable after
   * memberUnreachableAfterMinutes without any chain speech. Baseline = last
   * speak time (fallback: member join time); never marks chair members, done
   * members, or members who already show a non-active status.
   * P1-2/P2-2: a member with fresh cowork-session activity or a valid
   * [WORKING long-task] heartbeat lease is ALIVE (mid long task) — never
   * flagged unreachable. A member with a non-rejected deliverable on the
   * ledger is DONE waiting, not unreachable, and is skipped entirely.
   * Recovery (fix/group-member-status): the stamp used to be one-way — a
   * member marked unreachable left this scan set forever, so a stale stamp
   * outlived any resumed activity whenever the cursor-based message handler
   * missed the comeback (e.g. a hung tick). The scan now also covers
   * 'unreachable' members and restores them to 'working' the moment ANY
   * liveness signal (fresh speech / session activity / heartbeat lease) reads
   * alive again.
   */
  const monitorMemberUnreachable = (task: GroupTask, members: GroupTaskMember[]): void => {
    const thresholdMs = memberUnreachableAfterMinutes * 60_000;
    const store = deps.getGroupTaskStore();
    const workers = members.filter(
      (member) => member.role === 'worker'
        && (member.status === 'assigned' || member.status === 'working' || member.status === 'unreachable'),
    );
    if (workers.length === 0 || !task.groupId) return;
    const speakMap = store.getMembersLastSpeakAt(
      task.groupId,
      workers.map((member) => member.globalmetaid),
    );
    // Review fix (delivered-then-idle): a worker with a non-rejected
    // deliverable on the ledger is DONE waiting, not unreachable — same
    // guard as monitorLocalWorkerTimeout so the badge never stamps a
    // delivered member who simply went quiet after handing in its work.
    const deliveredGmids = new Set(
      store.listDeliverables(task.id)
        .filter((deliverable) => deliverable.status !== 'rejected')
        .map((deliverable) => (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase())
        .filter((authorGmid) => authorGmid.length > 0),
    );
    // Task #51 obligation gate: an 'unreachable' stamp is only meaningful for
    // a member with something OUTSTANDING. Three obligation sources:
    //   1. a pending [WORKING] ACK watch (fresh assignment, not yet answered);
    //   2. an armed ETA delivery deadline;
    //   3. a [WORKING] claim on record (the member publicly took work — going
    //      silent afterwards with a dead session is flag-worthy; this is also
    //      what keeps this monitor consistent with monitorLocalWorkerTimeout,
    //      whose own stamp condition implies a [WORKING] claim).
    // A member with none of these (never assigned anything open, or already
    // delivered and idle) is legitimately silent — never stamp it, and lift
    // a stale stamp immediately instead of waiting for fresh liveness (older
    // builds stamped exactly these members; cf. Lucy in task #51).
    const workingMap = store.getMembersWorkingAt(
      task.groupId,
      workers.map((member) => member.globalmetaid),
    );
    for (const member of workers) {
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      const hasObligation = (member.metabotId != null && (
        deps.getStore().get<string>(`${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`) != null
        || deps.getStore().get<string>(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`) != null
      )) || (gmid ? workingMap.get(gmid) != null : false);
      if ((gmid && deliveredGmids.has(gmid)) || !hasObligation) {
        if (member.status === 'unreachable' && member.metabotId != null) {
          try {
            store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: member ${member.name ?? member.metabotId} recovered ` +
              'unreachable -> working (no outstanding obligation — the stamp was bogus)',
            );
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: failed to lift bogus unreachable stamp for ${member.metabotId}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        continue;
      }
      // fix-v2 (B2): a member whose latest chair assignment waits on an
      // undelivered upstream ([DEPENDS_ON] tag or prose declaration) is
      // WAITING, not unreachable — the same exemption the stale-[WORKING]
      // monitor applies (tasks #54/#55 stamped correctly waiting members).
      // Release-review P1: a prose declaration is honored for a bounded
      // window only — once it expires, monitoring resumes and a silently
      // dead member gets stamped again.
      if (member.metabotId != null) {
        const chairMember = members.find((m) => m.role === 'chair');
        const depWait = checkMemberDependencyWait(task, member, chairMember);
        if (depWait && depWait.pendingTokens.length > 0 && !depWait.proseDeclared) continue;
        if (depWait?.proseDeclared) {
          if (applyProseDependencyExemption(task, member, depWait.pendingTokens, depWait.assignmentMsgId)) continue;
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: prose dependency-wait exemption expired for member ` +
            `${member.name ?? member.metabotId} (${Math.round(PROSE_DEPENDENCY_EXEMPTION_MAX_MS / 60_000)} min ` +
            'with the same chair assignment) — unreachable monitoring resumes',
          );
        }
      }
      const speakSec = gmid ? speakMap.get(gmid) ?? null : null;
      const lastMs = speakSec != null
        ? speakSec * 1000
        : parseSqliteUtcMs(member.createdAt);
      if (lastMs == null) continue;
      const liveness = classifyMemberLiveness({
        lastSpeakMs: lastMs,
        lastSessionActivityMs: member.metabotId != null
          ? getLocalMemberSessionInfo(task.id, member.metabotId)?.lastActivityMs ?? null
          : null,
        heartbeatUntilMs: member.metabotId != null
          ? getMemberHeartbeatUntil(task.id, member.metabotId)
          : null,
        nowMs: now(),
        thresholdMs,
      });
      if (liveness === 'alive') {
        if (member.status !== 'unreachable') continue;
        try {
          store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: member ${member.name ?? member.metabotId} recovered ` +
            'unreachable -> working (fresh speech/session activity/heartbeat)',
          );
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: failed to recover member ${member.metabotId} from unreachable: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      if (member.status === 'unreachable') continue; // already stamped; wait for liveness
      try {
        store.setMemberStatus(task.id, member.metabotId, 'unreachable', member.globalmetaid);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: member ${member.name ?? member.metabotId} marked ` +
          `unreachable (no speech for ${memberUnreachableAfterMinutes}+ min) — chair should re-assign or check`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: failed to mark member ${member.metabotId} unreachable: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * release-review P2: both dep-wait monitors (unreachable watch + delivery
   * deadline escalation) re-run every tick and used to rewrite the exemption
   * note unconditionally — one kv write per ~5s per waiting member (a full
   * export+rewrite flush on the sql.js fallback backend). Write only when the
   * note is first armed or the pending-token set changed; `checkedAt` alone
   * never justifies a rewrite. Returns whether the note changed, so callers
   * can gate their per-tick log line on it too.
   */
  const writeDepWaitExemptionNote = (
    taskId: number,
    metabotId: number,
    pendingTokens: string[],
  ): boolean => {
    const sqlite = deps.getStore();
    const key = `${GROUP_TASK_DEP_WAIT_EXEMPT_PREFIX}${taskId}:${metabotId}`;
    let changed = true;
    const priorRaw = sqlite.get<string>(key);
    if (priorRaw != null) {
      try {
        const prior = JSON.parse(priorRaw) as { upstreamTokens?: string[] };
        changed = JSON.stringify(prior.upstreamTokens ?? []) !== JSON.stringify(pendingTokens);
      } catch {
        changed = true;
      }
    }
    if (changed) {
      sqlite.set(key, JSON.stringify({
        upstreamTokens: pendingTokens,
        upstreamDelivered: false,
        checkedAt: now(),
      }));
    }
    return changed;
  };

  /**
   * release-review P2: memoize the "latest chair @mention assignment" scan
   * per (task, member) against the chair's newest message id — the widened
   * scan window (up to 2000 chair messages) must not re-scan every tick.
   * Only the assignment MESSAGE is memoized; tokens/pendingTokens recompute
   * per call so an upstream delivery still lifts the wait immediately.
   */
  const depWaitAssignmentMemo = new Map<string, { maxChairMsgId: number; assignment: GroupTaskDaemonMessage | null }>();
  /**
   * fix/group-task-dep-wait: the [DEPENDS_ON] state of the member's LATEST
   * chair assignment (chair-sent, @mentioning the member, skipping host
   * notices / roll calls — the same gates the ACK-watch arming path applies).
   * Returns null when no assignment can be located or checked; otherwise the
   * assignment's upstream tokens and the subset still undelivered. A member
   * with a pending upstream is legitimately WAITING (the P2-6 dispatch gate
   * holds it the same way), so its silence must not read as a stuck signal.
   */
  const checkMemberDependencyWait = (
    task: GroupTask,
    member: GroupTaskMember,
    chairMember: GroupTaskMember | undefined,
  ): { tokens: string[]; pendingTokens: string[]; proseDeclared: boolean; assignmentMsgId: number | null } | null => {
    const chairGmid = (chairMember?.globalmetaid ?? '').trim().toLowerCase();
    if (!task.groupId || !chairGmid || member.metabotId == null) return null;
    const bot = deps.getMetabotStore().getMetabotById(member.metabotId);
    if (!bot) return null;
    let assignment: GroupTaskDaemonMessage | null = null;
    try {
      // release-review P2: the latest chair @mention may sit far behind the
      // chair's 50 most recent messages in a long task (host notices, roll
      // calls, chatter to other members) — the exemption used to silently
      // evaporate once the assignment scrolled out, reviving false stuck
      // verdicts mid-task. Page backwards (keyset, newest first) with a
      // bounded budget; page 1 doubles as the memo freshness probe so the
      // steady state stays one page query per call.
      const db = deps.getStore().getDatabase();
      const PAGE_SIZE = 100;
      const MAX_PAGES = 20; // 2000 chair messages — beyond any real dispatch gap
      let beforeId = Number.MAX_SAFE_INTEGER;
      let newestChairMsgId = 0;
      const memoKey = `${task.id}:${member.metabotId}`;
      for (let page = 0; page < MAX_PAGES && !assignment; page += 1) {
        const rows = mapMessageRows(db.exec(
          `SELECT id, pin_id, tx_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
                  chain_timestamp, reply_pin, sender_suspect
           FROM group_chat_messages
           WHERE group_id = ? AND sender_global_metaid = ? AND id < ?
           ORDER BY id DESC LIMIT ${PAGE_SIZE}`,
          [task.groupId, chairGmid, beforeId],
        ));
        if (rows.length === 0) break;
        if (page === 0) {
          newestChairMsgId = toDaemonMessage(rows[0]).id;
          const memo = depWaitAssignmentMemo.get(memoKey);
          if (memo && memo.maxChairMsgId === newestChairMsgId) {
            assignment = memo.assignment; // may be null — nothing changed since the last scan
            break;
          }
        }
        for (const row of rows) {
          const message = toDaemonMessage(row);
          if (hasGroupTaskNotice(message.content) || isRollCallPresenceCheck(message.content)) continue;
          if (isMentioned(message, bot)) {
            assignment = message;
            break;
          }
        }
        beforeId = toDaemonMessage(rows[rows.length - 1]).id;
      }
      depWaitAssignmentMemo.set(memoKey, { maxChairMsgId: newestChairMsgId, assignment });
    } catch {
      return null;
    }
    if (!assignment) return null;
    // fix-v2 P0-1: dependency signals are scoped to the member's OWN dispatch
    // clause. A multi-member message (task #62's #3546: "[DEPENDS_ON: eleven
    // 媒体包…]" governing Builder's S3 clause + "@AI_小新 …等 Builder 的
    // metaapp:// 落地后我立即派单" governing AI_小新's S4 clause) otherwise
    // let the foreign tag mask the member's prose wait — the tag's free-text
    // token read as satisfied, the prose branch below was skipped because
    // tokens.length > 0, and the prose-waiting member ended up with zero
    // pending tokens (its conditional ETA then armed a deadline that alerted
    // two minutes later). Whole-message fallback covers mention-array-only
    // dispatches.
    const clause = extractMemberDispatchClause(assignment.content, bot.name) ?? assignment.content;
    const tokens = extractDependsOnTokens(clause);
    const pendingStructured = tokens.filter((token) => !dependencyTokenSatisfied(task, token));
    // fix-v2 (B2): chairs routinely declare dependencies in prose instead of
    // the structured [DEPENDS_ON: <pinid>] tag. A prose declaration counts as
    // a pending upstream too — without this, the stale-[WORKING] monitor saw
    // zero tokens, annotated "no upstream dependency" (wrong 3/3 times in
    // tasks #54/#55) and let the verdict fall on a correctly waiting member.
    // Release-review P1: prose cannot be ledger-verified, so the exemption it
    // grants is time-capped per assignment message (the monitors gate it
    // through applyProseDependencyExemption).
    // fix-v2 P0-1: the prose fallback runs whenever no STRUCTURED token from
    // the member's own clause is still pending — never masked by a foreign
    // clause's tag (see above).
    if (pendingStructured.length === 0 && hasProseDependencyDeclaration(clause)) {
      return {
        tokens,
        pendingTokens: ['(prose-declared upstream)'],
        proseDeclared: true,
        assignmentMsgId: assignment.id,
      };
    }
    return {
      tokens,
      pendingTokens: pendingStructured,
      proseDeclared: false,
      assignmentMsgId: assignment.id,
    };
  };

  /**
   * Release-review P1 gate for the prose dependency-wait exemption. A prose
   * declaration carries no ledger-verifiable token, so the exemption is
   * granted per (task, member) for a bounded window only. The FIRST grant
   * stamps the exemption kv note with grantedAt + the assignment message id;
   * while the same assignment stays the member's latest, the exemption is
   * honored for at most PROSE_DEPENDENCY_EXEMPTION_MAX_MS. A new chair
   * assignment (different message id) re-arms the window. Once the window is
   * exhausted the note is stamped proseExemptionExpired and the monitors fall
   * through to the normal unreachable/stuck/deadline verdicts. The note
   * (upstreamDelivered:false) also keeps the GT-09 panel projecting 'waiting'
   * while the exemption is active.
   */
  const applyProseDependencyExemption = (
    task: GroupTask,
    member: GroupTaskMember,
    pendingTokens: string[],
    assignmentMsgId: number | null,
  ): boolean => {
    const key = `${GROUP_TASK_DEP_WAIT_EXEMPT_PREFIX}${task.id}:${member.metabotId}`;
    const sqlite = deps.getStore();
    const nowMs = now();
    let grantedAt = nowMs;
    const raw = sqlite.get<string>(key);
    if (raw) {
      try {
        const note = JSON.parse(raw) as {
          grantedAt?: number;
          assignmentMsgId?: number | null;
          proseExemptionExpired?: boolean;
        };
        const sameAssignment = assignmentMsgId == null
          || note.assignmentMsgId == null
          || note.assignmentMsgId === assignmentMsgId;
        if (sameAssignment && note.proseExemptionExpired) return false;
        if (sameAssignment && typeof note.grantedAt === 'number' && Number.isFinite(note.grantedAt)) {
          grantedAt = note.grantedAt;
          if (nowMs - grantedAt > PROSE_DEPENDENCY_EXEMPTION_MAX_MS) {
            // Expired: stamp the note as exhausted (idempotent) instead of
            // deleting it — the other monitors in the same tick must observe
            // the same expired state, and a bare delete would read as "first
            // grant" to them and silently re-arm the window. GT-09 also reads
            // this flag to stop projecting 'waiting'.
            sqlite.set(key, JSON.stringify({
              upstreamTokens: pendingTokens,
              upstreamDelivered: false,
              checkedAt: nowMs,
              grantedAt,
              assignmentMsgId,
              proseExemptionExpired: true,
            }));
            return false;
          }
        }
      } catch {
        // Corrupt note — treat as a fresh grant.
      }
    }
    sqlite.set(key, JSON.stringify({
      upstreamTokens: pendingTokens,
      upstreamDelivered: false,
      checkedAt: nowMs,
      grantedAt,
      assignmentMsgId,
    }));
    return true;
  };

  /**
   * R6 L2: once a working/assigned LOCAL worker's [WORKING] signal goes stale
   * (older than the timeout window), inject a deterministic "re-assign" hint
   * into the chair's next turn and mark the authoritative state timeout. This
   * is the escalation ABOVE the existing L1 ACK/delivery reminders: those fire
   * once per assignment at 3 min; this fires once per (task, member) timeout
   * streak — the chair gets a concrete "re-assign to a standby member or mark
   * suspended" suggestion, not just another alert. Best-effort: never blocks
   * the tick; the store status change is the authoritative signal, the chair
   * hint is advisory. A member with a non-rejected deliverable on the ledger
   * is skipped entirely — delivered-then-idle is done, not stuck. A member
   * whose latest chair assignment is [DEPENDS_ON]-gated on an undelivered
   * upstream deliverable is skipped too — dependency-wait is waiting, not
   * stuck (fix/group-task-dep-wait).
   */
  const monitorLocalWorkerTimeout = async (
    task: GroupTask,
    members: GroupTaskMember[],
    ownerGlobalMetaId: string,
  ): Promise<string> => {
    if (task.status !== 'executing') return '';
    if (!task.groupId) return '';
    const store = deps.getGroupTaskStore();
    const sqlite = deps.getStore();
    const workers = members.filter(
      (member) => member.role === 'worker'
        && member.metabotId != null
        && (member.status === 'working' || member.status === 'assigned'),
    );
    if (workers.length === 0) return '';
    const workingMap = store.getMembersWorkingAt(
      task.groupId,
      workers.map((member) => member.globalmetaid),
    );
    // fix/group-member-status: fresh group speech also feeds the stamp guard
    // below — a member talking in the group must not wear 'unreachable' just
    // because its [WORKING] tag (not its voice) went stale.
    const speakMap = store.getMembersLastSpeakAt(
      task.groupId,
      workers.map((member) => member.globalmetaid),
    );
    // Review fix (delivered-then-idle): a worker with a non-rejected
    // deliverable on the ledger who then went quiet is DONE waiting, not
    // stuck — flagging it unreachable, stopping its session, and handing the
    // chair a re-dispatch directive duplicates finished work. Mirrors the
    // deliveredLate guard in monitorDeliveryDeadlines; delivery does not
    // move the member store status, so the ledger is the source of truth.
    // fix-v2 P1-3: the same ledger list also feeds the stuck-alert evidence
    // block below (fetched once per tick, not once per member).
    const taskDeliverables = store.listDeliverables(task.id);
    const deliveredGmids = new Set(
      taskDeliverables
        .filter((deliverable) => deliverable.status !== 'rejected')
        .map((deliverable) => (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase())
        .filter((authorGmid) => authorGmid.length > 0),
    );
    const standbyNames = members
      .filter((member) => member.role === 'worker' && member.status === 'standby')
      .map((member) => member.name ?? `bot-${member.metabotId}`);
    const chairMember = members.find((member) => member.role === 'chair');

    const timedOut: string[] = [];
    const reclaimNotes: string[] = [];
    for (const member of workers) {
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      if (gmid && deliveredGmids.has(gmid)) continue;
      const lastWorkingSec = gmid ? workingMap.get(gmid) ?? null : null;
      if (lastWorkingSec == null) continue;
      const staleMs = now() - lastWorkingSec * 1000;
      if (staleMs <= memberTimeoutAfterMinutes * 60_000) continue;

      const name = member.name ?? `bot-${member.metabotId}`;

      // P2-1/P2-2: a valid [WORKING long-task] heartbeat lease or fresh
      // cowork-session activity means the worker is mid long-task, not stuck
      // — never flag it unreachable and never reclaim its session.
      const lastSessionActivityMs = getLocalMemberSessionInfo(task.id, member.metabotId!)?.lastActivityMs ?? null;
      const heartbeatUntilMs = getMemberHeartbeatUntil(task.id, member.metabotId!);
      const liveness = classifyMemberLiveness({
        lastSpeakMs: null, // this monitor's baseline is the [WORKING] signal
        lastSessionActivityMs,
        heartbeatUntilMs,
        nowMs: now(),
        thresholdMs: memberTimeoutAfterMinutes * 60_000,
      });
      if (liveness === 'alive') continue;

      // fix/group-task-dep-wait: a member whose latest chair assignment is
      // [DEPENDS_ON]-gated on an undelivered upstream deliverable is correctly
      // WAITING (the P2-6 dispatch gate holds it the same way) — silence is
      // expected, not a stuck signal. Exempt it from the unreachable / hint /
      // reclaim verdict and leave an auditable kv note; the live check re-runs
      // every tick, so the exemption lifts on its own once the upstream lands.
      const depWait = checkMemberDependencyWait(task, member, chairMember);
      if (depWait && depWait.pendingTokens.length > 0) {
        // Release-review P1: prose declarations are gated by the time-capped
        // exemption helper (it stamps the kv note itself); structured tokens
        // keep the inline note and self-lift via the ledger. Release-review
        // P2: the structured note is written through the dedupe helper —
        // re-written (and re-logged) only when the pending-token set changes.
        if (depWait.proseDeclared) {
          if (applyProseDependencyExemption(task, member, depWait.pendingTokens, depWait.assignmentMsgId)) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: dependency-wait exemption: member ${name} ` +
              `waiting on upstream ${depWait.pendingTokens.join(', ')} (prose-declared, time-capped)`,
            );
            continue;
          }
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: prose dependency-wait exemption expired for member ${name} ` +
            `(${Math.round(PROSE_DEPENDENCY_EXEMPTION_MAX_MS / 60_000)} min with the same chair assignment) — ` +
            'stuck monitoring resumes',
          );
        } else {
          if (writeDepWaitExemptionNote(task.id, member.metabotId, depWait.pendingTokens)) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: dependency-wait exemption: member ${name} ` +
              `waiting on upstream ${depWait.pendingTokens.join(', ')} (not delivered)`,
            );
          }
          continue;
        }
      }
      // Not waiting (no [DEPENDS_ON] tag, or the upstream has delivered since):
      // clear a stale exemption note so the audit trail reflects the lift.
      // Prose notes are managed exclusively by applyProseDependencyExemption
      // (they carry the grantedAt/expiry state — never delete them here).
      if (depWait && !depWait.proseDeclared) {
        sqlite.delete(`${GROUP_TASK_DEP_WAIT_EXEMPT_PREFIX}${task.id}:${member.metabotId}`);
      }
      // GT-09 honesty: only pinid/txid tokens are ledger-verified — free-text
      // tokens are advisory (always "satisfied") and must never read as
      // "delivered" in the chair-facing annotation.
      // fix-v2 P1-3: when the exemption that just expired was PROSE-declared,
      // say so — never mislabel it "no upstream dependency declared" (task
      // #57: the false stuck alerts tagged prose-waiting members with exactly
      // that, contradicting the dispatch the chair could see).
      const depContext = depWait == null
        ? null
        : depWait.proseDeclared
          ? 'prose-declared upstream wait in the latest dispatch (time-capped exemption expired)'
          : depWait.tokens.length === 0
            ? 'no upstream dependency declared in the dispatch'
            : (() => {
                const verified = depWait.tokens.filter((token) => PINID_FORMAT.test(token) || TXID_FORMAT.test(token));
                const advisoryCount = depWait.tokens.length - verified.length;
                const parts: string[] = [];
                if (verified.length > 0) parts.push(`upstream ${verified.join(', ')} delivered`);
                if (advisoryCount > 0) {
                  parts.push(`${advisoryCount} advisory free-text upstream token(s) not ledger-verifiable`);
                }
                return parts.join('; ');
              })();

      // L2: mark the authoritative state timeout + inject a chair re-assign hint
      // once per (task, member) streak. Anti-flap (fix/group-member-status,
      // review follow-up): write 'unreachable' only in states where
      // monitorMemberUnreachable would not immediately recover the member —
      // i.e. its EXACT recovery predicate (group speech / cowork-session
      // activity / heartbeat lease within the UNREACHABLE window) must also
      // report stale. Judging freshness with the smaller
      // memberTimeoutAfterMinutes window made a member whose speech or session
      // activity sat in the 20–30 min gap flap unreachable→working→unreachable
      // on successive ticks for as long as the gap lasted.
      const speakSec = gmid ? speakMap.get(gmid) ?? null : null;
      const recoveryLiveness = classifyMemberLiveness({
        lastSpeakMs: speakSec != null ? speakSec * 1000 : parseSqliteUtcMs(member.createdAt),
        lastSessionActivityMs,
        heartbeatUntilMs,
        nowMs: now(),
        thresholdMs: memberUnreachableAfterMinutes * 60_000,
      });
      if (recoveryLiveness !== 'alive') {
        try {
          store.setMemberStatus(task.id, member.metabotId, 'unreachable', member.globalmetaid);
        } catch (error) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: timeout status write for ${name} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const hintKey = `${GROUP_TASK_TIMEOUT_HINT_PREFIX}${task.id}:${member.metabotId}`;
      if (sqlite.get<string>(hintKey) !== '1') {
        timedOut.push(depContext ? `${name} (${depContext})` : name);
        sqlite.set(hintKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${name} [WORKING] signal stale (${memberTimeoutAfterMinutes}+ min); ` +
          'injecting chair re-assign hint',
        );
        // fix/group-task-duration (task #59, the 9-hour stall): nudging the
        // CHAIR alone never wakes the stuck worker — the chair's status
        // broadcasts do not @-mention it, so nothing ever re-triggers the
        // member's session. Re-drive the member directly: requeue its most
        // recent chair @-mention as a deferred trigger and inject a host wake
        // notice so the turn knows why it was woken. The notice is ONLY
        // injected when a trigger exists — writing into a session we cannot
        // re-drive would (via the async memory pipeline) refresh the session's
        // activity timestamp and falsely "recover" the member.
        try {
          const bot = deps.getMetabotStore().getMetabotById(member.metabotId!);
          if (bot && task.groupId) {
            const recentRows = store.listGroupChatMessages(task.groupId, { limit: 30 });
            const chairGmid = (chairMember?.globalmetaid ?? '').trim().toLowerCase();
            let wakeMessageId: number | null = null;
            for (const row of recentRows.reverse()) {
              const rowGmid = (row.senderGlobalMetaId ?? '').trim().toLowerCase();
              if (!chairGmid || rowGmid !== chairGmid) continue;
              if (isMentioned({ content: row.content ?? '', mention: (row as { mention?: string | null }).mention ?? null }, bot)) {
                wakeMessageId = row.id;
                break;
              }
            }
            if (wakeMessageId != null) {
              const coworkStore = deps.getCoworkStore();
              const session = ensureTaskSession(coworkStore, task, member.metabotId!, bot.name ?? name);
              // The wake notice is HOST activity — pin updated_at back so the
              // liveness classifier never reads it as the member being alive.
              const activityBeforeWake = getLocalMemberSessionInfo(task.id, member.metabotId!)?.lastActivityMs ?? 0;
              coworkStore.addMessage(session.id, {
                type: 'user',
                content: [
                  '[SYSTEM stale-working wake — generated by the host, not a group participant]',
                  `Your [WORKING] signal went stale ${Math.round(staleMs / 60_000)} min ago with zero session activity while the task waited on you.`,
                  'Check whether your last assignment was fully delivered — especially the final on-chain post; a send that failed or was queued does not count as delivered. If the last step failed, redo just that step and deliver. If the work is genuinely complete, say so in the group.',
                ].join('\n'),
              });
              coworkStore.setSessionUpdatedAt(session.id, activityBeforeWake);
              deferReply({
                taskId: task.id,
                metabotId: member.metabotId!,
                messageId: wakeMessageId,
                reason: 'worker_mentioned',
                verificationNotes: [],
              });
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: stale-working wake for ${name} — re-driving ` +
                `its latest chair mention (message #${wakeMessageId})`,
              );
            } else {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: stale-working wake skipped for ${name} ` +
                '(no recent chair mention to re-drive; the chair hint remains the recovery path)',
              );
            }
          }
        } catch (wakeError) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: stale-working wake for ${name} failed: ` +
            `${wakeError instanceof Error ? wakeError.message : String(wakeError)}`,
          );
        }
      }

      // P1-2/P1-3 + fix-v2 (B2): the member reads inert (no speech, no
      // session activity, no heartbeat). The DEFAULT reclaim mode is
      // ALERT-ONLY — a stuck verdict raises one alert for the chair to
      // verify and act on, but never stops the member's session: the
      // automatic reclaim kept killing sessions of correctly waiting members
      // (tasks #54/#55, 3 false reclaims). kv `groupTaskStuckReclaim` =
      // {"mode":"auto"} restores the reclaim behavior.
      // fix-v2 P1-3: the verdict text must carry its own verifiable pointers
      // (ledger deliverable / speech / session-write / [WORKING] timestamps)
      // so the chair confirms instead of rebutting.
      const latestMemberDeliverable = gmid
        ? taskDeliverables
            .filter((deliverable) => (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase() === gmid)
            .sort((a, b) => (parseSqliteUtcMs(b.createdAt) ?? 0) - (parseSqliteUtcMs(a.createdAt) ?? 0))[0] ?? null
        : null;
      const stuckEvidence = buildStuckEvidence(latestMemberDeliverable, {
        lastWorkingMs: lastWorkingSec * 1000,
        lastSpeakMs: speakSec != null ? speakSec * 1000 : null,
        lastSessionActivityMs,
      });
      const stuckReason =
        `[WORKING] signal stale ${memberTimeoutAfterMinutes}+ min with zero cowork-session activity` +
        (depContext ? `; ${depContext}` : '') +
        `; evidence: ${stuckEvidence}`;
      if (parseGroupTaskStuckReclaimMode(sqlite.get<string>('groupTaskStuckReclaim')) === 'auto') {
        const reclaimNote = reclaimStuckWorkerSession(task, member, stuckReason);
        if (reclaimNote) reclaimNotes.push(reclaimNote);
      } else {
        const alertNote = alertStuckWorkerSession(task, member, stuckReason);
        if (alertNote) reclaimNotes.push(alertNote);
      }

      // L3: if the member is STILL silent past the escalation window (L2 + lag),
      // brief the owner ONCE per streak via the private report channel — local
      // workers previously had no owner touchpoint (only remote teammates did).
      if (staleMs <= (memberTimeoutAfterMinutes + memberEscalateAfterMinutes) * 60_000) continue;
      const ownerKey = `${GROUP_TASK_TIMEOUT_OWNER_PREFIX}${task.id}:${member.metabotId}`;
      if (sqlite.get<string>(ownerKey) === '1') continue;
      if (!ownerGlobalMetaId || chairMember?.metabotId == null || !deps.sendOwnerPrivateReport) continue;
      try {
        await deps.sendOwnerPrivateReport({
          taskId: task.id,
          metabotId: chairMember.metabotId,
          ownerGlobalMetaId,
          text:
            `[GroupTask] Task "${task.title}": local member "${name}" has been silent for ` +
            `${Math.round(staleMs / 60_000)}+ min (past the [WORKING] window). The chair will get a ` +
            're-assign hint on its next turn; you can also decide now whether to wait, reassign, or close the task.',
        });
        sqlite.set(ownerKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: owner briefed about silent local member ${name} (L3)`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: L3 owner brief failed for ${name}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (timedOut.length === 0 && reclaimNotes.length === 0) return '';
    const reAssign = standbyNames.length > 0
      ? `Re-assign to a standby member (${standbyNames.join(', ')}) or mark the step suspended.`
      : 'Mark the step suspended and tell the owner it is blocked on an unresponsive member.';
    return [
      '[SYSTEM member-timeout hint — generated by the host, not a group participant]',
      timedOut.length > 0
        ? `These members have gone silent past the ${memberTimeoutAfterMinutes}-min [WORKING] window: ${timedOut.join(', ')}.`
        : 'A stuck member session was reclaimed by the host (see below).',
      ...reclaimNotes,
      `${reAssign} Do NOT auto-fail them.`,
    ].join('\n');
  };

  /**
   * P0-3: per-message protocol markers:
   * - chair message that @mentions a worker = an ASSIGNMENT → record a pending
   *   [WORKING] ACK expectation for that worker (kv, timestamped).
   * - worker [WORKING] ACK → status working, clears the pending ACK, records
   *   the estimated delivery deadline for P0-4.
   * - worker [STANDBY] → status standby.
   * - any other worker speech clears the pending ACK (implicit ACK) and marks
   *   the member working (silence is never assumed).
   */
  /**
   * Task #41 residue: true when pinId resolves to a stored group message that
   * is a host protocol notice or a roll-call presence check. Empty or
   * unresolvable pins return false, leaving the default arming semantics
   * (P2-2: any ETA-bearing [WORKING] arms its own deadline) unchanged.
   */
  const isNoticeOrRollCallPin = (pinId: string | null | undefined): boolean => {
    const pin = (pinId ?? '').trim();
    if (!pin) return false;
    try {
      const result = deps.getStore().getDatabase().exec(
        'SELECT content FROM group_chat_messages WHERE pin_id = ? LIMIT 1',
        [pin],
      );
      const content = String(result[0]?.values?.[0]?.[0] ?? '');
      return hasGroupTaskNotice(content) || isRollCallPresenceCheck(content);
    } catch {
      return false;
    }
  };

  /**
   * Task #60: resolve the chair assignment message a worker ACK refers to —
   * the pending-ACK watch records the assignment's message id; failing that,
   * the ACK's replyPin threads under its trigger message. Used to read a
   * chair-stated step deadline when the ACK itself carries no ETA. Empty when
   * unresolvable; the caller then falls back to DEFAULT_STEP_DEADLINE_MS.
   */
  const resolveAssignmentContent = (
    task: GroupTask,
    assignmentMessageId: number | null,
    replyPin: string | null | undefined,
  ): string => {
    try {
      const db = deps.getStore().getDatabase();
      if (assignmentMessageId != null && task.groupId) {
        const row = queryMessageById(db, task.groupId, assignmentMessageId);
        const content = (row?.content ?? '').trim();
        if (content) return content;
      }
      const pin = (replyPin ?? '').trim();
      if (pin) {
        const result = db.exec(
          'SELECT content FROM group_chat_messages WHERE pin_id = ? LIMIT 1',
          [pin],
        );
        return String(result[0]?.values?.[0]?.[0] ?? '');
      }
    } catch {
      // resolution is best-effort; the caller falls back to the default
    }
    return '';
  };

  /**
   * Speedup R-02: does this ACK's replyPin thread under a REAL chair
   * assignment to this member? Used to tell a genuine dispatch response
   * (deadline-worthy) apart from an unprompted/host-posted [WORKING] line
   * (liveness only). Notice/roll-call targets never qualify.
   */
  const replyPinIsChairAssignment = (
    member: GroupTaskMember,
    bot: GroupTaskDaemonBotFull,
    replyPin: string | null | undefined,
    chairGmid: string,
  ): boolean => {
    const pin = (replyPin ?? '').trim();
    if (!pin || !chairGmid) return false;
    try {
      const result = deps.getStore().getDatabase().exec(
        'SELECT sender_global_metaid, content, mention FROM group_chat_messages WHERE pin_id = ? LIMIT 1',
        [pin],
      );
      const row = result[0]?.values?.[0];
      if (!row) return false;
      if (String(row[0] ?? '').trim().toLowerCase() !== chairGmid) return false;
      const content = String(row[1] ?? '');
      if (hasGroupTaskNotice(content) || isRollCallPresenceCheck(content.trim())) return false;
      const mention = row[2] == null ? null : String(row[2]);
      return isMentioned(
        { content, mention } as unknown as GroupTaskDaemonMessage,
        bot,
      );
    } catch {
      return false;
    }
  };

  const handleMemberProtocolMarkers = (
    task: GroupTask,
    message: GroupTaskDaemonMessage,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    opts?: { humanGateActive?: boolean },
  ): void => {
    const sqlite = deps.getStore();
    const store = deps.getGroupTaskStore();
    const senderGmid = (message.senderGlobalMetaId ?? '').trim().toLowerCase();
    if (!senderGmid || message.senderSuspect) return;

    const chairMember = members.find((member) => member.role === 'chair');
    const chairGmid = (chairMember?.globalmetaid ?? '').trim().toLowerCase();
    const isChairMessage = Boolean(chairGmid && senderGmid === chairGmid);
    if (isChairMessage) {
      for (const member of members) {
        if (member.role !== 'worker' || member.metabotId == null) continue;
        const bot = botsById.get(member.metabotId);
        if (!bot || !isMentioned(message, bot)) continue;
        // GT#47 R3: during review / an open checkpoint the mention is part of
        // a review-closing or checkpoint message, not a work assignment —
        // arming the 3-min no-ACK watch here is exactly what fired the false
        // "eleven did not ACK" alarm in task #47. The responder path posts the
        // dispatch-held notice that tells the chair why the mention went cold.
        if (opts?.humanGateActive) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: mention of ${member.name ?? member.metabotId} ` +
            `(message #${message.id}) during a human-gate phase — no ACK watch armed`,
          );
          continue;
        }
        // P5 (v1.1) false-positive modeling — being mentioned by the chair is
        // not always an assignment, and an unACKed "assignment" is not always
        // a missed one. Three legal states never arm the 3-min no-ACK watch:
        //   1. roll-call/kickoff notes (@name 请确认在线) — presence check,
        //      not work; arming here produced the false "Lucy / AI_小新 did
        //      not ACK" warnings in task #21;
        //   2. a member already standing by (observer/standby status);
        //   3. a [DEPENDS_ON]-gated assignment whose upstream is not
        //      delivered yet — the worker is legitimately waiting.
        const contentText = (message.content ?? '').trim();
        if (isRollCallPresenceCheck(contentText)) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: roll-call mention of ${member.name ?? member.metabotId} ` +
            `(message #${message.id}) — no ACK watch armed`,
          );
          continue;
        }
        if (member.status === 'standby') {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} is standing by ` +
            `(observer); mention in message #${message.id} arms no ACK watch`,
          );
          continue;
        }
        const pendingKey = `${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`;
        const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
        // P1-4: an assignment message this worker already ACKed must never
        // re-arm the watch — a cursor retry / duplicate processing of the
        // same message would otherwise re-start the 3-min no-ACK watch on an
        // already-engaged worker and misreport it to the chair.
        if (sqlite.get<string>(`${ACK_SEEN_PREFIX}${task.id}:${message.id}`) === '1') {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: assignment to ${member.name ?? member.metabotId} ` +
            `(message #${message.id}) already ACKed (ack-seen); no new ACK watch`,
          );
          continue;
        }
        if (sqlite.get<string>(pendingKey) == null && sqlite.get<string>(remindedKey) !== '1') {
          // P1-4: a DERIVED assignment (chair tags [DEPENDS_ON]) inherits the
          // upstream ACK: the worker already engaged on the chain the derived
          // step continues, so a fresh no-ACK watch would misreport a worker
          // who is demonstrably working. Inherit only when the referenced
          // upstream pinid resolves to a message this worker ACKed.
          const derived = resolveDerivedAssignmentUpstream(task, message, sqlite);
          if (derived !== null) {
            if (derived) {
              sqlite.set(`${ACK_SEEN_PREFIX}${task.id}:${message.id}`, '1');
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: derived assignment to ${member.name ?? member.metabotId} ` +
                `(message #${message.id}, DEPENDS_ON upstream ${derived}) inherits the upstream ACK; no new ACK watch`,
              );
            } else {
              // P5 (v1.1): dependency-waiting is a legal state — the worker
              // cannot start (and need not ACK) until the upstream deliverable
              // lands, so arming the 3-min no-ACK watch here would misreport
              // the #21-style false "did not ACK" warnings.
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: derived assignment to ${member.name ?? member.metabotId} ` +
                `(message #${message.id}) upstream not delivered; dependency-wait, no ACK watch`,
              );
            }
            continue;
          }
          // Task #51 false-alarm fix: persist the assignment's CHAIN second
          // alongside the daemon-local arming time. The implicit-ACK check in
          // monitorAcksAndReminders judges "spoke after the assignment" by
          // chain order (message id / chain second), never by `assignedAt` —
          // a tick blocked by a slow turn used to arm watches whose
          // `assignedAt` postdated the worker's actual reply and then
          // false-alarm a member who had demonstrably engaged.
          sqlite.set(
            pendingKey,
            JSON.stringify({
              assignedAt: now(),
              messageId: message.id,
              assignedChainSec: message.chainTimestamp ?? null,
            }),
          );
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: assignment to ${member.name ?? member.metabotId} (message #${message.id}); waiting for [WORKING] ACK`,
          );
        }
      }
      return;
    }

    const member = members.find(
      (candidate) => (candidate.globalmetaid ?? '').trim().toLowerCase() === senderGmid,
    );
    if (!member || member.role !== 'worker' || member.metabotId == null) return;

    const pendingKey = `${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`;
    const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
    // P1-4: clearing a pending watch records ack-seen for the assignment
    // message, so derived [DEPENDS_ON] assignments and re-processed messages
    // inherit the ACK instead of re-arming the no-ACK watch.
    const clearPendingAck = (): void => {
      const raw = sqlite.get<string>(pendingKey);
      if (raw != null) {
        try {
          const entry = JSON.parse(raw) as { assignedAt?: number; messageId?: number };
          if (entry && typeof entry.messageId === 'number') {
            sqlite.set(`${ACK_SEEN_PREFIX}${task.id}:${entry.messageId}`, '1');
          }
        } catch {
          // unparsable pending entry: drop it without ack-seen
        }
      }
      sqlite.delete(pendingKey);
      if (sqlite.get<string>(remindedKey) != null) sqlite.delete(remindedKey);
    };
    // Speedup hardening: tokens quoted inside code fences/backticks are
    // citations, not protocol input — parse the ACK from stripped content.
    const protocolContent = stripGroupTaskQuotedCode(message.content);
    const ack = parseWorkingAck(protocolContent);
    if (ack) {
      store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
      // Capture the pending assignment's message id BEFORE clearing it — a
      // numberless ACK arms its delivery deadline from the chair's stated
      // deadline (task #60), which lives in that assignment message.
      let assignmentMessageId: number | null = null;
      const pendingRawForDeadline = sqlite.get<string>(pendingKey);
      if (pendingRawForDeadline != null) {
        try {
          const pendingEntry = JSON.parse(pendingRawForDeadline) as { messageId?: number };
          if (pendingEntry && typeof pendingEntry.messageId === 'number') {
            assignmentMessageId = pendingEntry.messageId;
          }
        } catch {
          assignmentMessageId = null;
        }
      }
      clearPendingAck();
      // The member is alive again — clear the stuck-reclaim/stuck-alert streak
      // so a future stuck spell reclaims/alerts afresh.
      sqlite.delete(`${GROUP_TASK_STUCK_RECLAIM_PREFIX}${task.id}:${member.metabotId}`);
      sqlite.delete(`${GROUP_TASK_STUCK_ALERT_PREFIX}${task.id}:${member.metabotId}`);
      // P2-2: an ETA-bearing [WORKING] (ACK or long-task heartbeat) extends the
      // member's liveness lease — the watchdogs honor it before flagging
      // unreachable/timeout.
      if (ack.estimatedMinutes != null && ack.estimatedMinutes > 0) {
        sqlite.set(
          `${WORKING_HEARTBEAT_PREFIX}${task.id}:${member.metabotId}`,
          String(computeWorkingHeartbeatUntil(ack.estimatedMinutes, now())),
        );
      }
      // GT#47 R3: during review / an open checkpoint a [WORKING] is liveness
      // only, not a work commitment — arming a delivery deadline off a chair
      // message that must stay unanswered is what mis-armed task #47's
      // expected_delivery records deep into what should have been acceptance.
      // Task #41 residue: same for a [WORKING] threaded under a host notice or
      // roll call (replyPin → a [GROUP_TASK_NOTICE:*] / 请确认在线 message) —
      // it is a presence confirmation, not a delivery commitment. Host
      // auto-ACKs and organic worker replies both thread replyPin under their
      // trigger message, so the notice echo is recognizable by its target.
      const acksHostNotice = isNoticeOrRollCallPin(message.replyPin);
      // Speedup R-02: a delivery deadline may only be armed for a member with
      // a REAL, dependency-ready assignment on record — an unprompted or
      // host-posted [WORKING] line from a never-dispatched member is liveness
      // only (EP28: heartbeats armed a 30-min deadline for the undispatched
      // AI_小新, producing the false "no [DELIVERABLE] arrived" alert).
      // Qualifying evidence, strongest first: a pending ACK watch (the dispatch
      // armed one), an already-armed deadline (a progress re-ACK refreshes it),
      // or a replyPin threading under a genuine chair assignment to this
      // member (derived assignments never arm the watch). And when the
      // member's assignment is still upstream-blocked, the deadline stays
      // suspended — not armed, not ticking.
      const hasArmedDeadline =
        sqlite.get<string>(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`) != null;
      const memberBot = botsById.get(member.metabotId);
      const repliesToAssignment =
        assignmentMessageId == null && !hasArmedDeadline && memberBot
          ? replyPinIsChairAssignment(member, memberBot, message.replyPin, chairGmid)
          : false;
      const assignmentOnRecord = assignmentMessageId != null || hasArmedDeadline || repliesToAssignment;
      const awaitingUpstream = assignmentOnRecord
        ? Boolean(
            checkMemberDependencyWait(task, member, chairMember)?.pendingTokens.length,
          )
        : false;
      // fix-v2 P0-1: the member's own [WORKING] may declare a CONDITIONAL
      // upstream wait ("待 Builder 上链交付后接单，回填→发布预计 2 分钟"). The
      // chair-side dependency scan goes blind when the chair's latest mention
      // omits (or another member's clause carries) the dependency — task #62's
      // false alert fired exactly through that gap. The worker's own wait
      // declaration is authoritative liveness: extend the lease, arm nothing.
      const workerDeclaredWait = hasWorkerUpstreamWait(protocolContent);
      if (!opts?.humanGateActive && !acksHostNotice && assignmentOnRecord && !awaitingUpstream && !workerDeclaredWait) {
        // Single-track deadlines (single-commander): the ONLY deadline the
        // host clocks is the one the CHAIR stated in the assignment
        // ([DEADLINE: 30m]). The worker's own ETA number is information for
        // the chair's planning, not a second deadline source — the old
        // ETA-armed track is what produced the dual-clock escalations.
        // A numberless ACK against a deadline-less assignment arms nothing:
        // the chair playbook requires a deadline on every assignment, and a
        // missing one is the chair's sequencing gap, not the host's to invent.
        const chairDeadlineMinutes = parseChairDeadlineMinutes(
          resolveAssignmentContent(task, assignmentMessageId, message.replyPin),
        );
        if (chairDeadlineMinutes != null && chairDeadlineMinutes > 0) {
          // Arming a fresh deadline starts a fresh reminder cycle — a leftover
          // delivery-reminded flag from the previous (missed or delivered)
          // deadline would otherwise skip the next reminder and drop the member
          // straight onto the reclaim ladder after one grace window.
          sqlite.delete(`${DELIVERY_REMINDED_PREFIX}${task.id}:${member.metabotId}`);
          sqlite.set(
            `${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`,
            JSON.stringify({
              dueAt: now() + chairDeadlineMinutes * 60_000,
              ackedAt: now(),
              taskDescription: ack.taskDescription,
            }),
          );
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} ACKed [WORKING] — ` +
            `armed the chair-stated deadline: ${chairDeadlineMinutes}m`,
          );
        } else {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} ACKed [WORKING] — ` +
            'no chair-stated deadline on the assignment; nothing armed (the worker ETA is the chair\'s information, not a clock)',
          );
        }
      } else {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} ACKed [WORKING] ` +
          (opts?.humanGateActive
            ? 'during a human-gate phase'
            : acksHostNotice
              ? 'in reply to a host notice/roll call'
              : awaitingUpstream
                ? 'while its assignment is still upstream-blocked'
                : workerDeclaredWait
                  ? 'declaring a conditional upstream wait (ETA suspended until the upstream lands)'
                  : 'with no assignment on record') +
          ' — liveness only, no delivery deadline armed',
        );
      }
      return;
    }
    if (hasStandbyMarker(protocolContent)) {
      store.setMemberStatus(task.id, member.metabotId, 'standby', member.globalmetaid);
      return;
    }
    // Implicit ACK: any worker speech counts as engaged. Speech also lifts a
    // stale 'unreachable' stamp (fix/group-member-status): a member talking in
    // the group is definitionally reachable, even if the watchdog stamped it
    // during a silence window.
    if (member.status === 'assigned' || member.status === 'unreachable') {
      store.setMemberStatus(task.id, member.metabotId, 'working', member.globalmetaid);
    }
    clearPendingAck();
  };

  /**
   * G-01: no-progress stall monitor — one anomaly notice to the origin session
   * when an executing/planning task shows zero observable progress (no group
   * message, no deliverable) for the window. The stamp resets when progress
   * resumes so each stall episode reports at most once; the paired milestone
   * guard lives in the SAME kv store the service reads (production wires both
   * to the app sqlite kv), so clearing it here re-arms the service-side
   * once-guard. GT-03 (task #56): planning coverage — a planning task whose
   * chair plan attempts are exhausted gets ONE re-armed attempt per stall
   * episode instead of the executing-task status nudge.
   */
  /**
   * Task #63: the no-progress nudge's prime-suspect scan. Finds the newest
   * chair message that cites a [STATUS:*] tag ONLY descriptively while that
   * tag is a legal move from the live status — i.e. the chair TRIED to signal
   * a transition and the parser never saw an instruction. The generic nudge
   * ("post a status update") makes such a chair answer "false alarm" (its own
   * memory says the verdict was announced — task #63 burned two supervisor
   * cycles on exactly that); naming the miss makes the nudge actionable in
   * one round. Tags already applied bucket as no-op, not descriptive, so an
   * applied verdict never re-triggers this.
   */
  const findUnappliedChairStatusCitation = (
    db: Database,
    task: GroupTask,
    liveStatus: string,
  ): { tag: 'executing' | 'review' } | null => {
    if (!task.groupId) return null;
    const legal = CHAIR_STATUS_MOVES[liveStatus] ?? [];
    if (legal.length === 0) return null;
    try {
      const members = deps.getGroupTaskStore().listMembers(task.id);
      const chairGmid = (members.find((member) => member.role === 'chair')?.globalmetaid ?? '')
        .trim().toLowerCase();
      if (!chairGmid) return null;
      const rows = queryRecentMessages(db, task.groupId, 50); // oldest-first
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const row = rows[i];
        if (row.sender_suspect) continue;
        if ((row.sender_global_metaid ?? '').trim().toLowerCase() !== chairGmid) continue;
        if (hasGroupTaskNotice(row.content ?? '')) continue;
        const verdict = adjudicateStatusDirectives(row.content ?? '', liveStatus);
        if (verdict.instruction != null) continue;
        const hit = verdict.descriptive.find((tag) => legal.includes(tag));
        if (hit) return { tag: hit };
      }
    } catch {
      // best-effort diagnosis — fall back to the generic nudge note
    }
    return null;
  };

  const monitorNoProgressStall = (task: GroupTask): void => {
    const sqlite = deps.getStore();
    const stampKey = `${NO_PROGRESS_STALL_STAMP_PREFIX}${task.id}`;
    let lastMessageMs: number | null = null;
    try {
      const result = sqlite.getDatabase().exec(
        'SELECT MAX(chain_timestamp) FROM group_chat_messages WHERE group_id = ?',
        [task.groupId],
      );
      const sec = Number(result[0]?.values?.[0]?.[0]);
      if (Number.isFinite(sec) && sec > 0) lastMessageMs = sec * 1000;
    } catch {
      return; // transient read failure — retry next tick
    }
    let lastDeliverableMs: number | null = null;
    try {
      for (const deliverable of deps.getGroupTaskStore().listDeliverables(task.id)) {
        const ms = parseSqliteUtcMs(deliverable.createdAt ?? null);
        if (ms != null && (lastDeliverableMs == null || ms > lastDeliverableMs)) lastDeliverableMs = ms;
      }
    } catch {
      // best-effort ledger read
    }
    const progressPoints = [lastMessageMs, lastDeliverableMs].filter((ms): ms is number => ms != null);
    if (progressPoints.length === 0) return; // nothing observable yet — never alarm
    const lastProgressMs = Math.max(...progressPoints);
    const idleMs = now() - lastProgressMs;
    const nudgeKey = `${NO_PROGRESS_NUDGE_STAMP_PREFIX}${task.id}`;
    if (idleMs < noProgressNudgeMs) {
      // Fresh progress — re-arm both episode guards.
      if (sqlite.get<string>(stampKey) != null) {
        sqlite.delete(stampKey);
        sqlite.delete(`group_task_milestone_notified:anomaly:${task.id}:stall`);
      }
      if (sqlite.get<string>(nudgeKey) != null) sqlite.delete(nudgeKey);
      return;
    }
    // Task #51: past the smaller window with literally NOTHING running (no
    // dispatched turn, none latched), the task is idle-stuck — nudge the
    // chair once per episode to post a status update instead of sitting
    // silent until the stall anomaly. The supervisor-signal channel drives
    // the chair turn on the next tick.
    if (sqlite.get<string>(nudgeKey) == null) {
      // GT-01: a watchdog-LATCHED turn is not a legitimate in-flight attempt —
      // it already failed from the daemon's perspective and only waits for the
      // session to idle. Excluding it lets the nudge fire during a provider
      // outage instead of waiting out the 45-min latch cap in silence.
      const anyTurnInFlight = [...turnInFlight.keys()].some(
        (key) => key.startsWith(`${task.id}:`) && !latchedTurnKeys.has(key),
      );
      // fix-v2 (B2): group silence is not idleness — a local member whose
      // cowork session worked within the window is making progress that has
      // not surfaced as a message yet (long renders, tool chains). Nudging
      // the chair there only forces a wasted status report (task #55: the
      // 20-min nudges landed on the chair itself mid-run).
      const anyLocalSessionActive = (() => {
        try {
          return deps.getGroupTaskStore().listMembers(task.id).some((member) => {
            if (member.metabotId == null) return false;
            const activityMs = getLocalMemberSessionInfo(task.id, member.metabotId)?.lastActivityMs ?? null;
            return activityMs != null && now() - activityMs <= noProgressNudgeMs;
          });
        } catch {
          return false;
        }
      })();
      if (!anyTurnInFlight && !anyLocalSessionActive) {
        // GT-03 (task #56): a PLANNING task needs its planning turn re-armed,
        // not a status-report nudge — the chair has nothing to report yet and
        // the supervisor directive forbids [STATUS:*] anyway. When the plan was
        // never posted and the bounded attempts are exhausted (the state #56
        // wedged into during the outage), release ONE more attempt per stall
        // episode: bounded self-heal that can never spin.
        if (task.status === 'planning') {
          const plannedKey = `${CHAIR_PLANNED_KV_PREFIX}${task.id}`;
          const attemptsKey = `${CHAIR_PLAN_ATTEMPTS_KV_PREFIX}${task.id}`;
          const attempts = Number(sqlite.get<number>(attemptsKey) ?? 0) || 0;
          if (sqlite.get<string>(plannedKey) !== '1' && attempts >= MAX_CHAIR_PLAN_ATTEMPTS) {
            sqlite.set(attemptsKey, MAX_CHAIR_PLAN_ATTEMPTS - 1);
            sqlite.set(nudgeKey, '1');
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: planning stalled for ${Math.round(idleMs / 60_000)} min ` +
              'with the chair plan attempts exhausted — re-armed one planning attempt (one per stall episode)',
            );
          }
          // Planning tasks never take the status-report nudge below; the stall
          // anomaly further down still applies to them (GT-03 visibility).
        } else {
          try {
            // Task #63: enrich the nudge with the prime-suspect diagnosis when
            // the chair's verdict tag never parsed as an instruction.
            const citation = findUnappliedChairStatusCitation(sqlite.getDatabase(), task, task.status);
            const idleText = `No progress for ${Math.round(idleMs / 60_000)} min and no turn is running`;
            const note = citation
              ? `${idleText}. Diagnosis: the host never applied your [STATUS:${citation.tag.toUpperCase()}] ` +
                `(an earlier chair message cited the tag as descriptive prose, not a bare instruction line) — ` +
                `the task is still "${task.status}" in the host DB. If you intend that transition, post ONE new ` +
                `message containing only the bare [STATUS:${citation.tag.toUpperCase()}] tag (own line, no bold, ` +
                'no backticks, no extra text); otherwise post a brief status update: what is done, what is blocked, what happens next.'
              : `${idleText} — post a brief status update to the group: what is done, what is blocked, what happens next.`;
            deps.getGroupTaskStore().addSupervisorSignal({
              taskId: task.id,
              kind: 'nudge',
              note,
            });
            sqlite.set(nudgeKey, '1');
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: no progress for ${Math.round(idleMs / 60_000)} min ` +
              'with no turn in flight — nudged the chair for a status update',
            );
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: no-progress nudge failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }
    if (idleMs < noProgressStallMs) return;
    if (sqlite.get<string>(stampKey) === '1') return; // already reported this episode
    sqlite.set(stampKey, '1');
    emitLog(
      `[GroupTaskDaemon] Task ${task.id}: no progress for ${Math.round(idleMs / 60_000)} min ` +
      '(no new group message, no new deliverable) — reporting stall anomaly to the origin session',
    );
    notifySourceSessionMilestone(
      task,
      'anomaly',
      buildSourceSessionAnomalyNotice({
        title: task.title,
        status: task.status,
        summary:
          `No progress for ${Math.round(idleMs / 60_000)} minutes (no new group messages, no new deliverables). ` +
          'Check the task detail view — the chair may be waiting on a stuck member or a silent failure.',
      }),
      'stall',
    );
  };

  /**
   * Task #52 self-heal: reconcile a stuck chair status directive. A verdict the
   * parser once rejected (e.g. `[STATUS:REVIEW] — explanation` under the G-03
   * absolute-trailing rule) left the task pinned in executing AFTER the message
   * cursor already advanced — fixing the parser alone cannot repair tasks that
   * already ate the directive. Once per daemon run per task, rescan the
   * cursor-passed transcript for the NEWEST chair message carrying a
   * message-end directive; when it differs from the live status (and the
   * transition is legal, and the message is NEWER than the last recorded
   * status event — a UI/RPC rework posts no group message, so an older REVIEW
   * must never flip a re-opened task back), re-run the tag-only processing on
   * it (the GT#26 drop-time pattern: same idempotency contract — deliverable
   * rows dedupe by msg pin + uri, the transition itself is legality-checked).
   * The review ceremony then runs from the normal path, exactly as if the
   * directive had parsed on arrival. Messages the cursor has NOT passed are
   * deliberately excluded — they still flow through the normal path.
   */
  const reconcileStatusDirective = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
    promptMembers: DaemonPromptMember[],
    ownerGlobalMetaId: string,
    memberGmids: Set<string>,
  ): Promise<void> => {
    if (!task.groupId) return;
    if (task.status === 'done' || task.status === 'cancelled') return;
    const db = deps.getStore().getDatabase();
    const chairMember = members.find((member) => member.role === 'chair');
    const chairGmid = (chairMember?.globalmetaid ?? '').trim().toLowerCase();
    if (!chairGmid) return;
    // GT-04: newest cursor-passed chair row whose ADJUDICATED instruction
    // differs from the live status (newest-first). Adjudication is what lets
    // task #56's shape self-heal — its real EXECUTING instruction sat on a
    // standalone body line while the descriptive end-line REVIEW was illegal.
    // Host notices are documentation, never protocol input: they legitimately
    // cite tag syntax (the status-parser note itself lists legal moves).
    const liveStatus = deps.getGroupTaskStore().getTaskById(task.id)?.status ?? task.status;
    // Task #63: pins the rework debounce deliberately swallowed must stay
    // swallowed — the reconciler (now re-armed per cursor advance) would
    // otherwise resurrect them and reintroduce the review<->executing flip.
    let debouncedReviewPins = new Set<string>();
    try {
      const raw = deps.getStore().get<string>(`${GROUP_TASK_DEBOUNCED_REVIEW_PINS_KV_PREFIX}${task.id}`);
      const parsed = JSON.parse(String(raw ?? '[]'));
      if (Array.isArray(parsed)) debouncedReviewPins = new Set(parsed.map((pin) => String(pin)));
    } catch {
      // unreadable marker — reconcile's freshness guard still applies
    }
    const candidate = queryRecentMessages(db, task.groupId, 50)
      .reverse()
      .find((row) => {
        if (row.id > task.lastProcessedMsgId) return false; // normal path owns it
        if (row.pin_id && debouncedReviewPins.has(row.pin_id)) return false;
        const senderGmid = (row.sender_global_metaid ?? '').trim().toLowerCase();
        if (senderGmid !== chairGmid || row.sender_suspect) return false;
        const content = row.content ?? '';
        if (hasGroupTaskNotice(content)) return false;
        return adjudicateStatusDirectives(content, liveStatus).instruction != null;
      });
    if (!candidate) return;
    const directive = adjudicateStatusDirectives(candidate.content ?? '', liveStatus).instruction;
    if (!directive) return;
    const freshStatus = deps.getGroupTaskStore().getTaskById(task.id)?.status ?? task.status;
    if (directive === freshStatus) return; // already applied (or a later state)
    // Legal chair-directive transitions only (mirrors LEGAL_TRANSITIONS minus
    // the owner-only terminal moves) — anything else keeps its normal-path
    // rejection semantics; reconciliation must not manufacture new audit noise.
    const legalChairMoves: Record<string, string[]> = {
      planning: ['executing'],
      executing: ['review'],
      review: ['executing'],
      done: [],
      cancelled: [],
    };
    if (!(legalChairMoves[freshStatus] ?? []).includes(directive)) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: status directive reconcile skipped — ` +
        `${freshStatus} -> ${directive} is not a legal chair move`,
      );
      return;
    }
    // Rework guard: a re-open (review->executing via Tasks UI / RPC rework)
    // posts no group message, so the newest tagged chair row can predate it.
    // Only a directive NEWER than the last recorded status event may
    // reconcile — group_task_status_events captures every real transition
    // regardless of the path that drove it (tag, UI rework, RPC, store call).
    try {
      const result = db.exec(
        'SELECT MAX(created_at) FROM group_task_status_events WHERE task_id = ?',
        [task.id],
      );
      const rawEventAt = result[0]?.values?.[0]?.[0];
      const lastEventMs = rawEventAt == null ? null : parseSqliteUtcMs(String(rawEventAt));
      const candidateMs = Number(candidate.chain_timestamp) > 0
        ? Number(candidate.chain_timestamp) * 1000
        : null;
      if (lastEventMs != null && candidateMs != null && candidateMs <= lastEventMs) {
        return;
      }
    } catch {
      // status-events table unreadable — the normal path still guards legality
    }
    emitLog(
      `[GroupTaskDaemon] Task ${task.id}: reconciling stuck status directive ` +
      `[STATUS:${directive.toUpperCase()}] from chair message ${candidate.id} ` +
      `(${freshStatus} -> ${directive})`,
    );
    const rawMessage = toDaemonMessage(candidate);
    const tagMessage = await enrichMessageAttribution(rawMessage, memberGmids, ownerGlobalMetaId)
      .catch(() => rawMessage);
    await processMessageTags(task, tagMessage, members, botsById, promptMembers);
    handleMemberProtocolMarkers(task, tagMessage, members, botsById);
  };

  /**
   * P0-3: chair reminder when an assignment got no [WORKING] ACK within
   * ackTimeoutMs (default 3 min). Fires ONCE per pending assignment; never
   * auto-fails the worker.
   */
  const monitorAcksAndReminders = async (
    task: GroupTask,
    members: GroupTaskMember[],
  ): Promise<void> => {
    if (task.status !== 'planning' && task.status !== 'executing') return;
    const sqlite = deps.getStore();
    const chair = members.find((member) => member.role === 'chair');
    if (!chair?.metabotId) return;
    for (const member of members) {
      if (member.role !== 'worker' || member.metabotId == null) continue;
      // P5 (v1.1): a member who moved to standby (observer) after the watch
      // armed is in a legal silent state — never report them as "not ACKed".
      if (member.status === 'standby') continue;
      const pendingKey = `${ACK_PENDING_PREFIX}${task.id}:${member.metabotId}`;
      const raw = sqlite.get<string>(pendingKey);
      if (!raw) continue;
      let entry: { assignedAt: number; messageId: number; assignedChainSec?: number | null };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry || typeof entry.assignedAt !== 'number') continue;
      if (now() - entry.assignedAt < ackTimeoutMs) continue;
      // P1-4: a worker who spoke ANYTHING after the assignment is engaged —
      // implicit ACK. The pending watch was either missed (cursor retry /
      // member-match gap) or the worker is mid-work; clear it, record
      // ack-seen for the assignment message, and never misreport it as
      // "not ACKed" (the 8/10 #11 incident: worker [WORKING]-ed at 18:36 but
      // the chair still got a no-ACK alert at 18:43).
      //
      // Task #51: "spoke after the assignment" is judged by CHAIN order, not
      // daemon-local processing time — a tick blocked by a slow turn used to
      // compare the worker's chain-time speech against a processing-time
      // `assignedAt` and false-alarm. Two independent signals, either
      // suffices:
      //   1. the member's latest group message id exceeds the assignment
      //      message id (insertion-order proof), or
      //   2. the member's last-speech chain second is >= the assignment's
      //      chain second (same-second ties count as engaged — P1-4).
      // Pending entries armed before assignedChainSec existed fall back to
      // the legacy processing-time comparison.
      const store = deps.getGroupTaskStore();
      const memberGmid = (member.globalmetaid ?? '').trim();
      if (memberGmid && task.groupId) {
        const speakMap = store.getMembersLastSpeakAt(task.groupId, [memberGmid]);
        const lastSpeakSec = speakMap.get(memberGmid.toLowerCase());
        let latestMsgId: number | null = null;
        try {
          // Task #64: host-authored notice lines carry the member's own
          // GlobalMetaID (the long-turn reminder) but are not the member
          // speaking — excluding the ASCII notice prefix keeps the implicit
          // ACK honest instead of letting the host's own liveness notice
          // cancel the no-ACK watch.
          const result = sqlite.getDatabase().exec(
            "SELECT MAX(id) FROM group_chat_messages WHERE group_id = ? AND sender_global_metaid = ?"
            + " AND content NOT LIKE '[GROUP_TASK_NOTICE:%'",
            [task.groupId, memberGmid.toLowerCase()],
          );
          const value = Number(result[0]?.values?.[0]?.[0]);
          if (Number.isFinite(value) && value > 0) latestMsgId = value;
        } catch {
          latestMsgId = null; // transient read failure — fall through to the time-based check
        }
        const spokeAfterAssignment =
          (latestMsgId != null && latestMsgId > entry.messageId)
          || (lastSpeakSec != null && Number.isFinite(lastSpeakSec) && (
            typeof entry.assignedChainSec === 'number'
              ? lastSpeakSec >= entry.assignedChainSec
              : lastSpeakSec * 1000 >= entry.assignedAt
          ));
        if (spokeAfterAssignment) {
          sqlite.set(`${ACK_SEEN_PREFIX}${task.id}:${entry.messageId}`, '1');
          sqlite.delete(pendingKey);
          if (sqlite.get<string>(`${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`) != null) {
            sqlite.delete(`${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`);
          }
          // R6 L2: the member recovered — reset the timeout-hint streak so a
          // future silence window triggers a fresh re-assign hint.
          sqlite.delete(`${GROUP_TASK_TIMEOUT_HINT_PREFIX}${task.id}:${member.metabotId}`);
          // P1-2: same for the stuck-reclaim/stuck-alert streak.
          sqlite.delete(`${GROUP_TASK_STUCK_RECLAIM_PREFIX}${task.id}:${member.metabotId}`);
          sqlite.delete(`${GROUP_TASK_STUCK_ALERT_PREFIX}${task.id}:${member.metabotId}`);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} spoke after ` +
            `assignment #${entry.messageId} (implicit ACK); no no-ACK reminder`,
          );
          continue;
        }
      }
      // G-02 (task #48): liveness is state-driven — a member with a valid
      // (non-rejected, delivered/accepted/frozen) deliverable already answered
      // the assignment with work product, no matter how long ago. An ACK-timeout
      // alarm against them is noise and invites a bogus re-dispatch, so retire
      // the watch silently (log only; no group message, no chair reminder).
      const hasValidDeliverable = memberGmid
        && store.listDeliverables(task.id).some((deliverable) =>
          (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase() === memberGmid.toLowerCase()
          && deliverable.status !== 'rejected');
      if (hasValidDeliverable) {
        sqlite.delete(pendingKey);
        const remindedRaw = sqlite.get<string>(`${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`);
        if (remindedRaw != null) {
          sqlite.delete(`${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`);
        }
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} has a valid deliverable ` +
          `(assignment #${entry.messageId}); ACK watch retired silently — delivered members never alarm`,
        );
        continue;
      }
      // P5 (v1.2): ENGAGED worker — recent speech (even before the assignment:
      // mid long skill turn) or a deliverable recorded within the window. The
      // member is demonstrably active, so the watch is consumed silently —
      // single-commander: no host speech, not even a standby note.
      const remindedKey = `${ACK_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
      const lastActivityMs = (() => {
        if (memberGmid && task.groupId) {
          const speakSec = store.getMembersLastSpeakAt(task.groupId, [memberGmid]).get(memberGmid.toLowerCase());
          if (speakSec != null && Number.isFinite(speakSec)) return speakSec * 1000;
        }
        return 0;
      })();
      const hasRecentDeliverable = store.listDeliverables(task.id).some((deliverable) => {
        if (!memberGmid) return false;
        if ((deliverable.authorGlobalmetaid ?? '').trim().toLowerCase() !== memberGmid.toLowerCase()) return false;
        const created = deliverable.createdAt;
        if (!created) return false;
        const createdSec = Math.floor(Date.parse(`${created.trim().replace(' ', 'T')}Z`) / 1000);
        return Number.isFinite(createdSec) && createdSec * 1000 >= now() - ackEngagedRecentMs;
      });
      if (lastActivityMs >= now() - ackEngagedRecentMs || hasRecentDeliverable) {
        sqlite.delete(pendingKey);
        if (sqlite.get<string>(remindedKey) != null) sqlite.delete(remindedKey);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: ${member.name ?? member.metabotId} engaged on a long turn ` +
          `(assignment #${entry.messageId}); watch consumed silently — no host speech`,
        );
        continue;
      }
      if (sqlite.get<string>(remindedKey) === '1') continue;
      // Single-commander: the missing-ACK fact goes to the chair as an
      // environment note (the host never posts as the chair). The chair
      // decides whether to nudge the member itself.
      try {
        store.recordHostNote({
          taskId: task.id,
          kind: 'no_ack',
          target: member.name ?? `bot-${member.metabotId}`,
          dedupeKey: `no_ack:${task.id}:${member.metabotId}:${entry.messageId}`,
          body:
            `${member.name ?? `bot-${member.metabotId}`} was assigned work in message #${entry.messageId} ` +
            `${Math.round(ackTimeoutMs / 60_000)}+ min ago and has not sent a [WORKING] ACK ` +
            '(no speech from the member since the assignment).',
        });
        sqlite.set(remindedKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: recorded no-ACK environment note for ${member.name ?? member.metabotId}`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: no-ACK environment note record failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * P0-4: multi-source on-chain existence check. MAN (local sqlite + manapi)
   * is always queried via deps.readPinForVerification; the metafile-indexer
   * is queried when deps.readPinSecondaryForVerification is wired. A 404 from
   * ONE source with success from another is treated as indexer lag ("待同步"),
   * never as a hard failure.
   */
  const verifyPinSources = async (pinId: string): Promise<{
    sources: Array<{ source: string; outcome: 'found' | 'not_found' | 'unavailable' }>;
    verified: boolean;
    checkedAt: number;
  }> => {
    const sources: Array<{ source: string; outcome: 'found' | 'not_found' | 'unavailable' }> = [];
    const primary = deps.readPinForVerification;
    if (primary) {
      try {
        sources.push({ source: 'man', outcome: await primary(pinId) });
      } catch {
        sources.push({ source: 'man', outcome: 'unavailable' });
      }
    }
    if (deps.readPinSecondaryForVerification) {
      try {
        sources.push({
          source: 'metafile-indexer',
          outcome: await deps.readPinSecondaryForVerification(pinId),
        });
      } catch {
        sources.push({ source: 'metafile-indexer', outcome: 'unavailable' });
      }
    }
    const found = sources.some((entry) => entry.outcome === 'found');
    const notFound = sources.some((entry) => entry.outcome === 'not_found');
    // verified only when at least one source found it AND no source hard-404s.
    const verified = found && !notFound;
    return { sources, verified, checkedAt: now() };
  };

  /** P0-4: extract the first 64-hex+i0 pinid from a deliverable uri. */
  const pinidFromDeliverable = (uri: string | null): string | null => {
    const match = (uri ?? '').match(/[0-9a-f]{64}i0/i);
    return match ? match[0].toLowerCase() : null;
  };

  /**
   * P2: same-bytes deliverable dedupe. Within one task, rows carrying the same
   * sha256 content hash (identical bytes registered under different pins)
   * collapse to the EARLIEST row: the later duplicate is deleted and the
   * survivor's verification JSON gains one append-only `duplicates` entry
   * naming the absorbed row's pin/uri. Rejected rows never participate (see
   * findDeliverableByContentHash). `outcome` is 'current-deleted' when the
   * caller's row was absorbed (the caller must stop touching it),
   * 'other-deleted' when the caller's row absorbed a later duplicate (then
   * `survivorVerification` carries the caller row's NEW verification JSON so
   * the caller can refresh its stale in-memory copy), 'none' when no
   * same-bytes row exists.
   */
  const dedupeDeliverableByContentHash = (
    task: GroupTask,
    deliverable: GroupTaskDeliverable,
    contentHash: string,
  ): {
    outcome: 'current-deleted' | 'other-deleted' | 'none';
    survivorVerification?: string;
  } => {
    const store = deps.getGroupTaskStore();
    // release-review P2: scope the same-bytes lookup to the SAME author —
    // member B re-attaching bytes identical to member A's deliverable (a
    // shared asset, a chair-directed re-upload) is a distinct delivery that
    // must keep its row and delivery credit; only the same author
    // re-delivering collapses. Null author keeps the legacy unscoped match
    // (rare, legacy rows only).
    const hit = store.findDeliverableByContentHash(
      task.id,
      contentHash,
      deliverable.id,
      deliverable.authorGlobalmetaid,
    );
    if (!hit) return { outcome: 'none' };
    const survivor = hit.id < deliverable.id ? hit : deliverable;
    const duplicate = hit.id < deliverable.id ? deliverable : hit;
    const survivorVerification = appendDeliverableDuplicateNote(
      survivor,
      duplicate.msgPinId ?? null,
      duplicate.uri ?? null,
    );
    store.deleteDeliverable(duplicate.id);
    emitLog(
      `[GroupTaskDaemon] Task ${task.id}: deliverable #${duplicate.id} duplicates #${survivor.id} ` +
      `(same bytes, sha256 ${contentHash.slice(0, 12)}…); merged into the earliest row`,
    );
    return duplicate.id === deliverable.id
      ? { outcome: 'current-deleted' }
      : { outcome: 'other-deleted', survivorVerification };
  };

  /**
   * Speedup R-03: append-only duplicates[] annotation shared by the
   * content-hash dedupe and the (author, uri) cross-message fold — the
   * survivor's verification report gains one entry per absorbed duplicate.
   * Merge into the survivor's existing report; a corrupt/missing report
   * degrades to a fresh object. Returns the written JSON.
   */
  const appendDeliverableDuplicateNote = (
    survivor: GroupTaskDeliverable,
    msgPinId: string | null,
    uri: string | null,
  ): string => {
    const store = deps.getGroupTaskStore();
    let report: Record<string, unknown> = {};
    try {
      if (survivor.verification) report = JSON.parse(survivor.verification);
    } catch {
      report = {};
    }
    const duplicates = Array.isArray(report.duplicates) ? report.duplicates : [];
    duplicates.push({
      msgPinId: msgPinId ?? null,
      uri: uri ?? null,
      notedAt: new Date().toISOString(),
    });
    report.duplicates = duplicates;
    const survivorVerification = JSON.stringify(report);
    store.updateDeliverableVerification(survivor.id, survivorVerification);
    return survivorVerification;
  };

  /** P2: hard cap for download-and-hash of metafile deliverables (bytes). */
  const DELIVERABLE_CONTENT_HASH_MAX_BYTES = 25 * 1024 * 1024;
  /**
   * P2: deliverables whose bytes were already downloaded-and-hashed (or
   * attempted) in this daemon lifetime — the verification monitor runs every
   * tick, so an unhashable/oversized row must not re-download each pass.
   * Keyed by `id:uri` so a corrected uri is hashed again.
   */
  const contentHashAttempted = new Set<string>();

  /**
   * P0-4: periodic re-verification for deliverables that are NOT verified yet
   * (indexer lag / 40400). Re-checks every verificationRetryMinutes (default
   * 10) per deliverable until verified.
   */
  const monitorDeliverableVerification = async (task: GroupTask): Promise<void> => {
    const store = deps.getGroupTaskStore();
    const deliverables = store.listDeliverables(task.id);
    const nowMs = now();
    for (const deliverable of deliverables) {
      if (deliverable.status === 'rejected') continue;
      // P2: content-hash backfill for direct metafile refs — rows recorded
      // from a `[DELIVERABLE] metafile://<pin>` tag carry no hash at record
      // time, so download the bytes once (size-capped) and hash them here,
      // off the hot message loop, then run the same-bytes dedupe. Any
      // network/parse failure leaves the hash NULL and never breaks
      // verification or ingestion.
      const deliverableUri = (deliverable.uri ?? '').trim();
      if (deliverable.contentHash == null && deliverableUri.startsWith('metafile://')) {
        const attemptKey = `${deliverable.id}:${deliverableUri}`;
        if (!contentHashAttempted.has(attemptKey)) {
          contentHashAttempted.add(attemptKey);
          try {
            // maxBytes: the download aborts at the cap (Content-Length
            // pre-check + streamed cancel) — a multi-hundred-MB deliverable
            // must never be fully buffered into the main process just to be
            // measured against the cap and discarded.
            const { buffer } = await downloadMetafileBytes(deliverableUri, {
              maxBytes: DELIVERABLE_CONTENT_HASH_MAX_BYTES,
            });
            if (buffer.length <= DELIVERABLE_CONTENT_HASH_MAX_BYTES) {
              const contentHash = createHash('sha256').update(buffer).digest('hex');
              const dedupe = dedupeDeliverableByContentHash(task, deliverable, contentHash);
              if (dedupe.outcome === 'current-deleted') {
                continue; // absorbed into an earlier row — nothing left to verify here
              }
              store.updateDeliverableContentHash(deliverable.id, contentHash);
              if (dedupe.survivorVerification != null) {
                // This row absorbed a later duplicate — refresh the in-memory
                // report so the re-verification write below cannot clobber
                // the just-merged `duplicates` annotation.
                deliverable.verification = dedupe.survivorVerification;
              }
            }
          } catch (error) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} content hashing skipped: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      const pinid = pinidFromDeliverable(deliverable.uri);
      if (!pinid) continue;
      let report: { verified?: boolean; checkedAt?: number } = {};
      try {
        if (deliverable.verification) report = JSON.parse(deliverable.verification);
      } catch {
        // corrupt/missing → re-verify
      }
      if (report.verified === true) {
        // P3 (v1.1) backfill: rows verified before the 'delivered' status
        // existed (task #22's ledger) read 'pending' forever — flip them here
        // so the enum catches up with the recorded verification report.
        if (deliverable.status === 'pending') {
          store.updateDeliverableStatus(deliverable.id, 'delivered');
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} status ` +
            `pending -> delivered (verified backlog backfill)`,
          );
        }
        continue;
      }
      const checkedAt = typeof report.checkedAt === 'number' ? report.checkedAt : 0;
      if (nowMs - checkedAt < verificationRetryMs) continue;
      try {
        const fresh = await verifyPinSources(pinid);
        // P2: re-verification refreshes the source probe fields but must not
        // clobber annotation keys (e.g. the `duplicates` dedupe audit trail)
        // merged into the report by other passes.
        store.updateDeliverableVerification(
          deliverable.id,
          JSON.stringify({ ...(report as Record<string, unknown>), ...fresh }),
        );
        // Issue #8: the re-verification pass is the chain-confirmation-driven
        // update path — a pin that becomes verifiable on-chain (indexer lag
        // caught up) flips the ledger's confirmation state.
        store.updateDeliverableConfirmation(
          deliverable.id,
          fresh.verified ? 'confirmed' : 'unconfirmed',
        );
        // P3 (v1.1): chain-confirmation-driven status flip (indexer lag caught
        // up) — same pending -> delivered rule as the record-time path.
        if (fresh.verified && deliverable.status === 'pending') {
          store.updateDeliverableStatus(deliverable.id, 'delivered');
        }
        const lagging = fresh.sources.some((entry) => entry.outcome === 'not_found')
          && fresh.sources.some((entry) => entry.outcome === 'found');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} ${pinid.slice(0, 10)}… ` +
          `${fresh.verified ? 'verified on-chain' : (lagging ? 'awaiting indexer sync' : 'not found')}`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: deliverable #${deliverable.id} re-verification failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  /**
   * P0-4: delivery deadline reminders. When a worker's [WORKING] ACK carried an
   * estimated duration and the deadline passes without ANY deliverable from
   * that member, post ONE reminder addressed to both chair and worker.
   * P1-3: when the reminder already went out and the deadline stays blown past
   * one member-timeout grace window, escalate from "remind" to the same
   * auto-recovery the timeout watchdog uses — but only when the member is
   * genuinely inert (no heartbeat, no cowork-session activity). Returns a
   * chair-context block with the reclaim directives (may be empty).
   */
  const monitorDeliveryDeadlines = async (
    task: GroupTask,
    members: GroupTaskMember[],
  ): Promise<string> => {
    if (task.status !== 'executing') return '';
    const sqlite = deps.getStore();
    const store = deps.getGroupTaskStore();
    const nowMs = now();
    const reclaimNotes: string[] = [];
    for (const member of members) {
      if (member.role !== 'worker' || member.metabotId == null) continue;
      const raw = sqlite.get<string>(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`);
      if (!raw) continue;
      let entry: { dueAt: number };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry || typeof entry.dueAt !== 'number' || nowMs < entry.dueAt) continue;
      const remindedKey = `${DELIVERY_REMINDED_PREFIX}${task.id}:${member.metabotId}`;
      if (sqlite.get<string>(remindedKey) === '1') {
        // P1-3 escalation: the reminder went out and the deadline is still
        // blown past one grace window. Reclaim only a genuinely inert member
        // — a valid heartbeat lease or fresh session activity means the long
        // task is alive and the ETA was just optimistic.
        if (nowMs < entry.dueAt + memberTimeoutAfterMinutes * 60_000) continue;
        // Review fix (task #36 follow-up): re-check the ledger BEFORE
        // reclaiming. The original escalation branch never looked at
        // deliverables again, so a LATE delivery (past ETA, after the
        // reminder) plus one quiet timeout window of normal post-delivery
        // waiting stopped a healthy worker's session, failed its attempt,
        // and told the chair to re-dispatch work that was already done.
        const gmidEscalation = (member.globalmetaid ?? '').trim().toLowerCase();
        const deliveredLate = Boolean(gmidEscalation)
          && store.listDeliverables(task.id).some(
            (deliverable) =>
              (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase() === gmidEscalation
              && deliverable.status !== 'rejected',
          );
        if (deliveredLate) {
          sqlite.delete(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`);
          sqlite.delete(remindedKey);
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: delivery deadline watch for ${member.name ?? member.metabotId} ` +
            'retired — the deliverable arrived late but arrived; no reclaim',
          );
          continue;
        }
        const liveness = classifyMemberLiveness({
          lastSpeakMs: null,
          lastSessionActivityMs: getLocalMemberSessionInfo(task.id, member.metabotId)?.lastActivityMs ?? null,
          heartbeatUntilMs: getMemberHeartbeatUntil(task.id, member.metabotId),
          nowMs,
          thresholdMs: memberTimeoutAfterMinutes * 60_000,
        });
        if (liveness === 'alive') continue;
        // GT-09: the escalation branch must honor the SAME two gates as the
        // timeout monitor — it used to reclaim directly, killing the session
        // of a member who was correctly WAITING on an undelivered upstream
        // (and ignoring the alert-only reclaim mode entirely).
        const chairForDepWait = members.find((candidate) => candidate.role === 'chair');
        const depWait = checkMemberDependencyWait(task, member, chairForDepWait);
        if (depWait && depWait.pendingTokens.length > 0) {
          // Release-review P1: prose declarations are gated by the
          // time-capped exemption helper (it stamps the kv note itself);
          // structured tokens go through the dedupe helper (release-review
          // P2) and always keep the exemption while pending.
          if (depWait.proseDeclared) {
            if (applyProseDependencyExemption(task, member, depWait.pendingTokens, depWait.assignmentMsgId)) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: delivery-deadline escalation skipped for ${member.name ?? member.metabotId} ` +
                `— waiting on upstream ${depWait.pendingTokens.join(', ')} (prose-declared, time-capped)`,
              );
              continue;
            }
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: prose dependency-wait exemption expired for ` +
              `${member.name ?? member.metabotId} — delivery-deadline escalation resumes`,
            );
          } else {
            if (writeDepWaitExemptionNote(task.id, member.metabotId, depWait.pendingTokens)) {
              emitLog(
                `[GroupTaskDaemon] Task ${task.id}: delivery-deadline escalation skipped for ${member.name ?? member.metabotId} ` +
                `— waiting on upstream ${depWait.pendingTokens.join(', ')} (not delivered)`,
              );
            }
            continue;
          }
        }
        if (depWait && !depWait.proseDeclared) {
          // Symmetry with the timeout monitor above: the wait lifted on this
          // path too — clear the stale exemption note so the audit trail
          // reflects the lift instead of relying on the other monitor's run.
          // Structured tokens only: prose notes carry the grantedAt/expiry
          // state owned by applyProseDependencyExemption — never delete them.
          sqlite.delete(`${GROUP_TASK_DEP_WAIT_EXEMPT_PREFIX}${task.id}:${member.metabotId}`);
        }
        const deadlineReclaimReason =
          'estimated delivery missed past the grace window with no [DELIVERABLE] and zero cowork-session activity';
        if (parseGroupTaskStuckReclaimMode(sqlite.get<string>('groupTaskStuckReclaim')) === 'auto') {
          const note = reclaimStuckWorkerSession(task, member, deadlineReclaimReason);
          if (note) reclaimNotes.push(note);
        } else {
          const note = alertStuckWorkerSession(task, member, deadlineReclaimReason);
          if (note) reclaimNotes.push(note);
        }
        continue;
      }
      const gmid = (member.globalmetaid ?? '').trim().toLowerCase();
      const hasDeliverable = store.listDeliverables(task.id).some(
        (deliverable) =>
          Boolean(gmid)
          && (deliverable.authorGlobalmetaid ?? '').trim().toLowerCase() === gmid
          && deliverable.status !== 'rejected',
      );
      if (hasDeliverable) {
        sqlite.delete(`${EXPECTED_DELIVERY_PREFIX}${task.id}:${member.metabotId}`);
        continue;
      }
      // Speedup R-02: never deadline-alert a member whose assignment is still
      // upstream-blocked — the downstream ETA must stay suspended (not armed,
      // not ticking) until the upstream deliverable lands. Leaving the
      // reminder unposted AND the reminded flag unset keeps the clock from
      // advancing while the member legitimately waits.
      const reminderDepWait = checkMemberDependencyWait(
        task,
        member,
        members.find((candidate) => candidate.role === 'chair'),
      );
      // fix-v2 P0-1: a parked (standby) member cannot be late — the chair has
      // not activated it, so there is nothing to be late ON (task #62's false
      // alert hit a member the chair had explicitly parked as an observer).
      if (member.status === 'standby') {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: delivery reminder suspended for ${member.name ?? member.metabotId} ` +
          '— member is standby (parked by the chair, no active assignment)',
        );
        continue;
      }
      // fix-v2 P0-1: suspension keys on STRUCTURED (ledger-verifiable) pending
      // tokens only. A prose wait never self-lifts, so prose-suspending the
      // reminder would keep the clock frozen even after the upstream landed.
      // With the arm-side gates (clause-scoped dispatch scan + the worker's
      // own conditional-ETA declaration) a waiting member's deadline is never
      // armed in the first place — an existing kv means the member committed.
      const reminderPendingStructured = (reminderDepWait?.pendingTokens ?? [])
        .filter((token) => token !== '(prose-declared upstream)');
      if (reminderPendingStructured.length > 0) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: delivery reminder suspended for ${member.name ?? member.metabotId} ` +
          `— waiting on upstream ${reminderPendingStructured.join(', ')} (not delivered)`,
        );
        continue;
      }
      const chair = members.find((candidate) => candidate.role === 'chair');
      if (!chair?.metabotId) continue;
      // fix-v2 P0-1: a retained alert must carry the member's dependency state
      // so the chair and the member can verify it without a clarifying round.
      const reminderDepState = reminderDepWait == null
        ? 'no chair assignment on record'
        : reminderDepWait.proseDeclared
          ? 'prose-declared upstream in the latest dispatch (not ledger-verifiable)'
          : reminderDepWait.tokens.length > 0
            ? `declared upstream(s) delivered or advisory: ${reminderDepWait.tokens.join(', ')}`
            : 'no upstream dependency declared in the latest dispatch';
      // Single-commander: the missed-deadline fact goes to the chair as an
      // environment note (the host never posts the ⚠ as the chair). The
      // chair decides whether to nudge the member, extend, or re-assign.
      try {
        store.recordHostNote({
          taskId: task.id,
          kind: 'deadline',
          target: member.name ?? `bot-${member.metabotId}`,
          dedupeKey: `deadline:${task.id}:${member.metabotId}:${entry.dueAt}`,
          body:
            `${member.name ?? `bot-${member.metabotId}`}'s estimated delivery ` +
            `(${new Date(entry.dueAt).toISOString()}) has passed with no [DELIVERABLE] on record ` +
            `(dependency state: ${reminderDepState}).`,
        });
        sqlite.set(remindedKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: recorded missed-deadline environment note for ${member.name ?? member.metabotId}`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: delivery reminder note record failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (reclaimNotes.length === 0) return '';
    return [
      '[SYSTEM delivery-timeout recovery — generated by the host, not a group participant]',
      ...reclaimNotes,
    ].join('\n');
  };

  /** Stable per-member welcome key (local members by metabot_id, remote by gmid). */
  const memberJoinKey = (member: GroupTaskMember): string =>
    member.metabotId != null
      ? `local:${member.metabotId}`
      : `remote:${(member.globalmetaid ?? '').trim().toLowerCase()}`;

  /**
   * #13 handshake (inviter side): ONE welcome broadcast when a member joins a
   * task AFTER the initial roster — especially a remote OpenTeam member whose
   * join just confirmed (joined_pin_id appears). The welcome names the joiner
   * and why they were invited (invite required-skills), tells the joiner to
   * greet the group first, and @s the existing local members once for an
   * online confirmation. Their mention-gated replies are the one-round
   * handshake; the confirmations carry no mentions, so nothing replies to
   * them and no chat loop starts ([NO_REPLY] discipline intact). The welcome
   * itself @s members only — the chair is skipped (self-skip by sender), so
   * the chair does not floor-control a reply to it.
   *
   * Bookkeeping: the first tick snapshots the initially-joined member keys
   * (create-time roster); later joins outside that snapshot and not yet
   * welcomed get the broadcast (kv `group_task_welcome_done:<taskId>:<key>`).
   * Review/terminal tasks never welcome (review-phase silence must keep the
   * last message as the closing ceremony).
   */
  const monitorMemberJoinWelcomes = async (
    task: GroupTask,
    members: GroupTaskMember[],
    botsById: Map<number, GroupTaskDaemonBotFull>,
  ): Promise<void> => {
    if (task.status !== 'planning' && task.status !== 'executing') return;
    const sqlite = deps.getStore();
    const initialKey = `${WELCOME_INITIAL_JOINED_PREFIX}${task.id}`;
    const rawInitial = sqlite.get<string>(initialKey);
    if (rawInitial == null) {
      // First tick for this task: snapshot the roster that is already joined.
      // Create-time members are introduced by the kickoff — never welcomed.
      const initialJoined = members
        .filter((member) => member.joinedPinId)
        .map(memberJoinKey);
      sqlite.set(initialKey, JSON.stringify(initialJoined));
      return;
    }
    let initialJoined: string[] = [];
    try {
      const parsed = JSON.parse(rawInitial);
      initialJoined = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      initialJoined = [];
    }
    const chair = members.find((member) => member.role === 'chair');
    if (!chair?.metabotId) return;
    const membershipStore = deps.getOpenTeamMembershipStore?.();
    // Why was each remote joiner invited? (invite required-skills, best-effort)
    const invitedForByGmid = new Map<string, string>();
    for (const member of members) {
      if (member.role === 'chair' || member.metabotId != null || !member.joinedPinId) continue;
      const gmid = (member.globalmetaid ?? '').trim();
      if (!gmid) continue;
      try {
        const invite = membershipStore?.getLatestInvite(task.id, gmid);
        if (invite?.requiredSkills?.length) {
          invitedForByGmid.set(gmid.toLowerCase(), invite.requiredSkills.join(', '));
        }
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: invite lookup for welcome failed (welcome proceeds): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const member of members) {
      if (member.role === 'chair' || !member.joinedPinId) continue;
      const key = memberJoinKey(member);
      if (initialJoined.includes(key)) continue; // create-time roster
      const doneKey = `${WELCOME_DONE_PREFIX}${task.id}:${key}`;
      if (sqlite.get<string>(doneKey) === '1') continue; // already welcomed
      const isRemote = member.metabotId == null;
      const joinerName = member.name?.trim()
        || (isRemote ? 'remote-member' : `bot-${member.metabotId}`);
      const existingNames = members
        .filter((candidate) => candidate.id !== member.id)
        .filter((candidate) => candidate.role === 'worker' && candidate.metabotId != null)
        .map((candidate) => {
          const bot = botsById.get(candidate.metabotId!);
          return bot?.name?.trim() || candidate.name?.trim() || '';
        })
        .filter(Boolean);
      // Single-commander: the join is an environment FACT for the chair —
      // the host does not broadcast a welcome under the chair's identity.
      // The chair greets the joiner itself (its host-note turn follows
      // immediately) and may ask the listed members to confirm presence.
      const invitedFor = invitedForByGmid.get((member.globalmetaid ?? '').trim().toLowerCase());
      try {
        deps.getGroupTaskStore().recordHostNote({
          taskId: task.id,
          kind: 'join',
          target: joinerName,
          dedupeKey: `join:${task.id}:${key}`,
          body:
            `${joinerName} just joined the task (${isRemote ? 'remote teammate via OpenTeam' : 'local bot'}).`
            + (invitedFor ? ` Invited for: ${invitedFor}.` : '')
            + ' Greet them in the group, tell them what is expected, and have them confirm presence '
            + '(other listed members may confirm too, once each).'
            + (existingNames.length > 0 ? ` Currently seated: ${existingNames.join(', ')}.` : ''),
        });
        sqlite.set(doneKey, '1');
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: recorded join environment note for new ` +
          `${isRemote ? 'remote' : 'local'} member ${joinerName} (chair will greet)`,
        );
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: join environment note record failed (retried on next tick): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const processTask = async (task: GroupTask): Promise<void> => {
    if (!task.groupId) return;
    const store = deps.getGroupTaskStore();
    const sqlite = deps.getStore();
    const db = sqlite.getDatabase();
    // Entropy P0 knobs (floor gate / template ACK / log folding), read once
    // per task pass; defaults are all-on, kv exists for per-knob rollback.
    const entropyP0: GroupTaskEntropyP0Config = parseGroupTaskEntropyP0Config(
      sqlite.get<string>('groupTaskEntropyP0'),
    );

    // P2-8: multi-driver mutex — when another daemon instance holds a fresh
    // driver claim for this task, yield the whole tick (no heartbeat, no
    // planning, no message processing) so two chair sessions never drive the
    // same task at the same instant.
    if (!claimDriverOrYield(task.id)) return;

    if (deps.orchestrationBridge) {
      try {
        deps.orchestrationBridge.ensureCanonicalTask(task);
        deps.orchestrationBridge.syncStatus(task.id);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: canonical reconciliation failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const members = store.listMembers(task.id);
    const metabotStore = deps.getMetabotStore();
    const botsById = new Map<number, GroupTaskDaemonBotFull>();
    for (const member of members) {
      if (member.metabotId == null) continue;
      const bot = metabotStore.getMetabotById(member.metabotId);
      if (bot) botsById.set(member.metabotId, bot);
    }
    // Remote OpenTeam teammates (metabotId == null) join the prompt roster so
    // the chair and local workers can see and @ them; botsById and responder
    // gating stay local-only because their replies come from their own machine.
    const promptMembers: DaemonPromptMember[] = members.map((member) => {
      if (member.metabotId == null) {
        const globalMetaId = member.globalmetaid?.trim() || null;
        return {
          // The roster name must stay exactly the display_name snapshot — the
          // invitee's guest daemon name-gates on its real bot name.
          name: member.name ?? `remote-${(globalMetaId ?? '').slice(0, 10) || 'unknown'}`,
          role: member.role,
          globalMetaId,
          bio: null,
          roleProfile: null,
          goal: null,
          remote: true,
        };
      }
      const bot = botsById.get(member.metabotId);
      return {
        name: member.name ?? bot?.name ?? `bot-${member.metabotId}`,
        role: member.role,
        globalMetaId: member.globalmetaid?.trim() || bot?.globalmetaid?.trim() || null,
        bio: bot?.bio ?? bot?.background ?? null,
        roleProfile: bot?.role ?? null,
        goal: bot?.goal ?? null,
      };
    });
    const chairGlobalMetaId = (
      members.find((member) => member.role === 'chair')?.globalmetaid ?? ''
    ).trim();
    const chairMemberId = members.find((member) => member.role === 'chair')?.metabotId;
    const ownerGlobalMetaId = (
      chairMemberId != null ? botsById.get(chairMemberId)?.boss_global_metaid ?? '' : ''
    ).trim();

    // OpenTeam M2: remote-teammate unreachable evaluation (throttled presence
    // probe + group-message silence window). The resulting fact block rides
    // every chair turn this tick; empty when everyone is reachable/unwired.
    let remoteStatusBlock = '';
    try {
      remoteStatusBlock = buildRemoteStatusBlock(
        await evaluateRemoteTeammates(task, members, botsById, ownerGlobalMetaId),
      );
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: remote teammate evaluation failed (tick continues): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // GT-01 (task #56): lastDrivenAt (epoch seconds) is the show stall
    // signal's primary input, so it must track REAL drive work — a posted
    // message, a dispatched turn, or a processed message (see noteDriveActivity
    // call sites). The old per-tick heartbeat refreshed it even while the
    // daemon dispatched nothing for hours ("fake heartbeat": stall stayed
    // False through the whole #56 outage). The one legitimate per-tick refresh
    // that remains: a LIVE (non-latched) turn in flight for this task — a long
    // skill turn that stopped posting heartbeats is still genuine drive
    // activity, while a watchdog-latched turn (latchedTurnKeys) is not.
    const hasLiveTurn = [...turnInFlight.keys()].some(
      (key) => key.startsWith(`${task.id}:`) && !latchedTurnKeys.has(key),
    );
    if (hasLiveTurn) noteDriveActivity(task.id);

    // HITL: while a human checkpoint is open the group is paused waiting for
    // the owner's decision — skip member nudging (unreachable marking, ACK and
    // delivery-deadline reminders) that would punish the enforced silence.
    const checkpointOpenAtTick = store.getOpenCheckpoint(task.id) != null;
    // G-04: a supervisor pause holds dispatch — same monitor silence as a
    // checkpoint (owner-initiated pause must not punish members for it).
    const dispatchPausedAtTick = task.dispatchPausedAt != null;

    // G-01: one creation report per task — title, current status and roster to
    // the origin session. Fires on the first tick that sees the task (any
    // status), so even a task that raced past planning still reports once.
    if (task.sourceSessionId?.trim()) {
      notifySourceSessionMilestone(
        task,
        'created',
        buildSourceSessionCreatedNotice({
          title: task.title,
          status: task.status,
          memberNames: promptMembers.map((member) => member.name).filter(Boolean),
        }),
      );
    }

    // G-04: drive the chair's response to pending supervisor signals (nudge /
    // flag). One turn per batch; pause/resume rows arrive already processed
    // (host-applied gates).
    // fix/group-task-flow: detached — the turn must not block the tick; a busy
    // chair session defers the batch to a later tick (signals stay pending).
    if (!dispatchPausedAtTick) {
      const hasPendingSignals = store
        .listPendingSupervisorSignals(task.id)
        .some((signal) => signal.kind === 'nudge' || signal.kind === 'flag');
      if (hasPendingSignals && chairMemberId != null) {
        runTurnAsync(
          keyOf(task.id, chairMemberId),
          `Task ${task.id} supervisor-signal turn`,
          () => processSupervisorSignals(task, members, botsById, promptMembers),
          { taskId: task.id, metabotId: chairMemberId, isChair: true },
        );
      }
      // Single-commander: pending environment notes drive ONE chair turn
      // (facts only — the host itself never speaks in the group). Same
      // human-gate deferral as supervisor signals.
      if (
        chairMemberId != null
        && !checkpointOpenAtTick
        && store.listPendingHostNotes(task.id).length > 0
      ) {
        runTurnAsync(
          keyOf(task.id, chairMemberId),
          `Task ${task.id} host-note turn`,
          () => processHostNotes(task, members, botsById, promptMembers),
          { taskId: task.id, metabotId: chairMemberId, isChair: true },
        );
      }
    }

    // G-01: no-progress stall — a task with no new group message and no new
    // deliverable for the window looks stuck; tell the origin session once
    // per re-arm window instead of sitting silent.
    // GT-03 (task #56): PLANNING tasks are covered too — the old executing-only
    // gate left a task pinned in planning (chair plan attempts exhausted during
    // the outage) completely blind: no nudge, no stall anomaly, stall=False
    // forever in the detail view.
    if ((task.status === 'executing' || task.status === 'planning') && !checkpointOpenAtTick && !dispatchPausedAtTick && task.groupId) {
      monitorNoProgressStall(task);
    }

    // P0-2: auto-mark silent assigned/working members unreachable (badge for chair).
    if (task.status === 'executing' && !checkpointOpenAtTick && !dispatchPausedAtTick) {
      monitorMemberUnreachable(task, members);
    }

    // R6 L2/L3: when a LOCAL working/assigned member's [WORKING] signal goes
    // stale, mark them timeout + inject a chair re-assign hint (L2), then brief
    // the owner if still silent past the escalation window (L3). The hint block
    // rides the existing remoteStatusBlock chair-context channel.
    if (task.status === 'executing' && !checkpointOpenAtTick && !dispatchPausedAtTick) {
      const timeoutBlock = await monitorLocalWorkerTimeout(task, members, ownerGlobalMetaId);
      if (timeoutBlock) {
        remoteStatusBlock = [remoteStatusBlock, timeoutBlock].filter(Boolean).join('\n\n');
      }
    }

    // P0-3: once-per-assignment chair reminder for missing [WORKING] ACKs.
    if (!checkpointOpenAtTick && !dispatchPausedAtTick) {
      await monitorAcksAndReminders(task, members);
    }
    // P0-4: re-verify lagging deliverables + missed delivery deadlines.
    await monitorDeliverableVerification(task);
    if (!checkpointOpenAtTick && !dispatchPausedAtTick) {
      // P1-3: delivery-timeout reclaim directives ride the same chair-context
      // channel as the member-timeout hints.
      const deliveryRecoveryBlock = await monitorDeliveryDeadlines(task, members);
      if (deliveryRecoveryBlock) {
        remoteStatusBlock = [remoteStatusBlock, deliveryRecoveryBlock].filter(Boolean).join('\n\n');
      }
    }

    // #13: welcome broadcast + one-round handshake for members joining after
    // the initial roster (esp. remote OpenTeam members). Runs before the
    // planning turn so a mid-planning join is greeted before work is assigned.
    try {
      await monitorMemberJoinWelcomes(task, members, botsById);
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Task ${task.id}: join welcome monitor failed (tick continues): ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Exactly one chair planning turn per task, while it is still in 'planning'.
    // G-04: a supervisor pause holds the initial dispatch too.
    // fix/group-task-flow: detached — planning must not block the tick. The
    // planned-key/attempts counters inside keep their semantics; a busy chair
    // session simply retries on a later tick.
    if (task.status === 'planning' && !dispatchPausedAtTick && chairMemberId != null) {
      runTurnAsync(
        keyOf(task.id, chairMemberId),
        `Task ${task.id} chair planning turn`,
        () => maybeRunChairPlanningTurn(task, members, botsById, promptMembers, remoteStatusBlock),
        { taskId: task.id, metabotId: chairMemberId, isChair: true },
      );
    }

    // Task #51 chair-drive safety net: a chair trigger with no chair speech
    // and no completed chair turn within the window is re-driven ONCE through
    // the durable defer queue (the drain below picks it up this same tick).
    if (
      (task.status === 'executing' || task.status === 'planning')
      && !dispatchPausedAtTick
      && !checkpointOpenAtTick
      && chairMemberId != null
    ) {
      const pendingRaw = sqlite.get<string>(`${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`);
      if (pendingRaw) {
        let pending: {
          messageId?: number;
          reason?: GroupTaskResponderDecision['reason'];
          atMs?: number;
          redriven?: boolean;
        } | null = null;
        try {
          pending = JSON.parse(pendingRaw);
        } catch {
          pending = null;
        }
        if (
          pending
          && typeof pending.messageId === 'number'
          && typeof pending.atMs === 'number'
          && pending.reason
          && now() - pending.atMs >= chairResponseRedriveMs
        ) {
          // fix-v2 P0-2: never redrive or drop while the chair is provably
          // responsive — a turn in flight right now, or cowork-session writes
          // within the window (covers both the long quality-gate turn and the
          // chain-sync gap between a completed turn and its observed reply;
          // task #62 false-fired through both). The countdown slides forward
          // so it measures CONTINUOUS chair silence; a genuinely dead chair
          // session (no in-flight turn, no session writes for a full window)
          // still re-drives once and then alerts the origin session.
          const chairTurnKey = keyOf(task.id, chairMemberId);
          const chairSessionActivityMs =
            getLocalMemberSessionInfo(task.id, chairMemberId)?.lastActivityMs ?? null;
          const chairResponsive = turnInFlight.has(chairTurnKey)
            || (chairSessionActivityMs != null && now() - chairSessionActivityMs < chairResponseRedriveMs);
          if (chairResponsive) {
            sqlite.set(
              `${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`,
              JSON.stringify({ ...pending, atMs: now() }),
            );
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: chair response watch for message ${pending.messageId} ` +
              'deferred — chair turn in flight or session active',
            );
          } else if (pending.redriven) {
            // One re-drive already happened and the chair is still silent —
            // stop here; the no-progress stall monitor reports the episode.
            // GT-10: the drop itself is an anomaly too — "the chair never
            // answered, twice" must reach the origin session explicitly, not
            // only via the slower indirect stall signal.
            sqlite.delete(`${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`);
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: chair response for message ${pending.messageId} ` +
              'still missing after one re-drive; dropping the obligation',
            );
            notifySourceSessionMilestone(
              task,
              'anomaly',
              buildSourceSessionAnomalyNotice({
                title: task.title,
                status: task.status,
                summary:
                  `The chair never answered message #${pending.messageId} — not on the first dispatch, ` +
                  'not on the automatic re-drive. The obligation was dropped so the task cannot wedge ' +
                  'behind it; nudge the chair (supervisor channel) or check its LLM/session health.',
              }),
              `chair_response_dropped:${pending.messageId}`,
            );
          } else {
            // chairResponsive above already covers an in-flight turn — this is
            // a genuinely silent chair: re-drive once via the durable queue.
            sqlite.set(
              `${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`,
              JSON.stringify({ ...pending, redriven: true }),
            );
            deferReply({
              taskId: task.id,
              metabotId: chairMemberId,
              messageId: pending.messageId,
              reason: pending.reason,
              verificationNotes: [],
            });
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: chair never answered message ${pending.messageId} ` +
              `within ${Math.round(chairResponseRedriveMs / 60_000)} min of continuous silence; re-driven once via the defer queue`,
            );
          }
        }
      }
    }

    // P0-3c: compensate replies deferred by a cap/cooldown in an earlier tick.
    // Deferred entries get priority over brand-new messages so a skipped worker
    // still gets its chance (the message cursor already advanced past it).
    // fix/group-task-flow: the queue is durable (kv); entries dispatch as async
    // jobs and re-enter the queue when the bot session is still busy.
    const memberGmids = memberGlobalMetaIdSet(members);
    const ownerGmidKey = ownerGlobalMetaId.toLowerCase();
    const deferredForTask = loadDeferredQueue(task.id);
    if (deferredForTask.length > 0) {
      // Task #64: coalesce each worker's queued backlog to ONE trigger before
      // dispatching. The old one-turn-per-queued-message replay made a bot
      // re-live history after a long turn — welcome, assignment, stall nudge,
      // … each spawning its own multi-minute turn long after the messages
      // went stale. One turn now answers the backlog: the OLDEST still-open
      // chair assignment when one is queued (real assignments are never
      // silently dropped, and its auto-ACK gate still fires), otherwise the
      // NEWEST trigger (older chatter is superseded). The turn prompt carries
      // the recent group log, so superseded messages stay visible as context.
      // Chair entries keep their per-message semantics (floor control / owner
      // obligations) and are never coalesced.
      const coalescedDeferred = coalesceDeferredBacklogPerBot(db, task, members, deferredForTask);
      saveDeferredQueue(task.id, []); // popped; entries re-defer below as needed
      for (const entry of coalescedDeferred) {
        const member = members.find((candidate) => candidate.metabotId === entry.metabotId);
        const bot = botsById.get(entry.metabotId);
        if (!member || !bot) continue;
        const row = queryMessageById(db, task.groupId, entry.messageId);
        if (!row) continue; // message purged; drop the deferred entry
        const deferredMessage = toDaemonMessage(row);
        // Re-validate the sender before speaking on their message: it may have
        // been flagged SUSPECT, or the sender kicked out of the task, after
        // the reply was deferred (M3 kick loop closure).
        const deferredSenderGmid = (deferredMessage.senderGlobalMetaId ?? '').trim().toLowerCase();
        if (
          deferredMessage.senderSuspect
          || !deferredSenderGmid
          || (deferredSenderGmid !== ownerGmidKey && !memberGmids.has(deferredSenderGmid))
        ) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: deferred reply for message ${entry.messageId} dropped; ` +
            'the sender is suspect or no longer an active member',
          );
          continue;
        }
        const key = keyOf(task.id, entry.metabotId);
        const isChair = member.role === 'chair';
        // HITL: worker replies deferred before the checkpoint opened keep
        // waiting — workers are silenced while the owner decides.
        if (checkpointOpenAtTick && !isChair) {
          deferReply(entry);
          continue;
        }
        const lastReplyAt = lastReplyAtByKey.get(key) ?? 0;
        const cooldownMs = isChair ? chairCooldownMs : workerCooldownMs;
        if (now() - lastReplyAt < cooldownMs) {
          deferReply(entry); // still cooling down; keep waiting
          continue;
        }
        if ((replyCountByKey.get(key) ?? 0) >= replyBudget) continue; // permanently spent
        if (isChair && entry.reason !== 'chair_mentioned' && twinChairActive(db, task.id, task.groupId, deferredMessage.pinId, chairGlobalMetaId)) {
          continue; // the Twin already spoke about this message (or in the recent window); drop the auto reply
        }
        // Single-commander: no [DEPENDS_ON] hold on the drain either — see
        // the message-processing note above. Sequencing is the chair's.
        // fix/group-task-flow: a busy session keeps the entry queued — the
        // in-flight turn finishes first, then this drains on a later tick.
        if (turnInFlight.has(key)) {
          deferReply(entry);
          continue;
        }
        dispatchReplyTurn({
          task,
          member,
          bot,
          message: deferredMessage,
          reason: entry.reason,
          promptMembers,
          chairGlobalMetaId,
          ownerGlobalMetaId,
          verificationNotes: entry.verificationNotes,
          remoteStatusBlock,
          entry,
        });
      }
    }

    // Task #52 self-heal: reconcile a stuck chair status directive (a verdict
    // the old parser rejected after the cursor moved on). Re-armed whenever
    // the cursor advances (Task #63) so mid-run misses heal without a restart.
    // Best-effort — a failure logs and the task simply keeps its status.
    if (statusDirectiveReconciledCursor.get(task.id) !== task.lastProcessedMsgId) {
      statusDirectiveReconciledCursor.set(task.id, task.lastProcessedMsgId);
      try {
        await reconcileStatusDirective(task, members, botsById, promptMembers, ownerGlobalMetaId, memberGmids);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: status directive reconcile failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // GT-05 (task #56): restart reconciliation — a planning task whose bounded
    // plan attempts were exhausted BEFORE the restart (e.g. burned during a
    // provider outage) would otherwise sit silent until GT-03's 20-minute stall
    // episode re-arms it. Once per daemon run, release one attempt immediately
    // so a restart puts a wedged planning task back into motion on the first
    // ticks.
    if (task.status === 'planning' && !planningRearmedThisRun.has(task.id)) {
      planningRearmedThisRun.add(task.id);
      const plannedKey = `${CHAIR_PLANNED_KV_PREFIX}${task.id}`;
      const attemptsKey = `${CHAIR_PLAN_ATTEMPTS_KV_PREFIX}${task.id}`;
      const attempts = Number(sqlite.get<number>(attemptsKey) ?? 0) || 0;
      if (sqlite.get<string>(plannedKey) !== '1' && attempts >= MAX_CHAIR_PLAN_ATTEMPTS) {
        sqlite.set(attemptsKey, MAX_CHAIR_PLAN_ATTEMPTS - 1);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: restart reconciliation — chair plan attempts were exhausted ` +
          'with no plan posted; re-armed one planning attempt for this daemon run',
        );
      }
    }

    const rows = queryNewMessages(db, task.groupId, task.lastProcessedMsgId);
    if (rows.length === 0) return;

    let workerRepliesThisTick = 0;
    // P2-7: at most ONE chair auto response (deliverable / floor control / owner
    // message) per tick, so the daemon never double-speaks alongside the Twin.
    let chairAutoRepliesThisTick = 0;

    for (const row of rows) {
      try {
        // Round-4 attribution first: resolve the chain-signature GlobalMetaID
        // (persisted once) and mark SUSPECT when the sender is neither a task
        // member nor the owner. Everything downstream (deliverable collection,
        // gating, replies, experience capture) consumes the enriched message.
        // Inside the try on purpose (R2P1-4): a resolver THROW is transient and
        // rides the bounded retry path below instead of sticking a SUSPECT
        // stamp on the message and advancing the cursor past it.
        const message = await enrichMessageAttribution(
          toDaemonMessage(row),
          memberGmids,
          ownerGlobalMetaId,
        );
        if (message.senderSuspect) {
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: message ${message.id} from non-member sender ` +
            `(globalMetaId=${message.senderGlobalMetaId ?? 'unresolved'}, name=${message.senderName}) ` +
            'marked SUSPECT — no deliverables recorded, no replies triggered',
          );
        }
        recordGroupTaskMessageForLocalMembers(task, message, members, botsById);
        const verificationNotes = await processMessageTags(task, message, members, botsById, promptMembers);
        // A [STATUS:...] tag on THIS message may have flipped the task status
        // (e.g. chair posted [STATUS:REVIEW]); gate with the fresh status, not
        // the tick-start snapshot. A [CHECKPOINT...] tag may likewise have
        // opened/resolved a HITL checkpoint — gate with the fresh state too.
        const freshStatus = store.getTaskById(task.id)?.status ?? task.status;
        const hasOpenCheckpoint = store.getOpenCheckpoint(task.id) != null;
        // GT#47 R3: during a human-gate phase (review / open checkpoint) a
        // chair @mention is NOT an assignment and a worker [WORKING] is NOT a
        // work commitment — the protocol-marker watches below must respect the
        // same silence gate the responder path uses, or a final-check message
        // mis-arms ACK/deadline watches (task #47: expected_delivery armed and
        // a no-ACK alarm fired off the chair's review-closing messages).
        const humanGateActive = freshStatus === 'review' || hasOpenCheckpoint;
        // P0-3: [WORKING] ACK / [STANDBY] markers + assignment ACK tracking.
        handleMemberProtocolMarkers(task, message, members, botsById, { humanGateActive });
        // Task #51 safety net: the chair spoke — every pending trigger up to
        // this message counts as answered; a NEWER trigger (armed later in
        // the same tick) survives.
        if (
          chairGlobalMetaId
          && (message.senderGlobalMetaId ?? '').trim().toLowerCase() === chairGlobalMetaId.trim().toLowerCase()
        ) {
          const pendingKey = `${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`;
          const pendingRaw = sqlite.get<string>(pendingKey);
          if (pendingRaw) {
            let pendingId: number | null = null;
            try {
              pendingId = (JSON.parse(pendingRaw) as { messageId?: number }).messageId ?? null;
            } catch {
              pendingId = null;
            }
            if (pendingId == null || pendingId <= message.id) sqlite.delete(pendingKey);
          }
        }
        const gatingTask: GroupTaskDaemonTask = {
          ...task,
          status: freshStatus,
          hasOpenCheckpoint,
          dispatchPaused: dispatchPausedAtTick || store.getTaskById(task.id)?.dispatchPausedAt != null,
        };
        const decisions = decideGroupTaskResponders(message, gatingTask, members, botsById, {
          entropyFloorGate: entropyP0.floorGate,
        });
        // Task #51 safety net: a chair decision means the chair owes this
        // message a response. The entry is cleared by chair speech (above) or
        // a completed chair turn (dispatchReplyTurn); if neither lands within
        // the redrive window the trigger is re-driven once via the defer
        // queue — covering triggers silently dropped by the per-tick chair
        // auto-reply cap, the Twin-suppression window, or a spent budget.
        const chairDecision = decisions.find((decision) =>
          members.find((candidate) => candidate.metabotId === decision.metabotId)?.role === 'chair');
        if (chairDecision && chairMemberId != null) {
          sqlite.set(
            `${CHAIR_RESPONSE_PENDING_PREFIX}${task.id}`,
            JSON.stringify({ messageId: message.id, reason: chairDecision.reason, atMs: now() }),
          );
        }
        // P0-1: review-phase silence hint — a chair dispatch to workers during
        // review is intentionally unanswered (workers are gated silent); log
        // it so the operator/chair reopens the task instead of assuming the
        // dispatch failed or the worker is broken. Same for an open HITL
        // checkpoint: resume with [CHECKPOINT_RESOLVED: ...].
        if (freshStatus === 'review' || hasOpenCheckpoint) {
          const silencedWorkers = members.filter((candidate) =>
            candidate.role === 'worker'
            && candidate.metabotId != null
            && botsById.get(candidate.metabotId) != null
            && isMentioned(message, botsById.get(candidate.metabotId)!),
          );
          if (silencedWorkers.length > 0) {
            const gatePrefix = freshStatus === 'review' ? 'review-phase silence' : 'checkpoint silence';
            const gateHint = freshStatus === 'review'
              ? 'task in REVIEW; reopen with [STATUS:EXECUTING] or the UI Back-to-work action'
              : 'HITL checkpoint open; resume with [CHECKPOINT_RESOLVED: <decision>] after the owner replies';
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: ${gatePrefix} — dispatch to ` +
              `${silencedWorkers.map((candidate) => candidate.name ?? candidate.metabotId).join(', ')} ` +
              `ignored (${gateHint})`,
            );
            // P1-2 (task #39): the log line above is invisible to the chair.
            // A dispatch swallowed by a human-gate phase otherwise reads as
            // "members ignore @mentions". Single-commander: the held-dispatch
            // FACT goes to the chair as an environment note (once per held
            // message) — the host does not explain itself in the group.
            const heldKey = `group_task_dispatch_held:${task.id}:${message.id}`;
            if (sqlite.get<string>(heldKey) !== '1') {
              const chairMemberForNotice = members.find((candidate) => candidate.role === 'chair');
              if (chairMemberForNotice?.metabotId != null) {
                sqlite.set(heldKey, '1');
                try {
                  const checkpointTopic = freshStatus === 'review'
                    ? null
                    : store.getOpenCheckpoint(task.id)?.topic ?? null;
                  store.recordHostNote({
                    taskId: task.id,
                    kind: 'dispatch_held',
                    target: message.senderName?.trim() || 'chair',
                    dedupeKey: `dispatch_held:${task.id}:${message.id}`,
                    body:
                      `Your dispatch in message #${message.id} to ${silencedWorkers
                        .map((candidate) => candidate.name ?? `bot-${candidate.metabotId}`)
                        .filter(Boolean)
                        .join(', ')} was NOT delivered to them: ${gateHint}` +
                      (checkpointTopic ? ` (open checkpoint topic: ${checkpointTopic})` : '') +
                      '. The members are gated silent, not ignoring you.',
                  });
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: dispatch-held environment note recorded for message ` +
                    `${message.id}`,
                  );
                } catch (error) {
                  sqlite.delete(heldKey); // transient record failure: retry on a later tick
                  emitLog(
                    `[GroupTaskDaemon] Task ${task.id}: dispatch-held note record failed: ` +
                    `${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              }
            }
          }
        }
        for (const decision of decisions) {
          const member = members.find((candidate) => candidate.metabotId === decision.metabotId);
          const bot = botsById.get(decision.metabotId);
          if (!member || !bot) continue;
          const isChair = member.role === 'chair';
          const key = keyOf(task.id, decision.metabotId);

          // Speedup R-03: a [DELIVERABLE] message whose candidates ALL folded
          // into earlier ledger rows (same author + same uri re-delivery)
          // needs no fresh chair verdict — skip the wake entirely.
          if (decision.reason === 'chair_deliverable'
              && sqlite.get<string>(`${DELIVERABLE_FOLDED_PREFIX}${task.id}:${message.id}`) === '1') {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: chair wake suppressed for message #${message.id} ` +
              '— duplicate deliverable folded into the existing ledger row',
            );
            continue;
          }

          // P2-7: a chair auto response (deliverable / floor control / owner
          // message) is suppressed when the Twin already replied to this message
          // on-chain OR spoke in the recent suppression window — the daemon must
          // not double-speak next to the Twin (round 2 covers replies without a
          // reply_pin and Twin speech on related messages).
          if (isChair && decision.reason !== 'chair_mentioned') {
            if (twinChairActive(db, task.id, task.groupId, message.pinId, chairGlobalMetaId)) {
              emitLog(`[GroupTaskDaemon] Task ${task.id}: Twin already spoke about message ${message.id}; skipping chair auto response`);
              continue;
            }
            if (chairAutoRepliesThisTick >= 1) {
              emitLog(`[GroupTaskDaemon] Task ${task.id}: chair auto-reply cap (1/tick) reached; skipping`);
              continue;
            }
          }

          if (!isChair && workerRepliesThisTick >= maxRepliesPerTaskPerTick) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: per-tick reply cap reached; deferring bot ${decision.metabotId} to a later tick`);
            deferReply({
              taskId: task.id,
              metabotId: decision.metabotId,
              messageId: message.id,
              reason: decision.reason,
              verificationNotes: [],
            });
            continue;
          }
          const lastReplyAt = lastReplyAtByKey.get(key) ?? 0;
          const cooldownMs = isChair ? chairCooldownMs : workerCooldownMs;
          if (now() - lastReplyAt < cooldownMs) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: bot ${decision.metabotId} in cooldown; deferring to a later tick`);
            deferReply({
              taskId: task.id,
              metabotId: decision.metabotId,
              messageId: message.id,
              reason: decision.reason,
              verificationNotes: decision.reason === 'chair_deliverable' ? verificationNotes : [],
            });
            continue;
          }
          if ((replyCountByKey.get(key) ?? 0) >= replyBudget) {
            emitLog(`[GroupTaskDaemon] Task ${task.id}: bot ${decision.metabotId} reply budget exhausted; skipping`);
            continue;
          }

          // Single-commander (task #64 follow-up): the [DEPENDS_ON] DISPATCH
          // GATE is gone — sequencing is solely the chair's judgment (its
          // playbook: assign a step only when its inputs are ready). The tag
          // stays declarative: the monitors still use it to exempt a
          // legitimately-waiting member from timeout flags. The worker turn
          // proceeds; if the upstream has not landed the worker (and the
          // chair, via its context) see that in the group log.

          // Verification facts travel with the deliverable that triggered the chair.
          const notesForDecision = decision.reason === 'chair_deliverable' ? verificationNotes : [];
          // fix/group-task-flow: a busy session queues the trigger durably
          // instead of blocking the tick behind the in-flight turn.
          if (turnInFlight.has(key)) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: bot ${decision.metabotId} has a turn in flight; ` +
              `queued message #${message.id} for a later tick`,
            );
            deferReply({
              taskId: task.id,
              metabotId: decision.metabotId,
              messageId: message.id,
              reason: decision.reason,
              verificationNotes: notesForDecision,
            });
            continue;
          }
          dispatchReplyTurn({
            task,
            member,
            bot,
            message,
            reason: decision.reason,
            promptMembers,
            chairGlobalMetaId,
            ownerGlobalMetaId,
            verificationNotes: notesForDecision,
            remoteStatusBlock,
            entry: null,
          });
          if (!isChair) {
            workerRepliesThisTick += 1;
          } else if (decision.reason !== 'chair_mentioned') {
            chairAutoRepliesThisTick += 1;
          }
        }
        // Round-4: cursor advances only on SUCCESSFUL processing.
        store.updateLastProcessedMsgId(task.id, message.id);
        noteDriveActivity(task.id); // a processed message is real drive work
        noteTickProgress(); // a processed message proves the in-flight tick is alive
        const retryKey = `${MSG_RETRY_PREFIX}${task.id}:${message.id}`;
        if (sqlite.get<number>(retryKey) != null) {
          sqlite.delete(retryKey); // recovered after earlier failures
        }
      } catch (error) {
        // fix/group-task-flow: responder turns are detached jobs now, so this
        // catch only covers SYNCHRONOUS processing failures (attribution,
        // protocol tags). Skill-turn watchdog handling lives in
        // dispatchReplyTurn (no retry; guard latched until the session idles).
        // Round-4 cursor semantics: lastProcessedMsgId is the id of the LAST
        // MESSAGE THE HOST SUCCESSFULLY PROCESSED — it only advances on
        // success. A failing message is retried on later ticks (bounded by a
        // kv failure counter) so a transient error never loses the message,
        // while a permanently broken message is dropped after
        // MSG_RETRY_MAX_FAILURES so it cannot stall the pipeline forever.
        // (row.id: the enriched message variable is scoped to the try block.)
        const retryKey = `${MSG_RETRY_PREFIX}${task.id}:${row.id}`;
        const failures = (Number(sqlite.get<number>(retryKey) ?? 0) || 0) + 1;
        sqlite.set(retryKey, failures);
        emitLog(
          `[GroupTaskDaemon] Task ${task.id}: message ${row.id} failed ` +
          `(attempt ${failures}/${MSG_RETRY_MAX_FAILURES}): ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
        if (failures >= MSG_RETRY_MAX_FAILURES) {
          sqlite.delete(retryKey);
          // GT#26 (stall incident): control tags must not die with the dropped
          // message. The chair's plan ended with [STATUS:EXECUTING] but every
          // attempt failed during the DSH stall storm (e.g. updateTaskStatus
          // hitting a busy DB), so the bounded retries gave up, the cursor
          // advanced, and the task stayed pinned in 'planning' while workers
          // already executed. Best-effort, idempotent tag-only reprocess of the
          // PERSISTED row: no attribution resolver (fall back to the stored
          // sender_global_metaid — an unattributable sender correctly keeps its
          // tags ignored), no reply generation, no cursor semantics of its own.
          // Only the durable local side effects (status transition, deliverable
          // rows, protocol markers) get one final chance to land.
          try {
            const rawMessage = toDaemonMessage(row);
            const tagMessage = await enrichMessageAttribution(rawMessage, memberGmids, ownerGlobalMetaId)
              .catch(() => rawMessage);
            await processMessageTags(task, tagMessage, members, botsById, promptMembers);
            handleMemberProtocolMarkers(task, tagMessage, members, botsById);
          } catch (tagError) {
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: dropped message ${row.id} tag reprocess failed: ` +
              `${tagError instanceof Error ? tagError.message : String(tagError)}`,
            );
          }
          store.updateLastProcessedMsgId(task.id, row.id);
          noteDriveActivity(task.id); // a settled (dropped) message is real drive work
          noteTickProgress();
          emitLog(
            `[GroupTaskDaemon] Task ${task.id}: message ${row.id} dropped after ` +
            `${failures} consecutive failures (cursor advanced past it)`,
          );
          // GT-10: a dropped message is permanent information loss — the origin
          // session must hear about it, not just the log file.
          notifySourceSessionMilestone(
            task,
            'anomaly',
            buildSourceSessionAnomalyNotice({
              title: task.title,
              status: task.status,
              summary:
                `Group message #${row.id} was dropped after ${failures} consecutive processing failures ` +
                '(its control tags were given one final best-effort reprocess). The pipeline continues, ' +
                'but that message\'s content is lost — check the daemon logs for the underlying error.',
            }),
            `message_dropped:${task.id}:${row.id}`,
          );
          // The poison message is out of the way: later messages may proceed.
          continue;
        }
        // Fail-stop (R2P1-4 review): later messages must wait behind the
        // failed one — otherwise their success would advance the cursor past
        // it and silently strand the pending retry forever.
        break;
      }
    }

    // #14 follow-up (single-commander): a straggler landing after review entry
    // no longer triggers a host closing line — the host is never a speaker.
    // The transcript ends on whatever the participants last said; the Tasks
    // acceptance card (from the recorded summary) is the authoritative
    // closing view. Kept as a log line for diagnosability.
    if (task.status === 'review' && task.groupId) {
      const chair = members.find((member) => member.role === 'chair');
      const chairGlobalMetaId = chair?.globalmetaid?.trim() || null;
      if (chair?.metabotId != null && chairGlobalMetaId) {
        const lastRow = queryRecentMessages(db, task.groupId, 1)[0];
        const lastSender = (lastRow?.sender_global_metaid ?? '').trim();
        if (lastRow && lastSender && lastSender !== chairGlobalMetaId) {
          const reassertKey = `${GROUP_TASK_REVIEW_REASSERT_KV_PREFIX}${task.id}`;
          if (String(sqlite.get(reassertKey) ?? '') !== String(lastRow.id)) {
            sqlite.set(reassertKey, String(lastRow.id));
            emitLog(
              `[GroupTaskDaemon] Task ${task.id}: straggler msg ${lastRow.id} landed after review entry — ` +
              'no host re-assert (single-commander); the acceptance card is the closing view',
            );
          }
        }
      }
    }
  };

  const runTick = async (): Promise<void> => {
    // fix/group-task-duration: deliver group messages queued behind a sponsor
    // broadcast reconciliation BEFORE processing tasks — a recovered send can
    // unblock a stalled task on this very tick.
    try {
      await drainPendingGroupSends();
    } catch (error) {
      emitLog(
        `[GroupTaskDaemon] Pending-send drain failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const store = deps.getGroupTaskStore();
    const activeTasks = store
      .listTasks()
      .filter((task) => task.status === 'planning' || task.status === 'executing' || task.status === 'review');
    // OpenTeam M2: tasks that left the active set (done/cancelled) drop their
    // presence snapshot and owner-notification flags, so a reactivated task
    // re-evaluates and re-notifies from scratch.
    const activeTaskIds = new Set(activeTasks.map((task) => task.id));
    for (const taskId of [...remotePresenceByTask.keys()]) {
      if (!activeTaskIds.has(taskId)) remotePresenceByTask.delete(taskId);
    }
    for (const key of [...remoteUnreachableNotified]) {
      if (!activeTaskIds.has(Number(key.slice(0, key.indexOf(':'))))) {
        remoteUnreachableNotified.delete(key);
      }
    }
    // fix/group-task-flow: tasks that left the active set drop their durable
    // defer queue too — a done/cancelled task must never resurrect queued replies.
    for (const task of store.listTasks()) {
      if (!activeTaskIds.has(task.id)) saveDeferredQueue(task.id, []);
    }
    for (const task of activeTasks) {
      try {
        await processTask(task);
      } catch (error) {
        emitLog(
          `[GroupTaskDaemon] Task ${task.id} tick failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const runGuardedTick = (): void => {
    // Tick watchdog (fix/group-member-status): a hung await inside runTick
    // (a promise that never settles — observed in the wild as the loop going
    // silently idle for hours) used to brick the daemon forever: `ticking`
    // stayed true and every later interval call early-returned. The check is
    // INACTIVITY-based: if the in-flight tick has shown no observable progress
    // (group send / cursor advance) for the whole watchdog window, log loudly
    // and resume the loop. A healthy long tick keeps refreshing its progress
    // heartbeat, so legitimate multi-turn batches never trip it (review
    // feedback: a duration-based 30-min window could fire under a legit pair
    // of 30-min skill turns and double-dispatch the pending messages). The
    // epoch guard keeps the hung tick's late `.finally` from clearing a NEWER
    // tick's flag; the dangling promise itself is left to rot.
    if (ticking) {
      if (now() - tickLastProgressAtMs > tickWatchdogMs) {
        emitLog(
          `[GroupTaskDaemon] Tick watchdog: tick #${tickEpoch} made no progress for ` +
          `${Math.round(tickWatchdogMs / 60_000)} min — resetting the loop ` +
          '(a dangling await may still be in flight)',
        );
        ticking = false;
      } else {
        return;
      }
    }
    ticking = true;
    tickLastProgressAtMs = now();
    tickEpoch += 1;
    const epoch = tickEpoch;
    void runTick()
      .catch((error) => {
        emitLog(`[GroupTaskDaemon] Tick failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (tickEpoch === epoch) ticking = false;
      });
  };

  return {
    runTick,
    whenIdle,
    getTurnActivity: () => currentTurnActivity(),
    start() {
      if (timer) return;
      runGuardedTick();
      timer = setInterval(runGuardedTick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // fix/group-task-flow: release the post-timeout session latch watchers
      // with the loop so a stopped daemon never holds timers alive.
      for (const watcher of latchWatchers) clearInterval(watcher);
      latchWatchers.clear();
    },
    isRunning() {
      return timer !== null;
    },
  };
}

let activeDaemonLoop: GroupTaskDaemonLoop | null = null;

export function startGroupTaskDaemon(deps: GroupTaskDaemonDeps): void {
  stopGroupTaskDaemon();
  activeDaemonLoop = createGroupTaskDaemonLoop(deps);
  activeDaemonLoop.start();
}

export function stopGroupTaskDaemon(): void {
  activeDaemonLoop?.stop();
  activeDaemonLoop = null;
}

export function isGroupTaskDaemonRunning(): boolean {
  return Boolean(activeDaemonLoop?.isRunning());
}

/** Sidebar badge: current in-flight MetaBot background turns ([] when no daemon). */
export function getGroupTaskTurnActivity(): GroupTaskTurnActivityEntry[] {
  return activeDaemonLoop?.getTurnActivity() ?? [];
}
