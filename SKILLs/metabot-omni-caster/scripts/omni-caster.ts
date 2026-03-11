#!/usr/bin/env node
/**
 * MetaBot Omni-Caster: Universal MetaID protocol gateway.
 * Accepts path and payload from CLI, builds MetaID 7-tuple, and sends to local RPC.
 * Supports both JSON/text payloads and binary file uploads.
 *
 * Usage (JSON protocol):
 *   IDBOTS_METABOT_ID=1 node omni-caster.js --path "/protocols/paylike" --payload '{"isLike":1,"likeTo":"..."}'
 *
 * Usage (binary file upload):
 *   IDBOTS_METABOT_ID=1 node omni-caster.js --path "/file" --payload-file ./image.png --content-type image/png
 */

import { parseArgs } from 'util';
import fs from 'fs';
import path from 'path';
import { createCipheriv } from 'crypto';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

interface ParsedArgs {
  path?: string;
  payload?: string;
  'payload-file'?: string;
  operation?: string;
  'content-type'?: string;
  encoding?: string;
  help?: boolean;
}

function groupIdToSecretKey(groupId: string): string {
  const normalized = String(groupId ?? '').trim();
  if (normalized.length >= 16) {
    return normalized.slice(0, 16);
  }
  return normalized.padEnd(16, '0');
}

function encryptSimpleGroupChatContent(message: string, groupId: string): string {
  const secretKey = groupIdToSecretKey(groupId);
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from(secretKey, 'utf8'),
    Buffer.from('0000000000000000', 'utf8')
  );
  const encrypted = Buffer.concat([
    cipher.update(String(message ?? ''), 'utf8'),
    cipher.final(),
  ]);
  return encrypted.toString('hex');
}

/** Infer MIME type from file extension. */
function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.txt': 'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      path: { type: 'string', short: 'p' },
      payload: { type: 'string' },
      'payload-file': { type: 'string' },
      operation: { type: 'string', short: 'o' },
      'content-type': { type: 'string', short: 'c' },
      encoding: { type: 'string', short: 'e' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  const args = values as ParsedArgs;

  if (args.help) {
    console.error(
      'Usage: node omni-caster.js --path "<protocol-path>" (--payload \'<json-or-text>\' | --payload-file <file>)'
      + ' [--operation <create|modify|revoke>] [--content-type <mime>] [--encoding <utf-8|base64>]'
    );
    process.exit(0);
  }

  for (const positional of positionals) {
    if (positional.startsWith('-')) {
      console.error(`Unknown option: ${positional}`);
      process.exit(1);
    }
  }

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

  const hasPayload = args.payload !== undefined && args.payload !== '';
  const hasPayloadFile = args['payload-file'] !== undefined && args['payload-file'].trim() !== '';

  if (hasPayload && hasPayloadFile) {
    console.error('Error: Use either --payload or --payload-file, not both.');
    process.exit(1);
  }
  if (!hasPayload && !hasPayloadFile) {
    console.error('Error: Either --payload or --payload-file is required.');
    process.exit(1);
  }

  const operation = args.operation || 'create';
  let contentType = args['content-type'] ?? 'application/json';
  let cleanPayload: string;
  let encoding: 'utf-8' | 'base64' = 'utf-8';

  if (hasPayloadFile) {
    const filePath = args['payload-file']!.trim();
    if (!fs.existsSync(filePath)) {
      console.error(`Error: File not found: ${filePath}`);
      process.exit(1);
    }
    const buffer = fs.readFileSync(filePath);
    cleanPayload = buffer.toString('base64');
    encoding = 'base64';
    if (!args['content-type']) {
      contentType = inferContentType(filePath);
    }
  } else {
    const payloadStr = args.payload!;
    if (args.encoding === 'base64') {
      encoding = 'base64';
    }
    if (contentType.toLowerCase().includes('json')) {
      try {
        const parsed = JSON.parse(payloadStr) as Record<string, unknown>;
        if (args.path!.trim() === '/protocols/simplegroupchat') {
          const groupId = typeof parsed.groupId === 'string' ? parsed.groupId.trim() : '';
          if (!groupId) {
            console.error('Payload for /protocols/simplegroupchat must include a non-empty groupId.');
            process.exit(1);
          }
          if (typeof parsed.content !== 'string') {
            console.error('Payload for /protocols/simplegroupchat must include a string content field.');
            process.exit(1);
          }
          parsed.content = encryptSimpleGroupChatContent(parsed.content, groupId);
          parsed.encryption = 'aes';
        }
        cleanPayload = JSON.stringify(parsed);
      } catch {
        console.error('Payload is not valid JSON');
        process.exit(1);
      }
    } else {
      cleanPayload = payloadStr;
      // Auto-detect binary: image/*, application/octet-stream, *;binary
      if (encoding === 'utf-8') {
        const ct = contentType.toLowerCase();
        if (
          ct.startsWith('image/') ||
          ct.startsWith('video/') ||
          ct.startsWith('audio/') ||
          ct === 'application/octet-stream' ||
          ct.endsWith(';binary')
        ) {
          encoding = 'base64';
        }
      }
    }
  }

  const metaidData: Record<string, unknown> = {
    operation,
    path: args.path!.trim(),
    encryption: '0' as const,
    version: '1.0',
    contentType,
    payload: cleanPayload,
  };
  if (encoding === 'base64') {
    metaidData.encoding = 'base64';
  }

  const requestBody = {
    metabot_id: metabotId,
    metaidData,
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
