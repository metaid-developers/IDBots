/**
 * Group chat transport service: on-chain pin writes (create/join/send/remove) for
 * MetaWeb group chats, plus an indexer-readiness poll. Consolidates logic that
 * previously existed only as an inline arrow function in main.ts and inside skill
 * scripts.
 *
 * Payload references:
 * - Create body mirrors idchat production createChannel (idchat/src/utils/talk.ts:724-741).
 * - Join body follows the SimpleGroupJoin protocol ({groupId, state, referrer, k});
 *   the group_chat built-in tool's join_group sends the same shape.
 * - Send body matches the former inline sender in main.ts (simplegroupchat, AES).
 */

import type { MetabotStore } from '../metabotStore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { UserIdentity } from '../types/userIdentity';
import { createPin, createPinForIdentity } from './metaidCore';
import { encryptGroupMessageECB } from './metaWebCrypto';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { recordOutgoingGroupSend } from './groupSendLedger';
import { assertNoSecretEgressText } from '../security/secretEgressGuard';

export interface CreateGroupChatOptions {
  groupName: string;
  groupNote?: string;
}

export interface JoinGroupChatOptions {
  referrer?: string;
}

export interface RemoveGroupChatMemberOptions {
  /** Legacy MetaID of the member being removed (not the GlobalMetaID). */
  removeMetaid: string;
  reason?: string;
}

export interface SendGroupChatMessageOptions {
  content: string;
  nickName?: string;
  contentType?: string;
  replyPin?: string;
  mention?: string[];
}

export interface SendGroupChatMessageAsIdentityOptions {
  content: string;
  nickName?: string;
  replyPin?: string;
  mention?: string[];
}

/** Dual indexer endpoints, same pair as privateChatHistorySyncService. */
const GROUP_INFO_ENDPOINTS = ['https://api.idchat.io', 'https://www.show.now'];

const DEFAULT_INDEX_TIMEOUT_MS = 60_000;
const INDEX_POLL_INTERVAL_MS = 2_000;
const MEMBER_LIST_TIMEOUT_MS = 10_000;

// Dependency injection for MetabotStore, mirroring libs/claudeSettings.ts setStoreGetter:
// main.ts wires its getMetabotStore() here once during startup.
let metabotStoreGetter: (() => MetabotStore) | null = null;

export function setGroupChatTransportMetabotStoreGetter(getter: () => MetabotStore): void {
  metabotStoreGetter = getter;
}

function getMetabotStore(): MetabotStore {
  if (!metabotStoreGetter) {
    throw new Error(
      'groupChatTransport not initialized: call setGroupChatTransportMetabotStoreGetter first'
    );
  }
  return metabotStoreGetter();
}

// DI for the user identity store (owner identity signs its own pins via createPinForIdentity).
let userIdentityStoreGetter: (() => UserIdentityStore) | null = null;

export function setGroupChatTransportUserIdentityStoreGetter(getter: () => UserIdentityStore): void {
  userIdentityStoreGetter = getter;
}

function getUserIdentity(): UserIdentity {
  if (!userIdentityStoreGetter) {
    throw new Error(
      'groupChatTransport not initialized: call setGroupChatTransportUserIdentityStoreGetter first'
    );
  }
  const identity = userIdentityStoreGetter().get();
  if (!identity) {
    throw new Error('No user identity found: create or import a user identity first');
  }
  return identity;
}

// Pin-function seams (same setter-injection style as groupTaskService): tests override
// these to inspect payloads without chain writes.
let createPinForIdentityFn = createPinForIdentity;
// fetch seam: tests stub HTTP responses for the member-list/indexer clients.
let fetchFn: typeof fetch = globalThis.fetch;

export interface GroupChatTransportOverrides {
  createPinForIdentity?: typeof createPinForIdentity;
  fetchFn?: typeof fetch;
}

export function setGroupChatTransportOverrides(overrides: GroupChatTransportOverrides): void {
  createPinForIdentityFn = overrides.createPinForIdentity ?? createPinForIdentity;
  fetchFn = overrides.fetchFn ?? globalThis.fetch;
}

export function resetGroupChatTransportOverrides(): void {
  createPinForIdentityFn = createPinForIdentity;
  fetchFn = globalThis.fetch;
}

/**
 * Create a public group chat on-chain (/protocols/simplegroupcreate).
 * Body mirrors idchat createChannel (idchat/src/utils/talk.ts:724-741) for a public
 * text group; groupIcon added per the SimpleGroupCreate protocol doc
 * (03-group-management.md in the MetaID protocol docs). The returned pinId
 * (<txid>i0) IS the canonical on-chain groupId (the indexer overrides the body
 * field), so the body groupId is left empty.
 */
