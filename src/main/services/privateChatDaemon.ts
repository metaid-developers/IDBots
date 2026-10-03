/**
 * Private Chat Daemon: process unprocessed private_chat_messages.
 * Decrypts with ECDH, intercepts ping/pong (MetaSwarm handshake), otherwise LLM reply + encrypt + broadcast.
 * SDD Task 14: encrypted private chat daemon and MetaSwarm handshake.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import { isSqliteWasmBoundsError } from '../sqliteRecovery';
import { getPrivateKeyBufferForEcdh } from './metabotWalletService';
import { stripLoneSurrogates, truncateUtf16Units, truncateUtf16UnitsFromEnd } from '../libs/llmSafeText';
import {
  computeEcdhSharedSecret,
  computeEcdhSharedSecretSha256,
  ecdhDecrypt,
  ecdhEncrypt,
} from './metaWebCrypto';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import { metabotBrainOptions, normalizeMetabotLlmId } from './llmFallback';
import type { CoworkRunner } from '../libs/coworkRunner';
import { isDshShutdownError } from '../libs/dshShutdownError';
import { PrivateChatOrderCowork, type OrderCoworkRequest } from './privateChatOrderCowork';
import { appendA2AGuidanceToSystemPrompt } from './a2aGuidance';
import { buildOrderPrompts } from './orderPromptBuilder';
import { buildMetabotPersonaPrompt } from '../libs/metabotPersonaPrompt';
import {
  checkOrderPaymentStatus,
  extractOrderRequestText,
  extractOrderTxid,
  extractOrderPinId,
  extractOrderReferenceId,
  extractOrderSkillId,
  extractOrderSkillName,
  extractOrderAllowedSkills,
  extractOrderOutputType,
  normalizeOrderOutputType,
  OrderSource,
  type ServiceOrderOutputType,
} from './orderPayment';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type { CoworkConversationMapping, CoworkMessage, CoworkMessageMetadata, CoworkStore } from '../coworkStore';
import type { MemoryBackend } from '../memory/memoryBackend';
import { MetaIDExperienceStore } from '../metaidExperienceStore';
import { recordMetaIDPrivateA2AExperience } from './metaidExperienceRecorder';
import { buildScopedMemoryPromptBlocks } from '../memory/memoryPromptBlocks';
import { createOwnerMemoryScope } from '../memory/memoryScope';
import { resolveMemoryScopes } from '../memory/memoryScopeResolver';
import type { MetaidDataPayload } from './metaidCore';
import { generateSessionTitle } from '../libs/coworkUtil';
import { resolveSessionWorkingDirectory } from '../libs/botWorkspace';
import {
  buildA2AEpisodeContinuityPromptBlock,
  maybeRollOverPrivateChatEpisode,
} from './a2aEpisodeRollover';
import { parseOpenTeamEnvelope, type OpenTeamInvitePayload, type OpenTeamKickPayload } from './openTeamProtocols';
import {
  handleIncomingOpenTeamInvite,
  handleIncomingOpenTeamKick,
  handleIncomingOpenTeamResponse,
} from './openTeamGuestService';
import {
  buildExperiencePromptBlocksXml as composeExperiencePromptBlocks,
  RECENT_SUMMARIES_PROMPT_DAYS,
} from '../libs/experiencePromptBlocks';
import {
  SERVICE_ORDER_DELIVERY_ARTIFACT_FAILED_REASON,
  SERVICE_ORDER_DELIVERY_FUNDING_INSUFFICIENT_REASON,
  SERVICE_ORDER_SKILL_SCOPE_UNRESOLVED_REASON,
  type ServiceOrderLifecycleService,
} from './serviceOrderLifecycleService';
import {
  buildDeliveryMessage,
  buildOrderEndMessage,
  buildOrderStatusMessage,
  buildCoworkDeliveryResultMessage,
  cleanServiceResultText,
  parseDeliveryMessage,
  parseNeedsRatingMessage,
  parseOrderEndMessage,
  parseOrderStatusMessage,
} from './serviceOrderProtocols.js';
import { createPinWithMvcSubsidyRetry, isMvcInsufficientBalanceError } from './privateChatSubsidizedPin';
import {
  isNeedsRatingMessage,
  shouldCompleteBuyerOrderObserverSession,
} from './privateChatOrderObserverState';
import { ensureServiceOrderObserverSession } from './serviceOrderObserverSession';
import { resolveOrderSessionId } from './serviceOrderSessionResolution.js';
import {
  normalizeServiceOutputType,
  verifyDeliveryArtifactUpload,
} from './serviceDeliveryArtifacts.js';
import type { ListenerConfig } from './metaWebListenerService';
import {
  buildA2AChainMetadata,
  extractTxidFromA2AChainPinId,
  normalizeA2AChainTxid,
  type A2AChainMetadata,
} from './a2aChainMetadata';
import {
  buildCanonicalPrivateConversationExternalConversationId,
  buildOrderProtocolDisplayMetadata,
  classifySimplemsgContent,
  type SimplemsgProtocolTag,
} from './simplemsgPeerConversation';
import {
  A2A_SESSION_CONVERSATION_GAP_MS,
  ensureCoworkA2ASession,
} from './coworkEnsureA2ASession';
import {
  deriveA2AClosingPhaseTurns,
  normalizeA2AAutoReplyEnabled,
  normalizeA2AByeCooldownMs,
  normalizeA2AMaxIncomingTurns,
} from './a2aChatLimits';
import {
  classifyPrivateChatSkillTurnError,
  nextSkillTurnRetryAt,
  PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS,
  shouldRetryPrivateChatSkillTurn,
} from './privateChatSkillTurnPolicy';
import { extractFinalAssistantReply } from './orchestratorCoworkBridge';
import { resolveOrderDeliveryBudget, type OrderDeliveryBudget } from './orderDeliveryBudgetService';

const POLL_INTERVAL_MS = 5_000;
/** Max recent messages of the active segment sent to the model per A2A private-chat turn. */
export const PRIVATE_CHAT_CONTEXT_MAX_MESSAGES = 80;
const PRIVATE_CHAT_PREVIOUS_SEGMENT_CONTEXT_MESSAGES = 20;
const RATING_PROMPT_ORIGINAL_REQUEST_MAX_CHARS = 1200;
const RATING_PROMPT_SERVICE_RESULT_MAX_CHARS = 6000;
const RATING_PROMPT_EXCERPT_TAIL_CHARS = 1200;
const SELLER_ORDER_ACKNOWLEDGEMENT_TIMEOUT_MS = 8_000;

export interface PrivateChatMessageRow {
  id: number;
  pin_id: string;
  tx_id?: string | null;
  from_metaid: string;
  from_global_metaid: string | null;
  from_name: string | null;
  from_avatar: string | null;
  from_chat_pubkey: string | null;
  to_metaid: string;
  to_global_metaid: string | null;
  content: string | null;
  encryption: string | null;
  reply_pin: string | null;
  raw_data: string | null;
  [k: string]: unknown;
}

/** (metabotId, body) => create /protocols/simplemsg pin and broadcast */
export type CreatePrivateMsgPinFn = (
  metabotId: number,
  body: { to: string; content: string; replyPin?: string }
) => Promise<{ txid?: string }>;

type SaveDbFn = () => void;
type RendererEmitter = (channel: string, data: unknown) => void;
type DelayFn = (ms: number) => Promise<void>;
type GetSellerOrderSkillsPromptFn = (params: {
  skillId?: string | null;
  skillName?: string | null;
  allowedSkillNames?: string[];
  strictScope?: boolean;
}) => Promise<string | null | SellerOrderSkillsPromptResult>;
type SellerOrderSkillsPromptResult = {
  prompt: string | null;
  activeSkillIds?: string[];
  missingSkillNames?: string[];
};
export type SellerOrderSkillScopeResolution = {
  prompt: string | null;
  activeSkillIds: string[];
  missingSkillNames: string[];
  allowedSkillNames: string[];
  strictScope: boolean;
  shouldRejectOrder: boolean;
};
type ChatSkillsRoutingPromptResult = {
  prompt: string | null;
  activeSkillIds: string[];
};
type GetChatSkillsRoutingPromptFn = (
  input: { metabotId?: number | null; widened?: boolean }
) => ChatSkillsRoutingPromptResult | Promise<ChatSkillsRoutingPromptResult>;
type RunPrivateChatSkillTurnFn = (params: {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  metabotId: number;
  activeSkillIds: string[];
  onSkillExecutionStart?: () => Promise<void> | void;
}) => Promise<{ replyText: string; assistantMessageId?: string | null }>;
type GeneratePrivateChatSkillWaitNoticeFn = (params: {
  metabot: {
    id: number;
    name: string;
    role?: string | null;
    soul?: string | null;
    goal?: string | null;
    bio?: string | null;
    /** Deprecated compatibility field; use bio. */
    background?: string | null;
  };
  userMessage: string;
  llmId?: string | null;
  llmProvider?: string | null;
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
}) => Promise<string>;
type ConsumeA2AGuidanceFn = (sessionId: string, metabotId: number) => string | null;
type GetListenerConfigFn = () => Partial<ListenerConfig> | null | undefined;
type PrivateChatPerformChatFn = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    llmProvider?: string | null;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: 'off' | 'low' | 'high' | 'max' | null;
    fallbackEffort?: 'off' | 'low' | 'high' | 'max' | null;
    thinking?: 'enabled' | 'disabled';
  }
) => Promise<string>;
type GetMetaIDCognitionPromptBlockFn = (input: {
  observerGlobalMetaID: string;
  subjectGlobalMetaID: string;
  excludeEvidenceIds?: string[];
}) => string | Promise<string>;

export interface PrivateChatA2AContextMessage {
  speaker: string;
  content: string;
  timestamp: number;
  direction: 'incoming' | 'outgoing';
}

export interface PrivateChatA2AAnalysis {
  contextMessages: PrivateChatA2AContextMessage[];
  incomingTurnCount: number;
  shouldForceBye: boolean;
}

/** In-flight task keys to avoid duplicate processing */
const thinkingTasks = new Set<string>();

/**
 * Pin ids of A2A / online private-chat reply pipelines currently in flight.
 *
 * Consumed by the sleep guard (src/main/sleepGuardWorkSources.ts): the skill
 * branch of a reply runs inside a cowork session, but the plain branch is a
 * session-less reasoning completion, so the pipeline itself must count as work
 * for as long as it runs. Cleared when the daemon stops.
 */
export function getActiveA2AReplyTaskIds(): string[] {
  return Array.from(thinkingTasks);
}
/** Backoff state for chat-skill turns that failed with a retryable error. */
const privateChatSkillTurnRetries = new Map<string, { attempts: number; nextRetryAt: number }>();

/**
 * Row ids whose ciphertext failed to decrypt with every known shared-secret
 * variant. Those rows stay unprocessed (is_processed = 0) so a later daemon
 * start — e.g. after an app update adds the missing key variant — retries
 * them; the set only keeps the poll loop from redoing the ECDH/decrypt work
 * and log line on every 5s tick. Cleared in stopPrivateChatDaemon.
 */
const privateChatDecryptFailedIds = new Set<number>();

/**
 * How long a row may be deferred because its A2A session still has an active
 * runner turn. A turn that outlives this cap is treated as wedged: the row
 * falls through to the normal flow (pickup or a fresh turn) so one leaked
 * turn cannot mute a conversation forever.
 */
const PRIVATE_CHAT_BUSY_DEFER_MAX_MS = 45 * 60_000;
const privateChatBusyDeferredSince = new Map<string, number>();

/**
 * Bounded host wake for silent-but-open A2A conversations (2026-09-16 deadlock
 * shape: the local bot promised a deferred answer, the peer's follow-ups were
 * hold/ack messages the model answered with [NO_REPLY], and — because the
 * daemon only reacts to NEW inbound messages — both sides then waited
 * forever). Whenever a turn in an established, not-bye'd conversation ends
 * without delivering anything (sentinel or empty give-up), the daemon arms a
 * timer that re-drives the same inbound row as a wake turn: the model gets a
 * host wake notice and re-decides (deliver the owed answer / close with bye /
 * stay silent). All intent judgment stays in the LLM; the host only schedules
 * on verifiable facts (nothing was delivered, conversation open).
 */
