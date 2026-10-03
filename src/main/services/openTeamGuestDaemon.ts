/**
 * OpenTeam guest daemon (M1): watches group_chat_messages for every active
 * openteam_memberships row and lets the invited bot answer when @-mentioned,
 * exactly like a local group-task worker would. M3/P1-2 adds a periodic
 * on-chain membership self-check (default 5 min) that marks the membership
 * left when this bot has disappeared from the group member list — the fallback
 * for the chair's one-way [OPENTEAM_KICK] simplemsg. Two guards keep indexer
 * lag from killing a healthy membership: a fresh (re-)activation skips the
 * check for a grace window (default 15 min, anchored at activated_at), and
 * only 2 consecutive absence reads mark the membership left.
 *
 * Modeled on groupTaskDaemon's structure (5s tick, single-tick re-entry guard,
 * module-level start/stop singleton, same mention gating via
 * groupChatMentionUtils) but deliberately leaner: no chair/worker protocol, no
 * orchestration, no session channel. Loop prevention comes from the per-
 * membership cursor (openteam_memberships.last_processed_msg_id, monotonic),
 * the self-message skip, and a per-membership reply cooldown. The cursor only
 * advances past messages that were actually processed: a cooldown-blocked
 * mention is re-evaluated on a later tick (answered once the cooldown has
 * elapsed), and a send/generation failure is retried next tick — bounded, so
 * the same message is abandoned after 3 consecutive failures. A reply starting
 * with [NO_REPLY] is suppressed (not sent on-chain), same escape hatch as the
 * group-task daemon.
 *
 * M3 scope note: chat-skill turns are wired through the same narrow seams the
 * group-task daemon uses (getChatSkillsRoutingPrompt + runSkillTurn, backed by
 * runSkillTurnInExistingSession in main.ts). Routing stays on the bot's OWN
 * assigned skills (widened is never set — external group members are
 * not the owner, so the permission surface matches a non-owner private-chat
 * peer). Any routing/execution failure degrades to the plain LLM completion
 * path so skill assembly can never silence the guest. Files produced by a
 * skill turn are uploaded on-chain as metafiles (guest bot's own wallet pays,
 * via the metaFileUploadService path the private-chat order flow uses) and
 * delivered as `[DELIVERABLE] metafile: metafile://<pinId><ext>` lines — the
 * exact shape the inviter-side groupTaskDeliverableParser ingests.
 * Session/experience recording is likewise left to later milestones.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type { CoworkSession, CoworkStore } from '../coworkStore';
import type {
  OpenTeamMembership,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import { metabotBrainOptions, normalizeMetabotLlmId } from './llmFallback';
import { isMentioned } from './groupChatMentionUtils';
import { isOpenTeamTaskStatusTerminal, parseOpenTeamTaskStatusTag } from '../libs/openTeamTaskStatus';
import { buildOpenTeamGuestPrompt } from './openTeamGuestPrompt';
import { ensureOpenTeamGuestSession, corruptSessionLogSignature, isCorruptSessionLogError } from './groupTaskSession';
import {
  buildMinimalSelfCognitionBlocks,
  RECENT_SUMMARIES_PROMPT_DAYS,
} from '../libs/experiencePromptBlocks';
import type { MemoryUsageClass } from '../memory/memoryScope';
import {
  buildGuestMetafileDeliverableLine,
  buildGuestNoteDeliverableLine,
  collectGuestDeliverableFiles,
  DEFAULT_MAX_DELIVERABLE_FILES,
} from './openTeamGuestDeliverables';
import { isTextDocumentDeliverable } from './deliverableTextNote';

/** Escape hatch: a reply starting with the [NO_REPLY] tag is suppressed (not sent on-chain). */
const NO_REPLY_PATTERN = /^\[NO_REPLY\]/i;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_COOLDOWN_MS = 20_000;
/**
 * R5 (OpenTeam chat scenario): chat groups run a shorter reply cooldown —
 * task cadence (20s) reads as lag in a live conversation, while the loop
 * insurance that cooldown provides still holds (self-message skip + prompt
 * etiquette + [NO_REPLY]).
 */
const DEFAULT_CHAT_COOLDOWN_MS = 8_000;
const DEFAULT_CONTEXT_MESSAGE_COUNT = 20;
/** Bounded retry: consecutive failures on one message before the cursor gives up and advances past it. */
const MAX_CONSECUTIVE_MESSAGE_FAILURES = 3;
/** fix-v2 P1-5: one corrupt-log guest-session rebuild per membership per hour (same cap as the group-task host side). */
const CORRUPT_SESSION_REBUILD_MIN_INTERVAL_MS = 60 * 60_000;
/**
 * P1-2 self-check fallback: how often each active membership re-verifies on-chain
 * that this bot is still a group member (the KICK simplemsg may never arrive).
 */
const DEFAULT_MEMBERSHIP_CHECK_INTERVAL_MS = 5 * 60_000;
/**
 * Activation grace: a fresh (re-)activation skips the self-check for this long.
 * The indexer takes minutes to absorb the join pin into the member list (the
 * inviter-side join-confirmation budget is 10 min for the same reason), so an
 * early absence read would mark a brand-new membership left by mistake.
 */
const DEFAULT_MEMBERSHIP_SELF_CHECK_GRACE_MS = 15 * 60_000;
/**
 * Confirmed-absence threshold: a single missing member-list read can be
 * indexer lag; only this many CONSECUTIVE absence results mark the membership
 * left.
 */
const MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD = 2;

/** Cowork conversation-mapping channel for the guest's per-group skill sessions. */
const CONVERSATION_CHANNEL = 'openteam_guest';

// ---------------------------------------------------------------------------
// Pure gating (exported for tests)
// ---------------------------------------------------------------------------

export interface OpenTeamGuestDaemonMessage {
  id: number;
  pinId: string | null;
  senderMetaId: string;
  senderGlobalMetaId: string | null;
  senderName: string;
  content: string;
  chainTimestamp?: number | null;
  replyPin?: string | null;
  /** Raw mention column (JSON array string). */
  mention: string | null;
}

export type OpenTeamGuestDecision =
  | { respond: true; reason: 'mentioned' | 'chat_direct' }
  | {
    respond: false;
    reason: 'self_message' | 'empty_content' | 'not_mentioned' | 'protocol_line' | 'cooldown';
  };

