#!/usr/bin/env npx ts-node
/**
 * MetaBot Omni-Caster: Universal MetaID protocol gateway.
 * Accepts path and payload from CLI, builds MetaID 7-tuple, and sends to local RPC.
 *
 * Usage:
 *   IDBOTS_METABOT_ID=1 npx ts-node omni-caster.ts --path "/protocols/paylike" --payload '{"isLike":1,"likeTo":"..."}'
 */

import { parseArgs } from 'util';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

interface ParsedArgs {
  path?: string;
  payload?: string;
  operation?: string;
  'content-type'?: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      path: { type: 'string', short: 'p' },
      payload: { type: 'string' },
      operation: { type: 'string', short: 'o' },
      'content-type': { type: 'string', short: 'c' },
    },
    allowPositionals: true,
  });

  const args = values as ParsedArgs;

  // Environment validation
  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    console.error('Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
    process.exit(1);
  }

  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    console.error('Error: IDBOTS_METABOT_ID must be a positive integer.');
    process.exit(1);
  }

  const rpcUrl = process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200';

  // Argument validation
  if (!args.path || args.path.trim() === '') {
    console.error('Error: --path is required.');
    process.exit(1);
  }

  if (!args.payload || args.payload.trim() === '') {
    console.error('Error: --payload is required.');
    process.exit(1);
  }

  const operation = args.operation || 'create';
  const contentType = args['content-type'] || 'application/json';

  // JSON safety: if content-type contains "json", parse and re-stringify to sanitize
  let cleanPayload: string;
  if (contentType.toLowerCase().includes('json')) {
    try {
      const parsed = JSON.parse(args.payload);
      cleanPayload = JSON.stringify(parsed);
    } catch {
      console.error('Payload is not valid JSON');
      process.exit(1);
    }
  } else {
    cleanPayload = args.payload;
  }

  // Build request body (RPC expects metabot_id + metaidData)
  const requestBody = {
    metabot_id: metabotId,
    metaidData: {
      operation,
      path: args.path.trim(),
      encryption: '0' as const,
      version: '1.0',
      contentType,
      payload: cleanPayload,
    },
  };

  await runCreatePin(rpcUrl, requestBody);
}

void main();

async function runCreatePin(rpcUrl: string, body: object): Promise<void> {
  const url = `${rpcUrl.replace(/\/$/, '')}/api/metaid/create-pin`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      console.error('Request failed:', json.error || 'Unknown error');
      process.exit(1);
    }

    const txid = json.txid ?? json.txids?.[0] ?? '';
    const pinId = json.pinId ?? `${txid}i0`;
    console.log(JSON.stringify({ txid, pinId }));
    if (typeof json.totalCost === 'number') {
      console.error(`Cost: ${json.totalCost} satoshis`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Request error:', message);
    process.exit(1);
  }
}
