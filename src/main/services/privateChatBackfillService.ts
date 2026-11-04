/**
 * Private chat history backfill: periodically reconciles local
 * private_chat_messages with the MetaSO history API so messages missed by the
 * socket push (disconnects, restarts, app offline) are recovered.
 *
 * Peer discovery combines the server-side conversation directory
 * (latest-chat-info-list, which also reveals brand-new conversations) with
 * locally known peers (stored messages + A2A session mappings). Newly stored
 * rows newer than a per-pair threshold are flagged is_processed = 0 so the
 * private chat daemon picks them up for display and auto-reply; older rows
 * are archived without a reply and reported as archivedPinIds so the host
 * still renders the bubble. A late-indexed message must not vanish just
 * because a newer one already landed.
 *
 * Issue #24: the fixed 15s cadence is now gated by a shared PollBackoffController —
 * consecutive total-failure ticks escalate the retry delay, and after a
 * threshold the circuit opens (attempts paused for a cooldown, then one
 * half-open probe). Scheduled ticks skip cheaply while the gate is closed.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import {
  PrivateChatHistorySyncService,
  storePrivateChatHistoryMessages,
  type PrivateChatHistoryMessage,
} from './privateChatHistorySyncService';
import { PollBackoffController } from './pollBackoffController';

export interface PrivateChatBackfillIdentity {
  metabotId: number;
  globalMetaId: string;
}

export interface PrivateChatBackfillDirectoryEntry {
  peerGlobalMetaId: string;
  lastMessagePinId: string;
  timestamp: number | null;
}

export interface PrivateChatBackfillServiceDeps {
  db: Database;
  saveDb: () => void;
  getLocalIdentities: () => PrivateChatBackfillIdentity[];
  onMessagesStored?: (input: {
    identity: PrivateChatBackfillIdentity;
    peerGlobalMetaID: string;
    inserted: number;
    archivedPinIds: string[];
  }) => void | Promise<void>;
  historySync?: Pick<PrivateChatHistorySyncService, 'fetchRecentConversationMessages'>;
  fetchDirectoryJson?: (url: string) => Promise<unknown>;
  directoryEndpoints?: Array<{ baseUrl: string }>;
  shouldRun?: () => boolean;
  emitLog?: (message: string) => void;
  now?: () => number;
  intervalMs?: number;
  lookback?: number;
  catchUpWindowSec?: number;
  overlapSec?: number;
  localPeerProbeIntervalMs?: number;
  /** Retry-hygiene controller (issue #24); defaults to a local instance. */
  backoff?: PollBackoffController;
}

export interface PrivateChatBackfillSyncResult {
  identities: number;
  probedPeers: number;
  inserted: number;
  failedPeers: number;
  /** Identities whose directory fetch failed this tick (issue #24 signal). */
  failedDirectories: number;
}

export interface PrivateChatBackfillLoop {
  syncOnce(): Promise<PrivateChatBackfillSyncResult>;
  /**
   * One guarded poll tick: consults the backoff gate, runs syncOnce, records
   * the outcome. Test seam for driving the backoff ladder without real
   * timers — the scheduler only times calls to this.
   */
  runTick(): Promise<void>;
  getBackoff(): PollBackoffController;
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_LOOKBACK = 32;
const DEFAULT_CATCH_UP_WINDOW_SEC = 6 * 60 * 60;
const DEFAULT_OVERLAP_SEC = 300;
const DEFAULT_LOCAL_PEER_PROBE_INTERVAL_MS = 60_000;
const DIRECTORY_PAGE_SIZE = 100;
const MILLISECONDS_THRESHOLD_SEC = 1_000_000_000_000;

const DEFAULT_DIRECTORY_ENDPOINTS = [
  { baseUrl: 'https://www.show.now/chat-api/group-chat/user/latest-chat-info-list' },
  { baseUrl: 'https://api.idchat.io/chat-api/group-chat/user/latest-chat-info-list' },
];

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const normalizeEpochSeconds = (value: unknown): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.floor(numeric > MILLISECONDS_THRESHOLD_SEC ? numeric / 1000 : numeric);
};

/**
 * Threshold for flagging freshly stored rows as unprocessed (= daemon work).
 * Known pair: a small overlap behind the latest locally stored timestamp so
 * crossed/late-indexed messages are still picked up. Brand-new pair: only
 * messages inside the catch-up window are treated as live, older history is
 * archived without triggering display or auto-reply.
 */
