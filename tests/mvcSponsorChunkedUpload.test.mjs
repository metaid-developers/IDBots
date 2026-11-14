import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_CHUNK_THRESHOLD_BYTES,
  selectUploadMode,
} = require('../dist-electron/main/services/metaFileUploadShared.js');
const {
  uploadFileToMetaFsMultipart,
} = await import('../dist-electron/main/services/metaFsMultipartUpload.js');
const {
  uploadMvcSponsorChunkedFile,
} = await import('../dist-electron/main/services/mvcSponsorChunkedUpload.js');
const {
  TrafficInsufficientError,
} = await import('../dist-electron/main/services/mvcSponsorCreatePin.js');
const {
  resetSponsorCircuitBreakerForTests,
} = await import('../dist-electron/main/services/mvcSponsorCircuitBreaker.js');
const {
  initTrafficAccountService,
  resetTrafficAccountServiceForTests,
  listLocalTrafficJournal,
} = await import('../dist-electron/main/services/trafficAccountService.js');

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET_PATH = "m/44'/10001'/0'/0/0";
const BOT_ADDRESS = '1C24mA4h5W8zG9sN9c8z9B3L7P8fQ6bJ3H';
const METAID = 'a'.repeat(64);
const INDEX_TXID = '1'.repeat(64);

function createFakeStore() {
  const kv = new Map();
  const journalRows = [];
  return {
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    getSaveFunction: () => () => {},
    getDatabase: () => ({
      run(sql, params = []) {
        if (/INSERT INTO traffic_spend_journal/i.test(sql)) {
          journalRows.push({
            id: journalRows.length + 1,
            tx_id: params[0],
            bot_address: params[1],
            order_id: params[2],
            tx_size: params[3],
            sponsored_miner_fee: params[4],
            saved_fee: params[5],
            billed_by: params[6],
            kind: params[7],
            me_amount_milli: params[8],
            created_at: params[9],
          });
        }
      },
      exec(sql) {
        if (/PRAGMA table_info/i.test(sql)) {
          return [{
            columns: ['cid', 'name'],
            values: [
              [0, 'id'], [1, 'tx_id'], [2, 'bot_address'], [3, 'order_id'],
              [4, 'tx_size'], [5, 'sponsored_miner_fee'], [6, 'saved_fee'],
              [7, 'billed_by'], [8, 'kind'], [9, 'me_amount_milli'], [10, 'created_at'],
            ],
          }];
        }
        if (/SELECT \* FROM traffic_spend_journal/i.test(sql)) {
          const ordered = [...journalRows].reverse();
          return [{
            columns: [
              'id', 'tx_id', 'bot_address', 'order_id', 'tx_size',
              'sponsored_miner_fee', 'saved_fee', 'billed_by', 'kind', 'me_amount_milli', 'created_at',
            ],
            values: ordered.map((r) => [
              r.id, r.tx_id, r.bot_address, r.order_id, r.tx_size,
              r.sponsored_miner_fee, r.saved_fee, r.billed_by, r.kind, r.me_amount_milli, r.created_at,
            ]),
          }];
        }
        return [];
      },
    }),
  };
}

