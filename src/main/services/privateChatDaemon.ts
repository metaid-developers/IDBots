/**
 * Private Chat Daemon: process unprocessed private_chat_messages.
 * Decrypts with ECDH, intercepts ping/pong (MetaSwarm handshake), otherwise LLM reply + encrypt + broadcast.
 * SDD Task 14: encrypted private chat daemon and MetaSwarm handshake.
 */

import type { Database } from 'sql.js';
import { getPrivateKeyBufferForEcdh } from './metabotWalletService';
import {
  computeEcdhSharedSecret,
  ecdhDecrypt,
  ecdhEncrypt,
} from './metaWebCrypto';
import { performChatCompletionForOrchestrator } from './cognitiveChatCompletion';
import type { MetabotStore } from '../metabotStore';
import type { MetaidDataPayload } from './metaidCore';

const POLL_INTERVAL_MS = 5_000;

export interface PrivateChatMessageRow {
  id: number;
  pin_id: string;
  from_metaid: string;
  from_global_metaid: string | null;
  from_chat_pubkey: string | null;
  to_metaid: string;
  to_global_metaid: string | null;
  content: string | null;
  encryption: string | null;
  reply_pin: string | null;
  [k: string]: unknown;
}

/** (metabotId, body) => create /protocols/simplemsg pin and broadcast */
export type CreatePrivateMsgPinFn = (
  metabotId: number,
  body: { to: string; content: string; replyPin?: string }
) => Promise<{ txid?: string }>;

type SaveDbFn = () => void;

/** In-flight task keys to avoid duplicate processing */
const thinkingTasks = new Set<string>();