export function computeUnprocessedAfterTimestampSec(input: {
  latestLocalTimestampSec: number | null;
  nowSec: number;
  catchUpWindowSec?: number;
  overlapSec?: number;
}): number {
  const overlapSec = Math.max(0, Math.trunc(input.overlapSec ?? DEFAULT_OVERLAP_SEC));
  const catchUpWindowSec = Math.max(0, Math.trunc(input.catchUpWindowSec ?? DEFAULT_CATCH_UP_WINDOW_SEC));
  const latest = input.latestLocalTimestampSec;
  if (typeof latest === 'number' && Number.isFinite(latest) && latest > 0) {
    return Math.max(0, Math.trunc(latest) - overlapSec);
  }
  return Math.max(0, Math.trunc(input.nowSec) - catchUpWindowSec);
}

function hasPrivateChatPin(db: Database, pinId: string): boolean {
  const result = db.exec(
    'SELECT 1 AS found FROM private_chat_messages WHERE pin_id = ? LIMIT 1',
    [pinId],
  );
  return Boolean(result[0]?.values?.length);
}

function getLatestLocalPairTimestampSec(
  db: Database,
  localGlobalMetaId: string,
  peerGlobalMetaId: string,
): number | null {
  const result = db.exec(
    `SELECT MAX(chain_timestamp) AS latest
     FROM private_chat_messages
     WHERE (from_global_metaid = ? AND to_global_metaid = ?)
        OR (from_global_metaid = ? AND to_global_metaid = ?)`,
    [localGlobalMetaId, peerGlobalMetaId, peerGlobalMetaId, localGlobalMetaId],
  );
  const value = result[0]?.values?.[0]?.[0];
  return normalizeEpochSeconds(value);
}

function listLocalPrivateChatPeers(
  db: Database,
  identity: PrivateChatBackfillIdentity,
): string[] {
  const peers = new Set<string>();
  const local = identity.globalMetaId;

  const messagePeers = db.exec(
    `SELECT DISTINCT peer FROM (
       SELECT from_global_metaid AS peer FROM private_chat_messages WHERE to_global_metaid = ?
       UNION
       SELECT to_global_metaid AS peer FROM private_chat_messages WHERE from_global_metaid = ?
     ) WHERE peer IS NOT NULL AND TRIM(peer) != ''`,
    [local, local],
  );
  for (const row of messagePeers[0]?.values ?? []) {
    const peer = normalizeRawGlobalMetaId(row?.[0]);
    if (peer && peer !== local) peers.add(peer);
  }

  const mappingPeers = db.exec(
    `SELECT external_conversation_id
     FROM cowork_conversation_mappings
     WHERE channel = 'metaweb_private' AND metabot_id = ?`,
    [identity.metabotId],
  );
  for (const row of mappingPeers[0]?.values ?? []) {
    const raw = toSafeString(row?.[0]);
    const withoutPrefix = raw.startsWith('metaweb-private:')
      ? raw.slice('metaweb-private:'.length)
      : raw;
    const peer = normalizeRawGlobalMetaId(withoutPrefix);
    if (peer && peer !== local) peers.add(peer);
  }

  return [...peers];
}

async function fetchDirectoryPeers(
  deps: PrivateChatBackfillServiceDeps & { fetchJson: (url: string) => Promise<unknown> },
  localGlobalMetaId: string,
): Promise<Map<string, PrivateChatBackfillDirectoryEntry> | null> {
  const endpoints = deps.directoryEndpoints ?? DEFAULT_DIRECTORY_ENDPOINTS;
  const lists = await Promise.all(endpoints.map(async (endpoint) => {
    try {
      const url = new URL(endpoint.baseUrl);
      url.searchParams.set('metaId', localGlobalMetaId);
      url.searchParams.set('size', String(DIRECTORY_PAGE_SIZE));
      url.searchParams.set('cursor', '0');
      const json = await deps.fetchJson(url.toString()) as {
        data?: { list?: unknown[] };
      };
      return Array.isArray(json?.data?.list) ? json.data.list : [];
    } catch {
      return null;
    }
  }));

  if (lists.every((list) => list === null)) {
    return null;
  }

  const merged = new Map<string, PrivateChatBackfillDirectoryEntry>();
  for (const list of lists) {
    for (const item of list ?? []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const record = item as Record<string, unknown>;
      if (toSafeString(record.groupId)) continue;
      const peer = normalizeRawGlobalMetaId(record.globalMetaId);
      if (!peer || peer === localGlobalMetaId) continue;
      const timestamp = normalizeEpochSeconds(record.timestamp);
      const lastMessagePinId = toSafeString(record.lastMessagePinId);
      const existing = merged.get(peer);
      if (!existing || (timestamp ?? 0) > (existing.timestamp ?? 0)) {
        merged.set(peer, { peerGlobalMetaId: peer, lastMessagePinId, timestamp });
      }
    }
  }
  return merged;
}

