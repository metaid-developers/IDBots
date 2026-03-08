#!/usr/bin/env npx ts-node

import { parseArgs } from 'util';
import fs from 'fs';
import { sendPrivateChat } from './send-privatechat';

interface PayloadInput {
  to?: string;
  toGlobalMetaId?: string;
  content?: string;
  replyPin?: string;
}

function fail(message: string): never {
  process.stderr.write(`[metabot-chat-privatechat] Error: ${message}\n`);
  process.exit(1);
}

function parsePayloadRaw(): string {
  const { values } = parseArgs({
    options: {
      payload: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(
      'Usage: npx ts-node index.ts --payload "{\"to\":\"idq...\",\"content\":\"hello\"}"\n'
    );
    process.exit(0);
  }

  const payload = (values.payload || '').trim();
  if (payload) return payload;

  if (process.stdin.isTTY) {
    fail('pass --payload JSON or pipe JSON to stdin');
  }
  return fs.readFileSync(0, 'utf-8').trim();
}

async function main(): Promise<void> {
  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || !metabotIdStr.trim()) {
    fail('IDBOTS_METABOT_ID is required');
  }
  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (!Number.isFinite(metabotId) || metabotId < 1) {
    fail('IDBOTS_METABOT_ID must be a positive integer');
  }

  const mnemonic = (process.env.IDBOTS_METABOT_MNEMONIC || '').trim();
  if (!mnemonic) {
    fail('IDBOTS_METABOT_MNEMONIC is required');
  }

  const raw = parsePayloadRaw();
  let payload: PayloadInput;
  try {
    payload = JSON.parse(raw) as PayloadInput;
  } catch (error) {
    fail(`invalid payload JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const toGlobalMetaId = String(payload.toGlobalMetaId || payload.to || '').trim();
  const content = String(payload.content || '');
  const replyPin = String(payload.replyPin || '').trim();
  if (!toGlobalMetaId) {
    fail('payload.to or payload.toGlobalMetaId is required');
  }
  if (!content.trim()) {
    fail('payload.content is required');
  }

  const result = await sendPrivateChat({
    toGlobalMetaId,
    content,
    replyPin,
    metabotId,
    mnemonic,
    path: process.env.IDBOTS_METABOT_PATH,
    rpcUrl: process.env.IDBOTS_RPC_URL,
  });

  process.stdout.write(
    JSON.stringify({
      success: true,
      txid: result.txid,
      pinId: result.pinId,
      totalCost: result.totalCost ?? 0,
    }) + '\n'
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
