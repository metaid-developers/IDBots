#!/usr/bin/env node
/**
 * metabot-chat-groupchat skill: group chat actions via local RPC.
 * Usage: node index.js --payload '<JSON>'
 * Or:    echo '<JSON>' | node index.js
 *
 * action:
 *   - orchestrate (default): assign local group_chat_tasks (reply / random reply).
 *   - join_group: chain SimpleGroupJoin (/protocols/simplegroupjoin).
 *   - send_group_message: chain SimpleGroupChat (/protocols/simplegroupchat), AES encrypts content like omni-caster.
 */

import { parseArgs } from 'util';
import * as fs from 'fs';
import { createCipheriv } from 'crypto';

const RPC_URL = process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200';
const ASSIGN_PATH = '/api/idbots/assign-group-chat-task';
const RESOLVE_PATH = '/api/idbots/resolve-metabot-id';
const CREATE_PIN_PATH = '/api/metaid/create-pin';

type GroupChatAction = 'orchestrate' | 'join_group' | 'send_group_message';

interface BaseParams {
  target_metabot_name: string;
  group_id: string;
  /** Default orchestrate. Use join_group / send_group_message for on-chain join or one-shot message. */
  action?: GroupChatAction;
  /** mvc | doge | btc */
  network?: string;
}

interface OrchestrateParams extends BaseParams {
  action?: 'orchestrate';
  reply_on_mention?: boolean;
  random_reply_probability?: number;
  cooldown_seconds?: number;
  context_message_count?: number;
  discussion_background?: string;
  participation_goal?: string;
  supervisor_globalmetaid?: string;
  allowed_skills?: string[] | string | null;
  original_prompt?: string | null;
}

interface JoinGroupParams extends BaseParams {
  action: 'join_group';
  /** SimpleGroupJoin: invitee MetaID; omit or empty for public groups. */
  referrer?: string;
  /** SimpleGroupJoin: encrypted key for private groups. */
  k?: string;
}

interface SendGroupMessageParams extends BaseParams {
  action: 'send_group_message';
  /** Plain text; encrypted before broadcast (same rules as metabot-omni-caster). */
  message_plaintext: string;
  /** Overrides MetaBot display name in the protocol payload. */
  nick_name?: string;
  reply_pin?: string;
  channel_id?: string;
  mention?: string[];
}

type TaskParams = OrchestrateParams | JoinGroupParams | SendGroupMessageParams;

function groupIdToSecretKey(groupId: string): string {
  const normalized = String(groupId ?? '').trim();
  if (normalized.length >= 16) {
    return normalized.slice(0, 16);
  }
  return normalized.padEnd(16, '0');
}

/** Matches SKILLs/metabot-omni-caster/scripts/omni-caster.js (AES-128-CBC, iv 000...) */
function encryptSimpleGroupChatContent(message: string, groupId: string): string {
  const secretKey = groupIdToSecretKey(groupId);
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(secretKey, 'utf8'), Buffer.from('0000000000000000', 'utf8'));
  const encrypted = Buffer.concat([cipher.update(String(message ?? ''), 'utf8'), cipher.final()]);
  return encrypted.toString('hex');
}

function parsePayload(): string {
  const { values } = parseArgs({
    options: { payload: { type: 'string', short: 'p' } },
    allowPositionals: true,
  });
  const payload = (values as { payload?: string }).payload;
  if (payload != null && payload.trim() !== '') {
    return payload.trim();
  }
  if (process.stdin.isTTY) {
    console.error('Error: pass --payload "<JSON>" or pipe JSON to stdin');
    process.exit(1);
  }
  return fs.readFileSync(0, 'utf-8').trim();
}