/**
 * R2 (OpenTeam chat scenario): protocol-only content filter. A message whose
 * every non-empty line starts with a known ASCII protocol tag ([STATUS:...],
 * [DELIVERABLE], [WORKING], host notices, ...) is ledger/protocol traffic,
 * never a conversational turn — in chat mode it must not wake the guest. The
 * check is tag-structural only (no natural-language intent matching): one
 * prose line anywhere makes the message conversational again.
 */
const OPENTEAM_PROTOCOL_TAG_LINE_RE =
  /^\[(?:STATUS|NO_REPLY|DELIVERABLE|WORKING|STANDBY|PLAN_CHANGE|CHECKPOINT(?:_RESOLVED)?|FREEZE|POSITION|GROUP_TASK_NOTICE|OPENTEAM_[A-Z_]+)[^\]]*\]/i;

export function isOpenTeamProtocolOnlyContent(content: string): boolean {
  const lines = String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  return lines.every((line) => OPENTEAM_PROTOCOL_TAG_LINE_RE.test(line));
}

/**
 * Guest gating. Task mode (default, unchanged): answer only messages that
 * @-mention this bot. Chat mode (R2): also answer direct conversational
 * messages from the inviter/chair without an @ — the structural-silence fix
 * for the 2026-09-08 incident (a no-@ welcome went unanswered for 10.5
 * minutes). In chat mode, protocol-only lines never wake the guest and other
 * members still need an @ (multi-guest storm insurance — the model stays the
 * intent judge via the [NO_REPLY] escape). Never the bot's own messages,
 * never empty content, and not while the per-membership cooldown runs.
 */
export function decideOpenTeamGuestResponse(input: {
  message: OpenTeamGuestDaemonMessage;
  bot: { name: string; globalmetaid: string | null; metaid?: string };
  lastReplyAt: number;
  now: number;
  cooldownMs: number;
  /** R2: group mode; absent = task (legacy memberships). */
  mode?: 'task' | 'chat';
  /** R2: the inviter/chair globalMetaId recorded on the membership. */
  inviterGlobalMetaId?: string | null;
}): OpenTeamGuestDecision {
  const { message, bot } = input;
  const content = (message.content ?? '').trim();
  if (!content) return { respond: false, reason: 'empty_content' };
  const senderGlobalMetaId = (message.senderGlobalMetaId ?? '').trim();
  if (
    senderGlobalMetaId
    && bot.globalmetaid?.trim()
    && senderGlobalMetaId === bot.globalmetaid.trim()
  ) {
    return { respond: false, reason: 'self_message' };
  }
  const mentioned = isMentioned(message, bot);
  if (input.mode !== 'chat') {
    // Task mode: byte-identical legacy gate — mentions only.
    if (!mentioned) return { respond: false, reason: 'not_mentioned' };
    if (input.now - input.lastReplyAt < input.cooldownMs) {
      return { respond: false, reason: 'cooldown' };
    }
    return { respond: true, reason: 'mentioned' };
  }
  // Chat mode (R2): protocol-only lines (bare [STATUS:...]/[DELIVERABLE]/
  // notice lines) are lifecycle traffic, never conversation — skip them even
  // when they carry an @. Everything else from the INVITER/chair is direct
  // conversation without an @; other members still need an @ (storm
  // insurance — the model stays the intent judge via [NO_REPLY]).
  if (isOpenTeamProtocolOnlyContent(content)) {
    return { respond: false, reason: 'protocol_line' };
  }
  const inviterKey = (input.inviterGlobalMetaId ?? '').trim().toLowerCase();
  const senderKey = senderGlobalMetaId.toLowerCase();
  if (!mentioned && !(inviterKey && senderKey === inviterKey)) {
    return { respond: false, reason: 'not_mentioned' };
  }
  if (input.now - input.lastReplyAt < input.cooldownMs) {
    return { respond: false, reason: 'cooldown' };
  }
  return { respond: true, reason: mentioned ? 'mentioned' : 'chat_direct' };
}

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

export type OpenTeamGuestPerformChatFn = (
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
  },
) => Promise<string>;

export type OpenTeamGuestSendGroupMessageFn = (
  metabotId: number,
  groupId: string,
  opts: { content: string; nickName?: string },
) => Promise<{ pinId: string }>;

/** Narrow skill-routing seam (same shape as groupTaskDaemon's; wired to skillManager.buildChatSkillsRoutingPrompt). */
export type OpenTeamGuestSkillRoutingFn = (input: {
  metabotId?: number | null;
  widened?: boolean;
}) =>
  | { prompt: string | null; activeSkillIds: string[] }
  | Promise<{ prompt: string | null; activeSkillIds: string[] }>;

/**
 * Narrow skill-turn seam (wired to runSkillTurnInExistingSession in main.ts).
 * `cwd` is the working directory the turn ran in — the delivery step resolves
 * mentioned file paths and scans for generated files against it.
 */
export type OpenTeamGuestRunSkillTurnFn = (params: {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  activeSkillIds: string[];
}) => Promise<{ replyText: string; assistantMessageId?: string | null; cwd?: string | null }>;

/**
 * Narrow metafile upload seam (wired to metaFileUploadService.uploadMetaFile
 * in main.ts). The GUEST bot's own wallet (metabotId) pays the upload, exactly
 * like the private-chat order delivery path.
 */
export type OpenTeamGuestUploadFileFn = (input: {
  metabotId: number;
  filePath: string;
  contentType?: string;
}) => Promise<Record<string, unknown>>;

/**
 * Narrow simplenote publish seam (wired to
 * deliverableTextNote.publishTextFileAsNote in main.ts). MetaWeb URI
 * convention: readable text deliverables (Markdown / plain text) go on-chain
 * as simplenote notes cited pin:// — metafile:// is reserved for binary
 * payloads. The GUEST bot's own wallet pays the note pin.
 */
export type OpenTeamGuestPublishTextFn = (input: {
  metabotId: number;
  filePath: string;
  contentType?: string;
}) => Promise<{ pinId?: string } | null | undefined>;

export interface OpenTeamGuestDaemonSqliteLike {
  getDatabase(): Database;
}

/** Narrow memory read (owner scope, created status) for the plain-path minimal self-cognition pack. */
export type OpenTeamGuestListUserMemoriesFn = (
  metabotId: number,
  input: { usageClass?: MemoryUsageClass; limit: number },
) => Array<{ text: string }>;

