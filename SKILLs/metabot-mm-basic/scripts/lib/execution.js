'use strict';

const Decimal = require('decimal.js');

const { normalizePayload } = require('./payload');
const { loadConfig } = require('./config');
const { resolveFairValue } = require('./marketData');
const {
  buildBidAsk,
  computeSkewBps,
  resolveUsableInventory,
  isWithinSlippage,
  classifyOutputAmount,
  roundExecutableOutput,
} = require('./pricing');
const {
  verifyPaymentProof,
  verifyWithRetry,
} = require('./paymentProof');
const {
  buildIdempotencyKey,
  createInMemoryTerminalState,
  createLifecycleTrace,
  getTerminalOutcome,
  recordTerminalOutcome,
} = require('./state');
const {
  getAccountSummaryViaRpc,
  getAddressBalanceViaRpc,
  executeTransferViaRpc,
} = require('./localRpc');
const {
  formatSupportedPairsMessage,
  formatQuoteMessage,
  formatExecutedMessage,
  formatRefundMessage,
  formatVoidMessage,
  formatPayoutFailedMessage,
  formatRefundFailedMessage,
} = require('./formatter');

const PAIR_ASSETS = {
  'BTC/SPACE': { base: 'BTC', quote: 'SPACE' },
  'DOGE/SPACE': { base: 'DOGE', quote: 'SPACE' },
};

const CHAIN_BY_ASSET = {
  BTC: 'btc',
  DOGE: 'doge',
  SPACE: 'space',
};

const ACCOUNT_ADDRESS_KEYS = {
  BTC: 'btc_address',
  DOGE: 'doge_address',
  SPACE: 'mvc_address',
};

const BALANCE_ADDRESS_KEYS = {
  BTC: 'btc',
  DOGE: 'doge',
  SPACE: 'mvc',
};

function getMetabotId(env) {
  const metabotId = Number(env?.IDBOTS_METABOT_ID || 0);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('IDBOTS_METABOT_ID is required.');
  }
  return metabotId;
}

function getPairAssets(pair) {
  const assets = PAIR_ASSETS[String(pair || '').toUpperCase()];
  if (!assets) {
    throw new Error('unsupported pair');
  }
  return assets;
}

function getAssetChain(asset) {
  const chain = CHAIN_BY_ASSET[String(asset || '').toUpperCase()];
  if (!chain) {
    throw new Error('unsupported asset');
  }
  return chain;
}

function normalizeBalanceMap(raw) {
  if (raw && raw.balances && typeof raw.balances === 'object') {
    return raw.balances;
  }

  const balance = raw?.balance;
  if (!balance || typeof balance !== 'object') {
    return {};
  }

  return {
    BTC: balance.btc?.value != null ? String(balance.btc.value) : undefined,
    DOGE: balance.doge?.value != null ? String(balance.doge.value) : undefined,
    SPACE: balance.mvc?.value != null ? String(balance.mvc.value) : undefined,
  };
}

async function fetchAccountSummary({ deps, env, metabotId, fetchImpl }) {
  const reader = deps.getAccountSummaryViaRpc || getAccountSummaryViaRpc;
  return reader({ env, fetchImpl, metabotId });
}

async function fetchAssetBalances({ deps, env, metabotId, assets, fetchImpl }) {
  const reader = deps.getAddressBalanceViaRpc || getAddressBalanceViaRpc;
  const requestedAssets = Array.from(new Set(assets.map((asset) => String(asset).toUpperCase())));
  const body = { metabot_id: metabotId };

  if (deps.getAddressBalanceViaRpc) {
    body.addresses = Object.fromEntries(requestedAssets.map((asset) => [asset, true]));
  } else {
    const summary = await fetchAccountSummary({ deps, env, metabotId, fetchImpl });
    body.addresses = Object.fromEntries(
      requestedAssets.map((asset) => [BALANCE_ADDRESS_KEYS[asset], summary[ACCOUNT_ADDRESS_KEYS[asset]]]),
    );
  }

  const result = await reader({ env, fetchImpl, body });
  const balances = normalizeBalanceMap(result);
  return Object.fromEntries(requestedAssets.map((asset) => [asset, String(balances[asset] ?? '0')]));
}