export async function createGroupChat(
  metabotId: number,
  opts: CreateGroupChatOptions
): Promise<{ groupId: string; pinId: string }> {
  const body = {
    groupId: '',
    communityId: '',
    groupName: opts.groupName,
    groupNote: opts.groupNote ?? '',
    groupIcon: '',
    groupType: '1', // idchat PublicText: '1' = AES-encrypted messages
    status: '1',
    type: '0', // public
    tickId: '',
    collectionId: '',
    limitAmount: '',
    chatSettingType: 0, // everyone may speak
    deleteStatus: 0,
    path: '',
    timestamp: Math.floor(Date.now() / 1000), // idchat uses seconds
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupcreate',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  }, { feeRate: getGlobalFeeRate('mvc'), origin: 'internal:group-chat' });
  return { groupId: result.pinId, pinId: result.pinId };
}

/**
 * Join a public group chat on-chain (/protocols/simplegroupjoin, state 1).
 * Public groups use an empty k (no transferable key).
 */
export async function joinGroupChat(
  metabotId: number,
  groupId: string,
  opts?: JoinGroupChatOptions
): Promise<{ pinId: string }> {
  const body = {
    groupId,
    state: 1,
    referrer: opts?.referrer ?? '',
    k: '',
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupjoin',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  }, { feeRate: getGlobalFeeRate('mvc'), origin: 'internal:group-chat' });
  return { pinId: result.pinId };
}

/**
 * Remove a member from a group on-chain (/protocols/simplegroupremoveuser).
 * Only the group creator's signature is honored by the indexer, so callers must
 * pass the chair (group creator) metabot id. `removeMetaid` is the kicked
 * member's legacy MetaID (idchat removeMember convention); body mirrors the
 * SimpleGroupRemoveUser protocol doc
 * (03-group-management.md in the MetaID protocol docs).
 */
export async function removeGroupChatMember(
  metabotId: number,
  groupId: string,
  opts: RemoveGroupChatMemberOptions
): Promise<{ pinId: string }> {
  const body = {
    removeMetaid: opts.removeMetaid,
    groupId,
    reason: opts.reason?.trim() ?? '',
    timestamp: Math.floor(Date.now() / 1000), // idchat uses seconds
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupremoveuser',
    contentType: 'application/json',
    encryption: '0',
    payload: JSON.stringify(body),
  }, { feeRate: getGlobalFeeRate('mvc'), origin: 'internal:group-chat' });
  return { pinId: result.pinId };
}

/**
 * Join a public group chat as the local human user identity (owner). The indexer
 * diverts messages from non-members, so the owner must join every task group to
 * observe and post. Same payload as joinGroupChat, signed via createPinForIdentity.
 */
export async function joinGroupChatAsIdentity(groupId: string): Promise<{ pinId: string }> {
  const identity = getUserIdentity();
  const body = {
    groupId,
    state: 1,
    referrer: '',
    k: '',
  };
  const result = await createPinForIdentityFn({
    mnemonic: identity.mnemonic,
    path: identity.path || undefined,
    metaidData: {
      operation: 'create',
      path: '/protocols/simplegroupjoin',
      contentType: 'application/json',
      payload: JSON.stringify(body),
    },
    options: { feeRate: getGlobalFeeRate('mvc') },
  });
  return { pinId: result.pinId };
}

/**
 * Send an AES-encrypted group message as the local human user identity.
 * Same /protocols/simplegroupchat scheme as sendGroupChatMessage, signed via
 * createPinForIdentity; nickName defaults to the identity display name.
 */
export async function sendGroupChatMessageAsIdentity(
  groupId: string,
  opts: SendGroupChatMessageAsIdentityOptions
): Promise<{ pinId: string }> {
  const identity = getUserIdentity();
  assertNoSecretEgressText(opts.content, {
    channel: 'group_chat_identity',
    extraMnemonics: identity?.mnemonic ? [identity.mnemonic] : undefined,
  });
  const encryptedContent = encryptGroupMessageECB(opts.content, groupId);
  const body = {
    groupId,
    nickName: opts.nickName ?? identity.name ?? '',
    content: encryptedContent,
    contentType: 'text/plain',
    encryption: 'aes',
    timestamp: Date.now(),
    replyPin: opts.replyPin ?? '',
    mention: opts.mention ?? [],
  };
  const result = await createPinForIdentityFn({
    mnemonic: identity.mnemonic,
    path: identity.path || undefined,
    metaidData: {
      operation: 'create',
      path: '/protocols/simplegroupchat',
      contentType: 'application/json',
      payload: JSON.stringify(body),
    },
    options: { feeRate: getGlobalFeeRate('mvc') },
  });
  recordOutgoingGroupSend({ metabotId: -1, groupId, pinId: result.pinId, origin: 'transport:identity' });
  return { pinId: result.pinId };
}

/**
 * Send an AES-encrypted message to a group chat (/protocols/simplegroupchat).
 * Same body as the former inline sender in main.ts, with optional reply/mention.
 */
export async function sendGroupChatMessage(
  metabotId: number,
  groupId: string,
  opts: SendGroupChatMessageOptions
): Promise<{ pinId: string }> {
  let extraMnemonics: string[] | undefined;
  try {
    const store = getMetabotStore();
    const wallet = typeof store?.getMetabotWalletByMetabotId === 'function'
      ? store.getMetabotWalletByMetabotId(metabotId)
      : null;
    if (wallet?.mnemonic?.trim()) {
      extraMnemonics = [wallet.mnemonic.trim()];
    }
  } catch {
    // Best-effort local wallet lookup; global secret registry still applies.
  }
  assertNoSecretEgressText(opts.content, {
    channel: 'group_chat',
    extraMnemonics,
  });
  const encryptedContent = encryptGroupMessageECB(opts.content, groupId);
  const body = {
    groupId,
    nickName: opts.nickName ?? '',
    content: encryptedContent,
    contentType: opts.contentType ?? 'text/plain',
    encryption: 'aes',
    timestamp: Date.now(),
    replyPin: opts.replyPin ?? '',
    mention: opts.mention ?? [],
  };
  const result = await createPin(getMetabotStore(), metabotId, {
    operation: 'create',
    path: '/protocols/simplegroupchat',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  }, { feeRate: getGlobalFeeRate('mvc'), origin: 'internal:group-chat' });
  // R4 single-send ledger: every bot-signed group send is recorded the moment
  // the pin lands so the guest daemon can prove "already sent this turn".
  recordOutgoingGroupSend({ metabotId, groupId, pinId: result.pinId, origin: 'transport' });
  return { pinId: result.pinId };
}

/** True when the group-info envelope carries a real group object for this groupId. */
function isIndexedGroupInfo(json: unknown, groupId: string): boolean {
  if (!json || typeof json !== 'object') return false;
  const envelope = json as { code?: number; data?: unknown };
  if (envelope.code !== 0) return false;
  const data = envelope.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if ('groupId' in record) return record.groupId === groupId;
  return Object.keys(record).length > 0;
}

/** Group creator identity extracted from a group-info record (idchat GroupRoomInfo shape). */
export interface GroupInfoDetails {
  groupId: string;
  createUserMetaId: string;
  createUserGlobalMetaId: string;
}

export type FetchGroupInfoResult =
  | { status: 'found'; info: GroupInfoDetails }
  | { status: 'not_found' }
  | { status: 'error' };

/**
 * Single-endpoint group-info query (injectable via the module fetchFn seam).
 * 'found' carries the group record's creator identity fields; 'not_found'
 * means the indexer answered but has no such group; 'error' means the
 * endpoint itself failed (network/HTTP/JSON). Never throws.
 */
async function fetchGroupInfoOnce(
  endpointBase: string,
  groupId: string,
  timeoutMs: number
): Promise<FetchGroupInfoResult> {
  const url = `${endpointBase}/chat-api/group-chat/group-info?groupId=${encodeURIComponent(groupId)}`;
  let json: unknown;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { status: 'error' };
    json = await response.json();
  } catch {
    return { status: 'error' };
  }
  if (!isIndexedGroupInfo(json, groupId)) return { status: 'not_found' };
  const data = (json as { data: Record<string, unknown> }).data;
  return {
    status: 'found',
    info: {
      groupId:
        typeof data.groupId === 'string' && data.groupId.trim() ? data.groupId.trim() : groupId,
      createUserMetaId:
        typeof data.createUserMetaId === 'string' ? data.createUserMetaId.trim() : '',
      createUserGlobalMetaId:
        typeof data.createUserGlobalMetaId === 'string' ? data.createUserGlobalMetaId.trim() : '',
    },
  };
}