interface PrivateChatA2AWakeEntry {
  rowId: number;
  sessionId: string;
  metabotId: number;
  externalConversationId: string;
  fromGlobalMetaId: string | null;
  fromMetaId: string | null;
  toGlobalMetaId: string | null;
  toMetaId: string | null;
  /** Wake turns already fired for this conversation. */
  fires: number;
  fireAt: number;
  /** True while the re-driven row is being processed as a wake turn. */
  running: boolean;
}
const privateChatA2AWakes = new Map<string, PrivateChatA2AWakeEntry>();
/** Wake schedule (delay before fire N+1); length bounds the total fires. */
export const PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS: readonly number[] = [15 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
let privateChatA2AWakeDelaysMs: readonly number[] = PRIVATE_CHAT_A2A_DEFAULT_WAKE_DELAYS_MS;

/**
 * Next wake fire timestamp after `fires` wakes have already fired, or null
 * when the wake budget is exhausted.
 */
export function nextPrivateChatA2AWakeAt(fires: number, now: number = Date.now()): number | null {
  const safeFires = Number.isFinite(fires) && fires >= 0 ? Math.floor(fires) : 0;
  if (safeFires >= privateChatA2AWakeDelaysMs.length) return null;
  return now + Math.max(1, privateChatA2AWakeDelaysMs[safeFires] ?? 1);
}

/** Test seam: shrink the wake schedule so daemon-level tests can observe fires. */
export function setPrivateChatA2AWakeDelaysForTests(delays: readonly number[]): void {
  privateChatA2AWakeDelaysMs = delays.filter((delay) => Number.isFinite(delay) && delay > 0);
}

/** Host notice appended to the system prompt of a wake turn. */
export function buildPrivateChatA2AWakeNotice(fire: number): string {
  const safeFire = Number.isFinite(fire) && fire > 0 ? Math.floor(fire) : 1;
  return [
    `## Host Wake Check ${safeFire} (host timer — no new peer message arrived)`,
    'Your previous turn for the peer\'s latest message ended WITHOUT delivering anything, and the conversation is still open. The host woke you on a timer because it only runs you again when a NEW peer message arrives — if both sides now wait, the conversation deadlocks.',
    'Decide again for the conversation tail:',
    '- If you owe the peer an answer you promised or deferred earlier (for example you said you would verify something and reply later), deliver it now as your final text.',
    '- If the conversation has nothing left to produce, close it politely by replying exactly "bye".',
    '- Reply `[NO_REPLY]` only if you genuinely owe nothing and the conversation should stay open awaiting the peer.',
  ].join('\n');
}

function armPrivateChatA2AWake(params: {
  row: PrivateChatMessageRow;
  sessionId: string;
  metabotId: number;
  externalConversationId: string;
  fires: number;
  emitLog: (msg: string) => void;
}): void {
  const fireAt = nextPrivateChatA2AWakeAt(params.fires);
  if (fireAt == null) {
    privateChatA2AWakes.delete(params.row.pin_id);
    params.emitLog(
      `[PrivateChat] Wake budget exhausted for ${params.externalConversationId.slice(0, 30)}…; ` +
      `the silent conversation tail will stay as-is.`
    );
    return;
  }
  const waitMs = Math.max(0, fireAt - Date.now());
  privateChatA2AWakes.set(params.row.pin_id, {
    rowId: params.row.id,
    sessionId: params.sessionId,
    metabotId: params.metabotId,
    externalConversationId: params.externalConversationId,
    fromGlobalMetaId: params.row.from_global_metaid,
    fromMetaId: params.row.from_metaid,
    toGlobalMetaId: params.row.to_global_metaid,
    toMetaId: params.row.to_metaid,
    fires: params.fires,
    fireAt,
    running: false,
  });
  params.emitLog(
    `[PrivateChat] Wake ${params.fires + 1} scheduled in ${Math.round(waitMs / 1000)}s for the silent open ` +
    `conversation ${params.externalConversationId.slice(0, 30)}… (message ${params.row.id}).`
  );
}

function cancelPrivateChatA2AWakesForConversation(
  externalConversationId: string,
  reason: string,
  emitLog?: (msg: string) => void,
): void {
  for (const [taskKey, wake] of privateChatA2AWakes) {
    if (wake.externalConversationId !== externalConversationId) continue;
    privateChatA2AWakes.delete(taskKey);
  }
  emitLog?.(`[PrivateChat] Cancelled pending wake for ${externalConversationId.slice(0, 30)}… (${reason}).`);
}

/**
 * The disposition a fired wake attaches to the row it re-drives: the handler
 * and the presentation layer can then tell a re-served old message apart from
 * a true new inbound (H-64 leg B). Written at throw time, never retroactively.
 */
export interface PrivateChatWakeReDriveDisposition {
  reServed: true;
  /** private_chat_messages row id of the original message being re-served. */
  originalRowId: number;
}

/** Fire due wakes: re-drive their inbound row and let the poll pick it up.
 * Returns the re-drive disposition for every row it actually threw back so
 * the poll can hand it straight to processOne and the presentation layer. */
function fireDuePrivateChatA2AWakes(deps: {
  db: Pick<Database, 'exec' | 'run'>;
  saveDb: SaveDbFn;
  coworkStore: Pick<CoworkStore, 'getConversationMapping' | 'getSessionWithoutMessages' | 'addMessage' | 'updateSession'>;
  emitLog: (msg: string) => void;
  emitToRenderer?: (channel: string, data: unknown) => void;
}): Map<number, PrivateChatWakeReDriveDisposition> {
  const reDrivenDispositions = new Map<number, PrivateChatWakeReDriveDisposition>();
  const now = Date.now();
  for (const [taskKey, wake] of [...privateChatA2AWakes]) {
    if (wake.running || wake.fireAt > now) continue;
    privateChatA2AWakes.delete(taskKey);

    const mapping = deps.coworkStore.getConversationMapping(
      'metaweb_private',
      wake.externalConversationId,
      wake.metabotId,
    );
    if (parseConversationMappingMetadata(mapping?.metadataJson).byeSent === true) {
      deps.emitLog(`[PrivateChat] Wake for ${wake.externalConversationId.slice(0, 30)}… cancelled: conversation closed with bye.`);
      continue;
    }
    if (!deps.coworkStore.getSessionWithoutMessages(wake.sessionId)) {
      deps.emitLog(`[PrivateChat] Wake for ${wake.externalConversationId.slice(0, 30)}… cancelled: session no longer exists.`);
      continue;
    }
    if (hasNewerPrivateChatMessage(deps.db, {
      currentRowId: wake.rowId,
      fromGlobalMetaId: wake.fromGlobalMetaId,
      fromMetaId: wake.fromMetaId,
      toGlobalMetaId: wake.toGlobalMetaId,
      toMetaId: wake.toMetaId,
    })) {
      deps.emitLog(`[PrivateChat] Wake for ${wake.externalConversationId.slice(0, 30)}… cancelled: a newer peer message owns the conversation tail.`);
      continue;
    }

    wake.fires += 1;
    wake.running = true;
    wake.fireAt = Number.POSITIVE_INFINITY;
    privateChatA2AWakes.set(taskKey, wake);
    try {
      deps.db.run('UPDATE private_chat_messages SET is_processed = 0 WHERE id = ?', [wake.rowId]);
      deps.saveDb();
    } catch (error) {
      privateChatA2AWakes.delete(taskKey);
      deps.emitLog(`[PrivateChat] Wake for ${wake.externalConversationId.slice(0, 30)}… failed to re-drive message ${wake.rowId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // H-64 leg B: the disposition is written when the row is thrown back
    // into the pipeline — never retroactively after presentation.
    reDrivenDispositions.set(wake.rowId, { reServed: true, originalRowId: wake.rowId });
    appendPrivateChatA2AMessage({
      coworkStore: deps.coworkStore,
      sessionId: wake.sessionId,
      externalConversationId: wake.externalConversationId,
      type: 'assistant',
      content: `[Host] Wake check ${wake.fires}: re-evaluating the silent conversation tail (no new peer message) for an owed deferred reply or a bye.`,
      extraMetadata: {
        isThinking: true,
        isStreaming: false,
        isFinal: true,
        privateChatWakeNotice: true,
      },
      emitToRenderer: deps.emitToRenderer,
    });
    deps.emitLog(`[PrivateChat] Wake ${wake.fires} fired for ${wake.externalConversationId.slice(0, 30)}…; re-driving message ${wake.rowId}.`);
  }
  return reDrivenDispositions;
}

export function shouldDeferForBusyRunnerSession(
  isSessionTurnActive: ((sessionId: string) => boolean) | undefined,
  sessionId: string,
  emitLog: (msg: string) => void,
  now: number = Date.now(),
): boolean {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || typeof isSessionTurnActive !== 'function') return false;
  if (!isSessionTurnActive(normalizedSessionId)) {
    privateChatBusyDeferredSince.delete(normalizedSessionId);
    return false;
  }
  const firstSeenAt = privateChatBusyDeferredSince.get(normalizedSessionId);
  if (firstSeenAt == null) {
    privateChatBusyDeferredSince.set(normalizedSessionId, now);
    return true;
  }
  if (now - firstSeenAt < PRIVATE_CHAT_BUSY_DEFER_MAX_MS) return true;
  privateChatBusyDeferredSince.delete(normalizedSessionId);
  emitLog(
    `[PrivateChat] Session ${normalizedSessionId} turn stayed active for over ` +
    `${Math.round(PRIVATE_CHAT_BUSY_DEFER_MAX_MS / 60000)}min; proceeding despite the busy session.`
  );
  return false;
}

/**
 * Recover the final reply of a skill turn that completed after the daemon
 * stopped waiting for it (watchdog timeout / restart). The daemon detaches
 * from an over-budget turn but the runner keeps it alive and persists its
 * final assistant message into the session; without this pickup that reply
 * stays a local-only "internal status" bubble and the peer never gets it.
 *
 * Scans the session window AFTER the trigger message, stopping at the next
 * inbound peer user message (a newer turn boundary). Assistant bubbles that
 * were already delivered (chain-stamped outgoing) are skipped; bubbles whose
 * broadcast failed are picked up again so the send is retried without
 * re-running the whole LLM turn.
 */
export function findDeliverableCompletedTurnReply(input: {
  coworkStore: Pick<CoworkStore, 'getSession'>;
  sessionId: string;
  triggerMessageId: string;
}): { replyText: string; assistantMessageId: string } | null {
  const session = input.coworkStore.getSession(input.sessionId);
  const messages = session?.messages ?? [];
  const triggerIndex = messages.findIndex((message) => message.id === input.triggerMessageId);
  if (triggerIndex < 0) return null;
  const window: CoworkMessage[] = [];
  for (let i = triggerIndex + 1; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === 'user') break;
    if (
      message.type === 'assistant'
      && message.metadata?.direction === 'outgoing'
      && message.metadata?.privateChatDeliveryStatus !== 'failed'
    ) {
      continue;
    }
    window.push(message);
  }
  const { replyText, assistantMessageId } = extractFinalAssistantReply(window);
  if (!replyText || !assistantMessageId) return null;
  return { replyText, assistantMessageId };
}

/** Publish of the on-chain reply pin must not wedge the serial poll loop. */
const PRIVATE_CHAT_REPLY_PIN_PUBLISH_TIMEOUT_MS = 120_000;

function withPrivateChatPublishTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
const interruptibleA2AGuidanceTurns = new Map<string, {
  sessionId: string;
  metabotId: number;
  abortController: AbortController;
  assistantOutputStarted: boolean;
}>();
let orderCowork: PrivateChatOrderCowork | null = null;
const sentOrderDeliveryKeys = new Set<string>();
const sentOrderRatingInviteKeys = new Set<string>();

function trackInterruptibleA2AGuidanceTurn(input: {
  sessionId: string;
  metabotId: number;
}): {
  sessionId: string;
  metabotId: number;
  abortController: AbortController;
  assistantOutputStarted: boolean;
} {
  const turn = {
    sessionId: input.sessionId,
    metabotId: input.metabotId,
    abortController: new AbortController(),
    assistantOutputStarted: false,
  };
  interruptibleA2AGuidanceTurns.set(input.sessionId, turn);
  return turn;
}

function releaseInterruptibleA2AGuidanceTurn(turn: {
  sessionId: string;
  abortController: AbortController;
}): void {
  if (interruptibleA2AGuidanceTurns.get(turn.sessionId) === turn) {
    interruptibleA2AGuidanceTurns.delete(turn.sessionId);
  }
}

export function interruptPrivateChatA2AGuidanceTurnBeforeOutput(sessionId: string): boolean {
  const turn = interruptibleA2AGuidanceTurns.get(String(sessionId || '').trim());
  if (!turn || turn.assistantOutputStarted || turn.abortController.signal.aborted) {
    return false;
  }
  turn.abortController.abort('A2A guidance queued before assistant output');
  return true;
}

export function buildPrivateChatA2AChainMetadata(input: {
  txId?: unknown;
  txids?: unknown;
  pinId?: unknown;
}): CoworkMessageMetadata {
  return buildA2AChainMetadata(input) as CoworkMessageMetadata;
}

function normalizePrivateChatPinId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getPrivateChatRowTxid(row: PrivateChatMessageRow): string {
  return normalizeA2AChainTxid(row.tx_id) || extractTxidFromA2AChainPinId(row.pin_id);
}

function metadataHasPrivateChatChainIdentity(
  metadata: CoworkMessageMetadata | null | undefined,
  row: PrivateChatMessageRow
): boolean {
  if (!metadata) return false;
  const rowPinId = normalizePrivateChatPinId(row.pin_id);
  if (rowPinId && normalizePrivateChatPinId(metadata.pinId) === rowPinId) return true;

  const rowTxid = getPrivateChatRowTxid(row);
  if (!rowTxid) return false;
  if (normalizeA2AChainTxid(metadata.txid) === rowTxid) return true;
  if (extractTxidFromA2AChainPinId(metadata.pinId) === rowTxid) return true;
  if (Array.isArray(metadata.txids) && metadata.txids.some((txid) => normalizeA2AChainTxid(txid) === rowTxid)) {
    return true;
  }
  return false;
}

function getPrivateChatChainIdentitySearchValues(row: PrivateChatMessageRow): string[] {
  return Array.from(new Set([
    normalizePrivateChatPinId(row.pin_id),
    getPrivateChatRowTxid(row),
  ].filter(Boolean)));
}

function findPrivateChatA2AInboundMessage(params: {
  coworkStore: Pick<CoworkStore, 'getSessionMessagesMatchingMetadataValues'>;
  sessionId: string;
  externalConversationId: string;
  row: PrivateChatMessageRow;
}): CoworkMessage | null {
  return params.coworkStore.getSessionMessagesMatchingMetadataValues(
    params.sessionId,
    getPrivateChatChainIdentitySearchValues(params.row),
  ).find((message) => (
    message.type === 'user'
    && message.metadata?.sourceChannel === 'metaweb_private'
    && message.metadata?.externalConversationId === params.externalConversationId
    && metadataHasPrivateChatChainIdentity(message.metadata, params.row)
  )) ?? null;
}

function findRetryablePrivateChatA2AReplyMessage(params: {
  coworkStore: Pick<CoworkStore, 'getSessionMessagesMatchingMetadataValues'>;
  sessionId: string;
  externalConversationId: string;
  row: PrivateChatMessageRow;
}): CoworkMessage | null {
  const rowPinId = normalizePrivateChatPinId(params.row.pin_id);
  const rowTxid = getPrivateChatRowTxid(params.row);
  if (!rowPinId && !rowTxid) return null;
  return params.coworkStore.getSessionMessagesMatchingMetadataValues(
    params.sessionId,
    getPrivateChatChainIdentitySearchValues(params.row),
  ).find((message) => {
    const metadata = message.metadata;
    if (
      message.type !== 'assistant'
      || metadata?.sourceChannel !== 'metaweb_private'
      || metadata.externalConversationId !== params.externalConversationId
      || metadata.privateChatDeliveryStatus !== 'failed'
    ) {
      return false;
    }
    return Boolean(
      (rowPinId && normalizePrivateChatPinId(metadata.privateChatReplyForPinId) === rowPinId)
        || (rowTxid && normalizeA2AChainTxid(metadata.privateChatReplyForTxid) === rowTxid)
    );
  }) ?? null;
}

function buildOrderDispatchKey(
  localMetabotId: number,
  peerGlobalMetaId: string,
  orderTrackingId: string
): string {
  return `${localMetabotId}:${peerGlobalMetaId}:${orderTrackingId}`;
}

function parsePrivateChatRows(db: Database): PrivateChatMessageRow[] {
  const result = db.exec(
    `SELECT id, pin_id, tx_id, from_metaid, from_global_metaid, from_name, from_avatar, from_chat_pubkey, to_metaid, to_global_metaid, content, encryption, reply_pin, raw_data
     FROM private_chat_messages WHERE is_processed = 0 ORDER BY id ASC`
  );
  if (!result[0]?.values?.length) return [];
  const cols = result[0].columns as string[];
  const rows = result[0].values as unknown[][];
  return rows.map((row) =>
    cols.reduce((acc, c, i) => {
      acc[c] = row[i];
      return acc;
    }, {} as Record<string, unknown>)
  ) as PrivateChatMessageRow[];
}

function getCipherTextFromRawData(rawData: string | null): string {
  const raw = (rawData ?? '').trim();
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw) as {
      content?: unknown;
      data?: { content?: unknown };
    };
    const c1 = typeof obj.content === 'string' ? obj.content.trim() : '';
    if (c1) return c1;
    const c2 =
      obj.data && typeof obj.data.content === 'string'
        ? obj.data.content.trim()
        : '';
    return c2 || '';
  } catch {
    return '';
  }
}

function looksLikeEncryptedPrivateContent(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.startsWith('U2FsdGVkX1')) return true; // OpenSSL "Salted__" base64 prefix
  if (/^[0-9a-fA-F]{32,}$/.test(s) && s.length % 2 === 0) return true;
  return false;
}

function tryDecryptWithSecret(cipherText: string, secret: string): string | null {
  if (!cipherText || !secret) return null;
  const plain = ecdhDecrypt(cipherText, secret);
  if (!plain || plain === cipherText) return null;
  return plain;
}

function rethrowSqliteWasmBoundsError(error: unknown): void {
  if (isSqliteWasmBoundsError(error)) {
    throw error;
  }
}

function markProcessed(db: Database, id: number, saveDb: SaveDbFn): void {
  db.run('UPDATE private_chat_messages SET is_processed = 1 WHERE id = ?', [id]);
  saveDb();
}

function buildPrivateMsgPayload(to: string, encryptedContent: string, replyPin = ''): string {
  const body = {
    to,
    timestamp: Math.floor(Date.now() / 1000),
    content: encryptedContent,
    contentType: 'text/markdown',
    encrypt: 'ecdh',
    replyPin: replyPin || '',
  };
  return JSON.stringify(body);
}

const ORDER_PREFIX = '[ORDER]';
const CHAIN_UNIT = 100_000_000;
const METAFILE_URI_RE = /metafile:\/\/([A-Za-z0-9]+i\d+)(?:\.([A-Za-z0-9]+))?/gi;
const IMAGE_DELIVERY_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const VIDEO_DELIVERY_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);
const AUDIO_DELIVERY_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);

type ResolveLocalServiceOutputTypeFn = (input: {
  serviceId?: string | null;
  serviceName?: string | null;
}) => string | null | undefined;
type ResolveLocalServiceExecutionReminderFn = (input: {
  serviceId?: string | null;
  serviceName?: string | null;
}) => string | null | undefined;

function isOrderMessage(plaintext: string): boolean {
  return plaintext.trim().toUpperCase().startsWith(ORDER_PREFIX);
}

function normalizeOrderMessageTxid(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/i.test(normalized) ? normalized : '';
}

function resolveOrderProtocolTxid(plaintext: string): string {
  return normalizeOrderMessageTxid(
    parseOrderStatusMessage(plaintext)?.orderTxid
      || parseDeliveryMessage(plaintext)?.orderTxid
      || parseNeedsRatingMessage(plaintext)?.orderTxid
      || parseOrderEndMessage(plaintext)?.orderTxid
  );
}

function resolveOrderProtocolPinId(plaintext: string): string {
  const delivery = parseDeliveryMessage(plaintext);
  return normalizeServiceOrderPinId(
    parseOrderStatusMessage(plaintext)?.orderPinId
      || delivery?.serviceOrderPinId
      || delivery?.orderPinId
      || parseNeedsRatingMessage(plaintext)?.orderPinId
      || parseOrderEndMessage(plaintext)?.orderPinId
  );
}

export function resolveBuyerOrderProtocolMapping(
  coworkStore: Pick<CoworkStore, 'findOrderSessionByOrderPinId' | 'findOrderSessionByOrderTxid' | 'findOrderSessionByPeer'>,
  input: {
    localMetabotId: number;
    peerGlobalMetaId: string;
    plaintext: string;
  }
): CoworkConversationMapping | null {
  const delivery = parseDeliveryMessage(input.plaintext);
  const orderStatus = parseOrderStatusMessage(input.plaintext);
  const isNeedsRating = isNeedsRatingMessage(input.plaintext);
  const orderEnd = parseOrderEndMessage(input.plaintext);
  const explicitOrderPinId = resolveOrderProtocolPinId(input.plaintext);
  if (explicitOrderPinId) {
    return coworkStore.findOrderSessionByOrderPinId(
      input.localMetabotId,
      input.peerGlobalMetaId,
      explicitOrderPinId,
      orderEnd ? undefined : 'buyer',
    );
  }

  const orderProtocolTxid = resolveOrderProtocolTxid(input.plaintext);
  if (orderProtocolTxid) {
    return coworkStore.findOrderSessionByOrderTxid(
      input.localMetabotId,
      input.peerGlobalMetaId,
      orderProtocolTxid,
      orderEnd ? undefined : 'buyer',
    );
  }

  if (delivery || orderStatus || isNeedsRating || orderEnd) {
    return coworkStore.findOrderSessionByPeer(input.localMetabotId, input.peerGlobalMetaId);
  }
  return null;
}

function buildOrderA2ADisplayMetadata(input: {
  peerGlobalMetaId: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  fallbackTag?: SimplemsgProtocolTag;
  orderTxid?: string | null;
  orderRole?: 'buyer' | 'seller' | string | null;
  orderPinId?: string | null;
  paymentTxid?: string | null;
  orderMappingExternalConversationId?: string | null;
  extra?: CoworkMessageMetadata | null;
}): CoworkMessageMetadata {
  const classification = classifySimplemsgContent(input.content);
  const tag = classification.kind === 'order_protocol'
    ? classification.tag
    : input.fallbackTag ?? 'ORDER_STATUS';
  const orderTxid = input.orderTxid
    || (classification.kind === 'order_protocol' ? classification.orderTxid : null)
    || null;
  const orderPinId = input.orderPinId
    || (classification.kind === 'order_protocol' ? classification.orderPinId : null)
    || null;
  return buildOrderProtocolDisplayMetadata({
    peerGlobalMetaId: input.peerGlobalMetaId,
    direction: input.direction,
    tag,
    orderTxid,
    orderRole: input.orderRole,
    orderPinId,
    paymentTxid: input.paymentTxid,
    orderMappingExternalConversationId: input.orderMappingExternalConversationId,
    extra: input.extra,
  }) as CoworkMessageMetadata;
}

function normalizeAllowedSkillScopeNames(values: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const trimmed = String(value || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export async function resolveSellerOrderSkillScopePrompt(params: {
  skillId?: string | null;
  skillName?: string | null;
  allowedSkillNames?: string[] | null;
  getSkillsPrompt?: GetSellerOrderSkillsPromptFn;
}): Promise<SellerOrderSkillScopeResolution> {
  const allowedSkillNames = normalizeAllowedSkillScopeNames(params.allowedSkillNames);
  const strictScope = allowedSkillNames.length > 0;
  const rawResult = params.getSkillsPrompt
    ? await params.getSkillsPrompt({
      skillId: params.skillId,
      skillName: params.skillName,
      allowedSkillNames,
      strictScope,
    })
    : null;
  let promptResult: SellerOrderSkillsPromptResult;
  if (typeof rawResult === 'string') {
    promptResult = {
      prompt: rawResult,
      activeSkillIds: [],
      missingSkillNames: [],
    };
  } else if (rawResult == null) {
    promptResult = {
      prompt: null,
      activeSkillIds: [],
      missingSkillNames: strictScope ? allowedSkillNames : [],
    };
  } else {
    promptResult = {
      prompt: rawResult.prompt,
      activeSkillIds: Array.isArray(rawResult.activeSkillIds) ? rawResult.activeSkillIds : [],
      missingSkillNames: Array.isArray(rawResult.missingSkillNames) ? rawResult.missingSkillNames : [],
    };
  }
  const activeSkillIds = Array.from(new Set(
    (promptResult.activeSkillIds ?? [])
      .map((skillId) => String(skillId || '').trim())
      .filter(Boolean)
  ));
  const missingSkillNames = normalizeAllowedSkillScopeNames(
    promptResult.missingSkillNames && promptResult.missingSkillNames.length > 0
      ? promptResult.missingSkillNames
      : strictScope && activeSkillIds.length === 0 && !promptResult.prompt
        ? allowedSkillNames
        : []
  );
  const prompt = typeof promptResult.prompt === 'string' && promptResult.prompt.trim()
    ? promptResult.prompt
    : null;

  return {
    prompt,
    activeSkillIds,
    missingSkillNames,
    allowedSkillNames,
    strictScope,
    shouldRejectOrder: strictScope && activeSkillIds.length === 0,
  };
}

function getCurrencyFromChain(chain?: string): string {
  if (chain === 'btc') return 'BTC';
  if (chain === 'doge') return 'DOGE';
  return 'SPACE';
}

function formatPaymentAmountFromSats(amountSats?: number): string {
  if (!Number.isFinite(amountSats)) return '0';
  const amount = Number(amountSats) / CHAIN_UNIT;
  return amount.toFixed(8).replace(/\.?0+$/, '') || '0';
}

function isByeMessage(text: string): boolean {
  return text.trim().toLowerCase() === 'bye';
}

function parseConversationMappingMetadata(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

export function shouldKeepPrivateChatConversationClosedAfterBye(params: {
  mappingMeta: Record<string, unknown>;
  now?: number;
  /** Per-MetaBot cooldown after an auto-bye; defaults to the app-wide default. */
  reopenGapMs?: number;
}): boolean {
  if (params.mappingMeta.byeSent !== true) return false;
  const endedAt = typeof params.mappingMeta.endedAt === 'number' && Number.isFinite(params.mappingMeta.endedAt)
    ? params.mappingMeta.endedAt
    : 0;
  return params.mappingMeta.endedByHuman === true
    || !endedAt
    || (params.now ?? Date.now()) - endedAt < normalizeA2AByeCooldownMs(params.reopenGapMs);
}

export function shouldDisplayInboundPrivateChatWhileClosed(params: {
  mappingMeta: Record<string, unknown>;
  now?: number;
  /** Per-MetaBot cooldown after an auto-bye; defaults to the app-wide default. */
  reopenGapMs?: number;
}): boolean {
  return params.mappingMeta.byeSent === true
    && shouldKeepPrivateChatConversationClosedAfterBye(params);
}

/** How many recent messages a closed-conversation reopen scan inspects. */
const PRIVATE_CHAT_CLOSED_REOPEN_SCAN_MESSAGES = 200;

/**
 * A bye only means "stop auto-replying"; it is not a one-way mute. When the
 * LOCAL MetaBot has itself sent an outbound private message to this peer after
 * the bye (a scheduled report, a manual send from the Bot Browser, a
 * bot-initiated turn), the conversation is demonstrably live again on our side
 * — keeping the flag set then swallows the peer's reply silently, which is the
 * reported "只入库不回复" defect.
 */
export function shouldReopenClosedPrivateChatForLocalOutbound(params: {
  mappingMeta: Record<string, unknown>;
  /** Newest local outbound turn in the mapped session (ms, local clock). */
  lastLocalOutboundAt?: number | null;
}): boolean {
  if (params.mappingMeta.byeSent !== true) return false;
  const endedAt = typeof params.mappingMeta.endedAt === 'number' && Number.isFinite(params.mappingMeta.endedAt)
    ? params.mappingMeta.endedAt
    : 0;
  // No recorded bye time: keep the existing (permanent) closed semantics rather
  // than guessing that this conversation was re-engaged.
  if (!endedAt) return false;
  const lastOutboundAt = typeof params.lastLocalOutboundAt === 'number' && Number.isFinite(params.lastLocalOutboundAt)
    ? params.lastLocalOutboundAt
    : 0;
  return lastOutboundAt > endedAt;
}

/**
 * Newest local outbound turn in a private A2A session, ignoring what the bye
 * itself leaves behind: the end-marker bubble (`a2aConversationEnded`, whose
 * created_at is a millisecond AFTER `endedAt`) and the end system notice. Both
 * would otherwise look like a local re-engagement the instant the conversation
 * was closed.
 */
function findLastLocalOutboundPrivateChatAt(
  coworkStore: Pick<CoworkStore, 'getSessionView'>,
  sessionId: string
): number | null {
  const trimmedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!trimmedSessionId) return null;
  const view = coworkStore.getSessionView(trimmedSessionId, PRIVATE_CHAT_CLOSED_REOPEN_SCAN_MESSAGES);
  let latest: number | null = null;
  for (const message of view?.messages ?? []) {
    if (message.type !== 'assistant') continue;
    const metadata = message.metadata ?? {};
    if (metadata.sourceChannel !== 'metaweb_private') continue;
    if (metadata.direction !== 'outgoing') continue;
    if (metadata.a2aConversationEnded === true) continue;
    if (metadata.a2aConversationEndSystemNotice === true) continue;
    const at = typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) ? message.timestamp : 0;
    if (at <= 0) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

export function resolveSellerOrderOutputType(input: {
  plaintext: string;
  serviceId?: string | null;
  serviceName?: string | null;
  resolveLocalServiceOutputType?: ResolveLocalServiceOutputTypeFn | null;
}): ServiceOrderOutputType {
  const explicit = extractOrderOutputType(input.plaintext);
  if (explicit) {
    return explicit;
  }

  const fallback = input.resolveLocalServiceOutputType?.({
    serviceId: input.serviceId ?? null,
    serviceName: input.serviceName ?? null,
  });
  const normalizedFallback = normalizeOrderOutputType(
    typeof fallback === 'string' ? fallback : ''
  );
  return normalizedFallback || 'text';
}

export function resolveBuyerOrderOutputType(input: {
  buyerOrderMeta?: Record<string, unknown> | null;
  orderPayload?: string | null;
  resolveLocalServiceOutputType?: ResolveLocalServiceOutputTypeFn | null;
}): ServiceOrderOutputType {
  const meta = input.buyerOrderMeta || {};
  const explicitMeta = normalizeOrderOutputType(
    typeof meta.serviceOutputType === 'string' ? meta.serviceOutputType : ''
  );
  if (explicitMeta) {
    return explicitMeta;
  }

  const payload = String(input.orderPayload || '');
  const explicitPayload = extractOrderOutputType(payload);
  if (explicitPayload) {
    return explicitPayload;
  }

  const serviceId = typeof meta.serviceId === 'string'
    ? meta.serviceId
    : extractOrderSkillId(payload);
  const serviceName = typeof meta.serviceSkill === 'string'
    ? meta.serviceSkill
    : extractOrderSkillName(payload);
  const fallback = input.resolveLocalServiceOutputType?.({
    serviceId,
    serviceName,
  });
  const normalizedFallback = normalizeOrderOutputType(
    typeof fallback === 'string' ? fallback : ''
  );
  return normalizedFallback || 'text';
}

function getExpectedDeliveryExtensions(outputType: string): Set<string> | null {
  if (outputType === 'image') return IMAGE_DELIVERY_EXTENSIONS;
  if (outputType === 'video') return VIDEO_DELIVERY_EXTENSIONS;
  if (outputType === 'audio') return AUDIO_DELIVERY_EXTENSIONS;
  return null;
}

export function deliveryResultHasExpectedArtifact(resultText: string, expectedOutputType?: string | null): boolean {
  const outputType = normalizeServiceOutputType(expectedOutputType);
  if (outputType === 'text') {
    return true;
  }

  const result = String(resultText || '');
  const expectedExtensions = getExpectedDeliveryExtensions(outputType);
  METAFILE_URI_RE.lastIndex = 0;
  for (const match of result.matchAll(METAFILE_URI_RE)) {
    const pinId = String(match[1] || '').trim();
    if (!pinId) continue;
    if (!expectedExtensions) {
      return true;
    }
    const extension = String(match[2] || '').trim().toLowerCase();
    if (extension && expectedExtensions.has(extension)) {
      return true;
    }
  }

  return false;
}

function buildOrderExternalConversationId(
  row: PrivateChatMessageRow,
  source: OrderSource,
  orderTrackingId: string | null
): string {
  const peerId = normalizePrivateConversationPeerId(row);
  const pinId = (row.pin_id || '').trim();
  const txidPart = orderTrackingId ? orderTrackingId.slice(0, 12) : 'no-txid';
  const suffix = pinId || String(Date.now());
  return `${source}:order:${peerId}:${txidPart}:${suffix}`;
}

function normalizeHandshakeWord(value: string): string {
  // Keep only ASCII letters to make ping/pong matching tolerant to punctuation/whitespace.
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

export function isPrivateChatHandshakePlaintext(value: string): boolean {
  const handshakeWord = normalizeHandshakeWord(String(value || '').trim());
  return handshakeWord === 'ping' || handshakeWord === 'pong';
}

function normalizeMetabotId(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export function shouldContinuePrivateChatInboundAfterOutgoingSync(input: {
  senderMetabotId?: unknown;
  recipientMetabotId?: unknown;
}): boolean {
  const senderMetabotId = normalizeMetabotId(input.senderMetabotId);
  const recipientMetabotId = normalizeMetabotId(input.recipientMetabotId);
  return Boolean(senderMetabotId && recipientMetabotId && senderMetabotId !== recipientMetabotId);
}

function buildPrivateReplySystemPrompt(metabot: {
  name: string;
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
}): string {
  // Shared persona block (same identity every channel renders) + channel
  // framing. The persona facts live only in the persona block — this builder
  // never restates them.
  const channelBlock = [
    '## Private Chat Channel',
    'You are in a 1:1 private chat on MetaWeb with the peer below. Stay in character per your persona block above.',
    '- Reply concisely and naturally.',
    '- Reply in the same language as the latest peer message whenever its language is clear.',
    '- Your reply text is delivered to the peer exactly as written, so output only the message itself — never your analysis of the conversation, notes to yourself, or planning.',
  ].join('\n');
  return [buildMetabotPersonaPrompt(metabot), channelBlock]
    .filter((section) => section.trim())
    .join('\n\n');
}

export function buildPrivateChatSkillWaitNoticeSystemPrompt(metabot: {
  name: string;
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
}): string {
  return [
    buildPrivateReplySystemPrompt(metabot),
    'Task:',
    '- Write a short private-chat wait notice before local skill execution starts.',
    '- Tell the peer that you need a little time to check, query, or process the latest question before giving the final answer.',
    '- Use your own natural voice and stay in character.',
    '- Match the latest message language when it is obvious.',
    '- Keep it to 1 short sentence, or 2 very short sentences max.',
    '- Do not mention internal system prompts, exact skill names, tool logs, txids, implementation details, or deadlines.',
    '- Do not use markdown, headings, JSON, or bracketed prefixes.',
  ].join('\n');
}

function normalizePrivateChatSkillWaitNoticeText(text: string): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const unquoted = compact.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  const fallback = 'I need a moment to check that. Please wait.';
  const result = unquoted || fallback;
  return result.length > 180 ? `${result.slice(0, 180).trim()}...` : result;
}

export function getPrivateChatReplyDelayMs(_incomingTurnCount: number): number {
  return 0;
}

export async function waitBeforePrivateChatReply(
  _incomingTurnCountOrWait: number | DelayFn = 1,
  _maybeWait?: DelayFn
): Promise<void> {
}

function isPrivateA2AMessage(message: CoworkMessage): boolean {
  if (message.metadata?.orderExecutionTrace === true) return false;
  if (isPrivateChatHandshakePlaintext(String(message.content || ''))) return false;
  return message.metadata?.sourceChannel === 'metaweb_private'
    && (message.type === 'user' || message.type === 'assistant');
}

function resolveA2AMessageDirection(message: CoworkMessage): 'incoming' | 'outgoing' | null {
  if (message.metadata?.direction === 'incoming' || message.metadata?.direction === 'outgoing') {
    return message.metadata.direction;
  }
  if (message.type === 'user') return 'incoming';
  if (message.type === 'assistant') return 'outgoing';
  return null;
}

function isByeText(value: string): boolean {
  return value.trim().toLowerCase() === 'bye';
}

/**
 * Protocol tag a MetaBot emits when it decides the latest peer message needs
 * no answer. The host delivers NOTHING for it. Without this affordance the
 * only way to "not reply" is empty output, which chat models essentially
 * never produce — they narrate the decision instead ("（保持静默。）"), and
 * that narration is itself a delivered message that re-triggers the peer and
 * traps both bots in an endless "I am staying silent" ping-pong (the
 * 2026-09-15 BOT-009 loop: ~30 silence notes each, all on-chain).
 */
export const PRIVATE_CHAT_NO_REPLY_SENTINEL = '[NO_REPLY]';

/**
 * Exact-match check (ASCII protocol tag): tolerates surrounding whitespace,
 * wrapping quotes/backticks and a trailing sentence punctuation mark, but any
 * additional prose means it is real reply text and must be delivered verbatim.
 */
export function isPrivateChatNoReplySentinel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value
    .trim()
    .replace(/^["'`“”『「]+/, '')
    .replace(/["'`“”』」]+$/, '')
    .replace(/[.!。！？?…]+$/, '')
    .trim()
    .toLowerCase();
  return normalized === PRIVATE_CHAT_NO_REPLY_SENTINEL.toLowerCase();
}

/**
 * Host notice appended to the system prompt when an A2A reply turn is re-run
 * because the previous attempt completed WITHOUT any final reply text — the
 * 2026-09-16 stall: opencode/DeepSeek turns completed normally with the whole
 * answer drafted inside the reasoning block and no final text message, and the
 * silent markProcessed of that empty reply stranded the peer forever.
 */
export function buildPrivateChatEmptyReplyRetryNotice(attempt: number): string {
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  return [
    `## Host Retry Notice (attempt ${safeAttempt} for the latest peer message)`,
    'Your previous turn for the latest peer message ended with no final reply text — for example a reasoning-only completion where the whole answer stayed inside the thinking block.',
    'The host delivers ONLY your final text message to the peer; reasoning content is never delivered. An empty turn is not a valid outcome.',
    'Answer the latest peer message again now and make sure the reply is emitted as a regular final text message outside any thinking block.',
    'If you genuinely have nothing to deliver, reply with exactly `[NO_REPLY]`.',
  ].join('\n');
}

export function shouldSkipPrivateChatAutoReplyText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === 'bye') return true;
  if (normalized === 'thinking...' || normalized === 'thinking…') return true;
  if (/^[.\s]+$/.test(normalized)) return true;
  if (/^[…\s]+$/.test(normalized)) return true;
  // A peer host on an older version may broadcast its own sentinel verbatim;
  // that is a silence marker, never something to answer.
  if (isPrivateChatNoReplySentinel(normalized)) return true;
  return false;
}

/**
 * Consecutive-identical-copy escalation threshold for the inbound
 * retransmission dedup below: the 2nd copy is absorbed (loop protection),
 * the 3rd consecutive identical copy runs as an insistent re-ask.
 */
const PRIVATE_CHAT_REPEAT_ESCALATION_AFTER = 3;

/**
 * Per-conversation count of consecutive absorbed verbatim duplicates.
 * Keyed `${metabotId}:${externalConversationId}`; entries reset when a
 * different plaintext arrives, when the window lapses, or on escalation.
 * Module-level because processOne runs per row with no daemon-lifetime
 * closure to hold it; the window check bounds staleness.
 */
const inboundRepeatEscalation = new Map<string, { plaintext: string; count: number; firstAt: number }>();

/**
 * True when the inbound plaintext is verbatim-identical to the immediately
 * previous inbound message of the same active conversation segment. The first
 * copy already drove (or is driving) a reply turn, so re-running the model for
 * each identical retransmission only feeds degenerate loops — the 2026-09-17
 * BOT-009 ping-pong, where both hosts mirrored each other's silence notes
 * ("（静默。）") for 40+ on-chain messages. Pure byte-equality dedup on the
 * message stream; no wording, language, or intent is interpreted.
 */
export function isRepeatPrivateChatInboundMessage(params: {
  messages: CoworkMessage[];
  plaintext: string;
  now?: number;
  /**
   * Chain identity of the row currently being processed. Messages matching it
   * are the SAME chain message already recorded locally (e.g. the owner sent
   * it from this machine and the UI appended it optimistically) — not a
   * retransmission — so they must not suppress the reply turn.
   */
  excludeChainRow?: PrivateChatMessageRow | null;
}): boolean {
  const target = String(params.plaintext ?? '').trim();
  if (!target) return false;
  const now = Number.isFinite(params.now) ? (params.now as number) : Date.now();
  const a2aMessages = params.messages
    .filter(isPrivateA2AMessage)
    .filter((message) => (
      !params.excludeChainRow
      || !metadataHasPrivateChatChainIdentity(message.metadata, params.excludeChainRow)
    ));
  for (let i = a2aMessages.length - 1; i >= 0; i -= 1) {
    const message = a2aMessages[i];
    if (!message) continue;
    if (resolveA2AMessageDirection(message) !== 'incoming') continue;
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : now;
    if (now - timestamp > A2A_SESSION_CONVERSATION_GAP_MS) return false;
    return String(message.content ?? '').trim() === target;
  }
  return false;
}

/**
 * Delivery-side degenerate-loop guard. Counts the trailing run of already
 * delivered outgoing messages that are verbatim-identical to the candidate
 * reply (skill wait notices and failed/suppressed deliveries do not count).
 * A bot never needs to say the exact same thing three times in a row: once
 * the tail shows two identical delivered replies, a third identical delivery
 * is definitionally an echo loop — the converged stage of the 2026-09-17
 * silence ping-pong, where flash-tier models ignored the `[NO_REPLY]`
 * protocol and mirrored the peer's silence notation back onto the chain.
 * Language-agnostic by construction: byte equality only.
 */
export const PRIVATE_CHAT_ECHO_GUARD_MIN_REPEATS = 2;

export function wouldCreatePrivateChatEchoLoop(params: {
  messages: CoworkMessage[];
  replyText: string;
  minRepeats?: number;
}): boolean {
  const target = String(params.replyText ?? '').trim();
  if (!target) return false;
  const requestedMinRepeats = params.minRepeats;
  const minRepeats = Number.isFinite(requestedMinRepeats) && (requestedMinRepeats as number) >= 1
    ? Math.floor(requestedMinRepeats as number)
    : PRIVATE_CHAT_ECHO_GUARD_MIN_REPEATS;
  const deliveredOutgoing = params.messages
    .filter(isPrivateA2AMessage)
    .filter((message) => (
      resolveA2AMessageDirection(message) === 'outgoing'
      && message.metadata?.privateChatNoReply !== true
      && message.metadata?.privateChatSkillWaitNotice !== true
      && message.metadata?.privateChatDeliveryStatus !== 'failed'
    ));
  let identicalRun = 0;
  for (let i = deliveredOutgoing.length - 1; i >= 0; i -= 1) {
    if (String(deliveredOutgoing[i]?.content ?? '').trim() !== target) break;
    identicalRun += 1;
  }
  return identicalRun >= minRepeats;
}

export function analyzePrivateChatA2AConversation(params: {
  messages: CoworkMessage[];
  now?: number;
  /** Per-MetaBot max incoming turns per active session; defaults to the app-wide default. */
  maxIncomingTurns?: number;
}): PrivateChatA2AAnalysis {
  const maxIncomingTurns = normalizeA2AMaxIncomingTurns(params.maxIncomingTurns);
  const sortedMessages = params.messages
    .filter(isPrivateA2AMessage)
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);
  let activeSegment: PrivateChatA2AContextMessage[] = [];
  let previousSegmentTail: PrivateChatA2AContextMessage[] = [];
  let previousTimestamp: number | null = null;
  // Conversation-scoped bye pressure: incoming messages since the current
  // conversation opened. A conversation ends (and the counter resets) on a
  // >5-min gap or a bye from EITHER side — release-audit follow-up 2026-09-19:
  // the previous thread-cumulative reading (reset only on our own outgoing
  // bye) force-byed long-lived threads every maxIncomingTurns CUMULATIVE
  // inbound messages, which is exactly the twin→owner daily-report pattern:
  // one short message a day, every conversation well under the cap, and the
  // thread still got a forced "bye" every 50 cumulative messages, forever.
  // Continuous chatter still accumulates: a peer keeping the thread hot
  // without a pause cannot outlive the policy.
  let incomingSinceBye = 0;

  for (const message of sortedMessages) {
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : params.now ?? Date.now();
    if (
      previousTimestamp != null
      && timestamp - previousTimestamp > A2A_SESSION_CONVERSATION_GAP_MS
    ) {
      previousSegmentTail = activeSegment.slice(-PRIVATE_CHAT_PREVIOUS_SEGMENT_CONTEXT_MESSAGES);
      activeSegment = [];
      incomingSinceBye = 0;
    }
    previousTimestamp = timestamp;

    const direction = resolveA2AMessageDirection(message);
    if (!direction) continue;

    const content = String(message.content || '').trim();
    if (!content) continue;
    if (direction === 'outgoing' && isByeText(content)) {
      previousSegmentTail = [];
      activeSegment = [];
      incomingSinceBye = 0;
      continue;
    }
    if (direction === 'incoming' && isByeText(content)) {
      // The peer ended the conversation — same reset as our own bye: the next
      // exchange is a new conversation with fresh pressure, and the bye text
      // itself is neither context nor a counted turn (previously it was
      // pushed as context AND counted +1 toward our forced bye).
      previousSegmentTail = [];
      activeSegment = [];
      incomingSinceBye = 0;
      continue;
    }

    const senderName = typeof message.metadata?.senderName === 'string'
      ? message.metadata.senderName.trim()
      : '';
    activeSegment.push({
      speaker: direction === 'incoming' ? (senderName || 'Peer Bot') : 'Local Bot',
      content,
      timestamp,
      direction,
    });
    if (direction === 'incoming') {
      incomingSinceBye += 1;
    }
  }

  const activeContextMessages = activeSegment.slice(-PRIVATE_CHAT_CONTEXT_MAX_MESSAGES);
  const previousContextSlots = Math.max(0, PRIVATE_CHAT_CONTEXT_MAX_MESSAGES - activeContextMessages.length);
  const previousContextMessages = previousContextSlots > 0
    ? previousSegmentTail.slice(-Math.min(PRIVATE_CHAT_PREVIOUS_SEGMENT_CONTEXT_MESSAGES, previousContextSlots))
    : [];
  const contextMessages = [
    ...previousContextMessages,
    ...activeContextMessages,
  ];
  const incomingTurnCount = incomingSinceBye;
  return {
    contextMessages,
    incomingTurnCount,
    shouldForceBye: incomingTurnCount >= maxIncomingTurns,
  };
}

export function buildPrivateChatA2ASystemPrompt(params: {
  metabot: {
    name: string;
    role?: string | null;
    soul?: string | null;
    goal?: string | null;
    bio?: string | null;
    /** Deprecated compatibility field; use bio. */
    background?: string | null;
  };
  memoryContext?: string;
  analysis: PrivateChatA2AAnalysis;
  skillsPrompt?: string | null;
  skillWaitNoticeAlreadySent?: boolean;
  operatorGuidance?: string | null;
  /** Per-MetaBot max incoming turns per active session; defaults to the app-wide default. */
  maxIncomingTurns?: number;
}): string {
  const maxIncomingTurns = normalizeA2AMaxIncomingTurns(params.maxIncomingTurns);
  const closingPhaseTurns = deriveA2AClosingPhaseTurns(maxIncomingTurns);
  const localName = params.metabot.name || 'Local Bot';
  const allowedSkillsPrompt =
    !params.analysis.shouldForceBye && typeof params.skillsPrompt === 'string'
      ? params.skillsPrompt.trim()
      : '';
  const contextLines = params.analysis.contextMessages.length > 0
    ? params.analysis.contextMessages.map((message) => {
        const speaker = message.direction === 'outgoing' ? localName : message.speaker;
        return `${speaker}: ${message.content}`;
      })
    : ['(no prior messages in this active private-chat session)'];
  const closingPhaseRule = params.analysis.incomingTurnCount > closingPhaseTurns && !params.analysis.shouldForceBye
    ? '- The conversation is entering the closing phase. Guide the discussion toward a natural conclusion. If there is no valuable discussion or pending questions, politely begin wrapping up the conversation.'
    : '';

  const forceByeRule = params.analysis.shouldForceBye
    ? `- This active conversation has reached the ${maxIncomingTurns} turns limit. Reply exactly "bye" now, with no other text.`
    : '- If the conversation no longer seems likely to produce useful new information, end the topic by replying exactly "bye".';
  const skillPolicyRule = allowedSkillsPrompt
    ? '- You may use only the local skills listed in <available_skills> when they clearly help answer the latest private-chat message.'
    : '- Do not claim local tool access or execute local skills in this regular private chat.';
  const skillWaitNoticeRule = allowedSkillsPrompt
    ? params.skillWaitNoticeAlreadySent
      ? '- A brief wait notice has already been sent for this local-skill turn. Do not repeat it as the final answer; use the skill if needed and then answer with the result.'
      : '- If local skill execution actually starts, the host will send a brief wait notice to the peer at that moment. Do not preface normal replies with wait notices; answer directly when no skill is needed.'
    : '';

  const basePrompt = [
    buildPrivateReplySystemPrompt(params.metabot),
    '',
    '## MetaBot-to-MetaBot Private Chat Policy',
    '- You are speaking with another MetaBot in an autonomous private chat.',
    '- Use the active private-chat context below as the conversation history for this round.',
    '- Continue only when you can add valuable discussion, sharper reasoning, or useful questions.',
    '- Keep the discussion around one coherent topic instead of drifting between unrelated subjects.',
    '- Avoid empty pleasantries, loops, repeated introductions, and generic filler.',
    '- You do not need to reply to every message; reply only to the latest meaningful message. When the latest message needs no answer — a work-in-progress signal, a hold marker, a mere acknowledgement, meaningless placeholder/closing content such as "Thinking...", "....", or "bye", or a silence/hold announcement in any wording or notation (for example a parenthesized "staying silent" note) — reply with exactly `[NO_REPLY]` and nothing else: the host then delivers nothing to the peer.',
    '- Before choosing `[NO_REPLY]`, check what YOU still owe the peer. The host only runs you again when a NEW peer message arrives, so if your own earlier reply promised a later answer or update (for example you said you would verify something and come back with the result), a `[NO_REPLY]` now leaves both sides waiting forever. When you owe the peer an answer, deliver it (or a substantive interim result) as your reply; when the conversation has nothing left to produce, close it by replying exactly "bye". Choose `[NO_REPLY]` only when the latest message needs no answer AND you owe the peer nothing.',
    '- Your reply is delivered to the peer on-chain verbatim, word for word. Output ONLY the final message for the peer: make the judgment calls in this policy (whether to reply, wrapping up, saying bye) silently, and never narrate them as text before or around your reply — a reply that opens with your own analysis of the peer\'s message ("this looks like a duplicate closing message, I will close briefly") leaks your internal state to the peer.',
    '- Your final reply MUST be a regular text message outside any thinking/reasoning block. The host delivers ONLY your final text — reasoning content is never sent to the peer. Ending a turn with the whole answer drafted inside reasoning and no final text is a protocol violation that leaves the peer waiting forever; if you have decided to say nothing, reply with exactly `[NO_REPLY]` instead of ending wordless.',
    '- Never announce silence, waiting, or "no reply needed" in words. Such an announcement IS a delivered message: it forces the peer to process and answer it, trapping both bots in an endless exchange of "I am staying silent" notes. Staying silent means replying `[NO_REPLY]` (the host delivers nothing) — never telling the peer that you will stay silent.',
    '- Never mirror or reuse the peer\'s silence notation. When the peer\'s message is itself a silence/hold announcement — in any language or notation — treat it as a no-op and reply `[NO_REPLY]`; echoing a silence note back (or answering it substantively) traps both bots in an endless loop of silence notes.',
    '- MetaWeb references: cite on-chain content with a full, clickable MetaWeb URI — pin://<pinId> for any pin (the correct choice for readable text: simplenote notes, buzz posts), metafile://<pinId> ONLY for binary files published on /file (images, video, audio, PDF, archives), metaapp://<pinId> for MetaApps, metaid://<globalMetaId> for people/bots. Never send Web2 viewer URLs, and never deliver a text/Markdown document as a metafile:// upload — publish readable text as a simplenote note and reference it as pin://.',
    skillPolicyRule,
    skillWaitNoticeRule,
    forceByeRule,
    closingPhaseRule,
    '- When you say "bye", say exactly "bye" and nothing else.',
    `- Active incoming turn count: ${params.analysis.incomingTurnCount}/${maxIncomingTurns} turns.`,
    ...(allowedSkillsPrompt
      ? [
          '',
          allowedSkillsPrompt,
          '',
          'After using Read/Bash to run a skill, reply concisely in the private chat. Do not paste full skill logs.',
        ]
      : []),
    '',
    '## Active Private Chat Context',
    ...contextLines,
    ...(params.memoryContext ? ['', params.memoryContext] : []),
  ].join('\n');
  return appendA2AGuidanceToSystemPrompt(
    basePrompt,
    params.analysis.shouldForceBye ? null : params.operatorGuidance,
  );
}

function buildSellerOrderAcknowledgementSystemPrompt(metabot: {
  name: string;
  role?: string | null;
  soul?: string | null;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility field; use bio. */
  background?: string | null;
}): string {
  return [
    buildPrivateReplySystemPrompt(metabot),
    'Task:',
    '- Write a short private acknowledgement for a paid service order before execution starts.',
    '- Confirm that you understood the client request and are starting work now.',
    '- Tell the client that skill execution may take some time and ask them to wait patiently for the final result.',
    '- Use the same language as the original order request whenever its language is clear.',
    '- Keep it to 1 sentence, or 2 short sentences max.',
    '- Do not mention payment amount, txid, service id, skill id, deadlines, ratings, or system details.',
    '- Do not use markdown, headings, JSON, or bracketed prefixes.',
  ].join('\n');
}

function normalizeSellerOrderAcknowledgementText(text: string): string {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact || 'I received your request and have started working on it. Skill execution may take some time, so please wait for the final result.';
}

async function waitForSellerOrderAcknowledgement(textPromise: Promise<string>): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('seller_order_acknowledgement_timeout'));
    }, SELLER_ORDER_ACKNOWLEDGEMENT_TIMEOUT_MS);

    textPromise.then(
      (text) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(text);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

function buildImmediateSellerOrderAcknowledgementText(peerName?: string | null): string {
  const name = peerName?.trim();
  const prefix = name ? `${name}, ` : '';
  return `${prefix}I received your service request and will start now. Skill execution may take some time, so please wait.`;
}

function markSellerOrderFirstResponseSent(params: {
  serviceOrderLifecycle?: Pick<ServiceOrderLifecycleService, 'markSellerOrderFirstResponseSent'> | null;
  metabotId: number;
  peerGlobalMetaId: string;
  orderPinId?: string | null;
  paymentTxid?: string | null;
  sentAt: number;
}): void {
  if (!params.serviceOrderLifecycle || (!params.orderPinId && !params.paymentTxid)) return;
  params.serviceOrderLifecycle.markSellerOrderFirstResponseSent({
    localMetabotId: params.metabotId,
    counterpartyGlobalMetaId: params.peerGlobalMetaId,
    ...(params.orderPinId ? { orderPinId: params.orderPinId } : {}),
    ...(params.paymentTxid ? { paymentTxid: params.paymentTxid } : {}),
    sentAt: params.sentAt,
  });
}

export function markSellerOrderExecutionFailed(params: {
  serviceOrderLifecycle?: Pick<ServiceOrderLifecycleService, 'markSellerOrderFailed'> | null;
  metabotId: number;
  peerGlobalMetaId: string;
  orderPinId?: string | null;
  paymentTxid?: string | null;
  orderMessageTxid?: string | null;
  failureReason: string;
  failedAt: number;
}): void {
  if (
    !params.serviceOrderLifecycle
    || (!params.orderPinId && !params.paymentTxid && !params.orderMessageTxid)
  ) {
    return;
  }
  params.serviceOrderLifecycle.markSellerOrderFailed({
    localMetabotId: params.metabotId,
    counterpartyGlobalMetaId: params.peerGlobalMetaId,
    ...(params.orderPinId ? { orderPinId: params.orderPinId } : {}),
    ...(params.paymentTxid ? { paymentTxid: params.paymentTxid } : {}),
    ...(params.orderMessageTxid ? { orderMessageTxid: params.orderMessageTxid } : {}),
    failureReason: params.failureReason,
    failedAt: params.failedAt,
  });
}

function cleanNonDeliverableFallbackDetail(fallbackDetail?: string | null): string {
  const raw = String(fallbackDetail || '').trim();
  if (!raw) return '';
  const parsed = parseOrderStatusMessage(raw);
  return String(parsed?.content || raw)
    .replace(/^\[ORDER_STATUS(?::[^\]]+)?\]\s*/i, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*order\s+pin\s+id\s*[:：=]/i.test(line))
    .join('\n')
    .trim();
}

