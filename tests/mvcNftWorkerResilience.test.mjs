import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const workerApi = require('../dist-electron/main/libs/mvcNftWorkerApi.js');

let mvcNftService;
try {
  mvcNftService = require('../dist-electron/main/services/mvcNftService.js');
} catch {
  mvcNftService = null;
}

const CODEHASH = 'e205939ad9956673ce7da9fbd40514b30f66dc35';
const GENESIS = '005d69cba8c80e6978157e146f998c21288a9d49';
const HOLDER_ADDRESS = '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const VAULT_ADDRESS = '1Mw6q8iZ2dYXd6vYwdYfd3ybUKNnWKj8ET';
const NFT_TXID = 'cad519c5b04b94ddacf0245b0222c869b27aacb2b825fc1edf1d5057dd0903df';
const PRE_TXID = '9f08a1112233445566778899aabbccddeeff00112233445566778899aabbccdd';
const SAMPLE_HEX = '01000000000000000000';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

test('parseWorkerProcessOutput extracts structured stderr error even when stdout has ANSI noise from meta-contract', () => {
  const noisyStdout = [
    "request failed. { uri: \u001b[32m'https://api.microvisionchain.com/open-api-mvc/contract/nft/genesis/...'\u001b[39m,",
    '  timeout: \u001b[33m180000\u001b[39m }',
  ].join('\n');
  const stderr = [
    '[buildMvcNftTransferRawTxWorker] Fetched MVC NFT funding candidates {"candidateOutpoints":["abc:0"]}',
    JSON.stringify({
      success: false,
      error: 'network timeout at: https://api.microvisionchain.com/open-api-mvc/contract/nft/genesis/utxo',
    }),
  ].join('\n');

  assert.throws(
    () => workerApi.parseWorkerProcessOutput(noisyStdout, stderr),
    (err) => {
      assert.equal(
        err.message,
        'network timeout at: https://api.microvisionchain.com/open-api-mvc/contract/nft/genesis/utxo',
      );
      assert.ok(!err.message.includes('\u001b['), 'error must not contain ANSI escape codes');
      assert.ok(!err.message.includes('request failed.'), 'error must not dump raw stdout noise');
      return true;
    },
  );
});

test('parseWorkerProcessOutput returns structured success from stdout despite preceding diagnostic noise', () => {
  const stdout = [
    'some library debug line',
    JSON.stringify({
      success: true,
      txHex: SAMPLE_HEX,
      txid: NFT_TXID,
      spentOutpoints: [`${NFT_TXID}:0`],
    }),
  ].join('\n');
  const stderr = '[worker] step log\n';

  const parsed = workerApi.parseWorkerProcessOutput(stdout, stderr);
  assert.equal(parsed.success, true);
  assert.equal(parsed.txHex, SAMPLE_HEX);
  assert.equal(parsed.txid, NFT_TXID);
});

test('findHeldNftUtxoViaMetalet queries Metalet v4 without codeHash/genesis params, paginates safely, and short-circuits on match', async () => {
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.searchParams.has('codeHash'), false, 'must NOT pass codeHash param to Metalet v4');
    assert.equal(parsedUrl.searchParams.has('genesis'), false, 'must NOT pass genesis param to Metalet v4');
    const flag = parsedUrl.searchParams.get('flag');
    if (!flag) {
      return jsonResponse({
        code: 0,
        data: {
          list: [
            {
              address: HOLDER_ADDRESS,
              txId: '11'.repeat(32),
              txIndex: 0,
              codeHash: CODEHASH,
              genesis: GENESIS,
              tokenIndex: 1001,
              flag: 'cursor-page-1',
            },
          ],
        },
      });
    }
    if (flag === 'cursor-page-1') {
      return jsonResponse({
        code: 0,
        data: {
          list: [
            {
              address: HOLDER_ADDRESS,
              txId: NFT_TXID,
              txIndex: '0',
              codeHash: CODEHASH.toUpperCase(),
              genesis: GENESIS,
              tokenIndex: 8539,
              metaTxId: PRE_TXID,
              metaOutputIndex: 0,
              flag: 'cursor-page-2',
            },
          ],
        },
      });
    }
    throw new Error('should short-circuit before fetching page 3');
  };

  const detail = await workerApi.findHeldNftUtxoViaMetalet(
    HOLDER_ADDRESS,
    { codehash: CODEHASH, genesis: GENESIS, tokenIndex: '8539' },
    { fetchImpl, retryDelayMs: 0 },
  );

  assert.equal(seenUrls.length, 2);
  assert.deepEqual(detail, {
    txId: NFT_TXID,
    outputIndex: 0,
    tokenAddress: HOLDER_ADDRESS,
    tokenIndex: '8539',
    metaTxId: PRE_TXID,
    metaOutputIndex: 0,
  });
});

