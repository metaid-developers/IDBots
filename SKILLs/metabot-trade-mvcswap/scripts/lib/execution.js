'use strict';

const { parseTradeIntent } = require('./intent.js');
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

async function loadTradeContext({ intent, fetchImpl, env }) {
  const allPairs = await fetchAllPairs({ fetchImpl });
  const resolvedPair = resolveSpacePair({
    pairs: allPairs.data,
    tokenSymbol: intent.tokenSymbol,
    direction: intent.direction,
  });
  const tokenDecimals = getTokenDecimals(resolvedPair.token);
  const inputDecimals = intent.direction === 'space_to_token' ? 8 : tokenDecimals;
  const outputDecimals = intent.direction === 'space_to_token' ? tokenDecimals : 8;
  const quote = await quoteRoute({
    direction: intent.direction,
    tokenSymbol: intent.tokenSymbol,
    amount: intent.amount,
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

async function executeTrade({ intent, env, fetchImpl, context }) {
  const metabotId = Number(env?.IDBOTS_METABOT_ID || 0);
  if (!Number.isInteger(metabotId) || metabotId < 1) {
    throw new Error('IDBOTS_METABOT_ID is required.');
  }

  const account = await getAccountSummary({ env, fetchImpl, metabotId });
  const requestArgs = await requestSwapArgs({
    symbol: context.resolvedPair.symbol,
    address: account.mvc_address,
    op: intent.direction === 'space_to_token' ? 3 : 4,
    fetchImpl,
  });
  const outputSymbol = intent.direction === 'space_to_token' ? intent.tokenSymbol : 'SPACE';
  const estimatedOut = fromBaseUnits(context.quote.amountOut, context.outputDecimals);
  const txFeeSats = toSafeInteger(String(requestArgs.txFee || 0), 'txFee');

  if (intent.direction === 'space_to_token') {
    const amountInSats = toSafeInteger(toBaseUnits(intent.amount, context.inputDecimals), 'amount');
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
        directionLabel: 'SPACE -> ' + intent.tokenSymbol,
        inputAmount: intent.amount,
        inputUnit: 'SPACE',
        outputAmount: estimatedOut,
        outputUnit: intent.tokenSymbol,
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
            symbol: intent.tokenSymbol,
            tokenID: context.resolvedPair.token.tokenID,
            genesisHash: resolveTokenGenesis(context.resolvedPair.token),
            codeHash: context.resolvedPair.token.codeHash,
            decimal: context.resolvedPair.token.decimal,
          },
          to_address: requestArgs.tokenToAddress,
          amount: toBaseUnits(intent.amount, Number(context.resolvedPair.token.decimal || 8)),
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
      directionLabel: `${intent.tokenSymbol} -> SPACE`,
      inputAmount: intent.amount,
      inputUnit: intent.tokenSymbol,
      outputAmount: estimatedOut,
      outputUnit: 'SPACE',
      txid: swap.txid,
    }),
  };
}

async function handleTradeRequest({ input, env, fetchImpl = fetch }) {
  const intent = parseTradeIntent(input);
  if (intent.kind !== 'trade') {
    return { mode: 'unsupported', message: intent.reason };
  }

  const context = await loadTradeContext({ intent, fetchImpl, env });
  const outputSymbol = intent.direction === 'space_to_token' ? intent.tokenSymbol : 'SPACE';
  const estimatedOut = fromBaseUnits(context.quote.amountOut, context.outputDecimals);
  const minimumReceived = computeMinimumReceived(context.quote.amountOut, intent.slippagePercent, context.outputDecimals);

  if (intent.quoteOnly) {
    return {
      mode: 'quote',
      message: formatQuote({ intent, estimatedOut, minimumReceived, outputSymbol }),
    };
  }

  if (!intent.executeNow) {
    return {
      mode: 'preview',
      message: formatPreview({ intent, estimatedOut, minimumReceived, outputSymbol }),
    };
  }

  return executeTrade({ intent, env, fetchImpl, context });
}

module.exports = {
  handleTradeRequest,
  computeMinimumReceived,
};
