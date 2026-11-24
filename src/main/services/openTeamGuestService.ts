/**
 * OpenTeam guest service (M1): the invitee side of the OpenTeam handshake plus
 * the inviter-side ACCEPT/DECLINE bookkeeping and the guest-side KICK handler
 * (M3: the chair's kick notification marks the local membership left).
 *
 * Guest flow: validate an incoming [OPENTEAM_INVITE] envelope against local
 * policy, join the group on-chain, record the membership (which instantly
 * adds the group to the chat backfill union) and reply ACCEPT/DECLINE via
 * encrypted simplemsg. The product decision stays "default on, fully
 * automatic" — but because any on-chain sender can forge an invite envelope,
 * the validation chain is hardened before the guest wallet spends anything:
 *
 *   duplicate inviteId (silent skip) -> bot enabled -> allowRemoteCollab
 *   switch -> target match -> sender match (envelope inviter vs actual row
 *   sender) -> per-inviter/per-group rate limit -> already-member -> expiry
 *   (60s clock-skew tolerance) -> on-chain group verification (group must
 *   exist and the inviter must be its creator/chair) -> join.
 *
 * A validation failure still gets a DECLINE reply so the inviter learns why;
 * duplicates are skipped silently (socket + backfill double delivery). All
 * GlobalMetaID comparisons normalize through normalizeRawGlobalMetaId with a
 * trim/lowercase fallback for legacy non-canonical values.
 *
 * Dependencies are injectable two ways: handleOpenTeamInvite takes an explicit
 * deps object (tests), while the privateChatDaemon interception path calls the
 * module-level handleIncomingOpenTeamInvite / handleIncomingOpenTeamResponse,
 * which resolve the deps wired once by main.ts (setOpenTeamGuestServiceDeps,
 * same setter-injection style as groupChatTransport). Rate-limit/dedup state
 * is keyed per deps object (WeakMap), so tests get fresh state per harness.
 */

import type { CoworkStore } from '../coworkStore';
import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import type {
  OpenTeamInvite,
  OpenTeamInviteStatus,
  OpenTeamMembershipStore,
} from '../openTeamMembershipStore';
import type {
  SendEncryptedSimplemsgResult,
  SimplemsgWalletInput,
} from './encryptedSimplemsg';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import {
  buildOpenTeamAcceptMessage,
  buildOpenTeamDeclineMessage,
  type OpenTeamAcceptEnvelope,
  type OpenTeamDeclineEnvelope,
  type OpenTeamInvitePayload,
  type OpenTeamKickPayload,
} from './openTeamProtocols';
import {
  ensureOpenTeamGuestSession,
  injectOpenTeamGuestContext,
} from './groupTaskSession';

/** Per-metabot kill switch (metabot_settings kv): missing = allowed, '0' = off. */
export const OPENTEAM_ALLOW_REMOTE_COLLAB_KEY = 'openteam.allowRemoteCollab';

/** Clock-skew tolerance when judging envelope expiry (guest clock may lag the inviter). */
export const OPENTEAM_INVITE_EXPIRY_SKEW_MS = 60_000;
/** Rate limit: at most this many invites processed per inviter AND per group per window. */
export const OPENTEAM_INVITE_RATE_LIMIT_DEFAULT = 3;
export const OPENTEAM_INVITE_RATE_WINDOW_MS = 60_000;
/** Cap on the in-memory processed-inviteId dedup set (FIFO trim). */
const PROCESSED_INVITE_IDS_MAX = 1_000;

/** deps.sendEncryptedSimplemsg already has createPin bound by the host. */
export type OpenTeamGuestSendSimplemsgFn = (input: {
  metabotId: number;
  wallet: SimplemsgWalletInput;
  peerGlobalMetaId: string;
  peerChatPubkey: string;
  plaintext: string;
  replyPin?: string | null;
}) => Promise<SendEncryptedSimplemsgResult>;

/**
 * On-chain group verification lookup (wired to groupChatTransport.fetchGroupInfo
 * in main.ts). 'found' carries the group creator's identity fields (both the
 * legacy metaId and the GlobalMetaID form, whichever the indexer exposes);
 * 'not_found' means the indexer answered but has no such group; 'error' means
 * every indexer endpoint failed. Structurally compatible with
 * groupChatTransport.FetchGroupInfoResult.
 */
