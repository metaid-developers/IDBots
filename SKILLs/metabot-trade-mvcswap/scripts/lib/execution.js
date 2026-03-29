'use strict';

const {
  fetchAllPairs,
  resolveSpacePair,
  quoteRoute,
  requestSwapArgs,
  executeToken1ToToken2,
  executeToken2ToToken1,
  toBaseUnits,
  fromBaseUnits,
} = require('./mvcswapApi.js');
const {
  getFeeRateSummary,
  getAccountSummary,
  getAddressBalance,
  buildMvcRawTxBundle,
  buildMvcTransferRawTx,
} = require('./localRpc.js');
const { formatPreview, formatQuote, formatExecuted } = require('./formatter.js');

function validateTradeRequest(request) {
  if (!request || typeof request !== 'object') {
    return { ok: false, reason: 'Trade request is missing.' };
  }

  const action = String(request.action || '').trim().toLowerCase();
  const direction = String(request.direction || '').trim().toLowerCase();
  const amountIn = String(request.amountIn || '').trim();
  const tokenSymbol = String(request.tokenSymbol || '').trim().toUpperCase();
  const slippagePercent = Number(request.slippagePercent);

  if (!['quote', 'preview', 'execute'].includes(action)) {
    return { ok: false, reason: 'Trade request action must be quote, preview, or execute.' };
  }
  if (!['space_to_token', 'token_to_space'].includes(direction)) {
    return { ok: false, reason: 'Trade request direction must be space_to_token or token_to_space.' };
  }
  if (!amountIn || !/^\d+(\.\d+)?$/.test(amountIn) || Number(amountIn) <= 0) {
    return { ok: false, reason: 'Trade request amountIn must be a positive decimal.' };
  }
  if (!tokenSymbol || tokenSymbol === 'SPACE') {
    return { ok: false, reason: 'Trade request tokenSymbol must be the non-SPACE token symbol.' };
  }
  if (!Number.isFinite(slippagePercent) || slippagePercent < 0) {
    return { ok: false, reason: 'Trade request slippagePercent must be a non-negative number.' };
  }

  return {
    ok: true,
    request: {
      action,
      direction,
      amountIn,
      tokenSymbol,
      slippagePercent,
    },
  };
}

function getTokenDecimals(token) {
  const decimals = Number(token?.decimal);
  return Number.isInteger(decimals) && decimals >= 0 ? decimals : 8;
}

function resolveTokenGenesis(token) {
  return String(token?.tokenID || token?.genesisHash || '').trim();
}

function requireV1Route(quote) {
  const path = String(quote?.path || '').toLowerCase();
  if (path && path !== 'v1') {
    throw new Error('This pair currently routes through mvcswap v2, but Phase 1 supports v1 only.');
  }
}