/**
 * Group-info lookup across both indexer endpoints: the first 'found' wins; a
 * definitive 'not_found' from a healthy endpoint is reported when no endpoint
 * found the group; 'error' only when every endpoint failed. Used by the
 * OpenTeam guest flow to verify an invited group really exists and to check
 * the inviter against the group's creator. Never throws.
 */
export async function fetchGroupInfo(
  groupId: string,
  opts?: { timeoutMs?: number }
): Promise<FetchGroupInfoResult> {
  const timeoutMs = Math.max(1_000, opts?.timeoutMs ?? MEMBER_LIST_TIMEOUT_MS);
  let sawNotFound = false;
  for (const endpoint of GROUP_INFO_ENDPOINTS) {
    const result = await fetchGroupInfoOnce(endpoint, groupId, timeoutMs);
    if (result.status === 'found') return result;
    if (result.status === 'not_found') sawNotFound = true;
  }
  return sawNotFound ? { status: 'not_found' } : { status: 'error' };
}

/**
 * Poll the indexer until the newly created group pin is indexed (group-info returns
 * a real group object). Tries both endpoints each round; returns false on timeout.
 * Never throws.
 */
export async function waitForGroupIndexed(
  groupId: string,
  timeoutMs: number = DEFAULT_INDEX_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const endpoint of GROUP_INFO_ENDPOINTS) {
      const result = await fetchGroupInfoOnce(endpoint, groupId, MEMBER_LIST_TIMEOUT_MS);
      if (result.status === 'found') return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(INDEX_POLL_INTERVAL_MS, remaining)));
  }
}

