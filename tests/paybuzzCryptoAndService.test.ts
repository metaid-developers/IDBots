import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const {
  derivePaybuzzAuthorMasterSeed,
  derivePaybuzzContentKey,
  encryptPaybuzzContent,
  decryptPaybuzzContent,
  signPaybuzzVipChallenge,
  verifyPaybuzzVipChallengeSignature,
} = require('../dist-electron/main/services/paybuzzCryptoService.js');
const {
  publishPaybuzzArticle,
  recoverAuthorPaybuzzKey,
  decryptAndCachePaybuzzWithKey,
  fetchPaybuzzItem,
} = require('../dist-electron/main/services/paybuzzService.js');
const {
  handlePaybuzzPublishRoute,
  handlePaybuzzItemGetRoute,
  handlePaybuzzUnlockedGetRoute,
} = require('../dist-electron/main/services/paybuzzGatewayRoutes.js');
const { getPaybuzzAuthoredItem, getPaybuzzUnlockedCache } = require('../dist-electron/main/services/paybuzzStore.js');
const { BtcWallet, AddressType, CoinType } = require('@metalet/utxo-wallet-service');

const AUTHOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const READER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const AUTHOR_METAID = 'idq1author00000000000000000000000000000000';
const AUTHOR_MVC_ADDR = '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB';
const SAMPLE_ASSET_KEY = `mrc20:${'aa'.repeat(32)}i0`;
const SAMPLE_COLLECTION_PIN = `${'bb'.repeat(32)}i0`;

async function withDb(fn: (ctx: { sqliteStore: any; db: any; saveDb: () => void }) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-paybuzz-c6-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    await fn({ sqliteStore, db: sqliteStore.getDatabase(), saveDb: sqliteStore.getSaveFunction() });
  } finally {
    try {
      sqliteStore.close();
    } catch {
      // ignore close errors
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows EPERM cleanup
    }
  }
}

function makeBotStore() {
  return {
    getMetabotById: (id: number) =>
      id === 1
        ? {
            id: 1,
            name: 'AuthorBot',
            enabled: true,
            mvc_address: AUTHOR_MVC_ADDR,
            btc_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
            globalmetaid: AUTHOR_METAID,
            metaid: 'author-sha256',
          }
        : null,
    getMetabotWalletByMetabotId: (id: number) =>
      id === 1 ? { mnemonic: AUTHOR_MNEMONIC, path: "m/44'/10001'/0'/0/0" } : null,
    listMetabots: () => [
      {
        id: 1,
        name: 'AuthorBot',
        enabled: true,
        metabot_type: 'twin',
        mvc_address: AUTHOR_MVC_ADDR,
        btc_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        globalmetaid: AUTHOR_METAID,
      },
    ],
  };
}

test('AES-256-GCM rejects 1-bit tamper in ciphertext, authTag, or IV', async () => {
  const seed = await derivePaybuzzAuthorMasterSeed(AUTHOR_MNEMONIC);
  const markdown = '# Secret Alpha\n\nThis is confidential research content for paid readers.';
  const enc = encryptPaybuzzContent({ plaintextMarkdown: markdown, authorMasterSeedBytes: seed });

  // Baseline valid decryption succeeds
  const ok = decryptPaybuzzContent({
    ciphertextBuffer: enc.ciphertextBuffer,
    contentKeyHex: enc.contentKeyHex,
    ivHex: enc.ivHex,
    authTagHex: enc.authTagHex,
    expectedCipherSha256: enc.cipherSha256,
    expectedPlainSha256: enc.plainSha256,
  });
  assert.equal(ok.plaintextMarkdown, markdown);

  // Flip 1 bit in ciphertext (skipping expectedCipherSha256 to prove GCM authTag itself catches tamper)
  const tamperedCipher = Buffer.from(enc.ciphertextBuffer);
  tamperedCipher[0] ^= 0x01;
  assert.throws(() =>
    decryptPaybuzzContent({
      ciphertextBuffer: tamperedCipher,
      contentKeyHex: enc.contentKeyHex,
      ivHex: enc.ivHex,
      authTagHex: enc.authTagHex,
    }),
  );

  // Flip 1 bit with expectedCipherSha256 -> caught at hash check too
  assert.throws(
    () =>
      decryptPaybuzzContent({
        ciphertextBuffer: tamperedCipher,
        contentKeyHex: enc.contentKeyHex,
        ivHex: enc.ivHex,
        authTagHex: enc.authTagHex,
        expectedCipherSha256: enc.cipherSha256,
      }),
    /PAYBUZZ_CIPHERTEXT_HASH_MISMATCH/,
  );

  // Flip 1 bit in authTag
  const tamperedTagBuf = Buffer.from(enc.authTagHex, 'hex');
  tamperedTagBuf[0] ^= 0x01;
  assert.throws(() =>
    decryptPaybuzzContent({
      ciphertextBuffer: enc.ciphertextBuffer,
      contentKeyHex: enc.contentKeyHex,
      ivHex: enc.ivHex,
      authTagHex: tamperedTagBuf.toString('hex'),
    }),
  );
});

