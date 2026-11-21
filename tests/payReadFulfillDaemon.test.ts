import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { PayReadFulfillDaemon } = require('../dist-electron/main/services/payReadFulfillDaemon.js');
const {
  formatPayReadWireMessage,
  parsePayReadWireMessage,
} = require('../dist-electron/main/services/payReadWireProtocol.js');
const { signPaybuzzVipChallenge } = require('../dist-electron/main/services/paybuzzCryptoService.js');
const { publishPaybuzzArticle } = require('../dist-electron/main/services/paybuzzService.js');
const {
  getPaybuzzUnlockedCache,
  getPaybuzzRoyaltySummary,
  getPaybuzzUsedPayment,
} = require('../dist-electron/main/services/paybuzzStore.js');
const { BtcWallet, AddressType, CoinType } = require('@metalet/utxo-wallet-service');

const AUTHOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const READER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const AUTHOR_METAID = 'idq1author00000000000000000000000000000000';
const READER_METAID = 'idq1reader00000000000000000000000000000000';
const OTHER_READER_METAID = 'idq1otherreader000000000000000000000000000';
const AUTHOR_MVC_ADDR = '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB';
const AUTHOR_BTC_ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

const REAL_BTC_MRC20_ID = `${'12'.repeat(32)}i0`;
const SPOOF_BTC_MRC20_ID = `${'99'.repeat(32)}i0`;
const REAL_BTC_ASSET_KEY = `mrc20:${REAL_BTC_MRC20_ID}`;
const SPOOF_BTC_ASSET_KEY = `mrc20:${SPOOF_BTC_MRC20_ID}`;
const MVC_CODEHASH = 'a242'.padEnd(40, '0');
const MVC_GENESIS = '005d'.padEnd(40, '1');
const REAL_MVC_ASSET_KEY = `mvc-ft:${MVC_CODEHASH}:${MVC_GENESIS}`;
const VIP_COLLECTION_PIN = `${'77'.repeat(32)}i0`;

function getReaderMvcAddress(): string {
  const wallet = new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex: 0,
    network: 'livenet' as any,
    mnemonic: READER_MNEMONIC,
  });
  return wallet.getAddress();
}

async function withDb(fn: (ctx: { sqliteStore: any; db: any; saveDb: () => void }) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-payread-daemon-'));
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
    getMetabotById: (id: number) => {
      if (id === 1) {
        return {
          id: 1,
          name: 'AuthorBot',
          enabled: true,
          mvc_address: AUTHOR_MVC_ADDR,
          btc_address: AUTHOR_BTC_ADDR,
          globalmetaid: AUTHOR_METAID,
        };
      }
      if (id === 2) {
        return {
          id: 2,
          name: 'ReaderBot',
          enabled: true,
          mvc_address: getReaderMvcAddress(),
          btc_address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
          globalmetaid: READER_METAID,
        };
      }
      return null;
    },
    getMetabotWalletByMetabotId: (id: number) => {
      if (id === 1) return { mnemonic: AUTHOR_MNEMONIC, path: "m/44'/10001'/0'/0/0" };
      if (id === 2) return { mnemonic: READER_MNEMONIC, path: "m/44'/10001'/0'/0/0" };
      return null;
    },
    listMetabots: () => [],
  };
}

async function publishTestArticle(
  db: any,
  saveDb: () => void,
  pinHexSeed: string,
  markdown: string,
  pinsMap: Map<string, any>,
) {
  const pinId = `${pinHexSeed.repeat(32)}i0`;
  const res = await publishPaybuzzArticle(
    {
      getDb: () => db,
      saveDb,
      getMetabotStore: makeBotStore as any,
      createChainPin: async (_id: number, payload: any) => {
        const parsed = JSON.parse(payload.payload);
        pinsMap.set(pinId, parsed);
        return { txids: [pinHexSeed.repeat(32)], pinId };
      },
    },
    {
      metabotId: 1,
      title: `Article ${pinHexSeed}`,
      markdown,
      unlockRules: {
        tokenPrices: [
          {
            assetKey: REAL_BTC_ASSET_KEY,
            chain: 'btc',
            standard: 'mrc20',
            symbol: 'METAID',
            decimals: 8,
            amountBase: '1000000000',
            amountDisplay: '10',
            receiveAddress: AUTHOR_BTC_ADDR,
          },
          {
            assetKey: REAL_MVC_ASSET_KEY,
            chain: 'mvc',
            standard: 'metacontract-ft',
            codehash: MVC_CODEHASH,
            genesis: MVC_GENESIS,
            symbol: 'SHOW',
            decimals: 8,
            amountBase: '5000000000',
            amountDisplay: '50',
            receiveAddress: AUTHOR_MVC_ADDR,
          },
        ],
        vipMrc721Collections: [
          {
            collectionPinId: VIP_COLLECTION_PIN,
            collectionName: 'VIP Column Pass',
          },
        ],
      },
    },
  );
  return res.paybuzzPinId;
}