/**
 * Collect every member identity string from a group-member-list `data` payload,
 * tolerantly: entries under data.list / data.admins / data.creator contribute
 * their metaId / globalMetaId, and plain-string entries are collected as-is.
 * Returned strings are raw (trimmed only) — callers do their own matching.
 */
function collectMemberIdentities(data: unknown): string[] {
  const found = new Set<string>();
  const push = (value: unknown): void => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) found.add(text);
  };
  const pushEntry = (entry: unknown): void => {
    if (typeof entry === 'string') {
      push(entry);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    push(record.metaId);
    push(record.globalMetaId);
  };
  if (Array.isArray(data)) {
    data.forEach(pushEntry);
    return [...found];
  }
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.list)) record.list.forEach(pushEntry);
  if (Array.isArray(record.admins)) record.admins.forEach(pushEntry);
  pushEntry(record.creator);
  return [...found];
}

async function fetchGroupMembersOnce(
  endpointBase: string,
  groupId: string,
  timeoutMs: number
): Promise<string[] | null> {
  const url = `${endpointBase}/chat-api/group-chat/group-member-list?groupId=${encodeURIComponent(groupId)}`;
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const json: unknown = await response.json();
    if (!json || typeof json !== 'object') return null;
    const envelope = json as { code?: unknown; data?: unknown };
    if (envelope.code !== 0) return null;
    return collectMemberIdentities(envelope.data);
  } catch {
    return null;
  }
}

/**
 * Thin group-member-list client (OpenTeam join confirmation): returns the raw
 * member identity strings (metaId/globalMetaId forms mixed) or null when both
 * indexer endpoints failed — an empty array is a real, successful empty list.
 * Never throws.
 */
export async function fetchGroupMembers(
  groupId: string,
  opts?: { timeoutMs?: number }
): Promise<string[] | null> {
  const timeoutMs = Math.max(1_000, opts?.timeoutMs ?? MEMBER_LIST_TIMEOUT_MS);
  for (const endpoint of GROUP_INFO_ENDPOINTS) {
    const members = await fetchGroupMembersOnce(endpoint, groupId, timeoutMs);
    if (members) return members;
  }
  return null;
}

/**
 * Poll group-member-list until any of the given identities appears (match is
 * case-insensitive; pass both the globalMetaId and the legacy metaId form when
 * both are known). Returns true on the first hit, false on timeout. Failed
 * fetches simply cost one round. Never throws — same semantics as
 * waitForGroupIndexed.
 */
export async function waitForMemberJoined(
  groupId: string,
  identities: string | string[],
  opts?: { timeoutMs?: number; intervalMs?: number }
): Promise<boolean> {
  const candidates = new Set(
    (Array.isArray(identities) ? identities : [identities])
      .map((value) => String(value ?? '').trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
  if (candidates.size === 0) return false;
  const timeoutMs = Math.max(0, opts?.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS);
  const intervalMs = Math.max(250, opts?.intervalMs ?? INDEX_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const members = await fetchGroupMembers(groupId);
    if (members && members.some((member) => candidates.has(member.trim().toLowerCase()))) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}