function buildPricingContext({ pair, direction, pairConfig, fairValue, balances }) {
  const { base, quote } = getPairAssets(pair);
  const usableBase = resolveUsableInventory({
    liveBalance: balances[base],
    maxUsable: pairConfig.max_usable_inventory?.[base],
  });
  const usableQuote = resolveUsableInventory({
    liveBalance: balances[quote],
    maxUsable: pairConfig.max_usable_inventory?.[quote],
  });
  const skewBps = computeSkewBps({
    targetBase: pairConfig.target_inventory?.[base],
    currentBase: usableBase,
    targetQuote: pairConfig.target_inventory?.[quote],
    currentQuote: usableQuote,
    sensitivityBps: Number(pairConfig.inventory_sensitivity_bps || 0),
    maxSkewBps: Number(pairConfig.max_skew_bps || 0),
  });
  const mid = new Decimal(fairValue)
    .mul(new Decimal(1).plus(new Decimal(skewBps).div(10000)))
    .toFixed(8);
  const { bid, ask } = buildBidAsk({
    mid,
    spreadBps: Number(pairConfig.spread_bps || 0),
  });
  const side = String(direction).endsWith(`_to_${quote.toLowerCase()}`) ? 'bid' : 'ask';
  return {
    base,
    quote,
    bid,
    ask,
    mid,
    side,
    price: side === 'bid' ? bid : ask,
    usableInventory: {
      [base]: usableBase,
      [quote]: usableQuote,
    },
  };
}

function getTradeLimitStatus({ amountIn, assetIn, pairConfig }) {
  const minKey = `min_in_${assetIn}`;
  const maxKey = `max_in_${assetIn}`;
  const min = new Decimal(pairConfig.trade_limits?.[minKey] ?? 0);
  const max = new Decimal(pairConfig.trade_limits?.[maxKey] ?? 0);
  const amount = new Decimal(amountIn);
  if (amount.lt(min)) {
    return { allowed: false, reason: 'minimum' };
  }
  if (amount.gt(max)) {
    return { allowed: false, reason: 'maximum' };
  }
  return { allowed: true };
}

function computeOutputAmount({ amountIn, assetIn, assetOut, price }) {
  const input = new Decimal(amountIn);
  if (assetIn === 'SPACE') {
    return input.div(new Decimal(price)).toFixed(8);
  }
  if (assetOut === 'SPACE') {
    return input.mul(new Decimal(price)).toFixed(8);
  }
  throw new Error('unsupported asset direction');
}

function toBaseUnitsString(amount, decimals = 8) {
  return new Decimal(amount).mul(new Decimal(10).pow(decimals)).toFixed(0);
}

async function ensureRefund({
  deps,
  env,
  fetchImpl,
  metabotId,
  lifecycle,
  idempotencyKey,
  payload,
  reason,
  feeBearer,
  refundAmountMode,
  errorPrefix,
}) {
  await lifecycle.mark('refund_required');
  const executor = deps.executeTransferViaRpc || executeTransferViaRpc;
  try {
    const transfer = await executor({
      env,
      fetchImpl,
      body: {
        metabot_id: metabotId,
        chain: getAssetChain(payload.order.asset_in),
        to_address: payload.order.refund_address,
        amount: payload.order.amount_in,
        transferType: 'refund',
        feeBearer,
        refundAmountMode,
      },
    });
    await lifecycle.mark('refunded');
    const result = {
      mode: 'refunded',
      reason,
      lifecycle: lifecycle.states.slice(),
      refundTxid: transfer.txid || transfer.txId || null,
      message: formatRefundMessage({
        reason,
        feeBearer,
        refundAmountMode,
        assetIn: payload.order.asset_in,
        amountIn: payload.order.amount_in,
        txid: transfer.txid || transfer.txId || 'unknown',
      }),
    };
    await recordTerminalOutcome(deps.terminalState, idempotencyKey, result);
    return result;
  } catch (error) {
    const detail = [errorPrefix, error?.message].filter(Boolean).join(': ');
    const result = {
      mode: 'refund_failed',
      reason,
      lifecycle: lifecycle.states.slice(),
      message: formatRefundFailedMessage(detail || 'refund transfer failed'),
    };
    await recordTerminalOutcome(deps.terminalState, idempotencyKey, result);
    return result;
  }
}

