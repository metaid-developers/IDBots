/**
 * Restore private-chat bubbles that reached private_chat_messages and were
 * marked processed without ever landing in the local MetaBot's A2A transcript.
 *
 * Two ways that happens:
 * - History backfill archives a late-indexed row (older than the pair's
 *   overlap window) as is_processed = 1 so it will not auto-reply. That used
 *   to also skip display, so the peer's window had the message and this one
 *   did not.
 * - Older daemon builds marked a burst or a "bye" processed before appending
 *   the bubble. Those rows stay processed forever, so a later build never
 *   retries them.
 *
 * This pass only inserts the missing bubble. It does not run a reply turn.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type { CoworkMessage, CoworkStore } from '../coworkStore';
import { buildA2AChainMetadata } from './a2aChainMetadata';
import { buildCanonicalPrivateConversationExternalConversationId } from './simplemsgPeerConversation';

/** Recent enough that a missing bubble is still a live conversation hole. */
export const PRIVATE_CHAT_DISPLAY_RECONCILE_LOOKBACK_SEC = 60 * 24 * 60 * 60;

const MILLISECONDS_THRESHOLD_SEC = 1_000_000_000_000;

export interface PrivateChatDisplayIdentity {
  metabotId: number;
  globalMetaId: string;
}

type ReconcileStore = Pick<CoworkStore, 'listA2AConversationEpisodes' | 'insertHistoricalCoworkMessage'>;

interface PrivateChatDisplayRow {
  pin_id: string;
  tx_id: string | null;
  from_global_metaid: string | null;
  to_global_metaid: string | null;
  from_name: string | null;
  from_avatar: string | null;
  content: string | null;
  chain_timestamp: number | string | null;
}

export function isPrivateChatDisplayCiphertext(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('U2FsdGVkX1')) return true;
  if (/^[0-9a-fA-F]{32,}$/.test(trimmed) && trimmed.length % 2 === 0) return true;
  return false;
}

/**
 * Rows the daemon deliberately consumes WITHOUT a display bubble must never be
 * resurrected by this pass (pre-release review P1): handshake pings/pongs are
 * answered silently (privateChatDaemon marks them processed with no append,
 * and the listener already stores the DECRYPTED text, so plaintext "ping"
 * passes the ciphertext filter), and order-protocol payloads ([ORDER],
 * [DELIVERY], [ORDER_STATUS], [NeedsRating]) route into their own
 * metaweb_order sessions — their pins never appear in this transcript, so
 * without the filter the reconcile re-inserted raw protocol text into the
 * private chat. Handshake matching mirrors the daemon's
 * isPrivateChatHandshakePlaintext (letters-only normalize, ping/pong); kept
 * local to avoid a privateChatDaemon import cycle.
 */
function isProtocolRowWithoutDisplay(content: string): boolean {
  const trimmed = content.trim();
  const handshakeWord = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  if (handshakeWord === 'ping' || handshakeWord === 'pong') return true;
  return /^\[(ORDER|DELIVERY|ORDER_STATUS|NeedsRating)/i.test(trimmed);
}

function chainTimestampMs(value: number | string | null): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric > MILLISECONDS_THRESHOLD_SEC ? numeric : numeric * 1000);
}

function rowsOf<T>(db: Database, sql: string, params: unknown[] = []): T[] {
  const result = db.exec(sql, params);
  const columns = result[0]?.columns ?? [];
  return (result[0]?.values ?? []).map((values) =>
    Object.fromEntries(columns.map((column, index) => [column, values[index]])) as T,
  );
}

function episodeSessionForTime(
  episodes: Array<{ sessionId: string; startedAt: number; endedAt: number | null }>,
  chainMs: number,
  fallbackSessionId: string,
): string {
  if (episodes.length === 0) return fallbackSessionId;
  const containing = episodes.find((episode) => (
    episode.startedAt <= chainMs
    && (episode.endedAt == null || episode.endedAt >= chainMs)
  ));
  if (containing) return containing.sessionId;
  const earliest = episodes[0];
  if (earliest && chainMs < earliest.startedAt) return earliest.sessionId;
  return episodes[episodes.length - 1]?.sessionId || fallbackSessionId;
}

function collectThreadPinIds(db: Database, sessionIds: string[]): Set<string> {
  const pins = new Set<string>();
  if (sessionIds.length === 0) return pins;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const found = rowsOf<{ pin: string | null }>(
    db,
    `SELECT json_extract(metadata, '$.pinId') AS pin
     FROM cowork_messages
     WHERE session_id IN (${placeholders})
       AND json_extract(metadata, '$.pinId') IS NOT NULL`,
    sessionIds,
  );
  for (const row of found) {
    const pin = String(row.pin ?? '').trim();
    if (pin) pins.add(pin);
  }
  return pins;
}