export type OpenTeamFetchGroupInfoResult =
  | { status: 'found'; createUserMetaId: string; createUserGlobalMetaId: string }
  | { status: 'not_found' }
  | { status: 'error' };

export type OpenTeamFetchGroupInfoFn = (
  groupId: string,
) => Promise<OpenTeamFetchGroupInfoResult>;

export interface OpenTeamGuestServiceDeps {
  getMetabotStore: () => MetabotStore;
  getMembershipStore: () => OpenTeamMembershipStore;
  joinGroupChat: (metabotId: number, groupId: string) => Promise<{ pinId: string }>;
  sendEncryptedSimplemsg: OpenTeamGuestSendSimplemsgFn;
  /**
   * Group existence + creator verification. Fail-closed: an unwired dep is
   * treated as 'error' and the invite is declined (group_verify_failed).
   */
  fetchGroupInfo?: OpenTeamFetchGroupInfoFn;
  /** Rate-limit tuning (tests); defaults OPENTEAM_INVITE_RATE_LIMIT_DEFAULT / _WINDOW_MS. */
  inviteRateLimitPerWindow?: number;
  inviteRateWindowMs?: number;
  emitLog?: (message: string) => void;
  now?: () => number;
  /**
   * P1-3 (invitee-side immediate wake-up): when wired, the ACCEPT flow
   * eagerly creates the invited bot's cowork session and injects the group
   * context (task title + recent transcript) — the worker session exists
   * within seconds of the invite instead of waiting ~20 min for a lazy
   * daemon-created session.
   */
  getCoworkStore?: () => CoworkStore;
  listRecentGroupMessages?: (
    groupId: string,
    limit: number,
  ) => Array<{ senderName: string | null; content: string | null }>;
}

export interface OpenTeamInviteReplyContext {
  /** Inviter's globalMetaId (sender of the invite simplemsg). */
  peerGlobalMetaId: string;
  /** Inviter's chat pubkey (from_chat_pubkey of the invite row). */
  peerChatPubkey: string;
  /** Invite pin id; used as replyPin on the ACCEPT/DECLINE reply. */
  invitePinId: string;
}

export interface OpenTeamGuestResult {
  /**
   * accepted: joined + ACCEPT sent. declined: DECLINE reply attempted.
   * skipped: duplicate inviteId delivery — no state change, no reply.
   */
  action: 'accepted' | 'declined' | 'skipped';
  /** Short machine-ish decline reason tag (empty when accepted). */
  reason: string;
  joinedPinId: string | null;
  /** pinId of the ACCEPT/DECLINE simplemsg we sent back (null when unsent). */
  replyPinId: string | null;
}

let deps: OpenTeamGuestServiceDeps | null = null;

export function setOpenTeamGuestServiceDeps(next: OpenTeamGuestServiceDeps): void {
  deps = next;
}

export function resetOpenTeamGuestServiceDeps(): void {
  deps = null;
}

