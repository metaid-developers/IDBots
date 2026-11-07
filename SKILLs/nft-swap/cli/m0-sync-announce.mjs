#!/usr/bin/env node
/**
 * M0 steps 3+4: chain-sync the swap Bot identity (chat-key rotation + name +
 * persona pins via the host syncMetaBotToChain flow) and post the swap-station
 * announcement pin.
 *
 * - Chat-key rotation is REQUIRED (2026-11-05 finding): the on-chain
 *   chatpubkey was registered from a key outside the issuer mnemonic's
 *   derivations, so incoming private chats would be undecryptable. The bot
 *   row carries chat_public_key (236-derived) with a NULL pin id, which makes
 *   the host sync pin OUR key (latest pin wins for senders).
 * - The announcement is the PRD §8 M0 公告件: vault address + how-to, posted
 *   as a simplebuzz pin from the bot identity. No external promotion.
 *
 * Usage: node cli/m0-sync-announce.mjs [--user-data <dir>] [--file <issuer notes>] [--skip-announce]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { loadIssuerMnemonic } from './lib/issuer-source.mjs';
import { ISSUER_CONFIG } from './lib/issuer-config.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_USER_DATA = path.join(process.env.HOME || '', 'Library', 'Application Support', 'IDBots');
const CONFIG_KEY = 'nft_swap_pilot_config';

function parseArgs(argv) {
  const args = { skipAnnounce: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user-data') args.userData = argv[++i];
    else if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--skip-announce') args.skipAnnounce = true;
  }
  return args;
}

const ANNOUNCEMENT = [
  '【Avatar 兑换站上线（试点）】',
  '',
  'MetaBot Avatar 旧版（MetaContract）NFT 可 1:1 免费兑换同编号新版 MRC-721：',
  '1. 在 IDBots 内私聊本 Bot（Avatar 兑换站）',
  `2. 把旧 token 普通转账到金库地址 ${ISSUER_CONFIG.vaultAddress}`,
  '3. 引擎链上验真后，由原发行者身份铸造同编号 item（item-####）并发货',
  '',
  `兑换集合：${ISSUER_CONFIG.collectionName}（totalSupply ${ISSUER_CONFIG.tokenSupply}，collection_desc 已附 236 发行者同源绑定签名）`,
  '一代 999 限量头像不在本试点范围。兑换全程免费，台账三桶对账，异常即停。',
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataPath = args.userData || DEFAULT_USER_DATA;

  const loaded = loadIssuerMnemonic({
    filePath: args.file || '/Users/tusm/Documents/MetaID_Projects/servers/metacontract_nft_issuer.md',
    keyword: 'endorse',
    expectAddress: ISSUER_CONFIG.issuerAddress,
    path: ISSUER_CONFIG.issuerPath,
  });
  if (!loaded.ok) {
    console.log(JSON.stringify({ ok: false, error: loaded.error, detail: loaded.detail }));
    process.exit(1);
  }
  const mnemonic = loaded.mnemonic;

  const { SqliteStore } = require('../../../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../../../dist-electron/main/metabotStore.js');
  const metaidCore = await import('../../../dist-electron/main/services/metaidCore.js');

  let store;
  try {
    store = await SqliteStore.create(userDataPath);
    const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());

    const cfgRow = store
      .getDatabase()
      .exec('SELECT value FROM cowork_config WHERE key = ?', [CONFIG_KEY])[0]?.values?.[0]?.[0];
    if (!cfgRow) {
      console.log(JSON.stringify({ ok: false, error: 'PILOT_CONFIG_MISSING' }));
      process.exit(1);
    }
    const config = JSON.parse(cfgRow);
    const metabotId = config.metabotId;

    // deps.createPin for syncMetaBotToChain uses the metaidCore 4-arg contract
    // (store, metabotId, metaidData, options) — NOT the 3-arg MRC721 one.
    const createPinWrapper = (storeArg, id, metaidData, options) =>
      metaidCore.createPin(storeArg ?? metabotStore, id, metaidData, {
        ...options,
        feeRate: options?.feeRate ?? 1,
        sponsorMode: 'self',
      });

    // 1. Identity sync (chat-key rotation + name + persona pins).
    console.error('[m0-sync] running syncMetaBotToChain…');
    const sync = await metaidCore.syncMetaBotToChain(
      metabotStore,
      metabotId,
      { createPin: createPinWrapper },
    );
    console.error('[m0-sync] sync result:', JSON.stringify({
      success: sync.success,
      syncedSteps: sync.syncedSteps?.map((s) => s.key) ?? [],
      error: sync.error ?? null,
    }));

    // 2. Announcement pin (PRD §8 M0 公告件).
    let announce = null;
    if (!args.skipAnnounce && sync.success) {
      console.error('[m0-announce] posting simplebuzz…');
      const result = await createPinWrapper(
        metabotStore,
        metabotId,
        {
          operation: 'create',
          path: '/protocols/simplebuzz',
          encryption: '0',
          version: '1.0',
          contentType: 'application/json',
          payload: JSON.stringify({ content: ANNOUNCEMENT, contentType: 'text/plain;utf-8', attachments: [] }),
        },
        { network: 'mvc', origin: 'tool:nft_swap_m0_announce' },
      );
      announce = { pinId: result.pinId, txids: result.txids, totalCost: result.totalCost };
    }

    // 3. Persist results into the pilot config.
    if (sync.success) {
      config.identitySyncedAt = new Date().toISOString();
      config.chatKeyPinId = sync.chatPublicKeyPinId ?? null;
      config.metabotInfoPinId = sync.metabotInfoPinId ?? null;
      config.syncTxids = sync.txids ?? [];
      if (announce) {
        config.announcePinId = announce.pinId;
        config.announceTxids = announce.txids;
        config.announcedAt = new Date().toISOString();
      }
      store
        .getDatabase()
        .run('UPDATE cowork_config SET value = ?, updated_at = ? WHERE key = ?', [
          JSON.stringify(config),
          Date.now(),
          CONFIG_KEY,
        ]);
      store.getSaveFunction()();
    }

    const evidence = {
      ok: sync.success,
      stage: 'm0-sync-announce',
      metabotId,
      sync: {
        success: sync.success,
        syncedSteps: sync.syncedSteps ?? [],
        plannedSteps: sync.plannedSteps ?? [],
        chatKeyPinId: sync.chatPublicKeyPinId ?? null,
        metabotInfoPinId: sync.metabotInfoPinId ?? null,
        txids: sync.txids ?? [],
        error: sync.error ?? null,
      },
      announcement: announce,
      note: 'chat key rotated to the 236 issuer key (old on-chain key belonged to an outside registration)',
    };
    const evidenceText = JSON.stringify(evidence);
    for (const word of mnemonic.split(' ')) {
      if (word.length >= 4 && evidenceText.includes(word)) {
        console.log(JSON.stringify({ ok: false, error: 'EVIDENCE_CONTAMINATION' }));
        process.exit(1);
      }
    }
    console.log(JSON.stringify(evidence, null, 2));
    if (!sync.success) process.exit(1);
  } finally {
    try {
      store?.close();
    } catch {
      // best-effort close
    }
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: 'UNEXPECTED', detail: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