function createFetchStub(routes) {
  return async (url, init = {}) => {
    const rawUrl = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    for (const [pattern, handler] of routes) {
      const matched = typeof pattern === 'string' ? rawUrl.includes(pattern) : pattern.test(rawUrl);
      if (!matched) continue;
      const out = await handler(rawUrl, body, init);
      const status = out.status ?? 200;
      const envelope = out.rawEnvelope ?? { code: 0, message: 'ok', data: out.data ?? out };
      return new Response(JSON.stringify(envelope), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${rawUrl}`);
  };
}

test('selectUploadMode routes files >= 5 MiB to chunked and < 5 MiB to direct', () => {
  assert.equal(DEFAULT_CHUNK_THRESHOLD_BYTES, 5 * 1024 * 1024);
  assert.equal(selectUploadMode({ sizeBytes: 5 * 1024 * 1024 - 1 }), 'direct');
  assert.equal(selectUploadMode({ sizeBytes: 5 * 1024 * 1024 }), 'chunked');
  assert.equal(selectUploadMode({ sizeBytes: 10 * 1024 * 1024 }), 'chunked');
});

test('uploadFileToMetaFsMultipart streams multi-part file from disk cleanly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metafs-multipart-'));
  const filePath = path.join(tempDir, 'sample.bin');
  try {
    const payload = Buffer.alloc(1024 * 1024 + 512, 0x42);
    fs.writeFileSync(filePath, payload);

    const uploadedParts = [];
    const fetchImpl = createFetchStub([
      ['/api/v1/config', () => ({ data: { maxFileSize: 50 * 1024 * 1024, chains: { mvc: { feeRate: 5, chunkSize: 2 * 1024 * 1024 } } } })],
      ['/api/v1/files/multipart/initiate', () => ({ data: { uploadId: 'up-1', key: 'storage/key-1' } })],
      ['/api/v1/files/multipart/upload-part', (_url, body) => {
        uploadedParts.push({ partNumber: body.partNumber, byteLen: Buffer.from(body.content, 'base64').length });
        return { data: { partNumber: body.partNumber, etag: `etag-${body.partNumber}` } };
      }],
      ['/api/v1/files/multipart/complete', () => ({ data: { key: 'storage/key-1' } })],
    ]);

    const result = await uploadFileToMetaFsMultipart({
      filePath,
      fileName: 'sample.bin',
      size: payload.length,
      metaId: METAID,
      address: BOT_ADDRESS,
      uploaderBaseUrl: 'https://metafs.test',
      fetchImpl,
    });
    assert.equal(result.storageKey, 'storage/key-1');
    assert.deepEqual(uploadedParts, [
      { partNumber: 1, byteLen: 1024 * 1024 },
      { partNumber: 2, byteLen: 512 },
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('uploadMvcSponsorChunkedFile charges ME points via ABS and journals the spend', async () => {
  resetSponsorCircuitBreakerForTests();
  const fakeStore = createFakeStore();
  initTrafficAccountService({
    getStore: () => fakeStore,
    getMetabotStore: () => ({ listMetabots: () => [] }),
    getUserIdentityStore: () => ({ get: () => null }),
  });

  let capturedBody = null;
  let selfPaidCalls = 0;
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => ({
      data: {
        exists: true,
        balance: 0,
        grantedAmount: 0,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: 0,
        status: 'active',
        me: { trafficBilling: true, spendableMilli: 500_000 },
      },
    })],
    ['/v2/assist/gas/mvc/challenge', () => ({
      data: { challengeId: 'ch-1', message: 'assist-sponsor-challenge:ch-1:9999999999999' },
    })],
    ['/v2/assist/gas/mvc/chunked-upload', (_url, body) => {
      capturedBody = body;
      return {
        data: {
          orderId: 'order-chunk-1',
          txId: INDEX_TXID,
          pinId: `${INDEX_TXID}i0`,
          chunkTxIds: ['c'.repeat(64)],
          txSize: 5_244_000,
          minerFee: 26_220_000,
          paySource: 'me',
          meAmountMilli: 105_000,
        },
      };
    }],
  ]);

  try {
    const result = await uploadMvcSponsorChunkedFile({
      data: Buffer.alloc(5 * 1024 * 1024, 7),
      fileName: 'video.mp4',
      uploadPath: '/file/video.mp4',
      contentType: 'video/mp4;binary',
      bytes: 5 * 1024 * 1024,
      feeRate: 5,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: BOT_ADDRESS,
      metaId: METAID,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
      uploadMultipart: async () => ({
        storageKey: 'metafs/key-123',
        uploaderBaseUrl: 'https://metafs.test',
        limits: { maxFileSize: 50 * 1024 * 1024, feeRate: 5, chunkSize: 2 * 1024 * 1024 },
      }),
      resolveTrafficAccount: async ({ billing }) => ({
        accountId: 'idq1alice',
        authSignature: 'sig-me',
        timestamp: 1700000000,
        billing,
      }),
      selfPaidChunkedUpload: async () => {
        selfPaidCalls += 1;
        return {};
      },
    });

    assert.equal(selfPaidCalls, 0);
    assert.equal(capturedBody.storageKey, 'metafs/key-123');
    assert.equal(capturedBody.trafficAccount.billing, 'me');
    assert.equal(result.pinId, `${INDEX_TXID}i0`);
    assert.equal(result.uploadMode, 'chunked');
    assert.equal(result.feeAssist.used, true);
    assert.equal(result.feeAssist.billedBy, 'me');
    assert.equal(result.feeAssist.meAmountMilli, 105_000);

    const journal = listLocalTrafficJournal({ limit: 10 });
    assert.equal(journal.length, 1);
    assert.equal(journal[0].txId, INDEX_TXID);
    assert.equal(journal[0].billedBy, 'me');
    assert.equal(journal[0].meAmountMilli, 105_000);
    assert.equal(journal[0].kind, '/file/index');
  } finally {
    resetTrafficAccountServiceForTests();
    resetSponsorCircuitBreakerForTests();
  }
});

test('uploadMvcSponsorChunkedFile polls order on SPONSOR_BROADCAST_PENDING and resolves on broadcast', async () => {
  resetSponsorCircuitBreakerForTests();
  let orderPollCount = 0;
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => ({
      data: {
        exists: true,
        balance: 0,
        grantedAmount: 0,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: 0,
        status: 'active',
        me: { trafficBilling: true, spendableMilli: 500_000 },
      },
    })],
    ['/v2/assist/gas/mvc/challenge', () => ({
      data: { challengeId: 'ch-2', message: 'assist-sponsor-challenge:ch-2:9999999999999' },
    })],
    ['/v2/assist/gas/mvc/chunked-upload', () => ({
      rawEnvelope: {
        code: 1,
        message: 'SPONSOR_BROADCAST_PENDING: orderId=order-pend-1',
        data: { errorCode: 'SPONSOR_BROADCAST_PENDING', orderId: 'order-pend-1', retryable: true, nextPollAfterMs: 1 },
      },
    })],
    ['/v2/assist/gas/mvc/order/order-pend-1', () => {
      orderPollCount += 1;
      if (orderPollCount < 2) {
        return {
          data: {
            orderId: 'order-pend-1',
            status: 'broadcasting',
            txSize: 6_000_000,
            minerFee: 30_000_000,
            pending: true,
            final: false,
          },
        };
      }
      return {
        data: {
          orderId: 'order-pend-1',
          status: 'broadcasted',
          txId: INDEX_TXID,
          txSize: 6_000_000,
          minerFee: 30_000_000,
          paySource: 'me',
          meAmountMilli: 120_000,
          pending: false,
          final: true,
        },
      };
    }],
  ]);

  const result = await uploadMvcSponsorChunkedFile({
    data: Buffer.alloc(6 * 1024 * 1024, 1),
    fileName: 'archive.zip',
    uploadPath: '/file/archive.zip',
    contentType: 'application/zip;binary',
    bytes: 6 * 1024 * 1024,
    feeRate: 5,
    mnemonic: MNEMONIC,
    walletPath: WALLET_PATH,
    mvcAddress: BOT_ADDRESS,
    metaId: METAID,
    fallbackPolicy: 'selfpay',
    baseUrl: 'https://sponsor.test',
    fetchImpl,
    uploadMultipart: async () => ({
      storageKey: 'metafs/key-pend',
      uploaderBaseUrl: 'https://metafs.test',
      limits: { maxFileSize: 50 * 1024 * 1024, feeRate: 5, chunkSize: 2 * 1024 * 1024 },
    }),
    resolveTrafficAccount: async ({ billing }) => ({
      accountId: 'idq1alice',
      authSignature: 'sig-me',
      timestamp: 1700000000,
      billing,
    }),
    selfPaidChunkedUpload: async () => {
      throw new Error('should not fall back when pending order broadcasts');
    },
    commitReconcilePollIntervalMs: 1,
    commitReconcileMaxWaitMs: 5_000,
  });

  assert.equal(orderPollCount, 2);
  assert.equal(result.pinId, `${INDEX_TXID}i0`);
  assert.equal(result.feeAssist.used, true);
  assert.equal(result.feeAssist.commitRecovered, true);
  assert.equal(result.feeAssist.meAmountMilli, 120_000);
  resetSponsorCircuitBreakerForTests();
});

test('uploadMvcSponsorChunkedFile falls back to self-paid (reusing storageKey) when ME is insufficient', async () => {
  resetSponsorCircuitBreakerForTests();
  let multipartCount = 0;
  let fallbackArgs = null;

  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => ({
      data: {
        exists: true,
        balance: 0,
        grantedAmount: 0,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: 0,
        status: 'active',
        me: { trafficBilling: true, spendableMilli: 5_000 },
      },
    })],
    ['/v2/assist/gas/mvc/challenge', () => ({
      data: { challengeId: 'ch-3', message: 'assist-sponsor-challenge:ch-3:9999999999999' },
    })],
    ['/v2/assist/gas/mvc/chunked-upload', () => ({
      rawEnvelope: {
        code: 1,
        message: 'ME balance insufficient',
        data: { errorCode: 'ME_INSUFFICIENT', neededMilli: 120_000, availableMilli: 5_000, retryable: false },
      },
    })],
  ]);

  const result = await uploadMvcSponsorChunkedFile({
    data: Buffer.alloc(6 * 1024 * 1024, 2),
    fileName: 'fallback.bin',
    uploadPath: '/file/fallback.bin',
    contentType: 'application/octet-stream;binary',
    bytes: 6 * 1024 * 1024,
    feeRate: 5,
    mnemonic: MNEMONIC,
    walletPath: WALLET_PATH,
    mvcAddress: BOT_ADDRESS,
    metaId: METAID,
    fallbackPolicy: 'selfpay',
    baseUrl: 'https://sponsor.test',
    fetchImpl,
    uploadMultipart: async () => {
      multipartCount += 1;
      return {
        storageKey: 'metafs/reuse-key',
        uploaderBaseUrl: 'https://metafs.test',
        limits: { maxFileSize: 50 * 1024 * 1024, feeRate: 5, chunkSize: 2 * 1024 * 1024 },
      };
    },
    resolveTrafficAccount: async ({ billing }) => ({
      accountId: 'idq1alice',
      authSignature: 'sig-me',
      timestamp: 1700000000,
      billing,
    }),
    selfPaidChunkedUpload: async (feeAssist, storageKey) => {
      fallbackArgs = { feeAssist, storageKey };
      return {
        pinId: `${INDEX_TXID}i0`,
        uploadMode: 'chunked',
        feeAssist,
      };
    },
  });

  assert.equal(multipartCount, 1);
  assert.equal(fallbackArgs.storageKey, 'metafs/reuse-key');
  assert.equal(fallbackArgs.feeAssist.used, false);
  assert.equal(fallbackArgs.feeAssist.mode, 'self_paid');
  assert.equal(fallbackArgs.feeAssist.reason, 'insufficient_me');
  assert.equal(fallbackArgs.feeAssist.requiredMilli, 120_000);
  assert.equal(fallbackArgs.feeAssist.spendableMilli, 5_000);
  assert.equal(result.pinId, `${INDEX_TXID}i0`);
  resetSponsorCircuitBreakerForTests();
});

test('uploadMvcSponsorChunkedFile tags INSUFFICIENT_SELFPAY_FUNDS when both ME and wallet SPACE fail', async () => {
  resetSponsorCircuitBreakerForTests();
  const fetchImpl = createFetchStub([
    ['/v2/assist/gas/address/info', () => ({
      data: {
        exists: true,
        balance: 0,
        grantedAmount: 0,
        reservedAmount: 0,
        spentAmount: 0,
        availableAmount: 0,
        status: 'active',
        me: { trafficBilling: true, spendableMilli: 0 },
      },
    })],
  ]);

  await assert.rejects(
    uploadMvcSponsorChunkedFile({
      data: Buffer.alloc(5 * 1024 * 1024, 3),
      fileName: 'broke.bin',
      uploadPath: '/file/broke.bin',
      contentType: 'application/octet-stream;binary',
      bytes: 5 * 1024 * 1024,
      feeRate: 5,
      mnemonic: MNEMONIC,
      walletPath: WALLET_PATH,
      mvcAddress: BOT_ADDRESS,
      metaId: METAID,
      fallbackPolicy: 'selfpay',
      baseUrl: 'https://sponsor.test',
      fetchImpl,
      selfPaidChunkedUpload: async () => {
        throw new Error('Insufficient MVC balance for chunked upload: requires ~25000000 sats (0.25 SPACE), only 0 sats (0 SPACE) spendable');
      },
    }),
    (error) => error.code === 'INSUFFICIENT_SELFPAY_FUNDS' && error.data?.feeAssist?.reason === 'insufficient_me',
  );
  resetSponsorCircuitBreakerForTests();
});
