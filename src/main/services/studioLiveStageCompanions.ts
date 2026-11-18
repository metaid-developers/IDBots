import { markdownToPlainText, type LiveStageGroupThread, type LiveStagePeerThread } from './studioLiveStageModel';

/**
 * Pure status derivation for the Live Stage companion rail (peers + group
 * threads). All functions take plain rows plus `nowMs` — no store access —
 * so they are unit-testable without a database.
 */

/** A2A sessions count as "live" on the rail while they saw activity in the last 10 minutes. */
export const PRIVATE_CHAT_ACTIVE_WINDOW_MS = 10 * 60_000;
/** An incoming peer message reads as "incoming" for 30s. */
export const PRIVATE_CHAT_INCOMING_MS = 30_000;
/** An outgoing message reads as "delivered" for 12s, then falls back to "awaiting". */
export const PRIVATE_CHAT_DELIVERED_MS = 12_000;
/** Group threads count as live while chat or daemon activity is within 30 minutes. */
export const GROUP_THREAD_ACTIVE_WINDOW_MS = 30 * 60_000;
/** The newest group message marks the thread posting/incoming for 20s. */
export const GROUP_POSTING_WINDOW_MS = 20_000;

export const MAX_ACTIVE_PEERS = 4;
export const MAX_ACTIVE_GROUPS = 2;
export const MAX_GROUP_MEMBERS = 8;
export const MAX_GROUP_TITLE = 60;
export const MAX_PEER_PREVIEW = 40;

/** Directional message signal feeding the peer status derivation. */
export type PrivateChatMessageSignal = {
  direction?: 'incoming' | 'outgoing' | null;
  /** Epoch ms of the message. */
  at: number | null;
};

export function derivePrivateChatStatus(input: {
  /** Session row status === 'running' means a reply is in flight. */
  sessionRunning: boolean;
  latest?: PrivateChatMessageSignal | null;
}, nowMs: number): LiveStagePeerThread['status'] {
  if (input.sessionRunning) return 'sending';
  const latest = input.latest;
  if (!latest || latest.at == null
    || (latest.direction !== 'incoming' && latest.direction !== 'outgoing')) {
    return 'open';
  }
  const age = nowMs - latest.at;
  if (latest.direction === 'incoming') {
    return age <= PRIVATE_CHAT_INCOMING_MS ? 'incoming' : 'open';
  }
  return age <= PRIVATE_CHAT_DELIVERED_MS ? 'delivered' : 'awaiting';
}

/** Markdown → plain-text rail preview, ≤40 chars. */
export function privateChatPreview(content: string | null | undefined): string | undefined {
  const plain = markdownToPlainText(content ?? '');
  if (!plain) return undefined;
  return plain.length > MAX_PEER_PREVIEW ? `${plain.slice(0, MAX_PEER_PREVIEW - 1)}…` : plain;
}

/** Latest group-chat message signal feeding the group status derivation. */
export type GroupChatMessageSignal = {
  /** Epoch ms of the message (chain timestamp). */
  at: number | null;
  /** Member id of the sender when known. */
  senderId?: string | null;
  senderIsSelf: boolean;
};

export function deriveGroupThreadStatus(
  latest: GroupChatMessageSignal | null | undefined,
  nowMs: number,
): { status: LiveStageGroupThread['status']; senderId?: string } {
  if (latest?.at != null && nowMs - latest.at <= GROUP_POSTING_WINDOW_MS) {
    if (latest.senderIsSelf) return { status: 'posting' };
    return { status: 'incoming', ...(latest.senderId ? { senderId: latest.senderId } : {}) };
  }
  return { status: 'active' };
}

/** Clip a group thread title to the rail budget. */
export function groupThreadTitle(title: string | null | undefined): string {
  const cleaned = (title ?? '').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_GROUP_TITLE ? cleaned.slice(0, MAX_GROUP_TITLE) : cleaned;
}
