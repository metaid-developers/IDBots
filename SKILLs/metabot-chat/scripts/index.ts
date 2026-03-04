#!/usr/bin/env npx ts-node
/**
 * metabot-chat skill: submit parsed task params to main process via RPC.
 * Usage: npx ts-node index.ts --payload '<JSON>'
 * Or:    echo '<JSON>' | npx ts-node index.ts
 * JSON must include target_metabot_name and group_id; other fields optional.
 */

import { parseArgs } from 'util';
import * as fs from 'fs';

const RPC_URL = process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200';
const ASSIGN_PATH = '/api/idbots/assign-group-chat-task';

interface TaskParams {
  target_metabot_name: string;
  group_id: string;
  reply_on_mention?: boolean;
  random_reply_probability?: number;
  cooldown_seconds?: number;
  context_message_count?: number;
  discussion_background?: string;
  participation_goal?: string;
  supervisor_metaid?: string;
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

  const url = `${RPC_URL.replace(/\/$/, '')}${ASSIGN_PATH}`;
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
