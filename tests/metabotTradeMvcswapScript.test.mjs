import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);

const { handleTradeRequest } = require('../SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js');

const SPACE_MC_PAIR = {
  token1: { symbol: 'space', decimal: 8 },
  token2: { symbol: 'mc', tokenID: 'mc-id', genesisHash: 'mc-genesis', codeHash: 'mc-code', decimal: 8 },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function createAllPairsResponse(pair = SPACE_MC_PAIR) {
  return jsonResponse({
    code: 0,
    data: {
      'space-mc': pair,
    },
  });
}

function readSerializedGzipJson(body) {
  const serialized = JSON.parse(body);
  const compressed = serialized?.data?.data || serialized?.data;
  return JSON.parse(gunzipSync(Buffer.from(compressed)).toString('utf-8'));
}

function createFetchStubForQuote() {
  return async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse();
    }
    if (href.includes('/router/route')) {
      return jsonResponse({
        code: 0,
        data: {
          path: 'v1',
          amountIn: '1000000000',
          amountOut: '400000000',
        },
      });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    throw new Error(`Unexpected fetch in quote stub: ${href} ${options.method || 'GET'}`);
  };
}

function createFetchStubForDirectSpaceTrade(calls) {
  return async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, method: options.method || 'GET', body: options.body || null });
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse();
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v1', amountIn: '1000000000', amountOut: '400000000' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    if (href.includes('/api/idbots/metabot/account-summary')) {
      return jsonResponse({ success: true, metabot_id: 1, mvc_address: 'mvc-from-address', public_key: 'pub' });
    }
    if (href.includes('/api/idbots/address/balance')) {
      return jsonResponse({
        success: true,
        balance: {
          mvc: {
            value: 100,
            unit: 'SPACE',
            satoshis: 10000000000,
            address: 'mvc-from-address',
          },
        },
      });
    }
    if (href.includes('/swap/reqswapargs')) {
      return jsonResponse({
        code: 0,
        data: {
          requestIndex: 'req-1',
          mvcToAddress: 'mvc-swap-address',
          tokenToAddress: 'mvc-token-address',
          txFee: 10000,
        },
      });
    }
    if (href.includes('/api/idbots/wallet/mvc/build-transfer-rawtx')) {
      return jsonResponse({ success: true, raw_tx: 'mvc-raw', txid: 'mvc-txid', output_index: 0 });
    }
    if (href.includes('/swap/token1totoken2')) {
      return jsonResponse({ code: 0, data: { txid: 'swap-space-to-token', token2Amount: '400000000' } });
    }
    throw new Error(`Unexpected fetch in direct space trade stub: ${href}`);
  };
}

function createFetchStubForDirectTokenTrade(calls) {
  return async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, method: options.method || 'GET', body: options.body || null });
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse();
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v1', amountIn: '500000000', amountOut: '900000000' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    if (href.includes('/api/idbots/metabot/account-summary')) {
      return jsonResponse({ success: true, metabot_id: 1, mvc_address: 'mvc-from-address', public_key: 'pub' });
    }
    if (href.includes('/api/idbots/address/balance')) {
      return jsonResponse({
        success: true,
        balance: {
          mvc: {
            value: 1,
            unit: 'SPACE',
            satoshis: 100000000,
            address: 'mvc-from-address',
          },
        },
      });
    }
    if (href.includes('/swap/reqswapargs')) {
      return jsonResponse({
        code: 0,
        data: {
          requestIndex: 'req-2',
          mvcToAddress: 'mvc-fee-address',
          tokenToAddress: 'mvc-token-address',
          txFee: 10000,
        },
      });
    }
    if (href.includes('/api/idbots/wallet/mvc/build-rawtx-bundle')) {
      return jsonResponse({
        success: true,
        steps: [
          {
            index: 0,
            kind: 'mvc_transfer',
            raw_tx: 'mvc-fee-raw',
            txid: 'mvc-fee-txid',
            output_index: 0,
            change_outpoint: 'mvc-fee-txid:1',
          },
          {
            index: 1,
            kind: 'mvc_ft_transfer',
            raw_tx: 'ft-raw',
            output_index: 0,
            amount_check_raw_tx: 'amount-check-raw',
            spent_outpoints: ['a'.repeat(64) + ':0', 'b'.repeat(64) + ':1'],
            resolved_funding_outpoint: 'mvc-fee-txid:1',
          },
        ],
      });
    }
    if (href.includes('/swap/token2totoken1')) {
      return jsonResponse({ code: 0, data: { txid: 'swap-token-to-space', token1Amount: '900000000' } });
    }
    throw new Error(`Unexpected fetch in direct token trade stub: ${href}`);
  };
}

test('quote-only request returns an estimated output without calling execute endpoints', async () => {
  const result = await handleTradeRequest({
    request: {
      action: 'quote',
      direction: 'space_to_token',
      amountIn: '10',
      tokenSymbol: 'MC',
      slippagePercent: 1,
    },
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForQuote(),
  });

  assert.equal(result.mode, 'quote');
  assert.match(result.message, /预计收到/);
  assert.match(result.message, /MC/);
});