/** Recent dream summaries (newest first) for the plain-path minimal self-cognition pack. */
export type OpenTeamGuestListDailySummariesFn = (
  metabotId: number,
  limit: number,
) => Array<{ summaryDate: string; summaryText: string }>;

export interface OpenTeamGuestDaemonDeps {
  getStore: () => OpenTeamGuestDaemonSqliteLike;
  getMetabotStore: () => MetabotStore;
  getOpenTeamMembershipStore: () => OpenTeamMembershipStore;
  performChat: OpenTeamGuestPerformChatFn;
  sendGroupMessage: OpenTeamGuestSendGroupMessageFn;
  /**
   * R4 single-send guarantee: true when this (bot, group) already sent a group
   * message after sinceMs (the outgoing-send ledger wired in main.ts). Unwired
   * = the suppression is disabled (plain behavior).
   */
  hasSentToGroupSince?: (metabotId: number, groupId: string, sinceMs: number) => boolean;
  /**
   * M3 skill machinery — all three must be wired for chat-skill turns; unwired
   * (or failing) the daemon stays on the plain LLM completion path.
   */
  getChatSkillsRoutingPrompt?: OpenTeamGuestSkillRoutingFn;
  runSkillTurn?: OpenTeamGuestRunSkillTurnFn;
  /** M3 file delivery; unwired = skill turns run but files are not uploaded/delivered. */
  uploadDeliverableFile?: OpenTeamGuestUploadFileFn;
  /**
   * M3 text-document delivery: readable text files (Markdown / plain text)
   * are published as simplenote notes (pin://) instead of /file metafiles.
   * Unwired (or returning null) = text documents fall back to the metafile
   * upload path.
   */
  publishTextDeliverable?: OpenTeamGuestPublishTextFn;
  /**
   * P1-2 self-check fallback: group member-list read (wired to
   * groupChatTransport.fetchGroupMembers in main.ts). Unwired = the periodic
   * on-chain membership self-check stays off.
   */
  fetchGroupMembers?: (groupId: string) => Promise<string[] | null>;
  /** Self-check cadence per membership (default 5 min). */
  membershipCheckIntervalMs?: number;
  /**
   * Post-activation grace during which the self-check is skipped entirely
   * (default 15 min; covers the indexer lag in absorbing the join pin).
   */
  membershipSelfCheckGraceMs?: number;
  /** Cap on metafile deliverables appended per turn (default DEFAULT_MAX_DELIVERABLE_FILES). */
  maxDeliverableFilesPerTurn?: number;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  cooldownMs?: number;
  /** R5: chat-mode reply cooldown (default 8s; task mode keeps 20s). */
  chatCooldownMs?: number;
  contextMessageCount?: number;
  /**
   * P1-3: when wired, guest turns are logged into the eager session created at
   * invite-accept time (context continuity; the session also carries the
   * injected group context snapshot). Also used by the M3 skill-turn path.
   */
  getCoworkStore?: () => CoworkStore;
  /**
   * Memory/dream reads for the minimal self-cognition pack (self-identity +
   * recent dream summaries) appended to the PLAIN completion path only. Skill
   * turns are excluded: they run through the cowork runner, which injects the
   * full experience block into the turn tail itself. Unwired = no pack.
   */
  listUserMemories?: OpenTeamGuestListUserMemoriesFn;
  listDailySummaries?: OpenTeamGuestListDailySummariesFn;
  /**
   * Per-bot memory policy (parity with the group-task/private-chat paths):
   * memoryEnabled=false gates the self-cognition pack off. Unwired = enabled.
   */
  getEffectiveMemoryPolicy?: (metabotId: number) => { memoryEnabled: boolean } | null | undefined;
}