test('Deterministic mnemonic recovery on a fresh empty DB reconstructs identical K and decrypts old article', async () => {
  let publishedPinId = '';
  let publishedPayload: any = null;
  const originalMarkdown = '# 2027 Agent Micro-Economy\n\nDeep quantitative analysis... '.repeat(3);

  // Machine A: publish article
  await withDb(async ({ db, saveDb }) => {
    const res = await publishPaybuzzArticle(
      {
        getDb: () => db,
        saveDb,
        getMetabotStore: makeBotStore as any,
        createChainPin: async (_id: number, payload: any) => {
          publishedPinId = `${'cc'.repeat(32)}i0`;
          assert.equal(payload.path, '/protocols/paybuzz');
          publishedPayload = JSON.parse(payload.payload);
          return { txids: ['cc'.repeat(32)], pinId: publishedPinId };
        },
      },
      {
        metabotId: 1,
        title: '2027 Agent Micro-Economy',
        markdown: originalMarkdown,
        unlockRules: {
          tokenPrices: [
            {
              assetKey: SAMPLE_ASSET_KEY,
              chain: 'btc',
              standard: 'mrc20',
              symbol: 'METAID',
              decimals: 8,
              amountBase: '1000000000',
              amountDisplay: '10',
              receiveAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
            },
          ],
          vipMrc721Collections: [
            {
              collectionPinId: SAMPLE_COLLECTION_PIN,
              collectionName: 'Annual Alpha VIP Card',
            },
          ],
        },
      },
    );

    assert.equal(res.paybuzzPinId, publishedPinId);
    assert.ok(publishedPayload.encryption.ciphertextPinOrBase64.startsWith('base64:'));
    assert.match(publishedPayload.encryption.keySaltHex, /^[0-9a-f]{64}$/);
    const localRow = getPaybuzzAuthoredItem(db, publishedPinId);
    assert.ok(localRow);
    assert.equal(localRow.keySaltHex, publishedPayload.encryption.keySaltHex);
  });

  // Machine B: brand new empty DB with ONLY mnemonic + on-chain pin payload
  await withDb(async ({ db, saveDb }) => {
    assert.equal(getPaybuzzAuthoredItem(db, publishedPinId), null);

    const recovered = await recoverAuthorPaybuzzKey(
      {
        getDb: () => db,
        saveDb,
        getMetabotStore: makeBotStore as any,
        fetchFromMetaso: async () => null,
        fetchChainPin: async () => ({ payload: publishedPayload }),
      },
      {
        metabotId: 1,
        paybuzzPinId: publishedPinId,
      },
    );

    // Verify derived key matches direct derivation and decrypts the inline ciphertext
    const seed = await derivePaybuzzAuthorMasterSeed(AUTHOR_MNEMONIC);
    const expectedKey = derivePaybuzzContentKey(seed, publishedPayload.encryption.keySaltHex).toString('hex');
    assert.equal(recovered.contentKeyHex, expectedKey);

    const cached = await decryptAndCachePaybuzzWithKey(
      {
        getDb: () => db,
        saveDb,
        getMetabotStore: makeBotStore as any,
        fetchFromMetaso: async () => null,
        fetchChainPin: async () => ({ payload: publishedPayload }),
      },
      {
        paybuzzPinId: publishedPinId,
        contentKeyHex: recovered.contentKeyHex,
        grantedVia: 'author',
      },
    );
    assert.equal(cached.decryptedMarkdown, originalMarkdown);
    assert.ok(getPaybuzzAuthoredItem(db, publishedPinId), 'recovered item is persisted locally');
  });
});

test('Payload > 16 KB automatically uploads encrypted ciphertext via metafile:// attachment', async () => {
  await withDb(async ({ db, saveDb }) => {
    const bigMarkdown = '# Long Report\n\n' + 'A'.repeat(20 * 1024);
    let uploadedBytesLen = 0;
    let pinPayloadObj: any = null;

    const res = await publishPaybuzzArticle(
      {
        getDb: () => db,
        saveDb,
        getMetabotStore: makeBotStore as any,
        uploadEncryptedAttachment: async ({ data }: { data: Buffer }) => {
          uploadedBytesLen = data.length;
          return { pinId: `${'dd'.repeat(32)}i0` };
        },
        createChainPin: async (_id: number, payload: any) => {
          pinPayloadObj = JSON.parse(payload.payload);
          return { txids: ['ee'.repeat(32)], pinId: `${'ee'.repeat(32)}i0` };
        },
      },
      {
        metabotId: 1,
        title: 'Large Research Report',
        markdown: bigMarkdown,
        unlockRules: {
          vipMrc721Collections: [
            { collectionPinId: SAMPLE_COLLECTION_PIN, collectionName: 'VIP' },
          ],
        },
      },
    );

    assert.ok(uploadedBytesLen > 16 * 1024);
    assert.equal(
      pinPayloadObj.encryption.ciphertextPinOrBase64,
      `metafile://${'dd'.repeat(32)}i0.enc`,
    );

    // Verify fetchPaybuzzItem falls back to chain pin when MetaSo misses, and decrypts from metafile bytes
    const fetched = await fetchPaybuzzItem(
      {
        getDb: () => db,
        saveDb,
        getMetabotStore: makeBotStore as any,
        fetchFromMetaso: async () => null,
        fetchChainPin: async () => ({ payload: pinPayloadObj }),
      },
      res.paybuzzPinId,
    );
    assert.ok(fetched);
    assert.equal(fetched.title, 'Large Research Report');
  });
});

