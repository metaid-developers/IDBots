/**
 * MetaWeb listener service: multi-instance Socket.IO manager and message router.
 * For each MetaBot with globalmetaid, runs a socket; parses push payloads and writes
 * to group_chat_messages, private_chat_messages, protocol_events. Emits logs to renderer.
 */

import type { Database } from 'sql.js';
import { SocketIOClient } from './metaWebSocket';
import { decryptGroupMessage } from './metaWebCrypto';

const SOCKET_URL = 'https://api.idchat.io';
const SOCKET_PATH = '/socket/socket.io';

export interface ListenerConfig {
  groupChats: boolean;
  privateChats: boolean;
  serviceRequests: boolean;
}

export interface MetaBotForListener {
  id: number;
  name: string;
  globalmetaid: string | null;
}

type EmitLogFn = (log: string) => void;

/** In-memory map: globalmetaid -> SocketIOClient */
const activeSockets = new Map<string, SocketIOClient>();

/** Unified chat message shape from idchat.io push (group or private) */
interface UnifiedChatMessage {
  txId?: string;
  pinId?: string;
  groupId?: string;
  metanetId?: string;
  address?: string;
  globalMetaId?: string;
  metaId?: string;
  protocol?: string;
  content?: string;
  contentType?: string;
  encryption?: string;
  chatType?: number;
  timestamp?: number;
  fromGlobalMetaId?: string;
  fromUserInfo?: { chatPublicKey?: string; [k: string]: unknown };
  toGlobalMetaId?: string;
  toUserInfo?: { chatPublicKey?: string; [k: string]: unknown };
  [k: string]: unknown;
}

function isPrivateChatMessage(m: UnifiedChatMessage): boolean {
  return !!(
    m.fromGlobalMetaId &&
    m.fromUserInfo &&
    m.toGlobalMetaId &&
    m.toUserInfo
  );
}

function isGroupChatMessage(m: UnifiedChatMessage): boolean {
  return !!(m.groupId && m.metanetId);
}

function parsePayload(data: unknown): { M?: string; D?: UnifiedChatMessage } | null {
  let raw: string;
  if (typeof data === 'string') {
    raw = data;
  } else if (data != null && typeof (data as Record<string, unknown>).message === 'string') {
    raw = (data as { message: string }).message;
  } else {
    raw = JSON.stringify(data);
  }
  try {
    let wrapper = JSON.parse(raw) as { M?: string; D?: UnifiedChatMessage } | string | unknown[];
    if (typeof wrapper === 'string') {
      wrapper = JSON.parse(wrapper) as { M?: string; D?: UnifiedChatMessage };
    }
    if (Array.isArray(wrapper) && wrapper.length >= 2) {
      const ev = wrapper[0] as string;
      const D = wrapper[1] as UnifiedChatMessage;
      return { M: ev, D };
    }
    if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper)) {
      return wrapper as { M?: string; D?: UnifiedChatMessage };
    }
  } catch {
    // ignore
  }
  return null;
}

function pinIdFromMessage(m: UnifiedChatMessage): string {
  return m.pinId ?? (m.txId ? `${m.txId}i0` : '');
}

type SaveDbFn = () => void;

/**
 * Route and persist one received message; emit log on success.
 * Uses INSERT OR IGNORE for all tables.
 */