function getOpenTeamGuestServiceDeps(): OpenTeamGuestServiceDeps {
  if (!deps) {
    throw new Error('openTeamGuestService not initialized: call setOpenTeamGuestServiceDeps first');
  }
  return deps;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Canonical GlobalMetaID comparison key: normalizeRawGlobalMetaId first, with
 * a trim/lowercase fallback so legacy non-canonical values still compare
 * deterministically (never throws, '' for unusable input).
 */
function globalMetaIdCompareKey(value: unknown): string {
  return normalizeRawGlobalMetaId(value) ?? (typeof value === 'string' ? value.trim().toLowerCase() : '');
}

// ---------------------------------------------------------------------------
// Per-deps invite guard: duplicate delivery dedup + fixed-window rate limit.
// ---------------------------------------------------------------------------

interface OpenTeamInviteGuardState {
  /** `<metabotId>:<inviteId>` keys already handled (any outcome). */
  processedInviteIds: Set<string>;
  /** Fixed-window timestamps per key (`inviter:<gmid>` / `group:<groupId>`). */
  windows: Map<string, number[]>;
}

const inviteGuardStateByDeps = new WeakMap<OpenTeamGuestServiceDeps, OpenTeamInviteGuardState>();

function getInviteGuardState(target: OpenTeamGuestServiceDeps): OpenTeamInviteGuardState {
  let state = inviteGuardStateByDeps.get(target);
  if (!state) {
    state = { processedInviteIds: new Set(), windows: new Map() };
    inviteGuardStateByDeps.set(target, state);
  }
  return state;
}

function markInviteProcessed(state: OpenTeamInviteGuardState, key: string): void {
  if (state.processedInviteIds.has(key)) return;
  state.processedInviteIds.add(key);
  if (state.processedInviteIds.size > PROCESSED_INVITE_IDS_MAX) {
    // FIFO trim: Set iterates in insertion order.
    let remaining = state.processedInviteIds.size - PROCESSED_INVITE_IDS_MAX;
    for (const oldest of state.processedInviteIds) {
      if (remaining <= 0) break;
      state.processedInviteIds.delete(oldest);
      remaining -= 1;
    }
  }
}

/**
 * Fixed-window rate limiter. Records the attempt and returns true when any of
 * the keys is already at the limit inside the current window (the attempt is
 * NOT recorded in that case, so a rejected burst cannot extend the lockout).
 */
function isInviteRateLimited(
  state: OpenTeamInviteGuardState,
  keys: string[],
  limit: number,
  windowMs: number,
  nowMs: number,
): boolean {
  const cutoff = nowMs - windowMs;
  const pruned = keys.map((key) => {
    const stamps = (state.windows.get(key) ?? []).filter((ts) => ts > cutoff);
    state.windows.set(key, stamps);
    return stamps;
  });
  if (pruned.some((stamps) => stamps.length >= limit)) return true;
  for (const [index, key] of keys.entries()) {
    pruned[index]!.push(nowMs);
    state.windows.set(key, pruned[index]!);
  }
  return false;
}

/**
 * Core guest accept flow with explicit deps (unit-testable). Validation order:
 * duplicate -> bot enabled -> allowRemoteCollab switch -> target match ->
 * sender match -> rate limit -> already-member -> expiry (60s skew) ->
 * on-chain group/creator verification -> join. Every failure path replies
 * DECLINE with a reason (a join failure declines with the underlying error,
 * e.g. insufficient balance); only a duplicate inviteId is skipped silently.
 */
export async function handleOpenTeamInvite(
  deps: OpenTeamGuestServiceDeps,
  input: {
    metabot: Metabot;
    invite: OpenTeamInvitePayload;
    replyContext: OpenTeamInviteReplyContext;
    /**
     * Actual sender of the invite simplemsg row (from_global_metaid). When
     * provided and it does not match the envelope's inviterGlobalMetaId the
     * invite is declined (sender_mismatch) — a forged envelope naming another
     * inviter must never spend the guest wallet.
     */
    senderGlobalMetaId?: string;
  },
): Promise<OpenTeamGuestResult> {
  const { metabot, invite, replyContext } = input;
  const emitLog = deps.emitLog ?? (() => undefined);
  const now = deps.now ?? (() => Date.now());
  const metabotStore = deps.getMetabotStore();
  const membershipStore = deps.getMembershipStore();
  const guard = getInviteGuardState(deps);

  const sendReply = async (plaintext: string): Promise<string | null> => {
    const wallet = metabotStore.getMetabotWalletByMetabotId(metabot.id);
    if (!wallet?.mnemonic?.trim()) {
      emitLog(`[OpenTeam] MetaBot ${metabot.id}: cannot reply to invite (no wallet)`);
      return null;
    }
    try {
      const sent = await deps.sendEncryptedSimplemsg({
        metabotId: metabot.id,
        wallet,
        peerGlobalMetaId: replyContext.peerGlobalMetaId,
        peerChatPubkey: replyContext.peerChatPubkey,
        plaintext,
        replyPin: replyContext.invitePinId,
      });
      return sent.pinId ?? null;
    } catch (error) {
      emitLog(
        `[OpenTeam] MetaBot ${metabot.id}: invite reply send failed: ${errorMessage(error)}`,
      );
      return null;
    }
  };

  const decline = async (reason: string, detail?: string): Promise<OpenTeamGuestResult> => {
    const text = detail ? `${reason}: ${detail}` : reason;
    emitLog(`[OpenTeam] MetaBot ${metabot.id}: declining invite ${invite.inviteId} (${text})`);
    // P0-1: the invite history row exists (recorded on entry); finalize it as
    // declined so the guest-side UI shows the outcome instead of a dangling
    // "invited".
    membershipStore.updateGuestInviteStatus(invite.inviteId, 'declined', { reason: text });
    const replyPinId = await sendReply(buildOpenTeamDeclineMessage(invite.inviteId, text));
    return { action: 'declined', reason, joinedPinId: null, replyPinId };
  };

  // Idempotency: the socket push and the history backfill can deliver the same
  // invite twice, and the async daemon dispatch can overlap them. A previously
  // handled inviteId (in-memory, or the membership row's invite_pin_id from an
  // earlier accept) is skipped silently — no second join, no second reply.
  // P0-1: record the invite in the guest-side history as soon as it is handled
  // (idempotent on invite_pin_id — a re-delivered envelope returns the same
  // row). The row exists even when the bot later declines, so the invite is
  // visible to the A2A session system / collab UI regardless of the outcome.
  membershipStore.createGuestInvite({
    groupId: invite.groupId,
    inviterGlobalmetaid: invite.inviterGlobalMetaId,
    inviterName: invite.inviterName || null,
    taskTitle: invite.taskTitle || null,
    goalSummary: invite.goalSummary || null,
    requiredSkills: invite.requiredSkills,
    invitePinId: invite.inviteId,
    targetGlobalmetaid: invite.targetGlobalMetaId,
    expiresAt: invite.expiresAt,
  });

  const dedupKey = `${metabot.id}:${invite.inviteId}`;
  const existing = membershipStore.getMembership(invite.groupId, metabot.id);
  if (guard.processedInviteIds.has(dedupKey) || existing?.invitePinId === invite.inviteId) {
    markInviteProcessed(guard, dedupKey);
    membershipStore.updateGuestInviteStatus(invite.inviteId, 'skipped', { reason: 'duplicate_invite' });
    emitLog(
      `[OpenTeam] MetaBot ${metabot.id}: duplicate invite ${invite.inviteId}; skipped without reply`,
    );
    return { action: 'skipped', reason: 'duplicate_invite', joinedPinId: null, replyPinId: null };
  }
  markInviteProcessed(guard, dedupKey);

  if (metabot.enabled === false) {
    return decline('bot_disabled', 'the invited MetaBot is disabled');
  }
  const allowRemoteCollab = metabotStore.getMetabotSetting(metabot.id, OPENTEAM_ALLOW_REMOTE_COLLAB_KEY);
  if (allowRemoteCollab === '0') {
    return decline('remote_collab_disabled', 'remote collaboration is disabled by the bot owner');
  }
  // Twin Bot holds elevated orchestration & wallet management privileges:
  // decline external OpenTeam invites by default unless the owner explicitly
  // opts in (`openteam.allowRemoteCollab === '1'`).
  if (metabot.metabot_type === 'twin' && allowRemoteCollab !== '1') {
    return decline(
      'twin_remote_collab_disabled',
      'Twin Bot does not join external OpenTeam groups unless explicitly enabled by the owner',
    );
  }
  const localGlobalMetaId = (metabot.globalmetaid ?? '').trim();
  const localCompareKey = globalMetaIdCompareKey(localGlobalMetaId);
  if (!localCompareKey || localCompareKey !== globalMetaIdCompareKey(invite.targetGlobalMetaId)) {
    return decline('target_mismatch', 'invite target does not match this bot');
  }
  const senderKey = globalMetaIdCompareKey(input.senderGlobalMetaId);
  if (senderKey && senderKey !== globalMetaIdCompareKey(invite.inviterGlobalMetaId)) {
    return decline('sender_mismatch', 'the simplemsg sender does not match the envelope inviter');
  }
  const rateLimit = Math.max(1, Math.trunc(deps.inviteRateLimitPerWindow ?? OPENTEAM_INVITE_RATE_LIMIT_DEFAULT));
  const rateWindowMs = Math.max(1_000, Math.trunc(deps.inviteRateWindowMs ?? OPENTEAM_INVITE_RATE_WINDOW_MS));
  const rateKeys = [
    `inviter:${globalMetaIdCompareKey(invite.inviterGlobalMetaId) || invite.inviterGlobalMetaId}`,
    `group:${invite.groupId.trim().toLowerCase()}`,
  ];
  if (isInviteRateLimited(guard, rateKeys, rateLimit, rateWindowMs, now())) {
    return decline('rate_limited', 'too many invites from this inviter or for this group; retry later');
  }
  if (existing?.status === 'active') {
    return decline('already_member', 'bot is already an active member of this group');
  }
  // 60s clock-skew tolerance: the inviter's clock may be slightly ahead.
  if (invite.expiresAt * 1000 <= now() - OPENTEAM_INVITE_EXPIRY_SKEW_MS) {
    return decline('invite_expired', 'the invite has expired');
  }

  // On-chain verification BEFORE the guest wallet pays a join pin: the group
  // must really exist and the inviter must be its creator (chair). Both
  // creator identity forms (globalMetaId / legacy metaId) are accepted against
  // either envelope identity field (inviterGlobalMetaId / chairGlobalMetaId).
  // Fail-closed: a network failure declines (group_verify_failed).
  let groupInfo: OpenTeamFetchGroupInfoResult;
  if (typeof deps.fetchGroupInfo !== 'function') {
    groupInfo = { status: 'error' };
  } else {
    try {
      groupInfo = await deps.fetchGroupInfo(invite.groupId);
    } catch (error) {
      emitLog(
        `[OpenTeam] MetaBot ${metabot.id}: group-info lookup failed for ${invite.groupId}: ${errorMessage(error)}`,
      );
      groupInfo = { status: 'error' };
    }
  }
  if (!groupInfo || groupInfo.status === 'error') {
    return decline('group_verify_failed', 'could not verify the invited group on-chain');
  }
  if (groupInfo.status === 'not_found') {
    return decline('invalid_group', 'the invited group does not exist on-chain');
  }
  const creatorKeys = [groupInfo.createUserGlobalMetaId, groupInfo.createUserMetaId]
    .map(globalMetaIdCompareKey)
    .filter((key) => key.length > 0);
  const inviterKeys = [invite.inviterGlobalMetaId, invite.chairGlobalMetaId]
    .map(globalMetaIdCompareKey)
    .filter((key) => key.length > 0);
  if (creatorKeys.length === 0 || !inviterKeys.some((key) => creatorKeys.includes(key))) {
    return decline('inviter_not_chair', 'only the group creator (chair) can invite members');
  }

  let joinedPinId: string;
  try {
    const joined = await deps.joinGroupChat(metabot.id, invite.groupId);
    joinedPinId = joined.pinId;
  } catch (error) {
    return decline('join_failed', errorMessage(error));
  }

  try {
    membershipStore.upsertActiveMembership({
      groupId: invite.groupId,
      metabotId: metabot.id,
      globalmetaid: localGlobalMetaId,
      inviterGlobalmetaid: invite.inviterGlobalMetaId,
      taskTitle: invite.taskTitle,
      invitePinId: invite.inviteId,
      joinedPinId,
      // R1: the group's mode as declared by the inviter — the guest daemon
      // switches gating/prompt/cadence on it ('task' when the envelope
      // omitted the field, e.g. an older inviter host).
      groupMode: invite.mode === 'chat' ? 'chat' : 'task',
    });
    // The guest daemon answers only messages arriving after the join.
    membershipStore.catchUpCursorToLatest(invite.groupId, metabot.id);
  } catch (error) {
    // Joined on-chain but the local record failed: decline so the inviter does
    // not wait on a member we cannot track. The membership UNIQUE upsert makes
    // a later re-invite converge back to active.
    return decline('membership_record_failed', errorMessage(error));
  }

  // P0-1: finalize the guest-side history row as accepted with the join pin.
  membershipStore.updateGuestInviteStatus(invite.inviteId, 'accepted', { joinedPinId });

  // P1-3 (invitee-side immediate wake-up): eagerly create the invited bot's
  // cowork session and inject the group context. Best-effort — a session
  // failure must never flip a successful join into a decline.
  try {
    if (deps.getCoworkStore && deps.listRecentGroupMessages) {
      const coworkStore = deps.getCoworkStore();
      const { session } = ensureOpenTeamGuestSession(
        coworkStore,
        metabot.id,
        metabot.name?.trim() || `bot-${metabot.id}`,
        { groupId: invite.groupId, taskTitle: invite.taskTitle },
      );
      injectOpenTeamGuestContext({
        coworkStore,
        sessionId: session.id,
        taskTitle: invite.taskTitle,
        inviterGlobalmetaid: invite.inviterGlobalMetaId,
        groupMode: invite.mode === 'chat' ? 'chat' : 'task',
        recentMessages: deps.listRecentGroupMessages(invite.groupId, 20),
      });
      // P0-1: the invite itself enters the guest's A2A session stream, so the
      // bot's own conversation history shows the invitation that started the
      // collaboration (not only the group messages after the join).
      coworkStore.addMessage(session.id, {
        type: 'assistant',
        content:
          `[OpenTeam invite accepted] ${invite.inviterName?.trim() || invite.inviterGlobalMetaId} ` +
          `invited you to group task "${invite.taskTitle || invite.groupId}" ` +
          `(invite ${invite.inviteId}, joined pin ${joinedPinId}). ` +
          `Goal: ${invite.goalSummary || '(not provided)'}` +
          (invite.requiredSkills.length > 0
            ? ` Required skills: ${invite.requiredSkills.join(', ')}`
            : ''),
      });
      emitLog(
        `[OpenTeam] MetaBot ${metabot.id}: guest session ready for group ${invite.groupId} (${session.id})`,
      );
    }
  } catch (error) {
    emitLog(
      `[OpenTeam] MetaBot ${metabot.id}: guest session pre-creation failed (continuing without it): ${errorMessage(error)}`,
    );
  }

  emitLog(
    `[OpenTeam] MetaBot ${metabot.id}: accepted invite ${invite.inviteId}, joined group ${invite.groupId} (pin ${joinedPinId})`,
  );
  const replyPinId = await sendReply(buildOpenTeamAcceptMessage(invite.inviteId, joinedPinId));
  return { action: 'accepted', reason: '', joinedPinId, replyPinId };
}

/** Daemon entry point: resolves the module deps wired by main.ts. */
export async function handleIncomingOpenTeamInvite(input: {
  metabot: Metabot;
  invite: OpenTeamInvitePayload;
  replyContext: OpenTeamInviteReplyContext;
  /** Actual sender of the invite simplemsg row (from_global_metaid). */
  senderGlobalMetaId?: string;
}): Promise<OpenTeamGuestResult> {
  return handleOpenTeamInvite(getOpenTeamGuestServiceDeps(), input);
}

export interface OpenTeamResponseResult {
  /** True when a local invite row matched the envelope inviteId. */
  matched: boolean;
  invite: OpenTeamInvite | null;
}

/**
 * Inviter-side bookkeeping for ACCEPT/DECLINE envelopes: transition the
 * matching pending invite row. The join-confirmation watcher that turns an
 * accepted invite into a task member is a later milestone; here we only
 * persist the state change. When the actual sender is provided it must match
 * the invite row's invitee — a forged ACCEPT/DECLINE from anyone else is
 * ignored (no state change).
 */
export function handleOpenTeamResponse(
  deps: OpenTeamGuestServiceDeps,
  envelope: OpenTeamAcceptEnvelope | OpenTeamDeclineEnvelope,
  options?: { senderGlobalMetaId?: string },
): OpenTeamResponseResult {
  const emitLog = deps.emitLog ?? (() => undefined);
  const membershipStore = deps.getMembershipStore();
  const invite = membershipStore.getInviteByPinId(envelope.inviteId);
  if (!invite) {
    emitLog(`[OpenTeam] ${envelope.kind} for unknown invite ${envelope.inviteId}; ignored`);
    return { matched: false, invite: null };
  }
  const senderKey = globalMetaIdCompareKey(options?.senderGlobalMetaId);
  if (senderKey && senderKey !== globalMetaIdCompareKey(invite.inviteeGlobalmetaid)) {
    emitLog(
      `[OpenTeam] ${envelope.kind} for invite ${envelope.inviteId} from a sender that is not ` +
      'the invitee; ignored',
    );
    return { matched: true, invite };
  }
  if (invite.status !== 'pending') {
    emitLog(
      `[OpenTeam] ${envelope.kind} for invite ${envelope.inviteId} already ${invite.status}; ignored`,
    );
    return { matched: true, invite };
  }
  const status: OpenTeamInviteStatus = envelope.kind === 'accept' ? 'accepted' : 'declined';
  const declineReason = envelope.kind === 'decline' ? envelope.reason || null : null;
  let updated = membershipStore.updateInviteStatus(
    { invitePinId: envelope.inviteId },
    status,
    declineReason,
  );
  // P1-2: the ACCEPT envelope echoes the guest's join pin — persist it on the
  // invite row so the join-confirmation watcher can copy it into the remote
  // member row (joined_pin_id was null forever before, hiding "already joined").
  if (envelope.kind === 'accept' && envelope.joinedPinId) {
    updated = membershipStore.updateInviteJoinedPinId(envelope.inviteId, envelope.joinedPinId) ?? updated;
  }
  emitLog(
    `[OpenTeam] Invite ${envelope.inviteId} marked ${status}` +
    (declineReason ? ` (${declineReason})` : '') +
    (envelope.kind === 'accept' && envelope.joinedPinId ? ` (joined pin ${envelope.joinedPinId})` : ''),
  );
  return { matched: true, invite: updated };
}

/** Daemon entry point: resolves the module deps wired by main.ts. */
export function handleIncomingOpenTeamResponse(
  envelope: OpenTeamAcceptEnvelope | OpenTeamDeclineEnvelope,
  options?: { senderGlobalMetaId?: string },
): OpenTeamResponseResult {
  return handleOpenTeamResponse(getOpenTeamGuestServiceDeps(), envelope, options);
}

export interface OpenTeamKickResult {
  /** marked_left: the membership was flipped to left; ignored: no state change. */
  action: 'marked_left' | 'ignored';
  reason: string;
}

/**
 * Guest side of the chair's one-way kick notification (M3): mark the local
 * membership left so the guest daemon stops consuming the group, backfill
 * stops pulling it, and the External collaborations view shows Left. The
 * actual sender of the simplemsg must be the inviter recorded on the
 * membership row — a KICK from anyone else is a forgery and is ignored.
 * Local-only bookkeeping (no chain write, no reply), so it never throws into
 * the daemon path: failures are logged and reported as ignored.
 */
export function handleOpenTeamKick(
  deps: OpenTeamGuestServiceDeps,
  input: {
    metabot: Metabot;
    kick: OpenTeamKickPayload;
    /** Actual sender of the kick simplemsg row (from_global_metaid). */
    senderGlobalMetaId?: string;
  },
): OpenTeamKickResult {
  const emitLog = deps.emitLog ?? (() => undefined);
  try {
    const membershipStore = deps.getMembershipStore();
    const groupId = input.kick.groupId.trim();
    const membership = membershipStore.getMembership(groupId, input.metabot.id);
    if (!membership) {
      emitLog(
        `[OpenTeam] MetaBot ${input.metabot.id}: KICK for unknown group ${groupId}; ignored`,
      );
      return { action: 'ignored', reason: 'no_membership' };
    }
    if (membership.status !== 'active') {
      return { action: 'ignored', reason: 'already_left' };
    }
    const senderKey = globalMetaIdCompareKey(input.senderGlobalMetaId);
    const inviterKey = globalMetaIdCompareKey(membership.inviterGlobalmetaid);
    if (!senderKey || !inviterKey || senderKey !== inviterKey) {
      emitLog(
        `[OpenTeam] MetaBot ${input.metabot.id}: KICK for group ${groupId} from a sender that is ` +
        'not the recorded inviter; ignored',
      );
      return { action: 'ignored', reason: 'sender_not_inviter' };
    }
    membershipStore.markLeft(groupId, input.metabot.id, { cause: 'kick', reason: input.kick.reason });
    emitLog(
      `[OpenTeam] MetaBot ${input.metabot.id}: KICK received for group ${groupId} ` +
      `("${input.kick.taskTitle || 'untitled'}")` +
      `${input.kick.reason ? `, reason: "${input.kick.reason}"` : ''}; membership marked left`,
    );
    return { action: 'marked_left', reason: '' };
  } catch (error) {
    emitLog(`[OpenTeam] KICK handling failed for MetaBot ${input.metabot.id}: ${errorMessage(error)}`);
    return { action: 'ignored', reason: 'handler_error' };
  }
}

/** Daemon entry point: resolves the module deps wired by main.ts. */
export function handleIncomingOpenTeamKick(input: {
  metabot: Metabot;
  kick: OpenTeamKickPayload;
  senderGlobalMetaId?: string;
}): OpenTeamKickResult {
  return handleOpenTeamKick(getOpenTeamGuestServiceDeps(), input);
}