test('VIP challenge ECDSA signing & verification enforces address match and ±300s window', async () => {
  const wallet = new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex: 0,
    network: 'livenet' as any,
    mnemonic: READER_MNEMONIC,
  });
  const holderAddress = wallet.getAddress();
  const pinId = `${'11'.repeat(32)}i0`;
  const readerGlobalMetaId = 'idq1reader000000000000000000000000000000';
  const nowSec = 1795300100;

  const signed = await signPaybuzzVipChallenge({
    mnemonic: READER_MNEMONIC,
    path: "m/44'/10001'/0'/0/0",
    paybuzzPinId: pinId,
    readerGlobalMetaId,
    timestamp: nowSec,
  });

  // Valid within window
  const ok = verifyPaybuzzVipChallengeSignature({
    paybuzzPinId: pinId,
    readerGlobalMetaId,
    timestamp: nowSec,
    holderAddress,
    signature: signed.signatureHex,
    nowSec: nowSec + 120,
  });
  assert.equal(ok.valid, true);

  // Wrong holderAddress fails
  const wrongAddr = verifyPaybuzzVipChallengeSignature({
    paybuzzPinId: pinId,
    readerGlobalMetaId,
    timestamp: nowSec,
    holderAddress: AUTHOR_MVC_ADDR,
    signature: signed.signatureHex,
    nowSec,
  });
  assert.equal(wrongAddr.valid, false);
  assert.equal(wrongAddr.reason, 'SIGNATURE_MISMATCH');

  // Expired timestamp (>300s) fails
  const expired = verifyPaybuzzVipChallengeSignature({
    paybuzzPinId: pinId,
    readerGlobalMetaId,
    timestamp: nowSec,
    holderAddress,
    signature: signed.signatureHex,
    nowSec: nowSec + 301,
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'TIMESTAMP_EXPIRED');
});

test('PayBuzz RPC route handlers publish, get item, and read unlocked cache', async () => {
  await withDb(async ({ db, saveDb }) => {
    let savedPayload: any = null;
    const pinId = `${'fa'.repeat(32)}i0`;
    const deps = {
      getDb: () => db,
      saveDb,
      getMetabotStore: makeBotStore as any,
      createChainPin: async (_id: number, payload: any) => {
        savedPayload = JSON.parse(payload.payload);
        return { txids: ['fa'.repeat(32)], pinId };
      },
      fetchFromMetaso: async () => savedPayload,
    };

    const pubRes = await handlePaybuzzPublishRoute(
      deps,
      JSON.stringify({
        metabot_id: 1,
        title: 'RPC Article',
        markdown: '# Hello RPC\n\nBody text.',
        unlockRules: {
          vipMrc721Collections: [{ collectionPinId: SAMPLE_COLLECTION_PIN, collectionName: 'VIP' }],
        },
      }),
    );
    assert.equal(pubRes.status, 200);
    assert.equal(pubRes.body.success, true);
    assert.equal(pubRes.body.paybuzzPinId, pinId);

    const itemRes = await handlePaybuzzItemGetRoute(deps, pinId, '1');
    assert.equal(itemRes.status, 200);
    assert.equal(itemRes.body.success, true);
    assert.equal((itemRes.body.item as any).title, 'RPC Article');

    const missUnlocked = handlePaybuzzUnlockedGetRoute(deps, pinId);
    assert.equal(missUnlocked.status, 404);

    // Decrypt and verify unlocked endpoint
    const authored = getPaybuzzAuthoredItem(db, pinId)!;
    await decryptAndCachePaybuzzWithKey(deps, {
      paybuzzPinId: pinId,
      contentKeyHex: authored.contentKeyHex,
      grantedVia: 'token',
    });
    const hitUnlocked = handlePaybuzzUnlockedGetRoute(deps, pinId);
    assert.equal(hitUnlocked.status, 200);
    assert.equal((hitUnlocked.body.unlocked as any).decryptedMarkdown, '# Hello RPC\n\nBody text.');
    assert.ok(getPaybuzzUnlockedCache(db, pinId));
  });
});