async function resolveMetabot(base: string, name: string): Promise<{ metabot_id: number; display_name: string }> {
  const url = `${base}${RESOLVE_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim() }),
  });
  const result = (await res.json()) as {
    success: boolean;
    metabot_id?: number;
    display_name?: string;
    error?: string;
  };
  if (!res.ok || !result.success || result.metabot_id == null) {
    console.error(result.error ?? 'MetaBot not found');
    process.exit(1);
  }
  return {
    metabot_id: result.metabot_id,
    display_name: result.display_name?.trim() || name.trim(),
  };
}

async function runCreatePin(
  base: string,
  metabotId: number,
  path: string,
  payloadObj: Record<string, unknown>,
  network: string
): Promise<void> {
  const url = `${base}${CREATE_PIN_PATH}`;
  const metaidData = {
    operation: 'create',
    path,
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify(payloadObj),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: metabotId, network, metaidData }),
  });
  const json = (await res.json()) as {
    success?: boolean;
    error?: string;
    txid?: string;
    txids?: string[];
    pinId?: string;
    totalCost?: number;
  };
  if (!json.success) {
    console.error('Request failed:', json.error ?? 'Unknown error');
    process.exit(1);
  }
  const txid = json.txid ?? json.txids?.[0] ?? '';
  const pinId = json.pinId ?? `${txid}i0`;
  console.log(JSON.stringify({ txid, pinId }));
  if (typeof json.totalCost === 'number') {
    console.error(`Cost: ${json.totalCost} satoshis`);
  }
}

async function main(): Promise<void> {
  const raw = parsePayload();
  let params: TaskParams;
  try {
    params = JSON.parse(raw) as TaskParams;
  } catch (e) {
    console.error('Error: invalid JSON', e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (!params.target_metabot_name?.trim()) {
    console.error('Error: target_metabot_name is required');
    process.exit(1);
  }
  if (!params.group_id?.trim()) {
    console.error('Error: group_id is required');
    process.exit(1);
  }

  const base = RPC_URL.replace(/\/$/, '');
  const action: GroupChatAction = params.action ?? 'orchestrate';
  const networkRaw = params.network?.toLowerCase?.()?.trim() ?? '';
  const network = networkRaw === 'doge' || networkRaw === 'btc' ? networkRaw : 'mvc';

  if (action === 'orchestrate') {
    const url = `${base}${ASSIGN_PATH}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

    const result = (await res.json()) as { success: boolean; message?: string; error?: string };
    if (!res.ok) {
      console.error('RPC error:', result.error ?? res.statusText);
      process.exit(1);
    }
    if (!result.success) {
      console.error(result.error ?? 'Unknown error');
      process.exit(1);
    }
    console.log(result.message ?? 'Success! Task assigned.');
    return;
  }

  const { metabot_id: metabotId, display_name: displayName } = await resolveMetabot(base, params.target_metabot_name);
  const groupId = params.group_id.trim();

  if (action === 'join_group') {
    const p = params as JoinGroupParams;
    const joinPayload: Record<string, unknown> = {
      groupId,
      state: 1,
    };
    const ref = p.referrer?.trim();
    if (ref) joinPayload.referrer = ref;
    const k = p.k?.trim();
    if (k) joinPayload.k = k;

    await runCreatePin(base, metabotId, '/protocols/simplegroupjoin', joinPayload, network);
    return;
  }

  if (action === 'send_group_message') {
    const p = params as SendGroupMessageParams;
    const plain = p.message_plaintext;
    if (plain == null || String(plain).trim() === '') {
      console.error('Error: message_plaintext is required for send_group_message');
      process.exit(1);
    }
    const nickName = p.nick_name?.trim() || displayName;
    const encryptedContent = encryptSimpleGroupChatContent(String(plain), groupId);
    const chatPayload: Record<string, unknown> = {
      groupId,
      nickName,
      content: encryptedContent,
      contentType: 'text/plain',
      encryption: 'aes',
      timestamp: Date.now(),
    };
    if (p.reply_pin?.trim()) chatPayload.replyPin = p.reply_pin.trim();
    if (p.channel_id?.trim()) chatPayload.channelId = p.channel_id.trim();
    if (Array.isArray(p.mention) && p.mention.length) chatPayload.mention = p.mention;

    await runCreatePin(base, metabotId, '/protocols/simplegroupchat', chatPayload, network);
    return;
  }

  console.error('Error: unknown action');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