test('Track A VIP NFT: grants key when holder owns active card, rejects immediately after card is sold', async () => {
  await withDb(async ({ db, saveDb }) => {
    const pinsMap = new Map<string, any>();
    const secretBody = '# VIP Exclusive Research\n\nFull institutional breakdown for VIP holders.';
    const pinId = await publishTestArticle(db, saveDb, 'a1', secretBody, pinsMap);

    let holderOwnsCard = true;
    const sentMessages: Array<{ metabotId: number; toGlobalMetaId: string; content: string }> = [];
    const emittedEvents: Array<{ channel: string; payload: any }> = [];
    const nowSec = 1795300100;

    const daemon = new PayReadFulfillDaemon(db, saveDb, {
      getDb: () => db,
      saveDb,
      getMetabotStore: makeBotStore as any,
      fetchFromMetaso: async (id: string) => pinsMap.get(id) ?? null,
      fetchMrc721ItemsForAddress: async () =>
        holderOwnsCard
          ? [{ itemPinId: `${'88'.repeat(32)}i0`, collectionPinId: VIP_COLLECTION_PIN, burned: false }]
          : [],
      sendPayReadMessage: async (msg: any) => {
        sentMessages.push(msg);
      },
      emitToRenderer: (channel: string, payload: any) => {
        emittedEvents.push({ channel, payload });
      },
      nowMs: () => nowSec * 1000,
    });

    // Non-payread plaintext is ignored (returns handled: false)
    const ignored = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: 'Hello author, nice weather today!',
    });
    assert.equal(ignored.handled, false);

    // Reader signs VIP challenge and requests unlock while holding VIP NFT
    const readerAddr = getReaderMvcAddress();
    const signed = await signPaybuzzVipChallenge({
      mnemonic: READER_MNEMONIC,
      paybuzzPinId: pinId,
      readerGlobalMetaId: READER_METAID,
      timestamp: nowSec,
    });
    const reqWire = formatPayReadWireMessage({
      type: 'PAYREAD_VIP_REQ_V1',
      paybuzzPinId: pinId,
      collectionPinId: VIP_COLLECTION_PIN,
      holderAddress: readerAddr,
      readerGlobalMetaId: READER_METAID,
      timestamp: nowSec,
      signatureHex: signed.signatureHex,
    });

    const res1 = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: reqWire,
    });
    assert.equal(res1.handled, true);
    assert.equal(res1.outcome, 'granted');
    assert.equal(sentMessages.length, 1);
    const grantWire = parsePayReadWireMessage(sentMessages[0].content);
    assert.equal(grantWire?.type, 'PAYREAD_KEY_GRANT_V1');
    assert.equal((grantWire as any).grantedVia, 'vip-nft');

    // Reader receives PAYREAD_KEY_GRANT_V1 -> decrypts and stores in paybuzz_unlocked_cache
    const readerHandle = await daemon.handleIncomingPayReadMessage({
      metabotId: 2,
      fromGlobalMetaId: AUTHOR_METAID,
      plaintext: sentMessages[0].content,
    });
    assert.equal(readerHandle.handled, true);
    assert.equal(readerHandle.outcome, 'unlocked_cached');
    const cached = getPaybuzzUnlockedCache(db, pinId);
    assert.ok(cached);
    assert.equal(cached.decryptedMarkdown, secretBody);
    assert.equal(cached.grantedVia, 'vip-nft');
    assert.ok(emittedEvents.some((e) => e.channel === 'paybuzz:unlocked' && e.payload.paybuzzPinId === pinId));

    // Now reader SELLS the VIP card -> real-time MRC-721 query returns empty -> daemon MUST reject!
    holderOwnsCard = false;
    const res2 = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: reqWire,
    });
    assert.equal(res2.handled, true);
    assert.equal(res2.outcome, 'rejected');
    assert.equal(res2.reason, 'VIP_CARD_NOT_HELD');
    const rejectWire = parsePayReadWireMessage(sentMessages[1].content);
    assert.equal(rejectWire?.type, 'PAYREAD_REJECTED_V1');
    assert.equal((rejectWire as any).code, 'VIP_CARD_NOT_HELD');
  });
});