function toSafeInteger(baseUnits, label) {
  const value = Number(baseUnits);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid or too large.`);
  }
  return value;
}

function computeMinimumReceived(amountOutBase, slippagePercent, decimals = 8) {
  const raw = BigInt(String(amountOutBase || '0'));
  const basisPoints = Math.round(Number(slippagePercent) * 100);
  const adjusted = raw * BigInt(Math.max(0, 10000 - basisPoints)) / 10000n;
  return fromBaseUnits(adjusted.toString(), decimals);
}

async function loadTradeContext({ request, fetchImpl, env }) {
  const allPairs = await fetchAllPairs({ fetchImpl });
  const resolvedPair = resolveSpacePair({
    pairs: allPairs.data,
    tokenSymbol: request.tokenSymbol,
    direction: request.direction,
  });
  const tokenDecimals = getTokenDecimals(resolvedPair.token);
  const inputDecimals = request.direction === 'space_to_token' ? 8 : tokenDecimals;
  const outputDecimals = request.direction === 'space_to_token' ? tokenDecimals : 8;
  const quote = await quoteRoute({
    direction: request.direction,
    tokenSymbol: request.tokenSymbol,
    amount: request.amountIn,
    inputDecimals,
    fetchImpl,
  });
  requireV1Route(quote);
  const feeSummary = await getFeeRateSummary({ env, fetchImpl });
  return {
    resolvedPair,
    quote,
    inputDecimals,
    outputDecimals,
    feeRate: Number(feeSummary.defaultFeeRate || 1),
  };
}

async function ensureSufficientSpaceBalance({ env, fetchImpl, metabotId, requiredSats }) {
  const balanceResult = await getAddressBalance({ env, fetchImpl, metabotId });
  const availableSats = Number(balanceResult?.balance?.mvc?.satoshis || 0);
  if (!Number.isSafeInteger(availableSats) || availableSats < requiredSats) {
    const required = fromBaseUnits(String(requiredSats), 8) || '0';
    const available = fromBaseUnits(String(Math.max(0, availableSats)), 8) || '0';
    throw new Error(`SPACE balance is insufficient for this trade. Required ${required} SPACE, available ${available} SPACE.`);
  }
}

async function executeTrade({ request, env, fetchImpl, context }) {
  const metabotId = Number(env?.IDBOTS_METABOT_ID || 0);
  if (!Number.isInteger(metabotId) || metabotId < 1) {
    throw new Error('IDBOTS_METABOT_ID is required.');
  }

  const account = await getAccountSummary({ env, fetchImpl, metabotId });
  const requestArgs = await requestSwapArgs({
    symbol: context.resolvedPair.symbol,
    address: account.mvc_address,
    op: request.direction === 'space_to_token' ? 3 : 4,
    fetchImpl,
  });
  const outputSymbol = request.direction === 'space_to_token' ? request.tokenSymbol : 'SPACE';
  const estimatedOut = fromBaseUnits(context.quote.amountOut, context.outputDecimals);
  const txFeeSats = toSafeInteger(String(requestArgs.txFee || 0), 'txFee');

  if (request.direction === 'space_to_token') {
    const amountInSats = toSafeInteger(toBaseUnits(request.amountIn, context.inputDecimals), 'amount');
    await ensureSufficientSpaceBalance({
      env,
      fetchImpl,
      metabotId,
      requiredSats: amountInSats + txFeeSats,
    });
    const mvcTx = await buildMvcTransferRawTx({
      env,
      fetchImpl,
      body: {
        metabot_id: metabotId,
        to_address: requestArgs.mvcToAddress,
        amount_sats: amountInSats + txFeeSats,
        fee_rate: context.feeRate,
      },
    });
    const swap = await executeToken1ToToken2({
      fetchImpl,
      body: {
        symbol: context.resolvedPair.symbol,
        requestIndex: requestArgs.requestIndex,
        op: 3,
        mvcRawTx: mvcTx.raw_tx,
        mvcOutputIndex: mvcTx.output_index,
      },
    });
    return {
      mode: 'executed',
      message: formatExecuted({
        directionLabel: 'SPACE -> ' + request.tokenSymbol,
        inputAmount: request.amountIn,
        inputUnit: 'SPACE',
        outputAmount: estimatedOut,
        outputUnit: request.tokenSymbol,
        txid: swap.txid,
      }),
    };
  }

  await ensureSufficientSpaceBalance({
    env,
    fetchImpl,
    metabotId,
    requiredSats: txFeeSats,
  });
  const bundle = await buildMvcRawTxBundle({
    env,
    fetchImpl,
    body: {
      metabot_id: metabotId,
      steps: [
        {
          kind: 'mvc_transfer',
          to_address: requestArgs.mvcToAddress,
          amount_sats: txFeeSats,
          fee_rate: context.feeRate,
        },
        {
          kind: 'mvc_ft_transfer',
          token: {
            symbol: request.tokenSymbol,
            tokenID: context.resolvedPair.token.tokenID,
            genesisHash: resolveTokenGenesis(context.resolvedPair.token),
            codeHash: context.resolvedPair.token.codeHash,
            decimal: context.resolvedPair.token.decimal,
          },
          to_address: requestArgs.tokenToAddress,
          amount: toBaseUnits(request.amountIn, Number(context.resolvedPair.token.decimal || 8)),
          fee_rate: context.feeRate,
          funding: {
            step_index: 0,
            use_output: 'change',
          },
        },
      ],
    },
  });
  const mvcTx = Array.isArray(bundle?.steps) ? bundle.steps[0] : null;
  const ftTx = Array.isArray(bundle?.steps) ? bundle.steps[1] : null;
  if (!mvcTx?.raw_tx || !ftTx?.raw_tx || typeof ftTx.amount_check_raw_tx !== 'string') {
    throw new Error('Failed to build the ordered raw transaction bundle for this trade.');
  }
  const swap = await executeToken2ToToken1({
    fetchImpl,
    body: {
      symbol: context.resolvedPair.symbol,
      requestIndex: requestArgs.requestIndex,
      op: 4,
      token2RawTx: ftTx.raw_tx,
      token2OutputIndex: ftTx.output_index,
      amountCheckRawTx: ftTx.amount_check_raw_tx,
      mvcRawTx: mvcTx.raw_tx,
      mvcOutputIndex: mvcTx.output_index,
    },
  });
  return {
    mode: 'executed',
    message: formatExecuted({
      directionLabel: `${request.tokenSymbol} -> SPACE`,
      inputAmount: request.amountIn,
      inputUnit: request.tokenSymbol,
      outputAmount: estimatedOut,
      outputUnit: 'SPACE',
      txid: swap.txid,
    }),
  };
}

async function handleTradeRequest({ request, env, fetchImpl = fetch }) {
  const validation = validateTradeRequest(request);
  if (!validation.ok) {
    return { mode: 'unsupported', message: validation.reason };
  }
  const normalizedRequest = validation.request;

  const context = await loadTradeContext({ request: normalizedRequest, fetchImpl, env });
  const outputSymbol = normalizedRequest.direction === 'space_to_token' ? normalizedRequest.tokenSymbol : 'SPACE';
  const estimatedOut = fromBaseUnits(context.quote.amountOut, context.outputDecimals);
  const minimumReceived = computeMinimumReceived(context.quote.amountOut, normalizedRequest.slippagePercent, context.outputDecimals);

  if (normalizedRequest.action === 'quote') {
    return {
      mode: 'quote',
      message: formatQuote({ request: normalizedRequest, estimatedOut, minimumReceived, outputSymbol }),
    };
  }

  if (normalizedRequest.action === 'preview') {
    return {
      mode: 'preview',
      message: formatPreview({ request: normalizedRequest, estimatedOut, minimumReceived, outputSymbol }),
    };
  }

  return executeTrade({ request: normalizedRequest, env, fetchImpl, context });
}

module.exports = {
  handleTradeRequest,
  computeMinimumReceived,
  validateTradeRequest,
};
