#!/usr/bin/env node
/**
 * IDBots metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC gateway.
 * Supports text-only buzz and buzz with file attachments (images, documents, etc.).
 *
 * Requires: Node.js 18+ (for fetch). Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).
 *
 * Usage:
 *   node post-buzz.js --content "<content>" [--attachment <file>]... [--content-type "<mime>"] [--network mvc|doge|btc]
 */

import { parseArgs } from 'util';
import fs from 'fs';
import pathMod from 'path';

const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
const CREATE_PIN_URL = `${RPC_BASE}/api/metaid/create-pin`;

function writeStderr(message: string): void {
  process.stderr.write(message + '\n');
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
};

function inferContentType(filePath: string): string {
  const ext = pathMod.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

function getFileExtension(filePath: string): string {
  return pathMod.extname(filePath).toLowerCase();
}

interface CreatePinResponse {
  success?: boolean;
  error?: string;
  txid?: string;
  txids?: string[];
  pinId?: string;
  totalCost?: number;
}

async function createPin(metabotId: number, network: string, metaidData: Record<string, unknown>): Promise<CreatePinResponse> {
  const res = await fetch(CREATE_PIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: metabotId, network, metaidData }),
  });

  const rawText = await res.text();
  let parsed: CreatePinResponse | null = null;
  if (rawText.trim()) {
    try {
      const maybe = JSON.parse(rawText) as unknown;
      parsed = maybe && typeof maybe === 'object' ? (maybe as CreatePinResponse) : null;
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const errMsg = parsed?.error || rawText;
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }
  if (parsed && parsed.success === false) {
    throw new Error(parsed.error || 'Unknown RPC error');
  }
  return parsed ?? {};
}

function resolvePinId(resp: CreatePinResponse): string {
  const txid = resp.txid ?? resp.txids?.[0] ?? '';
  return resp.pinId ?? (txid ? `${txid}i0` : '');
}

async function uploadFile(filePath: string, metabotId: number, network: string): Promise<{ pinId: string; ext: string }> {
  const resolved = pathMod.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const buffer = fs.readFileSync(resolved);
  const base64 = buffer.toString('base64');
  const contentType = inferContentType(resolved);
  const ext = getFileExtension(resolved);

  writeStderr(`Uploading: ${pathMod.basename(resolved)} (${contentType}, ${buffer.length} bytes)...`);

  const resp = await createPin(metabotId, network, {
    operation: 'create',
    path: '/file',
    encryption: '0',
    version: '1.0',
    contentType,
    encoding: 'base64',
    payload: base64,
  });

  const pinId = resolvePinId(resp);
  if (!pinId) {
    throw new Error(`Failed to get pinId for uploaded file: ${resolved}`);
  }

  if (typeof resp.totalCost === 'number') {
    writeStderr(`  -> pinId: ${pinId} (cost: ${resp.totalCost} satoshis)`);
  } else {
    writeStderr(`  -> pinId: ${pinId}`);
  }

  return { pinId, ext };
}

const USAGE =
  'Usage: node post-buzz.js --content "<content>" [--attachment <file>]... [--content-type "<mime>"] [--network mvc|doge|btc]';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      content: { type: 'string' },
      attachment: { type: 'string', multiple: true },
      'content-type': { type: 'string' },
      network: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(
      'metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC.\n\n' +
        USAGE +
        '\n\n' +
        'Options:\n' +
        '  --content <string>       (required) Text to post.\n' +
        '  --attachment <file>      (optional, repeatable) Local file path to upload as attachment.\n' +
        '  --content-type <string>  (optional) Content MIME type, default: text/plain;utf-8\n' +
        '  --network <string>       (optional) Target network: mvc (default), doge, btc\n' +
        '  -h, --help               Show this message.\n' +
        '\nEnv: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).\n'
    );
    process.exit(0);
  }

  const content = values.content ?? '';
  const contentType = values['content-type'] ?? 'text/plain;utf-8';
  const attachmentPaths: string[] = values.attachment ?? [];
  const networkRaw = values.network?.toLowerCase?.()?.trim() ?? '';
  const network = networkRaw === 'doge' || networkRaw === 'btc' ? networkRaw : 'mvc';

  for (const p of positionals) {
    if (p.startsWith('-')) {
      writeStderr(`Unknown option: ${p}`);
      process.exit(1);
    }
  }

  if (typeof content !== 'string' || content.trim() === '') {
    writeStderr('Error: --content is required and must not be empty.');
    writeStderr(USAGE);
    process.exit(1);
  }

  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    writeStderr('Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
    process.exit(1);
  }
  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    writeStderr('Error: IDBOTS_METABOT_ID must be a positive integer.');
    process.exit(1);
  }

  // Phase 1: upload attachments and collect metafile:// URIs (with file extension)
  const attachments: string[] = [];

  for (const filePath of attachmentPaths) {
    const { pinId, ext } = await uploadFile(filePath, metabotId, network);
    attachments.push(`metafile://${pinId}${ext}`);
  }

  if (attachments.length > 0) {
    writeStderr(`All ${attachments.length} attachment(s) uploaded.`);
  }

  // Phase 2: post the SimpleBuzz with attachments
  const buzzPayload = {
    content: content.trim(),
    contentType,
    attachments,
    quotePin: '',
  };

  const resp = await createPin(metabotId, network, {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify(buzzPayload),
  });

  const txid = resp.txid ?? resp.txids?.[0] ?? '';
  const pinId = resolvePinId(resp);

  const result: Record<string, unknown> = {
    success: true,
    message: pinId ? `Buzz posted: ${pinId}` : 'Buzz posted successfully.',
  };
  if (txid) result.txid = txid;
  if (pinId) result.pinId = pinId;
  if (attachments.length > 0) result.attachments = attachments;
  if (typeof resp.totalCost === 'number') {
    result.totalCost = resp.totalCost;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (typeof resp.totalCost === 'number') {
    writeStderr(`Cost: ${resp.totalCost} satoshis`);
  }
}

main().catch((e) => {
  writeStderr(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