test('quote flow formats token outputs using live token decimals', async () => {
  const pair = {
    token1: { symbol: 'space', decimal: 8 },
    token2: { symbol: 'usd1', tokenID: 'usd1-id', genesisHash: 'usd1-genesis', codeHash: 'usd1-code', decimal: 2 },
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse(pair);
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v1', amountIn: '1000000000', amountOut: '1234' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    throw new Error(`Unexpected fetch in token decimal quote stub: ${href}`);
  };

  const result = await handleTradeRequest({
    request: {
      action: 'quote',
      direction: 'space_to_token',
      amountIn: '10',
      tokenSymbol: 'USD1',
      slippagePercent: 1,
    },
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl,
  });

  assert.equal(result.mode, 'quote');
  assert.match(result.message, /12\.34 USD1/);
});

test('token -> SPACE quote uses the live token decimals when calling router', async () => {
  const calls = [];
  const pair = {
    token1: { symbol: 'space', decimal: 8 },
    token2: { symbol: 'meme', tokenID: 'meme-id', genesisHash: 'meme-genesis', codeHash: 'meme-code', decimal: 2 },
  };
  const fetchImpl = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse(pair);
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v1', amountIn: '123', amountOut: '450000000' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    throw new Error(`Unexpected fetch in token input decimal stub: ${href}`);
  };

  const result = await handleTradeRequest({
    request: {
      action: 'quote',
      direction: 'token_to_space',
      amountIn: '1.23',
      tokenSymbol: 'MEME',
      slippagePercent: 1,
    },
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl,
  });

  assert.equal(result.mode, 'quote');
  assert.ok(calls.some((href) => href.includes('/router/route') && href.includes('amount=123')));
});

test('quote flow rejects router routes that require mvcswap v2', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse();
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v2', amountIn: '1000000000', amountOut: '400000000' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    throw new Error(`Unexpected fetch in v2 route stub: ${href}`);
  };

  await assert.rejects(
    () =>
      handleTradeRequest({
        request: {
          action: 'quote',
          direction: 'space_to_token',
          amountIn: '10',
          tokenSymbol: 'MC',
          slippagePercent: 1,
        },
        env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
        fetchImpl,
      }),
    /v1/i,
  );
});

test('preview request returns a confirmation instruction when executeNow is false', async () => {
  const result = await handleTradeRequest({
    request: {
      action: 'preview',
      direction: 'space_to_token',
      amountIn: '10',
      tokenSymbol: 'MC',
      slippagePercent: 1,
    },
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForQuote(),
  });

  assert.equal(result.mode, 'preview');
  assert.match(result.message, /确认交易/);
  assert.match(result.message, /最少收到/);
});

test('SPACE -> token execute flow builds mvc raw tx and submits token1totoken2', async () => {
  const calls = [];
  const result = await handleTradeRequest({
    request: {
      action: 'execute',
      direction: 'space_to_token',
      amountIn: '10',
      tokenSymbol: 'MC',
      slippagePercent: 1,
    },
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForDirectSpaceTrade(calls),
  });

  assert.equal(result.mode, 'executed');
  assert.ok(calls.some((entry) => entry.url.includes('/api/idbots/address/balance')));
  assert.ok(calls.some((entry) => entry.url.includes('/api/idbots/wallet/mvc/build-transfer-rawtx')));
  assert.ok(calls.some((entry) => entry.url.includes('/swap/token1totoken2')));
  const swapCall = calls.find((entry) => entry.url.includes('/swap/token1totoken2'));
  const serializedSwapBody = JSON.parse(swapCall.body);
  assert.ok(serializedSwapBody.data);
  assert.ok(Array.isArray(serializedSwapBody.data.data));
  const swapBody = readSerializedGzipJson(swapCall.body);
  assert.deepEqual(swapBody, {
    symbol: 'space-mc',
    requestIndex: 'req-1',
    op: 3,
    mvcRawTx: 'mvc-raw',
    mvcOutputIndex: 0,
  });
  assert.match(result.message, /交易已提交|TxID/i);
});

test('SPACE -> token execute flow rejects when SPACE balance cannot cover input plus fee', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, method: options.method || 'GET' });
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse();
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v1', amountIn: '1000000000', amountOut: '400000000' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    if (href.includes('/api/idbots/metabot/account-summary')) {
      return jsonResponse({ success: true, metabot_id: 1, mvc_address: 'mvc-from-address', public_key: 'pub' });
    }
    if (href.includes('/swap/reqswapargs')) {
      return jsonResponse({
        code: 0,
        data: {
          requestIndex: 'req-1',
          mvcToAddress: 'mvc-swap-address',
          tokenToAddress: 'mvc-token-address',
          txFee: 10000,
        },
      });
    }
    if (href.includes('/api/idbots/address/balance')) {
      return jsonResponse({
        success: true,
        balance: {
          mvc: {
            value: 0.1,
            unit: 'SPACE',
            satoshis: 1000,
            address: 'mvc-from-address',
          },
        },
      });
    }
    throw new Error(`Unexpected fetch in insufficient balance stub: ${href}`);
  };

  await assert.rejects(
    () =>
      handleTradeRequest({
        request: {
          action: 'execute',
          direction: 'space_to_token',
          amountIn: '10',
          tokenSymbol: 'MC',
          slippagePercent: 1,
        },
        env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
        fetchImpl,
      }),
    /SPACE balance/i,
  );
  assert.ok(!calls.some((entry) => entry.url.includes('/api/idbots/wallet/mvc/build-transfer-rawtx')));
  assert.ok(!calls.some((entry) => entry.url.includes('/swap/token1totoken2')));
});