export function createPrivateChatBackfillLoop(
  deps: PrivateChatBackfillServiceDeps,
): PrivateChatBackfillLoop {
  const intervalMs = Math.max(1_000, Math.trunc(deps.intervalMs ?? DEFAULT_INTERVAL_MS));
  const lookback = Math.max(1, Math.trunc(deps.lookback ?? DEFAULT_LOOKBACK));
  const localPeerProbeIntervalMs = Math.max(
    1_000,
    Math.trunc(deps.localPeerProbeIntervalMs ?? DEFAULT_LOCAL_PEER_PROBE_INTERVAL_MS),
  );
  const now = deps.now ?? (() => Date.now());
  const emitLog = deps.emitLog ?? (() => undefined);
  const historySync = deps.historySync ?? new PrivateChatHistorySyncService();
  const fetchJson = deps.fetchDirectoryJson ?? (async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch private chat directory: ${response.status}`);
    }
    return await response.json() as unknown;
  });

  /** Per-pair throttle for peers the directory cannot tell us about. */
  const lastLocalPeerProbeAt = new Map<string, number>();

  const backoff = deps.backoff ?? new PollBackoffController({
    name: 'private-chat-backfill',
    baseMs: intervalMs,
    emitLog,
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let stopped = true;

  const syncOnce = async (): Promise<PrivateChatBackfillSyncResult> => {
    const result: PrivateChatBackfillSyncResult = {
      identities: 0,
      probedPeers: 0,
      inserted: 0,
      failedPeers: 0,
      failedDirectories: 0,
    };
    if (deps.shouldRun && !deps.shouldRun()) {
      return result;
    }

    const identities = (deps.getLocalIdentities() ?? [])
      .map((identity) => ({
        metabotId: Number(identity?.metabotId),
        globalMetaId: normalizeRawGlobalMetaId(identity?.globalMetaId) ?? '',
      }))
      .filter((identity) => Number.isFinite(identity.metabotId)
        && identity.metabotId > 0
        && Boolean(identity.globalMetaId));
    result.identities = identities.length;

    for (const identity of identities) {
      const nowMs = now();
      let directory: Map<string, PrivateChatBackfillDirectoryEntry> | null = null;
      try {
        directory = await fetchDirectoryPeers({ ...deps, fetchJson }, identity.globalMetaId);
      } catch (error) {
        emitLog(`[PrivateChatBackfill] Directory fetch failed for ${identity.globalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`);
      }
      // fetchDirectoryPeers answers null when EVERY endpoint failed (it never
      // throws for network failure) — the honest total-outage signal (issue #24).
      if (directory === null) {
        result.failedDirectories += 1;
      }

      const probePeers = new Set<string>();
      if (directory) {
        for (const entry of directory.values()) {
          if (entry.lastMessagePinId && !hasPrivateChatPin(deps.db, entry.lastMessagePinId)) {
            probePeers.add(entry.peerGlobalMetaId);
          }
        }
      }

      let localPeers: string[] = [];
      try {
        localPeers = listLocalPrivateChatPeers(deps.db, identity);
      } catch (error) {
        emitLog(`[PrivateChatBackfill] Local peer lookup failed for ${identity.globalMetaId.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const peer of localPeers) {
        if (probePeers.has(peer)) continue;
        const directoryEntry = directory?.get(peer);
        const directoryFresh = Boolean(directoryEntry)
          && (!directoryEntry!.lastMessagePinId || hasPrivateChatPin(deps.db, directoryEntry!.lastMessagePinId));
        if (directoryFresh) continue;
        const throttleKey = `${identity.globalMetaId}|${peer}`;
        const lastProbeAt = lastLocalPeerProbeAt.get(throttleKey) ?? 0;
        if (nowMs - lastProbeAt < localPeerProbeIntervalMs) continue;
        lastLocalPeerProbeAt.set(throttleKey, nowMs);
        probePeers.add(peer);
      }

      for (const peer of probePeers) {
        result.probedPeers += 1;
        try {
          const messages = (await historySync.fetchRecentConversationMessages({
            metaId: identity.globalMetaId,
            otherMetaId: peer,
            lookback,
          })).map((message: PrivateChatHistoryMessage) => ({
            ...message,
            timestamp: normalizeEpochSeconds(message.timestamp),
          }));
          if (messages.length === 0) continue;

          const latestLocalTimestampSec = getLatestLocalPairTimestampSec(
            deps.db,
            identity.globalMetaId,
            peer,
          );
          const unprocessedAfterTimestampSec = computeUnprocessedAfterTimestampSec({
            latestLocalTimestampSec,
            nowSec: Math.floor(now() / 1000),
            catchUpWindowSec: deps.catchUpWindowSec,
            overlapSec: deps.overlapSec,
          });
          const stored = storePrivateChatHistoryMessages({
            db: deps.db,
            saveDb: deps.saveDb,
            messages,
            unprocessedAfterTimestampSec,
          });
          result.inserted += stored.inserted;
          try {
            await deps.onMessagesStored?.({
              identity,
              peerGlobalMetaID: peer,
              inserted: stored.inserted,
              archivedPinIds: stored.archivedPinIds,
            });
          } catch (error) {
            emitLog(`[PrivateChatBackfill] Experience reconciliation failed for ${peer.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (stored.inserted > 0) {
            emitLog(`[PrivateChatBackfill] Recovered ${stored.inserted} private chat message(s) for ${identity.globalMetaId.slice(0, 12)}… ↔ ${peer.slice(0, 12)}…`);
          }
        } catch (error) {
          result.failedPeers += 1;
          emitLog(`[PrivateChatBackfill] Peer sync failed for ${peer.slice(0, 12)}…: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return result;
  };

  /**
   * Issue #24: a tick is a retry-worthy failure only when EVERY attempted
   * network unit failed — every identity's directory fetch AND every probed
   * peer (the hard-outage shape). Partial success means the network is at
   * least partly alive, so the ladder resets. A tick with no identities
   * attempted nothing and keeps the current state.
   */
  const recordTickOutcome = (result: PrivateChatBackfillSyncResult): void => {
    if (result.identities === 0) return;
    const attempted = result.identities + result.probedPeers;
    const failed = result.failedDirectories + result.failedPeers;
    if (failed === attempted) {
      backoff.recordFailure();
    } else {
      backoff.recordSuccess();
    }
  };

  const runTick = async (): Promise<void> => {
    if (syncing) return;
    if (!backoff.ready()) return; // circuit open / ladder delay — skip this attempt
    syncing = true;
    try {
      const result = await syncOnce();
      recordTickOutcome(result);
    } catch (error) {
      emitLog(`[PrivateChatBackfill] Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      backoff.recordFailure();
    } finally {
      syncing = false;
    }
  };

  const scheduledTick = (): void => {
    timer = null;
    void runTick().finally(() => {
      if (stopped) return; // stop() ran while the tick was in flight
      scheduleNext(backoff.nextDelayMs());
    });
  };

  const scheduleNext = (delayMs: number): void => {
    timer = setTimeout(scheduledTick, Math.max(0, delayMs));
    timer.unref?.();
  };

  return {
    syncOnce,
    runTick,
    getBackoff: () => backoff,
    start() {
      if (!stopped) return;
      stopped = false;
      scheduledTick(); // immediate first sync, then self-rescheduling
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    isRunning() {
      return !stopped;
    },
  };
}

let activeBackfillLoop: PrivateChatBackfillLoop | null = null;

export function startPrivateChatBackfill(deps: PrivateChatBackfillServiceDeps): void {
  stopPrivateChatBackfill();
  activeBackfillLoop = createPrivateChatBackfillLoop(deps);
  activeBackfillLoop.start();
}

export function stopPrivateChatBackfill(): void {
  activeBackfillLoop?.stop();
  activeBackfillLoop = null;
}

export function isPrivateChatBackfillRunning(): boolean {
  return Boolean(activeBackfillLoop?.isRunning());
}
