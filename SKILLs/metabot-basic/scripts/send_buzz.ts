#!/usr/bin/env node

/**
 * Send Buzz to MVC network via MetaID RPC gateway.
 * metabot_id must be provided via IDBOTS_METABOT_ID (injected by IDBots Cowork when using metabot-basic skill).
 *
 * Usage:
 *   IDBOTS_METABOT_ID=1 npx ts-node scripts/send_buzz.ts <content>
 *   IDBOTS_METABOT_ID=1 npx ts-node scripts/send_buzz.ts @<filepath>
 */

import * as fs from 'fs';
import * as path from 'path';

const RPC_URL = 'http://127.0.0.1:31200/api/metaid/create-pin';

interface BuzzBody {
  content: string;
  contentType: string;
  attachments: any[];
  quotePin: string;
}

async function main() {
  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    console.error('IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
    process.exit(1);
  }
  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    console.error('IDBOTS_METABOT_ID must be a positive integer.');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  let content: string;
  if (args[0]?.startsWith('@')) {
    const filePath = args[0].slice(1);
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);
    if (!fs.existsSync(fullPath)) {
      console.error(`File not found: ${fullPath}`);
      process.exit(1);
    }
    content = fs.readFileSync(fullPath, 'utf-8');
  } else {
    content = args.join(' ').trim();
  }

  if (!content) {
    console.error('Please provide Buzz content.');
    console.error('Usage: IDBOTS_METABOT_ID=1 npx ts-node scripts/send_buzz.ts "<content>"');
    console.error('   or: IDBOTS_METABOT_ID=1 npx ts-node scripts/send_buzz.ts @./content.txt');
    process.exit(1);
  }

  const body: BuzzBody = {
    content,
    contentType: 'text/plain;utf-8',
    attachments: [],
    quotePin: '',
  };

  const metaidData = {
    operation: 'create',
    path: '/protocols/simplebuzz',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify(body),
  };

  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metabot_id: metabotId, metaidData }),
    });
    const json = await res.json();

    if (!json.success) {
      throw new Error(json.error || 'Request failed');
    }
    console.log('Buzz sent successfully!');
    console.log(`TXID: ${json.txid ?? json.txids?.[0]}`);
    if (typeof json.totalCost === 'number') {
      console.log(`Cost: ${json.totalCost} satoshis`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Send failed: ${message}`);
    process.exit(1);
  }
}

main();
