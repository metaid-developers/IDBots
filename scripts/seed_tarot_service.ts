#!/usr/bin/env npx tsx
/**
 * Seed script: publish a "Tarot Reader" service to the MetaID chain in two steps.
 *
 * Step 1 – Upload the remote-skill markdown to /file/remote-skill
 * Step 2 – Publish the skill-service-public protocol referencing the pinId from step 1
 *
 * Prerequisites:
 *   - IDBots must be running (npm run electron:dev) so the RPC gateway is available.
 *
 * Usage:
 *   IDBOTS_METABOT_ID=1 npx tsx scripts/seed_tarot_service.ts
 */

const RPC_URL = process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200';
const CREATE_PIN_ENDPOINT = `${RPC_URL.replace(/\/$/, '')}/api/metaid/create-pin`;
const NETWORK = 'mvc';
const INDEXER_DELAY_MS = 5_000;

interface CreatePinResponse {
  success?: boolean;
  error?: string;
  txid?: string;
  txids?: string[];
  pinId?: string;
  totalCost?: number;
}

async function createPin(
  metabotId: number,
  metaidData: Record<string, unknown>
): Promise<{ txid: string; pinId: string; totalCost: number }> {
  const body = {
    metabot_id: metabotId,
    network: NETWORK,
    metaidData,
  };

  const res = await fetch(CREATE_PIN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = (await res.json()) as CreatePinResponse;

  if (!json.success) {
    throw new Error(json.error || 'RPC returned success=false');
  }

  const txid = json.txid ?? json.txids?.[0] ?? '';
  if (!txid) {
    throw new Error('No txid in RPC response');
  }

  const pinId = json.pinId ?? `${txid}i0`;
  return { txid, pinId, totalCost: json.totalCost ?? 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

async function main(): Promise<void> {
  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    console.error(`${RED}Error: IDBOTS_METABOT_ID env var is required.${RESET}`);
    process.exit(1);
  }
  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    console.error(`${RED}Error: IDBOTS_METABOT_ID must be a positive integer.${RESET}`);
    process.exit(1);
  }

  console.log(`RPC endpoint : ${CREATE_PIN_ENDPOINT}`);
  console.log(`MetaBot ID   : ${metabotId}`);
  console.log(`Network      : ${NETWORK}`);
  console.log('');

  // ── Step 1: Upload remote-skill markdown ──────────────────────────────
  console.log('Step 1: Uploading remote-skill markdown to /file/remote-skill ...');

  const markdownContent =
    '# AI Tarot Reader\nThis is a remote skill for Tarot reading. Send a prompt to get your fortune.';

  const step1 = await createPin(metabotId, {
    operation: 'create',
    path: '/file/remote-skill',
    encryption: '0',
    version: '1.0',
    contentType: 'text/markdown',
    payload: markdownContent,
  });

  console.log(
    `${GREEN}[SUCCESS] Step 1: Remote skill uploaded, PINID: ${step1.pinId}${RESET}`
  );
  console.log(`         TXID: ${step1.txid}  |  Cost: ${step1.totalCost} satoshis`);
  console.log('');

  // ── Wait for indexer ──────────────────────────────────────────────────
  console.log(`Waiting ${INDEXER_DELAY_MS / 1000}s for indexer propagation ...`);
  await sleep(INDEXER_DELAY_MS);

  // ── Step 2: Publish skill-service-public protocol ─────────────────────
  console.log('Step 2: Publishing skill-service-public protocol ...');

  const servicePayload = {
    serviceName: 'ai-tarot-reader',
    displayName: 'AI 塔罗牌大师 (1 DOGE 测试版)',
    description:
      '为你解答近期的财运、事业与爱情疑惑。请在订单中输入你的问题，全自动接单并加密回复。',
    price: 10000,
    currency: 'SATS-BTC',
    remoteSkillPinId: step1.pinId,
    availableBeforeBTCHeight: 9999999,
  };

  const step2 = await createPin(metabotId, {
    operation: 'create',
    path: '/protocols/skill-service-public',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify(servicePayload),
  });

  console.log(
    `${GREEN}[SUCCESS] Step 2: Service published, TXID: ${step2.txid}${RESET}`
  );
  console.log(`         PINID: ${step2.pinId}  |  Cost: ${step2.totalCost} satoshis`);
  console.log('');
  console.log(`${GREEN}All done! Tarot service is now live on-chain.${RESET}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${RED}[FAILED] ${message}${RESET}`);
  process.exit(1);
});