test('createResilientMvcNftApiMethods resolves NFT UTXO via Metalet v4 without touching open-api-mvc, and falls back when needed', async () => {
  const urlsPrimary = [];
  const primaryApi = workerApi.createResilientMvcNftApiMethods({
    holderAddress: HOLDER_ADDRESS,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      urlsPrimary.push(url);
      if (url.includes('/wallet-api/v4/mvc/address/contract/nft/utxo-list')) {
        return jsonResponse({
          code: 0,
          data: {
            list: [
              {
                address: HOLDER_ADDRESS,
                txId: NFT_TXID,
                txIndex: 0,
                codeHash: CODEHASH,
                genesis: GENESIS,
                tokenIndex: '8539',
                flag: '0',
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fallback call: ${url}`);
    },
  });

  const resolvedPrimary = await primaryApi.getNonFungibleTokenUnspentDetail(CODEHASH, GENESIS, '8539');
  assert.equal(resolvedPrimary.txId, NFT_TXID);
  assert.equal(resolvedPrimary.outputIndex, 0);
  assert.equal(urlsPrimary.length, 1);
  assert.ok(urlsPrimary[0].includes('metalet.space'), 'primary lookup should hit Metalet v4 only');

  // Now simulate Metalet v4 failing with HTTP 503 twice, verifying bounded fallback to open-api-mvc succeeds.
  const urlsFallback = [];
  const fallbackApi = workerApi.createResilientMvcNftApiMethods({
    holderAddress: HOLDER_ADDRESS,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      urlsFallback.push(url);
      if (url.includes('metalet.space')) {
        return jsonResponse({ message: 'unavailable' }, 503);
      }
      if (url.includes('open-api-mvc/contract/nft/genesis/')) {
        return jsonResponse([
          {
            txid: NFT_TXID,
            txIndex: 2,
            address: HOLDER_ADDRESS,
            tokenIndex: 8539,
            metaTxid: PRE_TXID,
            metaOutputIndex: 1,
          },
        ]);
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const resolvedFallback = await fallbackApi.getNonFungibleTokenUnspentDetail(CODEHASH, GENESIS, '8539');
  assert.equal(resolvedFallback.txId, NFT_TXID);
  assert.equal(resolvedFallback.outputIndex, 2);
  assert.equal(resolvedFallback.metaTxId, PRE_TXID);
  assert.equal(resolvedFallback.metaOutputIndex, 1);
  assert.equal(urlsFallback.length, 3, '2 Metalet attempts + 1 open-api-mvc fallback');
});

test('createResilientMvcNftApiMethods caches raw tx hex across repeated calls and falls back to open-api-mvc tx/raw', async () => {
  let fetchCalls = 0;
  const api = workerApi.createResilientMvcNftApiMethods({
    maxAttempts: 1,
    retryDelayMs: 0,
    fetchImpl: async (url) => {
      fetchCalls += 1;
      if (url.includes('metalet.space') && url.includes(PRE_TXID)) {
        throw new Error('TypeError: fetch failed');
      }
      if (url.includes('metalet.space') && url.includes(NFT_TXID)) {
        return jsonResponse({ code: 0, data: { hex: SAMPLE_HEX } });
      }
      if (url.includes(`open-api-mvc/tx/${PRE_TXID}/raw`)) {
        return textResponse('02000000000000000000');
      }
      throw new Error(`unexpected url: ${url}`);
    },
  });

  const first = await api.getRawTxData(NFT_TXID);
  const second = await api.getRawTxData(NFT_TXID.toUpperCase());
  assert.equal(first, SAMPLE_HEX);
  assert.equal(second, SAMPLE_HEX);
  assert.equal(fetchCalls, 1, 'cached txid must not re-fetch');

  const fallbackHex = await api.getRawTxData(PRE_TXID);
  assert.equal(fallbackHex, '02000000000000000000');
  assert.equal(fetchCalls, 3, '1 cached hit + 1 Metalet miss + 1 open-api-mvc fallback');
});

test('fetchMvcFundingUtxos stops on flag="0" or repeated flag and retries transient timeout', async () => {
  let calls = 0;
  const rows = await workerApi.fetchMvcFundingUtxos(HOLDER_ADDRESS, {
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        const timeoutErr = new Error('The operation was aborted due to timeout');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }
      return jsonResponse({
        code: 0,
        data: {
          list: [
            { txid: NFT_TXID, outIndex: 1, value: 5000, height: 123456, flag: '0' },
            { txid: PRE_TXID, outIndex: 0, value: 546, height: 123456, flag: '0' },
          ],
        },
      });
    },
  });

  assert.equal(calls, 2, 'should retry once after timeout and stop on flag="0"');
  assert.equal(rows.length, 1, 'dust (<600 sats) should be filtered out');
  assert.equal(rows[0].txid, NFT_TXID);
  assert.equal(rows[0].value, 5000);
});

test('executeMvcNftTransfer retries transient buildRawTx upstream timeouts and immediately fails non-retryable errors', async (t) => {
  if (!mvcNftService) {
    t.skip('mvcNftService requires Electron runtime resolution');
    return;
  }

  const fakeStore = {};
  let buildAttempts = 0;
  let broadcastCalls = 0;

  const transferResult = await mvcNftService.executeMvcNftTransfer(
    fakeStore,
    {
      metabotId: 1,
      genesis: GENESIS,
      codehash: CODEHASH,
      tokenIndex: '8539',
      toAddress: VAULT_ADDRESS,
      feeRate: 1,
    },
    {
      retryDelayMs: 0,
      buildRawTx: async () => {
        buildAttempts += 1;
        if (buildAttempts === 1) {
          throw new Error('MVC upstream request failed: The operation was aborted due to timeout');
        }
        return {
          raw_tx: SAMPLE_HEX,
          txid: NFT_TXID,
          spent_outpoints: [`${NFT_TXID}:0`],
        };
      },
      broadcastTx: async (rawTx) => {
        broadcastCalls += 1;
        assert.equal(rawTx, SAMPLE_HEX);
        return NFT_TXID;
      },
    },
  );

  assert.equal(buildAttempts, 2, 'transient upstream timeout in buildRawTx must be retried');
  assert.equal(broadcastCalls, 1);
  assert.equal(transferResult.txId, NFT_TXID);

  let nonRetryableAttempts = 0;
  await assert.rejects(
    () => mvcNftService.executeMvcNftTransfer(
      fakeStore,
      {
        metabotId: 1,
        genesis: GENESIS,
        codehash: CODEHASH,
        tokenIndex: '8539',
        toAddress: VAULT_ADDRESS,
        feeRate: 1,
      },
      {
        retryDelayMs: 0,
        buildRawTx: async () => {
          nonRetryableAttempts += 1;
          throw new Error('No spendable MVC UTXOs after exclusions');
        },
        broadcastTx: async () => NFT_TXID,
      },
    ),
    /No spendable MVC UTXOs after exclusions/,
  );
  assert.equal(nonRetryableAttempts, 1, 'permanent balance/exclusion errors must not retry');
});