function handleReceivedMessage(
  rawMsg: unknown,
  targetGlobalMetaId: string,
  targetName: string,
  db: Database,
  config: ListenerConfig,
  emitLog: EmitLogFn,
  saveDb: SaveDbFn
): void {
  try {
    const parsed = parsePayload(rawMsg);
    if (!parsed?.D) return;

    const { M, D } = parsed;
    const eventType = M;

    // Array form already normalized to { M, D }
    if (eventType === 'WS_SERVER_NOTIFY_GROUP_CHAT' && config.groupChats && isGroupChatMessage(D)) {
      routeGroupChat(D, targetGlobalMetaId, targetName, db, emitLog, saveDb);
      return;
    }
    if (eventType === 'WS_SERVER_NOTIFY_PRIVATE_CHAT' && config.privateChats && isPrivateChatMessage(D)) {
      routePrivateChat(D, targetGlobalMetaId, targetName, db, emitLog, saveDb);
      return;
    }
    if (eventType === 'WS_RESPONSE_SUCCESS' && D && typeof D === 'object') {
      const payload = (D as { data?: UnifiedChatMessage }).data ?? D;
      if (isGroupChatMessage(payload as UnifiedChatMessage) && config.groupChats) {
        routeGroupChat(payload as UnifiedChatMessage, targetGlobalMetaId, targetName, db, emitLog, saveDb);
        return;
      }
      if (isPrivateChatMessage(payload as UnifiedChatMessage) && config.privateChats) {
        routePrivateChat(payload as UnifiedChatMessage, targetGlobalMetaId, targetName, db, emitLog, saveDb);
        return;
      }
    }

    // Route C: protocol_events for /protocols/service-request
    const protocol = (D.protocol ?? (D as { path?: string }).path ?? '') as string;
    if (
      config.serviceRequests &&
      (protocol === '/protocols/service-request' || protocol?.endsWith('service-request'))
    ) {
      routeProtocolEvent(D, targetGlobalMetaId, targetName, db, emitLog, saveDb);
    }
  } catch (err) {
    emitLog(`[MetaWeb] Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function routeGroupChat(
  D: UnifiedChatMessage,
  targetGlobalMetaId: string,
  targetName: string,
  db: Database,
  emitLog: EmitLogFn,
  saveDb: SaveDbFn
): void {
  const groupId = D.groupId ?? '';
  if (!groupId) return;

  const pinId = pinIdFromMessage(D);
  if (!pinId) return;

  const senderMetaid = D.globalMetaId ?? D.metaId ?? D.address ?? '';
  const messageType = String(D.chatType ?? 0);
  let content = D.content ?? '';
  if (D.encryption === 'aes' && (D.chatType === 0 || D.chatType === 1)) {
    const secretKeyStr = groupId.substring(0, 16);
    content = decryptGroupMessage(content, secretKeyStr);
  }

  const content_type = D.contentType ?? '';
  const encryption = D.encryption ?? '0';
  const chain_timestamp = typeof D.timestamp === 'number' ? D.timestamp : null;

  db.run(
    `INSERT OR IGNORE INTO group_chat_messages (
      pin_id, group_id, sender_metaid, message_type, content, content_type, encryption, chain_timestamp, is_processed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [pinId, groupId, senderMetaid, messageType, content, content_type, encryption, chain_timestamp]
  );
  saveDb();

  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  emitLog(`[${timeStr}] 📡 [Target: ${targetName}] Group message from group ${groupId.slice(0, 8)}…`);
}

function routePrivateChat(
  D: UnifiedChatMessage,
  targetGlobalMetaId: string,
  targetName: string,
  db: Database,
  emitLog: EmitLogFn,
  saveDb: SaveDbFn
): void {
  const pinId = pinIdFromMessage(D);
  if (!pinId) return;

  const senderMetaid = D.fromGlobalMetaId ?? '';
  const toMetaid = targetGlobalMetaId;
  const messageType = String(D.chatType ?? 0);
  const content = D.content ?? '';
  const content_type = D.contentType ?? '';
  const encryption = D.encryption ?? 'ecdh';
  const chain_timestamp = typeof D.timestamp === 'number' ? D.timestamp : null;

  db.run(
    `INSERT OR IGNORE INTO private_chat_messages (
      pin_id, sender_metaid, to_metaid, message_type, content, content_type, encryption, chain_timestamp, is_processed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [pinId, senderMetaid, toMetaid, messageType, content, content_type, encryption, chain_timestamp]
  );
  saveDb();

  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  emitLog(`[${timeStr}] 💬 [Target: ${targetName}] Private message from ${senderMetaid.slice(0, 12)}…`);
}

function routeProtocolEvent(
  D: UnifiedChatMessage & Record<string, unknown>,
  targetGlobalMetaId: string,
  targetName: string,
  db: Database,
  emitLog: EmitLogFn,
  saveDb: SaveDbFn
): void {
  const pinId = pinIdFromMessage(D as UnifiedChatMessage) || ((D.txId as string) ?? '');
  if (!pinId) return;

  const txid = (D.txId as string) ?? '';
  const protocol_path = (D.protocol as string) ?? '/protocols/service-request';
  const sender_metaid = (D.fromGlobalMetaId ?? D.globalMetaId ?? D.metaId ?? D.address ?? '') as string;
  const target_metaid = (D.toGlobalMetaId ?? targetGlobalMetaId) as string;
  const payload = JSON.stringify(D);

  db.run(
    `INSERT OR IGNORE INTO protocol_events (
      pin_id, txid, protocol_path, sender_metaid, target_metaid, payload, status, error_msg
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`,
    [pinId, txid, protocol_path, sender_metaid, target_metaid, payload]
  );
  saveDb();

  const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  emitLog(`[${timeStr}] 💰 [Target: ${targetName}] Service request (${protocol_path})`);
}

/**
 * Start MetaWeb listener: one socket per MetaBot with globalmetaid.
 * Persists to db, respects config, and sends logs via emitLog.
 */
export function startMetaWebListener(
  db: Database,
  getMetaBots: () => MetaBotForListener[],
  config: ListenerConfig,
  emitLog: EmitLogFn,
  saveDb: SaveDbFn
): void {
  stopMetaWebListener();

  const bots = getMetaBots().filter((b) => b.globalmetaid && b.globalmetaid.trim());
  if (bots.length === 0) {
    emitLog('[MetaWeb] No MetaBots with globalmetaid; listener not started.');
    return;
  }

  for (const bot of bots) {
    const metaid = bot.globalmetaid!.trim();
    const name = bot.name || metaid.slice(0, 12);
    const handler = (data: unknown) => {
      handleReceivedMessage(data, metaid, name, db, config, emitLog, saveDb);
    };
    const client = new SocketIOClient(
      {
        url: SOCKET_URL,
        path: SOCKET_PATH,
        metaid,
        type: 'pc',
      },
      handler
    );
    activeSockets.set(metaid, client);
    client.connect();
  }

  emitLog(`[MetaWeb] Listener started for ${bots.length} MetaBot(s).`);
}

/**
 * Disconnect all sockets and clear the map.
 */
export function stopMetaWebListener(): void {
  for (const client of activeSockets.values()) {
    client.disconnect();
  }
  activeSockets.clear();
}

export function isListenerRunning(): boolean {
  return activeSockets.size > 0;
}