export function buildNonDeliverableSellerFailureNotice(input: {
  outputType?: ServiceOrderOutputType | string | null;
  fallbackDetail?: string | null;
} = {}): string {
  const outputType = normalizeServiceOutputType(input.outputType);
  const detail = cleanNonDeliverableFallbackDetail(input.fallbackDetail);
  return [
    `The service provider could not deliver the agreed ${outputType} result.`,
    detail,
    'The system will start the refund process automatically. Do not submit a positive rating for this service.',
  ].filter(Boolean).join('\n');
}

function resolveNonDeliverableSellerFailureReason(fallbackDetail?: string | null): string {
  const detail = String(fallbackDetail || '');
  if (/超时|timed out|timeout/i.test(detail)) {
    return 'delivery_timeout';
  }
  return SERVICE_ORDER_DELIVERY_ARTIFACT_FAILED_REASON;
}

function buildOrderExecutionFailureNotice(error: unknown): string {
  const rawReason = error instanceof Error ? error.message : String(error || '');
  const reason = rawReason.replace(/\s+/g, ' ').trim();
  const compactReason = reason.length > 160 ? `${reason.slice(0, 160)}...` : reason;
  if (/timed out|timeout/i.test(reason)) {
    return [
      'The service execution timed out before producing a final result.',
      compactReason ? `Reason: ${compactReason}` : '',
      'If no formal delivery arrives later, the system will start a refund automatically.',
    ].filter(Boolean).join('\n');
  }

  return [
    'The service execution failed before producing a final result.',
    compactReason ? `Reason: ${compactReason}` : '',
    'If no formal delivery arrives later, the system will start a refund automatically.',
  ].filter(Boolean).join('\n');
}

function buildOrderSkillScopeFailureNotice(scope: SellerOrderSkillScopeResolution): string {
  const requested = scope.allowedSkillNames.join(', ');
  const missing = scope.missingSkillNames.join(', ');
  return [
    'The allowed skills specified by this service order could not be resolved to enabled local skills, so the order cannot run within its authorized scope.',
    requested ? `Allowed skill scope: ${requested}.` : '',
    missing ? `Missing local skills: ${missing}.` : '',
    'To stay within the order authorization, no unapproved local skills will be used.',
  ].filter(Boolean).join('\n');
}

function buildOrderDeliveryFundingFailureNotice(budget: OrderDeliveryBudget): string {
  const fundableMb = (budget.fundableBytes / (1024 * 1024)).toFixed(1);
  return [
    'The service provider cannot accept this order right now: the provider wallet balance is too low to pay the on-chain delivery fee for the result file.',
    `Current delivery capacity is about ${fundableMb} MB of on-chain upload, which is below the minimum a deliverable file requires.`,
    'The order was rejected before any skill execution, so no work was started.',
    'The system will start the refund process automatically. Do not submit a positive rating for this service.',
  ].join('\n');
}