async function quoteSupportedPairs({ deps, env, fetchImpl }) {
  const config = (deps.loadConfig || loadConfig)({ env });
  const supportedPairs = [];
  for (const pair of Object.keys(PAIR_ASSETS)) {
    const pairConfig = config.pairs?.[pair];
    if (!pairConfig || pairConfig.enabled === false) {
      continue;
    }
    const { fairValue, source } = await (deps.resolveFairValue || resolveFairValue)({
      mode: 'quote',
      config,
      pair,
      fetchImpl,
      now: deps.now,
    });
    const balances = await fetchAssetBalances({
      deps,
      env,
      metabotId: getMetabotId(env),
      assets: Object.values(getPairAssets(pair)),
      fetchImpl,
    });
    const pricing = buildPricingContext({
      pair,
      direction: `${getPairAssets(pair).base.toLowerCase()}_to_${getPairAssets(pair).quote.toLowerCase()}`,
      pairConfig,
      fairValue,
      balances,
    });
    supportedPairs.push({
      pair,
      bid: pricing.bid,
      ask: pricing.ask,
      mid: pricing.mid,
      source,
    });
  }
  return {
    mode: 'quoted',
    supportedPairs,
    message: formatSupportedPairsMessage(supportedPairs),
  };
}

async function quoteSingle({ payload, deps, env, fetchImpl }) {
  const config = (deps.loadConfig || loadConfig)({ env });
  const pairConfig = config.pairs?.[payload.service.pair];
  if (!pairConfig || pairConfig.enabled === false) {
    throw new Error('pair is disabled');
  }
  const { fairValue, source } = await (deps.resolveFairValue || resolveFairValue)({
    mode: 'quote',
    config,
    pair: payload.service.pair,
    fetchImpl,
    now: deps.now,
  });
  const balances = await fetchAssetBalances({
    deps,
    env,
    metabotId: getMetabotId(env),
    assets: Object.values(getPairAssets(payload.service.pair)),
    fetchImpl,
  });
  const pricing = buildPricingContext({
    pair: payload.service.pair,
    direction: payload.service.direction,
    pairConfig,
    fairValue,
    balances,
  });
  const outputAmount = roundExecutableOutput({
    assetOut: payload.order.asset_out,
    rawOutput: computeOutputAmount({
      amountIn: payload.order.amount_in,
      assetIn: payload.order.asset_in,
      assetOut: payload.order.asset_out,
      price: pricing.price,
    }),
  });

  return {
    mode: 'quoted',
    quote: {
      pair: payload.service.pair,
      direction: payload.service.direction,
      side: pricing.side,
      price: pricing.price,
      bid: pricing.bid,
      ask: pricing.ask,
      output_amount: outputAmount,
      fair_value_source: source,
    },
    message: formatQuoteMessage({
      pair: payload.service.pair,
      direction: payload.service.direction,
      outputAmount,
      assetOut: payload.order.asset_out,
    }),
  };
}