test('Track B FT Micropayment: blocks S-01 spoofed ticker, blocks S-02 reverted MRC-20 output, blocks S-06 cross-article replay, allows same-reader same-article idempotent retry', async () => {
  await withDb(async ({ db, saveDb }) => {
    const pinsMap = new Map<string, any>();
    const pin1 = await publishTestArticle(db, saveDb, 'b1', '# Article One Secret', pinsMap);
    const pin2 = await publishTestArticle(db, saveDb, 'b2', '# Article Two Secret', pinsMap);

    const realPaymentTxId = 'ab'.repeat(32);
    const revertedTxId = 'cd'.repeat(32);
    const mvcPaymentTxId = 'ef'.repeat(32);
    const sentMessages: Array<{ metabotId: number; toGlobalMetaId: string; content: string }> = [];
    const notifications: any[] = [];

    const daemon = new PayReadFulfillDaemon(db, saveDb, {
      getDb: () => db,
      saveDb,
      getMetabotStore: makeBotStore as any,
      fetchFromMetaso: async (id: string) => pinsMap.get(id) ?? null,
      fetchBtcMrc20RecipientUtxos: async ({ paymentTxId }: { paymentTxId: string }) => {
        if (paymentTxId === realPaymentTxId) {
          return [
            {
              txId: realPaymentTxId,
              address: AUTHOR_BTC_ADDR,
              status: 'TransferPendingIn',
              mrc20s: [{ mrc20Id: REAL_BTC_MRC20_ID, tick: 'METAID', amount: '10' }],
            },
          ];
        }
        if (paymentTxId === revertedTxId) {
          // S-02 simulation: sendAllAmountToFirstOutput returned failed/refunded or went to sender address
          return [
            {
              txId: revertedTxId,
              address: AUTHOR_BTC_ADDR,
              status: 'Failed',
              mrc20s: [{ mrc20Id: REAL_BTC_MRC20_ID, tick: 'METAID', amount: '10' }],
            },
          ];
        }
        return [];
      },
      fetchMvcFtVerifiedUtxos: async ({ paymentTxId }: { paymentTxId: string }) => {
        if (paymentTxId === mvcPaymentTxId) {
          return [
            {
              txId: mvcPaymentTxId,
              codehash: MVC_CODEHASH,
              genesis: MVC_GENESIS,
              ownerAddress: AUTHOR_MVC_ADDR,
              amountBase: '5000000000',
            },
          ];
        }
        return [];
      },
      sendPayReadMessage: async (msg: any) => {
        sentMessages.push(msg);
      },
      recordNotification: (n: any) => notifications.push(n),
    });

    // 1. S-01 Ticker Spoofing: fake $METAID assetKey rejected
    const spoofRes = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin1,
        assetKey: SPOOF_BTC_ASSET_KEY,
        paymentTxId: realPaymentTxId,
        readerGlobalMetaId: READER_METAID,
      }),
    });
    assert.equal(spoofRes.outcome, 'rejected');
    assert.equal(spoofRes.reason, 'UNSUPPORTED_ASSET_KEY');

    // 2. S-02 Reverted / Failed MRC-20 output rejected
    const s02Res = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin1,
        assetKey: REAL_BTC_ASSET_KEY,
        paymentTxId: revertedTxId,
        readerGlobalMetaId: READER_METAID,
      }),
    });
    assert.equal(s02Res.outcome, 'rejected');
    assert.equal(s02Res.reason, 'BTC_MRC20_OUTPUT_NOT_FOUND_OR_REVERTED');

    // 3. Valid BTC MRC-20 payment succeeds -> key granted + used_payments recorded + royalty logged
    const okRes = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin1,
        assetKey: REAL_BTC_ASSET_KEY,
        paymentTxId: realPaymentTxId,
        readerGlobalMetaId: READER_METAID,
      }),
    });
    assert.equal(okRes.outcome, 'granted');
    assert.ok(getPaybuzzUsedPayment(db, realPaymentTxId));
    assert.equal(getPaybuzzRoyaltySummary(db, 1).count, 1);
    assert.equal(notifications.length, 1);

    // 4. S-06 Cross-Article Replay Attack: same paymentTxId used on pin2 MUST be hard-blocked!
    const replayArticle2 = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin2,
        assetKey: REAL_BTC_ASSET_KEY,
        paymentTxId: realPaymentTxId,
        readerGlobalMetaId: READER_METAID,
      }),
    });
    assert.equal(replayArticle2.outcome, 'rejected');
    assert.equal(replayArticle2.reason, 'PAYMENT_TX_ALREADY_USED');

    // 5. S-06 Cross-Reader Replay Attack on same pin1 MUST also be blocked!
    const replayOtherReader = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: OTHER_READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin1,
        assetKey: REAL_BTC_ASSET_KEY,
        paymentTxId: realPaymentTxId,
        readerGlobalMetaId: OTHER_READER_METAID,
      }),
    });
    assert.equal(replayOtherReader.outcome, 'rejected');
    assert.equal(replayOtherReader.reason, 'PAYMENT_TX_ALREADY_USED');

    // 6. Idempotent retry whitelist: SAME reader re-sending for SAME pin1 re-grants key without duplicating royalty
    const sentBeforeRetry = sentMessages.length;
    const retryRes = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin1,
        assetKey: REAL_BTC_ASSET_KEY,
        paymentTxId: realPaymentTxId,
        readerGlobalMetaId: READER_METAID,
      }),
    });
    assert.equal(retryRes.outcome, 'granted_idempotent');
    assert.equal(sentMessages.length, sentBeforeRetry + 1);
    assert.equal(parsePayReadWireMessage(sentMessages[sentMessages.length - 1].content)?.type, 'PAYREAD_KEY_GRANT_V1');
    assert.equal(getPaybuzzRoyaltySummary(db, 1).count, 1, 'royalty must not be double-counted on retry');

    // 7. MVC FT payment on pin2 succeeds via higun/MVC verifier
    const mvcRes = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_TOKEN_REQ_V1',
        paybuzzPinId: pin2,
        assetKey: REAL_MVC_ASSET_KEY,
        paymentTxId: mvcPaymentTxId,
        readerGlobalMetaId: READER_METAID,
      }),
    });
    assert.equal(mvcRes.outcome, 'granted');
    assert.equal(getPaybuzzRoyaltySummary(db, 1).count, 2);
  });
});

