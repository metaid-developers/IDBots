#!/usr/bin/env node
/**
 * M0 step 2: restore the legacy-NFT issuer identity as the swap Bot (PRD §8 M0).
 *
 * Opens the IDBots SQLite store (app must be CLOSED), runs the host restore
 * core with:
 *   - the 236 issuer path (coin-type fix wired in metabotWalletService),
 *   - expectedGlobalMetaId hard guard (fail-closed on identity mismatch),
 *   - a profile override (display name 「Avatar 兑换站」 + swap-station persona,
 *     because the on-chain profile only carries the bare name "Bot"),
 *   - boss binding from the local user identity.
 *
 * Then writes the pilot config (vault address + album constants) into the
 * store's cowork_config KV for the M1 engine.
 *
 * The mnemonic never reaches stdout/logs; a word-level contamination guard
 * runs over the final evidence before printing.
 *
 * Usage:
 *   node cli/restore-issuer.mjs --user-data "<IDBots userData dir>" [--dry-run]
 * Exit codes: 0 restored (or dry-run plan ok); 1 failed.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { loadIssuerMnemonic, deriveMvcAddress, computeMetaId } from './lib/issuer-source.mjs';
import { ISSUER_CONFIG } from './lib/issuer-config.mjs';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user-data') args.userData = argv[++i];
    else if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

const DEFAULT_USER_DATA = path.join(process.env.HOME || '', 'Library', 'Application Support', 'IDBots');
const CONFIG_KEY = 'nft_swap_pilot_config';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const userDataPath = args.userData || DEFAULT_USER_DATA;

  // 1. Resolve + gate the mnemonic in-process.
  const loaded = loadIssuerMnemonic({
    filePath: args.file || '/Users/tusm/Documents/MetaID_Projects/servers/metacontract_nft_issuer.md',
    keyword: 'endorse',
    expectAddress: ISSUER_CONFIG.issuerAddress,
    path: ISSUER_CONFIG.issuerPath,
  });
  if (!loaded.ok) {
    console.log(JSON.stringify({ ok: false, error: loaded.error, detail: loaded.detail, diagnostics: loaded.diagnostics }));
    process.exit(1);
  }
  const mnemonic = loaded.mnemonic;

  // Independent re-derivation guard (belt and braces: the gate lib already
  // enforced the address; recompute here and fail before touching the store).
  const derived = deriveMvcAddress(mnemonic, ISSUER_CONFIG.issuerPath);
  if (derived.address !== ISSUER_CONFIG.issuerAddress) {
    console.log(JSON.stringify({ ok: false, error: 'ADDRESS_RECHECK_FAILED' }));
    process.exit(1);
  }

  // 2. Open the store (host modules, compiled dist-electron).
  const { SqliteStore } = require('../../../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../../../dist-electron/main/metabotStore.js');
  const { UserIdentityStore } = require('../../../dist-electron/main/userIdentityStore.js');
  const {
    restoreMetabotFromMnemonicCore,
  } = require('../../../dist-electron/main/services/metabotRestoreService.js');
  const { convertToGlobalMetaId } = require('../../../dist-electron/main/services/globalMetaid.js');

  const expectedGlobalMetaId = convertToGlobalMetaId(ISSUER_CONFIG.issuerAddress);
  if (expectedGlobalMetaId !== ISSUER_CONFIG.expectedGlobalMetaId) {
    console.log(JSON.stringify({ ok: false, error: 'GLOBAL_METAID_CONSTANT_DRIFT', detail: expectedGlobalMetaId }));
    process.exit(1);
  }

  const vault = deriveMvcAddress(mnemonic, ISSUER_CONFIG.vaultPath);
  const vaultAddress = vault.address;

  let store;
  try {
    store = await SqliteStore.create(userDataPath);
    const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
    const identityStore = new UserIdentityStore(store.getDatabase(), store.getSaveFunction());

    // Pre-flight facts (read-only).
    const bossIdentity = identityStore.get();
    const bossGlobalMetaId = bossIdentity?.globalmetaid || null;
    const nameClash = metabotStore.listMetabots().some(
      (m) => m.name.trim().toLowerCase() === ISSUER_CONFIG.botDisplayName.toLowerCase(),
    );
    const walletClash = Boolean(metabotStore.getMetabotWalletByMnemonicNormalized(mnemonic));

    if (args.dryRun) {
      console.log(JSON.stringify({
        ok: true,
        dryRun: true,
        userDataPath,
        issuerAddress: ISSUER_CONFIG.issuerAddress,
        expectedGlobalMetaId,
        bossGlobalMetaIdFound: Boolean(bossGlobalMetaId),
        nameClash,
        walletAlreadyPresent: walletClash,
        vaultAddress,
        plan: [
          'backup idbots.sqlite (+wal/shm) before this run in production',
          'restoreMetabotFromMnemonicCore with path=' + ISSUER_CONFIG.issuerPath,
          'profileOverride name=' + ISSUER_CONFIG.botDisplayName,
          'write ' + CONFIG_KEY + ' kv row (vault=' + vaultAddress + ')',
        ],
      }, null, 2));
      return;
    }

    if (nameClash) {
      console.log(JSON.stringify({ ok: false, error: 'NAME_DUPLICATE', detail: ISSUER_CONFIG.botDisplayName }));
      process.exit(1);
    }
    if (walletClash) {
      console.log(JSON.stringify({ ok: false, error: 'METABOT_WALLET_IN_USE' }));
      process.exit(1);
    }

    // 3. Restore via the host core (fail-closed on expectedGlobalMetaId).
    const profileOverride = {
      name: ISSUER_CONFIG.botDisplayName,
      avatarDataUrl: null,
      metabotInfoPinId: null,
      chatpubkeyPinId: null,
      bio: {
        role: 'MetaBot Avatar 专辑兑换站（MetaContract → MRC-721 试点）',
        soul: '只做 MetaBot Avatar 专辑的旧版 NFT 兑换：收旧验真、按需铸造同编号新版、发货、销毁台账。谨守三元组验真与台账单锁，异常即停。',
        goal: '让老用户把旧 MetaBot Avatar 安全换成 MRC-721 新版，回流 IDBots。',
        bio: null,
        background: null,
        llm_id: null,
        llm_provider: null,
        llm_effort: null,
        tools: [],
        skills: ['nft-swap'],
        allowChatSkills: [],
        boss_id: null,
        boss_global_metaid: bossGlobalMetaId,
        created_by: '0000',
      },
      raw: null,
    };

    const result = await restoreMetabotFromMnemonicCore(
      metabotStore,
      {
        mnemonic,
        path: ISSUER_CONFIG.issuerPath,
        expectedGlobalMetaId,
        profileOverride,
        boss_global_metaid: bossGlobalMetaId,
        metabotType: 'worker',
      },
      {},
    );
    if (!result.success) {
      console.log(JSON.stringify({ ok: false, error: 'RESTORE_FAILED', detail: result.error }));
      process.exit(1);
    }
    const metabot = result.metabot;

    // 4. Persist the pilot config for the M1 engine.
    const config = {
      version: 1,
      metabotId: metabot.id,
      collectionName: ISSUER_CONFIG.collectionName,
      genesis: ISSUER_CONFIG.genesis,
      codeHash: ISSUER_CONFIG.codeHash,
      sensibleId: ISSUER_CONFIG.sensibleId,
      tokenSupply: ISSUER_CONFIG.tokenSupply,
      issuerAddress: ISSUER_CONFIG.issuerAddress,
      issuerPath: ISSUER_CONFIG.issuerPath,
      vaultAddress,
      vaultPath: ISSUER_CONFIG.vaultPath,
      burnAddress: ISSUER_CONFIG.burnAddress,
      net: ISSUER_CONFIG.net,
      perSwapFeeCeilingSats: ISSUER_CONFIG.perSwapFeeCeilingSats,
      restoredAt: new Date().toISOString(),
    };
    const db = store.getDatabase();
    db.run(
      'INSERT OR REPLACE INTO cowork_config (key, value, updated_at) VALUES (?, ?, ?)',
      [CONFIG_KEY, JSON.stringify(config), Date.now()],
    );
    store.getSaveFunction()();

    // 5. Evidence (word-contamination guarded).
    const evidence = {
      ok: true,
      stage: 'restore-issuer',
      metabotId: metabot.id,
      name: metabot.name,
      mvcAddress: metabot.mvc_address,
      globalmetaid: metabot.globalmetaid,
      walletPathUsed: ISSUER_CONFIG.issuerPath,
      expectedGlobalMetaIdGuard: expectedGlobalMetaId === metabot.globalmetaid,
      bossBound: Boolean(bossGlobalMetaId),
      vaultAddress,
      configKey: CONFIG_KEY,
      derivedAddress: derived.address,
      metaId: computeMetaId(ISSUER_CONFIG.issuerAddress),
    };
    const evidenceText = JSON.stringify(evidence);
    for (const word of mnemonic.split(' ')) {
      if (word.length >= 4 && evidenceText.includes(word)) {
        console.log(JSON.stringify({ ok: false, error: 'EVIDENCE_CONTAMINATION' }));
        process.exit(1);
      }
    }
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    try {
      store?.close();
    } catch {
      // best-effort close (Windows CI lesson: never let cleanup fail the run)
    }
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: 'UNEXPECTED', detail: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