test('token -> SPACE execute flow builds ft raw tx and mvc fee raw tx before token2totoken1', async () => {
  const calls = [];
  const result = await handleTradeRequest({
    request: {
      action: 'execute',
      direction: 'token_to_space',
      amountIn: '500',
      tokenSymbol: 'MC',
      slippagePercent: 1,
    },
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForDirectTokenTrade(calls),
  });

  assert.equal(result.mode, 'executed');
  assert.ok(calls.some((entry) => entry.url.includes('/api/idbots/address/balance')));
  assert.ok(calls.some((entry) => entry.url.includes('/api/idbots/wallet/mvc/build-rawtx-bundle')));
  assert.ok(calls.some((entry) => entry.url.includes('/swap/token2totoken1')));
  const bundleCall = calls.find((entry) => entry.url.includes('/api/idbots/wallet/mvc/build-rawtx-bundle'));
  const bundleBody = JSON.parse(bundleCall.body);
  assert.equal(bundleBody.steps[0].kind, 'mvc_transfer');
  assert.equal(bundleBody.steps[0].fee_rate, 1);
  assert.equal(bundleBody.steps[0].amount_sats, 10000);
  assert.equal(bundleBody.steps[1].kind, 'mvc_ft_transfer');
  assert.equal(bundleBody.steps[1].token.genesisHash, 'mc-id');
  assert.equal(bundleBody.steps[1].funding.step_index, 0);
  assert.equal(bundleBody.steps[1].funding.use_output, 'change');
  const swapCall = calls.find((entry) => entry.url.includes('/swap/token2totoken1'));
  const serializedSwapBody = JSON.parse(swapCall.body);
  assert.ok(serializedSwapBody.data);
  assert.ok(Array.isArray(serializedSwapBody.data.data));
  const swapBody = readSerializedGzipJson(swapCall.body);
  assert.deepEqual(swapBody, {
    symbol: 'space-mc',
    requestIndex: 'req-2',
    op: 4,
    token2RawTx: 'ft-raw',
    token2OutputIndex: 0,
    amountCheckRawTx: 'amount-check-raw',
    mvcRawTx: 'mvc-fee-raw',
    mvcOutputIndex: 0,
  });
  assert.match(result.message, /交易已提交|TxID/i);
});

test('execute without MetaBot context fails with a Cowork-oriented message', async () => {
  await assert.rejects(
    () =>
      handleTradeRequest({
        request: {
          action: 'execute',
          direction: 'space_to_token',
          amountIn: '10',
          tokenSymbol: 'MC',
          slippagePercent: 1,
        },
        env: { IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
        fetchImpl: createFetchStubForQuote(),
      }),
    /MetaBot identity is not available|IDBOTS_METABOT_ID/i,
  );
});

test('token -> SPACE execute flow rejects when the mvc fee tx has no change output for FT funding', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('/swap/allpairs')) {
      return createAllPairsResponse();
    }
    if (href.includes('/router/route')) {
      return jsonResponse({ code: 0, data: { path: 'v1', amountIn: '500000000', amountOut: '900000000' } });
    }
    if (href.includes('/api/idbots/fee-rate-summary')) {
      return jsonResponse({ success: true, list: [{ title: 'Avg', feeRate: 1 }], defaultFeeRate: 1 });
    }
    if (href.includes('/api/idbots/metabot/account-summary')) {
      return jsonResponse({ success: true, metabot_id: 1, mvc_address: 'mvc-from-address', public_key: 'pub' });
    }
    if (href.includes('/api/idbots/address/balance')) {
      return jsonResponse({
        success: true,
        balance: {
          mvc: {
            value: 1,
            unit: 'SPACE',
            satoshis: 100000000,
            address: 'mvc-from-address',
          },
        },
      });
    }
    if (href.includes('/swap/reqswapargs')) {
      return jsonResponse({
        code: 0,
        data: {
          requestIndex: 'req-2',
          mvcToAddress: 'mvc-fee-address',
          tokenToAddress: 'mvc-token-address',
          txFee: 10000,
        },
      });
    }
    if (href.includes('/api/idbots/wallet/mvc/build-rawtx-bundle')) {
      return jsonResponse({
        success: false,
        error: 'Previous bundle task did not produce a change output for the next task.',
      }, 400);
    }
    throw new Error(`Unexpected fetch in missing bundle change stub: ${href}`);
  };

  await assert.rejects(
    () =>
      handleTradeRequest({
        request: {
          action: 'execute',
          direction: 'token_to_space',
          amountIn: '500',
          tokenSymbol: 'MC',
          slippagePercent: 1,
        },
        env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
        fetchImpl,
      }),
    /change output/i,
  );
});
