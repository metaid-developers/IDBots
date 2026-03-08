#!/usr/bin/env node
/**
 * IDBots metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC gateway.
 * Cross-platform TypeScript replacement for post-buzz.sh.
 *
 * Requires: Node.js 18+ (for fetch). Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).
 *
 * Usage:
 *   node post-buzz.ts --content "<content>" [--content-type "<mime-type>"]
 */

import { parseArgs } from 'util';

function writeStderr(message: string): void {
  process.stderr.write(message + '\n');
}

const USAGE =
  'Usage: node post-buzz.ts --content "<content>" [--content-type "<mime-type>"]';

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      content: { type: 'string' },
      'content-type': { type: 'string' },
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
        '  --content <string>     (required) Text to post.\n' +
        '  --content-type <string> (optional) MIME type, default: text/plain;utf-8\n' +
        '  -h, --help             Show this message.\n' +
        '\nEnv: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).\n'
    );
    process.exit(0);
  }

  let content = values.content ?? '';
  const contentType = values['content-type'] ?? 'text/plain;utf-8';

  // Unknown options (unrecognized flags end up as positionals starting with -)
  for (const p of positionals) {
    if (p.startsWith('-')) {
      writeStderr(`Unknown option: ${p}`);
      process.exit(1);
    }
  }

  // Parameter validation: --content must not be empty
  if (typeof content !== 'string' || content.trim() === '') {
    writeStderr('Error: --content is required and must not be empty.');
    writeStderr(USAGE);
    process.exit(1);
  }

  // Environment check: IDBOTS_METABOT_ID must exist
  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    writeStderr(
      'Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.'
    );
    process.exit(1);
  }

  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    writeStderr('Error: IDBOTS_METABOT_ID must be a positive integer.');
    process.exit(1);
  }

  const rpcUrl =
    (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(
      /\/+$/,
      ''
    );
  const url = `${rpcUrl}/api/metaid/create-pin`;

  // Build payload and body (same structure as post-buzz.sh)
  const payload = {
    content: content.trim(),
    contentType,
    attachments: [] as string[],
    quotePin: '',
  };

  // metaidData.payload must be a JSON string (same as jq --arg payload "$PAYLOAD_JSON" in the shell)
  const body = {
    metabot_id: metabotId,
    metaidData: {
      operation: 'create',
      path: '/protocols/simplebuzz',
      encryption: '0',
      version: '1.0',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
    },
  };

  (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        writeStderr(`HTTP ${res.status}: ${text}`);
        process.exit(1);
      }
      // Success: silent exit 0 (same as curl -s)
    } catch (err) {
      writeStderr(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  })();
}

main();
