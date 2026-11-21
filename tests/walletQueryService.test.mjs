import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompiled(rel) {
  const candidates = [`../dist-electron/main/${rel}`, `../dist-electron/main/${rel}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try next compile output layout
    }
  }
  return require.resolve(candidates[0]);
}


function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  };
}

// walletQueryService only depends on freshFetch (no Electron), but keep the
// electron stub for robustness across import-chain changes.
function loadWalletQueryService() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = resolveCompiled('services/walletQueryService.js');
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1 && id !== 2) return null;
      return {
        id,
        name: id === 1 ? 'Twin' : 'Worker',
        mvc_address: `1MvcAddr${id}`,
        btc_address: `1BtcAddr${id}`,
        doge_address: `DogeAddr${id}`,
        public_key: 'pk',
      };
    },
  };
}

test('mvc truth layer: headline from balance-info (Metalet parity), cross-checked against the utxo walk', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  const seenUrls = [];
  global.fetch = async (url) => {
    const href = String(url);
    seenUrls.push(href);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { address: '1MvcAddr1', confirmed: 125, unconfirmed: 50, utxoCount: 3 } });
    }
    if (!href.includes('/wallet-api/v4/mvc/address/utxo-list')) {
      throw new Error(`unexpected fetch: ${href}`);
    }
    if (!href.includes('flag=')) {
      return jsonResponse({
        code: 0,
        data: {
          list: [
            { txid: 'a', outIndex: 0, value: 100, height: 100, flag: 'page-2' },
            { txid: 'b', outIndex: 1, value: 50, height: -1, flag: 'page-2' },
          ],
        },
      });
    }
    return jsonResponse({
      code: 0,
      data: {
        list: [
          { txid: 'c', outIndex: 0, value: 25, height: 200 },
        ],
      },
    });
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr1');
    assert.equal(snapshot.confirmed_sats, 125, 'headline confirmed comes from the balance endpoint');
    assert.equal(snapshot.unconfirmed_sats, 50);
    assert.equal(snapshot.total_sats, 175);
    assert.equal(snapshot.utxo_count, 3, 'utxo_count is the listed row count');
    assert.equal(snapshot.unit, 'SPACE');
    assert.equal(snapshot.mvc_truth.verdict, 'ok');
    assert.equal(snapshot.mvc_truth.index_utxo_count, 3);
    assert.equal(snapshot.mvc_truth.utxo_listed_sum_sats, 175);
    assert.ok(seenUrls.some((u) => u.includes('/mvc/address/balance-info')), 'the balance endpoint is read');
    assert.ok(seenUrls.some((u) => u.includes('flag=page-2')), 'the utxo walk still paginates');
  } finally {
    global.fetch = originalFetch;
  }
});

test('mvc truth layer: degraded fallback when the balance endpoint is down', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return new Response('404 page not found', { status: 404 });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [{ txid: 'a', outIndex: 0, value: 175, height: 100 }] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr1');
    assert.equal(snapshot.total_sats, 175, 'figures fall back to the utxo walk');
    assert.equal(snapshot.mvc_truth.verdict, 'degraded');
    assert.match(snapshot.mvc_truth.reason, /balance endpoint unavailable/);
    assert.match(snapshot.mvc_truth.guidance, /Do NOT report this wallet as spent-out/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('mvc truth layer: empty-wallet reading with history escalates and degrades', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 0, unconfirmed: 0, utxoCount: 0 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [] } });
    }
    if (href.includes('/mvc/address/tx-list')) {
      // One page, churn-only net (income == outcome): the probe reads
      // serverTotal > 0 → the index may be under-reporting even though the
      // history sum agrees the wallet nets to zero.
      return jsonResponse({ code: 0, data: { total: 500, list: [{ txid: 'a'.repeat(64), income: 1000, outcome: 1000, height: 100, flag: '2' }] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr1');
    assert.equal(snapshot.mvc_truth.verdict, 'degraded');
    assert.match(snapshot.mvc_truth.reason, /empty wallet but the address has transaction history/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('mvc truth layer: genuine zero when history is also empty', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 0, unconfirmed: 0, utxoCount: 0 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [] } });
    }
    if (href.includes('/mvc/address/tx-list')) {
      return jsonResponse({ code: 0, data: { total: 0, list: [] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr1');
    assert.equal(snapshot.total_sats, 0);
    assert.equal(snapshot.mvc_truth.verdict, 'ok', 'a wallet with no history at all is genuinely empty');
  } finally {
    global.fetch = originalFetch;
  }
});

test('mvc truth layer: deep verification switches the headline to the history sum on divergence', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 8169543, unconfirmed: 0, utxoCount: 32 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [{ txid: 'a', outIndex: 0, value: 8169543, height: 100 }] } });
    }
    if (href.includes('/mvc/address/tx-list')) {
      if (!href.includes('flag=')) {
        const rows = Array.from({ length: 10 }, (_, i) => ({
          txid: `${String(i).padStart(2, '0')}${'a'.repeat(62)}`,
          income: 55_000_000,
          outcome: 0,
          height: 100,
          flag: 'page-2',
        }));
        return jsonResponse({ code: 0, data: { total: 20, list: rows } });
      }
      return jsonResponse({ code: 0, data: { total: 20, list: [] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr1', { deep: true });
    assert.equal(snapshot.total_sats, 550_000_000, 'the on-chain history sum wins the headline');
    assert.equal(snapshot.mvc_truth.verdict, 'degraded');
    assert.match(snapshot.mvc_truth.reason, /disagrees with transaction history/);
    assert.equal(snapshot.mvc_truth.history_complete, true);
    assert.equal(snapshot.mvc_truth.index_total_sats, 8_169_543, 'the index view is preserved for the cross-check line');
  } finally {
    global.fetch = originalFetch;
  }
});

test('mvc truth layer: deep on an oversized history reports the bound instead of verifying', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  let page = 0;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 1000, unconfirmed: 0, utxoCount: 1 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [{ txid: 'a', outIndex: 0, value: 1000, height: 100 }] } });
    }
    if (href.includes('/mvc/address/tx-list')) {
      page += 1;
      const rows = Array.from({ length: 10 }, (_, i) => ({
        txid: `${String(page % 100).padStart(2, '0')}${String(i).padStart(2, '0')}${'b'.repeat(60)}`,
        income: 10,
        outcome: 10,
        height: 100,
        flag: `p${page + 1}`,
      }));
      return jsonResponse({ code: 0, data: { total: 999999, list: rows } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('mvc', '1MvcAddr1', { deep: true });
    assert.equal(snapshot.mvc_truth.verdict, 'degraded');
    assert.match(snapshot.mvc_truth.reason, /could not be fully verified from history/);
    assert.equal(snapshot.mvc_truth.history_complete, false);
    assert.equal(snapshot.total_sats, 1000, 'the headline stays on the index view when history is unverified');
    assert.ok(page > 1, 'the walk actually paged');
  } finally {
    global.fetch = originalFetch;
  }
});

test('mvc truth layer: both endpoints failing throws the aggregate error', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('503 service unavailable', { status: 503 });
  try {
    await assert.rejects(
      () => getWalletBalanceSnapshot('mvc', '1MvcAddr1'),
      /mvc balance unavailable: balance-info .+ utxo-list /,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('btc v3 utxo list: confirmed boolean splits the sum', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (!href.includes('/wallet-api/v3/address/btc-utxo')) {
      throw new Error(`unexpected fetch: ${href}`);
    }
    assert.ok(href.includes('unconfirmed=1'));
    return jsonResponse({
      code: 0,
      data: [
        { txId: 't1', outputIndex: 0, satoshis: 700, confirmed: true },
        { txId: 't2', outputIndex: 1, value: 300, confirmed: false },
      ],
    });
  };
  try {
    const snapshot = await getWalletBalanceSnapshot('btc', '1BtcAddr1');
    assert.equal(snapshot.confirmed_sats, 700);
    assert.equal(snapshot.unconfirmed_sats, 300);
    assert.equal(snapshot.total_sats, 1000);
    assert.equal(snapshot.unit, 'BTC');
  } finally {
    global.fetch = originalFetch;
  }
});

test('provider error code surfaces as a thrown error', async () => {
  const { getWalletBalanceSnapshot } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async () => jsonResponse({ code: 1001, message: 'rate limited' });
  try {
    await assert.rejects(
      () => getWalletBalanceSnapshot('doge', 'DogeAddr1'),
      /rate limited/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('getMetabotWalletBalances batches bots and isolates per-chain errors', async () => {
  const { getMetabotWalletBalances } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 5, unconfirmed: 0, utxoCount: 1 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [{ txid: 'x', outIndex: 0, value: 5, height: 9 }] } });
    }
    if (href.includes('/doge/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [] } });
    }
    if (href.includes('/btc/address/btc-utxo')) {
      return jsonResponse({ code: 0, data: [] });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const result = await getMetabotWalletBalances(createMetabotStore(), { metabotIds: [1, 2], chains: ['mvc', 'doge'] });
    assert.equal(result.entries.length, 2);
    assert.ok(result.queried_at);
    for (const entry of result.entries) {
      assert.equal(entry.balances.mvc.total_sats, 5);
      assert.equal(entry.balances.doge.total_sats, 0);
      assert.equal(entry.balances.btc, undefined);
    }
    await assert.rejects(
      () => getMetabotWalletBalances(createMetabotStore(), { metabotIds: [3] }),
      /MetaBot not found: 3/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('appendMvcBalanceHint enriches balance errors only', async () => {
  const { appendMvcBalanceHint } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 1200, unconfirmed: 0, utxoCount: 1 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({
        code: 0,
        data: { list: [{ txid: 'x', outIndex: 0, value: 1200, height: 5 }] },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  try {
    const untouched = await appendMvcBalanceHint(createMetabotStore(), 1, 'some other failure');
    assert.equal(untouched, 'some other failure');

    const enriched = await appendMvcBalanceHint(createMetabotStore(), 1, 'not enough balance', {
      needSats: 6000,
      needIsEstimate: true,
    });
    assert.match(enriched, /^not enough balance \[/);
    assert.match(enriched, /insufficient balance: have 1200 sats \(0\.00001200 SPACE\)/);
    assert.match(enriched, /need ~6000 sats/);
    assert.match(enriched, /confirmed 1200 sats \/ unconfirmed 0 sats at 1MvcAddr1/);
    assert.doesNotMatch(enriched, /DEGRADED/, 'a healthy read carries no degraded warning');

    // Broken balance endpoint: the hint must warn instead of implying an
    // empty wallet (2026-11-20: bots claimed "funds are gone" on this read).
    global.fetch = async (url) => {
      const href = String(url);
      if (href.includes('/mvc/address/balance-info')) {
        return new Response('404 page not found', { status: 404 });
      }
      if (href.includes('/mvc/address/utxo-list')) {
        return jsonResponse({ code: 0, data: { list: [{ txid: 'x', outIndex: 0, value: 1200, height: 5 }] } });
      }
      throw new Error(`unexpected fetch: ${href}`);
    };
    const degraded = await appendMvcBalanceHint(createMetabotStore(), 1, 'no utxo available for spend');
    assert.match(degraded, /WARNING the balance read is DEGRADED/);
    assert.match(degraded, /may NOT actually be empty/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('withMvcBalanceHint rethrows the SAME error with data preserved, mvc only', async () => {
  const { withMvcBalanceHint } = loadWalletQueryService();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes('/mvc/address/balance-info')) {
      return jsonResponse({ code: 0, data: { confirmed: 42, unconfirmed: 0, utxoCount: 1 } });
    }
    if (href.includes('/mvc/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [{ txid: 'x', outIndex: 0, value: 42, height: 5 }] } });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  const estimate = () => 1234;
  try {
    // Non-mvc network passes through untouched (no balance fetch).
    const dogeError = new Error('not enough balance');
    await assert.rejects(
      () => withMvcBalanceHint(createMetabotStore(), 1, 'doge', () => Promise.reject(dogeError), { estimateNeedSats: estimate }),
      (error) => error === dogeError && error.message === 'not enough balance',
    );

    // Non-balance error passes through untouched.
    const otherError = new Error('network down');
    await assert.rejects(
      () => withMvcBalanceHint(createMetabotStore(), 1, 'mvc', () => Promise.reject(otherError)),
      (error) => error === otherError && error.message === 'network down',
    );

    // Balance error on mvc: same error object, enriched message, data kept.
    const boom = Object.assign(new Error('not enough balance'), { data: { feeAssist: { reason: 'x' } } });
    await assert.rejects(
      () => withMvcBalanceHint(createMetabotStore(), 1, undefined, () => Promise.reject(boom), { estimateNeedSats: estimate }),
      (error) => {
        assert.equal(error, boom);
        assert.equal(error.data.feeAssist.reason, 'x');
        assert.match(error.message, /insufficient balance: have 42 sats/);
        assert.match(error.message, /need ~1234 sats/);
        return true;
      },
    );

    // Success path returns the value.
    const value = await withMvcBalanceHint(createMetabotStore(), 1, 'mvc', () => Promise.resolve('ok'));
    assert.equal(value, 'ok');
  } finally {
    global.fetch = originalFetch;
  }
});