function insertMissingBubble(input: {
  coworkStore: ReconcileStore;
  sessionId: string;
  externalConversationId: string;
  direction: 'incoming' | 'outgoing';
  row: PrivateChatDisplayRow;
  content: string;
  chainMs: number;
}): CoworkMessage | null {
  const chain = buildA2AChainMetadata({
    txId: input.row.tx_id,
    pinId: input.row.pin_id,
  });
  const incoming = input.direction === 'incoming';
  return input.coworkStore.insertHistoricalCoworkMessage(input.sessionId, {
    type: incoming ? 'user' : 'assistant',
    content: input.content,
    timestamp: input.chainMs,
    metadata: {
      sourceChannel: 'metaweb_private',
      externalConversationId: input.externalConversationId,
      direction: input.direction,
      simplemsgKind: 'private_chat',
      privateChatDisplayReconciled: true,
      ...chain,
      ...(incoming ? {
        senderGlobalMetaId: input.row.from_global_metaid ?? undefined,
        senderName: input.row.from_name ?? undefined,
        senderAvatar: input.row.from_avatar ?? undefined,
        suppressRunningStatus: true,
      } : {}),
    },
  });
}

export function reconcilePrivateChatDisplayGaps(input: {
  db: Database;
  coworkStore: ReconcileStore;
  identities: PrivateChatDisplayIdentity[];
  nowSec?: number;
  lookbackSec?: number;
  onlyMetabotId?: number;
  onlyPeerGlobalMetaId?: string;
  emitLog?: (message: string) => void;
}): { inserted: number } {
  const nowSec = Math.floor(input.nowSec ?? Date.now() / 1000);
  const lookbackSec = Math.max(0, Math.floor(input.lookbackSec ?? PRIVATE_CHAT_DISPLAY_RECONCILE_LOOKBACK_SEC));
  const sinceSec = Math.max(0, nowSec - lookbackSec);
  const peerFilter = String(input.onlyPeerGlobalMetaId ?? '').trim();
  let inserted = 0;

  for (const identity of input.identities) {
    const metabotId = Number(identity.metabotId);
    const localGlobalMetaId = String(identity.globalMetaId ?? '').trim();
    if (!Number.isFinite(metabotId) || metabotId <= 0 || !localGlobalMetaId) continue;
    if (input.onlyMetabotId != null && metabotId !== input.onlyMetabotId) continue;

    const mappings = rowsOf<{ cowork_session_id: string; external_conversation_id: string }>(
      input.db,
      `SELECT cowork_session_id, external_conversation_id
       FROM cowork_conversation_mappings
       WHERE channel = 'metaweb_private' AND metabot_id = ?`,
      [metabotId],
    );

    for (const mapping of mappings) {
      const externalConversationId = String(mapping.external_conversation_id ?? '').trim();
      const peerGlobalMetaId = externalConversationId.startsWith('metaweb-private:')
        ? externalConversationId.slice('metaweb-private:'.length).trim()
        : '';
      const sessionId = String(mapping.cowork_session_id ?? '').trim();
      if (!peerGlobalMetaId || peerGlobalMetaId === localGlobalMetaId || !sessionId) continue;
      if (peerFilter && peerGlobalMetaId !== peerFilter) continue;

      const episodes = input.coworkStore.listA2AConversationEpisodes(sessionId);
      const sessionIds = episodes.length > 0
        ? episodes.map((episode) => episode.sessionId)
        : [sessionId];
      const knownPins = collectThreadPinIds(input.db, sessionIds);
      const canonicalExternalId = buildCanonicalPrivateConversationExternalConversationId(peerGlobalMetaId);

      const chatRows = rowsOf<PrivateChatDisplayRow>(
        input.db,
        `SELECT pin_id, tx_id, from_global_metaid, to_global_metaid, from_name, from_avatar, content, chain_timestamp
         FROM private_chat_messages
         WHERE is_processed = 1
           AND (
             (from_global_metaid = ? AND to_global_metaid = ?)
             OR (from_global_metaid = ? AND to_global_metaid = ?)
           )
           AND chain_timestamp >= ?`,
        [localGlobalMetaId, peerGlobalMetaId, peerGlobalMetaId, localGlobalMetaId, sinceSec],
      );

      for (const row of chatRows) {
        const pinId = String(row.pin_id ?? '').trim();
        if (!pinId || knownPins.has(pinId)) continue;
        const content = String(row.content ?? '');
        if (isPrivateChatDisplayCiphertext(content)) continue;
        if (isProtocolRowWithoutDisplay(content)) continue;
        const chainMs = chainTimestampMs(row.chain_timestamp);
        if (chainMs == null) continue;
        const fromGlobalMetaId = String(row.from_global_metaid ?? '').trim();
        const toGlobalMetaId = String(row.to_global_metaid ?? '').trim();
        const direction = fromGlobalMetaId === localGlobalMetaId
          ? 'outgoing'
          : toGlobalMetaId === localGlobalMetaId
            ? 'incoming'
            : null;
        if (!direction) continue;

        const targetSessionId = episodeSessionForTime(episodes, chainMs, sessionId);
        const message = insertMissingBubble({
          coworkStore: input.coworkStore,
          sessionId: targetSessionId,
          externalConversationId: canonicalExternalId,
          direction,
          row,
          content,
          chainMs,
        });
        if (!message) continue;
        knownPins.add(pinId);
        inserted += 1;
      }
    }
  }

  if (inserted > 0) {
    input.emitLog?.(`[PrivateChat] Restored ${inserted} private-chat message(s) missing from the local transcript.`);
  }
  return { inserted };
}
