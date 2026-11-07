#!/usr/bin/env node
/**
 * M0 first action: register the collection_desc pin (PRD §4b/§8, prereview
 * #13 — collection_name is global first-come-first-served).
 *
 * Idempotent + fail-closed:
 *  - collection already registered AND createAddress === issuer → skip (0 exit);
 *  - collection registered by ANYONE ELSE → abort COLLECTION_NAME_TAKEN
 *    (stop-and-report, never overwrite, never re-use a foreign name);
 *  - fresh same-origin binding signature signed in-process with the 236 key.
 *
 * Usage: node cli/register-collection.mjs [--user-data <dir>] [--file <issuer notes>]
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { loadIssuerMnemonic, deriveMvcAddress, signIssuerBinding } from './lib/issuer-source.mjs';
import { ISSUER_CONFIG, issuerBindingMessage } from './lib/issuer-config.mjs';

const require = createRequire(import.meta.url);
const DEFAULT_USER_DATA = path.join(process.env.HOME || '', 'Library', 'Application Support', 'IDBots');
const CONFIG_KEY = 'nft_swap_pilot_config';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user-data') args.userData = argv[++i];
    else if (argv[i] === '--file') args.file = argv[++i];
  }
  return args;
}

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
  const issuerKey = deriveMvcAddress(mnemonic, ISSUER_CONFIG.issuerPath);

  const { SqliteStore } = require('../../../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../../../dist-electron/main/metabotStore.js');
  const mrc721 = await import('../../../dist-electron/main/services/mrc721Service.js');
  const metaidCore = await import('../../../dist-electron/main/services/metaidCore.js');

  let store;
  try {
    store = await SqliteStore.create(userDataPath);
    const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());

    // Pilot config written by restore-issuer is the single source of truth.
    const cfgRow = store
      .getDatabase()
      .exec('SELECT value FROM cowork_config WHERE key = ?', [CONFIG_KEY])[0]?.values?.[0]?.[0];
    if (!cfgRow) {
      console.log(JSON.stringify({ ok: false, error: 'PILOT_CONFIG_MISSING', detail: 'run restore-issuer first' }));
      process.exit(1);
    }
    const config = JSON.parse(cfgRow);
    const metabotId = config.metabotId;
    const collectionName = config.collectionName || ISSUER_CONFIG.collectionName;

    // Idempotence / name-taken gate.
    const existing = await mrc721.fetchMrc721CollectionInfo({ name: collectionName });
    if (existing) {
      const creator = String(existing.createAddress || '');
      if (creator === ISSUER_CONFIG.issuerAddress) {
        console.log(JSON.stringify({
          ok: true,
          stage: 'register-collection',
          skipped: 'ALREADY_REGISTERED',
          collectionName,
          pinId: existing.pinid || null,
          createAddress: creator,
        }, null, 2));
        return;
      }
      console.log(JSON.stringify({
        ok: false,
        error: 'COLLECTION_NAME_TAKEN',
        detail: `collection "${collectionName}" exists with createAddress ${creator} — stop-and-report per PRD §11-1`,
        existing,
      }, null, 2));
      process.exit(1);
    }

    // Fresh same-origin binding signature (PRD §8 M0).
    const binding = signIssuerBinding(issuerKey.privateKey, ISSUER_CONFIG.issuerAddress);
    const metadata = {
      swap: {
        mode: 'mrc721-mint-on-demand',
        from: 'MetaContract',
        legacyGenesis: ISSUER_CONFIG.genesis,
        legacyCodeHash: ISSUER_CONFIG.codeHash,
        legacySensibleId: ISSUER_CONFIG.sensibleId,
        issuerAddress: ISSUER_CONFIG.issuerAddress,
        issuerPath: ISSUER_CONFIG.issuerPath,
        bindingMessage: binding.message,
        bindingSignature: binding.signature,
        signedAt: new Date().toISOString(),
        pilot: 'metabot-avatar-swap-v1',
      },
    };

    const createPinWrapper = (id, metaidData, options) =>
      metaidCore.createPin(metabotStore, id, metaidData, {
        ...options,
        feeRate: options?.feeRate ?? 1,
        sponsorMode: 'self',
      });

    console.error('[register-collection] broadcasting collection_desc pin…');
    const result = await mrc721.createMrc721Collection(
      { createPin: createPinWrapper },
      {
        metabotId,
        collectionName,
        name: 'MetaBot Avatar',
        desc:
          'Official swap collection: legacy MetaContract MetaBot Avatar items are exchanged 1:1 for the same-numbered MRC-721 item, minted on demand by the original issuer. Legacy genesis ' +
          ISSUER_CONFIG.genesis +
          '. Old 999-series avatars are NOT in scope.',
        totalSupply: ISSUER_CONFIG.tokenSupply,
        royaltyRate: 0,
        metadata,
        network: 'mvc',
        origin: 'tool:nft_swap_m0_register',
      },
    );
    console.error('[register-collection] pin broadcast:', result.pinId);

    // R1 confirmation: collection/info must resolve (≥5 min budget per PRD §5.6).
    const waited = await mrc721.waitForMrc721CollectionInfo({
      name: collectionName,
      pinId: result.pinId,
      timeoutMs: 360_000,
      intervalMs: 5_000,
    });

    // Persist the collection pinId into the pilot config.
    config.collectionPinId = result.pinId;
    config.collectionRegisteredAt = new Date().toISOString();
    config.collectionRegisteredTxids = result.txids;
    store
      .getDatabase()
      .run('UPDATE cowork_config SET value = ?, updated_at = ? WHERE key = ?', [
        JSON.stringify(config),
        Date.now(),
        CONFIG_KEY,
      ]);
    store.getSaveFunction()();

    const evidence = {
      ok: true,
      stage: 'register-collection',
      collectionName,
      pinId: result.pinId,
      txids: result.txids,
      totalCost: result.totalCost,
      totalSupply: ISSUER_CONFIG.tokenSupply,
      confirmedByIndexer: Boolean(waited.hit),
      collectionInfo: waited.hit ?? null,
      lastError: waited.lastError ?? null,
      bindingMessage: binding.message,
      bindingSignature: binding.signature,
    };
    const evidenceText = JSON.stringify(evidence);
    for (const word of mnemonic.split(' ')) {
      if (word.length >= 4 && evidenceText.includes(word)) {
        console.log(JSON.stringify({ ok: false, error: 'EVIDENCE_CONTAMINATION' }));
        process.exit(1);
      }
    }
    console.log(JSON.stringify(evidence, null, 2));
    if (!waited.hit) {
      // Broadcast succeeded; indexer lag only. Report but keep exit 0 — the
      // collection pin IS on chain; acceptance re-checks collection/info.
      console.error('[register-collection] WARNING: collection/info not indexed within budget');
    }
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