export interface OpenTeamGuestDaemonLoop {
  runTick(): Promise<void>;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

interface GroupChatMessageRow {
  id: number;
  pin_id: string | null;
  sender_metaid: string | null;
  sender_global_metaid: string | null;
  sender_name: string | null;
  content: string | null;
  mention: string | null;
  chain_timestamp: number | null;
  reply_pin: string | null;
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

function toDaemonMessage(row: GroupChatMessageRow): OpenTeamGuestDaemonMessage {
  return {
    id: row.id,
    pinId: row.pin_id ?? null,
    senderMetaId: (row.sender_metaid ?? '').trim(),
    senderGlobalMetaId: row.sender_global_metaid ?? null,
    senderName: (row.sender_name ?? '').trim() || 'Unknown',
    content: (row.content ?? '').trim(),
    mention: row.mention ?? null,
    chainTimestamp: row.chain_timestamp ?? null,
    replyPin: row.reply_pin ?? null,
  };
}

/** sqlite UTC text ('YYYY-MM-DD HH:MM:SS', optionally with .SSS) -> epoch ms. */
const parseSqliteUtcMs = (value: string | null): number => {
  if (!value) return Number.NaN;
  const parsed = Date.parse(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export function createOpenTeamGuestDaemonLoop(deps: OpenTeamGuestDaemonDeps): OpenTeamGuestDaemonLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const cooldownMs = Math.max(0, Math.trunc(deps.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  const chatCooldownMs = Math.max(0, Math.trunc(deps.chatCooldownMs ?? DEFAULT_CHAT_COOLDOWN_MS));
  const contextMessageCount = Math.max(1, Math.trunc(deps.contextMessageCount ?? DEFAULT_CONTEXT_MESSAGE_COUNT));
  const membershipCheckIntervalMs = Math.max(
    1_000,
    Math.trunc(deps.membershipCheckIntervalMs ?? DEFAULT_MEMBERSHIP_CHECK_INTERVAL_MS),
  );
  const membershipSelfCheckGraceMs = Math.max(
    0,
    Math.trunc(deps.membershipSelfCheckGraceMs ?? DEFAULT_MEMBERSHIP_SELF_CHECK_GRACE_MS),
  );
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());

  // Loop prevention state (in-memory, per loop instance; the durable half is
  // the membership cursor in openteam_memberships).
  const lastReplyAtByMembership = new Map<number, number>();
  /** Consecutive send/generation failure streak per membership (bounded retry). */
  const consecutiveFailuresByMembership = new Map<number, { messageId: number; count: number }>();
  /** P1-2 self-check: last on-chain membership verification per membership. */
  const membershipCheckedAtByMembership = new Map<number, number>();
  /** P1-2 self-check: consecutive absence streak per membership (confirmed kick). */
  const membershipAbsenceStreakByMembership = new Map<number, number>();

  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  /** One-time-per-run transcript backfill of the host-task status (below). */
  let taskStatusBackfillDone = false;

  /**
   * Host-task status sync: the chair drives the host-side state machine with
   * `[STATUS:EXECUTING|REVIEW]` group messages and closeGroupTask posts a
   * deterministic `[STATUS:DONE|CANCELLED]` close-out. The newest chair-sent
   * tag in the transcript is the membership's task_status. Legacy rows (tag
   * pre-dates this feature) are re-derived once per daemon start from the
   * already-indexed transcript — this is what un-sticks the eternal "active"
   * badge for pre-existing memberships.
   */
  const backfillTaskStatusesFromTranscript = (): void => {
    const membershipStore = deps.getOpenTeamMembershipStore();
    for (const membership of membershipStore.listMembershipsWithUnknownTaskStatus()) {
      try {
        const derived = membershipStore.deriveLatestChairTaskStatus(
          membership.groupId,
          membership.inviterGlobalmetaid,
        );
        if (derived && membershipStore.updateMembershipTaskStatus(membership.groupId, membership.metabotId, derived)) {
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: host task status backfilled ` +
            `from the transcript: ${derived}`,
          );
        }
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: task-status backfill failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const queryNewMessages = (db: Database, groupId: string, afterId: number): GroupChatMessageRow[] =>
    mapMessageRows(db.exec(
      `SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin
       FROM group_chat_messages
       WHERE group_id = ? AND id > ?
       ORDER BY id ASC`,
      [groupId, afterId],
    ));

  const queryRecentMessages = (db: Database, groupId: string, limit: number): GroupChatMessageRow[] => {
    const rows = mapMessageRows(db.exec(
      `SELECT id, pin_id, sender_metaid, sender_global_metaid, sender_name, content, mention,
              chain_timestamp, reply_pin
       FROM group_chat_messages
       WHERE group_id = ?
       ORDER BY id DESC LIMIT ?`,
      [groupId, limit],
    ));
    return rows.reverse();
  };

  /** Per-turn local time line (mirrors groupTaskDaemon's formatTurnTimeText). */
  const formatTurnTimeText = (): string => {
    const date = new Date(now());
    const pad = (value: number): string => String(value).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const utcOffset = `${sign}${Math.floor(Math.abs(offsetMinutes) / 60)}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
    const weekday = date.toLocaleDateString('en-US', { weekday: 'long' });
    return `Current local time: ${local} (UTC${utcOffset}, ${timezone}), ${weekday}`;
  };

  const buildGroupLogUserMessage = (
    db: Database,
    membership: OpenTeamMembership,
    triggering: OpenTeamGuestDaemonMessage,
  ): string => {
    const recent = queryRecentMessages(db, membership.groupId, contextMessageCount);
    const lines = recent.map((row) => {
      const message = toDaemonMessage(row);
      const line = `${message.senderName}: ${message.content}`;
      return row.id === triggering.id
        ? `>>> ${line} <<< (the message you are responding to)`
        : line;
    });
    const taskTitle = (membership.taskTitle ?? '').trim() || '(untitled task)';
    return [
      formatTurnTimeText(),
      '',
      `[OpenTeam group task "${taskTitle}" — recent group log (last ${contextMessageCount} messages)]`,
      ...(lines.length > 0 ? lines : ['(no messages yet)']),
    ].join('\n');
  };

  const maxDeliverableFilesPerTurn = Math.max(
    1,
    Math.trunc(deps.maxDeliverableFilesPerTurn ?? DEFAULT_MAX_DELIVERABLE_FILES),
  );

  /**
   * Per-membership cowork session for skill turns (mirrors groupTaskDaemon's
   * ensureTaskSession, keyed on the external group id instead of a local
   * group_tasks row).
   */
  const createGuestSession = (
    coworkStore: CoworkStore,
    membership: OpenTeamMembership,
    bot: Metabot,
    rebuilt: boolean,
  ): CoworkSession => {
    const config = coworkStore.getConfig();
    const workspaceRoot = resolveSessionWorkingDirectory(
      (config.workingDirectory ?? '').trim() || process.cwd(),
      bot.id,
    );
    const taskTitle = (membership.taskTitle ?? '').trim() || '(untitled task)';
    const session = coworkStore.createSession(
      `OpenTeam Guest "${taskTitle}" (${bot.name})${rebuilt ? ' [rebuilt]' : ''}`,
      workspaceRoot,
      '',
      config.executionMode || 'local',
      [],
      bot.id,
      'group_task',
      null,
      null,
      null,
    );
    coworkStore.upsertConversationMapping({
      channel: CONVERSATION_CHANNEL,
      externalConversationId: `openteam-guest:${membership.groupId}`,
      metabotId: bot.id,
      coworkSessionId: session.id,
      metadataJson: JSON.stringify({ groupId: membership.groupId }),
    });
    return session;
  };

  const ensureGuestSession = (
    coworkStore: CoworkStore,
    membership: OpenTeamMembership,
    bot: Metabot,
  ): CoworkSession => {
    const externalConversationId = `openteam-guest:${membership.groupId}`;
    const existing = coworkStore.getConversationMapping(CONVERSATION_CHANNEL, externalConversationId, bot.id);
    if (existing) {
      const session = coworkStore.getSession(existing.coworkSessionId);
      if (session) return session;
    }
    return createGuestSession(coworkStore, membership, bot, false);
  };

  /**
   * fix-v2 P1-5: a corrupt DSH session log (driver-handoff race, task #57)
   * fails every turn on the guest session forever. The guest needs no ledger
   * seed — its context is rebuilt from the group transcript on every turn —
   * so recovery is simply a fresh session under the same workspace; the old
   * session row stays for post-mortem. Returns null when the rebuild was
   * rate-capped (one per membership per hour).
   */
  const lastCorruptRebuildAtByMembership = new Map<number, number>();
  /** Guidance line rides the same once-per-hour cadence as the rebuild itself. */
  const lastCorruptGuidanceAtByMembership = new Map<number, number>();
  const rebuildGuestSession = (
    coworkStore: CoworkStore,
    membership: OpenTeamMembership,
    bot: Metabot,
  ): CoworkSession | null => {
    const lastRebuildAt = lastCorruptRebuildAtByMembership.get(membership.id) ?? 0;
    if (now() - lastRebuildAt <= CORRUPT_SESSION_REBUILD_MIN_INTERVAL_MS) return null;
    lastCorruptRebuildAtByMembership.set(membership.id, now());
    return createGuestSession(coworkStore, membership, bot, true);
  };

  /**
   * M3 file delivery: publish the skill turn's file artifact(s) on-chain and
   * append one `[DELIVERABLE]` line per file. Protocol follows content kind
   * (MetaWeb URI convention): readable text documents become simplenote notes
   * (`note: pin://<pinId>`), binary files become metafiles
   * (`metafile: metafile://<pinId><ext>`). Upload problems never suppress or
   * rewrite the text reply — failed files are called out in a plain
   * (untagged) sentence so no fake deliverable rows can be ingested on the
   * inviter side.
   */
  const appendFileDeliverables = async (input: {
    bot: Metabot;
    reply: string;
    cwd: string;
    turnStartedAt: number;
    turnCompletedAt: number;
  }): Promise<string> => {
    const files = collectGuestDeliverableFiles({
      texts: [input.reply],
      cwd: input.cwd,
      // The allowlist root IS the guest session workspace (the daemon wiring
      // runs the skill turn there): anything outside is dropped + logged.
      allowedRoot: input.cwd,
      emitLog,
      turnStartedAt: input.turnStartedAt,
      turnCompletedAt: input.turnCompletedAt,
      maxFiles: maxDeliverableFilesPerTurn,
    });
    if (files.length === 0) return input.reply;

    const deliverableLines: string[] = [];
    const failedNames: string[] = [];
    for (const file of files) {
      try {
        // MetaWeb URI convention: readable text documents (Markdown / plain
        // text) are published as simplenote notes and delivered as pin://;
        // metafile:// is reserved for binary payloads. A note publish yielding
        // no pinId (oversized/unreadable doc) falls through to the metafile
        // upload so the file still gets delivered on-chain.
        const preferTextNote = deps.publishTextDeliverable != null
          && isTextDocumentDeliverable(file.filePath, file.contentType);
        let line: string | null = null;
        if (preferTextNote) {
          const published = await deps.publishTextDeliverable!({
            metabotId: input.bot.id,
            filePath: file.filePath,
            contentType: file.contentType,
          });
          const notePinId = typeof published?.pinId === 'string' ? published.pinId.trim() : '';
          line = notePinId
            ? buildGuestNoteDeliverableLine({ pinId: notePinId, fileName: file.fileName })
            : null;
        }
        if (!line && deps.uploadDeliverableFile) {
          const upload = await deps.uploadDeliverableFile({
            metabotId: input.bot.id,
            filePath: file.filePath,
            contentType: file.contentType,
          });
          const pinId = typeof upload?.pinId === 'string' ? upload.pinId.trim() : '';
          line = pinId
            ? buildGuestMetafileDeliverableLine({
              pinId,
              fileName: file.fileName,
              contentType: file.contentType,
            })
            : null;
        }
        if (line) {
          deliverableLines.push(line);
        } else {
          failedNames.push(file.fileName);
          emitLog(
            `[OpenTeamGuestDaemon] Bot ${input.bot.id}: on-chain publish for ${file.fileName} produced no deliverable line`,
          );
        }
      } catch (error) {
        failedNames.push(file.fileName);
        emitLog(
          `[OpenTeamGuestDaemon] Bot ${input.bot.id}: on-chain publish for ${file.fileName} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (deliverableLines.length === 0 && failedNames.length === 0) return input.reply;
    return [
      input.reply,
      ...deliverableLines,
      ...(failedNames.length > 0
        ? [`(On-chain publish failed for: ${failedNames.join(', ')} — generated locally but not delivered on-chain; ask me to retry if needed.)`]
        : []),
    ].join('\n');
  };

  const generateAndSendGuestReply = async (
    membership: OpenTeamMembership,
    bot: Metabot,
    message: OpenTeamGuestDaemonMessage,
  ): Promise<void> => {
    const db = deps.getStore().getDatabase();
    // #13: the guest prompt carries WHY this bot was invited (goal summary +
    // required skills from the guest-side invite history row, looked up by the
    // invite pin echoed on the membership) — plus the greet-first rule in the
    // playbook, so the guest's first group message is a presence greeting.
    let whyContext: { goalSummary?: string | null; requiredSkills?: string[] } = {};
    if (membership.invitePinId) {
      try {
        const guestInvite = deps.getOpenTeamMembershipStore().getGuestInviteByPinId(membership.invitePinId);
        whyContext = {
          goalSummary: guestInvite?.goalSummary ?? undefined,
          requiredSkills: guestInvite?.requiredSkills?.length ? guestInvite.requiredSkills : undefined,
        };
      } catch {
        whyContext = {};
      }
    }
    const systemPrompt = buildOpenTeamGuestPrompt({
      metabot: bot,
      membership: {
        groupId: membership.groupId,
        taskTitle: membership.taskTitle,
        inviterGlobalmetaid: membership.inviterGlobalmetaid,
        // R3: chat mode swaps the task playbook for the chat playbook.
        groupMode: membership.groupMode === 'chat' ? 'chat' : 'task',
        ...whyContext,
      },
    });
    const userMessage = buildGroupLogUserMessage(db, membership, message);

    // Minimal self-cognition pack (dream-written self-identity + recent dream
    // summaries) for the PLAIN completion path: without it the guest prompt
    // carries persona facts but none of the bot's dream-distilled "who am I".
    // Skill turns are excluded — the cowork runner injects the full experience
    // block into the turn tail itself, and a copy here would double it. Gated
    // on the bot's memory policy (parity with the group-task path).
    const buildSelfCognitionSection = (): string => {
      if (!deps.listUserMemories && !deps.listDailySummaries) return '';
      if (deps.getEffectiveMemoryPolicy?.(bot.id)?.memoryEnabled === false) return '';
      try {
        return buildMinimalSelfCognitionBlocks({
          identityText: deps.listUserMemories?.(bot.id, { usageClass: 'self_identity', limit: 1 })?.[0]?.text ?? null,
          summaries: deps.listDailySummaries?.(bot.id, RECENT_SUMMARIES_PROMPT_DAYS) ?? [],
        });
      } catch {
        return '';
      }
    };
    const selfCognitionSection = buildSelfCognitionSection();

    // Skill routing (mirrors groupTaskDaemon): when the bot has chat skills
    // enabled and routing hits, run ONE skill turn in the guest's cowork
    // session; otherwise (or on any routing failure) fall back to the plain
    // completion path.
    let routing: { prompt: string | null; activeSkillIds: string[] } = { prompt: null, activeSkillIds: [] };
    if (deps.getChatSkillsRoutingPrompt && deps.runSkillTurn && deps.getCoworkStore) {
      try {
        routing = await deps.getChatSkillsRoutingPrompt({
          metabotId: bot.id,
          // External group members are never the owner: only the bot's
          // assigned skills are routable — the exact permission surface a
          // non-owner private-chat peer gets. Nothing is widened.
          widened: false,
        });
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: skill routing failed for bot ${bot.id}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const canRunSkillTurn = Boolean(
      routing.prompt && routing.activeSkillIds.length > 0 && deps.runSkillTurn && deps.getCoworkStore,
    );

    let reply = '';
    let skillTurn: { cwd: string; startedAt: number; completedAt: number } | null = null;
    // R4: anchored BEFORE the turn — the mid-turn send check asks "did this
    // (bot, group) send anything after this moment".
    const skillTurnStartedAt = now();
    const skillTurnAttempted = canRunSkillTurn;
    /** P1-3 mirror-session logging (shared by the send and suppression paths). */
    const logTurnToMirrorSession = (user: string, finalReply: string): void => {
      if (!deps.getCoworkStore) return;
      try {
        const coworkStore = deps.getCoworkStore();
        const { session } = ensureOpenTeamGuestSession(
          coworkStore,
          bot.id,
          bot.name?.trim() || `bot-${bot.id}`,
          { groupId: membership.groupId, taskTitle: membership.taskTitle },
        );
        coworkStore.addMessage(session.id, { type: 'user', content: user, metadata: { origin: 'group_task' } });
        coworkStore.addMessage(session.id, { type: 'assistant', content: finalReply });
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: session logging failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    if (canRunSkillTurn) {
      const coworkStore = deps.getCoworkStore!();
      const session = ensureGuestSession(coworkStore, membership, bot);
      const skillSystemPrompt = [
        systemPrompt,
        '',
        routing.prompt!,
        '',
        'After using Read/Bash to run a skill, reply concisely in the group. Do not paste full skill logs.',
        'If the skill produced a file, put its absolute local path on its own line in your reply — the host uploads it on-chain and appends the [DELIVERABLE] metafile line for you. NEVER write or invent a metafile:// URI yourself.',
      ].join('\n');
      coworkStore.addMessage(session.id, { type: 'user', content: userMessage, metadata: { origin: 'group_task' } });
      try {
        const skillTurnResult = await deps.runSkillTurn!({
          sessionId: session.id,
          systemPrompt: skillSystemPrompt,
          userMessage,
          activeSkillIds: routing.activeSkillIds,
        });
        reply = (skillTurnResult.replyText ?? '').trim();
        // The runner appends the assistant message to the session itself.
        if (reply) {
          skillTurn = {
            cwd: (skillTurnResult.cwd ?? '').trim() || session.cwd,
            startedAt: skillTurnStartedAt,
            completedAt: now(),
          };
        }
      } catch (error) {
        // fix-v2 P1-5: a corrupt DSH session log (driver-handoff race, task
        // #57) fails EVERY skill turn on this guest session fast and forever;
        // the plain-completion fallback below would mask it and the guest
        // would silently degrade to skill-less replies for the rest of the
        // task. Rebuild the guest session (fresh log, same workspace; context
        // comes from the group transcript each turn anyway) so the next
        // mention's skill turn works — this turn still falls back.
        if (isCorruptSessionLogError(error)) {
          const rebuilt = rebuildGuestSession(coworkStore, membership, bot);
          if (rebuilt) {
            emitLog(
              `[OpenTeamGuestDaemon] Group ${membership.groupId}: corrupt session log for bot ${bot.id} — ` +
              `guest session rebuilt (${rebuilt.id.slice(0, 8)}…); the next mention's skill turn runs on the ` +
              'fresh session (this turn fell back to plain completion). ' +
              `Log signature: ${corruptSessionLogSignature(error)}`,
            );
          } else {
            // Rate-capped recurrence: the dual-writer race is likely still
            // live. Guidance once per hour, then the fallback still applies.
            const lastGuidanceAt = lastCorruptGuidanceAtByMembership.get(membership.id) ?? 0;
            if (now() - lastGuidanceAt > CORRUPT_SESSION_REBUILD_MIN_INTERVAL_MS) {
              lastCorruptGuidanceAtByMembership.set(membership.id, now());
              emitLog(
                `[OpenTeamGuestDaemon] Group ${membership.groupId}: corrupt session log for bot ${bot.id} ` +
                'recurred within the rebuild cooldown. ' +
                `Log signature: ${corruptSessionLogSignature(error)}. ` +
                'Self-heal guidance: restart the app so every runtime ' +
                'subprocess is reaped and the session resumes under a single writer; if it still recurs, ' +
                'investigate the provider re-pin / config-change handoff for this bot.',
              );
            }
          }
        }
        // Skill execution failure degrades to the plain completion path — a
        // skill-assembly problem must never silence the guest.
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: skill turn failed for bot ${bot.id}, ` +
          `falling back to plain completion: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (!reply) {
      const brain = metabotBrainOptions(bot);
      const llmId = brain.llmId ?? undefined;
      const fallbackLlmId = brain.fallbackLlmId;
      const plainSystemPrompt = [systemPrompt, selfCognitionSection]
        .filter((section) => section.trim())
        .join('\n\n');
      reply = (
        await deps.performChat(plainSystemPrompt, userMessage, llmId, {
          llmProvider: brain.llmProvider,
          fallbackLlmId,
          fallbackLlmProvider: brain.fallbackLlmProvider,
          effort: brain.effort,
          fallbackEffort: brain.fallbackEffort,
          thinking: 'enabled',
        })
      ).trim();
    }
    if (!reply) return;
    // [NO_REPLY] escape hatch: the model opted to stay silent — either nothing
    // to say OR it already said it mid-turn (the one-voice rule). Checked
    // BEFORE any upload so a suppressed message never spends upload fees.
    if (NO_REPLY_PATTERN.test(reply)) {
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} answered [NO_REPLY]; send suppressed`,
      );
      return;
    }

    // R4 single-send guarantee (P2 fix): a skill turn may have already spoken
    // to this group via the group_chat tool (send_group_message). If ANY send
    // for this (bot, group) landed after the turn started, the final text is a
    // duplicate report — it must stay OFF-CHAIN (session log only, below).
    // Checked before file uploads so a suppressed send never spends fees.
    if (skillTurnAttempted && deps.hasSentToGroupSince) {
      try {
        if (deps.hasSentToGroupSince(bot.id, membership.groupId, skillTurnStartedAt)) {
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} already sent to this group ` +
            `mid-turn; final-text auto-send suppressed (single-send guarantee) — the text stays in the ` +
            'session log only',
          );
          logTurnToMirrorSession(userMessage, reply);
          return;
        }
      } catch (error) {
        // The guarantee is best-effort observable: a ledger read failure must
        // not silence a legitimate reply.
        emitLog(
          `[OpenTeamGuestDaemon] Group ${membership.groupId}: mid-turn send check failed ` +
          `(sending anyway): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (skillTurn && (deps.uploadDeliverableFile || deps.publishTextDeliverable)) {
      reply = await appendFileDeliverables({
        bot,
        reply,
        cwd: skillTurn.cwd,
        turnStartedAt: skillTurn.startedAt,
        turnCompletedAt: skillTurn.completedAt,
      });
    }

    await deps.sendGroupMessage(bot.id, membership.groupId, {
      content: reply,
      nickName: bot.name?.trim() || `bot-${bot.id}`,
    });
    // P1-3: log the turn into the guest session (the one eagerly created at
    // invite-accept time) so the invitee's host has context continuity.
    logTurnToMirrorSession(userMessage, reply);
  };

  /**
   * P1-2 self-check fallback: the chair's [OPENTEAM_KICK] simplemsg may never
   * arrive (offline, indexer lag), so every membershipCheckIntervalMs each
   * active membership re-verifies on-chain that this bot is still a member of
   * the group. Two guards keep an indexer-lag false absence from killing a
   * healthy membership: (1) a fresh (re-)activation is not checked at all for
   * membershipSelfCheckGraceMs (anchored at activated_at, which the upsert
   * restamps on revival — created_at would survive a re-invite); (2) only
   * MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD consecutive absence reads mark the
   * membership left. Marking left stops the daemon consuming the group, stops
   * backfill pulling it, shows Left in the collab view, and lets a re-invite
   * land cleanly. A failed lookup silently skips the round.
   * Returns true when the membership was just marked left.
   */
  const runMembershipSelfCheck = async (
    membership: OpenTeamMembership,
    bot: Metabot,
  ): Promise<boolean> => {
    if (!deps.fetchGroupMembers) return false;
    // Activation grace: the indexer takes minutes to list a fresh join.
    const activatedMs = parseSqliteUtcMs(membership.activatedAt);
    if (Number.isFinite(activatedMs) && now() - activatedMs < membershipSelfCheckGraceMs) return false;
    const lastCheckedAt = membershipCheckedAtByMembership.get(membership.id) ?? 0;
    if (now() - lastCheckedAt < membershipCheckIntervalMs) return false;
    membershipCheckedAtByMembership.set(membership.id, now());
    let members: string[] | null = null;
    try {
      members = await deps.fetchGroupMembers(membership.groupId);
    } catch (error) {
      members = null;
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: membership self-check failed; ` +
        `skipping this round: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!members) return false; // indexer unreachable — try again next interval
    const identities = new Set(
      [bot.globalmetaid, bot.metaid, membership.globalmetaid]
        .map((value) => String(value ?? '').trim().toLowerCase())
        .filter(Boolean),
    );
    if (identities.size === 0) return false;
    if (members.some((member) => identities.has(member.trim().toLowerCase()))) {
      membershipAbsenceStreakByMembership.delete(membership.id);
      return false;
    }
    // One absence read can be indexer lag; only a confirmed streak marks left.
    const absenceStreak = (membershipAbsenceStreakByMembership.get(membership.id) ?? 0) + 1;
    if (absenceStreak < MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD) {
      membershipAbsenceStreakByMembership.set(membership.id, absenceStreak);
      emitLog(
        `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} missing from the on-chain ` +
        `member list (absence ${absenceStreak}/${MEMBERSHIP_SELF_CHECK_ABSENCE_THRESHOLD}); ` +
        'confirming on the next round before marking left',
      );
      return false;
    }
    membershipAbsenceStreakByMembership.delete(membership.id);
    deps.getOpenTeamMembershipStore().markLeft(membership.groupId, membership.metabotId, { cause: 'self_check' });
    emitLog(
      `[OpenTeamGuestDaemon] Group ${membership.groupId}: bot ${bot.id} is no longer an on-chain ` +
      'member; membership marked left (kick self-check)',
    );
    return true;
  };

  const processMembership = async (membership: OpenTeamMembership): Promise<void> => {
    const metabotStore = deps.getMetabotStore();
    const membershipStore = deps.getOpenTeamMembershipStore();
    const bot = metabotStore.getMetabotById(membership.metabotId);
    if (!bot || bot.enabled === false) return;
    if (!bot.globalmetaid?.trim()) return;
    const db = deps.getStore().getDatabase();

    // Kick self-check before consuming new messages (P1-2 fallback path).
    if (await runMembershipSelfCheck(membership, bot)) return;

    // Host-task status sync: the chair's `[STATUS:...]` tags ride the ordinary
    // transcript. Once a close-out tag ([STATUS:DONE|CANCELLED]) has landed the
    // task is over — the daemon keeps consuming messages (advancing the cursor)
    // but never speaks in the group again.
    let taskTerminal = isOpenTeamTaskStatusTerminal(membership.taskStatus);
    const chairGlobalMetaId = (membership.inviterGlobalmetaid ?? '').trim();

    const rows = queryNewMessages(db, membership.groupId, membership.lastProcessedMsgId);
    for (const row of rows) {
      const message = toDaemonMessage(row);
      // Status tags are parsed BEFORE the mention gating so a close-out tag is
      // picked up even while a reply cooldown is running. Only the chair (the
      // membership's recorded inviter — the kick handler's trust anchor) may
      // set the host-task status; tags quoted by other members never count.
      if (chairGlobalMetaId && (message.senderGlobalMetaId ?? '').trim() === chairGlobalMetaId) {
        const statusTag = parseOpenTeamTaskStatusTag(message.content);
        if (statusTag) {
          try {
            if (membershipStore.updateMembershipTaskStatus(membership.groupId, membership.metabotId, statusTag)) {
              emitLog(
                `[OpenTeamGuestDaemon] Group ${membership.groupId}: host task status -> ${statusTag} (chair transcript tag)`,
              );
            }
          } catch (error) {
            emitLog(
              `[OpenTeamGuestDaemon] Group ${membership.groupId}: task-status update failed: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (isOpenTeamTaskStatusTerminal(statusTag)) taskTerminal = true;
        }
      }
      let advanceCursor = false;
      try {
        if (taskTerminal) {
          // Terminal host task: consume the message without any reply path.
          advanceCursor = true;
        } else {
          const decision = decideOpenTeamGuestResponse({
            message,
            bot,
            lastReplyAt: lastReplyAtByMembership.get(membership.id) ?? 0,
            now: now(),
            // R5: chat groups use the shorter cadence.
            cooldownMs: membership.groupMode === 'chat' ? chatCooldownMs : cooldownMs,
            // R2: chat-mode gating (direct chair conversation without an @).
            mode: membership.groupMode === 'chat' ? 'chat' : 'task',
            inviterGlobalMetaId: chairGlobalMetaId,
          });
          if (!decision.respond && decision.reason === 'cooldown') {
            // Cooldown is transient: keep the cursor BEFORE this message so the
            // next tick re-evaluates it once the cooldown has elapsed instead of
            // dropping a legitimate mention forever. Later messages wait to keep
            // processing order.
            break;
          }
          if (decision.respond) {
            await generateAndSendGuestReply(membership, bot, message);
            lastReplyAtByMembership.set(membership.id, now());
          }
          consecutiveFailuresByMembership.delete(membership.id);
          advanceCursor = true;
        }
      } catch (error) {
        // A send/generation failure must not silently drop the mention: hold
        // the cursor and retry on the next tick, giving up after a bounded run
        // of consecutive failures on the SAME message so one poisonous message
        // cannot stall the membership forever.
        const previous = consecutiveFailuresByMembership.get(membership.id);
        const failures = previous?.messageId === message.id ? previous.count + 1 : 1;
        if (failures >= MAX_CONSECUTIVE_MESSAGE_FAILURES) {
          consecutiveFailuresByMembership.delete(membership.id);
          advanceCursor = true;
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: message ${message.id} failed ` +
            `${failures} times in a row; giving up on it (cursor advances): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        } else {
          consecutiveFailuresByMembership.set(membership.id, { messageId: message.id, count: failures });
          emitLog(
            `[OpenTeamGuestDaemon] Group ${membership.groupId}: message ${message.id} failed ` +
            `(retry ${failures}/${MAX_CONSECUTIVE_MESSAGE_FAILURES} next tick): ` +
            `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!advanceCursor) break;
      membershipStore.updateLastProcessedMsgId(
        membership.groupId,
        membership.metabotId,
        message.id,
      );
    }
  };

  const runTick = async (): Promise<void> => {
    const membershipStore = deps.getOpenTeamMembershipStore();
    const activeMemberships = membershipStore.listActiveMemberships();
    // Drop in-memory loop-prevention state of memberships that are no longer
    // active (kick / owner opt-out): the maps are keyed by membership id and
    // would otherwise grow monotonically — and a later re-join must not
    // inherit a stale cooldown or failure streak.
    const activeIds = new Set(activeMemberships.map((membership) => membership.id));
    for (const id of [...lastReplyAtByMembership.keys()]) {
      if (!activeIds.has(id)) lastReplyAtByMembership.delete(id);
    }
    for (const id of [...consecutiveFailuresByMembership.keys()]) {
      if (!activeIds.has(id)) consecutiveFailuresByMembership.delete(id);
    }
    for (const id of [...membershipCheckedAtByMembership.keys()]) {
      if (!activeIds.has(id)) membershipCheckedAtByMembership.delete(id);
    }
    for (const id of [...membershipAbsenceStreakByMembership.keys()]) {
      if (!activeIds.has(id)) membershipAbsenceStreakByMembership.delete(id);
    }
    for (const id of [...lastCorruptRebuildAtByMembership.keys()]) {
      if (!activeIds.has(id)) lastCorruptRebuildAtByMembership.delete(id);
    }
    for (const id of [...lastCorruptGuidanceAtByMembership.keys()]) {
      if (!activeIds.has(id)) lastCorruptGuidanceAtByMembership.delete(id);
    }
    for (const membership of activeMemberships) {
      try {
        await processMembership(membership);
      } catch (error) {
        emitLog(
          `[OpenTeamGuestDaemon] Membership ${membership.id} tick failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const runGuardedTick = (): void => {
    if (ticking) return;
    ticking = true;
    void runTick()
      .catch((error) => {
        emitLog(`[OpenTeamGuestDaemon] Tick failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        ticking = false;
      });
  };

  return {
    runTick,
    start() {
      if (timer) return;
      if (!taskStatusBackfillDone) {
        taskStatusBackfillDone = true;
        // One-time-per-run repair of legacy memberships: re-derive the host
        // task status from chair `[STATUS:...]` tags already in the transcript.
        backfillTaskStatusesFromTranscript();
      }
      runGuardedTick();
      timer = setInterval(runGuardedTick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
  };
}

let activeDaemonLoop: OpenTeamGuestDaemonLoop | null = null;

export function startOpenTeamGuestDaemon(deps: OpenTeamGuestDaemonDeps): void {
  stopOpenTeamGuestDaemon();
  activeDaemonLoop = createOpenTeamGuestDaemonLoop(deps);
  activeDaemonLoop.start();
}

export function stopOpenTeamGuestDaemon(): void {
  activeDaemonLoop?.stop();
  activeDaemonLoop = null;
}

export function isOpenTeamGuestDaemonRunning(): boolean {
  return Boolean(activeDaemonLoop?.isRunning());
}