export async function sendSellerOrderAcknowledgement(params: {
  metabot: {
    id: number;
    name: string;
    role?: string | null;
    soul?: string | null;
    goal?: string | null;
    bio?: string | null;
    /** Deprecated compatibility field; use bio. */
    background?: string | null;
    llm_id?: string | null;
    llm_provider?: string | null;
    fallback_llm_id?: string | null;
    fallback_llm_provider?: string | null;
  };
  peerGlobalMetaId: string;
  peerName?: string | null;
  plaintext: string;
  skillName?: string | null;
  paymentTxid?: string | null;
  orderPinId?: string | null;
  orderTxid?: string | null;
  performChat: (
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
  sendEncryptedMsg: (text: string) => Promise<{ pinId?: string | null; txids?: string[] | null }>;
  serviceOrderLifecycle?: Pick<ServiceOrderLifecycleService, 'markSellerOrderFirstResponseSent'> | null;
  emitLog?: (msg: string) => void;
  now?: () => number;
}): Promise<{ text: string; pinId: string | null; txids: string[] }> {
  const peerName = params.peerName?.trim() || 'the client';
  const llmId = normalizeMetabotLlmId(params.metabot.llm_id) ?? undefined;
  const llmProvider = normalizeMetabotLlmId(params.metabot.llm_provider);
  const fallbackLlmId = normalizeMetabotLlmId(params.metabot.fallback_llm_id);
  const fallbackLlmProvider = normalizeMetabotLlmId(params.metabot.fallback_llm_provider);
  const ackSystemPrompt = buildSellerOrderAcknowledgementSystemPrompt(params.metabot);
  const requestText = extractOrderRequestText(params.plaintext) || String(params.plaintext || '').trim();
  const ackUserPrompt = [
    `Client name: ${peerName}`,
    params.skillName?.trim() ? `Required skill: ${params.skillName.trim()}` : '',
    'Original order request:',
    requestText,
  ].filter(Boolean).join('\n');

  let acknowledgementText = 'I received your request and have started working on it. Skill execution may take some time, so please wait for the final result.';
  try {
    acknowledgementText = normalizeSellerOrderAcknowledgementText(
      await waitForSellerOrderAcknowledgement(
        params.performChat(ackSystemPrompt, ackUserPrompt, llmId, { llmProvider, fallbackLlmId, fallbackLlmProvider })
      )
    );
  } catch (error) {
    rethrowSqliteWasmBoundsError(error);
    params.emitLog?.(
      `[Order] Acknowledgement generation failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const transmittedText = params.orderTxid || params.orderPinId
    ? buildOrderStatusMessage(params.orderTxid, acknowledgementText, params.orderPinId)
    : acknowledgementText;
  const result = await params.sendEncryptedMsg(transmittedText);
  const sentAt = params.now ? params.now() : Date.now();
  markSellerOrderFirstResponseSent({
    serviceOrderLifecycle: params.serviceOrderLifecycle,
    metabotId: params.metabot.id,
    peerGlobalMetaId: params.peerGlobalMetaId,
    orderPinId: params.orderPinId,
    paymentTxid: params.paymentTxid,
    sentAt,
  });
  params.emitLog?.(`[Order] Acknowledgement sent to ${params.peerGlobalMetaId.slice(0, 12)}…`);

  return {
    text: transmittedText,
    pinId: result.pinId ?? null,
    txids: Array.isArray(result.txids) ? result.txids : [],
  };
}

export async function sendSellerOrderImmediateAcknowledgement(params: {
  metabot: {
    id: number;
    name: string;
    role?: string | null;
    soul?: string | null;
    goal?: string | null;
    bio?: string | null;
    /** Deprecated compatibility field; use bio. */
    background?: string | null;
    llm_id?: string | null;
  };
  peerGlobalMetaId: string;
  peerName?: string | null;
  paymentTxid?: string | null;
  orderPinId?: string | null;
  orderTxid?: string | null;
  sendEncryptedMsg: (text: string) => Promise<{ pinId?: string | null; txids?: string[] | null }>;
  serviceOrderLifecycle?: Pick<ServiceOrderLifecycleService, 'markSellerOrderFirstResponseSent'> | null;
  emitLog?: (msg: string) => void;
  now?: () => number;
}): Promise<{ text: string; pinId: string | null; txids: string[] }> {
  const acknowledgementText = buildImmediateSellerOrderAcknowledgementText(params.peerName);
  const transmittedText = params.orderTxid || params.orderPinId
    ? buildOrderStatusMessage(params.orderTxid, acknowledgementText, params.orderPinId)
    : acknowledgementText;
  const result = await params.sendEncryptedMsg(transmittedText);
  const sentAt = params.now ? params.now() : Date.now();
  markSellerOrderFirstResponseSent({
    serviceOrderLifecycle: params.serviceOrderLifecycle,
    metabotId: params.metabot.id,
    peerGlobalMetaId: params.peerGlobalMetaId,
    orderPinId: params.orderPinId,
    paymentTxid: params.paymentTxid,
    sentAt,
  });
  params.emitLog?.(`[Order] Immediate acknowledgement sent to ${params.peerGlobalMetaId.slice(0, 12)}...`);

  return {
    text: transmittedText,
    pinId: result.pinId ?? null,
    txids: Array.isArray(result.txids) ? result.txids : [],
  };
}

export function buildPrivateReplyMemoryPromptBlocks(params: {
  memoryBackend: Pick<MemoryBackend, 'listUserMemories'>;
  metabotId: number;
  sourceChannel: string;
  externalConversationId: string;
  peerGlobalMetaId?: string | null;
  limit: number;
  currentUserText?: string;
}): string {
  const resolved = resolveMemoryScopes({
    metabotId: params.metabotId,
    sourceChannel: params.sourceChannel,
    externalConversationId: params.externalConversationId,
    peerGlobalMetaId: params.peerGlobalMetaId,
    sessionType: 'a2a',
  });

  const ownerEntries = resolved.ownerReadPolicy === 'none'
    ? []
    : params.memoryBackend.listUserMemories({
        metabotId: params.metabotId,
        scope: createOwnerMemoryScope(),
        status: 'created',
        includeDeleted: false,
        limit: Math.max(params.limit, 12),
        offset: 0,
        // Injection IS the usage event for the hygiene decay clock.
        touchLastUsed: true,
      });
  const contactEntries = resolved.writeScope.kind === 'contact'
    ? params.memoryBackend.listUserMemories({
        metabotId: params.metabotId,
        scope: resolved.writeScope,
        status: 'created',
        includeDeleted: false,
        limit: params.limit,
        offset: 0,
        touchLastUsed: true,
      })
    : [];
  const conversationEntries = resolved.writeScope.kind === 'conversation'
    ? params.memoryBackend.listUserMemories({
        metabotId: params.metabotId,
        scope: resolved.writeScope,
        status: 'created',
        includeDeleted: false,
        limit: params.limit,
        offset: 0,
        touchLastUsed: true,
      })
    : [];

  return buildScopedMemoryPromptBlocks({
    channel: params.sourceChannel,
    currentUserText: params.currentUserText,
    ownerEntries,
    contactEntries,
    conversationEntries,
    maxOwnerEntries: params.limit,
    maxScopedEntries: params.limit,
    maxOwnerOperationalPreferences: Math.min(3, params.limit),
  });
}

function normalizePrivateConversationPeerId(row: PrivateChatMessageRow): string {
  const globalMetaId = (row.from_global_metaid ?? '').trim();
  if (globalMetaId) return globalMetaId;
  const fallbackMetaId = (row.from_metaid ?? '').trim();
  if (fallbackMetaId) return fallbackMetaId;
  return 'unknown-peer';
}

function buildPrivateConversationExternalConversationId(row: PrivateChatMessageRow): string {
  return buildCanonicalPrivateConversationExternalConversationId(normalizePrivateConversationPeerId(row));
}

function normalizeIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function matchesSenderIdentity(
  candidate: unknown,
  senderGlobalMetaId: string,
  senderMetaId: string
): boolean {
  const normalized = normalizeIdentity(candidate);
  return Boolean(normalized && (normalized === senderGlobalMetaId || normalized === senderMetaId));
}

export type PrivateChatAutoReplyPolicyReason =
  | 'disabled_metabot'
  | 'auto_reply_disabled'
  | 'owner'
  | 'respond_to_strangers_enabled'
  | 'prior_local_outbound'
  | 'stranger_blocked';

export function isPrivateChatFromMetabotOwner(params: {
  metabot: {
    boss_id?: number | null;
    boss_global_metaid?: string | null;
  };
  senderGlobalMetaId?: string | null;
  senderMetaId?: string | null;
  metabotStore: Pick<MetabotStore, 'getMetabotById'>;
}): boolean {
  const senderGlobalMetaId = normalizeIdentity(params.senderGlobalMetaId);
  const senderMetaId = normalizeIdentity(params.senderMetaId);
  if (!senderGlobalMetaId && !senderMetaId) return false;

  if (matchesSenderIdentity(params.metabot.boss_global_metaid, senderGlobalMetaId, senderMetaId)) {
    return true;
  }

  const bossId = Number(params.metabot.boss_id);
  if (!Number.isFinite(bossId) || bossId <= 0) return false;

  const boss = params.metabotStore.getMetabotById(bossId);
  if (!boss) return false;
  return matchesSenderIdentity(boss.globalmetaid, senderGlobalMetaId, senderMetaId)
    || matchesSenderIdentity(boss.metaid, senderGlobalMetaId, senderMetaId);
}

export function evaluatePrivateChatAutoReplyPolicy(params: {
  metabot: {
    enabled?: boolean;
    /** Per-MetaBot A2A auto-reply toggle; null/undefined = default (on). */
    a2a_auto_reply_enabled?: boolean | null;
    boss_id?: number | null;
    boss_global_metaid?: string | null;
  };
  senderGlobalMetaId?: string | null;
  senderMetaId?: string | null;
  listenerConfig?: Partial<ListenerConfig> | null;
  metabotStore: Pick<MetabotStore, 'getMetabotById'>;
  hasPriorLocalOutbound: boolean;
}): { shouldReply: boolean; reason: PrivateChatAutoReplyPolicyReason } {
  if (params.metabot.enabled === false) {
    return { shouldReply: false, reason: 'disabled_metabot' };
  }

  if (!normalizeA2AAutoReplyEnabled(params.metabot.a2a_auto_reply_enabled)) {
    return { shouldReply: false, reason: 'auto_reply_disabled' };
  }

  if (isPrivateChatFromMetabotOwner({
    metabot: params.metabot,
    senderGlobalMetaId: params.senderGlobalMetaId,
    senderMetaId: params.senderMetaId,
    metabotStore: params.metabotStore,
  })) {
    return { shouldReply: true, reason: 'owner' };
  }

  if (params.listenerConfig?.respondToStrangerPrivateChats !== false) {
    return { shouldReply: true, reason: 'respond_to_strangers_enabled' };
  }

  if (params.hasPriorLocalOutbound) {
    return { shouldReply: true, reason: 'prior_local_outbound' };
  }

  return { shouldReply: false, reason: 'stranger_blocked' };
}

export function hasPriorNonHandshakePrivateChatOutbound(
  db: Pick<Database, 'exec'>,
  params: {
    localGlobalMetaId?: string | null;
    localMetaId?: string | null;
    peerGlobalMetaId?: string | null;
    peerMetaId?: string | null;
    currentRowId?: number | null;
  }
): boolean {
  const localGlobalMetaId = normalizeIdentity(params.localGlobalMetaId);
  const localMetaId = normalizeIdentity(params.localMetaId);
  const peerGlobalMetaId = normalizeIdentity(params.peerGlobalMetaId);
  const peerMetaId = normalizeIdentity(params.peerMetaId);
  if ((!localGlobalMetaId && !localMetaId) || (!peerGlobalMetaId && !peerMetaId)) {
    return false;
  }

  const currentRowId = Number.isFinite(params.currentRowId)
    ? Number(params.currentRowId)
    : -1;
  const result = db.exec(
    `SELECT 1 AS found
     FROM private_chat_messages
     WHERE id <> ?
       AND (from_global_metaid = ? OR from_metaid = ?)
       AND (to_global_metaid = ? OR to_metaid = ?)
       AND lower(trim(COALESCE(content, ''))) NOT IN ('ping', 'pong')
     LIMIT 1`,
    [currentRowId, localGlobalMetaId, localMetaId, peerGlobalMetaId, peerMetaId]
  );
  return Boolean(result[0]?.values?.length);
}

export function hasNewerPrivateChatMessage(
  db: Pick<Database, 'exec'>,
  params: {
    currentRowId: number;
    fromGlobalMetaId?: string | null;
    fromMetaId?: string | null;
    toGlobalMetaId?: string | null;
    toMetaId?: string | null;
  }
): boolean {
  const fromGlobalMetaId = normalizeIdentity(params.fromGlobalMetaId);
  const fromMetaId = normalizeIdentity(params.fromMetaId);
  const toGlobalMetaId = normalizeIdentity(params.toGlobalMetaId);
  const toMetaId = normalizeIdentity(params.toMetaId);
  if ((!fromGlobalMetaId && !fromMetaId) || (!toGlobalMetaId && !toMetaId)) {
    return false;
  }

  const result = db.exec(
    `SELECT 1 AS found
     FROM private_chat_messages
     WHERE id > ?
       AND (from_global_metaid = ? OR from_metaid = ?)
       AND (to_global_metaid = ? OR to_metaid = ?)
     LIMIT 1`,
    [params.currentRowId, fromGlobalMetaId, fromMetaId, toGlobalMetaId, toMetaId]
  );
  return Boolean(result[0]?.values?.length);
}

export function hasPriorPrivateChatA2AOutbound(
  coworkStore: Pick<CoworkStore, 'getConversationMapping' | 'hasPriorPrivateA2AOutboundMessage'>,
  params: {
    externalConversationId: string;
    metabotId: number;
  }
): boolean {
  const mapping = coworkStore.getConversationMapping(
    'metaweb_private',
    params.externalConversationId,
    params.metabotId
  );
  if (!mapping) return false;

  return coworkStore.hasPriorPrivateA2AOutboundMessage(mapping.coworkSessionId);
}

function completeBuyerOrderObserverSession(
  coworkStore: CoworkStore,
  sessionId: string,
  emitToRenderer?: (channel: string, data: unknown) => void
): void {
  coworkStore.updateSession(sessionId, { status: 'completed' });
  if (emitToRenderer) {
    emitToRenderer('cowork:stream:complete', { sessionId });
  }
}

/**
 * Handle delivery of a result for an auto-delegated order.
 * Injects the delivery result into the original cowork session,
 * exits delegation blocking mode, and notifies the renderer.
 */
function handleAutoDeliveryResult(
  coworkStore: CoworkStore,
  sourceCoworkSessionId: string,
  deliveryContent: string,
  serviceName: string,
  paymentAmount: string,
  paymentCurrency: string,
  paymentTxid: string,
  orderId: string,
  emitLog: (msg: string) => void,
  emitToRenderer?: (channel: string, data: unknown) => void
): void {
  emitLog(`[AutoDelivery] Injecting delivery result into source cowork session ${sourceCoworkSessionId.slice(0, 8)}… from order ${orderId.slice(0, 8)}…`);

  // 1. Exit delegation blocking mode
  coworkStore.setDelegationBlocking(sourceCoworkSessionId, false);

  // 2. Extract the actual result text from the delivery message if possible
  const parsedContent = parseDeliveryMessage(deliveryContent);
  const resultText = parsedContent && typeof parsedContent.result === 'string'
    ? parsedContent.result
    : cleanServiceResultText(deliveryContent);

  // 3. Inject delivery result as assistant message into original cowork session
  const resultMsg = coworkStore.addMessage(sourceCoworkSessionId, {
    type: 'assistant',
    content: buildCoworkDeliveryResultMessage(resultText),
    metadata: {
      delegationDelivery: true,
      orderId,
      serviceName,
      paymentAmount,
      paymentCurrency,
      paymentTxid,
    },
  });

  // 4. Emit result message to renderer
  if (emitToRenderer) {
    emitToRenderer('cowork:stream:message', { sessionId: sourceCoworkSessionId, message: resultMsg });
  }

  // 5. Notify renderer that delegation is unblocked
  if (emitToRenderer) {
    emitToRenderer('cowork:delegation:stateChange', {
      sessionId: sourceCoworkSessionId,
      blocking: false,
    });
  }

  emitLog(`[AutoDelivery] Delegation unblocked for session ${sourceCoworkSessionId.slice(0, 8)}…`);
}

async function resolvePrivateConversationSession(
  coworkStore: CoworkStore,
  metabotId: number,
  localGlobalMetaId: string,
  row: PrivateChatMessageRow,
  firstMessage: string
): Promise<{
  sessionId: string;
  externalConversationId: string;
  episodeStarted: boolean;
}> {
  const peerId = normalizePrivateConversationPeerId(row);
  const externalConversationId = buildPrivateConversationExternalConversationId(row);
  const existing = coworkStore.getConversationMapping('metaweb_private', externalConversationId, metabotId);
  if (existing) {
    const session = coworkStore.getSessionWithoutMessages(existing.coworkSessionId);
    if (session) {
      const repaired = coworkStore.ensureCanonicalPeerSessionShape({
        sessionId: existing.coworkSessionId,
        metabotId,
        peerGlobalMetaId: peerId,
        peerName: (row.from_name as string | null) ?? null,
        peerAvatar: (row.from_avatar as string | null) ?? null,
      });
      if (repaired) {
        const repairedSession = coworkStore.getSessionWithoutMessages(existing.coworkSessionId) ?? session;
        const existingMetadata = parseConversationMappingMetadata(existing.metadataJson);
        coworkStore.registerA2AEpisode({
          sessionId: repairedSession.id,
          localMetabotId: metabotId,
          localGlobalMetaId,
          peerGlobalMetaId: peerId,
          episodeIndex: Number(existingMetadata.episodeIndex) || 1,
          previousSessionId: typeof existingMetadata.previousEpisodeSessionId === 'string'
            ? existingMetadata.previousEpisodeSessionId
            : null,
          startedAt: Number(existingMetadata.episodeStartedAt) || repairedSession.createdAt,
        });
        if (coworkStore.isSessionArchived(repairedSession.id)) {
          coworkStore.unarchiveSession(repairedSession.id);
        }
        coworkStore.touchConversationMapping('metaweb_private', externalConversationId, metabotId);
        return { sessionId: existing.coworkSessionId, externalConversationId, episodeStarted: false };
      }
      coworkStore.deleteConversationMapping('metaweb_private', externalConversationId, metabotId);
    } else {
      coworkStore.deleteConversationMapping('metaweb_private', externalConversationId, metabotId);
    }
  }

  const workspace = resolveSessionWorkingDirectory(coworkStore.getConfig().workingDirectory, metabotId);
  const fallbackTitle = firstMessage.split('\n')[0].slice(0, 50) || `Private-${peerId.slice(0, 12)}`;
  let generatedTitle: string | null = null;
  try {
    generatedTitle = await generateSessionTitle(firstMessage);
  } catch (error) {
    rethrowSqliteWasmBoundsError(error);
  }
  const title = generatedTitle?.trim() || fallbackTitle;
  const session = coworkStore.createSession(
    title,
    workspace,
    '',
    'local',
    [],
    metabotId,
    'a2a',
    peerId,
    (row.from_name as string | null) ?? null,
    (row.from_avatar as string | null) ?? null
  );
  coworkStore.upsertConversationMapping({
    channel: 'metaweb_private',
    externalConversationId,
    metabotId,
    coworkSessionId: session.id,
    metadataJson: JSON.stringify({
      peerGlobalMetaId: peerId,
      peerName: (row.from_name as string | null) ?? null,
      peerAvatar: (row.from_avatar as string | null) ?? null,
      a2aConversationId: externalConversationId,
      episodeIndex: 1,
      episodeStartedAt: session.createdAt,
    }),
  });
  const registeredEpisode = coworkStore.registerA2AEpisode({
    sessionId: session.id,
    localMetabotId: metabotId,
    localGlobalMetaId,
    peerGlobalMetaId: peerId,
    episodeIndex: 1,
    startedAt: session.createdAt,
  });
  coworkStore.updateConversationMappingMetadata('metaweb_private', externalConversationId, metabotId, {
    peerGlobalMetaId: peerId,
    peerName: (row.from_name as string | null) ?? null,
    peerAvatar: (row.from_avatar as string | null) ?? null,
    a2aConversationId: externalConversationId,
    a2aThreadId: registeredEpisode.threadId,
    episodeIndex: 1,
    episodeStartedAt: session.createdAt,
  });
  coworkStore.updateConversationMappingMetadata('cowork_ui', session.id, metabotId, {
    a2aConversationId: externalConversationId,
    a2aThreadId: registeredEpisode.threadId,
    episodeIndex: 1,
    episodeStartedAt: session.createdAt,
    peerGlobalMetaId: peerId,
  });
  return { sessionId: session.id, externalConversationId, episodeStarted: true };
}

/**
 * A2A session status is turn-scoped: a failed local turn writes 'error' (via
 * handleError / runSkillTurnInExistingSession), but the plain-chat reply path
 * and the outgoing-sync path never write a status back. One transient failure
 * therefore stranded long-lived conversations on a permanent error banner even
 * while the transcript kept moving. New transcript activity proves the
 * conversation lives on, so a session still resting on 'error' heals to
 * 'completed' — the resting state of healthy A2A sessions. Deliberately
 * narrow: only 'error' is touched (running/idle/stopped keep their meaning),
 * and a retrying skill turn that fails again simply re-writes 'error'.
 */
function healStaleA2AErrorStatus(params: {
  coworkStore: Pick<CoworkStore, 'getSessionWithoutMessages' | 'updateSession'>;
  sessionId: string;
  emitToRenderer?: RendererEmitter;
}): boolean {
  const session = params.coworkStore.getSessionWithoutMessages(params.sessionId);
  if (!session || session.sessionType !== 'a2a' || session.status !== 'error') {
    return false;
  }
  params.coworkStore.updateSession(params.sessionId, { status: 'completed' });
  // Same rest signal the order-observer close-out uses, so the renderer's
  // complete listener syncs the healed status into its session state.
  params.emitToRenderer?.('cowork:stream:complete', { sessionId: params.sessionId });
  return true;
}

export function appendPrivateChatA2AMessage(params: {
  coworkStore: Pick<CoworkStore, 'addMessage' | 'getSessionWithoutMessages' | 'updateSession'>;
  sessionId: string;
  externalConversationId: string;
  type: 'user' | 'assistant';
  content: string;
  senderGlobalMetaId?: string | null;
  senderName?: string | null;
  senderAvatar?: string | null;
  extraMetadata?: CoworkMessageMetadata;
  emitToRenderer?: RendererEmitter;
}): CoworkMessage {
  const metadata: CoworkMessageMetadata = {
    sourceChannel: 'metaweb_private',
    externalConversationId: params.externalConversationId,
    direction: params.type === 'user' ? 'incoming' : 'outgoing',
    ...(params.extraMetadata ?? {}),
  };

  if (params.type === 'user') {
    metadata.senderGlobalMetaId = params.senderGlobalMetaId ?? undefined;
    metadata.senderName = params.senderName ?? undefined;
    metadata.senderAvatar = params.senderAvatar ?? undefined;
    metadata.suppressRunningStatus = true;
  }

  const message = params.coworkStore.addMessage(params.sessionId, {
    type: params.type,
    content: params.content,
    metadata,
  });

  if (params.emitToRenderer) {
    params.emitToRenderer('cowork:stream:message', {
      sessionId: params.sessionId,
      message,
    });
  }

  healStaleA2AErrorStatus({
    coworkStore: params.coworkStore,
    sessionId: params.sessionId,
    emitToRenderer: params.emitToRenderer,
  });

  return message;
}

export interface RecordOutgoingPrivateChatA2ADisplayResult {
  sessionId: string;
  externalConversationId: string;
  message: CoworkMessage | null;
  duplicate: boolean;
}

/**
 * Make a locally sent private-chat message visible in the peer's A2A session.
 * Ensures the canonical metaweb_private session/mapping exists (creating it
 * for conversations started from the Bot Browser), appends the outgoing
 * assistant turn, and dedupes by chain identity so the later socket echo or
 * history backfill of the same pin does not produce a second bubble.
 */
export function recordOutgoingPrivateChatA2ADisplay(params: {
  coworkStore: CoworkStore;
  getMetabotById: (metabotId: number) => Pick<Metabot, 'id' | 'name' | 'globalmetaid'> | null;
  metabotId: number;
  peerGlobalMetaId: string;
  peerName?: string | null;
  peerAvatar?: string | null;
  content: string;
  chain?: { txId?: unknown; txids?: unknown; pinId?: unknown };
  extraMetadata?: CoworkMessageMetadata;
  emitToRenderer?: RendererEmitter;
}): RecordOutgoingPrivateChatA2ADisplayResult | null {
  const content = String(params.content ?? '');
  if (!content.trim()) return null;

  const ensured = ensureCoworkA2ASession({
    coworkStore: params.coworkStore,
    getMetabotById: params.getMetabotById,
    input: {
      localMetabotId: params.metabotId,
      peerGlobalMetaId: params.peerGlobalMetaId,
      peerName: params.peerName,
      peerAvatar: params.peerAvatar,
    },
  });

  const chainMetadata = buildPrivateChatA2AChainMetadata(params.chain ?? {});
  const chainPinId = normalizePrivateChatPinId(chainMetadata.pinId);
  const chainTxid = normalizeA2AChainTxid(chainMetadata.txid);
  if (chainPinId || chainTxid) {
    const identityRow = { pin_id: chainPinId, tx_id: chainTxid } as PrivateChatMessageRow;
    const alreadyTracked = params.coworkStore.getSessionMessagesMatchingMetadataValues(
      ensured.session.id,
      getPrivateChatChainIdentitySearchValues(identityRow),
    ).some((message) => (
      message.type === 'assistant'
      && message.metadata?.sourceChannel === 'metaweb_private'
      && metadataHasPrivateChatChainIdentity(message.metadata, identityRow)
    )) ?? false;
    if (alreadyTracked) {
      return {
        sessionId: ensured.session.id,
        externalConversationId: ensured.externalConversationId,
        message: null,
        duplicate: true,
      };
    }
  }

  const message = appendPrivateChatA2AMessage({
    coworkStore: params.coworkStore,
    sessionId: ensured.session.id,
    externalConversationId: ensured.externalConversationId,
    type: 'assistant',
    content,
    extraMetadata: {
      simplemsgKind: 'private_chat',
      ...chainMetadata,
      ...(params.extraMetadata ?? {}),
    },
    emitToRenderer: params.emitToRenderer,
  });
  params.coworkStore.touchConversationMapping(
    'metaweb_private',
    ensured.externalConversationId,
    params.metabotId,
  );

  return {
    sessionId: ensured.session.id,
    externalConversationId: ensured.externalConversationId,
    message,
    duplicate: false,
  };
}

export interface RecordOwnerSentPrivateChatA2AMessageResult {
  message: CoworkMessage;
  duplicate: boolean;
}

/**
 * Make an owner-sent private-chat message visible in the local MetaBot's A2A
 * session. The human signed the simplemsg with the user-identity wallet, so
 * from the session's perspective this is an INCOMING peer message: type
 * 'user', direction 'incoming', sender = owner. Dedupes by chain identity so
 * the daemon's later sync of the same pin reuses this message
 * (findPrivateChatA2AInboundMessage) instead of double-bubbling.
 */
export function recordOwnerSentPrivateChatA2AMessage(params: {
  coworkStore: CoworkStore;
  sessionId: string;
  externalConversationId: string;
  metabotId: number;
  ownerGlobalMetaId: string;
  ownerName?: string | null;
  ownerAvatar?: string | null;
  content: string;
  chain?: { txId?: unknown; txids?: unknown; pinId?: unknown };
  emitToRenderer?: RendererEmitter;
}): RecordOwnerSentPrivateChatA2AMessageResult | null {
  const content = String(params.content ?? '');
  if (!content.trim()) return null;

  const chainMetadata = buildPrivateChatA2AChainMetadata(params.chain ?? {});
  const identityRow = {
    pin_id: normalizePrivateChatPinId(chainMetadata.pinId),
    tx_id: normalizeA2AChainTxid(chainMetadata.txid),
  } as PrivateChatMessageRow;
  if (identityRow.pin_id || identityRow.tx_id) {
    const existing = findPrivateChatA2AInboundMessage({
      coworkStore: params.coworkStore,
      sessionId: params.sessionId,
      externalConversationId: params.externalConversationId,
      row: identityRow,
    });
    if (existing) {
      return { message: existing, duplicate: true };
    }
  }

  const message = appendPrivateChatA2AMessage({
    coworkStore: params.coworkStore,
    sessionId: params.sessionId,
    externalConversationId: params.externalConversationId,
    type: 'user',
    content,
    senderGlobalMetaId: params.ownerGlobalMetaId,
    senderName: params.ownerName ?? null,
    senderAvatar: params.ownerAvatar ?? null,
    extraMetadata: {
      simplemsgKind: 'private_chat',
      ownerSent: true,
      ...chainMetadata,
    },
    emitToRenderer: params.emitToRenderer,
  });
  params.coworkStore.touchConversationMapping(
    'metaweb_private',
    params.externalConversationId,
    params.metabotId,
  );

  return { message, duplicate: false };
}

function getPrivateChatSkillWaitNoticeKey(row: PrivateChatMessageRow): string {
  return String(row.pin_id || row.id || '').trim();
}

function hasSentPrivateChatSkillWaitNotice(
  coworkStore: Pick<CoworkStore, 'getSessionMessagesMatchingMetadataValues'>,
  sessionId: string,
  waitNoticeKey: string,
): boolean {
  if (!waitNoticeKey) return false;
  return coworkStore.getSessionMessagesMatchingMetadataValues(
    sessionId,
    [waitNoticeKey],
  ).some((message) => (
    message.type === 'assistant'
    && message.metadata?.privateChatSkillWaitNotice === true
    && message.metadata?.privateChatSkillWaitNoticeForPinId === waitNoticeKey
    && message.metadata?.privateChatDeliveryStatus === 'sent'
  ));
}

async function sendPrivateChatSkillWaitNotice(params: {
  coworkStore: CoworkStore;
  sessionId: string;
  externalConversationId: string;
  row: PrivateChatMessageRow;
  fromGlobalMetaId: string;
  sharedSecretForReply: string;
  noticeText: string;
  createSimpleMsgPin: (payload: string) => Promise<{ txids?: unknown; pinId?: unknown }>;
  emitLog: (msg: string) => void;
  emitToRenderer?: RendererEmitter;
}): Promise<boolean> {
  const waitNoticeKey = getPrivateChatSkillWaitNoticeKey(params.row);
  const encryptedNotice = ecdhEncrypt(params.noticeText, params.sharedSecretForReply);
  const payloadStr = buildPrivateMsgPayload(params.fromGlobalMetaId, encryptedNotice, params.row.reply_pin ?? '');
  try {
    const sentResult = await params.createSimpleMsgPin(payloadStr);
    const chainMetadata = buildPrivateChatA2AChainMetadata({
      txids: sentResult.txids,
      pinId: sentResult.pinId,
    });
    appendPrivateChatA2AMessage({
      coworkStore: params.coworkStore,
      sessionId: params.sessionId,
      externalConversationId: params.externalConversationId,
      type: 'assistant',
      content: params.noticeText,
      extraMetadata: {
        ...chainMetadata,
        privateChatSkillWaitNotice: true,
        privateChatSkillWaitNoticeForPinId: waitNoticeKey,
        privateChatDeliveryStatus: 'sent',
        suppressRunningStatus: true,
      },
      emitToRenderer: params.emitToRenderer,
    });
    params.emitLog(`[PrivateChat] Sent skill wait notice to ${params.fromGlobalMetaId.slice(0, 12)}…`);
    return true;
  } catch (e) {
    rethrowSqliteWasmBoundsError(e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    params.emitLog(`[PrivateChat] Failed to send skill wait notice: ${errorMessage}`);
    return false;
  }
}

export function endPrivateChatA2AConversation(params: {
  coworkStore: Pick<
    CoworkStore,
    | 'getSessionWithoutMessages'
    | 'getConversationSourceContextBySession'
    | 'getConversationMapping'
    | 'updateConversationMappingMetadata'
    | 'updateSession'
    | 'addMessage'
  >;
  sessionId: string;
  now?: () => number;
  emitToRenderer?: RendererEmitter;
}): {
  success: boolean;
  error?: string;
  externalConversationId?: string;
  peerGlobalMetaId?: string | null;
  alreadyEnded?: boolean;
  endMessage?: CoworkMessage;
} {
  const session = params.coworkStore.getSessionWithoutMessages(params.sessionId);
  if (!session) return { success: false, error: 'Session not found' };
  if (session.sessionType !== 'a2a') return { success: false, error: 'Only A2A sessions can be ended this way' };
  if (typeof session.metabotId !== 'number') return { success: false, error: 'A2A session has no local MetaBot id' };

  const sourceContext = params.coworkStore.getConversationSourceContextBySession(params.sessionId);
  if (sourceContext.sourceChannel !== 'metaweb_private' || !sourceContext.externalConversationId) {
    return { success: false, error: 'Only MetaWeb private chat A2A sessions can be ended this way' };
  }

  const mapping = params.coworkStore.getConversationMapping(
    'metaweb_private',
    sourceContext.externalConversationId,
    session.metabotId
  );
  if (!mapping) return { success: false, error: 'Private chat conversation mapping not found' };

  const currentMetadata = parseConversationMappingMetadata(mapping.metadataJson);
  if (currentMetadata.byeSent === true && currentMetadata.endedByHuman === true) {
    return {
      success: true,
      externalConversationId: sourceContext.externalConversationId,
      peerGlobalMetaId: session.peerGlobalMetaId ?? (currentMetadata.peerGlobalMetaId as string | undefined) ?? null,
      alreadyEnded: true,
    };
  }

  const endedAt = params.now ? params.now() : Date.now();
  params.coworkStore.updateConversationMappingMetadata(
    'metaweb_private',
    sourceContext.externalConversationId,
    session.metabotId,
    {
      ...currentMetadata,
      byeSent: true,
      endedByHuman: true,
      endedAt,
    }
  );

  const endMessage = appendPrivateChatA2AMessage({
    coworkStore: params.coworkStore,
    sessionId: params.sessionId,
    externalConversationId: sourceContext.externalConversationId,
    type: 'assistant',
    content: 'bye',
    extraMetadata: {
      a2aConversationEnded: true,
      suppressRunningStatus: true,
    },
    emitToRenderer: params.emitToRenderer,
  });

  const systemMessage = params.coworkStore.addMessage(params.sessionId, {
    type: 'system',
    content: '系统提示：人类已结束此 A2A 私聊，本机 MetaBot 将不再自动回复该对话。',
    metadata: {
      sourceChannel: 'metaweb_private',
      externalConversationId: sourceContext.externalConversationId,
      a2aConversationEndSystemNotice: true,
      suppressRunningStatus: true,
    },
  });
  if (params.emitToRenderer) {
    params.emitToRenderer('cowork:stream:message', {
      sessionId: params.sessionId,
      message: systemMessage,
    });
  }

  params.coworkStore.updateSession(params.sessionId, { status: 'completed' });
  if (params.emitToRenderer) {
    params.emitToRenderer('cowork:stream:complete', { sessionId: params.sessionId });
  }

  return {
    success: true,
    externalConversationId: sourceContext.externalConversationId,
    peerGlobalMetaId: session.peerGlobalMetaId ?? (currentMetadata.peerGlobalMetaId as string | undefined) ?? null,
    endMessage,
  };
}

interface RatingFlowParams {
  metabot: {
    id: number;
    name: string;
    llm_id?: string | null;
    llm_provider?: string | null;
    fallback_llm_id?: string | null;
    fallback_llm_provider?: string | null;
  };
  metabotStore: MetabotStore;
  coworkStore: CoworkStore;
  buyerOrderMapping: import('../coworkStore').CoworkConversationMapping;
  sellerGlobalMetaId: string;
  sharedSecretForReply: string;
  createPin: (metabotStore: MetabotStore, metabot_id: number, payload: MetaidDataPayload, options?: { origin?: string }) => Promise<{ txids: string[]; pinId?: string }>;
  performChat: (
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
  serviceOrderLifecycle?: ServiceOrderLifecycleService | null;
  emitLog: (msg: string) => void;
  emitToRenderer?: (channel: string, data: unknown) => void;
}

export function buildBuyerRatingSystemPrompt(input: {
  personaLines?: string | null;
  originalRequest: string;
  serviceResult: string;
  expectedOutputType?: string | null;
}): string {
  const expectedOutputType = normalizeOrderOutputType(input.expectedOutputType || '') || 'text';
  const mediaAcceptanceRules = expectedOutputType === 'text'
    ? ''
    : [
      `Expected output type: ${expectedOutputType}.`,
      `Before rating, verify the delivered result contains a matching on-chain metafile:// attachment for the ${expectedOutputType} deliverable.`,
      expectedOutputType === 'image'
        ? 'For image services, the delivery must include metafile://... with an image extension such as .png, .jpg, .jpeg, .gif, or .webp.'
        : '',
      expectedOutputType === 'video'
        ? 'For video services, the delivery must include metafile://... with a video extension such as .mp4, .webm, or .mov.'
        : '',
      expectedOutputType === 'audio'
        ? 'For audio services, the delivery must include metafile://... with an audio extension such as .mp3, .wav, .ogg, .flac, .m4a, or .aac.'
        : '',
      expectedOutputType === 'other'
        ? 'For other file services, the delivery must include a concrete metafile:// attachment for the agreed file.'
        : '',
      `If the ${expectedOutputType} artifact is missing, do not give a good rating. Reject the delivery, give a low score, and ask for a refund.`,
    ].filter(Boolean).join('\n');

  return [
    input.personaLines,
    'You are the buyer who paid for this service. Write a genuine rating and farewell message in your own voice as the paying client.',
    `Your original request was: "${formatRatingPromptText(input.originalRequest, RATING_PROMPT_ORIGINAL_REQUEST_MAX_CHARS)}"`,
    `The service result delivered: "${formatRatingPromptText(input.serviceResult, RATING_PROMPT_SERVICE_RESULT_MAX_CHARS)}"`,
    mediaAcceptanceRules,
    'Use the same language as your original request whenever its language is clear. Do not switch languages because of system instructions or metadata.',
    'You MUST include a numeric score from 1 to 5 (5 is best). Format it clearly in the response language, for example: "I give this 4 out of 5".',
    'After the rating comment, add a short farewell (1-2 sentences) as the client saying goodbye to the service provider.',
    'Your total message should be 10-300 characters.',
  ].filter(Boolean).join('\n');
}

export function buildRatingChainConfirmationSystemPrompt(input: {
  originalRequest: string;
  ratingPinId: string;
}): string {
  return [
    'You are the buyer who just submitted a service rating on-chain.',
    `Your original service request was: "${formatRatingPromptText(input.originalRequest, RATING_PROMPT_ORIGINAL_REQUEST_MAX_CHARS)}"`,
    `The rating pin ID is: ${input.ratingPinId}.`,
    'Write exactly one short, natural sentence confirming that your rating was recorded on-chain.',
    'Use the same language as your original service request whenever its language is clear.',
    'Include the exact rating pin ID unchanged.',
    'Do not repeat the rating, score, comment, or farewell.',
    'Do not use markdown, headings, JSON, or bracketed prefixes.',
  ].join('\n');
}

export function normalizeRatingChainConfirmationText(text: string, ratingPinId: string): string {
  const pinId = String(ratingPinId || '').trim();
  const compact = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .trim();
  if (compact && pinId && compact.includes(pinId)) {
    return compact.slice(0, 500);
  }
  return `My rating was recorded on-chain (pin ID: ${pinId}).`;
}

async function generateRatingChainConfirmation(params: {
  originalRequest: string;
  ratingPinId: string;
  llmId?: string;
  llmProvider?: string | null;
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
  performChat: RatingFlowParams['performChat'];
  emitLog: (msg: string) => void;
}): Promise<string> {
  try {
    const text = await params.performChat(
      buildRatingChainConfirmationSystemPrompt({
        originalRequest: params.originalRequest,
        ratingPinId: params.ratingPinId,
      }),
      'Write the on-chain rating confirmation now.',
      params.llmId,
      {
        llmProvider: params.llmProvider,
        fallbackLlmId: params.fallbackLlmId,
        fallbackLlmProvider: params.fallbackLlmProvider,
      },
    );
    return normalizeRatingChainConfirmationText(text, params.ratingPinId);
  } catch (error) {
    rethrowSqliteWasmBoundsError(error);
    params.emitLog(`[Rating] Confirmation generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return normalizeRatingChainConfirmationText('', params.ratingPinId);
  }
}

function formatRatingPromptText(value: string, maxChars: number): string {
  const text = stripLoneSurrogates(String(value || '').trim());
  if (text.length <= maxChars) {
    return text;
  }

  const excerptNotice = [
    '',
    '[System excerpt note: middle content omitted only to keep the prompt short.',
    'Do not treat this prompt-side omission as missing or incomplete delivery.]',
    '',
  ].join('\n');
  const tailLength = Math.min(RATING_PROMPT_EXCERPT_TAIL_CHARS, Math.floor(maxChars / 3));
  const headLength = Math.max(0, maxChars - excerptNotice.length - tailLength);
  return [
    truncateUtf16Units(text, headLength).trimEnd(),
    excerptNotice.trim(),
    truncateUtf16UnitsFromEnd(text, tailLength).trimStart(),
  ].filter(Boolean).join('\n\n');
}

function getMessageMetadataRecord(message: CoworkMessage): Record<string, unknown> {
  return message.metadata && typeof message.metadata === 'object'
    ? message.metadata as Record<string, unknown>
    : {};
}

function getMessageOrderTxid(message: CoworkMessage): string {
  const metadataTxid = normalizeOrderMessageTxid(getMessageMetadataRecord(message).orderTxid);
  if (metadataTxid) return metadataTxid;
  return resolveOrderProtocolTxid(String(message.content || ''));
}

function normalizeServiceOrderPinId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getMessageServiceOrderPinId(message: CoworkMessage): string {
  const metadata = getMessageMetadataRecord(message);
  const metadataOrderPinId = normalizeServiceOrderPinId(metadata.serviceOrderPinId)
    || normalizeServiceOrderPinId(metadata.orderPinId);
  if (metadataOrderPinId) return metadataOrderPinId;
  const content = String(message.content || '');
  const delivery = parseDeliveryMessage(content);
  return normalizeServiceOrderPinId(delivery?.serviceOrderPinId)
    || normalizeServiceOrderPinId(delivery?.orderPinId)
    || normalizeServiceOrderPinId(extractOrderPinId(content));
}

function messageMatchesOrderTxid(message: CoworkMessage, orderTxid: string): boolean {
  const normalizedOrderTxid = normalizeOrderMessageTxid(orderTxid);
  return Boolean(normalizedOrderTxid && getMessageOrderTxid(message) === normalizedOrderTxid);
}

function messageMatchesServiceOrderPinId(message: CoworkMessage, serviceOrderPinId: string): boolean {
  const normalizedOrderPinId = normalizeServiceOrderPinId(serviceOrderPinId);
  return Boolean(normalizedOrderPinId && getMessageServiceOrderPinId(message) === normalizedOrderPinId);
}

function messageMatchesOrderScope(message: CoworkMessage, input: {
  orderTxid?: string | null;
  serviceOrderPinId?: string | null;
}): boolean {
  const normalizedOrderPinId = normalizeServiceOrderPinId(input.serviceOrderPinId);
  if (normalizedOrderPinId) {
    return messageMatchesServiceOrderPinId(message, normalizedOrderPinId);
  }
  const normalizedOrderTxid = normalizeOrderMessageTxid(input.orderTxid);
  if (normalizedOrderTxid) {
    return messageMatchesOrderTxid(message, normalizedOrderTxid);
  }
  return false;
}

function findOrderRequestMessage(
  messages: CoworkMessage[],
  input: { orderTxid?: string | null; serviceOrderPinId?: string | null } = {}
): CoworkMessage | null {
  const normalizedOrderTxid = normalizeOrderMessageTxid(input.orderTxid);
  const normalizedOrderPinId = normalizeServiceOrderPinId(input.serviceOrderPinId);
  if (normalizedOrderTxid || normalizedOrderPinId) {
    return messages.find((message) => (
      typeof message.content === 'string'
      && isOrderMessage(message.content)
      && messageMatchesOrderScope(message, input)
    )) ?? null;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const metadata = getMessageMetadataRecord(message);
    if (
      message.type === 'user'
      && metadata.direction === 'outgoing'
      && typeof message.content === 'string'
      && isOrderMessage(message.content)
    ) {
      return message;
    }
  }
  return null;
}

function findDeliveryMessageForRating(
  messages: CoworkMessage[],
  input: { orderTxid?: string | null; serviceOrderPinId?: string | null } = {}
): CoworkMessage | null {
  const normalizedOrderTxid = normalizeOrderMessageTxid(input.orderTxid);
  const normalizedOrderPinId = normalizeServiceOrderPinId(input.serviceOrderPinId);
  if (normalizedOrderTxid || normalizedOrderPinId) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (typeof message.content !== 'string') continue;
      if (!parseDeliveryMessage(message.content)) continue;
      if (messageMatchesOrderScope(message, input)) {
        return message;
      }
    }
    return null;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const metadata = getMessageMetadataRecord(message);
    if (
      message.type === 'assistant'
      && metadata.direction === 'incoming'
      && typeof message.content === 'string'
      && parseDeliveryMessage(message.content)
    ) {
      return message;
    }
  }
  return null;
}

function extractRatingDeliveryResult(message: CoworkMessage | null): string {
  const content = String(message?.content || '').trim();
  if (!content) return '';
  const parsedDelivery = parseDeliveryMessage(content);
  if (parsedDelivery && typeof parsedDelivery.result === 'string') {
    return parsedDelivery.result;
  }
  return cleanServiceResultText(content) || content;
}

function findFallbackIncomingServiceResult(messages: CoworkMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const metadata = getMessageMetadataRecord(message);
    const content = String(message.content || '').trim();
    if (message.type !== 'assistant' || metadata.direction !== 'incoming' || !content) continue;
    if (parseNeedsRatingMessage(content) || parseOrderEndMessage(content) || parseOrderStatusMessage(content)) continue;
    const parsedDelivery = parseDeliveryMessage(content);
    if (parsedDelivery && typeof parsedDelivery.result === 'string') {
      return parsedDelivery.result;
    }
    return cleanServiceResultText(content) || content;
  }
  return '';
}

function getOrderMessageContentForScope(
  messages: CoworkMessage[],
  input: { orderTxid?: string | null; serviceOrderPinId?: string | null } = {}
): string {
  return String(findOrderRequestMessage(messages, input)?.content || '').trim();
}

export function resolveBuyerRatingContext(input: {
  messages: CoworkMessage[];
  orderTxid?: string | null;
  serviceOrderPinId?: string | null;
  fallbackOriginalRequest?: string | null;
  fallbackServiceResult?: string | null;
}): { originalRequest: string; serviceResult: string } {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const orderPayload = getOrderMessageContentForScope(messages, {
    orderTxid: input.orderTxid,
    serviceOrderPinId: input.serviceOrderPinId,
  });
  const originalRequest = (
    extractOrderRequestText(orderPayload)
    || orderPayload
    || String(input.fallbackOriginalRequest || '').trim()
  ).trim();
  const scopedDeliveryMessage = findDeliveryMessageForRating(messages, {
    orderTxid: input.orderTxid,
    serviceOrderPinId: input.serviceOrderPinId,
  });
  const hasScopedOrderTxid = Boolean(normalizeOrderMessageTxid(input.orderTxid));
  const hasScopedOrderPinId = Boolean(normalizeServiceOrderPinId(input.serviceOrderPinId));
  const serviceResult = (
    extractRatingDeliveryResult(scopedDeliveryMessage)
    || String(input.fallbackServiceResult || '').trim()
    || (hasScopedOrderTxid || hasScopedOrderPinId ? '' : findFallbackIncomingServiceResult(messages))
  ).trim();
  return {
    originalRequest,
    serviceResult,
  };
}

export function shouldSkipAutoRatingForMissingScopedContext(input: {
  orderTxid?: string | null;
  serviceOrderPinId?: string | null;
  originalRequest?: string | null;
  serviceResult?: string | null;
}): boolean {
  const hasScopedOrderTxid = Boolean(normalizeOrderMessageTxid(input.orderTxid));
  const hasScopedOrderPinId = Boolean(normalizeServiceOrderPinId(input.serviceOrderPinId));
  if (!hasScopedOrderTxid && !hasScopedOrderPinId) return false;
  return !String(input.originalRequest || '').trim() || !String(input.serviceResult || '').trim();
}

export function isOrderDeliveryFailureNotice(plaintext: string): boolean {
  const text = String(plaintext || '');
  if (!text.trim()) return false;
  const hasRefundFlowNotice = /退款流程|refund process|start a refund/i.test(text);
  const hasDeliveryFailure =
    /服务方未能按约定交付/.test(text) ||
    /上传链上交付失败/.test(text) ||
    /缺少链上上传能力/.test(text) ||
    /could not deliver the agreed/i.test(text) ||
    /on-chain upload failed/i.test(text) ||
    /lacks on-chain upload capability/i.test(text);
  return hasRefundFlowNotice && hasDeliveryFailure;
}

async function handleRatingFlow(params: RatingFlowParams): Promise<void> {
  const { metabot, metabotStore, coworkStore, buyerOrderMapping, sellerGlobalMetaId,
    sharedSecretForReply, createPin, performChat, serviceOrderLifecycle, emitLog, emitToRenderer } = params;

  // Parse order metadata stored when buyer sent the order
  const orderMeta = parseConversationMappingMetadata(buyerOrderMapping.metadataJson);
  const serviceId = typeof orderMeta.serviceId === 'string' ? orderMeta.serviceId : '';
  const servicePrice = typeof orderMeta.servicePrice === 'string' ? orderMeta.servicePrice : '';
  const serviceCurrency = typeof orderMeta.serviceCurrency === 'string' ? orderMeta.serviceCurrency : '';
  const serviceSkill = typeof orderMeta.serviceSkill === 'string' ? orderMeta.serviceSkill : '';
  const serverBotGlobalMetaId = typeof orderMeta.serverBotGlobalMetaId === 'string' ? orderMeta.serverBotGlobalMetaId : sellerGlobalMetaId;
  const servicePaidTx = typeof orderMeta.servicePaidTx === 'string' ? orderMeta.servicePaidTx : '';
  const serviceOrderPinId = normalizeServiceOrderPinId(orderMeta.serviceOrderPinId)
    || normalizeServiceOrderPinId(orderMeta.orderPinId);
  const orderTxid = typeof orderMeta.orderTxid === 'string' ? orderMeta.orderTxid : '';
  const serviceOutputType = typeof orderMeta.serviceOutputType === 'string'
    ? orderMeta.serviceOutputType
    : '';

  // Retrieve session messages to find original request and service result
  const session = coworkStore.getSession(buyerOrderMapping.coworkSessionId);
  const messages = session?.messages ?? [];
  const ratingContext = resolveBuyerRatingContext({
    messages,
    orderTxid,
    serviceOrderPinId,
  });
  const originalRequest = ratingContext.originalRequest;
  const serviceResult = ratingContext.serviceResult;
  if (shouldSkipAutoRatingForMissingScopedContext({
    orderTxid,
    serviceOrderPinId,
    originalRequest,
    serviceResult,
  })) {
    const scopeLabel = orderTxid
      ? `order ${orderTxid.slice(0, 12)}…`
      : `order pin ${serviceOrderPinId.slice(0, 24)}…`;
    emitLog(`[Rating] Missing scoped order context for ${scopeLabel}, skipping auto-rating to avoid cross-order history leakage.`);
    return;
  }

  // Build A's persona (shared builder — one identity across channels)
  const buyerMetabot = metabotStore.getMetabotById(metabot.id);
  const personaLines = buyerMetabot ? buildMetabotPersonaPrompt(buyerMetabot) : '';

  const ratingSystemPrompt = buildBuyerRatingSystemPrompt({
    personaLines,
    originalRequest,
    serviceResult,
    expectedOutputType: serviceOutputType || extractOrderOutputType(originalRequest),
  });

  const llmId = normalizeMetabotLlmId(metabot.llm_id) ?? undefined;
  const llmProvider = normalizeMetabotLlmId(metabot.llm_provider);
  const fallbackLlmId = normalizeMetabotLlmId(metabot.fallback_llm_id);
  const fallbackLlmProvider = normalizeMetabotLlmId(metabot.fallback_llm_provider);

  const ratingText = await performChat(ratingSystemPrompt, 'Write your rating, numeric score, and farewell now.', llmId, { llmProvider, fallbackLlmId, fallbackLlmProvider, thinking: 'disabled' });

  // Extract rate (1-5) from the generated text
  const rateMatch = ratingText.match(/[1-5]\s*分|评分[：:]\s*([1-5])|([1-5])\s*(?:out of|\/)\s*5|([1-5])\s*星/i)
    ?? ratingText.match(/([1-5])/);
  const rateStr = rateMatch
    ? (rateMatch[1] ?? rateMatch[2] ?? rateMatch[3] ?? rateMatch[0]).replace(/[^1-5]/g, '').slice(0, 1)
    : '3';
  const comment = ratingText.trim().slice(0, 500);

  emitLog(`[Rating] Generated rating: ${rateStr} — ${comment.slice(0, 60)}…`);

  // Publish skill-service-rate on-chain
  let ratingPinId = '';
  try {
    const ratingPayload = JSON.stringify({
      serviceID: serviceId,
      servicePrice,
      serviceCurrency,
      servicePaidTx,
      serviceOrderPinId,
      serviceSkill,
      serverBot: serverBotGlobalMetaId,
      rate: rateStr,
      comment,
    });
    const ratingResult = await createPin(metabotStore, metabot.id, {
      operation: 'create',
      path: '/protocols/skill-service-rate',
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: ratingPayload,
    }, { origin: 'internal:service-order' });
    ratingPinId = (ratingResult as { pinId?: string }).pinId ?? ratingResult.txids?.[0] ?? '';
    emitLog(`[Rating] skill-service-rate published: pinId=${ratingPinId}`);
  } catch (e) {
    rethrowSqliteWasmBoundsError(e);
    emitLog(`[Rating] Failed to publish skill-service-rate: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Build combined message: rating text + language-matched on-chain pin reference.
  const ratingConfirmation = ratingPinId
    ? await generateRatingChainConfirmation({
      originalRequest,
      ratingPinId,
      llmId,
      llmProvider,
      fallbackLlmId,
      fallbackLlmProvider,
      performChat,
      emitLog,
    })
    : '';
  const pinLine = ratingConfirmation ? `\n\n${ratingConfirmation}` : '';
  const combinedMessageBody = `${ratingText.trim()}${pinLine}`;
  const combinedMessage = orderTxid || serviceOrderPinId
    ? buildOrderEndMessage(orderTxid, 'rated', combinedMessageBody, serviceOrderPinId)
    : combinedMessageBody;

  // Send combined message to B via simplemsg
  let combinedMessageMetadata: A2AChainMetadata = {};
  try {
    const encrypted = ecdhEncrypt(combinedMessage, sharedSecretForReply);
    const payloadStr = buildPrivateMsgPayload(sellerGlobalMetaId, encrypted, '');
    const combinedMessageResult = await createPin(metabotStore, metabot.id, {
      operation: 'create',
      path: '/protocols/simplemsg',
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: payloadStr,
    }, { origin: 'internal:private-chat' });
    combinedMessageMetadata = buildA2AChainMetadata({
      txids: combinedMessageResult.txids,
      pinId: combinedMessageResult.pinId,
    });
    emitLog(`[Rating] Combined rating+farewell sent to ${sellerGlobalMetaId.slice(0, 12)}…`);
    if (serviceOrderLifecycle && (serviceOrderPinId || servicePaidTx)) {
      serviceOrderLifecycle.markOrderEnded('buyer', {
        localMetabotId: metabot.id,
        counterpartyGlobalMetaId: sellerGlobalMetaId,
        orderPinId: serviceOrderPinId,
        paymentTxid: servicePaidTx,
        reason: 'rated',
        orderEndMessagePinId: combinedMessageResult.pinId ?? null,
        endedAt: Date.now(),
      });
    }
  } catch (e) {
    rethrowSqliteWasmBoundsError(e);
    emitLog(`[Rating] Combined message send failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Add combined message to A's buyer session (outgoing) — single entry visible to A
  const combinedMsg = coworkStore.addMessage(buyerOrderMapping.coworkSessionId, {
    type: 'user',
    content: combinedMessage,
    metadata: buildOrderA2ADisplayMetadata({
      peerGlobalMetaId: sellerGlobalMetaId,
      direction: 'outgoing',
      content: combinedMessage,
      fallbackTag: 'ORDER_END',
      orderTxid,
      orderRole: 'buyer',
      orderPinId: serviceOrderPinId,
      paymentTxid: servicePaidTx,
      orderMappingExternalConversationId: buyerOrderMapping.externalConversationId,
      extra: {
        suppressRunningStatus: true,
        ...combinedMessageMetadata,
      },
    }),
  });
  if (emitToRenderer) {
    emitToRenderer('cowork:stream:message', { sessionId: buyerOrderMapping.coworkSessionId, message: combinedMsg });
  }
}

/**
 * Resolve the plaintext for an outgoing private chat message stored by the listener.
 * The listener may have kept the ciphertext when it couldn't decrypt (the peer's
 * chatPublicKey is often missing from toUserInfo for outgoing messages).
 * We try to decrypt here using the peer's chatPubkey from a previous incoming message.
 */
async function resolveOutgoingPrivateChatPlaintext(params: {
  db: Database;
  row: PrivateChatMessageRow;
  metabot: { id: number };
  metabotStore: MetabotStore;
  toGlobalMetaId: string;
  emitLog: (msg: string) => void;
}): Promise<string | null> {
  const content = String(params.row.content ?? '').trim();
  if (!content) return null;

  // Already plaintext — listener decrypted successfully.
  if (!content.startsWith('U2FsdGVkX1')) return content;

  // Ciphertext — try to decrypt using the peer's chatPubkey (local history → chain API fallback).
  const peerChatPubkey = await resolvePeerChatPubkey(
    params.db,
    params.toGlobalMetaId,
    params.emitLog
  );
  if (!peerChatPubkey) {
    params.emitLog(
      `[PrivateChat] Outgoing message ${params.row.id}: cannot decrypt — no peer chatPubkey for ${params.toGlobalMetaId.slice(0, 12)}…`
    );
    return null;
  }

  try {
    const wallet = params.metabotStore.getMetabotWalletByMetabotId(params.metabot.id);
    if (!wallet?.mnemonic?.trim()) return null;
    const privateKeyBuffer = await getPrivateKeyBufferForEcdh(
      wallet.mnemonic,
      wallet.path ?? "m/44'/10001'/0'/0/0"
    );
    const sharedSecret = computeEcdhSharedSecretSha256(privateKeyBuffer, peerChatPubkey);
    const plain = ecdhDecrypt(content, sharedSecret);
    if (plain && plain !== content) return plain;
  } catch (e) {
    rethrowSqliteWasmBoundsError(e);
    params.emitLog(
      `[PrivateChat] Outgoing message ${params.row.id}: decrypt failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return null;
}

/**
 * Resolve the peer's chatPubkey for ECDH decryption.
 * 1) Look up from a previous incoming private_chat_messages row (fast, local).
 * 2) Fall back to the MetaID chain API.
 */
async function resolvePeerChatPubkey(
  db: Database,
  peerGlobalMetaId: string,
  emitLog: (msg: string) => void
): Promise<string> {
  // 1) Local: from a previous incoming message where the peer is the sender.
  const localResult = db.exec(
    `SELECT from_chat_pubkey
     FROM private_chat_messages
     WHERE from_global_metaid = ?
       AND from_chat_pubkey IS NOT NULL
       AND from_chat_pubkey != ''
     ORDER BY id DESC
     LIMIT 1`,
    [peerGlobalMetaId]
  );
  const localRow = localResult[0]?.values?.[0];
  if (typeof localRow?.[0] === 'string' && localRow[0].trim()) {
    return localRow[0].trim();
  }

  // 2) Fallback: fetch from MetaID chain.
  try {
    const url = `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/${encodeURIComponent(peerGlobalMetaId)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      emitLog(`[PrivateChat] Peer chatPubkey API returned HTTP ${res.status} for ${peerGlobalMetaId.slice(0, 12)}…`);
      return '';
    }
    const json = await res.json() as Record<string, unknown>;
    // Unwrap { data: {...} } envelope if present.
    const data = (json.data && typeof json.data === 'object' ? json.data : json) as Record<string, unknown>;
    // Try common key names.
    const candidates = [data.chatpubkey, data.chatPubkey, data.chatPublicKey, data.pubkey];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    emitLog(`[PrivateChat] Peer chatPubkey not found in API response for ${peerGlobalMetaId.slice(0, 12)}…`);
  } catch (e) {
    rethrowSqliteWasmBoundsError(e);
    emitLog(
      `[PrivateChat] Peer chatPubkey API fetch failed for ${peerGlobalMetaId.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return '';
}

// ---------------------------------------------------------------------------
// OpenTeam protocol interception (invite/accept/decline envelopes)
// ---------------------------------------------------------------------------

/**
 * Human-readable invite text for the guest's A2A private-chat stream
 * (改进清单 #15): the invitation must be visible in the invitee's online
 * conversations with the group-task name/identifier, the inviting bot, the
 * time and the explicit "invite to join a group task" intent — not only in
 * the collab history card. The message's own timestamp carries the arrival
 * time; the text carries the group identity, inviter, goal and expiry.
 */
export function buildOpenTeamInviteDisplayText(
  invite: OpenTeamInvitePayload,
  botName: string,
): string {
  const task = invite.taskTitle?.trim() || `group task ${invite.groupId}`;
  const inviter = invite.inviterName?.trim() || invite.inviterGlobalMetaId || 'unknown';
  const lines = [
    `[OpenTeam Invite] ${inviter} invites ${botName} to join the group task "${task}".`,
    `Group: ${invite.groupId}`,
    `Inviter: ${inviter} (${invite.inviterGlobalMetaId})`,
    `Goal: ${invite.goalSummary?.trim() || '(not provided)'}`,
  ];
  if (invite.requiredSkills.length > 0) {
    lines.push(`Required skills: ${invite.requiredSkills.join(', ')}`);
  }
  lines.push(`Invite ID: ${invite.inviteId}`);
  const expires = Number.isFinite(invite.expiresAt)
    ? new Date(invite.expiresAt * 1000).toLocaleString()
    : 'unknown';
  lines.push(`Expires: ${expires}`);
  return lines.join('\n');
}

/**
 * Make an incoming [OPENTEAM_KICK] visible in the guest's A2A private-chat
 * stream — the symmetric counterpart of recordOpenTeamInviteA2ADisplay (R4).
 * Without it the guest host exits the group silently and the Boss never sees
 * that their bot was removed. Deduped by the envelope pinId so the socket push
 * and the history backfill of the same envelope produce a single bubble.
 */
export function buildOpenTeamKickDisplayText(
  kick: OpenTeamKickPayload,
  botName: string,
): string {
  const task = kick.taskTitle?.trim() || `group task ${kick.groupId}`;
  const lines = [
    `[OpenTeam Kick] ${botName} was removed from the group task "${task}" by the owner.`,
    `Group: ${kick.groupId}`,
    `Reason: ${kick.reason?.trim() || '(none given)'}`,
    'The bot has left the group and will no longer process its messages.',
  ];
  return lines.join('\n');
}

export function recordOpenTeamKickA2ADisplay(params: {
  coworkStore: CoworkStore;
  /** Local bot that was kicked (its session owns the message). */
  metabot: Pick<Metabot, 'id' | 'name' | 'globalmetaid'>;
  kick: OpenTeamKickPayload;
  /** Actual sender of the kick simplemsg row (the inviting/chair bot). */
  senderGlobalMetaId: string;
  senderName?: string | null;
  senderAvatar?: string | null;
  /** PinId of the kick envelope message; the dedup identity. */
  envelopePinId?: string;
  emitToRenderer?: RendererEmitter;
}): { sessionId: string; message: CoworkMessage | null; duplicate: boolean } | null {
  const peerGlobalMetaId = String(params.senderGlobalMetaId ?? '').trim();
  if (!peerGlobalMetaId) return null;
  const botName = params.metabot.name?.trim() || `bot-${params.metabot.id}`;

  const ensured = ensureCoworkA2ASession({
    coworkStore: params.coworkStore,
    getMetabotById: () => ({
      id: params.metabot.id,
      name: params.metabot.name,
      globalmetaid: params.metabot.globalmetaid,
    }),
    input: {
      localMetabotId: params.metabot.id,
      peerGlobalMetaId,
      peerName: params.senderName,
      peerAvatar: params.senderAvatar,
    },
  });

  const chainPinId = normalizePrivateChatPinId(params.envelopePinId);
  if (chainPinId) {
    const dedupRow = { pin_id: chainPinId } as PrivateChatMessageRow;
    const alreadyTracked = params.coworkStore.getSessionMessagesMatchingMetadataValues(
      ensured.session.id,
      [chainPinId],
    ).some((message) => (
      message.type === 'user'
      && message.metadata?.sourceChannel === 'metaweb_private'
      && message.metadata?.openTeamKick === true
      && metadataHasPrivateChatChainIdentity(message.metadata, dedupRow)
    ));
    if (alreadyTracked) {
      return { sessionId: ensured.session.id, message: null, duplicate: true };
    }
  }

  const message = appendPrivateChatA2AMessage({
    coworkStore: params.coworkStore,
    sessionId: ensured.session.id,
    externalConversationId: ensured.externalConversationId,
    type: 'user',
    content: buildOpenTeamKickDisplayText(params.kick, botName),
    senderGlobalMetaId: peerGlobalMetaId,
    senderName: params.senderName,
    senderAvatar: params.senderAvatar,
    extraMetadata: {
      simplemsgKind: 'private_chat',
      openTeamKick: true,
      ...buildPrivateChatA2AChainMetadata({ pinId: chainPinId }),
    },
    emitToRenderer: params.emitToRenderer,
  });
  params.coworkStore.touchConversationMapping(
    'metaweb_private',
    ensured.externalConversationId,
    params.metabot.id,
  );
  return { sessionId: ensured.session.id, message, duplicate: false };
}

/**
 * Make an incoming [OPENTEAM_INVITE] visible in the guest's A2A private-chat
 * stream (改进清单 #15): ensure the canonical metaweb_private session with the
 * INVITER exists and append the invitation as a user message. Runs at
 * interception time — before the accept/decline outcome is known — so the
 * invite is visible on the invitee's machine even when the bot later declines
 * it or it is skipped as a duplicate: the invitation itself is the trace a
 * Boss must be able to see ("my bot was invited out to collaborate").
 * Deduplicated by the envelope pinId so the socket push and the history
 * backfill of the same envelope produce a single bubble.
 */
export function recordOpenTeamInviteA2ADisplay(params: {
  coworkStore: CoworkStore;
  /** Local bot that received the invite (its session owns the message). */
  metabot: Pick<Metabot, 'id' | 'name' | 'globalmetaid'>;
  invite: OpenTeamInvitePayload;
  /** Actual sender of the invite simplemsg row (the inviting bot). */
  senderGlobalMetaId: string;
  senderName?: string | null;
  senderAvatar?: string | null;
  /** PinId of the invite envelope message; the dedup identity. */
  envelopePinId?: string;
  emitToRenderer?: RendererEmitter;
}): { sessionId: string; message: CoworkMessage | null; duplicate: boolean } | null {
  const peerGlobalMetaId = String(params.senderGlobalMetaId ?? '').trim();
  if (!peerGlobalMetaId) return null;
  const botName = params.metabot.name?.trim() || `bot-${params.metabot.id}`;

  const ensured = ensureCoworkA2ASession({
    coworkStore: params.coworkStore,
    getMetabotById: () => ({
      id: params.metabot.id,
      name: params.metabot.name,
      globalmetaid: params.metabot.globalmetaid,
    }),
    input: {
      localMetabotId: params.metabot.id,
      peerGlobalMetaId,
      peerName: params.senderName,
      peerAvatar: params.senderAvatar,
    },
  });

  const chainPinId = normalizePrivateChatPinId(params.envelopePinId)
    || normalizePrivateChatPinId(params.invite.inviteId);
  if (chainPinId) {
    const dedupRow = { pin_id: chainPinId } as PrivateChatMessageRow;
    const alreadyTracked = params.coworkStore.getSessionMessagesMatchingMetadataValues(
      ensured.session.id,
      [chainPinId],
    ).some((message) => (
      message.type === 'user'
      && message.metadata?.sourceChannel === 'metaweb_private'
      && message.metadata?.openTeamInvite === true
      && metadataHasPrivateChatChainIdentity(message.metadata, dedupRow)
    ));
    if (alreadyTracked) {
      return { sessionId: ensured.session.id, message: null, duplicate: true };
    }
  }

  const message = appendPrivateChatA2AMessage({
    coworkStore: params.coworkStore,
    sessionId: ensured.session.id,
    externalConversationId: ensured.externalConversationId,
    type: 'user',
    content: buildOpenTeamInviteDisplayText(params.invite, botName),
    senderGlobalMetaId: peerGlobalMetaId,
    senderName: params.senderName,
    senderAvatar: params.senderAvatar,
    extraMetadata: {
      simplemsgKind: 'private_chat',
      openTeamInvite: true,
      ...buildPrivateChatA2AChainMetadata({ pinId: chainPinId }),
    },
    emitToRenderer: params.emitToRenderer,
  });
  params.coworkStore.touchConversationMapping(
    'metaweb_private',
    ensured.externalConversationId,
    params.metabot.id,
  );
  return { sessionId: ensured.session.id, message, duplicate: false };
}

/** Injectable seams for interceptOpenTeamEnvelope (tests stub the handlers/schedule). */
export interface PrivateChatOpenTeamInterceptionDeps {
  handleInvite: typeof handleIncomingOpenTeamInvite;
  handleResponse: typeof handleIncomingOpenTeamResponse;
  handleKick: typeof handleIncomingOpenTeamKick;
  /** Async handoff used to keep the handling off the processOne call stack. */
  schedule: (task: () => void) => void;
  /** 改进清单 #15: surface an incoming invite in the invitee's A2A stream. */
  recordInviteDisplay?: typeof recordOpenTeamInviteA2ADisplay;
  /** R4: surface an incoming kick in the kicked bot's A2A stream. */
  recordKickDisplay?: typeof recordOpenTeamKickA2ADisplay;
}

const defaultOpenTeamInterceptionDeps: PrivateChatOpenTeamInterceptionDeps = {
  handleInvite: (input) => handleIncomingOpenTeamInvite(input),
  handleResponse: (envelope, options) => handleIncomingOpenTeamResponse(envelope, options),
  handleKick: (input) => handleIncomingOpenTeamKick(input),
  schedule: (task) => setImmediate(task),
  recordInviteDisplay: (input) => recordOpenTeamInviteA2ADisplay(input),
  recordKickDisplay: (input) => recordOpenTeamKickA2ADisplay(input),
};

/**
 * OpenTeam protocol interception for processOne. Runs right after the row's
 * plaintext is resolved and BEFORE the enabled/wallet/chat-pubkey gates, so a
 * disabled bot still answers an invite with DECLINE instead of leaving the
 * inviter to wait out the whole invite TTL.
 *
 * Returns true when the plaintext carried an OpenTeam envelope — the caller
 * must then markProcessed and return immediately (the envelope never reaches
 * the LLM reply path). The actual handling (on-chain join + ACCEPT/DECLINE
 * pins, invite state transitions) is dispatched fire-and-forget via the
 * detached-work tracker: it never stalls the private-chat pipeline, and since
 * the row is marked processed first, an async failure can never cause the
 * same message to be handled twice. Without from_chat_pubkey no reply is
 * possible, so reply-bound envelopes (invite/accept/decline) are only consumed
 * (true) without dispatching; the one-way KICK notification needs no reply and
 * is still dispatched.
 */
export function interceptOpenTeamEnvelope(params: {
  plaintext: string;
  metabot: Metabot;
  /** Actual sender of the simplemsg row (from_global_metaid/from_metaid). */
  fromGlobalMetaId: string;
  fromChatPubkey: string;
  messageId: number;
  emitLog: (msg: string) => void;
  onWasmBoundsError?: () => void;
  deps?: PrivateChatOpenTeamInterceptionDeps;
  /** 改进清单 #15: cowork store to surface the invite in the A2A stream. */
  coworkStore?: CoworkStore;
  /** Sender display fields from the simplemsg row (A2A peer identity). */
  senderName?: string | null;
  senderAvatar?: string | null;
  /** PinId of the invite envelope message; dedup identity for the A2A bubble. */
  rowPinId?: string;
  emitToRenderer?: RendererEmitter;
}): boolean {
  const envelope = parseOpenTeamEnvelope(params.plaintext);
  if (!envelope) return false;
  const emitLog = params.emitLog;
  if (!params.fromChatPubkey && envelope.kind !== 'kick') {
    emitLog(
      `[OpenTeam] Message ${params.messageId}: envelope has no from_chat_pubkey; ` +
      'cannot reply, skipping without dispatch.',
    );
    return true;
  }
  const handlers = params.deps ?? defaultOpenTeamInterceptionDeps;
  const work = new Promise<void>((resolve) => {
    handlers.schedule(() => resolve());
  }).then(async () => {
    if (envelope.kind === 'invite') {
      // 改进清单 #15: surface the invite in the invitee's A2A private-chat
      // stream BEFORE the accept/decline outcome is known — the invitation
      // must be visible on this machine's online conversations even when the
      // bot later declines it. Best effort: a display failure is logged and
      // must never block the invite handling (join + ACCEPT).
      if (params.coworkStore && params.fromGlobalMetaId && handlers.recordInviteDisplay) {
        try {
          handlers.recordInviteDisplay({
            coworkStore: params.coworkStore,
            metabot: params.metabot,
            invite: envelope.invite,
            senderGlobalMetaId: params.fromGlobalMetaId,
            senderName: params.senderName,
            senderAvatar: params.senderAvatar,
            envelopePinId: params.rowPinId,
            emitToRenderer: params.emitToRenderer,
          });
        } catch (error) {
          emitLog(
            `[OpenTeam] Invite A2A display failed for message ${params.messageId}: ` +
            `${error instanceof Error ? error.message : error}`,
          );
        }
      }
      await handlers.handleInvite({
        metabot: params.metabot,
        invite: envelope.invite,
        senderGlobalMetaId: params.fromGlobalMetaId,
        replyContext: {
          peerGlobalMetaId: params.fromGlobalMetaId,
          peerChatPubkey: params.fromChatPubkey,
          invitePinId: envelope.invite.inviteId,
        },
      });
    } else if (envelope.kind === 'kick') {
      // R4: surface the kick in the kicked bot's A2A stream BEFORE the
      // membership flip — the Boss must see "my bot was removed", not just a
      // silently grayed collab card. Best effort, mirroring the invite path.
      if (params.coworkStore && params.fromGlobalMetaId && handlers.recordKickDisplay) {
        try {
          handlers.recordKickDisplay({
            coworkStore: params.coworkStore,
            metabot: params.metabot,
            kick: envelope.kick,
            senderGlobalMetaId: params.fromGlobalMetaId,
            senderName: params.senderName,
            senderAvatar: params.senderAvatar,
            envelopePinId: params.rowPinId,
            emitToRenderer: params.emitToRenderer,
          });
        } catch (error) {
          emitLog(
            `[OpenTeam] Kick A2A display failed for message ${params.messageId}: ` +
            `${error instanceof Error ? error.message : error}`,
          );
        }
      }
      handlers.handleKick({
        metabot: params.metabot,
        kick: envelope.kick,
        senderGlobalMetaId: params.fromGlobalMetaId,
      });
    } else {
      handlers.handleResponse(envelope, { senderGlobalMetaId: params.fromGlobalMetaId });
    }
  }).catch((error) => {
    if (isSqliteWasmBoundsError(error)) {
      void stopPrivateChatDaemon();
      params.onWasmBoundsError?.();
      return;
    }
    emitLog(
      `[OpenTeam] Envelope handling failed for message ${params.messageId}: ` +
      `${error instanceof Error ? error.message : error}`,
    );
  });
  trackPrivateChatDetachedWork(work);
  return true;
}

async function processOne(
  row: PrivateChatMessageRow,
  db: Database,
  saveDb: SaveDbFn,
  coworkStore: CoworkStore,
  metabotStore: MetabotStore,
  createPin: (metabotStore: MetabotStore, metabot_id: number, payload: MetaidDataPayload, options?: { origin?: string }) => Promise<{ txids: string[]; pinId?: string }>,
  performChat: PrivateChatPerformChatFn,
  emitLog: (msg: string) => void,
  orderCoworkHandler: PrivateChatOrderCowork | null,
  serviceOrderLifecycle: ServiceOrderLifecycleService | null,
  getSkillsPrompt?: GetSellerOrderSkillsPromptFn,
  emitToRenderer?: (channel: string, data: unknown) => void,
  getListenerConfig?: GetListenerConfigFn,
  resolveLocalServiceOutputType?: ResolveLocalServiceOutputTypeFn,
  resolveLocalServiceExecutionReminder?: ResolveLocalServiceExecutionReminderFn,
  onWasmBoundsError?: () => void,
  getChatSkillsRoutingPrompt?: GetChatSkillsRoutingPromptFn,
  runPrivateChatSkillTurn?: RunPrivateChatSkillTurnFn,
  generatePrivateChatSkillWaitNotice?: GeneratePrivateChatSkillWaitNoticeFn,
  consumeA2AGuidance?: ConsumeA2AGuidanceFn,
  getRecentDailySummaries?: (metabotId: number, limit: number) => Array<{ summaryDate: string; summaryText: string }>,
  refreshA2APeerProfile?: (sessionId: string) => void,
  experienceStore?: MetaIDExperienceStore,
  getMetaIDCognitionPromptBlock?: GetMetaIDCognitionPromptBlockFn,
  isSessionTurnActive?: (sessionId: string) => boolean,
  /** Written by the wake dispatch point at throw time (H-64 leg B). */
  wakeDisposition?: PrivateChatWakeReDriveDisposition,
): Promise<void> {
  const taskKey = row.pin_id;
  if (thinkingTasks.has(taskKey)) return;
  const pendingRetry = privateChatSkillTurnRetries.get(taskKey);
  if (pendingRetry && Date.now() < pendingRetry.nextRetryAt) {
    return;
  }
  // A wake turn re-drives a previously processed row whose conversation went
  // silent without a bye; it re-decides under a host wake notice instead of a
  // new peer message. The disposition arrives as a parameter straight from
  // the wake dispatch point; the in-memory wake map stays as the carrier for
  // rows re-picked on a later tick (e.g. deferred behind a busy runner turn),
  // whose fire happened in an earlier tick.
  const wakeEntry = privateChatA2AWakes.get(taskKey);
  const isWakeTurn = wakeDisposition?.reServed === true || wakeEntry?.running === true;
  thinkingTasks.add(taskKey);
  try {
    const toGlobalMetaId = (row.to_global_metaid ?? row.to_metaid ?? '').trim();
    if (!toGlobalMetaId) {
      emitLog(`[PrivateChat] Skip message ${row.id}: no to_global_metaid`);
      markProcessed(db, row.id, saveDb);
      return;
    }
    const recipientMetabot = metabotStore.getMetabotByGlobalMetaId(toGlobalMetaId);

    // Outgoing path: this message was sent FROM a local metabot TO a peer.
    // The listener stores it but may keep the ciphertext when decryption fails
    // (toUserInfo.chatPublicKey is often missing for the outgoing direction).
    // Decrypt and sync into the sender's A2A session so the outgoing message is visible locally.
    // For local-to-local simplemsg rows, continue afterward so the recipient MetaBot can
    // process the same row as an incoming message.
    const outgoingFromMetaId = (row.from_global_metaid || row.from_metaid || '').trim();
    const senderMetabot = outgoingFromMetaId
      ? metabotStore.getMetabotByGlobalMetaId(outgoingFromMetaId)
      : null;
    if (senderMetabot) {
      // Resolve the plaintext even when no A2A session mapping exists yet:
      // conversations started from the Bot Browser send path have no mapping
      // until the first inbound message, and the outgoing echo must still
      // become visible locally.
      const plaintext = await resolveOutgoingPrivateChatPlaintext({
        db,
        row,
        metabot: senderMetabot,
        metabotStore,
        toGlobalMetaId,
        emitLog,
      });
      if (plaintext) {
        if (isPrivateChatHandshakePlaintext(plaintext)) {
          emitLog(
            `[PrivateChat] Outgoing sync: skipping transport handshake ${normalizeHandshakeWord(plaintext)}.`
          );
        } else if (parseOpenTeamEnvelope(plaintext)) {
          // OpenTeam envelopes are transport-level protocol messages, not chat
          // content — keep them out of the local A2A session display on the
          // outgoing path too (the inbound side is intercepted in processOne).
          emitLog('[PrivateChat] Outgoing sync: skipping OpenTeam protocol envelope.');
        } else {
          try {
            const recorded = recordOutgoingPrivateChatA2ADisplay({
              coworkStore,
              getMetabotById: (metabotId) => metabotStore.getMetabotById(metabotId),
              metabotId: senderMetabot.id,
              peerGlobalMetaId: toGlobalMetaId,
              content: plaintext,
              chain: { txId: row.tx_id, pinId: row.pin_id },
              emitToRenderer,
            });
            if (recorded) {
              try {
                recordMetaIDPrivateA2AExperience({
                  store: experienceStore ?? new MetaIDExperienceStore(db, saveDb),
                  ownerGlobalMetaID: senderMetabot.globalmetaid,
                  peerGlobalMetaID: toGlobalMetaId,
                  externalConversationId: recorded.externalConversationId,
                  sessionId: recorded.sessionId,
                  direction: 'outgoing',
                  content: plaintext,
                  messageId: recorded.message?.id ?? null,
                  pinId: row.pin_id,
                  replyToPinId: row.reply_pin,
                  occurredAt: Number.isFinite(Number(row.chain_timestamp)) ? Number(row.chain_timestamp) : undefined,
                  sourceMetadata: { txId: row.tx_id, pinId: row.pin_id },
                });
              } catch (error) {
                emitLog(
                  `[PrivateChat] Outgoing experience capture failed for ${toGlobalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }
            if (recorded?.duplicate) {
              emitLog(
                `[PrivateChat] Outgoing sync: message already tracked in session, skipping duplicate.`
              );
            } else if (recorded) {
              emitLog(
                `[PrivateChat] Synced outgoing message to A2A session for peer ${toGlobalMetaId.slice(0, 12)}…`
              );
            }
          } catch (error) {
            rethrowSqliteWasmBoundsError(error);
            emitLog(
              `[PrivateChat] Outgoing sync failed for peer ${toGlobalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      if (!shouldContinuePrivateChatInboundAfterOutgoingSync({
        senderMetabotId: senderMetabot.id,
        recipientMetabotId: recipientMetabot?.id ?? null,
      })) {
        markProcessed(db, row.id, saveDb);
        return;
      }

      emitLog(
        `[PrivateChat] Outgoing local message is addressed to local MetaBot ${recipientMetabot?.id}; continuing inbound processing.`
      );
    }

    const metabot = recipientMetabot;
    if (!metabot) {
      emitLog(`[PrivateChat] Skip message ${row.id}: no MetaBot for to_global_metaid ${toGlobalMetaId.slice(0, 12)}…`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const wallet = metabotStore.getMetabotWalletByMetabotId(metabot.id);
    const fromChatPubkey = (row.from_chat_pubkey ?? '').trim();
    const fromGlobalMetaId = (row.from_global_metaid || row.from_metaid || '').trim();

    // Resolve the plaintext whenever the crypto material is available. The
    // OpenTeam interception below runs BEFORE the enabled/wallet/chat-pubkey
    // gates so a disabled bot can still DECLINE an invite (otherwise the
    // inviter waits out the whole invite TTL). Rows that cannot be decrypted
    // keep the original skip behavior via the gates re-checked afterward.
    let plaintext = '';
    let sharedSecretForReply = '';
    if (wallet?.mnemonic?.trim() && fromChatPubkey) {
      if (privateChatDecryptFailedIds.has(row.id)) {
        // Already known undecryptable for this daemon run; skip quietly while
        // keeping the row unprocessed so a restart can retry it.
        return;
      }
      let privateKeyBuffer: Buffer;
      try {
        privateKeyBuffer = await getPrivateKeyBufferForEcdh(wallet.mnemonic, wallet.path ?? "m/44'/10001'/0'/0/0");
      } catch (e) {
        rethrowSqliteWasmBoundsError(e);
        emitLog(`[PrivateChat] Skip message ${row.id}: getPrivateKeyBufferForEcdh failed: ${e instanceof Error ? e.message : e}`);
        markProcessed(db, row.id, saveDb);
        return;
      }

      let sharedSecretSha256: string;
      let sharedSecretRaw: string;
      try {
        sharedSecretSha256 = computeEcdhSharedSecretSha256(privateKeyBuffer, fromChatPubkey);
        sharedSecretRaw = computeEcdhSharedSecret(privateKeyBuffer, fromChatPubkey);
      } catch (e) {
        rethrowSqliteWasmBoundsError(e);
        emitLog(`[PrivateChat] Skip message ${row.id}: invalid peer public key (${fromChatPubkey.slice(0, 16)}…): ${e instanceof Error ? e.message : e}`);
        markProcessed(db, row.id, saveDb);
        return;
      }
      emitLog(
        `[PrivateChat] ECDH ready: from_chat_pubkey(first/last16)=${fromChatPubkey.slice(0, 16)}...${fromChatPubkey.slice(-16)} sha256Secret(first/last16)=${sharedSecretSha256.slice(0, 16)}...${sharedSecretSha256.slice(-16)}`
      );

      const contentInDb = (row.content ?? '').trim();
      const contentInRawData = getCipherTextFromRawData(
        typeof row.raw_data === 'string' ? row.raw_data : null
      );
      const cipherText = contentInRawData || contentInDb;
      if (!cipherText && !contentInDb) {
        markProcessed(db, row.id, saveDb);
        return;
      }

      const shouldDecrypt =
        !!contentInRawData || looksLikeEncryptedPrivateContent(contentInDb);
      plaintext = contentInDb;
      sharedSecretForReply = sharedSecretSha256;
      if (shouldDecrypt) {
        const plainBySha256 = tryDecryptWithSecret(cipherText, sharedSecretSha256);
        if (plainBySha256 != null) {
          plaintext = plainBySha256;
          sharedSecretForReply = sharedSecretSha256;
        } else {
          const plainByRaw = tryDecryptWithSecret(cipherText, sharedSecretRaw);
          if (plainByRaw != null) {
            plaintext = plainByRaw;
            sharedSecretForReply = sharedSecretRaw;
            emitLog('[PrivateChat] Decrypt fallback: using raw shared secret for legacy payload.');
          } else {
            // Loss-stop: an undecryptable message must NOT be marked
            // processed, otherwise the ciphertext is silently consumed and
            // can never be retried (e.g. once an app update adds the missing
            // key variant). Keep is_processed = 0 and only remember the id so
            // the 5s poll loop skips the repeated ECDH/decrypt work;
            // stopPrivateChatDaemon clears the set, so every daemon start
            // retries these rows once.
            privateChatDecryptFailedIds.add(row.id);
            emitLog(
              `[PrivateChat] Keep message ${row.id} unprocessed: decrypt failed for both sha256/raw shared secret`
            );
            return;
          }
        }
      }
      if (!plaintext.trim()) {
        emitLog(`[PrivateChat] Skip message ${row.id}: plaintext empty after decode`);
        markProcessed(db, row.id, saveDb);
        return;
      }
    } else {
      // Without the wallet or the peer chat pubkey the ciphertext is
      // unreadable; only a row already stored as plaintext can still be
      // inspected for an OpenTeam envelope below.
      const contentInDb = (row.content ?? '').trim();
      const contentInRawData = getCipherTextFromRawData(
        typeof row.raw_data === 'string' ? row.raw_data : null
      );
      if (!contentInRawData && contentInDb && !looksLikeEncryptedPrivateContent(contentInDb)) {
        plaintext = contentInDb;
      }
    }

    // OpenTeam protocol envelopes (invite/accept/decline/kick) are handled by the
    // OpenTeam guest/inviter flows and must never reach the LLM reply path —
    // same interception pattern as the MetaSwarm handshake and [ORDER]
    // protocols. `metabot` here is the local RECIPIENT bot of this message, so
    // invite handling always runs in the invitee's context. markProcessed runs
    // FIRST: the actual handling continues fire-and-forget (join + ACCEPT are
    // two chain pins and must not stall the private-chat pipeline), and an
    // async failure must never cause this row to be handled twice.
    if (plaintext.trim() && interceptOpenTeamEnvelope({
      plaintext,
      metabot,
      fromGlobalMetaId,
      fromChatPubkey,
      messageId: row.id,
      emitLog,
      onWasmBoundsError,
      // 改进清单 #15: pass the cowork store + row display fields so an
      // incoming invite becomes a visible message in the invitee's A2A
      // private-chat stream (not a silent protocol consume).
      coworkStore,
      senderName: (row.from_name as string | null) ?? null,
      senderAvatar: (row.from_avatar as string | null) ?? null,
      rowPinId: row.pin_id,
      emitToRenderer,
    })) {
      markProcessed(db, row.id, saveDb);
      return;
    }

    if (metabot.enabled === false) {
      emitLog(`[PrivateChat] Skip message ${row.id}: MetaBot ${metabot.name} is disabled.`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    if (!wallet?.mnemonic?.trim()) {
      emitLog(`[PrivateChat] Skip message ${row.id}: MetaBot ${metabot.name} has no wallet`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    if (!fromChatPubkey) {
      emitLog(`[PrivateChat] Skip message ${row.id}: no from_chat_pubkey`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const handshakeWord = normalizeHandshakeWord(plaintext.trim());
    const createSimpleMsgPin = async (payload: string) => createPinWithMvcSubsidyRetry({
      metabot,
      wallet,
      createPin: async () => createPin(metabotStore, metabot.id, {
        operation: 'create',
        path: '/protocols/simplemsg',
        encryption: '0',
        version: '1.0.0',
        contentType: 'application/json',
        payload,
      }, { origin: 'internal:private-chat' }),
    });

    if (handshakeWord === 'ping') {
      const encryptedPong = ecdhEncrypt('pong', sharedSecretForReply);
      emitLog(`[PrivateChat] Encrypt ping->pong: plaintext="pong" sharedSecretLen=${sharedSecretForReply.length} encryptedLen=${encryptedPong.length} encryptedPrefix=${encryptedPong.slice(0, 40)}...`);
      const payloadStr = buildPrivateMsgPayload(fromGlobalMetaId, encryptedPong, row.reply_pin || '');
      try {
        await createSimpleMsgPin(payloadStr);
        emitLog(`[PrivateChat] Ping -> Pong to ${fromGlobalMetaId.slice(0, 12)}…`);
      } catch (e) {
        rethrowSqliteWasmBoundsError(e);
        const suffix = isMvcInsufficientBalanceError(e)
          ? ' (auto-subsidy retry failed)'
          : '';
        emitLog(`[PrivateChat] Failed to send pong${suffix}: ${e instanceof Error ? e.message : e}`);
      }
      markProcessed(db, row.id, saveDb);
      return;
    }

    if (handshakeWord === 'pong') {
      emitLog(`[PrivateChat] Handshake completed: received pong from ${fromGlobalMetaId.slice(0, 12)}…, no further reply.`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    if (isByeMessage(plaintext)) {
      emitLog(`[PrivateChat] Received "bye" from ${fromGlobalMetaId.slice(0, 12)}…, ending conversation.`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    // Handle incoming orders FIRST — before any buyer-reply routing.
    // An [ORDER] message is always a new task request, never a reply to our own order.
    if (isOrderMessage(plaintext)) {
      const source: OrderSource = 'metaweb_private';
      const txid = extractOrderTxid(plaintext);
      const orderPinId = extractOrderPinId(plaintext);
      const orderReferenceId = extractOrderReferenceId(plaintext);
      const localGlobalMetaId = (metabot.globalmetaid || '').trim();
      if (
        source === 'metaweb_private'
        && fromGlobalMetaId
        && localGlobalMetaId
        && fromGlobalMetaId === localGlobalMetaId
      ) {
        emitLog(`[Order] Skip self-directed order message for ${localGlobalMetaId.slice(0, 12)}…`);
        serviceOrderLifecycle?.repairSelfDirectedOrders();
        markProcessed(db, row.id, saveDb);
        return;
      }
      const payment = await checkOrderPaymentStatus({
        txid,
        plaintext,
        source,
        metabotId: metabot.id,
        metabotStore,
      });
      const isFreeOrder = payment.reason === 'free_order_no_payment_required';
      const paymentTxid = txid || '';
      const orderTrackingId = orderPinId || txid || (isFreeOrder ? orderReferenceId : null);
      const orderMessageTxid = normalizeOrderMessageTxid(row.tx_id);
      const orderPeerGlobalMetaId = fromGlobalMetaId || normalizePrivateConversationPeerId(row);
      if (!payment.paid) {
        emitLog(`[Order] Payment not confirmed for txid=${txid || orderReferenceId || 'n/a'} (reason=${payment.reason})`);
        markProcessed(db, row.id, saveDb);
        return;
      }
      emitLog(
        `[Order] Payment verified: ref=${orderTrackingId || 'n/a'} chain=${payment.chain || '?'} amount=${payment.amountAtomic ?? payment.amountSats ?? 0} ${payment.settlementKind === 'mrc20' ? 'atomic' : 'sats'}`
      );
      const allowedSkillNames = extractOrderAllowedSkills(plaintext);
      const serviceId = extractOrderSkillId(plaintext);
      const serviceName = extractOrderSkillName(plaintext) || 'Service Order';
      const serviceOutputType = resolveSellerOrderOutputType({
        plaintext,
        serviceId,
        serviceName,
        resolveLocalServiceOutputType,
      });
      const executionReminder = String(resolveLocalServiceExecutionReminder?.({
        serviceId,
        serviceName,
      }) || '').trim();
      const paymentAmount = payment.amountDisplay || formatPaymentAmountFromSats(payment.amountSats);
      const paymentCurrency = payment.currency || getCurrencyFromChain(payment.chain);
      let sellerOrderSessionId: string | null = null;
      let sellerOrderConversationId: string | null = null;
      if (serviceOrderLifecycle && orderTrackingId) {
        try {
          serviceOrderLifecycle.createSellerOrder({
            localMetabotId: metabot.id,
            counterpartyGlobalMetaId: orderPeerGlobalMetaId,
            servicePinId: serviceId,
            orderPinId,
            serviceName,
            paymentTxid,
            paymentChain: payment.chain || 'mvc',
            paymentAmount,
            paymentCurrency,
            settlementKind: payment.settlementKind,
            mrc20Ticker: payment.mrc20Ticker,
            mrc20Id: payment.mrc20Id,
            paymentCommitTxid: payment.paymentCommitTxid,
            orderMessagePinId: row.pin_id,
            orderMessageTxid,
          });
        } catch (error) {
          rethrowSqliteWasmBoundsError(error);
          emitLog(`[Order] Failed to create seller order row: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (orderTrackingId) {
        try {
          const ensuredObserverSession = await ensureServiceOrderObserverSession(coworkStore, {
            role: 'seller',
            metabotId: metabot.id,
            peerGlobalMetaId: orderPeerGlobalMetaId,
            peerName: (row.from_name as string | null) ?? null,
            peerAvatar: (row.from_avatar as string | null) ?? null,
            serviceId,
            servicePrice: paymentAmount,
            serviceCurrency: paymentCurrency,
            servicePaymentChain: payment.chain || 'mvc',
            serviceSettlementKind: payment.settlementKind,
            serviceMrc20Ticker: payment.mrc20Ticker,
            serviceMrc20Id: payment.mrc20Id,
            servicePaymentCommitTxid: payment.paymentCommitTxid,
            serviceSkill: serviceName,
            serviceOutputType,
            serverBotGlobalMetaId: localGlobalMetaId || null,
            servicePaidTx: paymentTxid,
            serviceOrderPinId: orderPinId,
            orderTxid: orderMessageTxid,
            orderMessagePinId: row.pin_id,
            orderMessageTxid: row.tx_id,
            orderPayload: plaintext,
          });
          sellerOrderSessionId = ensuredObserverSession.coworkSessionId;
          sellerOrderConversationId = ensuredObserverSession.externalConversationId;
          if (serviceOrderLifecycle) {
            try {
              serviceOrderLifecycle.attachCoworkSessionToSellerOrder({
                localMetabotId: metabot.id,
                counterpartyGlobalMetaId: orderPeerGlobalMetaId,
                orderPinId,
                paymentTxid,
                coworkSessionId: ensuredObserverSession.coworkSessionId,
              });
            } catch (error) {
              rethrowSqliteWasmBoundsError(error);
              emitLog(`[Order] Failed to persist seller session link: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (ensuredObserverSession.initialMessage && emitToRenderer) {
            emitToRenderer('cowork:stream:message', {
              sessionId: ensuredObserverSession.coworkSessionId,
              message: ensuredObserverSession.initialMessage,
            });
          }
        } catch (error) {
          rethrowSqliteWasmBoundsError(error);
          emitLog(`[Order] Failed to ensure seller order session: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!orderCoworkHandler) {
        emitLog('[Order] Cowork handler not initialized; skipping order.');
        markProcessed(db, row.id, saveDb);
        return;
      }

      const sendEncryptedMsg = async (text: string) => {
        const encrypted = ecdhEncrypt(text, sharedSecretForReply);
        const payloadStr = buildPrivateMsgPayload(fromGlobalMetaId, encrypted, row.reply_pin || '');
        return await createSimpleMsgPin(payloadStr);
      };

      let processingNotice: OrderCoworkRequest['processingNotice'] | undefined;
      if (source === 'metaweb_private' && fromGlobalMetaId) {
        try {
          const acknowledgement = await sendSellerOrderAcknowledgement({
            metabot,
            peerGlobalMetaId: fromGlobalMetaId,
            peerName: (row.from_name as string | null) ?? null,
            plaintext,
            skillName: serviceName,
            paymentTxid,
            orderPinId,
            orderTxid: orderMessageTxid,
            performChat,
            sendEncryptedMsg,
            serviceOrderLifecycle,
            emitLog,
          });
          processingNotice = {
            content: acknowledgement.text,
            metadata: buildPrivateChatA2AChainMetadata({
              txids: acknowledgement.txids,
              pinId: acknowledgement.pinId,
            }),
          };
        } catch (error) {
          rethrowSqliteWasmBoundsError(error);
          emitLog(`[Order] Immediate acknowledgement broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const skillScope = await resolveSellerOrderSkillScopePrompt({
        skillId: serviceId,
        skillName: serviceName,
        allowedSkillNames,
        getSkillsPrompt,
      });
      if (skillScope.shouldRejectOrder) {
        const scopeFailureNotice = buildOrderSkillScopeFailureNotice(skillScope);
        const transmittedScopeFailureNotice = orderMessageTxid || orderPinId
          ? buildOrderStatusMessage(orderMessageTxid, scopeFailureNotice, orderPinId)
          : scopeFailureNotice;
        emitLog(
          `[Order] Rejecting scoped order: allowed skills did not resolve locally (${skillScope.allowedSkillNames.join(', ') || 'n/a'}).`
        );
        if (source === 'metaweb_private' && fromGlobalMetaId) {
          try {
            const failureResult = await sendEncryptedMsg(transmittedScopeFailureNotice);
            if (sellerOrderSessionId) {
              const failureMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: transmittedScopeFailureNotice,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: transmittedScopeFailureNotice,
                  fallbackTag: 'ORDER_STATUS',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: sellerOrderConversationId,
                  extra: {
                    orderExecutionFailed: true,
                    orderSkillScopeRejected: true,
                    allowedSkillNames: skillScope.allowedSkillNames,
                    missingSkillNames: skillScope.missingSkillNames,
                    ...buildPrivateChatA2AChainMetadata({
                      txids: failureResult.txids,
                      pinId: failureResult.pinId,
                    }),
                  },
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: failureMsg });
              }
            }
          } catch (sendError) {
            rethrowSqliteWasmBoundsError(sendError);
            emitLog(`[Order] Scoped failure notice broadcast failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          }
        }
        serviceOrderLifecycle?.markSellerOrderFailed({
          localMetabotId: metabot.id,
          counterpartyGlobalMetaId: orderPeerGlobalMetaId,
          orderPinId,
          paymentTxid,
          orderMessageTxid,
          failureReason: SERVICE_ORDER_SKILL_SCOPE_UNRESOLVED_REASON,
          failedAt: Date.now(),
        });
        markProcessed(db, row.id, saveDb);
        return;
      }

      // Delivery funding gate: a file deliverable is only complete once it is
      // pinned on-chain, and that upload is paid from this bot's MVC wallet.
      // Measure the wallet's delivery capacity up front so the executor can
      // size the artifact to fit — and reject orders the wallet cannot
      // possibly deliver before any skill work (or third-party API quota) is
      // burned. Fails open: a balance-query error yields no budget and the
      // order proceeds without guidance.
      let deliveryBudget: OrderDeliveryBudget | null = null;
      try {
        deliveryBudget = await resolveOrderDeliveryBudget({
          metabotStore,
          metabotId: metabot.id,
          mvcAddress: metabot.mvc_address,
          outputType: serviceOutputType,
        });
      } catch (error) {
        rethrowSqliteWasmBoundsError(error);
        emitLog(`[Order] Delivery budget resolution failed; continuing without it: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (deliveryBudget?.shouldRejectOrder) {
        const fundingFailureNotice = buildOrderDeliveryFundingFailureNotice(deliveryBudget);
        const transmittedFundingFailureNotice = orderMessageTxid || orderPinId
          ? buildOrderStatusMessage(orderMessageTxid, fundingFailureNotice, orderPinId)
          : fundingFailureNotice;
        emitLog(
          `[Order] Rejecting order: delivery funding insufficient (capacity ${deliveryBudget.fundableBytes} bytes).`
        );
        if (source === 'metaweb_private' && fromGlobalMetaId) {
          try {
            const failureResult = await sendEncryptedMsg(transmittedFundingFailureNotice);
            if (sellerOrderSessionId) {
              const failureMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: transmittedFundingFailureNotice,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: transmittedFundingFailureNotice,
                  fallbackTag: 'ORDER_STATUS',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: sellerOrderConversationId,
                  extra: {
                    orderExecutionFailed: true,
                    orderDeliveryFundingInsufficient: true,
                    deliveryFundableBytes: deliveryBudget.fundableBytes,
                    ...buildPrivateChatA2AChainMetadata({
                      txids: failureResult.txids,
                      pinId: failureResult.pinId,
                    }),
                  },
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: failureMsg });
              }
            }
          } catch (sendError) {
            rethrowSqliteWasmBoundsError(sendError);
            emitLog(`[Order] Funding failure notice broadcast failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          }
        }
        serviceOrderLifecycle?.markSellerOrderFailed({
          localMetabotId: metabot.id,
          counterpartyGlobalMetaId: orderPeerGlobalMetaId,
          orderPinId,
          paymentTxid,
          orderMessageTxid,
          failureReason: SERVICE_ORDER_DELIVERY_FUNDING_INSUFFICIENT_REASON,
          failedAt: Date.now(),
        });
        markProcessed(db, row.id, saveDb);
        return;
      }

      const prompts = buildOrderPrompts({
        plaintext,
        source,
        metabotName: metabot.name,
        skillsPrompt: skillScope.prompt,
        peerName: (row.from_name as string | null) ?? null,
        skillId: serviceId,
        skillName: serviceName,
        allowedSkillNames: skillScope.allowedSkillNames,
        executionReminder,
        expectedOutputType: serviceOutputType,
        deliveryBudget,
      });
      const externalConversationId = sellerOrderConversationId || buildOrderExternalConversationId(row, source, orderTrackingId);
      const orderDispatchKey = orderTrackingId
        ? buildOrderDispatchKey(metabot.id, orderPeerGlobalMetaId, orderTrackingId)
        : null;

      let orderResult: { serviceReply: string; ratingInvite: string; isDeliverable: boolean };
      try {
        orderResult = await orderCoworkHandler.runOrder({
          metabotId: metabot.id,
          source,
          externalConversationId,
          displaySessionId: sellerOrderSessionId,
          prompt: prompts.userPrompt,
          systemPrompt: prompts.systemPrompt,
          peerGlobalMetaId: fromGlobalMetaId || null,
          peerName: (row.from_name as string | null) ?? null,
          peerAvatar: (row.from_avatar as string | null) ?? null,
          expectedOutputType: serviceOutputType,
          orderTxid: orderMessageTxid,
          orderPinId,
          paymentTxid,
          activeSkillIds: skillScope.activeSkillIds,
          processingNotice,
          sendStatusUpdate: source === 'metaweb_private' && fromGlobalMetaId
            ? sendEncryptedMsg
            : undefined,
        });
      } catch (error) {
        rethrowSqliteWasmBoundsError(error);
        const failureDetail = buildOrderExecutionFailureNotice(error);
        const failureReason = resolveNonDeliverableSellerFailureReason(failureDetail);
        const failureNotice = buildNonDeliverableSellerFailureNotice({
          outputType: serviceOutputType,
          fallbackDetail: failureDetail,
        });
        const transmittedFailureNotice = orderMessageTxid || orderPinId
          ? buildOrderStatusMessage(orderMessageTxid, failureNotice, orderPinId)
          : failureNotice;
        emitLog(`[Order] Cowork run failed: ${error instanceof Error ? error.message : String(error)}`);
        if (source === 'metaweb_private' && fromGlobalMetaId) {
          try {
            const failureResult = await sendEncryptedMsg(transmittedFailureNotice);
            emitLog(`[Order] Failure notice sent to ${fromGlobalMetaId.slice(0, 12)}…`);
            if (sellerOrderSessionId) {
              const failureMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: transmittedFailureNotice,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: transmittedFailureNotice,
                  fallbackTag: 'ORDER_STATUS',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: externalConversationId,
                  extra: {
                    orderExecutionFailed: true,
                    ...buildPrivateChatA2AChainMetadata({
                      txids: failureResult.txids,
                      pinId: failureResult.pinId,
                    }),
                  },
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: failureMsg });
              }
            }
          } catch (sendError) {
            rethrowSqliteWasmBoundsError(sendError);
            emitLog(`[Order] Failure notice broadcast failed: ${sendError instanceof Error ? sendError.message : String(sendError)}`);
          }
        }
        markSellerOrderExecutionFailed({
          serviceOrderLifecycle,
          metabotId: metabot.id,
          peerGlobalMetaId: orderPeerGlobalMetaId,
          orderPinId,
          paymentTxid,
          orderMessageTxid,
          failureReason,
          failedAt: Date.now(),
        });
        markProcessed(db, row.id, saveDb);
        return;
      }

      sellerOrderSessionId = resolveOrderSessionId({
        directSessionId: sellerOrderSessionId,
        fallbackSessionId: coworkStore.getConversationMapping('metaweb_order', externalConversationId, metabot.id)?.coworkSessionId,
      });

      const trimmedReply = (orderResult.serviceReply || '').trim();
      const trimmedInvite = (orderResult.ratingInvite || '').trim();
      let deliveryBroadcastFailed = false;
      if (trimmedReply && source === 'metaweb_private') {
        if (orderResult.isDeliverable === false) {
          const failureReason = resolveNonDeliverableSellerFailureReason(trimmedReply);
          const failureNotice = buildNonDeliverableSellerFailureNotice({
            outputType: serviceOutputType,
            fallbackDetail: trimmedReply,
          });
          try {
            const transmittedFallbackReply = orderMessageTxid || orderPinId
              ? buildOrderStatusMessage(orderMessageTxid, failureNotice, orderPinId)
              : failureNotice;
            const fallbackResult = await sendEncryptedMsg(transmittedFallbackReply);
            emitLog(`[Order] Timeout fallback notice sent to ${fromGlobalMetaId.slice(0, 12)}…`);
            if (sellerOrderSessionId) {
              const fallbackMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: transmittedFallbackReply,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: transmittedFallbackReply,
                  fallbackTag: 'ORDER_STATUS',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: externalConversationId,
                  extra: {
                    orderTimeoutFallback: true,
                    orderExecutionFailed: true,
                    orderNonDeliverableFailure: true,
                    ...buildPrivateChatA2AChainMetadata({
                      txids: fallbackResult.txids,
                      pinId: fallbackResult.pinId,
                    }),
                  },
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: fallbackMsg });
              }
            }
          } catch (error) {
            rethrowSqliteWasmBoundsError(error);
            emitLog(`[Order] Timeout fallback notice broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          markSellerOrderExecutionFailed({
            serviceOrderLifecycle,
            metabotId: metabot.id,
            peerGlobalMetaId: orderPeerGlobalMetaId,
            orderPinId,
            paymentTxid,
            orderMessageTxid,
            failureReason,
            failedAt: Date.now(),
          });
        } else if (orderDispatchKey && sentOrderDeliveryKeys.has(orderDispatchKey)) {
          emitLog(`[Order] Delivery already sent for order ${orderTrackingId}, skipping duplicate send.`);
        } else {
          const deliverySentAtSec = Math.floor(Date.now() / 1000);
          const deliveryText = buildDeliveryMessage({
            ...(paymentTxid ? { paymentTxid } : {}),
            ...(orderPinId ? { serviceOrderPinId: orderPinId, orderPinId } : {}),
            servicePinId: serviceId,
            serviceName,
            result: trimmedReply,
            deliveredAt: deliverySentAtSec,
          }, orderMessageTxid);
          try {
            const deliveryResult = await sendEncryptedMsg(deliveryText);
            if (serviceOrderLifecycle && orderTrackingId) {
              serviceOrderLifecycle.markSellerOrderDelivered({
                localMetabotId: metabot.id,
                counterpartyGlobalMetaId: orderPeerGlobalMetaId,
                orderPinId,
                paymentTxid,
                deliveryMessagePinId: deliveryResult.pinId ?? null,
                deliveredAt: deliverySentAtSec * 1000,
              });
            }
            if (orderDispatchKey) {
              sentOrderDeliveryKeys.add(orderDispatchKey);
            }
            if (sellerOrderSessionId) {
              const deliveryMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: deliveryText,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: deliveryText,
                  fallbackTag: 'DELIVERY',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: externalConversationId,
                  extra: {
                    orderDeliveryMessage: true,
                    ...buildPrivateChatA2AChainMetadata({
                      txids: deliveryResult.txids,
                      pinId: deliveryResult.pinId,
                    }),
                  },
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: deliveryMsg });
              }
            }
            emitLog(`[Order] Service reply sent to ${fromGlobalMetaId.slice(0, 12)}…`);
          } catch (error) {
            rethrowSqliteWasmBoundsError(error);
            deliveryBroadcastFailed = true;
            emitLog(`[Order] Service reply broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
            if (sellerOrderSessionId) {
              const failureReason = error instanceof Error ? error.message : String(error);
              const localFailureText = orderMessageTxid || orderPinId
                ? buildOrderStatusMessage(orderMessageTxid, [
                  'The service result was generated, but the on-chain delivery message failed to send. The result below is available only in this local conversation.',
                  failureReason,
                  '',
                  deliveryText,
                ].join('\n'), orderPinId)
                : [
                  'The service result was generated, but the on-chain delivery message failed to send. The result below is available only in this local conversation.',
                  failureReason,
                  '',
                  deliveryText,
                ].join('\n');
              const localFailureMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: localFailureText,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: localFailureText,
                  fallbackTag: 'ORDER_STATUS',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: externalConversationId,
                  extra: {
                    excludeFromSandboxHistory: true,
                    orderDeliveryBroadcastFailed: true,
                  },
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: localFailureMsg });
              }
            }
          }
        }
      }
      if (trimmedInvite && source === 'metaweb_private' && !deliveryBroadcastFailed) {
        if (orderDispatchKey && sentOrderRatingInviteKeys.has(orderDispatchKey)) {
          emitLog(`[Order] Rating invite already sent for order ${orderTrackingId}, skipping duplicate send.`);
        } else {
          try {
            const inviteResult = await sendEncryptedMsg(trimmedInvite);
            if (serviceOrderLifecycle && orderTrackingId) {
              serviceOrderLifecycle.markOrderRatingRequested('seller', {
                localMetabotId: metabot.id,
                counterpartyGlobalMetaId: orderPeerGlobalMetaId,
                orderPinId,
                paymentTxid,
              });
            }
            if (orderDispatchKey) {
              sentOrderRatingInviteKeys.add(orderDispatchKey);
            }
            emitLog(`[Order] Rating invite sent to ${fromGlobalMetaId.slice(0, 12)}…`);
            // Add [NeedsRating] to B's own session so it appears in B's UI
            if (sellerOrderSessionId) {
              const inviteMsg = coworkStore.addMessage(sellerOrderSessionId, {
                type: 'assistant',
                content: trimmedInvite,
                metadata: buildOrderA2ADisplayMetadata({
                  peerGlobalMetaId: orderPeerGlobalMetaId,
                  direction: 'outgoing',
                  content: trimmedInvite,
                  fallbackTag: 'NeedsRating',
                  orderTxid: orderMessageTxid,
                  orderRole: 'seller',
                  orderPinId,
                  paymentTxid,
                  orderMappingExternalConversationId: externalConversationId,
                  extra: buildPrivateChatA2AChainMetadata({
                    txids: inviteResult.txids,
                    pinId: inviteResult.pinId,
                  }),
                }),
              });
              if (emitToRenderer) {
                emitToRenderer('cowork:stream:message', { sessionId: sellerOrderSessionId, message: inviteMsg });
              }
            }
          } catch (error) {
            rethrowSqliteWasmBoundsError(error);
            emitLog(`[Order] Rating invite broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (source !== 'metaweb_private') {
        emitLog('[Order] Group order reply not implemented yet.');
      }

      markProcessed(db, row.id, saveDb);
      return;
    }

    // Route explicit order protocol messages by the original [ORDER] simplemsg txid.
    // Legacy delivery/rating messages without txid keep the old single-open-order fallback.
    if (fromGlobalMetaId) {
      const delivery = parseDeliveryMessage(plaintext);
      const isNeedsRating = isNeedsRatingMessage(plaintext);
      const orderEnd = parseOrderEndMessage(plaintext);
      const orderProtocolTxid = resolveOrderProtocolTxid(plaintext);
      const explicitOrderPinId = resolveOrderProtocolPinId(plaintext);
      const buyerOrderMapping = resolveBuyerOrderProtocolMapping(coworkStore, {
        localMetabotId: metabot.id,
        peerGlobalMetaId: fromGlobalMetaId,
        plaintext,
      });
      if (buyerOrderMapping) {
        emitLog(`[PrivateChat] Order protocol message from ${fromGlobalMetaId.slice(0, 12)}…, attaching to session ${buyerOrderMapping.coworkSessionId.slice(0, 8)}…`);
        const buyerOrderMeta = parseConversationMappingMetadata(buyerOrderMapping.metadataJson);
        if (isNeedsRating && buyerOrderMeta.needsRatingHandled === true) {
          emitLog(`[Rating] Duplicate [NeedsRating] detected for session ${buyerOrderMapping.coworkSessionId.slice(0, 8)}…, skipping.`);
          markProcessed(db, row.id, saveDb);
          return;
        }
        const paymentTxid =
          typeof buyerOrderMeta.servicePaidTx === 'string'
            ? buyerOrderMeta.servicePaidTx.trim()
            : '';
        const serviceOrderPinId = explicitOrderPinId
          || normalizeServiceOrderPinId(buyerOrderMeta.serviceOrderPinId)
          || normalizeServiceOrderPinId(buyerOrderMeta.orderPinId)
          || normalizeServiceOrderPinId(delivery?.serviceOrderPinId)
          || normalizeServiceOrderPinId(delivery?.orderPinId);
        const deliveryFailureNotice = isOrderDeliveryFailureNotice(plaintext);
        const observerRole = String(buyerOrderMeta.role || '').trim();
        const observerOrderTxid = typeof buyerOrderMeta.orderTxid === 'string'
          ? buyerOrderMeta.orderTxid.trim()
          : orderProtocolTxid;
        const replyMsg = coworkStore.addMessage(buyerOrderMapping.coworkSessionId, {
          type: observerRole === 'seller' ? 'user' : 'assistant',
          content: plaintext,
          metadata: buildOrderA2ADisplayMetadata({
            peerGlobalMetaId: fromGlobalMetaId,
            direction: 'incoming',
            content: plaintext,
            fallbackTag: deliveryFailureNotice ? 'ORDER_STATUS' : undefined,
            orderTxid: observerOrderTxid,
            orderRole: observerRole || 'buyer',
            orderPinId: serviceOrderPinId,
            paymentTxid,
            orderMappingExternalConversationId: buyerOrderMapping.externalConversationId,
            extra: {
              senderGlobalMetaId: fromGlobalMetaId,
              senderName: (row.from_name as string | null) ?? undefined,
              senderAvatar: (row.from_avatar as string | null) ?? undefined,
              ...buildPrivateChatA2AChainMetadata({
                txId: row.tx_id,
                pinId: row.pin_id,
              }),
            },
          }),
        });
        coworkStore.touchConversationMapping('metaweb_order', buyerOrderMapping.externalConversationId, metabot.id);
        if (emitToRenderer) {
          emitToRenderer('cowork:stream:message', { sessionId: buyerOrderMapping.coworkSessionId, message: replyMsg });
        }

        if (serviceOrderLifecycle && (serviceOrderPinId || paymentTxid)) {
          if (orderEnd) {
            serviceOrderLifecycle.markOrderEnded(observerRole === 'seller' ? 'seller' : 'buyer', {
              localMetabotId: metabot.id,
              counterpartyGlobalMetaId: fromGlobalMetaId,
              orderPinId: serviceOrderPinId,
              paymentTxid,
              reason: orderEnd.reason,
              orderEndMessagePinId: row.pin_id,
              endedAt: Date.now(),
            });
          } else if (isNeedsRating) {
            serviceOrderLifecycle.markOrderRatingRequested('buyer', {
              localMetabotId: metabot.id,
              counterpartyGlobalMetaId: fromGlobalMetaId,
              orderPinId: serviceOrderPinId,
              paymentTxid,
              requestedAt: Date.now(),
            });
          } else if (delivery && (typeof delivery.paymentTxid === 'string' || paymentTxid || serviceOrderPinId)) {
            const deliveryPaymentTxid = typeof delivery.paymentTxid === 'string' && delivery.paymentTxid.trim()
              ? delivery.paymentTxid.trim()
              : paymentTxid;
            const buyerOrderSession = coworkStore.getSession(buyerOrderMapping.coworkSessionId);
            const buyerOrderPayload = getOrderMessageContentForScope(
              buyerOrderSession?.messages ?? [],
              {
                orderTxid: observerOrderTxid || orderProtocolTxid,
                serviceOrderPinId,
              },
            );
            const expectedOutputType = resolveBuyerOrderOutputType({
              buyerOrderMeta,
              orderPayload: buyerOrderPayload,
              resolveLocalServiceOutputType,
            });
            const deliveryResultText = typeof delivery.result === 'string' ? delivery.result : plaintext;
            if (!deliveryResultHasExpectedArtifact(deliveryResultText, expectedOutputType)) {
              const failedOrder = await serviceOrderLifecycle.markBuyerOrderFailedAndRequestRefund({
                localMetabotId: metabot.id,
                counterpartyGlobalMetaId: fromGlobalMetaId,
                orderPinId: serviceOrderPinId,
                paymentTxid: deliveryPaymentTxid,
                failureReason: SERVICE_ORDER_DELIVERY_ARTIFACT_FAILED_REASON,
                failedAt: Date.now(),
              });
              emitLog(`[Order] Buyer order ${deliveryPaymentTxid.slice(0, 12)}… entered refund flow after missing ${normalizeServiceOutputType(expectedOutputType)} artifact.`);
              if (
                failedOrder &&
                failedOrder.coworkSessionId &&
                coworkStore.isDelegationBlocking(failedOrder.coworkSessionId)
              ) {
                handleAutoDeliveryResult(
                  coworkStore,
                  failedOrder.coworkSessionId,
                  plaintext,
                  failedOrder.serviceName,
                  failedOrder.paymentAmount,
                  failedOrder.paymentCurrency,
                  failedOrder.paymentTxid,
                  failedOrder.id,
                  emitLog,
                  emitToRenderer,
                );
              }
            } else {
              const deliveredOrder = serviceOrderLifecycle.markBuyerOrderDelivered({
                localMetabotId: metabot.id,
                counterpartyGlobalMetaId: fromGlobalMetaId,
                orderPinId: serviceOrderPinId,
                paymentTxid: deliveryPaymentTxid,
                deliveryMessagePinId: row.pin_id,
                deliveredAt:
                  typeof delivery.deliveredAt === 'number'
                    ? delivery.deliveredAt * 1000
                    : Date.now(),
              });

              // Check if this is an auto-delegated order (has a source cowork session in blocking mode)
              if (
                deliveredOrder &&
                deliveredOrder.coworkSessionId &&
                coworkStore.isDelegationBlocking(deliveredOrder.coworkSessionId)
              ) {
                handleAutoDeliveryResult(
                  coworkStore,
                  deliveredOrder.coworkSessionId,
                  plaintext,
                  deliveredOrder.serviceName,
                  deliveredOrder.paymentAmount,
                  deliveredOrder.paymentCurrency,
                  deliveredOrder.paymentTxid,
                  deliveredOrder.id,
                  emitLog,
                  emitToRenderer,
                );
              }
            }
          } else if (deliveryFailureNotice) {
            const failedOrder = await serviceOrderLifecycle.markBuyerOrderFailedAndRequestRefund({
              localMetabotId: metabot.id,
              counterpartyGlobalMetaId: fromGlobalMetaId,
              orderPinId: serviceOrderPinId,
              paymentTxid,
              failureReason: SERVICE_ORDER_DELIVERY_ARTIFACT_FAILED_REASON,
              failedAt: Date.now(),
            });
            emitLog(`[Order] Buyer order ${paymentTxid.slice(0, 12)}… entered refund flow after delivery artifact failure.`);
            if (
              failedOrder &&
              failedOrder.coworkSessionId &&
              coworkStore.isDelegationBlocking(failedOrder.coworkSessionId)
            ) {
              handleAutoDeliveryResult(
                coworkStore,
                failedOrder.coworkSessionId,
                plaintext,
                failedOrder.serviceName,
                failedOrder.paymentAmount,
                failedOrder.paymentCurrency,
                failedOrder.paymentTxid,
                failedOrder.id,
                emitLog,
                emitToRenderer,
              );
            }
          } else if (!isNeedsRatingMessage(plaintext)) {
            serviceOrderLifecycle.markBuyerOrderFirstResponseReceived({
              localMetabotId: metabot.id,
              counterpartyGlobalMetaId: fromGlobalMetaId,
              orderPinId: serviceOrderPinId,
              paymentTxid,
              receivedAt: Date.now(),
            });
          }
        }

        if (shouldCompleteBuyerOrderObserverSession(plaintext)) {
          completeBuyerOrderObserverSession(coworkStore, buyerOrderMapping.coworkSessionId, emitToRenderer);
        }

        // If this is a [NeedsRating] message, trigger automatic rating flow
        if (isNeedsRating) {
          coworkStore.updateConversationMappingMetadata(
            'metaweb_order',
            buyerOrderMapping.externalConversationId,
            metabot.id,
            {
              ...buyerOrderMeta,
              needsRatingHandled: true,
              needsRatingHandledAt: Date.now(),
            },
          );
          emitLog(`[Rating] Received [NeedsRating] from ${fromGlobalMetaId.slice(0, 12)}…, starting auto-rating flow`);
          const ratingWork = handleRatingFlow({
            metabot,
            metabotStore,
            coworkStore,
            buyerOrderMapping,
            sellerGlobalMetaId: fromGlobalMetaId,
            sharedSecretForReply,
            createPin,
            performChat: performChatCompletionForOrchestrator,
            serviceOrderLifecycle,
            emitLog,
            emitToRenderer,
          }).catch((e) => {
            if (isSqliteWasmBoundsError(e)) {
              void stopPrivateChatDaemon();
              onWasmBoundsError?.();
              return;
            }
            emitLog(`[Rating] Rating flow failed: ${e instanceof Error ? e.message : String(e)}`);
          });
          trackPrivateChatDetachedWork(ratingWork);
        }

        markProcessed(db, row.id, saveDb);
        return;
      }
      emitLog(`[PrivateChat] No buyer order session found for peer ${fromGlobalMetaId.slice(0, 12)}…, treating as regular private chat.`);
    }

    const externalConversationId = buildPrivateConversationExternalConversationId(row);

    if (shouldSkipPrivateChatAutoReplyText(plaintext)) {
      emitLog(`[PrivateChat] Skip no-op private chat message from ${fromGlobalMetaId.slice(0, 12)}…`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    // Human-ended conversations stay closed. Auto-bye conversations can restart after the cooldown.
    const existingMapping = coworkStore.getConversationMapping('metaweb_private', externalConversationId, metabot.id);
    const mappedSessionId = String(existingMapping?.coworkSessionId ?? '').trim();
    // A previous reply turn for this conversation is still running in the
    // runner (it can outlive the skill-turn watchdog). Starting another turn
    // now would clobber the live one — CoworkRunner.startSession has no
    // active-turn guard — so defer the row; the running turn's reply is
    // picked up and delivered once the session goes idle again.
    if (mappedSessionId && shouldDeferForBusyRunnerSession(isSessionTurnActive, mappedSessionId, emitLog)) {
      emitLog(`[PrivateChat] Deferring message ${row.id}: session ${mappedSessionId} still has an active reply turn.`);
      return;
    }
    // A verbatim retransmission of the previous inbound message carries no
    // new information — the first copy already drove a reply turn — and
    // answering each copy again is what turns leaked silence notes into an
    // endless ping-pong (2026-09-17). Byte-equality only, no wording checks.
    // The row's own chain identity is excluded first: a locally recorded copy
    // of THIS message (owner composer optimistic append) is not a repeat.
    // Release-audit follow-up 2026-09-19: only the SECOND consecutive
    // identical copy is absorbed. A peer that keeps re-sending the exact same
    // wording a third time is insistent, not retransmitting — absorbing it
    // forever left the peer with no reply, no silence handling, and no wake
    // (audit P2: "permanently ignored"). The third copy escalates into a real
    // reply turn; the outbound echo guard independently prevents an identical
    // reply from being delivered twice in a row, so the loop protection holds.
    const inboundRepeatKey = `${metabot.id}:${externalConversationId}`;
    const trackedRepeat = inboundRepeatEscalation.get(inboundRepeatKey);
    if (
      trackedRepeat
      && (trackedRepeat.plaintext !== plaintext.trim()
        || Date.now() - trackedRepeat.firstAt > A2A_SESSION_CONVERSATION_GAP_MS * 2)
    ) {
      inboundRepeatEscalation.delete(inboundRepeatKey);
    }
    if (mappedSessionId && isRepeatPrivateChatInboundMessage({
      messages: coworkStore.getRecentPrivateA2AMessages(mappedSessionId, 20),
      plaintext,
      excludeChainRow: row,
    })) {
      const priorRepeats = inboundRepeatEscalation.get(inboundRepeatKey);
      // Which consecutive identical copy is this, counting the original the
      // peer already sent: no entry means the absorbed candidate is copy #2.
      const copyNumber = (priorRepeats?.count ?? 1) + 1;
      if (copyNumber < PRIVATE_CHAT_REPEAT_ESCALATION_AFTER) {
        inboundRepeatEscalation.set(inboundRepeatKey, {
          plaintext: plaintext.trim(),
          count: copyNumber,
          firstAt: priorRepeats?.firstAt ?? Date.now(),
        });
        emitLog(
          `[PrivateChat] Skip message ${row.id}: identical to the previous inbound message from ${fromGlobalMetaId.slice(0, 12)}… in this conversation segment; the earlier copy already drove a reply turn.`
        );
        markProcessed(db, row.id, saveDb);
        return;
      }
      inboundRepeatEscalation.delete(inboundRepeatKey);
      emitLog(
        `[PrivateChat] Message ${row.id}: third consecutive identical copy from ${fromGlobalMetaId.slice(0, 12)}… — treating it as an insistent re-ask, not a retransmission; running a reply turn.`
      );
    }
    let currentExperienceEvidenceId: string | null = null;
    try {
      const recordedExperience = recordMetaIDPrivateA2AExperience({
        store: experienceStore ?? new MetaIDExperienceStore(db, saveDb),
        ownerGlobalMetaID: metabot.globalmetaid,
        peerGlobalMetaID: fromGlobalMetaId,
        externalConversationId,
        sessionId: existingMapping?.coworkSessionId ?? null,
        direction: 'incoming',
        content: plaintext,
        messageId: String(row.id),
        pinId: row.pin_id,
        replyToPinId: row.reply_pin,
        occurredAt: Number.isFinite(Number(row.chain_timestamp)) ? Number(row.chain_timestamp) : undefined,
        sourceMetadata: { txId: row.tx_id, pinId: row.pin_id },
      });
      currentExperienceEvidenceId = recordedExperience?.evidence.id ?? null;
    } catch (error) {
      emitLog(
        `[PrivateChat] Incoming experience capture failed for ${fromGlobalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (hasNewerPrivateChatMessage(db, {
      currentRowId: row.id,
      fromGlobalMetaId: row.from_global_metaid,
      fromMetaId: row.from_metaid,
      toGlobalMetaId: row.to_global_metaid,
      toMetaId: row.to_metaid,
    })) {
      // A stale row normally gets no reply of its own — the newer peer
      // message carries the conversation. But when an earlier turn already
      // completed and its reply was never delivered (watchdog detachment,
      // app restart), dropping this row would strand that reply forever as a
      // local-only "internal status" bubble. Fall through so the pickup
      // below delivers it before the newer message is answered.
      const pendingCompletedReply = mappedSessionId
        ? (() => {
          const trigger = findPrivateChatA2AInboundMessage({
            coworkStore,
            sessionId: mappedSessionId,
            externalConversationId,
            row,
          });
          return trigger
            ? findDeliverableCompletedTurnReply({
              coworkStore,
              sessionId: mappedSessionId,
              triggerMessageId: trigger.id,
            })
            : null;
        })()
        : null;
      if (!pendingCompletedReply) {
        emitLog(`[PrivateChat] Skip stale private chat message ${row.id}; a newer peer message is queued.`);
        markProcessed(db, row.id, saveDb);
        return;
      }
      emitLog(`[PrivateChat] Message ${row.id} has a newer peer message queued, but a completed reply turn was never delivered; delivering it first.`);
    }

    const mappingMeta = parseConversationMappingMetadata(existingMapping?.metadataJson);
    if (mappingMeta.byeSent === true) {
      // The local side may have re-engaged this peer after the bye; a bye only
      // suppresses the auto-reply, it must not mute a conversation we are
      // ourselves still writing to.
      if (shouldReopenClosedPrivateChatForLocalOutbound({
        mappingMeta,
        lastLocalOutboundAt: findLastLocalOutboundPrivateChatAt(coworkStore, mappedSessionId),
      })) {
        coworkStore.updateConversationMappingMetadata('metaweb_private', externalConversationId, metabot.id, {
          ...mappingMeta,
          byeSent: false,
          endedByHuman: false,
          endedByAutoPolicy: false,
          restartedAt: Date.now(),
        });
        emitLog(`[PrivateChat] Reopened closed private chat ${externalConversationId.slice(0, 30)}…: the local side re-engaged the peer after the bye.`);
      } else if (shouldKeepPrivateChatConversationClosedAfterBye({ mappingMeta, reopenGapMs: metabot.a2a_bye_cooldown_ms ?? undefined })) {
        const { sessionId } = await resolvePrivateConversationSession(
          coworkStore,
          metabot.id,
          metabot.globalmetaid,
          row,
          plaintext
        );
        const existingInbound = findPrivateChatA2AInboundMessage({
          coworkStore,
          sessionId,
          externalConversationId,
          row,
        });
        if (!existingInbound) {
          appendPrivateChatA2AMessage({
            coworkStore,
            sessionId,
            externalConversationId,
            type: 'user',
            content: plaintext,
            senderGlobalMetaId: fromGlobalMetaId,
            senderName: (row.from_name as string | null) ?? null,
            senderAvatar: (row.from_avatar as string | null) ?? null,
            extraMetadata: buildPrivateChatA2AChainMetadata({
              txId: row.tx_id,
              pinId: row.pin_id,
            }),
            emitToRenderer,
          });
        }
        emitLog(`[PrivateChat] byeSent flag set for ${externalConversationId.slice(0, 30)}…, stored inbound message without auto-reply.`);
        markProcessed(db, row.id, saveDb);
        return;
      }
      coworkStore.updateConversationMappingMetadata('metaweb_private', externalConversationId, metabot.id, {
        ...mappingMeta,
        byeSent: false,
        endedByAutoPolicy: false,
        restartedAt: Date.now(),
      });
    }

    const hasPriorLocalOutbound = hasPriorNonHandshakePrivateChatOutbound(db, {
      localGlobalMetaId: metabot.globalmetaid,
      localMetaId: metabot.metaid,
      peerGlobalMetaId: row.from_global_metaid,
      peerMetaId: row.from_metaid,
      currentRowId: row.id,
    }) || hasPriorPrivateChatA2AOutbound(coworkStore, {
      externalConversationId,
      metabotId: metabot.id,
    });
    const autoReplyPolicy = evaluatePrivateChatAutoReplyPolicy({
      metabot,
      senderGlobalMetaId: row.from_global_metaid,
      senderMetaId: row.from_metaid,
      listenerConfig: getListenerConfig ? getListenerConfig() : null,
      metabotStore,
      hasPriorLocalOutbound,
    });
    if (!autoReplyPolicy.shouldReply) {
      emitLog(
        `[PrivateChat] Auto-reply skipped for ${fromGlobalMetaId.slice(0, 12)}… (reason: ${autoReplyPolicy.reason}).`
      );
      markProcessed(db, row.id, saveDb);
      return;
    }

    const resolvedConversation = await resolvePrivateConversationSession(
      coworkStore,
      metabot.id,
      metabot.globalmetaid,
      row,
      plaintext
    );
    // Long-lived threads roll over to a fresh episode session past the message
    // threshold (bounded kernel context, handoff summary for continuity). The
    // inbound message below then lands in the successor session.
    const rolloverBrain = metabotBrainOptions(metabot);
    const rollover = await maybeRollOverPrivateChatEpisode({
      coworkStore,
      sessionId: resolvedConversation.sessionId,
      externalConversationId,
      metabotId: metabot.id,
      localGlobalMetaId: metabot.globalmetaid,
      peerGlobalMetaId: fromGlobalMetaId,
      peerName: (row.from_name as string | null) ?? null,
      peerAvatar: (row.from_avatar as string | null) ?? null,
      performChat,
      llmId: rolloverBrain.llmId,
      llmProvider: rolloverBrain.llmProvider,
      fallbackLlmId: rolloverBrain.fallbackLlmId,
      fallbackLlmProvider: rolloverBrain.fallbackLlmProvider,
      effort: rolloverBrain.effort,
      fallbackEffort: rolloverBrain.fallbackEffort,
      emitLog,
    });
    let sessionId = resolvedConversation.sessionId;
    let episodeStarted = resolvedConversation.episodeStarted;
    if (rollover) {
      sessionId = rollover.sessionId;
      episodeStarted = true;
      // Pending wakes reference the retired session's row bookkeeping; the
      // rollover turn re-arms on its own outcome if it stays silent.
      cancelPrivateChatA2AWakesForConversation(externalConversationId, 'episode rollover', emitLog);
    }
    // Keep the session's stored peer name/avatar in sync with the latest
    // chain profile (socket userInfo may be stale or absent); the refresh is
    // TTL-cached so it stays cheap on busy conversations.
    try {
      refreshA2APeerProfile?.(sessionId);
    } catch { /* peer profile refresh is best-effort */ }

    const userMessage = findPrivateChatA2AInboundMessage({
      coworkStore,
      sessionId,
      externalConversationId,
      row,
    }) ?? appendPrivateChatA2AMessage({
      coworkStore,
      sessionId,
      externalConversationId,
      type: 'user',
      content: plaintext,
      senderGlobalMetaId: fromGlobalMetaId,
      senderName: (row.from_name as string | null) ?? null,
      senderAvatar: (row.from_avatar as string | null) ?? null,
      extraMetadata: {
        ...buildPrivateChatA2AChainMetadata({
          txId: row.tx_id,
          pinId: row.pin_id,
        }),
        // H-64 leg B: a re-drive that actually re-presents this row (the
        // session-scoped dedup above missed) must not masquerade as a true
        // new inbound — carry the wake disposition to the renderer. The
        // already-presented original bubble is never retroactively marked.
        ...(isWakeTurn ? {
          privateChatReServed: true,
          privateChatReServedForMessageId: String(wakeDisposition?.originalRowId ?? wakeEntry?.rowId ?? row.id),
        } : {}),
        ...(episodeStarted ? {
          refreshSessionSummary: true,
          a2aEpisodeStarted: true,
          ...(rollover ? { previousEpisodeSessionId: rollover.previousSessionId } : {}),
        } : {}),
      },
      emitToRenderer,
    });

    // A previous reply turn for this conversation may have completed after
    // the daemon stopped waiting for it (skill-turn watchdog, app restart).
    // If its final reply was never delivered, deliver that reply now instead
    // of re-running an expensive LLM turn for the same trigger. A wake turn
    // skips the pickup on purpose: its window still ends in the old silent
    // decision, which is exactly what the wake re-decides.
    const completedTurnReply = isWakeTurn
      ? null
      : findDeliverableCompletedTurnReply({
          coworkStore,
          sessionId,
          triggerMessageId: userMessage.id,
        });
    if (completedTurnReply) {
      emitLog(`[PrivateChat] Picking up the completed reply turn for message ${row.id} instead of starting a new turn.`);
    }

    const memoryBackend = coworkStore.getMemoryBackend();
    const memoryPolicy = memoryBackend.getEffectiveMemoryPolicyForMetabot(metabot.id);
    const memoryContext = memoryPolicy.memoryEnabled
      ? buildPrivateReplyMemoryPromptBlocks({
          memoryBackend,
          metabotId: metabot.id,
          sourceChannel: 'metaweb_private',
          externalConversationId,
          peerGlobalMetaId: fromGlobalMetaId,
          limit: memoryPolicy.memoryUserMemoriesMaxItems,
          currentUserText: plaintext,
        })
      : '';

    let cognitionContext = '';
    if (memoryPolicy.memoryEnabled && getMetaIDCognitionPromptBlock && metabot.globalmetaid && fromGlobalMetaId) {
      try {
        cognitionContext = (await getMetaIDCognitionPromptBlock({
          observerGlobalMetaID: metabot.globalmetaid,
          subjectGlobalMetaID: fromGlobalMetaId,
          excludeEvidenceIds: currentExperienceEvidenceId ? [currentExperienceEvidenceId] : [],
        })).trim();
      } catch (error) {
        rethrowSqliteWasmBoundsError(error);
        emitLog(
          `[PrivateChat] MetaID cognition context unavailable for ${fromGlobalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // Successor episodes see the closed episodes' handoff summaries as their
    // own memory of the thread (topics, conclusions, open commitments).
    let episodeContinuityContext = '';
    try {
      episodeContinuityContext = buildA2AEpisodeContinuityPromptBlock(
        coworkStore
          .listA2AConversationEpisodes(sessionId)
          .filter((episode) => episode.sessionId !== sessionId),
      );
    } catch { /* thread lookup is best-effort; non-thread sessions have none */ }
    const promptMemoryContext = [memoryContext, cognitionContext, episodeContinuityContext].filter(Boolean).join('\n\n');

    const brain = metabotBrainOptions(metabot);
    const llmId = brain.llmId;
    const fallbackLlmId = brain.fallbackLlmId;
    if (llmId) {
      emitLog(`[PrivateChat] Auto-reply with MetaBot(${metabot.name}) llm_id=${llmId}${brain.effort ? ` effort=${brain.effort}` : ''}`);
    } else {
      emitLog(`[PrivateChat] MetaBot(${metabot.name}) llm_id is empty, fallback to default app LLM.`);
    }

    const contextMessageLimit = Math.min(
      1000,
      Math.max(120, normalizeA2AMaxIncomingTurns(metabot.a2a_max_incoming_turns ?? undefined) * 4 + 40),
    );
    // Bye pressure is thread-scoped: count incoming messages since the last
    // outgoing bye ACROSS episode rollovers, so a long-lived conversation
    // cannot outlive the max-incoming-turns policy by rotating sessions.
    const recentPrivateMessages = coworkStore.getRecentA2AThreadMessages(
      sessionId,
      Math.max(contextMessageLimit, 400),
    );
    const conversationAnalysis = analyzePrivateChatA2AConversation({
      messages: recentPrivateMessages.length > 0 ? recentPrivateMessages : [userMessage],
      maxIncomingTurns: metabot.a2a_max_incoming_turns ?? undefined,
    });
    let chatSkillsRouting: ChatSkillsRoutingPromptResult = { prompt: null, activeSkillIds: [] };
    const shouldUseChatSkills = !conversationAnalysis.shouldForceBye && getChatSkillsRoutingPrompt && runPrivateChatSkillTurn;
    if (shouldUseChatSkills) {
      try {
        chatSkillsRouting = await getChatSkillsRoutingPrompt({
          metabotId: metabot.id,
          // Baseline (any peer): bundled + assigned skills. Owner turns widen
          // to the bot's full visible set, additionally unlocking global
          // external skills.
          widened: autoReplyPolicy.reason === 'owner',
        });
      } catch (error) {
        rethrowSqliteWasmBoundsError(error);
        emitLog(`[PrivateChat] Failed to resolve chat skills for ${metabot.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const canRunChatSkills = Boolean(
      chatSkillsRouting.prompt
      && chatSkillsRouting.activeSkillIds.length > 0
      && runPrivateChatSkillTurn
    );
    const waitNoticeKey = canRunChatSkills ? getPrivateChatSkillWaitNoticeKey(row) : '';
    let skillWaitNoticeAlreadySent = canRunChatSkills
      ? hasSentPrivateChatSkillWaitNotice(coworkStore, sessionId, waitNoticeKey)
      : false;
    const sendSkillWaitNoticeBeforeExecution = async (): Promise<void> => {
      if (!canRunChatSkills || skillWaitNoticeAlreadySent) return;
      skillWaitNoticeAlreadySent = hasSentPrivateChatSkillWaitNotice(coworkStore, sessionId, waitNoticeKey);
      if (skillWaitNoticeAlreadySent) return;

      let waitNoticeText = '';
      try {
        const rawWaitNotice = generatePrivateChatSkillWaitNotice
          ? await generatePrivateChatSkillWaitNotice({
              metabot: {
                id: metabot.id,
                name: metabot.name,
                role: metabot.role,
                soul: metabot.soul,
                goal: metabot.goal,
                bio: metabot.bio,
              },
              userMessage: plaintext,
              llmId,
              llmProvider: brain.llmProvider,
              fallbackLlmId,
              fallbackLlmProvider: brain.fallbackLlmProvider,
            })
          : await performChat(
              buildPrivateChatSkillWaitNoticeSystemPrompt({
                name: metabot.name,
                role: metabot.role,
                soul: metabot.soul,
                goal: metabot.goal,
                bio: metabot.bio,
              }),
              plaintext,
              llmId,
              // Wait-notice is a short acknowledgment; skip reasoning to keep latency low.
              {
                llmProvider: brain.llmProvider,
                fallbackLlmId,
                fallbackLlmProvider: brain.fallbackLlmProvider,
                thinking: 'disabled',
              }
            );
        waitNoticeText = normalizePrivateChatSkillWaitNoticeText(rawWaitNotice);
      } catch (error) {
        rethrowSqliteWasmBoundsError(error);
        waitNoticeText = normalizePrivateChatSkillWaitNoticeText('');
        emitLog(`[PrivateChat] Skill wait notice generation failed for message ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const waitNoticeSent = await sendPrivateChatSkillWaitNotice({
        coworkStore,
        sessionId,
        externalConversationId,
        row,
        fromGlobalMetaId,
        sharedSecretForReply,
        noticeText: waitNoticeText,
        createSimpleMsgPin,
        emitLog,
        emitToRenderer,
      });
      if (!waitNoticeSent) {
        emitLog(`[PrivateChat] Continuing message ${row.id} skill execution without a delivered wait notice.`);
        return;
      }
      skillWaitNoticeAlreadySent = true;
    };
    const operatorGuidance = conversationAnalysis.shouldForceBye || completedTurnReply
      ? null
      : consumeA2AGuidance?.(sessionId, metabot.id) ?? null;
    const systemPrompt = buildPrivateChatA2ASystemPrompt({
      metabot: {
        name: metabot.name,
        role: metabot.role,
        soul: metabot.soul,
        goal: metabot.goal,
        bio: metabot.bio,
      },
      memoryContext: promptMemoryContext,
      analysis: conversationAnalysis,
      skillsPrompt: canRunChatSkills ? chatSkillsRouting.prompt : null,
      skillWaitNoticeAlreadySent,
      operatorGuidance,
      maxIncomingTurns: metabot.a2a_max_incoming_turns ?? undefined,
    });
    // Hot-layer experience injection (self-identity + value boundaries + work
    // reviews + recent dream summaries). These describe the bot itself, not the
    // user, so they are intentionally present in A2A contexts; gated on the same
    // memory policy. Work reviews were previously group-task-only; private chats
    // benefit from the same acceptance-rating feedback.
    // Validated capability drafts (Dream-RSI P0): only drafts that survived
    // the dream-time validation pass are injected.
    const provenTechniques = memoryPolicy.memoryEnabled
      ? coworkStore.listCapabilityDrafts(metabot.id, { status: 'validated', limit: 5 })
      : [];
    const experienceContext = memoryPolicy.memoryEnabled
      ? composeExperiencePromptBlocks({
          identityText: memoryBackend.listUserMemories({
            metabotId: metabot.id,
            scope: createOwnerMemoryScope(),
            usageClass: 'self_identity',
            status: 'created',
            includeDeleted: false,
            limit: 1,
            offset: 0,
          })[0]?.text ?? null,
          valueBoundaries: memoryBackend.listUserMemories({
            metabotId: metabot.id,
            scope: createOwnerMemoryScope(),
            usageClass: 'value_boundary',
            status: 'created',
            includeDeleted: false,
            limit: 5,
            offset: 0,
          }),
          workReviews: memoryBackend.listUserMemories({
            metabotId: metabot.id,
            scope: createOwnerMemoryScope(),
            usageClass: 'work_review',
            status: 'created',
            includeDeleted: false,
            limit: 5,
            offset: 0,
          }),
          provenTechniques,
          summaries: getRecentDailySummaries?.(metabot.id, RECENT_SUMMARIES_PROMPT_DAYS) ?? [],
        })
      : '';
    // P2 utilization telemetry: only bump when the techniques block actually
    // rendered (the guidance ladder can drop it entirely). Best-effort.
    if (provenTechniques.length > 0 && experienceContext.includes('<proven_techniques>')) {
      try {
        coworkStore.markCapabilityDraftsInjected(provenTechniques.map((draft) => draft.id));
      } catch {
        // telemetry is best-effort
      }
    }
    const systemPromptWithExperience = experienceContext ? `${systemPrompt}\n\n${experienceContext}` : systemPrompt;
    // A re-run of this row (after an empty-reply retry or a retriable skill-turn
    // error) carries an explicit host notice so the model knows why it is being
    // asked again and what a valid completion looks like. A wake turn instead
    // carries the wake notice: re-decide the silent tail (owed answer / bye /
    // sentinel), because no new peer message drove this run.
    const emptyReplyRetryAttempt = privateChatSkillTurnRetries.get(taskKey)?.attempts ?? 0;
    const systemPromptForTurn = [
      systemPromptWithExperience,
      emptyReplyRetryAttempt > 0 ? `\n\n${buildPrivateChatEmptyReplyRetryNotice(emptyReplyRetryAttempt)}` : '',
      isWakeTurn ? `\n\n${buildPrivateChatA2AWakeNotice(wakeEntry?.fires ?? 1)}` : '',
    ].filter(Boolean).join('');
    let reply = '';
    let trimmed = '';
    let skillAssistantMessageId: string | null = null;
    const guidanceTurn = trackInterruptibleA2AGuidanceTurn({
      sessionId,
      metabotId: metabot.id,
    });
    try {
      try {
        if (conversationAnalysis.shouldForceBye) {
          await waitBeforePrivateChatReply(conversationAnalysis.incomingTurnCount);
          reply = 'bye';
        } else if (completedTurnReply) {
          reply = completedTurnReply.replyText;
          skillAssistantMessageId = completedTurnReply.assistantMessageId;
        } else if (canRunChatSkills && runPrivateChatSkillTurn) {
          const skillTurnResult = await runPrivateChatSkillTurn({
            sessionId,
            systemPrompt: systemPromptForTurn,
            userMessage: plaintext,
            metabotId: metabot.id,
            activeSkillIds: chatSkillsRouting.activeSkillIds,
            onSkillExecutionStart: sendSkillWaitNoticeBeforeExecution,
          });
          reply = skillTurnResult.replyText;
          skillAssistantMessageId = skillTurnResult.assistantMessageId ?? null;
        } else {
          await waitBeforePrivateChatReply(conversationAnalysis.incomingTurnCount);
          reply = await performChat(systemPromptForTurn, plaintext, llmId, {
            signal: guidanceTurn.abortController.signal,
            llmProvider: brain.llmProvider,
            fallbackLlmId,
            fallbackLlmProvider: brain.fallbackLlmProvider,
            effort: brain.effort,
            fallbackEffort: brain.fallbackEffort,
            thinking: 'enabled',
          });
        }
      } catch (e) {
        rethrowSqliteWasmBoundsError(e);
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (isDshShutdownError(e)) {
          // App/host shutdown closed the DSH runtime mid-turn. Leave the row
          // UNPROCESSED and do not burn a retry attempt: the daemon picks the
          // message up again after the next boot and answers it for real.
          emitLog(`[PrivateChat] Message ${row.id} aborted: DSH runtime is shutting down; will retry after restart.`);
          return;
        }
        if (guidanceTurn.abortController.signal.aborted) {
          emitLog(`[PrivateChat] Restarting message ${row.id} so queued A2A guidance can be applied before assistant output.`);
          return;
        }
        emitLog(`[PrivateChat] LLM failed for message ${row.id}: ${errorMessage}`);
        if (canRunChatSkills) {
          const previous = privateChatSkillTurnRetries.get(taskKey);
          const attempts = (previous?.attempts ?? 0) + 1;
          if (shouldRetryPrivateChatSkillTurn({ error: e, attempts })) {
            const nextRetryAt = nextSkillTurnRetryAt(attempts);
            privateChatSkillTurnRetries.set(taskKey, { attempts, nextRetryAt });
            const waitMs = Math.max(0, nextRetryAt - Date.now());
            emitLog(
              `[PrivateChat] Keeping message ${row.id} unprocessed until a skill reply can be delivered ` +
              `(attempt ${attempts}/${PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS}, next retry in ${waitMs}ms).`
            );
            return;
          }
          privateChatSkillTurnRetries.delete(taskKey);
          emitLog(
            `[PrivateChat] Skill turn failed permanently for message ${row.id} ` +
            `(${classifyPrivateChatSkillTurnError(e)}); marking processed.`
          );
        }
        markProcessed(db, row.id, saveDb);
        return;
      }

      if (guidanceTurn.abortController.signal.aborted) {
        emitLog(`[PrivateChat] Restarting message ${row.id} so queued A2A guidance can be applied before assistant output.`);
        return;
      }

      // Fresh bye state for wake arming below: the byeSent block normalized
      // the store before the turn, but the turn may have run for minutes and
      // the conversation could have been closed meanwhile.
      const conversationClosedByBye = parseConversationMappingMetadata(
        coworkStore.getConversationMapping('metaweb_private', externalConversationId, metabot.id)?.metadataJson
      ).byeSent === true;

      trimmed = (reply ?? '').trim();
      if (!trimmed) {
        // The turn COMPLETED but produced no deliverable text. Observed shape
        // (2026-09-16 stall): the model drafts the whole answer inside its
        // reasoning block, the stream ends without a final text message, and
        // the kernel reports a normal completion — extractFinalAssistantReply
        // correctly refuses thinking content, so the reply comes back empty.
        // Silently marking the row processed here stranded the peer forever;
        // retry with an explicit protocol notice instead (same bounded backoff
        // as skill-turn failures).
        const previous = privateChatSkillTurnRetries.get(taskKey);
        const attempts = (previous?.attempts ?? 0) + 1;
        if (attempts < PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS) {
          const nextRetryAt = nextSkillTurnRetryAt(attempts);
          privateChatSkillTurnRetries.set(taskKey, { attempts, nextRetryAt });
          const waitMs = Math.max(0, nextRetryAt - Date.now());
          emitLog(
            `[PrivateChat] Turn for message ${row.id} completed without final reply text (reasoning-only completion); ` +
            `keeping the message unprocessed to retry with a protocol notice ` +
            `(attempt ${attempts}/${PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS}, next retry in ${waitMs}ms).`
          );
          appendPrivateChatA2AMessage({
            coworkStore,
            sessionId,
            externalConversationId,
            type: 'assistant',
            content: `[Host] Previous turn ended with no final reply text (reasoning only). Re-running with a protocol notice (attempt ${attempts + 1}/${PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS} in ${Math.round(waitMs / 1000)}s).`,
            extraMetadata: {
              isThinking: true,
              isStreaming: false,
              isFinal: true,
              privateChatReplyRetryNotice: true,
            },
            emitToRenderer,
          });
          return;
        }
        privateChatSkillTurnRetries.delete(taskKey);
        emitLog(
          `[PrivateChat] Turn for message ${row.id} still produced no final reply text after ` +
          `${PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS} attempts; marking processed — the peer message will go unanswered.`
        );
        appendPrivateChatA2AMessage({
          coworkStore,
          sessionId,
          externalConversationId,
          type: 'assistant',
          content: `[Host] Turn ended with no final reply text after ${PRIVATE_CHAT_SKILL_TURN_MAX_ATTEMPTS} attempts; the message was marked processed without a reply.`,
          extraMetadata: {
            isThinking: true,
            isStreaming: false,
            isFinal: true,
            privateChatReplyRetryNotice: true,
          },
          emitToRenderer,
        });
        // The conversation tail is now silent without a bye — arm a wake so
        // the host revisits it on a timer (only for established, open
        // conversations; a wake turn that exhausted its reply retries does
        // not re-arm).
        if (!isWakeTurn && hasPriorLocalOutbound && !conversationClosedByBye) {
          armPrivateChatA2AWake({
            row,
            sessionId,
            metabotId: metabot.id,
            externalConversationId,
            fires: 0,
            emitLog,
          });
        }
        markProcessed(db, row.id, saveDb);
        return;
      }
      privateChatSkillTurnRetries.delete(taskKey);
      const deliverNothingForSilentTurn = (logMessage: string): void => {
        emitLog(`[PrivateChat] ${logMessage}; delivering nothing to ${fromGlobalMetaId.slice(0, 12)}…`);
        // The skill-turn path may already have persisted the would-be reply as
        // an assistant bubble. Keep it for local context, but tag it so the
        // A2A view hides it and no late-completion pickup re-delivers it as a
        // real reply.
        if (skillAssistantMessageId) {
          const candidate = coworkStore.getMessageById(sessionId, skillAssistantMessageId);
          if (candidate?.type === 'assistant') {
            const metadata: CoworkMessageMetadata = {
              ...(candidate.metadata ?? {}),
              privateChatNoReply: true,
            };
            coworkStore.updateMessage(sessionId, candidate.id, { metadata });
            if (emitToRenderer) {
              emitToRenderer('cowork:stream:messageUpdate', {
                sessionId,
                messageId: candidate.id,
                metadata,
              });
            }
          }
        }
        // The host only runs this bot again when a NEW peer message arrives,
        // so a silent decision in an open conversation can strand both sides
        // (the 2026-09-16 deadlock). Arm a bounded wake that re-drives this
        // row under a wake notice; a wake turn that stays silent re-arms
        // until the budget is exhausted.
        if (isWakeTurn) {
          armPrivateChatA2AWake({
            row,
            sessionId,
            metabotId: metabot.id,
            externalConversationId,
            fires: wakeEntry?.fires ?? 1,
            emitLog,
          });
        } else if (hasPriorLocalOutbound && !conversationClosedByBye) {
          armPrivateChatA2AWake({
            row,
            sessionId,
            metabotId: metabot.id,
            externalConversationId,
            fires: 0,
            emitLog,
          });
        }
        markProcessed(db, row.id, saveDb);
      };
      if (isPrivateChatNoReplySentinel(trimmed)) {
        deliverNothingForSilentTurn(
          `Bot chose silence for message ${row.id} (${PRIVATE_CHAT_NO_REPLY_SENTINEL})`
        );
        return;
      }
      // Degenerate echo loop (2026-09-17): the model ignored the sentinel
      // protocol and produced the same silence note the peer keeps sending.
      // Once the conversation tail already holds two identical delivered
      // replies, delivering a third verbatim copy can only perpetuate the
      // loop — suppress it exactly like a sentinel silence.
      if (wouldCreatePrivateChatEchoLoop({
        messages: coworkStore.getRecentPrivateA2AMessages(sessionId, 24),
        replyText: trimmed,
      })) {
        deliverNothingForSilentTurn(
          `Echo-loop guard matched for message ${row.id}: the reply repeats the last delivered outgoing messages verbatim`
        );
        return;
      }
      guidanceTurn.assistantOutputStarted = true;
      releaseInterruptibleA2AGuidanceTurn(guidanceTurn);
    } finally {
      releaseInterruptibleA2AGuidanceTurn(guidanceTurn);
    }

    let assistantMessage: CoworkMessage | null = null;
    if (skillAssistantMessageId) {
      const candidateAssistant = coworkStore.getMessageById(sessionId, skillAssistantMessageId);
      const existingAssistant = candidateAssistant?.type === 'assistant' ? candidateAssistant : null;
      if (existingAssistant) {
        const metadata: CoworkMessageMetadata = {
          ...(existingAssistant.metadata ?? {}),
          sourceChannel: 'metaweb_private',
          externalConversationId,
          direction: 'outgoing',
          privateChatReplyForPinId: normalizePrivateChatPinId(row.pin_id),
          privateChatReplyForTxid: getPrivateChatRowTxid(row),
        };
        coworkStore.updateMessage(sessionId, existingAssistant.id, { metadata });
        existingAssistant.metadata = metadata;
        assistantMessage = existingAssistant;
        if (emitToRenderer) {
          emitToRenderer('cowork:stream:messageUpdate', {
            sessionId,
            messageId: existingAssistant.id,
            metadata,
          });
        }
      }
    }

    if (!assistantMessage) {
      assistantMessage = findRetryablePrivateChatA2AReplyMessage({
        coworkStore,
        sessionId,
        externalConversationId,
        row,
      });
      if (assistantMessage) {
        const metadata: CoworkMessageMetadata = {
          ...(assistantMessage.metadata ?? {}),
          sourceChannel: 'metaweb_private',
          externalConversationId,
          direction: 'outgoing',
          privateChatReplyForPinId: normalizePrivateChatPinId(row.pin_id),
          privateChatReplyForTxid: getPrivateChatRowTxid(row),
        };
        coworkStore.updateMessage(sessionId, assistantMessage.id, { content: trimmed, metadata });
        assistantMessage.content = trimmed;
        assistantMessage.metadata = metadata;
        if (emitToRenderer) {
          emitToRenderer('cowork:stream:messageUpdate', {
            sessionId,
            messageId: assistantMessage.id,
            content: trimmed,
            metadata,
          });
        }
      }
    }

    if (!assistantMessage) {
      assistantMessage = appendPrivateChatA2AMessage({
        coworkStore,
        sessionId,
        externalConversationId,
        type: 'assistant',
        content: trimmed,
        extraMetadata: {
          privateChatReplyForPinId: normalizePrivateChatPinId(row.pin_id),
          privateChatReplyForTxid: getPrivateChatRowTxid(row),
        },
        emitToRenderer,
      });
    }

    try {
      recordMetaIDPrivateA2AExperience({
        store: experienceStore ?? new MetaIDExperienceStore(db, saveDb),
        ownerGlobalMetaID: metabot.globalmetaid,
        peerGlobalMetaID: fromGlobalMetaId,
        externalConversationId,
        sessionId,
        direction: 'outgoing',
        content: trimmed,
        // The chain echo is the durable source row; let its later capture
        // attach the local private_chat_messages id instead of freezing a
        // transient Cowork message UUID into the evidence record.
        messageId: null,
        replyToPinId: row.pin_id,
        sourceMetadata: { replyToPinId: row.pin_id },
      });
    } catch (error) {
      emitLog(
        `[PrivateChat] Assistant experience capture failed for ${fromGlobalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (memoryPolicy.memoryEnabled) {
      try {
        const result = await memoryBackend.applyTurnMemoryUpdates({
          sessionId,
          userText: plaintext,
          assistantText: trimmed,
          implicitEnabled: memoryPolicy.memoryImplicitUpdateEnabled,
          memoryLlmJudgeEnabled: memoryPolicy.memoryLlmJudgeEnabled,
          guardLevel: memoryPolicy.memoryGuardLevel,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
        });
        emitLog(
          `[PrivateChat] Memory updates: total=${result.totalChanges} created=${result.created} updated=${result.updated} deleted=${result.deleted} skipped=${result.skipped}`
        );
      } catch (error) {
        rethrowSqliteWasmBoundsError(error);
        emitLog(`[PrivateChat] Memory update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const encryptedReply = ecdhEncrypt(trimmed, sharedSecretForReply);
    emitLog(`[PrivateChat] Encrypt reply: plaintextLen=${trimmed.length} sharedSecretLen=${sharedSecretForReply.length} encryptedLen=${encryptedReply.length} encryptedPrefix=${encryptedReply.slice(0, 40)}...`);
    const payloadStr = buildPrivateMsgPayload(fromGlobalMetaId, encryptedReply, row.reply_pin ?? '');
    try {
      const sentResult = await withPrivateChatPublishTimeout(
        createSimpleMsgPin(payloadStr),
        PRIVATE_CHAT_REPLY_PIN_PUBLISH_TIMEOUT_MS,
        '[PrivateChat] reply pin publish',
      );
      const chainMetadata = buildPrivateChatA2AChainMetadata({
        txids: sentResult.txids,
        pinId: sentResult.pinId,
      });
      const updatedMetadata: CoworkMessageMetadata = {
        ...(assistantMessage.metadata ?? {}),
        ...chainMetadata,
        privateChatDeliveryStatus: 'sent',
      };
      delete updatedMetadata.privateChatDeliveryError;
      delete updatedMetadata.privateChatDeliveryFailedAt;
      coworkStore.updateMessage(sessionId, assistantMessage.id, { metadata: updatedMetadata });
      assistantMessage.metadata = updatedMetadata;
      if (emitToRenderer) {
        emitToRenderer('cowork:stream:messageUpdate', {
          sessionId,
          messageId: assistantMessage.id,
          metadata: updatedMetadata,
        });
      }
      emitLog(`[PrivateChat] Replied to ${fromGlobalMetaId.slice(0, 12)}…`);
      // A delivered reply (including bye) means the conversation tail is no
      // longer silent — any pending wake for it is obsolete.
      cancelPrivateChatA2AWakesForConversation(externalConversationId, 'a reply was delivered', emitLog);
    } catch (e) {
      rethrowSqliteWasmBoundsError(e);
      const errorMessage = e instanceof Error ? e.message : String(e);
      emitLog(`[PrivateChat] Failed to broadcast reply: ${errorMessage}`);
      const failedMetadata: CoworkMessageMetadata = {
        ...(assistantMessage.metadata ?? {}),
        privateChatDeliveryStatus: 'failed',
        privateChatDeliveryError: errorMessage,
        privateChatDeliveryFailedAt: Date.now(),
      };
      coworkStore.updateMessage(sessionId, assistantMessage.id, { metadata: failedMetadata });
      assistantMessage.metadata = failedMetadata;
      if (emitToRenderer) {
        emitToRenderer('cowork:stream:messageUpdate', {
          sessionId,
          messageId: assistantMessage.id,
          metadata: failedMetadata,
        });
      }
      emitLog(`[PrivateChat] Keeping message ${row.id} unprocessed because reply broadcast failed.`);
      return;
    }

    // If we just said "bye", set the byeSent flag so we ignore future messages from this peer
    if (isByeMessage(trimmed)) {
      const currentMeta = parseConversationMappingMetadata(
        coworkStore.getConversationMapping('metaweb_private', externalConversationId, metabot.id)?.metadataJson
      );
      coworkStore.updateConversationMappingMetadata('metaweb_private', externalConversationId, metabot.id, {
        ...currentMeta,
        byeSent: true,
        endedByAutoPolicy: true,
        endedAt: Date.now(),
      });
      emitLog(`[PrivateChat] Sent "bye" to ${fromGlobalMetaId.slice(0, 12)}…, byeSent flag set.`);
    }
    privateChatSkillTurnRetries.delete(taskKey);
    markProcessed(db, row.id, saveDb);
  } finally {
    thinkingTasks.delete(taskKey);
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** sql.js Database must not be used concurrently; skip overlapping ticks. */
let privateChatPollTickRunning = false;
let privateChatDaemonGeneration = 0;
let privateChatActiveTickPromise: Promise<void> | null = null;
const privateChatDetachedWork = new Set<Promise<void>>();

function trackPrivateChatDetachedWork(work: Promise<void>): void {
  privateChatDetachedWork.add(work);
  void work.finally(() => {
    privateChatDetachedWork.delete(work);
  });
}

export function startPrivateChatDaemon(
  db: Database,
  saveDb: SaveDbFn,
  coworkStore: CoworkStore,
  metabotStore: MetabotStore,
  coworkRunner: CoworkRunner,
  createPin: (metabotStore: MetabotStore, metabot_id: number, payload: MetaidDataPayload, options?: { origin?: string }) => Promise<{ txids: string[]; pinId?: string }>,
  emitLog: (msg: string) => void,
  serviceOrderLifecycle: ServiceOrderLifecycleService | null,
  getSkillsPrompt?: GetSellerOrderSkillsPromptFn,
  emitToRenderer?: (channel: string, data: unknown) => void,
  getListenerConfig?: GetListenerConfigFn,
  resolveLocalServiceOutputType?: ResolveLocalServiceOutputTypeFn,
  resolveLocalServiceExecutionReminder?: ResolveLocalServiceExecutionReminderFn,
  onWasmBoundsError?: () => void,
  getChatSkillsRoutingPrompt?: GetChatSkillsRoutingPromptFn,
  runPrivateChatSkillTurn?: RunPrivateChatSkillTurnFn,
  generatePrivateChatSkillWaitNotice?: GeneratePrivateChatSkillWaitNoticeFn,
  consumeA2AGuidance?: ConsumeA2AGuidanceFn,
  getRecentDailySummaries?: (metabotId: number, limit: number) => Array<{ summaryDate: string; summaryText: string }>,
  refreshA2APeerProfile?: (sessionId: string) => void,
  getMetaIDCognitionPromptBlock?: GetMetaIDCognitionPromptBlockFn,
): void {
  void stopPrivateChatDaemon();
  const daemonGeneration = ++privateChatDaemonGeneration;
  orderCowork = new PrivateChatOrderCowork({
    coworkRunner,
    coworkStore,
    metabotStore,
    emitToRenderer,
    uploadDeliveryArtifact: async (artifact, request) => {
      const { uploadMetaFile } = await import('./metaFileUploadService');
      return uploadMetaFile(metabotStore, {
        metabotId: request.metabotId,
        filePath: String(artifact.filePath || ''),
        contentType: typeof artifact.contentType === 'string' ? artifact.contentType : undefined,
        network: 'mvc',
      });
    },
    verifyDeliveryArtifactUpload,
    consumeA2AGuidance,
  });
  const experienceStore = new MetaIDExperienceStore(db, saveDb);
  const performChat = performChatCompletionForOrchestrator;
  // Older harnesses inject a minimal runner stub; only real CoworkRunner
  // instances expose isSessionActive.
  const isSessionTurnActive = typeof (coworkRunner as Partial<CoworkRunner> | undefined)?.isSessionActive === 'function'
    ? (sessionId: string) => coworkRunner.isSessionActive(sessionId)
    : undefined;
  const runPollTick = async (): Promise<void> => {
    if (daemonGeneration !== privateChatDaemonGeneration) return;
    if (privateChatPollTickRunning) return;
    privateChatPollTickRunning = true;
    const runActiveTickWork = async (): Promise<void> => {
      try {
        // Fire due wakes first: a fired wake resets its row to unprocessed so
        // the query below re-drives it in this same tick. The returned
        // dispositions ride along with those rows into processOne.
        const reDrivenWakeDispositions = fireDuePrivateChatA2AWakes({
          db,
          saveDb,
          coworkStore,
          emitLog,
          emitToRenderer,
        });
        let rows: PrivateChatMessageRow[];
        try {
          rows = parsePrivateChatRows(db);
        } catch (e) {
          console.error('[PrivateChat] parsePrivateChatRows error:', e);
          if (isSqliteWasmBoundsError(e)) {
            void stopPrivateChatDaemon();
            onWasmBoundsError?.();
          }
          return;
        }
        for (const row of rows) {
          if (daemonGeneration !== privateChatDaemonGeneration) {
            return;
          }
          try {
            await processOne(
              row,
              db,
              saveDb,
              coworkStore,
              metabotStore,
              createPin,
              performChat,
              emitLog,
              orderCowork,
              serviceOrderLifecycle,
              getSkillsPrompt,
              emitToRenderer,
              getListenerConfig,
              resolveLocalServiceOutputType,
              resolveLocalServiceExecutionReminder,
              onWasmBoundsError,
              getChatSkillsRoutingPrompt,
              runPrivateChatSkillTurn,
              generatePrivateChatSkillWaitNotice,
              consumeA2AGuidance,
              getRecentDailySummaries,
              refreshA2APeerProfile,
              experienceStore,
              getMetaIDCognitionPromptBlock,
              isSessionTurnActive,
              reDrivenWakeDispositions.get(row.id),
            );
          } catch (e) {
            console.error('[PrivateChat] processOne error:', e);
            if (isSqliteWasmBoundsError(e)) {
              void stopPrivateChatDaemon();
              onWasmBoundsError?.();
              return;
            }
          }
        }
      } finally {
        if (daemonGeneration === privateChatDaemonGeneration) {
          privateChatPollTickRunning = false;
        }
        if (privateChatActiveTickPromise === activeTick) {
          privateChatActiveTickPromise = null;
        }
      }
    };
    const activeTick = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        runActiveTickWork().then(resolve, reject);
      });
    });
    privateChatActiveTickPromise = activeTick;
    await activeTick;
  };
  pollTimer = setInterval(() => {
    void runPollTick();
  }, POLL_INTERVAL_MS);
  void runPollTick();
  emitLog('[PrivateChat] Daemon started.');
}

export async function stopPrivateChatDaemon(options?: { waitForTick?: boolean }): Promise<void> {
  privateChatDaemonGeneration += 1;
  const activeTickPromise = privateChatActiveTickPromise;
  const detachedWork = [...privateChatDetachedWork];
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  privateChatPollTickRunning = false;
  orderCowork?.dispose();
  orderCowork = null;
  thinkingTasks.clear();
  privateChatSkillTurnRetries.clear();
  privateChatBusyDeferredSince.clear();
  privateChatA2AWakes.clear();
  privateChatDecryptFailedIds.clear();
  if (options?.waitForTick) {
    await activeTickPromise?.catch(() => undefined);
    await Promise.allSettled(detachedWork);
  }
}
