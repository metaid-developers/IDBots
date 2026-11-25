/**
 * Persistent App/Game Runtime (docs/14 §2, §5, §6, §7).
 *
 * Game-agnostic: each game is a sandboxed `adapter.js`. The Runtime owns
 * Session lifecycle, message intake (reusing the existing group-chat socket +
 * history backfill), the action loop, idempotent chain writes, lease/fencing,
 * and recovery on host restart. MetaApp close does not stop a Session.
 *
 * Injected deps keep the Runtime testable and decoupled from Electron:
 *  - messageStore: reads group_chat_messages rows since a cursor
 *  - llmComplete: chatCompletionWithTools (same stack as Cowork/bridge)
 *  - chainWrite: group-chat write (owner identity signs; seat claims pass
 *    `asAgentId` so the transport signs them as the session agent's bot)
 *  - manifestFetch: loads + JSON-parses a GameManifest
 *  - adapterPathFor: resolves a local adapter.js path from manifestUri
 */

import { EventEmitter } from 'events';
import { createHash, randomUUID } from 'crypto';
import { loadAdapterSandbox, AdapterError, type AdapterSandbox } from './adapterSandbox';
import { AgentGameSessionStore, type WriteLogKey } from './sessionStore';
import { LeaseRegistry, LEASE_HEARTBEAT_INTERVAL_MS } from './leaseRegistry';
import { buildMovePrompt } from './llmStrategy';
import {
  isActionEvent,
  toSessionView,
  type ActionEvent,
  type GameEvent,
  type GameManifest,
  type GameSession,
  type SeatClaimedEvent,
  type SessionBudget,
  type SessionConsent,
  type SessionError,
  type SessionErrorCode,
  type SessionStartParams,
  type SessionStatus,
  type SessionView,
  type TimeoutClaimedEvent,
} from './abi';
import type { ChatCompletionResult } from '../services/cognitiveChatCompletion';

/* ------------------------------------------------------------------ */
/* Injected dependencies                                              */
/* ------------------------------------------------------------------ */

/** A decrypted group-chat message row relevant to a session. */
export interface SessionMessage {
  /** Group message index (cursor). */
  msgIndex: number | null;
  content: string;
  senderGlobalMetaId: string | null;
  /** Chain timestamp of the message (docs/07 §2 event metadata): Unix SECONDS
   *  (10 digits) — it is `group_chat_messages.chain_timestamp` as the indexer
   *  writes it (metaWebListenerService.ts; seconds are the chain's own unit,
   *  see coworkStore.ts). It is normalized to milliseconds at the single
   *  conversion point in withRowMeta below. */
  chainTimestamp: number | null;
  pinId: string;
}

/** docs/07 §2: the group message's `index`, `senderMetaId`, `timestamp` are
 *  event metadata — conveyed alongside the envelope, never inside the body.
 *  UNIT CONTRACT: `timestamp` is Unix MILLISECONDS since epoch on BOTH lanes —
 *  the chain-row lane is normalized by toEventMetaMs() (seconds → ms) and own
 *  writes are stamped with this.now() (already ms). Adapters compare it against
 *  ms constants, so feeding one lane seconds is what made a writer and a reader
 *  reach opposite timeout verdicts on the same pin. A legacy caller handing in
 *  seconds is still tolerated by magnitude (|v| < 1e11 ⇒ seconds), the same
 *  rule the third-party replayer uses.
 *  NOTE: every event payload body also carries a `timestamp` (Date.now(), ms —
 *  groupChatTransport). Event metadata always means THIS row timestamp, never
 *  the body one; mixing them is the second unit drift of the same defect. */
export interface EventMeta {
  index?: number;
  senderMetaId?: string;
  timestamp?: number;
}

export type MetaStampedEvent = GameEvent & { meta?: EventMeta };

/** Internal write-log slot for non-action events: protocol `actionSeq` starts
 *  at 1 (docs/07 §2), so 0 never collides with a real action. */
const NON_ACTION_LEDGER_SEQ = 0;