test('Fresh machine recovery: PayReadFulfillDaemon derives key from mnemonic + chain keySaltHex when local authored DB is empty', async () => {
  const pinsMap = new Map<string, any>();
  let pinId = '';
  const body = '# Mnemonic Disaster Recovery Article\n\nStill fulfills even on a fresh machine!';

  // Machine 1 publishes
  await withDb(async ({ db, saveDb }) => {
    pinId = await publishTestArticle(db, saveDb, 'c1', body, pinsMap);
  });

  // Machine 2 has empty SQLite DB and only author mnemonic
  await withDb(async ({ db, saveDb }) => {
    const sentMessages: any[] = [];
    const daemon = new PayReadFulfillDaemon(db, saveDb, {
      getDb: () => db,
      saveDb,
      getMetabotStore: makeBotStore as any,
      fetchFromMetaso: async (id: string) => pinsMap.get(id) ?? null,
      fetchMrc721ItemsForAddress: async () => [
        { itemPinId: `${'55'.repeat(32)}i0`, collectionPinId: VIP_COLLECTION_PIN, burned: false },
      ],
      sendPayReadMessage: async (msg: any) => {
        sentMessages.push(msg);
      },
      nowMs: () => 1795300100 * 1000,
    });

    const signed = await signPaybuzzVipChallenge({
      mnemonic: READER_MNEMONIC,
      paybuzzPinId: pinId,
      readerGlobalMetaId: READER_METAID,
      timestamp: 1795300100,
    });
    const res = await daemon.handleIncomingPayReadMessage({
      metabotId: 1,
      fromGlobalMetaId: READER_METAID,
      plaintext: formatPayReadWireMessage({
        type: 'PAYREAD_VIP_REQ_V1',
        paybuzzPinId: pinId,
        collectionPinId: VIP_COLLECTION_PIN,
        holderAddress: getReaderMvcAddress(),
        readerGlobalMetaId: READER_METAID,
        timestamp: 1795300100,
        signatureHex: signed.signatureHex,
      }),
    });
    assert.equal(res.outcome, 'granted');

    // Verify granted key decrypts the original markdown
    const grant = parsePayReadWireMessage(sentMessages[0].content);
    assert.equal(grant?.type, 'PAYREAD_KEY_GRANT_V1');
    const readerHandle = await daemon.handleIncomingPayReadMessage({
      metabotId: 2,
      fromGlobalMetaId: AUTHOR_METAID,
      plaintext: sentMessages[0].content,
    });
    assert.equal(readerHandle.outcome, 'unlocked_cached');
    assert.equal(getPaybuzzUnlockedCache(db, pinId)?.decryptedMarkdown, body);
  });
});