function parsePrivateChatRows(db: Database): PrivateChatMessageRow[] {
  const result = db.exec(
    `SELECT id, pin_id, from_metaid, from_global_metaid, from_chat_pubkey, to_metaid, to_global_metaid, content, encryption, reply_pin
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

function markProcessed(db: Database, id: number, saveDb: SaveDbFn): void {
  db.run('UPDATE private_chat_messages SET is_processed = 1 WHERE id = ?', [id]);
  saveDb();
}

function buildPrivateMsgPayload(to: string, encryptedContent: string, replyPin = ''): string {
  const body = {
    to,
    timestamp: Math.floor(Date.now() / 1000),
    content: encryptedContent,
    contentType: 'text/plain',
    encrypt: 'ecdh',
    replyPin: replyPin || '',
  };
  return JSON.stringify(body);
}

async function processOne(
  row: PrivateChatMessageRow,
  db: Database,
  saveDb: SaveDbFn,
  metabotStore: MetabotStore,
  createPin: (metabotStore: MetabotStore, metabot_id: number, payload: MetaidDataPayload) => Promise<{ txids: string[] }>,
  performChat: (systemPrompt: string, userMessage: string, llmId?: string | null) => Promise<string>,
  emitLog: (msg: string) => void
): Promise<void> {
  const taskKey = row.pin_id;
  if (thinkingTasks.has(taskKey)) return;
  thinkingTasks.add(taskKey);
  try {
    const toGlobalMetaId = (row.to_global_metaid ?? row.to_metaid ?? '').trim();
    if (!toGlobalMetaId) {
      emitLog(`[PrivateChat] Skip message ${row.id}: no to_global_metaid`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const metabot = metabotStore.getMetabotByGlobalMetaId(toGlobalMetaId);
    if (!metabot) {
      emitLog(`[PrivateChat] Skip message ${row.id}: no MetaBot for to_global_metaid ${toGlobalMetaId.slice(0, 12)}…`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const wallet = metabotStore.getMetabotWalletByMetabotId(metabot.id);
    if (!wallet?.mnemonic?.trim()) {
      emitLog(`[PrivateChat] Skip message ${row.id}: MetaBot ${metabot.name} has no wallet`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const fromChatPubkey = (row.from_chat_pubkey ?? '').trim();
    if (!fromChatPubkey) {
      emitLog(`[PrivateChat] Skip message ${row.id}: no from_chat_pubkey`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    let privateKeyBuffer: Buffer;
    try {
      privateKeyBuffer = await getPrivateKeyBufferForEcdh(wallet.mnemonic, wallet.path ?? "m/44'/10001'/0'/0/0");
    } catch (e) {
      emitLog(`[PrivateChat] Skip message ${row.id}: getPrivateKeyBufferForEcdh failed: ${e instanceof Error ? e.message : e}`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const sharedSecret = computeEcdhSharedSecret(privateKeyBuffer, fromChatPubkey);
    emitLog(`[PrivateChat] Decrypt: from_chat_pubkey (first/last 16 hex)=${(fromChatPubkey ?? '').slice(0, 16)}...${(fromChatPubkey ?? '').slice(-16)} sharedSecret (first/last 16 hex)=${sharedSecret.slice(0, 16)}...${sharedSecret.slice(-16)}`);
    const cipherText = (row.content ?? '').trim();
    if (!cipherText) {
      markProcessed(db, row.id, saveDb);
      return;
    }

    let plaintext: string;
    try {
      plaintext = ecdhDecrypt(cipherText, sharedSecret);
    } catch {
      plaintext = '';
    }
    if (plaintext === cipherText || (plaintext.length < 2 && cipherText.length > 20)) {
      emitLog(`[PrivateChat] Skip message ${row.id}: decrypt failed or unchanged`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const normalized = plaintext.trim().toLowerCase();
    const fromGlobalMetaId = (row.from_global_metaid ?? row.from_metaid ?? '').trim();

    if (normalized === 'ping') {
      const encryptedPong = ecdhEncrypt('pong', sharedSecret);
      emitLog(`[PrivateChat] Encrypt ping->pong: plaintext="pong" sharedSecretLen=${sharedSecret.length} encryptedLen=${encryptedPong.length} encryptedPrefix=${encryptedPong.slice(0, 40)}...`);
      const payloadStr = buildPrivateMsgPayload(fromGlobalMetaId, encryptedPong, row.reply_pin ?? '');
      try {
        await createPin(metabotStore, metabot.id, {
          operation: 'create',
          path: '/protocols/simplemsg',
          encryption: '0',
          version: '1.0.0',
          contentType: 'application/json',
          payload: payloadStr,
        });
        emitLog(`[PrivateChat] Ping -> Pong to ${fromGlobalMetaId.slice(0, 12)}…`);
      } catch (e) {
        emitLog(`[PrivateChat] Failed to send pong: ${e instanceof Error ? e.message : e}`);
      }
      markProcessed(db, row.id, saveDb);
      return;
    }

    if (normalized === 'pong') {
      markProcessed(db, row.id, saveDb);
      return;
    }

    const systemPrompt = `You are ${metabot.name}, a private-chat MetaBot. ${metabot.role || ''} ${metabot.soul || ''}. Reply concisely and in character.`;
    let reply: string;
    try {
      reply = await performChat(systemPrompt, plaintext, metabot.llm_id ?? null);
    } catch (e) {
      emitLog(`[PrivateChat] LLM failed for message ${row.id}: ${e instanceof Error ? e.message : e}`);
      markProcessed(db, row.id, saveDb);
      return;
    }

    const trimmed = (reply ?? '').trim();
    if (!trimmed) {
      markProcessed(db, row.id, saveDb);
      return;
    }

    const encryptedReply = ecdhEncrypt(trimmed, sharedSecret);
    emitLog(`[PrivateChat] Encrypt reply: plaintextLen=${trimmed.length} sharedSecretLen=${sharedSecret.length} encryptedLen=${encryptedReply.length} encryptedPrefix=${encryptedReply.slice(0, 40)}...`);
    const payloadStr = buildPrivateMsgPayload(fromGlobalMetaId, encryptedReply, row.reply_pin ?? '');
    try {
      await createPin(metabotStore, metabot.id, {
        operation: 'create',
        path: '/protocols/simplemsg',
        encryption: '0',
        version: '1.0.0',
        contentType: 'application/json',
        payload: payloadStr,
      });
      emitLog(`[PrivateChat] Replied to ${fromGlobalMetaId.slice(0, 12)}…`);
    } catch (e) {
      emitLog(`[PrivateChat] Failed to broadcast reply: ${e instanceof Error ? e.message : e}`);
    }
    markProcessed(db, row.id, saveDb);
  } finally {
    thinkingTasks.delete(taskKey);
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startPrivateChatDaemon(
  db: Database,
  saveDb: SaveDbFn,
  metabotStore: MetabotStore,
  createPin: (metabotStore: MetabotStore, metabot_id: number, payload: MetaidDataPayload) => Promise<{ txids: string[] }>,
  emitLog: (msg: string) => void
): void {
  stopPrivateChatDaemon();
  const performChat = performChatCompletionForOrchestrator;
  const tick = () => {
    const rows = parsePrivateChatRows(db);
    for (const row of rows) {
      processOne(row, db, saveDb, metabotStore, createPin, performChat, emitLog).catch((e) => {
        console.error('[PrivateChat] processOne error:', e);
      });
    }
  };
  pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  tick();
  emitLog('[PrivateChat] Daemon started.');
}

export function stopPrivateChatDaemon(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  thinkingTasks.clear();
}