export interface RuntimeDeps {
  store: AgentGameSessionStore;
  /** Read group-chat messages for a group strictly after the given msg_index. */
  messageStore: {
    readSince(groupId: string, afterMsgIndex: number): SessionMessage[];
  };
  /** One-shot LLM call (chatCompletionWithTools). Throws on abort/timeout.
   *  `opts.signal` (GAP-4): the runtime's own move-window abort — a wired
   *  implementation must cancel the underlying request when it fires, so the
   *  2-minute contract holds even if the wiring drops `timeoutMs`. */
  llmComplete: (messages: import('../services/cognitiveChatCompletion').ChatMessage[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<ChatCompletionResult>;
  /**
   * Write an encrypted agent-game/1 event to the group (returns pinId).
   * `opts.asAgentId`: sign as this session agent's local bot identity instead
   * of the host owner — seat claims are attributed by the chain message's
   * `senderMetaId` (docs/07 §3), so identity writes MUST come from the agent.
   */
  chainWrite: (groupId: string, plaintext: string, opts?: { asAgentId?: string }) => Promise<{ pinId: string }>;
  /** Fetch + parse a GameManifest from its URI. */
  manifestFetch: (manifestUri: string) => Promise<GameManifest>;
  /** Resolve a local filesystem path for the adapter module from manifestUri. */
  adapterPathFor: (manifestUri: string, manifest: GameManifest) => Promise<string>;
  /** Resolve a display name for the session agent (seat.claimed payload); optional. */
  agentNameFor?: (agentId: string) => string;
  /**
   * Ensure the session agent is a member of the game group before the runtime
   * writes anything on-chain (docs/03 入座前置, lost in the APP-2 migration):
   * the chat-api server diverts group writes from non-members — they never
   * enter the group history index nor the WS fanout, so no client (page,
   * host catch-up, third-party replay) ever sees them (room 924-2 root cause).
   * Best-effort per call site; `chargedWrite` marks an actual join pin so the
   * session budget stays truthful. By contract it must not throw.
   */
  ensureAgentGroupMember?: (
    agentId: string,
    groupId: string,
  ) => Promise<{ joined: boolean; chargedWrite?: boolean }>;
  /** Clock injection (tests). */
  now?: () => number;
  /** Log sink. */
  log?: (msg: string) => void;
}

export interface RuntimeEvents {
  sessionUpdated: (session: GameSession) => void;
  consentRequired: (requestId: string, params: SessionStartParams, manifest: GameManifest) => void;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                           */
/* ------------------------------------------------------------------ */

const LLM_CALL_TIMEOUT_MS = 120_000;
const LLM_MAX_PARSE_ATTEMPTS = 3;
/** Backoff schedule (ms) for failed writes / LLM calls — bounded, no quota burst. */
const WRITE_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000];
const ACTION_LOOP_DEBOUNCE_MS = 500;
/**
 * GAP-4 move window for timeout.claimed (architecture decision ②'s fault
 * criterion, game-side twin): adapters judge a claim from CHAIN timestamps
 * with a 900s per-move window (xiangqi MOVE_TIMEOUT_MS) — the runtime only
 * decides WHEN to spend a pin on the claim, the adapter's reduce stays the
 * judge. A premature claim reduces to a no-op there but still costs a pin,
 * so the trigger waits out the full window plus a margin.
 */
const MOVE_TIMEOUT_MS = 900_000;
/** Safety margin over the adapter window so chain-timestamp skew and write
 *  latency can never make the claim land inside the still-open window. */
const MOVE_CLAIM_MARGIN_MS = 60_000;
/** How often the move-window sweeper checks for expired move-LLM windows.
 *  The tick is real-time but the expiry decision uses this.now(), so tests
 *  drive it with the virtual clock. */
const LLM_WINDOW_SWEEP_INTERVAL_MS = 1_000;

/* ------------------------------------------------------------------ */
/* Runtime                                                            */
/* ------------------------------------------------------------------ */

export class AgentGameRuntime extends EventEmitter {
  private leases = new LeaseRegistry();
  /** sessionId -> active sandbox. */
  private sandboxes = new Map<string, AdapterSandbox>();
  /** In-memory working state (canonical source = store; this is the hot copy). */
  private states = new Map<string, unknown>();
  /** Sessions currently inside the action loop (re-entry guard). */
  private busy = new Set<string>();
  /** Per-session serialization of async work (see withSessionLock): the action
   *  loop, the catch-up behind onGroupMessage, resume and recover all mutate
   *  one session's working state, and no two of them may interleave. */
  private readonly sessionTails = new Map<string, Promise<void>>();
  /** Pending (in-flight) write per session for retry/dedup. */
  private pending = new Map<string, { event: GameEvent; key: WriteLogKey }>();
  /** GAP-4: wall-clock anchor of the last ACCEPTED game progress per session
   *  (accepted = the adapter changed its serialized state — the same notion
   *  the adapter's own lastProgressTs tracks, approximated on the host). */
  private lastProgressAt = new Map<string, number>();
  /** GAP-4: wall-clock time of the last timeout.claimed we queued. B1: this
   *  is a per-window THROTTLE, not an epoch lock — a rejected claim (the
   *  adapter judged the window still open) may be retried after each full
   *  MOVE_TIMEOUT_MS + MOVE_CLAIM_MARGIN_MS has elapsed, because chain/host
   *  drift beyond the margin can keep a genuinely-expired window reading as
   *  open; re-claiming INSIDE the window would burn pins on a verdict that
   *  cannot have changed. */
  private lastClaimAt = new Map<string, number>();
  /**
   * GAP-4: in-flight move-LLM windows (one per session — the busy guard keeps
   * calls single-flight). The runtime OWNS architecture decision ②'s 2-minute
   * fault window instead of trusting the llmComplete wiring to pass timeoutMs
   * down: the 2026-09-25 production asar shipped exactly that wiring drop
   * (`llmComplete: (messages) => …` with no attemptTimeoutMs) and every
   * attempt hung until undici's default 300s headers timeout — the contract
   * existed at both ends of the pipe and died at its only joint. Each window
   * holds an AbortController (wired implementations cancel the underlying
   * request when it fires) and a race rejector (unwired/hung callees are cut
   * anyway), so the fault exit is enforced at the contract owner.
   */
  private llmWindows = new Map<string, { deadline: number; ac: AbortController; reject: (err: Error) => void }>();
  private llmWindowTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private deps: RuntimeDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  private log(msg: string): void {
    this.deps.log?.(`[agent-game] ${msg}`);
  }

  /* ----------------------- lifecycle ----------------------- */

  /** Start background housekeeping (lease heartbeat + loop tick + move-window sweep). */
  startBackground(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.housekeeping(), LEASE_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    this.ensureLlmWindowTimer();
    this.scheduleLoop(0);
  }

  /** The move-window sweeper starts with the background loop, but a window
   *  must never go unswept just because startBackground wasn't reached yet —
   *  lazily arm it on first in-flight window too. */
  private ensureLlmWindowTimer(): void {
    if (this.llmWindowTimer || this.disposed) return;
    this.llmWindowTimer = setInterval(() => this.sweepLlmWindows(), LLM_WINDOW_SWEEP_INTERVAL_MS);
    this.llmWindowTimer.unref?.();
  }

  /** Recover unfinished sessions after host restart (docs/14 §5). */
  async recover(): Promise<void> {
    const sessions = this.deps.store.listRecoverableSessions();
    this.log(`recovering ${sessions.length} unfinished session(s)`);
    for (const s of sessions) {
      // Re-verify grant: not revoked / expired / depleted.
      if (this.isExpiredOrDepleted(s)) {
        this.markStatus(
          s.sessionId,
          'paused',
          mkError(s.expiresAt <= this.now() ? 'rate_limited' : 'budget_exhausted', 'authorization expired or budget depleted on recovery', this.now),
        );
        continue;
      }
      try {
        // Same membership guarantee as start(): a session that recovered
        // before its join pin settled (or whose agent was kicked) would
        // otherwise write into the void again.
        await this.ensureGroupMembership(s);
        await this.ensureSandbox(s);
        await this.withSessionLock(s.sessionId, () => this.catchUp(s.sessionId));
        // Re-acquire lease (fresh id) — conflict stays paused.
        const res = this.leases.acquire(s.groupId, s.seat, s.sessionId);
        if (!res.acquired) {
          this.markStatus(
            s.sessionId,
            'paused',
            mkError('session_conflict', `lease held by ${res.conflictSessionId} on recovery`, this.now),
          );
        } else {
          this.persistLease(s.sessionId, res.lease!);
          this.markStatus(s.sessionId, s.status === 'paused' ? 'paused' : 'running', null);
        }
      } catch (err) {
        // GAP-5: preserve structured codes (e.g. state_corrupt surfaced by
        // library hydration) instead of flattening every recovery failure to
        // adapter_error — the code is what operators page on.
        this.markStatus(s.sessionId, 'paused', mkError(errorCodeOf(err) ?? 'adapter_error', errMsg(err), this.now));
      }
    }
    this.scheduleLoop(0);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.llmWindowTimer) clearInterval(this.llmWindowTimer);
    this.heartbeatTimer = null;
    this.loopTimer = null;
    this.llmWindowTimer = null;
    // Release every in-flight move window: hung llmComplete promises die with
    // the process, but the abort must still reach wired transports.
    for (const [sessionId, w] of this.llmWindows) {
      this.llmWindows.delete(sessionId);
      w.ac.abort();
    }
    for (const sb of this.sandboxes.values()) {
      await sb.dispose().catch(() => {});
    }
    this.sandboxes.clear();
  }

  private housekeeping(): void {
    this.leases.sweep();
    // Renew live leases for running sessions.
    for (const s of this.deps.store.listRecoverableSessions()) {
      if (s.status === 'running' && this.leases.isHolder(s.groupId, s.seat, s.sessionId)) {
        this.leases.renew(s.groupId, s.seat, s.sessionId);
        const peek = this.leases.peek(s.groupId, s.seat);
        if (peek) this.persistLease(s.sessionId, peek);
      }
    }
  }

  /* ----------------------- intake ----------------------- */

  /**
   * Notify the runtime that one or more groups received new messages. Called
   * from the existing group-chat ingest path (socket push + backfill). No-op
   * when no session exists for the group — zero regression to normal chat.
   */
  onGroupMessage(groupId: string): void {
    const sessions = this.deps.store.listRecoverableSessions().filter((s) => s.groupId === groupId);
    if (sessions.length === 0) return;
    for (const s of sessions) {
      void this.withSessionLock(s.sessionId, async () => {
        // Re-read under the lock: the session may have been stopped while this
        // catch-up waited behind a running turn.
        const current = this.deps.store.getSession(s.sessionId);
        if (!current || current.status === 'stopped' || current.status === 'finished') return null;
        return this.catchUp(s.sessionId);
      })
        .then(() => this.scheduleLoop(0))
        .catch((err) => {
          // GAP-5: catchUp can now surface persisted-state corruption
          // (state_corrupt). Park the session instead of leaving an
          // unhandled rejection that silently wedges the game.
          this.markStatus(s.sessionId, 'paused', mkError(errorCodeOf(err) ?? 'adapter_error', errMsg(err), this.now));
        });
    }
  }

  /* ----------------------- catch-up ----------------------- */

  /**
   * Replay messages since the session cursor and advance state.
   * Returns the fresh session record it mutated (callers that persist
   * afterwards must use it — persisting a pre-catch-up copy rolls back
   * lastIndex / lastActionSeq and re-triggers the GAP-3b wedge).
   *
   * GAP-5 family (cursor/state decoupling): the cursor may only advance over
   * messages the state actually reduced. Without a sandbox there is nothing
   * to reduce with — consumption is deferred (a group message waking the
   * session before recover() must not burn the cursor). On the hydration
   * path (no in-memory state) the state is rebuilt by full replay of the
   * group history — exactly what a third-party client does — and the stored
   * blob is only a cross-check: a library blob that is missing, stale, or
   * the bare initial board while the cursor has consumed the full history
   * (the G2 black-seat wedge: "initial board + idx=19") heals to the
   * chain-replayed truth. A blob that cannot PARSE is library corruption →
   * state_corrupt, park (existing GAP-5 contract, untouched).
   */
  private async catchUp(sessionId: string): Promise<GameSession | null> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) return null;
    const sandbox = this.sandboxes.get(sessionId);
    let state = this.states.get(sessionId);
    if (state === undefined && !sandbox) {
      // Nothing to reduce with — defer consumption until recover/resume has
      // both the sandbox and a state. Advancing the cursor here is what
      // created the decoupling wedge.
      return s;
    }
    let heal = false;
    let storedState: unknown;
    if (state === undefined) {
      const stored = this.deps.store.getSerializedState(sessionId);
      if (stored) storedState = parseStoredState(sessionId, stored); // throws state_corrupt
      // Full-replay self-heal: rebuild from the initial board over the whole
      // group history (chain truth). The stored blob (if parseable) is
      // cross-checked afterwards; it never wins.
      state = await sandbox!.initialState({ gameId: s.gameId, seat: s.seat });
      heal = true;
      // GAP-3b: the expected-next-seq cursor is recomputed from the replay
      // (a stale-high stored value would bake seq-skips into our next write).
      s.lastActionSeq = 0;
      this.log(`${sessionId}: state hydration — full-replay self-heal of group history (stored cursor ${s.lastIndex})`);
    }
    const after = heal ? -1 : (s.lastIndex < 0 ? -1 : s.lastIndex);
    const messages = this.deps.messageStore.readSince(s.groupId, after);
    if (messages.length === 0 && !heal) return s;
    let cursor = s.lastIndex;
    for (const msg of messages) {
      // Advance cursor for every consumed message (agent-game or not). Non-agent
      // messages are preserved by the backend but ignored here.
      const idx = msg.msgIndex ?? -1;
      if (idx >= 0) cursor = Math.max(cursor, idx);
      const env = this.tryParseEnvelope(msg.content);
      if (!env || env.protocol !== 'agent-game/1' || env.gameId !== s.gameId || env.rulesHash !== s.rulesHash) {
        continue;
      }
      // A landed event clears its own pending retry (action or seat.claimed).
      const pending = this.pending.get(sessionId);
      if (pending && pending.key.eventId === env.eventId) {
        this.pending.delete(sessionId);
      }
      if (sandbox && state !== undefined) {
        // Canonical form BEFORE the reduce: adapters may mutate and return the
        // same object, so the change signal must be captured pre-call.
        let beforeSerialized: string | null = null;
        try {
          beforeSerialized = await sandbox.serializeState(state);
        } catch {
          beforeSerialized = null;
        }
        let reduced: unknown;
        let reduceFailed = false;
        try {
          // reduce accepts the decrypted, ordered game event. docs/07 §2: the
          // row's index / senderMetaId / timestamp ARE the event metadata —
          // attached here so adapter attribution (senderSeat) replays exactly
          // like the page/third-party clients. Values come from the message
          // row itself; nothing is synthesized.
          reduced = await sandbox.reduce(state, withRowMeta(env as MetaStampedEvent, msg));
        } catch (err) {
          this.log(`${sessionId}: reduce failed for ${env.eventId}: ${errMsg(err)}`);
          reduceFailed = true;
        }
        if (!reduceFailed) {
          // Change detection covers EVERY accepted event, not just actions:
          // GAP-4's timeout.claimed trigger keys off "the game last progressed
          // here", and a seat claim (waiting→playing) or a finished match are
          // progress too. serializeState is the ABI-canonical form, so an
          // adapter-accepted event always changes it while rejected ones
          // (out-of-turn / illegal / seq-skip / dedup replay) leave it
          // identical.
          let afterSerialized: string | null = null;
          try {
            afterSerialized = await sandbox.serializeState(reduced);
          } catch {
            afterSerialized = null;
          }
          // B2 (conservative by design, no behavior change): when either
          // serializeState call fails (null) the acceptance inference below
          // cannot run, so the progress re-anchor and the lastActionSeq
          // advance are skipped — the reduced state itself still lands.
          // lastActionSeq is the expected-next-seq cursor: advancing it on an
          // UNCONFIRMED acceptance would bake a seq-skip into our next write
          // and permanently wedge third-party replay (the GAP-3b wedge), while
          // a skipped advance only delays our own next move. Thorough fix is
          // an adapter ABI change — reduce() returning an explicit accept
          // signal instead of inferring acceptance from serialized-state
          // change; until that lands, the conservative skip stays.
          if (
            beforeSerialized !== null &&
            afterSerialized !== null &&
            afterSerialized !== beforeSerialized
          ) {
            this.lastProgressAt.set(sessionId, this.now());
            if (isActionEvent(env as GameEvent)) {
              // GAP-3b: lastActionSeq is the expected-next-seq cursor and must
              // advance only across actions the adapter ACCEPTED (move applied).
              // Counting rejected events desynced our expectation from the
              // converged third-party view and permanently wedged replay
              // (924-2: black lastActionSeq=12 while the stream converges at
              // plies=1).
              const ae = env as ActionEvent;
              if (ae.actionSeq > s.lastActionSeq) {
                s.lastActionSeq = ae.actionSeq;
              }
            }
          }
          state = reduced;
        }
      }
    }
    if (state !== undefined) {
      this.states.set(sessionId, state);
    }
    if (heal && storedState !== undefined && sandbox) {
      // Divergence cross-check: a stored state that disagrees with the chain
      // replay was the wedge (stale, bare-initial, partially reduced) — the
      // replay already won; leave an auditable trace instead of healing
      // silently (the G2 black-seat wedge had "no audit, no logs").
      try {
        const storedCanonical = await sandbox.serializeState(storedState);
        const replayCanonical = await sandbox.serializeState(state);
        if (storedCanonical !== replayCanonical) {
          this.deps.store.audit('state-heal', sessionId, s.agentId, {
            reason: 'stored-diverges-from-replay',
            storedCursor: s.lastIndex,
          });
          this.log(`${sessionId}: state-heal — stored state diverged from full replay and was replaced (audited)`);
        }
      } catch {
        // cross-check only — never blocks the heal
      }
    }
    s.lastIndex = cursor;
    this.persistOwnedFields(s, state);
    return s;
  }

  /**
   * Persist only the fields this runtime path OWNS (cursor, expected seq,
   * budget, game state) onto a FRESH read of the session record. A stale
   * in-flight record must never revert a concurrent markStatus: a pause
   * landing while a catch-up was awaiting was silently resurrected to
   * running/null by the catch-up's whole-row persist (the runtime-window cut
   * lost to a racing catch-up; the same ghost produced the "paused → running
   * again with no resume" flashes in the 2026-09-25 G2 forensics).
   */
  private persistOwnedFields(s: GameSession, state: unknown): void {
    const fresh = this.deps.store.getSession(s.sessionId) ?? s;
    fresh.lastIndex = s.lastIndex;
    fresh.lastActionSeq = s.lastActionSeq;
    // Budget merge is DIRECTIONAL. budget.llmCallsUsed / writesUsed are
    // cumulative SPEND counters (incremented in place at the LLM call site
    // and the write-commit site, never reset while the session lives), so
    // under a concurrent interleave the truthful value is the MAX of the two
    // snapshots: a whole-value assignment from the stale in-flight snapshot
    // rolled spend back past a concurrent writer's charge and could push a
    // depleted session past its cap (isExpiredOrDepleted inputs must be
    // monotonic). If a budget field were ever a REMAINING BALANCE, the
    // direction flips to min — do not copy this merge onto balance-shaped
    // fields. The caps (llmCalls / writes) are create-time constants; the
    // fresh row's copy stays canonical.
    fresh.budget = {
      ...fresh.budget,
      llmCallsUsed: Math.max(fresh.budget.llmCallsUsed, s.budget.llmCallsUsed),
      writesUsed: Math.max(fresh.budget.writesUsed, s.budget.writesUsed),
    };
    this.persist(fresh, state);
  }

  /* ----------------------- action loop ----------------------- */

  private scheduleLoop(delayMs = ACTION_LOOP_DEBOUNCE_MS): void {
    if (this.disposed) return;
    if (this.loopTimer) return; // already scheduled
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      void this.runLoopOnce().finally(() => {
        if (!this.disposed && !this.loopTimer) this.scheduleLoop();
      });
    }, delayMs);
    this.loopTimer.unref?.();
  }

  private async runLoopOnce(): Promise<void> {
    const sessions = this.deps.store.listRecoverableSessions().filter((s) => s.status === 'running');
    for (const s of sessions) {
      if (this.busy.has(s.sessionId)) continue;
      void this.processSession(s.sessionId);
    }
  }

  private async processSession(sessionId: string): Promise<void> {
    if (this.busy.has(sessionId)) return;
    const s = this.deps.store.getSession(sessionId);
    if (!s || s.status !== 'running') return;
    if (!this.leases.isHolder(s.groupId, s.seat, s.sessionId)) {
      this.markStatus(sessionId, 'paused', mkError('session_conflict', 'lease lost', this.now));
      return;
    }
    if (this.isExpiredOrDepleted(s)) {
      this.markStatus(sessionId, 'paused', mkError('budget_exhausted', 'budget depleted or authorization expired', this.now));
      return;
    }
    if (!this.sandboxes.has(sessionId)) return;
    this.busy.add(sessionId);
    try {
      await this.withSessionLock(sessionId, () => this.runTurn(sessionId));
    } catch (err) {
      if (err instanceof AdapterError) {
        this.markStatus(sessionId, 'paused', mkError(err.code, err.message, this.now));
      } else {
        this.markStatus(sessionId, 'error', mkError(err.code, errMsg(err), this.now));
      }
    } finally {
      this.busy.delete(sessionId);
    }
  }

  /**
   * One action-loop pass. Runs under the session lock, so the catch-up behind
   * onGroupMessage and any other pass of this session cannot interleave with
   * it; errors propagate to processSession's classification.
   */
  private async runTurn(sessionId: string): Promise<void> {
    // Re-read under the lock: a catch-up, a pause or a stop may have landed
    // while this pass waited for the lock.
    const s = this.deps.store.getSession(sessionId);
    if (!s || s.status !== 'running' || this.disposed) return;
    const sandbox = this.sandboxes.get(sessionId);
    if (!sandbox) return;
    const state = this.states.get(sessionId);
    if (state === undefined) return;
    // First: retry any pending write.
    if (this.pending.has(sessionId)) {
      await this.retryPendingWrite(s);
      return;
    }
    const turn = await sandbox.getTurn(state);
    if (turn.phase === 'finished') {
      await this.finish(s);
      return;
    }
    if (turn.phase !== 'playing' || turn.seat !== s.seat) {
      // GAP-4: while we WAIT for the mover, watch the move window — a stalled
      // opponent must be claimable without human resume (S1 legal endgame).
      this.considerTimeoutClaim(s, turn);
      return;
    }

    // Generate a candidate action via the host LLM (≤ N parse attempts).
    const observation = await sandbox.getObservation(state, s.seat);
    const schema = await sandbox.getActionSchema(state, s.seat);
    let action: unknown = null;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= LLM_MAX_PARSE_ATTEMPTS; attempt++) {
      let text: string;
      try {
        const result = await this.completeMoveInWindow(sessionId, buildMovePrompt({
          gameId: s.gameId, seat: s.seat, observation, schema, lastError,
        }));
        text = result.content?.trim() ?? '';
      } catch (err) {
        // stop() settles the window with a named error: the session is
        // already stopped (lease released, sandbox disposed) — return
        // without any status write, or a late stop-settlement would
        // resurrect the terminal session as paused/llm_*.
        if ((err as { name?: string } | null)?.name === 'SessionStoppedError') {
          this.log(`${sessionId}: move-LLM call interrupted by stop (no status change)`);
          return;
        }
        // GAP-4: session-correlated failure line — operators must be able to
        // tell WHICH seat stalled with which classification from the host
        // log alone (the 2026-09-25 G2 red-seat forensics had neither seat
        // nor cause in ~50 bare "fetch failed" lines).
        const code = isAbort(err) ? 'llm_timeout' : 'llm_unavailable';
        this.log(`${sessionId}: move-LLM failed (${code}, seat ${s.seat}, attempt ${attempt}/${LLM_MAX_PARSE_ATTEMPTS}): ${errMsg(err)}`);
        this.markStatus(sessionId, 'paused', mkError(code, errMsg(err), this.now));
        return;
      }
      s.budget.llmCallsUsed++;
      const parsed = await sandbox.parseAction(text, { schema, observation, seat: s.seat });
      if (!parsed.error) {
        action = parsed.action;
        break;
      }
      lastError = parsed.error;
    }
    if (action === null) {
      this.markStatus(sessionId, 'paused', mkError('llm_unavailable', 'LLM produced no valid action after retries', this.now));
      return;
    }
    const validated = await sandbox.validateAction(state, action, { schema, observation, seat: s.seat });
    if (!validated.valid) {
      this.log(`${sessionId}: action rejected by adapter (${validated.code})`);
      return; // not fatal — try again next tick
    }

    // State hashing via draft reduce clone (deterministic).
    const prevStateHash = this.hashOf(await sandbox.serializeState(state));
    const draft = structuredClone(state);
    const actionSeq = s.lastActionSeq + 1;
    const draftEvent = this.draftEnvelope(s, actionSeq, prevStateHash, validated.normalizedAction ?? action);
    // GAP-3a: the pre-write draft reduce must attribute exactly like the
    // landed row will (the transport signs as the session agent, so the
    // chain row's senderMetaId == s.agentId). A meta-less draft reduce can't
    // map the action to our seat, no-ops, and bakes stateHash ==
    // prevStateHash into the event — every third-party replay then rejects
    // it and the mover regenerates the same move forever (924-2 组B/C:
    // 红 h2e2×2 / 黑 h9g7×9). The meta stays LOCAL: docs/07 §2 keeps
    // identity in row metadata, never in the chain body (chainWrite sends
    // the meta-free `event` below).
    const attributedDraft = withOwnMeta(draftEvent as MetaStampedEvent, s.agentId, this.now());
    const reducedDraft = await sandbox.reduce(draft, attributedDraft);
    const stateHash = this.hashOf(await sandbox.serializeState(reducedDraft));

    const event: ActionEvent = {
      ...draftEvent,
      stateHash,
    };
    const key: WriteLogKey = { groupId: s.groupId, actionSeq, eventId: event.eventId };
    // Record intent BEFORE write (idempotency ledger).
    this.deps.store.recordWriteIntent(key, sessionId);
    this.deps.store.audit('action-write', sessionId, s.agentId, { actionSeq, eventId: event.eventId });
    this.pending.set(sessionId, { event, key });
    await this.retryPendingWrite(s);
  }

  /**
   * Serialize per-session async work.
   *
   * The failure this closes: the action loop's write finalize and the
   * onGroupMessage catch-up both read `this.states` before an await and wrote
   * it back after, with nothing mutual about it. A group message that landed
   * between a write's `committed` and its post-write state update was applied
   * by the catch-up and then overwritten by the finalize, which reduced into
   * the state it had captured before the message: the event was gone from the
   * working state (and the finalize's stale snapshot rolled the cursor back
   * with it), so the game waited for a move it had already consumed. In
   * production that is a lost opponent move; in tests it was the Windows-only
   * agent-game flake that four rounds of wider waitFor budgets never fixed
   * (v1.1.3, 2026-11-25) — the budget was never the problem, the pass simply
   * never ran again.
   *
   * Every flow that mutates a session's state runs through here; catchUp
   * itself does not, so a locked flow can call it.
   */
  private withSessionLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.sessionTails.get(sessionId) ?? Promise.resolve()).then(work);
    // The tail never rejects: one flow's failure must not poison the next.
    const tail: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
    });
    return run;
  }

  /**
   * GAP-4: one move-LLM call under the runtime-owned window. Two independent
   * cut paths fire at the contract deadline (LLM_CALL_TIMEOUT_MS): the
   * AbortController aborts (wired implementations cancel the underlying
   * request — the socket dies instead of farming the keep-alive pool), and
   * the race rejector surfaces a BrowserLlmTimeout error (unwired callees
   * that ignore both timeoutMs and signal are cut anyway). The sweeper is a
   * real-time tick judging expiry by this.now(), so the virtual clock drives
   * it in tests.
   */
  private completeMoveInWindow(sessionId: string, messages: import('../services/cognitiveChatCompletion').ChatMessage[]): Promise<ChatCompletionResult> {
    const ac = new AbortController();
    this.ensureLlmWindowTimer();
    return new Promise<ChatCompletionResult>((resolve, reject) => {
      const entry = { deadline: this.now() + LLM_CALL_TIMEOUT_MS, ac, reject };
      this.llmWindows.set(sessionId, entry);
      this.deps.llmComplete(messages, { timeoutMs: LLM_CALL_TIMEOUT_MS, signal: ac.signal }).then(
        (result) => {
          // Generational check: only a settlement of the window THIS call
          // created may remove it. A stale callee settling late (a hung call
          // already cut by the sweeper, with the session resumed and a fresh
          // window registered) must not detach the new window — that would
          // leave the new call unenforced forever (GAP-4 recurrence path).
          if (this.llmWindows.get(sessionId) === entry) this.llmWindows.delete(sessionId);
          resolve(result);
        },
        (err) => {
          if (this.llmWindows.get(sessionId) === entry) this.llmWindows.delete(sessionId);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Cut every expired move-LLM window: abort the transport, reject the race,
   *  drop the entry (a late callee settlement becomes a no-op). */
  private sweepLlmWindows(): void {
    if (this.disposed) return;
    for (const [sessionId, w] of this.llmWindows) {
      if (this.now() < w.deadline) continue;
      this.llmWindows.delete(sessionId);
      const err = new Error(`move-LLM window of ${LLM_CALL_TIMEOUT_MS}ms exceeded (runtime-enforced, architecture decision ②)`);
      err.name = 'BrowserLlmTimeout'; // isAbort() → session paused as llm_timeout
      w.ac.abort(err);
      w.reject(err);
      this.log(`${sessionId}: move-LLM window enforced at ${LLM_CALL_TIMEOUT_MS}ms (runtime-owned abort)`);
    }
  }

  /**
   * GAP-4: the waiting seat automates timeout.claimed. The ADAPTER stays the
   * judge — its reduce re-checks the 900s window from chain timestamps and
   * finishes the match with the stalled seat losing; a premature claim reduces
   * to a no-op there. This side only decides when to spend a pin: game
   * playing, not our turn, no accepted progress for window+margin, and at
   * most one claim per (window + margin) per progress epoch (B1: a rejected
   * claim no longer locks the epoch — clock drift past the margin can make a
   * genuine timeout read as still-open forever, so each elapsed full window
   * earns one retry; inside the window a re-claim cannot change the verdict
   * and would only burn pins).
   */
  private considerTimeoutClaim(s: GameSession, turn: { phase: string; seat?: string | null }): void {
    if (turn.phase !== 'playing' || turn.seat == null || turn.seat === s.seat) return;
    const anchoredAt = this.lastProgressAt.get(s.sessionId);
    if (anchoredAt === undefined) return;
    if (this.now() - anchoredAt <= MOVE_TIMEOUT_MS + MOVE_CLAIM_MARGIN_MS) return;
    const lastClaim = this.lastClaimAt.get(s.sessionId);
    // B1: a rejected claim must not lock the progress epoch forever. A claim
    // that landed via the catch-up dedup path never re-anchors the window
    // (retryPendingWrite's unconditional re-anchor is skipped), and a rejected
    // claim produces no accepted change either — with chain/host drift past
    // the 60s margin the adapter can keep judging a genuinely-expired window
    // open, and the old hard lock (lastClaim >= anchoredAt → return) wedged
    // such games with no exit. Throttle instead: at most one claim per full
    // window (window + margin) per progress epoch; claims from a PREVIOUS
    // epoch (lastClaim < anchoredAt) never block.
    if (
      lastClaim !== undefined &&
      lastClaim >= anchoredAt &&
      this.now() - lastClaim < MOVE_TIMEOUT_MS + MOVE_CLAIM_MARGIN_MS
    ) {
      return;
    }
    if (this.pending.has(s.sessionId)) return; // a write is already in flight
    this.lastClaimAt.set(s.sessionId, this.now());
    const event: TimeoutClaimedEvent = {
      protocol: 'agent-game/1',
      gameId: s.gameId,
      matchId: s.groupId,
      rulesHash: s.rulesHash,
      type: 'timeout.claimed',
      eventId: `${s.agentId}:${randomUUID()}`,
      payload: {},
    };
    const key: WriteLogKey = { groupId: s.groupId, actionSeq: NON_ACTION_LEDGER_SEQ, eventId: event.eventId };
    this.deps.store.recordWriteIntent(key, s.sessionId);
    this.deps.store.audit('timeout-claim-write', s.sessionId, s.agentId, { eventId: event.eventId });
    this.pending.set(s.sessionId, { event, key });
    this.log(`${s.sessionId}: timeout.claimed queued (no accepted progress for ${MOVE_TIMEOUT_MS + MOVE_CLAIM_MARGIN_MS}ms)`);
  }

  /** Attempt the pending write; on failure back off; on success advance state. */
  private async retryPendingWrite(s: GameSession): Promise<void> {
    const pending = this.pending.get(s.sessionId);
    if (!pending) return;
    const { event, key } = pending;
    // If history shows it already landed, just clear + advance.
    const fresh = await this.catchUp(s.sessionId);
    if (!this.pending.has(s.sessionId)) return; // cleared by catch-up
    const current = fresh ?? s;
    const entry = this.deps.store.getWriteLogEntry(key);
    const attempt = entry?.attempts ?? 0;
    try {
      const plaintext = JSON.stringify(event);
      // All game writes are signed as the session agent's local bot wallet
      // (architecture decision ④ 走子方自付): seat claims because docs/07 §3
      // attributes them by senderMetaId, actions because the mover pays and
      // owner-signed moves would vanish in bot-created rooms where the owner
      // is not a member. The transport falls back to the host owner identity
      // when the agent is not a local bot (third-party-bot sessions).
      const writeOpts = { asAgentId: s.agentId };
      const { pinId } = await this.deps.chainWrite(s.groupId, plaintext, writeOpts);
      current.budget.writesUsed++;
      this.deps.store.markWriteStatus(key, 'committed', { pinId });
      // Advance local state by reducing the event into the working state.
      // GAP-3a: our own writes reduce locally WITH our identity — the same
      // senderMetaId the replayed row will carry. A meta-less action reduce
      // can't attribute the move, leaves the working state stale, and the
      // next tick regenerates the same move under a new actionSeq (the other
      // half of the 924-2 同着法无限再生). The adapter's seq guard makes the
      // later row replay a no-op.
      const state = this.states.get(s.sessionId);
      const sandbox = this.sandboxes.get(s.sessionId);
      if (state !== undefined && sandbox) {
        try {
          const reduceEvent: MetaStampedEvent = withOwnMeta(event, s.agentId, this.now());
          this.states.set(s.sessionId, await sandbox.reduce(state, reduceEvent));
        } catch (err) {
          this.log(`${s.sessionId}: post-write reduce failed: ${errMsg(err)}`);
        }
      }
      // GAP-4: a committed write is progress — re-anchor the move window.
      this.lastProgressAt.set(s.sessionId, this.now());
      if (isActionEvent(event)) {
        // Monotonic: another seat's valid action may have advanced the cursor
        // via catch-up while our write was in flight — never roll it back.
        current.lastActionSeq = Math.max(current.lastActionSeq, event.actionSeq);
      }
      this.pending.delete(s.sessionId);
      // Persist the post-catch-up record: persisting the caller's pre-catch-up
      // copy would roll back lastIndex / lastActionSeq (lost update). Owned-
      // fields merge: the chain write awaited above must not revert a
      // markStatus that landed meanwhile (same ghost as catchUp's persist).
      this.persistOwnedFields(current, this.states.get(s.sessionId));
      this.log(`${s.sessionId}: committed ${event.type} (pin ${pinId.slice(0, 12)}…)`);
    } catch (err) {
      const backoff = WRITE_BACKOFF_MS[Math.min(attempt, WRITE_BACKOFF_MS.length - 1)];
      this.deps.store.markWriteStatus(key, 'failed', { error: errMsg(err) });
      this.log(`${s.sessionId}: write attempt ${attempt + 1} failed, backing off ${backoff}ms: ${errMsg(err)}`);
      await sleep(backoff);
      // Re-check history once more in case it actually landed.
      await this.catchUp(s.sessionId);
      if (this.pending.has(s.sessionId)) {
        // Still pending — schedule another loop pass to retry (bounded by budget).
        this.scheduleLoop(WRITE_BACKOFF_MS[0]);
      }
    }
  }

  private async finish(s: GameSession): Promise<void> {
    this.leases.release(s.groupId, s.seat, s.sessionId);
    this.lastProgressAt.delete(s.sessionId);
    this.lastClaimAt.delete(s.sessionId);
    this.markStatus(s.sessionId, 'finished', null);
    this.deps.store.audit('match-finished', s.sessionId, s.agentId, {});
    this.log(`${s.sessionId}: match finished, lease released`);
  }

  /* ----------------------- session API ----------------------- */

  async start(params: SessionStartParams, consent: SessionConsent): Promise<SessionView> {
    const manifest = await this.deps.manifestFetch(params.manifestUri);
    if (manifest.protocol !== 'agent-game/1') {
      throw runtimeError('adapter_invalid', `unsupported protocol ${manifest.protocol}`);
    }
    if (manifest.gameId !== params.gameId) {
      throw runtimeError('adapter_invalid', `manifest gameId ${manifest.gameId} != ${params.gameId}`);
    }
    const adapterPath = await this.deps.adapterPathFor(params.manifestUri, manifest);
    const sandbox = await loadAdapterSandbox(adapterPath, manifest.adapterHash);
    await sandbox.smokeTest({ gameId: params.gameId, seat: params.seat });

    const now = this.now();
    const sessionId = randomUUID();

    // Lease conflict → session_conflict. Lease is held by the sessionId.
    const res = this.leases.acquire(params.groupId, params.seat, sessionId);
    if (!res.acquired) {
      await sandbox.dispose();
      throw runtimeError('session_conflict', `seat ${params.seat} held by ${res.conflictSessionId}`);
    }
    const budget: SessionBudget = { llmCalls: params.budget.llmCalls, llmCallsUsed: 0, writes: params.budget.writes, writesUsed: 0 };
    const session: GameSession = {
      sessionId,
      status: 'running',
      appId: params.appId,
      groupId: params.groupId,
      gameId: params.gameId,
      agentId: params.agentId,
      seat: params.seat,
      rulesHash: params.rulesHash,
      adapterHash: manifest.adapterHash,
      manifestUri: params.manifestUri,
      protocolPaths: params.protocolPaths ?? ['/protocols/simplegroupchat'],
      budget,
      lastIndex: -1,
      lastActionSeq: 0,
      lastError: null,
      expiresAt: now + params.ttlMs,
      consent,
      leaseId: res.lease!.leaseId,
      leaseExpiresAt: res.lease!.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.set(sessionId, sandbox);
    this.deps.store.upsertGrant(consent);
    // Membership before the first on-chain write: a seat.claimed from a
    // non-member never reaches the group history / WS fanout (room 924-2).
    await this.ensureGroupMembership(session);
    const initialState = await sandbox.initialState({ gameId: params.gameId, seat: params.seat });
    this.states.set(sessionId, initialState);
    this.deps.store.upsertSession(session, JSON.stringify(initialState));
    // GAP-4: the move window starts at seat time (the pending seat.claimed is
    // the first progress the adapter itself anchors on).
    this.lastProgressAt.set(sessionId, now);
    this.deps.store.audit('session-start', sessionId, params.agentId, { groupId: params.groupId, gameId: params.gameId, seat: params.seat });
    // Seat granted (phase 2 created the session): announce the claim on-chain
    // (docs/07 §3) so the match can leave `waiting` — without it no client can
    // seat this agent. Same idempotent-write machinery as actions.
    this.enqueueSeatClaim(session);
    this.emit('sessionUpdated', session);
    this.scheduleLoop(0);
    return toSessionView(session);
  }

  async status(sessionId: string): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    return toSessionView(s);
  }

  list(actorId: string, opts: { appId?: string; status?: SessionStatus; groupId?: string }): SessionView[] {
    return this.deps.store.listSessions({ agentId: actorId, ...opts }).map(toSessionView);
  }

  async pause(sessionId: string): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.status === 'paused' || s.status === 'stopped' || s.status === 'finished') return toSessionView(s);
    this.markStatus(sessionId, 'paused', null); // pause keeps the lease
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  async resume(sessionId: string): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    // Terminal states: finished is over; stopped was torn down by stop()
    // (sandbox disposed, lease released) — recovery runs are for
    // running/paused only, so re-activating a stopped session would
    // half-execute (fresh lease + scheduled loop) while markStatus's
    // terminal guard refuses the running write. Return the view as-is.
    if (s.status === 'finished' || s.status === 'stopped') return toSessionView(s);
    await this.ensureSandbox(s);
    await this.withSessionLock(sessionId, () => this.catchUp(sessionId));
    const res = this.leases.acquire(s.groupId, s.seat, sessionId);
    if (!res.acquired) {
      this.markStatus(sessionId, 'paused', mkError('session_conflict', `lease held by ${res.conflictSessionId}`, this.now));
      return toSessionView(this.deps.store.getSession(sessionId)!);
    }
    this.persistLease(sessionId, res.lease!);
    this.markStatus(sessionId, 'running', null);
    this.scheduleLoop(0);
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  async stop(sessionId: string, _releaseSeat?: boolean): Promise<SessionView> {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.status === 'stopped' || s.status === 'finished') return toSessionView(s);
    this.pending.delete(sessionId);
    // Release an in-flight move window so a hung llmComplete cannot keep the
    // seat's transport pinned after the session is gone. Abort AND reject:
    //  - the abort reaches wired transports (socket dies, not the pool);
    //  - the reject settles the move-loop awaiter even when the wiring
    //    ignores the signal (a degraded llmComplete would otherwise never
    //    settle → the busy flag leaks forever), and it beats a late wired
    //    abort-settlement to the catch with a named error the loop
    //    recognizes as a stop — a late settle arriving after this function
    //    returns must not resurrect the stopped session via markStatus.
    const window = this.llmWindows.get(sessionId);
    if (window) {
      this.llmWindows.delete(sessionId);
      window.ac.abort();
      const stopErr = new Error(`session ${sessionId} stopped while a move-LLM call was in flight`);
      stopErr.name = 'SessionStoppedError';
      window.reject(stopErr);
    }
    this.leases.releaseSession(sessionId);
    const sb = this.sandboxes.get(sessionId);
    if (sb) {
      await sb.dispose().catch(() => {});
      this.sandboxes.delete(sessionId);
    }
    this.markStatus(sessionId, 'stopped', null);
    this.deps.store.audit('session-stop', sessionId, s.agentId, {});
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  /** Revoke a session's authorization (manual). */
  revokeConsent(sessionId: string, reason: string): SessionView {
    const s = this.deps.store.getSession(sessionId);
    if (!s) throw runtimeError('session_not_found', `unknown session ${sessionId}`);
    if (s.consent) {
      this.deps.store.revokeGrant({
        resourceUri: s.consent.resourceUri, actorId: s.consent.actorId, appId: s.consent.appId,
        groupId: s.consent.groupId, gameId: s.consent.gameId, rulesHash: s.consent.rulesHash,
        adapterHash: s.consent.adapterHash, seat: s.consent.seat,
      }, reason);
    }
    this.markStatus(sessionId, 'paused', mkError('consent_denied', `consent revoked: ${reason}`, this.now));
    return toSessionView(this.deps.store.getSession(sessionId)!);
  }

  /* ----------------------- helpers ----------------------- */

  private async ensureSandbox(s: GameSession): Promise<void> {
    if (this.sandboxes.has(s.sessionId)) return;
    const manifest = await this.deps.manifestFetch(s.manifestUri);
    const adapterPath = await this.deps.adapterPathFor(s.manifestUri, manifest);
    const sandbox = await loadAdapterSandbox(adapterPath, s.adapterHash);
    await sandbox.smokeTest({ gameId: s.gameId, seat: s.seat });
    this.sandboxes.set(s.sessionId, sandbox);
    // GAP-5 family: state hydration belongs to catchUp ALONE. Presetting a
    // fresh initial board here is what wedged the G2 black seat as "bare
    // initial board + idx=19" (the preset shadowed the true mid-game state,
    // and catchUp only hydrates when the map is empty); and hydrating the
    // raw stored blob here would skip catchUp's full-replay cross-check.
    // catchUp rebuilds by chain replay and audited-heals divergence; until
    // it runs, processSession's state===undefined guard keeps the loop idle.
    // GAP-4: (re)anchor conservatively — after a restart we cannot know when
    // the game last progressed, so the move window restarts from now rather
    // than risking a premature claim.
    if (!this.lastProgressAt.has(s.sessionId)) {
      this.lastProgressAt.set(s.sessionId, this.now());
    }
  }

  private isExpiredOrDepleted(s: GameSession): boolean {
    if (s.expiresAt > 0 && s.expiresAt <= this.now()) return true;
    if (s.budget.llmCalls > 0 && s.budget.llmCallsUsed >= s.budget.llmCalls) return true;
    if (s.budget.writes > 0 && s.budget.writesUsed >= s.budget.writes) return true;
    return false;
  }

  private markStatus(sessionId: string, status: SessionStatus, err: SessionError | null): void {
    const s = this.deps.store.getSession(sessionId);
    if (!s) return;
    // Terminal-state guard: a stopped/finished session is inert (no lease,
    // no sandbox, excluded from recover/housekeeping/wake). Async paths that
    // raced a stop/finish — a late settle's catch, a stale recovery loop —
    // must not flip it back to paused/running (ghost resurrection).
    if ((s.status === 'stopped' || s.status === 'finished') && (status === 'paused' || status === 'running')) {
      this.log(`${sessionId}: refusing status change ${s.status} → ${status} (terminal state guard)`);
      return;
    }
    s.status = status;
    s.lastError = err;
    s.updatedAt = this.now();
    this.deps.store.upsertSession(s, this.deps.store.getSerializedState(sessionId) ?? undefined);
    this.emit('sessionUpdated', s);
  }

  private persist(s: GameSession, state: unknown): void {
    s.updatedAt = this.now();
    let serialized: string | undefined;
    if (state !== undefined) {
      try {
        serialized = JSON.stringify(state);
        this.states.set(s.sessionId, state);
      } catch {
        serialized = undefined;
      }
    }
    this.deps.store.upsertSession(s, serialized);
    this.emit('sessionUpdated', s);
  }

  private persistLease(sessionId: string, lease: { leaseId: string; expiresAt: number }): void {
    const s = this.deps.store.getSession(sessionId);
    if (!s) return;
    s.leaseId = lease.leaseId;
    s.leaseExpiresAt = lease.expiresAt;
    this.deps.store.upsertSession(s, this.deps.store.getSerializedState(sessionId) ?? undefined);
  }

  private tryParseEnvelope(content: string): GameEvent | null {
    try {
      const env = JSON.parse(content);
      if (env && typeof env === 'object' && env.protocol === 'agent-game/1') {
        return env as GameEvent;
      }
    } catch {
      // not JSON / not an agent-game envelope — ignore
    }
    return null;
  }

  private draftEnvelope(
    s: GameSession,
    actionSeq: number,
    prevStateHash: string,
    payload: unknown,
  ): ActionEvent {
    return {
      protocol: 'agent-game/1',
      gameId: s.gameId,
      matchId: s.groupId,
      rulesHash: s.rulesHash,
      type: 'action',
      eventId: `${s.agentId}:${randomUUID()}`,
      actionSeq,
      prevStateHash,
      stateHash: '', // filled after draft reduce
      payload: (payload as Record<string, unknown>) ?? {},
    };
  }

  /** docs/07 §3 seat.claimed — identity rides the group-message metadata, the
   *  body only carries role + display info. */
  private draftSeatClaim(s: GameSession): SeatClaimedEvent {
    const name = this.deps.agentNameFor?.(s.agentId) || '';
    return {
      protocol: 'agent-game/1',
      gameId: s.gameId,
      matchId: s.groupId,
      rulesHash: s.rulesHash,
      type: 'seat.claimed',
      eventId: `${s.agentId}:${randomUUID()}`,
      payload: {
        requestedRole: s.seat,
        ...(name ? { name } : {}),
      },
    };
  }

  /** Best-effort membership bootstrap (docs/03 入座前置). Failures are loud in
   *  the log but never block the session — the chat-api write paths degrade
   *  the same way they did before this hook existed. */
  private async ensureGroupMembership(s: GameSession): Promise<void> {
    if (!this.deps.ensureAgentGroupMember) return;
    try {
      const res = await this.deps.ensureAgentGroupMember(s.agentId, s.groupId);
      if (res?.joined) {
        this.log(`${s.sessionId}: agent joined game group ${s.groupId.slice(0, 12)}…${res.chargedWrite ? ' (join pin charged to budget)' : ''}`);
      }
      if (res?.chargedWrite) {
        s.budget.writesUsed++;
      }
    } catch (err) {
      this.log(`${s.sessionId}: ensureAgentGroupMember failed (continuing): ${errMsg(err)}`);
    }
  }

  /** Queue the seat-claim write through the action path's idempotency ledger:
   *  intent recorded BEFORE the write, dedup by eventId, backoff on failure. */
  private enqueueSeatClaim(s: GameSession): void {    const event = this.draftSeatClaim(s);
    const key: WriteLogKey = { groupId: s.groupId, actionSeq: NON_ACTION_LEDGER_SEQ, eventId: event.eventId };
    this.deps.store.recordWriteIntent(key, s.sessionId);
    this.deps.store.audit('seat-claim-write', s.sessionId, s.agentId, { eventId: event.eventId, seat: s.seat });
    this.pending.set(s.sessionId, { event, key });
    this.log(`${s.sessionId}: seat.claimed queued (${s.seat})`);
  }

  private hashOf(serialized: string): string {
    return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

export class RuntimeError extends Error {
  constructor(public readonly code: SessionErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

function runtimeError(code: SessionErrorCode, message: string): RuntimeError {
  return new RuntimeError(code, message);
}

function isAbort(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: string }).name;
  // TimeoutError: the WHATWG name AbortSignal.timeout aborts with — the
  // GAP-4 per-attempt LLM window surfaces as this when the raw signal reason
  // escapes the transport.
  return name === 'AbortError' || name === 'TimeoutError' || name === 'BrowserLlmTimeout';
}

/** Unix MILLISECONDS since epoch — the ONE unit of `EventMeta.timestamp`
 *  (docs/07 §2). Adapter windows are ms (xiangqi MOVE_TIMEOUT_MS = 900_000) and
 *  withOwnMeta already stamps ms (this.now()); only the chain-row lane used to
 *  hand over raw seconds, which is the S1 timebase defect. The range test
 *  mirrors the third-party replayer's normalizeTs (|v| < 1e11 ⇒ seconds), so an
 *  already-ms row passes through untouched and a seconds row from a legacy
 *  writer is still understood. */
export function toEventMetaMs(v: number): number {
  return Math.abs(v) < 1e11 ? Math.round(v * 1000) : Math.round(v);
}

/** Stamp docs/07 §2 event metadata from the group-chat message row itself
 *  (index / senderMetaId / chain timestamp). Missing row fields stay missing —
 *  nothing is synthesized (adapters treat an absent senderMetaId as '').
 *  The row's `chainTimestamp` is Unix SECONDS (see SessionMessage); this is the
 *  single conversion point onto the ms event-metadata contract. */
function withRowMeta(env: MetaStampedEvent, msg: SessionMessage): MetaStampedEvent {
  const meta: EventMeta = {};
  if (msg.msgIndex !== null && msg.msgIndex >= 0) meta.index = msg.msgIndex;
  if (msg.senderGlobalMetaId) meta.senderMetaId = msg.senderGlobalMetaId;
  // docs/07 §2: EventMeta.timestamp is Unix MILLISECONDS. The written artifact
  // is /protocols/simplegroupchat with a ms body timestamp
  // (groupChatTransport.ts), but the ROW (group_chat_messages.chain_timestamp)
  // is the indexer's Unix SECONDS (metaWebListenerService.ts). Normalize here —
  // the only row→event lane in the runtime.
  if (msg.chainTimestamp !== null && Number.isFinite(msg.chainTimestamp)) {
    meta.timestamp = toEventMetaMs(msg.chainTimestamp);
  }
  return { ...env, meta };
}

/** Stamp our own write identity for the post-write local reduce of
 *  identity-signed (non-action) events: the transport signs seat claims as the
 *  session agent, so the replayed row meta will carry the same senderMetaId. */
function withOwnMeta(env: MetaStampedEvent, agentId: string, ts: number): MetaStampedEvent {
  return { ...env, meta: { senderMetaId: agentId, timestamp: ts } };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** GAP-5: parse a persisted serialized game state. A blob that exists but
 *  cannot parse into a state object is library corruption — recovery must
 *  never silently fall back to a fresh initial board mid-game, so callers
 *  surface `state_corrupt` and park the session. */
function parseStoredState(sessionId: string, stored: string): unknown {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (parsed === null || typeof parsed !== 'object') throw new Error('not a state object');
    return parsed;
  } catch (err) {
    throw runtimeError('state_corrupt', `persisted game state for ${sessionId} is corrupt: ${errMsg(err)}`);
  }
}

/** Structured code of a RuntimeError, for callers translating errors into
 *  session lastError without flattening every failure to adapter_error. */
function errorCodeOf(err: unknown): SessionErrorCode | null {
  return err instanceof RuntimeError ? err.code : null;
}

/** Build a SessionError with the current timestamp. */
function mkError(code: SessionErrorCode, message: string, now: () => number): SessionError {
  return { code, message, at: now() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