async function handleExecute({ payload, deps, env, fetchImpl }) {
  deps.terminalState = deps.terminalState || createInMemoryTerminalState();
  const lifecycle = createLifecycleTrace();
  const metabotId = getMetabotId(env);
  const idempotencyKey = buildIdempotencyKey({
    serviceOrderPinId: payload.order.service_order_pin_id,
    payTxid: payload.order.pay_txid,
    pair: payload.service.pair,
    direction: payload.service.direction,
    payerGlobalmetaid: payload.order.payer_globalmetaid,
  });
  const existingOutcome = await getTerminalOutcome(deps.terminalState, idempotencyKey);
  if (existingOutcome) {
    return existingOutcome;
  }

  await lifecycle.mark('pending_payment_proof');

  const txLookup = deps.txLookup || (async () => null);
  const proofDiscovery = await (deps.verifyWithRetry || verifyWithRetry)(
    { txid: payload.order.pay_txid },
    txLookup,
  );

  if (proofDiscovery.mode === 'void') {
    await lifecycle.mark('void');
    const result = {
      mode: 'void',
      lifecycle: lifecycle.states.slice(),
      needsOperatorReconciliation: true,
      message: formatVoidMessage(),
    };
    await recordTerminalOutcome(deps.terminalState, idempotencyKey, result);
    return result;
  }

  const config = (deps.loadConfig || loadConfig)({ env });
  const pairConfig = config.pairs?.[payload.service.pair];
  if (!pairConfig || pairConfig.enabled === false) {
    throw new Error('pair is disabled');
  }

  let expectedReceivingAddress = null;
  if (!deps.verifyPaymentProof) {
    const accountSummary = await fetchAccountSummary({ deps, env, metabotId, fetchImpl });
    expectedReceivingAddress = accountSummary?.[ACCOUNT_ADDRESS_KEYS[payload.order.asset_in]] || null;
  }

  const txOutputs =
    proofDiscovery.txSourceResult?.txOutputs
    || proofDiscovery.txSourceResult?.outputs
    || [];
  const expectedBaseUnits = toBaseUnitsString(payload.order.amount_in);
  let paidBaseUnits = proofDiscovery.txSourceResult?.paidBaseUnits;
  if (paidBaseUnits == null && Array.isArray(txOutputs) && expectedReceivingAddress) {
    let total = 0n;
    for (const output of txOutputs) {
      if (output?.address === expectedReceivingAddress && /^\d+$/.test(String(output.baseUnits || ''))) {
        total += BigInt(String(output.baseUnits));
      }
    }
    paidBaseUnits = total.toString();
  }
  if (paidBaseUnits == null) {
    paidBaseUnits = expectedBaseUnits;
  }

  try {
    await (deps.verifyPaymentProof || verifyPaymentProof)({
      expectedBaseUnits,
      paidBaseUnits,
      expectedChain: getAssetChain(payload.order.asset_in),
      txSourceResult: proofDiscovery.txSourceResult,
      expectedReceivingAddress,
      txOutputs,
    });
  } catch (error) {
    return ensureRefund({
      deps,
      env,
      fetchImpl,
      metabotId,
      lifecycle,
      idempotencyKey,
      payload,
      reason: 'amount_mismatch',
      feeBearer: 'payer',
      refundAmountMode: 'net_of_fee',
      errorPrefix: error.message,
    });
  }

  await lifecycle.mark('validated');

  const limitStatus = getTradeLimitStatus({
    amountIn: payload.order.amount_in,
    assetIn: payload.order.asset_in,
    pairConfig,
  });
  if (!limitStatus.allowed) {
    return ensureRefund({
      deps,
      env,
      fetchImpl,
      metabotId,
      lifecycle,
      idempotencyKey,
      payload,
      reason: 'trade_limit',
      feeBearer: 'maker',
      refundAmountMode: 'full_principal',
      errorPrefix: `amount is outside the configured ${limitStatus.reason}`,
    });
  }

  const { fairValue } = await (deps.resolveFairValue || resolveFairValue)({
    mode: 'execute',
    config,
    pair: payload.service.pair,
    fetchImpl,
    now: deps.now,
  });
  const balances = await fetchAssetBalances({
    deps,
    env,
    metabotId,
    assets: Object.values(getPairAssets(payload.service.pair)),
    fetchImpl,
  });
  const pricing = buildPricingContext({
    pair: payload.service.pair,
    direction: payload.service.direction,
    pairConfig,
    fairValue,
    balances,
  });
  const rawOutput = computeOutputAmount({
    amountIn: payload.order.amount_in,
    assetIn: payload.order.asset_in,
    assetOut: payload.order.asset_out,
    price: pricing.price,
  });
  const latestOutput = roundExecutableOutput({
    assetOut: payload.order.asset_out,
    rawOutput,
  });

  if (payload.quote_context?.has_prior_quote) {
    const slippageOk = isWithinSlippage({
      quotedOutput: payload.quote_context.quoted_output,
      latestOutput,
      slippageBps: payload.quote_context.slippage_bps,
    });
    if (!slippageOk) {
      return ensureRefund({
        deps,
        env,
        fetchImpl,
        metabotId,
        lifecycle,
        idempotencyKey,
        payload,
        reason: 'slippage_exceeded',
        feeBearer: 'maker',
        refundAmountMode: 'full_principal',
      });
    }
  }

  const outputBaseUnits = toBaseUnitsString(latestOutput);
  if (classifyOutputAmount({
    assetOut: payload.order.asset_out,
    roundedOutputBaseUnits: outputBaseUnits,
  }) !== 'execute') {
    return ensureRefund({
      deps,
      env,
      fetchImpl,
      metabotId,
      lifecycle,
      idempotencyKey,
      payload,
      reason: 'dust_output',
      feeBearer: 'maker',
      refundAmountMode: 'full_principal',
    });
  }

  const outputInventory = new Decimal(pricing.usableInventory[payload.order.asset_out] || 0);
  if (outputInventory.lt(new Decimal(latestOutput))) {
    return ensureRefund({
      deps,
      env,
      fetchImpl,
      metabotId,
      lifecycle,
      idempotencyKey,
      payload,
      reason: 'inventory_shortage',
      feeBearer: 'maker',
      refundAmountMode: 'full_principal',
    });
  }

  const executor = deps.executeTransferViaRpc || executeTransferViaRpc;
  try {
    const transfer = await executor({
      env,
      fetchImpl,
      body: {
        metabot_id: metabotId,
        chain: getAssetChain(payload.order.asset_out),
        to_address: payload.order.payout_address,
        amount: latestOutput,
        transferType: 'payout',
        pricingSide: pricing.side,
      },
    });
    await lifecycle.mark('executed');
    const result = {
      mode: 'executed',
      lifecycle: lifecycle.states.slice(),
      payoutTxid: transfer.txid || transfer.txId || null,
      quote: {
        side: pricing.side,
        price: pricing.price,
        output_amount: latestOutput,
      },
      message: formatExecutedMessage({
        assetIn: payload.order.asset_in,
        amountIn: payload.order.amount_in,
        assetOut: payload.order.asset_out,
        outputAmount: latestOutput,
        pricingSide: pricing.side,
        txid: transfer.txid || transfer.txId || 'unknown',
      }),
    };
    await recordTerminalOutcome(deps.terminalState, idempotencyKey, result);
    return result;
  } catch (error) {
    const result = {
      mode: 'payout_failed',
      lifecycle: lifecycle.states.slice(),
      message: formatPayoutFailedMessage(error.message),
    };
    await recordTerminalOutcome(deps.terminalState, idempotencyKey, result);
    return result;
  }
}

function buildDefaultDeps(overrides = {}) {
  return {
    env: process.env,
    fetchImpl: fetch,
    now: Date.now,
    terminalState: createInMemoryTerminalState(),
    loadConfig,
    resolveFairValue,
    verifyPaymentProof,
    verifyWithRetry,
    getAccountSummaryViaRpc,
    getAddressBalanceViaRpc,
    executeTransferViaRpc,
    txLookup: async () => null,
    ...overrides,
  };
}

async function handleMmRequest(inputPayload, depsInput = {}) {
  const deps = buildDefaultDeps(depsInput);
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || fetch;
  const payload = normalizePayload(inputPayload);

  if (payload.mode === 'quote' && payload.query?.kind === 'supported_pairs') {
    return quoteSupportedPairs({ deps, env, fetchImpl });
  }

  if (payload.mode === 'quote') {
    return quoteSingle({ payload, deps, env, fetchImpl });
  }

  return handleExecute({ payload, deps, env, fetchImpl });
}

module.exports = {
  buildDefaultDeps,
  handleMmRequest,
};
